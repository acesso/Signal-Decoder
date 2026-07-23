/// <reference types="@webgpu/types" />
// WebGPU orchestration for the fused searchBoth grid-search kernel (see
// searchBoth.wgsl for the kernel, fineSync.ts for the plain-TS
// shift200()/oneStrength()/searchTimeFine()/searchBoth() math it mirrors).
//
// NOT wired into the live decode pipeline — standalone, currently-unused
// module, same status webgpuFftGeneral.ts/webgpuCoarseSearch.ts had before
// their own integration decisions. One dispatch runs the WHOLE (hz x off)
// grid search for a batch of candidates at once, returning only each
// candidate's single best (hz, off, strength) — matching what
// searchBothDefault(samples200, bestOff)[0] (sorted-and-take-best) returns
// per candidate on the CPU path (see gpuDecodePipeline.ts's own
// `const best = refinedCandidates[0];` after sorting).
//
// Caller-side constraint (mirrors fftGeneralFused.wgsl/webgpuFftGeneral.ts):
// every candidate's shift200 window length must be 2/3/5-smooth
// (factorRadixSchedule(n) must yield only radix-2/3/5 stages). searchBoth()
// window lengths are typically ~2592 samples (2/3/5-smooth), but a
// candidate whose off0 clamps very close to the sample buffer's start can
// occasionally produce a non-smooth length (confirmed via a JS sweep: about
// 1 in 200 possible bestOff values) — buildSearchBothCandidate() throws a
// clear error for that candidate rather than silently miscomputing, exactly
// like flattenStageSchedule() does for the plain FFT kernel. A real
// integration would need a CPU fallback for that rare case; out of scope
// for this prototype stage.
import searchBothWgsl from './searchBoth.wgsl?raw';
import { factorRadixSchedule } from './fftGeneral';
import { getDevice } from './webgpuDevice';
import { checkSearchBothWorkgroupBudget, SEARCH_BOTH_MAX_N, SEARCH_BOTH_MAX_HZ, SEARCH_BOTH_MAX_OFF } from './searchBothBudget';

const WG_SIZE = 256;
const MAX_STAGES = 14;
// MUST equal SEARCH_BOTH_MAX_N (searchBoth.wgsl's buf_a/buf_b array size) —
// a candidate's window IS its FFT length, so the samples buffer's
// per-candidate stride is exactly the kernel's fixed MAX_N, not an
// independently-chosen value. Kept as its own named constant (rather than
// importing SEARCH_BOTH_MAX_N and using it inline everywhere) purely for
// local readability; the two MUST stay numerically equal.
const MAX_SAMPLES_LEN = SEARCH_BOTH_MAX_N;
const CANDIDATE_PARAMS_BYTES = 32; // 8x u32 (n, num_stages, hz_count, off_count, off_inc, off0, window_off, samples_len)
const STAGE_DESC_BYTES = 16; // 4x u32 (radix, stride_in, stride_out, groups)
// out_result/readback are array<vec4<f32>> on the WGSL side (NOT vec3 — see
// searchBoth.wgsl's binding(5) doc comment for the exact WGSL memory-layout
// rule: array<vec3<f32>> strides its elements 16 bytes apart in storage
// memory, not 12, because vec3<f32> has AlignOf=16/SizeOf=12 and array
// stride is roundUp(AlignOf,SizeOf) — so the buffer must be sized/indexed
// as 4 floats per candidate here, matching the kernel's actual stride, with
// the 4th float an unused always-0 pad).
const RESULT_FLOATS_PER_CANDIDATE = 4;

export interface SearchBothCandidateInput {
  /** Raw samples200 buffer (the FULL candidate buffer searchTimeFine reads
   *  from — same array fineSync.ts's searchBoth() is given). */
  samples200: Float64Array | Float32Array | number[];
  /** hz0/hzN/hzWin/off0/offN/offWin — same parameters searchBoth() takes;
   *  see fineSync.ts's searchBothDefault() for this repo's actual defaults. */
  hz0: number;
  hzN: number;
  hzWin: number;
  off0: number;
  offN: number;
  offWin: number;
}

