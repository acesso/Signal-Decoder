import { fftGeneral, factorRadixSchedule, realFftGeneral } from '../fftGeneral';
import { fft1920 } from '../fft1920';

function seededRandom(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return (s / 0x7fffffff) * 2 - 1;
  };
}

function naiveDft(inputInterleaved: Float64Array, n: number): Float64Array {
  const out = new Float64Array(n * 2);
  for (let k = 0; k < n; k++) {
    let re = 0, im = 0;
    for (let i = 0; i < n; i++) {
      const theta = (-2 * Math.PI * k * i) / n;
      const xr = inputInterleaved[i * 2], xi = inputInterleaved[i * 2 + 1];
      const c = Math.cos(theta), s = Math.sin(theta);
      re += xr * c - xi * s;
      im += xr * s + xi * c;
    }
    out[k * 2] = re;
    out[k * 2 + 1] = im;
  }
  return out;
}

describe('factorRadixSchedule', () => {
  test('factors 2/3/5-smooth numbers exactly', () => {
    expect(factorRadixSchedule(1920)).toEqual([2, 2, 2, 2, 2, 2, 2, 3, 5]);
    expect(factorRadixSchedule(18000).reduce((a, b) => a * b, 1)).toBe(18000);
    expect(factorRadixSchedule(18000).every(f => [2, 3, 5].includes(f))).toBe(true);
  });

  test('handles a leftover prime factor', () => {
    const factors = factorRadixSchedule(1920 * 7); // 7 is prime, not 2/3/5
    expect(factors.reduce((a, b) => a * b, 1)).toBe(1920 * 7);
    expect(factors[factors.length - 1]).toBe(7);
  });
});

describe('fftGeneral', () => {
  test('matches fft1920 exactly at N=1920', () => {
    const rng = seededRandom(42);
    const input = new Float64Array(1920 * 2);
    for (let i = 0; i < 1920 * 2; i++) input[i] = rng();

    const ref = fft1920(input);
    const got = fftGeneral(input, 1920);

    let maxErr = 0;
    for (let i = 0; i < 1920 * 2; i++) maxErr = Math.max(maxErr, Math.abs(ref[i] - got[i]));
    expect(maxErr).toBeLessThan(1e-6);
  });

  test('matches a naive DFT for a small 2/3/5-smooth N (N=60)', () => {
    const rng = seededRandom(7);
    const n = 60; // 2^2*3*5
    const input = new Float64Array(n * 2);
    for (let i = 0; i < n * 2; i++) input[i] = rng();

    const ref = naiveDft(input, n);
    const got = fftGeneral(input, n);

    let maxErr = 0;
    for (let i = 0; i < n * 2; i++) maxErr = Math.max(maxErr, Math.abs(ref[i] - got[i]));
    expect(maxErr).toBeLessThan(1e-9);
  });

  test('matches a naive DFT for N with a non-2/3/5 prime factor (N=84 = 2^2*3*7)', () => {
    const rng = seededRandom(13);
    const n = 84;
    const input = new Float64Array(n * 2);
    for (let i = 0; i < n * 2; i++) input[i] = rng();

    const ref = naiveDft(input, n);
    const got = fftGeneral(input, n);

    let maxErr = 0;
    for (let i = 0; i < n * 2; i++) maxErr = Math.max(maxErr, Math.abs(ref[i] - got[i]));
    expect(maxErr).toBeLessThan(1e-9);
  });

  test('matches a naive DFT for a prime N (N=17, entirely generic-DFT combine)', () => {
    const rng = seededRandom(99);
    const n = 17;
    const input = new Float64Array(n * 2);
    for (let i = 0; i < n * 2; i++) input[i] = rng();

    const ref = naiveDft(input, n);
    const got = fftGeneral(input, n);

    let maxErr = 0;
    for (let i = 0; i < n * 2; i++) maxErr = Math.max(maxErr, Math.abs(ref[i] - got[i]));
    expect(maxErr).toBeLessThan(1e-9);
  });

  test('does not mutate its input array', () => {
    const rng = seededRandom(5);
    const n = 60;
    const input = new Float64Array(n * 2);
    for (let i = 0; i < n * 2; i++) input[i] = rng();
    const copy = input.slice();

    fftGeneral(input, n);

    expect(Array.from(input)).toEqual(Array.from(copy));
  });

  test('pure tone at a known bin peaks at the exact expected bin (N=300)', () => {
    const n = 300; // 2^2*3*5^2
    const bin = 42;
    const input = new Float64Array(n * 2);
    for (let i = 0; i < n; i++) input[i * 2] = Math.cos((2 * Math.PI * bin * i) / n);

    const out = fftGeneral(input, n);
    let peakBin = -1, peakMag = -1;
    for (let k = 0; k < n; k++) {
      const mag = Math.hypot(out[k * 2], out[k * 2 + 1]);
      if (mag > peakMag) { peakMag = mag; peakBin = k; }
    }
    expect(peakBin).toBe(bin);
  });
});

describe('realFftGeneral', () => {
  test('matches the rfft-bin subset of a full complex fftGeneral', () => {
    const rng = seededRandom(23);
    const n = 120;
    const samples = new Float64Array(n);
    for (let i = 0; i < n; i++) samples[i] = rng();

    const rfftBins = realFftGeneral(samples, n);

    const interleaved = new Float64Array(n * 2);
    for (let i = 0; i < n; i++) interleaved[i * 2] = samples[i];
    const full = fftGeneral(interleaved, n);

    let maxErr = 0;
    for (let k = 0; k < rfftBins.length; k++) {
      maxErr = Math.max(maxErr, Math.abs(rfftBins[k][0] - full[k * 2]), Math.abs(rfftBins[k][1] - full[k * 2 + 1]));
    }
    expect(maxErr).toBeLessThan(1e-9);
  });

  test('zero-pads samples shorter than n', () => {
    const samples = new Float64Array([1, 2, 3]);
    const bins = realFftGeneral(samples, 60);
    expect(bins.length).toBe(31); // 60/2+1
    expect(Number.isFinite(bins[0][0])).toBe(true);
  });
});
