// Port of src/components/MFSKDecoder.tsx (Next.js app) — implements
// DecoderControls via a caller-owned mutable handle (props.handle.current),
// filled in via onMount, instead of forwardRef+useImperativeHandle.
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show, type JSX } from 'solid-js'
import type { DecoderControls, DecoderProps } from '../lib/decoderControls'
import { fmtAbsHz } from '$decoder-lib/formatFreq'
import AudioAnalysisPanel from './AudioAnalysisPanel'
import NumberField from './NumberField'
import { createMFSKProcessor, type MFSKSymbol, type MFSKWord } from '../lib/mfsk/processor'
import { MFSKChannel, MFSKDecoderOptions, DEFAULT_DECODER_OPTIONS } from '$decoder-lib/mfsk/decoder'
import { bitsToBaudotCode, decodeBaudotCodePoints } from '$decoder-lib/mfsk/baudot'
import { decodeCCIR476FromBits } from '$decoder-lib/mfsk/ccir476'
import { decodeMFSKVaricode } from '$decoder-lib/mfsk/varicode'
import { decodeMFSKWithFECIncremental, makeFECCursor, type FECCursor } from '$decoder-lib/mfsk/fec'
import { loadNumberArray, saveNumberArray, loadNumber, saveNumber, loadBoolean, saveBoolean } from '$decoder-lib/storage'

type Encoding = 'ascii' | 'baudot' | 'varicode' | 'ccir476'

const DEFAULT_PANEL_WEIGHTS = [1, 1.4, 0.65]
const LS_PANEL_WEIGHTS = 'mfsk_panel_weights'
const LS_SHOW_GRID = 'mfsk_show_grid'
const LS_GRID_SIZE = 'mfsk_grid_size'
const LS_SHOW_WORD_MARKERS = 'mfsk_show_word_markers'
const LS_SHOW_BIT_MARKERS = 'mfsk_show_bit_markers'
const LS_SHOW_FRAME_MARKERS = 'mfsk_show_frame_markers'

const CANVAS_H = 200
const AXIS_H = 25
const PLOT_H = CANVAS_H - AXIS_H
const MAX_TXT = 20_000 // max chars kept in the decoded text box

// Single default tone color — user can change per-tone
const DEFAULT_TONE_COLOR = '#79c0ff'

function makeId() {
  return Math.random().toString(36).slice(2, 9)
}

const DEFAULT_CHANNELS: MFSKChannel[] = [
  { id: makeId(), freq: 800, color: DEFAULT_TONE_COLOR, label: 'T0' },
  { id: makeId(), freq: 1000, color: DEFAULT_TONE_COLOR, label: 'T1' },
  { id: makeId(), freq: 1200, color: DEFAULT_TONE_COLOR, label: 'T2' },
  { id: makeId(), freq: 1400, color: DEFAULT_TONE_COLOR, label: 'T3' },
]

// ── Presets ───────────────────────────────────────────────────────────────────

type FECMode = 'none' | 'k7r12'

interface PresetDef {
  label: string
  baudRate: number
  channelBw: number
  channels: Omit<MFSKChannel, 'id'>[]
  decoderOpts: Partial<MFSKDecoderOptions>
  encoding: Encoding
  fec: FECMode
  interleaverDepth: number
  frameWidth: number
  wordWidth: number
  startBits: number
  stopBits: number
  candidateOffsets?: number[]
}

function makeTones(n: number, baseHz: number, spacingHz: number): Omit<MFSKChannel, 'id'>[] {
  return Array.from({ length: n }, (_, i) => ({
    freq: baseHz + i * spacingHz,
    color: DEFAULT_TONE_COLOR,
    label: `T${i}`,
  }))
}

const RTTY_OPTS = { bitOrder: 'lsb' as const, oversampleFactor: 2, syncMode: 'start-bit' as const, charBits: 5, stopBitSymbols: 1.5, reverseShift: false }
const RTTY_FRAME = { encoding: 'baudot' as const, fec: 'none' as const, interleaverDepth: 0, frameWidth: 75, wordWidth: 7.5, startBits: 1, stopBits: 1.5 }
const MFSK_OPTS = { bitOrder: 'msb' as const, oversampleFactor: 1, syncMode: 'free' as const, charBits: 8, stopBitSymbols: 1, useGrayCode: true }

