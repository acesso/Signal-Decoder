// Soft-decision LLR extraction: c79 (79x8 complex tone bins from
// symbolExtract.ts) -> ll174 (174-float LLR array), the exact input
// contract src/lib/ft/webgpu/ldpcDecode.wgsl's GPU kernel expects (positive
// favors bit=0, matching ldpc_decode's llcodeword[i]=log(P(0)/P(1))
// convention).
//
// This mirrors c_soft_decode() (ft8.cc:1785-1914) — confirmed the ACTIVE
// default (soft_ones=2, ft8.cc:98), not the simpler soft_decode()
// (soft_ones=1) an earlier investigation focused on. Depends on:
// c_convert_to_snr() (ft8.cc:1427-1495), Stats/make_stats (ft8.cc:232-384,
// 1503-1535 — problt_how_sig=problt_how_noise=0, i.e. ALWAYS the
// gaussian_problt branch, so only that branch is ported), bayes()
// (ft8.cc:1633-1692), un_gray_code_r (ft8.cc:1333-1347), blackman()
// (dsp.ts). All confirmed stateless — no WASM/hash-table/persistent-state
// dependency (see the scoping investigation this module was built from).
import { blackman, type Complex } from './dsp';

const SNR_WIN = 7;
const SNR_HOW = 3; // weakest tone (this repo's active default, ft8.cc:51)
const C_SOFT_WEIGHT = 7;
const C_SOFT_WIN = 2;
const USE_APRIORI = true;
const BAYES_HOW = 1;
const MAXLOG = 4.97;

const APRIORI174 = [
  0.47, 0.32, 0.29, 0.37, 0.52, 0.36, 0.40, 0.42, 0.42, 0.53, 0.44,
  0.44, 0.39, 0.46, 0.39, 0.38, 0.42, 0.43, 0.45, 0.51, 0.42, 0.48,
  0.31, 0.45, 0.47, 0.53, 0.59, 0.41, 0.03, 0.50, 0.30, 0.26, 0.40,
  0.65, 0.34, 0.49, 0.46, 0.49, 0.69, 0.40, 0.45, 0.45, 0.60, 0.46,
  0.43, 0.49, 0.56, 0.45, 0.55, 0.51, 0.46, 0.37, 0.55, 0.52, 0.56,
  0.55, 0.50, 0.01, 0.19, 0.70, 0.88, 0.75, 0.75, 0.74, 0.73, 0.18,
  0.71, 0.35, 0.60, 0.58, 0.36, 0.60, 0.38, 0.50, 0.02, 0.01, 0.98,
  0.48, 0.49, 0.54, 0.50, 0.49, 0.53, 0.50, 0.49, 0.49, 0.51, 0.51,
  0.51, 0.47, 0.50, 0.53, 0.51, 0.46, 0.51, 0.51, 0.48, 0.51, 0.52,
  0.50, 0.52, 0.51, 0.50, 0.49, 0.53, 0.52, 0.50, 0.46, 0.47, 0.48,
  0.52, 0.50, 0.49, 0.51, 0.49, 0.49, 0.50, 0.50, 0.50, 0.50, 0.51,
  0.50, 0.49, 0.49, 0.55, 0.49, 0.51, 0.48, 0.55, 0.49, 0.48, 0.50,
  0.51, 0.50, 0.51, 0.50, 0.51, 0.53, 0.49, 0.54, 0.50, 0.48, 0.49,
  0.46, 0.51, 0.51, 0.52, 0.49, 0.51, 0.49, 0.51, 0.50, 0.49, 0.50,
  0.50, 0.47, 0.49, 0.52, 0.49, 0.51, 0.49, 0.48, 0.52, 0.48, 0.49,
  0.47, 0.50, 0.48, 0.50, 0.49, 0.51, 0.51, 0.51, 0.49,
];

if (APRIORI174.length !== 174) throw new Error(`APRIORI174 must have 174 entries, got ${APRIORI174.length}`);

const COSTAS = [3, 1, 4, 0, 6, 5, 2] as const;

/** c_convert_to_snr() (ft8.cc:1427-1495): normalizes each symbol's tone
 *  magnitudes by a Blackman-windowed running "noise" estimate (snr_how=3:
 *  weakest of the 8 tones at each symbol time, this repo's active
 *  default). Operates on complex bins, dividing (not taking magnitude
 *  first) — matches ft8mon exactly. */
