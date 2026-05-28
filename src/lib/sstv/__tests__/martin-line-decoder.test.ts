import { MartinLineDecoder } from '../martin-line-decoder';

describe('MartinLineDecoder', () => {
  const sampleRate = 48000;

  describe('Initialization', () => {
    test('creates Martin M1 instance with valid sample rate', () => {
      const decoder = new MartinLineDecoder(sampleRate, 0.146432);
      expect(decoder).toBeDefined();
      expect(decoder).toBeInstanceOf(MartinLineDecoder);
    });

    test('creates Martin M2 instance with valid sample rate', () => {
      const decoder = new MartinLineDecoder(sampleRate, 0.058048);
      expect(decoder).toBeDefined();
      expect(decoder).toBeInstanceOf(MartinLineDecoder);
    });

    test('handles different sample rates for M1', () => {
      expect(() => new MartinLineDecoder(44100, 0.146432)).not.toThrow();
      expect(() => new MartinLineDecoder(48000, 0.146432)).not.toThrow();
      expect(() => new MartinLineDecoder(96000, 0.146432)).not.toThrow();
    });

    test('handles different sample rates for M2', () => {
      expect(() => new MartinLineDecoder(44100, 0.058048)).not.toThrow();
      expect(() => new MartinLineDecoder(48000, 0.058048)).not.toThrow();
      expect(() => new MartinLineDecoder(96000, 0.058048)).not.toThrow();
    });
  });

  describe('Scan Line Decoding - Martin M1', () => {
    test('returns null for too-short buffer', () => {
      const decoder = new MartinLineDecoder(sampleRate, 0.146432);
      const shortBuffer = new Float32Array(100);
      const result = decoder.decodeScanLine(shortBuffer, 0, 0);
      expect(result).toBeNull();
    });

    test('returns null when syncPulseIndex is negative', () => {
      const decoder = new MartinLineDecoder(sampleRate, 0.146432);
      const buffer = new Float32Array(50000);
      buffer.fill(0);
      const result = decoder.decodeScanLine(buffer, -1, 0);
      expect(result).toBeNull();
    });

    test('returns valid DecodedLine for correctly-sized buffer (M1 ~446ms at 48kHz)', () => {
      const decoder = new MartinLineDecoder(sampleRate, 0.146432);
      // Martin M1: ~445.874ms total line at 48kHz = ~21402 samples
      // sync(4.862) + porch(0.572) + G(146.432) + sep(0.572) + B(146.432) + sep(0.572) + R(146.432) = 445.874ms
      const totalSamples = Math.ceil(0.446 * sampleRate) + 1000; // extra headroom
      const buffer = new Float32Array(totalSamples);
      buffer.fill(0);

      const result = decoder.decodeScanLine(buffer, 0, 0);

      expect(result).not.toBeNull();
      if (result !== null) {
        expect(result.width).toBe(320);
        expect(result.height).toBe(1);
        expect(result.isOddLine).toBe(false);
        expect(result.pixels.length).toBe(320 * 4);
        expect(result.pixels).toBeInstanceOf(Uint8ClampedArray);
      }
    });

    test('all pixels have alpha 255', () => {
      const decoder = new MartinLineDecoder(sampleRate, 0.146432);
      const buffer = new Float32Array(30000);
      buffer.fill(0.3);

      const result = decoder.decodeScanLine(buffer, 0, 0);

      expect(result).not.toBeNull();
      if (result !== null) {
        for (let i = 3; i < result.pixels.length; i += 4) {
          expect(result.pixels[i]).toBe(255);
        }
      }
    });
  });

  describe('Scan Line Decoding - Martin M2', () => {
    test('returns null for too-short buffer', () => {
      const decoder = new MartinLineDecoder(sampleRate, 0.058048);
      const shortBuffer = new Float32Array(100);
      const result = decoder.decodeScanLine(shortBuffer, 0, 0);
      expect(result).toBeNull();
    });

    test('returns valid DecodedLine for correctly-sized buffer (M2 ~181ms at 48kHz)', () => {
      const decoder = new MartinLineDecoder(sampleRate, 0.058048);
      // Martin M2: ~180.722ms total at 48kHz
      const totalSamples = Math.ceil(0.182 * sampleRate) + 500;
      const buffer = new Float32Array(totalSamples);
      buffer.fill(0);

      const result = decoder.decodeScanLine(buffer, 0, 0);

      expect(result).not.toBeNull();
      if (result !== null) {
        expect(result.width).toBe(320);
        expect(result.height).toBe(1);
        expect(result.isOddLine).toBe(false);
        expect(result.pixels.length).toBe(320 * 4);
        expect(result.pixels).toBeInstanceOf(Uint8ClampedArray);
      }
    });
  });

  describe('Positive Timing (sync-first)', () => {
    test('Martin uses positive timing (buffer starts at sync, no negative offset needed)', () => {
      const decoder = new MartinLineDecoder(sampleRate, 0.146432);
      // syncPulseIndex=0 is valid for Martin (unlike Scottie which needs a large positive offset)
      const buffer = new Float32Array(30000);
      buffer.fill(0);

      const result = decoder.decodeScanLine(buffer, 0, 0);
      expect(result).not.toBeNull();
    });

    test('non-zero sync position within large buffer', () => {
      const decoder = new MartinLineDecoder(sampleRate, 0.146432);
      const buffer = new Float32Array(50000);
      buffer.fill(0);

      const result = decoder.decodeScanLine(buffer, 1000, 0);
      expect(result).not.toBeNull();
    });
  });

  describe('RGB Output Validation', () => {
    test('produces valid RGB values in 0-255 range', () => {
      const decoder = new MartinLineDecoder(sampleRate, 0.146432);
      const buffer = new Float32Array(30000);
      buffer.fill(0);

      const result = decoder.decodeScanLine(buffer, 0, 0);

      expect(result).not.toBeNull();
      if (result !== null) {
        for (let i = 0; i < result.pixels.length; i += 4) {
          expect(result.pixels[i]).toBeGreaterThanOrEqual(0);
          expect(result.pixels[i]).toBeLessThanOrEqual(255);
          expect(result.pixels[i + 1]).toBeGreaterThanOrEqual(0);
          expect(result.pixels[i + 1]).toBeLessThanOrEqual(255);
          expect(result.pixels[i + 2]).toBeGreaterThanOrEqual(0);
          expect(result.pixels[i + 2]).toBeLessThanOrEqual(255);
          expect(result.pixels[i + 3]).toBe(255);
        }
      }
    });

    test('dark buffer decodes to dark pixels', () => {
      const decoder = new MartinLineDecoder(sampleRate, 0.146432);
      const buffer = new Float32Array(30000);
      buffer.fill(-0.8);

      const result = decoder.decodeScanLine(buffer, 0, 0);

      expect(result).not.toBeNull();
      if (result !== null) {
        const r = result.pixels[0];
        const g = result.pixels[1];
        const b = result.pixels[2];
        expect(r).toBeLessThan(100);
        expect(g).toBeLessThan(100);
        expect(b).toBeLessThan(100);
      }
    });

    test('bright buffer decodes to bright pixels', () => {
      const decoder = new MartinLineDecoder(sampleRate, 0.146432);
      const buffer = new Float32Array(30000);
      buffer.fill(0.8);

      const result = decoder.decodeScanLine(buffer, 0, 0);

      expect(result).not.toBeNull();
      if (result !== null) {
        const r = result.pixels[0];
        const g = result.pixels[1];
        const b = result.pixels[2];
        expect(r).toBeGreaterThan(150);
        expect(g).toBeGreaterThan(150);
        expect(b).toBeGreaterThan(150);
      }
    });
  });

  describe('Frequency Offset Handling', () => {
    test('handles positive frequency offset', () => {
      const decoder = new MartinLineDecoder(sampleRate, 0.146432);
      const buffer = new Float32Array(30000);
      buffer.fill(0);
      expect(() => decoder.decodeScanLine(buffer, 0, 0.1)).not.toThrow();
    });

    test('handles negative frequency offset', () => {
      const decoder = new MartinLineDecoder(sampleRate, 0.146432);
      const buffer = new Float32Array(30000);
      buffer.fill(0);
      expect(() => decoder.decodeScanLine(buffer, 0, -0.1)).not.toThrow();
    });
  });

  describe('Reset Functionality', () => {
    test('reset does not throw', () => {
      const decoder = new MartinLineDecoder(sampleRate, 0.146432);
      expect(() => decoder.reset()).not.toThrow();
    });

    test('can decode after reset', () => {
      const decoder = new MartinLineDecoder(sampleRate, 0.146432);
      const buffer = new Float32Array(30000);
      buffer.fill(0);

      decoder.reset();
      const result = decoder.decodeScanLine(buffer, 0, 0);
      expect(result).not.toBeNull();
    });

    test('multiple resets work correctly', () => {
      const decoder = new MartinLineDecoder(sampleRate, 0.146432);
      decoder.reset();
      decoder.reset();
      decoder.reset();

      const buffer = new Float32Array(30000);
      buffer.fill(0);
      const result = decoder.decodeScanLine(buffer, 0, 0);
      expect(result).not.toBeNull();
    });
  });

  describe('Edge Cases', () => {
    test('handles all zeros buffer', () => {
      const decoder = new MartinLineDecoder(sampleRate, 0.146432);
      const buffer = new Float32Array(30000);
      buffer.fill(0);
      expect(() => decoder.decodeScanLine(buffer, 0, 0)).not.toThrow();
    });

    test('handles all ones buffer', () => {
      const decoder = new MartinLineDecoder(sampleRate, 0.146432);
      const buffer = new Float32Array(30000);
      buffer.fill(1);
      expect(() => decoder.decodeScanLine(buffer, 0, 0)).not.toThrow();
    });

    test('handles all negative ones buffer', () => {
      const decoder = new MartinLineDecoder(sampleRate, 0.146432);
      const buffer = new Float32Array(30000);
      buffer.fill(-1);
      expect(() => decoder.decodeScanLine(buffer, 0, 0)).not.toThrow();
    });

    test('handles random noise', () => {
      const decoder = new MartinLineDecoder(sampleRate, 0.146432);
      const buffer = new Float32Array(30000);
      for (let i = 0; i < buffer.length; i++) {
        buffer[i] = Math.random() * 2 - 1;
      }
      expect(() => decoder.decodeScanLine(buffer, 0, 0)).not.toThrow();
    });

    test('consecutive line decodes are independent', () => {
      const decoder = new MartinLineDecoder(sampleRate, 0.146432);
      const buffer = new Float32Array(30000);
      buffer.fill(0);

      const result1 = decoder.decodeScanLine(buffer, 0, 0);
      expect(result1).not.toBeNull();
      if (result1 !== null) expect(result1.height).toBe(1);

      const result2 = decoder.decodeScanLine(buffer, 0, 0);
      expect(result2).not.toBeNull();
      if (result2 !== null) expect(result2.height).toBe(1);
    });
  });
});
