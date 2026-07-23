// Ordered-statistics decoder (OSD) for LDPC(174,91) — plain-TS port of
// lib/ft8mon/osd.cc's osd_decode()/gauss_jordan()/matmul()/osd_score()/
// osd_check()/ldpc_encode(), matching the C source's algorithm and variable
// meanings exactly (same loop order, same score/threshold constants, same
// depth-loop semantics — see osd.cc for the ground truth this mirrors).
// This is BOTH the correctness oracle the OSD WGSL kernel (osdDecode.wgsl)
// is cross-checked against, AND a self-contained, directly usable CPU-only
// OSD path (osdDecode() below) — not just a private test helper.
//
// gauss_jordan() here is ft8mon's own libldpc.c:339-384 (see that file),
// operating on the SAME m[174][182] layout (rows=91, cols=174, m has
// 2*91=182 columns: left 91 = reordered generator matrix, right 91 =
// accumulates the inverse via "lazy creation of identity matrix in the
// upper-right quarter" — osd.cc:369's own comment, preserved here).
import { GEN_SYS } from './genSys';
import { checkCrc } from './crc';

if (GEN_SYS.length !== 174 || GEN_SYS[0].length !== 91) {
  throw new Error(`GEN_SYS must be 174x91, got ${GEN_SYS.length}x${GEN_SYS[0]?.length}`);
}

export const OSD_N = 174;
export const OSD_K = 91;
const OSD_SCORE_LLR_SCALE = 4.6; // osd_score()'s magic constant, osd.cc:51/54
const OSD_THRESH = -500; // osd.cc:176 osd_thresh

/** ldpc_encode(): 91-bit plain -> 174-bit codeword via GEN_SYS, systematic
 *  bits verbatim + XOR-parity for the remaining 83 — mirrors osd.cc:19-35
 *  exactly, including its (slightly odd, but preserved verbatim) inner-loop
 *  structure where `codeword[i+91]` is reassigned on every `j` iteration,
 *  not just written once after the sum is complete. */
export function ldpcEncode(plain: Uint8Array | number[]): Uint8Array {
  const codeword = new Uint8Array(OSD_N);
  for (let i = 0; i < OSD_K; i++) {
    codeword[i] = plain[i];
  }
  for (let i = 0; i + OSD_K < OSD_N; i++) {
    let sum = 0;
    for (let j = 0; j < OSD_K; j++) {
      sum += GEN_SYS[i + OSD_K][j] * plain[j];
      codeword[i + OSD_K] = sum % 2;
    }
  }
  return codeword;
}

/** osd_score(): ldpc-encode xplain, compare against the received LLRs
 *  ll174 — mirrors osd.cc:41-59 exactly (note the final negation: the
 *  function accumulates `score` then returns `-score`). Lower is better
 *  (osd_decode() looks for scores below OSD_THRESH). */
export function osdScore(xplain: Uint8Array, ll174: Float64Array | number[]): number {
  const xcode = ldpcEncode(xplain);
  let score = 0;
  for (let i = 0; i < OSD_N; i++) {
    if (xcode[i]) {
      score -= ll174[i] * OSD_SCORE_LLR_SCALE;
    } else {
      score += ll174[i] * OSD_SCORE_LLR_SCALE;
    }
  }
  return -score;
}

/** osd_check(): reject the all-zero decode, then require a valid CRC-14 —
 *  mirrors osd.cc:62-80 exactly. Reuses the already-proven checkCrc() from
 *  crc.ts instead of re-porting check_crc(). */
export function osdCheck(plain: Uint8Array): boolean {
  let allZero = true;
  for (let i = 0; i < OSD_K; i++) {
    if (plain[i] !== 0) {
      allZero = false;
      break;
    }
  }
  if (allZero) return false;
  return checkCrc(plain);
}

/** matmul(): c = (a * b) mod 2, a is 91x91, b/c are 91-vectors — mirrors
 *  osd.cc:82-92 exactly. */
export function matmul(a: number[][] | Uint8Array[], b: Uint8Array | number[]): Uint8Array {
  const c = new Uint8Array(OSD_K);
  for (let i = 0; i < OSD_K; i++) {
    let sum = 0;
    const row = a[i];
    for (let j = 0; j < OSD_K; j++) {
      sum += row[j] * b[j];
    }
    c[i] = sum % 2;
  }
  return c;
}

/** gauss_jordan(): binary Gauss-Jordan elimination over GF(2) — mirrors
 *  libldpc.c:339-384 exactly. `m` is rows=91 x cols=174, each row having
 *  2*91=182 columns (left 91 = generator-matrix-in-progress, right 91 =
 *  the accumulating inverse). `which` (length 91, but osd_decode() passes
 *  the full reordered 174-length `which`/`xwhich` and only the first 91
 *  entries get swapped here — matching the C call site's own `int
 *  xwhich[174]` passed as `int which[91]`, a pointer-decay quirk of the C
 *  signature that this TS port preserves by accepting a length-174 array
 *  and mutating only indices < 91, i.e. rows). Mutates `m` and `which`
 *  in place; returns true if invertible (ok=1), false otherwise. */
