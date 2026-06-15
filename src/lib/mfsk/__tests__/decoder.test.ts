/**
 * MFSK unit decode tests — Node/Jest, no browser required.
 *
 * Uses MFSKDecoder (from decoder.ts) for Goertzel detection, feeding audio in
 * 4096-sample chunks exactly as the Web Audio API does in the real UI.
 * Uses decodeMFSKWithFEC (from fec.ts) for the FEC/varicode path.
 * This mirrors the full UI decode pipeline for all fldigi MFSK presets.
 *
 * fldigi MFSK modes (K=7 R=1/2 FEC + varicode, mode name = baud rate):
 *   MFSK4:   32 tones, 5 bps, symlen=2048 @ 8kHz,  3.906 Bd,  depth=5
 *   MFSK8:   32 tones, 5 bps, symlen=1000 @ 8kHz,  8.0 Bd,    depth=5
 *   MFSK16:  16 tones, 4 bps, symlen=512  @ 8kHz,  15.625 Bd, depth=10
 *   MFSK32:  16 tones, 4 bps, symlen=256  @ 8kHz,  31.25 Bd,  depth=10
 *   MFSK64:  64 tones, 6 bps, symlen=256  @ 8kHz,  31.25 Bd,  depth=10
 *   MFSK128: 128 tones,7 bps, symlen=512  @ 8kHz,  15.625 Bd, depth=20
 *
 * WBCQ recording (WBCQ_MFSK64_8k.wav, 194.2s, real HF broadcast):
 *   0–40s:    VOICE  — do not decode as MFSK
 *   40–155s:  MFSK64 digital signal
 *   155–194s: VOICE  — do not decode as MFSK
 */

import * as fs   from 'fs';
import * as path from 'path';
import { MFSKDecoder, MFSKChannel } from '../decoder';
import { decodeMFSKWithFEC, makeFECCursor, decodeMFSKWithFECIncremental } from '../fec';

// ── WAV reader ────────────────────────────────────────────────────────────────

interface WavData { sampleRate: number; samples: Float32Array; totalSeconds: number; }

function readWav(filePath: string): WavData {
  const buf = fs.readFileSync(filePath);
  if (buf.toString('ascii', 0, 4) !== 'RIFF') throw new Error(`Not a WAV: ${filePath}`);
  let pos = 12, sampleRate = 0, bitsPerSample = 0, numChannels = 0;
  let dataOffset = 0, dataLength = 0;
  while (pos < buf.length - 8) {
    const chunkId   = buf.toString('ascii', pos, pos + 4);
    const chunkSize = buf.readUInt32LE(pos + 4);
    pos += 8;
    if (chunkId === 'fmt ') {
      numChannels   = buf.readUInt16LE(pos + 2);
      sampleRate    = buf.readUInt32LE(pos + 4);
      bitsPerSample = buf.readUInt16LE(pos + 14);
    } else if (chunkId === 'data') {
      dataOffset = pos; dataLength = chunkSize; break;
    }
    pos += chunkSize + (chunkSize & 1);
  }
  if (!sampleRate || !dataOffset) throw new Error(`Bad WAV: ${filePath}`);
  const bytesPerSample = bitsPerSample >> 3;
  const numSamples = Math.floor(dataLength / (bytesPerSample * numChannels));
  const samples = new Float32Array(numSamples);
  const scale = 1 / (bitsPerSample === 16 ? 32768 : 128);
  for (let i = 0; i < numSamples; i++) {
    const p = dataOffset + i * bytesPerSample * numChannels;
    samples[i] = bitsPerSample === 16
      ? buf.readInt16LE(p) * scale
      : (buf.readUInt8(p) - 128) * scale;
  }
  return { sampleRate, samples, totalSeconds: numSamples / sampleRate };
}

// ── Engine: MFSKDecoder + decodeMFSKWithFEC (same as UI) ─────────────────────

/**
 * Feed a WAV segment through the full decode pipeline used by the UI.
 * MFSKDecoder handles Goertzel detection (4096-sample Web-Audio-style chunks).
 * decodeMFSKWithFEC handles de-interleave + Viterbi + varicode.
 */
