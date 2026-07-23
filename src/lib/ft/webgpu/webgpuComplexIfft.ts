/// <reference types="@webgpu/types" />
// GPU-backed complex-to-complex IFFT — the genuine inverse of
// runFftGeneralGpu() (webgpuFftGeneral.ts), needed because
// runRealIfftGeneralGpu() there ASSUMES a conjugate-symmetric spectrum
// (real-valued time signal) and discards the imaginary part of its result.
// subtract.ts's analytic()/hilbert_shift() need the OPPOSITE: the spectrum
// after positive-half-doubled/negative-half-zeroed is NOT conjugate-
// symmetric, so the imaginary part of the inverse transform is real
// information (it's what makes the result the analytic signal, not just x
// again), and MUST be kept.
//
// Deliberately a separate file, NOT a change to webgpuFftGeneral.ts (task
// constraint: that file is proven/frozen) — reuses its exported
// runFftGeneralGpu()/flattenStageSchedule()/checkFftWorkgroupBudget() rather
// than re-deriving the Stockham math, same "don't reinvent FFT" discipline
// as fftGeneral.ts's own module doc.
//
// Same conjugate-FFT-conjugate identity ifftComplexGeneral() (subtract.ts)
// uses on CPU, and the same one runRealIfftGeneralGpu() already uses
// internally — just without collapsing the result to real-only at the end,
// and WITHOUT the 1/sqrt(N) normalization ft8mon's one_ifft_cc() applies
// (that scaling is applied by subtract.ts's own analytic()/hilbertShift()
// callers on the CPU-side whole-buffer step; this module mirrors
// runFftGeneralGpu()'s own unnormalized FFTW-style convention exactly, same
// as fftGeneral.ts's plain fftGeneral()).
import { runFftGeneralGpu } from './webgpuFftGeneral';
import type { Complex } from './dsp';
export { checkFftWorkgroupBudget, FFT_GENERAL_MAX_N } from './fftWorkgroupBudget';

/** Complex-to-complex IFFT via the conjugate-FFT-conjugate identity:
 *  IFFT(X) = conj(FFT(conj(X))) (UNNORMALIZED — no division by N, matching
 *  fftGeneral()'s own raw-DFT-sum convention). `inputInterleaved` is a flat
 *  [re,im,...] Float32Array of length `batch*n*2`; returns the same layout.
 *  N must be 2/3/5-smooth (see runFftGeneralGpu's own module header — this
 *  is just a thin wrapper, same limitation applies). */
export async function runComplexIfftGeneralGpu(inputInterleaved: Float32Array, n: number, batch = 1): Promise<Float32Array> {
  const expectedLen = batch * n * 2;
  if (inputInterleaved.length !== expectedLen) {
    throw new Error(`runComplexIfftGeneralGpu: expected ${expectedLen} interleaved values for N=${n}, batch=${batch}, got ${inputInterleaved.length}`);
  }

  const conjInput = new Float32Array(expectedLen);
  for (let i = 0; i < batch * n; i++) {
    conjInput[i * 2] = inputInterleaved[i * 2];
    conjInput[i * 2 + 1] = -inputInterleaved[i * 2 + 1];
  }

  const transformed = await runFftGeneralGpu(conjInput, n, batch);

  const out = new Float32Array(expectedLen);
  for (let i = 0; i < batch * n; i++) {
    out[i * 2] = transformed[i * 2];
    out[i * 2 + 1] = -transformed[i * 2 + 1];
  }
  return out;
}

/** Complex[]-in/Complex[]-out convenience wrapper for a single signal —
 *  matches subtract.ts's ifftComplexGeneral() shape, minus the 1/sqrt(N)
 *  normalization (see module header: applied by the caller, not here). */
export async function runComplexIfftGeneralGpuOne(bins: Complex[]): Promise<Complex[]> {
  const n = bins.length;
  const flat = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    flat[i * 2] = bins[i][0];
    flat[i * 2 + 1] = bins[i][1];
  }
  const out = await runComplexIfftGeneralGpu(flat, n, 1);
  const result: Complex[] = new Array(n);
  for (let i = 0; i < n; i++) result[i] = [out[i * 2], out[i * 2 + 1]];
  return result;
}
