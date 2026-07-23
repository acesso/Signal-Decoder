// Ordered-statistics decoder (OSD) for LDPC(174,91) — WGSL port of
// lib/ft8mon/osd.cc's osd_decode()/gauss_jordan()/matmul()/osd_score()/
// osd_check()/ldpc_encode(), cross-checked against the plain-TS reference
// (osdDecode.ts) — see that file's header for the exact same algorithm
// description. One WORKGROUP per candidate (task parallelism across
// candidates, data parallelism WITHIN a candidate for the sort's O(n^2)
// compare-pass and gauss_jordan's per-step elimination pass), matching this
// codebase's established shape (searchBoth.wgsl: one workgroup per
// candidate, workgroupBarrier()-separated sequential stages each
// internally parallel across the workgroup's threads).
//
// MEMORY LAYOUT (see osdWorkgroupBudget.ts for the full accounting):
// - `b` (osd.cc's 174x182 int matrix gauss_jordan() operates on) is FAR too
//   large for WGSL workgroup/shared memory (126672 bytes; guaranteed
//   minimum maxComputeWorkgroupStorageSize is only 16384) — exactly the
//   same problem ldpcDecode.wgsl's m[83][174]+e[83][174] scratch hit (see
//   that file's header comment), solved the same way: `b` lives in a
//   per-candidate slice of a `storage` scratch buffer the host allocates
//   (n_candidates * OSD_B_STRIDE elements), NOT `var<workgroup>`.
// - gen1_inv (91x91 i32, 33124 bytes) and the small 174-/91-element arrays
//   (which/strength_bits/y1/xplain/best_plain) DO fit comfortably in
//   workgroup memory and are declared `var<workgroup>` — FIXED size,
//   independent of n_candidates/depth (one workgroup per candidate, so
//   per-workgroup footprint never grows with batch size).
//
// SORT: WGSL has no std::sort. A selection sort over 174 elements (find the
// max-|LLR| remaining element, swap it to the front, repeat) is used —
// O(n^2)=~30276 compares, trivial for a one-time per-candidate cost, same
// "obvious correctness over cleverness" choice searchBoth.wgsl's
// dft32_one_bin makes for its small fixed-N DFT (see that kernel's own
// header comment). The compare/argmax-scan for each of the 174 selection
// steps IS parallelized across the workgroup (each thread scans a strided
// subset, writes its local best to a workgroup array, one barrier, tid==0
// picks the global best and does the swap) — same "parallel independent
// writes to disjoint slots, then one thread's serial linear scan" reduction
// shape as searchBoth.wgsl's own final best-slot scan (see that kernel's
// header comment justifying this exact choice for small fixed-size
// reductions).
//
// GAUSS-JORDAN: 91 SEQUENTIAL elimination steps, each: (a) pivot check+
// search+swap (real data-dependent, done by tid==0 only, since a single
// row-compare-and-swap is cheap and doing it on one thread avoids any
// possibility of two threads racing on the same swap), workgroupBarrier(),
// then (b) the elimination pass over the other 173 (of 174) rows, which IS
// parallelized: each thread handles a strided subset of rows. A
// workgroupBarrier() separates every step from the next, exactly matching
// run_fft_stages()'s per-stage barrier discipline in searchBoth.wgsl/
// fftGeneralFused.wgsl (91 sequential barriers here vs. that kernel's
// num_stages) — required because step N's elimination reads/writes rows
// that step N+1's pivot search and elimination both depend on.
//
// CRC/SCORE/CHECK: cheap (82-length polynomial division, 174-element score
// sum, 91-element all-zero check) relative to gauss_jordan's O(91*174)
// elimination — done by tid==0 only per depth-loop iteration, avoiding any
// cross-thread synchronization complexity for a part of the computation
// that is not the bottleneck.
//
// DEPTH LOOP: does NOT early-exit (matches osd.cc:197-212 exactly — the
// loop always runs all `depth` iterations, keeping the best-scoring valid
// result seen, not the first). `depth` is a runtime uniform (this app's
// live default is 2 — see decoder.worker.ts's osdDepth), not a compile-time
// constant, so it stays tunable without a kernel rebuild.

const OSD_N: u32 = 174u;
const OSD_K: u32 = 91u;
const OSD_B_COLS: u32 = 182u; // 2*OSD_K
const OSD_SCORE_LLR_SCALE: f32 = 4.6;
const OSD_THRESH: f32 = -500.0;
const WG_SIZE: u32 = 128u;

