/**
 * SSTV Encoder — synthesizes FM audio for every mode in SSTV_MODES from an
 * RGBA image buffer. Inverse of decoder.ts + *-line-decoder.ts: instead of
 * demodulating frequency -> pixel level, it walks pixels -> frequency and
 * integrates phase to produce samples. Frequency/timing constants are kept
 * in exact lockstep with the decoders so anything encoded here round-trips
 * through this app's own decoder.
 */
import { SSTV_MODES, SSTVMode, FREQ_SYNC, FREQ_BLACK, FREQ_WHITE, FREQ_VIS_BIT0, FREQ_VIS_BIT1, FREQ_VIS_START, FREQ_VIS_STOP } from './constants';

export interface EncodeProgress {
  line: number;
  totalLines: number;
}

/** Accumulates phase across the whole waveform so consecutive tones are
 *  phase-continuous (no clicks at frequency boundaries). */
class PhaseSynth {
  private phase = 0;
  constructor(private sampleRate: number) {}

  tone(freq: number, seconds: number, out: number[]): void {
    const n = Math.round(seconds * this.sampleRate);
    const step = (2 * Math.PI * freq) / this.sampleRate;
    for (let i = 0; i < n; i++) {
      out.push(Math.sin(this.phase));
      this.phase += step;
      if (this.phase > Math.PI * 1e6) this.phase -= Math.PI * 1e6; // keep bounded, harmless to the waveform
    }
  }

  /** Frequency sweeps linearly across `seconds`, sampled once per output
   *  sample via `freqAt(t 0..1)` — used for a scan line's per-pixel tones. */
  sweep(freqAt: (t: number) => number, seconds: number, out: number[]): void {
    const n = Math.round(seconds * this.sampleRate);
    for (let i = 0; i < n; i++) {
      const freq = freqAt(i / n);
      const step = (2 * Math.PI * freq) / this.sampleRate;
      out.push(Math.sin(this.phase));
      this.phase += step;
      if (this.phase > Math.PI * 1e6) this.phase -= Math.PI * 1e6;
    }
  }
}

function levelToFreq(level: number): number {
  // level: 0..255 -> FREQ_BLACK..FREQ_WHITE (inverse of freqToLevel in the line decoders)
  const clamped = Math.max(0, Math.min(255, level));
  return FREQ_BLACK + (clamped / 255) * (FREQ_WHITE - FREQ_BLACK);
}

/** RGB (0-255) -> YUV (ITU-R BT.601), inverse of yuv2rgb() in the line decoders. */
function rgb2yuv(r: number, g: number, b: number): { y: number; u: number; v: number } {
  const y = 16 + (65.738 * r + 129.057 * g + 25.064 * b) / 256;
  const u = 128 + (-37.945 * r - 74.494 * g + 112.439 * b) / 256; // B-Y
  const v = 128 + (112.439 * r - 94.154 * g - 18.285 * b) / 256; // R-Y
  return {
    y: Math.max(0, Math.min(255, y)),
    u: Math.max(0, Math.min(255, u)),
    v: Math.max(0, Math.min(255, v)),
  };
}

function pixelAt(img: Uint8ClampedArray, width: number, x: number, y: number): { r: number; g: number; b: number } {
  const idx = (y * width + x) * 4;
  return { r: img[idx], g: img[idx + 1], b: img[idx + 2] };
}

/** Resample a source image (nearest-neighbor) to the target width/height —
 *  callers pre-scale the composed canvas to each mode's native resolution. */
export function resizeImageData(src: Uint8ClampedArray, srcW: number, srcH: number, dstW: number, dstH: number): Uint8ClampedArray {
  const dst = new Uint8ClampedArray(dstW * dstH * 4);
  for (let y = 0; y < dstH; y++) {
    const sy = Math.min(srcH - 1, Math.floor((y * srcH) / dstH));
    for (let x = 0; x < dstW; x++) {
      const sx = Math.min(srcW - 1, Math.floor((x * srcW) / dstW));
      const s = (sy * srcW + sx) * 4;
      const d = (y * dstW + x) * 4;
      dst[d] = src[s];
      dst[d + 1] = src[s + 1];
      dst[d + 2] = src[s + 2];
      dst[d + 3] = 255;
    }
  }
  return dst;
}

