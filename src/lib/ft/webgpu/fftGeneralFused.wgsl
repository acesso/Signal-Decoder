// Fused single-dispatch general-length (2/3/5-smooth) FFT — same "one
// workgroup computes an entire FFT in workgroup-shared memory, synchronized
// with workgroupBarrier() between stages" structure as fft1920Fused.wgsl,
// generalized to a runtime-variable N and a runtime-variable stage count.
//
// fft1920Fused.wgsl bakes N=1920's specific 9-stage schedule in as WGSL
// `const` arrays because that kernel only ever needs to run at exactly
// N=1920. This kernel exists because shift200()/searchBoth()'s window
// length varies per candidate (edge-clamping near the buffer start), so the
// radix/stride schedule can't be a compile-time constant here — instead the
// CPU side calls fftGeneral.ts's factorRadixSchedule(n), flattens it to
// (radix, strideIn, strideOut, groups) per stage, and uploads it as a
// read-only storage buffer that every workgroup loops over identically.
// Looping `num_stages` times (a uniform, workgroup-wide-identical value) is
// safe around workgroupBarrier() by the same uniformity rule
// fft1920Fused.wgsl's header documents: a barrier only needs to be reached
// by every invocation, and a value read identically off a uniform buffer by
// every invocation in the workgroup is not a per-invocation branch.
//
// Radix-2/3/5 butterfly math (twiddle, radix3, radix5) is copied verbatim
// from fft1920Fused.wgsl — same closed-form derivation, verified there
// against a naive DFT and real ft8mon output; only radix2's inline butterfly
// and the outer stage loop differ, because here the radix is a per-stage
// runtime value read from `stages[stage].x` instead of a compile-time
// constant baked into which branch of an unrolled loop runs.
//
// Caller-side constraint (NOT enforced by this kernel): N must factor
// entirely into 2s/3s/5s — i.e. factorRadixSchedule(n) must return only
// radix-2/3/5 stages, no leftover-prime generic-DFT stage. fftGeneral.ts's
// CPU path falls back to a generic O(r*N) DFT combine for a leftover prime
// factor; this GPU kernel does NOT implement that fallback (out of scope —
// see task doc). Any N that doesn't factor cleanly is a caller-side bug:
// pad/choose N to be 2/3/5-smooth before calling.
//
// Workgroup memory: MAX_N=4096 * 8 bytes (vec2<f32>) * 2 (ping-pong) = 65536
// bytes — matches this developer's own confirmed
// maxComputeWorkgroupStorageSize (see fftWorkgroupBudget.ts's header
// comment), NOT hardcoded as a device assumption: callers MUST run
// checkFftWorkgroupBudget(n, device.limits.maxComputeWorkgroupStorageSize)
// before dispatching, since a device only guaranteeing the WebGPU spec
// minimum (16384 bytes) can't actually fit N=4096 here (only N<=1024) even
// though the array is sized for it.
//
// Workgroup size 256, matching fft1920Fused.wgsl — each invocation loops
// over multiple per-stage butterfly-group elements when a stage needs more
// than 256 threads (largest possible per-stage thread count is N/radix_min,
// i.e. up to N/2), same masking-via-`if`-around-computation-only pattern
// (never around a barrier) as fft1920Fused.wgsl.
//
// Per-element f32 error grows with stage COUNT (more sequential rounding
// steps before reaching the output) and with radix-3/5 STAGES specifically
// (radix3()/radix5()'s closed-form butterflies do several more add/mul
// steps per output than radix2()'s single add/sub) — confirmed by an
// external f32-accurate JS simulation (Math.fround at every intermediate
// op, not just final output) that reproduces the same relative ordering:
// N=4096 (12 pure-radix-2 stages) and N=2592 (9 stages, 4 of them radix-3)
// both show measurably larger maxAbsDiff against the f64 CPU reference than
// N=1920 (9 stages, only 1 radix-3 + 1 radix-5) — see
// webgpu-fftgeneral-bench.html's per-N tolerance for the actual numbers.
// This is plain floating-point accumulation, not a logic bug: the
// underlying WGSL `cos`/`sin` builtins are only spec-guaranteed to 2^-11
// absolute error for |theta| <= pi (WGSL spec's float builtin accuracy
// table) and this kernel's twiddle() calls theta values up to ~5 radians
// (k up to stride_out-1, theta = -2*pi*k/stride_out) with NO accuracy
// guarantee at all outside [-pi, pi] — real GPU trig hardware is not
// obligated to be as accurate out there as a host-side f64 cos/sin would
// be, and empirically isn't.