function decodeSegment(
  samples:   Float32Array,
  sampleRate: number,
  numTones:  number,
  symlen:    number,
  bps:       number,
  depth:     number,
  startSec:  number,
  endSec:    number,
  baseFreq:  number = 1000,  // lowest tone Hz; fldigi production = 1000 Hz
): string {
  const s0    = Math.floor(startSec * sampleRate);
  const s1    = Math.min(Math.floor(endSec * sampleRate), samples.length);
  const slice = samples.slice(s0, s1);

  const spacing = sampleRate / symlen;

  const channels: MFSKChannel[] = Array.from({ length: numTones }, (_, i) => ({
    id:    `t${i}`,
    freq:  baseFreq + i * spacing,
    color: '#79c0ff',
    label: `T${i}`,
  }));

  // useGrayCode: true  — fldigi MFSK encodes Gray-coded tone indices
  // syncMode: 'free'   — Goertzel block mode, no start-bit sync (same as UI MFSK preset)
  const decoder = new MFSKDecoder(sampleRate, channels, spacing, {
    useGrayCode: true,
    syncMode:    'free',
  });

  const syms: { symbolIndex: number; powers: number[] }[] = [];
  decoder.onSymbol = s => syms.push({ symbolIndex: s.symbolIndex, powers: s.powers });

  // Feed in 4096-sample chunks — matches the Web Audio API ScriptProcessor chunk size
  const CHUNK = 4096;
  for (let i = 0; i < slice.length; i += CHUNK) {
    decoder.processSamples(slice.slice(i, i + CHUNK));
  }

  return decodeMFSKWithFEC(
    syms.map(s => s.symbolIndex),
    bps,
    true,
    depth,
    syms.map(s => s.powers),
  );
}

function wavPath(name: string) {
  return path.resolve(__dirname, '../../../../', 'test-samples', name);
}

function skipIfMissing(file: string, name: string): boolean {
  if (!fs.existsSync(file)) {
    console.warn(`Skipping ${name}: ${file} not found`);
    return true;
  }
  return false;
}

// ── FEC subsystem unit tests ──────────────────────────────────────────────────

describe('MFSK FEC subsystem', () => {
  const { viterbiDecode } = require('../fec');

  test('viterbiDecode: all-PUNCTURE (neutral) decodes to mostly zeros', () => {
    const puncture = new Uint8Array(200).fill(128);
    const dec = viterbiDecode(puncture);
    expect(dec.length).toBe(100);
    const ones = Array.from(dec as Uint8Array).filter((b: number) => b === 1).length;
    expect(ones).toBeLessThan(15);
  });

  test('viterbiDecode: all-255 input does not throw', () => {
    expect(() => viterbiDecode(new Uint8Array(200).fill(255))).not.toThrow();
  });

  test('decodeMFSKWithFEC: empty symbols returns empty string', () => {
    expect(decodeMFSKWithFEC([], 5, true, 5)).toBe('');
  });
});

// ── fldigi MFSK4/8/16/32 — clean synthetic WAVs ───────────────────────────────
// WAVs encoded by fldigi carrying: "The quick brown fox jumps over the lazy dog 1234567890"
// Tests use MFSKDecoder for detection (same as UI), not a standalone Goertzel loop.

interface MFSKMode {
  name:      string;
  numTones:  number;
  symlen:    number;
  bps:       number;
  depth:     number;
  wav:       string;
  baseFreq:  number;  // lowest tone frequency (Hz)
  expect:    string[];
  digitRun:  RegExp;
}

// fldigi parameters verified against mfsk.cxx:
// basefreq = sampleRate * basetone / symlen = 1000 Hz for all modes.
// MFSK4/8: basetone=256/128, numtones=32, bps=5. MFSK16/32/64: basetone=64/32/16, numtones=16, bps=4.
//
// NOTE: The sigidwiki WAV samples (MFSK_4/8/16/32) were encoded with center=1500 Hz
// (base = 1500 - (n-1)*spacing/2), not fldigi's production base=1000 Hz. The WBCQ
// OTA recording and MFSK_64_8k.wav use fldigi's actual base=1000 Hz.
const FLDIGI_MODES: MFSKMode[] = [
  {
    name: 'fldigi MFSK4',  numTones: 32, symlen: 2048, bps: 5, depth: 5,
    wav: 'MFSK_4_8k.wav',
    baseFreq: 1439.453,   // sigidwiki sample: center 1500 Hz → base = 1500 - 31*3.906/2
    expect: ['quick brown fox', 'lazy dog'],
    digitRun: /1234567890/,
  },
  {
    // MFSK8 sample from sigidwiki uses symlen=1000 (8.0 Bd, not nominal 7.813 Bd).
    // Interleaver warmup eats the first few words.
    name: 'fldigi MFSK8',  numTones: 32, symlen: 1000, bps: 5, depth: 5,
    wav: 'MFSK_8_8k.wav',
    baseFreq: 1378.906,   // sigidwiki sample: center 1500 Hz → base = 1500 - 31*8/2
    expect: ['quick brown'],
    digitRun: /[0-9]{5,}/,
  },
  {
    name: 'fldigi MFSK16', numTones: 16, symlen: 512,  bps: 4, depth: 10,
    wav: 'MFSK_16_8k.wav',
    baseFreq: 1382.813,   // sigidwiki sample: center 1500 Hz → base = 1500 - 15*15.625/2
    expect: ['quick brown fox', 'lazy dog'],
    digitRun: /1234567890/,
  },
  {
    name: 'fldigi MFSK32', numTones: 16, symlen: 256,  bps: 4, depth: 10,
    wav: 'MFSK_32_8k.wav',
    baseFreq: 1265.625,   // sigidwiki sample: center 1500 Hz → base = 1500 - 15*31.25/2
    expect: ['quick brown fox', 'lazy dog'],
    digitRun: /1234567890/,
  },
  {
    // MFSK64: symlen=128, basetone=16, numtones=16, bps=4, depth=10
    // MFSK_64_8k.wav uses fldigi's actual base=1000 Hz (confirmed by decode test)
    name: 'fldigi MFSK64', numTones: 16, symlen: 128,  bps: 4, depth: 10,
    wav: 'MFSK_64_8k.wav',
    baseFreq: 1000,       // fldigi production: base = basetone * spacing = 16 * 62.5
    expect: ['quick brown fox', 'lazy dog'],
    digitRun: /1234567890/,
  },
];

