// Full GPU-accelerated FT8 decode pipeline: coarse Costas-sync search (GPU)
// -> per-candidate fine sync (GPU: searchBoth grid search, shift200) + soft-
// decision LLR extraction (GPU: symbol extract + soft-decode, CPU finishing
// for the cheap global-stats/Bayes step — see webgpuSoftDecode.ts) -> LDPC
// belief-propagation (GPU, batched) -> OSD fallback for near-misses (GPU,
// batched) -> CRC validation (crc.ts) -> spectral subtraction (GPU, batched)
// -> repeat for NPASSES total passes.
//
// Mirrors ft8mon's "pass 0..N, clean LDPC + OSD fallback, spectral
// subtraction between passes" path — see webgpuOsdDecode.ts/subtractGpu.ts's
// own module docs for the OSD/subtraction kernels this composes with, and
// the scoping investigation this pipeline was built from for what's still
// NOT replicated (ft8mon's own cross-sub-band threading, prevdecs_ carried
// in from outside a single decode call — both dead code in this app's own
// WASM build per ft8mon_wasm.cc, so nothing lost by not chasing them here).
//
// IMPORTANT: always operates at the fixed rate=12000/blocksize=1920 this
// repo's coarse-search GPU kernel is built for — ft8mon's own C++ path
// dynamically REDUCES its internal sample rate for narrow min_hz/max_hz
// search bands (reduce_rate(), ft8.cc:711-793, discovered while cross-
// checking this port against real captured data), which would desync this
// pipeline's fixed-1920-point-FFT assumption if mimicked. This pipeline
// sidesteps that entirely by always searching the FULL captured bandwidth
// internally (never calling into ft8mon's C++/WASM path at all), so there
// is no equivalent rate-reduction decision to make here — callers can
// filter results by frequency afterward if they only care about a sub-band.
//
// MULTI-PASS DESIGN (batch-within-pass, serial-between-passes): ft8mon's own
// pass loop (ft8.cc:853-929) is a single strongest-first sequential loop
// that subtracts EACH successful decode immediately, before even computing
// the next (weaker) candidate's LLR — so within one pass, a later
// candidate's LLR can depend on an earlier one already being subtracted.
// This pipeline deliberately does NOT chase that: every candidate in ONE
// pass is fine-synced/decoded against the SAME pass-start residual, batched
// into one set of GPU dispatches (the entire point of the GPU port), and
// only the SUCCESSFUL decodes from that whole pass are subtracted together
// (summed independently-computed deltas — see subtractGpu.ts's own module
// doc for why this is a reasonable approximation of sequential subtraction)
// before the NEXT pass starts fresh on the updated residual. This is the
// same "approximate the algorithm's INTENT, not its exact sequential
// mechanics, in favor of real GPU parallelism" tradeoff already made for
// already[]'s band-dedup (see the dedup comment below) — passes themselves
// stay sequential (pass N+1 genuinely needs pass N's subtracted residual),
// but nothing within a pass is serialized candidate-by-candidate.
import { FFT_N } from './fft1920';
import { runCoarseSearchGpu } from './webgpuCoarseSearch';
import { realFftGeneral } from './fftGeneral';
import { runRealFftGeneralBatchGpu, runRealIfftGeneralBatchGpu } from './webgpuFftGeneral';
import { fbandpass, shiftBins, type Complex } from './dsp';
import { runSearchBothGpu, type SearchBothCandidateInput } from './webgpuSearchBoth';
import { fine, shouldApplyFineAdjustment } from './fineSync';
import { runSymbolExtractGpu, type SymbolExtractCandidateInput } from './webgpuSymbolExtract';
import { runSoftDecodeGpu } from './webgpuSoftDecode';
import { guessSnr } from './guessSnr';
import { runLdpcDecodeGpu } from './webgpuLdpcDecode';
import { runOsdDecodeGpu } from './webgpuOsdDecode';
import { ldpcEncode } from './osdDecode';
import { runSubtractGpu, type SubtractGpuCandidate } from './subtractGpu';
import { recode } from './subtract';
import { checkCrc } from './crc';
import { LDPC_CHECKS } from './ldpcMatrix';

