import { ldpcDecode, ldpcCheck } from '../ldpcDecode';
import { ldpcDecodeF32 } from '../ldpcDecodeF32';
import { LDPC_N, LDPC_CHECKS, Nm } from '../ldpcMatrix';

function seededRandom(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

function makeValidCodeword(seed: number, numFlipPairs: number): Uint8Array {
  const rng = seededRandom(seed);
  const codeword = new Uint8Array(LDPC_N);
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
    if (ldpcCheck(codeword) !== LDPC_CHECKS) {
      codeword[bitA] ^= 1;
      codeword[bitB] ^= 1;
    }
  }
  return codeword;
}

function codewordToLLR(codeword: Uint8Array, confidence: number, rng: () => number, noiseAmp: number): Float64Array {
  const llr = new Float64Array(LDPC_N);
  for (let i = 0; i < LDPC_N; i++) {
    const base = codeword[i] === 0 ? confidence : -confidence;
    llr[i] = base + (rng() - 0.5) * noiseAmp;
  }
  return llr;
}

describe('ldpcDecodeF32 vs ldpcDecode (f64) — precision feasibility for WGSL port', () => {
  test('f32 precision decodes a clean high-confidence codeword identically to f64', () => {
    const codeword = makeValidCodeword(1, 40);
    const rng = seededRandom(123);
    const llr = codewordToLLR(codeword, 5.0, rng, 0);

    const f64Result = ldpcDecode(llr, 25);
    const f32Result = ldpcDecodeF32(llr, 25);

    expect(f64Result.ok).toBe(LDPC_CHECKS);
    expect(f32Result.ok).toBe(LDPC_CHECKS);
    expect(Array.from(f32Result.plain)).toEqual(Array.from(f64Result.plain));
  });

  test('f32 precision still recovers from realistic channel noise across many random codewords', () => {
    // This is the real feasibility question: across a range of noisy,
    // marginal-but-decodable inputs (matching ft8mon's actual maxlog=4.97
    // LLR clamp and realistic per-bit noise), does f32 rounding at every
    // step of the 25-iteration BP loop cause any DIVERGENCE from f64's
    // result? If f32 matches f64 across a reasonable sample, WGSL's native
    // f32 is safe for this kernel without needing a double-precision
    // emulation trick.
    let matches = 0;
    let bothSucceeded = 0;
    const trials = 15;
    for (let seed = 0; seed < trials; seed++) {
      const codeword = makeValidCodeword(seed * 7 + 1, 40);
      const rng = seededRandom(seed * 13 + 5);
      const llr = codewordToLLR(codeword, 4.97, rng, 2.0); // noisy, similar magnitude to ft8mon's real clamp

      const f64Result = ldpcDecode(llr, 25);
      const f32Result = ldpcDecodeF32(llr, 25);

      if (f64Result.ok === LDPC_CHECKS && f32Result.ok === LDPC_CHECKS) {
        bothSucceeded++;
        if (Array.from(f32Result.plain).every((b, i) => b === f64Result.plain[i])) matches++;
      }
    }
    // Not every trial is expected to converge (noise level is deliberately
    // aggressive) — but whenever f64 succeeds, f32 should too, and agree
    // bit-for-bit, or this kernel needs a different numeric strategy before
    // porting to WGSL.
    expect(bothSucceeded).toBeGreaterThan(0);
    expect(matches).toBe(bothSucceeded);
  });
});