struct Params {
  n_candidates: u32,
  depth: u32,
  _pad0: u32,
  _pad1: u32,
}

@group(0) @binding(0) var<uniform> params: Params;
// Flattened GEN_SYS[174][91], row-major, uploaded ONCE (fixed constant,
// shared read-only across every candidate in every dispatch — matches
// ldpcMatrix.ts's flattenNm()/flattenMn() upload-once discipline).
@group(0) @binding(1) var<storage, read> gen_sys: array<u32>;
// Input: n_candidates * 174 f32 LLR values, one 174-block per candidate
// (positive favors bit=0, same convention as ldpcDecode.wgsl's llr_in).
@group(0) @binding(2) var<storage, read> ll174_in: array<f32>;
// Output: n_candidates * 91 u32 decoded plain bits, one 91-block per candidate.
@group(0) @binding(3) var<storage, read_write> plain_out: array<u32>;
// Output: n_candidates u32 (1=ok, 0=no valid decode found).
@group(0) @binding(4) var<storage, read_write> ok_out: array<u32>;
// Output: n_candidates i32 depth actually used (0 = zero-flip; -1 = failed).
@group(0) @binding(5) var<storage, read_write> depth_out: array<i32>;
// Per-candidate scratch for `b` (osd.cc's 174x182 int matrix) — far too
// large for workgroup memory, see module header. Sized
// (n_candidates * OSD_N * OSD_B_COLS) i32 elements by the host.
@group(0) @binding(6) var<storage, read_write> b_scratch: array<i32>;

const B_STRIDE: u32 = OSD_N * OSD_B_COLS;

fn b_idx(base: u32, row: u32, col: u32) -> u32 {
  return base + row * OSD_B_COLS + col;
}

// FIXED-size workgroup memory, independent of n_candidates/depth (see
// osdWorkgroupBudget.ts's OSD_FIXED_WORKGROUP_BYTES for the exact byte
// accounting this must match).
var<workgroup> gen1_inv: array<i32, OSD_K * OSD_K>;
var<workgroup> which_arr: array<u32, OSD_N>;
// Strength stored as its bit pattern (bitcast<u32>) rather than f32 directly
// -- WGSL atomics require u32/i32; not using atomics here (writes are to
// disjoint per-selection-step scratch, see argmax_buf below), but keeping
// this array u32-typed keeps its role (a sort KEY, compared via bitcast
// back to f32) visually distinct from the LLR VALUES array (ll_cache),
// which stays f32.
var<workgroup> strength_bits: array<u32, OSD_N>;
var<workgroup> ll_cache: array<f32, OSD_N>;
var<workgroup> y1: array<u32, OSD_K>;
var<workgroup> xplain: array<u32, OSD_K>;
var<workgroup> best_plain: array<u32, OSD_K>;
// Selection-sort per-thread local-best scratch: (value_bits, index) pairs,
// one slot per thread — same "parallel independent writes to disjoint
// slots, one thread does the final serial scan" shape as searchBoth.wgsl's
// score_buf reduction (see that kernel's header comment).
var<workgroup> argmax_val: array<u32, WG_SIZE>;
var<workgroup> argmax_idx: array<u32, WG_SIZE>;
// Gauss-Jordan pivot-search result, written by tid==0 only but declared
// workgroup-scope so every thread can read it after the barrier.
var<workgroup> pivot_row1: array<u32, 1>;
var<workgroup> pivot_ok: array<u32, 1>;
var<workgroup> crc_buf: array<u32, 96>; // ft8_crc()'s msg[] scratch (82+14), tid==0 only

fn gen_sys_at(row: u32, col: u32) -> u32 {
  return gen_sys[row * OSD_K + col];
}

