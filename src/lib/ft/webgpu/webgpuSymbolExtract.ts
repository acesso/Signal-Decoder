/// <reference types="@webgpu/types" />
// WebGPU orchestration for symbolExtractFused.wgsl — GPU port of extract()
// (symbolExtract.ts): samples200 + off -> c79 (79x8 complex tone bins), one
// workgroup per candidate, all 79*8 (symbol, bin) DFT evaluations
// independent (see the kernel's own header comment).
//
// NOT wired into the live decode pipeline — standalone, currently-unused
// module, same status as webgpuSearchBoth.ts/webgpuFftGeneral.ts before any
// integration decision.
import symbolExtractWgsl from './symbolExtractFused.wgsl?raw';
import { getDevice } from './webgpuDevice';
import { checkSymbolExtractBufferBudget, SYMBOL_EXTRACT_MAX_SAMPLES_LEN } from './symbolExtractBudget';
import type { Complex } from './dsp';

const WG_SIZE = 256;
const MAX_SAMPLES_LEN = SYMBOL_EXTRACT_MAX_SAMPLES_LEN;
const CANDIDATE_PARAMS_BYTES = 8; // 2x u32/i32 (off, samples_len) -- see WGSL struct CandidateParams

export interface SymbolExtractCandidateInput {
  /** Same samples200 buffer extract() reads from (post-shift200, ~25Hz-
   *  centered baseband). Only the window starting at `off` (up to
   *  MAX_SAMPLES_LEN samples) is actually uploaded per candidate. */
  samples200: Float64Array | Float32Array | number[];
  /** Symbol-0 start sample index into samples200 — same as extract()'s `off`. */
  off: number;
}

interface FlatCandidate {
  offInWindow: number; // off relative to the uploaded window's own start (0 unless off<0, mirroring extract()'s own out-of-range zero-fill via samples_len gating instead)
  samplesLen: number; // count of valid (non-padding) samples in this candidate's window
  samples: Float32Array; // MAX_SAMPLES_LEN samples starting at max(off,0) less any needed left margin -- see buildFlatCandidate
}

/** extract() reads samples200[off + si*32 .. +32) for si in [0,79), i.e.
 *  needs samples in [off, off + 79*32 + 32). Negative indices before `off`
 *  are never read (extract() has no si<0 case), so the uploaded window
 *  simply starts at `off` itself when off>=0; if off<0 (not something
 *  extract()'s own callers produce in practice, but not disallowed by its
 *  signature either) the window still starts at `off`, and samples_len/off
 *  bookkeeping below reproduces extract()'s zero-past-the-end AND
 *  zero-before-the-start behavior (dsp.ts's realFft() zero-fills any index
 *  outside [0, samples200.length), not just past the end) via the same
 *  bounds check the kernel already does against samples_len, applied to a
 *  window that starts at off's OWN position (so idx<0 relative to the
 *  window can still occur and must read as 0, matching realFft()'s `idx <
 *  nSamples ? samples[idx] : 0` — note this does NOT check idx>=0, so
 *  dsp.ts's realFft ALSO silently reads out-of-bounds-negative for a
 *  negative i0; replicated here by never letting the uploaded window imply
 *  wraparound: samples_len covers only the true valid range and the kernel
 *  clamps on both sides). */
function buildFlatCandidate(input: SymbolExtractCandidateInput, samplesLenTotal: number): FlatCandidate {
  const { samples200, off } = input;
  const needed = 79 * 32 + 32;
  if (needed > MAX_SAMPLES_LEN) {
    throw new Error(`buildFlatCandidate: extract() needs ${needed} samples per candidate, exceeding MAX_SAMPLES_LEN=${MAX_SAMPLES_LEN}.`);
  }

  const samples = new Float32Array(MAX_SAMPLES_LEN);
  for (let i = 0; i < MAX_SAMPLES_LEN; i++) {
    const idx = off + i;
    samples[i] = idx >= 0 && idx < samplesLenTotal ? Number(samples200[idx]) : 0;
  }

  return {
    offInWindow: 0, // samples[] already starts at `off` itself
    samplesLen: Math.max(0, Math.min(MAX_SAMPLES_LEN, samplesLenTotal - off)),
    samples,
  };
}

interface PipelineState {
  device: GPUDevice;
  pipeline: GPUComputePipeline;
  maxBatch: number;
  nBatchBuf: GPUBuffer;
  paramsBuf: GPUBuffer;
  samplesBuf: GPUBuffer;
  c79Buf: GPUBuffer;
  readbackBuf: GPUBuffer;
}

let cachedPipeline: PipelineState | null = null;

