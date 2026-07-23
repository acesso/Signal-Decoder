/// <reference types="@webgpu/types" />
// WebGPU orchestration for softDecodeFused.wgsl + CPU-side finishing step —
// GPU-accelerated replacement for cSoftDecode() (softDecode.ts). See
// softDecodeFused.wgsl's own header for the exact 3-phase GPU split; see
// finishSoftDecodeCpu() below for what's deliberately left on the CPU and
// why.
//
// NOT wired into the live decode pipeline — standalone, currently-unused
// module, same status as webgpuSearchBoth.ts/webgpuSymbolExtract.ts.
//
// SPLIT DECISION (task doc's option (b), chosen deliberately): the GPU
// kernel does the EXPENSIVE, per-symbol/per-tone-parallel work (632 tone
// values' worth of SNR normalization + neighbor-distance sums — the actual
// per-candidate cost this task exists to remove from the CPU). The CPU does
// makeStats() (mean/stddev over ~632+174 numbers, cheap) and bayes() (per-
// bit Bayes combining using those stats, also cheap — 58 bits x a handful
//   of arithmetic ops each). Reasons this split was chosen over doing
// everything in-shader:
//   1) makeStats() is a genuine GLOBAL reduction (needs the full sum across
//      all 632 `all` values and up to 79 `bests` values before either
//      Gaussian's mean/stddev is known) — the task doc's own analysis
//      already flags this as the single real correctness-risk multiplier of
//      this whole task, and explicitly suggests a serial CPU scan is a
//      defensible simpler alternative to an in-shader tree/serial reduction
//      given the tiny (632-element) data size.
//   2) bayes() needs erf() (Abramowitz-Stegun polynomial approximation) —
//      WGSL has no native erf, so doing this in-shader means a fresh polynomial
//      port, a whole new class of possible transcription bugs (this task
//      already found one in its OWN Blackman-window constant table — see
//      softDecodeFused.wgsl's header — for a much SIMPLER closed form than
//      erf's 5-term polynomial-times-exp).
//   3) The actual COST of makeStats+bayes is tiny (summing/dividing ~800
//      numbers, computing erf ~116 times) — nowhere near the 632-element
//      FFT-adjacent distance-sum work the GPU kernel already offloads. Per
//      the task doc's own framing: "not everything needs to be on the GPU."
//      Keeping this step in JS is lower-risk (reuses softDecode.ts's own
//      already-proven makeStats/bayes/erf/unGrayCodeR code verbatim, via a
//      small currently-duplicated port here since softDecode.ts itself is
//      read-only/not-importable-for-mutation per the task's constraints —
//      see below) with no measurable throughput cost, since it runs ONCE
//      per candidate on ~800 numbers, dwarfed by the GPU dispatch/readback
//      round-trip itself.
//
// Because softDecode.ts is READ-ONLY (task constraint — it's the proven
// CPU reference these new files are verified against, not a shared
// dependency to import internals from), makeStats()/bayes()/erf()/
// unGrayCodeR()/APRIORI174 are re-declared here rather than imported —
// small, mechanical, low-risk code per the task doc's own risk framing, and
// keeping this module import-independent of softDecode.ts also means nobody
// can accidentally create a cyclic or fragile coupling between "the CPU
// reference" and "the GPU-accelerated replacement being verified against
// it".
import softDecodeWgsl from './softDecodeFused.wgsl?raw';
import { getDevice } from './webgpuDevice';
import { checkSoftDecodeWorkgroupBudget } from './softDecodeBudget';
import type { Complex } from './dsp';

const WG_SIZE = 256;
const COSTAS = [3, 1, 4, 0, 6, 5, 2] as const;
const USE_APRIORI = true;
const BAYES_HOW = 1;
const MAXLOG = 4.97;

