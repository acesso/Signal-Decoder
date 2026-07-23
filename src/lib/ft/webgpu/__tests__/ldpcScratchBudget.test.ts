import { checkLdpcScratchBudget } from '../ldpcScratchBudget';

// Regression test for a real bug found while benchmarking: past a candidate
// count whose scratch buffer exceeds WebGPU's default 128 MiB
// maxStorageBufferBindingSize, createBindGroup() silently rejects the bind
// (a validation error surfaced through the device's error-scope/
// uncapturederror mechanism, NOT a thrown JS exception) and every
// candidate's decode result came back as an all-zero (ok=0) buffer instead
// of a visible error — a genuinely dangerous failure mode since it looks
// like "every single decode failed" rather than "ran out of GPU memory
// budget". checkLdpcScratchBudget() is the proactive guard that turns this
// into a clear, immediate thrown error instead.
const MIB = 1024 * 1024;
const DEFAULT_LIMIT = 128 * MIB; // WebGPU spec's guaranteed-minimum maxStorageBufferBindingSize

describe('checkLdpcScratchBudget', () => {
  test('allows the exact real-world boundary that was measured to work (1161 candidates)', () => {
    expect(checkLdpcScratchBudget(1161, DEFAULT_LIMIT)).toBeNull();
  });

  test('rejects the exact real-world boundary that was measured to silently corrupt (1162 candidates)', () => {
    const err = checkLdpcScratchBudget(1162, DEFAULT_LIMIT);
    expect(err).not.toBeNull();
    expect(err).toContain('1162 candidates');
    expect(err).toContain('128.0 MiB');
  });

  test('allows small, realistic candidate counts', () => {
    expect(checkLdpcScratchBudget(1, DEFAULT_LIMIT)).toBeNull();
    expect(checkLdpcScratchBudget(100, DEFAULT_LIMIT)).toBeNull();
    expect(checkLdpcScratchBudget(500, DEFAULT_LIMIT)).toBeNull();
  });

  test('error message reports the max candidates this device could actually handle', () => {
    const err = checkLdpcScratchBudget(2000, DEFAULT_LIMIT);
    expect(err).toContain('Max candidates in one dispatch on this device: 1161');
  });

  test('scales correctly with a larger device limit (e.g. a device that negotiated 1 GiB)', () => {
    const largeLimit = 1024 * MIB;
    expect(checkLdpcScratchBudget(1162, largeLimit)).toBeNull(); // fits comfortably now
    expect(checkLdpcScratchBudget(9999, largeLimit)).not.toBeNull(); // still has SOME ceiling
  });
});
