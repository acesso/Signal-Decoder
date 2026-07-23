// Per-candidate fine sync refinement + baseband extraction — bridges the
// GPU coarse Costas-search output (a (hz, off) cell at 12kHz/1920-pt-FFT
// resolution) to the 200sps baseband samples the symbol-extraction stage
// (extract() in ft8.cc, ported in symbolExtract.ts) needs. Mirrors
// down_v7_f() (ft8.cc:2305-2345), one_strength()/search_time_fine()/
// search_both() (ft8.cc:937-1158), shift200() (ft8.cc:1273-1284), and
// fine() (ft8.cc:2480-2630) — all confirmed stateless, no WASM/hash-table
// dependency (see the scoping investigation this module was built from).
//
// This runs on the CPU/JS main thread for each GPU-coarse-search candidate
// — a small (tens of candidates) per-window grid search, not a GPU
// workload. downV7f itself uses dsp.ts's direct-DFT realFft only for the
// tiny 32-point per-symbol FFTs in oneStrength (cheap at that size); but
// shift200's whole-window (~1000-3000 sample) FFT+IFFT MUST use
// fftGeneral's fast O(N log N) transform, not a direct O(N^2) DFT — an
// earlier version of this file used dsp.ts's realFft/realIfft there and
// measured ~6.3 SECONDS per fine-sync candidate (126s for 20 candidates),
// which fftGeneral's Stockham-based transform cuts to well under a
// millisecond per call (see fftGeneralIfft.test.ts's own speed assertion).
import { fbandpass, shiftBins, type Complex } from './dsp';
import { realFftGeneral, realIfftGeneral } from './fftGeneral';
import { realFft } from './dsp';

const RATE = 12000; // ft8mon's fixed internal decode rate (resample_to_12k())
const SHOULDER200 = 10;
const SHOULDER200_EXTRA = 0.0;
const SECOND_HZ_WIN = 3.5;
// ft8mon's own defaults are second_hz_n=8/second_off_n=10 (ft8.cc:54-57) — a
// grid-size sweep against the full 22-file real-WAV corpus (31-file test
// set minus files with no .txt ground truth) found HALVING both to 4/5 costs
// only 3/353 matched messages (217->214) for a 41% per-candidate speed cut
// (142ms -> 83ms), while a further cut to 2/3 loses a real 8.3% of matches
// (217->199) — not just noise. Halved here since fine-sync is this
// pipeline's dominant cost (93% of total decode time measured live) and
// this is effectively free accuracy to give up for the speed.
const SECOND_HZ_N = 4;
const SECOND_OFF_WIN = 0.5; // +/- symbol-times
const SECOND_OFF_N = 5;
const FINE_THRESH = 0.19;
const FINE_MAX_OFF = 2;
const FINE_MAX_TONE = 4;
const COSTAS = [3, 1, 4, 0, 6, 5, 2] as const;

/** down_v7_f(): move `hz` down to 25Hz, bandpass-filter, resample to
 *  200sps. `bins` is the full-rate (12kHz/1920-pt) spectrogram FFT of the
 *  candidate's symbol window (same convention as one_fft() — real input,
 *  `len/2+1` complex output bins), `len` is the ORIGINAL time-domain
 *  sample count that FFT came from (not the bin count). */
export function downV7f(bins: Complex[], len: number, hz: number): Float64Array {
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

  const blen = Math.round(len * (200.0 / RATE));
  const nBbins = Math.floor(blen / 2) + 1;
  const bbins: Complex[] = new Array(nBbins);
  for (let i = 0; i < nBbins; i++) bbins[i] = i < bins1.length ? bins1[i] : [0, 0];

  return realIfftGeneral(bbins);
}

/** one_strength() (ft8.cc:937-980, strength_how=4 i.e. plain signal sum —
 *  this repo's active default, see the source investigation): Costas-sync
 *  correlation strength at 200sps, hz assumed near 25 (tone-0 bin center),
 *  off in samples. */
