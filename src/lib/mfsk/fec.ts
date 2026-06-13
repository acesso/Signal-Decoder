/**
 * MFSK Forward Error Correction
 *
 * Implements the fldigi/gmfsk FEC pipeline:
 *   1. Soft-bit extraction from Goertzel powers (via Gray decode)
 *   2. Streaming cascade de-interleaver  (REV direction, PUNCTURE=128)
 *   3. Soft-decision Viterbi decoder  (K=7, R=1/2, fldigi polynomials)
 *
 * Polynomial set (from fldigi mfsk.h):
 *   POLY1 = 0x6d = 109 (0b1101101)
 *   POLY2 = 0x4f = 79  (0b1001111)
 *
 * Interleaver parameters (depth × bitsPerSymbol coded bits per block):
 *   MFSK4   4 tones  2 bps  depth  5
 *   MFSK8   8 tones  3 bps  depth  5
 *   MFSK16 16 tones  4 bps  depth 10
 *   MFSK32 32 tones  5 bps  depth 10
 *   MFSK64 64 tones  6 bps  depth 10
 *  MFSK128 128 tones 7 bps  depth 20
 */

import { grayEncode, grayDecode, decodeMFSKVaricodeFromBits, MFSK_VARICODE } from './varicode';

// ── Constants ─────────────────────────────────────────────────────────────────

const K        = 7;
const NSTATES  = 1 << (K - 1); // 64
// fldigi mfsk.h: POLY1 = 0x6d, POLY2 = 0x4f
const POLY1    = 0x6d;          // 109, 0b1101101
const POLY2    = 0x4f;          // 79,  0b1001111
const PUNCTURE = 128;           // neutral soft value (fldigi interleave.h)

function parity7(x: number): number {
  x ^= x >> 4; x ^= x >> 2; x ^= x >> 1; return x & 1;
}

// Encoder output table: output_table[i] for i in 0..127 (full 7-bit register).
// fldigi encoder: shreg = (shreg<<1 | bit) & 127, output = parity(P1&shreg)|(parity(P2&shreg)<<1)
// State n (0..63) = shreg & 63 (lower 6 bits, LSB = newest input bit).
// Viterbi trellis predecessors for state n: p0=n>>1 (via bit=0), p1=(n+64)>>1 (via bit=1).
const _outFull = new Uint8Array(NSTATES * 2); // [0..NSTATES-1]=bit-0 outputs, [NSTATES..2*NSTATES-1]=bit-1

(function buildTable() {
  for (let i = 0; i < NSTATES * 2; i++) {
    _outFull[i] = parity7(i & POLY1) | (parity7(i & POLY2) << 1);
  }
})();

// Soft metric tables: mettab[0][i] = 128-i, mettab[1][i] = i-128
// These match fldigi's mettab tables in viterbi.cxx
const _mettab0 = new Int16Array(256);
const _mettab1 = new Int16Array(256);
for (let i = 0; i < 256; i++) {
  _mettab0[i] = 128 - i;
  _mettab1[i] = i - 128;
}

// ── Soft-decision Viterbi ─────────────────────────────────────────────────────

/**
 * Soft-decision Viterbi K=7 R=1/2 decoder (fldigi-compatible).
 *
 * Uses maximum-metric algorithm with soft inputs 0-255.
 * Value 0 = strong 0, 255 = strong 1, 128 = erasure (PUNCTURE).
 *
 * Input pairs: (sym0, sym1) where sym0 = POLY1 output, sym1 = POLY2 output.
 * This matches fldigi viterbi::decode(symbolpair[0], symbolpair[1]).
 *
 * @param softPairs  Float32Array or Uint8Array of soft bit pairs, length = 2*nPairs.
 *                   Values in [0,255].
 * @returns          Decoded data bits (length = nPairs).
 */
