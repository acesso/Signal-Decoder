// Plain-TS reference for ft8mon's LDPC(174,91) sum-product belief-propagation
// decoder — mirrors ldpc_decode() in lib/ft8mon/libldpc.c:55-174 EXACTLY
// (same probability-domain formulation, same loop order, same early-exit at
// syndrome=83), used both as a Jest-testable correctness oracle and as the
// reference the WGSL ldpcDecode.wgsl kernel is cross-checked against.
//
// NOT ldpc_decode_log (libldpc.c:214+) — that variant is dead code in
// ft8mon (never called), and the active ldpc_decode already has zero
// transcendental calls inside its iteration loop (pure probability-domain
// multiply/add), making it the better port target as-is. See the
// investigation this module's WGSL sibling cites for the full comparison.
import { Nm, Mn, LDPC_N, LDPC_CHECKS, NM_MAX_DEGREE, MN_DEGREE } from './ldpcMatrix';

export interface LdpcResult {
  plain: Uint8Array; // 174 bits (0/1) — full corrected codeword, not just the 91 payload bits
  ok: number; // 0-83; 83 = full syndrome success
}

/** Number of parity checks satisfied by a candidate 174-bit codeword —
 *  mirrors ldpc_check() in libldpc.c:30-48 exactly. */
export function ldpcCheck(codeword: Uint8Array): number {
  let score = 0;
  for (let j = 0; j < LDPC_CHECKS; j++) {
    let x = 0;
    for (let k = 0; k < NM_MAX_DEGREE; k++) {
      const i1 = Nm[j][k] - 1;
      if (i1 >= 0) x ^= codeword[i1];
    }
    if (x === 0) score++;
  }
  return score;
}

/** llCodeword[i] = log(P(bit_i=0) / P(bit_i=1)) — positive favors 0.
 *  Mirrors ldpc_decode()'s probability-domain sum-product exactly. */
export function ldpcDecode(llCodeword: Float64Array, iters: number): LdpcResult {
  if (llCodeword.length !== LDPC_N) {
    throw new Error(`ldpcDecode: expected ${LDPC_N} LLR values, got ${llCodeword.length}`);
  }

  const m = new Float64Array(LDPC_CHECKS * LDPC_N);
  const e = new Float64Array(LDPC_CHECKS * LDPC_N);
  const codeword = new Float64Array(LDPC_N);
  let bestScore = -1;
  let bestCw = new Uint8Array(LDPC_N);

  // llcodeword -> P(zero): p = e^x / (1 + e^x)
  for (let i = 0; i < LDPC_N; i++) {
    const ex = Math.exp(llCodeword[i]);
    codeword[i] = ex / (1.0 + ex);
  }

  for (let i = 0; i < LDPC_N; i++) {
    for (let j = 0; j < LDPC_CHECKS; j++) {
      m[j * LDPC_N + i] = codeword[i];
    }
  }
  // e[][] already zero-initialized by Float64Array default.

  const cw = new Uint8Array(LDPC_N);

  for (let iter = 0; iter < iters; iter++) {
    // Check -> variable update
    for (let j = 0; j < LDPC_CHECKS; j++) {
      for (let ii1 = 0; ii1 < NM_MAX_DEGREE; ii1++) {
        const i1 = Nm[j][ii1] - 1;
        if (i1 < 0) continue;
        let a = 1.0;
        for (let ii2 = 0; ii2 < NM_MAX_DEGREE; ii2++) {
          const i2 = Nm[j][ii2] - 1;
          if (i2 >= 0 && i2 !== i1) {
            const tmp = 1.0 - 2.0 * (1.0 - m[j * LDPC_N + i2]);
            a *= tmp;
          }
        }
        e[j * LDPC_N + i1] = 0.5 + 0.5 * a;
      }
    }

    // Tentative codeword + syndrome check
    for (let i = 0; i < LDPC_N; i++) {
      let q0 = codeword[i];
      let q1 = 1.0 - q0;
      for (let j = 0; j < MN_DEGREE; j++) {
        const j2 = Mn[i][j] - 1;
        q0 *= e[j2 * LDPC_N + i];
        q1 *= 1.0 - e[j2 * LDPC_N + i];
      }
      const p = q0 === 0.0 ? 1.0 : 1.0 / (1.0 + q1 / q0);
      cw[i] = p <= 0.5 ? 1 : 0;
    }

    const score = ldpcCheck(cw);
    if (score === LDPC_CHECKS) {
      return { plain: cw.slice(), ok: LDPC_CHECKS };
    }
    if (score > bestScore) {
      bestCw = cw.slice();
      bestScore = score;
    }

    // Variable -> check update
    for (let i = 0; i < LDPC_N; i++) {
      for (let ji1 = 0; ji1 < MN_DEGREE; ji1++) {
        const j1 = Mn[i][ji1] - 1;
        let q0 = codeword[i];
        let q1 = 1.0 - q0;
        for (let ji2 = 0; ji2 < MN_DEGREE; ji2++) {
          const j2 = Mn[i][ji2] - 1;
          if (j1 !== j2) {
            q0 *= e[j2 * LDPC_N + i];
            q1 *= 1.0 - e[j2 * LDPC_N + i];
          }
        }
        const p = q0 === 0.0 ? 1.0 : 1.0 / (1.0 + q1 / q0);
        m[j1 * LDPC_N + i] = p;
      }
    }
  }

  return { plain: bestCw, ok: bestScore };
}