// Selection sort: for each output position `pos` (0..173), find the
// remaining element (index >= pos) with the largest |LLR|, swap it into
// position `pos`. The argmax scan for each `pos` is parallelized across the
// workgroup; the actual swap (tiny, 1 element) is done by tid==0 only.
fn sort_by_strength(tid: u32) {
  for (var i = tid; i < OSD_N; i = i + WG_SIZE) {
    which_arr[i] = i;
    let x = ll_cache[i];
    strength_bits[i] = bitcast<u32>(select(x, -x, x < 0.0));
  }
  workgroupBarrier();

  // Tie-break rule MUST match osdDecode.ts's `which.sort((a, b) =>
  // strength[b] - strength[a])` exactly -- JS's Array.prototype.sort is
  // STABLE (guaranteed since ES2019), so among strength ties the ORIGINAL
  // (pre-sort) index that appeared earlier wins. A real GPU run caught
  // this the hard way: an earlier revision broke ties by comparing the
  // current ARRAY POSITION `i` (which drifts after swaps), not the
  // original index stored in which_arr[i] -- for LLR inputs with several
  // bins at an identical saturated magnitude (a real, common case: this
  // app's hint-forced LLRs are literally +-4.97 for the ~165 "confident"
  // Costas-tone bits, see ldpcDecode.wgsl's own header comment on that
  // convention), this silently picked a DIFFERENT (but still valid-
  // looking) "strongest 91" ordering than osd_decode()'s own stable sort,
  // producing a different y1/gen1_inv and a DIFFERENT (still CRC-passing
  // in this specific case, since the corrupted plaintext still happened
  // to satisfy check_crc for some reordering, but wrong overall) decoded
  // message -- confirmed only by comparing actual which_arr/plain output
  // between this kernel and osdDecode.ts's CPU reference on synthetic
  // tied-LLR data, not caught by code review or by the WGSL compiler.
  // Fixed by comparing which_arr[i]/which_arr[j] (the ORIGINAL indices)
  // on ties, preferring the smaller one, exactly matching stable-sort
  // semantics regardless of how many swaps have already happened.
  for (var pos = 0u; pos < OSD_N; pos = pos + 1u) {
    var localBestVal: f32 = -1.0;
    var localBestOrig: u32 = 0xffffffffu;
    var localBestIdx: u32 = pos;
    var i = pos + tid;
    loop {
      if (i >= OSD_N) { break; }
      let v = bitcast<f32>(strength_bits[i]);
      let orig = which_arr[i];
      if (v > localBestVal || (v == localBestVal && orig < localBestOrig)) {
        localBestVal = v;
        localBestOrig = orig;
        localBestIdx = i;
      }
      i = i + WG_SIZE;
    }
    argmax_val[tid] = bitcast<u32>(localBestVal);
    argmax_idx[tid] = localBestIdx;
    workgroupBarrier();

    if (tid == 0u) {
      var bestVal: f32 = -1.0;
      var bestOrig: u32 = 0xffffffffu;
      var bestIdx: u32 = pos;
      let lim = min(WG_SIZE, OSD_N - pos);
      for (var t = 0u; t < lim; t = t + 1u) {
        let v = bitcast<f32>(argmax_val[t]);
        let candIdx = argmax_idx[t];
        let orig = which_arr[candIdx];
        if (v > bestVal || (v == bestVal && orig < bestOrig)) {
          bestVal = v;
          bestOrig = orig;
          bestIdx = candIdx;
        }
      }
      if (bestIdx != pos) {
        let tmpS = strength_bits[pos];
        strength_bits[pos] = strength_bits[bestIdx];
        strength_bits[bestIdx] = tmpS;
        let tmpW = which_arr[pos];
        which_arr[pos] = which_arr[bestIdx];
        which_arr[bestIdx] = tmpW;
      }
    }
    workgroupBarrier();
  }
}