const RATE = 12000;
const BLOCK = FFT_N; // 1920, matches blocksize(12000)
const BIN_HZ = RATE / BLOCK; // 6.25
const SHOULDER200 = 10;
const SHOULDER200_EXTRA = 0.0;
const SECOND_HZ_WIN = 3.5;
const SECOND_HZ_N = 4;
const SECOND_OFF_WIN = 0.5;
const SECOND_OFF_N = 5;

// osd_ldpc_thresh (ft8.cc:70, this app's live default — decoder.worker.ts's
// DEFAULT_DECODER_PARAMS.osdLdpcThresh): only attempt OSD for a candidate
// whose clean LDPC belief-propagation got AT LEAST this many (of 83) parity
// checks right — i.e. "close but not perfect", not a full BP failure.
const OSD_LDPC_THRESH = 70;
// osd_depth (this app's live default — decoder.worker.ts's osdDepth).
const OSD_DEPTH = 2;
// npasses_one (ft8.cc:47, this app's live default — decoder.worker.ts's npasses)
// is 3, but multi-pass is DISABLED here (forced to 1) — see runSubtractGpu's
// module doc: its per-candidate un-shift step is a genuine whole-buffer
// (~180000-sample) complex FFT+IFFT pair, currently CPU-only (no GPU kernel
// in this pipeline handles an FFT that large). Measured live: even capped to
// the 5 strongest candidates/pass, a real busy-band file cost 13.5s of a
// 20.3s total just on subtraction — worse than the pre-GPU-port CPU
// baseline this whole pipeline was built to beat. Subtraction stays fully
// built and real-hardware-verified (subtractGpu.ts/webgpuSubtract.ts,
// webgpu-subtract-bench.html) for when a GPU-accelerated large-N FFT
// exists to fix the actual bottleneck — until then it's simply not called
// (NPASSES=1 means the pass loop below runs once and never reaches the
// subtract-and-continue branch). OSD, which found a genuine coverage win at
// negligible cost (~1.5s/file), stays active regardless of this.
const NPASSES = 1;
const MAX_SUBTRACT_PER_PASS = 5;

export interface GpuDecodeResult {
  freqHz: number;
  dtSec: number;
  snr: number;
  plain: Uint8Array; // 174 bits: 91 payload + 83 parity
  candidateCount: number; // how many coarse candidates were tried this window
  pass: number; // which pass (0-indexed) found this decode
  osd: number; // -1 = clean LDPC, >=0 = OSD depth used (matches ft8mon's own osd_depth output convention)
}

export interface GpuDecodeTimings {
  coarseSearchMs: number;
  wholeBufferFftMs: number; // once per window, feeds downV7fBins for every candidate
  fineSyncMs: number; // GPU: downV7f + searchBoth + extract + soft-decode, all candidates batched, ALL passes combined
  ldpcMs: number; // GPU batched LDPC dispatch, all passes combined
  osdMs: number; // GPU batched OSD dispatch, all passes combined
  subtractMs: number; // GPU batched spectral subtraction, all passes combined
  totalMs: number;
  passesRun: number; // how many passes actually ran (stops early if a pass finds nothing new)
}

const ALREADY_HZ = 27; // already_hz, ft8.cc:77 — dedup bucket width

export interface GpuDecodeParams {
  /** How many top-strength coarse candidates to carry into fine-sync/LDPC,
   *  PER PASS — mirrors ft8mon's own strongest-first ordering (order sorted
   *  by strength_ before iterating, ft8.cc:901-903). */
  maxCandidates: number;
}

