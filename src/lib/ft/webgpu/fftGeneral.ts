// General-length mixed-radix Stockham FFT — generalizes fft1920.ts's
// proven radix-2/3/5 butterfly math (verified against a naive DFT and
// real ft8mon output) to an arbitrary buffer length N, instead of the
// fixed N=1920 used for per-symbol FFTs.
//
// Needed because down_v7_f() (ft8.cc:2305-2345, ported in fineSync.ts)
// operates on ONE whole-capture-buffer FFT (ft8.cc:873-874, "just do this
// once, re-use for every fractional fft_shift") — typically ~15s at
// 12kHz, ~180000 samples — not the 1920-sample per-symbol blocks. A
// direct O(N^2) DFT over a buffer that size is wildly impractical (would
// take seconds per call); this reuses the same proven Stockham radix
// math, generalized to whatever N actually shows up.
//
// ft8mon's own "nice FFTW sizes" (go(), ft8.cc:723-726 — 18000, 18225,
// 36000, ... 218700) are ALL exactly 2^a * 3^b * 5^c (verified), so for
// buffer lengths ft8mon itself would consider "nice," this factors
// perfectly with zero remainder. For arbitrary N (e.g. a live-captured
// window that isn't exactly one of those sizes), any leftover prime
// factor after extracting all 2s/3s/5s is handled by a direct O(rem * N)
// partial-DFT combine pass — correct for any N, and fast as long as the
// remainder is small (true for any N reasonably close to a round number
// of samples, which live audio capture always is).
import type { Complex } from './dsp';

function twiddle(k: number, n: number): [number, number] {
  const theta = (-2 * Math.PI * k) / n;
  return [Math.cos(theta), Math.sin(theta)];
}
function cmul(a: [number, number], b: [number, number]): [number, number] {
  return [a[0] * b[0] - a[1] * b[1], a[0] * b[1] + a[1] * b[0]];
}

const R3_S = 0.8660254037844387;
function radix3(a0: Complex, a1: Complex, a2: Complex): Complex[] {
  const t1: Complex = [a1[0] + a2[0], a1[1] + a2[1]];
  const t2: Complex = [a0[0] - 0.5 * t1[0], a0[1] - 0.5 * t1[1]];
  const t3: Complex = [R3_S * (a1[1] - a2[1]), R3_S * (a2[0] - a1[0])];
  return [
    [a0[0] + t1[0], a0[1] + t1[1]],
    [t2[0] + t3[0], t2[1] + t3[1]],
    [t2[0] - t3[0], t2[1] - t3[1]],
  ];
}

const R5_C1 = 0.30901699437494745;
const R5_S1 = 0.9510565162951535;
const R5_C2 = -0.8090169943749475;
const R5_S2 = 0.5877852522924731;
function radix5(a0: Complex, a1: Complex, a2: Complex, a3: Complex, a4: Complex): Complex[] {
  const out: Complex[] = new Array(5);
  out[0] = [a0[0] + a1[0] + a2[0] + a3[0] + a4[0], a0[1] + a1[1] + a2[1] + a3[1] + a4[1]];
  const b1: Complex = [a1[0] + a4[0], a1[1] + a4[1]];
  const b2: Complex = [a2[0] + a3[0], a2[1] + a3[1]];
  const b3: Complex = [a1[0] - a4[0], a1[1] - a4[1]];
  const b4: Complex = [a2[0] - a3[0], a2[1] - a3[1]];
  const re1 = a0[0] + R5_C1 * b1[0] + R5_C2 * b2[0];
  const re2 = a0[0] + R5_C2 * b1[0] + R5_C1 * b2[0];
  const im1 = a0[1] + R5_C1 * b1[1] + R5_C2 * b2[1];
  const im2 = a0[1] + R5_C2 * b1[1] + R5_C1 * b2[1];
  const ix1 = R5_S1 * b3[0] + R5_S2 * b4[0];
  const ix2 = R5_S2 * b3[0] - R5_S1 * b4[0];
  const iy1 = R5_S1 * b3[1] + R5_S2 * b4[1];
  const iy2 = R5_S2 * b3[1] - R5_S1 * b4[1];
  out[4] = [re1 - iy1, im1 + ix1];
  out[1] = [re1 + iy1, im1 - ix1];
  out[3] = [re2 - iy2, im2 + ix2];
  out[2] = [re2 + iy2, im2 - ix2];
  return out;
}