// gauss_jordan(): 91 sequential elimination steps over `b` (in per-candidate
// storage scratch, base offset `bbase`). Mirrors libldpc.c:339-384 exactly.
// Returns true (1) if invertible.
fn gauss_jordan(bbase: u32, tid: u32) -> bool {
  // `failed` (workgroup-scope, all threads read the SAME barrier-synced
  // value) gates the REST of every step's body once a pivot search first
  // fails, WITHOUT ever `break`-ing the outer step loop early -- WGSL
  // requires workgroup-uniform control flow at every workgroupBarrier(),
  // and Dawn's real validator (unlike this kernel's earlier revision,
  // which used a data-dependent `break` here and failed
  // CreateShaderModule with "must only be called from uniform control
  // flow" on ACTUAL GPU hardware -- caught only by real compilation, not
  // by code review) treats a conditional `break` skipping later barriers
  // as non-uniform even when every invocation reads the identical
  // already-barrier-synced value. Running all 91 iterations and all
  // barriers UNCONDITIONALLY, gated only by a plain `if` around the
  // per-step WORK (not the loop's own continuation), sidesteps this
  // entirely and still matches gauss_jordan()'s own "no further real work
  // happens after the first failed pivot search" behavior (osd.cc's
  // *ok=0 early `return` -- b/gen1_inv end up partially-eliminated in
  // that case, which osd_check()'s CRC gate downstream makes safe, same
  // as osdDecode.ts's own preserved-verbatim non-early-return comment).
  var failed = false;
  for (var row = 0u; row < OSD_K; row = row + 1u) {
    if (tid == 0u) {
      if (!failed) {
        var found = b_scratch[b_idx(bbase, row, row)] == 1;
        var swapWith = row;
        if (!found) {
          for (var row1 = row + 1u; row1 < OSD_N; row1 = row1 + 1u) {
            if (b_scratch[b_idx(bbase, row1, row)] == 1) {
              swapWith = row1;
              found = true;
              break;
            }
          }
        }
        pivot_ok[0] = select(0u, 1u, found);
        pivot_row1[0] = swapWith;
      }
    }
    // b_scratch is a STORAGE buffer, not workgroup memory --
    // workgroupBarrier() alone only orders workgroup-address-space
    // accesses (per the WGSL memory model); storage-address-space accesses
    // need storageBarrier() too, added throughout this function on a real
    // GPU run's evidence (this codebase's other kernels only ever
    // barrier-synchronize workgroup memory, never storage memory across
    // invocations within one workgroup, so this requirement had no
    // existing precedent to copy here). Every barrier in this function now
    // pairs workgroupBarrier() with storageBarrier().
    workgroupBarrier();
    storageBarrier();

    if (!failed && pivot_ok[0] == 0u) {
      failed = true;
    }

    let swapWith = pivot_row1[0];
    if (!failed && swapWith != row) {
      if (tid == 0u) {
        for (var col = 0u; col < OSD_B_COLS; col = col + 1u) {
          let tmp = b_scratch[b_idx(bbase, row, col)];
          b_scratch[b_idx(bbase, row, col)] = b_scratch[b_idx(bbase, swapWith, col)];
          b_scratch[b_idx(bbase, swapWith, col)] = tmp;
        }
        // libldpc.c:357-359 ALSO swaps which[row]/which[row1] alongside the
        // matrix row swap -- an earlier revision of this kernel swapped
        // ONLY b_scratch's rows and never touched which_arr at all, a real
        // bug that produced a "successful"-looking gauss_jordan (same
        // gen1_inv-derived xplain math ran to completion, no NaN/garbage)
        // but with y1[]/gen1_inv built from the WRONG row-to-original-index
        // mapping downstream -- confirmed by direct comparison against
        // osdDecode.ts's gaussJordan() on synthetic tied-LLR data: this
        // kernel's own which_arr readback matched the CPU's PRE-elimination
        // sort order exactly, then silently diverged the moment any pivot
        // swap occurred (row 6 in the reproducing case), which code review
        // alone did not catch (the omission reads as "obviously fine" since
        // b_scratch's OWN swap is correct in isolation).
        let tmpW = which_arr[row];
        which_arr[row] = which_arr[swapWith];
        which_arr[swapWith] = tmpW;
      }
    }
    workgroupBarrier();
    storageBarrier();

    if (tid == 0u && !failed) {
      let diagCol = OSD_K + row;
      b_scratch[b_idx(bbase, row, diagCol)] = (b_scratch[b_idx(bbase, row, diagCol)] + 1) % 2;
    }
    workgroupBarrier();
    storageBarrier();

    // Elimination pass over the other 173 rows -- parallelized: each thread
    // handles a strided subset of rows (independent row-by-row work, no
    // cross-row dependency within a single step). Skipped entirely (but
    // the loop and its trailing barrier still run unconditionally, for the
    // same uniform-control-flow reason as above) once `failed` is true.
    var row1 = tid;
    loop {
      if (row1 >= OSD_N) { break; }
      if (!failed && row1 != row) {
        if (b_scratch[b_idx(bbase, row1, row)] != 0) {
          for (var col = 0u; col < OSD_B_COLS; col = col + 1u) {
            let sum = b_scratch[b_idx(bbase, row1, col)] + b_scratch[b_idx(bbase, row, col)];
            b_scratch[b_idx(bbase, row1, col)] = sum % 2;
          }
        }
      }
      row1 = row1 + WG_SIZE;
    }
    workgroupBarrier();
    storageBarrier();
  }
  return !failed;
}

