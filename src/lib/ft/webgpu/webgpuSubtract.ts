/// <reference types="@webgpu/types" />
// WebGPU orchestration for subtractFused.wgsl — GPU port of subtract()'s
// per-candidate window work (amplitude/phase extraction + ramped synthesis
// and subtraction), one workgroup per candidate. See subtractFused.wgsl's
// own header for the extraction/synthesis math, and subtractGpu.ts for the
// CPU-side whole-buffer hilbert_shift() steps this composes with (this
// module only handles the WINDOWED, per-candidate part — it does not know
// about the whole-buffer analytic-signal transform at all).
//
// NOT wired into the live decode pipeline — standalone, currently-unused
// module, same status as webgpuSymbolExtract.ts before any integration
// decision.
import subtractWgsl from './subtractFused.wgsl?raw';
import { getDevice } from './webgpuDevice';
import {
  checkSubtractWorkgroupBudget,
  checkSubtractBufferBudget,
  SUBTRACT_MAX_WINDOW_LEN,
  SUBTRACT_N_SYM,
} from './subtractWorkgroupBudget';

const WG_SIZE = 128;
const MAX_WINDOW_LEN = SUBTRACT_MAX_WINDOW_LEN;
const BLOCK = 1920;
const LEFT_MARGIN = BLOCK;
const CANDIDATE_PARAMS_BYTES = 12; // 3x i32 (off0, bin0, ramp)

export interface SubtractFusedCandidateInput {
  /** The candidate's own hilbert_shift()-forward-shifted whole buffer
   *  ("moved" in subtract.ts/ft8.cc) — only the window
   *  [off0-BLOCK, off0+79*BLOCK) is actually read/uploaded (see
   *  buildFlatCandidate below), matching subtract()'s own read range
   *  (extraction needs [off0, off0+79*block); the initial ramp read
   *  starts exactly at off0, so no read before off0 actually occurs, but a
   *  block of left margin is kept for layout symmetry / future headroom). */
  moved: Float64Array | Float32Array;
  off0: number;
  bin0: number;
  re79: number[];
  ramp: number;
}

export interface SubtractFusedResult {
  /** The windowed residual: `moved`'s own [off0-BLOCK, off0+79*BLOCK) slice
   *  with the synthesized waveform subtracted — same window/margin layout
   *  as the input. Samples outside this window are UNCHANGED by
   *  subtraction (matching subtract()'s own behavior: only this range of
   *  `moved` is ever touched). */
  residualWindow: Float32Array;
  windowStart: number; // absolute sample index this residualWindow[0] corresponds to (off0 - BLOCK)
}

function buildFlatMovedWindow(input: SubtractFusedCandidateInput): Float32Array {
  const { moved, off0 } = input;
  const out = new Float32Array(MAX_WINDOW_LEN);
  const absStart = off0 - LEFT_MARGIN;
  for (let i = 0; i < MAX_WINDOW_LEN; i++) {
    const idx = absStart + i;
    out[i] = idx >= 0 && idx < moved.length ? Number(moved[idx]) : 0;
  }
  return out;
}

interface PipelineState {
  device: GPUDevice;
  pipeline: GPUComputePipeline;
  maxBatch: number;
  nBatchBuf: GPUBuffer;
  paramsBuf: GPUBuffer;
  re79Buf: GPUBuffer;
  movedBuf: GPUBuffer;
  residualBuf: GPUBuffer;
  readbackBuf: GPUBuffer;
}

let cachedPipeline: PipelineState | null = null;

