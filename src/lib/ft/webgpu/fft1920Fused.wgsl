// Fused single-dispatch variant of fft1920.wgsl: instead of 9 separate
// dispatches (one per Stockham radix stage, round-tripping through a
// storage buffer between each), ONE WORKGROUP computes an ENTIRE 1920-point
// FFT internally, using workgroup-shared memory as the ping-pong buffer and
// workgroupBarrier() to synchronize between the 9 stages — no storage
// round-trip until the very end. One workgroup per symbol; multiple
// symbols' workgroups run in parallel across the dispatch.
//
// This exists because the earlier (unfused) benchmark showed GPU coarse
// search was dominated by fixed dispatch/readback overhead (~100ms) rather
// than compute time at single-15s-window scale — 9 dispatches per window
// means 9x that per-dispatch overhead. Fusing into 1 dispatch removes 8 of
// those 9 overhead payments. Whether this actually helps in practice
// depends on whether per-dispatch overhead is truly per-dispatch-call or
// more about total submitted work — see the benchmark script for the
// measured comparison against the unfused fft1920.wgsl.
//
// Correctness rests on the SAME verified stride/twiddle/butterfly math as
// fft1920.wgsl/fft1920.ts (naive-DFT-verified at N=1920, cross-checked
// against real ft8mon output) — only the dispatch/synchronization
// structure differs, not the algorithm.
//
// WGSL limits respected: workgroup storage 1920 * 8 bytes (vec2<f32>) =
// 15360 bytes, under the guaranteed-minimum 16384-byte
// maxComputeWorkgroupStorageSize. Workgroup size 256, under the
// guaranteed-minimum 256 maxComputeInvocationsPerWorkgroup — each
// invocation loops up to 4 times per stage to cover all needed butterflies
// (960 max threads-needed / 256 = ceil 4), per the verified WGSL uniformity
// rule: workgroupBarrier() must be reached by ALL invocations
// unconditionally (no early `return` before a barrier) — this kernel masks
// out-of-range work internally with `if` guards around the actual
// computation, never around the barrier calls themselves.

struct FusedParams {
  n_symbols: u32,
  _pad0: u32,
  _pad1: u32,
  _pad2: u32,
}

@group(0) @binding(0) var<uniform> params: FusedParams;
@group(0) @binding(1) var<storage, read> src: array<vec2<f32>>;
@group(0) @binding(2) var<storage, read_write> dst: array<vec2<f32>>;

const N: u32 = 1920u;
const WG_SIZE: u32 = 256u;
const TWO_PI: f32 = 6.283185307179586;
const NUM_STAGES: u32 = 9u;

// Fixed radix schedule (1920 = 2^7 * 3 * 5), same order as
// fft1920.ts's buildPassSchedule() — baked in as constants since WGSL has
// no way to loop over a host-provided array of distinct per-stage radixes
// with different fixed-size butterfly code per radix.
const STAGE_RADIX = array<u32, NUM_STAGES>(2u, 2u, 2u, 2u, 2u, 2u, 2u, 3u, 5u);
const STAGE_STRIDE_IN = array<u32, NUM_STAGES>(1u, 2u, 4u, 8u, 16u, 32u, 64u, 128u, 384u);
const STAGE_STRIDE_OUT = array<u32, NUM_STAGES>(2u, 4u, 8u, 16u, 32u, 64u, 128u, 384u, 1920u);

var<workgroup> buf_a: array<vec2<f32>, N>;
var<workgroup> buf_b: array<vec2<f32>, N>;

fn c_mul(a: vec2<f32>, b: vec2<f32>) -> vec2<f32> {
  return vec2<f32>(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x);
}

fn twiddle(k: u32, n: u32) -> vec2<f32> {
  let theta = -TWO_PI * f32(k) / f32(n);
  return vec2<f32>(cos(theta), sin(theta));
}

const R3_S: f32 = 0.8660254037844387;

