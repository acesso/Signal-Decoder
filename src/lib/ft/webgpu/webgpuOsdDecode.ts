/// <reference types="@webgpu/types" />
// WebGPU orchestration for the OSD (ordered statistics decoding) kernel (see
// osdDecode.wgsl for the kernel, osdDecode.ts for the correctness-verified
// plain-TS math it mirrors — cross-checked against synthetic bit-flip
// recovery vectors, see __tests__/osdDecode.test.ts).
//
// NOT wired into gpuDecodePipeline.ts yet — standalone module only, matching
// how webgpuSearchBoth.ts/webgpuLdpcDecode.ts were each built and verified
// standalone before their own (separate, later) integration.
import osdDecodeWgsl from './osdDecode.wgsl?raw';
import { flattenGenSys } from './genSys';
import { OSD_N, OSD_K } from './osdDecode';
import { getDevice } from './webgpuDevice';
import { checkOsdWorkgroupBudget, checkOsdScratchBudget, OSD_B_STRIDE } from './osdWorkgroupBudget';
export { checkOsdWorkgroupBudget, checkOsdScratchBudget } from './osdWorkgroupBudget';

export interface OsdGpuResult {
  ok: boolean[]; // one per candidate
  plain: Uint8Array[]; // one 91-bit array per candidate (only meaningful where ok[c] is true)
  depthUsed: Int32Array; // one per candidate; -1 if ok[c] is false
  timings: {
    uploadMs: number;
    dispatchMs: number;
    readbackMs: number;
    totalMs: number;
  };
}

const PARAMS_BYTES = 16; // 4x u32 (n_candidates, depth, pad, pad)

interface OsdPipelineState {
  device: GPUDevice;
  pipeline: GPUComputePipeline;
  genSysBuf: GPUBuffer;
  maxCandidates: number;
  paramsBuf: GPUBuffer;
  llrBuf: GPUBuffer;
  plainBuf: GPUBuffer;
  okBuf: GPUBuffer;
  depthBuf: GPUBuffer;
  bScratchBuf: GPUBuffer;
  plainReadback: GPUBuffer;
  okReadback: GPUBuffer;
  depthReadback: GPUBuffer;
}

let cachedPipeline: OsdPipelineState | null = null;

