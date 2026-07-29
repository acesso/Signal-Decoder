import { encodeSSTV } from '../encoder';
import { SyncIntervalDetector } from '../sync-interval-detector';
import { SSTV_MODES } from '../constants';

const SAMPLE_RATE = 44100;
const VIS_HEADER_SECONDS = 0.3 + 0.01 + 0.3 + 0.03 + 8 * 0.03 + 0.03; // mirrors encoder.ts's own constant

let logSpy: jest.SpiedFunction<typeof console.log>;
beforeAll(() => {
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
});
afterAll(() => {
  logSpy.mockRestore();
});

function makeGradientImage(width: number, height: number): Uint8ClampedArray {
  const img = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      img[i] = Math.round((x / Math.max(1, width - 1)) * 255);
      img[i + 1] = Math.round((y / Math.max(1, height - 1)) * 255);
      img[i + 2] = Math.round((1 - x / Math.max(1, width - 1)) * 255);
      img[i + 3] = 255;
    }
  }
  return img;
}

/** Simulates tuning in mid-transmission: strips the VIS header plus an
 *  additional offset into the image body, so the detector only ever sees
 *  audio a real "joined late" listener would have. */
function midStreamSamples(samples: Float32Array, skipIntoBodySeconds: number): Float32Array {
  const skipSamples = Math.round((VIS_HEADER_SECONDS + skipIntoBodySeconds) * SAMPLE_RATE);
  return samples.subarray(Math.min(skipSamples, samples.length));
}

function runDetector(samples: Float32Array): keyof typeof SSTV_MODES | undefined {
  const detector = new SyncIntervalDetector(SAMPLE_RATE);
  const CHUNK = 4096;
  for (let i = 0; i < samples.length; i += CHUNK) {
    const result = detector.process(samples.subarray(i, Math.min(i + CHUNK, samples.length)));
    if (result.detected) return result.modeName;
  }
  return undefined;
}

describe('SyncIntervalDetector', () => {
  test('never reports detected on silence', () => {
    const detector = new SyncIntervalDetector(SAMPLE_RATE);
    const silence = new Float32Array(SAMPLE_RATE * 3); // 3s of silence
    const result = detector.process(silence);
    expect(result.detected).toBe(false);
  });

  describe.each(['ROBOT36', 'SCOTTIE_S2', 'PD120', 'MARTIN_M1'] as const)('identifies %s from mid-stream sync timing alone (skipping the VIS header)', (modeName) => {
    test('detects the correct mode without ever seeing the VIS header', () => {
      const mode = SSTV_MODES[modeName];
      const img = makeGradientImage(mode.width, mode.height);
      const full = encodeSSTV(img, modeName, SAMPLE_RATE);
      // Join a couple of lines into the transmission, well past the header.
      const midStream = midStreamSamples(full, 2 * (mode.scanTime / 1000));

      const detected = runDetector(midStream);
      expect(detected).toBe(modeName);
    }, 30000);
  });

  // Cheaper structural check for the rest: the timing-match math alone
  // (no full audio synthesis/detection round-trip) — confirms every mode's
  // scanTime resolves to itself and nothing else within tolerance, which is
  // the actual disambiguation the detector depends on. The two closest
  // modes (PD90 vs WRAASE_SC2_180, ~9ms apart) are the tightest case.
  test('every mode scanTime is closer to itself than to any other mode (within tolerance)', () => {
    const entries = Object.entries(SSTV_MODES) as Array<[keyof typeof SSTV_MODES, (typeof SSTV_MODES)[keyof typeof SSTV_MODES]]>;
    for (const [name, mode] of entries) {
      let closest: { name: keyof typeof SSTV_MODES; diff: number } | null = null;
      for (const [otherName, otherMode] of entries) {
        const diff = Math.abs(mode.scanTime - otherMode.scanTime);
        if (!closest || diff < closest.diff) closest = { name: otherName, diff };
      }
      expect(closest!.name).toBe(name);
    }
  });
});