describe.each(FLDIGI_MODES)('$name decode', (mode) => {
  const file = wavPath(mode.wav);

  test('contains expected phrase substrings (soft-decision)', () => {
    if (skipIfMissing(file, mode.name)) return;
    const { sampleRate, samples, totalSeconds } = readWav(file);
    const text = decodeSegment(samples, sampleRate, mode.numTones, mode.symlen, mode.bps, mode.depth, 0, totalSeconds, mode.baseFreq);
    for (const phrase of mode.expect) {
      expect(text.toLowerCase()).toContain(phrase.toLowerCase());
    }
  });

  test('contains digit sequence from pangram (soft-decision)', () => {
    if (skipIfMissing(file, mode.name)) return;
    const { sampleRate, samples, totalSeconds } = readWav(file);
    const text = decodeSegment(samples, sampleRate, mode.numTones, mode.symlen, mode.bps, mode.depth, 0, totalSeconds, mode.baseFreq);
    expect(text).toMatch(mode.digitRun);
  });
});

// ── WBCQ MFSK64 — real HF over-the-air broadcast ─────────────────────────────
// Recording: WBCQ 7490 kHz, 194.2s total.
//   0–40s:   VOICE (AM broadcast intro, NOT MFSK)
//   40–155s: MFSK64 digital transmission
//   155–194s:VOICE (show continues, NOT MFSK)
//
// fldigi MFSK64: symlen=128, basetone=16, numtones=16, bps=4, depth=10.
// spacing = 8000/128 = 62.5 Hz, base = 16 * 62.5 = 1000 Hz.
// SNR degraded by HF fading; exact words cannot be asserted.

describe('MFSK64 real-signal (WBCQ HF broadcast, 40–155s digital segment)', () => {
  const WAV      = wavPath('WBCQ_MFSK64_8k.wav');
  const NUM_TONES = 16;
  const SYMLEN    = 128;   // 62.5 Bd at 8 kHz
  const BPS       = 4;     // log2(16)
  const DEPTH     = 10;
  // Digital segment: 40–155s. Voice at 0-40s and 155-194s must be excluded.
  const DIG_START = 40;
  const DIG_END   = 155;

  test('digital segment (40–155s) decodes without throw', () => {
    if (skipIfMissing(WAV, 'WBCQ MFSK64')) return;
    const { sampleRate, samples } = readWav(WAV);
    expect(() =>
      decodeSegment(samples, sampleRate, NUM_TONES, SYMLEN, BPS, DEPTH, DIG_START, DIG_END)
    ).not.toThrow();
  });

  test('digital segment produces substantially more word-like output than voice segment', () => {
    if (skipIfMissing(WAV, 'WBCQ MFSK64')) return;
    const { sampleRate, samples } = readWav(WAV);

    const digitalText = decodeSegment(samples, sampleRate, NUM_TONES, SYMLEN, BPS, DEPTH, DIG_START, DIG_END);
    const voiceText   = decodeSegment(samples, sampleRate, NUM_TONES, SYMLEN, BPS, DEPTH, 0, DIG_START);

    const wordCount     = (t: string) => (t.match(/[a-zA-Z]{3,}/g) ?? []).length;
    const digitalWords  = wordCount(digitalText);
    const voiceWords    = wordCount(voiceText);

    // Digital segment is ~3× longer and carries real data; should produce far more
    // coherent output than decoding voice as if it were MFSK64.
    expect(digitalWords).toBeGreaterThan(voiceWords * 2);
    // Absolute floor: 20 word-like sequences over 115 seconds of real HF MFSK64
    expect(digitalWords).toBeGreaterThanOrEqual(20);
  });

  test('voice segment (0–40s) produces fewer words than digital segment', () => {
    if (skipIfMissing(WAV, 'WBCQ MFSK64')) return;
    const { sampleRate, samples } = readWav(WAV);

    const digitalText = decodeSegment(samples, sampleRate, NUM_TONES, SYMLEN, BPS, DEPTH, DIG_START, DIG_END);
    const voiceText   = decodeSegment(samples, sampleRate, NUM_TONES, SYMLEN, BPS, DEPTH, 0, DIG_START);

    const wordCount    = (t: string) => (t.match(/[a-zA-Z]{3,}/g) ?? []).length;
    expect(wordCount(voiceText)).toBeLessThan(wordCount(digitalText));
  });
});

