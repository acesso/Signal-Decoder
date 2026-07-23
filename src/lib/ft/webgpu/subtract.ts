// CPU reference port of ft8mon's subtract() (ft8.cc:2763-2912), analytic()/
// hilbert_shift() (fft.cc:493-560), and recode() (ft8.cc:2996-3021) — used to
// remove an already-decoded signal from nsamples_ so a subsequent pass can
// find weaker signals underneath. Built on fftGeneral.ts's already-proven
// mixed-radix Stockham FFT (do NOT reinvent FFT math here) rather than
// dsp.ts's O(N^2) direct DFT, since analytic() runs over the WHOLE capture
// buffer (~180000 samples at 15s/12kHz).
//
// analytic()/hilbert_shift() need a genuine COMPLEX FFT/IFFT pair (the
// spectrum after zeroing the negative-frequency half is NOT conjugate-
// symmetric, so realFftGeneral/realIfftGeneral's real-signal assumption
// doesn't apply here) — fftComplexGeneral/ifftComplexGeneral below wrap
// fftGeneral() with the SAME normalization convention ft8mon's own
// one_fft_c()/one_ifft_cc() use (each direction scaled by 1/sqrt(N), so the
// round trip is scale-preserving, matching scipy.signal.hilbert()'s
// contract that the analytic signal's real part reproduces the original x
// unchanged) — fftGeneral() itself is unnormalized (raw DFT sum, FFTW
// convention), so both scalings are applied explicitly here.
import { fftGeneral } from './fftGeneral';
import type { Complex } from './dsp';

const SUBTRACT_RAMP = 0.11; // subtract_ramp, ft8.cc:96

function cabs(c: Complex): number {
  return Math.hypot(c[0], c[1]);
}
function carg(c: Complex): number {
  return Math.atan2(c[1], c[0]);
}

/** Complex FFT via fftGeneral(), scaled by 1/sqrt(n) — matches one_fft_c()'s
 *  own normalization exactly (fft.cc:304-353). */
export function fftComplexGeneral(x: Complex[]): Complex[] {
  const n = x.length;
  const interleaved = new Float64Array(n * 2);
  for (let i = 0; i < n; i++) {
    interleaved[i * 2] = x[i][0];
    interleaved[i * 2 + 1] = x[i][1];
  }
  const full = fftGeneral(interleaved, n);
  const norm = 1 / Math.sqrt(n);
  const out: Complex[] = new Array(n);
  for (let i = 0; i < n; i++) out[i] = [full[i * 2] * norm, full[i * 2 + 1] * norm];
  return out;
}

/** Complex IFFT via fftGeneral()'s conjugate-FFT-conjugate identity, scaled
 *  by 1/sqrt(n) — matches one_ifft_cc()'s own normalization exactly
 *  (fft.cc:407-450). Unlike realIfftGeneral(), does NOT assume conjugate
 *  symmetry and does NOT discard the imaginary part of the result — needed
 *  because analytic()'s spectrum (after the positive-half-doubled/negative-
 *  half-zeroed transform) is not conjugate-symmetric. */
export function ifftComplexGeneral(bins: Complex[]): Complex[] {
  const n = bins.length;
  const conjInterleaved = new Float64Array(n * 2);
  for (let i = 0; i < n; i++) {
    conjInterleaved[i * 2] = bins[i][0];
    conjInterleaved[i * 2 + 1] = -bins[i][1];
  }
  const transformed = fftGeneral(conjInterleaved, n);
  const norm = 1 / Math.sqrt(n);
  const out: Complex[] = new Array(n);
  for (let i = 0; i < n; i++) out[i] = [transformed[i * 2] * norm, -transformed[i * 2 + 1] * norm];
  return out;
}

/** analytic(): the Hilbert-transform analytic signal of a real-valued
 *  signal x, matching scipy.signal.hilbert() (fft.cc:500-527) — the return
 *  value is x + iy where y is x's Hilbert transform: forward FFT, double
 *  the positive-frequency half, zero the negative-frequency half (leaving
 *  DC and Nyquist, if present, alone), inverse FFT. */
export function analytic(x: Float64Array): Complex[] {
  const n = x.length;
  const xComplex: Complex[] = new Array(n);
  for (let i = 0; i < n; i++) xComplex[i] = [x[i], 0];
  const y = fftComplexGeneral(xComplex);

  if (n % 2 === 0) {
    for (let i = 1; i < n / 2; i++) y[i] = [y[i][0] * 2, y[i][1] * 2];
    for (let i = n / 2 + 1; i < n; i++) y[i] = [0, 0];
  } else {
    for (let i = 1; i < (n + 1) / 2; i++) y[i] = [y[i][0] * 2, y[i][1] * 2];
    for (let i = (n + 1) / 2; i < n; i++) y[i] = [0, 0];
  }

  return ifftComplexGeneral(y);
}