export function oneStrength(samples200: Float64Array | number[], hz: number, off: number): number {
  const bin0 = Math.round(hz / 6.25);
  const starts = [0, 36, 72];
  let sig = 0;

  for (const start of starts) {
    for (let si = 0; si < 7; si++) {
      const fft = realFft(samples200, off + (si + start) * 32, 32);
      for (let bi = 0; bi < 8; bi++) {
        const x = Math.hypot(fft[bin0 + bi][0], fft[bin0 + bi][1]);
        if (bi === COSTAS[si]) sig += x;
        // strength_how=4 ignores noise entirely (return sig).
      }
    }
  }
  return sig;
}

/** shift200(): shift samples200's frequency so `hz` lands at bin 4 (25Hz) —
 *  ft8.cc:1273-1284, via a whole-buffer FFT + integer-bin-shift + IFFT
 *  (fft_shift, ft8.cc:1222-1247; the mutex-guarded "hack" cache there is a
 *  pure speed optimization for repeated identical calls, irrelevant to
 *  correctness — always recomputed here). */
export function shift200(samples200: Float64Array | number[], off: number, len: number, hz: number): Float64Array {
  if (Math.abs(hz - 25) < 0.001 && off === 0 && len === samples200.length) {
    return samples200 instanceof Float64Array ? samples200 : new Float64Array(samples200);
  }
  // Extract the [off, off+len) window into its own zero-padded array first
  // — realFftGeneral (unlike dsp.ts's realFft) takes a plain sample array
  // starting at index 0, not an (array, offset, block) triple, so the
  // offset has to be materialized here rather than passed through.
  const windowed = new Float64Array(len);
  for (let i = 0; i < len; i++) {
    const idx = off + i;
    windowed[i] = idx < samples200.length ? samples200[idx] : 0;
  }
  const bins = realFftGeneral(windowed, len);
  const binHz = 200 / len;
  const down = Math.round((hz - 25.0) / binHz);
  const shifted = shiftBins(bins, down);
  return realIfftGeneral(shifted);
}

export interface Strength {
  hz: number;
  off: number;
  strength: number;
}

/** search_time_fine() (ft8.cc:1046-1084): best time offset for a
 *  hypothesized `hz`, searching `[off0, offN]` in steps of `gran`. Returns
 *  null if the window would run past the end of samples200 (matching
 *  ft8.cc:1063-1067's early return). */
export function searchTimeFine(
  samples200: Float64Array, off0In: number, offN: number, hz: number, gran: number,
): { off: number; strength: number } | null {
  const off0 = Math.max(0, off0In);
  const len = (offN - off0) + 79 * 32 + 32;
  if (off0 + len > samples200.length) return null;

  const downsamples200 = shift200(samples200, off0, len, hz);

  let bestOff = -1;
  let bestSum = 0.0;
  for (let g = 0; g <= (offN - off0) && g + 79 * 32 <= len; g += gran) {
    const sum = oneStrength(downsamples200, 25, g);
    if (sum > bestSum || bestOff === -1) {
      bestOff = g;
      bestSum = sum;
    }
  }
  if (bestOff === -1) return null;
  return { off: off0 + bestOff, strength: bestSum };
}

/** search_both() (ft8.cc:1130-1158): 2D grid search over (hz, off) around
 *  the coarse candidate's estimate, refining via searchTimeFine at each hz. */
export function searchBoth(
  samples200: Float64Array,
  hz0: number, hzN: number, hzWin: number,
  off0: number, offN: number, offWin: number,
): Strength[] {
  const strengths: Strength[] = [];
  const hzInc = (2 * hzWin) / hzN;
  let offInc = Math.round((2 * offWin) / offN);
  if (offInc < 1) offInc = 1;

  for (let hz = hz0 - hzWin; hz <= hz0 + hzWin + 0.01; hz += hzInc) {
    const result = searchTimeFine(samples200, off0 - offWin, off0 + offWin, hz, offInc);
    if (result) strengths.push({ hz, off: result.off, strength: result.strength });
  }
  return strengths;
}

/** Wraps search_both with ft8mon's own tunable defaults (second_hz_n=8,
 *  second_hz_win=3.5, second_off_n=10, second_off_win=0.5 symbol-times ->
 *  *32 samples, ft8.cc:54-57) — matches the do_second=1 branch of
 *  one_iter() (ft8.cc:2380-2409), sorted strongest-first exactly like the
 *  caller does before trying candidates in order. */
