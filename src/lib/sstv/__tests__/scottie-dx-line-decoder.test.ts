import { ScottieDXLineDecoder } from '../scottie-dx-line-decoder';

describe('ScottieDXLineDecoder', () => {
  const sampleRate = 48000;

  describe('Initialization', () => {
    test('creates instance with valid sample rate', () => {
      const decoder = new ScottieDXLineDecoder(sampleRate);
      expect(decoder).toBeDefined();
      expect(decoder).toBeInstanceOf(ScottieDXLineDecoder);
    });

    test('handles different sample rates', () => {
      expect(() => new ScottieDXLineDecoder(44100)).not.toThrow();
      expect(() => new ScottieDXLineDecoder(48000)).not.toThrow();
      expect(() => new ScottieDXLineDecoder(96000)).not.toThrow();
    });
  });

  describe('Timing Calculations', () => {
    test('first sync pulse is longer than regular sync', () => {
      const decoder = new ScottieDXLineDecoder(sampleRate);

      // First line: sync(9) + sep(1.5) + G(345.6) + sep(1.5) + B(345.6) + sync(9) + sep(1.5) + R(345.6)
      const firstSyncSamples = decoder.getFirstSyncPulseSamples();
      const expectedFirstSync = Math.round((0.009 + 2 * (0.0015 + 0.3456)) * sampleRate);

      expect(firstSyncSamples).toBeCloseTo(expectedFirstSync, 0);
    });

    test('getBeginSamples returns a negative value (negative timing)', () => {
      const decoder = new ScottieDXLineDecoder(sampleRate);
      expect(decoder.getBeginSamples()).toBeLessThan(0);
    });

    test('getEndSamples returns a positive value', () => {
      const decoder = new ScottieDXLineDecoder(sampleRate);
      expect(decoder.getEndSamples()).toBeGreaterThan(0);
    });

    test('handles 44.1kHz sample rate timing', () => {
      const decoder44k = new ScottieDXLineDecoder(44100);
      // Scottie DX at 44.1kHz: ~1049ms * 44100 = ~46260 samples
      // Plus buffer for negative timing (green/blue before sync): ~700ms extra
      const buffer = new Float32Array(100000);
      buffer.fill(0);
      expect(() => decoder44k.decodeScanLine(buffer, 50000, 0)).not.toThrow();
    });
  });

  describe('Scan Line Decoding', () => {
    test('returns null for too-short buffer', () => {
      const decoder = new ScottieDXLineDecoder(sampleRate);
      const shortBuffer = new Float32Array(100);
      const result = decoder.decodeScanLine(shortBuffer, 50, 0);
      expect(result).toBeNull();
    });

    test('returns null when sync pulse is too early (negative timing)', () => {
      const decoder = new ScottieDXLineDecoder(sampleRate);
      const buffer = new Float32Array(10000);

      // Scottie DX has negative timing (green/blue before sync), needs large offset
      const result = decoder.decodeScanLine(buffer, 100, 0); // Too close to start
      expect(result).toBeNull();
    });

    test('returns valid DecodedLine for correctly-sized buffer', () => {
      const decoder = new ScottieDXLineDecoder(sampleRate);
      // Scottie DX: ~1049ms total, but green/blue are before sync (negative timing)
      // Green starts ~701.7ms before sync, so need ~70000 samples at 48kHz before sync
      // Plus ~347ms after sync for red channel
      // Total buffer: ~100000 samples minimum
      const buffer = new Float32Array(120000);
      buffer.fill(0);

      // syncPulseIndex must be large enough to accommodate negative timing
      const result = decoder.decodeScanLine(buffer, 70000, 0);

      expect(result).not.toBeNull();
      if (result !== null) {
        expect(result.width).toBe(320);
        expect(result.height).toBe(1);
        expect(result.isOddLine).toBe(false);
        expect(result.pixels.length).toBe(320 * 4);
        expect(result.pixels).toBeInstanceOf(Uint8ClampedArray);
      }
    });

    test('handles frequency offset', () => {
      const decoder = new ScottieDXLineDecoder(sampleRate);
      const buffer = new Float32Array(120000);
      buffer.fill(0);
      expect(() => decoder.decodeScanLine(buffer, 70000, 0.1)).not.toThrow();
    });

    test('handles negative frequency offset', () => {
      const decoder = new ScottieDXLineDecoder(sampleRate);
      const buffer = new Float32Array(120000);
      buffer.fill(0);
      expect(() => decoder.decodeScanLine(buffer, 70000, -0.1)).not.toThrow();
    });
  });

  describe('RGB Sequential Decoding', () => {
    test('always returns height 1 (sequential RGB)', () => {
      const decoder = new ScottieDXLineDecoder(sampleRate);
      const buffer = new Float32Array(120000);
      buffer.fill(0);

      const result = decoder.decodeScanLine(buffer, 70000, 0);

      expect(result).not.toBeNull();
      if (result !== null) {
        expect(result.height).toBe(1);
        expect(result.isOddLine).toBe(false);
      }
    });

    test('produces valid RGB values in 0-255 range', () => {
      const decoder = new ScottieDXLineDecoder(sampleRate);
      const buffer = new Float32Array(120000);
      buffer.fill(0);

      const result = decoder.decodeScanLine(buffer, 70000, 0);

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

    test('all pixels have alpha 255', () => {
      const decoder = new ScottieDXLineDecoder(sampleRate);
      const buffer = new Float32Array(120000);
      buffer.fill(0.3);

      const result = decoder.decodeScanLine(buffer, 70000, 0);

      expect(result).not.toBeNull();
      if (result !== null) {
        for (let i = 3; i < result.pixels.length; i += 4) {
          expect(result.pixels[i]).toBe(255);
        }
      }
    });

    test('dark buffer decodes to dark pixels', () => {
      const decoder = new ScottieDXLineDecoder(sampleRate);
      const buffer = new Float32Array(120000);
      buffer.fill(-0.8);

      const result = decoder.decodeScanLine(buffer, 70000, 0);

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
      const decoder = new ScottieDXLineDecoder(sampleRate);
      const buffer = new Float32Array(120000);
      buffer.fill(0.8);

      const result = decoder.decodeScanLine(buffer, 70000, 0);

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

    test('consecutive lines are independent', () => {
      const decoder = new ScottieDXLineDecoder(sampleRate);
      const buffer = new Float32Array(120000);
      buffer.fill(0);

      const result1 = decoder.decodeScanLine(buffer, 70000, 0);
      expect(result1).not.toBeNull();
      if (result1 !== null) expect(result1.height).toBe(1);

      const result2 = decoder.decodeScanLine(buffer, 70000, 0);
      expect(result2).not.toBeNull();
      if (result2 !== null) expect(result2.height).toBe(1);
    });
  });

  describe('Reset Functionality', () => {
    test('reset does not throw', () => {
      const decoder = new ScottieDXLineDecoder(sampleRate);
      expect(() => decoder.reset()).not.toThrow();
    });

    test('can decode after reset', () => {
      const decoder = new ScottieDXLineDecoder(sampleRate);
      const buffer = new Float32Array(120000);
      buffer.fill(0);

      decoder.reset();
      const result = decoder.decodeScanLine(buffer, 70000, 0);
      expect(result).not.toBeNull();
    });

    test('multiple resets work correctly', () => {
      const decoder = new ScottieDXLineDecoder(sampleRate);
      decoder.reset();
      decoder.reset();
      decoder.reset();

      const buffer = new Float32Array(120000);
      buffer.fill(0);
      const result = decoder.decodeScanLine(buffer, 70000, 0);
      expect(result).not.toBeNull();
    });

    test('reset does not affect sequential decoding', () => {
      const decoder = new ScottieDXLineDecoder(sampleRate);
      const buffer = new Float32Array(120000);
      buffer.fill(0);

      const result1 = decoder.decodeScanLine(buffer, 70000, 0);
      expect(result1?.height).toBe(1);

      decoder.reset();

      const result2 = decoder.decodeScanLine(buffer, 70000, 0);
      expect(result2?.height).toBe(1);
    });
  });

  describe('Edge Cases', () => {
    test('handles all zeros buffer', () => {
      const decoder = new ScottieDXLineDecoder(sampleRate);
      const buffer = new Float32Array(120000);
      buffer.fill(0);
      expect(() => decoder.decodeScanLine(buffer, 70000, 0)).not.toThrow();
    });

    test('handles all ones buffer', () => {
      const decoder = new ScottieDXLineDecoder(sampleRate);
      const buffer = new Float32Array(120000);
      buffer.fill(1);
      expect(() => decoder.decodeScanLine(buffer, 70000, 0)).not.toThrow();
    });

    test('handles random noise', () => {
      const decoder = new ScottieDXLineDecoder(sampleRate);
      const buffer = new Float32Array(120000);
      for (let i = 0; i < buffer.length; i++) {
        buffer[i] = Math.random() * 2 - 1;
      }
      expect(() => decoder.decodeScanLine(buffer, 70000, 0)).not.toThrow();
    });
  });

  describe('Comparison with Scottie S1/S2', () => {
    test('Scottie DX is much slower than S1 and S2', () => {
      // S1: 138.24ms/ch, S2: 88.064ms/ch, DX: 345.6ms/ch
      const dxSamples = Math.round(0.3456 * sampleRate);
      const s1Samples = Math.round(0.13824 * sampleRate);
      const s2Samples = Math.round(0.088064 * sampleRate);

      expect(dxSamples).toBeGreaterThan(s1Samples);
      expect(dxSamples).toBeGreaterThan(s2Samples);
    });

    test('returns width 320 matching S1/S2', () => {
      const decoder = new ScottieDXLineDecoder(sampleRate);
      const buffer = new Float32Array(120000);
      buffer.fill(0);

      const result = decoder.decodeScanLine(buffer, 70000, 0);

      expect(result).not.toBeNull();
      if (result !== null) {
        expect(result.width).toBe(320);
      }
    });
  });
});
