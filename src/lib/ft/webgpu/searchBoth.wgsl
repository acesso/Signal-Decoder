// Fused single-dispatch GPU port of fineSync.ts's searchBoth() grid search:
// one workgroup per candidate, entire (hz x off) 2D grid search for that
// candidate's best (hz, off, strength) computed in workgroup-shared memory,
// with NO per-candidate readback of intermediate FFT/IFFT results — only the
// final best (hz, off, strength) triple crosses back to the host.
//
// Per candidate, per hz value in the grid: shift200()'s whole-window
// forward FFT -> bin-shift (shiftBins() semantics: zero-fill out-of-range) ->
// inverse FFT, using the EXACT stage-loop/butterfly code copied verbatim
// from fftGeneralFused.wgsl (same Stockham ping-pong buffers, same
// twiddle()/radix3()/radix5() closed forms, same "num_stages is
// workgroup-uniform, looping it around workgroupBarrier() is legal" argument
// — see that file's header, not re-derived here). Both forward and inverse
// FFT reuse this SAME stage loop: the inverse is done via the conjugate-
// FFT-conjugate identity (conjugate input, run the identical forward stage
// loop, conjugate output, matching webgpuFftGeneral.ts's
// runRealIfftGeneralGpu()'s exact CPU-side steps for realIfftGeneral()) —
// no second kernel entry point or code path needed for "inverse".
//
// oneStrength()'s 21 tiny 32-point rFFTs (one per (start,si) pair) are
// deliberately NOT run through the general Stockham machinery above (that
// would mean re-entering the stage loop at a completely different N=32
// mid-kernel, with a different stage schedule, while still inside the outer
// hz loop — awkward and a real correctness-risk multiplier for a kernel
// already doing a lot). N=32 is fixed and tiny (32^2=1024 multiply-adds per
// call, 21 calls = ~21504 per grid point — trivial next to a GPU thread's
// budget), so a plain direct DFT (dft32(), below) is used instead: simple,
// obviously correct, no shared-memory or cross-invocation dependency at all
// (matches oneStrength()'s own reference implementation using dsp.ts's
// realFft, a direct O(N^2) DFT — see task doc point 3).
//
// PARALLEL REDUCTION (the single biggest correctness risk named in the task
// doc): the (hz, off) grid has at most MAX_HZ*MAX_OFF <= 64 points per
// candidate (this repo's current defaults: 5 hz x up to 6 off = 30). Each
// grid point's oneStrength() call is independent and cheap (no shared
// state read by more than one invocation) — so grid points are handed out
// round-robin to invocations (idx = tid, tid+WG_SIZE, ...), each invocation
// computing and writing its OWN (score, hz_idx, off_idx) into a UNIQUE slot
// of shared arrays (score_buf[idx]/valid_buf[idx]) it never shares with any
// other invocation — this is not a "reduction" needing synchronization at
// write time, just parallel independent writes to disjoint memory. Finding
// the MAX afterward is the actual reduction: a single workgroupBarrier()
// separates "every invocation has finished writing its slots" from "read
// the whole array", and then ONE invocation (tid==0) does a plain linear
// scan over the <=64 slots to find the best — no multi-invocation
// read-modify-write on a shared "best so far" variable anywhere, so there
// is no data race by construction (WGSL's memory model requires exactly
// this shape — a barrier between the last write and any read that depends
// on another invocation's write — Vulkan/D3D/Metal compute all agree a
// workgroupBarrier() is a full workgroup-visible memory+execution barrier
// for workgroup address-space variables). A tree reduction across 64
// elements would save a few dozen scalar compares on ONE thread — not worth
// the extra correctness surface for a search this small (see task doc
// point 1's own explicit preference).
//
// Workgroup memory budget: FFT ping-pong scratch is the SAME layout as
// fftGeneralFused.wgsl (two buf_a/buf_b arrays of vec2<f32>, MAX_N elements
// each, reused sequentially across all hz values in the grid — not one copy
// per hz) plus a small results-scratch array (MAX_HZ*MAX_OFF f32 scores).
// UNLIKE fftGeneralFused.wgsl, buf_a/buf_b here are ALWAYS MAX_N elements —
// this kernel's total workgroup-shared-memory footprint (MAX_N*8*2 +
// MAX_HZ*MAX_OFF*4 bytes) is therefore CONSTANT across every dispatch,
// regardless of any individual candidate's actual (smaller) window length.
// A real-GPU run caught this the hard way: MAX_N=4096/MAX_HZ=8/MAX_OFF=8
// summed to 65792 bytes, 256 bytes over this developer's own confirmed
// 65536-byte maxComputeWorkgroupStorageSize, which made
// CreateComputePipeline fail WebGPU VALIDATION silently (no JS exception —
// surfaced only through the device's error-scope/uncapturederror
// mechanism), invalidating every subsequent bind group/pass/dispatch and
// making every readback come back exactly zero. MAX_N/MAX_HZ/MAX_OFF are
// now sized (4032/6/8, 64704 bytes total) to fit this exact device with
// headroom — callers MUST validate the FIXED constants
// (SEARCH_BOTH_MAX_N/SEARCH_BOTH_MAX_HZ/SEARCH_BOTH_MAX_OFF), never a
// runtime candidate's smaller n/hzCount/offCount, via
// checkSearchBothWorkgroupBudget(device.limits.maxComputeWorkgroupStorageSize)
// before dispatching — see searchBothBudget.ts.
//
// Caller-side constraint (NOT enforced by this kernel, same as
// fftGeneralFused.wgsl): each candidate's window length `n` must factor
// entirely into 2s/3s/5s. Unlike the coarse search's fixed N=1920 or most
// shift200 windows (typically ~2592, which IS 2/3/5-smooth), a candidate
// whose off0 clamps very close to the sample buffer's start can produce a
// window length with a leftover prime factor (confirmed: ~0.5% of possible
// bestOff values in a JS sweep) — this kernel has no generic-DFT fallback
// for that case, matching fftGeneralFused.wgsl's own documented scope. The
// TS orchestration layer (webgpuSearchBoth.ts) throws a clear error for
// such a candidate rather than silently producing wrong output; a caller
// hitting this in practice would need to fall back to the CPU path for
// that one candidate (out of scope for this prototype stage).

