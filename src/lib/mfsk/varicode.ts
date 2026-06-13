/**
 * IZ8BLY / ZL1BPU binary varicode for MFSK16/8/32 etc.
 *
 * Each character maps to a variable-length binary code.  Characters are
 * separated by a two-bit "00" delimiter.  The shift-register decoder fires
 * when (datashreg & 7) === 1, meaning the last three received bits are 001:
 *   bit-0 = 1  → first bit of the NEXT character
 *   bit-1 = 0  → separator second bit
 *   bit-2 = 0  → separator first bit
 * At that point `datashreg >> 3` yields the code value for the current char.
 *
 * Gray code (for MFSK16 tones): tone N carries data nibble gray(N) = N ^ (N>>1).
 * Bits are assembled MSB-first from the nibble.
 */

/**
 * Convert a binary value to Gray code: n → n ^ (n>>1).
 * fldigi uses this on the RX side (graydecode in misc.cxx): tone → nibble.
 */
export function grayEncode(n: number): number {
  return n ^ (n >> 1);
}

/**
 * Convert a Gray-coded value back to binary (iterative, arbitrary bit width).
 * fldigi uses this on the TX side (grayencode in misc.cxx): nibble → tone.
 */
export function grayDecode(gray: number): number {
  let n = gray;
  for (let mask = gray >> 1; mask; mask >>= 1) n ^= mask;
  return n;
}

/**
 * Reverse lookup: shift-register code value → ASCII character.
 *
 * Code value = parseInt(codeString, 2) where codeString is the IZ8BLY table
 * entry for that character (bits in transmission order, MSB first).
 */
export const MFSK_VARICODE: Record<number, string> = {
  // ── Space / punctuation ──────────────────────────────────────────────────
  4: ' ',     // 100
  448: '!',   // 111000000
  508: '"',   // 111111100
  728: '#',   // 1011011000
  680: '$',   // 1010101000
  672: '%',   // 1010100000
  512: '&',   // 1000000000
  444: "'",   // 110111100
  500: '(',   // 111110100
  496: ')',   // 111110000
  692: '*',   // 1010110100
  480: '+',   // 111100000
  160: ',',   // 10100000
  472: '-',   // 111011000
  468: '.',   // 111010100
  488: '/',   // 111101000

  // ── Digits ───────────────────────────────────────────────────────────────
  224: '0',   // 11100000
  240: '1',   // 11110000
  320: '2',   // 101000000
  340: '3',   // 101010100
  372: '4',   // 101110100
  352: '5',   // 101100000
  364: '6',   // 101101100
  416: '7',   // 110100000
  384: '8',   // 110000000
  428: '9',   // 110101100

  // ── More punctuation ─────────────────────────────────────────────────────
  492: ':',   // 111101100
  504: ';',   // 111111000
  704: '<',   // 1011000000
  476: '=',   // 111011100
  700: '>',   // 1010111100
  464: '?',   // 111010000
  640: '@',   // 1010000000

  // ── Uppercase A-Z ────────────────────────────────────────────────────────
  188: 'A',   // 10111100
  256: 'B',   // 100000000
  212: 'C',   // 11010100
  220: 'D',   // 11011100
  184: 'E',   // 10111000
  248: 'F',   // 11111000
  336: 'G',   // 101010000
  344: 'H',   // 101011000
  192: 'I',   // 11000000
  436: 'J',   // 110110100
  380: 'K',   // 101111100
  244: 'L',   // 11110100
  232: 'M',   // 11101000
  252: 'N',   // 11111100
  208: 'O',   // 11010000
  236: 'P',   // 11101100
  432: 'Q',   // 110110000
  216: 'R',   // 11011000
  180: 'S',   // 10110100
  176: 'T',   // 10110000
  348: 'U',   // 101011100
  424: 'V',   // 110101000
  360: 'W',   // 101101000
  368: 'X',   // 101110000
  376: 'Y',   // 101111000
  440: 'Z',   // 110111000

  // ── Brackets / symbols ───────────────────────────────────────────────────
  744: '[',   // 1011101000
  720: '\\',  // 1011010000
  748: ']',   // 1011101100
  724: '^',   // 1011010100
  688: '_',   // 1010110000
  684: '`',   // 1010101100

  // ── Lowercase a-z ────────────────────────────────────────────────────────
  20: 'a',    // 10100
  96: 'b',    // 1100000
  56: 'c',    // 111000
  52: 'd',    // 110100
  8: 'e',     // 1000
  80: 'f',    // 1010000
  88: 'g',    // 1011000
  48: 'h',    // 110000
  24: 'i',    // 11000
  128: 'j',   // 10000000
  112: 'k',   // 1110000
  44: 'l',    // 101100
  64: 'm',    // 1000000
  28: 'n',    // 11100
  16: 'o',    // 10000
  84: 'p',    // 1010100
  120: 'q',   // 1111000
  32: 'r',    // 100000
  40: 's',    // 101000
  12: 't',    // 1100
  60: 'u',    // 111100
  108: 'v',   // 1101100
  104: 'w',   // 1101000
  116: 'x',   // 1110100
  92: 'y',    // 1011100
  124: 'z',   // 1111100

  // ── More symbols ─────────────────────────────────────────────────────────
  732: '{',   // 1011011100
  696: '|',   // 1010111000
  736: '}',   // 1011100000
  752: '~',   // 1011110000

  // Common control codes (same encoding as fldigi)
  2: '\r',    // 10
  3: '\n',    // 11
};

/**
 * Decode a flat stream of 0/1 data bits into text using binary varicode.
 * Used as the final stage of the FEC pipeline.
 */
export function decodeMFSKVaricodeFromBits(bits: Uint8Array | number[]): string {
  const chars: string[] = [];
  let datashreg = 0;

  for (let i = 0; i < bits.length; i++) {
    const bit = bits[i] & 1;
    datashreg = ((datashreg << 1) | bit) >>> 0;
    if ((datashreg & 7) === 1 && datashreg !== 1) {
      const code = datashreg >>> 1;
      const ch = MFSK_VARICODE[code];
      if (ch !== undefined) {
        chars.push(ch === '\r' || ch === '\n' ? '\n' : ch);
      }
      datashreg = 1;
    }
  }

  return chars.join('');
}

/**
 * Decode a stream of MFSK symbol indices into text using binary varicode.
 *
 * @param symbols      Array of Goertzel tone indices (0 = lowest tone).
 * @param bitsPerSym   Number of bits each symbol carries (log2 of num tones).
 * @param useGrayCode  Apply Gray decode to each tone index before extracting bits.
 */
export function decodeMFSKVaricode(
  symbols: number[],
  bitsPerSym: number,
  useGrayCode: boolean,
): string {
  const bits: number[] = [];

  for (const sym of symbols) {
    const nibble = useGrayCode ? grayDecode(sym) : sym;
    for (let b = bitsPerSym - 1; b >= 0; b--) {
      bits.push((nibble >> b) & 1);
    }
  }

  return decodeMFSKVaricodeFromBits(bits);
}