async function getPipelineState(maxBatch: number): Promise<PipelineState> {
  const device = await getDevice();
  if (cachedPipeline && cachedPipeline.maxBatch >= maxBatch) return cachedPipeline;
  if (cachedPipeline) resetSymbolExtractGpuState();

  const budgetError = checkSymbolExtractBufferBudget(maxBatch, device.limits.maxStorageBufferBindingSize);
  if (budgetError) throw new Error(budgetError);

  const module = device.createShaderModule({ code: symbolExtractWgsl });
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
  const samplesBuf = device.createBuffer({
    size: maxBatch * MAX_SAMPLES_LEN * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  const c79Buf = device.createBuffer({
    size: maxBatch * 79 * 8 * 2 * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });
  const readbackBuf = device.createBuffer({
    size: maxBatch * 79 * 8 * 2 * 4,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });

  cachedPipeline = { device, pipeline, maxBatch, nBatchBuf, paramsBuf, samplesBuf, c79Buf, readbackBuf };
  return cachedPipeline;
}

/** Runs extract() (79x8 complex tone-bin extraction) for a BATCH of
 *  candidates in one dispatch (one workgroup per candidate). Returns each
 *  candidate's c79 as a 79-length array of 8-length Complex arrays, matching
 *  symbolExtract.ts's extract() return shape exactly. */
export async function runSymbolExtractGpu(inputs: SymbolExtractCandidateInput[]): Promise<Complex[][][]> {
  if (inputs.length === 0) return [];

  const state = await getPipelineState(inputs.length);
  const { device, pipeline, nBatchBuf, paramsBuf, samplesBuf, c79Buf, readbackBuf } = state;

  const batch = inputs.length;
  const flats = inputs.map((input) => buildFlatCandidate(input, input.samples200.length));

  const nBatchData = new Uint32Array(4);
  nBatchData[0] = batch;
  device.queue.writeBuffer(nBatchBuf, 0, nBatchData.buffer, nBatchData.byteOffset, nBatchData.byteLength);

  const paramsData = new Int32Array(batch * 2);
  const samplesData = new Float32Array(batch * MAX_SAMPLES_LEN);
  flats.forEach((f, i) => {
    paramsData[i * 2 + 0] = f.offInWindow;
    paramsData[i * 2 + 1] = f.samplesLen;
    samplesData.set(f.samples, i * MAX_SAMPLES_LEN);
  });

  device.queue.writeBuffer(paramsBuf, 0, paramsData.buffer, paramsData.byteOffset, paramsData.byteLength);
  device.queue.writeBuffer(samplesBuf, 0, samplesData.buffer, samplesData.byteOffset, samplesData.byteLength);

  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: nBatchBuf } },
      { binding: 1, resource: { buffer: paramsBuf } },
      { binding: 2, resource: { buffer: samplesBuf } },
      { binding: 3, resource: { buffer: c79Buf } },
    ],
  });

  const encoder = device.createCommandEncoder();
  const pass = encoder.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.dispatchWorkgroups(batch);
  pass.end();

  const bytes = batch * 79 * 8 * 2 * 4;
  encoder.copyBufferToBuffer(c79Buf, 0, readbackBuf, 0, bytes);

  device.queue.submit([encoder.finish()]);
  await device.queue.onSubmittedWorkDone();

  await readbackBuf.mapAsync(GPUMapMode.READ, 0, bytes);
  const mapped = readbackBuf.getMappedRange(0, bytes);
  const result = new Float32Array(mapped.slice(0));
  readbackBuf.unmap();

  const out: Complex[][][] = new Array(batch);
  for (let c = 0; c < batch; c++) {
    const base = c * 79 * 8 * 2;
    const m79: Complex[][] = new Array(79);
    for (let si = 0; si < 79; si++) {
      const row: Complex[] = new Array(8);
      for (let bi = 0; bi < 8; bi++) {
        const idx = base + (si * 8 + bi) * 2;
        row[bi] = [result[idx], result[idx + 1]];
      }
      m79[si] = row;
    }
    out[c] = m79;
  }
  return out;
}

export function resetSymbolExtractGpuState(): void {
  if (cachedPipeline) {
    cachedPipeline.nBatchBuf.destroy();
    cachedPipeline.paramsBuf.destroy();
    cachedPipeline.samplesBuf.destroy();
    cachedPipeline.c79Buf.destroy();
    cachedPipeline.readbackBuf.destroy();
    cachedPipeline = null;
  }
}

export const SYMBOL_EXTRACT_WG_SIZE = WG_SIZE;
export { checkSymbolExtractBufferBudget } from './symbolExtractBudget';
