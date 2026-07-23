// General-purpose (non-GPU, non-Stockham-optimized) real FFT/IFFT and
// related DSP primitives — used by the fine-sync/LLR-extraction bridge
// (fineSync.ts, softDecode.ts) that runs a SMALL per-candidate grid search
// (tens of candidates, not thousands of FFT bins like the coarse search),
// so a plain O(N^2) or simple recursive-radix DFT is fast enough and much
// simpler to keep provably correct than a second Stockham port. Mirrors
// lib/ft8mon/fft.cc's one_fft()/one_ifft() exactly: real-valued input,
// `block/2+1` complex output bins (rfft convention), same for the inverse.
//
// Complex values are represented as [re, im] tuples throughout this module
// (not interleaved arrays) since these functions work on much smaller N
// (32, up to ~1920) than the coarse-search hot path and clarity matters
// more here than avoiding tuple-array allocation overhead.

export type Complex = [number, number];

function cmul(a: Complex, b: Complex): Complex {
  return [a[0] * b[0] - a[1] * b[1], a[0] * b[1] + a[1] * b[0]];
}
function cadd(a: Complex, b: Complex): Complex {
  return [a[0] + b[0], a[1] + b[1]];
}
function csub(a: Complex, b: Complex): Complex {
  return [a[0] - b[0], a[1] - b[1]];
}

/** Real-to-complex FFT via direct O(N^2) DFT — mirrors one_fft()'s rfft
 *  convention: `block` real input samples (starting at `i0` in `samples`,
 *  zero-padded past the end exactly like ft8mon's own out-of-range handling
 *  at fft.cc:200-206), `block/2+1` complex output bins. */
export function realFft(samples: Float64Array | number[], i0: number, block: number): Complex[] {
  const nSamples = samples.length;
  const nBins = Math.floor(block / 2) + 1;
  const out: Complex[] = new Array(nBins);
  for (let k = 0; k < nBins; k++) {
    let re = 0;
    let im = 0;
    const theta0 = (-2 * Math.PI * k) / block;
    for (let n = 0; n < block; n++) {
      const idx = i0 + n;
      const x = idx < nSamples ? samples[idx] : 0;
      if (x === 0) continue;
      const theta = theta0 * n;
      re += x * Math.cos(theta);
      im += x * Math.sin(theta);
    }
    out[k] = [re, im];
  }
  return out;
}

/** Computes only bins [k0, k0+count) of the real-to-complex rfft of a
 *  LARGE sample buffer (e.g. a full ~15s/12kHz capture, ~180000 samples) —
 *  a full realFft() over such a buffer would be O(N * nBins), impractically
 *  slow; this is a targeted partial DFT, O(count * N), used specifically
 *  because down_v7_f() only ever reads a narrow (~100Hz-wide) band of bins
 *  from the whole-buffer FFT before zeroing everything else via
 *  fbandpass() — computing the full spectrum would waste >99% of the work
 *  on bins that get discarded immediately after. Returns an array of
 *  `count` complex bins, where result[i] corresponds to bin `k0+i`; bins
 *  requested past the Nyquist bin (block/2) return [0,0] (matching
 *  one_fft()'s own nBins=block/2+1 cap — callers must not request k0+count
 *  beyond that or they'll silently get zeros, same as reading past
 *  ft8mon's own bins.size()). */
export function realFftBins(samples: Float64Array | Float32Array, block: number, k0: number, count: number): Complex[] {
  const nSamples = samples.length;
  const maxBin = Math.floor(block / 2); // inclusive — matches one_fft()'s nbins = block/2+1
  const out: Complex[] = new Array(count);
  for (let i = 0; i < count; i++) {
    const k = k0 + i;
    if (k < 0 || k > maxBin) { out[i] = [0, 0]; continue; }
    let re = 0;
    let im = 0;
    const theta0 = (-2 * Math.PI * k) / block;
    for (let n = 0; n < block; n++) {
      const x = n < nSamples ? samples[n] : 0;
      if (x === 0) continue;
      const theta = theta0 * n;
      re += x * Math.cos(theta);
      im += x * Math.sin(theta);
    }
    out[i] = [re, im];
  }
  return out;
}