struct FftParams {
  n: u32,
  num_stages: u32,
  n_batch: u32,
  _pad0: u32,
}

// One stage descriptor per FFT pass: (radix, stride_in, stride_out, groups).
// `groups` = n / stride_out is precomputed CPU-side (cheap, avoids a
// division per invocation per stage on the GPU) — see webgpuFftGeneral.ts's
// flattenStageSchedule().
struct StageDesc {
  radix: u32,
  stride_in: u32,
  stride_out: u32,
  groups: u32,
}

@group(0) @binding(0) var<uniform> params: FftParams;
@group(0) @binding(1) var<storage, read> stages: array<StageDesc>;
@group(0) @binding(2) var<storage, read> src: array<vec2<f32>>;
@group(0) @binding(3) var<storage, read_write> dst: array<vec2<f32>>;

const MAX_N: u32 = 4096u;
const WG_SIZE: u32 = 256u;
const TWO_PI: f32 = 6.283185307179586;

var<workgroup> buf_a: array<vec2<f32>, MAX_N>;
var<workgroup> buf_b: array<vec2<f32>, MAX_N>;

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

// One workgroup per batch element (workgroup_id.x = batch index, e.g. one
// per fine-sync candidate window in the later per-candidate grid search).
@compute @workgroup_size(WG_SIZE)
fn main(@builtin(workgroup_id) wg_id: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
  let batch_idx = wg_id.x;
  if (batch_idx >= params.n_batch) {
    // Safe before any barrier: wg_id.x is identical for every invocation in
    // this workgroup (workgroup-uniform), not a per-invocation data-dependent
    // branch — same guard fft1920Fused.wgsl uses for n_symbols.
    return;
  }
  let n = params.n;
  let batch_offset = batch_idx * n;
  let tid = lid.x;

  var i = tid;
  loop {
    if (i >= n) { break; }
    buf_a[i] = src[batch_offset + i];
    i = i + WG_SIZE;
  }
  workgroupBarrier();

  var use_a_as_src = true;

  // num_stages is a uniform value (identical across the whole workgroup, and
  // across every workgroup in this dispatch) — looping it and calling
  // workgroupBarrier() once per iteration is workgroup-uniform control flow,
  // not a per-invocation early-exit, so it does not violate WGSL's
  // barrier-uniformity requirement.
  for (var stage = 0u; stage < params.num_stages; stage = stage + 1u) {
    let desc = stages[stage];
    let radix = desc.radix;
    let stride_in = desc.stride_in;
    let stride_out = desc.stride_out;
    let groups = desc.groups;
    let per_batch_threads = stride_in * groups;

    var idx = tid;
    loop {
      if (idx >= per_batch_threads) { break; }
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
        // radix 5 — caller-side contract guarantees no other radix ever
        // appears in the stage schedule (see module header: N must be
        // 2/3/5-smooth for this kernel).
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

  // Whichever buffer is NOT "use_a_as_src" holds the final result: each
  // stage flips use_a_as_src once, so after num_stages flips from an
  // initial true, use_a_as_src is true iff num_stages is even (result in
  // buf_a) and false iff odd (result in buf_b) — a runtime-dependent parity
  // (unlike fft1920Fused.wgsl's hardcoded "9 is odd, so buf_b"), since
  // num_stages varies with N here.
  var j2 = tid;
  loop {
    if (j2 >= n) { break; }
    if (use_a_as_src) {
      dst[batch_offset + j2] = buf_a[j2];
    } else {
      dst[batch_offset + j2] = buf_b[j2];
    }
    j2 = j2 + WG_SIZE;
  }
}
