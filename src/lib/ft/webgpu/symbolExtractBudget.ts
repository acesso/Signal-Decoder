// Pure size-check logic for symbolExtractFused.wgsl — factored out exactly
// like fftWorkgroupBudget.ts/ldpcScratchBudget.ts/searchBothBudget.ts, so
// it's unit-testable without a real GPUDevice (webgpuSymbolExtract.ts
// imports the .wgsl file via Vite's ?raw suffix, which Jest can't resolve).
//
// This kernel has NO workgroup-shared-memory usage at all (see
// symbolExtractFused.wgsl's own header comment — each (symbol, bin) DFT
// evaluation is fully independent, no shared arrays, no barriers), so the
// only real per-device ceiling is the flattened samples/out_c79 STORAGE
// buffer sizes against maxStorageBufferBindingSize — same class of check
// ldpcScratchBudget.ts does for webgpuLdpcDecode.ts's scratch buffer.
// MUST equal symbolExtractFused.wgsl's own MAX_SAMPLES_LEN constant -- see
// that file's header comment for why this needs real headroom (2864+)
// above extract()'s own off+79*32+32=off+2592 requirement, not just a
// small fixed margin past 2592: a real-GPU run against this repo's own
// fixture (bestOff=304) caught an earlier, too-small value (2752) silently
// truncating and zero-padding real signal data.
export const SYMBOL_EXTRACT_MAX_SAMPLES_LEN = 4096;

const SAMPLES_BYTES_PER_CANDIDATE = SYMBOL_EXTRACT_MAX_SAMPLES_LEN * 4; // f32
const C79_FLOATS_PER_CANDIDATE = 79 * 8 * 2; // vec2<f32> per (symbol, bin)
const C79_BYTES_PER_CANDIDATE = C79_FLOATS_PER_CANDIDATE * 4;

/** Returns an error message if `maxBatch` candidates' samples or out_c79
 *  buffers would exceed `maxStorageBufferBindingSize`, or null if within
 *  budget. */
export function checkSymbolExtractBufferBudget(maxBatch: number, maxStorageBufferBindingSize: number): string | null {
  const samplesBytes = maxBatch * SAMPLES_BYTES_PER_CANDIDATE;
  const c79Bytes = maxBatch * C79_BYTES_PER_CANDIDATE;
  const worst = Math.max(samplesBytes, c79Bytes);
  if (worst <= maxStorageBufferBindingSize) return null;

  const maxBatchForThisDevice = Math.floor(
    maxStorageBufferBindingSize / Math.max(SAMPLES_BYTES_PER_CANDIDATE, C79_BYTES_PER_CANDIDATE),
  );
  return (
    `runSymbolExtractGpu: ${maxBatch} candidates needs a ${(worst / 1024 / 1024).toFixed(1)} MiB buffer, ` +
    `exceeding this device's maxStorageBufferBindingSize (${(maxStorageBufferBindingSize / 1024 / 1024).toFixed(1)} MiB). ` +
    `Max candidates in one dispatch on this device: ${maxBatchForThisDevice}.`
  );
}