interface FlatCandidate {
  n: number;
  numStages: number;
  stageFlat: Uint32Array;
  hzCount: number;
  offCount: number;
  offInc: number;
  off0Clamped: number;
  windowOff: number; // offset into the original samples200 buffer where the shift200 window starts
  samplesLen: number; // length of the ORIGINAL samples200 buffer this candidate was built from
  hzDowns: Float32Array; // [hz_count] interleaved (hz_value, down) pairs, length MAX_HZ*2
  samples: Float32Array; // MAX_SAMPLES_LEN raw samples starting at windowOff (zero-padded past samplesLen)
}

/** Mirrors searchBoth()'s own grid-shape math (hzInc/offInc derivation,
 *  off0 clamping, window length) exactly — see fineSync.ts's searchBoth()
 *  and searchTimeFine(). Precomputes everything the kernel needs per
 *  candidate: the flattened stage schedule for THIS candidate's window
 *  length, the per-hz (value, down-bins) pairs, and a zero-padded window of
 *  raw samples starting at the clamped off0. */
function buildFlatCandidate(input: SearchBothCandidateInput): FlatCandidate {
  const { samples200, hz0, hzN, hzWin, off0, offN, offWin } = input;
  const samplesLen = samples200.length;

  const hzInc = (2 * hzWin) / hzN;
  let offInc = Math.round((2 * offWin) / offN);
  if (offInc < 1) offInc = 1;

  const off0In = off0 - offWin;
  const offNval = off0 + offWin;
  const off0Clamped = Math.max(0, off0In);
  const n = (offNval - off0Clamped) + 79 * 32 + 32;

  if (off0Clamped + n > samplesLen) {
    throw new Error(
      `buildFlatCandidate: window [${off0Clamped}, ${off0Clamped + n}) runs past samples200.length=${samplesLen} ` +
      `— matches searchTimeFine()'s own null-return case; caller must skip this candidate (no GPU equivalent of "no result").`,
    );
  }
  if (n > MAX_SAMPLES_LEN) {
    throw new Error(`buildFlatCandidate: window length n=${n} exceeds MAX_SAMPLES_LEN=${MAX_SAMPLES_LEN}.`);
  }

  const factors = factorRadixSchedule(n);
  if (factors.some((r) => r !== 2 && r !== 3 && r !== 5)) {
    throw new Error(
      `buildFlatCandidate: window length n=${n} is not 2/3/5-smooth (factorRadixSchedule produced a non-2/3/5 stage) — ` +
      `searchBoth.wgsl has no generic-DFT fallback for a leftover prime factor (same documented scope as fftGeneralFused.wgsl); ` +
      `this candidate would need a CPU fallback.`,
    );
  }
  if (factors.length > MAX_STAGES) {
    throw new Error(`buildFlatCandidate: window length n=${n} needs ${factors.length} stages, exceeding MAX_STAGES=${MAX_STAGES}.`);
  }

  const stageFlat = new Uint32Array(MAX_STAGES * 4);
  let strideIn = 1;
  factors.forEach((radix, i) => {
    const strideOut = strideIn * radix;
    const groups = n / strideOut;
    stageFlat[i * 4] = radix;
    stageFlat[i * 4 + 1] = strideIn;
    stageFlat[i * 4 + 2] = strideOut;
    stageFlat[i * 4 + 3] = groups;
    strideIn = strideOut;
  });

  const hzList: number[] = [];
  for (let hz = hz0 - hzWin; hz <= hz0 + hzWin + 0.01; hz += hzInc) hzList.push(hz);
  if (hzList.length > SEARCH_BOTH_MAX_HZ) {
    throw new Error(`buildFlatCandidate: hzCount=${hzList.length} exceeds SEARCH_BOTH_MAX_HZ=${SEARCH_BOTH_MAX_HZ}.`);
  }
  const binHz = 200 / n;
  const hzDowns = new Float32Array(SEARCH_BOTH_MAX_HZ * 2);
  hzList.forEach((hz, i) => {
    const down = Math.round((hz - 25.0) / binHz);
    hzDowns[i * 2] = hz;
    hzDowns[i * 2 + 1] = down;
  });

  let offCount = 0;
  for (let g = 0; g <= (offNval - off0Clamped); g += offInc) offCount++;
  if (offCount > SEARCH_BOTH_MAX_OFF) {
    throw new Error(`buildFlatCandidate: offCount=${offCount} exceeds SEARCH_BOTH_MAX_OFF=${SEARCH_BOTH_MAX_OFF}.`);
  }

  const samples = new Float32Array(MAX_SAMPLES_LEN);
  for (let i = 0; i < MAX_SAMPLES_LEN; i++) {
    const idx = off0Clamped + i;
    samples[i] = idx < samplesLen ? Number(samples200[idx]) : 0;
  }

  return {
    n,
    numStages: factors.length,
    stageFlat,
    hzCount: hzList.length,
    offCount,
    offInc,
    off0Clamped,
    windowOff: 0, // samples[] is already sliced to start at off0Clamped
    samplesLen: n, // samples[] only has `n` valid entries (rest is padding, already zeroed)
    hzDowns,
    samples,
  };
}

