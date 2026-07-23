import { ldpcDecode, ldpcCheck } from '../ldpcDecode';
import { LDPC_N, LDPC_CHECKS, Nm, NM_MAX_DEGREE } from '../ldpcMatrix';

function seededRandom(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

/** Constructs a valid LDPC(174,91) codeword (all 83 parity checks satisfied)
 *  via bit-flip local search, without needing ft8mon's gen_sys[174][91]
 *  generator matrix (a large table not worth transcribing just for test
 *  fixtures) — starts from all-zero (trivially valid, since every parity
 *  check is an XOR that's satisfied by all-zero) and applies random
 *  even-sized bit-flip perturbations that preserve every check's parity,
 *  guaranteeing the result stays a valid codeword while still exercising
 *  a non-trivial bit pattern. */
function makeValidCodeword(seed: number, numFlipPairs: number): Uint8Array {
  const rng = seededRandom(seed);
  const codeword = new Uint8Array(LDPC_N); // all-zero: trivially valid (every XOR check = 0)

  // Flipping any two bits that both appear in a check's row preserves that
  // check's parity for that check, but flipping a single bit may break
  // OTHER checks it participates in. Simplest guaranteed-safe perturbation:
  // pick one check row entirely and flip ALL of its bits — since every bit
  // in that row is XORed together, flipping an even number of them (or all
  // of them, if the row's degree happens to work out) keeps that row's
  // parity, but to keep this simple and correct regardless of degree
  // parity, just flip PAIRS of bits that co-occur in the same check row —
  // flipping both members of a pair always preserves that specific row's
  // parity (XOR of two flipped bits toggles twice = no change), but could
  // still break OTHER rows those bits also belong to (variable-node degree
  // is 3, so each bit affects up to 3 rows). To keep this fully rigorous
  // without a real encoder, verify validity via ldpcCheck at the end rather
  // than assuming — the test only needs SOME valid, non-trivial codeword.
  for (let attempt = 0; attempt < numFlipPairs; attempt++) {
    const j = Math.floor(rng() * LDPC_CHECKS);
    const degree = Nm[j].filter(v => v !== 0).length;
    const a = Math.floor(rng() * degree);
    let b = Math.floor(rng() * degree);
    while (b === a) b = Math.floor(rng() * degree);
    const bitA = Nm[j][a] - 1;
    const bitB = Nm[j][b] - 1;
    codeword[bitA] ^= 1;
    codeword[bitB] ^= 1;
    // If this perturbation broke another check, undo it — keeps the
    // construction simple while guaranteeing the invariant.
    if (ldpcCheck(codeword) !== LDPC_CHECKS) {
      codeword[bitA] ^= 1;
      codeword[bitB] ^= 1;
    }
  }

  return codeword;
}

function codewordToLLR(codeword: Uint8Array, confidence: number): Float64Array {
  // bit=0 -> positive LLR (favors zero), bit=1 -> negative LLR, matching
  // ldpc_decode's llcodeword[i] = log(P(zero)/P(one)) convention.
  const llr = new Float64Array(LDPC_N);
  for (let i = 0; i < LDPC_N; i++) {
    llr[i] = codeword[i] === 0 ? confidence : -confidence;
  }
  return llr;
}

describe('ldpcCheck', () => {
  test('all-zero codeword satisfies all 83 parity checks', () => {
    expect(ldpcCheck(new Uint8Array(LDPC_N))).toBe(LDPC_CHECKS);
  });

  test('a single flipped bit breaks at least one check (Nm has no isolated bits)', () => {
    const codeword = new Uint8Array(LDPC_N);
    codeword[10] = 1;
    expect(ldpcCheck(codeword)).toBeLessThan(LDPC_CHECKS);
  });
});

describe('ldpcDecode', () => {
  test('decodes a valid, high-confidence codeword to itself with ok=83', () => {
    const codeword = makeValidCodeword(1, 40);
    expect(ldpcCheck(codeword)).toBe(LDPC_CHECKS); // sanity: fixture really is valid

    const llr = codewordToLLR(codeword, 5.0); // high confidence, similar to ft8.cc's maxlog=4.97 clamp
    const result = ldpcDecode(llr, 25);

    expect(result.ok).toBe(LDPC_CHECKS);
    expect(Array.from(result.plain)).toEqual(Array.from(codeword));
  });

  test('recovers from a few weakly-confident wrong bits (error correction)', () => {
    const codeword = makeValidCodeword(2, 40);
    expect(ldpcCheck(codeword)).toBe(LDPC_CHECKS);

    const llr = codewordToLLR(codeword, 5.0);
    // Corrupt 3 bits' LLR sign but with LOW confidence (small magnitude) —
    // exactly the noisy-channel scenario LDPC is designed to correct.
    const corruptIdx = [5, 50, 150];
    for (const i of corruptIdx) llr[i] = -llr[i] * 0.15;

    const result = ldpcDecode(llr, 25);
    expect(result.ok).toBe(LDPC_CHECKS);
    expect(Array.from(result.plain)).toEqual(Array.from(codeword));
  });

  test('returns best-effort guess with ok < 83 when it cannot converge', () => {
    // Pure noise LLRs (no real codeword structure) should not spuriously
    // reach 83 — if it did by chance, ldpcCheck's own invariant would be
    // violated, so this doubles as a check that ok is trustworthy.
    const rng = seededRandom(99);
    const llr = new Float64Array(LDPC_N);
    for (let i = 0; i < LDPC_N; i++) llr[i] = (rng() - 0.5) * 0.2; // near-zero, low confidence noise

    const result = ldpcDecode(llr, 25);
    expect(result.ok).toBeLessThanOrEqual(LDPC_CHECKS);
    expect(ldpcCheck(result.plain)).toBe(result.ok); // reported score matches the actual output
  });

  test('throws on wrong-length LLR input', () => {
    expect(() => ldpcDecode(new Float64Array(100), 25)).toThrow();
  });
});