/** hilbert_shift(): general-purpose frequency shift of x by a (possibly
 *  linearly-swept, hz0..hz1 across the buffer) amount, via the analytic
 *  signal + a complex local oscillator (fft.cc:540-560). Wraps around at 0Hz
 *  and Nyquist, same caveat as the C source. */
export function hilbertShift(x: Float64Array, hz0: number, hz1: number, rate: number): Float64Array {
  const y = analytic(x);
  const dt = 1.0 / rate;
  const n = x.length;
  const ret = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const hz = hz0 + (i / n) * (hz1 - hz0);
    const theta = 2 * Math.PI * hz * dt * i;
    const loRe = Math.cos(theta);
    const loIm = Math.sin(theta);
    // (lo * y[i]).real()
    ret[i] = loRe * y[i][0] - loIm * y[i][1];
  }
  return ret;
}

/** blocksize(): symbol length in samples at `rate`, matching ft8mon's
 *  integer-block-length assertion (fft.cc:565-575, called blocksize() there
 *  too — the module lives in fft.cc despite being a scalar helper). */
export function blocksize(rate: number): number {
  const xblock = 1920 / (12000.0 / rate);
  if (Math.round(xblock) !== xblock) {
    throw new Error(`blocksize: rate=${rate} does not yield an integer symbol length (got ${xblock})`);
  }
  return xblock;
}

/** ffts(): one real-input FFT per symbol-time block, `block/2+1` complex
 *  bins each (fft.cc:238-297, one_fft()'s r2c convention) — used here for
 *  subtract()'s per-symbol amplitude/phase read at the candidate's time
 *  offset. IMPORTANT: this is UNNORMALIZED (raw fftw_execute_dft_r2c
 *  output, no 1/sqrt(N) scaling) — unlike fftComplexGeneral/
 *  ifftComplexGeneral above (which mirror one_fft_c()/one_ifft_cc()'s own
 *  DIFFERENT, normalized convention, used only by analytic()). Reuses
 *  fftGeneral.ts's realFftGeneral()-style approach (full complex FFT with
 *  im=0 input, matching that module's own "simplest correct approach"
 *  tradeoff) rather than reinventing an r2c-specific transform. */
export function ffts(samples: Float64Array, i0: number, block: number): Complex[][] {
  const nsamples = samples.length;
  const nbins = Math.floor(block / 2) + 1;
  const nblocks = Math.floor((nsamples - i0) / block);
  const bins: Complex[][] = new Array(Math.max(0, nblocks));
  for (let si = 0; si < nblocks; si++) {
    const off = i0 + si * block;
    const interleaved = new Float64Array(block * 2);
    for (let i = 0; i < block; i++) interleaved[i * 2] = off + i < nsamples ? samples[off + i] : 0;
    const full = fftGeneral(interleaved, block);
    const row: Complex[] = new Array(nbins);
    for (let bi = 0; bi < nbins; bi++) row[bi] = [full[bi * 2], full[bi * 2 + 1]];
    bins[si] = row;
  }
  return bins;
}

const RECODE_COSTAS = [3, 1, 4, 0, 6, 5, 2];
const RECODE_GRAYMAP = [0, 1, 3, 2, 5, 6, 4, 7];

/** recode(): given 174 error-corrected bits (91 payload + 83 LDPC parity),
 *  work backwards to the 79 symbol numbers that must have been sent
 *  (ft8.cc:2996-3021) — the 3 Costas sync blocks (symbols 0-6, 36-42, 72-78)
 *  are fixed regardless of the bits; the remaining 58 data symbols come 3
 *  bits at a time (174 = 58*3) from a174, gray-coded. */
export function recode(a174: number[] | Uint8Array): number[] {
  let i174 = 0;
  const out79: number[] = [];
  for (let i79 = 0; i79 < 79; i79++) {
    if (i79 < 7) {
      out79.push(RECODE_COSTAS[i79]);
    } else if (i79 >= 36 && i79 < 36 + 7) {
      out79.push(RECODE_COSTAS[i79 - 36]);
    } else if (i79 >= 72) {
      out79.push(RECODE_COSTAS[i79 - 72]);
    } else {
      const sym = (a174[i174 + 0] << 2) | (a174[i174 + 1] << 1) | (a174[i174 + 2] << 0);
      i174 += 3;
      out79.push(RECODE_GRAYMAP[sym]);
    }
  }
  if (out79.length !== 79) throw new Error(`recode: expected 79 symbols, got ${out79.length}`);
  if (i174 !== 174) throw new Error(`recode: expected to consume 174 bits, consumed ${i174}`);
  return out79;
}