export interface SearchBothResult {
  hz: number;
  off: number;
  strength: number;
}

interface PipelineState {
  device: GPUDevice;
  pipeline: GPUComputePipeline;
  maxBatch: number;
  nBatchBuf: GPUBuffer;
  paramsBuf: GPUBuffer;
  stagesBuf: GPUBuffer;
  hzDownsBuf: GPUBuffer;
  samplesBuf: GPUBuffer;
  resultBuf: GPUBuffer;
  readbackBuf: GPUBuffer;
}

let cachedPipeline: PipelineState | null = null;

async function getPipelineState(maxBatch: number, workgroupStorageBudget: { n: number; hzCount: number; offCount: number }): Promise<PipelineState> {
  const device = await getDevice();
  if (cachedPipeline && cachedPipeline.maxBatch >= maxBatch) return cachedPipeline;
  if (cachedPipeline) resetSearchBothGpuState();

  const budgetError = checkSearchBothWorkgroupBudget(
    workgroupStorageBudget.n,
    workgroupStorageBudget.hzCount,
    workgroupStorageBudget.offCount,
    device.limits.maxComputeWorkgroupStorageSize,
  );
  if (budgetError) throw new Error(budgetError);

  const module = device.createShaderModule({ code: searchBothWgsl });
  const pipeline = device.createComputePipeline({
    layout: 'auto',
    compute: { module, entryPoint: 'main' },
  });

  const nBatchBuf = device.createBuffer({
    size: 16, // single u32, padded to a 16-byte uniform binding
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const paramsBuf = device.createBuffer({
    size: maxBatch * CANDIDATE_PARAMS_BYTES,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  const stagesBuf = device.createBuffer({
    size: maxBatch * MAX_STAGES * STAGE_DESC_BYTES,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  const hzDownsBuf = device.createBuffer({
    size: maxBatch * SEARCH_BOTH_MAX_HZ * 2 * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  const samplesBuf = device.createBuffer({
    size: maxBatch * MAX_SAMPLES_LEN * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  const resultBuf = device.createBuffer({
    size: maxBatch * RESULT_FLOATS_PER_CANDIDATE * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });
  const readbackBuf = device.createBuffer({
    size: maxBatch * RESULT_FLOATS_PER_CANDIDATE * 4,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });

  cachedPipeline = { device, pipeline, maxBatch, nBatchBuf, paramsBuf, stagesBuf, hzDownsBuf, samplesBuf, resultBuf, readbackBuf };
  return cachedPipeline;
}

/** Runs searchBoth()'s entire (hz x off) grid search for a BATCH of
 *  candidates in one dispatch (one workgroup per candidate), returning only
 *  each candidate's single best (hz, off, strength) — the GPU analogue of
 *  `searchBothDefault(samples200, bestOff)[0]` per candidate. Candidates
 *  whose window would run past their samples200 buffer (searchTimeFine's
 *  own null-return case) must be filtered out by the caller before calling
 *  this — there is no GPU equivalent of "no result" here. */
export async function runSearchBothGpu(inputs: SearchBothCandidateInput[]): Promise<SearchBothResult[]> {
  if (inputs.length === 0) return [];

  const flats = inputs.map(buildFlatCandidate);
  const maxN = Math.max(...flats.map((f) => f.n));
  const maxHzCount = Math.max(...flats.map((f) => f.hzCount));
  const maxOffCount = Math.max(...flats.map((f) => f.offCount));

  const state = await getPipelineState(flats.length, { n: maxN, hzCount: maxHzCount, offCount: maxOffCount });
  const { device, pipeline, nBatchBuf, paramsBuf, stagesBuf, hzDownsBuf, samplesBuf, resultBuf, readbackBuf } = state;

  const batch = flats.length;

  const nBatchData = new Uint32Array(4);
  nBatchData[0] = batch;
  device.queue.writeBuffer(nBatchBuf, 0, nBatchData.buffer, nBatchData.byteOffset, nBatchData.byteLength);

  const paramsData = new Uint32Array(batch * 8);
  const stagesData = new Uint32Array(batch * MAX_STAGES * 4);
  const hzDownsData = new Float32Array(batch * SEARCH_BOTH_MAX_HZ * 2);
  const samplesData = new Float32Array(batch * MAX_SAMPLES_LEN);

  flats.forEach((f, i) => {
    paramsData[i * 8 + 0] = f.n;
    paramsData[i * 8 + 1] = f.numStages;
    paramsData[i * 8 + 2] = f.hzCount;
    paramsData[i * 8 + 3] = f.offCount;
    paramsData[i * 8 + 4] = f.offInc;
    paramsData[i * 8 + 5] = f.off0Clamped;
    paramsData[i * 8 + 6] = f.windowOff;
    paramsData[i * 8 + 7] = f.samplesLen;
    stagesData.set(f.stageFlat, i * MAX_STAGES * 4);
    hzDownsData.set(f.hzDowns, i * SEARCH_BOTH_MAX_HZ * 2);
    samplesData.set(f.samples, i * MAX_SAMPLES_LEN);
  });

  device.queue.writeBuffer(paramsBuf, 0, paramsData.buffer, paramsData.byteOffset, paramsData.byteLength);
  device.queue.writeBuffer(stagesBuf, 0, stagesData.buffer, stagesData.byteOffset, stagesData.byteLength);
  device.queue.writeBuffer(hzDownsBuf, 0, hzDownsData.buffer, hzDownsData.byteOffset, hzDownsData.byteLength);
  device.queue.writeBuffer(samplesBuf, 0, samplesData.buffer, samplesData.byteOffset, samplesData.byteLength);

  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: nBatchBuf } },
      { binding: 1, resource: { buffer: paramsBuf } },
      { binding: 2, resource: { buffer: stagesBuf } },
      { binding: 3, resource: { buffer: hzDownsBuf } },
      { binding: 4, resource: { buffer: samplesBuf } },
      { binding: 5, resource: { buffer: resultBuf } },
    ],
  });

  const encoder = device.createCommandEncoder();
  const pass = encoder.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.dispatchWorkgroups(batch);
  pass.end();

  const bytes = batch * RESULT_FLOATS_PER_CANDIDATE * 4;
  encoder.copyBufferToBuffer(resultBuf, 0, readbackBuf, 0, bytes);

  device.queue.submit([encoder.finish()]);
  await device.queue.onSubmittedWorkDone();

  await readbackBuf.mapAsync(GPUMapMode.READ, 0, bytes);
  const mapped = readbackBuf.getMappedRange(0, bytes);
  const result = new Float32Array(mapped.slice(0));
  readbackBuf.unmap();

  const out: SearchBothResult[] = new Array(batch);
  for (let i = 0; i < batch; i++) {
    const base = i * RESULT_FLOATS_PER_CANDIDATE;
    out[i] = { hz: result[base], off: result[base + 1], strength: result[base + 2] };
  }
  return out;
}

export function resetSearchBothGpuState(): void {
  if (cachedPipeline) {
    cachedPipeline.nBatchBuf.destroy();
    cachedPipeline.paramsBuf.destroy();
    cachedPipeline.stagesBuf.destroy();
    cachedPipeline.hzDownsBuf.destroy();
    cachedPipeline.samplesBuf.destroy();
    cachedPipeline.resultBuf.destroy();
    cachedPipeline.readbackBuf.destroy();
    cachedPipeline = null;
  }
}

export const SEARCH_BOTH_WG_SIZE = WG_SIZE;
export const SEARCH_BOTH_MAX_SAMPLES_LEN = MAX_SAMPLES_LEN;
export { checkSearchBothWorkgroupBudget } from './searchBothBudget';