/** Generic radix-r combine via direct r-point DFT — used only for whatever
 *  prime factor remains after extracting all 2s/3s/5s (typically small;
 *  see module doc). Verified against the closed-form radix2/3/5 above
 *  during fft1920.ts's original derivation (this is the same "generic
 *  radixDFT" formulation that was proven equivalent before the closed-form
 *  butterflies were substituted in for speed — see fftGeneral.test.ts). */
function radixGenericDft(legs: Complex[], r: number): Complex[] {
  const out: Complex[] = new Array(r);
  for (let s = 0; s < r; s++) {
    let acc: Complex = [0, 0];
    for (let t = 0; t < r; t++) {
      const w = twiddle(s * t, r);
      acc = [acc[0] + legs[t][0] * w[0] - legs[t][1] * w[1], acc[1] + legs[t][0] * w[1] + legs[t][1] * w[0]];
    }
    out[s] = acc;
  }
  return out;
}

function radixButterfly(legs: Complex[], r: number): Complex[] {
  if (r === 2) return [
    [legs[0][0] + legs[1][0], legs[0][1] + legs[1][1]],
    [legs[0][0] - legs[1][0], legs[0][1] - legs[1][1]],
  ];
  if (r === 3) return radix3(legs[0], legs[1], legs[2]);
  if (r === 5) return radix5(legs[0], legs[1], legs[2], legs[3], legs[4]);
  return radixGenericDft(legs, r);
}

/** Factors N into a radix schedule: as many 2s/3s/5s as possible (using the
 *  proven closed-form butterflies), then whatever composite/prime factors
 *  remain (using the generic DFT combine) — always yields SOME valid
 *  factorization for any N >= 2, since the final leftover factor is just N
 *  itself if nothing else divides evenly (correct, just slow if N has a
 *  large prime factor — not expected for realistic capture-buffer
 *  lengths). */
export function factorRadixSchedule(n: number): number[] {
  const factors: number[] = [];
  let remaining = n;
  for (const p of [2, 3, 5]) {
    while (remaining % p === 0) {
      factors.push(p);
      remaining /= p;
    }
  }
  if (remaining > 1) factors.push(remaining);
  return factors;
}

/** General-length complex FFT (interleaved [re,im,...] in/out, length
 *  N*2), via mixed-radix Stockham autosort — same stride/twiddle
 *  derivation as fft1920.ts (per-leg twiddle j*t over stride_out modulus,
 *  verified against a naive DFT at multiple N). Does not mutate input
 *  (see fft1920.ts's own history of a real input-mutation bug from
 *  aliasing the ping-pong buffer directly onto the caller's array). */
export function fftGeneral(inputInterleaved: Float64Array, n: number): Float64Array {
  if (inputInterleaved.length !== n * 2) {
    throw new Error(`fftGeneral: expected ${n * 2} interleaved values for N=${n}, got ${inputInterleaved.length}`);
  }
  const factors = factorRadixSchedule(n);

  let src: Complex[] = new Array(n);
  for (let i = 0; i < n; i++) src[i] = [inputInterleaved[i * 2], inputInterleaved[i * 2 + 1]];
  let dst: Complex[] = new Array(n);

  let strideIn = 1;
  for (const r of factors) {
    const strideOut = strideIn * r;
    const groups = n / strideOut;
    for (let block = 0; block < groups; block++) {
      for (let j = 0; j < strideIn; j++) {
        const legs: Complex[] = new Array(r);
        for (let t = 0; t < r; t++) {
          const idx = j + block * strideIn + t * groups * strideIn;
          const w = twiddle(j * t, strideOut);
          legs[t] = cmul(src[idx], w);
        }
        const out = radixButterfly(legs, r);
        const base = block * strideOut + j;
        for (let s = 0; s < r; s++) dst[base + s * strideIn] = out[s];
      }
    }
    [src, dst] = [dst, src];
    strideIn = strideOut;
  }

  const outArr = new Float64Array(n * 2);
  for (let i = 0; i < n; i++) {
    outArr[i * 2] = src[i][0];
    outArr[i * 2 + 1] = src[i][1];
  }
  return outArr;
}