const PRESETS: Record<string, PresetDef> = {
  // ── RTTY ──────────────────────────────────────────────────────────────────
  'rtty-50-170': {
    label: 'RTTY 50 Bd — 170 Hz shift', baudRate: 50, channelBw: 120,
    channels: [{ freq: 1275, color: DEFAULT_TONE_COLOR, label: 'Mk' }, { freq: 1445, color: DEFAULT_TONE_COLOR, label: 'Sp' }],
    decoderOpts: RTTY_OPTS, ...RTTY_FRAME,
  },
  'rtty-45-170': {
    label: 'RTTY 45.45 Bd — 170 Hz shift', baudRate: 45.45, channelBw: 120,
    channels: [{ freq: 1275, color: DEFAULT_TONE_COLOR, label: 'Mk' }, { freq: 1445, color: DEFAULT_TONE_COLOR, label: 'Sp' }],
    decoderOpts: RTTY_OPTS, ...RTTY_FRAME,
  },
  'rtty-75-170': {
    label: 'RTTY 75 Bd — 170 Hz shift', baudRate: 75, channelBw: 120,
    channels: [{ freq: 1275, color: DEFAULT_TONE_COLOR, label: 'Mk' }, { freq: 1445, color: DEFAULT_TONE_COLOR, label: 'Sp' }],
    decoderOpts: RTTY_OPTS, ...RTTY_FRAME,
  },
  'rtty-50-450': {
    label: 'RTTY 50 Bd — 450 Hz shift', baudRate: 50, channelBw: 180,
    channels: [{ freq: 1275, color: DEFAULT_TONE_COLOR, label: 'Mk' }, { freq: 1725, color: DEFAULT_TONE_COLOR, label: 'Sp' }],
    decoderOpts: RTTY_OPTS, ...RTTY_FRAME,
  },
  'rtty-50-850': {
    label: 'RTTY 50 Bd — 850 Hz shift', baudRate: 50, channelBw: 350,
    channels: [{ freq: 1020, color: DEFAULT_TONE_COLOR, label: 'Mk' }, { freq: 1870, color: DEFAULT_TONE_COLOR, label: 'Sp' }],
    decoderOpts: RTTY_OPTS, ...RTTY_FRAME,
  },
  'rtty-75-850': {
    label: 'RTTY 75 Bd — 850 Hz shift', baudRate: 75, channelBw: 350,
    channels: [{ freq: 1020, color: DEFAULT_TONE_COLOR, label: 'Mk' }, { freq: 1870, color: DEFAULT_TONE_COLOR, label: 'Sp' }],
    decoderOpts: RTTY_OPTS, ...RTTY_FRAME,
  },

  // ── 2-tone FSK utility catches ────────────────────────────────────────────
  // Famous non-amateur 2-tone FSK signals with correct on-air parameters.
  navtex: {
    label: 'NAVTEX / SITOR-B — 100 Bd, 170 Hz (CCIR476)', baudRate: 100, channelBw: 120,
    channels: [{ freq: 1415, color: DEFAULT_TONE_COLOR, label: 'Mk' }, { freq: 1585, color: DEFAULT_TONE_COLOR, label: 'Sp' }],
    decoderOpts: { bitOrder: 'lsb', oversampleFactor: 2, syncMode: 'free', charBits: 8, stopBitSymbols: 1 },
    encoding: 'ccir476', fec: 'none', interleaverDepth: 0,
    // 7-bit grid: one CCIR476 code word per row — the 4-mark/3-space constant
    // ratio is easy to spot visually when tuned correctly.
    frameWidth: 7, wordWidth: 7, startBits: 0, stopBits: 0,
  },
  // Bell 202's HDLC/NRZI framing isn't implemented, so it stays a raw-bit
  // analysis preset; tones and baud are correct for identification.
  afsk1200: {
    label: 'Bell 202 / AFSK 1200 — packet, APRS (raw bits)', baudRate: 1200, channelBw: 600,
    channels: [{ freq: 1200, color: DEFAULT_TONE_COLOR, label: 'Mk' }, { freq: 2200, color: DEFAULT_TONE_COLOR, label: 'Sp' }],
    decoderOpts: { bitOrder: 'lsb', oversampleFactor: 2, syncMode: 'free', charBits: 8, stopBitSymbols: 1 },
    encoding: 'ascii', fec: 'none', interleaverDepth: 0,
    frameWidth: 8, wordWidth: 8, startBits: 0, stopBits: 0,
  },

  // ── fldigi MFSK (varicode, K=7 R=1/2 FEC) ────────────────────────────────
  // Parameters verified against fldigi-4.2.10 src/mfsk/mfsk.cxx.
  // Mode name = baud rate.  basefreq = sampleRate * basetone / symlen.
  // basetone always equals numtones, so basefreq = numtones * (sampleRate/symlen) = numtones * spacing.
  // MFSK4/8:      32 tones, 5 bps, depth=5.
  // MFSK16/32/64/128: 16 tones, 4 bps, depth=10/10/10/20.
  // basefreq = sampleRate * basetone / symlen = 1000 Hz for all fldigi modes.
  // MFSK4/8: basetone=numtones=32.  MFSK16: basetone=64, numtones=16.
  // MFSK32: basetone=32, numtones=16.  MFSK64: basetone=16, numtones=16.
  // MFSK128: basetone=8, numtones=16.
  mfsk4: {
    label: 'fldigi MFSK4 — 32 tones / 3.9 Bd',
    baudRate: 3.906, channelBw: 4,
    channels: makeTones(32, 1500 - 15.5 * 3.906, 3.906), // center 1500 Hz
    decoderOpts: MFSK_OPTS,
    encoding: 'varicode', fec: 'k7r12', interleaverDepth: 5,
    frameWidth: 48, wordWidth: 0, startBits: 0, stopBits: 0,
    candidateOffsets: [-7.812, -3.906, 0, 3.906, 7.812],
  },
  mfsk8: {
    label: 'fldigi MFSK8 — 32 tones / 7.8 Bd',
    baudRate: 7.813, channelBw: 8,
    channels: makeTones(32, 1500 - 15.5 * 7.813, 7.813), // center 1500 Hz
    decoderOpts: MFSK_OPTS,
    encoding: 'varicode', fec: 'k7r12', interleaverDepth: 5,
    frameWidth: 48, wordWidth: 0, startBits: 0, stopBits: 0,
    candidateOffsets: [-15.625, -7.813, 0, 7.813, 15.625],
  },
  mfsk16: {
    label: 'fldigi MFSK16 — 16 tones / 15.6 Bd',
    baudRate: 15.625, channelBw: 16,
    channels: makeTones(16, 1500 - 7.5 * 15.625, 15.625), // center 1500 Hz
    decoderOpts: MFSK_OPTS,
    encoding: 'varicode', fec: 'k7r12', interleaverDepth: 10,
    frameWidth: 64, wordWidth: 0, startBits: 0, stopBits: 0,
    candidateOffsets: [-31.25, -15.625, 0, 15.625, 31.25],
  },
  mfsk32: {
    label: 'fldigi MFSK32 — 16 tones / 31.25 Bd',
    baudRate: 31.25, channelBw: 32,
    channels: makeTones(16, 1500 - 7.5 * 31.25, 31.25), // center 1500 Hz
    decoderOpts: MFSK_OPTS,
    encoding: 'varicode', fec: 'k7r12', interleaverDepth: 10,
    frameWidth: 64, wordWidth: 0, startBits: 0, stopBits: 0,
    candidateOffsets: [-62.5, -31.25, 0, 31.25, 62.5],
  },
  mfsk64: {
    // fldigi MFSK64: symlen=128, basetone=16, numtones=16, bps=4, depth=10
    // spacing = 62.5 Hz, center = 1500 Hz → base = 1500 - 7.5*62.5 = 1031.25 Hz
    label: 'fldigi MFSK64 — 16 tones / 62.5 Bd',
    baudRate: 62.5, channelBw: 63,
    channels: makeTones(16, 1500 - 7.5 * 62.5, 62.5), // center 1500 Hz
    decoderOpts: MFSK_OPTS,
    encoding: 'varicode', fec: 'k7r12', interleaverDepth: 10,
    frameWidth: 96, wordWidth: 0, startBits: 0, stopBits: 0,
    candidateOffsets: [-125, -62.5, 0, 62.5, 125],
  },
  mfsk128: {
    // fldigi MFSK128: symlen=64, basetone=8, numtones=16, bps=4, depth=20
    // spacing = 125 Hz, center = 1500 Hz → base = 1500 - 7.5*125 = 562.5 Hz
    label: 'fldigi MFSK128 — 16 tones / 125 Bd',
    baudRate: 125, channelBw: 125,
    channels: makeTones(16, 1500 - 7.5 * 125, 125), // center 1500 Hz
    decoderOpts: MFSK_OPTS,
    encoding: 'varicode', fec: 'k7r12', interleaverDepth: 20,
    frameWidth: 128, wordWidth: 0, startBits: 0, stopBits: 0,
    candidateOffsets: [-250, -125, 0, 125, 250],
  },

  // ── Classic MFSK (sigidwiki samples — mode number = tone count) ───────────
  // These are the original IZ8BLY / ZL1BPU MFSK modes where MFSK-N means N tones.
  // Carrier = 1500 Hz. spacing = 8000/(symlen at 8kHz).
  // MFSK-4:   4 tones, 31.25 Hz spacing, symlen=256 at 8kHz
  // MFSK-8:   8 tones, 15.625 Hz spacing, symlen=512 at 8kHz
  // MFSK-16: 16 tones, 7.8125 Hz spacing, symlen=1024 at 8kHz
  // MFSK-32: 32 tones, 3.90625 Hz spacing, symlen=2048 at 8kHz
  // Note: these use NO FEC (original IZ8BLY varicode only, no Viterbi)
  'classic-mfsk4': {
    label: 'Classic MFSK-4 — 4 tones / 31.25 Bd',
    baudRate: 31.25, channelBw: 32,
    channels: makeTones(4, 1453.125, 31.25),
    decoderOpts: MFSK_OPTS,
    encoding: 'varicode', fec: 'none', interleaverDepth: 0,
    frameWidth: 32, wordWidth: 0, startBits: 0, stopBits: 0,
    candidateOffsets: [-62.5, -31.25, 0, 31.25, 62.5],
  },
  'classic-mfsk8': {
    label: 'Classic MFSK-8 — 8 tones / 15.625 Bd',
    baudRate: 15.625, channelBw: 16,
    channels: makeTones(8, 1445.313, 15.625),
    decoderOpts: MFSK_OPTS,
    encoding: 'varicode', fec: 'none', interleaverDepth: 0,
    frameWidth: 48, wordWidth: 0, startBits: 0, stopBits: 0,
    candidateOffsets: [-31.25, -15.625, 0, 15.625, 31.25],
  },
  'classic-mfsk16': {
    label: 'Classic MFSK-16 — 16 tones / 7.8125 Bd',
    baudRate: 7.8125, channelBw: 8,
    channels: makeTones(16, 1441.406, 7.8125),
    decoderOpts: MFSK_OPTS,
    encoding: 'varicode', fec: 'none', interleaverDepth: 0,
    frameWidth: 48, wordWidth: 0, startBits: 0, stopBits: 0,
    candidateOffsets: [-15.625, -7.8125, 0, 7.8125, 15.625],
  },
  'classic-mfsk32': {
    label: 'Classic MFSK-32 — 32 tones / 3.906 Bd',
    baudRate: 3.90625, channelBw: 4,
    channels: makeTones(32, 1439.453, 3.90625),
    decoderOpts: MFSK_OPTS,
    encoding: 'varicode', fec: 'none', interleaverDepth: 0,
    frameWidth: 64, wordWidth: 0, startBits: 0, stopBits: 0,
    candidateOffsets: [-7.8125, -3.90625, 0, 3.90625, 7.8125],
  },
  // MFSK-11/22/31 are Wavecom proprietary modes — parameters estimated from sample analysis
  // These are observation/identification presets only; FEC is unknown
  'wavecom-mfsk11': {
    label: 'Wavecom MFSK-11 — 11 tones / ~31.25 Bd',
    baudRate: 31.25, channelBw: 35,
    channels: makeTones(11, 1500 - 5 * 31.25, 31.25),
    decoderOpts: MFSK_OPTS,
    encoding: 'varicode', fec: 'none', interleaverDepth: 0,
    frameWidth: 32, wordWidth: 0, startBits: 0, stopBits: 0,
  },
  'wavecom-mfsk22': {
    label: 'Wavecom MFSK-22 — 22 tones / ~15.625 Bd',
    baudRate: 15.625, channelBw: 18,
    channels: makeTones(22, 1500 - 10.5 * 15.625, 15.625),
    decoderOpts: MFSK_OPTS,
    encoding: 'varicode', fec: 'none', interleaverDepth: 0,
    frameWidth: 48, wordWidth: 0, startBits: 0, stopBits: 0,
  },
  'wavecom-mfsk31': {
    label: 'Wavecom MFSK-31 — 31 tones / ~7.8125 Bd',
    baudRate: 7.8125, channelBw: 10,
    channels: makeTones(31, 1500 - 15 * 7.8125, 7.8125),
    decoderOpts: MFSK_OPTS,
    encoding: 'varicode', fec: 'none', interleaverDepth: 0,
    frameWidth: 64, wordWidth: 0, startBits: 0, stopBits: 0,
  },
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function hexToRgb(hex: string): [number, number, number] {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)]
}

function drawAxisLabels(ctx: CanvasRenderingContext2D, w: number, pH: number, minF: number, maxF: number) {
  const span = maxF - minF
  ctx.strokeStyle = '#30363d'
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(0, pH)
  ctx.lineTo(w, pH)
  ctx.stroke()
  // Choose tick step based on span
  const step = span <= 500 ? 50 : span <= 1000 ? 100 : span <= 2000 ? 200 : 500
  const majMult = step * 5
  const medMult = step * 2
  const firstTick = Math.ceil(minF / step) * step
  for (let f = firstTick; f <= maxF; f += step) {
    const x = ((f - minF) / span) * w
    const maj = f % majMult === 0,
      med = !maj && f % medMult === 0
    ctx.strokeStyle = maj ? '#8b949e' : '#30363d'
    ctx.beginPath()
    ctx.moveTo(x, pH)
    ctx.lineTo(x, pH + (maj ? 6 : med ? 4 : 2))
    ctx.stroke()
    if (maj) {
      ctx.fillStyle = '#8b949e'
      ctx.font = '10px monospace'
      ctx.textAlign = 'center'
      ctx.fillText(f >= 1000 ? `${f / 1000}k` : `${f}`, x, pH + 17)
    }
  }
}

function drawSqGrid(
  ctx: CanvasRenderingContext2D, cW: number, pH: number,
  fd: Uint8Array, sql: number, gCols: number, gRows: number,
  channels: MFSKChannel[], minHz: number, maxHz: number, halfBw: number,
) {
  const span = maxHz - minHz
  const cH = pH / gRows
  const cWc = cW / gCols
  const sqlF = sql / 100
  const colCh: (MFSKChannel | null)[] = Array(gCols).fill(null)
  for (let c = 0; c < gCols; c++) {
    const cf = minHz + ((c + 0.5) / gCols) * span
    for (const ch of channels) if (cf >= ch.freq - halfBw && cf <= ch.freq + halfBw) { colCh[c] = ch; break }
  }
  for (let c = 0; c < gCols; c++) {
    const f0 = Math.floor((c / gCols) * fd.length)
    const f1 = Math.min(Math.ceil(((c + 1) / gCols) * fd.length), fd.length)
    let pk = 0
    for (let f = f0; f < f1; f++) if (fd[f] > pk) pk = fd[f]
    const aF = pk / 255
    const [lr, lg, lb] = colCh[c] ? hexToRgb(colCh[c]!.color) : [227, 179, 65]
    for (let r = 0; r < gRows; r++) {
      const x = c * cWc, y = r * cH, rb = 1 - (r + 1) / gRows
      if (aF > rb) {
        if (rb >= sqlF || sql === 0) {
          ctx.fillStyle = `rgba(${lr},${lg},${lb},${Math.min(0.92, 0.35 + (aF - rb) * gRows * 0.55)})`
        } else {
          ctx.fillStyle = `rgba(${lr},${lg},${lb},0.12)`
        }
        ctx.fillRect(x + 0.5, y + 0.5, cWc - 1, cH - 1)
      }
    }
  }
  ctx.strokeStyle = 'rgba(48,54,61,.55)'
  ctx.lineWidth = 0.5
  ctx.setLineDash([])
  ctx.beginPath()
  for (let c = 0; c <= gCols; c++) { ctx.moveTo(c * cWc, 0); ctx.lineTo(c * cWc, pH) }
  for (let r = 0; r <= gRows; r++) { ctx.moveTo(0, r * cH); ctx.lineTo(cW, r * cH) }
  ctx.stroke()
  if (sql > 0) {
    const sY = pH * (1 - sqlF)
    ctx.lineWidth = 1.5
    ctx.setLineDash([4, 2])
    ctx.strokeStyle = '#e3b341'
    ctx.beginPath()
    ctx.moveTo(0, sY)
    ctx.lineTo(cW, sY)
    ctx.stroke()
    ctx.setLineDash([])
    ctx.fillStyle = '#e3b341'
    ctx.beginPath()
    ctx.moveTo(0, sY - 5)
    ctx.lineTo(9, sY)
    ctx.lineTo(0, sY + 5)
    ctx.closePath()
    ctx.fill()
    ctx.beginPath()
    ctx.moveTo(cW, sY - 5)
    ctx.lineTo(cW - 9, sY)
    ctx.lineTo(cW, sY + 5)
    ctx.closePath()
    ctx.fill()
    ctx.font = '9px monospace'
    ctx.textAlign = 'left'
    ctx.fillStyle = '#e3b341'
    ctx.fillText(`SQL ${sql}%`, 12, sY > 12 ? sY - 3 : sY + 12)
  }
}

