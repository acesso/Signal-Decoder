'use client';

import { useEffect, useRef, useCallback, useState, useMemo } from 'react';
import { useMFSKProcessor } from '@/hooks/useMFSKProcessor';
import type { MFSKSymbol, MFSKWord } from '@/hooks/useMFSKProcessor';
import { MFSKChannel, MFSKDecoderOptions, DEFAULT_DECODER_OPTIONS } from '@/lib/mfsk/decoder';
import { bitsToBaudotCode, decodeBaudotCodePoints } from '@/lib/mfsk/baudot';
import { decodeMFSKVaricode } from '@/lib/mfsk/varicode';
import { decodeMFSKWithFECIncremental, makeFECCursor, FECCursor } from '@/lib/mfsk/fec';
import GLSpectrogram, { GLSpectrogramHandle, GLView } from './GLSpectrogram';

type SpectrogramView = 'legacy' | GLView;
type Encoding = 'ascii' | 'baudot' | 'varicode';

const CANVAS_H       = 200;
const AXIS_H         = 25;
const PLOT_H         = CANVAS_H - AXIS_H;
const MAX_TXT        = 20_000; // max chars kept in the decoded text box

// Single default tone color — user can change per-tone
const DEFAULT_TONE_COLOR = '#79c0ff';

function makeId() { return Math.random().toString(36).slice(2, 9); }

const DEFAULT_CHANNELS: MFSKChannel[] = [
  { id: makeId(), freq: 800,  color: DEFAULT_TONE_COLOR, label: 'T0' },
  { id: makeId(), freq: 1000, color: DEFAULT_TONE_COLOR, label: 'T1' },
  { id: makeId(), freq: 1200, color: DEFAULT_TONE_COLOR, label: 'T2' },
  { id: makeId(), freq: 1400, color: DEFAULT_TONE_COLOR, label: 'T3' },
];

// ── Presets ───────────────────────────────────────────────────────────────────

type FECMode = 'none' | 'k7r12';

interface PresetDef {
  label:              string;
  baudRate:           number;
  channelBw:          number;
  channels:           Omit<MFSKChannel, 'id'>[];
  decoderOpts:        Partial<MFSKDecoderOptions>;
  encoding:           Encoding;
  fec:                FECMode;
  interleaverDepth:   number;
  frameWidth:         number;
  wordWidth:          number;
  startBits:          number;
  stopBits:           number;
  candidateOffsets?:  number[];
}

function makeTones(n: number, baseHz: number, spacingHz: number): Omit<MFSKChannel, 'id'>[] {
  return Array.from({ length: n }, (_, i) => ({
    freq:  baseHz + i * spacingHz,
    color: DEFAULT_TONE_COLOR,
    label: `T${i}`,
  }));
}

const RTTY_OPTS = { bitOrder: 'lsb' as const, oversampleFactor: 2, syncMode: 'start-bit' as const, charBits: 5, stopBitSymbols: 1.5, reverseShift: false };
const RTTY_FRAME = { encoding: 'baudot' as const, fec: 'none' as const, interleaverDepth: 0, frameWidth: 75, wordWidth: 7.5, startBits: 1, stopBits: 1.5 };
const MFSK_OPTS  = { bitOrder: 'msb' as const, oversampleFactor: 1, syncMode: 'free' as const, charBits: 8, stopBitSymbols: 1, useGrayCode: true };

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
  'mfsk4': {
    label: 'fldigi MFSK4 — 32 tones / 3.9 Bd',
    baudRate: 3.906, channelBw: 4,
    channels: makeTones(32, 1500 - 15.5 * 3.906, 3.906),  // center 1500 Hz
    decoderOpts: MFSK_OPTS,
    encoding: 'varicode', fec: 'k7r12', interleaverDepth: 5,
    frameWidth: 48, wordWidth: 0, startBits: 0, stopBits: 0,
    candidateOffsets: [-7.812, -3.906, 0, 3.906, 7.812],
  },
  'mfsk8': {
    label: 'fldigi MFSK8 — 32 tones / 7.8 Bd',
    baudRate: 7.813, channelBw: 8,
    channels: makeTones(32, 1500 - 15.5 * 7.813, 7.813),  // center 1500 Hz
    decoderOpts: MFSK_OPTS,
    encoding: 'varicode', fec: 'k7r12', interleaverDepth: 5,
    frameWidth: 48, wordWidth: 0, startBits: 0, stopBits: 0,
    candidateOffsets: [-15.625, -7.813, 0, 7.813, 15.625],
  },
  'mfsk16': {
    label: 'fldigi MFSK16 — 16 tones / 15.6 Bd',
    baudRate: 15.625, channelBw: 16,
    channels: makeTones(16, 1500 - 7.5 * 15.625, 15.625),  // center 1500 Hz
    decoderOpts: MFSK_OPTS,
    encoding: 'varicode', fec: 'k7r12', interleaverDepth: 10,
    frameWidth: 64, wordWidth: 0, startBits: 0, stopBits: 0,
    candidateOffsets: [-31.25, -15.625, 0, 15.625, 31.25],
  },
  'mfsk32': {
    label: 'fldigi MFSK32 — 16 tones / 31.25 Bd',
    baudRate: 31.25, channelBw: 32,
    channels: makeTones(16, 1500 - 7.5 * 31.25, 31.25),  // center 1500 Hz
    decoderOpts: MFSK_OPTS,
    encoding: 'varicode', fec: 'k7r12', interleaverDepth: 10,
    frameWidth: 64, wordWidth: 0, startBits: 0, stopBits: 0,
    candidateOffsets: [-62.5, -31.25, 0, 31.25, 62.5],
  },
  'mfsk64': {
    // fldigi MFSK64: symlen=128, basetone=16, numtones=16, bps=4, depth=10
    // spacing = 62.5 Hz, center = 1500 Hz → base = 1500 - 7.5*62.5 = 1031.25 Hz
    label: 'fldigi MFSK64 — 16 tones / 62.5 Bd',
    baudRate: 62.5, channelBw: 63,
    channels: makeTones(16, 1500 - 7.5 * 62.5, 62.5),   // center 1500 Hz
    decoderOpts: MFSK_OPTS,
    encoding: 'varicode', fec: 'k7r12', interleaverDepth: 10,
    frameWidth: 96, wordWidth: 0, startBits: 0, stopBits: 0,
    candidateOffsets: [-125, -62.5, 0, 62.5, 125],
  },
  'mfsk128': {
    // fldigi MFSK128: symlen=64, basetone=8, numtones=16, bps=4, depth=20
    // spacing = 125 Hz, center = 1500 Hz → base = 1500 - 7.5*125 = 562.5 Hz
    label: 'fldigi MFSK128 — 16 tones / 125 Bd',
    baudRate: 125, channelBw: 125,
    channels: makeTones(16, 1500 - 7.5 * 125, 125),     // center 1500 Hz
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
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function hexToRgb(hex: string): [number, number, number] {
  return [parseInt(hex.slice(1,3),16), parseInt(hex.slice(3,5),16), parseInt(hex.slice(5,7),16)];
}

function drawAxisLabels(ctx: CanvasRenderingContext2D, w: number, pH: number, minF: number, maxF: number) {
  const span = maxF - minF;
  ctx.strokeStyle = '#30363d'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, pH); ctx.lineTo(w, pH); ctx.stroke();
  // Choose tick step based on span
  const step = span <= 500 ? 50 : span <= 1000 ? 100 : span <= 2000 ? 200 : 500;
  const majMult = step * 5;
  const medMult = step * 2;
  const firstTick = Math.ceil(minF / step) * step;
  for (let f = firstTick; f <= maxF; f += step) {
    const x = ((f - minF) / span) * w;
    const maj = f % majMult === 0, med = !maj && f % medMult === 0;
    ctx.strokeStyle = maj ? '#8b949e' : '#30363d';
    ctx.beginPath(); ctx.moveTo(x, pH); ctx.lineTo(x, pH + (maj ? 6 : med ? 4 : 2)); ctx.stroke();
    if (maj) {
      ctx.fillStyle = '#8b949e'; ctx.font = '10px monospace'; ctx.textAlign = 'center';
      ctx.fillText(f >= 1000 ? `${f/1000}k` : `${f}`, x, pH + 17);
    }
  }
}

function drawSqGrid(
  ctx: CanvasRenderingContext2D, cW: number, pH: number,
  fd: Uint8Array, sql: number, gCols: number, gRows: number,
  channels: MFSKChannel[], minHz: number, maxHz: number, halfBw: number,
) {
  const span = maxHz - minHz;
  const cH = pH / gRows; const cWc = cW / gCols; const sqlF = sql / 100;
  const colCh: (MFSKChannel | null)[] = Array(gCols).fill(null);
  for (let c = 0; c < gCols; c++) {
    const cf = minHz + ((c + 0.5) / gCols) * span;
    for (const ch of channels) if (cf >= ch.freq - halfBw && cf <= ch.freq + halfBw) { colCh[c] = ch; break; }
  }
  for (let c = 0; c < gCols; c++) {
    const f0 = Math.floor((c / gCols) * fd.length);
    const f1 = Math.min(Math.ceil(((c+1)/gCols)*fd.length), fd.length);
    let pk = 0; for (let f = f0; f < f1; f++) if (fd[f] > pk) pk = fd[f];
    const aF = pk / 255;
    const [lr,lg,lb] = colCh[c] ? hexToRgb(colCh[c]!.color) : [227,179,65];
    for (let r = 0; r < gRows; r++) {
      const x = c*cWc, y = r*cH, rb = 1-(r+1)/gRows;
      if (aF > rb) {
        if (rb >= sqlF || sql === 0) {
          ctx.fillStyle = `rgba(${lr},${lg},${lb},${Math.min(0.92,0.35+(aF-rb)*gRows*0.55)})`;
        } else {
          ctx.fillStyle = `rgba(${lr},${lg},${lb},0.12)`;
        }
        ctx.fillRect(x+.5, y+.5, cWc-1, cH-1);
      }
    }
  }
  ctx.strokeStyle='rgba(48,54,61,.55)';ctx.lineWidth=.5;ctx.setLineDash([]);ctx.beginPath();
  for(let c=0;c<=gCols;c++){ctx.moveTo(c*cWc,0);ctx.lineTo(c*cWc,pH);}
  for(let r=0;r<=gRows;r++){ctx.moveTo(0,r*cH);ctx.lineTo(cW,r*cH);}
  ctx.stroke();
  if (sql > 0) {
    const sY = pH*(1-sqlF);
    ctx.lineWidth=1.5;ctx.setLineDash([4,2]);ctx.strokeStyle='#e3b341';
    ctx.beginPath();ctx.moveTo(0,sY);ctx.lineTo(cW,sY);ctx.stroke();ctx.setLineDash([]);
    ctx.fillStyle='#e3b341';
    ctx.beginPath();ctx.moveTo(0,sY-5);ctx.lineTo(9,sY);ctx.lineTo(0,sY+5);ctx.closePath();ctx.fill();
    ctx.beginPath();ctx.moveTo(cW,sY-5);ctx.lineTo(cW-9,sY);ctx.lineTo(cW,sY+5);ctx.closePath();ctx.fill();
    ctx.font='9px monospace';ctx.textAlign='left';ctx.fillStyle='#e3b341';
    ctx.fillText(`SQL ${sql}%`,12,sY>12?sY-3:sY+12);
  }
}

