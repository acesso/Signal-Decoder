// Top-level GPU-accelerated orchestration for subtract() (see subtract.ts
// for the CPU reference this must match, subtractFused.wgsl/
// webgpuSubtract.ts for the per-candidate windowed GPU kernel this composes
// with). NOT wired into gpuDecodePipeline.ts's multi-pass loop — standalone,
// currently-unused capability, per this task's own scope.
//
// GPU/CPU split (see this module's own doc comment further down for the
// full justification):
//  - analytic()/hilbert_shift()'s whole-buffer FFT/IFFT MUST stay on CPU:
//    a real 15s/12kHz capture is ~180000 samples, far beyond
//    fftGeneralFused.wgsl's fixed MAX_N=4096 workgroup-array size (see
//    fftWorkgroupBudget.ts) — there is no GPU kernel in this repo capable of
//    an FFT this large at all, so this is not a "could go either way"
//    judgment call, it is the same hard ceiling gpuDecodePipeline.ts's own
//    wholeBufferBins already documents and works around identically.
//  - per-candidate LO-modulation to build "moved" (hilbert_shift's forward
//    direction) is a cheap O(window) per-sample complex multiply, done here
//    on CPU as a tight loop over just the candidate's own window (NOT the
//    whole buffer — only the window subtractFused.wgsl actually reads is
//    ever computed), since it depends on the SAME whole-buffer analytic
//    signal `y` shared across all candidates in a pass.
//  - per-symbol amplitude/phase extraction + ramped synthesis/subtraction:
//    GPU-batched via runSubtractFusedGpu (subtractFused.wgsl) — see that
//    module for the kernel. This is where real GPU parallelism pays off:
//    79 symbols x 1920-sample single-bin DFT + ramp math, per candidate,
//    fully independent across candidates in the batch.
//  - hilbert_shift's INVERSE (un-shifting the modified window back) also
//    requires a fresh WHOLE-BUFFER analytic() transform (verified NOT to be
//    exactly reproducible via "undo the forward shift" shortcut — a direct
//    numeric test of hilbertShift(hilbertShift(x,d0,d1),-d0,-d1) against x
//    showed non-trivial round-trip error, so this is NOT an identity to
//    exploit) — so it stays on CPU too, applied to a zero-padded buffer
//    containing only the per-candidate WINDOWED delta (moved-vs-residual),
//    not the whole modified buffer, keeping this step's CPU cost
//    proportional to nsamples.length (one whole-buffer FFT) per candidate,
//    same order as gpuDecodePipeline.ts's own wholeBufferBins cost, not
//    proportional to window size.
//
// MULTI-CANDIDATE COMBINING (batch-within-pass): the reference algorithm's
// true behavior subtracts candidates ONE AT A TIME, serially, strongest
// first (try_decode()'s own subtract() call happens inside go()'s per-
// candidate loop). This module instead computes each candidate's own
// residual delta INDEPENDENTLY (against the SAME shared original nsamples,
// not against each other's partially-subtracted output) and SUMS the
// deltas into one combined residual. This is the natural batch-within-pass
// approximation of sequential subtraction: verified below (see
// subtractGpu.test.ts) that summing 2 independently-computed deltas from
// non-overlapping-frequency signals matches sequential order-subtraction to
// a tight numeric tolerance.
import { analytic, blocksize, subtractDecodedSignal } from './subtract';
import { runSubtractFusedGpu, SUBTRACT_LEFT_MARGIN, type SubtractFusedCandidateInput } from './webgpuSubtract';

const SUBTRACT_RAMP = 0.11;
const BLOCK = 1920;

export interface SubtractGpuCandidate {
  re79: number[]; // 79 corrected symbol numbers (0-7), from recode()
  hz0: number;
  hz1: number;
  offSec: number;
}

