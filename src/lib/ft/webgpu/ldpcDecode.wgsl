// LDPC(174,91) sum-product belief-propagation decoder — WGSL port of
// ldpc_decode() in lib/ft8mon/libldpc.c:55-174, one invocation per
// SYNC CANDIDATE (task parallelism, not data parallelism within one
// decode) — each candidate's 174-bit LLR input is fully independent of
// every other candidate's, exactly matching the CPU version's per-candidate
// decode() call (see ft8.cc:2210+ / one_iter1() at ft8.cc:2664+).
//
// f32 precision confirmed safe by cross-checking a Math.fround-simulated
// f32 TS port (ldpcDecodeF32.ts) against ft8mon's OWN real LLR/output pairs
// captured from actual decodes (see __tests__/ldpcDecodeRealData.test.ts) —
// 19/19 real successful decodes reproduced bit-for-bit at f32 precision,
// including cases with graduated (non-hint-forced) soft-decision LLR
// values, not just the ldpc_iters=25 max-confidence ±4.97 hint-forced case.
//
// This is the ~86%-of-decode-time stage (per profiling: coarse Costas
// search is ~14%, per-candidate fine-decode/LDPC is ~86%) — the actual
// target of the GPU feasibility prototype, unlike the coarse-search kernel
// (fft1920.wgsl/costasCorrelation.wgsl) which was step 1 to de-risk the
// GPU buffer/dispatch pipeline on an easier, lower-payoff piece first.
//
// SCRATCH MEMORY: libldpc.c's m[83][174]/e[83][174] are stack-allocated in
// C (~232KB combined at double precision — why the WASM build needs
// STACK_SIZE=8388608, see project CLAUDE.md). Naively porting those as WGSL
// function-local ("private" address space) arrays would put ~115KB of
// private state on EVERY invocation — verified against the WGSL spec this
// is unsafe: the guaranteed minimum for function/private-address-space
// storage is only 8192 bytes (WGSL limits table), so ~115KB is ~14x over
// the portable floor. Some implementations (e.g. Safari/WebKit) may refuse
// to compile it; others (Chrome/Dawn) may compile but silently spill to
// slow off-chip "local memory," and at that size realistic occupancy would
// be ~1 invocation per compute unit — effectively serializing the whole
// dispatch. Fix: m/e live in a `storage` scratch buffer sized
// (n_candidates * 83 * 174 * 4 bytes), one slice per candidate, indexed
// explicitly — the standard idiom for "each invocation needs large
// per-thread scratch space" in WGSL. Only the small per-invocation locals
// (codeword/cw/best_cw, 174 elements each, well under the 8KB floor even
// combined) stay as function-local `var`s.
//
// Early exit (syndrome=83) is per-invocation only, exactly like the CPU's
// early `return` — no cooperative/shared state between candidates, so one
// GPU thread finishing early while siblings keep iterating is a pure
// performance detail, never a correctness concern (confirmed against the
// WebGPU spec: WGSL permits data-dependent branching/early-return within a
// single invocation; only WORKGROUP-level operations like barriers require
// uniform control flow across a subgroup, and this kernel uses none).

const LDPC_N: u32 = 174u;
const LDPC_CHECKS: u32 = 83u;
const NM_MAX_DEGREE: u32 = 7u;
const MN_DEGREE: u32 = 3u;

struct Params {
  n_candidates: u32,
  iters: u32,
  _pad0: u32,
  _pad1: u32,
}

@group(0) @binding(0) var<uniform> params: Params;
// Flattened Nm[83][7], 0-origin, -1 = unused sentinel (matches
// ldpcMatrix.ts's flattenNm() exactly).
@group(0) @binding(1) var<storage, read> nm: array<i32>;
// Flattened Mn[174][3], 0-origin (matches flattenMn() exactly).
@group(0) @binding(2) var<storage, read> mn: array<i32>;
// Input: n_candidates * 174 f32 LLR values, one 174-block per candidate.
@group(0) @binding(3) var<storage, read> llr_in: array<f32>;
// Output: n_candidates * 174 u32 decoded bits (0/1), one 174-block per candidate.
@group(0) @binding(4) var<storage, read_write> plain_out: array<u32>;
// Output: n_candidates u32 syndrome scores (0-83; 83 = full success).
@group(0) @binding(5) var<storage, read_write> ok_out: array<u32>;
// Per-candidate scratch for m[83][174] and e[83][174], flattened:
// scratch[candidate * (2*83*174) + which*83*174 + j*174 + i], which=0 for m,
// which=1 for e. Sized (n_candidates * 2*83*174) f32 elements by the host.
@group(0) @binding(6) var<storage, read_write> scratch: array<f32>;

const MN_STRIDE: u32 = LDPC_CHECKS * LDPC_N; // one candidate's m (or e) block size
const CANDIDATE_SCRATCH_STRIDE: u32 = 2u * MN_STRIDE; // m block + e block

fn m_idx(base: u32, j: u32, i: u32) -> u32 {
  return base + j * LDPC_N + i;
}
fn e_idx(base: u32, j: u32, i: u32) -> u32 {
  return base + MN_STRIDE + j * LDPC_N + i;
}