const APRIORI174 = [
  0.47, 0.32, 0.29, 0.37, 0.52, 0.36, 0.40, 0.42, 0.42, 0.53, 0.44,
  0.44, 0.39, 0.46, 0.39, 0.38, 0.42, 0.43, 0.45, 0.51, 0.42, 0.48,
  0.31, 0.45, 0.47, 0.53, 0.59, 0.41, 0.03, 0.50, 0.30, 0.26, 0.40,
  0.65, 0.34, 0.49, 0.46, 0.49, 0.69, 0.40, 0.45, 0.45, 0.60, 0.46,
  0.43, 0.49, 0.56, 0.45, 0.55, 0.51, 0.46, 0.37, 0.55, 0.52, 0.56,
  0.55, 0.50, 0.01, 0.19, 0.70, 0.88, 0.75, 0.75, 0.74, 0.73, 0.18,
  0.71, 0.35, 0.60, 0.58, 0.36, 0.60, 0.38, 0.50, 0.02, 0.01, 0.98,
  0.48, 0.49, 0.54, 0.50, 0.49, 0.53, 0.50, 0.49, 0.49, 0.51, 0.51,
  0.51, 0.47, 0.50, 0.53, 0.51, 0.46, 0.51, 0.51, 0.48, 0.51, 0.52,
  0.50, 0.52, 0.51, 0.50, 0.49, 0.53, 0.52, 0.50, 0.46, 0.47, 0.48,
  0.52, 0.50, 0.49, 0.51, 0.49, 0.49, 0.50, 0.50, 0.50, 0.50, 0.51,
  0.50, 0.49, 0.49, 0.55, 0.49, 0.51, 0.48, 0.55, 0.49, 0.48, 0.50,
  0.51, 0.50, 0.51, 0.50, 0.51, 0.53, 0.49, 0.54, 0.50, 0.48, 0.49,
  0.46, 0.51, 0.51, 0.52, 0.49, 0.51, 0.49, 0.51, 0.50, 0.49, 0.50,
  0.50, 0.47, 0.49, 0.52, 0.49, 0.51, 0.49, 0.48, 0.52, 0.48, 0.49,
  0.47, 0.50, 0.48, 0.50, 0.49, 0.51, 0.51, 0.51, 0.49,
];
if (APRIORI174.length !== 174) throw new Error(`APRIORI174 must have 174 entries, got ${APRIORI174.length}`);

const UNGRAY_MAP = [0, 1, 3, 2, 6, 4, 5, 7];

class GaussianStats {
  private values: number[] = [];
  private sum = 0;
  private finalized = false;
  private meanVal = 0;
  private stddevVal = 0;

  add(x: number): void {
    this.values.push(x);
    this.sum += x;
    this.finalized = false;
  }

  private finalize(): void {
    this.finalized = true;
    const n = this.values.length;
    this.meanVal = this.sum / n;
    let variance = 0;
    for (const v of this.values) {
      const y = v - this.meanVal;
      variance += y * y;
    }
    variance /= n;
    this.stddevVal = Math.sqrt(variance);
  }

  mean(): number {
    if (!this.finalized) this.finalize();
    return this.meanVal;
  }

  problt(x: number): number {
    if (!this.finalized) this.finalize();
    const sds = (x - this.meanVal) / this.stddevVal;
    return 0.5 * (1.0 + erf(sds / Math.sqrt(2.0)));
  }
}

function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const t = 1.0 / (1.0 + p * x);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return sign * y;
}

function makeStats(m79Mag: number[][]): { bests: GaussianStats; all: GaussianStats } {
  const bests = new GaussianStats();
  const all = new GaussianStats();

  for (let si = 0; si < 79; si++) {
    if (si < 7 || (si >= 36 && si < 36 + 7) || si >= 72) {
      const ci = si >= 72 ? si - 72 : si >= 36 ? si - 36 : si;
      for (let bi = 0; bi < 8; bi++) {
        const x = m79Mag[si][bi];
        all.add(x);
        if (bi === COSTAS[ci]) bests.add(x);
      }
    } else {
      let mx = 0;
      for (let bi = 0; bi < 8; bi++) {
        const x = m79Mag[si][bi];
        if (x > mx) mx = x;
        all.add(x);
      }
      bests.add(mx);
    }
  }
  return { bests, all };
}

