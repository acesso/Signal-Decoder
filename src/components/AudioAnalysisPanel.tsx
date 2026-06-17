'use client';

import { useRef, useEffect, useState, useCallback } from 'react';
import type React from 'react';
import GLSpectrogram, { GLSpectrogramHandle, GLView } from './GLSpectrogram';
import type { MFSKChannel } from '@/lib/mfsk/decoder';

type SpectrogramView = 'legacy' | GLView;

// ── Canvas helpers (copied from MFSKDecoder) ──────────────────────────────────

const CANVAS_H = 200;
const AXIS_H   = 25;
const PLOT_H   = CANVAS_H - AXIS_H;

function hexToRgb(hex: string): [number, number, number] {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return [isNaN(r) ? 100 : r, isNaN(g) ? 100 : g, isNaN(b) ? 100 : b];
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
  channels: AudioMarker[], minHz: number, maxHz: number, halfBw: number,
) {
  const span = maxHz - minHz;
  const cH = pH / gRows; const cWc = cW / gCols; const sqlF = sql / 100;
  const colCh: (AudioMarker | null)[] = Array(gCols).fill(null);
  for (let c = 0; c < gCols; c++) {
    const cf = minHz + ((c + 0.5) / gCols) * span;
    for (const ch of channels) {
      const bw = halfBw; // use the shared halfBw for simple markers
      if (cf >= ch.freq - bw && cf <= ch.freq + bw) { colCh[c] = ch; break; }
    }
  }
  for (let c = 0; c < gCols; c++) {
    const f0 = Math.floor((c / gCols) * fd.length);
    const f1 = Math.min(Math.ceil(((c+1)/gCols)*fd.length), fd.length);
    let pk = 0; for (let f = f0; f < f1; f++) if (fd[f] > pk) pk = fd[f];
    const aF = pk / 255;
    const col = colCh[c];
    const [lr, lg, lb] = col ? hexToRgb(col.color) : [227, 179, 65];
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

// ── Signal meter ──────────────────────────────────────────────────────────────

function SignalMeter({ envelopeLevel }: { envelopeLevel: number }) {
  const db  = envelopeLevel > 1e-9 ? 20 * Math.log10(envelopeLevel) : -80;
  const pct = Math.max(0, Math.min(100, Math.round(((db + 80) / 60) * 100)));
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-[#8b949e]">Signal</span>
      <div className="flex items-center gap-1">
        {[0, 1, 2, 3, 4].map((bar) => {
          const isActive = pct > bar * 20;
          const color = !isActive ? 'bg-[#21262d]'
            : pct < 30 ? 'bg-[#da3633]'
            : pct < 60 ? 'bg-[#e3b341]'
            : 'bg-[#2ea043]';
          return <div key={bar} className={`w-1.5 sm:w-2 rounded-sm transition-colors ${color}`} style={{ height: `${8 + bar * 3}px` }} />;
        })}
      </div>
      <span className="text-xs font-mono text-[#c9d1d9] min-w-[3ch]">{pct}%</span>
    </div>
  );
}

// ── Public interface ──────────────────────────────────────────────────────────

export interface AudioMarker {
  freq: number;
  color: string;
  label: string;
  bandwidthHz?: number;
}

export interface AudioAnalysisPanelProps {
  analyser: AnalyserNode | null;
  isRecording: boolean;
  markers?: AudioMarker[];
  /** Called when the user drags a marker to a new frequency (index = position in markers array) */
  onMarkerDrag?: (index: number, newFreq: number) => void;
  squelch?: number;
  onSquelchChange?: (v: number) => void;
  showGrid?: boolean;
  gridSize?: number;
  signalLevel?: number;
  /** Initial max Hz for the view range (default 3000) */
  defaultMaxHz?: number;
  /** Optional MFSKChannel array for the GL spectrogram bands (advanced usage) */
  glBands?: MFSKChannel[];
  /** Extra CSS classes applied to the root card div (e.g. flex sizing) */
  className?: string;
  style?: React.CSSProperties;
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function AudioAnalysisPanel({
  analyser,
  isRecording,
  markers = [],
  onMarkerDrag,
  squelch = 0,
  onSquelchChange,
  showGrid = false,
  gridSize = 48,
  signalLevel = 0,
  defaultMaxHz = 3000,
  glBands,
  className,
  style,
}: AudioAnalysisPanelProps) {
  const [displayMinHz, setDisplayMinHz] = useState(0);
  const [displayMaxHz, setDisplayMaxHz] = useState(defaultMaxHz);
  const [lockCenter,   setLockCenter]   = useState(true);
  const [centerFreqInput, setCenterFreqInput] = useState('');
  const [sgView,    setSgView]    = useState<SpectrogramView>('terrain');
  const [sgGamma,   setSgGamma]   = useState(1.0);
  const [sg3dSpeed, setSg3dSpeed] = useState(80);    // GL/3D: ms between rows, default Normal
  const [sg2dSpeed, setSg2dSpeed] = useState(50);    // 2D canvas: ms between rows, default Normal
  const [sg3dSmooth, setSg3dSmooth] = useState(0.35);
  const [bandAlpha, setBandAlpha] = useState(0.3);

  const specRef        = useRef<HTMLCanvasElement>(null);
  const sgCanvRef      = useRef<HTMLCanvasElement>(null);
  const glSgRef        = useRef<GLSpectrogramHandle>(null);
  const rafRef         = useRef<number | null>(null);
  const sgContainerRef = useRef<HTMLDivElement>(null);
  const [sgH, setSgH]  = useState(300);
  const sgHRef         = useRef(300);

  // Live refs for use inside the animation callback
  const minHzRef    = useRef(displayMinHz);
  const maxHzRef    = useRef(displayMaxHz);
  const markersRef  = useRef(markers);
  const squelchRef  = useRef(squelch);
  const showGridRef = useRef(showGrid);
  const gridSzRef   = useRef(gridSize);
  const sgGRef        = useRef(sgGamma);
  const sg3dSpRef     = useRef(80);   // GL rows
  const sg2dSpRef     = useRef(50);   // 2D canvas rows
  const sg3dLastTs    = useRef(0);
  const sg2dLastTs    = useRef(0);
  const spLastTs      = useRef(0);
  const fftBuf        = useRef<Uint8Array<ArrayBuffer> | null>(null);
  const squelchDragRef = useRef(false);
  const onSquelchChangeRef = useRef(onSquelchChange);

  // Marker drag state
  const onMarkerDragRef  = useRef(onMarkerDrag);
  const markerDragRef    = useRef<{ index: number } | null>(null);
  useEffect(() => { onMarkerDragRef.current = onMarkerDrag; }, [onMarkerDrag]);

  useEffect(() => { minHzRef.current   = displayMinHz; }, [displayMinHz]);
  useEffect(() => { maxHzRef.current   = displayMaxHz; }, [displayMaxHz]);
  useEffect(() => { markersRef.current = markers; }, [markers]);
  useEffect(() => { squelchRef.current = squelch; }, [squelch]);
  useEffect(() => { showGridRef.current = showGrid; }, [showGrid]);
  useEffect(() => { gridSzRef.current  = gridSize; }, [gridSize]);
  useEffect(() => { sgGRef.current         = sgGamma;    }, [sgGamma]);
  useEffect(() => { sg3dSpRef.current = sg3dSpeed; glSgRef.current?.setRowInterval(sg3dSpeed); }, [sg3dSpeed]);
  useEffect(() => { sg2dSpRef.current      = sg2dSpeed;  }, [sg2dSpeed]);
  useEffect(() => { glSgRef.current?.setSmooth(sg3dSmooth); }, [sg3dSmooth]);
  useEffect(() => { onSquelchChangeRef.current = onSquelchChange; }, [onSquelchChange]);

  // Spectrum canvas mouse handlers — marker drag + squelch line drag
  const handleSpectrumMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = specRef.current; if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const yRatio = (e.clientY - rect.top) / rect.height;
    const canvasY = yRatio * CANVAS_H;

    // Check squelch line hit first (within 8px, when squelch control is wired)
    const sql = squelchRef.current;
    if (onSquelchChangeRef.current && sql > 0) {
      const sqY = PLOT_H * (1 - sql / 100);
      if (Math.abs(canvasY - sqY) <= 8) {
        e.preventDefault();
        e.stopPropagation();
        squelchDragRef.current = true;
        return;
      }
    }
    // Also allow starting squelch drag when clicking in the plot area near threshold
    // even if squelch is 0, as long as onSquelchChange is available — handled in mousemove

    // Marker drag
    if (!onMarkerDragRef.current) return;
    const ms = markersRef.current;
    if (!ms.length) return;
    const xRatio = (e.clientX - rect.left) / rect.width;
    const clickHz = minHzRef.current + xRatio * (maxHzRef.current - minHzRef.current);
    // Find closest marker — no distance cap, always grab the nearest
    let best = 0, bestDist = Infinity;
    for (let i = 0; i < ms.length; i++) {
      const d = Math.abs(ms[i].freq - clickHz);
      if (d < bestDist) { bestDist = d; best = i; }
    }
    e.preventDefault();
    e.stopPropagation();
    markerDragRef.current = { index: best };
  }, []);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      // Squelch drag
      if (squelchDragRef.current && onSquelchChangeRef.current) {
        e.preventDefault();
        const canvas = specRef.current; if (!canvas) return;
        const rect = canvas.getBoundingClientRect();
        const yRatio = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
        // yRatio=0 → top of canvas (plot area top = 100%), yRatio → PLOT_H/CANVAS_H at bottom of plot
        const plotFraction = yRatio * (CANVAS_H / PLOT_H);
        const newSql = Math.round(Math.max(0, Math.min(100, (1 - plotFraction) * 100)));
        onSquelchChangeRef.current(newSql);
        return;
      }
      // Marker drag
      const drag = markerDragRef.current;
      if (!drag || !onMarkerDragRef.current) return;
      e.preventDefault();
      const canvas = specRef.current; if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const xRatio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      const newHz  = Math.round(minHzRef.current + xRatio * (maxHzRef.current - minHzRef.current));
      onMarkerDragRef.current(drag.index, newHz);
    };
    const onUp = () => { markerDragRef.current = null; squelchDragRef.current = false; };
    window.addEventListener('mousemove', onMove, { passive: false });
    window.addEventListener('mouseup',   onUp);
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
  }, []);

  // Spectrogram container height observer
  useEffect(() => {
    const el = sgContainerRef.current; if (!el) return;
    const ro = new ResizeObserver(e => {
      const h = Math.round(e[0].contentRect.height);
      if (h > 60 && Math.abs(h - sgHRef.current) > 4) { sgHRef.current = h; setSgH(h); }
    });
    ro.observe(el); return () => ro.disconnect();
  }, []);

  // Compute center from markers
  const centerFreq = markers.length
    ? Math.round(markers.reduce((s, m) => s + m.freq, 0) / markers.length)
    : Math.round((displayMinHz + displayMaxHz) / 2);

  // Apply center-frequency shift to all markers (propagates via onSquelchChange-style callback if needed)
  // In this panel we just track center for the input display — the parent drives marker positions.

  const drawSpectrum = useCallback((canvas: HTMLCanvasElement): Uint8Array | null => {
    const ctx = canvas.getContext('2d'); if (!ctx) return null;
    const minHz = minHzRef.current, maxHz = maxHzRef.current;
    ctx.fillStyle = '#0a0a0a'; ctx.fillRect(0, 0, canvas.width, CANVAS_H);
    if (!analyser) { drawAxisLabels(ctx, canvas.width, PLOT_H, minHz, maxHz); return null; }

    const bc = analyser.frequencyBinCount;
    if (!fftBuf.current || fftBuf.current.length !== bc) fftBuf.current = new Uint8Array(bc) as Uint8Array<ArrayBuffer>;
    const d = fftBuf.current;
    analyser.getByteFrequencyData(d);
    const nq   = analyser.context.sampleRate / 2;
    const bin0 = Math.floor((minHz / nq) * bc);
    const bin1 = Math.min(Math.floor((maxHz / nq) * bc), bc);
    const vis  = d.subarray(bin0, bin1);

    const ms = markersRef.current;
    ctx.globalAlpha = showGridRef.current ? 0.30 : 1;
    ctx.strokeStyle = '#2ea043'; ctx.lineWidth = 1.5; ctx.beginPath();
    const bw = canvas.width / Math.max(1, vis.length);
    for (let i = 0; i < vis.length; i++) {
      const x = i * bw, y = PLOT_H - (vis[i] / 255) * PLOT_H;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke(); ctx.globalAlpha = 1;

    if (showGridRef.current) {
      const gs = gridSzRef.current;
      // Derive a halfBw from the first marker's bandwidthHz or fall back to a default
      const halfBw = ms.length > 0 && ms[0].bandwidthHz != null
        ? ms[0].bandwidthHz / 2
        : 40;
      drawSqGrid(ctx, canvas.width, PLOT_H, vis, squelchRef.current, gs * 2, gs, ms, minHz, maxHz, halfBw);
    } else if (squelchRef.current > 0) {
      const sy = PLOT_H * (1 - squelchRef.current / 100);
      ctx.lineWidth = 1; ctx.setLineDash([4, 3]); ctx.strokeStyle = '#e3b341';
      ctx.beginPath(); ctx.moveTo(0, sy); ctx.lineTo(canvas.width, sy); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = '#e3b341'; ctx.font = '9px monospace'; ctx.textAlign = 'left';
      ctx.fillText(`SQL ${squelchRef.current}%`, 12, sy > 12 ? sy - 3 : sy + 12);
    }

    for (const m of ms) {
      const halfBw = m.bandwidthHz != null ? m.bandwidthHz / 2 : 40;
      drawChannelMarker(ctx, canvas.width, PLOT_H, m.freq, m.color, m.label, halfBw, minHz, maxHz);
    }
    drawAxisLabels(ctx, canvas.width, PLOT_H, minHz, maxHz);
    return vis;
  }, [analyser]);

  const drawSpectrogram = useCallback((canvas: HTMLCanvasElement, fd: Uint8Array) => {
    const ctx = canvas.getContext('2d'); if (!ctx) return;
    const row = ctx.createImageData(canvas.width, 1);
    for (let px = 0; px < canvas.width; px++) {
      const bf = (px / canvas.width) * (fd.length - 1), b0 = Math.floor(bf), b1 = Math.min(b0+1, fd.length-1);
      const v  = fd[b0] * (1 - (bf - b0)) + fd[b1] * (bf - b0);
      const g  = sgGRef.current;
      const a  = g === 1 ? v : Math.pow(v / 255, g) * 255;
      let r: number, gr: number, bl: number;
      if (a < 128) { r = 0; gr = 0; bl = Math.round(a * 2); }
      else         { r = Math.round((a - 128) * 2); gr = 0; bl = Math.round(255 - (a - 128) * 2); }
      const i = px * 4; row.data[i] = r; row.data[i+1] = gr; row.data[i+2] = bl; row.data[i+3] = 255;
    }
    ctx.putImageData(ctx.getImageData(0, 0, canvas.width, canvas.height - 1), 0, 1);
    ctx.putImageData(row, 0, 0);
  }, []);

  // Animation loop — spectrum ~30fps; 2D and 3D spectrograms throttled independently
  useEffect(() => {
    const tick = (now: number) => {
      const sp = specRef.current, sg = sgCanvRef.current;
      if (sp && now - spLastTs.current >= 33) {
        spLastTs.current = now;
        const fd = drawSpectrum(sp);
        if (fd) {
          // 2D classic canvas
          if (sg && now - sg2dLastTs.current >= sg2dSpRef.current) {
            sg2dLastTs.current = now;
            drawSpectrogram(sg, fd);
          }
          // 3D GL spectrogram: upload a new row on the configured interval
          if (now - sg3dLastTs.current >= sg3dSpRef.current) {
            sg3dLastTs.current = now;
            glSgRef.current?.pushRow(fd);
          }
        }
      }
      // Redraw the 3D terrain every rAF frame so the view is always smooth
      glSgRef.current?.render();
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, [drawSpectrum, drawSpectrogram]);

  // GL bands from markers
  const glBandsComputed = glBands
    ? glBands.map(ch => {
        const halfBw = 40;
        return { fromHz: ch.freq - halfBw, toHz: ch.freq + halfBw, color: ch.color };
      })
    : markers.map(m => {
        const halfBw = m.bandwidthHz != null ? m.bandwidthHz / 2 : 40;
        return { fromHz: m.freq - halfBw, toHz: m.freq + halfBw, color: m.color };
      });

  const glMarkers = markers.map(m => ({ fromHz: m.freq, toHz: m.freq, color: m.color }));

  return (
    <div className={`bg-[#161b22] border border-[#30363d] rounded-lg p-3 sm:p-4 flex flex-col${className ? ` ${className}` : ''}`} style={style}>
      {/* Header */}
      <div className="flex items-center justify-between mb-2 shrink-0">
        <h2 className="text-lg sm:text-xl font-semibold">Audio Analysis</h2>
        <SignalMeter envelopeLevel={signalLevel} />
      </div>

      <div className="shrink-0">
        {/* Center freq display / input */}
        {markers.length > 0 && (
          <div className="flex items-center gap-2 mb-1.5 text-xs text-[#8b949e]">
            <span className="shrink-0">Center</span>
            <input
              type="number" min={50} max={displayMaxHz} step={1}
              value={centerFreqInput !== '' ? centerFreqInput : centerFreq}
              onChange={e => setCenterFreqInput(e.target.value)}
              onBlur={() => {
                if (centerFreqInput !== '' && onMarkerDragRef.current) {
                  const newCenter = parseInt(centerFreqInput);
                  if (!isNaN(newCenter)) {
                    const delta = newCenter - centerFreq;
                    markers.forEach((_, i) => {
                      onMarkerDragRef.current!(i, markers[i].freq + delta);
                    });
                  }
                }
                setCenterFreqInput('');
              }}
              onKeyDown={e => {
                if (e.key === 'Enter' && centerFreqInput !== '' && onMarkerDragRef.current) {
                  const newCenter = parseInt(centerFreqInput);
                  if (!isNaN(newCenter)) {
                    const delta = newCenter - centerFreq;
                    markers.forEach((_, i) => {
                      onMarkerDragRef.current!(i, markers[i].freq + delta);
                    });
                  }
                  setCenterFreqInput('');
                  (e.target as HTMLInputElement).blur();
                }
              }}
              readOnly={!onMarkerDrag}
              className={`w-20 bg-[#0d1117] border border-[#30363d] rounded px-2 py-0.5 font-mono text-[#c9d1d9] focus:outline-none focus:border-[#2ea043] ${!onMarkerDrag ? 'opacity-60 cursor-default' : ''}`}
            />
            <span className="shrink-0 text-[#484f58]">Hz</span>
            <span className="text-[#484f58] text-[10px] ml-auto">
              {markers.length} marker{markers.length !== 1 ? 's' : ''}
            </span>
          </div>
        )}

        {/* Spectrum canvas */}
        <canvas
          ref={specRef}
          width={640} height={CANVAS_H}
          className={`w-full border border-[#30363d] rounded bg-[#0a0a0a] touch-manipulation block ${onMarkerDrag ? 'cursor-ew-resize' : onSquelchChange ? 'cursor-ns-resize' : 'cursor-crosshair'}`}
          onMouseDown={onMarkerDrag || onSquelchChange ? handleSpectrumMouseDown : undefined}
        />

        {/* Frequency view range */}
        <div className="flex items-center gap-1.5 mt-1 text-[10px] text-[#8b949e]">
          <span className="shrink-0">View</span>
          <input type="number" min={0} max={displayMaxHz-100} step={100}
            value={displayMinHz}
            onChange={e => { const v = parseInt(e.target.value); if (!isNaN(v)) setDisplayMinHz(Math.max(0, Math.min(displayMaxHz-100, v))); }}
            className="w-16 bg-[#0d1117] border border-[#30363d] rounded px-1.5 py-0.5 font-mono text-[#c9d1d9] focus:outline-none focus:border-[#2ea043]"/>
          <span className="shrink-0 text-[#484f58]">–</span>
          <input type="number" min={displayMinHz+100} max={24000} step={100}
            value={displayMaxHz}
            onChange={e => { const v = parseInt(e.target.value); if (!isNaN(v)) setDisplayMaxHz(Math.max(displayMinHz+100, Math.min(24000, v))); }}
            className="w-16 bg-[#0d1117] border border-[#30363d] rounded px-1.5 py-0.5 font-mono text-[#c9d1d9] focus:outline-none focus:border-[#2ea043]"/>
          <span className="shrink-0 text-[#484f58]">Hz</span>
          {[1000, 2000, 3000, 4000].map(mx => (
            <button key={mx}
              onClick={() => { setDisplayMinHz(0); setDisplayMaxHz(mx); }}
              className={`px-1.5 py-0.5 rounded border text-[9px] transition-colors ${displayMinHz===0&&displayMaxHz===mx?'border-[#2ea043]/50 bg-[#238636]/20 text-[#2ea043]':'border-[#30363d] text-[#484f58] hover:text-[#8b949e]'}`}>
              {mx/1000}k
            </button>
          ))}
        </div>

        {/* Squelch + lock/free */}
        <div className="flex items-center justify-between mt-0.5">
          {onSquelchChange ? (
            <div className="flex items-center gap-2 text-xs text-[#8b949e]">
              <span className="shrink-0">Squelch</span>
              <input type="range" min={0} max={100} step={1} value={squelch}
                onChange={e => onSquelchChange(parseInt(e.target.value))}
                className="w-24 accent-[#e3b341]"/>
              <span className="font-mono text-[#e3b341] w-8 text-right shrink-0">{squelch}%</span>
            </div>
          ) : (
            <p className="text-[10px] text-[#484f58]">
              {isRecording ? 'Receiving audio' : 'Start decoding to see spectrum'}
            </p>
          )}
          <button
            onClick={() => setLockCenter(v => !v)}
            title={lockCenter ? 'View locked — click to free' : 'View free — click to lock'}
            className={`flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] transition-colors ${
              lockCenter ? 'border-[#2ea043]/50 bg-[#238636]/20 text-[#2ea043]' : 'border-[#30363d] text-[#484f58] hover:text-[#8b949e]'
            }`}>
            {lockCenter ? (
              <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z" clipRule="evenodd"/>
              </svg>
            ) : (
              <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3" viewBox="0 0 20 20" fill="currentColor">
                <path d="M10 2a5 5 0 00-5 5v2a2 2 0 00-2 2v5a2 2 0 002 2h10a2 2 0 002-2v-5a2 2 0 00-2-2H7V7a3 3 0 015.905-.75 1 1 0 001.937-.5A5.002 5.002 0 0010 2z"/>
              </svg>
            )}
            {lockCenter ? 'Locked' : 'Free'}
          </button>
        </div>
      </div>

      {/* Spectrogram */}
      <div className="flex flex-col gap-2 mt-3 flex-1 min-h-0">
        <h3 className="text-xs font-medium text-[#8b949e] shrink-0">Spectrogram</h3>
        <div ref={sgContainerRef} className="relative flex-1 min-h-[100px]">
          <div className={sgView === 'legacy' ? 'block' : 'hidden'}>
            <canvas ref={sgCanvRef} width={640} height={sgH} style={{ height: sgH }}
              className="w-full border border-[#30363d] rounded bg-[#0d1117] block"/>
          </div>
          <div className={sgView !== 'legacy' ? 'block' : 'hidden'}>
            <GLSpectrogram
              ref={glSgRef}
              view={sgView === 'legacy' ? 'terrain' : sgView}
              gamma={sgGamma}
              height={sgH}
              maxHz={displayMaxHz}
              minHz={displayMinHz}
              bands={glBandsComputed}
              bandAlpha={bandAlpha}
              markers={glMarkers}
              sqlLevel={onSquelchChange != null ? squelch / 100 : undefined}
              sqlAlpha={0.6}
              sqlGridSize={showGrid ? gridSize : undefined}
            />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-xs text-[#8b949e] shrink-0">
          <label className="flex items-center gap-1.5">View
            <select value={sgView} onChange={e => setSgView(e.target.value as SpectrogramView)}
              className="bg-[#0d1117] border border-[#30363d] rounded px-1.5 py-0.5 text-[#c9d1d9] focus:outline-none focus:border-[#2ea043] cursor-pointer">
              <option value="terrain">3D Terrain</option>
              <option value="ridge">Ridgeline</option>
              <option value="legacy">Classic 2D</option>
            </select>
          </label>
          {sgView !== 'legacy' && (
            <label className="flex items-center gap-1.5">Range
              <input type="range" min={0} max={1} step={0.05} value={bandAlpha}
                onChange={e => setBandAlpha(parseFloat(e.target.value))}
                className="w-14 accent-[#2ea043]"/>
            </label>
          )}
          <label className="flex items-center gap-1.5">Contrast
            <input type="range" min={0.2} max={2.0} step={0.1} value={sgGamma}
              onChange={e => setSgGamma(parseFloat(e.target.value))}
              className="w-14 accent-[#2ea043]"/>
          </label>
          {sgView === 'legacy' ? (
            <label className="flex items-center gap-1.5">Speed
              <select value={sg2dSpeed} onChange={e => setSg2dSpeed(parseInt(e.target.value))}
                className="bg-[#0d1117] border border-[#30363d] rounded px-1.5 py-0.5 text-[#c9d1d9] focus:outline-none focus:border-[#2ea043] cursor-pointer">
                <option value={16}>Fast</option>
                <option value={50}>Normal</option>
                <option value={150}>Slow</option>
                <option value={500}>Very Slow</option>
              </select>
            </label>
          ) : (
            <>
              <label className="flex items-center gap-1.5">Speed
                <select value={sg3dSpeed} onChange={e => setSg3dSpeed(parseInt(e.target.value))}
                  className="bg-[#0d1117] border border-[#30363d] rounded px-1.5 py-0.5 text-[#c9d1d9] focus:outline-none focus:border-[#2ea043] cursor-pointer">
                  <option value={80}>Normal</option>
                  <option value={200}>Slow</option>
                  <option value={500}>Very Slow</option>
                  <option value={1200}>Paused</option>
                </select>
              </label>
              <label className="flex items-center gap-1.5">Smooth
                <input type="range" min={0.05} max={1} step={0.05} value={sg3dSmooth}
                  onChange={e => setSg3dSmooth(parseFloat(e.target.value))}
                  className="w-14 accent-[#2ea043]"/>
              </label>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
