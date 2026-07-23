// Fused single-dispatch GPU port of subtract()'s per-candidate window work
// (ft8.cc:2763-2912, ported to TS in subtract.ts's subtractDecodedSignal()):
// given the candidate's own hilbert_shift()-forward-shifted window ("moved",
// uploaded by the CPU orchestration — see subtractGpu.ts for why the
// WHOLE-buffer analytic()/hilbert_shift steps themselves stay on CPU, same
// "too large for one workgroup" reasoning as gpuDecodePipeline.ts's own
// wholeBufferBins), this kernel does subtract()'s remaining per-candidate
// work entirely on GPU:
//   1) per-symbol amplitude+phase extraction: a single-bin direct DFT per
//      symbol (block=1920 samples, 79 symbols) at the candidate's decoded
//      tone bin (bin0+re79[si]) — NOT symbolExtractFused.wgsl's 8-bin
//      extraction (that kernel is N=32/200sps; this is N=1920/12kHz-rate,
//      genuinely different block size, hence a new kernel rather than
//      reusing that one, per the task doc's own note).
//   2) the ramped waveform synthesis + subtraction (subtract()'s fiddly
//      dtheta/phase-correction math, ported verbatim from subtract.ts).
//
// One workgroup per candidate. Extraction (step 1) needs a barrier before
// synthesis (step 2) can run, because synthesis at symbol si reads
// phases[si+1]/amps[si+1] (the NEXT symbol's measured amp/phase) — so
// amps/phases are staged through a small workgroup-shared array (79 floats
// each, 632 bytes total — trivial next to fftGeneralFused.wgsl's 64KB
// budget), with one workgroupBarrier() between the two phases, same
// "barrier separates all-writes-done from any cross-invocation read" shape
// searchBoth.wgsl's own header documents.
//
// Round-robin work distribution (idx, idx+WG_SIZE, ...) over both phases,
// matching symbolExtractFused.wgsl/searchBoth.wgsl's own established
// pattern — extraction's 79 symbols are fully independent of each other, and
// synthesis's per-symbol ramp math (though it reads si+1's phase/hz) never
// WRITES anything another invocation reads, so no data race despite the
// cross-symbol read.
//
// f32 PRECISION FIX (found via a real headless-GPU run against the CPU
// reference, NOT visible from code review alone): `theta` at the start of
// the transition-ramp is phase + (BLOCK-ramp)*dtheta, which is O(1000-2000)
// in magnitude (dtheta~1 rad/sample, BLOCK~1920) — fine for cos()'s own
// internal range reduction, but FATAL for `actual`/`target_phase`'s
// subtraction: `target_phase - actual` is the physically meaningful
// quantity (should be small, O(1e-4) for a clean signal) but both operands
// are computed as O(2000)-magnitude sums, and f32 (24-bit mantissa) only
// has ~2.4e-4 absolute precision at magnitude 2000 — LARGER than the true
// difference. This is catastrophic cancellation: `adj` (which depends on
// this difference) came out ~100x too large and wrong-signed in a direct
// numeric comparison against a f64 CPU trace at the exact same inputs,
// which explains a real, measured ~2.0-amplitude residual error at
// transition-ramp samples (see the task's own verification results).
// Fix: wrap theta into [-PI,PI] via wrap_theta() at every point it's
// produced (cos() only ever needs it mod 2*PI, so this changes nothing
// mathematically) BEFORE it's used in any subtraction-sensitive
// computation, keeping every intermediate magnitude small and f32-safe.
fn wrap_theta(t: f32) -> f32 {
  return t - round(t / TWO_PI) * TWO_PI;
}

struct CandidateParams {
  off0: i32, // symbol-0 start sample index into this candidate's `moved` window
  bin0: i32, // (hz0+hz1)/2 rounded to a bin number
  ramp: i32, // round(block * subtract_ramp), >= 1
}

const BLOCK: i32 = 1920;
const N_SYM: u32 = 79u;
const RATE: f32 = 12000.0;
const BIN_HZ: f32 = 6.25; // RATE / BLOCK
const TWO_PI: f32 = 6.283185307179586;
const WG_SIZE: u32 = 128u;
const MAX_WINDOW_LEN: u32 = 155008u; // headroom above 79*1920+1920 = 153600 (one extra block of margin for off0 clamping, matches this repo's other MAX_* headroom convention)

@group(0) @binding(0) var<uniform> n_batch: u32;
@group(0) @binding(1) var<storage, read> params: array<CandidateParams>;
@group(0) @binding(2) var<storage, read> re79: array<i32>; // [batch][79], flattened
@group(0) @binding(3) var<storage, read> moved: array<f32>; // [batch][MAX_WINDOW_LEN], flattened -- candidate's own hilbert_shift-forward-shifted window, ALREADY sliced so index 0 = off0-BLOCK (one block of left margin, for the initial-ramp read safety — see subtractGpu.ts)
@group(0) @binding(4) var<storage, read_write> out_residual: array<f32>; // [batch][MAX_WINDOW_LEN], flattened -- moved with the synthesized waveform subtracted (same layout/margin as `moved`)

var<workgroup> amps: array<f32, N_SYM>;
var<workgroup> phases: array<f32, N_SYM>;

const LEFT_MARGIN: i32 = BLOCK; // moved[]/out_residual[] index 0 corresponds to (off0 - LEFT_MARGIN)

