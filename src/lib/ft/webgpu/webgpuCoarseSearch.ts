/// <reference types="@webgpu/types" />
// WebGPU orchestration for the coarse Costas-sync search feasibility
// prototype (see fft1920.wgsl / costasCorrelation.wgsl for the actual
// kernels, fft1920.ts / costasCorrelation.ts for the correctness-verified
// plain-TS math those kernels mirror — cross-checked against real ft8mon
// output on a real WAV, see the branch's benchmark script for the numbers).
//
// Pipeline: upload raw 15s/12kHz audio once (as `n_symbols` independent
// 1920-sample blocks, framed exactly like ft8mon's ffts()) -> 9 chained FFT
// compute passes (one per Stockham radix stage, ping-ponging between two
// storage buffers, ALL n_symbols FFTs batched into each pass's single
// dispatch since they're fully independent) -> one correlation-grid compute
// pass over (si, bi) -> read back a flat strength buffer. Candidate
// sort/dedup/top-k stays on the CPU/JS side (see module doc in
// costasCorrelation.wgsl) — that part is small and not worth a GPU port.
//
// This is NOT wired into the live decode path (src/lib/ft/decoder.worker.ts)
// — it's a standalone feasibility benchmark target, invoked only from
// scripts/webgpu-coarse-benchmark.ts, until the measured numbers justify
// integration.

import fft1920Wgsl from './fft1920.wgsl?raw';
import fft1920FusedWgsl from './fft1920Fused.wgsl?raw';
import costasCorrelationWgsl from './costasCorrelation.wgsl?raw';
import { FFT_N, buildPassSchedule } from './fft1920';
import { getDevice } from './webgpuDevice';
export { isWebGpuAvailable } from './webgpuDevice';

export interface CoarseSearchResult {
  strengths: Float32Array; // flat (siCount * biCount), row-major si-outer/bi-inner
  siCount: number;
  biCount: number;
  si0: number;
  bi0: number;
  timings: {
    uploadMs: number;
    dispatchMs: number; // FFT (9 passes) + correlation pass, encoder-to-submit
    readbackMs: number;
    totalMs: number;
  };
}

export interface CoarseSearchParams {
  si0: number;
  siCount: number;
  bi0: number;
  biCount: number;
}

interface PipelineState {
  device: GPUDevice;
  fftPipeline: GPUComputePipeline;
  correlationPipeline: GPUComputePipeline;
  nSymbols: number;
  bufA: GPUBuffer;
  bufB: GPUBuffer;
  fftParamsBufs: GPUBuffer[]; // one per FFT pass — see FFT_PASS_COUNT comment
  gridParamsBuf: GPUBuffer;
  strengthBuf: GPUBuffer;
  readbackBuf: GPUBuffer;
}

let cachedPipeline: PipelineState | null = null;

// WGSL uniform buffer bindings must be sized to a multiple of 16 bytes.
const FFT_PARAMS_BYTES = 32; // 5x u32 (20 bytes) rounded up to 32
const GRID_PARAMS_BYTES = 32; // 6x u32 (24 bytes) rounded up to 32

// GPUQueue.writeBuffer() is a QUEUE-timeline operation: every writeBuffer
// call made before a submit() executes (in call order) BEFORE that
// submit()'s encoded commands run, regardless of where in JS code order the
// encoder's commands were recorded relative to the writeBuffer calls.
// Recording into an encoder has no queue-timeline effect until submit() —
// so reusing ONE uniform buffer across all 9 FFT passes (write, record pass
// referencing it, write again, record next pass, ..., submit once at the
// end) made every pass see the LAST writeBuffer's contents, since all 9
// writes resolve before any of the 9 recorded passes execute. Confirmed
// against the WebGPU spec's queue-timeline model (gpuweb#4252) after this
// exact bug reproduced on real hardware (all 9 passes reading pass 9's
// radix=5/stride params, producing a garbage FFT while the per-symbol and
// batching math were independently verified correct in isolation).
//
// Fix: a DISTINCT uniform buffer per pass, each written once, so there's no
// shared buffer for a later writeBuffer to clobber before an earlier pass
// runs. (The alternative idiomatic fix — one buffer with dynamic offsets
// via setBindGroup's dynamicOffsets array — needs an explicit
// GPUBindGroupLayout with hasDynamicOffset: true; WGSL has no syntax to
// express that, so layout: 'auto' can never produce it. Distinct buffers
// keep the simpler layout: 'auto' pipeline setup for this fixed, small
// 9-pass schedule.)
const FFT_PASS_COUNT = 9;

