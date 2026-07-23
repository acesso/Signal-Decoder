import { fft1920, FFT_N } from '../fft1920';
import { coarseGrid, magSpectrogram, oneCoarseStrength, COSTAS } from '../costasCorrelation';

const RATE = 12000;
const BIN_HZ = RATE / FFT_N; // 6.25 Hz/bin
const SYMBOL_SAMPLES = FFT_N; // one symbol per FFT block, matching ft8mon's block=1920

/** Synthesizes a minimal signal containing the 3 Costas sync blocks (si=0,
 *  36, 72) at a given tone-0 bin, each symbol a pure sinusoid at
 *  bin0+costas[si] for one full 1920-sample block, embedded in a longer
 *  buffer of pure noise so oneCoarseStrength's sig/noise ratio is
 *  meaningfully large only at the true (si0, bi0) cell. */
function synthesizeCostasSignal(nSymbols: number, tone0Bin: number, noiseAmp: number, seed: number): Float64Array {
  let s = seed;
  const rng = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return (s / 0x7fffffff) * 2 - 1;
  };

  const samples = new Float64Array(nSymbols * SYMBOL_SAMPLES);
  for (let i = 0; i < samples.length; i++) samples[i] = noiseAmp * rng();

  const costasBlocks = [0, 36, 72];
  for (const blockStart of costasBlocks) {
    for (let si = 0; si < 7; si++) {
      const symbolIdx = blockStart + si;
      if (symbolIdx >= nSymbols) continue;
      const toneBin = tone0Bin + COSTAS[si];
      const freqHz = toneBin * BIN_HZ;
      const base = symbolIdx * SYMBOL_SAMPLES;
      for (let n = 0; n < SYMBOL_SAMPLES; n++) {
        samples[base + n] += Math.cos((2 * Math.PI * freqHz * n) / RATE);
      }
    }
  }
  return samples;
}

/** Computes a full (nSymbols x nbins) spectrogram via per-symbol fft1920,
 *  matching ft8mon's ffts() one-FFT-per-symbol-time approach. Returns
 *  interleaved [re,im,...] rows concatenated. */
function computeSpectrogram(samples: Float64Array, nSymbols: number): Float64Array {
  const out = new Float64Array(nSymbols * FFT_N * 2);
  for (let si = 0; si < nSymbols; si++) {
    const block = new Float64Array(FFT_N * 2);
    for (let n = 0; n < FFT_N; n++) block[n * 2] = samples[si * SYMBOL_SAMPLES + n];
    const spec = fft1920(block);
    out.set(spec, si * FFT_N * 2);
  }
  return out;
}

describe('oneCoarseStrength / coarseGrid', () => {
  test('peaks at the true (si0, bi0) cell for a synthetic Costas-tone signal', () => {
    const nSymbols = 80; // just enough for one full 79-symbol search window
    const tone0Bin = 200; // arbitrary, well within [8, FFT_N/2 - 8)
    const samples = synthesizeCostasSignal(nSymbols, tone0Bin, 0.05, 42);
    const spectrogram = computeSpectrogram(samples, nSymbols);
    const mags = magSpectrogram(spectrogram, nSymbols, FFT_N);

    const trueStrength = oneCoarseStrength(mags, FFT_N, nSymbols, 0, tone0Bin);

    // A handful of wrong cells (wrong bin, wrong symbol offset) should score
    // much lower — this is the actual discriminating behavior coarse()
    // relies on to find real signals in the full search grid.
    const wrongBin = oneCoarseStrength(mags, FFT_N, nSymbols, 0, tone0Bin + 20);
    const wrongOffset = oneCoarseStrength(mags, FFT_N, nSymbols, 1, tone0Bin);

    expect(trueStrength).toBeGreaterThan(3); // strong sig/noise ratio at the true cell
    expect(trueStrength).toBeGreaterThan(wrongBin * 5);
    expect(trueStrength).toBeGreaterThan(wrongOffset * 2);
  });

  test('coarseGrid finds the true cell as the grid maximum', () => {
    const nSymbols = 85;
    const tone0Bin = 150;
    const samples = synthesizeCostasSignal(nSymbols, tone0Bin, 0.05, 7);
    const spectrogram = computeSpectrogram(samples, nSymbols);
    const mags = magSpectrogram(spectrogram, nSymbols, FFT_N);

    const params = { si0: 0, siCount: nSymbols - 79, bi0: 100, biCount: 200, nbins: FFT_N, nSymbols };
    const grid = coarseGrid(mags, params);

    let maxIdx = 0;
    for (let i = 1; i < grid.length; i++) if (grid[i] > grid[maxIdx]) maxIdx = i;

    const foundBiLocal = maxIdx % params.biCount;
    const foundSiLocal = Math.floor(maxIdx / params.biCount);
    expect(params.bi0 + foundBiLocal).toBe(tone0Bin);
    expect(params.si0 + foundSiLocal).toBe(0);
  });

  test('returns 0 for out-of-range cells instead of throwing', () => {
    const mags = new Float64Array(10 * FFT_N);
    expect(oneCoarseStrength(mags, FFT_N, 10, 0, 0)).toBe(0); // si0+79 >= nSymbols
    expect(oneCoarseStrength(mags, 10, 100, 0, 5)).toBe(0); // bi0+8 > nbins
  });
});