/** subtract(): given a successfully-decoded candidate's corrected 79-symbol
 *  sequence (re79, from recode()) and its frequency (hz0~=hz1) and time
 *  offset (offSec), subtracts a ramped, phase/amplitude-matched synthesized
 *  copy of that signal from nsamples, returning the new residual buffer
 *  (ft8.cc:2763-2912). Matches the C source's variable names/order of
 *  operations closely — this is fiddly enough that transcription accuracy
 *  matters more than elegance (see this repo's own task doc for why). */
export function subtractDecodedSignal(
  nsamples: Float64Array,
  re79: number[],
  hz0: number,
  hz1: number,
  offSec: number,
  rate: number,
): Float64Array {
  const block = blocksize(rate);
  const binHz = rate / block;
  const off0 = Math.round(offSec * rate);

  const mhz = (hz0 + hz1) / 2.0;
  const bin0 = Math.round(mhz / binHz);

  const diff0 = bin0 * binHz - hz0;
  const diff1 = bin0 * binHz - hz1;
  const moved = hilbertShift(nsamples, diff0, diff1, rate);

  const bins = ffts(moved, off0, block);

  if (bin0 + 8 > bins[0].length) return nsamples.slice();
  if (bins.length < 79) return nsamples.slice();

  const phases = new Array<number>(79);
  const amps = new Array<number>(79);
  for (let i = 0; i < 79; i++) {
    const sym = bin0 + re79[i];
    const c = bins[i][sym];
    phases[i] = carg(c);
    // FFT multiplies magnitudes by number of bins, or half the number of samples.
    amps[i] = cabs(c) / (block / 2.0);
  }

  let ramp = Math.round(block * SUBTRACT_RAMP);
  if (ramp < 1) ramp = 1;

  // initial ramp part of first symbol.
  {
    const sym = bin0 + re79[0];
    const phase = phases[0];
    const amp = amps[0];
    const hz = 6.25 * sym;
    const dtheta = (2 * Math.PI) / (rate / hz); // advance per sample
    for (let jj = 0; jj < ramp; jj++) {
      let theta = phase + jj * dtheta;
      let x = amp * Math.cos(theta);
      x *= jj / ramp;
      const iii = off0 + block * 0 + jj;
      moved[iii] -= x;
    }
  }

  for (let si = 0; si < 79; si++) {
    const sym = bin0 + re79[si];

    const phase = phases[si];
    const amp = amps[si];

    const hz = 6.25 * sym;
    const dtheta0 = (2 * Math.PI) / (rate / hz); // advance per sample

    // we've already done the first ramp for this symbol.
    // now for the steady part between ramps.
    for (let jj = ramp; jj < block - ramp; jj++) {
      const theta = phase + jj * dtheta0;
      const x = amp * Math.cos(theta);
      const iii = off0 + block * si + jj;
      moved[iii] -= x;
    }

    // now the two ramps, from us to the next symbol.
    // we need to smoothly change the frequency, approximating wsjt-x's
    // gaussian frequency shift, and also end up matching the next symbol's
    // phase, which is often different from this symbol due to inaccuracies
    // in hz or offset.

    // at start of this symbol's off-ramp.
    let theta = phase + (block - ramp) * dtheta0;
    let dtheta = dtheta0;

    let hz1sym: number;
    let phase1: number;
    if (si + 1 >= 79) {
      hz1sym = hz;
      phase1 = phase;
    } else {
      const sym1 = bin0 + re79[si + 1];
      hz1sym = 6.25 * sym1;
      phase1 = phases[si + 1];
    }
    const dtheta1 = (2 * Math.PI) / (rate / hz1sym);

    // add this to dtheta for each sample, to gradually change the frequency.
    const inc = (dtheta1 - dtheta) / (2.0 * ramp);

    // after we've applied all those inc's, what will the phase be at the
    // end of the next symbol's initial ramp, if we don't do anything to
    // correct it?
    const actual = theta + dtheta * 2.0 * ramp + (inc * 4.0 * ramp * ramp) / 2.0;

    // what phase does the next symbol want to be at when its on-ramp finishes?
    let target = phase1 + dtheta1 * ramp;

    // ???
    while (Math.abs(target - actual) > Math.PI) {
      if (target < actual) target += 2 * Math.PI;
      else target -= 2 * Math.PI;
    }

    // adj is to be spread evenly over the off-ramp and on-ramp samples.
    const adj = target - actual;

    let end = block + ramp;
    if (si === 79 - 1) end = block;

    for (let jj = block - ramp; jj < end; jj++) {
      const iii = off0 + block * si + jj;
      let x = amp * Math.cos(theta);

      // trail off to zero at the very end.
      if (si === 79 - 1) x *= 1.0 - (jj - (block - ramp)) / ramp;

      moved[iii] -= x;

      theta += dtheta;
      dtheta += inc;
      theta += adj / (2.0 * ramp);
    }
  }

  return hilbertShift(moved, -diff0, -diff1, rate);
}