// searchBoth.wgsl/fftGeneralFused.wgsl have no generic-DFT fallback for a
// leftover prime factor after extracting 2s/3s/5s (deliberate scope limit,
// unlike fftGeneral.ts's CPU path, which does have one) — downV7f's own
// output length (blen, derived from the CAPTURE WINDOW's total duration)
// has no reason to land on a 2/3/5-smooth number in general (confirmed:
// 93 symbols * 1920 samples -> blen=2976 = 2^5*3*31, real captured file,
// not a synthetic edge case). Round the IFFT's target length UP to the
// nearest smooth value instead: the extra output samples are pure zero-
// padding (bbins already zero-fills past the real bandpassed spectrum, see
// below), a few samples added to a ~3000-sample 200sps buffer is a
// microsecond-scale duration change — negligible next to FT8's 5ms symbol
// period — and every downstream `off` value is computed independently from
// candidate.off/RATE*200, not from blen itself, so nothing needs to know
// this padding happened.
function nextSmooth235(n: number): number {
  let m = n;
  while (true) {
    let r = m;
    for (const p of [2, 3, 5]) while (r % p === 0) r /= p;
    if (r === 1) return m;
    m++;
  }
}

/** down_v7_f() (ft8.cc:2305-2345)'s bin-shift + bandpass steps only — cheap
 *  index/scalar work over an already-small bin array (not the whole-buffer
 *  spectrum), stays on CPU (same tradeoff webgpuFftGeneral.ts's own
 *  wrappers make). The final IFFT is deliberately NOT done here: every
 *  candidate in a window shares the same target blen (it depends only on
 *  the capture window's duration, not per-candidate hz), so the caller
 *  batches ALL candidates' bbins into ONE runRealIfftGeneralBatchGpu
 *  dispatch instead of one IFFT per candidate — found live, on real
 *  hardware, that doing this per-candidate (even sequentially, to avoid
 *  the shared-pipeline race) made fineSync the dominant cost by a wide
 *  margin (34.6s of a 35.7s total at maxCandidates=60): each call pays
 *  full submit/onSubmittedWorkDone/mapAsync round-trip latency
 *  individually, the same class of overhead searchBoth/extract/soft-decode
 *  already avoid by batching every candidate into one dispatch each. */
function downV7fBins(bins: Complex[], len: number, hz: number): Complex[] {
  const nbins = bins.length;
  const binHz = RATE / len;
  const down = Math.round((hz - 25) / binHz);

  let bins1: Complex[] = new Array(nbins);
  for (let i = 0; i < nbins; i++) {
    const j = i + down;
    bins1[i] = j >= 0 && j < nbins ? bins[j] : [0, 0];
  }

  const lowInner = 25.0 - SHOULDER200_EXTRA;
  let lowOuter = lowInner - SHOULDER200;
  if (lowOuter < 0) lowOuter = 0;
  const highInner = 75 - 6.25 + SHOULDER200_EXTRA;
  let highOuter = highInner + SHOULDER200;
  if (highOuter > 100) highOuter = 100;

  bins1 = fbandpass(bins1, binHz, lowOuter, lowInner, highInner, highOuter);

  const blen = nextSmooth235(Math.round(len * (200.0 / RATE)));
  const nBbins = Math.floor(blen / 2) + 1;
  const bbins: Complex[] = new Array(nBbins);
  for (let i = 0; i < nBbins; i++) bbins[i] = i < bins1.length ? bins1[i] : [0, 0];
  return bbins;
}

/** shift200() (ft8.cc:1273-1284), GPU-backed batch version: identical math
 *  to fineSync.ts's shift200(), dispatching the forward FFT / inverse FFT
 *  via batched GPU calls. Only called for the (typically small) subset of
 *  candidates whose fine() adjustment was accepted (see the caller) — but
 *  still batched, not looped, for the same reason downV7f is: this is only
 *  reached with a subset of candidates sharing the SAME samples200.length
 *  (the padded, already-smooth length every candidate in a window shares),
 *  so one dispatch covers all of them regardless of subset size. */