export function viterbiDecode(softPairs: Uint8Array | Float32Array): Uint8Array {
  const nPairs = softPairs.length >> 1;
  if (nPairs === 0) return new Uint8Array(0);

  // fldigi chunksize=1, traceback=K*12=84: streams 1 decoded bit per input pair,
  // always tracing back 84 steps from the best current state.
  // We implement this as a circular PATHMEM buffer matching fldigi exactly.
  const TRACEBACK = K * 12;            // 84
  const PATHMEM   = TRACEBACK + 2;     // circular buffer depth

  // metrics[p][n] and history[p][n] stored flat as [p * NSTATES + n]
  const metrics = new Int32Array(PATHMEM * NSTATES);
  const history = new Uint8Array(PATHMEM * NSTATES);
  // metrics start at 0 (fldigi reset() does memset 0)

  let ptr = 0;
  const decoded = new Uint8Array(nPairs);

  for (let t = 0; t < nPairs; t++) {
    const prevptr = (ptr + PATHMEM - 1) % PATHMEM;
    const currptr = ptr;

    const s0 = softPairs[t * 2]     & 0xff;
    const s1 = softPairs[t * 2 + 1] & 0xff;

    const met0 = _mettab0[s1] + _mettab0[s0];
    const met1 = _mettab0[s1] + _mettab1[s0];
    const met2 = _mettab1[s1] + _mettab0[s0];
    const met3 = _mettab1[s1] + _mettab1[s0];
    const mets = [met0, met1, met2, met3];

    const prevRow = prevptr * NSTATES;
    const currRow = currptr * NSTATES;

    for (let n = 0; n < NSTATES; n++) {
      const p0 = n >> 1;
      const p1 = (n + NSTATES) >> 1;
      const m0 = metrics[prevRow + p0] + mets[_outFull[n]];
      const m1 = metrics[prevRow + p1] + mets[_outFull[n + NSTATES]];
      if (m0 >= m1) {
        metrics[currRow + n] = m0;
        history[currRow + n] = p0;
      } else {
        metrics[currRow + n] = m1;
        history[currRow + n] = p1;
      }
    }

    ptr = (ptr + 1) % PATHMEM;

    // fldigi traceback: from best state at currptr, trace back TRACEBACK steps.
    // The bit output is state & 1 at the end of the traceback (84 steps ago).
    let bestState = 0;
    for (let s = 1; s < NSTATES; s++) {
      if (metrics[currRow + s] > metrics[currRow + bestState]) bestState = s;
    }

    let tracePtr = currptr;
    let traceState = bestState;
    for (let i = 0; i < TRACEBACK; i++) {
      traceState = history[tracePtr * NSTATES + traceState];
      tracePtr   = (tracePtr + PATHMEM - 1) % PATHMEM;
    }

    decoded[t] = traceState & 1;
  }

  return decoded;
}

// ── Streaming cascade de-interleaver with soft values ─────────────────────────

/**
 * fldigi REV (receive-side) streaming de-interleaver.
 *
 * Accepts raw Goertzel powers per symbol and produces soft-coded bits (0-255)
 * matching fldigi's softdecode() + rxinlv->symbols() pipeline.
 *
 * The de-interleaver table is pre-filled with PUNCTURE=128 (neutral), so
 * output during the warmup period contributes zero Viterbi metric.
 *
 * @param powers   Array of length numSymbols, each element being an array of
 *                 length numTones with raw Goertzel power for that tone.
 * @param bps      Bits per symbol = log2(numTones).
 * @param depth    Mode-specific interleaver depth.
 * @returns        Soft-bit array length = numSymbols * bps.  Values 0-255.
 */