struct CandidateParams {
  n: u32,
  num_stages: u32,
  hz_count: u32,
  off_count: u32,
  off_inc: u32,
  off0: u32,
  window_off: u32,
  samples_len: u32,
}

struct StageDesc {
  radix: u32,
  stride_in: u32,
  stride_out: u32,
  groups: u32,
}

@group(0) @binding(0) var<uniform> n_batch: u32;
@group(0) @binding(1) var<storage, read> params: array<CandidateParams>;
@group(0) @binding(2) var<storage, read> stages: array<StageDesc>; // [batch][MAX_STAGES], flattened
@group(0) @binding(3) var<storage, read> hz_downs: array<vec2<f32>>; // [batch][MAX_HZ]: (hz_value, down_bins_as_f32-rounded-int)
@group(0) @binding(4) var<storage, read> samples: array<f32>; // [batch][MAX_SAMPLES_LEN] raw samples200, flattened
// out_result is array<vec4<f32>>, NOT vec3 -- WGSL's storage-buffer memory
// layout rules give vec3<f32> a base ALIGNMENT of 16 bytes while its SIZE is
// only 12 (see: https://www.w3.org/TR/WGSL/#alignment-and-size, the fixed
// AlignOf/SizeOf table), and an array's element STRIDE is
// roundUp(AlignOf(T), SizeOf(T)) — so array<vec3<f32>> strides its elements
// 16 bytes apart, not 12. A real-GPU run (Dawn, native) confirmed this isn't
// hypothetical: it's a documented, deterministic layout rule, not a driver
// quirk. The 4th component is unused padding (kept at 0); using vec4
// upfront makes the TS-side byte layout unambiguous (4 * 4 = 16 bytes/slot,
// matching the WGSL array's actual stride) instead of relying on every
// caller re-deriving the vec3-pads-to-16 rule correctly by hand.
@group(0) @binding(5) var<storage, read_write> out_result: array<vec4<f32>>; // [batch]: (best_hz, best_off, best_strength, 0)

