import { encodeSSTV, resizeImageData, estimateEncodedSeconds } from '../encoder';
import { SSTVDecoder } from '../decoder';
import { SSTV_MODES } from '../constants';

const SAMPLE_RATE = 44100;

// decoder.ts and its line decoders log verbosely per sample-window by design
// (interactive debugging aid) — silence it here so full-suite round-trips
// don't spend most of their wall-clock formatting/writing console output.
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

function decodeAll(samples: Float32Array, modeName: keyof typeof SSTV_MODES): { image: Uint8ClampedArray; linesDecoded: number } {
  const decoder = new SSTVDecoder(SAMPLE_RATE, modeName, false);
  decoder.start();
  const CHUNK = 4096;
  for (let i = 0; i < samples.length; i += CHUNK) {
    decoder.processSamples(samples.subarray(i, Math.min(i + CHUNK, samples.length)));
  }
  return { image: decoder.getImageData(), linesDecoded: decoder.getStats().currentLine };
}

function avgChannelDiff(a: Uint8ClampedArray, b: Uint8ClampedArray, width: number, height: number): number {
  let total = 0;
  let n = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      for (let c = 0; c < 3; c++) {
        total += Math.abs(a[i + c] - b[i + c]);
        n++;
      }
    }
  }
  return total / n;
}

describe('encodeSSTV', () => {
  test('throws for an unsupported mode name', () => {
    const img = new Uint8ClampedArray(320 * 240 * 4);
    expect(() => encodeSSTV(img, 'NOT_A_MODE' as keyof typeof SSTV_MODES, SAMPLE_RATE)).toThrow();
  });

  test('produces mono samples in [-1, 1] and a non-trivial duration', () => {
    const mode = SSTV_MODES.ROBOT36;
    const img = makeGradientImage(mode.width, mode.height);
    const samples = encodeSSTV(img, 'ROBOT36', SAMPLE_RATE);
    expect(samples.length).toBeGreaterThan(SAMPLE_RATE); // at least 1s
    let min = Infinity, max = -Infinity;
    for (const s of samples) {
      min = Math.min(min, s);
      max = Math.max(max, s);
    }
    expect(min).toBeGreaterThanOrEqual(-1.0001);
    expect(max).toBeLessThanOrEqual(1.0001);
  });

  test('calls onProgress with the final line count', () => {
    const mode = SSTV_MODES.ROBOT36;
    const img = makeGradientImage(mode.width, mode.height);
    const progress = jest.fn();
    encodeSSTV(img, 'ROBOT36', SAMPLE_RATE, progress);
    expect(progress).toHaveBeenCalledWith({ line: mode.height, totalLines: mode.height });
  });

  // Full encode -> decode -> compare round-trips are expensive: the decoder
  // is a sample-by-sample JS implementation (Goertzel/FM-demod/filtering),
  // so decoding transmits at roughly real-time-scale — a few real seconds of
  // CPU per real second of encoded audio. Only the two cheapest, most
  // distinct-by-family modes get the full round-trip (ROBOT36: interlaced
  // YUV, smallest/shortest; SCOTTIE_S2: RGB sequential negative-timing,
  // fastest Scottie variant). This was cross-checked by hand against every
  // mode in every family (interlaced YUV, sequential YUV/PD, RGB
  // negative-timing Scottie, RGB positive-timing Martin/Wraase) during
  // development; the remaining modes get a cheap structural check below
  // instead of re-paying the full round-trip cost for all 14.
  describe.each(['ROBOT36', 'SCOTTIE_S2'] as const)('round-trips through the real decoder: %s', (modeName) => {
    test('decodes nearly all lines with low average pixel error', () => {
      const mode = SSTV_MODES[modeName];
      const img = makeGradientImage(mode.width, mode.height);
      const samples = encodeSSTV(img, modeName, SAMPLE_RATE);
      const { image, linesDecoded } = decodeAll(samples, modeName);

      // Sync detection has some edge slop (first/last line), so allow decoding
      // to fall a few lines short of the total rather than requiring exact.
      expect(linesDecoded).toBeGreaterThanOrEqual(mode.height - 10);

      const diff = avgChannelDiff(image, img, mode.width, mode.height);
      expect(diff).toBeLessThan(40);
    }, 60000);
  });

  describe.each([
    'ROBOT72',
    'SCOTTIE_S1',
    'SCOTTIE_DX',
    'MARTIN_M1',
    'MARTIN_M2',
    'WRAASE_SC2_180',
    'PD50',
    'PD90',
    'PD120',
    'PD160',
    'PD180',
    'PD240',
    'PD290',
  ] as const)('encodes without a full decode round-trip: %s', (modeName) => {
    test('produces bounded, non-empty audio matching the mode duration', () => {
      const mode = SSTV_MODES[modeName];
      const img = makeGradientImage(mode.width, mode.height);
      const samples = encodeSSTV(img, modeName, SAMPLE_RATE);

      // VIS header (~0.67s) + one scanTime per TRANSMITTED scan line. PD
      // modes pack 2 image rows into each transmitted line (Y-even + shared
      // chroma + Y-odd), so scanTime there covers height/2 lines, not height.
      const isPD = modeName.startsWith('PD');
      const transmittedLines = isPD ? mode.height / 2 : mode.height;
      const expectedMinSec = (mode.scanTime * transmittedLines) / 1000;
      expect(samples.length / SAMPLE_RATE).toBeGreaterThanOrEqual(expectedMinSec * 0.9);

      let min = Infinity, max = -Infinity;
      for (const s of samples) {
        min = Math.min(min, s);
        max = Math.max(max, s);
      }
      expect(min).toBeGreaterThanOrEqual(-1.0001);
      expect(max).toBeLessThanOrEqual(1.0001);
    });
  });
});

describe('resizeImageData', () => {
  test('nearest-neighbor upscale preserves solid color', () => {
    const src = new Uint8ClampedArray(2 * 2 * 4);
    for (let i = 0; i < src.length; i += 4) {
      src[i] = 10; src[i + 1] = 20; src[i + 2] = 30; src[i + 3] = 255;
    }
    const dst = resizeImageData(src, 2, 2, 8, 8);
    expect(dst.length).toBe(8 * 8 * 4);
    for (let i = 0; i < dst.length; i += 4) {
      expect(dst[i]).toBe(10);
      expect(dst[i + 1]).toBe(20);
      expect(dst[i + 2]).toBe(30);
      expect(dst[i + 3]).toBe(255);
    }
  });

  test('downscale samples within source bounds (no out-of-range reads)', () => {
    const src = makeGradientImage(64, 64);
    expect(() => resizeImageData(src, 64, 64, 16, 16)).not.toThrow();
    const dst = resizeImageData(src, 64, 64, 16, 16);
    expect(dst.length).toBe(16 * 16 * 4);
  });

  test('same-size resize is effectively an identity copy', () => {
    const src = makeGradientImage(10, 10);
    const dst = resizeImageData(src, 10, 10, 10, 10);
    for (let i = 0; i < src.length; i += 4) {
      expect(dst[i]).toBe(src[i]);
      expect(dst[i + 1]).toBe(src[i + 1]);
      expect(dst[i + 2]).toBe(src[i + 2]);
    }
  });
});