export function deinterleaveStreamSoft(
  powers: ArrayLike<number>[],
  bps:    number,
  depth:  number,
): Uint8Array {
  const size  = bps;
  const numTones = 1 << bps;
  // Pre-fill table with PUNCTURE (neutral soft value) — matches fldigi flush()
  const table = new Uint8Array(depth * size * size).fill(PUNCTURE);
  const out   = new Uint8Array(powers.length * size);

  for (let sym = 0; sym < powers.length; sym++) {
    const p = powers[sym];

    // Compute per-bit soft values using Goertzel power directly.
    //   sum = sum of powers, b[k] ± power for each tone.
    //   softbits[k] = clamp(128 + b[k] / sum * 256, 0, 255)
    let total = 0;
    const amps = new Float32Array(numTones);
    for (let i = 0; i < numTones; i++) {
      amps[i] = Math.max(0, p[i]);  // use raw Goertzel power (non-negative)
      total += amps[i];
    }
    if (total < 1e-20) total = 1e-20;

    const b = new Float32Array(size);
    for (let i = 0; i < numTones; i++) {
      const nib = grayEncode(i);  // fldigi graydecode: tone → nibble = i ^ (i>>1)
      const mag = amps[i];
      for (let k = 0; k < size; k++) {
        if ((nib >> (size - 1 - k)) & 1) b[k] += mag;
        else                              b[k] -= mag;
      }
    }

    // Convert to soft 0-255 — fldigi uses * 256 (not * 128)
    const psyms = new Uint8Array(size);
    for (let k = 0; k < size; k++) {
      const v = 128 + (b[k] / total) * 256;
      psyms[k] = v < 0 ? 0 : v > 255 ? 255 : v;
    }

    // Cascade through depth REV delay stages
    for (let kk = 0; kk < depth; kk++) {
      const base = kk * size * size;
      // Shift each bit's delay line left (drop oldest at pos 0, insert new at size-1)
      for (let i = 0; i < size; i++) {
        const row = base + i * size;
        table.copyWithin(row, row + 1, row + size);  // [0..size-2] = [1..size-1]
        table[row + size - 1] = psyms[i];
      }
      // REV read: bit i reads from position i
      for (let i = 0; i < size; i++) {
        psyms[i] = table[base + i * size + i];
      }
    }

    out.set(psyms, sym * size);
  }

  return out;
}

/**
 * fldigi REV streaming de-interleaver for hard-bit inputs (0 or 1).
 *
 * Uses Gray decode on tone index; PUNCTURE=128 fills unused positions.
 * Output is soft bits (0=strong-0, 255=strong-1, 128=neutral).
 */
export function deinterleaveStream(
  symbols: number[],
  bps:     number,
  depth:   number,
): Uint8Array {
  const size  = bps;
  const table = new Uint8Array(depth * size * size).fill(PUNCTURE);
  const out   = new Uint8Array(symbols.length * size);

  for (let sym = 0; sym < symbols.length; sym++) {
    const nib   = grayEncode(symbols[sym]);  // fldigi graydecode: tone → nibble = sym ^ (sym>>1)
    const psyms = new Uint8Array(size);
    for (let i = 0; i < size; i++) {
      psyms[i] = (nib >> (size - 1 - i)) & 1 ? 255 : 0;
    }

    for (let kk = 0; kk < depth; kk++) {
      const base = kk * size * size;
      for (let i = 0; i < size; i++) {
        const row = base + i * size;
        table.copyWithin(row, row + 1, row + size);
        table[row + size - 1] = psyms[i];
      }
      for (let i = 0; i < size; i++) {
        psyms[i] = table[base + i * size + i];
      }
    }

    out.set(psyms, sym * size);
  }

  return out;
}

// ── Combined FEC decode pipeline ──────────────────────────────────────────────

const TRACEBACK = K * 12;        // 84 — Viterbi traceback depth
const PATHMEM   = TRACEBACK + 2; // circular buffer depth for streaming Viterbi

/**
 * Decode MFSK symbols with K=7 R=1/2 convolutional FEC.
 *
 * Accepts raw Goertzel power arrays (one per received symbol) for soft-decision
 * decoding (preferred), or falls back to hard decisions if only tone indices are
 * available.
 *
 * Pipeline: powers → soft bits → streaming cascade de-interleave → Viterbi → varicode.
 *
 * @param symbols          Raw tone indices from the Goertzel detector.
 * @param bitsPerSym       log2(numTones).
 * @param useGray          Apply Gray decode to each tone index.
 * @param interleaverDepth Mode-specific interleaver depth.
 * @param powers           Optional raw Goertzel powers per symbol (numSymbols × numTones).
 *                         When provided, enables soft-decision decoding.
 */