function convertToSnr(m79: Complex[][]): Complex[][] {
  const mm = new Array(79);
  for (let si = 0; si < 79; si++) {
    const v = new Array(8);
    for (let bi = 0; bi < 8; bi++) v[bi] = Math.hypot(m79[si][bi][0], m79[si][bi][1]);
    v.sort((a, b) => a - b);
    // SNR_HOW === 3: weakest tone.
    mm[si] = v[0];
  }

  const winwin = SNR_WIN > 0 ? blackman(2 * SNR_WIN + 1) : new Float64Array([1.0]);

  const n79: Complex[][] = new Array(79);
  for (let si = 0; si < 79; si++) {
    let sum = 0;
    for (let dd = si - SNR_WIN; dd <= si + SNR_WIN; dd++) {
      const wi = dd - (si - SNR_WIN);
      if (dd >= 0 && dd < 79) sum += mm[dd] * winwin[wi];
      else if (dd < 0) sum += mm[0] * winwin[wi];
      else sum += mm[78] * winwin[wi];
    }
    const row: Complex[] = new Array(8);
    for (let bi = 0; bi < 8; bi++) {
      row[bi] = [m79[si][bi][0] / sum, m79[si][bi][1] / sum];
    }
    n79[si] = row;
  }
  return n79;
}

/** Stats (ft8.cc:232-384) — ONLY the gaussian_problt (how_=0) branch is
 *  ported: problt_how_sig=problt_how_noise=0 always in this repo, so the
 *  binary-search/logistic-tail/laplace branches (how_=1..5) are dead code
 *  for this call site and deliberately not ported. */
class GaussianStats {
  private values: number[] = [];
  private sum = 0;
  private finalized = false;
  private meanVal = 0;
  private stddevVal = 0;

  add(x: number): void {
    this.values.push(x);
    this.sum += x;
    this.finalized = false;
  }

  private finalize(): void {
    this.finalized = true;
    const n = this.values.length;
    this.meanVal = this.sum / n;
    let variance = 0;
    for (const v of this.values) {
      const y = v - this.meanVal;
      variance += y * y;
    }
    variance /= n;
    this.stddevVal = Math.sqrt(variance);
  }

  mean(): number {
    if (!this.finalized) this.finalize();
    return this.meanVal;
  }

  /** gaussian_problt(): CDF of x under the fitted normal distribution. */
  problt(x: number): number {
    if (!this.finalized) this.finalize();
    const sds = (x - this.meanVal) / this.stddevVal;
    return 0.5 * (1.0 + erf(sds / Math.sqrt(2.0)));
  }
}

/** Abramowitz & Stegun 7.1.26 erf approximation (max error ~1.5e-7) —
 *  JS has no native Math.erf. */
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const t = 1.0 / (1.0 + p * x);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return sign * y;
}

/** make_stats() (ft8.cc:1503-1535): builds the "strongest tone" (bests) and
 *  "all tones" (all) distributions from a window's own m79 magnitudes. */
function makeStats(m79Mag: number[][]): { bests: GaussianStats; all: GaussianStats } {
  const bests = new GaussianStats();
  const all = new GaussianStats();

  for (let si = 0; si < 79; si++) {
    if (si < 7 || (si >= 36 && si < 36 + 7) || si >= 72) {
      const ci = si >= 72 ? si - 72 : si >= 36 ? si - 36 : si;
      for (let bi = 0; bi < 8; bi++) {
        const x = m79Mag[si][bi];
        all.add(x);
        if (bi === COSTAS[ci]) bests.add(x);
      }
    } else {
      let mx = 0;
      for (let bi = 0; bi < 8; bi++) {
        const x = m79Mag[si][bi];
        if (x > mx) mx = x;
        all.add(x);
      }
      bests.add(mx);
    }
  }
  return { bests, all };
}

/** bayes() (ft8.cc:1633-1692): Bayes-combining-rule log-likelihood that a
 *  bit is 0 vs 1, given the strongest tone consistent with each hypothesis. */
