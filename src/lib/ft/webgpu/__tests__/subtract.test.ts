import { analytic, hilbertShift, recode, subtractDecodedSignal, blocksize } from '../subtract';

const RATE = 12000;
const BLOCK = 1920;
const BIN_HZ = RATE / BLOCK; // 6.25

function seededRandom(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return (s / 0x7fffffff) * 2 - 1;
  };
}

describe('analytic / hilbertShift', () => {
  test('analytic() real part reproduces the original signal (scipy.signal.hilbert contract)', () => {
    const n = 512;
    const rng = seededRandom(1);
    const x = new Float64Array(n);
    for (let i = 0; i < n; i++) x[i] = rng();

    const y = analytic(x);
    let maxErr = 0;
    for (let i = 0; i < n; i++) maxErr = Math.max(maxErr, Math.abs(y[i][0] - x[i]));
    expect(maxErr).toBeLessThan(1e-9);
  });

  test('hilbertShift with hz0=hz1=0 is the identity (no shift)', () => {
    const n = 400;
    const rng = seededRandom(2);
    const x = new Float64Array(n);
    for (let i = 0; i < n; i++) x[i] = rng();

    const out = hilbertShift(x, 0, 0, RATE);
    let maxErr = 0;
    for (let i = 0; i < n; i++) maxErr = Math.max(maxErr, Math.abs(out[i] - x[i]));
    expect(maxErr).toBeLessThan(1e-9);
  });

  test('hilbertShift shifts a pure tone to the expected frequency', () => {
    const n = 2400; // 0.2s at 12000
    const f0 = 500;
    const shift = 200;
    const x = new Float64Array(n);
    for (let i = 0; i < n; i++) x[i] = Math.cos((2 * Math.PI * f0 * i) / RATE);

    const shifted = hilbertShift(x, shift, shift, RATE);

    // Compare energy at (f0+shift) bin in shifted vs x via direct DFT correlation.
    const targetHz = f0 + shift;
    let reX = 0, imX = 0, reS = 0, imS = 0;
    for (let i = 0; i < n; i++) {
      const theta = (2 * Math.PI * targetHz * i) / RATE;
      const c = Math.cos(theta), s = Math.sin(theta);
      reX += x[i] * c; imX += x[i] * s;
      reS += shifted[i] * c; imS += shifted[i] * s;
    }
    const magX = Math.hypot(reX, imX); // energy of x AT targetHz — should be small (x has no energy there)
    const magS = Math.hypot(reS, imS); // energy of shifted signal at targetHz — should be large

    expect(magS).toBeGreaterThan(magX * 10);
  });
});

describe('recode', () => {
  test('reproduces Costas sync blocks and gray-decodes data symbols', () => {
    // 58 data symbols * 3 bits = 174 bits.
    const a174 = new Array(174).fill(0);
    // First data symbol (i79=7) bits -> sym after graymap. Set bits to
    // produce a known raw sym=5 (before graymap) => map[5]=6.
    a174[0] = 1; a174[1] = 0; a174[2] = 1; // 101 = 5
    const re79 = recode(a174);
    expect(re79.length).toBe(79);
    expect(re79.slice(0, 7)).toEqual([3, 1, 4, 0, 6, 5, 2]);
    expect(re79.slice(36, 43)).toEqual([3, 1, 4, 0, 6, 5, 2]);
    expect(re79.slice(72, 79)).toEqual([3, 1, 4, 0, 6, 5, 2]);
    expect(re79[7]).toBe(6); // map[5] = 6
  });
});

/** Synthesizes an FT8-like tone-burst signal: 79 symbols, each a pure
 *  sinusoid at bin (bin0+re79[si])*BIN_HZ for one full 1920-sample block,
 *  embedded in a longer noise buffer starting at sample offSamples —
 *  mirrors costasCorrelation.test.ts's synthesizeCostasSignal() helper
 *  (grepped from this repo's existing test fixtures) but for an arbitrary
 *  re79[] sequence rather than just the 3 Costas blocks, since subtract()
 *  needs all 79 symbols to be present and coherent. */
function synthesizeSignal(
  totalSamples: number,
  offSamples: number,
  bin0: number,
  re79: number[],
  amp: number,
  noiseAmp: number,
  seed: number,
): Float64Array {
  const rng = seededRandom(seed);
  const samples = new Float64Array(totalSamples);
  for (let i = 0; i < totalSamples; i++) samples[i] = noiseAmp * rng();

  for (let si = 0; si < 79; si++) {
    const toneBin = bin0 + re79[si];
    const freqHz = toneBin * BIN_HZ;
    const base = offSamples + si * BLOCK;
    for (let n = 0; n < BLOCK; n++) {
      const idx = base + n;
      if (idx >= 0 && idx < totalSamples) {
        samples[idx] += amp * Math.cos((2 * Math.PI * freqHz * n) / RATE);
      }
    }
  }
  return samples;
}