fn radix3(a0: vec2<f32>, a1: vec2<f32>, a2: vec2<f32>) -> array<vec2<f32>, 3> {
  let t1 = a1 + a2;
  let t2 = a0 - 0.5 * t1;
  let t3 = R3_S * vec2<f32>(a1.y - a2.y, a2.x - a1.x);
  var out: array<vec2<f32>, 3>;
  out[0] = a0 + t1;
  out[1] = t2 + t3;
  out[2] = t2 - t3;
  return out;
}

const R5_C1: f32 = 0.30901699437494745;
const R5_S1: f32 = 0.9510565162951535;
const R5_C2: f32 = -0.8090169943749475;
const R5_S2: f32 = 0.5877852522924731;

fn radix5(a0: vec2<f32>, a1: vec2<f32>, a2: vec2<f32>, a3: vec2<f32>, a4: vec2<f32>) -> array<vec2<f32>, 5> {
  var out: array<vec2<f32>, 5>;
  out[0] = a0 + a1 + a2 + a3 + a4;
  let b1 = a1 + a4;
  let b2 = a2 + a3;
  let b3 = a1 - a4;
  let b4 = a2 - a3;
  let re1 = a0.x + R5_C1 * b1.x + R5_C2 * b2.x;
  let re2 = a0.x + R5_C2 * b1.x + R5_C1 * b2.x;
  let im1 = a0.y + R5_C1 * b1.y + R5_C2 * b2.y;
  let im2 = a0.y + R5_C2 * b1.y + R5_C1 * b2.y;
  let ix1 = R5_S1 * b3.x + R5_S2 * b4.x;
  let ix2 = R5_S2 * b3.x - R5_S1 * b4.x;
  let iy1 = R5_S1 * b3.y + R5_S2 * b4.y;
  let iy2 = R5_S2 * b3.y - R5_S1 * b4.y;
  out[4] = vec2<f32>(re1 - iy1, im1 + ix1);
  out[1] = vec2<f32>(re1 + iy1, im1 - ix1);
  out[3] = vec2<f32>(re2 - iy2, im2 + ix2);
  out[2] = vec2<f32>(re2 + iy2, im2 - ix2);
  return out;
}

