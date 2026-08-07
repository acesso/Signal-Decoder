import { SSTVDecoder } from '../decoder';
import { encodeSSTV, VIS_HEADER_SECONDS } from '../encoder';
import { SAMPLE_RATE } from '../constants';

// decoder.ts and its line decoders log verbosely per sample-window by design
// (interactive debugging aid) — silence it here so the round-trip encode/
// decode in these tests doesn't spend most of its wall-clock on console I/O.
let logSpy: jest.SpiedFunction<typeof console.log>;
beforeAll(() => {
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
});
afterAll(() => {
  logSpy.mockRestore();
});

// Resample a waveform with a *linearly increasing* rate — simulates a
// receiver clock that runs progressively faster relative to the
// transmitter's, the real-world cause of the growing per-line horizontal
// skew this test guards against. driftPerSample is the fractional rate
// change accumulated per output sample (tiny, e.g. 2e-7 ~= 200ms drift over
// a ~35s Robot36 transmission).
function applyLinearDrift(samples: Float32Array, driftPerSample: number): Float32Array {
  const out = new Float32Array(samples.length);
  let srcPos = 0;
  for (let i = 0; i < samples.length; i++) {
    const rate = 1 + driftPerSample * i;
    const srcI = Math.floor(srcPos);
    const frac = srcPos - srcI;
    const a = samples[Math.min(srcI, samples.length - 1)];
    const b = samples[Math.min(srcI + 1, samples.length - 1)];
    out[i] = a * (1 - frac) + b * frac;
    srcPos += rate;
    if (srcPos >= samples.length - 2) {
      out[i] = samples[samples.length - 1];
    }
  }
  return out;
}

// Solid vertical white stripe on black — the feature whose column position
// we track across decoded rows. A right-shifting stripe row-over-row is
// exactly the visual skew reported against real captures.
function makeStripeImage(width: number, height: number, stripeX: number, stripeWidth: number): Uint8ClampedArray {
  const img = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const isStripe = x >= stripeX && x < stripeX + stripeWidth;
      const v = isStripe ? 255 : 0;
      img[idx] = v;
      img[idx + 1] = v;
      img[idx + 2] = v;
      img[idx + 3] = 255;
    }
  }
  return img;
}

// First column in the row whose luminance crosses the black/white midpoint —
// a simple, FM/YUV-lossiness-tolerant proxy for "where does the stripe start
// on this row". Returns null if the row never crosses (fully black/white,
// e.g. not yet decoded).
function stripeStartColumn(imageData: Uint8ClampedArray, width: number, row: number): number | null {
  for (let x = 0; x < width; x++) {
    const idx = (row * width + x) * 4;
    if (imageData[idx] > 128) return x;
  }
  return null;
}

describe('slant drift correction', () => {
  // Only decode the first ~20 lines' worth of audio — enough for the drift
  // EMA to pass DRIFT_MIN_SAMPLES and converge, without paying for a full
  // 240-line Robot36 transmission in every test run.
  const LINES_TO_TEST = 24;

  // Row 0-1 can still carry interlacing warm-up artifacts (Robot36 stores
  // the even line and only emits pixels once the following odd line
  // arrives) — skip them and compare only the stable region.
  const SKIP_ROWS = 2;

  function decodeFirstLines(driftPerSample: number, autoSlant: boolean): (number | null)[] {
    const width = 320;
    const height = 240;
    const stripeX = 150;
    const img = makeStripeImage(width, height, stripeX, 20);

    const full = encodeSSTV(img, 'ROBOT36', SAMPLE_RATE);
    const drifted = driftPerSample !== 0 ? applyLinearDrift(full, driftPerSample) : full;

    // Mirrors real usage (audioProcessor.ts): VISDetector consumes the VIS
    // header in its own pass and a fresh SSTVDecoder is only constructed
    // once the mode is known, so processSamples() never sees the header —
    // only scan-line audio from the first real line sync onward. Feeding
    // the raw header into the decoder (as an earlier version of this test
    // did) let its leader tone trip a spurious "valid line sync", which
    // made the *first* real sync-to-sync gap look like several missed
    // lines and fed decodeLineSpan garbage unrelated to slant at all.
    const headerSamples = Math.round(VIS_HEADER_SECONDS * SAMPLE_RATE);
    const sceneAudio = drifted.subarray(headerSamples);

    const decoder = new SSTVDecoder(SAMPLE_RATE, 'ROBOT36', autoSlant);
    decoder.start();

    const chunkSize = 4096;
    const samplesNeeded = Math.min(sceneAudio.length, Math.round(SAMPLE_RATE * LINES_TO_TEST * 0.15 * 1.3));
    for (let pos = 0; pos < samplesNeeded; pos += chunkSize) {
      decoder.processSamples(sceneAudio.subarray(pos, Math.min(pos + chunkSize, samplesNeeded)));
    }

    const imageData = decoder.getImageData();
    const columns: (number | null)[] = [];
    for (let row = SKIP_ROWS; row < LINES_TO_TEST; row++) {
      columns.push(stripeStartColumn(imageData, width, row));
    }
    return columns;
  }

  test('a clean (undrifted) signal decodes the stripe at a constant column across rows', () => {
    const columns = decodeFirstLines(0, true);
    const detected = columns.filter((c): c is number => c !== null);
    expect(detected.length).toBeGreaterThan(LINES_TO_TEST / 2);
    const first = detected[0];
    for (const c of detected) {
      expect(Math.abs(c - first)).toBeLessThanOrEqual(2);
    }
  });

  test('a sustained clock drift is tracked and corrected better with the drift-aware EMA than per-line-only correction', () => {
    // ~0.15%/s drift rate — small enough that every single line's corrFactor
    // stays inside the existing ±10% per-line bound (so pure per-line
    // correction "sees" every line and still can't fully cancel a sustained
    // trend), but large enough to visibly walk the stripe over 24 rows if
    // left uncorrected.
    const driftPerSample = 2.5e-7;

    const withDriftAwareCorrection = decodeFirstLines(driftPerSample, true);
    const withoutAnyCorrection = decodeFirstLines(driftPerSample, false);

    const detectedWith = withDriftAwareCorrection.filter((c): c is number => c !== null);
    const detectedWithout = withoutAnyCorrection.filter((c): c is number => c !== null);
    expect(detectedWith.length).toBeGreaterThan(LINES_TO_TEST / 2);
    expect(detectedWithout.length).toBeGreaterThan(LINES_TO_TEST / 2);

    const spread = (cols: number[]) => Math.max(...cols) - Math.min(...cols);
    const spreadWith = spread(detectedWith);
    const spreadWithout = spread(detectedWithout);

    // The whole point of tracking the trend: less accumulated horizontal
    // walk across the same rows than with no correction at all.
    expect(spreadWith).toBeLessThan(spreadWithout);
  });
});