/** Applies the LO-modulation half of hilbert_shift() (fft.cc:552-556) to a
 *  SLICE of the whole-buffer analytic signal `y`, rather than the whole
 *  buffer — valid because the LO factor at absolute sample index `i` only
 *  depends on `i` itself (and hz0/hz1/n, all known ahead of time), so this
 *  is exactly hilbert_shift(nsamples,hz0,hz1,rate)[absStart..absStart+len)
 *  computed directly from `y`, without redoing the whole-buffer analytic()
 *  FFT per candidate (already computed once, shared, by the caller). */
function loModulateSlice(y: Array<[number, number]>, absStart: number, len: number, hz0: number, hz1: number, rate: number): Float32Array {
  const n = y.length;
  const dt = 1.0 / rate;
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const absIdx = absStart + i;
    if (absIdx < 0 || absIdx >= n) { out[i] = 0; continue; }
    const hz = hz0 + (absIdx / n) * (hz1 - hz0);
    const theta = 2 * Math.PI * hz * dt * absIdx;
    const loRe = Math.cos(theta);
    const loIm = Math.sin(theta);
    out[i] = loRe * y[absIdx][0] - loIm * y[absIdx][1];
  }
  return out;
}

/** The exact CPU-side counterpart of loModulateSlice, but for the INVERSE
 *  shift applied to a zero-padded delta buffer (used to un-shift each
 *  candidate's windowed subtraction delta back to nsamples' original
 *  frequency frame) — this genuinely needs a fresh whole-buffer analytic()
 *  of the delta (Hilbert transform is non-local), unlike the forward slice
 *  above (see module header for why the forward direction can be sliced
 *  but the inverse cannot). */
function hilbertShiftFull(deltaFull: Float64Array, hz0: number, hz1: number, rate: number): Float64Array {
  const y = analytic(deltaFull);
  const dt = 1.0 / rate;
  const n = deltaFull.length;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const hz = hz0 + (i / n) * (hz1 - hz0);
    const theta = 2 * Math.PI * hz * dt * i;
    out[i] = Math.cos(theta) * y[i][0] - Math.sin(theta) * y[i][1];
  }
  return out;
}

/** GPU-accelerated batched subtraction: removes MULTIPLE already-decoded
 *  candidates from `nsamples` in one pass, combining their independent
 *  residual deltas by summation (see module header for the justification
 *  and its documented approximation of true sequential subtraction). */