// One workgroup per symbol (workgroup_id.x = symbol index). Invocations
// within the workgroup loop over multiple butterfly-group elements per
// stage since WG_SIZE=256 < the largest stage's 960 threads-needed.
@compute @workgroup_size(WG_SIZE)
fn main(@builtin(workgroup_id) wg_id: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
  let symbol_idx = wg_id.x;
  if (symbol_idx >= params.n_symbols) {
    // Safe to return here (before any barrier): this guard is UNIFORM
    // across the whole workgroup (wg_id.x is the same for every invocation
    // in this workgroup), not data-dependent per-invocation, so it does not
    // violate the barrier-uniformity rule below.
    return;
  }
  let symbol_offset = symbol_idx * N;
  let tid = lid.x;

  // Load this symbol's input into workgroup-shared buf_a. Every invocation
  // loads N/WG_SIZE (~7.5, so up to 8) elements, looping — no early return,
  // all invocations participate in every iteration up to the fixed bound.
  var i = tid;
  while (i < N) {
    buf_a[i] = src[symbol_offset + i];
    i = i + WG_SIZE;
  }
  workgroupBarrier();

  // 9 fused stages, ping-ponging between buf_a and buf_b entirely in
  // workgroup memory. `use_a_as_src` tracks which buffer holds the current
  // stage's input — a uniform (workgroup-wide-identical) value, safe to
  // branch on around barriers.
  var use_a_as_src = true;

  for (var stage = 0u; stage < NUM_STAGES; stage = stage + 1u) {
    let radix = STAGE_RADIX[stage];
    let stride_in = STAGE_STRIDE_IN[stage];
    let stride_out = STAGE_STRIDE_OUT[stage];
    let groups = N / stride_out;
    let per_symbol_threads = stride_in * groups;

    var idx = tid;
    while (idx < per_symbol_threads) {
      let j = idx % stride_in;
      let block = idx / stride_in;

      if (radix == 2u) {
        let i0 = j + block * stride_in;
        let i1 = i0 + groups * stride_in;
        let w1 = twiddle(j, stride_out);
        var a0: vec2<f32>;
        var a1: vec2<f32>;
        if (use_a_as_src) { a0 = buf_a[i0]; a1 = c_mul(buf_a[i1], w1); }
        else { a0 = buf_b[i0]; a1 = c_mul(buf_b[i1], w1); }
        let o0 = block * stride_out + j;
        if (use_a_as_src) { buf_b[o0] = a0 + a1; buf_b[o0 + stride_in] = a0 - a1; }
        else { buf_a[o0] = a0 + a1; buf_a[o0 + stride_in] = a0 - a1; }
      } else if (radix == 3u) {
        let i0 = j + block * stride_in;
        let i1 = i0 + groups * stride_in;
        let i2 = i1 + groups * stride_in;
        let w1 = twiddle(j, stride_out);
        let w2 = twiddle(j * 2u, stride_out);
        var a0: vec2<f32>; var a1: vec2<f32>; var a2: vec2<f32>;
        if (use_a_as_src) { a0 = buf_a[i0]; a1 = c_mul(buf_a[i1], w1); a2 = c_mul(buf_a[i2], w2); }
        else { a0 = buf_b[i0]; a1 = c_mul(buf_b[i1], w1); a2 = c_mul(buf_b[i2], w2); }
        let o = radix3(a0, a1, a2);
        let base = block * stride_out + j;
        if (use_a_as_src) {
          buf_b[base] = o[0]; buf_b[base + stride_in] = o[1]; buf_b[base + 2u * stride_in] = o[2];
        } else {
          buf_a[base] = o[0]; buf_a[base + stride_in] = o[1]; buf_a[base + 2u * stride_in] = o[2];
        }
      } else {
        // radix 5
        let i0 = j + block * stride_in;
        let i1 = i0 + groups * stride_in;
        let i2 = i1 + groups * stride_in;
        let i3 = i2 + groups * stride_in;
        let i4 = i3 + groups * stride_in;
        let w1 = twiddle(j, stride_out);
        let w2 = twiddle(j * 2u, stride_out);
        let w3 = twiddle(j * 3u, stride_out);
        let w4 = twiddle(j * 4u, stride_out);
        var a0: vec2<f32>; var a1: vec2<f32>; var a2: vec2<f32>; var a3: vec2<f32>; var a4: vec2<f32>;
        if (use_a_as_src) {
          a0 = buf_a[i0]; a1 = c_mul(buf_a[i1], w1); a2 = c_mul(buf_a[i2], w2); a3 = c_mul(buf_a[i3], w3); a4 = c_mul(buf_a[i4], w4);
        } else {
          a0 = buf_b[i0]; a1 = c_mul(buf_b[i1], w1); a2 = c_mul(buf_b[i2], w2); a3 = c_mul(buf_b[i3], w3); a4 = c_mul(buf_b[i4], w4);
        }
        let o = radix5(a0, a1, a2, a3, a4);
        let base = block * stride_out + j;
        if (use_a_as_src) {
          buf_b[base] = o[0]; buf_b[base + stride_in] = o[1]; buf_b[base + 2u * stride_in] = o[2]; buf_b[base + 3u * stride_in] = o[3]; buf_b[base + 4u * stride_in] = o[4];
        } else {
          buf_a[base] = o[0]; buf_a[base + stride_in] = o[1]; buf_a[base + 2u * stride_in] = o[2]; buf_a[base + 3u * stride_in] = o[3]; buf_a[base + 4u * stride_in] = o[4];
        }
      }

      idx = idx + WG_SIZE;
    }

    workgroupBarrier();
    use_a_as_src = !use_a_as_src;
  }

  // After 9 (odd) stages, the final result lives in whichever buffer is NOT
  // "use_a_as_src" at this point (use_a_as_src was flipped once per stage,
  // so after 9 flips from an initial true, it's false — final data is in
  // buf_b). Write out to the global result buffer.
  var j = tid;
  while (j < N) {
    if (use_a_as_src) {
      dst[symbol_offset + j] = buf_a[j];
    } else {
      dst[symbol_offset + j] = buf_b[j];
    }
    j = j + WG_SIZE;
  }
}