function bayes(bestZero: number, bestOne: number, lli: number, bests: GaussianStats, all: GaussianStats): number {
  let pzero = 0.5;
  let pone = 0.5;
  if (USE_APRIORI) {
    pzero = 1.0 - APRIORI174[lli];
    pone = APRIORI174[lli];
  }

  let a = pzero * bests.problt(bestZero) * (1.0 - all.problt(bestOne));
  if (BAYES_HOW === 1) a *= all.problt(all.mean() + (bestZero - bestOne));

  let b = pone * bests.problt(bestOne) * (1.0 - all.problt(bestZero));
  if (BAYES_HOW === 1) b *= all.problt(all.mean() + (bestOne - bestZero));

  let p: number;
  if (a + b === 0) p = 0.5;
  else p = a / (a + b);

  let ll: number;
  if (1 - p === 0.0) ll = MAXLOG;
  else ll = Math.log(p / (1 - p));

  if (ll > MAXLOG) ll = MAXLOG;
  if (ll < -MAXLOG) ll = -MAXLOG;
  return ll;
}

function unGrayCodeR(m79: number[][]): number[][] {
  const out: number[][] = new Array(79);
  for (let si = 0; si < 79; si++) {
    const row = new Array(8);
    for (let bi = 0; bi < 8; bi++) row[UNGRAY_MAP[bi]] = m79[si][bi];
    out[si] = row;
  }
  return out;
}

/** CPU-side finishing step: given the GPU kernel's m79Soft[79][8] output,
 *  runs makeStats() + un-gray-code + bayes() to produce the final ll174 —
 *  bit-for-bit the same math as cSoftDecode()'s own tail (from `const {
 *  bests, all } = makeStats(m79);` onward), just re-declared here per this
 *  module's own header comment (softDecode.ts is read-only). */
function finishSoftDecodeCpu(m79Soft: number[][]): Float64Array {
  const { bests, all } = makeStats(m79Soft);
  const m79u = unGrayCodeR(m79Soft);

  const ll174 = new Float64Array(174);
  let lli = 0;
  for (let i79 = 0; i79 < 79; i79++) {
    if (i79 < 7 || (i79 >= 36 && i79 < 36 + 7) || i79 >= 72) continue;

    for (let biti = 0; biti < 3; biti++) {
      let zeroi: number[], onei: number[];
      if (biti === 0) { zeroi = [0, 1, 2, 3]; onei = [4, 5, 6, 7]; }
      else if (biti === 1) { zeroi = [0, 1, 4, 5]; onei = [2, 3, 6, 7]; }
      else { zeroi = [0, 2, 4, 6]; onei = [1, 3, 5, 7]; }

      let bestZero = -Infinity;
      for (const zi of zeroi) if (m79u[i79][zi] > bestZero) bestZero = m79u[i79][zi];
      let bestOne = -Infinity;
      for (const oi of onei) if (m79u[i79][oi] > bestOne) bestOne = m79u[i79][oi];

      ll174[lli] = bayes(bestZero, bestOne, lli, bests, all);
      lli++;
    }
  }

  return ll174;
}

interface PipelineState {
  device: GPUDevice;
  pipeline: GPUComputePipeline;
  maxBatch: number;
  nBatchBuf: GPUBuffer;
  c79Buf: GPUBuffer;
  m79SoftBuf: GPUBuffer;
  maxesBuf: GPUBuffer;
  m79SoftReadback: GPUBuffer;
}

let cachedPipeline: PipelineState | null = null;