fn dft_one_bin(batch_base: u32, base: i32, bin: i32) -> vec2<f32> {
  var re = 0.0;
  var im = 0.0;
  let theta0 = -TWO_PI * f32(bin) / f32(BLOCK);
  for (var n = 0; n < BLOCK; n = n + 1) {
    let idx = base + n;
    var x = 0.0;
    if (idx >= 0 && u32(idx) < MAX_WINDOW_LEN) {
      x = moved[batch_base + u32(idx)];
    }
    let theta = theta0 * f32(n);
    re = re + x * cos(theta);
    im = im + x * sin(theta);
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
  let batch_base = batch_idx * MAX_WINDOW_LEN;
  let re79_base = batch_idx * N_SYM;

  // --- Phase 1: per-symbol amplitude/phase extraction ---
  var idx = tid;
  loop {
    if (idx >= N_SYM) { break; }
    let sym = p.bin0 + re79[re79_base + idx];
    // moved[] is laid out with LEFT_MARGIN samples before off0, so the
    // absolute sample (off0 + BLOCK*si) is at local index (LEFT_MARGIN + BLOCK*si).
    let base = LEFT_MARGIN + i32(idx) * BLOCK;
    let c = dft_one_bin(batch_base, base, sym);
    phases[idx] = atan2(c.y, c.x);
    // FFT multiplies magnitudes by number of bins, or half the number of samples.
    amps[idx] = length(c) / (f32(BLOCK) / 2.0);
    idx = idx + WG_SIZE;
  }

  workgroupBarrier();

  // Copy the full window through unchanged first (out_residual = moved),
  // so every sample outside a symbol's own subtraction range still carries
  // the right (unmodified) value — mirrors subtract.ts's `moved` being
  // mutated in place, just done as copy-then-subtract here since GPU
  // invocations write disjoint output, not a shared mutable input array.
  var ci = tid;
  loop {
    if (ci >= MAX_WINDOW_LEN) { break; }
    out_residual[batch_base + ci] = moved[batch_base + ci];
    ci = ci + WG_SIZE;
  }

  workgroupBarrier();

  // --- Phase 2: ramped synthesis + subtraction, one invocation per symbol ---
  // (subtract()'s ramp math is inherently sequential WITHIN a symbol's
  // sample loop — dtheta/theta/adj accumulate sample-by-sample — but
  // DIFFERENT symbols' loops are fully independent of each other, aside
  // from each reading si+1's already-extracted phases/amps from the
  // shared array populated in Phase 1. So: one invocation per symbol,
  // handed out round-robin same as Phase 1, each invocation running its
  // OWN sequential inner loop.)
  var si = tid;
  loop {
    if (si >= N_SYM) { break; }

    let sym = p.bin0 + re79[re79_base + si];
    let phase = phases[si];
    let amp = amps[si];
    let hz = BIN_HZ * f32(sym);
    let dtheta0 = TWO_PI / (RATE / hz);

    let sym_base = LEFT_MARGIN + i32(si) * BLOCK;

    // initial ramp part of symbol 0 only.
    if (si == 0u) {
      for (var jj = 0; jj < p.ramp; jj = jj + 1) {
        let theta = wrap_theta(phase + f32(jj) * dtheta0);
        var x = amp * cos(theta);
        x = x * (f32(jj) / f32(p.ramp));
        let iii = sym_base + jj;
        out_residual[batch_base + u32(iii)] = out_residual[batch_base + u32(iii)] - x;
      }
    }

    // steady part between ramps.
    for (var jj = p.ramp; jj < BLOCK - p.ramp; jj = jj + 1) {
      let theta = wrap_theta(phase + f32(jj) * dtheta0);
      let x = amp * cos(theta);
      let iii = sym_base + jj;
      out_residual[batch_base + u32(iii)] = out_residual[batch_base + u32(iii)] - x;
    }

    // the two ramps into the next symbol.
    // theta is wrapped into [-PI,PI] at every step from here on (see
    // wrap_theta()'s doc comment above) — cos() only ever needs theta mod
    // 2*PI, so this is exact, and it keeps actual/target_phase's difference
    // (the physically meaningful quantity) from being swamped by f32
    // rounding on an unnecessarily large absolute magnitude.
    var theta = wrap_theta(phase + f32(BLOCK - p.ramp) * dtheta0);
    var dtheta = dtheta0;

    var hz1: f32;
    var phase1: f32;
    if (si + 1u >= N_SYM) {
      hz1 = hz;
      phase1 = phase;
    } else {
      let sym1 = p.bin0 + re79[re79_base + si + 1u];
      hz1 = BIN_HZ * f32(sym1);
      phase1 = phases[si + 1u];
    }
    let dtheta1 = TWO_PI / (RATE / hz1);

    let ramp_f = f32(p.ramp);
    let inc = (dtheta1 - dtheta) / (2.0 * ramp_f);

    let actual = wrap_theta(theta + dtheta * 2.0 * ramp_f + (inc * 4.0 * ramp_f * ramp_f) / 2.0);
    var target_phase = wrap_theta(phase1 + dtheta1 * ramp_f);

    var iter = 0;
    loop {
      if (abs(target_phase - actual) <= 3.141592653589793 || iter > 100) { break; }
      if (target_phase < actual) { target_phase = target_phase + TWO_PI; } else { target_phase = target_phase - TWO_PI; }
      iter = iter + 1;
    }

    let adj = target_phase - actual;

    var end = BLOCK + p.ramp;
    if (si == N_SYM - 1u) { end = BLOCK; }

    var jj = BLOCK - p.ramp;
    loop {
      if (jj >= end) { break; }
      let iii = sym_base + jj;
      var x = amp * cos(theta);

      if (si == N_SYM - 1u) {
        x = x * (1.0 - (f32(jj - (BLOCK - p.ramp)) / ramp_f));
      }

      out_residual[batch_base + u32(iii)] = out_residual[batch_base + u32(iii)] - x;

      theta = wrap_theta(theta + dtheta);
      dtheta = dtheta + inc;
      theta = wrap_theta(theta + adj / (2.0 * ramp_f));
      jj = jj + 1;
    }

    si = si + WG_SIZE;
  }
}