// MAX_N/MAX_HZ/MAX_OFF are FIXED workgroup-array sizes, not sized per
// dispatch — buf_a/buf_b below are always MAX_N elements regardless of any
// candidate's actual (smaller) window length `n`, so this kernel's total
// workgroup-shared-memory footprint is CONSTANT across every dispatch:
// MAX_N*8*2 (buf_a+buf_b) + MAX_HZ*MAX_OFF*4 (score_buf) bytes, always.
// Confirmed the hard way on real hardware (Dawn native, this developer's
// own confirmed 65536-byte maxComputeWorkgroupStorageSize): an earlier
// revision left MAX_N=4096/MAX_HZ=8/MAX_OFF=8, i.e. 4096*8*2 + 8*8*4 =
// 65792 bytes — 256 bytes OVER this exact device's 65536-byte limit —
// which made CreateComputePipeline fail WebGPU VALIDATION (not a JS
// exception; surfaced only via the device's uncapturederror/console
// mechanism), silently downstream-invalidating the bind group, compute
// pass, and command buffer, so every dispatch was a total no-op and every
// readback came back exactly zero. searchBothBudget.ts's caller
// (webgpuSearchBoth.ts) MUST validate against these FIXED constants, never
// against a runtime candidate's smaller n/hzCount/offCount, or the check
// silently passes on exactly this failure mode. MAX_N=4032 (not 4096) /
// MAX_HZ=6 (not 8) / MAX_OFF=8 chosen so the fixed total (4032*8*2 + 6*8*4
// = 64704 bytes) fits within 65536 with headroom, while still safely
// covering this repo's real shift200 windows (~2592 samples) and grid
// shapes (<=5 hz x <=6 off, see fineSync.ts's SECOND_HZ_N/SECOND_OFF_N).
const MAX_N: u32 = 4032u;
const MAX_STAGES: u32 = 14u; // any 2/3/5-smooth N <= MAX_N needs at most 11 stages (N=2048=2^11); 14 keeps margin
const MAX_HZ: u32 = 6u;
const MAX_OFF: u32 = 8u;
const MAX_SAMPLES_LEN: u32 = 4032u; // caller-side stride for the `samples` buffer's per-candidate window; matches MAX_N (a candidate's window IS its FFT length)
const WG_SIZE: u32 = 256u;
const TWO_PI: f32 = 6.283185307179586;

var<workgroup> buf_a: array<vec2<f32>, MAX_N>;
var<workgroup> buf_b: array<vec2<f32>, MAX_N>;
var<workgroup> score_buf: array<f32, MAX_HZ * MAX_OFF>;

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

// One Stockham stage over whichever of buf_a/buf_b currently holds the
// source (tracked by `use_a_as_src`, flipped once per call) — identical
// control flow to fftGeneralFused.wgsl's per-stage loop body, extracted into
// a function here because this kernel calls it twice per hz value (forward
// FFT, then again for the inverse-via-conjugate-FFT identity) inside an
// outer per-hz loop, instead of once per dispatch.
fn fft_stage(tid: u32, desc: StageDesc, use_a_as_src: bool) {
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
}