async function getPipelineState(maxBatch: number): Promise<PipelineState> {
  const device = await getDevice();
  if (cachedPipeline && cachedPipeline.maxBatch >= maxBatch) return cachedPipeline;
  if (cachedPipeline) resetSoftDecodeGpuState();

  const budgetError = checkSoftDecodeWorkgroupBudget(device.limits.maxComputeWorkgroupStorageSize);
  if (budgetError) throw new Error(budgetError);

  const module = device.createShaderModule({ code: softDecodeWgsl });
  const pipeline = device.createComputePipeline({
    layout: 'auto',
    compute: { module, entryPoint: 'main' },
  });

  const nBatchBuf = device.createBuffer({
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const c79Buf = device.createBuffer({
    size: maxBatch * 79 * 8 * 2 * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  const m79SoftBuf = device.createBuffer({
    size: maxBatch * 79 * 8 * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });
  const maxesBuf = device.createBuffer({
    size: maxBatch * 79 * 2 * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });
  const m79SoftReadback = device.createBuffer({
    size: maxBatch * 79 * 8 * 4,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });

  cachedPipeline = { device, pipeline, maxBatch, nBatchBuf, c79Buf, m79SoftBuf, maxesBuf, m79SoftReadback };
  return cachedPipeline;
}

/** Runs the GPU-accelerated replacement for cSoftDecode() on a BATCH of
 *  candidates: softDecodeFused.wgsl computes the expensive per-symbol/
 *  per-tone SNR-normalization + neighbor-distance-sum work (m79Soft), then
 *  finishSoftDecodeCpu() runs the cheap global-stats + Bayes finishing step
 *  on the CPU (see this module's header for why). Input is each
 *  candidate's raw c79 (79x8 Complex, e.g. from runSymbolExtractGpu or
 *  extract()); output is each candidate's final 174-element ll174. */
export async function runSoftDecodeGpu(c79Batch: Complex[][][]): Promise<Float64Array[]> {
  if (c79Batch.length === 0) return [];

  const batch = c79Batch.length;
  const state = await getPipelineState(batch);
  const { device, pipeline, nBatchBuf, c79Buf, m79SoftBuf, m79SoftReadback } = state;

  const nBatchData = new Uint32Array(4);
  nBatchData[0] = batch;
  device.queue.writeBuffer(nBatchBuf, 0, nBatchData.buffer, nBatchData.byteOffset, nBatchData.byteLength);

  const c79Data = new Float32Array(batch * 79 * 8 * 2);
  c79Batch.forEach((m79, c) => {
    if (m79.length !== 79) throw new Error(`runSoftDecodeGpu: candidate ${c} has ${m79.length} symbols, expected 79`);
    for (let si = 0; si < 79; si++) {
      if (m79[si].length !== 8) throw new Error(`runSoftDecodeGpu: candidate ${c} symbol ${si} has ${m79[si].length} tones, expected 8`);
      for (let bi = 0; bi < 8; bi++) {
        const idx = (c * 79 * 8 + si * 8 + bi) * 2;
        c79Data[idx] = m79[si][bi][0];
        c79Data[idx + 1] = m79[si][bi][1];
      }
    }
  });
  device.queue.writeBuffer(c79Buf, 0, c79Data.buffer, c79Data.byteOffset, c79Data.byteLength);

  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: nBatchBuf } },
      { binding: 1, resource: { buffer: c79Buf } },
      { binding: 2, resource: { buffer: m79SoftBuf } },
      { binding: 3, resource: { buffer: state.maxesBuf } },
    ],
  });

  const encoder = device.createCommandEncoder();
  const pass = encoder.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.dispatchWorkgroups(batch);
  pass.end();

  const bytes = batch * 79 * 8 * 4;
  encoder.copyBufferToBuffer(m79SoftBuf, 0, m79SoftReadback, 0, bytes);

  device.queue.submit([encoder.finish()]);
  await device.queue.onSubmittedWorkDone();

  await m79SoftReadback.mapAsync(GPUMapMode.READ, 0, bytes);
  const mapped = m79SoftReadback.getMappedRange(0, bytes);
  const m79SoftFlat = new Float32Array(mapped.slice(0));
  m79SoftReadback.unmap();

  const out: Float64Array[] = new Array(batch);
  for (let c = 0; c < batch; c++) {
    const m79Soft: number[][] = new Array(79);
    for (let si = 0; si < 79; si++) {
      const row = new Array(8);
      for (let bi = 0; bi < 8; bi++) row[bi] = m79SoftFlat[c * 79 * 8 + si * 8 + bi];
      m79Soft[si] = row;
    }
    out[c] = finishSoftDecodeCpu(m79Soft);
  }
  return out;
}

export function resetSoftDecodeGpuState(): void {
  if (cachedPipeline) {
    cachedPipeline.nBatchBuf.destroy();
    cachedPipeline.c79Buf.destroy();
    cachedPipeline.m79SoftBuf.destroy();
    cachedPipeline.maxesBuf.destroy();
    cachedPipeline.m79SoftReadback.destroy();
    cachedPipeline = null;
  }
}

export const SOFT_DECODE_WG_SIZE = WG_SIZE;
export { checkSoftDecodeWorkgroupBudget } from './softDecodeBudget';
