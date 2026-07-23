// Runtime feature detection for which WASM SIMD tier this browser's engine
// actually supports, so the worker can load the fastest build it can run
// instead of assuming. Byte sequences are the standard, well-known
// WebAssembly.validate() probes used by GoogleChromeLabs/wasm-feature-detect
// (MIT-licensed; inlined here rather than adding a dependency for 2 of its
// ~22 detectors) — each encodes a tiny module containing exactly one
// SIMD-tier-specific instruction, so validate() (static type-check, no
// instantiation/execution) succeeds only on an engine that understands it.
export type SimdTier = 'relaxed-simd' | 'simd128' | 'baseline';

// (module (func (result v128) (i8x16.popcnt (v128.const i32x4 0 0 0 0))))
const SIMD128_PROBE = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1,
  8, 0, 65, 0, 253, 15, 253, 98, 11,
]);

// (module (func (result v128) (i8x16.relaxed_swizzle ...))) — an instruction
// only a Relaxed SIMD-capable engine can validate.
const RELAXED_SIMD_PROBE = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 15, 1,
  13, 0, 65, 1, 253, 15, 65, 2, 253, 15, 253, 128, 2, 11,
]);

function supportsSimd128(): boolean {
  try {
    return WebAssembly.validate(SIMD128_PROBE);
  } catch {
    return false;
  }
}

function supportsRelaxedSimd(): boolean {
  try {
    return WebAssembly.validate(RELAXED_SIMD_PROBE);
  } catch {
    return false;
  }
}

let cached: SimdTier | null = null;

/** Highest WASM SIMD tier this engine supports, detected once and cached —
 *  WebAssembly.validate() is cheap but there's no reason to re-probe it on
 *  every decode window. */
export function detectSimdTier(): SimdTier {
  if (cached) return cached;
  if (supportsRelaxedSimd()) cached = 'relaxed-simd';
  else if (supportsSimd128()) cached = 'simd128';
  else cached = 'baseline';
  return cached;
}
