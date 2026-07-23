// Mixed-radix Stockham FFT, fixed at N = 1920 = 2^7 * 3 * 5, matching
// ft8mon's exact symbol-block size (fft.cc's one_fft()/ffts(), 1920 samples
// at 12000 Hz -> 6.25 Hz/bin) so coarse-search candidates line up bin-for-bin
// with the existing WASM decoder — this is a feasibility prototype for the
// coarse Costas-search stage only (see one_coarse_strength()/coarse() in
// lib/ft8mon/ft8.cc), not a replacement for ft8mon's own FFT.
//
// Stockham autosort: 9 fixed radix passes (seven radix-2, one radix-3, one
// radix-5 — 1920 = 2^7 * 3 * 5) ping-ponging between two flat storage
// buffers, each pass a separate dispatch. No recursion, no dynamic
// allocation, no data-dependent branching — WGSL has none of those anyway,
// but it also means the whole factorization must be unrolled as a fixed
// pass list rather than computed on the fly (done host-side in fft1920.ts).
//
// Complex numbers are (re, im) as vec2<f32>. Input real-valued audio is
// loaded into the real component with im = 0 for pass 0.

struct Params {
  // Which pass of the 9-pass radix sequence this dispatch performs.
  pass_index: u32,
  // Radix of THIS pass (2, 3, or 5).
  radix: u32,
  // Product of radixes of all passes BEFORE this one ("L" in Stockham terms)
  // — stride between elements that share a butterfly at this pass.
  stride_in: u32,
  // Product of radixes of all passes INCLUDING this one.
  stride_out: u32,
  // How many independent 1920-point FFTs are batched in this one dispatch
  // (one per symbol-time in the search window).
  n_symbols: u32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> src: array<vec2<f32>>;
@group(0) @binding(2) var<storage, read_write> dst: array<vec2<f32>>;

const N: u32 = 1920u;
const TWO_PI: f32 = 6.283185307179586;

fn c_mul(a: vec2<f32>, b: vec2<f32>) -> vec2<f32> {
  return vec2<f32>(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x);
}

fn twiddle(k: u32, n: u32) -> vec2<f32> {
  let theta = -TWO_PI * f32(k) / f32(n);
  return vec2<f32>(cos(theta), sin(theta));
}

// Radix-3 butterfly constant: sin(2*pi/3) = 0.8660254 (the cos term, -0.5,
// is applied inline below rather than as a named constant).
const R3_S: f32 = 0.8660254037844387;

fn radix3(a0: vec2<f32>, a1: vec2<f32>, a2: vec2<f32>) -> array<vec2<f32>, 3> {
  let t1 = a1 + a2;
  let t2 = a0 - 0.5 * t1;
  let t3 = R3_S * vec2<f32>(a1.y - a2.y, a2.x - a1.x); // *(-i) rotation term
  var out: array<vec2<f32>, 3>;
  out[0] = a0 + t1;
  out[1] = t2 + t3;
  out[2] = t2 - t3;
  return out;
}

// Radix-5 butterfly constants (standard DFT-5 coefficients).
const R5_C1: f32 = 0.30901699437494745;  // cos(2pi/5)
const R5_S1: f32 = 0.9510565162951535;   // sin(2pi/5)
const R5_C2: f32 = -0.8090169943749475;  // cos(4pi/5)
const R5_S2: f32 = 0.5877852522924731;   // sin(4pi/5)

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

// One invocation per (symbol, output butterfly group element) pair. Each of
// the batch's `n_symbols` 1920-point FFTs is fully independent (ft8mon's
// ffts() computes one FFT per symbol-time, no cross-symbol dependency), so
// batching them into a single dispatch just adds a symbol_idx dimension:
// every buffer index below is offset by `symbol_idx * N`. This is what lets
// one dispatch cover all ~93 symbol-time FFTs for a 15s window at once
// instead of issuing 93 tiny dispatches serially.
//
// Per symbol: one invocation per output butterfly GROUP element index pair
// (j in [0, stride_in), block in [0, N/stride_out)) — Stockham autosort
// writes directly to its natural output position, no separate bit-reversal
// pass needed.
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let groups = N / params.stride_out; // number of independent butterfly groups
  let per_symbol = params.stride_in * groups;

  let global_idx = gid.x;
  if (global_idx >= per_symbol * params.n_symbols) {
    return;
  }

  let symbol_idx = global_idx / per_symbol;
  let idx = global_idx % per_symbol;
  let symbol_offset = symbol_idx * N;

  let j = idx % params.stride_in;       // position within the radix butterfly
  let block = idx / params.stride_in;   // which output group

  let r = params.radix;
  // Stockham autosort: leg t's twiddle exponent is j*t (NOT j*block) over
  // the full stride_out = stride_in*r modulus — each of the r input legs
  // gets its OWN twiddle before the radix-r combine, verified against a
  // naive DFT reference at N=6 and N=1920 (see fft1920.test.ts).

  if (r == 2u) {
    let i0 = symbol_offset + j + block * params.stride_in;
    let i1 = i0 + groups * params.stride_in;
    let w1 = twiddle(j * 1u, params.stride_out);
    let a0 = src[i0];
    let a1 = c_mul(src[i1], w1);
    let o0 = symbol_offset + block * params.stride_out + j;
    dst[o0] = a0 + a1;
    dst[o0 + params.stride_in] = a0 - a1;
  } else if (r == 3u) {
    let i0 = symbol_offset + j + block * params.stride_in;
    let i1 = i0 + groups * params.stride_in;
    let i2 = i1 + groups * params.stride_in;
    let w1 = twiddle(j * 1u, params.stride_out);
    let w2 = twiddle(j * 2u, params.stride_out);
    let a0 = src[i0];
    let a1 = c_mul(src[i1], w1);
    let a2 = c_mul(src[i2], w2);
    let o = radix3(a0, a1, a2);
    let base = symbol_offset + block * params.stride_out + j;
    dst[base] = o[0];
    dst[base + params.stride_in] = o[1];
    dst[base + 2u * params.stride_in] = o[2];
  } else {
    // radix 5
    let i0 = symbol_offset + j + block * params.stride_in;
    let i1 = i0 + groups * params.stride_in;
    let i2 = i1 + groups * params.stride_in;
    let i3 = i2 + groups * params.stride_in;
    let i4 = i3 + groups * params.stride_in;
    let w1 = twiddle(j * 1u, params.stride_out);
    let w2 = twiddle(j * 2u, params.stride_out);
    let w3 = twiddle(j * 3u, params.stride_out);
    let w4 = twiddle(j * 4u, params.stride_out);
    let a0 = src[i0];
    let a1 = c_mul(src[i1], w1);
    let a2 = c_mul(src[i2], w2);
    let a3 = c_mul(src[i3], w3);
    let a4 = c_mul(src[i4], w4);
    let o = radix5(a0, a1, a2, a3, a4);
    let base = symbol_offset + block * params.stride_out + j;
    dst[base] = o[0];
    dst[base + params.stride_in] = o[1];
    dst[base + 2u * params.stride_in] = o[2];
    dst[base + 3u * params.stride_in] = o[3];
    dst[base + 4u * params.stride_in] = o[4];
  }
}