async function getPipelineState(maxCandidates: number): Promise<OsdPipelineState> {
  const device = await getDevice();
  if (cachedPipeline && cachedPipeline.maxCandidates >= maxCandidates) return cachedPipeline;
  if (cachedPipeline) resetOsdGpuState();

  const workgroupBudgetError = checkOsdWorkgroupBudget(device.limits.maxComputeWorkgroupStorageSize);
  if (workgroupBudgetError) throw new Error(workgroupBudgetError);
  const scratchBudgetError = checkOsdScratchBudget(maxCandidates, device.limits.maxStorageBufferBindingSize);
  if (scratchBudgetError) throw new Error(scratchBudgetError);

  // Real-browser divergence found live: this kernel passed on the headless
  // Dawn/Vulkan sandbox build used during development but silently produced
  // ok=false for every candidate on the developer's actual Firefox/GPU —
  // classic symptom of a validation error caught only via error-scope
  // capture (createShaderModule/createComputePipeline validation errors
  // surface through device.onuncapturederror or an explicit error scope,
  // NOT a thrown JS exception — same class of silent failure the LDPC
  // scratch-buffer ceiling and searchBoth's workgroup-budget bug both hit
  // earlier this session).
  device.pushErrorScope('validation');
  const module = device.createShaderModule({ code: osdDecodeWgsl });
  // getCompilationInfo() gives structured, line/column-precise diagnostics —
  // the JS-visible error from popErrorScope()/onuncapturederror is
  // deliberately generic (WebGPU's spec withholds detailed shader-compiler
  // internals from that path), so this is the only way to see WHERE in the
  // WGSL a real validation error actually is.
  const compilationInfo = await module.getCompilationInfo();
  const compileErrors = compilationInfo.messages.filter(m => m.type === 'error');
  if (compileErrors.length > 0) {
    const detail = compileErrors.map(m => `line ${m.lineNum}:${m.linePos} — ${m.message}`).join('\n');
    throw new Error(`runOsdDecodeGpu: WGSL compile error(s):\n${detail}`);
  }
  const pipeline = device.createComputePipeline({
    layout: 'auto',
    compute: { module, entryPoint: 'main' },
  });
  const shaderError = await device.popErrorScope();
  if (shaderError) {
    throw new Error(`runOsdDecodeGpu: shader/pipeline validation error: ${shaderError.message}`);
  }

  const genSysFlat = flattenGenSys();
  const genSysBuf = device.createBuffer({
    size: genSysFlat.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(genSysBuf, 0, genSysFlat.buffer, genSysFlat.byteOffset, genSysFlat.byteLength);

  const paramsBuf = device.createBuffer({
    size: PARAMS_BYTES,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const llrBuf = device.createBuffer({
    size: maxCandidates * OSD_N * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  const plainBuf = device.createBuffer({
    size: maxCandidates * OSD_K * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });
  const okBuf = device.createBuffer({
    size: maxCandidates * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });
  const depthBuf = device.createBuffer({
    size: maxCandidates * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });
  const bScratchBuf = device.createBuffer({
    size: maxCandidates * OSD_B_STRIDE * 4,
    usage: GPUBufferUsage.STORAGE,
  });
  const plainReadback = device.createBuffer({
    size: maxCandidates * OSD_K * 4,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  const okReadback = device.createBuffer({
    size: maxCandidates * 4,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  const depthReadback = device.createBuffer({
    size: maxCandidates * 4,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });

  cachedPipeline = {
    device, pipeline, genSysBuf, maxCandidates, paramsBuf,
    llrBuf, plainBuf, okBuf, depthBuf, bScratchBuf,
    plainReadback, okReadback, depthReadback,
  };
  return cachedPipeline;
}

/** Runs OSD for every candidate in `llrPerCandidate` (each a 174-element
 *  Float32Array of LLR values, positive favors bit=0 — same convention as
 *  runLdpcDecodeGpu), one GPU workgroup per candidate, dispatched together.
 *  `depth` matches osd_decode()'s own depth parameter (this app's live
 *  default is 2 — see decoder.worker.ts's osdDepth). */
export async function runOsdDecodeGpu(
  llrPerCandidate: Float32Array[],
  depth: number,
): Promise<OsdGpuResult> {
  const t0 = performance.now();
  const nCandidates = llrPerCandidate.length;
  const state = await getPipelineState(nCandidates);
  const {
    device, pipeline, genSysBuf, paramsBuf, llrBuf, plainBuf, okBuf, depthBuf, bScratchBuf,
    plainReadback, okReadback, depthReadback,
  } = state;

  const llrFlat = new Float32Array(nCandidates * OSD_N);
  for (let c = 0; c < nCandidates; c++) {
    if (llrPerCandidate[c].length !== OSD_N) {
      throw new Error(`runOsdDecodeGpu: candidate ${c} has ${llrPerCandidate[c].length} LLR values, expected ${OSD_N}`);
    }
    llrFlat.set(llrPerCandidate[c], c * OSD_N);
  }
  device.queue.writeBuffer(llrBuf, 0, llrFlat.buffer, llrFlat.byteOffset, llrFlat.byteLength);

  const paramsData = new Uint32Array(PARAMS_BYTES / 4);
  paramsData[0] = nCandidates;
  paramsData[1] = depth;
  device.queue.writeBuffer(paramsBuf, 0, paramsData.buffer, paramsData.byteOffset, paramsData.byteLength);
  const tUpload = performance.now();

  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: paramsBuf } },
      { binding: 1, resource: { buffer: genSysBuf } },
      { binding: 2, resource: { buffer: llrBuf } },
      { binding: 3, resource: { buffer: plainBuf } },
      { binding: 4, resource: { buffer: okBuf } },
      { binding: 5, resource: { buffer: depthBuf } },
      { binding: 6, resource: { buffer: bScratchBuf } },
    ],
  });

  device.pushErrorScope('validation');
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.dispatchWorkgroups(nCandidates); // one workgroup per candidate
  pass.end();

  const plainBytes = nCandidates * OSD_K * 4;
  const okBytes = nCandidates * 4;
  const depthBytes = nCandidates * 4;
  encoder.copyBufferToBuffer(plainBuf, 0, plainReadback, 0, plainBytes);
  encoder.copyBufferToBuffer(okBuf, 0, okReadback, 0, okBytes);
  encoder.copyBufferToBuffer(depthBuf, 0, depthReadback, 0, depthBytes);

  device.queue.submit([encoder.finish()]);
  await device.queue.onSubmittedWorkDone();
  const dispatchError = await device.popErrorScope();
  if (dispatchError) {
    throw new Error(`runOsdDecodeGpu: dispatch validation error: ${dispatchError.message}`);
  }
  const tDispatch = performance.now();

  await Promise.all([
    plainReadback.mapAsync(GPUMapMode.READ, 0, plainBytes),
    okReadback.mapAsync(GPUMapMode.READ, 0, okBytes),
    depthReadback.mapAsync(GPUMapMode.READ, 0, depthBytes),
  ]);
  const plainFlat = new Uint32Array(plainReadback.getMappedRange(0, plainBytes).slice(0));
  const okFlat = new Uint32Array(okReadback.getMappedRange(0, okBytes).slice(0));
  const depthFlat = new Int32Array(depthReadback.getMappedRange(0, depthBytes).slice(0));
  plainReadback.unmap();
  okReadback.unmap();
  depthReadback.unmap();
  const tReadback = performance.now();

  const plain: Uint8Array[] = [];
  const ok: boolean[] = [];
  for (let c = 0; c < nCandidates; c++) {
    const bits = new Uint8Array(OSD_K);
    for (let i = 0; i < OSD_K; i++) bits[i] = plainFlat[c * OSD_K + i];
    plain.push(bits);
    ok.push(okFlat[c] === 1);
  }

  return {
    ok,
    plain,
    depthUsed: depthFlat,
    timings: {
      uploadMs: tUpload - t0,
      dispatchMs: tDispatch - tUpload,
      readbackMs: tReadback - tDispatch,
      totalMs: tReadback - t0,
    },
  };
}

export function resetOsdGpuState(): void {
  if (cachedPipeline) {
    cachedPipeline.genSysBuf.destroy();
    cachedPipeline.paramsBuf.destroy();
    cachedPipeline.llrBuf.destroy();
    cachedPipeline.plainBuf.destroy();
    cachedPipeline.okBuf.destroy();
    cachedPipeline.depthBuf.destroy();
    cachedPipeline.bScratchBuf.destroy();
    cachedPipeline.plainReadback.destroy();
    cachedPipeline.okReadback.destroy();
    cachedPipeline.depthReadback.destroy();
    cachedPipeline = null;
  }
}
