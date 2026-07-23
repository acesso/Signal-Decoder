// Pure size-check logic, factored out of webgpuLdpcDecode.ts into its own
// dependency-free module so it's unit-testable without a real GPUDevice
// (webgpuLdpcDecode.ts imports ldpcDecode.wgsl via Vite's ?raw suffix,
// which Jest can't resolve — same reason fft1920.ts/costasCorrelation.ts
// are separate from webgpuCoarseSearch.ts).
//
// The per-candidate m[83][174]+e[83][174] scratch buffer (see
// ldpcDecode.wgsl's header comment) is by far the largest allocation in the
// LDPC GPU pipeline, and the one that hits a real ceiling: WebGPU's
// spec-guaranteed default maxStorageBufferBindingSize is 128 MiB, and
// createBindGroup() rejects (via a validation error surfaced through the
// device's error-scope/uncapturederror mechanism, NOT a thrown JS
// exception) any attempt to bind a range past that limit. Caught in
// practice at candidate 1162 (128.03 MiB) vs. 1161 (127.92 MiB) working
// fine — every candidate's result silently came back zeroed (ok=0) instead
// of a visible error, because nothing was listening for the validation
// error. This check turns that into a clear, immediate thrown error
// instead of silent corruption; it's a real ceiling on this prototype's
// current design (one scratch slot per candidate in a single buffer), not
// a bug in the decode math itself.
import { LDPC_CHECKS, LDPC_N } from './ldpcMatrix';

export const CANDIDATE_SCRATCH_STRIDE = 2 * LDPC_CHECKS * LDPC_N; // m block + e block, per candidate

/** Returns an error message if `maxCandidates` would need a scratch buffer
 *  past `maxStorageBufferBindingSize`, or null if it's within budget. */
export function checkLdpcScratchBudget(maxCandidates: number, maxStorageBufferBindingSize: number): string | null {
  const scratchBytes = maxCandidates * CANDIDATE_SCRATCH_STRIDE * 4;
  if (scratchBytes <= maxStorageBufferBindingSize) return null;

  const maxCandidatesForThisDevice = Math.floor(maxStorageBufferBindingSize / (CANDIDATE_SCRATCH_STRIDE * 4));
  return (
    `runLdpcDecodeGpu: ${maxCandidates} candidates needs a ${(scratchBytes / 1024 / 1024).toFixed(1)} MiB scratch buffer, ` +
    `exceeding this device's maxStorageBufferBindingSize (${(maxStorageBufferBindingSize / 1024 / 1024).toFixed(1)} MiB). ` +
    `Max candidates in one dispatch on this device: ${maxCandidatesForThisDevice}. ` +
    `(This single-buffer-per-candidate scratch layout is a prototype simplification — a real integration would split into multiple dispatches past this ceiling.)`
  );
}