export function gaussJordan(m: number[][], which: number[]): boolean {
  const rows = OSD_K; // 91
  const cols = OSD_N; // 174
  const width = 2 * rows; // 182

  for (let row = 0; row < rows; row++) {
    if (m[row][row] !== 1) {
      for (let row1 = row + 1; row1 < cols; row1++) {
        if (m[row1][row] === 1) {
          const tmpRow = m[row];
          m[row] = m[row1];
          m[row1] = tmpRow;
          const tmpWhich = which[row];
          which[row] = which[row1];
          which[row1] = tmpWhich;
          break;
        }
      }
    }
    if (m[row][row] !== 1) {
      return false;
    }
    m[row][rows + row] = (m[row][rows + row] + 1) % 2;
    for (let row1 = 0; row1 < cols; row1++) {
      if (row1 === row) continue;
      if (m[row1][row] !== 0) {
        for (let col = 0; col < width; col++) {
          m[row1][col] = (m[row1][col] + m[row][col]) % 2;
        }
      }
    }
  }
  return true;
}

export interface OsdResult {
  ok: boolean;
  plain: Uint8Array; // 91 decoded plain bits (only meaningful if ok===true)
  depthUsed: number; // matches osd_decode()'s *out_depth: 0 = zero-flip hypothesis worked, >0 = which flip index succeeded
}

/** osd_decode(): the main OSD entry point — mirrors osd.cc:101-222 exactly.
 *  `codeword` is 174 LLR values (log(P(0)/P(1)), positive favors bit=0,
 *  same convention as ldpcDecode.ts's input). `depth` bounds the bit-flip
 *  search (this app's live default is 2 — see decoder.worker.ts's
 *  osdDepth). Returns ok=false if no valid (CRC-passing, non-all-zero)
 *  decode was found within the zero-flip try + `depth` single-bit-flip
 *  tries. */
export function osdDecode(codeword: Float64Array | number[], depth: number): OsdResult {
  if (codeword.length !== OSD_N) {
    throw new Error(`osdDecode: expected ${OSD_N} LLR values, got ${codeword.length}`);
  }

  const strength = new Float64Array(OSD_N);
  for (let i = 0; i < OSD_N; i++) {
    const x = codeword[i];
    strength[i] = x < 0 ? -x : x;
  }

  const which: number[] = new Array(OSD_N);
  for (let i = 0; i < OSD_N; i++) which[i] = i;
  which.sort((a, b) => strength[b] - strength[a]);

  // b[174][182]: generator matrix rows reordered strongest-codeword-bit
  // first, right half starts zeroed (osd.cc:125-135).
  const b: number[][] = new Array(OSD_N);
  for (let i = 0; i < OSD_N; i++) {
    const ii = which[i];
    const row = new Array(2 * OSD_K).fill(0);
    for (let j = 0; j < OSD_K; j++) {
      row[j] = GEN_SYS[ii][j];
    }
    b[i] = row;
  }

  const xwhich = which.slice();
  const ok = gaussJordan(b, xwhich);
  if (!ok) {
    // osd.cc:144 just logs and continues; gen1_inv will be garbage but the
    // subsequent osd_check() CRC gate makes this safe (never falsely
    // reports success) — preserved verbatim rather than early-returning,
    // to match ft8mon's own observable behavior exactly.
  }

  const gen1Inv: number[][] = new Array(OSD_K);
  for (let i = 0; i < OSD_K; i++) {
    gen1Inv[i] = new Array(OSD_K);
    for (let j = 0; j < OSD_K; j++) {
      gen1Inv[i][j] = b[i][OSD_K + j];
    }
  }

  for (let i = 0; i < OSD_N; i++) which[i] = xwhich[i];

  const y1 = new Uint8Array(OSD_K);
  for (let i = 0; i < OSD_K; i++) {
    const j = which[i];
    y1[i] = codeword[j] < 0 ? 1 : 0;
  }

  let bestPlain: Uint8Array | null = null;
  let bestScore = 0;
  let gotABest = false;
  let bestDepth = -1;

  const xplain0 = matmul(gen1Inv, y1);
  const xscore0 = osdScore(xplain0, codeword);
  const ch0 = osdCheck(xplain0);
  if (xscore0 < OSD_THRESH && ch0) {
    // osd.cc:182's `if(1)` branch: accept immediately, depth=0, no
    // further search — matches ft8mon's actual (dead-code-elided) behavior.
    return { ok: true, plain: xplain0, depthUsed: 0 };
  }

  for (let ii = 0; ii < depth; ii++) {
    const i = OSD_K - 1 - ii;
    y1[i] ^= 1;
    const xplain = matmul(gen1Inv, y1);
    y1[i] ^= 1;
    const xscore = osdScore(xplain, codeword);
    const ch = osdCheck(xplain);
    if (xscore < OSD_THRESH && ch) {
      if (!gotABest || xscore < bestScore) {
        gotABest = true;
        bestPlain = xplain;
        bestScore = xscore;
        bestDepth = ii;
      }
    }
  }

  if (gotABest && bestPlain) {
    return { ok: true, plain: bestPlain, depthUsed: bestDepth };
  }
  return { ok: false, plain: new Uint8Array(OSD_K), depthUsed: -1 };
}