export function decodeMFSKWithFEC(
  symbols:          number[],
  bitsPerSym:       number,
  useGray:          boolean,
  interleaverDepth: number,
  powers?:          ArrayLike<number>[],
): string {
  if (symbols.length === 0) return '';

  let softCoded: Uint8Array;

  if (powers && powers.length === symbols.length && useGray) {
    // Soft-decision path: use Goertzel powers for per-bit soft values
    softCoded = deinterleaveStreamSoft(powers, bitsPerSym, interleaverDepth);
  } else if (useGray) {
    // Hard-decision path: tone index → Gray decode → hard bits as soft (0 or 255)
    softCoded = deinterleaveStream(symbols, bitsPerSym, interleaverDepth);
  } else {
    // Non-Gray mode: raw bit extraction, no interleaver (non-standard)
    softCoded = new Uint8Array(symbols.length * bitsPerSym);
    for (let i = 0; i < symbols.length; i++) {
      for (let b = bitsPerSym - 1; b >= 0; b--) {
        softCoded[i * bitsPerSym + (bitsPerSym - 1 - b)] = (symbols[i] >> b) & 1 ? 255 : 0;
      }
    }
  }

  // Append PUNCTURE-padded flush tail so Viterbi traceback can drain all data bits.
  // fldigi uses traceback = K*12 = 84, chunksize = 8, so pad 84 pairs = 168 soft bits.
  const flush = new Uint8Array(TRACEBACK * 2).fill(PUNCTURE);
  const padded = new Uint8Array(softCoded.length + flush.length);
  padded.set(softCoded);
  padded.set(flush, softCoded.length);

  const dataBits = viterbiDecode(padded);
  return decodeMFSKVaricodeFromBits(dataBits);
}

// ── Truly incremental FEC decode cursor ──────────────────────────────────────

/**
 * Mutable cursor that holds all streaming state for the incremental FEC decoder.
 * Pass this to `decodeMFSKWithFECIncremental` on every call; it is updated in place.
 * Create with `makeFECCursor(bps, depth)` and discard when channels/baudRate change.
 */
export interface FECCursor {
  // Interleaver cascade state — one delay-line table per depth stage
  ilTable:   Uint8Array;  // depth * bps * bps, pre-filled with PUNCTURE
  ilSymbols: number;      // how many symbols have been fed into the interleaver

  // Accumulated interleaver output (soft bits, grows incrementally)
  softBuf:   number[];    // flat list of soft-coded bits, one bps-group per symbol

  // Viterbi streaming state (circular PATHMEM buffer)
  vmMetrics: Int32Array;  // PATHMEM * NSTATES — path metrics
  vmHistory: Uint8Array;  // PATHMEM * NSTATES — predecessor state for traceback
  vmPtr:     number;      // write pointer into [0, PATHMEM)
  vmPairs:   number;      // total soft pairs consumed from softBuf so far

  // Viterbi output bits (one bit per pair processed)
  decBits:   number[];

  // Varicode streaming state (applied to newly committed decBits)
  vcShreg:       number;  // shift register
  charCount:     number;  // total characters emitted so far
  committedBits: number;  // how many decBits have been fed through varicode

  // Mode parameters (kept so the cursor is self-contained)
  bps:   number;
  depth: number;
}

export function makeFECCursor(bps: number, depth: number): FECCursor {
  return {
    ilTable:   new Uint8Array(depth * bps * bps).fill(PUNCTURE),
    ilSymbols: 0,
    softBuf:   [],
    vmMetrics: new Int32Array(PATHMEM * NSTATES),
    vmHistory: new Uint8Array(PATHMEM * NSTATES),
    vmPtr:     0,
    vmPairs:   0,
    decBits:   [],
    vcShreg:   0,
    charCount: 0,
    committedBits: 0,
    bps,
    depth,
  };
}