/** Real-to-complex rfft convention (matches one_fft()/dsp.ts's realFft):
 *  real input of length n, `n/2+1` complex output bins. Computed via the
 *  full complex fftGeneral (im=0 input) — simplest correct approach; a
 *  real-input-optimized half-length trick would halve the work but isn't
 *  needed at this scale (see gpuDecodePipeline.ts's actual call frequency
 *  — once per decode window, not per candidate). */
export function realFftGeneral(samples: Float64Array | Float32Array, n: number): Complex[] {
  const interleaved = new Float64Array(n * 2);
  for (let i = 0; i < n; i++) interleaved[i * 2] = i < samples.length ? samples[i] : 0;
  const full = fftGeneral(interleaved, n);
  const nBins = Math.floor(n / 2) + 1;
  const out: Complex[] = new Array(nBins);
  for (let k = 0; k < nBins; k++) out[k] = [full[k * 2], full[k * 2 + 1]];
  return out;
}

/** Complex-to-real IFFT via fftGeneral, matching dsp.ts's realIfft()
 *  contract exactly (same rfft convention: `bins.length` = n/2+1 complex
 *  input bins, `n = (bins.length-1)*2` real output samples, UNNORMALIZED —
 *  matches FFTW's c2r convention, same as ft8mon's own one_ifft()) — just
 *  backed by the fast O(N log N) Stockham-general FFT instead of a direct
 *  O(N^2) DFT, needed because shift200()/fine sync operates on windows in
 *  the ~1000-3000 sample range where an O(N^2) inverse (dsp.ts's
 *  realIfft) is a real, measured performance bottleneck (~6 seconds per
 *  fine-sync candidate before this fix — see gpuDecodePipeline.ts's
 *  history). Standard trick: IFFT(X)[n] = (1/N) * conj(FFT(conj(X)))[n];
 *  reconstructs the full N-length complex spectrum from the rfft's
 *  conjugate-symmetric half first, then takes the real part of the
 *  result (valid since the caller guarantees a real-valued original
 *  signal, same assumption one_ifft() itself makes). */
export function realIfftGeneral(bins: Complex[]): Float64Array {
  const nBins = bins.length;
  const n = (nBins - 1) * 2;

  // Reconstruct the full N-point spectrum via conjugate symmetry (bin
  // N-k = conj(bin k)), matching what a real signal's true full FFT
  // would have produced.
  const full = new Float64Array(n * 2);
  for (let k = 0; k < nBins; k++) {
    full[k * 2] = bins[k][0];
    full[k * 2 + 1] = bins[k][1];
  }
  for (let k = nBins; k < n; k++) {
    const conjK = n - k;
    full[k * 2] = bins[conjK][0];
    full[k * 2 + 1] = -bins[conjK][1];
  }

  // Conjugate input, forward FFT, conjugate output, matching the standard
  // IFFT-via-FFT identity — division by N is NOT applied, to match
  // one_ifft()'s own unnormalized FFTW c2r convention (verified in
  // dsp.test.ts's round-trip test: realFft -> realIfft scales by N, with
  // no separate normalization anywhere in ft8mon's own FFT pairing either).
  for (let i = 0; i < n; i++) full[i * 2 + 1] = -full[i * 2 + 1];
  const transformed = fftGeneral(full, n);

  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = transformed[i * 2]; // real part; imaginary part should be ~0
  return out;
}
