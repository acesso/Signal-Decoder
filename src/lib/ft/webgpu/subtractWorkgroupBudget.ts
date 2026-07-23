// Pure size-check logic for subtractFused.wgsl — factored out exactly like
// fftWorkgroupBudget.ts/searchBothBudget.ts/symbolExtractBudget.ts, so it's
// unit-testable without a real GPUDevice (webgpuSubtract.ts imports the
// .wgsl file via Vite's ?raw suffix, which Jest can't resolve).
//
// subtractFused.wgsl's workgroup-shared-memory usage is SMALL and FIXED:
// two arrays of 79 f32 each (amps, phases) = 632 bytes total, independent of
// MAX_WINDOW_LEN (that buffer lives in STORAGE address space, not
// workgroup-shared — see the kernel's own header comment). Following
// searchBothBudget.ts's own hard-won lesson (a previous kernel this session
// validated a too-small, runtime-derived footprint instead of the kernel's
// actual FIXED constants), this checks the kernel's REAL fixed constants,
// never a runtime-derived value.
export const SUBTRACT_N_SYM = 79;
const BYTES_PER_F32 = 4;
export const SUBTRACT_FIXED_WORKGROUP_BYTES = SUBTRACT_N_SYM * BYTES_PER_F32 * 2; // amps + phases

// MUST equal subtractFused.wgsl's own MAX_WINDOW_LEN constant. 79 symbols *
// 1920 samples/block = 151680, plus one block (1920) of left margin for the
// initial-ramp read (see subtractGpu.ts's window-slicing) = 153600 minimum;
// this constant matches the kernel's own value (155008), which adds a
// little extra headroom above that bare minimum — same discipline as
// symbolExtractBudget.ts's own margin-above-bare-minimum choice.
export const SUBTRACT_MAX_WINDOW_LEN = 155008;
const WINDOW_BYTES_PER_CANDIDATE = SUBTRACT_MAX_WINDOW_LEN * 4; // f32, moved + out_residual buffers each this size

/** Returns an error message if subtractFused.wgsl's fixed workgroup-shared-
 *  memory footprint exceeds `maxComputeWorkgroupStorageSize` on this device
 *  (should essentially never happen — 632 bytes is far below even the
 *  WebGPU spec's guaranteed minimum of 16384 — but checked for the same
 *  "never silently assume" discipline the other budget modules follow), or
 *  null if fine. */
export function checkSubtractWorkgroupBudget(maxComputeWorkgroupStorageSize: number): string | null {
  if (SUBTRACT_FIXED_WORKGROUP_BYTES <= maxComputeWorkgroupStorageSize) return null;
  return (
    `runSubtractFusedGpu: subtractFused.wgsl's fixed workgroup-shared-memory footprint ` +
    `(${SUBTRACT_FIXED_WORKGROUP_BYTES} bytes) exceeds this device's maxComputeWorkgroupStorageSize ` +
    `(${maxComputeWorkgroupStorageSize} bytes). This should not happen on any real WebGPU device.`
  );
}

/** Returns an error message if `maxBatch` candidates' moved/out_residual
 *  STORAGE buffers would exceed `maxStorageBufferBindingSize`, or null if
 *  within budget — same class of check symbolExtractBudget.ts does for its
 *  own flattened samples/out_c79 buffers. */
export function checkSubtractBufferBudget(maxBatch: number, maxStorageBufferBindingSize: number): string | null {
  const bytes = maxBatch * WINDOW_BYTES_PER_CANDIDATE;
  if (bytes <= maxStorageBufferBindingSize) return null;
  const maxBatchForThisDevice = Math.floor(maxStorageBufferBindingSize / WINDOW_BYTES_PER_CANDIDATE);
  return (
    `runSubtractFusedGpu: ${maxBatch} candidates needs a ${(bytes / 1024 / 1024).toFixed(1)} MiB buffer, ` +
    `exceeding this device's maxStorageBufferBindingSize (${(maxStorageBufferBindingSize / 1024 / 1024).toFixed(1)} MiB). ` +
    `Max candidates in one dispatch on this device: ${maxBatchForThisDevice}.`
  );
}