async function shift200BatchGpu(inputs: Array<{ samples200: Float32Array; hz: number }>): Promise<Float32Array[]> {
  if (inputs.length === 0) return [];
  const len = inputs[0].samples200.length;
  const binHz = 200 / len;

  const binsBatch = await runRealFftGeneralBatchGpu(inputs.map(i => i.samples200), len);
  const shiftedBatch = binsBatch.map((bins, i) => {
    const down = Math.round((inputs[i].hz - 25.0) / binHz);
    return shiftBins(bins, down);
  });
  return runRealIfftGeneralBatchGpu(shiftedBatch);
}

interface PassResult {
  results: Array<GpuDecodeResult & { orderIndex: number }>;
  coarseSearchMs: number;
  wholeBufferFftMs: number;
  fineSyncMs: number;
  ldpcMs: number;
  osdMs: number;
}

/** Runs ONE pass (coarse search -> fine sync -> extract -> soft-decode ->
 *  LDPC -> OSD fallback -> CRC) against `samplesBySymbol` (the CURRENT
 *  residual for this pass — pass 0 gets the raw captured window, later
 *  passes get the subtracted residual from the pass before). Every
 *  candidate found here is checked against the SAME residual — no
 *  candidate in this pass sees another candidate in this SAME pass's
 *  subtraction (see module header for why). */