function drawChannelMarker(
  ctx: CanvasRenderingContext2D, cW: number, pH: number,
  freq: number, color: string, label: string, halfBw: number,
  minHz: number, maxHz: number,
) {
  const [r,g,b] = hexToRgb(color);
  const span = maxHz - minHz;
  const tX = ((freq - minHz) / span) * cW;
  const lo = Math.max(0,((freq-halfBw-minHz)/span)*cW);
  const hi = Math.min(cW,((freq+halfBw-minHz)/span)*cW);
  ctx.fillStyle=`rgba(${r},${g},${b},.07)`;ctx.fillRect(lo,0,hi-lo,pH);
  ctx.lineWidth=1;ctx.setLineDash([2,4]);ctx.strokeStyle=`rgba(${r},${g},${b},.30)`;
  ctx.beginPath();ctx.moveTo(lo,0);ctx.lineTo(lo,pH);ctx.stroke();
  ctx.beginPath();ctx.moveTo(hi,0);ctx.lineTo(hi,pH);ctx.stroke();ctx.setLineDash([]);
  ctx.lineWidth=1.5;ctx.setLineDash([4,3]);ctx.strokeStyle=color;
  ctx.beginPath();ctx.moveTo(tX,0);ctx.lineTo(tX,pH);ctx.stroke();ctx.setLineDash([]);
  ctx.font='10px monospace';ctx.textAlign='center';ctx.fillStyle=color;ctx.fillText(label,tX,14);
}

function drawBitGrid(
  ctx: CanvasRenderingContext2D, cW: number, cH: number,
  syms: MFSKSymbol[], bps: number,
  frameWidth: number, frameHeight: number,
  wordWidth: number, startBits: number, stopBits: number,
  showWord: boolean, showBit: boolean, showFrame: boolean,
  completedRows: number, bufOffset: number,
) {
  ctx.fillStyle='#0d1117'; ctx.fillRect(0,0,cW,cH);
  if (!syms.length || frameWidth<=0 || bps<=0 || completedRows<=0) return;
  const cpl = Math.round(frameWidth*bps);
  if (cpl<=0) return;
  const cWc = cW/cpl;
  const cHc = Math.max(6,Math.min(20,Math.round(cWc*1.05)));
  const maxV = Math.floor(cH/cHc);
  const firstRow = Math.max(0, completedRows-maxV);
  const wSz = wordWidth>0 ? Math.round(wordWidth*bps) : 0;
  const stSz = Math.round(startBits*bps), spSz = Math.round(stopBits*bps);

  for (let ri = firstRow; ri < completedRows; ri++) {
    const dr = ri-firstRow; const ly = dr*cHc;
    if (ly>cH) break;
    if (showFrame && frameHeight>0 && ri>0 && ri%frameHeight===0) {
      ctx.fillStyle='rgba(140,160,200,.22)'; ctx.fillRect(0,ly-1,cW,2);
    }
    const rowStartSym = Math.round(ri*frameWidth);
    const bufBitStart = (rowStartSym-bufOffset)*bps;
    for (let col = 0; col < cpl; col++) {
      const bufBit = bufBitStart+col;
      if (bufBit<0 || bufBit>=syms.length*bps) continue;
      const si = Math.floor(bufBit/bps), bi = bufBit%bps;
      const sym = syms[si]; if (!sym) continue;
      const bit = sym.bits[bi]??false;
      const x = col*cWc, y = ly;
      let isS = false, isSt = false;
      if (wSz>0 && showBit) {
        const p = (rowStartSym*bps+col)%wSz;
        isS = p<stSz; isSt = spSz>0 && p>=wSz-spSz;
      }
      if (isS) { ctx.fillStyle='rgba(86,211,100,.09)'; ctx.fillRect(x,y,cWc,cHc); }
      else if (isSt) { ctx.fillStyle='rgba(255,123,114,.09)'; ctx.fillRect(x,y,cWc,cHc); }
      if (!sym.squelched && bit) {
        if (isS) ctx.fillStyle='rgba(86,211,100,.90)';
        else if (isSt) ctx.fillStyle='rgba(255,123,114,.90)';
        else { const [r,g,b]=hexToRgb(sym.winnerChannel?.color??'#e3b341'); ctx.fillStyle=`rgba(${r},${g},${b},.88)`; }
        ctx.fillRect(x+.5,y+.5,cWc-1,cHc-1);
      } else if (!sym.squelched) { ctx.fillStyle='#151c28'; ctx.fillRect(x+.5,y+.5,cWc-1,cHc-1); }
    }
    if (showWord && wSz>0) {
      const m = (rowStartSym*bps)%wSz; const fb = m===0 ? 0 : wSz-m;
      ctx.strokeStyle='rgba(200,210,230,.35)';ctx.lineWidth=1;ctx.setLineDash([3,2]);
      for (let b = fb; b < cpl; b+=wSz) { const x=b*cWc; ctx.beginPath();ctx.moveTo(x,ly);ctx.lineTo(x,ly+cHc);ctx.stroke(); }
      ctx.setLineDash([]);
    }
    if (bps>1) {
      ctx.strokeStyle='rgba(40,48,60,.7)';ctx.lineWidth=.5;
      for(let s=1;s<frameWidth;s++){const x=Math.round(s*bps)*cWc;ctx.beginPath();ctx.moveTo(x,ly);ctx.lineTo(x,ly+cHc);ctx.stroke();}
    }
  }
  ctx.strokeStyle='rgba(30,36,45,.9)';ctx.lineWidth=.5;
  for(let lr=0;lr<=maxV;lr++){const y=lr*cHc;ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(cW,y);ctx.stroke();}
}

/** Decode word-structured symbols into ASCII text (free mode). */
function decodeAsciiFromSymbols(
  syms: MFSKSymbol[], wordWidth: number, startBits: number, stopBits: number, bps: number,
): string {
  if (wordWidth <= 0 || wordWidth <= startBits + stopBits) return '';
  const chars: string[] = [];
  let acc: boolean[] = [];
  const nWords = Math.floor(syms.length / wordWidth);
  for (let w = 0; w < nWords; w++) {
    let ok = true; const wbits: boolean[] = [];
    for (let s = startBits; s < wordWidth - stopBits; s++) {
      const sym = syms[w*wordWidth+s];
      if (!sym||sym.squelched) { ok=false; break; }
      for (let b=0;b<bps;b++) wbits.push(sym.bits[b]??false);
    }
    if (!ok) { acc=[]; continue; }
    acc.push(...wbits);
    while (acc.length>=8) {
      let byte=0;
      for(let b=0;b<8;b++) byte=(byte<<1)|(acc[b]?1:0);
      acc=acc.slice(8);
      if(byte>=32&&byte<127) chars.push(String.fromCharCode(byte));
      else if(byte===10||byte===13) chars.push('\n');
    }
  }
  return chars.join('');
}

/** Decode framed MFSKWords using ITA2 Baudot (start-bit sync mode). */
function decodeBaudotFromWords(words: MFSKWord[], lsbFirst: boolean): string {
  const codes = words
    .filter(w => !w.squelched && w.validStop)
    .map(w => bitsToBaudotCode(w.bits, lsbFirst));
  return decodeBaudotCodePoints(codes);
}

// ── Toggle ────────────────────────────────────────────────────────────────────

function Toggle({ checked, onChange }: { checked: boolean; onChange: () => void }) {
  return (
    <button role="switch" aria-checked={checked} onClick={onChange}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors focus:outline-none ${
        checked?'bg-[#238636] border-[#2ea043]':'bg-[#21262d] border-[#30363d]'
      }`}>
      <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow-sm transition-transform ${checked?'translate-x-4':'translate-x-0.5'}`}/>
    </button>
  );
}

// ── Small segmented buttons ────────────────────────────────────────────────────