/**
 * Truly incremental FEC decode.
 *
 * Processes only NEW symbols (those after cursor.ilSymbols) through the
 * interleaver and Viterbi decoder, then emits any newly committed varicode
 * characters.  O(newSymbols) per call — does NOT re-run from symbol 0.
 *
 * The cursor is mutated in place (it is a plain object, not React state).
 *
 * @param symbols   All symbols received so far (growing prefix — only the new
 *                  tail, from cursor.ilSymbols onward, is actually processed).
 * @param powers    Goertzel powers parallel to symbols (optional).
 * @param cursor    Mutable state object; updated by this call.
 * @returns         Newly committed text and the same cursor reference.
 */
export function decodeMFSKWithFECIncremental(
  symbols: number[],
  powers:  ArrayLike<number>[] | undefined,
  cursor:  FECCursor,
  bufOffset: number = 0,
): { newChars: string; cursor: FECCursor } {
  const { bps, depth } = cursor;
  const numTones = 1 << bps;

  // cursor.ilSymbols is absolute (total symbols ever fed into this cursor).
  // symbols[] is a rolling ring buffer starting at absolute index bufOffset.
  // localStart is the first index in symbols[] we haven't processed yet.
  const localStart = Math.max(0, cursor.ilSymbols - bufOffset);
  if (localStart >= symbols.length) return { newChars: '', cursor };

  // ── Step 1: Run interleaver on new symbols, append soft bits to softBuf ──────
  for (let si = localStart; si < symbols.length; si++) {
    const p = powers?.[si];
    const psyms = new Uint8Array(bps);

    if (p) {
      // Soft-decision: convert Goertzel powers to per-bit soft values
      let total = 0;
      const amps = new Float32Array(numTones);
      for (let i = 0; i < numTones; i++) { amps[i] = Math.max(0, p[i]); total += amps[i]; }
      if (total < 1e-20) total = 1e-20;
      const b = new Float32Array(bps);
      for (let i = 0; i < numTones; i++) {
        const nib = grayEncode(i);
        const mag = amps[i];
        for (let k = 0; k < bps; k++) {
          if ((nib >> (bps - 1 - k)) & 1) b[k] += mag; else b[k] -= mag;
        }
      }
      for (let k = 0; k < bps; k++) {
        const v = 128 + (b[k] / total) * 256;
        psyms[k] = v < 0 ? 0 : v > 255 ? 255 : v;
      }
    } else {
      // Hard-decision: tone index → Gray → hard bits as soft 0/255
      const nib = grayEncode(symbols[si]);
      for (let i = 0; i < bps; i++) {
        psyms[i] = (nib >> (bps - 1 - i)) & 1 ? 255 : 0;
      }
    }

    // Cascade through interleaver depth stages (REV mode, same as deinterleaveStreamSoft)
    for (let kk = 0; kk < depth; kk++) {
      const base = kk * bps * bps;
      for (let i = 0; i < bps; i++) {
        const row = base + i * bps;
        cursor.ilTable.copyWithin(row, row + 1, row + bps);
        cursor.ilTable[row + bps - 1] = psyms[i];
      }
      for (let i = 0; i < bps; i++) {
        psyms[i] = cursor.ilTable[base + i * bps + i];
      }
    }

    for (let i = 0; i < bps; i++) cursor.softBuf.push(psyms[i]);
  }
  cursor.ilSymbols = bufOffset + symbols.length;

  // ── Step 2: Run Viterbi on new soft pairs (two soft bits → one decoded bit) ──
  // softBuf[cursor.vmPairs * 2] is the next unconsumed byte.
  const softLen = cursor.softBuf.length;
  while (cursor.vmPairs * 2 + 1 < softLen) {
    const s0 = cursor.softBuf[cursor.vmPairs * 2]     & 0xff;
    const s1 = cursor.softBuf[cursor.vmPairs * 2 + 1] & 0xff;

    // ACS (add-compare-select) butterfly
    const met0 = _mettab0[s1] + _mettab0[s0];
    const met1 = _mettab0[s1] + _mettab1[s0];
    const met2 = _mettab1[s1] + _mettab0[s0];
    const met3 = _mettab1[s1] + _mettab1[s0];
    const mets = [met0, met1, met2, met3];

    const prevptr = (cursor.vmPtr + PATHMEM - 1) % PATHMEM;
    const currptr = cursor.vmPtr;
    const prevRow = prevptr * NSTATES;
    const currRow = currptr * NSTATES;

    for (let n = 0; n < NSTATES; n++) {
      const p0 = n >> 1, p1 = (n + NSTATES) >> 1;
      const m0 = cursor.vmMetrics[prevRow + p0] + mets[_outFull[n]];
      const m1 = cursor.vmMetrics[prevRow + p1] + mets[_outFull[n + NSTATES]];
      if (m0 >= m1) {
        cursor.vmMetrics[currRow + n] = m0;
        cursor.vmHistory[currRow + n] = p0;
      } else {
        cursor.vmMetrics[currRow + n] = m1;
        cursor.vmHistory[currRow + n] = p1;
      }
    }

    cursor.vmPtr = (cursor.vmPtr + 1) % PATHMEM;
    cursor.vmPairs++;

    // Traceback TRACEBACK steps from currptr to recover the committed decoded bit
    let bestState = 0;
    for (let s = 1; s < NSTATES; s++) {
      if (cursor.vmMetrics[currRow + s] > cursor.vmMetrics[currRow + bestState]) bestState = s;
    }
    let tracePtr = currptr, traceState = bestState;
    for (let i = 0; i < TRACEBACK; i++) {
      traceState = cursor.vmHistory[tracePtr * NSTATES + traceState];
      tracePtr   = (tracePtr + PATHMEM - 1) % PATHMEM;
    }
    cursor.decBits.push(traceState & 1);
  }

  // Trim softBuf periodically to keep memory bounded.
  // vmPairs indexes into softBuf as softBuf[vmPairs * 2], so we reset together.
  if (cursor.vmPairs > 5000) {
    cursor.softBuf.splice(0, cursor.vmPairs * 2);
    cursor.vmPairs = 0;
  }

  // ── Step 3: Feed newly decoded bits through the varicode decoder ──────────────
  // Every decoded bit from Viterbi is already committed (the traceback lag is
  // handled inside the Viterbi loop above — decBits[i] is always stable).
  const newCharsArr: string[] = [];
  while (cursor.committedBits < cursor.decBits.length) {
    const bit = cursor.decBits[cursor.committedBits++];
    cursor.vcShreg = ((cursor.vcShreg << 1) | bit) >>> 0;
    // Varicode end-of-code: three consecutive 0s (pattern & 7 === 1 after shift)
    if ((cursor.vcShreg & 7) === 1 && cursor.vcShreg !== 1) {
      const code = cursor.vcShreg >>> 1;
      const ch = MFSK_VARICODE[code];
      if (ch !== undefined) {
        newCharsArr.push(ch === '\r' || ch === '\n' ? '\n' : ch);
        cursor.charCount++;
      }
      cursor.vcShreg = 1;
    }
  }

  // Trim emitted bits to keep memory bounded
  if (cursor.committedBits > 10000) {
    cursor.decBits.splice(0, cursor.committedBits);
    cursor.committedBits = 0;
  }

  return { newChars: newCharsArr.join(''), cursor };
}

// ── Legacy hard-decision de-interleaver (kept for compatibility) ──────────────

/**
 * Diagonal block de-interleaver (legacy — not used by decodeMFSKWithFEC).
 */
export function deinterleave(bits: Uint8Array, size: number, depth: number): Uint8Array {
  const out = new Uint8Array(size * depth);
  for (let k = 0; k < depth; k++) {
    for (let j = 0; j < size; j++) {
      out[k * size + j] = bits[((k + j) % depth) * size + j];
    }
  }
  return out;
}

/**
 * Default interleaver depth for common MFSK modes (keyed by number of tones).
 */
export const MFSK_INTERLEAVER_DEPTH: Record<number, number> = {
  4:   5,
  8:   5,
  16:  10,
  32:  10,
  64:  10,
  128: 20,
};