async function runOnePass(
  samplesBySymbol: Float32Array,
  nSymbols: number,
  maxCandidates: number,
  passIndex: number,
): Promise<PassResult> {
  const tCoarse0 = performance.now();
  const coarseParams = { si0: 0, siCount: Math.max(1, nSymbols - 79), bi0: 0, biCount: Math.floor(FFT_N / 2) };
  const coarseResult = await runCoarseSearchGpu(samplesBySymbol, nSymbols, coarseParams);
  const coarseSearchMs = performance.now() - tCoarse0;

  const cellIndices = Array.from({ length: coarseResult.strengths.length }, (_, i) => i);
  cellIndices.sort((a, b) => coarseResult.strengths[b] - coarseResult.strengths[a]);
  const topCells = cellIndices.slice(0, maxCandidates);

  const candidates = topCells.map(idx => {
    const siLocal = Math.floor(idx / coarseParams.biCount);
    const biLocal = idx % coarseParams.biCount;
    const si = coarseParams.si0 + siLocal;
    const bi = coarseParams.bi0 + biLocal;
    return { hz: bi * BIN_HZ, off: si * BLOCK, strength: coarseResult.strengths[idx] };
  });

  const tWholeFft0 = performance.now();
  const wholeBufferBins = realFftGeneral(samplesBySymbol, samplesBySymbol.length);
  const wholeBufferFftMs = performance.now() - tWholeFft0;

  const bbinsPerCandidate = candidates.map(candidate => downV7fBins(wholeBufferBins, samplesBySymbol.length, candidate.hz));
  const samples200PerCandidate = candidates.length > 0 ? await runRealIfftGeneralBatchGpu(bbinsPerCandidate) : [];

  const searchInputs: SearchBothCandidateInput[] = candidates.map((candidate, i) => ({
    samples200: samples200PerCandidate[i],
    hz0: 25,
    hzN: SECOND_HZ_N,
    hzWin: SECOND_HZ_WIN,
    off0: Math.round((candidate.off / RATE) * 200.0),
    offN: SECOND_OFF_N,
    offWin: SECOND_OFF_WIN * 32,
  }));

  const validIdx: number[] = [];
  const validSearchInputs: SearchBothCandidateInput[] = [];
  searchInputs.forEach((input, i) => {
    try {
      buildFlatCandidateDryRun(input);
      validIdx.push(i);
      validSearchInputs.push(input);
    } catch {
      // skip — no GPU equivalent of searchTimeFine's null return
    }
  });

  const tFineSync0 = performance.now();
  const searchResults = validSearchInputs.length > 0 ? await runSearchBothGpu(validSearchInputs) : [];

  const extractInputs: SymbolExtractCandidateInput[] = [];
  const extractMeta: Array<{ candidateIdx: number; hz: number; off: number }> = [];

  for (let k = 0; k < validIdx.length; k++) {
    const candidateIdx = validIdx[k];
    const best = searchResults[k];
    const samples200 = samples200PerCandidate[candidateIdx];
    extractInputs.push({ samples200, off: best.off });
    extractMeta.push({ candidateIdx, hz: best.hz, off: best.off });
  }

  const firstPassM79 = extractInputs.length > 0 ? await runSymbolExtractGpu(extractInputs) : [];

  const reshiftIdx: number[] = [];
  const reshiftInputs: SymbolExtractCandidateInput[] = [];
  const adjustedMeta: Array<{ hz: number; off: number }> = extractMeta.map(m => ({ hz: m.hz, off: m.off }));

  for (let k = 0; k < firstPassM79.length; k++) {
    const { adjHz, adjOff } = fine(firstPassM79[k]);
    if (shouldApplyFineAdjustment(adjHz, adjOff)) {
      const candidateIdx = extractMeta[k].candidateIdx;
      const newHz = extractMeta[k].hz + adjHz;
      const newOff = Math.max(0, extractMeta[k].off + Math.round(adjOff));
      adjustedMeta[k] = { hz: newHz, off: newOff };
      reshiftIdx.push(k);
      reshiftInputs.push({ samples200: samples200PerCandidate[candidateIdx], off: newOff });
    }
  }

  const finalM79 = firstPassM79.slice();
  if (reshiftInputs.length > 0) {
    const needsShiftIdx = reshiftIdx.filter((_, i) => Math.abs(adjustedMeta[reshiftIdx[i]].hz - 25) >= 0.001);
    const shiftInputs = needsShiftIdx.map(k => ({
      samples200: samples200PerCandidate[extractMeta[k].candidateIdx],
      hz: adjustedMeta[k].hz,
    }));
    const reshiftedSamples = await shift200BatchGpu(shiftInputs);
    const samples200ByReshiftK = new Map<number, Float32Array>();
    needsShiftIdx.forEach((k, i) => samples200ByReshiftK.set(k, reshiftedSamples[i]));

    const reExtractInputs: SymbolExtractCandidateInput[] = reshiftIdx.map(k => ({
      samples200: samples200ByReshiftK.get(k) ?? samples200PerCandidate[extractMeta[k].candidateIdx],
      off: adjustedMeta[k].off,
    }));
    const reExtracted = await runSymbolExtractGpu(reExtractInputs);
    reshiftIdx.forEach((k, i) => { finalM79[k] = reExtracted[i]; });
  }

  const llrPerCandidate = finalM79.length > 0 ? await runSoftDecodeGpu(finalM79) : [];
  const tFineSyncEnd = performance.now();

  const results: Array<GpuDecodeResult & { orderIndex: number }> = [];
  let ldpcMs = 0;
  let osdMs = 0;

  if (llrPerCandidate.length > 0) {
    const llrF32 = llrPerCandidate.map(ll174 => new Float32Array(ll174));
    const ldpcResult = await runLdpcDecodeGpu(llrF32, 25);
    ldpcMs = ldpcResult.timings.totalMs;

    // Candidates whose clean LDPC belief-propagation is "close but not
    // perfect" (osd_ldpc_thresh <= ok < 83) get a second attempt via OSD —
    // matches decode()'s own gating (ft8.cc:2187-2222): OSD is never tried
    // on a candidate that already cleanly converged, nor on one whose BP
    // result is too far off to be worth the extra work.
    const osdIdx: number[] = [];
    const osdInputs: Float32Array[] = [];
    for (let k = 0; k < llrF32.length; k++) {
      if (ldpcResult.ok[k] === LDPC_CHECKS) continue;
      if (ldpcResult.ok[k] < OSD_LDPC_THRESH) continue;
      osdIdx.push(k);
      osdInputs.push(llrF32[k]);
    }
    const osdResult = osdInputs.length > 0 ? await runOsdDecodeGpu(osdInputs, OSD_DEPTH) : null;
    if (osdResult) osdMs = osdResult.timings.totalMs;

    for (let k = 0; k < llrF32.length; k++) {
      const candidateIdx = extractMeta[k].candidateIdx;
      const meta = adjustedMeta[k];
      const snr = guessSnr(finalM79[k]);

      let plain: Uint8Array | null = null;
      let osdDepthUsed = -1;

      if (ldpcResult.ok[k] === LDPC_CHECKS && checkCrc(ldpcResult.plain[k])) {
        plain = ldpcResult.plain[k];
      } else {
        const osdK = osdIdx.indexOf(k);
        if (osdK !== -1 && osdResult && osdResult.ok[osdK]) {
          // osdDecode.ts/webgpuOsdDecode.ts's plain[] is 91 payload bits
          // only (no parity) — re-encode to the full 174-bit codeword via
          // the SAME generator matrix osd_score()/osd_check() already
          // validated this message against (ldpcEncode(), osd.cc:19-35's
          // own ldpc_encode()) so GpuDecodeResult.plain has the same shape
          // LDPC's own output has (unpack()'s a77 slice only ever needs the
          // first 77 bits, but keeping the full 174 matches the LDPC
          // branch's own contract and any future use of the parity bits).
          plain = ldpcEncode(osdResult.plain[osdK]);
          osdDepthUsed = osdResult.depthUsed[osdK];
        }
      }

      if (!plain) continue;

      results.push({
        freqHz: candidates[candidateIdx].hz + meta.hz - 25.0,
        dtSec: meta.off / 200.0 - 0.5,
        snr,
        plain,
        candidateCount: candidates.length,
        orderIndex: candidateIdx,
        pass: passIndex,
        osd: osdDepthUsed,
      });
    }
  }

  return { results, coarseSearchMs, wholeBufferFftMs, fineSyncMs: tFineSyncEnd - tFineSync0, ldpcMs, osdMs };
}

