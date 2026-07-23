// Coarse Costas-sync correlation grid — WGSL port of one_coarse_strength()
// + coarse()'s outer (bi, si) loop from lib/ft8mon/ft8.cc:482-628, using
// this repo's default tuning (coarse_all=-1 "just costas symbols" path,
// coarse_strength_how=6 i.e. sig/noise — see ft8.cc:89,93).
//
// Each thread computes ONE grid cell's sync strength independently: a
// hypothesized tone-0 frequency bin `bi` and symbol-time offset `si`. This
// is the embarrassingly-parallel part of ft8mon's decode (confirmed via
// profiling: coarse search is ~14% of total decode wall-clock, the
// candidate-list bookkeeping/sort/dedup around it stays on the CPU/JS side
// — see webgpuCoarseSearch.ts).
//
// Input `bins` is the same flat spectrogram fft1920.wgsl produces (or the
// CPU-computed equivalent for the comparison variant): bins[symbol_time][freq_bin]
// as consecutive vec2<f32> (re, im), row-major (time-major) layout, i.e.
// bins[si * nbins + bi].

struct GridParams {
  si0: u32,       // first symbol-time index to search
  si_count: u32,  // number of symbol-time indices to search (si1 - si0)
  bi0: u32,       // first frequency bin to search (min_bin)
  bi_count: u32,  // number of frequency bins to search (max_bin - min_bin)
  nbins: u32,     // total bins per symbol-time row (spectrogram stride)
  n_symbols: u32, // total symbol-time rows available in `bins`
}

@group(0) @binding(0) var<uniform> grid: GridParams;
@group(0) @binding(1) var<storage, read> bins: array<vec2<f32>>;
@group(0) @binding(2) var<storage, read_write> strengths: array<f32>;

// Costas 7-3-7 sync array (same 3 blocks at si=0, si=36, si=72 relative to
// the hypothesized start) used by both FT8's actual protocol and ft8mon's
// search.
const COSTAS = array<u32, 7>(3u, 1u, 4u, 0u, 6u, 5u, 2u);

fn mag(c: vec2<f32>) -> f32 {
  return length(c);
}

// One coarse_strength() evaluation for hypothesized (bi0_cell, si0_cell).
// Mirrors ft8.cc:526-538 (coarse_all == -1 branch) exactly: for each of the
// 3 Costas sync blocks (si offsets 0, 36, 72) and each of the 7 symbols in
// each block, sum |bin| across all 8 tone candidates into sig (if it's the
// expected Costas tone) or noise (otherwise) — combined across all 3 blocks
// before the sig/noise reduction, not reduced per-block.
fn one_coarse_strength(si0_cell: u32, bi0_cell: u32) -> f32 {
  var sig: f32 = 0.0;
  var noise: f32 = 0.0;

  for (var si: u32 = 0u; si < 7u; si = si + 1u) {
    let costas_tone = COSTAS[si];
    for (var bi: u32 = 0u; bi < 8u; bi = bi + 1u) {
      var x: f32 = 0.0;
      x = x + mag(bins[(si0_cell + si) * grid.nbins + bi0_cell + bi]);
      x = x + mag(bins[(si0_cell + 36u + si) * grid.nbins + bi0_cell + bi]);
      x = x + mag(bins[(si0_cell + 72u + si) * grid.nbins + bi0_cell + bi]);
      if (bi == costas_tone) {
        sig = sig + x;
      } else {
        noise = noise + x;
      }
    }
  }

  // coarse_strength_how == 6 (this repo's default): sig / noise.
  return sig / noise;
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let idx = gid.x;
  let total = grid.si_count * grid.bi_count;
  if (idx >= total) {
    return;
  }

  // Row-major over (si, bi) so consecutive threads share bi0_cell reads
  // across nearby si — matches coarse()'s own bi-outer/si-inner loop nesting
  // (ft8.cc:596-605) for output ordering, though the GPU evaluates every
  // cell independently regardless of iteration order.
  let bi_local = idx % grid.bi_count;
  let si_local = idx / grid.bi_count;

  let si0_cell = grid.si0 + si_local;
  let bi0_cell = grid.bi0 + bi_local;

  // Bounds mirror ft8.cc:598 (si + 79 < bins.size()) and the bi0+8<=nbins
  // assert at ft8.cc:488 — out-of-range cells contribute no candidate
  // (written as a strength of exactly 0, filtered out host-side same as
  // ft8mon simply not iterating them).
  if (si0_cell + 79u >= grid.n_symbols || bi0_cell + 8u > grid.nbins) {
    strengths[idx] = 0.0;
    return;
  }

  strengths[idx] = one_coarse_strength(si0_cell, bi0_cell);
}
