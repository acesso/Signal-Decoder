// Pure size-check logic for fftGeneralFused.wgsl, factored out exactly like
// ldpcScratchBudget.ts was factored out of webgpuLdpcDecode.ts — so it's
// unit-testable without a real GPUDevice (webgpuFftGeneral.ts imports the
// .wgsl file via Vite's ?raw suffix, which Jest can't resolve).
//
// fftGeneralFused.wgsl does one whole N-point FFT per workgroup entirely in
// workgroup-shared memory (two ping-pong buffers of vec2<f32>, i.e. 8 bytes
// per element each). MAX_N in the kernel is a compile-time array size, not a
// per-call budget — this check instead guards the case that actually varies
// per device: whether N * 8 bytes * 2 buffers fits in THIS device's
// maxComputeWorkgroupStorageSize (spec-guaranteed minimum is 16384 bytes,
// but the kernel is sized for MAX_N=4096, i.e. 65536 bytes, which only some
// devices will actually offer — see fftGeneralFused.wgsl's header comment).
export const FFT_GENERAL_MAX_N = 4096;
const BYTES_PER_ELEMENT = 8; // vec2<f32>
const PING_PONG_BUFFERS = 2;

/** Returns an error message if an N-point fused FFT would need more
 *  workgroup-shared memory than `maxComputeWorkgroupStorageSize`, or if N
 *  exceeds the kernel's fixed MAX_N array size, or null if N is fine on this
 *  device. */
export function checkFftWorkgroupBudget(n: number, maxComputeWorkgroupStorageSize: number): string | null {
  if (n > FFT_GENERAL_MAX_N) {
    return (
      `runFftGeneralGpu: N=${n} exceeds fftGeneralFused.wgsl's fixed MAX_N=${FFT_GENERAL_MAX_N} ` +
      `workgroup-array size — this kernel only supports N up to ${FFT_GENERAL_MAX_N}.`
    );
  }

  const neededBytes = n * BYTES_PER_ELEMENT * PING_PONG_BUFFERS;
  if (neededBytes <= maxComputeWorkgroupStorageSize) return null;

  const maxNForThisDevice = Math.floor(maxComputeWorkgroupStorageSize / (BYTES_PER_ELEMENT * PING_PONG_BUFFERS));
  return (
    `runFftGeneralGpu: N=${n} needs ${neededBytes} bytes of workgroup-shared memory, ` +
    `exceeding this device's maxComputeWorkgroupStorageSize (${maxComputeWorkgroupStorageSize} bytes). ` +
    `Max N on this device: ${maxNForThisDevice}.`
  );
}
