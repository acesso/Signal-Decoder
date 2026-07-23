// GPU port of the EXPENSIVE, per-symbol/per-tone-parallel portion of
// cSoftDecode() (softDecode.ts / ft8.cc:1785-1914): convertToSnr() +
// maxes[] + the m79 (soft per-tone-per-symbol score) distance-sum stage.
// One workgroup per candidate, 79 symbols x 8 tones = 632 output values.
//
// Deliberately NOT ported here (see the task doc's own discussion, and
// symbolExtractFused.wgsl/softDecodeFused.ts's header comments for the full
// justification): makeStats() (a genuine 632+174-element global reduction)
// and bayes() (needs erf(), no native WGSL equivalent, and a fresh
// Abramowitz-Stegun port would add real correctness surface for an
// arithmetically cheap step). Both are done on the CPU, in
// softDecodeFused.ts, from this kernel's m79Soft/maxes output. This kernel
// produces exactly the two arrays that CPU-side finishing step needs:
// m79Soft[79*8] (the un-normalized-for-stats "soft" scores, pre-un-gray-code
// — matches softDecode.ts's own m79 local before unGrayCodeR is applied) and
// maxes[79] (needed by makeStats() to build `bests`).
//
// THREE sequential barrier-separated phases per candidate, matching the
// task doc's own dependency analysis exactly:
//   1) raw magnitude of each symbol's weakest tone (mm[79]) -- needs ALL
//      632 raw |c79| magnitudes computed first (each symbol's own 8-tone
//      min), so phase 1a computes magnitudes into shared mem, barrier, then
//      phase 1b's Blackman-windowed neighbor sum (SNR_WIN=+/-7) reads
//      neighbors' mm[] values another invocation may have written.
//   2) maxes[79]: Costas-consensus-or-strongest-tone complex value per
//      symbol, computed from the SNR-normalized c79 (n79) -- independent
//      per symbol, no barrier needed among these writes themselves, but a
//      barrier IS needed before phase 3 since phase 3 reads NEIGHBORS'
//      maxes[] entries (C_SOFT_WIN=+/-2), not just its own.
//   3) m79Soft[79*8]: for each (symbol, tone), sums the distance from
//      maxes[k] over a +/-2 symbol neighborhood -- needs maxes[] fully
//      written (barrier from phase 2) first.
//
// n79 (the SNR-normalized complex tone values) is kept in workgroup shared
// memory across all three phases -- phase 2's maxes[] and phase 3's
// distance sums both need the NORMALIZED values (not the raw c79 input),
// matching softDecode.ts's own convertToSnr()-before-everything-else
// ordering exactly.

// No per-candidate params buffer here (unlike symbolExtractFused.wgsl/
// searchBoth.wgsl) -- every candidate has the EXACT SAME fixed 79-symbol/
// 8-tone shape for this kernel, nothing varies per candidate at all, so
// there is genuinely no per-candidate scalar this kernel needs. An earlier
// revision included an unused `params: array<CandidateParams>` storage
// binding "for layout symmetry" with the other kernels -- WGSL's
// layout:'auto' pipeline creation silently DROPS any binding never actually
// referenced in the shader body from the generated bind group layout (not a
// compile error), so createBindGroup() then rejected the TS side's bind
// group (which still supplied an entry for that now-nonexistent binding
// index) with a real Dawn validation error, caught by real-GPU testing --
// removed entirely rather than kept as inert padding.
@group(0) @binding(0) var<uniform> n_batch: u32;
@group(0) @binding(1) var<storage, read> in_c79: array<vec2<f32>>; // [batch][79*8], flattened -- raw complex tone bins from symbolExtractFused.wgsl
@group(0) @binding(2) var<storage, read_write> out_m79_soft: array<f32>; // [batch][79*8], flattened
@group(0) @binding(3) var<storage, read_write> out_maxes: array<vec2<f32>>; // [batch][79], flattened

const WG_SIZE: u32 = 256u;
const SNR_WIN: i32 = 7;
const C_SOFT_WEIGHT: f32 = 7.0;
const C_SOFT_WIN: i32 = 2;

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

// blackman(2*SNR_WIN+1): computed in-shader with the exact same closed
// form as dsp.ts's blackman() (0.42 - 0.5*cos(2*pi*k/n) + 0.08*cos(4*pi*k/n))
// rather than a hand-transcribed constant table -- SNR_WIN=7 is fixed here
// (matching softDecode.ts's own SNR_WIN constant), but computing the 15 taps
// live guarantees exact agreement with the CPU formula with zero transcription
// risk (an earlier draft of this file hardcoded a 15-element table by hand
// and it was WRONG -- values for a differently-parameterized Blackman window
// crept in; recomputing from the formula every workgroup is trivially cheap
// at 15 taps and removes that whole bug class).
const SNR_WIN_TAPS: u32 = 15u; // 2*SNR_WIN+1
const PI: f32 = 3.141592653589793;

fn blackman_tap(k: u32) -> f32 {
  let n = f32(SNR_WIN_TAPS);
  let kf = f32(k);
  return 0.42 - 0.5 * cos(2.0 * PI * kf / n) + 0.08 * cos(4.0 * PI * kf / n);
}