export async function runSubtractGpu(
  nsamples: Float32Array,
  candidates: SubtractGpuCandidate[],
  rate: number,
): Promise<Float32Array> {
  if (candidates.length === 0) return nsamples.slice();

  const block = blocksize(rate);
  if (block !== BLOCK) {
    throw new Error(`runSubtractGpu: this GPU kernel is fixed at block=${BLOCK} (rate=12000); rate=${rate} yields block=${block}.`);
  }
  const binHz = rate / block;
  let ramp = Math.round(block * SUBTRACT_RAMP);
  if (ramp < 1) ramp = 1;

  const nsamplesF64 = new Float64Array(nsamples.length);
  for (let i = 0; i < nsamples.length; i++) nsamplesF64[i] = nsamples[i];

  // Whole-buffer analytic signal, computed ONCE and shared across every
  // candidate in this pass (same "just do this once, re-use" reasoning as
  // ft8.cc:873-874 and gpuDecodePipeline.ts's own wholeBufferBins).
  const y = analytic(nsamplesF64);

  // absStart[k] is the ABSOLUTE sample index (into nsamples) that each
  // candidate's uploaded window starts at — NOT the same as
  // gpuResults[k].windowStart, which webgpuSubtract.ts computes relative to
  // the LOCAL `off0` it was given (SUBTRACT_LEFT_MARGIN, since this
  // orchestration always uploads an already-sliced, locally-zero-based
  // window — see loModulateSlice above). Tracked here explicitly so the
  // delta-placement step below uses the correct absolute position.
  const absStarts: number[] = [];
  const gpuInputs: SubtractFusedCandidateInput[] = candidates.map((c) => {
    const off0 = Math.round(c.offSec * rate);
    const mhz = (c.hz0 + c.hz1) / 2.0;
    const bin0 = Math.round(mhz / binHz);
    const diff0 = bin0 * binHz - c.hz0;
    const diff1 = bin0 * binHz - c.hz1;

    const windowLen = 79 * block + SUBTRACT_LEFT_MARGIN;
    const absStart = off0 - SUBTRACT_LEFT_MARGIN;
    absStarts.push(absStart);
    const movedWindow = loModulateSlice(y, absStart, windowLen, diff0, diff1, rate);

    return { moved: movedWindow, off0: SUBTRACT_LEFT_MARGIN, bin0, re79: c.re79, ramp };
  });

  const gpuResults = await runSubtractFusedGpu(gpuInputs);

  // For each candidate: build a zero-padded, WHOLE-buffer-length delta
  // (movedWindow - residualWindow, at the window's absolute position, zero
  // elsewhere), then un-shift it back via a fresh whole-buffer
  // hilbert_shift (see module header — this cannot be sliced/localized).
  const combinedDelta = new Float64Array(nsamples.length);
  for (let k = 0; k < candidates.length; k++) {
    const c = candidates[k];
    const mhz = (c.hz0 + c.hz1) / 2.0;
    const bin0 = Math.round(mhz / binHz);
    const diff0 = bin0 * binHz - c.hz0;
    const diff1 = bin0 * binHz - c.hz1;

    const { residualWindow } = gpuResults[k];
    const gpuInput = gpuInputs[k];
    const absStart = absStarts[k];

    // residualWindow.length is the KERNEL's fixed MAX_WINDOW_LEN buffer
    // size (padding included), NOT the true per-candidate window length —
    // only iterate over gpuInput.moved's true length (79*block+LEFT_MARGIN)
    // to avoid reading past moved's actual data (which would silently
    // produce NaN via `undefined - number`, a real bug caught only by
    // running this against the actual GPU kernel, not by code review).
    const trueWindowLen = gpuInput.moved.length;
    const deltaFull = new Float64Array(nsamples.length);
    for (let i = 0; i < trueWindowLen; i++) {
      const absIdx = absStart + i;
      if (absIdx < 0 || absIdx >= nsamples.length) continue;
      deltaFull[absIdx] = gpuInput.moved[i] - residualWindow[i];
    }

    const unshiftedDelta = hilbertShiftFull(deltaFull, -diff0, -diff1, rate);
    for (let i = 0; i < combinedDelta.length; i++) combinedDelta[i] += unshiftedDelta[i];
  }

  const out = new Float32Array(nsamples.length);
  for (let i = 0; i < out.length; i++) out[i] = nsamplesF64[i] - combinedDelta[i];
  return out;
}

/** CPU-only reference for the SAME "batch by summing independent deltas"
 *  combining strategy, WITHOUT the GPU kernel — used by subtractGpu.test.ts
 *  to isolate whether any mismatch against the GPU path comes from the
 *  combining strategy itself or from the GPU kernel's numerics, and to
 *  compare against subtract.ts's own strictly-sequential
 *  subtractDecodedSignal() for the "does batching approximate sequential
 *  subtraction" check the task doc asks for. */
export function subtractSequentialCpu(nsamples: Float32Array, candidates: SubtractGpuCandidate[], rate: number): Float32Array {
  const start = new Float64Array(nsamples.length);
  for (let i = 0; i < nsamples.length; i++) start[i] = nsamples[i];
  let cur: Float64Array = start;
  for (const c of candidates) {
    cur = subtractDecodedSignal(cur, c.re79, c.hz0, c.hz1, c.offSec, rate);
  }
  const out = new Float32Array(cur.length);
  for (let i = 0; i < cur.length; i++) out[i] = cur[i];
  return out;
}