export function searchBothDefault(samples200: Float64Array, bestOff: number): Strength[] {
  const strengths = searchBoth(samples200, 25, SECOND_HZ_N, SECOND_HZ_WIN, bestOff, SECOND_OFF_N, SECOND_OFF_WIN * 32);
  return strengths.slice().sort((a, b) => b.strength - a.strength);
}

/** fine() (ft8.cc:2480-2630): symbol-to-symbol phase-slope nudge to
 *  best_hz/best_off. `m79` is the 79x8 complex extract() output. Returns
 *  {adjHz, adjOff} — caller applies only if within ft8mon's own acceptance
 *  thresholds (see applyFineAdjustment below, mirroring ft8.cc:2662). */
export function fine(m79: Complex[][]): { adjHz: number; adjOff: number } {
  const sym = new Array(79);
  const symphase = new Array(79);
  const symval = new Array(79);

  for (let i = 0; i < 79; i++) {
    if (i < 7) {
      sym[i] = COSTAS[i];
    } else if (i >= 36 && i < 36 + 7) {
      sym[i] = COSTAS[i - 36];
    } else if (i >= 72) {
      sym[i] = COSTAS[i - 72];
    } else {
      let mxj = -1;
      let mx = 0;
      for (let j = 0; j < 8; j++) {
        const x = Math.hypot(m79[i][j][0], m79[i][j][1]);
        if (mxj < 0 || x > mx) { mx = x; mxj = j; }
      }
      sym[i] = mxj;
    }
    symphase[i] = Math.atan2(m79[i][sym[i]][1], m79[i][sym[i]][0]);
    symval[i] = Math.hypot(m79[i][sym[i]][0], m79[i][sym[i]][1]);
  }

  let sum = 0;
  let weightSum = 0;
  for (let i = 0; i < 79 - 1; i++) {
    let d = symphase[i + 1] - symphase[i];
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    const w = symval[i];
    sum += d * w;
    weightSum += w;
  }
  const mean = sum / weightSum;
  const errRad = mean;
  const errHz = (errRad / (2 * Math.PI)) / 0.16;
  const adjHz = errHz;

  let nearly = 0;
  let nlate = 0;
  let early = 0.0;
  let late = 0.0;
  for (let i = 1; i < 79; i++) {
    const ph0 = Math.atan2(m79[i - 1][sym[i - 1]][1], m79[i - 1][sym[i - 1]][0]);
    const ph = Math.atan2(m79[i][sym[i]][1], m79[i][sym[i]][0]);
    let d = ph - ph0;
    d -= errRad;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;

    if (sym[i] > sym[i - 1]) {
      if (d > 0 && sym[i] <= FINE_MAX_TONE) { nlate++; late += d / Math.abs(sym[i] - sym[i - 1]); }
      if (d < 0 && sym[i - 1] <= FINE_MAX_TONE) { nearly++; early += Math.abs(d) / Math.abs(sym[i] - sym[i - 1]); }
    } else if (sym[i] < sym[i - 1]) {
      if (d > 0 && sym[i - 1] <= FINE_MAX_TONE) { nearly++; early += d / Math.abs(sym[i] - sym[i - 1]); }
      if (d < 0 && sym[i] <= FINE_MAX_TONE) { nlate++; late += Math.abs(d) / Math.abs(sym[i] - sym[i - 1]); }
    }
  }

  if (nearly > 0) early /= nearly;
  if (nlate > 0) late /= nlate;

  let adjOff = 0;
  if (nearly > 2 * nlate) {
    adjOff = Math.round((32 * early) / FINE_THRESH);
    if (adjOff > FINE_MAX_OFF) adjOff = FINE_MAX_OFF;
  } else if (nlate > 2 * nearly) {
    adjOff = -Math.round((32 * late) / FINE_THRESH);
    if (Math.abs(adjOff) > FINE_MAX_OFF) adjOff = -FINE_MAX_OFF;
  }

  return { adjHz, adjOff };
}

/** Acceptance gate from one_iter1() (ft8.cc:2662): only apply the fine()
 *  adjustment if it's within these small bounds (do_fine_hz/do_fine_off
 *  both default to 1/enabled — ft8.cc:102-103). */
export function shouldApplyFineAdjustment(adjHz: number, adjOff: number): boolean {
  return Math.abs(adjHz) < 6.25 / 4 && Math.abs(adjOff) < 4;
}