// matmul(): xplain = gen1_inv * y1 (mod 2), parallelized one row per thread
// (91 independent dot products). Firefox's WGSL validator (naga) rejects a
// `ptr<workgroup, ...>` function PARAMETER ("Argument ... is a pointer of
// space WorkGroup, which can't be passed into functions") even though this
// compiled and ran fine on the headless Dawn/Vulkan sandbox build used
// during development — only found via a real getCompilationInfo() call on
// actual Firefox, not by code review or the sandbox's own GPU. Every call
// site here only ever operates on the SAME xplain/y1 module-level workgroup
// arrays, so the fix is to reference them directly instead of taking
// pointer parameters, rather than threading pointers through at all.
fn matmul_xplain_from_y1(tid: u32) {
  var i = tid;
  loop {
    if (i >= OSD_K) { break; }
    var sum: u32 = 0u;
    for (var j = 0u; j < OSD_K; j = j + 1u) {
      sum = sum + u32(gen1_inv[i * OSD_K + j]) * y1[j];
    }
    xplain[i] = sum % 2u;
    i = i + WG_SIZE;
  }
  workgroupBarrier();
}

// ldpc_encode(): 91-bit plain (the module-level `xplain` workgroup array) ->
// 174-bit codeword, written into a LOCAL (per-invocation, `function`-
// address-space) array -- only tid==0 ever calls this (see osd_score/
// osd_check below), so no workgroup-scope storage is needed for the
// codeword itself. Reads `xplain` directly (not via a pointer parameter) --
// see matmul_xplain_from_y1()'s header comment for why: Firefox's WGSL
// validator rejects `ptr<workgroup, ...>` function parameters, and every
// call site here only ever operates on `xplain` (never `best_plain`),
// confirmed by grepping every osd_score/osd_check call site before making
// this change.
fn ldpc_encode_local() -> array<u32, OSD_N> {
  var codeword: array<u32, OSD_N>;
  for (var i = 0u; i < OSD_K; i = i + 1u) {
    codeword[i] = xplain[i];
  }
  for (var i = 0u; i + OSD_K < OSD_N; i = i + 1u) {
    var sum: u32 = 0u;
    for (var j = 0u; j < OSD_K; j = j + 1u) {
      sum = sum + gen_sys_at(i + OSD_K, j) * xplain[j];
      codeword[i + OSD_K] = sum % 2u;
    }
  }
  return codeword;
}

// osd_score(): mirrors osd.cc:41-59 exactly -- tid==0 only (cheap, 174-element
// sum after a 174-entry encode, not the bottleneck).
fn osd_score(candidate_base: u32) -> f32 {
  let xcode = ldpc_encode_local();
  var score: f32 = 0.0;
  for (var i = 0u; i < OSD_N; i = i + 1u) {
    let llv = ll174_in[candidate_base + i];
    if (xcode[i] == 1u) {
      score = score - llv * OSD_SCORE_LLR_SCALE;
    } else {
      score = score + llv * OSD_SCORE_LLR_SCALE;
    }
  }
  return -score;
}

// check_crc()/ft8_crc(): mirrors crc.ts's checkCrc()/ft8Crc() exactly --
// tid==0 only. DIV is FT8's 14-bit CRC polynomial 0x2757 with leading 1 bit.
const DIV0: u32 = 1u; const DIV1: u32 = 1u; const DIV2: u32 = 0u; const DIV3: u32 = 0u;
const DIV4: u32 = 1u; const DIV5: u32 = 1u; const DIV6: u32 = 1u; const DIV7: u32 = 0u;
const DIV8: u32 = 1u; const DIV9: u32 = 0u; const DIV10: u32 = 1u; const DIV11: u32 = 0u;
const DIV12: u32 = 1u; const DIV13: u32 = 1u; const DIV14: u32 = 1u;

fn div_at(j: u32) -> u32 {
  if (j == 0u) { return DIV0; } if (j == 1u) { return DIV1; }
  if (j == 2u) { return DIV2; } if (j == 3u) { return DIV3; }
  if (j == 4u) { return DIV4; } if (j == 5u) { return DIV5; }
  if (j == 6u) { return DIV6; } if (j == 7u) { return DIV7; }
  if (j == 8u) { return DIV8; } if (j == 9u) { return DIV9; }
  if (j == 10u) { return DIV10; } if (j == 11u) { return DIV11; }
  if (j == 12u) { return DIV12; } if (j == 13u) { return DIV13; }
  return DIV14;
}

