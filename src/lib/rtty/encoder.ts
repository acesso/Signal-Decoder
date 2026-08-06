// RTTY encoder — inverse of decoder.ts: text -> Baudot/ASCII code points ->
// phase-continuous FSK audio. Framing (start bit, LSB-first data bits,
// optional parity, stop bits) mirrors decoder.ts's FSM exactly so anything
// encoded here round-trips through this app's own decoder.
import { LTRS_TABLE, FIGS_TABLE, LTRS_SHIFT_CODE, FIGS_SHIFT_CODE } from './baudot';
import type { RTTYConfig } from './decoder';

// Reverse lookup built once from the decode tables — char -> 5-bit code,
// tagged with which shift table (LTRS/FIGS) it lives in. A few characters
// exist in both tables at different codes (e.g. space); LTRS wins ties since
// it's the idle/default shift, avoiding a needless shift pair for it.
interface BaudotEntry { code: number; figs: boolean }
const BAUDOT_ENCODE = new Map<string, BaudotEntry>();
for (let code = 0; code < LTRS_TABLE.length; code++) {
  const ch = LTRS_TABLE[code];
  if (ch && ch !== '\0' && !BAUDOT_ENCODE.has(ch)) BAUDOT_ENCODE.set(ch, { code, figs: false });
}
for (let code = 0; code < FIGS_TABLE.length; code++) {
  const ch = FIGS_TABLE[code];
  if (ch && ch !== '\0' && !BAUDOT_ENCODE.has(ch)) BAUDOT_ENCODE.set(ch, { code, figs: true });
}

/** Maps unsupported punctuation to the nearest Baudot equivalent so common
 *  typing (curly quotes, em dash) doesn't just silently drop characters. */
const BAUDOT_SUBSTITUTIONS: Record<string, string> = {
  '’': "'", '‘': "'", '“': '"', '”': '"',
  '—': '-', '–': '-', '\t': ' ',
};

export interface EncodeCharsResult {
  /** 5-bit Baudot code points in transmission order, including any LTRS/FIGS
   *  shift codes needed to reach each character. */
  codes: number[];
  /** Characters from the input that have no Baudot representation and were
   *  dropped (after substitution), in original order — surfaced so the UI
   *  can warn instead of silently mangling the message. */
  dropped: string[];
}

/** Baudot-encodes `text`, inserting LTRS/FIGS shift codes as needed. Starts
 *  from (and always ends in) LTRS, matching RTTY idle-line convention. */
export function encodeBaudotChars(text: string): EncodeCharsResult {
  const codes: number[] = [];
  const dropped: string[] = [];
  let inFigs = false;
  for (const raw of text) {
    const ch = raw === '\n' ? '\r\n' : (BAUDOT_SUBSTITUTIONS[raw] ?? raw);
    for (const c of ch) {
      const upper = c === c.toLowerCase() ? c : c.toUpperCase();
      const entry = BAUDOT_ENCODE.get(c) ?? BAUDOT_ENCODE.get(upper);
      if (!entry) {
        if (c !== ' ' || dropped[dropped.length - 1] !== ' ') dropped.push(c);
        continue;
      }
      if (entry.figs !== inFigs) {
        codes.push(entry.figs ? FIGS_SHIFT_CODE : LTRS_SHIFT_CODE);
        inFigs = entry.figs;
      }
      codes.push(entry.code);
    }
  }
  if (inFigs) codes.push(LTRS_SHIFT_CODE);
  return { codes, dropped };
}

/** ASCII-encodes `text` for 7/8-bit modes — printable range only, matching
 *  decoder.ts's decodeASCII() (0x20..0x7e). */
export function encodeAsciiChars(text: string): EncodeCharsResult {
  const codes: number[] = [];
  const dropped: string[] = [];
  for (const c of text) {
    const code = c.charCodeAt(0);
    if (code < 0x20 || code > 0x7e) {
      if (c !== '\n') dropped.push(c);
      continue;
    }
    codes.push(code);
  }
  return { codes, dropped };
}

