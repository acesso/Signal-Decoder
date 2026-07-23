// f32-precision variant of ldpcDecode.ts, used ONLY to test whether WGSL's
// native f32 (vs. ldpc_decode's C `double`) causes real convergence
// failures before committing to the WGSL port — see
// __tests__/ldpcDecodeF32.test.ts. Math.fround() after every arithmetic op
// simulates f32 rounding in plain JS/TS without needing a real GPU. Not
// used by the actual WGSL orchestration path (webgpuCoarseSearch.ts) —
// purely a precision-feasibility probe.
import { Nm, Mn, LDPC_N, LDPC_CHECKS, NM_MAX_DEGREE, MN_DEGREE } from './ldpcMatrix';
import type { LdpcResult } from './ldpcDecode';
import { ldpcCheck } from './ldpcDecode';

const f = Math.fround;

export function ldpcDecodeF32(llCodeword: Float64Array, iters: number): LdpcResult {
  if (llCodeword.length !== LDPC_N) {
    throw new Error(`ldpcDecodeF32: expected ${LDPC_N} LLR values, got ${llCodeword.length}`);
  }

  const m = new Float32Array(LDPC_CHECKS * LDPC_N);
  const e = new Float32Array(LDPC_CHECKS * LDPC_N);
  const codeword = new Float32Array(LDPC_N);
  let bestScore = -1;
  let bestCw = new Uint8Array(LDPC_N);

  for (let i = 0; i < LDPC_N; i++) {
    const ex = f(Math.exp(f(llCodeword[i])));
    codeword[i] = f(ex / f(1.0 + ex));
  }

  for (let i = 0; i < LDPC_N; i++) {
    for (let j = 0; j < LDPC_CHECKS; j++) {
      m[j * LDPC_N + i] = codeword[i];
    }
  }

  const cw = new Uint8Array(LDPC_N);

  for (let iter = 0; iter < iters; iter++) {
    for (let j = 0; j < LDPC_CHECKS; j++) {
      for (let ii1 = 0; ii1 < NM_MAX_DEGREE; ii1++) {
        const i1 = Nm[j][ii1] - 1;
        if (i1 < 0) continue;
        let a = f(1.0);
        for (let ii2 = 0; ii2 < NM_MAX_DEGREE; ii2++) {
          const i2 = Nm[j][ii2] - 1;
          if (i2 >= 0 && i2 !== i1) {
            const tmp = f(1.0 - f(2.0 * f(1.0 - m[j * LDPC_N + i2])));
            a = f(a * tmp);
          }
        }
        e[j * LDPC_N + i1] = f(0.5 + f(0.5 * a));
      }
    }

    for (let i = 0; i < LDPC_N; i++) {
      let q0 = codeword[i];
      let q1 = f(1.0 - q0);
      for (let j = 0; j < MN_DEGREE; j++) {
        const j2 = Mn[i][j] - 1;
        q0 = f(q0 * e[j2 * LDPC_N + i]);
        q1 = f(q1 * f(1.0 - e[j2 * LDPC_N + i]));
      }
      const p = q0 === 0.0 ? 1.0 : f(1.0 / f(1.0 + f(q1 / q0)));
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

    for (let i = 0; i < LDPC_N; i++) {
      for (let ji1 = 0; ji1 < MN_DEGREE; ji1++) {
        const j1 = Mn[i][ji1] - 1;
        let q0 = codeword[i];
        let q1 = f(1.0 - q0);
        for (let ji2 = 0; ji2 < MN_DEGREE; ji2++) {
          const j2 = Mn[i][ji2] - 1;
          if (j1 !== j2) {
            q0 = f(q0 * e[j2 * LDPC_N + i]);
            q1 = f(q1 * f(1.0 - e[j2 * LDPC_N + i]));
          }
        }
        const p = q0 === 0.0 ? 1.0 : f(1.0 / f(1.0 + f(q1 / q0)));
        m[j1 * LDPC_N + i] = p;
      }
    }
  }

  return { plain: bestCw, ok: bestScore };
}