fn ldpc_check(cw: ptr<function, array<u32, 174>>) -> u32 {
  var score: u32 = 0u;
  for (var j: u32 = 0u; j < LDPC_CHECKS; j = j + 1u) {
    var x: u32 = 0u;
    for (var k: u32 = 0u; k < NM_MAX_DEGREE; k = k + 1u) {
      let i1 = nm[j * NM_MAX_DEGREE + k];
      if (i1 >= 0) {
        x = x ^ (*cw)[u32(i1)];
      }
    }
    if (x == 0u) {
      score = score + 1u;
    }
  }
  return score;
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let candidate = gid.x;
  if (candidate >= params.n_candidates) {
    return;
  }

  let llr_base = candidate * LDPC_N;
  let out_base = candidate * LDPC_N;
  let scratch_base = candidate * CANDIDATE_SCRATCH_STRIDE;

  // Small per-invocation locals only (174 elements each — well within the
  // WGSL-guaranteed 8192-byte private/function storage floor even combined:
  // 174*4*3 = ~2088 bytes for codeword+cw+best_cw as f32/u32/u32).
  var codeword: array<f32, LDPC_N>;
  var cw: array<u32, LDPC_N>;
  var best_cw: array<u32, LDPC_N>;
  var best_score: i32 = -1;

  // llr -> P(zero): p = e^x / (1 + e^x)
  for (var i: u32 = 0u; i < LDPC_N; i = i + 1u) {
    let ex = exp(llr_in[llr_base + i]);
    codeword[i] = ex / (1.0 + ex);
  }

  for (var j: u32 = 0u; j < LDPC_CHECKS; j = j + 1u) {
    for (var i: u32 = 0u; i < LDPC_N; i = i + 1u) {
      scratch[m_idx(scratch_base, j, i)] = codeword[i];
      scratch[e_idx(scratch_base, j, i)] = 0.0;
    }
  }

  var converged: bool = false;

  for (var iter: u32 = 0u; iter < params.iters; iter = iter + 1u) {
    // Check -> variable update
    for (var j: u32 = 0u; j < LDPC_CHECKS; j = j + 1u) {
      for (var ii1: u32 = 0u; ii1 < NM_MAX_DEGREE; ii1 = ii1 + 1u) {
        let i1 = nm[j * NM_MAX_DEGREE + ii1];
        if (i1 < 0) {
          continue;
        }
        var a: f32 = 1.0;
        for (var ii2: u32 = 0u; ii2 < NM_MAX_DEGREE; ii2 = ii2 + 1u) {
          let i2 = nm[j * NM_MAX_DEGREE + ii2];
          if (i2 >= 0 && u32(i2) != u32(i1)) {
            let tmp = 1.0 - 2.0 * (1.0 - scratch[m_idx(scratch_base, j, u32(i2))]);
            a = a * tmp;
          }
        }
        scratch[e_idx(scratch_base, j, u32(i1))] = 0.5 + 0.5 * a;
      }
    }

    // Tentative codeword + syndrome check
    for (var i: u32 = 0u; i < LDPC_N; i = i + 1u) {
      var q0: f32 = codeword[i];
      var q1: f32 = 1.0 - q0;
      for (var k: u32 = 0u; k < MN_DEGREE; k = k + 1u) {
        let j2 = u32(mn[i * MN_DEGREE + k]);
        let ev = scratch[e_idx(scratch_base, j2, i)];
        q0 = q0 * ev;
        q1 = q1 * (1.0 - ev);
      }
      var p: f32;
      if (q0 == 0.0) {
        p = 1.0;
      } else {
        p = 1.0 / (1.0 + (q1 / q0));
      }
      cw[i] = select(0u, 1u, p <= 0.5);
    }

    let score = ldpc_check(&cw);
    if (score == LDPC_CHECKS) {
      for (var i: u32 = 0u; i < LDPC_N; i = i + 1u) {
        plain_out[out_base + i] = cw[i];
      }
      ok_out[candidate] = LDPC_CHECKS;
      converged = true;
      break;
    }

    if (i32(score) > best_score) {
      best_score = i32(score);
      for (var i: u32 = 0u; i < LDPC_N; i = i + 1u) {
        best_cw[i] = cw[i];
      }
    }

    // Variable -> check update
    for (var i: u32 = 0u; i < LDPC_N; i = i + 1u) {
      for (var ji1: u32 = 0u; ji1 < MN_DEGREE; ji1 = ji1 + 1u) {
        let j1 = u32(mn[i * MN_DEGREE + ji1]);
        var q0: f32 = codeword[i];
        var q1: f32 = 1.0 - q0;
        for (var ji2: u32 = 0u; ji2 < MN_DEGREE; ji2 = ji2 + 1u) {
          let j2 = u32(mn[i * MN_DEGREE + ji2]);
          if (j1 != j2) {
            let ev = scratch[e_idx(scratch_base, j2, i)];
            q0 = q0 * ev;
            q1 = q1 * (1.0 - ev);
          }
        }
        var p: f32;
        if (q0 == 0.0) {
          p = 1.0;
        } else {
          p = 1.0 / (1.0 + (q1 / q0));
        }
        scratch[m_idx(scratch_base, j1, i)] = p;
      }
    }
  }

  if (!converged) {
    for (var i: u32 = 0u; i < LDPC_N; i = i + 1u) {
      plain_out[out_base + i] = best_cw[i];
    }
    ok_out[candidate] = u32(best_score);
  }
}
