import { VISDetector } from '../vis-detector';
import { encodeSSTV, VIS_HEADER_SECONDS } from '../encoder';
import { SAMPLE_RATE, SSTV_MODES } from '../constants';

// decoder.ts and its line decoders log verbosely per sample-window by design
// (interactive debugging aid) — silence it here so encodeSSTV's round-trip
// doesn't spend most of its wall-clock on console I/O.
let logSpy: jest.SpiedFunction<typeof console.log>;
beforeAll(() => {
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
});
afterAll(() => {
  logSpy.mockRestore();
});

// A real VIS header only, sliced off a real encoded transmission (any mode —
// the header format doesn't depend on which one) so it carries exactly the
// same leader/break/bits waveform VISDetector has to parse in production.
function encodeVISHeader(modeName: keyof typeof SSTV_MODES): Float32Array {
  const mode = SSTV_MODES[modeName];
  const width = mode.width;
  const height = mode.height;
  const img = new Uint8ClampedArray(width * height * 4).fill(128);
  const full = encodeSSTV(img, modeName, SAMPLE_RATE);
  const headerSamples = Math.round(VIS_HEADER_SECONDS * SAMPLE_RATE);
  return full.subarray(0, headerSamples);
}

// Deterministic pseudo-random noise (no Math.random dependency) at a given
// RMS amplitude — mirrors the noise generator pattern used in
// audioProcessor.test.ts for the analogous silence-detector tests.
function makeNoise(length: number, rms: number, seed = 1): Float32Array {
  let state = seed;
  const rand = () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return (state / 0x7fffffff) * 2 - 1;
  };
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) out[i] = rand() * rms;
  return out;
}

function add(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] + b[i];
  return out;
}

// Zero out short bursts of the signal at regular intervals — simulates
// impulse noise / brief QSB dips landing on top of an otherwise-clean tone,
// the real-world scenario MAX_CONSECUTIVE_MISSES exists to survive.
function punchHoles(samples: Float32Array, holeMs: number, periodMs: number, sampleRate: number): Float32Array {
  const out = new Float32Array(samples);
  const holeSamples = Math.round((holeMs / 1000) * sampleRate);
  const periodSamples = Math.round((periodMs / 1000) * sampleRate);
  for (let start = 0; start < out.length; start += periodSamples) {
    for (let i = start; i < Math.min(start + holeSamples, out.length); i++) out[i] = 0;
  }
  return out;
}

function punchHolesInRange(
  samples: Float32Array,
  holeMs: number,
  periodMs: number,
  sampleRate: number,
  rangeStartMs: number,
  rangeEndMs: number,
): Float32Array {
  const out = new Float32Array(samples);
  const holeSamples = Math.round((holeMs / 1000) * sampleRate);
  const periodSamples = Math.round((periodMs / 1000) * sampleRate);
  const rangeStart = Math.round((rangeStartMs / 1000) * sampleRate);
  const rangeEnd = Math.round((rangeEndMs / 1000) * sampleRate);
  for (let start = rangeStart; start < rangeEnd; start += periodSamples) {
    for (let i = start; i < Math.min(start + holeSamples, out.length); i++) out[i] = 0;
  }
  return out;
}

function feedInChunks(detector: VISDetector, samples: Float32Array, chunkSize = 4096) {
  for (let pos = 0; pos < samples.length; pos += chunkSize) {
    const result = detector.process(samples.subarray(pos, Math.min(pos + chunkSize, samples.length)));
    if (result.detected) return result;
  }
  return { detected: false as const };
}