function bandEnergy(samples: Float64Array, off: number, len: number, hz: number, rate: number): number {
  let re = 0, im = 0;
  for (let i = 0; i < len; i++) {
    const idx = off + i;
    const x = idx >= 0 && idx < samples.length ? samples[idx] : 0;
    const theta = (2 * Math.PI * hz * i) / rate;
    re += x * Math.cos(theta);
    im += x * Math.sin(theta);
  }
  return Math.hypot(re, im);
}

describe('subtractDecodedSignal', () => {
  test('blocksize(12000) === 1920', () => {
    expect(blocksize(RATE)).toBe(BLOCK);
  });

  test('round-trip: synthesizing then subtracting the SAME known re79/hz/off leaves a much quieter residual', () => {
    const nSymbols = 85;
    const totalSamples = nSymbols * BLOCK;
    const offSymbols = 2;
    const offSamples = offSymbols * BLOCK;
    const bin0 = 300; // -> hz0 = 1875
    const hz0 = bin0 * BIN_HZ;

    // A plausible-looking re79 (3 fixed Costas blocks + pseudo-random data
    // tones elsewhere), all in [0,7].
    const rng = seededRandom(99);
    const re79 = new Array(79).fill(0).map((_, i) => {
      if (i < 7 || (i >= 36 && i < 43) || i >= 72) {
        return [3, 1, 4, 0, 6, 5, 2][i < 7 ? i : i >= 72 ? i - 72 : i - 36];
      }
      return Math.floor((rng() * 0.5 + 0.5) * 8) % 8;
    });

    const amp = 1.0;
    const noiseAmp = 0.02;
    const samples = synthesizeSignal(totalSamples, offSamples, bin0, re79, amp, noiseAmp, 7);

    const offSec = offSamples / RATE;
    const residual = subtractDecodedSignal(samples, re79, hz0, hz0, offSec, RATE);

    // Energy at the signal's own tones, mid-burst (steady-state, away from
    // ramps), should drop sharply after subtraction.
    let beforeEnergy = 0, afterEnergy = 0;
    const checkSymbols = [10, 20, 50, 60];
    for (const si of checkSymbols) {
      const toneBin = bin0 + re79[si];
      const hz = toneBin * BIN_HZ;
      const base = offSamples + si * BLOCK + Math.round(BLOCK * 0.3);
      const len = Math.round(BLOCK * 0.4); // steady-state window, away from ramps
      beforeEnergy += bandEnergy(samples, base, len, hz, RATE);
      afterEnergy += bandEnergy(residual, base, len, hz, RATE);
    }

    expect(afterEnergy).toBeLessThan(beforeEnergy * 0.15);

    // A pure-noise-floor estimate for comparison: the after-energy should
    // be in the same ballpark as noise alone (not exactly, since hilbert
    // shift + subtraction floating-point residue isn't perfectly clean, but
    // should not still look like a full-amplitude tone).
    const noiseOnly = new Float64Array(totalSamples);
    const rng2 = seededRandom(7);
    for (let i = 0; i < totalSamples; i++) noiseOnly[i] = noiseAmp * rng2();
    let noiseFloor = 0;
    for (const si of checkSymbols) {
      const toneBin = bin0 + re79[si];
      const hz = toneBin * BIN_HZ;
      const base = offSamples + si * BLOCK + Math.round(BLOCK * 0.3);
      const len = Math.round(BLOCK * 0.4);
      noiseFloor += bandEnergy(noiseOnly, base, len, hz, RATE);
    }
    // Residual energy should be within an order of magnitude of pure noise
    // floor energy at these same bins (loose bound — subtraction isn't
    // perfect due to ramp transitions/measurement of amp+phase from a
    // slightly-shifted buffer, but should be far from the original signal).
    expect(afterEnergy).toBeLessThan(noiseFloor * 10);
  });

  test('does not touch parts of the buffer far outside the signal window much', () => {
    const nSymbols = 85;
    const totalSamples = nSymbols * BLOCK;
    const offSamples = 2 * BLOCK;
    const bin0 = 300;
    const hz0 = bin0 * BIN_HZ;
    const re79 = new Array(79).fill(0).map((_, i) => [3, 1, 4, 0, 6, 5, 2][i % 7]);

    const samples = synthesizeSignal(totalSamples, offSamples, bin0, re79, 1.0, 0.02, 5);
    const offSec = offSamples / RATE;
    const residual = subtractDecodedSignal(samples, re79, hz0, hz0, offSec, RATE);

    // Well before the signal starts (a full symbol block of margin) should
    // be ~unchanged (hilbert_shift can smear slightly at edges, so allow
    // some tolerance, but it should not be wildly different).
    let maxDiff = 0;
    for (let i = 0; i < BLOCK; i++) {
      maxDiff = Math.max(maxDiff, Math.abs(residual[i] - samples[i]));
    }
    expect(maxDiff).toBeLessThan(0.5); // well under the tone's own amplitude of 1.0
  });
});
