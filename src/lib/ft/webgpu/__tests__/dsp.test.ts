import { realFft, realIfft, fbandpass, shiftBins, blackman } from '../dsp';
import { fft1920 } from '../fft1920';

function seededRandom(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return (s / 0x7fffffff) * 2 - 1;
  };
}

describe('realFft', () => {
  test('matches the already-proven fft1920 Stockham FFT (rfft convention, N=1920)', () => {
    const rng = seededRandom(11);
    const samples = new Float64Array(1920);
    for (let i = 0; i < 1920; i++) samples[i] = rng();

    const rfftBins = realFft(samples, 0, 1920);

    const interleaved = new Float64Array(1920 * 2);
    for (let i = 0; i < 1920; i++) interleaved[i * 2] = samples[i];
    const fullSpectrum = fft1920(interleaved);

    // rfft only returns bins [0, N/2], full spectrum has all N bins —
    // compare the overlapping range.
    let maxErr = 0;
    for (let k = 0; k <= 960; k++) {
      maxErr = Math.max(maxErr, Math.abs(rfftBins[k][0] - fullSpectrum[k * 2]), Math.abs(rfftBins[k][1] - fullSpectrum[k * 2 + 1]));
    }
    expect(maxErr).toBeLessThan(1e-6);
  }, 30000);

  test('pure tone at a known bin (small N=32) peaks at the exact expected bin', () => {
    const bin = 5;
    const N = 32;
    const samples = new Float64Array(N);
    for (let n = 0; n < N; n++) samples[n] = Math.cos((2 * Math.PI * bin * n) / N);

    const bins = realFft(samples, 0, N);
    let peakBin = -1, peakMag = -1;
    for (let k = 0; k < bins.length; k++) {
      const mag = Math.hypot(bins[k][0], bins[k][1]);
      if (mag > peakMag) { peakMag = mag; peakBin = k; }
    }
    expect(peakBin).toBe(bin);
  });

  test('zero-pads past the end of the input array, matching ft8mon fft.cc:200-206', () => {
    const samples = new Float64Array([1, 2, 3]); // shorter than block
    const bins = realFft(samples, 0, 8); // reads past the end -> should zero-pad
    expect(bins.length).toBe(5); // 8/2+1
    expect(Number.isFinite(bins[0][0])).toBe(true);
  });
});

describe('realIfft', () => {
  test('round-trips a real signal through realFft -> realIfft', () => {
    const N = 64;
    const rng = seededRandom(22);
    const samples = new Float64Array(N);
    for (let i = 0; i < N; i++) samples[i] = rng();

    const bins = realFft(samples, 0, N);
    const back = realIfft(bins);

    let maxErr = 0;
    for (let i = 0; i < N; i++) maxErr = Math.max(maxErr, Math.abs(back[i] - samples[i] * N));
    // realFft/realIfft here are UNNORMALIZED (matches FFTW's convention —
    // FFTW's c2r is also unnormalized, forward*inverse scales by N,
    // exactly matching ft8mon's own one_fft/one_ifft pairing, which never
    // separately normalizes either).
    expect(maxErr).toBeLessThan(1e-6);
  });

  test('DC-only spectrum produces a constant signal', () => {
    const nBins = 5; // block = 8
    const bins: [number, number][] = new Array(nBins).fill(0).map(() => [0, 0]);
    bins[0] = [16, 0]; // DC = 16
    const out = realIfft(bins);
    expect(out.length).toBe(8);
    for (const v of out) expect(v).toBeCloseTo(16, 6);
  });
});

describe('fbandpass', () => {
  test('zeroes bins outside the pass band, passes bins inside unchanged', () => {
    const bins: [number, number][] = Array.from({ length: 20 }, (_, i) => [i + 1, 0]);
    const binHz = 1;
    const out = fbandpass(bins, binHz, 2, 4, 10, 12);
    expect(out[0][0]).toBe(0); // ihz=0, below low_outer
    expect(out[19][0]).toBe(0); // ihz=19, above high_outer
    expect(out[7][0]).toBeCloseTo(bins[7][0], 6); // ihz=7, in flat pass region
  });
});

describe('shiftBins', () => {
  test('shifts down by N bins, zero-filling out-of-range', () => {
    const bins: [number, number][] = [[1, 0], [2, 0], [3, 0], [4, 0], [5, 0]];
    const shifted = shiftBins(bins, 2);
    expect(shifted).toEqual([[3, 0], [4, 0], [5, 0], [0, 0], [0, 0]]);
  });

  test('negative shift zero-fills the front', () => {
    const bins: [number, number][] = [[1, 0], [2, 0], [3, 0]];
    const shifted = shiftBins(bins, -1);
    expect(shifted).toEqual([[0, 0], [1, 0], [2, 0]]);
  });
});

describe('blackman', () => {
  test('starts near zero and peaks near the middle', () => {
    const w = blackman(64);
    expect(w[0]).toBeCloseTo(0, 1);
    const mid = w[32];
    expect(mid).toBeGreaterThan(w[0]);
    expect(mid).toBeGreaterThan(0.9);
  });
});
