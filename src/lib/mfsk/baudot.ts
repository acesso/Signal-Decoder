/**
 * ITA2 / Baudot tables and decoder for RTTY.
 *
 * Bit numbering: code points are 5-bit values where bit 0 is the LSB
 * (= first bit transmitted on RTTY, LSB-first order).
 *
 * Regional variants exist; this uses the CCITT ITA2 standard, the most
 * common in amateur RTTY.
 */

// code 27 = FIGS shift, code 31 = LTRS shift
export const BAUDOT_LTRS: string[] = [
  '\0', 'E', '\n', 'A', ' ', 'S', 'I', 'U',
  '\r', 'D', 'R',  'J', 'N', 'F', 'C', 'K',
  'T',  'Z', 'L',  'W', 'H', 'Y', 'P', 'Q',
  'O',  'B', 'G',  '\x1b', 'M', 'X', 'V', '\x1f',
];

export const BAUDOT_FIGS: string[] = [
  '\0', '3', '\n', '-', ' ', "'", '8', '7',
  '\r', '\x05', '4', '\x07', ',', '!', ':', '(',
  '5',  '"',  ')', '2', '#', '6', '0', '1',
  '9',  '?',  '&', '\x1b', '.', '/', '=', '\x1f',
];

export const BAUDOT_FIGS_CODE = 27;  // 0b11011
export const BAUDOT_LTRS_CODE = 31;  // 0b11111

/**
 * Decode a sequence of 5-bit Baudot code points into a string.
 *
 * `codePoints` is an array of numbers 0-31.  `initialShift` defaults to
 * 'ltrs' (letters shift, as per RTTY idle state = Mark = LTRS).
 */
export function decodeBaudotCodePoints(
  codePoints: number[],
  initialShift: 'ltrs' | 'figs' = 'ltrs',
): string {
  let shift = initialShift;
  const out: string[] = [];

  for (const code of codePoints) {
    if (code === BAUDOT_FIGS_CODE) { shift = 'figs'; continue; }
    if (code === BAUDOT_LTRS_CODE) { shift = 'ltrs'; continue; }
    if (code === 0) continue;

    const ch = (shift === 'ltrs' ? BAUDOT_LTRS : BAUDOT_FIGS)[code];
    if (!ch) continue;
    const cp = ch.charCodeAt(0);
    if (cp === 13 || cp === 10) { out.push('\n'); continue; }
    if (cp >= 32 && cp < 127) out.push(ch);
    // other control chars (BEL, ENQ, etc.) are silently dropped
  }
  return out.join('');
}

/**
 * Convert a time-ordered bit array to a Baudot code point.
 *
 * For RTTY (LSB-first): bits[0] is the first transmitted bit = LSB.
 * For MSB-first: bits[0] is the MSB.
 */
export function bitsToBaudotCode(bits: boolean[], lsbFirst: boolean): number {
  let code = 0;
  const n = Math.min(5, bits.length);
  for (let i = 0; i < n; i++) {
    if (bits[i]) code |= lsbFirst ? (1 << i) : (1 << (4 - i));
  }
  return code;
}
