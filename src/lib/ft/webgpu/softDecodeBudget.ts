// Pure size-check logic for softDecodeFused.wgsl — factored out exactly like
// symbolExtractBudget.ts/fftWorkgroupBudget.ts/ldpcScratchBudget.ts, so it's
// unit-testable without a real GPUDevice.
//
// softDecodeFused.wgsl's workgroup-shared-memory footprint is FIXED and tiny
// (7 arrays of <=632 f32/vec2<f32> elements — see the kernel's own var<workgroup>
// declarations: raw mm[79], n79_re/n79_im[632] each, maxes_re/maxes_im[79]
// each), always the same regardless of batch size (batch size only affects
// how many WORKGROUPS are dispatched, one per candidate, not any single
// workgroup's own shared-memory usage) — so unlike searchBoth.wgsl/
// fftGeneralFused.wgsl there is no per-candidate "does N fit" question here,
// only whether this fixed total fits the device at all (true on every real
// device WebGPU targets; the spec-guaranteed-minimum maxComputeWorkgroupStorageSize
// is 16384 bytes, comfortably above this kernel's footprint).
const F32_BYTES = 4;
export const SOFT_DECODE_FIXED_WORKGROUP_BYTES =
  (79 + 79 * 8 + 79 * 8 + 79 + 79) * F32_BYTES; // mm + n79_re + n79_im + maxes_re + maxes_im

/** Returns an error message if softDecodeFused.wgsl's fixed workgroup
 *  footprint exceeds this device's maxComputeWorkgroupStorageSize, or null
 *  if it fits (true for every real device in practice — see module header). */
export function checkSoftDecodeWorkgroupBudget(maxComputeWorkgroupStorageSize: number): string | null {
  if (SOFT_DECODE_FIXED_WORKGROUP_BYTES <= maxComputeWorkgroupStorageSize) return null;
  return (
    `runSoftDecodeGpu: softDecodeFused.wgsl's fixed workgroup-shared-memory footprint ` +
    `(${SOFT_DECODE_FIXED_WORKGROUP_BYTES} bytes) exceeds this device's maxComputeWorkgroupStorageSize ` +
    `(${maxComputeWorkgroupStorageSize} bytes). This kernel cannot run at all on this device.`
  );
}