fn osd_check() -> bool {
  var allZero = true;
  for (var i = 0u; i < OSD_K; i = i + 1u) {
    if (xplain[i] != 0u) { allZero = false; }
  }
  if (allZero) { return false; }

  // crc_buf[0..81] = xplain[0..76] then zero (82-length msg, matches
  // checkCrc()'s "zero bits 77..90" behavior), crc_buf[82..95] = 0 padding.
  for (var i = 0u; i < 96u; i = i + 1u) { crc_buf[i] = 0u; }
  for (var i = 0u; i < 77u; i = i + 1u) { crc_buf[i] = xplain[i]; }

  for (var i = 0u; i < 82u; i = i + 1u) {
    if (crc_buf[i] != 0u) {
      for (var j = 0u; j < 15u; j = j + 1u) {
        crc_buf[i + j] = (crc_buf[i + j] + div_at(j)) % 2u;
      }
    }
  }

  for (var i = 0u; i < 14u; i = i + 1u) {
    if (crc_buf[82u + i] != xplain[91u - 14u + i]) { return false; }
  }
  return true;
}

@compute @workgroup_size(WG_SIZE)
fn main(@builtin(workgroup_id) wg_id: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
  let candidate = wg_id.x;
  if (candidate >= params.n_candidates) {
    return;
  }
  let tid = lid.x;
  let llr_base = candidate * OSD_N;
  let out91_base = candidate * OSD_K;
  let bbase = candidate * B_STRIDE;

  for (var i = tid; i < OSD_N; i = i + WG_SIZE) {
    ll_cache[i] = ll174_in[llr_base + i];
  }
  workgroupBarrier();

  sort_by_strength(tid);

  // b[i] = GEN_SYS[which[i]] (left 91 cols), right 91 cols start zeroed --
  // mirrors osd.cc:126-135 exactly. Parallelized: each thread handles a
  // strided subset of the 174 rows.
  var i = tid;
  loop {
    if (i >= OSD_N) { break; }
    let ii = which_arr[i];
    for (var j = 0u; j < OSD_K; j = j + 1u) {
      b_scratch[b_idx(bbase, i, j)] = i32(gen_sys_at(ii, j));
    }
    for (var j = OSD_K; j < OSD_B_COLS; j = j + 1u) {
      b_scratch[b_idx(bbase, i, j)] = 0;
    }
    i = i + WG_SIZE;
  }
  // storageBarrier() required alongside workgroupBarrier() -- b_scratch is
  // written here by every invocation's strided subset of rows, then read
  // by gauss_jordan() (including by tid==0u alone, for rows it did not
  // itself write) immediately after; see gauss_jordan()'s own header
  // comment for why workgroupBarrier() alone does not order storage-buffer
  // accesses across invocations.
  workgroupBarrier();
  storageBarrier();

  // Return value intentionally unused past this point: osd.cc:143-145 only
  // logs on failure and continues (gen1_inv ends up partially-eliminated
  // garbage in that case, but osd_check()'s CRC gate downstream makes this
  // safe -- it can never falsely report a successful decode), matching
  // osdDecode.ts's own preserved-verbatim comment on the same point.
  let _gj_ok = gauss_jordan(bbase, tid);

  // gen1_inv = b[0:91][91:182] -- parallelized copy into workgroup memory.
  var gi = tid;
  loop {
    if (gi >= OSD_K * OSD_K) { break; }
    let row = gi / OSD_K;
    let col = gi % OSD_K;
    gen1_inv[gi] = b_scratch[b_idx(bbase, row, OSD_K + col)];
    gi = gi + WG_SIZE;
  }
  // gen1_inv is workgroup memory (destination), but b_scratch (source) is
  // storage memory last written inside gauss_jordan()'s final elimination
  // step by potentially OTHER invocations -- storageBarrier() needed here
  // too, same reasoning as above.
  workgroupBarrier();
  storageBarrier();

  // y1[i] = (codeword[which[i]] < 0 ? 1 : 0) -- mirrors osd.cc:161-165
  // exactly (uses the POST-gauss_jordan which_arr, since gauss_jordan may
  // have permuted it further via row swaps beyond the initial sort).
  var yi = tid;
  loop {
    if (yi >= OSD_K) { break; }
    let j = which_arr[yi];
    y1[yi] = select(0u, 1u, ll_cache[j] < 0.0);
    yi = yi + WG_SIZE;
  }
  workgroupBarrier();

  matmul_xplain_from_y1(tid);

  var gotABest = false;
  var bestScore: f32 = 0.0;
  var bestDepth: i32 = -1;
  var resultOk = false;

  if (tid == 0u) {
    let xscore0 = osd_score(llr_base);
    let ch0 = osd_check();
    if (xscore0 < OSD_THRESH && ch0) {
      resultOk = true;
      bestDepth = 0;
      for (var k = 0u; k < OSD_K; k = k + 1u) {
        best_plain[k] = xplain[k];
      }
    }
  }
  // Broadcast the zero-flip outcome to every invocation via workgroup
  // memory -- reuse pivot_ok[0]/pivot_row1[0] as scratch signal slots
  // (both already workgroup-scope, free after gauss_jordan() returns).
  if (tid == 0u) {
    pivot_ok[0] = select(0u, 1u, resultOk);
  }
  workgroupBarrier();
  let zeroFlipOk = pivot_ok[0] == 1u;

  // The depth loop below runs UNCONDITIONALLY for every invocation (never
  // gated behind `if (!zeroFlipOk)`), even though zeroFlipOk is a plain
  // barrier-synced workgroup-uniform value -- an earlier revision gated the
  // whole loop behind that read and failed CreateShaderModule on ACTUAL GPU
  // hardware ("workgroupBarrier must only be called from uniform control
  // flow" / "reading from workgroup storage variable may result in a
  // non-uniform value"), caught only by real compilation (same class of
  // issue as gauss_jordan()'s own fix above, see that function's header
  // comment). Instead, `skipWork` (a plain per-invocation bool, not gating
  // any barrier) disables the depth loop's SCORE-KEEPING effect once the
  // zero-flip hypothesis already succeeded, so osd.cc's "just accept this,
  // since no bits had to be flipped, don't even try flipping" early-return
  // semantics are preserved in behavior (the depth loop's redundant
  // matmul/score/check work still runs on real hardware in this case, but
  // its result is discarded -- a pure performance detail, not a
  // correctness one, exactly the same trade this codebase already makes
  // elsewhere for unconditional-execution-with-discarded-results, e.g.
  // ldpcDecode.wgsl's per-invocation early "converged" branch never
  // affecting OTHER invocations).
  let skipWork = zeroFlipOk;

  for (var ii = 0u; ii < params.depth; ii = ii + 1u) {
    let flipI = OSD_K - 1u - ii;
    if (tid == 0u) {
      y1[flipI] = y1[flipI] ^ 1u;
    }
    workgroupBarrier();
    matmul_xplain_from_y1(tid);
    if (tid == 0u) {
      y1[flipI] = y1[flipI] ^ 1u;
    }
    if (tid == 0u && !skipWork) {
      let xscore = osd_score(llr_base);
      let ch = osd_check();
      if (xscore < OSD_THRESH && ch) {
        if (!gotABest || xscore < bestScore) {
          gotABest = true;
          bestScore = xscore;
          bestDepth = i32(ii);
          for (var k = 0u; k < OSD_K; k = k + 1u) {
            best_plain[k] = xplain[k];
          }
        }
      }
    }
    workgroupBarrier();
  }

  // Unconditional (not gated behind `if (!zeroFlipOk)`) for the same
  // uniform-control-flow reason as the depth loop above -- when zeroFlipOk
  // is true, gotABest/bestDepth/best_plain were already finalized by the
  // tid==0u block right after the zero-flip check further up, and the
  // depth loop's own effect was discarded via skipWork, so recomputing
  // `resultOk = gotABest` and rebroadcasting here is redundant but
  // harmless (gotABest/bestDepth already hold the correct zero-flip
  // values in that case, since skipWork prevented the depth loop from
  // touching them).
  if (tid == 0u) {
    resultOk = zeroFlipOk || gotABest;
  }
  if (tid == 0u) {
    pivot_ok[0] = select(0u, 1u, resultOk);
    pivot_row1[0] = bitcast<u32>(bestDepth);
  }
  workgroupBarrier();
  resultOk = pivot_ok[0] == 1u;
  bestDepth = bitcast<i32>(pivot_row1[0]);

  var wi = tid;
  loop {
    if (wi >= OSD_K) { break; }
    plain_out[out91_base + wi] = best_plain[wi];
    wi = wi + WG_SIZE;
  }
  if (tid == 0u) {
    ok_out[candidate] = select(0u, 1u, resultOk);
    depth_out[candidate] = bestDepth;
  }
}