/** Full pipeline: real captured 12kHz-resampled audio (one 15s window,
 *  already through resampleTo12k) -> decoded FT8 messages, GPU-accelerated
 *  end to end (coarse search, fine sync, symbol extraction, soft-decode,
 *  LDPC, OSD fallback, spectral subtraction all run on GPU; only cheap
 *  scalar/small-array bookkeeping stays on CPU/JS). Runs up to NPASSES
 *  passes, subtracting each pass's successful decodes before the next. */
export async function decodeGpu(
  samples12k: Float32Array,
  params: GpuDecodeParams,
): Promise<{ results: GpuDecodeResult[]; timings: GpuDecodeTimings }> {
  const t0 = performance.now();
  const nSymbols = Math.floor(samples12k.length / BLOCK);
  const samplesBySymbol0 = samples12k.subarray(0, nSymbols * BLOCK);

  if (nSymbols < 79) {
    const tEnd = performance.now();
    return {
      results: [],
      timings: {
        coarseSearchMs: 0, wholeBufferFftMs: 0, fineSyncMs: 0, ldpcMs: 0, osdMs: 0, subtractMs: 0,
        totalMs: tEnd - t0, passesRun: 0,
      },
    };
  }

  let residual = samplesBySymbol0;
  const allResults: Array<GpuDecodeResult & { orderIndex: number }> = [];
  let totalCoarseSearchMs = 0, totalWholeBufferFftMs = 0, totalFineSyncMs = 0, totalLdpcMs = 0, totalOsdMs = 0, totalSubtractMs = 0;
  let passesRun = 0;

  for (let pass = 0; pass < NPASSES; pass++) {
    passesRun++;
    const passResult = await runOnePass(residual, nSymbols, params.maxCandidates, pass);
    totalCoarseSearchMs += passResult.coarseSearchMs;
    totalWholeBufferFftMs += passResult.wholeBufferFftMs;
    totalFineSyncMs += passResult.fineSyncMs;
    totalLdpcMs += passResult.ldpcMs;
    totalOsdMs += passResult.osdMs;

    if (passResult.results.length === 0) break; // nothing new — no point subtracting/continuing

    allResults.push(...passResult.results);

    if (pass < NPASSES - 1) {
      // try_decode()'s own subtract() call (ft8.cc:2971-2978) uses
      // best_off_samples/200.0 (samples200-domain offset -> seconds) as
      // off_sec, NOT the WSJT-X-display-normalized dtSec ("0 = exactly on
      // time") this pipeline reports in GpuDecodeResult — dtSec = off/200
      // - 0.5, so undo that -0.5 to recover the raw seconds subtract()
      // actually needs (ft8.cc:2955: `double best_off = best_off_samples /
      // 200.0;`, no further adjustment before reaching subtract()).
      const strongestFirst = passResult.results.slice().sort((a, b) => b.snr - a.snr);
      const subtractCandidates: SubtractGpuCandidate[] = strongestFirst.slice(0, MAX_SUBTRACT_PER_PASS).map(r => ({
        re79: recode(Array.from(r.plain)),
        hz0: r.freqHz,
        hz1: r.freqHz,
        offSec: r.dtSec + 0.5,
      }));
      const tSubtract0 = performance.now();
      residual = await runSubtractGpu(residual, subtractCandidates, RATE);
      totalSubtractMs += performance.now() - tSubtract0;
    }
  }

  const tEnd = performance.now();

  // Dedup by ~27Hz frequency bucket ACROSS ALL PASSES, keeping only the
  // STRONGEST successful decode per bucket — mirrors already[]
  // (ft8.cc:905-928). A candidate found again in a LATER pass at the same
  // frequency (e.g. a residual artifact) must not create a duplicate
  // contact; sort by pass ascending then orderIndex ascending so pass 0's
  // (strongest-first-within-pass) results always win a tie.
  allResults.sort((a, b) => (a.pass - b.pass) || (a.orderIndex - b.orderIndex));
  const seenBuckets = new Set<number>();
  const results: GpuDecodeResult[] = [];
  for (const r of allResults) {
    const bucket = Math.round(r.freqHz / ALREADY_HZ);
    if (seenBuckets.has(bucket)) continue;
    seenBuckets.add(bucket);
    const { orderIndex: _orderIndex, ...result } = r;
    results.push(result);
  }

  const timings: GpuDecodeTimings = {
    coarseSearchMs: totalCoarseSearchMs,
    wholeBufferFftMs: totalWholeBufferFftMs,
    fineSyncMs: totalFineSyncMs,
    ldpcMs: totalLdpcMs,
    osdMs: totalOsdMs,
    subtractMs: totalSubtractMs,
    totalMs: tEnd - t0,
    passesRun,
  };

  return { results, timings };
}

// Mirrors webgpuSearchBoth.ts's buildFlatCandidate()'s own window-length/
// smoothness validation, WITHOUT building the full flattened GPU payload —
// just enough to decide "would this candidate be rejected", so invalid
// candidates can be filtered out here instead of throwing away the whole
// batch when runSearchBothGpu validates internally.
function buildFlatCandidateDryRun(input: SearchBothCandidateInput): void {
  const { hz0, hzWin, off0, offWin, offN } = input;
  const off0In = off0 - offWin;
  const offNval = off0 + offWin;
  const off0Clamped = Math.max(0, off0In);
  const n = (offNval - off0Clamped) + 79 * 32 + 32;
  if (off0Clamped + n > input.samples200.length) {
    throw new Error('window runs past samples200.length');
  }
  const offInc = Math.max(1, Math.round((2 * offWin) / offN));
  if (offInc < 1) throw new Error('invalid offInc');
  let remaining = n;
  for (const p of [2, 3, 5]) while (remaining % p === 0) remaining /= p;
  if (remaining !== 1) throw new Error('window length not 2/3/5-smooth');
  void hz0;
}