function drawChannelMarker(
  ctx: CanvasRenderingContext2D, cW: number, pH: number,
  freq: number, color: string, label: string, halfBw: number,
  minHz: number, maxHz: number,
) {
  const [r, g, b] = hexToRgb(color)
  const span = maxHz - minHz
  const tX = ((freq - minHz) / span) * cW
  const lo = Math.max(0, ((freq - halfBw - minHz) / span) * cW)
  const hi = Math.min(cW, ((freq + halfBw - minHz) / span) * cW)
  ctx.fillStyle = `rgba(${r},${g},${b},.07)`
  ctx.fillRect(lo, 0, hi - lo, pH)
  ctx.lineWidth = 1
  ctx.setLineDash([2, 4])
  ctx.strokeStyle = `rgba(${r},${g},${b},.30)`
  ctx.beginPath()
  ctx.moveTo(lo, 0)
  ctx.lineTo(lo, pH)
  ctx.stroke()
  ctx.beginPath()
  ctx.moveTo(hi, 0)
  ctx.lineTo(hi, pH)
  ctx.stroke()
  ctx.setLineDash([])
  ctx.lineWidth = 1.5
  ctx.setLineDash([4, 3])
  ctx.strokeStyle = color
  ctx.beginPath()
  ctx.moveTo(tX, 0)
  ctx.lineTo(tX, pH)
  ctx.stroke()
  ctx.setLineDash([])
  ctx.font = '10px monospace'
  ctx.textAlign = 'center'
  ctx.fillStyle = color
  ctx.fillText(label, tX, 14)
}

function drawBitGrid(
  ctx: CanvasRenderingContext2D, cW: number, cH: number,
  syms: MFSKSymbol[], bps: number,
  frameWidth: number, frameHeight: number,
  wordWidth: number, startBits: number, stopBits: number,
  showWord: boolean, showBit: boolean, showFrame: boolean,
  completedRows: number, bufOffset: number,
) {
  ctx.fillStyle = '#0d1117'
  ctx.fillRect(0, 0, cW, cH)
  if (!syms.length || frameWidth <= 0 || bps <= 0 || completedRows <= 0) return
  const cpl = Math.round(frameWidth * bps)
  if (cpl <= 0) return
  const cWc = cW / cpl
  const cHc = Math.max(6, Math.min(20, Math.round(cWc * 1.05)))
  const maxV = Math.floor(cH / cHc)
  const firstRow = Math.max(0, completedRows - maxV)
  const wSz = wordWidth > 0 ? Math.round(wordWidth * bps) : 0
  const stSz = Math.round(startBits * bps), spSz = Math.round(stopBits * bps)

  for (let ri = firstRow; ri < completedRows; ri++) {
    const dr = ri - firstRow
    const ly = dr * cHc
    if (ly > cH) break
    if (showFrame && frameHeight > 0 && ri > 0 && ri % frameHeight === 0) {
      ctx.fillStyle = 'rgba(140,160,200,.22)'
      ctx.fillRect(0, ly - 1, cW, 2)
    }
    const rowStartSym = Math.round(ri * frameWidth)
    const bufBitStart = (rowStartSym - bufOffset) * bps
    for (let col = 0; col < cpl; col++) {
      const bufBit = bufBitStart + col
      if (bufBit < 0 || bufBit >= syms.length * bps) continue
      const si = Math.floor(bufBit / bps), bi = bufBit % bps
      const sym = syms[si]
      if (!sym) continue
      const bit = sym.bits[bi] ?? false
      const x = col * cWc, y = ly
      let isS = false, isSt = false
      if (wSz > 0 && showBit) {
        const p = (rowStartSym * bps + col) % wSz
        isS = p < stSz
        isSt = spSz > 0 && p >= wSz - spSz
      }
      if (isS) { ctx.fillStyle = 'rgba(86,211,100,.09)'; ctx.fillRect(x, y, cWc, cHc) }
      else if (isSt) { ctx.fillStyle = 'rgba(255,123,114,.09)'; ctx.fillRect(x, y, cWc, cHc) }
      if (!sym.squelched && bit) {
        if (isS) ctx.fillStyle = 'rgba(86,211,100,.90)'
        else if (isSt) ctx.fillStyle = 'rgba(255,123,114,.90)'
        else { const [r, g, b] = hexToRgb(sym.winnerChannel?.color ?? '#e3b341'); ctx.fillStyle = `rgba(${r},${g},${b},.88)` }
        ctx.fillRect(x + 0.5, y + 0.5, cWc - 1, cHc - 1)
      } else if (!sym.squelched) {
        ctx.fillStyle = '#151c28'
        ctx.fillRect(x + 0.5, y + 0.5, cWc - 1, cHc - 1)
      }
    }
    if (showWord && wSz > 0) {
      const m = (rowStartSym * bps) % wSz
      const fb = m === 0 ? 0 : wSz - m
      ctx.strokeStyle = 'rgba(200,210,230,.35)'
      ctx.lineWidth = 1
      ctx.setLineDash([3, 2])
      for (let b = fb; b < cpl; b += wSz) {
        const x = b * cWc
        ctx.beginPath()
        ctx.moveTo(x, ly)
        ctx.lineTo(x, ly + cHc)
        ctx.stroke()
      }
      ctx.setLineDash([])
    }
    if (bps > 1) {
      ctx.strokeStyle = 'rgba(40,48,60,.7)'
      ctx.lineWidth = 0.5
      for (let s = 1; s < frameWidth; s++) {
        const x = Math.round(s * bps) * cWc
        ctx.beginPath()
        ctx.moveTo(x, ly)
        ctx.lineTo(x, ly + cHc)
        ctx.stroke()
      }
    }
  }
  ctx.strokeStyle = 'rgba(30,36,45,.9)'
  ctx.lineWidth = 0.5
  for (let lr = 0; lr <= maxV; lr++) {
    const y = lr * cHc
    ctx.beginPath()
    ctx.moveTo(0, y)
    ctx.lineTo(cW, y)
    ctx.stroke()
  }
}

/** Decode word-structured symbols into ASCII text (free mode). */
function decodeAsciiFromSymbols(
  syms: MFSKSymbol[], wordWidth: number, startBits: number, stopBits: number, bps: number,
): string {
  if (wordWidth <= 0 || wordWidth <= startBits + stopBits) return ''
  const chars: string[] = []
  let acc: boolean[] = []
  const nWords = Math.floor(syms.length / wordWidth)
  for (let w = 0; w < nWords; w++) {
    let ok = true
    const wbits: boolean[] = []
    for (let s = startBits; s < wordWidth - stopBits; s++) {
      const sym = syms[w * wordWidth + s]
      if (!sym || sym.squelched) { ok = false; break }
      for (let b = 0; b < bps; b++) wbits.push(sym.bits[b] ?? false)
    }
    if (!ok) { acc = []; continue }
    acc.push(...wbits)
    while (acc.length >= 8) {
      let byte = 0
      for (let b = 0; b < 8; b++) byte = (byte << 1) | (acc[b] ? 1 : 0)
      acc = acc.slice(8)
      if (byte >= 32 && byte < 127) chars.push(String.fromCharCode(byte))
      else if (byte === 10 || byte === 13) chars.push('\n')
    }
  }
  return chars.join('')
}

/** Decode framed MFSKWords using ITA2 Baudot (start-bit sync mode). */
function decodeBaudotFromWords(words: MFSKWord[], lsbFirst: boolean): string {
  const codes = words
    .filter((w) => !w.squelched && w.validStop)
    .map((w) => bitsToBaudotCode(w.bits, lsbFirst))
  return decodeBaudotCodePoints(codes)
}

// ── Toggle ────────────────────────────────────────────────────────────────────