function parityBit(code: number, bits: number, parity: RTTYConfig['parity']): number | null {
  if (parity === 'none') return null;
  if (parity === 'zero') return 0;
  if (parity === 'one') return 1;
  let ones = 0;
  for (let i = 0; i < bits; i++) if ((code >> i) & 1) ones++;
  return parity === 'even' ? ones % 2 : (ones % 2) ^ 1;
}

/** Phase-continuous FSK tone generator — same accumulate-phase-across-calls
 *  approach as sstv/encoder.ts's PhaseSynth, so mark<->space transitions
 *  never click. */
class FSKSynth {
  private phase = 0;
  constructor(private sampleRate: number) {}

  tone(freq: number, samples: number, out: Float32Array, offset: number): void {
    const step = (2 * Math.PI * freq) / this.sampleRate;
    for (let i = 0; i < samples; i++) {
      out[offset + i] = Math.sin(this.phase);
      this.phase += step;
      if (this.phase > Math.PI * 1e6) this.phase -= Math.PI * 1e6;
    }
  }
}

/** Encodes Baudot/ASCII code points into FSK audio samples per `config`.
 *  Framing matches decoder.ts exactly: 1 start bit (space tone),
 *  bitsPerChar data bits (LSB first), optional parity bit, stopBits stop
 *  bits (mark tone). Idle line (before/after the message) is mark. */
export function encodeRTTYSamples(
  codes: number[],
  config: RTTYConfig,
  sampleRate: number,
  idleSecPre = 0.5,
  idleSecPost = 0.5,
): Float32Array {
  const { centerFreq, carrierShift, baudRate, bitsPerChar, parity, stopBits, reverseShift } = config;
  const halfShift = carrierShift / 2;
  const markF  = reverseShift ? centerFreq + halfShift : centerFreq - halfShift;
  const spaceF = reverseShift ? centerFreq - halfShift : centerFreq + halfShift;

  const samplesPerBit = sampleRate / baudRate;
  const bitsPerCharTotal = 1 /* start */ + bitsPerChar + (parity !== 'none' ? 1 : 0) + stopBits;
  const totalBits = codes.length * bitsPerCharTotal;
  const preSamples = Math.round(idleSecPre * sampleRate);
  const postSamples = Math.round(idleSecPost * sampleRate);
  const bodySamples = Math.round(totalBits * samplesPerBit);
  const out = new Float32Array(preSamples + bodySamples + postSamples);

  const synth = new FSKSynth(sampleRate);
  synth.tone(markF, preSamples, out, 0);

  let offset = preSamples;
  const bitSamples = (bit: 0 | 1): number => {
    const n = Math.round(samplesPerBit);
    synth.tone(bit === 1 ? markF : spaceF, n, out, offset);
    offset += n;
    return n;
  };

  for (const code of codes) {
    bitSamples(0); // start bit = space
    for (let i = 0; i < bitsPerChar; i++) bitSamples(((code >> i) & 1) as 0 | 1);
    const p = parityBit(code, bitsPerChar, parity);
    if (p !== null) bitSamples(p as 0 | 1);
    // Stop "bits" can be fractional (1.5) — emit as one continuous mark tone
    // spanning stopBits bit-periods rather than rounding per sub-bit.
    const stopN = Math.round(stopBits * samplesPerBit);
    synth.tone(markF, stopN, out, offset);
    offset += stopN;
  }

  synth.tone(markF, out.length - offset, out, offset);
  return out;
}

/** Convenience: text -> FSK samples in one call, using config.bitsPerChar to
 *  pick Baudot (5-bit) vs ASCII (7/8-bit) encoding. Returns dropped chars
 *  alongside the samples so the caller can warn about anything untransmittable. */
export function encodeRTTYText(
  text: string,
  config: RTTYConfig,
  sampleRate: number,
): { samples: Float32Array; dropped: string[] } {
  const { codes, dropped } = config.bitsPerChar === 5 ? encodeBaudotChars(text) : encodeAsciiChars(text);
  const samples = encodeRTTYSamples(codes, config, sampleRate);
  return { samples, dropped };
}
