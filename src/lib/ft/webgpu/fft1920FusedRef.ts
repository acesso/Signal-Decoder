// Plain-TS reference for fft1920Fused.wgsl's fused-single-dispatch
// algorithm (workgroup-shared ping-pong across all 9 Stockham stages,
// WG_SIZE-bounded loop per stage instead of one-invocation-per-element) —
// used to verify the fused kernel's indexing/barrier-equivalent structure
// matches the already-proven fft1920.ts stage-by-stage reference exactly,
// since a real GPU can't be exercised from this environment. A single-
// threaded for-loop over all WG_SIZE "invocations" per stage, run fully to
// completion before the next stage starts, is the correct simulation of a
// real workgroupBarrier() — every invocation finishes stage N before any
// invocation starts stage N+1, same guarantee the GPU barrier provides.
import { FFT_N } from './fft1920';

const WG_SIZE = 256;
const STAGE_RADIX = [2, 2, 2, 2, 2, 2, 2, 3, 5] as const;
const STAGE_STRIDE_IN = [1, 2, 4, 8, 16, 32, 64, 128, 384] as const;
const STAGE_STRIDE_OUT = [2, 4, 8, 16, 32, 64, 128, 384, 1920] as const;

function twiddle(k: number, n: number): [number, number] {
  const theta = (-2 * Math.PI * k) / n;
  return [Math.cos(theta), Math.sin(theta)];
}
function cmul(a: [number, number], b: [number, number]): [number, number] {
  return [a[0] * b[0] - a[1] * b[1], a[0] * b[1] + a[1] * b[0]];
}
function cadd(a: [number, number], b: [number, number]): [number, number] {
  return [a[0] + b[0], a[1] + b[1]];
}
function csub(a: [number, number], b: [number, number]): [number, number] {
  return [a[0] - b[0], a[1] - b[1]];
}

const R3_S = 0.8660254037844387;
function radix3(a0: [number, number], a1: [number, number], a2: [number, number]) {
  const t1 = cadd(a1, a2);
  const t2: [number, number] = [a0[0] - 0.5 * t1[0], a0[1] - 0.5 * t1[1]];
  const t3: [number, number] = [R3_S * (a1[1] - a2[1]), R3_S * (a2[0] - a1[0])];
  return [cadd(a0, t1), cadd(t2, t3), csub(t2, t3)];
}

const R5_C1 = 0.30901699437494745;
const R5_S1 = 0.9510565162951535;
const R5_C2 = -0.8090169943749475;
const R5_S2 = 0.5877852522924731;
function radix5(
  a0: [number, number], a1: [number, number], a2: [number, number],
  a3: [number, number], a4: [number, number],
) {
  const out: Array<[number, number]> = new Array(5);
  out[0] = [a0[0] + a1[0] + a2[0] + a3[0] + a4[0], a0[1] + a1[1] + a2[1] + a3[1] + a4[1]];
  const b1 = cadd(a1, a4), b2 = cadd(a2, a3), b3 = csub(a1, a4), b4 = csub(a2, a3);
  const re1 = a0[0] + R5_C1 * b1[0] + R5_C2 * b2[0];
  const re2 = a0[0] + R5_C2 * b1[0] + R5_C1 * b2[0];
  const im1 = a0[1] + R5_C1 * b1[1] + R5_C2 * b2[1];
  const im2 = a0[1] + R5_C2 * b1[1] + R5_C1 * b2[1];
  const ix1 = R5_S1 * b3[0] + R5_S2 * b4[0];
  const ix2 = R5_S2 * b3[0] - R5_S1 * b4[0];
  const iy1 = R5_S1 * b3[1] + R5_S2 * b4[1];
  const iy2 = R5_S2 * b3[1] - R5_S1 * b4[1];
  out[4] = [re1 - iy1, im1 + ix1];
  out[1] = [re1 + iy1, im1 - ix1];
  out[3] = [re2 - iy2, im2 + ix2];
  out[2] = [re2 + iy2, im2 - ix2];
  return out;
}