// Runs the full num_stages Stockham pass starting from wherever the
// caller's actual input currently lives (`start_in_a`) -> ... -> (buf_a or
// buf_b, whichever parity num_stages lands on starting from there). Every
// invocation in the workgroup must call this together (workgroup-uniform
// num_stages, same barrier-uniformity argument as fftGeneralFused.wgsl).
// Returns true if the result ended up in buf_a, false if buf_b.
//
// `start_in_a` MUST reflect where the input genuinely is — an earlier
// revision hardcoded `var use_a_as_src = true;` here unconditionally
// (i.e. always assumed the input was freshly in buf_a), which is only
// correct for the very first call in main() (forward FFT: samples were
// just written directly into buf_a). The SECOND call per hz value (the
// inverse FFT, run over the shift+conjugate step's output) starts from
// buf_a only when the forward FFT's OWN stage count was odd (so the
// shifted spectrum landed back in buf_a) — for an EVEN stage count it
// lands in buf_b instead, and the old hardcoded assumption silently read
// stale/wrong data as the inverse FFT's "source". This went undetected in
// this kernel's own JS simulation because that simulation modeled the FFT
// as a pure function over an explicit data array, never modeling buf_a/
// buf_b as SHARED, PERSISTENT, NAMED storage the way the actual WGSL does
// — so the simulation had no way to represent this class of bug at all.
// Every candidate this repo actually produces from shift200 has an ODD
// stage count in practice (2592 -> 9 stages), which is why this bug did
// not visibly corrupt results in earlier testing; it is still a real bug
// for any other window length with an even stage count (e.g. N=4096, 12
// stages, or N=2560, 10 stages) and is fixed here unconditionally rather
// than relying on this repo's current windows happening to avoid it.
fn run_fft_stages(tid: u32, batch_idx: u32, num_stages: u32, start_in_a: bool) -> bool {
  var use_a_as_src = start_in_a;
  for (var stage = 0u; stage < num_stages; stage = stage + 1u) {
    let desc = stages[batch_idx * MAX_STAGES + stage];
    fft_stage(tid, desc, use_a_as_src);
    workgroupBarrier();
    use_a_as_src = !use_a_as_src;
  }
  return use_a_as_src;
}

// oneStrength()'s per-(start,si) 32-point rFFT, direct O(32^2) DFT — mirrors
// dsp.ts's realFft(samples, i0, 32) exactly, including its zero-past-the-end
// semantics, but reads directly out of the shared time-domain buffer
// (buf_a/buf_b, whichever `in_a` selects) instead of a materialized JS
// array. Only the single bin `bin0+bi` is ever needed by the caller, so
// this returns just that one complex value (no need to compute/allocate all
// 17 rfft bins like dsp.ts's realFft does for a general-purpose caller).
fn dft32_one_bin(in_a: bool, base: u32, len: u32, bin: u32) -> vec2<f32> {
  var re = 0.0;
  var im = 0.0;
  let theta0 = -TWO_PI * f32(bin) / 32.0;
  for (var n = 0u; n < 32u; n = n + 1u) {
    let idx = base + n;
    var x = 0.0;
    if (idx < len) {
      if (in_a) { x = buf_a[idx].x; } else { x = buf_b[idx].x; }
    }
    if (x != 0.0) {
      let theta = theta0 * f32(n);
      re = re + x * cos(theta);
      im = im + x * sin(theta);
    }
  }
  return vec2<f32>(re, im);
}

const COSTAS0: u32 = 3u;
const COSTAS1: u32 = 1u;
const COSTAS2: u32 = 4u;
const COSTAS3: u32 = 0u;
const COSTAS4: u32 = 6u;
const COSTAS5: u32 = 5u;
const COSTAS6: u32 = 2u;

fn costas(si: u32) -> u32 {
  if (si == 0u) { return COSTAS0; }
  if (si == 1u) { return COSTAS1; }
  if (si == 2u) { return COSTAS2; }
  if (si == 3u) { return COSTAS3; }
  if (si == 4u) { return COSTAS4; }
  if (si == 5u) { return COSTAS5; }
  return COSTAS6;
}

// oneStrength(downsamples200, 25, off) — bin0 = round(25/6.25) = 4 is a
// compile-time constant here (searchTimeFine always calls oneStrength with
// hz FIXED at 25 after shift200 has already moved the candidate's hz there
// — see fineSync.ts's searchTimeFine() and its own comment on this), so
// this never needs a runtime bin0 parameter.
const BIN0: u32 = 4u;