async function getPipelineState(nSymbols: number): Promise<PipelineState> {
  const device = await getDevice();
  if (cachedPipeline && cachedPipeline.nSymbols === nSymbols) return cachedPipeline;
  if (cachedPipeline) resetGpuState();

  const fftModule = device.createShaderModule({ code: fft1920Wgsl });
  const correlationModule = device.createShaderModule({ code: costasCorrelationWgsl });

  const fftPipeline = device.createComputePipeline({
    layout: 'auto',
    compute: { module: fftModule, entryPoint: 'main' },
  });
  const correlationPipeline = device.createComputePipeline({
    layout: 'auto',
    compute: { module: correlationModule, entryPoint: 'main' },
  });

  const complexBufSize = nSymbols * FFT_N * 2 * 4; // vec2<f32> per (symbol, bin)
  const bufA = device.createBuffer({
    size: complexBufSize,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
  });
  const bufB = device.createBuffer({
    size: complexBufSize,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  // One buffer PER PASS (not one reused buffer) — see FFT_PASS_COUNT comment
  // above for why a single reused-and-rewritten uniform buffer is broken.
  const fftParamsBufs = Array.from({ length: FFT_PASS_COUNT }, () =>
    device.createBuffer({
      size: FFT_PARAMS_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    }),
  );
  const gridParamsBuf = device.createBuffer({
    size: GRID_PARAMS_BYTES,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  // Worst-case strength buffer sized for the full (nSymbols x FFT_N) grid;
  // actual dispatch only writes the params-specified (siCount x biCount)
  // subset starting at (si0, bi0).
  const strengthBufSize = nSymbols * FFT_N * 4;
  const strengthBuf = device.createBuffer({
    size: strengthBufSize,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });
  const readbackBuf = device.createBuffer({
    size: strengthBufSize,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });

  cachedPipeline = {
    device, fftPipeline, correlationPipeline, nSymbols,
    bufA, bufB, fftParamsBufs, gridParamsBuf, strengthBuf, readbackBuf,
  };
  return cachedPipeline;
}

/** Runs the full GPU pipeline: uploads per-symbol audio blocks, computes
 *  every symbol's FFT via the 9-pass Stockham kernel (all symbols batched
 *  into each pass's single dispatch — they're fully independent, same as
 *  ft8mon's ffts() computing one FFT per symbol-time with no cross-symbol
 *  dependency), then evaluates the coarse Costas correlation grid over the
 *  resulting spectrogram. `samplesBySymbol` must contain `nSymbols` blocks
 *  of exactly FFT_N real samples each (same framing as ft8mon's ffts()). */
export async function runCoarseSearchGpu(
  samplesBySymbol: Float32Array, // length nSymbols * FFT_N, real-valued
  nSymbols: number,
  params: CoarseSearchParams,
): Promise<CoarseSearchResult> {
  const t0 = performance.now();
  const state = await getPipelineState(nSymbols);
  const { device, fftPipeline, correlationPipeline, bufA, bufB, fftParamsBufs, gridParamsBuf, strengthBuf, readbackBuf } = state;

  if (samplesBySymbol.length !== nSymbols * FFT_N) {
    throw new Error(`runCoarseSearchGpu: expected ${nSymbols * FFT_N} samples, got ${samplesBySymbol.length}`);
  }

  // Upload: expand real samples into interleaved [re, im=0, ...] directly
  // into bufA via a staging Float32Array (WebGPU has no strided-write, so
  // build the interleaved layout on the CPU once per call).
  const interleaved = new Float32Array(nSymbols * FFT_N * 2);
  for (let i = 0; i < nSymbols * FFT_N; i++) interleaved[i * 2] = samplesBySymbol[i];
  device.queue.writeBuffer(bufA, 0, interleaved.buffer, interleaved.byteOffset, interleaved.byteLength);

  const passes = buildPassSchedule();

  // Write each pass's params into ITS OWN buffer — see FFT_PASS_COUNT
  // comment above for why reusing one buffer across passes is broken (every
  // pass would see the last writeBuffer's contents, since writeBuffer is a
  // queue-timeline op that always resolves before a later submit()).
  const paramsScratch = new Uint32Array(FFT_PARAMS_BYTES / 4);
  passes.forEach((pass, i) => {
    paramsScratch[0] = 0; // pass_index (unused by the kernel itself, kept for debugging/readability)
    paramsScratch[1] = pass.radix;
    paramsScratch[2] = pass.strideIn;
    paramsScratch[3] = pass.strideOut;
    paramsScratch[4] = nSymbols;
    device.queue.writeBuffer(fftParamsBufs[i], 0, paramsScratch.buffer, paramsScratch.byteOffset, paramsScratch.byteLength);
  });
  const tUpload = performance.now();

  let srcBuf = bufA;
  let dstBuf = bufB;

  const encoder = device.createCommandEncoder();
  passes.forEach((pass, i) => {
    const bindGroup = device.createBindGroup({
      layout: fftPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: fftParamsBufs[i] } },
        { binding: 1, resource: { buffer: srcBuf } },
        { binding: 2, resource: { buffer: dstBuf } },
      ],
    });

    const groups = FFT_N / pass.strideOut;
    const perSymbolThreads = pass.strideIn * groups;
    const totalThreads = perSymbolThreads * nSymbols;
    const workgroups = Math.ceil(totalThreads / 64);

    const computePass = encoder.beginComputePass();
    computePass.setPipeline(fftPipeline);
    computePass.setBindGroup(0, bindGroup);
    computePass.dispatchWorkgroups(workgroups);
    computePass.end();

    [srcBuf, dstBuf] = [dstBuf, srcBuf];
  });

  // After 9 (odd) ping-pong swaps starting src=bufA/dst=bufB, the final
  // spectrogram lives in what is now `srcBuf` (each pass swaps AFTER use).
  const spectrogramBuf = srcBuf;

  const gridParamsData = new Uint32Array(GRID_PARAMS_BYTES / 4);
  gridParamsData[0] = params.si0;
  gridParamsData[1] = params.siCount;
  gridParamsData[2] = params.bi0;
  gridParamsData[3] = params.biCount;
  gridParamsData[4] = FFT_N;
  gridParamsData[5] = nSymbols;
  device.queue.writeBuffer(gridParamsBuf, 0, gridParamsData.buffer, gridParamsData.byteOffset, gridParamsData.byteLength);

  const correlationBindGroup = device.createBindGroup({
    layout: correlationPipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: gridParamsBuf } },
      { binding: 1, resource: { buffer: spectrogramBuf } },
      { binding: 2, resource: { buffer: strengthBuf } },
    ],
  });

  const totalCells = params.siCount * params.biCount;
  const correlationWorkgroups = Math.ceil(totalCells / 64);
  const corrPass = encoder.beginComputePass();
  corrPass.setPipeline(correlationPipeline);
  corrPass.setBindGroup(0, correlationBindGroup);
  corrPass.dispatchWorkgroups(correlationWorkgroups);
  corrPass.end();

  const readbackBytes = totalCells * 4;
  encoder.copyBufferToBuffer(strengthBuf, 0, readbackBuf, 0, readbackBytes);

  device.queue.submit([encoder.finish()]);
  await device.queue.onSubmittedWorkDone();
  const tDispatch = performance.now();

  await readbackBuf.mapAsync(GPUMapMode.READ, 0, readbackBytes);
  const mapped = readbackBuf.getMappedRange(0, readbackBytes);
  const strengths = new Float32Array(mapped.slice(0));
  readbackBuf.unmap();
  const tReadback = performance.now();

  return {
    strengths,
    siCount: params.siCount,
    biCount: params.biCount,
    si0: params.si0,
    bi0: params.bi0,
    timings: {
      uploadMs: tUpload - t0,
      dispatchMs: tDispatch - tUpload,
      readbackMs: tReadback - tDispatch,
      totalMs: tReadback - t0,
    },
  };
}

