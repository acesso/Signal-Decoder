/// <reference types="@webgpu/types" />
// WebGPU orchestration for the fused general-length (2/3/5-smooth) FFT
// kernel (see fftGeneralFused.wgsl for the kernel, fftGeneral.ts for the
// correctness-verified plain-TS math it mirrors — cross-checked against
// fft1920.ts at N=1920 and a naive DFT at other 2/3/5-smooth N, see
// fftGeneral.test.ts / fftGeneralIfft.test.ts).
//
// Foundational piece only: this is the general-N analogue of
// webgpuCoarseSearch.ts's fft1920Fused.wgsl wrapper, built so a LATER
// per-candidate grid-search kernel (fineSync.ts's shift200()/searchBoth(),
// not built here) can run its FFT/IFFT math entirely on the GPU without
// round-tripping through JS. NOT wired into the live decode pipeline —
// standalone, currently-unused module, same status as webgpuCoarseSearch.ts
// before its own integration decision.
//
// Caller-side constraint (mirrors fftGeneralFused.wgsl's header): N must be
// 2/3/5-smooth (factorRadixSchedule(n) must yield only radix-2/3/5 stages) —
// this kernel does NOT implement fftGeneral.ts's generic-DFT fallback for a
// leftover prime factor. runFftGeneralGpu() throws if N doesn't factor
// cleanly, rather than silently producing wrong output.

import fftGeneralFusedWgsl from './fftGeneralFused.wgsl?raw';
import { factorRadixSchedule } from './fftGeneral';
import type { Complex } from './dsp';
import { getDevice } from './webgpuDevice';
import { checkFftWorkgroupBudget, FFT_GENERAL_MAX_N } from './fftWorkgroupBudget';
export { checkFftWorkgroupBudget } from './fftWorkgroupBudget';

const PARAMS_BYTES = 16; // 4x u32 (n, num_stages, n_batch, pad)
const STAGE_DESC_BYTES = 16; // 4x u32 per stage (radix, stride_in, stride_out, groups)
const WG_SIZE = 256;

interface StageSchedule {
  numStages: number;
  flat: Uint32Array; // numStages * 4 u32s: (radix, strideIn, strideOut, groups)
}

/** Flattens factorRadixSchedule(n) into the (radix, stride_in, stride_out,
 *  groups) layout fftGeneralFused.wgsl's StageDesc struct expects — same
 *  strideIn/strideOut derivation as fftGeneral.ts's own fftGeneral() loop
 *  and fft1920.ts's buildPassSchedule(). Throws if any stage's radix isn't
 *  2, 3, or 5 (see module header: this GPU kernel has no generic-DFT
 *  fallback for a leftover prime factor). */
export function flattenStageSchedule(n: number): StageSchedule {
  const factors = factorRadixSchedule(n);
  const flat = new Uint32Array(factors.length * 4);
  let strideIn = 1;
  factors.forEach((radix, i) => {
    if (radix !== 2 && radix !== 3 && radix !== 5) {
      throw new Error(
        `flattenStageSchedule: N=${n} is not 2/3/5-smooth (factorRadixSchedule produced a radix-${radix} stage) — ` +
        `fftGeneralFused.wgsl has no generic-DFT fallback for a leftover prime factor; pad/choose N to be 2/3/5-smooth.`,
      );
    }
    const strideOut = strideIn * radix;
    const groups = n / strideOut;
    flat[i * 4] = radix;
    flat[i * 4 + 1] = strideIn;
    flat[i * 4 + 2] = strideOut;
    flat[i * 4 + 3] = groups;
    strideIn = strideOut;
  });
  return { numStages: factors.length, flat };
}

interface PipelineState {
  device: GPUDevice;
  pipeline: GPUComputePipeline;
  n: number;
  maxBatch: number;
  paramsBuf: GPUBuffer;
  stagesBuf: GPUBuffer;
  srcBuf: GPUBuffer;
  dstBuf: GPUBuffer;
  readbackBuf: GPUBuffer;
}

let cachedPipeline: PipelineState | null = null;

