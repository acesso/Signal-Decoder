import { fft1920, FFT_N, buildPassSchedule } from '../fft1920';

function naiveDFT(inputInterleaved: Float64Array): Float64Array {
  const out = new Float64Array(FFT_N * 2);
  for (let k = 0; k < FFT_N; k++) {
    let re = 0, im = 0;
    for (let n = 0; n < FFT_N; n++) {
      const theta = (-2 * Math.PI * k * n) / FFT_N;
      const xr = inputInterleaved[n * 2];
      const xi = inputInterleaved[n * 2 + 1];
      const c = Math.cos(theta), s = Math.sin(theta);
      re += xr * c - xi * s;
      im += xr * s + xi * c;
    }
    out[k * 2] = re;
    out[k * 2 + 1] = im;
  }
  return out;
}

function seededRandom(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return (s / 0x7fffffff) * 2 - 1;
  };
}

describe('fft1920 pass schedule', () => {
  test('9 passes, radixes multiply to 1920, strides chain correctly', () => {
    const passes = buildPassSchedule();
    expect(passes).toHaveLength(9);
    expect(passes.reduce((acc, p) => acc * p.radix, 1)).toBe(FFT_N);
    for (let i = 1; i < passes.length; i++) {
      expect(passes[i].strideIn).toBe(passes[i - 1].strideOut);
    }
    expect(passes[passes.length - 1].strideOut).toBe(FFT_N);
  });
});

describe('fft1920 correctness', () => {
  test('matches naive O(N^2) DFT for random complex input', () => {
    const rng = seededRandom(12345);
    const input = new Float64Array(FFT_N * 2);
    for (let i = 0; i < FFT_N * 2; i++) input[i] = rng();

    const ref = naiveDFT(input);
    const got = fft1920(input);

    let maxErr = 0;
    for (let i = 0; i < FFT_N * 2; i++) {
      maxErr = Math.max(maxErr, Math.abs(ref[i] - got[i]));
    }
    expect(maxErr).toBeLessThan(1e-6);
  });

  test('pure tone at a known bin produces a peak at that exact bin', () => {
    const bin = 137;
    const input = new Float64Array(FFT_N * 2);
    for (let n = 0; n < FFT_N; n++) {
      input[n * 2] = Math.cos((2 * Math.PI * bin * n) / FFT_N);
      input[n * 2 + 1] = 0;
    }
    const out = fft1920(input);

    let peakBin = -1, peakMag = -1;
    for (let k = 0; k < FFT_N; k++) {
      const mag = Math.hypot(out[k * 2], out[k * 2 + 1]);
      if (mag > peakMag) { peakMag = mag; peakBin = k; }
    }
    expect(peakBin).toBe(bin);
  });

  test('real-valued input produces conjugate-symmetric output (matches ft8mon feeding real audio)', () => {
    const rng = seededRandom(999);
    const input = new Float64Array(FFT_N * 2);
    for (let n = 0; n < FFT_N; n++) {
      input[n * 2] = Math.sin((2 * Math.PI * 200 * n) / 12000) + 0.3 * rng();
      input[n * 2 + 1] = 0;
    }
    const out = fft1920(input);

    let maxErr = 0;
    for (let k = 1; k < FFT_N; k++) {
      const conjK = FFT_N - k;
      const errRe = Math.abs(out[k * 2] - out[conjK * 2]);
      const errIm = Math.abs(out[k * 2 + 1] + out[conjK * 2 + 1]);
      maxErr = Math.max(maxErr, errRe, errIm);
    }
    expect(maxErr).toBeLessThan(1e-9);
  });

  test('DC bin equals the sum of all real samples for a real-valued input', () => {
    const rng = seededRandom(7);
    const input = new Float64Array(FFT_N * 2);
    let sum = 0;
    for (let n = 0; n < FFT_N; n++) {
      const v = rng();
      input[n * 2] = v;
      sum += v;
    }
    const out = fft1920(input);
    expect(out[0]).toBeCloseTo(sum, 6);
    expect(out[1]).toBeCloseTo(0, 6);
  });

  test('does not mutate its input array', () => {
    // Regression test: the src/dst ping-pong swap ([src, dst] = [dst, src])
    // used to alias the caller's own array directly as `src`, so after
    // stage 0's swap, stage 1 wrote INTO the caller's array (whatever `src`
    // pointed to becomes the next stage's write target). Every real call
    // site happens to pass a freshly-allocated, never-reused buffer, so
    // this had no visible effect on any actual result — but it silently
    // corrupted the input for any caller that kept a reference to it
    // afterward, which is exactly what happened while cross-checking a
    // fused-kernel WGSL variant against this reference implementation.
    const rng = seededRandom(42);
    const input = new Float64Array(FFT_N * 2);
    for (let i = 0; i < FFT_N * 2; i++) input[i] = rng();
    const inputCopy = input.slice();

    fft1920(input);

    expect(Array.from(input)).toEqual(Array.from(inputCopy));
  });
});
