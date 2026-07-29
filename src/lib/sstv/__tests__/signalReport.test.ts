import { estimateSignalReport, formatSignalReport } from '../signalReport';

function makeSolidImage(width: number, height: number, r: number, g: number, b: number): Uint8ClampedArray {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
    data[i + 3] = 255;
  }
  return data;
}

function makeGradientImage(width: number, height: number): Uint8ClampedArray {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      data[i] = Math.round((x / (width - 1)) * 255);
      data[i + 1] = Math.round((y / (height - 1)) * 255);
      data[i + 2] = 128;
      data[i + 3] = 255;
    }
  }
  return data;
}

function makeNoisyImage(width: number, height: number, seed = 1): Uint8ClampedArray {
  const data = new Uint8ClampedArray(width * height * 4);
  let s = seed;
  const rand = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  for (let i = 0; i < data.length; i += 4) {
    const v = Math.round(rand() * 255);
    data[i] = v;
    data[i + 1] = Math.round(rand() * 255);
    data[i + 2] = Math.round(rand() * 255);
    data[i + 3] = 255;
  }
  return data;
}

describe('formatSignalReport', () => {
  test('concatenates R, S, V digits (RSV, not RST)', () => {
    expect(formatSignalReport({ readability: 5, strength: 9, video: 5 })).toBe('595');
    expect(formatSignalReport({ readability: 3, strength: 4, video: 2 })).toBe('342');
  });
});

describe('estimateSignalReport', () => {
  const W = 64, H = 64;

  test('returns readability/strength/video all within their valid ranges', () => {
    const img = makeGradientImage(W, H);
    const report = estimateSignalReport(15, 1, img, W, H);
    expect(report.readability).toBeGreaterThanOrEqual(1);
    expect(report.readability).toBeLessThanOrEqual(5);
    expect(report.strength).toBeGreaterThanOrEqual(1);
    expect(report.strength).toBeLessThanOrEqual(9);
    expect(report.video).toBeGreaterThanOrEqual(1);
    expect(report.video).toBeLessThanOrEqual(5);
  });

  test('a smooth solid-color image scores a clean video quality (5)', () => {
    const img = makeSolidImage(W, H, 100, 150, 200);
    const report = estimateSignalReport(20, 1, img, W, H);
    expect(report.video).toBe(5);
  });

  test('a smooth gradient scores a clean-to-near-clean video quality', () => {
    const img = makeGradientImage(W, H);
    const report = estimateSignalReport(20, 1, img, W, H);
    expect(report.video).toBeGreaterThanOrEqual(4);
  });

  test('a noisy/speckled image scores a lower video quality than a clean one', () => {
    const clean = estimateSignalReport(20, 1, makeSolidImage(W, H, 128, 128, 128), W, H);
    const noisy = estimateSignalReport(20, 1, makeNoisyImage(W, H), W, H);
    expect(noisy.video).toBeLessThan(clean.video);
  });

  test('video quality is independent of readability/strength (driven by pixels, not SNR/completeness)', () => {
    const img = makeSolidImage(W, H, 50, 50, 50);
    const highSnr = estimateSignalReport(25, 1, img, W, H);
    const lowSnr = estimateSignalReport(2, 1, img, W, H);
    expect(highSnr.video).toBe(lowSnr.video);
    expect(highSnr.strength).toBeGreaterThan(lowSnr.strength);
  });

  test('handles tiny images without throwing', () => {
    const img = makeSolidImage(2, 2, 10, 20, 30);
    expect(() => estimateSignalReport(10, 1, img, 2, 2)).not.toThrow();
  });

  test('null SNR falls back to a mid-scale strength', () => {
    const img = makeSolidImage(W, H, 0, 0, 0);
    const report = estimateSignalReport(null, 1, img, W, H);
    expect(report.strength).toBe(5);
  });
});