async function getPipelineState(n: number, maxBatch: number): Promise<PipelineState> {
  const device = await getDevice();
  if (cachedPipeline && cachedPipeline.n === n && cachedPipeline.maxBatch >= maxBatch) return cachedPipeline;
  if (cachedPipeline) resetFftGeneralGpuState();

  const budgetError = checkFftWorkgroupBudget(n, device.limits.maxComputeWorkgroupStorageSize);
  if (budgetError) throw new Error(budgetError);

  const module = device.createShaderModule({ code: fftGeneralFusedWgsl });
  const pipeline = device.createComputePipeline({
    layout: 'auto',
    compute: { module, entryPoint: 'main' },
  });

  const { numStages } = flattenStageSchedule(n);
  const complexBufSize = maxBatch * n * 2 * 4; // vec2<f32> per (batch, bin)

  const paramsBuf = device.createBuffer({
    size: PARAMS_BYTES,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const stagesBuf = device.createBuffer({
    size: Math.max(numStages, 1) * STAGE_DESC_BYTES,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  const srcBuf = device.createBuffer({
    size: complexBufSize,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  const dstBuf = device.createBuffer({
    size: complexBufSize,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });
  const readbackBuf = device.createBuffer({
    size: complexBufSize,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });

  cachedPipeline = { device, pipeline, n, maxBatch, paramsBuf, stagesBuf, srcBuf, dstBuf, readbackBuf };
  return cachedPipeline;
}

/** Runs a fused forward complex FFT for `batch` independent N-point signals
 *  in one dispatch (one workgroup per batch element), matching
 *  fftGeneral.ts's fftGeneral()'s per-signal math exactly. `inputInterleaved`
 *  is a flat [re,im,re,im,...] Float32Array of length `batch * n * 2`;
 *  returns the same layout. N must be 2/3/5-smooth (see module header). */
export async function runFftGeneralGpu(inputInterleaved: Float32Array, n: number, batch = 1): Promise<Float32Array> {
  const expectedLen = batch * n * 2;
  if (inputInterleaved.length !== expectedLen) {
    throw new Error(`runFftGeneralGpu: expected ${expectedLen} interleaved values for N=${n}, batch=${batch}, got ${inputInterleaved.length}`);
  }

  const state = await getPipelineState(n, batch);
  const { device, pipeline, paramsBuf, stagesBuf, srcBuf, dstBuf, readbackBuf } = state;

  const { numStages, flat } = flattenStageSchedule(n);
  device.queue.writeBuffer(stagesBuf, 0, flat.buffer, flat.byteOffset, flat.byteLength);
  device.queue.writeBuffer(srcBuf, 0, inputInterleaved.buffer, inputInterleaved.byteOffset, inputInterleaved.byteLength);

  const paramsData = new Uint32Array(PARAMS_BYTES / 4);
  paramsData[0] = n;
  paramsData[1] = numStages;
  paramsData[2] = batch;
  device.queue.writeBuffer(paramsBuf, 0, paramsData.buffer, paramsData.byteOffset, paramsData.byteLength);

  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: paramsBuf } },
      { binding: 1, resource: { buffer: stagesBuf } },
      { binding: 2, resource: { buffer: srcBuf } },
      { binding: 3, resource: { buffer: dstBuf } },
    ],
  });

  const encoder = device.createCommandEncoder();
  const pass = encoder.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.dispatchWorkgroups(batch);
  pass.end();

  const bytes = expectedLen * 4;
  encoder.copyBufferToBuffer(dstBuf, 0, readbackBuf, 0, bytes);

  device.queue.submit([encoder.finish()]);
  await device.queue.onSubmittedWorkDone();

  await readbackBuf.mapAsync(GPUMapMode.READ, 0, bytes);
  const mapped = readbackBuf.getMappedRange(0, bytes);
  const result = new Float32Array(mapped.slice(0));
  readbackBuf.unmap();
  return result;
}

/** Real-to-complex rfft on the GPU, matching fftGeneral.ts's
 *  realFftGeneral() contract: real input of length n, n/2+1 complex output
 *  bins. Runs the full complex FFT (im=0 input) via runFftGeneralGpu, same
 *  "simplest correct approach" tradeoff realFftGeneral() itself documents. */
export async function runRealFftGeneralGpu(samples: Float32Array, n: number): Promise<Complex[]> {
  const [result] = await runRealFftGeneralBatchGpu([samples], n);
  return result;
}

/** Batched version of runRealFftGeneralGpu: ALL `samplesBatch` entries MUST
 *  share the same N — one dispatch computes every entry's rfft, instead of
 *  `batch` separate round-trips each paying full submit/onSubmittedWorkDone/
 *  mapAsync latency. Added because gpuDecodePipeline.ts's downV7fGpu/
 *  shift200Gpu calls (one per fine-sync candidate, same N per window since
 *  it only depends on the capture window's duration, not per-candidate hz)
 *  were found — on real hardware — to dominate total decode time once
 *  forced sequential (concurrent calls into this module's single cached
 *  pipeline/readback buffer are unsafe, confirmed live via a real "Buffer
 *  mapping is already pending" error) rather than batched. */
export async function runRealFftGeneralBatchGpu(samplesBatch: Float32Array[], n: number): Promise<Complex[][]> {
  const batch = samplesBatch.length;
  const interleaved = new Float32Array(batch * n * 2);
  samplesBatch.forEach((samples, b) => {
    for (let i = 0; i < n; i++) interleaved[(b * n + i) * 2] = i < samples.length ? samples[i] : 0;
  });
  const full = await runFftGeneralGpu(interleaved, n, batch);
  const nBins = Math.floor(n / 2) + 1;
  return Array.from({ length: batch }, (_, b) => {
    const out: Complex[] = new Array(nBins);
    for (let k = 0; k < nBins; k++) out[k] = [full[(b * n + k) * 2], full[(b * n + k) * 2 + 1]];
    return out;
  });
}

/** Complex-to-real IFFT on the GPU, matching fftGeneral.ts's
 *  realIfftGeneral() contract exactly (same unnormalized FFTW c2r
 *  convention, same conjugate-symmetric spectrum reconstruction, same
 *  conjugate-FFT-conjugate identity) — just dispatched via the GPU kernel
 *  instead of the CPU Stockham pass.
 *
 *  Expect a per-sample error against the CPU reference roughly sqrt(N)
 *  times the forward FFT's per-bin error, not the same magnitude: each
 *  output sample here is an unnormalized sum over all N spectrum bins
 *  (see the conjugate-FFT-conjugate identity below), so N independent
 *  per-bin f32 rounding errors accumulate like a random walk (~sqrt(N)
 *  growth), not like N of them cancelling out. Confirmed externally: JS
 *  perturbing every CPU-computed bin by ~1e-2 (this kernel's own measured
 *  forward-FFT error scale) and re-running fftGeneral.ts's realIfftGeneral
 *  on the perturbed bins reproduces a ~1.4 maxAbsDiff at N=1920/2592 — the
 *  same order of magnitude as this GPU path's measured error against a
 *  CPU reference computed from independently-rounded bins. Not a logic
 *  bug in the reconstruction below (verified identical to
 *  fftGeneral.ts's realIfftGeneral()); see webgpu-fftgeneral-bench.html's
 *  tolerance comment for the derivation. */
export async function runRealIfftGeneralGpu(bins: Complex[]): Promise<Float32Array> {
  const [result] = await runRealIfftGeneralBatchGpu([bins]);
  return result;
}

/** Batched version of runRealIfftGeneralGpu — see runRealFftGeneralBatchGpu's
 *  doc comment for why this exists (one dispatch for all of a decode
 *  window's fine-sync candidates' downV7f/shift200 IFFTs, instead of one
 *  round-trip per candidate). Every entry in `binsBatch` MUST have the same
 *  length (same N per window, only per-candidate hz/content differs). */
export async function runRealIfftGeneralBatchGpu(binsBatch: Complex[][]): Promise<Float32Array[]> {
  const batch = binsBatch.length;
  const nBins = binsBatch[0].length;
  const n = (nBins - 1) * 2;

  const full = new Float32Array(batch * n * 2);
  binsBatch.forEach((bins, b) => {
    if (bins.length !== nBins) {
      throw new Error(`runRealIfftGeneralBatchGpu: candidate ${b} has ${bins.length} bins, expected ${nBins} (every candidate in a batch must share the same N)`);
    }
    const base = b * n * 2;
    for (let k = 0; k < nBins; k++) {
      full[base + k * 2] = bins[k][0];
      full[base + k * 2 + 1] = bins[k][1];
    }
    for (let k = nBins; k < n; k++) {
      const conjK = n - k;
      full[base + k * 2] = bins[conjK][0];
      full[base + k * 2 + 1] = -bins[conjK][1];
    }
    for (let i = 0; i < n; i++) full[base + i * 2 + 1] = -full[base + i * 2 + 1];
  });

  const transformed = await runFftGeneralGpu(full, n, batch);

  return Array.from({ length: batch }, (_, b) => {
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = transformed[(b * n + i) * 2];
    return out;
  });
}

export function resetFftGeneralGpuState(): void {
  if (cachedPipeline) {
    cachedPipeline.paramsBuf.destroy();
    cachedPipeline.stagesBuf.destroy();
    cachedPipeline.srcBuf.destroy();
    cachedPipeline.dstBuf.destroy();
    cachedPipeline.readbackBuf.destroy();
    cachedPipeline = null;
  }
}

export { FFT_GENERAL_MAX_N };
export const FFT_GENERAL_WG_SIZE = WG_SIZE;