function encodeVIS(synth: PhaseSynth, visCode: number, out: number[]): void {
  synth.tone(FREQ_VIS_START, 0.3, out); // leader
  synth.tone(FREQ_SYNC, 0.01, out); // break
  synth.tone(FREQ_VIS_START, 0.3, out); // leader
  synth.tone(FREQ_VIS_STOP, 0.03, out); // start bit

  let parity = 0;
  for (let bit = 0; bit < 7; bit++) {
    const b = (visCode >> bit) & 1;
    parity ^= b;
    synth.tone(b ? FREQ_VIS_BIT1 : FREQ_VIS_BIT0, 0.03, out);
  }
  synth.tone(parity ? FREQ_VIS_BIT1 : FREQ_VIS_BIT0, 0.03, out); // even parity bit
  synth.tone(FREQ_VIS_STOP, 0.03, out); // stop bit
}

function scanRowSweep(synth: PhaseSynth, img: Uint8ClampedArray, width: number, row: number, channel: 'R' | 'G' | 'B' | 'Y' | 'U' | 'V', seconds: number, out: number[]): void {
  // Per-pixel YUV is expensive to recompute per sample; precompute the row once.
  const levels = new Float32Array(width);
  for (let x = 0; x < width; x++) {
    const { r, g, b } = pixelAt(img, width, x, row);
    if (channel === 'R') levels[x] = r;
    else if (channel === 'G') levels[x] = g;
    else if (channel === 'B') levels[x] = b;
    else {
      const yuv = rgb2yuv(r, g, b);
      levels[x] = channel === 'Y' ? yuv.y : channel === 'U' ? yuv.u : yuv.v;
    }
  }
  synth.sweep((t) => levelToFreq(levels[Math.min(width - 1, Math.floor(t * width))]), seconds, out);
}

/** Averages the YUV channel across a pair of rows (even+odd) — used for the
 *  PD family's shared-chroma "V-avg"/"U-avg" channels. */
function scanRowSweepAvgUV(synth: PhaseSynth, img: Uint8ClampedArray, width: number, rowA: number, rowB: number, channel: 'U' | 'V', seconds: number, out: number[]): void {
  const levels = new Float32Array(width);
  for (let x = 0; x < width; x++) {
    const a = pixelAt(img, width, x, rowA);
    const b = pixelAt(img, width, x, rowB);
    const yuvA = rgb2yuv(a.r, a.g, a.b);
    const yuvB = rgb2yuv(b.r, b.g, b.b);
    levels[x] = channel === 'U' ? (yuvA.u + yuvB.u) / 2 : (yuvA.v + yuvB.v) / 2;
  }
  synth.sweep((t) => levelToFreq(levels[Math.min(width - 1, Math.floor(t * width))]), seconds, out);
}

function encodeRobot36(synth: PhaseSynth, img: Uint8ClampedArray, mode: SSTVMode, out: number[]): void {
  for (let row = 0; row < mode.height; row++) {
    const even = row % 2 === 0;
    synth.tone(FREQ_SYNC, mode.syncPulse / 1000, out);
    synth.tone(FREQ_BLACK, mode.syncPorch / 1000, out); // sync porch
    scanRowSweep(synth, img, mode.width, row, 'Y', mode.colorScanTimes![0] / 1000, out);
    synth.tone(even ? 1500 : 2300, mode.separatorPulses![0] / 1000, out); // separator: freq marks even/odd
    synth.tone(FREQ_BLACK, 0.0015, out); // porch
    scanRowSweep(synth, img, mode.width, row, even ? 'V' : 'U', mode.colorScanTimes![1] / 1000, out);
  }
}

