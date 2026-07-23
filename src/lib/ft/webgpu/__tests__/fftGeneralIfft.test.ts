import { realFftGeneral, realIfftGeneral, fftGeneral } from '../fftGeneral';
import { realFft, realIfft } from '../dsp';

function seededRandom(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return (s / 0x7fffffff) * 2 - 1;
  };
}

describe('realIfftGeneral', () => {
  test('matches the proven direct-DFT realIfft from dsp.ts (small N)', () => {
    const n = 64;
    const rng = seededRandom(11);
    const samples = new Float64Array(n);
    for (let i = 0; i < n; i++) samples[i] = rng();

    const bins = realFft(samples, 0, n); // proven direct-DFT rfft
    const refBack = realIfft(bins); // proven direct-DFT irfft
    const gotBack = realIfftGeneral(bins); // new fast irfft, same input

    let maxErr = 0;
    for (let i = 0; i < n; i++) maxErr = Math.max(maxErr, Math.abs(refBack[i] - gotBack[i]));
    expect(maxErr).toBeLessThan(1e-6);
  });

  test('round-trips realFftGeneral -> realIfftGeneral for a 2/3/5-smooth N', () => {
    const n = 300;
    const rng = seededRandom(22);
    const samples = new Float64Array(n);
    for (let i = 0; i < n; i++) samples[i] = rng();

    const bins = realFftGeneral(samples, n);
    const back = realIfftGeneral(bins);

    let maxErr = 0;
    for (let i = 0; i < n; i++) maxErr = Math.max(maxErr, Math.abs(back[i] - samples[i] * n));
    expect(maxErr).toBeLessThan(1e-6);
  });

  test('round-trips for N with a non-2/3/5 prime factor (N=182 = 2*7*13)', () => {
    const n = 182;
    const rng = seededRandom(33);
    const samples = new Float64Array(n);
    for (let i = 0; i < n; i++) samples[i] = rng();

    const bins = realFftGeneral(samples, n);
    const back = realIfftGeneral(bins);

    let maxErr = 0;
    for (let i = 0; i < n; i++) maxErr = Math.max(maxErr, Math.abs(back[i] - samples[i] * n));
    expect(maxErr).toBeLessThan(1e-6);
  });

  test('DC-only spectrum produces a constant signal', () => {
    const nBins = 5; // n = 8
    const bins: [number, number][] = new Array(nBins).fill(0).map(() => [0, 0]);
    bins[0] = [16, 0];
    const out = realIfftGeneral(bins);
    expect(out.length).toBe(8);
    for (const v of out) expect(v).toBeCloseTo(16, 6);
  });

  test('is dramatically faster than the direct-DFT approach for a mid-size window (~2500 samples)', () => {
    const n = 2560; // realistic shift200 window size
    const rng = seededRandom(44);
    const samples = new Float64Array(n);
    for (let i = 0; i < n; i++) samples[i] = rng();

    const bins = realFftGeneral(samples, n);

    const tFast0 = performance.now();
    realIfftGeneral(bins);
    const tFast1 = performance.now();

    // Direct-DFT realIfft would be O(n^2) ~ 6.5M ops for n=2560 -- don't
    // actually run it here (would slow the suite down for no benefit,
    // this is a known-slow path we're replacing), just assert the fast
    // path completes well within a real-time budget.
    expect(tFast1 - tFast0).toBeLessThan(50);
  });
});