function bayes(bestZero: number, bestOne: number, lli: number, bests: GaussianStats, all: GaussianStats): number {
  let pzero = 0.5;
  let pone = 0.5;
  if (USE_APRIORI) {
    pzero = 1.0 - APRIORI174[lli];
    pone = APRIORI174[lli];
  }

  let a = pzero * bests.problt(bestZero) * (1.0 - all.problt(bestOne));
  if (BAYES_HOW === 1) a *= all.problt(all.mean() + (bestZero - bestOne));

  let b = pone * bests.problt(bestOne) * (1.0 - all.problt(bestZero));
  if (BAYES_HOW === 1) b *= all.problt(all.mean() + (bestOne - bestZero));

  let p: number;
  if (a + b === 0) p = 0.5;
  else p = a / (a + b);

  let ll: number;
  if (1 - p === 0.0) ll = MAXLOG;
  else ll = Math.log(p / (1 - p));

  if (ll > MAXLOG) ll = MAXLOG;
  if (ll < -MAXLOG) ll = -MAXLOG;
  return ll;
}

/** un_gray_code_r() (ft8.cc:1333-1347): un-gray-code the 8 tone values at
 *  each symbol time. `map[bi]` says where original bin `bi` goes. */
const UNGRAY_MAP = [0, 1, 3, 2, 6, 4, 5, 7];
function unGrayCodeR(m79: number[][]): number[][] {
  const out: number[][] = new Array(79);
  for (let si = 0; si < 79; si++) {
    const row = new Array(8);
    for (let bi = 0; bi < 8; bi++) row[UNGRAY_MAP[bi]] = m79[si][bi];
    out[si] = row;
  }
  return out;
}

/** c_soft_decode() (ft8.cc:1785-1914): c79 (complex, pre-un-gray-code) ->
 *  ll174. Each symbol's 8 "distance from neighbor consensus" scores are
 *  computed from the RAW (not yet SNR-normalized) c79 first (maxes[]), then
 *  the whole m79 is SNR-normalized and un-gray-coded before Bayes combining. */
export function cSoftDecode(c79x: Complex[][]): Float64Array {
  const c79 = convertToSnr(c79x);

  const maxes: Complex[] = new Array(79);
  for (let i = 0; i < 79; i++) {
    let m: Complex;
    if (i < 7) {
      m = c79[i][COSTAS[i]];
    } else if (i >= 36 && i < 36 + 7) {
      m = c79[i][COSTAS[i - 36]];
    } else if (i >= 72) {
      m = c79[i][COSTAS[i - 72]];
    } else {
      let got = false;
      let best: Complex = [0, 0];
      for (let j = 0; j < 8; j++) {
        if (!got || Math.hypot(c79[i][j][0], c79[i][j][1]) > Math.hypot(best[0], best[1])) {
          got = true;
          best = c79[i][j];
        }
      }
      m = best;
    }
    maxes[i] = m;
  }

  const m79: number[][] = new Array(79);
  for (let i = 0; i < 79; i++) {
    const row = new Array(8);
    for (let j = 0; j < 8; j++) {
      const c = c79[i][j];
      let n = 0;
      let sum = 0;
      for (let k = i - C_SOFT_WIN; k <= i + C_SOFT_WIN; k++) {
        if (k < 0 || k >= 79) continue;
        if (k === i) {
          sum -= C_SOFT_WEIGHT * Math.hypot(c[0], c[1]);
        } else {
          const c1 = maxes[k];
          const dRe = c1[0] - c[0];
          const dIm = c1[1] - c[1];
          sum += Math.hypot(dRe, dIm);
        }
        n += 1;
      }
      row[j] = 0 - sum / n;
    }
    m79[i] = row;
  }

  const { bests, all } = makeStats(m79);
  const m79u = unGrayCodeR(m79);

  const ll174 = new Float64Array(174);
  let lli = 0;
  for (let i79 = 0; i79 < 79; i79++) {
    if (i79 < 7 || (i79 >= 36 && i79 < 36 + 7) || i79 >= 72) continue;

    for (let biti = 0; biti < 3; biti++) {
      let zeroi: number[], onei: number[];
      if (biti === 0) { zeroi = [0, 1, 2, 3]; onei = [4, 5, 6, 7]; }
      else if (biti === 1) { zeroi = [0, 1, 4, 5]; onei = [2, 3, 6, 7]; }
      else { zeroi = [0, 2, 4, 6]; onei = [1, 3, 5, 7]; }

      let bestZero = -Infinity;
      for (const zi of zeroi) if (m79u[i79][zi] > bestZero) bestZero = m79u[i79][zi];
      let bestOne = -Infinity;
      for (const oi of onei) if (m79u[i79][oi] > bestOne) bestOne = m79u[i79][oi];

      ll174[lli] = bayes(bestZero, bestOne, lli, bests, all);
      lli++;
    }
  }

  return ll174;
}