fn one_strength(in_a: bool, len: u32, off: u32) -> f32 {
  var sig = 0.0;
  let starts = array<u32, 3>(0u, 36u, 72u);
  for (var s = 0u; s < 3u; s = s + 1u) {
    let start = starts[s];
    for (var si = 0u; si < 7u; si = si + 1u) {
      let base = off + (si + start) * 32u;
      let bin = BIN0 + costas(si);
      let c = dft32_one_bin(in_a, base, len, bin);
      sig = sig + sqrt(c.x * c.x + c.y * c.y);
    }
  }
  return sig;
}

@compute @workgroup_size(WG_SIZE)
fn main(@builtin(workgroup_id) wg_id: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
  let batch_idx = wg_id.x;
  if (batch_idx >= n_batch) {
    return;
  }
  let tid = lid.x;
  let p = params[batch_idx];
  let n = p.n;
  let sample_base = batch_idx * MAX_SAMPLES_LEN;

  var i = tid;
  loop {
    if (i >= MAX_HZ * MAX_OFF) { break; }
    score_buf[i] = -1.0;
    i = i + WG_SIZE;
  }
  workgroupBarrier();

  for (var hz_idx = 0u; hz_idx < p.hz_count; hz_idx = hz_idx + 1u) {
    let hd = hz_downs[batch_idx * MAX_HZ + hz_idx];
    let down = i32(hd.y);

    var j = tid;
    loop {
      if (j >= n) { break; }
      let sidx = p.window_off + j;
      var xv = 0.0;
      if (sidx < p.samples_len) { xv = samples[sample_base + sidx]; }
      buf_a[j] = vec2<f32>(xv, 0.0);
      j = j + WG_SIZE;
    }
    workgroupBarrier();

    // Samples were just written directly into buf_a above, so the forward
    // FFT's input genuinely starts in buf_a — start_in_a=true here is a real
    // fact about this call, not a default.
    let fwd_in_a = run_fft_stages(tid, batch_idx, p.num_stages, true);

    // shiftBins(): bins1[i] = bins[i+down] if in [0,nbins), else 0 — but
    // shiftBins() operates on the HALF-spectrum (rFFT convention, nbins =
    // n/2+1), not the full N-point complex spectrum this kernel's Stockham
    // pass actually holds. A previous revision shifted the FULL spectrum
    // with the SAME +down index math for every k in [0,n) (this file's
    // earlier comment here claimed that "commutes" with conjugate-symmetric
    // reconstruction — that claim was checked against a companion JS
    // simulation that modeled the full-spectrum shift in isolation and
    // never actually cross-checked it against shiftBins()+realIfftGeneral()
    // on a REAL asymmetric spectrum, so the error went undetected).
    //
    // It does not commute: realIfftGeneral()'s convention reconstructs
    // negative-frequency bin (n-k) as conj(HALF-spectrum bin k) — i.e. the
    // NEGATIVE-frequency mirror is built from the (already shifted)
    // POSITIVE-frequency bin `k`, using shiftedHalf[k] = half[k+down]. So
    // the correct read for full-spectrum bin (n-k) is conj(half[k+down]) =
    // conj(X[k+down]), which — expressed directly in terms of the
    // NEGATIVE-frequency bin's own index m=n-k — is conj(X[n-m+down]) =
    // full-spectrum-conjugate-symmetric X[m-down] (since X[n-j] = conj(X[j])
    // for a real-valued input's full spectrum). That is: the negative-
    // frequency half needs `src_k = k - down` (mirrored SIGN), not `k +
    // down` — shifting the full spectrum with one consistent sign for every
    // k silently produces a DIFFERENT (and wrong) shifted signal whenever
    // down != 0, confirmed via a standalone DFT/IDFT cross-check against
    // shiftBins()+realIfftGeneral() on an asymmetric two-tone test signal
    // (this bug produces an ~symmetric-in-hz score grid around the
    // candidate's hz0, since +down and -down get silently swapped between
    // the two mirror halves — exactly the signature found live: searchBoth
    // GPU results always converging on hz0 regardless of the true off-
    // center peak, traced back to this line). Fixed below: `down` for k in
    // the positive-frequency half [0, n/2], `-down` for the mirrored
    // negative-frequency half (n/2, n).
    let n_half = n / 2u;
    var k = tid;
    loop {
      if (k >= n) { break; }
      let signed_down = select(-down, down, k <= n_half);
      let src_k = i32(k) + signed_down;
      var v = vec2<f32>(0.0, 0.0);
      if (src_k >= 0 && u32(src_k) < n) {
        if (fwd_in_a) { v = buf_a[u32(src_k)]; } else { v = buf_b[u32(src_k)]; }
      }
      // Conjugate here too (negate imaginary part) — folds shiftBins() and
      // the IFFT-via-conjugate-FFT identity's input-conjugation step into
      // one pass over the spectrum, instead of a separate conjugate-only
      // pass before re-entering run_fft_stages.
      let vc = vec2<f32>(v.x, -v.y);
      if (fwd_in_a) { buf_b[k] = vc; } else { buf_a[k] = vc; }
      k = k + WG_SIZE;
    }
    workgroupBarrier();

    let shift_in_a = !fwd_in_a; // shifted+conjugated spectrum landed in the OTHER buffer from fwd's result
    // MUST pass shift_in_a here (not hardcode true) -- this is the actual
    // location of this call's input; see run_fft_stages()'s doc comment for
    // why getting this wrong is a real, silent-corruption bug for even
    // stage counts.
    let ifft_in_a = run_fft_stages(tid, batch_idx, p.num_stages, shift_in_a);
    // ifft_in_a's buffer now holds conj(FFT(conj(shifted_spectrum))); its
    // REAL part is the shifted time-domain signal (imaginary part is
    // conjugated back by construction and should be ~0), matching
    // webgpuFftGeneral.ts's runRealIfftGeneralGpu()'s final `full[i*2+1] =
    // -full[i*2+1]` + fftGeneral() + take-real-part sequence exactly — the
    // one extra negation there is already folded into the shift-and-
    // conjugate pass above, so no further negation is needed here.

    for (var off_idx = 0u; off_idx < p.off_count; off_idx = off_idx + 1u) {
      let slot = hz_idx * MAX_OFF + off_idx;
      if (slot % WG_SIZE == tid % WG_SIZE) {
        // Round-robin slot ownership across invocations by slot index
        // modulo WG_SIZE: guarantees each slot is written by EXACTLY one
        // invocation (no two invocations ever compute the same slot, no
        // slot is left unwritten) — simpler than tid<hz_count*off_count
        // gating since hz_count*off_count is always <= WG_SIZE=256 here (at
        // most 64), so this reduces to "slot == tid" whenever tid <
        // hz_count*off_count and every other invocation's loop body simply
        // never matches for that slot. Written this way (modulo, not a
        // plain equality against tid) so it stays correct even if a future
        // caller raises hz_count*off_count above WG_SIZE.
        let g = off_idx * p.off_inc;
        let sig = one_strength(ifft_in_a, n, g);
        score_buf[slot] = sig;
      }
    }
    workgroupBarrier();
  }

  if (tid == 0u) {
    var best_slot = 0u;
    var best_score = -1.0;
    var found = false;
    for (var s = 0u; s < p.hz_count * MAX_OFF; s = s + 1u) {
      let hz_idx = s / MAX_OFF;
      let off_idx = s % MAX_OFF;
      if (off_idx >= p.off_count) { continue; }
      let sc = score_buf[s];
      if (!found || sc > best_score) {
        best_score = sc;
        best_slot = s;
        found = true;
      }
    }
    let best_hz_idx = best_slot / MAX_OFF;
    let best_off_idx = best_slot % MAX_OFF;
    let best_hz = hz_downs[batch_idx * MAX_HZ + best_hz_idx].x;
    let best_off = f32(p.off0) + f32(best_off_idx * p.off_inc);
    out_result[batch_idx] = vec4<f32>(best_hz, best_off, best_score, 0.0);
  }
}
