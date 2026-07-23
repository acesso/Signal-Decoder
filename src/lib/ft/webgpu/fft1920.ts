// Mixed-radix Stockham FFT for N=1920 (= 2^7 * 3 * 5), matching ft8mon's
// exact symbol-block size (lib/ft8mon/fft.cc's one_fft()/ffts()) so
// coarse-search candidates line up bin-for-bin with the existing WASM
// decoder. This module is the plain-TS reference implementation — same
// stride/twiddle math as webgpu/fft1920.wgsl — used both as a Jest-testable
// correctness oracle (jsdom has no WebGPU) and as the CPU-computed-spectrogram
// path for comparing against the GPU-computed one.
//
// Complex values are represented as interleaved [re0, im0, re1, im1, ...]
// Float64Array pairs to keep this allocation-cheap and directly comparable
// to the GPU's flat vec2<f32> storage buffer layout.

export const FFT_N = 1920;
export const FFT_FACTORS = [2, 2, 2, 2, 2, 2, 2, 3, 5] as const;

export interface FftPass {
  radix: number;
  strideIn: number; // "L" — elements already combined before this pass
  strideOut: number; // "L * radix"
}

/** The fixed 9-pass radix schedule for N=1920 — same order the WGSL
 *  dispatcher issues its 9 compute passes in. */
export function buildPassSchedule(): FftPass[] {
  const passes: FftPass[] = [];
  let strideIn = 1;
  for (const radix of FFT_FACTORS) {
    const strideOut = strideIn * radix;
    passes.push({ radix, strideIn, strideOut });
    strideIn = strideOut;
  }
  return passes;
}

function twiddle(k: number, n: number): [number, number] {
  const theta = (-2 * Math.PI * k) / n;
  return [Math.cos(theta), Math.sin(theta)];
}

/** Reference (non-GPU) Stockham FFT, operating on interleaved [re,im,...]
 *  Float64Arrays of length 2*FFT_N. Returns a new array; does not mutate
 *  input. Mirrors fft1920.wgsl's per-pass indexing exactly. */
export function fft1920(inputInterleaved: Float64Array): Float64Array {
  if (inputInterleaved.length !== FFT_N * 2) {
    throw new Error(`fft1920: expected ${FFT_N * 2} interleaved values, got ${inputInterleaved.length}`);
  }
  // Copy rather than alias inputInterleaved directly into the src/dst
  // ping-pong: after stage 0's [src, dst] = [dst, src] swap, whatever `src`
  // pointed to becomes stage 1's WRITE target — aliasing the caller's own
  // array here would silently overwrite it from stage 1 onward. Every
  // current call site happens to pass a freshly-allocated, never-reused
  // buffer (so this had no visible effect on any real result), but it's a
  // real mutate-your-input hazard for any future caller.
  let src: Float64Array<ArrayBufferLike> = inputInterleaved.slice();
  let dst: Float64Array<ArrayBufferLike> = new Float64Array(FFT_N * 2);

  for (const { radix: r, strideIn, strideOut } of buildPassSchedule()) {
    const groups = FFT_N / strideOut;
    for (let block = 0; block < groups; block++) {
      for (let j = 0; j < strideIn; j++) {
        const legs: Array<[number, number]> = new Array(r);
        for (let t = 0; t < r; t++) {
          const idx = j + block * strideIn + t * groups * strideIn;
          const re = src[idx * 2];
          const im = src[idx * 2 + 1];
          const [wc, ws] = twiddle(j * t, strideOut);
          legs[t] = [re * wc - im * ws, re * ws + im * wc];
        }
        const out = radixButterfly(legs, r);
        const base = block * strideOut + j;
        for (let s = 0; s < r; s++) {
          const outIdx = base + s * strideIn;
          dst[outIdx * 2] = out[s][0];
          dst[outIdx * 2 + 1] = out[s][1];
        }
      }
    }
    [src, dst] = [dst, src];
  }
  return src;
}

function radixButterfly(legs: Array<[number, number]>, r: number): Array<[number, number]> {
  if (r === 2) return radix2(legs[0], legs[1]);
  if (r === 3) return radix3(legs[0], legs[1], legs[2]);
  if (r === 5) return radix5(legs[0], legs[1], legs[2], legs[3], legs[4]);
  throw new Error(`fft1920: unsupported radix ${r}`);
}

function radix2(a0: [number, number], a1: [number, number]): Array<[number, number]> {
  return [
    [a0[0] + a1[0], a0[1] + a1[1]],
    [a0[0] - a1[0], a0[1] - a1[1]],
  ];
}

const R3_S = 0.8660254037844387; // sin(2*pi/3)

function radix3(a0: [number, number], a1: [number, number], a2: [number, number]): Array<[number, number]> {
  const t1: [number, number] = [a1[0] + a2[0], a1[1] + a2[1]];
  const t2: [number, number] = [a0[0] - 0.5 * t1[0], a0[1] - 0.5 * t1[1]];
  const t3: [number, number] = [R3_S * (a1[1] - a2[1]), R3_S * (a2[0] - a1[0])];
  return [
    [a0[0] + t1[0], a0[1] + t1[1]],
    [t2[0] + t3[0], t2[1] + t3[1]],
    [t2[0] - t3[0], t2[1] - t3[1]],
  ];
}

const R5_C1 = 0.30901699437494745; // cos(2*pi/5)
const R5_S1 = 0.9510565162951535; // sin(2*pi/5)
const R5_C2 = -0.8090169943749475; // cos(4*pi/5)
const R5_S2 = 0.5877852522924731; // sin(4*pi/5)

function radix5(
  a0: [number, number], a1: [number, number], a2: [number, number],
  a3: [number, number], a4: [number, number],
): Array<[number, number]> {
  const out: Array<[number, number]> = new Array(5);
  out[0] = [a0[0] + a1[0] + a2[0] + a3[0] + a4[0], a0[1] + a1[1] + a2[1] + a3[1] + a4[1]];

  const b1: [number, number] = [a1[0] + a4[0], a1[1] + a4[1]];
  const b2: [number, number] = [a2[0] + a3[0], a2[1] + a3[1]];
  const b3: [number, number] = [a1[0] - a4[0], a1[1] - a4[1]];
  const b4: [number, number] = [a2[0] - a3[0], a2[1] - a3[1]];

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