function encodeRobot72(synth: PhaseSynth, img: Uint8ClampedArray, mode: SSTVMode, out: number[]): void {
  for (let row = 0; row < mode.height; row++) {
    synth.tone(FREQ_SYNC, mode.syncPulse / 1000, out);
    synth.tone(FREQ_BLACK, mode.syncPorch / 1000, out);
    scanRowSweep(synth, img, mode.width, row, 'Y', mode.colorScanTimes![0] / 1000, out);
    synth.tone(FREQ_BLACK, mode.separatorPulses![0] / 1000, out);
    synth.tone(FREQ_BLACK, 0.0015, out);
    scanRowSweep(synth, img, mode.width, row, 'V', mode.colorScanTimes![1] / 1000, out);
    synth.tone(FREQ_BLACK, mode.separatorPulses![1] / 1000, out);
    synth.tone(FREQ_BLACK, 0.0015, out);
    scanRowSweep(synth, img, mode.width, row, 'U', mode.colorScanTimes![2] / 1000, out);
  }
}

function encodePD(synth: PhaseSynth, img: Uint8ClampedArray, mode: SSTVMode, out: number[]): void {
  // Two source rows (even/odd) per transmitted scan line: sync + porch + Y-even + V-avg + U-avg + Y-odd
  const chSec = mode.colorScanTime / 1000;
  for (let pair = 0; pair < mode.height / 2; pair++) {
    const rowEven = pair * 2;
    const rowOdd = Math.min(mode.height - 1, pair * 2 + 1);
    synth.tone(FREQ_SYNC, mode.syncPulse / 1000, out);
    synth.tone(FREQ_BLACK, mode.syncPorch / 1000, out);
    scanRowSweep(synth, img, mode.width, rowEven, 'Y', chSec, out);
    scanRowSweepAvgUV(synth, img, mode.width, rowEven, rowOdd, 'V', chSec, out);
    scanRowSweepAvgUV(synth, img, mode.width, rowEven, rowOdd, 'U', chSec, out);
    scanRowSweep(synth, img, mode.width, rowOdd, 'Y', chSec, out);
  }
}

function encodeScottie(synth: PhaseSynth, img: Uint8ClampedArray, mode: SSTVMode, out: number[]): void {
  // RGB sequential, negative timing (G,B transmitted before the sync that
  // marks the line, R after) — see scottie-s1-line-decoder.ts for the
  // rationale. Synthesizing in *playback* order (which is what actually goes
  // out over the air) means: for line 0, sync -> sep -> G -> sep -> B -> sync
  // -> sep -> R; for every following line, the previous line's "next sync"
  // IS this line's leading sync, so steady state is sync -> R -> sep -> G ->
  // sep -> B, repeating. The decoder pairs each sync with the G/B that
  // *precedes* it and the R that *follows* it, so this ordering decodes
  // correctly despite looking like R,G,B per visual line.
  const chSec = mode.colorScanTime / 1000;
  const sep = mode.separatorPulses![0] / 1000;
  synth.tone(FREQ_SYNC, mode.syncPulse / 1000, out);
  synth.tone(FREQ_BLACK, sep, out);
  scanRowSweep(synth, img, mode.width, 0, 'G', chSec, out);
  synth.tone(FREQ_BLACK, sep, out);
  scanRowSweep(synth, img, mode.width, 0, 'B', chSec, out);
  for (let row = 0; row < mode.height; row++) {
    synth.tone(FREQ_SYNC, mode.syncPulse / 1000, out);
    synth.tone(FREQ_BLACK, sep, out);
    scanRowSweep(synth, img, mode.width, row, 'R', chSec, out);
    if (row + 1 < mode.height) {
      synth.tone(FREQ_BLACK, sep, out);
      scanRowSweep(synth, img, mode.width, row + 1, 'G', chSec, out);
      synth.tone(FREQ_BLACK, sep, out);
      scanRowSweep(synth, img, mode.width, row + 1, 'B', chSec, out);
    }
  }
}