/** Complex-to-real IFFT via direct O(N^2) inverse DFT — mirrors
 *  one_ifft(): `bins.length` complex input bins (rfft convention, i.e.
 *  nBins = block/2+1), `block = (nBins-1)*2` real output samples. Assumes
 *  the input is the rfft of a real signal (uses conjugate symmetry to
 *  reconstruct the negative-frequency half, exactly like FFTW's
 *  c2r plan does — does NOT re-derive it from an arbitrary complex
 *  spectrum). */
export function realIfft(bins: Complex[]): Float64Array {
  const nBins = bins.length;
  const block = (nBins - 1) * 2;
  const out = new Float64Array(block);
  for (let n = 0; n < block; n++) {
    let sum = bins[0][0]; // DC, real-only contribution
    for (let k = 1; k < nBins - 1; k++) {
      const theta = (2 * Math.PI * k * n) / block;
      const [re, im] = bins[k];
      // full spectrum bin k contributes re*cos - im*sin; conjugate bin
      // (block-k) contributes the identical real part again (conjugate
      // symmetry for a real-valued time signal) -> factor of 2.
      sum += 2 * (re * Math.cos(theta) - im * Math.sin(theta));
    }
    if (block % 2 === 0) {
      // Nyquist bin (k = block/2) is its own conjugate, counted once, and
      // must be real by rfft convention (its imaginary part is ignored,
      // matching FFTW's c2r behavior).
      const nyquist = bins[nBins - 1][0];
      sum += nyquist * Math.cos(Math.PI * n);
    }
    out[n] = sum;
  }
  return out;
}

/** Bandpass filter FFT bins with a linear-taper transition (the `#if 1`
 *  active branch in ft8mon's fbandpass(), ft8.cc:2233-2285 — NOT the
 *  `#else` cosine-taper branch, which is dead code there). */
export function fbandpass(
  bins: Complex[],
  binHz: number,
  lowOuter: number, lowInner: number,
  highInner: number, highOuter: number,
): Complex[] {
  const out: Complex[] = new Array(bins.length);
  for (let i = 0; i < bins.length; i++) {
    const ihz = i * binHz;
    let factor: number;
    if (ihz <= lowOuter || ihz >= highOuter) {
      factor = 0;
    } else if (ihz >= lowOuter && ihz < lowInner) {
      factor = (ihz - lowOuter) / (lowInner - lowOuter);
    } else if (ihz > highInner && ihz <= highOuter) {
      factor = (highOuter - ihz) / (highOuter - highInner);
    } else {
      factor = 1.0;
    }
    out[i] = [bins[i][0] * factor, bins[i][1] * factor];
  }
  return out;
}

/** Shift a real-to-complex spectrum down in frequency by `down` bins,
 *  zero-filling bins that shift out of range — mirrors fft_shift_f()
 *  (ft8.cc:1252-1270) and the equivalent shift in down_v7_f()
 *  (ft8.cc:2305-2320): `bins1[i] = bins[i + down]`, or 0 if out of range. */
export function shiftBins(bins: Complex[], down: number): Complex[] {
  const nbins = bins.length;
  const out: Complex[] = new Array(nbins);
  for (let i = 0; i < nbins; i++) {
    const j = i + down;
    out[i] = j >= 0 && j < nbins ? bins[j] : [0, 0];
  }
  return out;
}

export { cmul, cadd, csub };

/** Blackman window of length n — mirrors blackman() (ft8.cc:129-137). */
export function blackman(n: number): Float64Array {
  const h = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    h[k] = 0.42 - 0.5 * Math.cos((2 * Math.PI * k) / n) + 0.08 * Math.cos((4 * Math.PI * k) / n);
  }
  return h;
}
