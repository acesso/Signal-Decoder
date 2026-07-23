// Resamples captured audio to ft8mon's fixed internal decode rate. Mirrors
// resample_to_12k() in ft8mon_wasm.cc exactly (same anti-alias FIR, same
// linear-interpolation formula, same edge clamping) — kept in its own module
// (no worker-bootstrapping imports) so it can be unit tested directly.
export const FT8MON_DECODE_RATE = 12000;

// Anti-alias low-pass applied before decimation. Without this, any input
// content above the new Nyquist (FT8MON_DECODE_RATE/2) folds back down into
// the passband under plain linear-interpolation resampling and corrupts
// exactly the FFT bins ft8mon's LLR computation reads — this used to run as
// bare linear interpolation with no filtering at all. Windowed-sinc FIR,
// cutoff set a bit inside the new Nyquist (0.45x, not 0.5x) so the filter's
// own finite-length transition band doesn't let aliasing content leak past
// the edge; Hamming window for a well-behaved (no ringing) stopband.
const ANTIALIAS_CUTOFF_FRACTION = 0.45; // of the OUTPUT sample rate
const ANTIALIAS_TAPS = 63; // odd length, symmetric FIR — cheap enough for a 720k-sample one-shot per window

export function designLowPassFir(cutoffHz: number, sampleRateHz: number, numTaps: number): Float64Array {
  const taps = new Float64Array(numTaps);
  const mid = (numTaps - 1) / 2;
  const fc = cutoffHz / sampleRateHz; // normalized cutoff (0..0.5)
  let sum = 0;
  for (let i = 0; i < numTaps; i++) {
    const x = i - mid;
    const sinc = x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x);
    const hamming = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (numTaps - 1));
    const w = sinc * hamming;
    taps[i] = w;
    sum += w;
  }
  // Normalize for unity gain at DC.
  for (let i = 0; i < numTaps; i++) taps[i] /= sum;
  return taps;
}

export function applyFir(samples: Float32Array, taps: Float64Array): Float32Array {
  const n = samples.length;
  const numTaps = taps.length;
  const half = (numTaps - 1) / 2;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (let k = 0; k < numTaps; k++) {
      const idx = i + k - half;
      if (idx >= 0 && idx < n) acc += taps[k] * samples[idx];
    }
    out[i] = acc;
  }
  return out;
}

export function resampleTo12k(samples: Float32Array, sampleRate: number): Float32Array {
  if (sampleRate === FT8MON_DECODE_RATE) return samples;

  // Anti-alias filter only matters when decimating (output rate < input
  // rate) — an upsample has no aliasing to guard against.
  const filtered =
    sampleRate > FT8MON_DECODE_RATE
      ? applyFir(samples, designLowPassFir(ANTIALIAS_CUTOFF_FRACTION * FT8MON_DECODE_RATE, sampleRate, ANTIALIAS_TAPS))
      : samples;

  const inLen = filtered.length;
  const nOut = Math.floor((inLen * FT8MON_DECODE_RATE) / sampleRate);
  const out = new Float32Array(nOut);
  const step = sampleRate / FT8MON_DECODE_RATE;
  for (let i = 0; i < nOut; i++) {
    const pos  = i * step;
    const idx  = Math.floor(pos);
    const frac = pos - idx;
    const s0   = filtered[idx];
    const s1   = idx + 1 < inLen ? filtered[idx + 1] : s0;
    out[i] = s0 + frac * (s1 - s0);
  }
  return out;
}
