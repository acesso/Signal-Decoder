import {
  decodeCCIR476FromBits, ccir476Valid,
  CCIR476_LTRS, CCIR476_FIGS, CCIR476_ALPHA, CCIR476_REP,
  CCIR476_LTRS_TABLE, CCIR476_FIGS_TABLE,
} from '../ccir476';

// ── Test-side encoder ─────────────────────────────────────────────────────────

const CHAR_TO_LTRS = Object.fromEntries(Object.entries(CCIR476_LTRS_TABLE).map(([c, ch]) => [ch, Number(c)]));
const CHAR_TO_FIGS = Object.fromEntries(Object.entries(CCIR476_FIGS_TABLE).map(([c, ch]) => [ch, Number(c)]));

// Text → CCIR476 code sequence with LTRS/FIGS shifts.
function encodeChars(text: string): number[] {
  const codes: number[] = [CCIR476_LTRS];
  let figs = false;
  for (const ch of text) {
    if (CHAR_TO_LTRS[ch] !== undefined && (!figs || ch === ' ' || ch === '\n')) {
      codes.push(CHAR_TO_LTRS[ch]);
      if (figs && ch !== ' ' && ch !== '\n') figs = false;
    } else if (CHAR_TO_LTRS[ch] !== undefined && figs) {
      codes.push(CCIR476_LTRS, CHAR_TO_LTRS[ch]);
      figs = false;
    } else if (CHAR_TO_FIGS[ch] !== undefined) {
      if (!figs) { codes.push(CCIR476_FIGS); figs = true; }
      codes.push(CHAR_TO_FIGS[ch]);
    } else {
      throw new Error(`unencodable char: ${JSON.stringify(ch)}`);
    }
  }
  return codes;
}

// SITOR-B time diversity: DX slots at even indices carry the character
// stream; each odd (RX) slot repeats the code from five slots back. Leading
// phasing pairs are REP/ALPHA, the standard idle pattern.
function interleaveSITOR(chars: number[], phasingPairs = 6): number[] {
  const dx: number[] = [...Array(phasingPairs).fill(CCIR476_REP), ...chars];
  const slots: number[] = [];
  for (let k = 0; k < dx.length + 3; k++) {
    slots.push(dx[k] ?? CCIR476_ALPHA); // DX slot 2k
    const rxSource = 2 * k + 1 - 5;
    slots.push(rxSource >= 0 ? slots[rxSource] : CCIR476_ALPHA); // RX slot 2k+1
  }
  return slots;
}

function codesToBits(codes: number[], invert = false, phaseBits = 0): number[] {
  const bits: number[] = Array(phaseBits).fill(invert ? 1 : 0);
  for (const code of codes) {
    for (let i = 0; i < 7; i++) {
      const b = (code >> i) & 1;
      bits.push(invert ? b ^ 1 : b);
    }
  }
  return bits;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ccir476', () => {
  it('all table codes satisfy the 4-mark constant ratio', () => {
    for (const code of Object.keys(CCIR476_LTRS_TABLE)) expect(ccir476Valid(Number(code))).toBe(true);
    for (const code of Object.keys(CCIR476_FIGS_TABLE)) expect(ccir476Valid(Number(code))).toBe(true);
    // 29 chars per case + 6 control codes = all 35 valid 7-bit 4:3 codes
    expect(Object.keys(CCIR476_LTRS_TABLE).length).toBe(29);
  });

  it('decodes a SITOR-B interleaved stream', () => {
    const slots = interleaveSITOR(encodeChars('NAVTEX TEST 123'));
    const text = decodeCCIR476FromBits(codesToBits(slots));
    expect(text).toContain('NAVTEX TEST 123');
  });

  it('self-aligns on bit phase and inverted polarity', () => {
    const slots = interleaveSITOR(encodeChars('QUICK BROWN FOX'));
    expect(decodeCCIR476FromBits(codesToBits(slots, false, 3))).toContain('QUICK BROWN FOX');
    expect(decodeCCIR476FromBits(codesToBits(slots, true, 5))).toContain('QUICK BROWN FOX');
  });

  it('recovers a corrupted DX character from its RX repeat', () => {
    const slots = interleaveSITOR(encodeChars('SECURITE'));
    const bits = codesToBits(slots);
    // Find the DX slot carrying 'E' (0x56) and break its constant ratio.
    const dxIndex = slots.findIndex((c, i) => i % 2 === 0 && c === 0x56);
    expect(dxIndex).toBeGreaterThan(-1);
    bits[dxIndex * 7] ^= 1;
    expect(decodeCCIR476FromBits(bits)).toContain('SECURITE');
  });

  it('does not drop legitimate characters repeating five text positions apart', () => {
    // 'E' recurs exactly 5 apart — a naive "skip if equals code 5 slots back"
    // decode without DX/RX parity lock would eat one of them.
    const msg = 'DE DX DE DX DE';
    const slots = interleaveSITOR(encodeChars(msg));
    expect(decodeCCIR476FromBits(codesToBits(slots))).toContain(msg);
  });

  it('handles FIGS shifts', () => {
    const slots = interleaveSITOR(encodeChars('WIND 25 KNOTS'));
    expect(decodeCCIR476FromBits(codesToBits(slots))).toContain('WIND 25 KNOTS');
  });

  it('returns empty for random noise', () => {
    // Deterministic pseudo-noise (no Math.random in tests for reproducibility)
    let seed = 12345;
    const bits = Array.from({ length: 700 }, () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return (seed >> 16) & 1;
    });
    expect(decodeCCIR476FromBits(bits)).toBe('');
  });
});
