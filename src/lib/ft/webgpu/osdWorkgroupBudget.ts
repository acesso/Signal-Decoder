// Pure size-check logic for osdDecode.wgsl, factored out exactly like
// ldpcScratchBudget.ts/searchBothBudget.ts/softDecodeBudget.ts — unit-testable
// without a real GPUDevice (webgpuOsdDecode.ts imports the .wgsl file via
// Vite's ?raw suffix, which Jest can't resolve).
//
// osd_decode()'s dominant memory cost is the 174x182 `b` matrix gauss_jordan()
// operates on (osd.cc's `int b[174][91*2]`) — at 174*182*4 = 126672 bytes,
// this is FAR too large for WGSL `workgroup` (shared) memory on any real
// device (the spec-guaranteed minimum maxComputeWorkgroupStorageSize is only
// 16384 bytes; even this developer's own confirmed 65536-byte device is
// nowhere close). Exactly like ldpcDecode.wgsl's m[83][174]+e[83][174]
// scratch (see ldpcScratchBudget.ts's own header comment for the identical
// reasoning), `b` lives in a per-candidate `storage` scratch buffer instead
// of `workgroup` shared memory — sized (n_candidates * OSD_B_STRIDE * 4)
// bytes, one slice per candidate, and subject to the SAME
// maxStorageBufferBindingSize ceiling ldpcScratchBudget.ts already
// documents hitting in practice (128 MiB default, silently producing
// zeroed results past it if unchecked).
//
// What DOES fit in workgroup memory (and is declared `var<workgroup>` in
// the kernel) is: gen1_inv (91x91 i32, 33124 bytes — the Gauss-Jordan
// output submatrix, needed by every invocation for the matmul/depth-flip
// loop) plus several 174- and 91-element small arrays (which/strength/y1/
// xplain/best_plain), all FIXED-size regardless of n_candidates (one
// workgroup per candidate, so per-workgroup memory doesn't grow with batch
// size — only the NUMBER of workgroups dispatched does, same shape as
// softDecodeFused.wgsl's fixed-and-tiny footprint, see softDecodeBudget.ts).
import { OSD_N, OSD_K } from './osdDecode';

export const OSD_B_ROWS = OSD_N; // 174
export const OSD_B_COLS = 2 * OSD_K; // 182 (left 91 = generator matrix, right 91 = accumulating inverse)
export const OSD_B_STRIDE = OSD_B_ROWS * OSD_B_COLS; // per-candidate scratch element count for `b`

const I32_BYTES = 4;

/** The kernel's FIXED per-workgroup (`var<workgroup>`) memory footprint —
 *  constant regardless of n_candidates or depth: gen1_inv (91x91 i32) +
 *  which/strength/y1/xplain/best_plain small arrays. Does NOT include `b`,
 *  which lives in the per-candidate storage scratch buffer (see
 *  checkOsdScratchBudget below) rather than workgroup memory. */
export const OSD_FIXED_WORKGROUP_BYTES =
  OSD_K * OSD_K * I32_BYTES + // gen1_inv
  OSD_N * I32_BYTES + // which
  OSD_N * I32_BYTES + // strength_bits (bit-pattern-as-u32, see kernel comment on why not f32 directly)
  OSD_K * I32_BYTES + // y1
  OSD_K * I32_BYTES + // xplain
  OSD_K * I32_BYTES; // best_plain

/** Returns an error message if osdDecode.wgsl's FIXED workgroup-shared-memory
 *  footprint (gen1_inv + small arrays — NOT `b`, which is storage scratch,
 *  see checkOsdScratchBudget) exceeds this device's
 *  maxComputeWorkgroupStorageSize, or null if it fits. Mirrors
 *  checkSearchBothWorkgroupBudget's/checkSoftDecodeWorkgroupBudget's own
 *  documented mistake to avoid: validate the kernel's ACTUAL FIXED
 *  footprint, never a runtime-scaled approximation. */
export function checkOsdWorkgroupBudget(maxComputeWorkgroupStorageSize: number): string | null {
  if (OSD_FIXED_WORKGROUP_BYTES <= maxComputeWorkgroupStorageSize) return null;
  return (
    `runOsdDecodeGpu: osdDecode.wgsl's fixed workgroup-shared-memory footprint ` +
    `(${OSD_FIXED_WORKGROUP_BYTES} bytes — gen1_inv 91x91 i32 + which/strength/y1/xplain/best_plain) ` +
    `exceeds this device's maxComputeWorkgroupStorageSize (${maxComputeWorkgroupStorageSize} bytes). ` +
    `This kernel cannot run at all on this device.`
  );
}

/** Returns an error message if `maxCandidates` would need a per-candidate
 *  `b`-matrix scratch buffer past `maxStorageBufferBindingSize`, or null if
 *  within budget — same shape/reasoning as checkLdpcScratchBudget. */
export function checkOsdScratchBudget(maxCandidates: number, maxStorageBufferBindingSize: number): string | null {
  const scratchBytes = maxCandidates * OSD_B_STRIDE * I32_BYTES;
  if (scratchBytes <= maxStorageBufferBindingSize) return null;

  const maxCandidatesForThisDevice = Math.floor(maxStorageBufferBindingSize / (OSD_B_STRIDE * I32_BYTES));
  return (
    `runOsdDecodeGpu: ${maxCandidates} candidates needs a ${(scratchBytes / 1024 / 1024).toFixed(1)} MiB ` +
    `'b' scratch buffer, exceeding this device's maxStorageBufferBindingSize ` +
    `(${(maxStorageBufferBindingSize / 1024 / 1024).toFixed(1)} MiB). Max candidates in one dispatch on this ` +
    `device: ${maxCandidatesForThisDevice}. (This single-buffer-per-candidate scratch layout is a prototype ` +
    `simplification — a real integration would split into multiple dispatches past this ceiling.)`
  );
}