async function getPipelineState(maxBatch: number): Promise<PipelineState> {
  const device = await getDevice();
  if (cachedPipeline && cachedPipeline.maxBatch >= maxBatch) return cachedPipeline;
  if (cachedPipeline) resetSubtractGpuState();

  const wgBudgetError = checkSubtractWorkgroupBudget(device.limits.maxComputeWorkgroupStorageSize);
  if (wgBudgetError) throw new Error(wgBudgetError);
  const bufBudgetError = checkSubtractBufferBudget(maxBatch, device.limits.maxStorageBufferBindingSize);
  if (bufBudgetError) throw new Error(bufBudgetError);

  const module = device.createShaderModule({ code: subtractWgsl });
  const pipeline = device.createComputePipeline({
    layout: 'auto',
    compute: { module, entryPoint: 'main' },
  });

  const nBatchBuf = device.createBuffer({
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const paramsBuf = device.createBuffer({
    size: maxBatch * CANDIDATE_PARAMS_BYTES,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  const re79Buf = device.createBuffer({
    size: maxBatch * SUBTRACT_N_SYM * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  const movedBuf = device.createBuffer({
    size: maxBatch * MAX_WINDOW_LEN * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  const residualBuf = device.createBuffer({
    size: maxBatch * MAX_WINDOW_LEN * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });
  const readbackBuf = device.createBuffer({
    size: maxBatch * MAX_WINDOW_LEN * 4,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });

  cachedPipeline = { device, pipeline, maxBatch, nBatchBuf, paramsBuf, re79Buf, movedBuf, residualBuf, readbackBuf };
  return cachedPipeline;
}

/** Runs subtractFused.wgsl (per-symbol amp/phase extraction + ramped
 *  synthesis+subtraction) for a BATCH of candidates in one dispatch (one
 *  workgroup per candidate). Returns each candidate's windowed residual. */
export async function runSubtractFusedGpu(inputs: SubtractFusedCandidateInput[]): Promise<SubtractFusedResult[]> {
  if (inputs.length === 0) return [];

  const needed = SUBTRACT_N_SYM * BLOCK + LEFT_MARGIN;
  if (needed > MAX_WINDOW_LEN) {
    throw new Error(`runSubtractFusedGpu: needs ${needed} samples per candidate, exceeding MAX_WINDOW_LEN=${MAX_WINDOW_LEN}.`);
  }
  for (const input of inputs) {
    if (input.re79.length !== SUBTRACT_N_SYM) {
      throw new Error(`runSubtractFusedGpu: re79 must have exactly ${SUBTRACT_N_SYM} entries, got ${input.re79.length}.`);
    }
  }

  const state = await getPipelineState(inputs.length);
  const { device, pipeline, nBatchBuf, paramsBuf, re79Buf, movedBuf, residualBuf, readbackBuf } = state;

  const batch = inputs.length;

  const nBatchData = new Uint32Array(4);
  nBatchData[0] = batch;
  device.queue.writeBuffer(nBatchBuf, 0, nBatchData.buffer, nBatchData.byteOffset, nBatchData.byteLength);

  const paramsData = new Int32Array(batch * 3);
  const re79Data = new Int32Array(batch * SUBTRACT_N_SYM);
  const movedData = new Float32Array(batch * MAX_WINDOW_LEN);
  inputs.forEach((input, i) => {
    paramsData[i * 3 + 0] = input.off0;
    paramsData[i * 3 + 1] = input.bin0;
    paramsData[i * 3 + 2] = input.ramp;
    re79Data.set(input.re79, i * SUBTRACT_N_SYM);
    movedData.set(buildFlatMovedWindow(input), i * MAX_WINDOW_LEN);
  });

  device.queue.writeBuffer(paramsBuf, 0, paramsData.buffer, paramsData.byteOffset, paramsData.byteLength);
  device.queue.writeBuffer(re79Buf, 0, re79Data.buffer, re79Data.byteOffset, re79Data.byteLength);
  device.queue.writeBuffer(movedBuf, 0, movedData.buffer, movedData.byteOffset, movedData.byteLength);

  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: nBatchBuf } },
      { binding: 1, resource: { buffer: paramsBuf } },
      { binding: 2, resource: { buffer: re79Buf } },
      { binding: 3, resource: { buffer: movedBuf } },
      { binding: 4, resource: { buffer: residualBuf } },
    ],
  });

  const encoder = device.createCommandEncoder();
  const pass = encoder.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.dispatchWorkgroups(batch);
  pass.end();

  const bytes = batch * MAX_WINDOW_LEN * 4;
  encoder.copyBufferToBuffer(residualBuf, 0, readbackBuf, 0, bytes);

  device.queue.submit([encoder.finish()]);
  await device.queue.onSubmittedWorkDone();

  await readbackBuf.mapAsync(GPUMapMode.READ, 0, bytes);
  const mapped = readbackBuf.getMappedRange(0, bytes);
  const result = new Float32Array(mapped.slice(0));
  readbackBuf.unmap();

  return inputs.map((input, i) => ({
    residualWindow: result.subarray(i * MAX_WINDOW_LEN, (i + 1) * MAX_WINDOW_LEN),
    windowStart: input.off0 - LEFT_MARGIN,
  }));
}

export function resetSubtractGpuState(): void {
  if (cachedPipeline) {
    cachedPipeline.nBatchBuf.destroy();
    cachedPipeline.paramsBuf.destroy();
    cachedPipeline.re79Buf.destroy();
    cachedPipeline.movedBuf.destroy();
    cachedPipeline.residualBuf.destroy();
    cachedPipeline.readbackBuf.destroy();
    cachedPipeline = null;
  }
}

export const SUBTRACT_WG_SIZE = WG_SIZE;
export const SUBTRACT_LEFT_MARGIN = LEFT_MARGIN;
export { checkSubtractWorkgroupBudget, checkSubtractBufferBudget } from './subtractWorkgroupBudget';
