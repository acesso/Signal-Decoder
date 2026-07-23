/// <reference types="@webgpu/types" />
// WebGPU orchestration for the parallel LDPC belief-propagation decode
// feasibility prototype (see ldpcDecode.wgsl for the kernel, ldpcDecode.ts /
// ldpcDecodeF32.ts for the correctness- and precision-verified plain-TS math
// it mirrors — cross-checked against ft8mon's own real decodes, see
// __tests__/ldpcDecodeRealData.test.ts).
//
// Unlike the coarse-search prototype (webgpuCoarseSearch.ts), this targets
// the REAL opportunity identified by profiling: per-candidate fine-decode/
// LDPC is ~86% of total ft8mon decode wall-clock time (coarse search is only
// ~14%). Task parallelism: one GPU invocation per sync candidate, all
// dispatched together — each candidate's 174-bit LLR decode is fully
// independent (see ft8.cc's per-candidate decode() call site), so this maps
// directly onto "N independent decoder instances" the way GPU compute is
// actually good at, unlike the coarse kernel where the win was marginal at
// single-window scale due to fixed dispatch/readback overhead.
//
// NOT wired into the live decode path — standalone feasibility benchmark
// target only, until measured numbers justify integration.

import ldpcDecodeWgsl from './ldpcDecode.wgsl?raw';
import { flattenNm, flattenMn, LDPC_N } from './ldpcMatrix';
import { getDevice } from './webgpuDevice';
import { checkLdpcScratchBudget, CANDIDATE_SCRATCH_STRIDE } from './ldpcScratchBudget';
export { checkLdpcScratchBudget } from './ldpcScratchBudget';

export interface LdpcGpuResult {
  plain: Uint8Array[]; // one 174-bit array per candidate
  ok: Uint32Array; // one syndrome score (0-83) per candidate
  timings: {
    uploadMs: number;
    dispatchMs: number;
    readbackMs: number;
    totalMs: number;
  };
}

const PARAMS_BYTES = 16; // 4x u32 (n_candidates, iters, pad, pad)

interface LdpcPipelineState {
  device: GPUDevice;
  pipeline: GPUComputePipeline;
  nmBuf: GPUBuffer;
  mnBuf: GPUBuffer;
  maxCandidates: number;
  paramsBuf: GPUBuffer;
  llrBuf: GPUBuffer;
  plainBuf: GPUBuffer;
  okBuf: GPUBuffer;
  scratchBuf: GPUBuffer;
  plainReadback: GPUBuffer;
  okReadback: GPUBuffer;
}

let cachedPipeline: LdpcPipelineState | null = null;

