// Plain-TS reference for the coarse Costas-sync correlation math — mirrors
// costasCorrelation.wgsl exactly (same COSTAS array, same coarse_all=-1 /
// coarse_strength_how=6 formula from one_coarse_strength() in
// lib/ft8mon/ft8.cc:482-559), so it can be (a) unit tested in Jest, where
// jsdom has no WebGPU, and (b) used as ft8mon's own values via the
// PROF-instrumented WASM build.

export const COSTAS = [3, 1, 4, 0, 6, 5, 2] as const;

/** `bins` is a flat, row-major (time-major) spectrogram: bins[si * nbins + bi]
 *  as a magnitude (already |complex|, not raw re/im) — pass mags directly to
 *  keep this usable both as a correctness oracle for the WGSL kernel (which
 *  takes complex vec2<f32> and computes magnitude itself) and as a thin
 *  wrapper over a real complex spectrogram via magSpectrogram() below. */
export function oneCoarseStrength(
  mags: Float64Array,
  nbins: number,
  nSymbols: number,
  si0Cell: number,
  bi0Cell: number,
): number {
  if (si0Cell + 79 >= nSymbols || bi0Cell + 8 > nbins) return 0;

  let sig = 0;
  let noise = 0;
  for (let si = 0; si < 7; si++) {
    const costasTone = COSTAS[si];
    for (let bi = 0; bi < 8; bi++) {
      let x = 0;
      x += mags[(si0Cell + si) * nbins + bi0Cell + bi];
      x += mags[(si0Cell + 36 + si) * nbins + bi0Cell + bi];
      x += mags[(si0Cell + 72 + si) * nbins + bi0Cell + bi];
      if (bi === costasTone) sig += x;
      else noise += x;
    }
  }
  return sig / noise; // coarse_strength_how === 6
}

export interface CoarseGridParams {
  si0: number;
  siCount: number;
  bi0: number;
  biCount: number;
  nbins: number;
  nSymbols: number;
}

/** Dense (si, bi) grid evaluation — same row-major (si-outer, bi-inner)
 *  layout as the WGSL kernel's `idx = si_local * bi_count + bi_local`. */
export function coarseGrid(mags: Float64Array, params: CoarseGridParams): Float64Array {
  const { si0, siCount, bi0, biCount, nbins, nSymbols } = params;
  const out = new Float64Array(siCount * biCount);
  for (let siLocal = 0; siLocal < siCount; siLocal++) {
    for (let biLocal = 0; biLocal < biCount; biLocal++) {
      out[siLocal * biCount + biLocal] = oneCoarseStrength(
        mags, nbins, nSymbols, si0 + siLocal, bi0 + biLocal,
      );
    }
  }
  return out;
}

/** Converts an interleaved [re,im,...] spectrogram (nSymbols rows of nbins
 *  complex bins each) into a flat magnitude array of the same (si, bi)
 *  shape, for feeding into oneCoarseStrength/coarseGrid. */
export function magSpectrogram(interleaved: Float64Array, nSymbols: number, nbins: number): Float64Array {
  const out = new Float64Array(nSymbols * nbins);
  for (let i = 0; i < nSymbols * nbins; i++) {
    const re = interleaved[i * 2];
    const im = interleaved[i * 2 + 1];
    out[i] = Math.hypot(re, im);
  }
  return out;
}
