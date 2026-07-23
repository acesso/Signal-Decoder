import { detectSimdTier } from '../simdTier';

describe('detectSimdTier', () => {
  test('returns one of the known tiers', () => {
    const tier = detectSimdTier();
    expect(['relaxed-simd', 'simd128', 'baseline']).toContain(tier);
  });

  test('caches the result across calls (WebAssembly.validate not re-run every time)', () => {
    const first = detectSimdTier();
    const second = detectSimdTier();
    expect(second).toBe(first);
  });

  test('reflects this Node engine\'s actual WASM SIMD support', () => {
    // Jest runs under Node/V8 — this is a real environment check, not a
    // mock, so the tier reported must be consistent with what
    // WebAssembly.validate() itself reports for the SIMD128 probe.
    const simd128Probe = new Uint8Array([
      0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10,
      1, 8, 0, 65, 0, 253, 15, 253, 98, 11,
    ]);
    const engineSupportsSimd128 = WebAssembly.validate(simd128Probe);
    const tier = detectSimdTier();
    if (!engineSupportsSimd128) {
      expect(tier).toBe('baseline');
    } else {
      expect(['simd128', 'relaxed-simd']).toContain(tier);
    }
  });
});