interface CorrelationOnlyState {
  device: GPUDevice;
  correlationPipeline: GPUComputePipeline;
  nSymbols: number;
  spectrogramBuf: GPUBuffer;
  gridParamsBuf: GPUBuffer;
  strengthBuf: GPUBuffer;
  readbackBuf: GPUBuffer;
}

let cachedCorrelationOnly: CorrelationOnlyState | null = null;

async function getCorrelationOnlyState(nSymbols: number): Promise<CorrelationOnlyState> {
  const device = await getDevice();
  if (cachedCorrelationOnly && cachedCorrelationOnly.nSymbols === nSymbols) return cachedCorrelationOnly;
  if (cachedCorrelationOnly) {
    cachedCorrelationOnly.spectrogramBuf.destroy();
    cachedCorrelationOnly.gridParamsBuf.destroy();
    cachedCorrelationOnly.strengthBuf.destroy();
    cachedCorrelationOnly.readbackBuf.destroy();
    cachedCorrelationOnly = null;
  }

  const correlationModule = device.createShaderModule({ code: costasCorrelationWgsl });
  const correlationPipeline = device.createComputePipeline({
    layout: 'auto',
    compute: { module: correlationModule, entryPoint: 'main' },
  });

  const complexBufSize = nSymbols * FFT_N * 2 * 4;
  const spectrogramBuf = device.createBuffer({
    size: complexBufSize,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  const gridParamsBuf = device.createBuffer({
    size: GRID_PARAMS_BYTES,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const strengthBufSize = nSymbols * FFT_N * 4;
  const strengthBuf = device.createBuffer({
    size: strengthBufSize,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });
  const readbackBuf = device.createBuffer({
    size: strengthBufSize,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });

  cachedCorrelationOnly = { device, correlationPipeline, nSymbols, spectrogramBuf, gridParamsBuf, strengthBuf, readbackBuf };
  return cachedCorrelationOnly;
}

/** Comparison variant: skips the GPU FFT entirely and runs ONLY the Costas
 *  correlation kernel, against a spectrogram computed on the CPU (e.g. via
 *  fft1920.ts, or extracted from ft8mon's own WASM run). Isolates "is the
 *  correlation grid evaluation itself faster on GPU" from "is GPU FFT
 *  throughput also a win" — see the branch's benchmark script for how these
 *  two numbers get compared against the full GPU pipeline and the current
 *  all-CPU/WASM baseline.
 *
 *  `spectrogramInterleaved` is a flat, row-major (time-major) [re,im,...]
 *  Float32Array of length nSymbols * FFT_N * 2 — same layout fft1920.ts's
 *  per-symbol output produces when concatenated. */
export async function runCoarseSearchGpuCorrelationOnly(
  spectrogramInterleaved: Float32Array,
  nSymbols: number,
  params: CoarseSearchParams,
): Promise<CoarseSearchResult> {
  const t0 = performance.now();
  const state = await getCorrelationOnlyState(nSymbols);
  const { device, correlationPipeline, spectrogramBuf, gridParamsBuf, strengthBuf, readbackBuf } = state;

  const expectedLen = nSymbols * FFT_N * 2;
  if (spectrogramInterleaved.length !== expectedLen) {
    throw new Error(`runCoarseSearchGpuCorrelationOnly: expected ${expectedLen} interleaved values, got ${spectrogramInterleaved.length}`);
  }

  device.queue.writeBuffer(spectrogramBuf, 0, spectrogramInterleaved.buffer, spectrogramInterleaved.byteOffset, spectrogramInterleaved.byteLength);
  const tUpload = performance.now();

  const gridParamsData = new Uint32Array(GRID_PARAMS_BYTES / 4);
  gridParamsData[0] = params.si0;
  gridParamsData[1] = params.siCount;
  gridParamsData[2] = params.bi0;
  gridParamsData[3] = params.biCount;
  gridParamsData[4] = FFT_N;
  gridParamsData[5] = nSymbols;
  device.queue.writeBuffer(gridParamsBuf, 0, gridParamsData.buffer, gridParamsData.byteOffset, gridParamsData.byteLength);

  const bindGroup = device.createBindGroup({
    layout: correlationPipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: gridParamsBuf } },
      { binding: 1, resource: { buffer: spectrogramBuf } },
      { binding: 2, resource: { buffer: strengthBuf } },
    ],
  });

  const totalCells = params.siCount * params.biCount;
  const workgroups = Math.ceil(totalCells / 64);

  const encoder = device.createCommandEncoder();
  const pass = encoder.beginComputePass();
  pass.setPipeline(correlationPipeline);
  pass.setBindGroup(0, bindGroup);
  pass.dispatchWorkgroups(workgroups);
  pass.end();

  const readbackBytes = totalCells * 4;
  encoder.copyBufferToBuffer(strengthBuf, 0, readbackBuf, 0, readbackBytes);

  device.queue.submit([encoder.finish()]);
  await device.queue.onSubmittedWorkDone();
  const tDispatch = performance.now();

  await readbackBuf.mapAsync(GPUMapMode.READ, 0, readbackBytes);
  const mapped = readbackBuf.getMappedRange(0, readbackBytes);
  const strengths = new Float32Array(mapped.slice(0));
  readbackBuf.unmap();
  const tReadback = performance.now();

  return {
    strengths,
    siCount: params.siCount,
    biCount: params.biCount,
    si0: params.si0,
    bi0: params.bi0,
    timings: {
      uploadMs: tUpload - t0,
      dispatchMs: tDispatch - tUpload,
      readbackMs: tReadback - tDispatch,
      totalMs: tReadback - t0,
    },
  };
}

interface FusedPipelineState {
  device: GPUDevice;
  fftPipeline: GPUComputePipeline;
  correlationPipeline: GPUComputePipeline;
  nSymbols: number;
  bufA: GPUBuffer;
  bufB: GPUBuffer;
  fftParamsBuf: GPUBuffer;
  gridParamsBuf: GPUBuffer;
  strengthBuf: GPUBuffer;
  readbackBuf: GPUBuffer;
}

let cachedFusedPipeline: FusedPipelineState | null = null;

const FUSED_PARAMS_BYTES = 16; // 4x u32 (n_symbols + 3 padding)

async function getFusedPipelineState(nSymbols: number): Promise<FusedPipelineState> {
  const device = await getDevice();
  if (cachedFusedPipeline && cachedFusedPipeline.nSymbols === nSymbols) return cachedFusedPipeline;
  if (cachedFusedPipeline) resetFusedGpuState();

  const fftModule = device.createShaderModule({ code: fft1920FusedWgsl });
  const correlationModule = device.createShaderModule({ code: costasCorrelationWgsl });

  const fftPipeline = device.createComputePipeline({
    layout: 'auto',
    compute: { module: fftModule, entryPoint: 'main' },
  });
  const correlationPipeline = device.createComputePipeline({
    layout: 'auto',
    compute: { module: correlationModule, entryPoint: 'main' },
  });

  const complexBufSize = nSymbols * FFT_N * 2 * 4;
  const bufA = device.createBuffer({
    size: complexBufSize,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
  });
  const bufB = device.createBuffer({
    size: complexBufSize,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
  });
  const fftParamsBuf = device.createBuffer({
    size: FUSED_PARAMS_BYTES,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const gridParamsBuf = device.createBuffer({
    size: GRID_PARAMS_BYTES,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const strengthBufSize = nSymbols * FFT_N * 4;
  const strengthBuf = device.createBuffer({
    size: strengthBufSize,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });
  const readbackBuf = device.createBuffer({
    size: strengthBufSize,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });

  cachedFusedPipeline = {
    device, fftPipeline, correlationPipeline, nSymbols,
    bufA, bufB, fftParamsBuf, gridParamsBuf, strengthBuf, readbackBuf,
  };
  return cachedFusedPipeline;
}

/** Same coarse-search pipeline as runCoarseSearchGpu, but using
 *  fft1920Fused.wgsl (ONE dispatch does all 9 Stockham stages internally
 *  via workgroup-shared memory + workgroupBarrier(), one workgroup per
 *  symbol) instead of 9 separate dispatches. Exists to test whether
 *  removing 8 of 9 dispatch-overhead payments actually helps at this
 *  workload's scale — see the benchmark page for the measured comparison
 *  against both the unfused GPU path and the CPU/WASM baseline. */
export async function runCoarseSearchGpuFusedFft(
  samplesBySymbol: Float32Array,
  nSymbols: number,
  params: CoarseSearchParams,
): Promise<CoarseSearchResult> {
  const t0 = performance.now();
  const state = await getFusedPipelineState(nSymbols);
  const { device, fftPipeline, correlationPipeline, bufA, bufB, fftParamsBuf, gridParamsBuf, strengthBuf, readbackBuf } = state;

  if (samplesBySymbol.length !== nSymbols * FFT_N) {
    throw new Error(`runCoarseSearchGpuFusedFft: expected ${nSymbols * FFT_N} samples, got ${samplesBySymbol.length}`);
  }

  const interleaved = new Float32Array(nSymbols * FFT_N * 2);
  for (let i = 0; i < nSymbols * FFT_N; i++) interleaved[i * 2] = samplesBySymbol[i];
  device.queue.writeBuffer(bufA, 0, interleaved.buffer, interleaved.byteOffset, interleaved.byteLength);

  const fftParamsData = new Uint32Array(FUSED_PARAMS_BYTES / 4);
  fftParamsData[0] = nSymbols;
  device.queue.writeBuffer(fftParamsBuf, 0, fftParamsData.buffer, fftParamsData.byteOffset, fftParamsData.byteLength);
  const tUpload = performance.now();

  const fftBindGroup = device.createBindGroup({
    layout: fftPipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: fftParamsBuf } },
      { binding: 1, resource: { buffer: bufA } },
      { binding: 2, resource: { buffer: bufB } },
    ],
  });

  const encoder = device.createCommandEncoder();
  // One workgroup PER SYMBOL (workgroup_id.x = symbol index) — dispatch
  // nSymbols workgroups, each internally doing all 9 fused stages.
  const fftPass = encoder.beginComputePass();
  fftPass.setPipeline(fftPipeline);
  fftPass.setBindGroup(0, fftBindGroup);
  fftPass.dispatchWorkgroups(nSymbols);
  fftPass.end();

  const gridParamsData = new Uint32Array(GRID_PARAMS_BYTES / 4);
  gridParamsData[0] = params.si0;
  gridParamsData[1] = params.siCount;
  gridParamsData[2] = params.bi0;
  gridParamsData[3] = params.biCount;
  gridParamsData[4] = FFT_N;
  gridParamsData[5] = nSymbols;
  device.queue.writeBuffer(gridParamsBuf, 0, gridParamsData.buffer, gridParamsData.byteOffset, gridParamsData.byteLength);

  const correlationBindGroup = device.createBindGroup({
    layout: correlationPipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: gridParamsBuf } },
      { binding: 1, resource: { buffer: bufB } }, // fused kernel always writes its final result to dst (bufB param)
      { binding: 2, resource: { buffer: strengthBuf } },
    ],
  });

  const totalCells = params.siCount * params.biCount;
  const correlationWorkgroups = Math.ceil(totalCells / 64);
  const corrPass = encoder.beginComputePass();
  corrPass.setPipeline(correlationPipeline);
  corrPass.setBindGroup(0, correlationBindGroup);
  corrPass.dispatchWorkgroups(correlationWorkgroups);
  corrPass.end();

  const readbackBytes = totalCells * 4;
  encoder.copyBufferToBuffer(strengthBuf, 0, readbackBuf, 0, readbackBytes);

  device.queue.submit([encoder.finish()]);
  await device.queue.onSubmittedWorkDone();
  const tDispatch = performance.now();

  await readbackBuf.mapAsync(GPUMapMode.READ, 0, readbackBytes);
  const mapped = readbackBuf.getMappedRange(0, readbackBytes);
  const strengths = new Float32Array(mapped.slice(0));
  readbackBuf.unmap();
  const tReadback = performance.now();

  return {
    strengths,
    siCount: params.siCount,
    biCount: params.biCount,
    si0: params.si0,
    bi0: params.bi0,
    timings: {
      uploadMs: tUpload - t0,
      dispatchMs: tDispatch - tUpload,
      readbackMs: tReadback - tDispatch,
      totalMs: tReadback - t0,
    },
  };
}