var<workgroup> mm: array<f32, 79>; // per-symbol weakest-tone raw magnitude (SNR_HOW=3)
var<workgroup> n79_re: array<f32, 79 * 8>;
var<workgroup> n79_im: array<f32, 79 * 8>;
var<workgroup> maxes_re: array<f32, 79>;
var<workgroup> maxes_im: array<f32, 79>;

fn sym_costas_idx(si: u32) -> i32 {
  if (si < 7u) { return i32(costas(si)); }
  if (si >= 36u && si < 43u) { return i32(costas(si - 36u)); }
  if (si >= 72u) { return i32(costas(si - 72u)); }
  return -1;
}

@compute @workgroup_size(WG_SIZE)
fn main(@builtin(workgroup_id) wg_id: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
  let batch_idx = wg_id.x;
  if (batch_idx >= n_batch) {
    return;
  }
  let tid = lid.x;
  let in_base = batch_idx * 79u * 8u;
  let out_base = batch_idx * 79u * 8u;
  let maxes_out_base = batch_idx * 79u;

  // Phase 1a: per-symbol weakest-of-8-tones raw magnitude (mm[si]).
  var si = tid;
  loop {
    if (si >= 79u) { break; }
    var minMag = -1.0;
    for (var bi = 0u; bi < 8u; bi = bi + 1u) {
      let c = in_c79[in_base + si * 8u + bi];
      let mag = sqrt(c.x * c.x + c.y * c.y);
      if (minMag < 0.0 || mag < minMag) { minMag = mag; }
    }
    mm[si] = minMag;
    si = si + WG_SIZE;
  }
  workgroupBarrier();

  // Phase 1b: Blackman-windowed +/-SNR_WIN neighbor sum of mm[], edge-clamped
  // by repeating the boundary value (matches convertToSnr()'s dd<0/dd>=79
  // branches exactly) -- then divide this symbol's raw complex c79 values by
  // that neighborhood-smoothed scalar to produce n79.
  var si2 = tid;
  loop {
    if (si2 >= 79u) { break; }
    var sum = 0.0;
    for (var dd = i32(si2) - SNR_WIN; dd <= i32(si2) + SNR_WIN; dd = dd + 1) {
      let wi = u32(dd - (i32(si2) - SNR_WIN));
      let w = blackman_tap(wi);
      var v: f32;
      if (dd >= 0 && dd < 79) { v = mm[u32(dd)]; }
      else if (dd < 0) { v = mm[0]; }
      else { v = mm[78]; }
      sum = sum + v * w;
    }
    for (var bi = 0u; bi < 8u; bi = bi + 1u) {
      let c = in_c79[in_base + si2 * 8u + bi];
      n79_re[si2 * 8u + bi] = c.x / sum;
      n79_im[si2 * 8u + bi] = c.y / sum;
    }
    si2 = si2 + WG_SIZE;
  }
  workgroupBarrier();

  // Phase 2: maxes[si] -- Costas-consensus tone for sync symbols, strongest
  // tone for data symbols, read from the just-computed n79 (SNR-normalized).
  var si3 = tid;
  loop {
    if (si3 >= 79u) { break; }
    let ci = sym_costas_idx(si3);
    var bestRe: f32;
    var bestIm: f32;
    if (ci >= 0) {
      bestRe = n79_re[si3 * 8u + u32(ci)];
      bestIm = n79_im[si3 * 8u + u32(ci)];
    } else {
      var bestMag = -1.0;
      bestRe = 0.0;
      bestIm = 0.0;
      for (var bi = 0u; bi < 8u; bi = bi + 1u) {
        let re = n79_re[si3 * 8u + bi];
        let im = n79_im[si3 * 8u + bi];
        let mag = sqrt(re * re + im * im);
        if (bestMag < 0.0 || mag > bestMag) { bestMag = mag; bestRe = re; bestIm = im; }
      }
    }
    maxes_re[si3] = bestRe;
    maxes_im[si3] = bestIm;
    out_maxes[maxes_out_base + si3] = vec2<f32>(bestRe, bestIm);
    si3 = si3 + WG_SIZE;
  }
  workgroupBarrier();

  // Phase 3: m79Soft[si][bi] -- sum of distances from neighbors' maxes[]
  // over a +/-C_SOFT_WIN symbol window, with the symbol's OWN tone
  // contributing -C_SOFT_WEIGHT*|c| instead of a distance (matches
  // cSoftDecode()'s k===i branch exactly).
  var idx = tid;
  loop {
    if (idx >= 79u * 8u) { break; }
    let i = idx / 8u;
    let j = idx % 8u;
    let cRe = n79_re[idx];
    let cIm = n79_im[idx];
    var n = 0.0;
    var sum = 0.0;
    for (var k = i32(i) - C_SOFT_WIN; k <= i32(i) + C_SOFT_WIN; k = k + 1) {
      if (k < 0 || k >= 79) { continue; }
      if (k == i32(i)) {
        sum = sum - C_SOFT_WEIGHT * sqrt(cRe * cRe + cIm * cIm);
      } else {
        let mRe = maxes_re[u32(k)];
        let mIm = maxes_im[u32(k)];
        let dRe = mRe - cRe;
        let dIm = mIm - cIm;
        sum = sum + sqrt(dRe * dRe + dIm * dIm);
      }
      n = n + 1.0;
    }
    out_m79_soft[out_base + idx] = 0.0 - sum / n;
    idx = idx + WG_SIZE;
  }
}