describe('VISDetector', () => {
  test('decodes a clean VIS header', () => {
    const header = encodeVISHeader('ROBOT36');
    const detector = new VISDetector(SAMPLE_RATE);
    const result = feedInChunks(detector, header);
    expect(result.detected).toBe(true);
    expect(result.modeName).toBe('ROBOT36');
  });

  test('decodes correctly across several modes (different VIS codes)', () => {
    for (const modeName of ['ROBOT36', 'SCOTTIE_S1', 'PD120', 'MARTIN_M1'] as const) {
      const header = encodeVISHeader(modeName);
      const detector = new VISDetector(SAMPLE_RATE);
      const result = feedInChunks(detector, header);
      expect(result.detected).toBe(true);
      expect(result.modeName).toBe(modeName);
    }
  });

  test('a moderate noise floor added to a clean header does not prevent detection', () => {
    // Mirrors the real-world complaint: a genuine transmission with a
    // realistic broadband noise floor underneath it should still decode,
    // not just a pristine synthetic tone.
    const header = encodeVISHeader('ROBOT36');
    const noisy = add(header, makeNoise(header.length, 0.15, 42));
    const detector = new VISDetector(SAMPLE_RATE);
    const result = feedInChunks(detector, noisy);
    expect(result.detected).toBe(true);
    expect(result.modeName).toBe('ROBOT36');
  });

  test('pure noise (no VIS header at all) is never falsely detected', () => {
    const detector = new VISDetector(SAMPLE_RATE);
    for (let seed = 1; seed <= 5; seed++) {
      const noise = makeNoise(SAMPLE_RATE * 2, 0.2, seed);
      const result = feedInChunks(detector, noise);
      expect(result.detected).toBe(false);
      detector.reset();
    }
  });

  test('a long noise burst exceeding the miss tolerance still fails to detect (not infinitely tolerant)', () => {
    // A burst much longer than MAX_CONSECUTIVE_MISSES windows should still
    // legitimately break detection — this isn't a "make VIS detection never
    // fail" change, just "don't fail on isolated brief noise".
    const header = encodeVISHeader('ROBOT36');
    const punctured = punchHoles(header, 150, 300, SAMPLE_RATE); // 150ms holes
    const detector = new VISDetector(SAMPLE_RATE);
    const result = feedInChunks(detector, punctured);
    expect(result.detected).toBe(false);
  });

  test('dropouts confined to the ~300ms leader tones (not the break/start-bit) survive', () => {
    // Robot36's header phase boundaries: leader1 0-300ms, break 300-310ms,
    // leader2 310-610ms, start bit 610-640ms, data bits 640-880ms. Holes
    // placed only within the leader spans (well clear of the two short
    // tones) exercise exactly what MAX_CONSECUTIVE_MISSES was added for —
    // 12ms holes every 40ms reliably defeated the previous zero-tolerance
    // state machine (any single non-matching window reset the whole
    // detector to IDLE) but survive with the current miss budget.
    const header = encodeVISHeader('ROBOT36');
    let punctured = punchHolesInRange(header, 12, 40, SAMPLE_RATE, 0, 295);
    punctured = punchHolesInRange(punctured, 12, 40, SAMPLE_RATE, 315, 605);
    const detector = new VISDetector(SAMPLE_RATE);
    const result = feedInChunks(detector, punctured);
    expect(result.detected).toBe(true);
    expect(result.modeName).toBe('ROBOT36');
  });

  test('documented limitation: a dropout landing squarely on the ~10ms break tone can still defeat detection', () => {
    // The break tone is only ~10ms (a single WINDOW_MS-sized analysis
    // window) with no redundancy to average over, and Goertzel needs a
    // window at least this long to tell 1100/1200/1300Hz apart at all
    // (verified separately: shrinking the window collapses that
    // discrimination well before it would give the break tone useful
    // extra resolution). This test pins that known, currently-unfixed
    // edge case so a future change either fixes it deliberately or at
    // least updates this test's expectation on purpose, rather than by
    // accident.
    const header = encodeVISHeader('ROBOT36');
    const punctured = punchHolesInRange(header, 8, 1000, SAMPLE_RATE, 303, 400);
    const detector = new VISDetector(SAMPLE_RATE);
    const result = feedInChunks(detector, punctured);
    expect(result.detected).toBe(false);
  });
});