export function resetFusedGpuState(): void {
  if (cachedFusedPipeline) {
    cachedFusedPipeline.bufA.destroy();
    cachedFusedPipeline.bufB.destroy();
    cachedFusedPipeline.fftParamsBuf.destroy();
    cachedFusedPipeline.gridParamsBuf.destroy();
    cachedFusedPipeline.strengthBuf.destroy();
    cachedFusedPipeline.readbackBuf.destroy();
    cachedFusedPipeline = null;
  }
}

/** Releases cached GPU resources — call between independent benchmark runs
 *  where nSymbols changes, or to force a clean device state. */
export function resetGpuState(): void {
  if (cachedPipeline) {
    cachedPipeline.bufA.destroy();
    cachedPipeline.bufB.destroy();
    cachedPipeline.fftParamsBufs.forEach(buf => buf.destroy());
    cachedPipeline.gridParamsBuf.destroy();
    cachedPipeline.strengthBuf.destroy();
    cachedPipeline.readbackBuf.destroy();
    cachedPipeline = null;
  }
  if (cachedCorrelationOnly) {
    cachedCorrelationOnly.spectrogramBuf.destroy();
    cachedCorrelationOnly.gridParamsBuf.destroy();
    cachedCorrelationOnly.strengthBuf.destroy();
    cachedCorrelationOnly.readbackBuf.destroy();
    cachedCorrelationOnly = null;
  }
  resetFusedGpuState();
}
