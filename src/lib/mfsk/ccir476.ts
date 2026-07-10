// CCIR 476 (ITU-R M.476/M.625) character decoder — SITOR-B / NAVTEX / AMTOR
// mode B. Each character is a 7-bit code with exactly four mark bits (4:3
// constant ratio, the code's error-detection property); codes are assembled
// LSB-first from the bit stream with mark = 1. Tables and conventions match
// fldigi's navtex.cxx.
//
// SITOR-B time diversity: every character is transmitted twice — first in its
// DX slot, repeated five character slots later in an RX slot (350 ms at
// 100 Bd). The decoder self-aligns (bit phase × polarity), infers which slot
// parity is RX from the "equals the code five slots back" statistic, then
// emits one character per DX/RX pair, falling back to the RX copy when the
// DX copy fails the constant-ratio check.

export const CCIR476_LTRS = 0x5a // shift to letters case
export const CCIR476_FIGS = 0x36 // shift to figures case
export const CCIR476_ALPHA = 0x0f // idle/phasing signal 2
export const CCIR476_BETA = 0x33 // idle signal
export const CCIR476_REP = 0x66 // repetition/phasing signal 1
export const CCIR476_CHAR32 = 0x6a // explicit space

// The 29 printable/format codes per case (the remaining 6 of the 35 valid
// 4-mark codes are the control signals above).
export const CCIR476_LTRS_TABLE: Record<number, string> = {
  0x17: 'J', 0x1b: 'F', 0x1d: 'C', 0x1e: 'K',
  0x27: 'W', 0x2b: 'Y', 0x2d: 'P', 0x2e: 'Q',
  0x35: 'G', 0x39: 'M', 0x3a: 'X', 0x3c: 'V',
  0x47: 'A', 0x4b: 'S', 0x4d: 'I', 0x4e: 'U',
  0x53: 'D', 0x55: 'R', 0x56: 'E', 0x59: 'N', 0x5c: ' ',
  0x63: 'Z', 0x65: 'L', 0x69: 'H', 0x6c: '\n',
  0x71: 'O', 0x72: 'B', 0x74: 'T', 0x78: '\r',
}

export const CCIR476_FIGS_TABLE: Record<number, string> = {
  0x17: "'", 0x1b: '!', 0x1d: ':', 0x1e: '(',
  0x27: '2', 0x2b: '6', 0x2d: '0', 0x2e: '1',
  0x35: '&', 0x39: '.', 0x3a: '/', 0x3c: ';',
  0x47: '-', 0x4b: '', 0x4d: '8', 0x4e: '7',
  0x53: '$', 0x55: '4', 0x56: '3', 0x59: ',', 0x5c: ' ',
  0x63: '"', 0x65: ')', 0x69: '#', 0x6c: '\n',
  0x71: '9', 0x72: '?', 0x74: '5', 0x78: '\r',
}

/** Constant-ratio check: a valid CCIR476 code has exactly four mark bits. */
export function ccir476Valid(code: number): boolean {
  let v = code & 0x7f
  let bc = 0
  while (v !== 0) {
    bc++
    v &= v - 1
  }
  return bc === 4
}

function assemble(bits: ArrayLike<number | boolean>, at: number, invert: boolean): number {
  let code = 0
  for (let i = 0; i < 7; i++) {
    const b = bits[at + i] ? 1 : 0
    if (b !== (invert ? 1 : 0)) code |= 1 << i
  }
  return code
}

interface Alignment {
  phase: number
  invert: boolean
  score: number
}

function findAlignment(bits: ArrayLike<number | boolean>): Alignment {
  const best: Alignment = { phase: 0, invert: false, score: -1 }
  for (const invert of [false, true]) {
    for (let phase = 0; phase < 7; phase++) {
      let valid = 0
      let total = 0
      for (let at = phase; at + 7 <= bits.length; at += 7) {
        total++
        if (ccir476Valid(assemble(bits, at, invert))) valid++
      }
      if (total === 0) continue
      const score = valid / total
      if (score > best.score) {
        best.phase = phase
        best.invert = invert
        best.score = score
      }
    }
  }
  return best
}

function decodeChar(code: number, figs: boolean): string {
  if (code === CCIR476_CHAR32) return ' '
  const ch = (figs ? CCIR476_FIGS_TABLE : CCIR476_LTRS_TABLE)[code]
  if (ch === undefined || ch === '\r') return ''
  return ch
}

/**
 * Decode a raw demodulated bit stream (tone-index bits, any polarity, any
 * bit phase) as SITOR-B / NAVTEX. Stateless full-buffer decode: alignment,
 * polarity, and DX/RX slot parity are re-derived from the whole stream each
 * call, matching the component's re-decode-from-scratch non-FEC paths.
 * Returns '' until the stream actually looks like CCIR476.
 */
export function decodeCCIR476FromBits(bits: ArrayLike<number | boolean>): string {
  if (bits.length < 70) return ''
  const align = findAlignment(bits)
  // Random bits pass the 4:3 check ~27% of the time — demand a clear majority
  // before claiming the stream is CCIR476 at all.
  if (align.score < 0.5) return ''

  const codes: number[] = []
  for (let at = align.phase; at + 7 <= bits.length; at += 7) {
    codes.push(assemble(bits, at, align.invert))
  }

  // RX slots repeat the code from five slots back; count that evidence per
  // slot parity to find which parity carries the repeats.
  const votes = [0, 0]
  for (let t = 5; t < codes.length; t++) {
    if (ccir476Valid(codes[t]) && codes[t] === codes[t - 5]) votes[t % 2]++
  }

  let figs = false
  const out: string[] = []
  const emit = (code: number) => {
    if (!ccir476Valid(code)) return
    if (code === CCIR476_LTRS) figs = false
    else if (code === CCIR476_FIGS) figs = true
    else if (code !== CCIR476_ALPHA && code !== CCIR476_BETA && code !== CCIR476_REP) {
      out.push(decodeChar(code, figs))
    }
  }

  if (votes[0] + votes[1] >= 3 && votes[0] !== votes[1]) {
    // Parity locked: one character per DX/RX pair, RX as fallback copy.
    const rxPar = votes[0] > votes[1] ? 0 : 1
    for (let t = 5; t < codes.length; t++) {
      if (t % 2 !== rxPar) continue
      const dx = codes[t - 5]
      emit(ccir476Valid(dx) ? dx : codes[t])
    }
  } else {
    // Not enough repetition evidence (short capture / non-FEC stream):
    // decode sequentially, skipping codes that match five slots back so an
    // FEC stream doesn't print everything twice.
    for (let t = 0; t < codes.length; t++) {
      if (t >= 5 && ccir476Valid(codes[t]) && codes[t] === codes[t - 5]) continue
      emit(codes[t])
    }
  }
  return out.join('')
}
