import { ldpcEncode, osdDecode, matmul, gaussJordan, OSD_K, OSD_N } from '../osdDecode';
import { GEN_SYS } from '../genSys';
import { ft8Crc, checkCrc } from '../crc';

// Verification method: SYNTHETIC test vectors (no real ft8mon fixture with
// OSD actually invoked was available — src/lib/ft/webgpu/__tests__/fixtures/
// only has clean ldpc_ok=83 fixtures, see ldpcRealDecodes.json; capturing a
// genuine OSD-succeeds fixture requires a full Docker WASM rebuild +
// temporary ft8.cc instrumentation round-trip, deferred per the task's own
// documented fallback). A valid 91-bit message (77 payload + 14 real CRC-14
// bits, so checkCrc() genuinely accepts it) is LDPC-encoded via this
// module's OWN ldpcEncode() port, converted to hard-decision LLRs, then a
// few bits are corrupted before being handed to osdDecode() — this
// exercises ldpc_encode/gauss_jordan/matmul/osd_score/osd_check together as
// an integrated pipeline, cross-checked against the known-original message.
function seededRandom(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function makeValidPlain(rand: () => number): Uint8Array {
  const plain = new Uint8Array(91);
  for (let i = 0; i < 77; i++) plain[i] = rand() < 0.5 ? 0 : 1;
  const aa = new Array(91).fill(0);
  for (let i = 0; i < 77; i++) aa[i] = plain[i];
  const crc = ft8Crc(aa, 82);
  for (let i = 0; i < 14; i++) plain[77 + i] = crc[i];
  return plain;
}

function toLlr(codeword: Uint8Array): Float64Array {
  const ll = new Float64Array(174);
  for (let i = 0; i < 174; i++) ll[i] = codeword[i] ? -4.97 : 4.97;
  return ll;
}

describe('genSys', () => {
  test('174x91 shape and byte-verified against osd.cc (spot-checked rows)', () => {
    expect(GEN_SYS.length).toBe(174);
    expect(GEN_SYS[0].length).toBe(91);
  });

  test('first 91 rows are the 91x91 identity (systematic bits)', () => {
    for (let i = 0; i < 91; i++) {
      for (let j = 0; j < 91; j++) {
        expect(GEN_SYS[i][j]).toBe(i === j ? 1 : 0);
      }
    }
  });

  // Byte-verified against lib/ft8mon/osd.cc lines 317 (row 91) and 399 (row
  // 173) directly during construction of this file — spot-checking here so
  // a future accidental edit to genSys.ts is caught by the test suite too.
  test('row 91 (first parity row) matches osd.cc line 317', () => {
    const expected = '1000001100101001110011100001000110111111001100011110101011110101000010011111001001111111110'
      .split('')
      .map(Number);
    expect(GEN_SYS[91]).toEqual(expected);
  });

  test('row 173 (last row) matches osd.cc line 399', () => {
    const expected = '0110000010001100110010000101011101011001010010111111101110110101010111010110100101100000000'
      .split('')
      .map(Number);
    expect(GEN_SYS[173]).toEqual(expected);
  });
});

describe('ldpcEncode', () => {
  test('systematic bits pass through unchanged', () => {
    const rand = seededRandom(1);
    const plain = makeValidPlain(rand);
    const codeword = ldpcEncode(plain);
    for (let i = 0; i < 91; i++) expect(codeword[i]).toBe(plain[i]);
    expect(codeword.length).toBe(174);
  });

  test('all-zero plaintext encodes to all-zero codeword', () => {
    const codeword = ldpcEncode(new Uint8Array(91));
    expect(Array.from(codeword)).toEqual(new Array(174).fill(0));
  });
});

describe('matmul / gaussJordan', () => {
  test('matmul with identity matrix is the identity function', () => {
    const identity: number[][] = Array.from({ length: 91 }, (_, i) =>
      Array.from({ length: 91 }, (_, j) => (i === j ? 1 : 0)),
    );
    const rand = seededRandom(2);
    const v = new Uint8Array(91).map(() => (rand() < 0.5 ? 0 : 1));
    const result = matmul(identity, v);
    expect(Array.from(result)).toEqual(Array.from(v));
  });

  test('gaussJordan inverts a full-rank reordered GEN_SYS submatrix (identity ordering)', () => {
    // Using the natural (unsorted) ordering: b[i] = GEN_SYS[i] for i<174,
    // right half zeroed — same setup osd_decode() does with `which` being
    // an identity permutation, to confirm gauss_jordan itself is a correct
    // GF(2) inverter before testing it through the full OSD pipeline.
    const b: number[][] = [];
    for (let i = 0; i < 174; i++) {
      const row = new Array(182).fill(0);
      for (let j = 0; j < 91; j++) row[j] = GEN_SYS[i][j];
      b.push(row);
    }
    const which = Array.from({ length: 174 }, (_, i) => i);
    const ok = gaussJordan(b, which);
    expect(ok).toBe(true);

    // gen1_inv should invert GEN_SYS's own top 91x91 (identity) block back
    // to the identity, since which=identity means b's first 91 rows are
    // exactly GEN_SYS[0..90] = the 91x91 identity already.
    const gen1Inv: number[][] = [];
    for (let i = 0; i < 91; i++) {
      gen1Inv.push(b[i].slice(91, 182));
    }
    for (let i = 0; i < 91; i++) {
      for (let j = 0; j < 91; j++) {
        expect(gen1Inv[i][j]).toBe(i === j ? 1 : 0);
      }
    }
  });
});

describe('osdDecode: synthetic recovery vectors', () => {
  test('clean codeword (no corruption) decodes at depth=0', () => {
    const rand = seededRandom(999);
    const plain = makeValidPlain(rand);
    const codeword = ldpcEncode(plain);
    const ll174 = toLlr(codeword);

    const result = osdDecode(ll174, 2);
    expect(result.ok).toBe(true);
    expect(result.depthUsed).toBe(0);
    expect(Array.from(result.plain)).toEqual(Array.from(plain));
  });

  test('2 weak/low-confidence corrupted bits recovered at depth=2 (20 trials)', () => {
    const rand = seededRandom(12345);
    let passCount = 0;
    for (let trial = 0; trial < 20; trial++) {
      const plain = makeValidPlain(rand);
      const codeword = ldpcEncode(plain);
      const ll174 = toLlr(codeword);
      // Weaken (not fully flip) 2 bits so OSD's strongest-91 reordering
      // pushes them toward the untrusted tail.
      ll174[10] = -ll174[10] * 0.3;
      ll174[55] = -ll174[55] * 0.3;

      const result = osdDecode(ll174, 2);
      if (result.ok && Array.from(result.plain).every((v, i) => v === plain[i])) passCount++;
    }
    expect(passCount).toBe(20);
  });

  test('never returns ok=true with a WRONG plaintext (200 trials, varying corruption 1-3 full bit-flips)', () => {
    const rand = seededRandom(7777);
    let mismatches = 0;
    let anyDepthPositive = false;
    let anyFail = false;
    const N = 200;
    for (let trial = 0; trial < N; trial++) {
      const plain = makeValidPlain(rand);
      const codeword = ldpcEncode(plain);
      const ll174 = toLlr(codeword);
      const flipCount = 1 + (trial % 3);
      for (let k = 0; k < flipCount; k++) {
        const idx = Math.floor(rand() * 174);
        ll174[idx] = -ll174[idx];
      }
      const result = osdDecode(ll174, 2);
      if (result.ok) {
        const matches = Array.from(result.plain).every((v, i) => v === plain[i]);
        if (!matches) mismatches++;
        if (result.depthUsed > 0) anyDepthPositive = true;
      } else {
        anyFail = true;
      }
    }
    expect(mismatches).toBe(0); // the critical correctness property: no false-positive wrong decode
    expect(anyDepthPositive).toBe(true); // confirms the depth-flip loop path is genuinely exercised
    expect(anyFail).toBe(true); // confirms the "no valid decode found" path is genuinely exercised
  });

  test('all-zero plaintext is rejected by osd_check even if it were the algebraic result', () => {
    expect(checkCrc(new Uint8Array(91))).toBe(false);
  });

  test('throws on wrong-length input', () => {
    expect(() => osdDecode(new Float64Array(173), 2)).toThrow();
  });
});
