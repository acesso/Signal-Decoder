// Pure size-check logic for searchBoth.wgsl, factored out exactly like
// fftWorkgroupBudget.ts/ldpcScratchBudget.ts — unit-testable without a real
// GPUDevice (webgpuSearchBoth.ts imports the .wgsl file via Vite's ?raw
// suffix, which Jest can't resolve).
//
// searchBoth.wgsl's workgroup memory has two independent pieces, and BOTH
// are FIXED-SIZE, compile-time array sizes in the kernel (buf_a/buf_b are
// always MAX_N elements; score_buf is always MAX_HZ*MAX_OFF elements) — NOT
// sized down for a candidate's smaller actual window length/grid shape:
//  - FFT ping-pong scratch: two buf_a/buf_b arrays of vec2<f32>, MAX_N
//    elements each — shift200's forward FFT + bin-shift + inverse FFT all
//    happen in this scratch, one hz value at a time, reused across all
//    MAX_HZ hz values in the grid (not one copy per hz — sequential reuse).
//  - Results scratch: MAX_HZ * MAX_OFF f32 score slots (see module header of
//    searchBoth.wgsl for why this size is small enough that every
//    invocation computing every slot redundantly, then one thread scanning
//    it, is the chosen reduction shape).
//
// A real-GPU run (Dawn, native, this developer's own confirmed
// maxComputeWorkgroupStorageSize=65536 bytes) caught a genuine bug here: an
// earlier revision of this check took a candidate's RUNTIME n/hzCount/
// offCount and computed FFT-scratch bytes as `n * 16`, which silently
// UNDER-counted the kernel's actual (always-MAX_N-sized) usage — a
// candidate with n=2592 passed the check (2592*16 + 256 = 41728 bytes, well
// under 65536), while the kernel's REAL workgroup memory usage (fixed at
// MAX_N=4096 back then) was 65792 bytes, over the limit. WebGPU's
// CreateComputePipeline failed VALIDATION as a result — silently, via the
// device's error-scope/uncapturederror mechanism, not a thrown JS exception
// — invalidating every subsequent bind group/pass/dispatch, so every
// readback came back exactly zero. checkSearchBothWorkgroupBudget() now
// validates ONLY the fixed constants (which never vary at runtime), so it
// can never again silently under-count the kernel's true footprint; MAX_N/
// MAX_HZ/MAX_OFF were also shrunk (4032/6/8, 64704 bytes total) so this
// exact fixed footprint fits within 65536 bytes with headroom.
export const SEARCH_BOTH_MAX_N = 4032;
export const SEARCH_BOTH_MAX_HZ = 6; // headroom above this repo's current SECOND_HZ_N=4 (5 hz steps)
export const SEARCH_BOTH_MAX_OFF = 8; // headroom above this repo's current SECOND_OFF_N=5 (up to 6 off steps)

const FFT_BYTES_PER_ELEMENT = 8; // vec2<f32>
const FFT_PING_PONG_BUFFERS = 2;
const RESULT_SLOT_BYTES = 4; // one f32 score per slot; hz_idx/off_idx are derived from the slot index, not stored

/** The kernel's TOTAL workgroup-shared-memory footprint — constant across
 *  every dispatch, since buf_a/buf_b/score_buf are all fixed-size arrays
 *  (MAX_N/MAX_HZ/MAX_OFF), never sized down for a smaller candidate. */
export const SEARCH_BOTH_FIXED_WORKGROUP_BYTES =
  SEARCH_BOTH_MAX_N * FFT_BYTES_PER_ELEMENT * FFT_PING_PONG_BUFFERS +
  SEARCH_BOTH_MAX_HZ * SEARCH_BOTH_MAX_OFF * RESULT_SLOT_BYTES;

/** Returns an error message if EITHER (a) a specific candidate's n/hzCount/
 *  offCount exceeds the kernel's fixed array-size ceilings (MAX_N/MAX_HZ/
 *  MAX_OFF — a per-candidate fit check, since a too-large candidate simply
 *  cannot run regardless of the device), OR (b) the kernel's fixed,
 *  candidate-independent total workgroup-memory footprint exceeds this
 *  device's maxComputeWorkgroupStorageSize (a per-device fit check that
 *  does NOT depend on n/hzCount/offCount at all — see module header: this
 *  is deliberately NOT computed from the runtime n, only from the fixed
 *  MAX_N/MAX_HZ/MAX_OFF constants, so it can never again silently
 *  under-count the kernel's true, constant footprint). Returns null if both
 *  checks pass. */
export function checkSearchBothWorkgroupBudget(
  n: number,
  hzCount: number,
  offCount: number,
  maxComputeWorkgroupStorageSize: number,
): string | null {
  if (n > SEARCH_BOTH_MAX_N) {
    return (
      `runSearchBothGpu: N=${n} exceeds searchBoth.wgsl's fixed MAX_N=${SEARCH_BOTH_MAX_N} ` +
      `workgroup-array size — this kernel only supports N up to ${SEARCH_BOTH_MAX_N}.`
    );
  }
  if (hzCount > SEARCH_BOTH_MAX_HZ) {
    return (
      `runSearchBothGpu: hzCount=${hzCount} exceeds searchBoth.wgsl's fixed MAX_HZ=${SEARCH_BOTH_MAX_HZ}.`
    );
  }
  if (offCount > SEARCH_BOTH_MAX_OFF) {
    return (
      `runSearchBothGpu: offCount=${offCount} exceeds searchBoth.wgsl's fixed MAX_OFF=${SEARCH_BOTH_MAX_OFF}.`
    );
  }

  if (SEARCH_BOTH_FIXED_WORKGROUP_BYTES <= maxComputeWorkgroupStorageSize) return null;

  return (
    `runSearchBothGpu: searchBoth.wgsl's FIXED workgroup-shared-memory footprint ` +
    `(${SEARCH_BOTH_FIXED_WORKGROUP_BYTES} bytes — MAX_N=${SEARCH_BOTH_MAX_N} FFT scratch + ` +
    `MAX_HZ=${SEARCH_BOTH_MAX_HZ}*MAX_OFF=${SEARCH_BOTH_MAX_OFF} results scratch, CONSTANT regardless of ` +
    `this candidate's actual n=${n}/hzCount=${hzCount}/offCount=${offCount}) exceeds this device's ` +
    `maxComputeWorkgroupStorageSize (${maxComputeWorkgroupStorageSize} bytes). This kernel cannot run at all ` +
    `on this device — MAX_N/MAX_HZ/MAX_OFF in searchBoth.wgsl (and here) would need to shrink further.`
  );
}
