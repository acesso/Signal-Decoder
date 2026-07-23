// GPU port of extract() (symbolExtract.ts / ft8.cc:1287-1309): per candidate,
// 79 independent 32-point direct-DFT rFFTs (one per symbol time), keeping
// bins 4..11 (the 8 FT8 tone bins). One workgroup per candidate; all 79*8=632
// (symbol, bin) DFT evaluations are fully independent (each reads only its
// own 32-sample window of `samples`, writes only its own output slot) — no
// shared-memory pass or barrier needed at all here, unlike softDecodeFused's
// later stages. Round-robin work distribution (idx, idx+WG_SIZE, ...) over
// WG_SIZE=256 threads, matching searchBoth.wgsl's own established pattern
// for handing out independent per-slot work within a workgroup.
//
// dft32_one_bin() below is copied from searchBoth.wgsl's helper of the same
// name (task doc's own suggested starting point), generalized to take the
// samples array directly (not a workgroup-shared FFT scratch buffer — this
// kernel never runs a whole-window FFT, only the tiny fixed 32-point DFTs)
// and to be called once per (symbol, bin) pair rather than embedded in a
// larger per-hz search loop.

struct CandidateParams {
  off: i32, // symbol-0 start sample index into this candidate's samples window
  samples_len: u32,
}

@group(0) @binding(0) var<uniform> n_batch: u32;
@group(0) @binding(1) var<storage, read> params: array<CandidateParams>;
@group(0) @binding(2) var<storage, read> samples: array<f32>; // [batch][MAX_SAMPLES_LEN], flattened
@group(0) @binding(3) var<storage, read_write> out_c79: array<vec2<f32>>; // [batch][79*8], flattened

// extract() needs samples[off .. off+79*32+32) = 2592 samples of headroom
// past `off` itself. An earlier revision set this to 2752 (2592+160) on the
// assumption `off` itself would always be small -- WRONG in practice: a
// real-GPU run against this repo's own fixture (bestOff=304) needed
// off+2592=2896 uploaded samples, and MAX_SAMPLES_LEN=2752 silently
// truncated the tail, zero-padding real signal data instead of reading it
// (a genuine numeric-correctness bug caught only by running against real
// captured data, not a JS simulation -- see the task's own verification
// results). 4096 gives real headroom above realistic bestOff values (this
// repo's searchBothDefault() typically clamps off windows to within a few
// hundred samples of the coarse candidate, but the caller-side window this
// kernel is handed can start anywhere in the original samples200 buffer).
const MAX_SAMPLES_LEN: u32 = 4096u;
const WG_SIZE: u32 = 256u;
const TWO_PI: f32 = 6.283185307179586;
const BIN0: u32 = 4u; // extract() keeps bins [4, 11] -- bin 4 is 25Hz at 200sps/32-samples-per-symbol, matching symbolExtract.ts's own BIN0 convention

fn dft32_one_bin(batch_base: u32, base: i32, len: u32, bin: u32) -> vec2<f32> {
  var re = 0.0;
  var im = 0.0;
  let theta0 = -TWO_PI * f32(bin) / 32.0;
  for (var n = 0u; n < 32u; n = n + 1u) {
    let idx = base + i32(n);
    var x = 0.0;
    if (idx >= 0 && u32(idx) < len) {
      x = samples[batch_base + u32(idx)];
    }
    if (x != 0.0) {
      let theta = theta0 * f32(n);
      re = re + x * cos(theta);
      im = im + x * sin(theta);
    }
  }
  return vec2<f32>(re, im);
}

@compute @workgroup_size(WG_SIZE)
fn main(@builtin(workgroup_id) wg_id: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
  let batch_idx = wg_id.x;
  if (batch_idx >= n_batch) {
    return;
  }
  let tid = lid.x;
  let p = params[batch_idx];
  let batch_base = batch_idx * MAX_SAMPLES_LEN;
  let out_base = batch_idx * 79u * 8u;

  var idx = tid;
  loop {
    if (idx >= 79u * 8u) { break; }
    let si = idx / 8u;
    let bi = idx % 8u;
    let base = p.off + i32(si * 32u);
    let bin = BIN0 + bi;
    out_c79[out_base + idx] = dft32_one_bin(batch_base, base, p.samples_len, bin);
    idx = idx + WG_SIZE;
  }
}