/** Simulates ONE workgroup's fused 9-stage FFT for a single symbol's
 *  interleaved [re,im,...] input (length FFT_N*2). Does not mutate input. */
export function fft1920Fused(inputInterleaved: Float64Array): Float64Array {
  if (inputInterleaved.length !== FFT_N * 2) {
    throw new Error(`fft1920Fused: expected ${FFT_N * 2} interleaved values, got ${inputInterleaved.length}`);
  }

  let bufA: Array<[number, number]> = new Array(FFT_N);
  let bufB: Array<[number, number]> = new Array(FFT_N);
  for (let i = 0; i < FFT_N; i++) bufA[i] = [inputInterleaved[i * 2], inputInterleaved[i * 2 + 1]];

  let useAAsSrc = true;

  for (let stage = 0; stage < 9; stage++) {
    const radix = STAGE_RADIX[stage];
    const strideIn = STAGE_STRIDE_IN[stage];
    const strideOut = STAGE_STRIDE_OUT[stage];
    const groups = FFT_N / strideOut;
    const perSymbolThreads = strideIn * groups;
    const src = useAAsSrc ? bufA : bufB;
    const dst = useAAsSrc ? bufB : bufA;

    for (let tid = 0; tid < WG_SIZE; tid++) {
      for (let idx = tid; idx < perSymbolThreads; idx += WG_SIZE) {
        const j = idx % strideIn;
        const block = Math.floor(idx / strideIn);

        if (radix === 2) {
          const i0 = j + block * strideIn;
          const i1 = i0 + groups * strideIn;
          const w1 = twiddle(j, strideOut);
          const a0 = src[i0];
          const a1 = cmul(src[i1], w1);
          const o0 = block * strideOut + j;
          dst[o0] = cadd(a0, a1);
          dst[o0 + strideIn] = csub(a0, a1);
        } else if (radix === 3) {
          const i0 = j + block * strideIn;
          const i1 = i0 + groups * strideIn;
          const i2 = i1 + groups * strideIn;
          const w1 = twiddle(j, strideOut);
          const w2 = twiddle(j * 2, strideOut);
          const a0 = src[i0], a1 = cmul(src[i1], w1), a2 = cmul(src[i2], w2);
          const out = radix3(a0, a1, a2);
          const base = block * strideOut + j;
          dst[base] = out[0];
          dst[base + strideIn] = out[1];
          dst[base + 2 * strideIn] = out[2];
        } else {
          const i0 = j + block * strideIn;
          const i1 = i0 + groups * strideIn;
          const i2 = i1 + groups * strideIn;
          const i3 = i2 + groups * strideIn;
          const i4 = i3 + groups * strideIn;
          const w1 = twiddle(j, strideOut);
          const w2 = twiddle(j * 2, strideOut);
          const w3 = twiddle(j * 3, strideOut);
          const w4 = twiddle(j * 4, strideOut);
          const a0 = src[i0], a1 = cmul(src[i1], w1), a2 = cmul(src[i2], w2), a3 = cmul(src[i3], w3), a4 = cmul(src[i4], w4);
          const out = radix5(a0, a1, a2, a3, a4);
          const base = block * strideOut + j;
          dst[base] = out[0];
          dst[base + strideIn] = out[1];
          dst[base + 2 * strideIn] = out[2];
          dst[base + 3 * strideIn] = out[3];
          dst[base + 4 * strideIn] = out[4];
        }
      }
    }

    useAAsSrc = !useAAsSrc;
  }

  const final = useAAsSrc ? bufA : bufB;
  const out = new Float64Array(FFT_N * 2);
  for (let i = 0; i < FFT_N; i++) {
    out[i * 2] = final[i][0];
    out[i * 2 + 1] = final[i][1];
  }
  return out;
}