function Toggle(props: { checked: boolean; onChange: () => void }) {
  return (
    <button
      role="switch"
      aria-checked={props.checked}
      onClick={props.onChange}
      class={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors focus:outline-none ${
        props.checked ? 'border-[#2ea043] bg-[#238636]' : 'border-[#30363d] bg-[#21262d]'
      }`}
    >
      <span
        class={`inline-block h-4 w-4 transform rounded-full bg-white shadow-sm transition-transform ${
          props.checked ? 'translate-x-4' : 'translate-x-0.5'
        }`}
      />
    </button>
  )
}

// ── Small segmented buttons ────────────────────────────────────────────────────

function SegBtn<T extends string | number>(props: {
  options: { label: string; value: T }[]
  value: T
  onChange: (v: T) => void
}) {
  return (
    <div class="flex overflow-hidden rounded border border-[#30363d]">
      <For each={props.options}>
        {(o) => (
          <button
            onClick={() => props.onChange(o.value)}
            class={`px-2 py-0.5 text-xs transition-colors ${
              o.value === props.value ? 'bg-[#238636] text-white' : 'bg-[#0d1117] text-[#8b949e] hover:text-[#c9d1d9]'
            }`}
          >
            {o.label}
          </button>
        )}
      </For>
    </div>
  )
}

// ── Tone row (collapsed / expanded) ──────────────────────────────────────────

function ToneRow(props: {
  ch: MFSKChannel
  index: number
  total: number
  maxHz: number
  vfoFrequency?: number
  onRemove: () => void
  onFreqChange: (f: number) => void
  onColorChange: (c: string) => void
  pwrRef: (el: HTMLDivElement | null) => void
}) {
  const [expanded, setExpanded] = createSignal(false)

  return (
    <div class="rounded border border-[#30363d]" style={{ 'border-left-color': props.ch.color, 'border-left-width': '3px' }}>
      {/* Collapsed row */}
      <div class="flex items-center gap-1.5 rounded bg-[#0d1117] px-2 py-1">
        {/* expand toggle */}
        <button onClick={() => setExpanded((v) => !v)} class="w-3 shrink-0 text-[#484f58] transition-colors hover:text-[#8b949e]">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class={`h-3 w-3 transition-transform ${expanded() ? 'rotate-90' : ''}`}>
            <path
              fill-rule="evenodd"
              d="M7.293 4.293a1 1 0 011.414 0L13 8.586a1 1 0 010 1.414l-4.293 4.293a1 1 0 01-1.414-1.414L10.586 10 7.293 6.707a1 1 0 010-1.414z"
              clip-rule="evenodd"
            />
          </svg>
        </button>
        {/* label */}
        <span class="w-7 shrink-0 font-mono text-[10px]" style={{ color: props.ch.color }}>
          {props.ch.label}
        </span>
        {/* freq inline */}
        <span class="min-w-0 flex-1 truncate font-mono text-[10px] text-[#8b949e]">
          {props.vfoFrequency ? `${fmtAbsHz(props.vfoFrequency + props.ch.freq)} Hz` : `${props.ch.freq} Hz`}
        </span>
        {/* power bar */}
        <div class="h-1 w-12 shrink-0 overflow-hidden rounded-full bg-[#21262d]">
          <div ref={props.pwrRef} class="h-full rounded-full" style={{ width: '0%', 'background-color': props.ch.color }} />
        </div>
        {/* remove */}
        <button
          onClick={props.onRemove}
          disabled={props.total <= 1}
          class="shrink-0 text-[#484f58] transition-colors hover:text-[#f85149] disabled:opacity-20"
        >
          <svg xmlns="http://www.w3.org/2000/svg" class="h-3 w-3" viewBox="0 0 20 20" fill="currentColor">
            <path
              fill-rule="evenodd"
              d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
              clip-rule="evenodd"
            />
          </svg>
        </button>
      </div>

      {/* Expanded detail */}
      <Show when={expanded()}>
        <div class="space-y-1.5 border-t border-[#1c2128] bg-[#0d1117] px-2 pt-1 pb-2">
          {/* Color + freq */}
          <div class="flex items-center gap-2">
            <label class="w-8 shrink-0 text-[10px] text-[#484f58]">Color</label>
            <input
              type="color"
              value={props.ch.color}
              onInput={(e) => props.onColorChange(e.currentTarget.value)}
              class="h-5 w-6 shrink-0 cursor-pointer rounded border-0 bg-transparent"
            />
            <span class="font-mono text-[10px]" style={{ color: props.ch.color }}>
              {props.ch.color}
            </span>
          </div>
          <div class="flex items-center gap-2">
            <label class="w-8 shrink-0 text-[10px] text-[#484f58]">Freq</label>
            {/* Shared NumberField: commits every valid keystroke and its ▲▼
                step buttons apply immediately — the old number input only
                committed on blur/Enter, so the native spinner arrows appeared
                to do nothing. */}
            <Show
              when={props.vfoFrequency}
              fallback={
                <NumberField
                  value={props.ch.freq}
                  min={50}
                  max={props.maxHz}
                  step={5}
                  onCommit={(f) => props.onFreqChange(Math.round(f))}
                  class="min-w-0 flex-1 rounded border border-[#30363d] bg-[#161b22] px-1.5 py-0.5 font-mono text-[10px] focus:border-[#2ea043] focus:outline-none"
                  style={{ color: props.ch.color }}
                />
              }
            >
              <span
                class="min-w-0 flex-1 rounded border border-[#30363d] bg-[#161b22] px-1.5 py-0.5 font-mono text-[10px]"
                style={{ color: props.ch.color }}
              >
                {fmtAbsHz(props.vfoFrequency! + props.ch.freq)}
              </span>
            </Show>
            <span class="shrink-0 text-[10px] text-[#484f58]">Hz</span>
          </div>
          <input
            type="range"
            min={50}
            max={props.maxHz}
            step={5}
            value={props.ch.freq}
            onInput={(e) => props.onFreqChange(parseInt(e.currentTarget.value))}
            class="w-full"
            style={{ 'accent-color': props.ch.color }}
          />
        </div>
      </Show>
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export default function MFSKDecoder(props: DecoderProps): JSX.Element {
  // ── Core params ───────────────────────────────────────────────────────────
  const [channels, setChannels] = createSignal<MFSKChannel[]>(DEFAULT_CHANNELS)
  const [baudRate, setBaudRate] = createSignal(31.25)
  const [squelch, setSquelch] = createSignal(0)
  const [channelBw, setChannelBw] = createSignal(80)
  const [gridSize, setGridSize] = createSignal(loadNumber(LS_GRID_SIZE, 48))
  const [showGrid, setShowGrid] = createSignal(loadBoolean(LS_SHOW_GRID, true))
  createEffect(() => saveNumber(LS_GRID_SIZE, gridSize()))
  createEffect(() => saveBoolean(LS_SHOW_GRID, showGrid()))

  // ── Decoder options ───────────────────────────────────────────────────────
  const [decoderOpts, setDecoderOpts] = createSignal<Partial<MFSKDecoderOptions>>({
    ...DEFAULT_DECODER_OPTIONS,
  })
  const [encoding, setEncoding] = createSignal<Encoding>('ascii')
  const [fec, setFec] = createSignal<FECMode>('none')
  const [interleaverDepth, setInterleaverDepth] = createSignal(10)

  // ── Output / frame ────────────────────────────────────────────────────────
  const [frameWidth, setFrameWidth] = createSignal(32)
  const [frameHeight, setFrameHeight] = createSignal(16)
  const [wordWidth, setWordWidth] = createSignal(0)
  const [startBits, setStartBits] = createSignal(1)
  const [stopBits, setStopBits] = createSignal(2)

  const [showWordMarkers, setShowWordMarkers] = createSignal(loadBoolean(LS_SHOW_WORD_MARKERS, true))
  const [showBitMarkers, setShowBitMarkers] = createSignal(loadBoolean(LS_SHOW_BIT_MARKERS, true))
  const [showFrameMarkers, setShowFrameMarkers] = createSignal(loadBoolean(LS_SHOW_FRAME_MARKERS, true))
  createEffect(() => saveBoolean(LS_SHOW_WORD_MARKERS, showWordMarkers()))
  createEffect(() => saveBoolean(LS_SHOW_BIT_MARKERS, showBitMarkers()))
  createEffect(() => saveBoolean(LS_SHOW_FRAME_MARKERS, showFrameMarkers()))

  // ── Multi-stream decode candidates ───────────────────────────────────────
  // Each offset (Hz) relative to the base frequency produces a candidate stream.
  // The selected index is used as the final decoded text.
  const [candidateOffsets, setCandidateOffsets] = createSignal<number[]>([-15.625, -7.8125, 0, 7.8125, 15.625])
  const [selectedCandidate, setSelectedCandidate] = createSignal(2) // center = index 2
  const [candidateTexts, setCandidateTexts] = createSignal<string[]>([])
  // Per-candidate FEC cursors for incremental decode
  let candCursors: FECCursor[] = []

  // ── Active preset label ───────────────────────────────────────────────────
  const [, setActivePresetLabel] = createSignal<string | null>(null)

  // ── Processor ─────────────────────────────────────────────────────────────
  const processor = createMFSKProcessor({ channels, baudRate, squelch, decoderOptions: decoderOpts })

  createEffect(() => {
    // Depend on every param so this re-syncs whenever any of them change,
    // same effect as the original's per-param useEffects collapsed into one.
    void channels()
    void baudRate()
    void squelch()
    void decoderOpts()
    processor.syncParams()
  })

  // ── Canvas refs ───────────────────────────────────────────────────────────
  let bitEl: HTMLCanvasElement | undefined
  let hoverCanvEl: HTMLCanvasElement | undefined
  let hoverPos: { x: number; y: number } | null = null
  let txtEl: HTMLPreElement | undefined
  let txtBuf = '' // rolling text buffer for the decoded output box
  let rafId: number | null = null
  let lastDec = 0
  let lastWrd = 0
  let lastRow = -1

  // Reset FEC cursors and text whenever the symbol buffer is wiped (param change or explicit clear)
  createEffect(() => {
    void processor.state().clearId
    candCursors = []
    txtBuf = ''
    lastDec = 0
    lastWrd = 0
    lastRow = -1
    setCandidateTexts([])
    if (txtEl) txtEl.textContent = ''
  })

  // Panel resize — starts at the default, restored from localStorage.
  let containerEl: HTMLDivElement | undefined
  const [pW, setPW] = createSignal(loadNumberArray(LS_PANEL_WEIGHTS, DEFAULT_PANEL_WEIGHTS))
  let dragState: { handle: number; startX: number; startWeights: number[] } | null = null
  createEffect(() => saveNumberArray(LS_PANEL_WEIGHTS, pW()))

  function startDrag(e: MouseEvent, handle: number) {
    e.preventDefault()
    dragState = { handle, startX: e.clientX, startWeights: [...pW()] }
  }

  onMount(() => {
    const onMove = (e: MouseEvent) => {
      const drag = dragState
      if (!drag || !containerEl) return
      const total = drag.startWeights.reduce((a, b) => a + b, 0)
      const dw = ((e.clientX - drag.startX) / containerEl.offsetWidth) * total
      const w = [...drag.startWeights]
      w[drag.handle] = Math.max(0.15, w[drag.handle] + dw)
      w[drag.handle + 1] = Math.max(0.15, w[drag.handle + 1] - dw)
      setPW(w)
    }
    const onUp = () => { dragState = null }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    onCleanup(() => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    })
  })

  const pwrRefs: Record<string, HTMLDivElement | null> = {}

  function drawBitCanvas(canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const syms = processor.getSymbols()
    const n = Math.max(2, channels().length)
    const bps = Math.max(1, Math.ceil(Math.log2(n)))
    const fw = frameWidth()

    const cpl = Math.round(fw * bps)
    const totalSym = processor.getSymbolCount()
    const bufOffset = Math.max(0, totalSym - syms.length)
    const completedRows = cpl > 0 ? Math.floor((totalSym * bps) / cpl) : 0
    if (completedRows !== lastRow) {
      lastRow = completedRows
      drawBitGrid(
        ctx, canvas.width, canvas.height, syms, bps,
        fw, frameHeight(), wordWidth(), startBits(), stopBits(),
        showWordMarkers(), showBitMarkers(), showFrameMarkers(),
        completedRows, bufOffset,
      )
    }

    // Text decode — incremental, append-only to avoid rewriting in-flight chars
    const opts = decoderOpts()
    const isSyncMode = opts.syncMode === 'start-bit'
    const words = processor.getWords()
    const newSym = processor.getSymbolCount(), newWrd = words.length
    if (newSym !== lastDec || newWrd !== lastWrd) {
      lastDec = newSym
      lastWrd = newWrd
      const enc = encoding()
      const isMFSK = enc === 'varicode' && fec() === 'k7r12'

      if (isMFSK && syms.length > 0) {
        // Incremental FEC decode: only append characters past the Viterbi horizon
        const offsets = candidateOffsets()
        const numTones = channels().length
        const spacing = baudRate() > 0 ? baudRate() : 1
        const gray = opts.useGrayCode ?? false
        void gray
        if (candCursors.length !== offsets.length) {
          candCursors = offsets.map(() => makeFECCursor(bps, interleaverDepth()))
        }
        const texts = offsets.map((off, i) => {
          const shift = Math.round(off / spacing)
          const shiftedSymIds = syms.map((s) => {
            const idx = (((s.symbolIndex + shift) % numTones) + numTones) % numTones
            return idx
          })
          const shiftedPowers = syms.map((s) => {
            if (shift === 0) return s.powers
            const p = s.powers
            const cnt = p.length
            const rotated = new Array(cnt)
            for (let j = 0; j < cnt; j++) rotated[j] = p[((j + shift) % cnt + cnt) % cnt]
            return rotated
          })
          const { newChars, cursor } = decodeMFSKWithFECIncremental(shiftedSymIds, shiftedPowers, candCursors[i], bufOffset)
          candCursors[i] = cursor
          return newChars
        })
        // Append new chars to candidate text state
        const selNew = texts[selectedCandidate()] ?? ''
        if (selNew) {
          txtBuf = (txtBuf + selNew).slice(-MAX_TXT)
          if (txtEl) {
            txtEl.textContent = txtBuf
            txtEl.scrollTop = txtEl.scrollHeight
          }
        }
        if (texts.some((t) => t.length > 0)) {
          setCandidateTexts((prev) =>
            offsets.map((_, i) => {
              const acc = (prev[i] ?? '') + (texts[i] ?? '')
              return acc.slice(-MAX_TXT)
            }),
          )
        }
      } else {
        // Non-FEC paths: full re-decode (no Viterbi in-flight issue)
        let text = ''
        if (enc === 'ccir476') {
          // SITOR-B/NAVTEX: the lib self-aligns bit phase, polarity, and
          // DX/RX slot parity over the whole stream — feed it raw symbol bits.
          const bits: number[] = []
          for (const s of syms) {
            if (s.squelched) continue
            for (let b = 0; b < bps; b++) bits.push(s.bits[b] ? 1 : 0)
          }
          text = decodeCCIR476FromBits(bits)
        } else if (isSyncMode) {
          text = enc === 'baudot'
            ? decodeBaudotFromWords(words, opts.bitOrder === 'lsb')
            : words
                .filter((w) => !w.squelched)
                .map((w) => {
                  let byte = 0
                  if (opts.bitOrder === 'lsb') w.bits.slice(0, 8).forEach((b, i) => { if (b) byte |= 1 << i })
                  else w.bits.slice(0, 8).forEach((b, i) => { if (b) byte |= 1 << (7 - i) })
                  return byte >= 32 && byte < 127 ? String.fromCharCode(byte) : ''
                })
                .join('')
        } else if (enc === 'varicode') {
          const symIds = syms.map((s) => s.symbolIndex)
          text = decodeMFSKVaricode(symIds, bps, opts.useGrayCode ?? false)
        } else {
          text = decodeAsciiFromSymbols(syms, wordWidth(), startBits(), stopBits(), bps)
        }
        // For non-FEC: full text from scratch — truncate to last MAX_TXT chars
        const capped = text.slice(-MAX_TXT)
        if (txtEl) {
          txtEl.textContent = capped
          txtEl.scrollTop = txtEl.scrollHeight
        }
      }
    }
  }

  // ── Hover overlay ─────────────────────────────────────────────────────────

  function drawHoverOverlay(oc: HTMLCanvasElement) {
    const ctx = oc.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, oc.width, oc.height)
    const hover = hoverPos
    if (!hover) return
    const syms = processor.getSymbols()
    if (!syms.length) return

    const n = Math.max(2, channels().length)
    const bps = Math.max(1, Math.ceil(Math.log2(n)))
    const fw = frameWidth()
    const ww = wordWidth()
    const cpl = Math.round(fw * bps)
    if (cpl <= 0) return
    const wSz = ww > 0 ? Math.round(ww * bps) : 0
    if (wSz <= 0) return

    const cW = oc.width, cH = oc.height
    const cWc = cW / cpl
    const cHc = Math.max(6, Math.min(20, Math.round(cWc * 1.05)))
    const maxV = Math.floor(cH / cHc)

    const totalSym = processor.getSymbolCount()
    const completedRows = Math.floor((totalSym * bps) / cpl)
    const firstRow = Math.max(0, completedRows - maxV)
    const bufOffset = Math.max(0, totalSym - syms.length)

    const { x: mx, y: my } = hover
    const hovRow = Math.floor(my / cHc)
    if (hovRow < 0 || hovRow >= completedRows - firstRow) return
    const col = Math.floor(mx / cWc)
    if (col < 0 || col >= cpl) return

    const ri = firstRow + hovRow
    const rowStartBit = Math.round(ri * fw) * bps
    const globalBit = rowStartBit + col
    const wordIdx = Math.floor(globalBit / wSz)
    const wordBitStart = wordIdx * wSz
    const wordBitEnd = wordBitStart + wSz

    ctx.fillStyle = 'rgba(200,210,255,0.14)'
    ctx.strokeStyle = 'rgba(180,195,255,0.55)'
    ctx.lineWidth = 1
    for (let si = firstRow; si < completedRows; si++) {
      const rs = Math.round(si * fw) * bps
      const re = rs + cpl
      const os = Math.max(wordBitStart, rs)
      const oe = Math.min(wordBitEnd, re)
      if (os >= oe) continue
      const dy = (si - firstRow) * cHc
      const x1 = (os - rs) * cWc, x2 = (oe - rs) * cWc
      ctx.fillRect(x1, dy, x2 - x1, cHc)
      ctx.strokeRect(x1 + 0.5, dy + 0.5, x2 - x1 - 1, cHc - 1)
    }

    const stSz = Math.round(startBits() * bps)
    const spSz = Math.round(stopBits() * bps)
    const dStart = wordBitStart + stSz
    const dEnd = wordBitEnd - spSz
    const dataBits: boolean[] = []
    for (let gb = dStart; gb < dEnd; gb++) {
      const buf = gb - bufOffset * bps
      if (buf < 0 || buf >= syms.length * bps) { dataBits.push(false); continue }
      dataBits.push(syms[Math.floor(buf / bps)]?.bits[buf % bps] ?? false)
    }

    const opts = decoderOpts()
    const lsb = opts.bitOrder === 'lsb'
    let decoded = ''
    if (encoding() === 'baudot') {
      const code = bitsToBaudotCode(dataBits, lsb)
      const ch = decodeBaudotCodePoints([code])
      decoded = ch || `[${code}]`
    } else {
      let byte = 0
      dataBits.slice(0, 8).forEach((b, i) => { if (b) byte |= lsb ? 1 << i : 1 << (7 - i) })
      decoded = byte >= 32 && byte < 127 ? String.fromCharCode(byte) : byte === 0 ? 'NUL' : `\\x${byte.toString(16).padStart(2, '0')}`
    }
    const bitStr = dataBits.map((b) => (b ? '1' : '0')).join('')
    const label = `"${decoded}"  ${bitStr}`

    ctx.font = '11px monospace'
    const tw = ctx.measureText(label).width + 14
    const th = 20
    const tx = Math.min(mx + 12, cW - tw - 4)
    const ty = my < th + 8 ? my + 8 : my - th - 4
    ctx.fillStyle = 'rgba(13,17,23,0.93)'
    ctx.strokeStyle = 'rgba(180,195,255,0.35)'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.roundRect(tx, ty, tw, th, 3)
    ctx.fill()
    ctx.stroke()
    ctx.fillStyle = '#c9d1d9'
    ctx.fillText(label, tx + 7, ty + 14)
  }

  // ── Animation loop ────────────────────────────────────────────────────────

  onMount(() => {
    const tick = () => {
      if (bitEl) drawBitCanvas(bitEl)
      if (hoverCanvEl) drawHoverOverlay(hoverCanvEl)
      rafId = requestAnimationFrame(tick)
    }
    rafId = requestAnimationFrame(tick)
    onCleanup(() => {
      if (rafId) cancelAnimationFrame(rafId)
    })
  })

  // ── Channels ──────────────────────────────────────────────────────────────

  function addChannel() {
    const i = channels().length
    const base = channels().length > 0 ? Math.max(...channels().map((c) => c.freq)) + 200 : 800
    setChannels((p) => [...p, { id: makeId(), freq: Math.min(2900, base), color: DEFAULT_TONE_COLOR, label: `T${i}` }])
  }
  function removeChannel(id: string) {
    setChannels((p) => p.filter((c) => c.id !== id).map((c, i) => ({ ...c, label: `T${i}` })))
  }
  function updFreq(id: string, f: number) {
    setChannels((p) => p.map((c) => (c.id === id ? { ...c, freq: f } : c)))
  }
  function updColor(id: string, color: string) {
    setChannels((p) => p.map((c) => (c.id === id ? { ...c, color } : c)))
  }

  // ── Tone-group geometry ───────────────────────────────────────────────────
  // Center = midpoint of the outermost tones; spacing = average gap (exact
  // for evenly spaced sets). Setting the center rigidly shifts the group;
  // setting the spacing re-lays the tones out evenly around the current
  // center, preserving their frequency order.

  const toneCenter = createMemo(() => {
    const fs = channels().map((c) => c.freq)
    if (fs.length === 0) return 0
    return Math.round((Math.min(...fs) + Math.max(...fs)) / 2)
  })
  const toneSpacing = createMemo(() => {
    const fs = channels().map((c) => c.freq)
    if (fs.length < 2) return 0
    return Math.round((Math.max(...fs) - Math.min(...fs)) / (fs.length - 1))
  })
  function applyToneCenter(newCenter: number) {
    const fs = channels().map((c) => c.freq)
    if (fs.length === 0) return
    let delta = Math.round(newCenter) - toneCenter()
    delta = Math.max(50 - Math.min(...fs), Math.min(3000 - Math.max(...fs), delta))
    if (delta !== 0) setChannels((p) => p.map((c) => ({ ...c, freq: c.freq + delta })))
  }
  function applyToneSpacing(spacing: number) {
    const n = channels().length
    if (n < 2) return
    const s = Math.max(1, Math.round(spacing))
    const lo = Math.max(50, Math.round(toneCenter() - ((n - 1) / 2) * s))
    const bySortedIndex = new Map([...channels()].sort((a, b) => a.freq - b.freq).map((c, i) => [c.id, Math.min(3000, lo + i * s)]))
    setChannels((p) => p.map((c) => ({ ...c, freq: bySortedIndex.get(c.id)! })))
  }

  // ── Preset apply ──────────────────────────────────────────────────────────

  function applyPreset(key: string) {
    const p = PRESETS[key]
    if (!p) return
    setBaudRate(p.baudRate)
    setChannelBw(p.channelBw)
    setChannels(p.channels.map((ch) => ({ ...ch, id: makeId() })))
    setDecoderOpts({ ...DEFAULT_DECODER_OPTIONS, ...p.decoderOpts })
    setEncoding(p.encoding)
    setFec(p.fec)
    setInterleaverDepth(p.interleaverDepth > 0 ? p.interleaverDepth : 10)
    setFrameWidth(p.frameWidth)
    setWordWidth(p.wordWidth)
    setStartBits(p.startBits)
    setStopBits(p.stopBits)
    if (p.candidateOffsets) {
      setCandidateOffsets(p.candidateOffsets)
      setSelectedCandidate(Math.floor(p.candidateOffsets.length / 2))
    }
    setCandidateTexts([])
    setActivePresetLabel(p.label)
    processor.clearSymbols()
    lastDec = 0
    lastWrd = 0
    candCursors = []
    txtBuf = ''
  }

  // ── Derived ───────────────────────────────────────────────────────────────

  const bps = createMemo(() => Math.max(1, Math.ceil(Math.log2(Math.max(2, channels().length)))))
  const dataBits = createMemo(() => Math.max(0, wordWidth() - startBits() - stopBits()) * bps())
  const isSyncMode = createMemo(() => decoderOpts().syncMode === 'start-bit')

  function handleReset() {
    processor.clearSymbols()
    lastDec = 0
    lastWrd = 0
    candCursors = []
    txtBuf = ''
    setCandidateTexts([])
    if (txtEl) txtEl.textContent = ''
  }

  function isSupported() {
    return processor.state().isSupported
  }

  onMount(() => {
    if (props.handle) {
      props.handle.current = {
        get isRecording() {
          return processor.state().isRecording
        },
        get isSupported() {
          return isSupported()
        },
        get error() {
          return processor.state().error ?? null
        },
        start: processor.startRecording,
        stop: processor.stopRecording,
        reset: handleReset,
      }
    }
  })

  createEffect(() => {
    const controls: DecoderControls = {
      isRecording: processor.state().isRecording,
      isSupported: isSupported(),
      error: processor.state().error ?? null,
      start: processor.startRecording,
      stop: processor.stopRecording,
      reset: handleReset,
    }
    props.onStateChange?.(controls)
  })

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div class="space-y-3">
      {/* ── Two panels ── */}
      <div ref={containerEl} class="flex flex-col gap-4 lg:flex-row lg:items-stretch lg:gap-0" style={{ height: 'calc(100vh - 260px)', 'min-height': '520px' }}>
        {/* ── Panel 1: Output ── */}
        <div class="flex min-h-[340px] min-w-0 flex-col rounded-lg border border-[#30363d] bg-[#161b22] p-3 sm:p-4 lg:min-h-0" style={{ flex: pW()[0] }}>
          {/* Header + decode badges */}
          <div class="mb-2 shrink-0">
            <div class="mb-1.5 flex items-center justify-between">
              <h2 class="text-sm font-semibold text-[#c9d1d9]">Output</h2>
              <div class="flex items-center gap-2 font-mono text-xs text-[#8b949e]">
                <span class="text-[#79c0ff]">{bps()} bit/symbol</span>
                <span>·</span>
                <span class="text-[#56d364]">{(baudRate() * bps()).toFixed(1)} bit/s</span>
              </div>
            </div>
            {/* Decode option badges */}
            <div class="flex flex-wrap gap-1 text-[10px]">
              <span
                class={`rounded border px-1.5 py-0.5 font-mono ${
                  (decoderOpts().bitOrder ?? 'msb') === 'lsb'
                    ? 'border-[#ffa657]/40 bg-[#ffa657]/10 text-[#ffa657]'
                    : 'border-[#79c0ff]/40 bg-[#79c0ff]/10 text-[#79c0ff]'
                }`}
              >
                {(decoderOpts().bitOrder ?? 'msb').toUpperCase()}-first
              </span>
              <span
                class={`rounded border px-1.5 py-0.5 font-mono ${
                  isSyncMode() ? 'border-[#56d364]/40 bg-[#56d364]/10 text-[#56d364]' : 'border-[#484f58]/60 text-[#484f58]'
                }`}
              >
                {isSyncMode() ? `sync · ${decoderOpts().stopBitSymbols ?? 1} stop` : 'free-run'}
              </span>
              <span
                class={`rounded border px-1.5 py-0.5 font-mono ${
                  encoding() === 'baudot'
                    ? 'border-[#d2a8ff]/40 bg-[#d2a8ff]/10 text-[#d2a8ff]'
                    : encoding() === 'varicode'
                      ? 'border-[#79c0ff]/40 bg-[#79c0ff]/10 text-[#79c0ff]'
                      : encoding() === 'ccir476'
                        ? 'border-[#f0883e]/40 bg-[#f0883e]/10 text-[#f0883e]'
                        : 'border-[#484f58]/60 text-[#484f58]'
                }`}
              >
                {encoding() === 'baudot' ? 'Baudot ITA2' : encoding() === 'varicode' ? 'Varicode' : encoding() === 'ccir476' ? 'CCIR476 SITOR' : 'ASCII'}
              </span>
              <Show when={decoderOpts().useGrayCode ?? false}>
                <span class="rounded border border-[#56d364]/40 bg-[#56d364]/10 px-1.5 py-0.5 font-mono text-[#56d364]">Gray</span>
              </Show>
              <Show when={(decoderOpts().oversampleFactor ?? 1) > 1}>
                <span class="rounded border border-[#e3b341]/40 bg-[#e3b341]/10 px-1.5 py-0.5 font-mono text-[#e3b341]">{decoderOpts().oversampleFactor}× OVS</span>
              </Show>
              <Show when={isSyncMode()}>
                <span class="rounded border border-[#8b949e]/40 bg-[#8b949e]/10 px-1.5 py-0.5 font-mono text-[#8b949e]">
                  {(decoderOpts().reverseShift ?? false) ? 'LSB' : 'USB'}
                </span>
              </Show>
              <Show when={fec() === 'k7r12'}>
                <span class="rounded border border-[#ffa657]/40 bg-[#ffa657]/10 px-1.5 py-0.5 font-mono text-[#ffa657]">FEC K7R½</span>
              </Show>
            </div>
          </div>

          {/* Frame + word controls */}
          <div class="mb-1.5 shrink-0 space-y-1.5">
            <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[#8b949e]">
              <label class="flex items-center gap-1.5">
                Row width
                <NumberField
                  value={frameWidth()}
                  parse={(raw) => {
                    const v = parseFloat(raw)
                    if (!Number.isFinite(v) || v <= 0) return null
                    const step = wordWidth() > 0 ? wordWidth() : 1
                    return Math.min(512, Math.max(step, Math.round(v / step) * step))
                  }}
                  onCommit={setFrameWidth}
                  class="w-14 rounded border border-[#30363d] bg-[#0d1117] px-1.5 py-0.5 font-mono text-[#c9d1d9] focus:border-[#2ea043] focus:outline-none"
                />
                cols
              </label>
              <label class="flex items-center gap-1.5">
                Frame
                <NumberField
                  value={frameHeight()}
                  min={2}
                  max={128}
                  onCommit={setFrameHeight}
                  class="w-12 rounded border border-[#30363d] bg-[#0d1117] px-1.5 py-0.5 font-mono text-[#c9d1d9] focus:border-[#2ea043] focus:outline-none"
                />
                rows
              </label>
              <span class="text-[10px] text-[#484f58]">= {frameWidth() * frameHeight()} cols/frame</span>
            </div>
            <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
              <label class="flex items-center gap-1.5 text-[#8b949e]">
                Word
                <NumberField
                  value={wordWidth()}
                  min={2}
                  max={64}
                  onCommit={setWordWidth}
                  class="w-20 rounded border border-[#30363d] bg-[#0d1117] px-2 py-0.5 font-mono text-[#c9d1d9] focus:border-[#2ea043] focus:outline-none"
                />
                cols
              </label>
              <label class={`flex items-center gap-1.5 ${isSyncMode() ? 'text-[#39d353]' : 'text-[#56d364]'}`}>
                Start
                <NumberField
                  value={startBits()}
                  min={0}
                  max={8}
                  onCommit={setStartBits}
                  class={`w-16 rounded border px-2 py-0.5 font-mono focus:outline-none ${
                    isSyncMode()
                      ? 'border-[#39d353] text-[#39d353] shadow-[0_0_0_1px_rgba(57,211,83,0.25)] focus:border-[#39d353]'
                      : 'border-[#30363d] text-[#56d364] focus:border-[#56d364]'
                  }`}
                />
                <Show when={isSyncMode()}>
                  <span class="h-2 w-2 shrink-0 animate-pulse rounded-full bg-[#39d353]" />
                </Show>
              </label>
              <label class="flex items-center gap-1.5 text-[#ff7b72]">
                Stop
                <NumberField
                  value={stopBits()}
                  min={0}
                  max={8}
                  onCommit={setStopBits}
                  class="w-16 rounded border border-[#30363d] bg-[#0d1117] px-2 py-0.5 font-mono text-[#ff7b72] focus:border-[#ff7b72] focus:outline-none"
                />
              </label>
              <span class="text-[10px] text-[#484f58]">{dataBits()} data bits</span>
            </div>
            <Show when={wordWidth() > 0}>
              <div class="flex h-5 overflow-hidden rounded border border-[#30363d]/60 font-mono text-[9px]">
                <Show when={startBits() > 0}>
                  <div
                    class={`flex shrink-0 items-center justify-center border-r border-[#30363d]/40 ${
                      isSyncMode() ? 'bg-[#39d353]/25 text-[#39d353]' : 'bg-[#56d364]/15 text-[#56d364]'
                    }`}
                    style={{ width: `${(startBits() / wordWidth()) * 100}%`, 'min-width': '2px' }}
                  >
                    <Show when={isSyncMode()}>
                      <span class="mr-0.5 text-[8px]">●</span>
                    </Show>
                    {startBits() > 1 ? `St×${startBits()}` : 'St'}
                  </div>
                </Show>
                <div class="flex flex-1 items-center justify-center overflow-hidden bg-[#30363d]/20 text-[#8b949e]">
                  {Math.max(0, wordWidth() - startBits() - stopBits())} data
                </div>
                <Show when={stopBits() > 0}>
                  <div
                    class="flex shrink-0 items-center justify-center border-l border-[#30363d]/40 bg-[#ff7b72]/15 text-[#ff7b72]"
                    style={{ width: `${(stopBits() / wordWidth()) * 100}%`, 'min-width': '2px' }}
                  >
                    {stopBits() !== 1 ? `Sp×${stopBits()}` : 'Sp'}
                  </div>
                </Show>
              </div>
            </Show>
          </div>

          {/* Toggles */}
          <div class="mb-1.5 flex shrink-0 flex-wrap gap-1.5">
            <For each={[['Frames', showFrameMarkers, setShowFrameMarkers] as const, ['Words', showWordMarkers, setShowWordMarkers] as const, ['Start/Stop', showBitMarkers, setShowBitMarkers] as const]}>
              {([l, v, s]) => (
                <button
                  onClick={() => s((x) => !x)}
                  class={`rounded border px-2 py-0.5 text-xs transition-colors ${
                    v() ? 'border-[#2ea043]/50 bg-[#238636]/20 text-[#2ea043]' : 'border-[#30363d] text-[#484f58]'
                  }`}
                >
                  {l}
                </button>
              )}
            </For>
          </div>

          {/* Bit grid */}
          <div class="relative min-h-0 flex-1" style={{ 'min-height': '60px' }}>
            <canvas ref={bitEl} class="absolute inset-0 h-full w-full rounded bg-[#0d1117]" width={640} height={400} />
            <canvas
              ref={hoverCanvEl}
              width={640}
              height={400}
              class="absolute inset-0 h-full w-full rounded"
              style={{ cursor: 'crosshair' }}
              onMouseMove={(e) => {
                const r = e.currentTarget.getBoundingClientRect()
                const sx = e.currentTarget.width / r.width, sy = e.currentTarget.height / r.height
                hoverPos = { x: (e.clientX - r.left) * sx, y: (e.clientY - r.top) * sy }
              }}
              onMouseLeave={() => { hoverPos = null }}
            />
          </div>

          {/* Multi-stream decode candidates */}
          <Show when={encoding() === 'varicode' && fec() === 'k7r12'}>
            <div class="mt-2 shrink-0">
              <div class="mb-1 flex items-center justify-between">
                <span class="font-mono text-[10px] text-[#484f58]">Multi-stream candidates</span>
                <span class="text-[10px] text-[#484f58]">click row to select</span>
              </div>
              <div class="overflow-hidden overflow-y-auto rounded border border-[#30363d]" style={{ 'max-height': '8rem' }}>
                <For each={candidateOffsets()}>
                  {(off, i) => (
                    <div
                      onClick={() => setSelectedCandidate(i())}
                      class={`flex cursor-pointer items-center gap-2 border-b border-[#30363d]/50 px-2 py-1 transition-colors last:border-b-0 ${
                        i() === selectedCandidate() ? 'border-l-2 border-l-[#2ea043] bg-[#238636]/20' : 'bg-[#0d1117] hover:bg-[#161b22]'
                      }`}
                    >
                      <span class={`w-14 shrink-0 font-mono text-[9px] ${i() === selectedCandidate() ? 'text-[#2ea043]' : 'text-[#484f58]'}`}>
                        {off >= 0 ? '+' : ''}
                        {off.toFixed(1)} Hz
                      </span>
                      <span class="flex-1 overflow-hidden font-mono text-[10px] whitespace-nowrap text-[#8b949e]" style={{ direction: 'rtl', 'text-align': 'left' }}>
                        {candidateTexts()[i()] ?? '—'}
                      </span>
                      <Show when={i() === selectedCandidate()}>
                        <span class="shrink-0 text-[9px] text-[#2ea043]">▶</span>
                      </Show>
                    </div>
                  )}
                </For>
              </div>
            </div>
          </Show>

          {/* Decoded text */}
          <div class="mt-2 shrink-0">
            <div class="mb-1 flex items-center justify-between">
              <span class="text-xs font-semibold text-[#8b949e]">
                Decoded ·{' '}
                {encoding() === 'ccir476'
                  ? 'CCIR476 SITOR-B'
                  : isSyncMode()
                    ? (encoding() === 'baudot' ? 'Baudot ITA2' : 'ASCII') + ' sync'
                    : encoding() === 'varicode'
                      ? 'Varicode (IZ8BLY)'
                      : 'ASCII free'}
              </span>
              <div class="flex items-center gap-1.5">
                <button
                  onClick={() => {
                    const t = txtEl?.textContent ?? ''
                    if (t) navigator.clipboard.writeText(t).catch(() => {})
                  }}
                  title="Copy decoded text"
                  class="rounded border border-[#30363d] px-1.5 py-0.5 text-xs text-[#484f58] transition-colors hover:border-[#484f58] hover:text-[#c9d1d9]"
                >
                  copy
                </button>
                <button
                  onClick={() => {
                    if (txtEl) txtEl.textContent = ''
                    lastDec = -1
                    lastWrd = -1
                    candCursors = []
                    txtBuf = ''
                    setCandidateTexts([])
                    processor.clearSymbols()
                  }}
                  title="Clear text and buffer"
                  class="rounded border border-[#30363d] px-1.5 py-0.5 text-xs text-[#484f58] transition-colors hover:border-[#484f58] hover:text-[#c9d1d9]"
                >
                  ×
                </button>
              </div>
            </div>
            <pre
              ref={txtEl}
              class="overflow-auto rounded border border-[#30363d] bg-[#0d1117] px-2 py-1.5 font-mono text-xs break-all whitespace-pre-wrap text-[#c9d1d9]"
              style={{ height: '6rem' }}
            ></pre>
          </div>
        </div>

        {/* Drag handle 0<->1 */}
        <div class="group hidden w-3 shrink-0 cursor-col-resize items-center justify-center self-stretch lg:flex" onMouseDown={(e) => startDrag(e, 0)}>
          <div class="h-full w-px bg-[#30363d] transition-colors group-hover:bg-[#2ea043]/50" />
        </div>

        {/* ── Panel 2: Audio Analysis ── */}
        <AudioAnalysisPanel
          analyser={props.analyser ?? null}
          isRecording={processor.state().isRecording}
          storageKeyPrefix="mfsk"
          markers={channels().map((ch) => ({ freq: ch.freq, color: ch.color, label: ch.label }))}
          onMarkerDrag={(idx, newHz, shiftKey) => {
            const ch = channels()[idx]
            if (!ch) return
            if (shiftKey) {
              // Shift+drag: move just this tone, leave the rest of the group.
              const f = Math.max(50, Math.min(24000, Math.round(newHz)))
              if (f !== ch.freq) setChannels((p) => p.map((c) => (c.id === ch.id ? { ...c, freq: f } : c)))
              return
            }
            let delta = Math.round(newHz) - ch.freq
            // Clamp delta so no channel escapes [50, 24000] — preserves spacing
            const minFreq = Math.min(...channels().map((c) => c.freq))
            const maxFreq = Math.max(...channels().map((c) => c.freq))
            delta = Math.max(50 - minFreq, Math.min(24000 - maxFreq, delta))
            if (delta === 0) return
            setChannels((p) => p.map((c) => ({ ...c, freq: c.freq + delta })))
          }}
          showGrid={showGrid()}
          gridSize={gridSize()}
          squelch={squelch()}
          onSquelchChange={setSquelch}
          glBands={channels()}
          vfoFrequency={props.vfoFrequency}
          class="min-w-0"
          style={{ flex: pW()[1] }}
        />

        {/* Drag handle 1<->2 */}
        <div class="group hidden w-3 shrink-0 cursor-col-resize items-center justify-center self-stretch lg:flex" onMouseDown={(e) => startDrag(e, 1)}>
          <div class="h-full w-px bg-[#30363d] transition-colors group-hover:bg-[#2ea043]/50" />
        </div>

        {/* ── Panel 3: Decoder ── */}
        <div class="flex min-h-[280px] min-w-0 flex-col rounded-lg border border-[#30363d] bg-[#161b22] p-3 sm:p-4 lg:min-h-0" style={{ flex: pW()[2] }}>
          <h2 class="mb-2.5 shrink-0 text-sm font-semibold text-[#c9d1d9]">Decoder</h2>

          {/* Preset */}
          <div class="mb-3 shrink-0 border-b border-[#30363d] pb-3">
            <label class="mb-1 block text-xs text-[#8b949e]">Preset</label>
            <select
              value=""
              onChange={(e) => {
                if (e.currentTarget.value) {
                  applyPreset(e.currentTarget.value)
                  e.currentTarget.value = ''
                }
              }}
              class="w-full cursor-pointer rounded border border-[#30363d] bg-[#0d1117] px-2 py-1.5 text-sm text-[#c9d1d9] focus:border-[#2ea043] focus:outline-none"
            >
              <option value="">— load preset —</option>
              <optgroup label="── RTTY ──">
                <For each={['rtty-45-170', 'rtty-50-170', 'rtty-75-170', 'rtty-50-450', 'rtty-50-850', 'rtty-75-850']}>
                  {(k) => <option value={k}>{PRESETS[k].label}</option>}
                </For>
              </optgroup>
              <optgroup label="── 2-tone FSK utility ──">
                <For each={['navtex', 'afsk1200']}>
                  {(k) => <option value={k}>{PRESETS[k].label}</option>}
                </For>
              </optgroup>
              <optgroup label="── fldigi MFSK (FEC, varicode) ──">
                <For each={['mfsk4', 'mfsk8', 'mfsk16', 'mfsk32', 'mfsk64', 'mfsk128']}>
                  {(k) => <option value={k}>{PRESETS[k].label}</option>}
                </For>
              </optgroup>
              <optgroup label="── Classic MFSK (IZ8BLY, no FEC) ──">
                <For each={['classic-mfsk4', 'classic-mfsk8', 'classic-mfsk16', 'classic-mfsk32']}>
                  {(k) => <option value={k}>{PRESETS[k].label}</option>}
                </For>
              </optgroup>
              <optgroup label="── Wavecom MFSK (approx params) ──">
                <For each={['wavecom-mfsk11', 'wavecom-mfsk22', 'wavecom-mfsk31']}>
                  {(k) => <option value={k}>{PRESETS[k].label}</option>}
                </For>
              </optgroup>
            </select>
          </div>

          {/* Decoder params */}
          <div class="mb-3 shrink-0 space-y-2 border-b border-[#30363d] pb-3">
            <div class="flex items-center gap-2 text-xs">
              <span class="w-16 shrink-0 text-[#8b949e]">Baud rate</span>
              <NumberField
                value={baudRate()}
                parse={(raw) => {
                  const v = parseFloat(raw)
                  return Number.isFinite(v) && v > 0 ? v : null
                }}
                onCommit={setBaudRate}
                class="min-w-0 flex-1 rounded border border-[#30363d] bg-[#0d1117] px-2 py-1 font-mono text-[#c9d1d9] focus:border-[#2ea043] focus:outline-none"
              />
              <span class="shrink-0 text-[#484f58]">Bd</span>
            </div>
            <div class="flex items-center gap-2 text-xs">
              <span class="w-16 shrink-0 text-[#8b949e]">Band width</span>
              <NumberField
                value={channelBw()}
                min={5}
                max={1000}
                onCommit={setChannelBw}
                class="min-w-0 flex-1 rounded border border-[#30363d] bg-[#0d1117] px-2 py-1 font-mono text-[#c9d1d9] focus:border-[#2ea043] focus:outline-none"
              />
              <span class="shrink-0 text-[#484f58]">Hz</span>
            </div>
            <div class="flex items-center gap-2 text-xs">
              <span class="w-16 shrink-0 text-[#8b949e]">Squelch</span>
              <input
                type="range"
                min={0}
                max={100}
                step={1}
                value={squelch()}
                onInput={(e) => setSquelch(parseInt(e.currentTarget.value))}
                class="flex-1 accent-[#e3b341]"
              />
              <span class="w-8 shrink-0 text-right font-mono text-[#e3b341]">{squelch()}%</span>
            </div>
            <div class="flex items-center gap-2 text-xs">
              <span class="w-16 shrink-0 text-[#8b949e]">Sq. grid</span>
              <Toggle checked={showGrid()} onChange={() => setShowGrid((v) => !v)} />
              <Show when={showGrid()}>
                <input type="range" min={6} max={96} step={2} value={gridSize()} onInput={(e) => setGridSize(parseInt(e.currentTarget.value))} class="flex-1 accent-[#e3b341]" />
                <span class="w-10 shrink-0 text-right font-mono text-[10px] text-[#484f58]">
                  {gridSize() * 2}×{gridSize()}
                </span>
              </Show>
            </div>
          </div>

          {/* Decode options */}
          <div class="mb-3 shrink-0 space-y-2 border-b border-[#30363d] pb-3">
            <p class="text-[10px] font-semibold tracking-wide text-[#484f58] uppercase">Decode Options</p>

            <div class="flex items-center gap-2 text-xs">
              <span class="w-16 shrink-0 text-[#8b949e]">Bit order</span>
              <SegBtn
                options={[{ label: 'MSB', value: 'msb' }, { label: 'LSB', value: 'lsb' }]}
                value={decoderOpts().bitOrder ?? 'msb'}
                onChange={(v) => setDecoderOpts((o) => ({ ...o, bitOrder: v as 'msb' | 'lsb' }))}
              />
            </div>

            <div class="flex items-center gap-2 text-xs">
              <span class="w-16 shrink-0 text-[#8b949e]">Oversample</span>
              <SegBtn
                options={[{ label: '1×', value: 1 }, { label: '2×', value: 2 }, { label: '4×', value: 4 }]}
                value={decoderOpts().oversampleFactor ?? 1}
                onChange={(v) => setDecoderOpts((o) => ({ ...o, oversampleFactor: v as number }))}
              />
            </div>

            <div class="flex items-center gap-2 text-xs">
              <span class="w-16 shrink-0 text-[#8b949e]">Sync mode</span>
              <SegBtn
                options={[{ label: 'Free', value: 'free' }, { label: 'Start-bit', value: 'start-bit' }]}
                value={decoderOpts().syncMode ?? 'free'}
                onChange={(v) => setDecoderOpts((o) => ({ ...o, syncMode: v as 'free' | 'start-bit' }))}
              />
            </div>

            <Show when={isSyncMode()}>
              <div class="flex items-center gap-2 text-xs">
                <span class="w-16 shrink-0 text-[#8b949e]">Stop bits</span>
                <SegBtn
                  options={[{ label: '1', value: 1 }, { label: '1.5', value: 1.5 }, { label: '2', value: 2 }]}
                  value={decoderOpts().stopBitSymbols ?? 1}
                  onChange={(v) => setDecoderOpts((o) => ({ ...o, stopBitSymbols: v as number }))}
                />
              </div>
              <div class="flex items-center gap-2 text-xs">
                <span class="w-16 shrink-0 text-[#8b949e]">Char bits</span>
                <NumberField
                  value={decoderOpts().charBits ?? 8}
                  min={5}
                  max={8}
                  onCommit={(n) => setDecoderOpts((o) => ({ ...o, charBits: n }))}
                  class="w-16 rounded border border-[#30363d] bg-[#0d1117] px-2 py-0.5 font-mono text-[#c9d1d9] focus:border-[#2ea043] focus:outline-none"
                />
                <span class="text-[#484f58]">bits</span>
              </div>
              <div class="flex items-center gap-2 text-xs">
                <span class="w-16 shrink-0 text-[#8b949e]">Sideband</span>
                <SegBtn
                  options={[{ label: 'USB', value: 0 }, { label: 'LSB', value: 1 }]}
                  value={(decoderOpts().reverseShift ?? false) ? 1 : 0}
                  onChange={(v) => setDecoderOpts((o) => ({ ...o, reverseShift: v === 1 }))}
                />
                <span class="text-[10px] text-[#484f58]">{(decoderOpts().reverseShift ?? false) ? 'ch0=Sp' : 'ch0=Mk'}</span>
              </div>
            </Show>

            <div class="flex items-center gap-2 text-xs">
              <span class="w-16 shrink-0 text-[#8b949e]">Encoding</span>
              <SegBtn
                options={[
                  { label: 'ASCII', value: 'ascii' },
                  { label: 'Varicode', value: 'varicode' },
                  { label: 'Baudot', value: 'baudot' },
                  { label: 'CCIR476', value: 'ccir476' },
                ]}
                value={encoding()}
                onChange={(v) => setEncoding(v as Encoding)}
              />
            </div>

            <Show when={!isSyncMode()}>
              <div class="flex items-center gap-2 text-xs">
                <span class="w-16 shrink-0 text-[#8b949e]">Gray code</span>
                <Toggle checked={decoderOpts().useGrayCode ?? false} onChange={() => setDecoderOpts((o) => ({ ...o, useGrayCode: !(o.useGrayCode ?? false) }))} />
                <span class="text-[10px] text-[#484f58]">MFSK tone→bits</span>
              </div>
            </Show>

            <Show when={encoding() === 'varicode' && !isSyncMode()}>
              <div class="flex items-center gap-2 text-xs">
                <span class="w-16 shrink-0 text-[#8b949e]">FEC</span>
                <SegBtn options={[{ label: 'None', value: 'none' }, { label: 'K7 R½', value: 'k7r12' }]} value={fec()} onChange={(v) => setFec(v as FECMode)} />
              </div>
              <Show when={fec() === 'k7r12'}>
                <div class="flex items-center gap-2 text-xs">
                  <span class="w-16 shrink-0 text-[#8b949e]">IL depth</span>
                  <NumberField
                    value={interleaverDepth()}
                    parse={(raw) => {
                      const v = parseInt(raw)
                      return Number.isFinite(v) && v > 0 ? Math.min(100, v) : null
                    }}
                    onCommit={setInterleaverDepth}
                    class="w-16 rounded border border-[#30363d] bg-[#0d1117] px-2 py-0.5 font-mono text-[#c9d1d9] focus:border-[#2ea043] focus:outline-none"
                  />
                  <span class="text-[10px] text-[#484f58]">symbols</span>
                </div>
              </Show>
            </Show>
          </div>

          {/* Tones */}
          <div class="mb-1.5 flex shrink-0 items-center justify-between">
            <span class="text-xs font-semibold text-[#8b949e]">Tones ({channels().length})</span>
            <button
              onClick={addChannel}
              disabled={channels().length >= 128}
              class="flex items-center gap-1 rounded bg-[#238636] px-2 py-0.5 text-xs text-white transition-colors hover:bg-[#2ea043] disabled:cursor-not-allowed disabled:opacity-40"
            >
              <svg xmlns="http://www.w3.org/2000/svg" class="h-3 w-3" viewBox="0 0 20 20" fill="currentColor">
                <path fill-rule="evenodd" d="M10 3a1 1 0 011 1v5h5a1 1 0 110 2h-5v5a1 1 0 11-2 0v-5H4a1 1 0 110-2h5V4a1 1 0 011-1z" clip-rule="evenodd" />
              </svg>
              Add
            </button>
          </div>

          {/* Group geometry — move/space the whole tone set at once */}
          <Show when={channels().length > 0}>
            <div class="mb-1 flex shrink-0 items-center gap-1.5 text-[10px] text-[#8b949e]">
              <span class="shrink-0">Center</span>
              <NumberField
                value={toneCenter()}
                min={50}
                max={3000}
                step={10}
                onCommit={applyToneCenter}
                title="Center of the tone group — shifts all tones together"
                class="w-14 rounded border border-[#30363d] bg-[#0d1117] px-1.5 py-0.5 font-mono text-[#c9d1d9] focus:border-[#2ea043] focus:outline-none"
              />
              <span class="shrink-0 text-[#484f58]">Hz</span>
              <span class="ml-1 shrink-0">Spacing</span>
              <NumberField
                value={toneSpacing()}
                min={1}
                max={1000}
                step={5}
                onCommit={applyToneSpacing}
                disabled={channels().length < 2}
                title="Gap between adjacent tones — re-lays the group out evenly around the center"
                class="w-12 rounded border border-[#30363d] bg-[#0d1117] px-1.5 py-0.5 font-mono text-[#c9d1d9] focus:border-[#2ea043] focus:outline-none disabled:opacity-40"
              />
              <span class="shrink-0 text-[#484f58]">Hz</span>
            </div>
            <p class="mb-1.5 shrink-0 text-[9px] text-[#484f58]">marker drag moves all tones · shift+drag moves one</p>
          </Show>

          <div class="flex-1 space-y-0.5 overflow-y-auto pr-0.5">
            <Show when={channels().length === 0}>
              <p class="py-3 text-center text-xs text-[#484f58]">Add a tone to start decoding.</p>
            </Show>
            <For each={channels()}>
              {(ch, i) => (
                <ToneRow
                  ch={ch}
                  index={i()}
                  total={channels().length}
                  maxHz={3000}
                  vfoFrequency={props.vfoFrequency}
                  onRemove={() => removeChannel(ch.id)}
                  onFreqChange={(f) => updFreq(ch.id, f)}
                  onColorChange={(c) => updColor(ch.id, c)}
                  pwrRef={(el) => { pwrRefs[ch.id] = el }}
                />
              )}
            </For>
          </div>

          <div class="mt-2 shrink-0 border-t border-[#30363d] pt-2">
            <div class="text-center font-mono text-[10px] text-[#484f58]">
              {channels().length} tones · {bps()} bit/symbol · {(baudRate() * bps()).toFixed(1)} bit/s
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