function SegBtn<T extends string | number>({
  options, value, onChange,
}: { options: { label: string; value: T }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="flex rounded overflow-hidden border border-[#30363d]">
      {options.map(o => (
        <button key={String(o.value)} onClick={() => onChange(o.value)}
          className={`px-2 py-0.5 text-xs transition-colors ${
            o.value===value ? 'bg-[#238636] text-white' : 'bg-[#0d1117] text-[#8b949e] hover:text-[#c9d1d9]'
          }`}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ── Tone row (collapsed / expanded) ──────────────────────────────────────────

function ToneRow({
  ch, index, total, maxHz,
  onRemove, onFreqChange, onColorChange,
  pwrRef,
}: {
  ch: MFSKChannel;
  index: number;
  total: number;
  maxHz: number;
  onRemove: () => void;
  onFreqChange: (f: number) => void;
  onColorChange: (c: string) => void;
  pwrRef: (el: HTMLDivElement | null) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [freqInput, setFreqInput] = useState(String(ch.freq));

  // keep freqInput in sync when channel changes externally (e.g. drag)
  useEffect(() => { setFreqInput(String(ch.freq)); }, [ch.freq]);

  const commitFreq = () => {
    const v = parseFloat(freqInput);
    if (!isNaN(v)) onFreqChange(Math.max(50, Math.min(maxHz, v)));
    else setFreqInput(String(ch.freq));
  };

  return (
    <div className="border border-[#30363d] rounded" style={{borderLeftColor: ch.color, borderLeftWidth: 3}}>
      {/* Collapsed row */}
      <div className="flex items-center gap-1.5 px-2 py-1 bg-[#0d1117] rounded">
        {/* expand toggle */}
        <button onClick={() => setExpanded(v => !v)}
          className="text-[#484f58] hover:text-[#8b949e] transition-colors shrink-0 w-3">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor"
            className={`w-3 h-3 transition-transform ${expanded ? 'rotate-90' : ''}`}>
            <path fillRule="evenodd" d="M7.293 4.293a1 1 0 011.414 0L13 8.586a1 1 0 010 1.414l-4.293 4.293a1 1 0 01-1.414-1.414L10.586 10 7.293 6.707a1 1 0 010-1.414z" clipRule="evenodd"/>
          </svg>
        </button>
        {/* label */}
        <span className="font-mono text-[10px] w-7 shrink-0" style={{color: ch.color}}>{ch.label}</span>
        {/* freq inline */}
        <span className="font-mono text-[10px] text-[#8b949e] flex-1 min-w-0 truncate">{ch.freq} Hz</span>
        {/* power bar */}
        <div className="w-12 bg-[#21262d] rounded-full h-1 overflow-hidden shrink-0">
          <div ref={pwrRef} className="h-full rounded-full" style={{width:'0%', backgroundColor: ch.color}}/>
        </div>
        {/* remove */}
        <button onClick={onRemove} disabled={total <= 1}
          className="text-[#484f58] hover:text-[#f85149] disabled:opacity-20 transition-colors shrink-0">
          <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3" viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd"/>
          </svg>
        </button>
      </div>

      {/* Expanded detail */}
      {expanded && (
        <div className="px-2 pb-2 pt-1 bg-[#0d1117] border-t border-[#1c2128] space-y-1.5">
          {/* Color + freq */}
          <div className="flex items-center gap-2">
            <label className="text-[#484f58] text-[10px] w-8 shrink-0">Color</label>
            <input type="color" value={ch.color} onChange={e => onColorChange(e.target.value)}
              className="w-6 h-5 rounded cursor-pointer border-0 bg-transparent shrink-0"/>
            <span className="font-mono text-[10px]" style={{color: ch.color}}>{ch.color}</span>
          </div>
          <div className="flex items-center gap-2">
            <label className="text-[#484f58] text-[10px] w-8 shrink-0">Freq</label>
            <input type="number" value={freqInput} min={50} max={maxHz} step={1}
              onChange={e => setFreqInput(e.target.value)}
              onBlur={commitFreq}
              onKeyDown={e => { if (e.key === 'Enter') commitFreq(); }}
              className="flex-1 bg-[#161b22] border border-[#30363d] rounded px-1.5 py-0.5 text-[10px] font-mono focus:outline-none focus:border-[#2ea043] min-w-0"
              style={{color: ch.color}}/>
            <span className="text-[#484f58] text-[10px] shrink-0">Hz</span>
          </div>
          <input type="range" min={50} max={maxHz} step={5} value={ch.freq}
            onChange={e => onFreqChange(parseInt(e.target.value))}
            className="w-full" style={{accentColor: ch.color}}/>
        </div>
      )}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function MFSKDecoder() {

  // ── Core params ───────────────────────────────────────────────────────────
  const [channels,  setChannels]  = useState<MFSKChannel[]>(DEFAULT_CHANNELS);
  const [baudRate,  setBaudRate]  = useState(31.25);
  const [squelch,   setSquelch]   = useState(0);
  const [channelBw, setChannelBw] = useState(80);
  const [gridSize,  setGridSize]  = useState(48);
  const [showGrid,       setShowGrid]       = useState(true);
  const [lockChannels,   setLockChannels]   = useState(true);

  // ── Decoder options ───────────────────────────────────────────────────────
  const [decoderOpts, setDecoderOpts] = useState<Partial<MFSKDecoderOptions>>({
    ...DEFAULT_DECODER_OPTIONS,
  });
  const [encoding,    setEncoding]    = useState<Encoding>('ascii');
  const [fec,         setFec]         = useState<FECMode>('none');
  const [interleaverDepth, setInterleaverDepth] = useState(10);

  // ── Output / frame ────────────────────────────────────────────────────────
  const [frameWidth,       setFrameWidth]       = useState(32);
  const [frameHeight,      setFrameHeight]      = useState(16);
  const [wordWidth,        setWordWidth]        = useState(0);
  const [startBits,        setStartBits]        = useState(1);
  const [stopBits,         setStopBits]         = useState(2);

  const [showWordMarkers,  setShowWordMarkers]  = useState(true);
  const [showBitMarkers,   setShowBitMarkers]   = useState(true);
  const [showFrameMarkers, setShowFrameMarkers] = useState(true);

  // ── Multi-stream decode candidates ───────────────────────────────────────
  // Each offset (Hz) relative to the base frequency produces a candidate stream.
  // The selected index is used as the final decoded text.
  const [candidateOffsets, setCandidateOffsets] = useState<number[]>([-15.625, -7.8125, 0, 7.8125, 15.625]);
  const [selectedCandidate, setSelectedCandidate] = useState(2); // center = index 2
  const [candidateTexts, setCandidateTexts] = useState<string[]>([]);
  const lastCandTextRef = useRef(0);
  // Per-candidate FEC cursors for incremental decode
  const candCursorsRef = useRef<FECCursor[]>([]);

  // ── Active preset label ───────────────────────────────────────────────────
  const [activePresetLabel, setActivePresetLabel] = useState<string | null>(null);

  // ── Center frequency display when dragging ────────────────────────────────
  const [draggingCenterFreq, setDraggingCenterFreq] = useState<number | null>(null);
  const [centerFreqInput, setCenterFreqInput] = useState('');

  // Compute center frequency from current channels
  const centerFreq = useMemo(() => {
    if (channels.length === 0) return 0;
    const freqs = channels.map(c => c.freq);
    return Math.round((Math.min(...freqs) + Math.max(...freqs)) / 2);
  }, [channels]);

  // ── Display frequency range ───────────────────────────────────────────────
  const [displayMinHz, setDisplayMinHz] = useState(0);
  const [displayMaxHz, setDisplayMaxHz] = useState(3000);

  // ── Spectrogram ───────────────────────────────────────────────────────────
  const [sgView,  setSgView]  = useState<SpectrogramView>('terrain');
  const [sgGamma, setSgGamma] = useState(3.0);
  const [sgSpeed, setSgSpeed] = useState(2);
  const [bandAlpha, setBandAlpha] = useState(0.3);

  // ── Hook ──────────────────────────────────────────────────────────────────
  const { state, startRecording, stopRecording, clearSymbols, getAnalyser, getSymbols, getWords, getSymbolCount } =
    useMFSKProcessor(channels, baudRate, squelch, decoderOpts);

  // Reset FEC cursors and text whenever the symbol buffer is wiped (param change or explicit clear)
  useEffect(() => {
    candCursorsRef.current = [];
    txtBufRef.current = '';
    lastDecRef.current = 0;
    lastWrdRef.current = 0;
    lastRowRef.current = -1;
    setCandidateTexts([]);
    if (txtRef.current) txtRef.current.textContent = '';
  }, [state.clearId]);

  // ── Canvas refs ───────────────────────────────────────────────────────────
  const specRef    = useRef<HTMLCanvasElement>(null);
  const sgCanvRef  = useRef<HTMLCanvasElement>(null);
  const bitRef      = useRef<HTMLCanvasElement>(null);
  const hoverCanvRef = useRef<HTMLCanvasElement>(null);
  const hoverPosRef  = useRef<{x:number;y:number}|null>(null);
  const glSgRef    = useRef<GLSpectrogramHandle>(null);
  const txtRef     = useRef<HTMLPreElement>(null);
  const txtBufRef  = useRef(''); // rolling text buffer for the decoded output box
  const rafRef     = useRef<number | null>(null);
  const sgFrmRef   = useRef(0);
  const lastDecRef = useRef(0);
  const lastWrdRef = useRef(0);
  const lastRowRef = useRef(-1);

  // Spectrogram container height
  const sgContainerRef     = useRef<HTMLDivElement>(null);
  const [sgH, setSgH]      = useState(300);
  const sgHRef             = useRef(300);
  useEffect(() => {
    const el = sgContainerRef.current; if (!el) return;
    const ro = new ResizeObserver(e => {
      const h = Math.round(e[0].contentRect.height);
      if (h>60 && Math.abs(h-sgHRef.current)>4) { sgHRef.current=h; setSgH(h); }
    });
    ro.observe(el); return () => ro.disconnect();
  }, []);

  // Panel resize
  const containerRef    = useRef<HTMLDivElement>(null);
  const [pW, setPW]     = useState([1,1.4,0.65]);
  const pWRef           = useRef([1,1.4,0.65]);
  const pDragRef        = useRef<{h:number;sx:number;sw:number[]}|null>(null);
  useEffect(() => { pWRef.current=pW; }, [pW]);
  const startDrag = (e:React.MouseEvent, h:number) => {
    e.preventDefault(); pDragRef.current={h,sx:e.clientX,sw:[...pWRef.current]};
  };
  useEffect(() => {
    const mv=(e:MouseEvent)=>{
      const d=pDragRef.current; if(!d||!containerRef.current) return;
      const tot=d.sw.reduce((a,b)=>a+b,0);
      const dw=(e.clientX-d.sx)/containerRef.current.offsetWidth*tot;
      const w=[...d.sw]; w[d.h]=Math.max(.15,w[d.h]+dw); w[d.h+1]=Math.max(.15,w[d.h+1]-dw);
      setPW([...w]);
    };
    const up=()=>{pDragRef.current=null;};
    window.addEventListener('mousemove',mv); window.addEventListener('mouseup',up);
    return ()=>{window.removeEventListener('mousemove',mv);window.removeEventListener('mouseup',up);};
  }, []);

  // Anim-loop refs
  const chRef    = useRef(channels);      useEffect(()=>{chRef.current=channels;},[channels]);
  const sqlRef   = useRef(squelch);       useEffect(()=>{sqlRef.current=squelch;},[squelch]);
  const gsRef    = useRef(gridSize);      useEffect(()=>{gsRef.current=gridSize;},[gridSize]);
  const bwRef    = useRef(channelBw);     useEffect(()=>{bwRef.current=channelBw;},[channelBw]);
  const shGRef   = useRef(showGrid);      useEffect(()=>{shGRef.current=showGrid;},[showGrid]);
  const fwRef    = useRef(frameWidth);    useEffect(()=>{fwRef.current=frameWidth;},[frameWidth]);
  const fhRef    = useRef(frameHeight);   useEffect(()=>{fhRef.current=frameHeight;},[frameHeight]);
  const wwRef    = useRef(wordWidth);     useEffect(()=>{wwRef.current=wordWidth;},[wordWidth]);
  const sbRef    = useRef(startBits);     useEffect(()=>{sbRef.current=startBits;},[startBits]);
  const stbRef   = useRef(stopBits);      useEffect(()=>{stbRef.current=stopBits;},[stopBits]);
  const swmRef   = useRef(showWordMarkers);  useEffect(()=>{swmRef.current=showWordMarkers;},[showWordMarkers]);
  const sbmRef   = useRef(showBitMarkers);   useEffect(()=>{sbmRef.current=showBitMarkers;},[showBitMarkers]);
  const sfmRef   = useRef(showFrameMarkers); useEffect(()=>{sfmRef.current=showFrameMarkers;},[showFrameMarkers]);
  const sgGRef   = useRef(sgGamma);       useEffect(()=>{sgGRef.current=sgGamma;},[sgGamma]);
  const sgSpRef  = useRef(sgSpeed);       useEffect(()=>{sgSpRef.current=sgSpeed;},[sgSpeed]);
  const encRef   = useRef(encoding);      useEffect(()=>{encRef.current=encoding;},[encoding]);
  const fecRef   = useRef(fec);           useEffect(()=>{fecRef.current=fec;},[fec]);
  const ildRef   = useRef(interleaverDepth); useEffect(()=>{ildRef.current=interleaverDepth;},[interleaverDepth]);
  const doRef    = useRef(decoderOpts);   useEffect(()=>{doRef.current=decoderOpts;},[decoderOpts]);
  const lockRef  = useRef(lockChannels);  useEffect(()=>{lockRef.current=lockChannels;},[lockChannels]);
  const brRef    = useRef(baudRate);      useEffect(()=>{brRef.current=baudRate;},[baudRate]);
  const minHzRef = useRef(displayMinHz);  useEffect(()=>{minHzRef.current=displayMinHz;},[displayMinHz]);
  const maxHzRef = useRef(displayMaxHz);  useEffect(()=>{maxHzRef.current=displayMaxHz;},[displayMaxHz]);
  const selCandRef = useRef(selectedCandidate); useEffect(()=>{selCandRef.current=selectedCandidate;},[selectedCandidate]);
  const candOffsRef  = useRef(candidateOffsets); useEffect(()=>{candOffsRef.current=candidateOffsets;},[candidateOffsets]);
  const setCandTextsRef = useRef(setCandidateTexts);

  const pwrRefs = useRef<Record<string,HTMLDivElement|null>>({});

  // ── drawSpectrum ──────────────────────────────────────────────────────────

  const drawSpectrum = useCallback((canvas: HTMLCanvasElement): Uint8Array|null => {
    const an=getAnalyser(); const ctx=canvas.getContext('2d'); if(!ctx) return null;
    const minHz=minHzRef.current, maxHz=maxHzRef.current;
    ctx.fillStyle='#0a0a0a'; ctx.fillRect(0,0,canvas.width,CANVAS_H);
    if (!an) { drawAxisLabels(ctx,canvas.width,PLOT_H,minHz,maxHz); return null; }
    const bc=an.frequencyBinCount, d=new Uint8Array(bc);
    an.getByteFrequencyData(d);
    const nq=an.context.sampleRate/2;
    // Map the full FFT to just the [minHz, maxHz] window
    const bin0=Math.floor((minHz/nq)*bc);
    const bin1=Math.min(Math.floor((maxHz/nq)*bc), bc);
    const vis=d.subarray(bin0, bin1);
    ctx.globalAlpha=shGRef.current?.30:1;
    ctx.strokeStyle='#2ea043';ctx.lineWidth=1.5;ctx.beginPath();
    const bw=canvas.width/Math.max(1,vis.length);
    for(let i=0;i<vis.length;i++){const x=i*bw,y=PLOT_H-(vis[i]/255)*PLOT_H;i===0?ctx.moveTo(x,y):ctx.lineTo(x,y);}
    ctx.stroke(); ctx.globalAlpha=1;
    const hbw=bwRef.current/2;
    if (shGRef.current) {
      const gs=gsRef.current;
      drawSqGrid(ctx,canvas.width,PLOT_H,vis,sqlRef.current,gs*2,gs,chRef.current,minHz,maxHz,hbw);
    } else if (sqlRef.current>0) {
      const sy=PLOT_H*(1-sqlRef.current/100);
      ctx.lineWidth=1;ctx.setLineDash([4,3]);ctx.strokeStyle='#e3b341';
      ctx.beginPath();ctx.moveTo(0,sy);ctx.lineTo(canvas.width,sy);ctx.stroke();ctx.setLineDash([]);
      ctx.fillStyle='#e3b341';ctx.font='9px monospace';ctx.textAlign='left';
      ctx.fillText(`SQL ${sqlRef.current}%`,12,sy>12?sy-3:sy+12);
    }
    for (const ch of chRef.current) {
      const relBin=Math.round(((ch.freq-minHz)/(maxHz-minHz))*vis.length);
      const tb=Math.max(0,Math.min(vis.length-1,relBin));
      const bar=pwrRefs.current[ch.id]; if(bar) bar.style.width=`${((vis[tb]??0)/255)*100}%`;
      drawChannelMarker(ctx,canvas.width,PLOT_H,ch.freq,ch.color,ch.label,hbw,minHz,maxHz);
    }
    drawAxisLabels(ctx,canvas.width,PLOT_H,minHz,maxHz);
    return vis;
  }, [getAnalyser]);

  const drawSpectrogram = useCallback((canvas: HTMLCanvasElement, fd: Uint8Array) => {
    const ctx=canvas.getContext('2d'); if(!ctx) return;
    const row=ctx.createImageData(canvas.width,1);
    for(let px=0;px<canvas.width;px++){
      const bf=(px/canvas.width)*(fd.length-1),b0=Math.floor(bf),b1=Math.min(b0+1,fd.length-1);
      const v=fd[b0]*(1-(bf-b0))+fd[b1]*(bf-b0),g=sgGRef.current;
      const a=g===1?v:Math.pow(v/255,g)*255;
      let r:number,gr:number,bl:number;
      if(a<128){r=0;gr=0;bl=Math.round(a*2);}else{r=Math.round((a-128)*2);gr=0;bl=Math.round(255-(a-128)*2);}
      const i=px*4; row.data[i]=r;row.data[i+1]=gr;row.data[i+2]=bl;row.data[i+3]=255;
    }
    ctx.putImageData(ctx.getImageData(0,0,canvas.width,canvas.height-1),0,1);
    ctx.putImageData(row,0,0);
  }, []);

  const drawBitCanvas = useCallback((canvas: HTMLCanvasElement) => {
    const ctx=canvas.getContext('2d'); if(!ctx) return;
    const syms=getSymbols();
    const n=Math.max(2,chRef.current.length);
    const bps=Math.max(1,Math.ceil(Math.log2(n)));
    const fw=fwRef.current;

    const cpl = Math.round(fw * bps);
    const totalSym = getSymbolCount();
    const bufOffset = Math.max(0, totalSym - syms.length);
    const completedRows = cpl > 0 ? Math.floor(totalSym * bps / cpl) : 0;
    if (completedRows !== lastRowRef.current) {
      lastRowRef.current = completedRows;
      drawBitGrid(ctx,canvas.width,canvas.height,syms,bps,
        fw,fhRef.current,wwRef.current,sbRef.current,stbRef.current,
        swmRef.current,sbmRef.current,sfmRef.current,
        completedRows, bufOffset);
    }

    // Text decode — incremental, append-only to avoid rewriting in-flight chars
    const opts=doRef.current;
    const isSyncMode = opts.syncMode==='start-bit';
    const words=getWords();
    const newSym=getSymbolCount(), newWrd=words.length;
    if (newSym!==lastDecRef.current || newWrd!==lastWrdRef.current) {
      lastDecRef.current=newSym; lastWrdRef.current=newWrd;
      const enc = encRef.current;
      const isMFSK = enc === 'varicode' && fecRef.current === 'k7r12';

      if (isMFSK && syms.length > 0) {
        // Incremental FEC decode: only append characters past the Viterbi horizon
        const offsets = candOffsRef.current;
        const numTones = chRef.current.length;
        const spacing = brRef.current > 0 ? brRef.current : 1;
        const gray = opts.useGrayCode ?? false;
        if (candCursorsRef.current.length !== offsets.length) {
          candCursorsRef.current = offsets.map(() => makeFECCursor(bps, ildRef.current));
        }
        const texts = offsets.map((off, i) => {
          const shift = Math.round(off / spacing);
          const shiftedSymIds = syms.map(s => {
            const idx = ((s.symbolIndex + shift) % numTones + numTones) % numTones;
            return idx;
          });
          const shiftedPowers = syms.map(s => {
            if (shift === 0) return s.powers;
            const p = s.powers; const n = p.length;
            const rotated = new Array(n);
            for (let j = 0; j < n; j++) rotated[j] = p[((j + shift) % n + n) % n];
            return rotated;
          });
          const { newChars, cursor } = decodeMFSKWithFECIncremental(
            shiftedSymIds, shiftedPowers, candCursorsRef.current[i], bufOffset,
          );
          candCursorsRef.current[i] = cursor;
          return newChars;
        });
        // Append new chars to candidate text state
        const selNew = texts[selCandRef.current] ?? '';
        if (selNew) {
          txtBufRef.current = (txtBufRef.current + selNew).slice(-MAX_TXT);
          if (txtRef.current) {
            txtRef.current.textContent = txtBufRef.current;
            txtRef.current.scrollTop = txtRef.current.scrollHeight;
          }
        }
        if (texts.some(t => t.length > 0)) {
          setCandTextsRef.current(prev => {
            return offsets.map((_, i) => {
              const acc = (prev[i] ?? '') + (texts[i] ?? '');
              return acc.slice(-MAX_TXT);
            });
          });
        }
      } else {
        // Non-FEC paths: full re-decode (no Viterbi in-flight issue)
        let text='';
        if (isSyncMode) {
          text = enc==='baudot'
            ? decodeBaudotFromWords(words, opts.bitOrder==='lsb')
            : words.filter(w=>!w.squelched).map(w=>{
                let byte=0;
                if(opts.bitOrder==='lsb') w.bits.slice(0,8).forEach((b,i)=>{if(b)byte|=1<<i;});
                else w.bits.slice(0,8).forEach((b,i)=>{if(b)byte|=1<<(7-i);});
                return byte>=32&&byte<127?String.fromCharCode(byte):'';
              }).join('');
        } else if (enc==='varicode') {
          const symIds = syms.map(s=>s.symbolIndex);
          text = decodeMFSKVaricode(symIds, bps, opts.useGrayCode ?? false);
        } else {
          text = decodeAsciiFromSymbols(syms,wwRef.current,sbRef.current,stbRef.current,bps);
        }
        // For non-FEC: full text from scratch — truncate to last MAX_TXT chars
        const capped = text.slice(-MAX_TXT);
        if (txtRef.current) {
          txtRef.current.textContent = capped;
          txtRef.current.scrollTop = txtRef.current.scrollHeight;
        }
      }
    }
  }, [getSymbols, getWords, getSymbolCount]);

  // ── Hover overlay ─────────────────────────────────────────────────────────

  const drawHoverOverlay = useCallback((oc: HTMLCanvasElement) => {
    const ctx = oc.getContext('2d'); if (!ctx) return;
    ctx.clearRect(0, 0, oc.width, oc.height);
    const hover = hoverPosRef.current; if (!hover) return;
    const syms = getSymbols(); if (!syms.length) return;

    const n   = Math.max(2, chRef.current.length);
    const bps = Math.max(1, Math.ceil(Math.log2(n)));
    const fw  = fwRef.current;
    const ww  = wwRef.current;
    const cpl = Math.round(fw * bps); if (cpl <= 0) return;
    const wSz = ww > 0 ? Math.round(ww * bps) : 0; if (wSz <= 0) return;

    const cW  = oc.width, cH = oc.height;
    const cWc = cW / cpl;
    const cHc = Math.max(6, Math.min(20, Math.round(cWc * 1.05)));
    const maxV = Math.floor(cH / cHc);

    const totalSym     = getSymbolCount();
    const completedRows = Math.floor(totalSym * bps / cpl);
    const firstRow     = Math.max(0, completedRows - maxV);
    const bufOffset    = Math.max(0, totalSym - syms.length);

    const { x: mx, y: my } = hover;
    const hovRow = Math.floor(my / cHc);
    if (hovRow < 0 || hovRow >= completedRows - firstRow) return;
    const col = Math.floor(mx / cWc);
    if (col < 0 || col >= cpl) return;

    const ri          = firstRow + hovRow;
    const rowStartBit = Math.round(ri * fw) * bps;
    const globalBit   = rowStartBit + col;
    const wordIdx     = Math.floor(globalBit / wSz);
    const wordBitStart = wordIdx * wSz;
    const wordBitEnd   = wordBitStart + wSz;

    ctx.fillStyle   = 'rgba(200,210,255,0.14)';
    ctx.strokeStyle = 'rgba(180,195,255,0.55)';
    ctx.lineWidth   = 1;
    for (let si = firstRow; si < completedRows; si++) {
      const rs  = Math.round(si * fw) * bps;
      const re  = rs + cpl;
      const os  = Math.max(wordBitStart, rs);
      const oe  = Math.min(wordBitEnd, re);
      if (os >= oe) continue;
      const dy  = (si - firstRow) * cHc;
      const x1  = (os - rs) * cWc, x2 = (oe - rs) * cWc;
      ctx.fillRect(x1, dy, x2 - x1, cHc);
      ctx.strokeRect(x1 + 0.5, dy + 0.5, x2 - x1 - 1, cHc - 1);
    }

    const stSz  = Math.round(sbRef.current  * bps);
    const spSz  = Math.round(stbRef.current * bps);
    const dStart = wordBitStart + stSz;
    const dEnd   = wordBitEnd   - spSz;
    const dataBits: boolean[] = [];
    for (let gb = dStart; gb < dEnd; gb++) {
      const buf = gb - bufOffset * bps;
      if (buf < 0 || buf >= syms.length * bps) { dataBits.push(false); continue; }
      dataBits.push(syms[Math.floor(buf / bps)]?.bits[buf % bps] ?? false);
    }

    const opts = doRef.current;
    const lsb  = opts.bitOrder === 'lsb';
    let decoded = '';
    if (encRef.current === 'baudot') {
      const code = bitsToBaudotCode(dataBits, lsb);
      const ch   = decodeBaudotCodePoints([code]);
      decoded = ch || `[${code}]`;
    } else {
      let byte = 0;
      dataBits.slice(0, 8).forEach((b, i) => { if (b) byte |= lsb ? (1 << i) : (1 << (7 - i)); });
      decoded = byte >= 32 && byte < 127 ? String.fromCharCode(byte) : byte === 0 ? 'NUL' : `\\x${byte.toString(16).padStart(2,'0')}`;
    }
    const bitStr = dataBits.map(b => b ? '1' : '0').join('');
    const label  = `"${decoded}"  ${bitStr}`;

    ctx.font = '11px monospace';
    const tw = ctx.measureText(label).width + 14;
    const th = 20;
    const tx = Math.min(mx + 12, cW - tw - 4);
    const ty = my < th + 8 ? my + 8 : my - th - 4;
    ctx.fillStyle   = 'rgba(13,17,23,0.93)';
    ctx.strokeStyle = 'rgba(180,195,255,0.35)';
    ctx.lineWidth   = 1;
    ctx.beginPath(); ctx.roundRect(tx, ty, tw, th, 3); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#c9d1d9';
    ctx.fillText(label, tx + 7, ty + 14);
  }, [getSymbols, getSymbolCount]);

  // ── Animation loop ────────────────────────────────────────────────────────

  useEffect(() => {
    const tick=()=>{
      const sp=specRef.current,sg=sgCanvRef.current,bg=bitRef.current,hc=hoverCanvRef.current;
      if(sp){const fd=drawSpectrum(sp);sgFrmRef.current++;
        if(fd&&sgFrmRef.current%sgSpRef.current===0){if(sg)drawSpectrogram(sg,fd);glSgRef.current?.pushRow(fd);}
      }
      if(bg)drawBitCanvas(bg);
      if(hc)drawHoverOverlay(hc);
      rafRef.current=requestAnimationFrame(tick);
    };
    rafRef.current=requestAnimationFrame(tick);
    return ()=>{if(rafRef.current)cancelAnimationFrame(rafRef.current);};
  }, [drawSpectrum,drawSpectrogram,drawBitCanvas,drawHoverOverlay]);

  // ── Spectrum drag ─────────────────────────────────────────────────────────

  type DM = {type:'squelch'}|{type:'channel';id:string;sf:number;af:Record<string,number>}|null;
  const dmRef=useRef<DM>(null);
  useEffect(()=>{
    const cv=specRef.current; if(!cv) return;
    const sy=()=>{const r=cv.getBoundingClientRect();return r.top+PLOT_H*(1-sqlRef.current/100)*(r.height/CANVAS_H);};
    const nSq=(cy:number)=>sqlRef.current>0&&Math.abs(cy-sy())<10;
    const chX=(f:number)=>{const r=cv.getBoundingClientRect();const mn=minHzRef.current,mx=maxHzRef.current;return r.left+((f-mn)/(mx-mn))*r.width;};
    const nCh=(cx:number)=>{let b:MFSKChannel|null=null,bd=18;for(const ch of chRef.current){const d=Math.abs(cx-chX(ch.freq));if(d<bd){bd=d;b=ch;}}return b;};
    const fX=(cx:number)=>{const r=cv.getBoundingClientRect();const mn=minHzRef.current,mx=maxHzRef.current;return Math.max(mn,Math.min(mx,mn+Math.round((cx-r.left)/r.width*(mx-mn))));};
    const aSq=(cy:number)=>{const r=cv.getBoundingClientRect();const pp=r.height*(PLOT_H/CANVAS_H);setSquelch(Math.max(0,Math.min(100,Math.round((1-Math.max(0,Math.min(1,(cy-r.top)/pp)))*100))));};
    const aF=(id:string,cx:number,sf:number,af:Record<string,number>)=>{
      const nf=fX(cx);
      const mx=maxHzRef.current;
      if(lockRef.current){
        const delta=nf-sf;
        setChannels(p=>p.map(ch=>({...ch,freq:Math.max(50,Math.min(mx,Math.round((af[ch.id]??ch.freq)+delta)))})));
        // compute center for overlay
        const freqs=Object.values(af).map(f=>Math.max(50,Math.min(mx,Math.round(f+delta))));
        if(freqs.length>0) setDraggingCenterFreq(Math.round((Math.min(...freqs)+Math.max(...freqs))/2));
      } else {
        setChannels(p=>p.map(ch=>ch.id===id?{...ch,freq:nf}:ch));
      }
    };
    const startDragCh=(cx:number)=>{
      const ch=nCh(cx); if(!ch) return false;
      const af=Object.fromEntries(chRef.current.map(c=>[c.id,c.freq]));
      dmRef.current={type:'channel',id:ch.id,sf:ch.freq,af};
      aF(ch.id,cx,ch.freq,af); return true;
    };
    const dn=(e:MouseEvent)=>{if(nSq(e.clientY)){dmRef.current={type:'squelch'};aSq(e.clientY);}else startDragCh(e.clientX);};
    const mv=(e:MouseEvent)=>{const m=dmRef.current;if(m?.type==='squelch')aSq(e.clientY);else if(m?.type==='channel')aF(m.id,e.clientX,m.sf,m.af);else{if(nSq(e.clientY))cv.style.cursor='ns-resize';else if(nCh(e.clientX))cv.style.cursor='ew-resize';else cv.style.cursor='crosshair';}};
    const up=()=>{dmRef.current=null; setDraggingCenterFreq(null);};
    const td=(e:TouchEvent)=>{e.preventDefault();const t=e.touches[0];if(nSq(t.clientY)){dmRef.current={type:'squelch'};aSq(t.clientY);}else startDragCh(t.clientX);};
    const tm=(e:TouchEvent)=>{e.preventDefault();const t=e.touches[0];const m=dmRef.current;if(m?.type==='squelch')aSq(t.clientY);else if(m?.type==='channel')aF(m.id,t.clientX,m.sf,m.af);};
    const tu=()=>{dmRef.current=null; setDraggingCenterFreq(null);};
    cv.addEventListener('mousedown',dn);cv.addEventListener('touchstart',td,{passive:false});
    window.addEventListener('mousemove',mv);window.addEventListener('mouseup',up);
    window.addEventListener('touchmove',tm as EventListener,{passive:false});window.addEventListener('touchend',tu);
    return ()=>{cv.removeEventListener('mousedown',dn);cv.removeEventListener('touchstart',td);
      window.removeEventListener('mousemove',mv);window.removeEventListener('mouseup',up);
      window.removeEventListener('touchmove',tm as EventListener);window.removeEventListener('touchend',tu);};
  }, []);

  // ── Channels ──────────────────────────────────────────────────────────────

  const addChannel = () => {
    const i=channels.length;
    const base=channels.length>0?Math.max(...channels.map(c=>c.freq))+200:800;
    setChannels(p=>[...p,{id:makeId(),freq:Math.min(displayMaxHz-100,base),color:DEFAULT_TONE_COLOR,label:`T${i}`}]);
  };
  const removeChannel = (id:string) =>
    setChannels(p=>p.filter(c=>c.id!==id).map((c,i)=>({...c,label:`T${i}`})));
  const updFreq = (id:string,f:number) =>
    setChannels(p=>p.map(c=>c.id===id?{...c,freq:f}:c));
  const updColor = (id:string,color:string) =>
    setChannels(p=>p.map(c=>c.id===id?{...c,color}:c));

  // Move all channels by setting center frequency
  const applyCenterFreq = (newCenter: number) => {
    const current = channels;
    if (current.length === 0) return;
    const freqs = current.map(c => c.freq);
    const curCenter = (Math.min(...freqs) + Math.max(...freqs)) / 2;
    const delta = newCenter - curCenter;
    setChannels(current.map(ch => ({
      ...ch,
      freq: Math.max(50, Math.min(displayMaxHz, Math.round(ch.freq + delta))),
    })));
  };

  // ── Preset apply ──────────────────────────────────────────────────────────

  const applyPreset = (key: string) => {
    const p=PRESETS[key]; if(!p) return;
    setBaudRate(p.baudRate);
    setChannelBw(p.channelBw);
    setChannels(p.channels.map(ch=>({...ch,id:makeId()})));
    setDecoderOpts({...DEFAULT_DECODER_OPTIONS,...p.decoderOpts});
    setEncoding(p.encoding);
    setFec(p.fec);
    setInterleaverDepth(p.interleaverDepth > 0 ? p.interleaverDepth : 10);
    setFrameWidth(p.frameWidth);
    setWordWidth(p.wordWidth);
    setStartBits(p.startBits);
    setStopBits(p.stopBits);
    if (p.candidateOffsets) {
      setCandidateOffsets(p.candidateOffsets);
      setSelectedCandidate(Math.floor(p.candidateOffsets.length / 2));
    }
    setCandidateTexts([]);
    setActivePresetLabel(p.label);
    clearSymbols();
    lastDecRef.current=0; lastWrdRef.current=0;
    candCursorsRef.current=[];
    txtBufRef.current='';
  };

  // ── Derived ───────────────────────────────────────────────────────────────

  const bps       = Math.max(1,Math.ceil(Math.log2(Math.max(2,channels.length))));
  const halfBw    = channelBw/2;
  const glBands   = channels.map(ch=>({fromHz:ch.freq-halfBw,toHz:ch.freq+halfBw,color:ch.color}));
  const glMarkers = channels.map(ch=>({fromHz:ch.freq,toHz:ch.freq,color:ch.color}));
  const dataBits  = Math.max(0,wordWidth-startBits-stopBits)*bps;
  const opts      = decoderOpts;
  const isSyncMode = opts.syncMode==='start-bit';

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-3">

      {/* ── Top bar ── */}
      <div className="bg-[#161b22] border border-[#30363d] rounded-lg p-3 sm:p-4">
        <div className="flex flex-col sm:flex-row gap-2 sm:items-center">
          <div className="flex gap-2">
            {!state.isRecording ? (
              <button onClick={startRecording} disabled={!state.isSupported}
                className="flex-1 sm:flex-none bg-[#238636] hover:bg-[#2ea043] disabled:opacity-50 text-white font-semibold px-5 py-2.5 rounded-md transition-colors text-sm flex items-center gap-2">
                <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM9.555 7.168A1 1 0 008 8v4a1 1 0 001.555.832l3-2a1 1 0 000-1.664l-3-2z" clipRule="evenodd"/></svg>
                Start
              </button>
            ) : (
              <button onClick={stopRecording}
                className="flex-1 sm:flex-none bg-[#da3633] hover:bg-[#f85149] text-white font-semibold px-5 py-2.5 rounded-md transition-colors text-sm flex items-center gap-2">
                <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8 7a1 1 0 00-1 1v4a1 1 0 001 1h4a1 1 0 001-1V8a1 1 0 00-1-1H8z" clipRule="evenodd"/></svg>
                Stop
              </button>
            )}
            <button onClick={() => {
              clearSymbols();
              lastDecRef.current=0; lastWrdRef.current=0;
              candCursorsRef.current=[]; txtBufRef.current='';
              setCandidateTexts([]);
              if (txtRef.current) txtRef.current.textContent='';
            }}
              className="flex-1 sm:flex-none bg-[#21262d] hover:bg-[#30363d] text-white font-semibold px-4 py-2.5 rounded-md transition-colors text-sm border border-[#30363d] flex items-center gap-1.5">
              <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M4 2a1 1 0 011 1v2.101a7.002 7.002 0 0111.601 2.566 1 1 0 11-1.885.666A5.002 5.002 0 005.999 7H9a1 1 0 010 2H4a1 1 0 01-1-1V3a1 1 0 011-1zm.008 9.057a1 1 0 011.276.61A5.002 5.002 0 0014.001 13H11a1 1 0 110-2h5a1 1 0 011 1v5a1 1 0 11-2 0v-2.101a7.002 7.002 0 01-11.601-2.566 1 1 0 01.61-1.276z" clipRule="evenodd"/></svg>
              Clear
            </button>
          </div>
          {(state.isRecording || activePresetLabel) && (
            <div className="text-xs font-mono text-[#8b949e]">
              <span className="text-[#56d364]">{activePresetLabel ?? `MFSK${channels.length}`}</span>
              {state.isRecording && (
                <>
                  {` · ${baudRate} Bd · ${bps} bit/symbol`}
                  {opts.oversampleFactor && opts.oversampleFactor > 1 ? ` · ${opts.oversampleFactor}× OVS` : ''}
                  {isSyncMode ? ` · sync` : ''}
                  {` · ${state.totalSymbols.toLocaleString()} symbols`}
                </>
              )}
            </div>
          )}
          {state.error && <div className="text-[#f85149] text-xs">{state.error}</div>}
        </div>
      </div>

      {/* ── Three panels ── */}
      <div ref={containerRef}
        className="flex flex-col lg:flex-row lg:items-stretch gap-4 lg:gap-0"
        style={{height:'calc(100vh - 260px)',minHeight:'520px'}}>

        {/* ── Panel 1: Output ── */}
        <div className="bg-[#161b22] border border-[#30363d] rounded-lg p-3 sm:p-4 flex flex-col min-w-0 min-h-[340px] lg:min-h-0"
          style={{flex:pW[0]}}>

          {/* Header + decode badges */}
          <div className="shrink-0 mb-2">
            <div className="flex items-center justify-between mb-1.5">
              <h2 className="text-sm font-semibold text-[#c9d1d9]">Output</h2>
              <div className="flex items-center gap-2 text-xs font-mono text-[#8b949e]">
                <span className="text-[#79c0ff]">{bps} bit/symbol</span>
                <span>·</span>
                <span className="text-[#56d364]">{(baudRate*bps).toFixed(1)} bit/s</span>
              </div>
            </div>
            {/* Decode option badges */}
            <div className="flex flex-wrap gap-1 text-[10px]">
              <span className={`px-1.5 py-0.5 rounded border font-mono ${(opts.bitOrder??'msb')==='lsb'?'border-[#ffa657]/40 bg-[#ffa657]/10 text-[#ffa657]':'border-[#79c0ff]/40 bg-[#79c0ff]/10 text-[#79c0ff]'}`}>
                {(opts.bitOrder??'msb').toUpperCase()}-first
              </span>
              <span className={`px-1.5 py-0.5 rounded border font-mono ${isSyncMode?'border-[#56d364]/40 bg-[#56d364]/10 text-[#56d364]':'border-[#484f58]/60 text-[#484f58]'}`}>
                {isSyncMode?`sync · ${opts.stopBitSymbols??1} stop`:'free-run'}
              </span>
              <span className={`px-1.5 py-0.5 rounded border font-mono ${
                encoding==='baudot'?'border-[#d2a8ff]/40 bg-[#d2a8ff]/10 text-[#d2a8ff]':
                encoding==='varicode'?'border-[#79c0ff]/40 bg-[#79c0ff]/10 text-[#79c0ff]':
                'border-[#484f58]/60 text-[#484f58]'}`}>
                {encoding==='baudot'?'Baudot ITA2':encoding==='varicode'?'Varicode':'ASCII'}
              </span>
              {(opts.useGrayCode??false)&&(
                <span className="px-1.5 py-0.5 rounded border border-[#56d364]/40 bg-[#56d364]/10 text-[#56d364] font-mono">Gray</span>
              )}
              {(opts.oversampleFactor??1)>1&&(
                <span className="px-1.5 py-0.5 rounded border border-[#e3b341]/40 bg-[#e3b341]/10 text-[#e3b341] font-mono">{opts.oversampleFactor}× OVS</span>
              )}
              {isSyncMode&&(
                <span className="px-1.5 py-0.5 rounded border border-[#8b949e]/40 bg-[#8b949e]/10 text-[#8b949e] font-mono">{(opts.reverseShift??false)?'LSB':'USB'}</span>
              )}
              {fec==='k7r12'&&(
                <span className="px-1.5 py-0.5 rounded border border-[#ffa657]/40 bg-[#ffa657]/10 text-[#ffa657] font-mono">FEC K7R½</span>
              )}
            </div>
          </div>

          {/* Frame + word controls */}
          <div className="shrink-0 mb-1.5 space-y-1.5">
            <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-[#8b949e] items-center">
              <label className="flex items-center gap-1.5">Row width
                <input type="number" value={frameWidth} min={1} max={512} step={wordWidth > 0 ? wordWidth : 1}
                  onChange={e=>{const v=parseFloat(e.target.value);if(!isNaN(v)&&v>0){const step=wordWidth>0?wordWidth:1;const snapped=Math.max(step,Math.round(v/step)*step);setFrameWidth(Math.min(512,snapped));}}}
                  className="bg-[#0d1117] border border-[#30363d] rounded px-1.5 py-0.5 w-14 font-mono focus:outline-none focus:border-[#2ea043] text-[#c9d1d9]"/>
                cols
              </label>
              <label className="flex items-center gap-1.5">Frame
                <input type="number" value={frameHeight} min={2} max={128} step={2}
                  onChange={e=>{const v=parseInt(e.target.value);if(!isNaN(v))setFrameHeight(Math.max(2,Math.min(128,v)));}}
                  className="bg-[#0d1117] border border-[#30363d] rounded px-1.5 py-0.5 w-12 font-mono focus:outline-none focus:border-[#2ea043] text-[#c9d1d9]"/>
                rows
              </label>
              <span className="text-[#484f58] text-[10px]">= {frameWidth*frameHeight} cols/frame</span>
            </div>
            <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs items-center">
              <label className="flex items-center gap-1.5 text-[#8b949e]">Word
                <input type="number" value={wordWidth} min={2} max={64} step={0.5}
                  onChange={e=>{const v=parseFloat(e.target.value);if(!isNaN(v))setWordWidth(Math.max(2,Math.min(64,v)));}}
                  className="bg-[#0d1117] border border-[#30363d] rounded px-2 py-0.5 w-20 font-mono focus:outline-none focus:border-[#2ea043] text-[#c9d1d9]"/>
                cols
              </label>
              <label className={`flex items-center gap-1.5 ${isSyncMode?'text-[#39d353]':'text-[#56d364]'}`}>Start
                <input type="number" value={startBits} min={0} max={8} step={1}
                  onChange={e=>{const v=parseFloat(e.target.value);if(!isNaN(v))setStartBits(Math.max(0,Math.min(8,v)));}}
                  className={`bg-[#0d1117] border rounded px-2 py-0.5 w-16 font-mono focus:outline-none ${isSyncMode?'border-[#39d353] text-[#39d353] focus:border-[#39d353] shadow-[0_0_0_1px_rgba(57,211,83,0.25)]':'border-[#30363d] text-[#56d364] focus:border-[#56d364]'}`}/>
                {isSyncMode && <span className="w-2 h-2 rounded-full bg-[#39d353] animate-pulse shrink-0"/>}
              </label>
              <label className="flex items-center gap-1.5 text-[#ff7b72]">Stop
                <input type="number" value={stopBits} min={0} max={8} step={0.5}
                  onChange={e=>{const v=parseFloat(e.target.value);if(!isNaN(v))setStopBits(Math.max(0,Math.min(8,v)));}}
                  className="bg-[#0d1117] border border-[#30363d] rounded px-2 py-0.5 w-16 font-mono focus:outline-none focus:border-[#ff7b72] text-[#ff7b72]"/>
              </label>
              <span className="text-[#484f58] text-[10px]">{dataBits} data bits</span>
            </div>
            {wordWidth > 0 && (
              <div className="flex h-5 rounded overflow-hidden border border-[#30363d]/60 text-[9px] font-mono">
                {startBits > 0 && (
                  <div className={`flex items-center justify-center border-r border-[#30363d]/40 shrink-0 ${isSyncMode?'bg-[#39d353]/25 text-[#39d353]':'bg-[#56d364]/15 text-[#56d364]'}`}
                    style={{width:`${(startBits/wordWidth)*100}%`,minWidth:2}}>
                    {isSyncMode && <span className="mr-0.5 text-[8px]">●</span>}
                    {startBits > 1 ? `St×${startBits}` : 'St'}
                  </div>
                )}
                <div className="flex items-center justify-center flex-1 bg-[#30363d]/20 text-[#8b949e] overflow-hidden">
                  {Math.max(0,wordWidth-startBits-stopBits)} data
                </div>
                {stopBits > 0 && (
                  <div className="flex items-center justify-center bg-[#ff7b72]/15 border-l border-[#30363d]/40 text-[#ff7b72] shrink-0"
                    style={{width:`${(stopBits/wordWidth)*100}%`,minWidth:2}}>
                    {stopBits !== 1 ? `Sp×${stopBits}` : 'Sp'}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Toggles */}
          <div className="shrink-0 mb-1.5 flex flex-wrap gap-1.5">
            {([['Frames',showFrameMarkers,setShowFrameMarkers],['Words',showWordMarkers,setShowWordMarkers],['Start/Stop',showBitMarkers,setShowBitMarkers]] as const).map(([l,v,s])=>(
              <button key={l} onClick={()=>(s as React.Dispatch<React.SetStateAction<boolean>>)(x=>!x)}
                className={`px-2 py-0.5 rounded border text-xs transition-colors ${v?'border-[#2ea043]/50 bg-[#238636]/20 text-[#2ea043]':'border-[#30363d] text-[#484f58]'}`}>
                {l}
              </button>
            ))}
          </div>

          {/* Bit grid */}
          <div className="flex-1 min-h-0 relative" style={{minHeight:60}}>
            <canvas ref={bitRef} className="absolute inset-0 w-full h-full rounded bg-[#0d1117]" width={640} height={400}/>
            <canvas ref={hoverCanvRef} width={640} height={400}
              className="absolute inset-0 w-full h-full rounded"
              style={{cursor:'crosshair'}}
              onMouseMove={e=>{
                const r=e.currentTarget.getBoundingClientRect();
                const sx=e.currentTarget.width/r.width, sy=e.currentTarget.height/r.height;
                hoverPosRef.current={x:(e.clientX-r.left)*sx,y:(e.clientY-r.top)*sy};
              }}
              onMouseLeave={()=>{hoverPosRef.current=null;}}
            />
          </div>

          {/* Multi-stream decode candidates */}
          {encoding === 'varicode' && fec === 'k7r12' && (
            <div className="shrink-0 mt-2">
              <div className="flex items-center justify-between mb-1">
                <span className="text-[10px] text-[#484f58] font-mono">Multi-stream candidates</span>
                <span className="text-[10px] text-[#484f58]">click row to select</span>
              </div>
              <div className="border border-[#30363d] rounded overflow-hidden overflow-y-auto" style={{maxHeight:'8rem'}}>
                {candidateOffsets.map((off, i) => (
                  <div key={i}
                    onClick={() => setSelectedCandidate(i)}
                    className={`flex items-center gap-2 px-2 py-1 cursor-pointer transition-colors border-b border-[#30363d]/50 last:border-b-0 ${
                      i === selectedCandidate
                        ? 'bg-[#238636]/20 border-l-2 border-l-[#2ea043]'
                        : 'bg-[#0d1117] hover:bg-[#161b22]'
                    }`}>
                    <span className={`font-mono text-[9px] w-14 shrink-0 ${i===selectedCandidate?'text-[#2ea043]':'text-[#484f58]'}`}>
                      {off >= 0 ? '+' : ''}{off.toFixed(1)} Hz
                    </span>
                    <span className="font-mono text-[10px] text-[#8b949e] flex-1 overflow-hidden whitespace-nowrap" style={{direction:'rtl',textAlign:'left'}}>
                      {candidateTexts[i] ?? '—'}
                    </span>
                    {i === selectedCandidate && (
                      <span className="shrink-0 text-[9px] text-[#2ea043]">▶</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Decoded text */}
          <div className="shrink-0 mt-2">
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs font-semibold text-[#8b949e]">
                Decoded · {isSyncMode
                  ? (encoding==='baudot'?'Baudot ITA2':'ASCII')+' sync'
                  : encoding==='varicode' ? 'Varicode (IZ8BLY)'
                  : 'ASCII free'}
              </span>
              <div className="flex items-center gap-1.5">
                <button onClick={()=>{
                  const t=txtRef.current?.textContent??'';
                  if(t) navigator.clipboard.writeText(t).catch(()=>{});
                }} title="Copy decoded text"
                  className="text-[#484f58] hover:text-[#c9d1d9] transition-colors text-xs px-1.5 py-0.5 rounded border border-[#30363d] hover:border-[#484f58]">
                  copy
                </button>
                <button onClick={()=>{
                  if(txtRef.current) txtRef.current.textContent='';
                  lastDecRef.current=-1; lastWrdRef.current=-1;
                  candCursorsRef.current=[]; txtBufRef.current='';
                  setCandidateTexts([]);
                  clearSymbols();
                }} title="Clear text and buffer"
                  className="text-[#484f58] hover:text-[#c9d1d9] transition-colors text-xs px-1.5 py-0.5 rounded border border-[#30363d] hover:border-[#484f58]">
                  ×
                </button>
              </div>
            </div>
            <pre ref={txtRef}
              className="bg-[#0d1117] border border-[#30363d] rounded px-2 py-1.5 text-xs font-mono text-[#c9d1d9] overflow-auto whitespace-pre-wrap break-all"
              style={{height: '6rem'}}>
            </pre>
          </div>
        </div>

        {/* Handle 0↔1 */}
        <div className="hidden lg:flex w-3 self-stretch cursor-col-resize items-center justify-center group shrink-0" onMouseDown={e=>startDrag(e,0)}>
          <div className="w-px h-full bg-[#30363d] group-hover:bg-[#2ea043]/50 transition-colors"/>
        </div>

        {/* ── Panel 2: Audio ── */}
        <div className="bg-[#161b22] border border-[#30363d] rounded-lg p-3 sm:p-4 flex flex-col min-w-0 min-h-[350px] lg:min-h-0"
          style={{flex:pW[1]}}>
          <h2 className="text-sm font-semibold text-[#c9d1d9] mb-2 shrink-0">Audio Analysis</h2>
          <div className="shrink-0">
            {/* Center freq input */}
            <div className="flex items-center gap-2 mb-1.5 text-xs text-[#8b949e]">
              <span className="shrink-0">Center</span>
              <input
                type="number" min={50} max={displayMaxHz} step={1}
                value={draggingCenterFreq !== null ? draggingCenterFreq : centerFreqInput || centerFreq}
                onChange={e => {
                  setCenterFreqInput(e.target.value);
                }}
                onBlur={e => {
                  const v = parseFloat(e.target.value);
                  if (!isNaN(v)) applyCenterFreq(Math.max(50, Math.min(displayMaxHz, v)));
                  setCenterFreqInput('');
                }}
                onKeyDown={e => {
                  if (e.key === 'Enter') {
                    const v = parseFloat((e.target as HTMLInputElement).value);
                    if (!isNaN(v)) applyCenterFreq(Math.max(50, Math.min(displayMaxHz, v)));
                    setCenterFreqInput('');
                  }
                }}
                className={`w-20 bg-[#0d1117] border rounded px-2 py-0.5 font-mono text-[#c9d1d9] focus:outline-none focus:border-[#2ea043] ${
                  draggingCenterFreq !== null ? 'border-[#2ea043] shadow-[0_0_0_1px_rgba(46,160,67,0.3)]' : 'border-[#30363d]'
                }`}
              />
              <span className="shrink-0 text-[#484f58]">Hz</span>
              {draggingCenterFreq !== null && (
                <span className="text-[#2ea043] text-[10px] font-mono animate-pulse">dragging…</span>
              )}
              <span className="text-[#484f58] text-[10px] ml-auto">
                {channels.length} tone{channels.length !== 1 ? 's' : ''}
              </span>
            </div>
            <canvas ref={specRef} width={640} height={CANVAS_H}
              className="w-full border border-[#30363d] rounded bg-[#0a0a0a] touch-manipulation block cursor-crosshair"/>
            {/* Frequency view range */}
            <div className="flex items-center gap-1.5 mt-1 text-[10px] text-[#8b949e]">
              <span className="shrink-0">View</span>
              <input type="number" min={0} max={displayMaxHz-100} step={100}
                value={displayMinHz}
                onChange={e=>{const v=parseInt(e.target.value);if(!isNaN(v))setDisplayMinHz(Math.max(0,Math.min(displayMaxHz-100,v)));}}
                className="w-16 bg-[#0d1117] border border-[#30363d] rounded px-1.5 py-0.5 font-mono text-[#c9d1d9] focus:outline-none focus:border-[#2ea043]"/>
              <span className="shrink-0 text-[#484f58]">–</span>
              <input type="number" min={displayMinHz+100} max={24000} step={100}
                value={displayMaxHz}
                onChange={e=>{const v=parseInt(e.target.value);if(!isNaN(v))setDisplayMaxHz(Math.max(displayMinHz+100,Math.min(24000,v)));}}
                className="w-16 bg-[#0d1117] border border-[#30363d] rounded px-1.5 py-0.5 font-mono text-[#c9d1d9] focus:outline-none focus:border-[#2ea043]"/>
              <span className="shrink-0 text-[#484f58]">Hz</span>
              {[1000,2000,3000,4000].map(mx=>(
                <button key={mx} onClick={()=>{setDisplayMinHz(0);setDisplayMaxHz(mx);}}
                  className={`px-1.5 py-0.5 rounded border text-[9px] transition-colors ${displayMinHz===0&&displayMaxHz===mx?'border-[#2ea043]/50 bg-[#238636]/20 text-[#2ea043]':'border-[#30363d] text-[#484f58] hover:text-[#8b949e]'}`}>
                  {mx/1000}k
                </button>
              ))}
            </div>
            <div className="flex items-center justify-between mt-0.5">
              <p className="text-[10px] text-[#484f58]">Drag channel markers (↔) · Drag squelch boundary (↕)</p>
              <button onClick={()=>setLockChannels(v=>!v)}
                title={lockChannels?'Channels move together — click to unlock':'Channels move independently — click to lock'}
                className={`flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] transition-colors ${
                  lockChannels?'border-[#2ea043]/50 bg-[#238636]/20 text-[#2ea043]':'border-[#30363d] text-[#484f58] hover:text-[#8b949e]'
                }`}>
                {lockChannels ? (
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z" clipRule="evenodd"/></svg>
                ) : (
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3" viewBox="0 0 20 20" fill="currentColor"><path d="M10 2a5 5 0 00-5 5v2a2 2 0 00-2 2v5a2 2 0 002 2h10a2 2 0 002-2v-5a2 2 0 00-2-2H7V7a3 3 0 015.905-.75 1 1 0 001.937-.5A5.002 5.002 0 0010 2z"/></svg>
                )}
                {lockChannels ? 'Locked' : 'Free'}
              </button>
            </div>
          </div>
          <div className="flex flex-col flex-1 gap-2 mt-3 min-h-0">
            <h3 className="text-xs font-medium text-[#8b949e] shrink-0">Spectrogram</h3>
            <div ref={sgContainerRef} className="relative flex-1 min-h-[100px]">
              <div className={sgView==='legacy'?'block':'hidden'}>
                <canvas ref={sgCanvRef} width={640} height={sgH} style={{height:sgH}} className="w-full border border-[#30363d] rounded bg-[#0d1117] block"/>
                {channels.map(ch=>{const span=displayMaxHz-displayMinHz;const pct=((ch.freq-displayMinHz)/span)*100,bwP=(channelBw/span)*100,[r,g,b]=hexToRgb(ch.color);return(
                  <div key={ch.id} className="absolute inset-y-0 pointer-events-none" style={{left:`${Math.max(0,pct-bwP/2)}%`,width:`${bwP}%`,backgroundColor:`rgba(${r},${g},${b},.07)`,borderLeft:`1px solid rgba(${r},${g},${b},.28)`,borderRight:`1px solid rgba(${r},${g},${b},.28)`}}/>
                );})}
              </div>
              <div className={sgView!=='legacy'?'block':'hidden'}>
                <GLSpectrogram ref={glSgRef} view={sgView==='legacy'?'terrain':sgView}
                  gamma={sgGamma} height={sgH} maxHz={displayMaxHz} minHz={displayMinHz} bands={glBands}
                  bandAlpha={bandAlpha} markers={glMarkers} sqlLevel={squelch/100} sqlAlpha={0.6}
                  sqlGridSize={showGrid?gridSize:undefined}/>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-3 text-xs text-[#8b949e] shrink-0">
              <label className="flex items-center gap-1.5">View
                <select value={sgView} onChange={e=>setSgView(e.target.value as SpectrogramView)}
                  className="bg-[#0d1117] border border-[#30363d] rounded px-1.5 py-0.5 text-[#c9d1d9] focus:outline-none focus:border-[#2ea043] cursor-pointer">
                  <option value="terrain">3D Terrain</option>
                  <option value="ridge">Ridgeline</option>
                  <option value="legacy">Classic 2D</option>
                </select>
              </label>
              {sgView!=='legacy'&&<label className="flex items-center gap-1.5">Range<input type="range" min={0} max={1} step={0.05} value={bandAlpha} onChange={e=>setBandAlpha(parseFloat(e.target.value))} className="w-14 accent-[#2ea043]"/></label>}
              <label className="flex items-center gap-1.5">Contrast<input type="range" min={0.5} max={6} step={0.25} value={sgGamma} onChange={e=>setSgGamma(parseFloat(e.target.value))} className="w-14 accent-[#2ea043]"/></label>
              <label className="flex items-center gap-1.5">Speed
                <select value={sgSpeed} onChange={e=>setSgSpeed(parseInt(e.target.value))}
                  className="bg-[#0d1117] border border-[#30363d] rounded px-1.5 py-0.5 text-[#c9d1d9] focus:outline-none focus:border-[#2ea043] cursor-pointer">
                  <option value={1}>1×</option><option value={2}>2×</option><option value={4}>4×</option><option value={8}>8×</option>
                </select>
              </label>
            </div>
          </div>
        </div>

        {/* Handle 1↔2 */}
        <div className="hidden lg:flex w-3 self-stretch cursor-col-resize items-center justify-center group shrink-0" onMouseDown={e=>startDrag(e,1)}>
          <div className="w-px h-full bg-[#30363d] group-hover:bg-[#2ea043]/50 transition-colors"/>
        </div>

        {/* ── Panel 3: Decoder ── */}
        <div className="bg-[#161b22] border border-[#30363d] rounded-lg p-3 sm:p-4 flex flex-col min-w-0 min-h-[280px] lg:min-h-0"
          style={{flex:pW[2]}}>

          <h2 className="text-sm font-semibold text-[#c9d1d9] mb-2.5 shrink-0">Decoder</h2>

          {/* Preset */}
          <div className="shrink-0 mb-3 pb-3 border-b border-[#30363d]">
            <label className="text-xs text-[#8b949e] block mb-1">Preset</label>
            <select defaultValue=""
              onChange={e=>{if(e.target.value){applyPreset(e.target.value);e.target.value='';}}}
              className="w-full bg-[#0d1117] border border-[#30363d] rounded px-2 py-1.5 text-sm text-[#c9d1d9] focus:outline-none focus:border-[#2ea043] cursor-pointer">
              <option value="">— load preset —</option>
              <optgroup label="── RTTY ──">
                {['rtty-45-170','rtty-50-170','rtty-75-170','rtty-50-450','rtty-50-850'].map(k=>(
                  <option key={k} value={k}>{PRESETS[k].label}</option>
                ))}
              </optgroup>
              <optgroup label="── fldigi MFSK (FEC, varicode) ──">
                {['mfsk4','mfsk8','mfsk16','mfsk32','mfsk64','mfsk128'].map(k=>(
                  <option key={k} value={k}>{PRESETS[k].label}</option>
                ))}
              </optgroup>
              <optgroup label="── Classic MFSK (IZ8BLY, no FEC) ──">
                {['classic-mfsk4','classic-mfsk8','classic-mfsk16','classic-mfsk32'].map(k=>(
                  <option key={k} value={k}>{PRESETS[k].label}</option>
                ))}
              </optgroup>
              <optgroup label="── Wavecom MFSK (approx params) ──">
                {['wavecom-mfsk11','wavecom-mfsk22','wavecom-mfsk31'].map(k=>(
                  <option key={k} value={k}>{PRESETS[k].label}</option>
                ))}
              </optgroup>
            </select>
          </div>

          {/* Decoder params */}
          <div className="shrink-0 space-y-2 mb-3 pb-3 border-b border-[#30363d]">
            <div className="flex items-center gap-2 text-xs">
              <span className="text-[#8b949e] w-16 shrink-0">Baud rate</span>
              <input type="number" value={baudRate} min={0.1} max={10000} step={0.1}
                onChange={e=>{const v=parseFloat(e.target.value);if(!isNaN(v)&&v>0)setBaudRate(v);}}
                className="flex-1 bg-[#0d1117] border border-[#30363d] rounded px-2 py-1 font-mono text-[#c9d1d9] focus:outline-none focus:border-[#2ea043] min-w-0"/>
              <span className="text-[#484f58] shrink-0">Bd</span>
            </div>
            <div className="flex items-center gap-2 text-xs">
              <span className="text-[#8b949e] w-16 shrink-0">Band width</span>
              <input type="number" value={channelBw} min={5} max={1000} step={5}
                onChange={e=>{const v=parseFloat(e.target.value);if(!isNaN(v))setChannelBw(Math.max(5,Math.min(1000,v)));}}
                className="flex-1 bg-[#0d1117] border border-[#30363d] rounded px-2 py-1 font-mono text-[#c9d1d9] focus:outline-none focus:border-[#2ea043] min-w-0"/>
              <span className="text-[#484f58] shrink-0">Hz</span>
            </div>
            <div className="flex items-center gap-2 text-xs">
              <span className="text-[#8b949e] w-16 shrink-0">Squelch</span>
              <input type="range" min={0} max={100} step={1} value={squelch}
                onChange={e=>setSquelch(parseInt(e.target.value))} className="flex-1 accent-[#e3b341]"/>
              <span className="font-mono text-[#e3b341] w-8 text-right shrink-0">{squelch}%</span>
            </div>
            <div className="flex items-center gap-2 text-xs">
              <span className="text-[#8b949e] w-16 shrink-0">Sq. grid</span>
              <Toggle checked={showGrid} onChange={()=>setShowGrid(v=>!v)}/>
              {showGrid&&<><input type="range" min={6} max={96} step={2} value={gridSize} onChange={e=>setGridSize(parseInt(e.target.value))} className="flex-1 accent-[#e3b341]"/><span className="font-mono text-[#484f58] text-[10px] w-10 text-right shrink-0">{gridSize*2}×{gridSize}</span></>}
            </div>
          </div>

          {/* Decode options */}
          <div className="shrink-0 space-y-2 mb-3 pb-3 border-b border-[#30363d]">
            <p className="text-[10px] font-semibold text-[#484f58] uppercase tracking-wide">Decode Options</p>

            <div className="flex items-center gap-2 text-xs">
              <span className="text-[#8b949e] w-16 shrink-0">Bit order</span>
              <SegBtn options={[{label:'MSB',value:'msb'},{label:'LSB',value:'lsb'}]}
                value={opts.bitOrder??'msb'}
                onChange={v=>setDecoderOpts(o=>({...o,bitOrder:v as 'msb'|'lsb'}))}/>
            </div>

            <div className="flex items-center gap-2 text-xs">
              <span className="text-[#8b949e] w-16 shrink-0">Oversample</span>
              <SegBtn options={[{label:'1×',value:1},{label:'2×',value:2},{label:'4×',value:4}]}
                value={opts.oversampleFactor??1}
                onChange={v=>setDecoderOpts(o=>({...o,oversampleFactor:v as number}))}/>
            </div>

            <div className="flex items-center gap-2 text-xs">
              <span className="text-[#8b949e] w-16 shrink-0">Sync mode</span>
              <SegBtn options={[{label:'Free',value:'free'},{label:'Start-bit',value:'start-bit'}]}
                value={opts.syncMode??'free'}
                onChange={v=>setDecoderOpts(o=>({...o,syncMode:v as 'free'|'start-bit'}))}/>
            </div>

            {isSyncMode && (
              <>
                <div className="flex items-center gap-2 text-xs">
                  <span className="text-[#8b949e] w-16 shrink-0">Stop bits</span>
                  <SegBtn options={[{label:'1',value:1},{label:'1.5',value:1.5},{label:'2',value:2}]}
                    value={opts.stopBitSymbols??1}
                    onChange={v=>setDecoderOpts(o=>({...o,stopBitSymbols:v as number}))}/>
                </div>
                <div className="flex items-center gap-2 text-xs">
                  <span className="text-[#8b949e] w-16 shrink-0">Char bits</span>
                  <input type="number" value={opts.charBits??8} min={5} max={8}
                    onChange={e=>{const v=parseInt(e.target.value);if(!isNaN(v))setDecoderOpts(o=>({...o,charBits:Math.max(5,Math.min(8,v))}));}}
                    className="w-16 bg-[#0d1117] border border-[#30363d] rounded px-2 py-0.5 font-mono text-[#c9d1d9] focus:outline-none focus:border-[#2ea043]"/>
                  <span className="text-[#484f58]">bits</span>
                </div>
                <div className="flex items-center gap-2 text-xs">
                  <span className="text-[#8b949e] w-16 shrink-0">Sideband</span>
                  <SegBtn options={[{label:'USB',value:0},{label:'LSB',value:1}]}
                    value={(opts.reverseShift??false)?1:0}
                    onChange={v=>setDecoderOpts(o=>({...o,reverseShift:v===1}))}/>
                  <span className="text-[#484f58] text-[10px]">{(opts.reverseShift??false)?'ch0=Sp':'ch0=Mk'}</span>
                </div>
              </>
            )}

            <div className="flex items-center gap-2 text-xs">
              <span className="text-[#8b949e] w-16 shrink-0">Encoding</span>
              <SegBtn options={[{label:'ASCII',value:'ascii'},{label:'Varicode',value:'varicode'},{label:'Baudot',value:'baudot'}]}
                value={encoding}
                onChange={v=>setEncoding(v as Encoding)}/>
            </div>

            {!isSyncMode && (
              <div className="flex items-center gap-2 text-xs">
                <span className="text-[#8b949e] w-16 shrink-0">Gray code</span>
                <Toggle checked={opts.useGrayCode??false}
                  onChange={()=>setDecoderOpts(o=>({...o,useGrayCode:!(o.useGrayCode??false)}))}/>
                <span className="text-[#484f58] text-[10px]">MFSK tone→bits</span>
              </div>
            )}

            {encoding==='varicode' && !isSyncMode && (
              <>
                <div className="flex items-center gap-2 text-xs">
                  <span className="text-[#8b949e] w-16 shrink-0">FEC</span>
                  <SegBtn options={[{label:'None',value:'none'},{label:'K7 R½',value:'k7r12'}]}
                    value={fec}
                    onChange={v=>setFec(v as FECMode)}/>
                </div>
                {fec==='k7r12' && (
                  <div className="flex items-center gap-2 text-xs">
                    <span className="text-[#8b949e] w-16 shrink-0">IL depth</span>
                    <input type="number" value={interleaverDepth} min={1} max={100} step={1}
                      onChange={e=>{const v=parseInt(e.target.value);if(!isNaN(v)&&v>0)setInterleaverDepth(v);}}
                      className="w-16 bg-[#0d1117] border border-[#30363d] rounded px-2 py-0.5 font-mono text-[#c9d1d9] focus:outline-none focus:border-[#2ea043]"/>
                    <span className="text-[#484f58] text-[10px]">symbols</span>
                  </div>
                )}
              </>
            )}
          </div>

          {/* Tones */}
          <div className="flex items-center justify-between mb-1.5 shrink-0">
            <span className="text-xs font-semibold text-[#8b949e]">Tones ({channels.length})</span>
            <button onClick={addChannel} disabled={channels.length>=128}
              className="flex items-center gap-1 text-xs px-2 py-0.5 bg-[#238636] hover:bg-[#2ea043] disabled:opacity-40 disabled:cursor-not-allowed text-white rounded transition-colors">
              <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M10 3a1 1 0 011 1v5h5a1 1 0 110 2h-5v5a1 1 0 11-2 0v-5H4a1 1 0 110-2h5V4a1 1 0 011-1z" clipRule="evenodd"/></svg>
              Add
            </button>
          </div>

          <div className="flex-1 overflow-y-auto space-y-0.5 pr-0.5">
            {channels.length===0 && (
              <p className="text-[#484f58] text-xs text-center py-3">Add a tone to start decoding.</p>
            )}
            {channels.map((ch, i) => (
              <ToneRow
                key={ch.id}
                ch={ch}
                index={i}
                total={channels.length}
                maxHz={displayMaxHz}
                onRemove={() => removeChannel(ch.id)}
                onFreqChange={f => updFreq(ch.id, f)}
                onColorChange={c => updColor(ch.id, c)}
                pwrRef={el => { pwrRefs.current[ch.id] = el; }}
              />
            ))}
          </div>

          <div className="mt-2 pt-2 border-t border-[#30363d] shrink-0">
            <div className="text-[10px] font-mono text-[#484f58] text-center">
              {channels.length} tones · {bps} bit/symbol · {(baudRate*bps).toFixed(1)} bit/s
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}