function encodeMartinLike(synth: PhaseSynth, img: Uint8ClampedArray, mode: SSTVMode, out: number[]): void {
  // Positive timing, sequential: sync -> porch -> ch1 -> sep -> ch2 -> sep -> ch3
  const chSec = mode.colorScanTime / 1000;
  const sep = mode.separatorPulses![0] / 1000;
  const order = mode.colorOrder; // ['G','B','R'] for Martin, ['R','G','B'] for Wraase
  for (let row = 0; row < mode.height; row++) {
    synth.tone(FREQ_SYNC, mode.syncPulse / 1000, out);
    synth.tone(FREQ_BLACK, mode.syncPorch / 1000, out);
    scanRowSweep(synth, img, mode.width, row, order[0], chSec, out);
    synth.tone(FREQ_BLACK, sep, out);
    scanRowSweep(synth, img, mode.width, row, order[1], chSec, out);
    synth.tone(FREQ_BLACK, sep, out);
    scanRowSweep(synth, img, mode.width, row, order[2], chSec, out);
  }
}

const SCOTTIE_MODES = new Set(['SCOTTIE_S1', 'SCOTTIE_S2', 'SCOTTIE_DX']);
const MARTIN_LIKE_MODES = new Set(['MARTIN_M1', 'MARTIN_M2', 'WRAASE_SC2_180']);
const PD_MODES = new Set(['PD50', 'PD90', 'PD120', 'PD160', 'PD180', 'PD240', 'PD290']);

// VIS header: leader(0.3) + break(0.01) + leader(0.3) + start(0.03) + 8 data/parity bits(0.03 each) + stop(0.03)
const VIS_HEADER_SECONDS = 0.3 + 0.01 + 0.3 + 0.03 + 8 * 0.03 + 0.03;

/** Exact transmit duration for a mode, without running the (expensive)
 *  synthesis — used for UI display. PD modes pack 2 image rows into each
 *  transmitted scan line (Y-even + shared chroma + Y-odd), so scanTime there
 *  covers height/2 lines, not height. */
export function estimateEncodedSeconds(modeName: keyof typeof SSTV_MODES): number {
  const mode = SSTV_MODES[modeName];
  const transmittedLines = PD_MODES.has(modeName) ? mode.height / 2 : mode.height;
  return VIS_HEADER_SECONDS + (mode.scanTime * transmittedLines) / 1000;
}

/**
 * Encode an RGBA image into an SSTV FM audio waveform (mono, [-1, 1] Float32).
 * `img` must already be exactly mode.width x mode.height (see resizeImageData).
 */
export function encodeSSTV(img: Uint8ClampedArray, modeName: keyof typeof SSTV_MODES, sampleRate: number, onProgress?: (p: EncodeProgress) => void): Float32Array {
  const mode = SSTV_MODES[modeName];
  const synth = new PhaseSynth(sampleRate);
  const out: number[] = [];

  // Leader tone + VIS header (standard across all modes)
  encodeVIS(synth, mode.visCode, out);

  if (modeName === 'ROBOT36') {
    encodeRobot36(synth, img, mode, out);
  } else if (modeName === 'ROBOT72') {
    encodeRobot72(synth, img, mode, out);
  } else if (SCOTTIE_MODES.has(modeName)) {
    encodeScottie(synth, img, mode, out);
  } else if (MARTIN_LIKE_MODES.has(modeName)) {
    encodeMartinLike(synth, img, mode, out);
  } else if (PD_MODES.has(modeName)) {
    encodePD(synth, img, mode, out);
  } else {
    throw new Error(`Unsupported SSTV encode mode: ${modeName}`);
  }

  onProgress?.({ line: mode.height, totalLines: mode.height });

  return Float32Array.from(out);
}