// ── FEC incremental decoder tests ─────────────────────────────────────────────

describe('FEC incremental decode — WBCQ full sample stability', () => {
  const WAV = wavPath('WBCQ_MFSK64_8k.wav');
  const NUM_TONES = 16, SYMLEN = 128, BPS = 4, DEPTH = 10;
  const DIG_START = 40, DIG_END = 155;

  function collectSymbols(samples: Float32Array, sampleRate: number) {
    const spacing = sampleRate / SYMLEN;
    const baseFreq = 1000;
    const s0 = Math.floor(DIG_START * sampleRate);
    const s1 = Math.floor(DIG_END   * sampleRate);
    const slice = samples.slice(s0, s1);
    const channels: MFSKChannel[] = Array.from({ length: NUM_TONES }, (_, i) => ({
      id: `t${i}`, freq: baseFreq + i * spacing, color: '#79c0ff', label: `T${i}`,
    }));
    const decoder = new MFSKDecoder(sampleRate, channels, spacing, {
      useGrayCode: true, syncMode: 'free',
    });
    const syms: { symbolIndex: number; powers: number[] }[] = [];
    decoder.onSymbol = (s) => syms.push({ symbolIndex: s.symbolIndex, powers: s.powers });
    const CHUNK = 4096;
    for (let i = 0; i < slice.length; i += CHUNK) {
      decoder.processSamples(slice.slice(i, i + CHUNK));
    }
    return syms;
  }

  test('incremental decode matches batch decode for digital segment', () => {
    if (skipIfMissing(WAV, 'WBCQ incremental')) return;
    const { sampleRate, samples } = readWav(WAV);
    const syms = collectSymbols(samples, sampleRate);

    // Batch decode (reference)
    const batchText = decodeMFSKWithFEC(
      syms.map(s => s.symbolIndex), BPS, true, DEPTH, syms.map(s => s.powers),
    );

    // Incremental decode — simulate feeding growing prefix of symbols as the UI does
    let cursor = makeFECCursor(BPS, DEPTH);
    let accumulated = '';
    const FEED_CHUNK = 50;
    for (let i = 0; i < syms.length; i += FEED_CHUNK) {
      const chunk = syms.slice(0, i + FEED_CHUNK);
      const result = decodeMFSKWithFECIncremental(
        chunk.map(s => s.symbolIndex),
        chunk.map(s => s.powers),
        cursor,
      );
      accumulated += result.newChars;
      cursor = result.cursor;
    }

    expect(accumulated.length).toBeGreaterThan(10);
    expect(accumulated.toLowerCase()).toMatch(/[a-z]{3,}/);
    // Incremental output should be a prefix of (or match) the batch output
    const minLen = Math.min(accumulated.length, batchText.length);
    if (minLen > 0) {
      expect(accumulated.slice(0, minLen)).toBe(batchText.slice(0, minLen));
    }
  });

  test('output does not freeze — processing time stays O(newSymbols) not O(totalSymbols)', () => {
    if (skipIfMissing(WAV, 'WBCQ incremental freeze')) return;
    const { sampleRate, samples } = readWav(WAV);
    const syms = collectSymbols(samples, sampleRate);

    let cursor = makeFECCursor(BPS, DEPTH);
    let accumulated = '';
    const callTimes: number[] = [];
    const FEED = 50;

    for (let i = 0; i < syms.length; i += FEED) {
      const t0 = Date.now();
      // Pass only the new chunk (not the full growing prefix) — this is the correct
      // incremental usage: cursor tracks position, so we only pass new symbols
      const chunk = syms.slice(0, i + FEED);
      const result = decodeMFSKWithFECIncremental(
        chunk.map(s => s.symbolIndex),
        chunk.map(s => s.powers),
        cursor,
      );
      callTimes.push(Date.now() - t0);
      accumulated += result.newChars;
      cursor = result.cursor;
    }

    // Last calls should not be significantly slower than first calls (O(newSymbols))
    const firstTen = callTimes.slice(0, 10).reduce((a, b) => a + b, 0) / 10;
    const lastTen  = callTimes.slice(-10).reduce((a, b) => a + b, 0)  / 10;
    // Allow generous 5× tolerance for system jitter; O(N) growth would be far worse
    expect(lastTen).toBeLessThan(Math.max(firstTen * 5, 50));

    expect(accumulated.length).toBeGreaterThan(10);
  });
});
