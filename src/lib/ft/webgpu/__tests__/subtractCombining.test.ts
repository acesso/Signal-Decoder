import { subtractDecodedSignal } from '../subtract';

const RATE = 12000;
const BLOCK = 1920;
const BIN_HZ = RATE / BLOCK;

function seededRandom(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return (s / 0x7fffffff) * 2 - 1;
  };
}

function synthesizeSignal(
  totalSamples: number,
  offSamples: number,
  bin0: number,
  re79: number[],
  amp: number,
): Float64Array {
  const samples = new Float64Array(totalSamples);
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

function makeRe79(seed: number): number[] {
  const rng = seededRandom(seed);
  return new Array(79).fill(0).map((_, i) => {
    if (i < 7 || (i >= 36 && i < 43) || i >= 72) {
      return [3, 1, 4, 0, 6, 5, 2][i < 7 ? i : i >= 72 ? i - 72 : i - 36];
    }
    return Math.floor((rng() * 0.5 + 0.5) * 8) % 8;
  });
}

/** Batch-within-pass approximation: sum each candidate's OWN independent
 *  delta (computed against the shared original nsamples, not against each
 *  other's partially-subtracted output) rather than subtracting one at a
 *  time. Mirrors subtractGpu.ts's own combining strategy (see its module
 *  header), but implemented directly against subtractDecodedSignal() so
 *  this test isolates the COMBINING STRATEGY itself from any GPU-kernel
 *  numerics. */
function subtractBatchedCpu(nsamples: Float64Array, candidates: Array<{ re79: number[]; hz0: number; hz1: number; offSec: number }>, rate: number): Float64Array {
  const deltas = candidates.map((c) => {
    const residual = subtractDecodedSignal(nsamples, c.re79, c.hz0, c.hz1, c.offSec, rate);
    const delta = new Float64Array(nsamples.length);
    for (let i = 0; i < nsamples.length; i++) delta[i] = nsamples[i] - residual[i];
    return delta;
  });
  const out = new Float64Array(nsamples.length);
  for (let i = 0; i < nsamples.length; i++) {
    let sum = 0;
    for (const d of deltas) sum += d[i];
    out[i] = nsamples[i] - sum;
  }
  return out;
}

function subtractSequential(nsamples: Float64Array, candidates: Array<{ re79: number[]; hz0: number; hz1: number; offSec: number }>, rate: number): Float64Array {
  let cur = nsamples;
  for (const c of candidates) cur = subtractDecodedSignal(cur, c.re79, c.hz0, c.hz1, c.offSec, rate);
  return cur;
}

describe('batch-within-pass combining vs strictly-sequential subtraction', () => {
  test('two overlapping-in-time, well-separated-in-frequency signals: batched-sum matches sequential closely', () => {
    const nSymbols = 85;
    const totalSamples = nSymbols * BLOCK;
    const offSamples = 2 * BLOCK;
    const offSec = offSamples / RATE;

    const bin0A = 200;
    const bin0B = 600; // well separated: (600-200)*6.25 = 2500 Hz apart, >> FT8's own ~50Hz tone spread
    const re79A = makeRe79(11);
    const re79B = makeRe79(22);

    const amp = 0.8;
    const noiseAmp = 0.02;
    const rng = seededRandom(3);
    const noise = new Float64Array(totalSamples);
    for (let i = 0; i < totalSamples; i++) noise[i] = noiseAmp * rng();

    const sigA = synthesizeSignal(totalSamples, offSamples, bin0A, re79A, amp);
    const sigB = synthesizeSignal(totalSamples, offSamples, bin0B, re79B, amp);
    const combined = new Float64Array(totalSamples);
    for (let i = 0; i < totalSamples; i++) combined[i] = noise[i] + sigA[i] + sigB[i];

    const candidates = [
      { re79: re79A, hz0: bin0A * BIN_HZ, hz1: bin0A * BIN_HZ, offSec },
      { re79: re79B, hz0: bin0B * BIN_HZ, hz1: bin0B * BIN_HZ, offSec },
    ];

    const seqResult = subtractSequential(combined, candidates, RATE);
    const batchResult = subtractBatchedCpu(combined, candidates, RATE);

    let maxDiff = 0, sumSqDiff = 0, sumSqSeq = 0;
    for (let i = 0; i < totalSamples; i++) {
      const d = Math.abs(seqResult[i] - batchResult[i]);
      maxDiff = Math.max(maxDiff, d);
      sumSqDiff += d * d;
      sumSqSeq += seqResult[i] * seqResult[i];
    }
    const relRmsDiff = Math.sqrt(sumSqDiff / totalSamples) / Math.sqrt(sumSqSeq / totalSamples);
    console.log(`two-signal batch-vs-sequential: maxDiff=${maxDiff.toFixed(4)}, relRmsDiff=${relRmsDiff.toFixed(4)}`);

    // Batched combining is an approximation, not an identity — for
    // well-separated frequencies it should be CLOSE (the two subtractions
    // barely interact) but need not be bit-exact (the residual-order
    // dependence in try_decode()'s own serial subtraction means signal B's
    // subtraction operates on an nsamples buffer that already had signal A
    // removed, vs batched subtracting signal B's contribution from the
    // ORIGINAL combined buffer).
    expect(relRmsDiff).toBeLessThan(0.05);
  });

  test('both signals are still substantially removed by the batched approximation', () => {
    const nSymbols = 85;
    const totalSamples = nSymbols * BLOCK;
    const offSamples = 2 * BLOCK;
    const offSec = offSamples / RATE;

    const bin0A = 200;
    const bin0B = 600;
    const re79A = makeRe79(11);
    const re79B = makeRe79(22);
    const amp = 0.8;

    const sigA = synthesizeSignal(totalSamples, offSamples, bin0A, re79A, amp);
    const sigB = synthesizeSignal(totalSamples, offSamples, bin0B, re79B, amp);
    const combined = new Float64Array(totalSamples);
    for (let i = 0; i < totalSamples; i++) combined[i] = sigA[i] + sigB[i];

    const candidates = [
      { re79: re79A, hz0: bin0A * BIN_HZ, hz1: bin0A * BIN_HZ, offSec },
      { re79: re79B, hz0: bin0B * BIN_HZ, hz1: bin0B * BIN_HZ, offSec },
    ];
    const batchResult = subtractBatchedCpu(combined, candidates, RATE);

    function bandEnergy(samples: Float64Array, bin0: number, re79: number[]): number {
      let e = 0;
      for (const si of [10, 20, 50, 60]) {
        const hz = (bin0 + re79[si]) * BIN_HZ;
        const base = offSamples + si * BLOCK + Math.round(BLOCK * 0.3);
        const len = Math.round(BLOCK * 0.4);
        let re = 0, im = 0;
        for (let i = 0; i < len; i++) {
          const idx = base + i;
          const x = idx < samples.length ? samples[idx] : 0;
          const theta = (2 * Math.PI * hz * i) / RATE;
          re += x * Math.cos(theta);
          im += x * Math.sin(theta);
        }
        e += Math.hypot(re, im);
      }
      return e;
    }

    const beforeA = bandEnergy(combined, bin0A, re79A);
    const afterA = bandEnergy(batchResult, bin0A, re79A);
    const beforeB = bandEnergy(combined, bin0B, re79B);
    const afterB = bandEnergy(batchResult, bin0B, re79B);

    expect(afterA).toBeLessThan(beforeA * 0.2);
    expect(afterB).toBeLessThan(beforeB * 0.2);
  });
});