async function getPipelineState(maxCandidates: number): Promise<LdpcPipelineState> {
  const device = await getDevice();
  if (cachedPipeline && cachedPipeline.maxCandidates >= maxCandidates) return cachedPipeline;
  if (cachedPipeline) resetLdpcGpuState();

  // The per-candidate m[83][174]+e[83][174] scratch buffer (see ldpcDecode.wgsl's
  // header comment) is by far the largest allocation here and the one that
  // actually hits a real ceiling: WebGPU's spec-guaranteed default
  // maxStorageBufferBindingSize is 128 MiB, and createBindGroup() rejects
  // (via a validation error surfaced through device.onuncapturederror, NOT a
  // thrown JS exception) any attempt to bind a range past that limit. Caught
  // in practice at candidate 1162 (128.03 MiB) vs. 1161 (127.92 MiB) working
  // fine — every candidate's result silently came back zeroed (ok=0) rather
  // than a visible error, because nothing was listening for the validation
  // error. Check proactively here instead of discovering it as silent
  // corruption; this is a real ceiling on this prototype's current design
  // (one scratch slot per candidate in a single buffer), not a bug in the
  // decode math itself.
  const budgetError = checkLdpcScratchBudget(maxCandidates, device.limits.maxStorageBufferBindingSize);
  if (budgetError) throw new Error(budgetError);

  const module = device.createShaderModule({ code: ldpcDecodeWgsl });
  const pipeline = device.createComputePipeline({
    layout: 'auto',
    compute: { module, entryPoint: 'main' },
  });

  const nmFlat = flattenNm();
  const mnFlat = flattenMn();
  const nmBuf = device.createBuffer({
    size: nmFlat.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  const mnBuf = device.createBuffer({
    size: mnFlat.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(nmBuf, 0, nmFlat.buffer, nmFlat.byteOffset, nmFlat.byteLength);
  device.queue.writeBuffer(mnBuf, 0, mnFlat.buffer, mnFlat.byteOffset, mnFlat.byteLength);

  const paramsBuf = device.createBuffer({
    size: PARAMS_BYTES,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const llrBuf = device.createBuffer({
    size: maxCandidates * LDPC_N * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  const plainBuf = device.createBuffer({
    size: maxCandidates * LDPC_N * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });
  const okBuf = device.createBuffer({
    size: maxCandidates * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });
  const scratchBuf = device.createBuffer({
    size: maxCandidates * CANDIDATE_SCRATCH_STRIDE * 4,
    usage: GPUBufferUsage.STORAGE,
  });
  const plainReadback = device.createBuffer({
    size: maxCandidates * LDPC_N * 4,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  const okReadback = device.createBuffer({
    size: maxCandidates * 4,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });

  cachedPipeline = {
    device, pipeline, nmBuf, mnBuf, maxCandidates, paramsBuf,
    llrBuf, plainBuf, okBuf, scratchBuf, plainReadback, okReadback,
  };
  return cachedPipeline;
}

/** Runs `iters`-bounded LDPC belief-propagation decode for every candidate
 *  in `llrPerCandidate` (each a 174-element Float32Array of LLR values, same
 *  convention as ldpc_decode: positive favors bit=0), one GPU invocation per
 *  candidate, dispatched together. */
export async function runLdpcDecodeGpu(
  llrPerCandidate: Float32Array[],
  iters: number,
): Promise<LdpcGpuResult> {
  const t0 = performance.now();
  const nCandidates = llrPerCandidate.length;
  const state = await getPipelineState(nCandidates);
  const { device, pipeline, nmBuf, mnBuf, paramsBuf, llrBuf, plainBuf, okBuf, scratchBuf, plainReadback, okReadback } = state;

  const llrFlat = new Float32Array(nCandidates * LDPC_N);
  for (let c = 0; c < nCandidates; c++) {
    if (llrPerCandidate[c].length !== LDPC_N) {
      throw new Error(`runLdpcDecodeGpu: candidate ${c} has ${llrPerCandidate[c].length} LLR values, expected ${LDPC_N}`);
    }
    llrFlat.set(llrPerCandidate[c], c * LDPC_N);
  }
  device.queue.writeBuffer(llrBuf, 0, llrFlat.buffer, llrFlat.byteOffset, llrFlat.byteLength);

  const paramsData = new Uint32Array(PARAMS_BYTES / 4);
  paramsData[0] = nCandidates;
  paramsData[1] = iters;
  device.queue.writeBuffer(paramsBuf, 0, paramsData.buffer, paramsData.byteOffset, paramsData.byteLength);
  const tUpload = performance.now();

  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: paramsBuf } },
      { binding: 1, resource: { buffer: nmBuf } },
      { binding: 2, resource: { buffer: mnBuf } },
      { binding: 3, resource: { buffer: llrBuf } },
      { binding: 4, resource: { buffer: plainBuf } },
      { binding: 5, resource: { buffer: okBuf } },
      { binding: 6, resource: { buffer: scratchBuf } },
    ],
  });

  const workgroups = Math.ceil(nCandidates / 64);
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.dispatchWorkgroups(workgroups);
  pass.end();

  const plainBytes = nCandidates * LDPC_N * 4;
  const okBytes = nCandidates * 4;
  encoder.copyBufferToBuffer(plainBuf, 0, plainReadback, 0, plainBytes);
  encoder.copyBufferToBuffer(okBuf, 0, okReadback, 0, okBytes);

  device.queue.submit([encoder.finish()]);
  await device.queue.onSubmittedWorkDone();
  const tDispatch = performance.now();

  await Promise.all([
    plainReadback.mapAsync(GPUMapMode.READ, 0, plainBytes),
    okReadback.mapAsync(GPUMapMode.READ, 0, okBytes),
  ]);
  const plainFlat = new Uint32Array(plainReadback.getMappedRange(0, plainBytes).slice(0));
  const ok = new Uint32Array(okReadback.getMappedRange(0, okBytes).slice(0));
  plainReadback.unmap();
  okReadback.unmap();
  const tReadback = performance.now();

  const plain: Uint8Array[] = [];
  for (let c = 0; c < nCandidates; c++) {
    const bits = new Uint8Array(LDPC_N);
    for (let i = 0; i < LDPC_N; i++) bits[i] = plainFlat[c * LDPC_N + i];
    plain.push(bits);
  }

  return {
    plain,
    ok,
    timings: {
      uploadMs: tUpload - t0,
      dispatchMs: tDispatch - tUpload,
      readbackMs: tReadback - tDispatch,
      totalMs: tReadback - t0,
    },
  };
}

export function resetLdpcGpuState(): void {
  if (cachedPipeline) {
    cachedPipeline.nmBuf.destroy();
    cachedPipeline.mnBuf.destroy();
    cachedPipeline.paramsBuf.destroy();
    cachedPipeline.llrBuf.destroy();
    cachedPipeline.plainBuf.destroy();
    cachedPipeline.okBuf.destroy();
    cachedPipeline.scratchBuf.destroy();
    cachedPipeline.plainReadback.destroy();
    cachedPipeline.okReadback.destroy();
    cachedPipeline = null;
  }
}
