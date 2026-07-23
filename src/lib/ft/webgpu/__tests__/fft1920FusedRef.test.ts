import { fft1920, FFT_N } from '../fft1920';
import { fft1920Fused } from '../fft1920FusedRef';

function seededRandom(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return (s / 0x7fffffff) * 2 - 1;
  };
}

describe('fft1920Fused vs fft1920 (unfused-vs-fused kernel equivalence)', () => {
  test('matches the unfused reference for random complex input', () => {
    const rng = seededRandom(555);
    const input = new Float64Array(FFT_N * 2);
    for (let i = 0; i < FFT_N * 2; i++) input[i] = rng();

    const ref = fft1920(input);
    const got = fft1920Fused(input);

    let maxErr = 0;
    for (let i = 0; i < FFT_N * 2; i++) maxErr = Math.max(maxErr, Math.abs(ref[i] - got[i]));
    expect(maxErr).toBeLessThan(1e-9);
  });

  test('matches the unfused reference for real-valued audio-like input', () => {
    const rng = seededRandom(9001);
    const input = new Float64Array(FFT_N * 2);
    for (let n = 0; n < FFT_N; n++) {
      input[n * 2] = Math.sin((2 * Math.PI * 300 * n) / 12000) + 0.2 * rng();
    }

    const ref = fft1920(input);
    const got = fft1920Fused(input);

    let maxErr = 0;
    for (let i = 0; i < FFT_N * 2; i++) maxErr = Math.max(maxErr, Math.abs(ref[i] - got[i]));
    expect(maxErr).toBeLessThan(1e-9);
  });

  test('pure tone produces a peak at the exact expected bin', () => {
    const bin = 271;
    const input = new Float64Array(FFT_N * 2);
    for (let n = 0; n < FFT_N; n++) input[n * 2] = Math.cos((2 * Math.PI * bin * n) / FFT_N);

    const out = fft1920Fused(input);
    let peakBin = -1, peakMag = -1;
    for (let k = 0; k < FFT_N; k++) {
      const mag = Math.hypot(out[k * 2], out[k * 2 + 1]);
      if (mag > peakMag) { peakMag = mag; peakBin = k; }
    }
    expect(peakBin).toBe(bin);
  });

  test('does not mutate its input array', () => {
    const rng = seededRandom(3);
    const input = new Float64Array(FFT_N * 2);
    for (let i = 0; i < FFT_N * 2; i++) input[i] = rng();
    const inputCopy = input.slice();

    fft1920Fused(input);

    expect(Array.from(input)).toEqual(Array.from(inputCopy));
  });
});
