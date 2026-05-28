'use client';

import { useEffect, useRef, useCallback, useState } from 'react';
import { useCWProcessor } from '@/hooks/useCWProcessor';

const DISPLAY_MAX_HZ = 1500;
const CANVAS_H = 200;
const AXIS_H   = 25;
const PLOT_H   = CANVAS_H - AXIS_H;

// ── Axis helper ───────────────────────────────────────────────────────────────

function drawAxisLabels(
  ctx: CanvasRenderingContext2D,
  canvasWidth: number,
  plotHeight: number,
  maxFreq: number,
) {
  ctx.strokeStyle = '#30363d'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, plotHeight); ctx.lineTo(canvasWidth, plotHeight); ctx.stroke();
  for (let freq = 0; freq <= maxFreq; freq += 10) {
    const xPos    = (freq / maxFreq) * canvasWidth;
    const isMajor = freq % 100 === 0;
    const isMed   = !isMajor && freq % 50 === 0;
    const tickLen = isMajor ? 6 : isMed ? 4 : 2;
    ctx.strokeStyle = isMajor ? '#8b949e' : '#30363d';
    ctx.beginPath(); ctx.moveTo(xPos, plotHeight); ctx.lineTo(xPos, plotHeight + tickLen); ctx.stroke();
    if (isMajor) {
      ctx.fillStyle = '#8b949e'; ctx.font = '10px monospace'; ctx.textAlign = 'center';
      ctx.fillText(freq >= 1000 ? `${freq / 1000}k` : `${freq}`, xPos, plotHeight + 17);
    }
  }
}

// ── SQL threshold line ────────────────────────────────────────────────────────

function drawSqlLine(
  ctx: CanvasRenderingContext2D,
  canvasWidth: number,
  plotHeight: number,
  squelch: number,
) {
  if (squelch === 0) return;
  const y = plotHeight * (1 - squelch / 100);

  ctx.lineWidth = 1; ctx.setLineDash([4, 3]);
  ctx.strokeStyle = '#e3b341';
  ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(canvasWidth, y); ctx.stroke();
  ctx.setLineDash([]);

  // Left handle triangle
  ctx.fillStyle = '#e3b341';
  ctx.beginPath(); ctx.moveTo(0, y - 5); ctx.lineTo(9, y); ctx.lineTo(0, y + 5); ctx.closePath(); ctx.fill();
  // Right handle triangle
  ctx.beginPath(); ctx.moveTo(canvasWidth, y - 5); ctx.lineTo(canvasWidth - 9, y); ctx.lineTo(canvasWidth, y + 5); ctx.closePath(); ctx.fill();

  ctx.font = '9px monospace'; ctx.textAlign = 'left'; ctx.fillStyle = '#e3b341';
  ctx.fillText(`SQL ${squelch}%`, 12, y > 12 ? y - 3 : y + 12);
}

// ── Tone marker ───────────────────────────────────────────────────────────────

function drawToneMarker(
  ctx: CanvasRenderingContext2D,
  canvasWidth: number,
  plotHeight: number,
  toneFreq: number,
  peakLevel: number,
) {
  const toneX  = (toneFreq / DISPLAY_MAX_HZ) * canvasWidth;
  const bandLo = Math.max(0, ((toneFreq - 100) / DISPLAY_MAX_HZ) * canvasWidth);
  const bandHi = Math.min(canvasWidth, ((toneFreq + 100) / DISPLAY_MAX_HZ) * canvasWidth);

  ctx.fillStyle = 'rgba(121,192,255,0.07)';
  ctx.fillRect(bandLo, 0, bandHi - bandLo, plotHeight);

  ctx.lineWidth = 1; ctx.setLineDash([2, 4]);
  ctx.strokeStyle = 'rgba(121,192,255,0.30)';
  ctx.beginPath(); ctx.moveTo(bandLo, 0); ctx.lineTo(bandLo, plotHeight); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(bandHi, 0); ctx.lineTo(bandHi, plotHeight); ctx.stroke();
  ctx.setLineDash([]);

  ctx.lineWidth = 1.5; ctx.setLineDash([4, 3]);
  ctx.strokeStyle = '#79c0ff';
  ctx.beginPath(); ctx.moveTo(toneX, 0); ctx.lineTo(toneX, plotHeight); ctx.stroke();
  ctx.setLineDash([]);

  if (peakLevel > 0) {
    const y = plotHeight * (1 - peakLevel / 255);
    ctx.strokeStyle = '#79c0ff'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(bandLo, y); ctx.lineTo(bandHi, y); ctx.stroke();
  }

  ctx.font = '10px monospace'; ctx.textAlign = 'center';
  ctx.fillStyle = '#79c0ff';
  ctx.fillText('T', toneX, 14);
}

// ── Signal meter (5-bar, matches RTTY) ───────────────────────────────────────

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

// ── Main component ────────────────────────────────────────────────────────────

export default function CWDecoder() {
  const [toneFreq, setToneFreq] = useState(700);
  const [squelch,  setSquelch]  = useState(20);
  const toneFreqRef             = useRef(700);
  const squelchRef              = useRef(20);
  useEffect(() => { toneFreqRef.current = toneFreq; }, [toneFreq]);
  useEffect(() => { squelchRef.current  = squelch;  }, [squelch]);

  const { state, startRecording, stopRecording, clearText, resetDecoder, getAnalyser } =
    useCWProcessor(toneFreq, squelch);

  const spectrumCanvasRef    = useRef<HTMLCanvasElement>(null);
  const spectrogramCanvasRef = useRef<HTMLCanvasElement>(null);
  const animationFrameRef    = useRef<number | null>(null);
  const textareaRef          = useRef<HTMLTextAreaElement>(null);
  const dragModeRef          = useRef<'tone' | 'squelch' | null>(null);
  const spectrogramFrameRef  = useRef(0);
  const tonePeakRef          = useRef(0);

  const spectrogramContainerRef    = useRef<HTMLDivElement>(null);
  const [spectrogramCanvasHeight, setSpectrogramCanvasHeight] = useState(500);
  const spectrogramCanvasHeightRef = useRef(500);

  useEffect(() => {
    const el = spectrogramContainerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(entries => {
      const h = Math.round(entries[0].contentRect.height);
      if (h > 80 && Math.abs(h - spectrogramCanvasHeightRef.current) > 4) {
        spectrogramCanvasHeightRef.current = h;
        setSpectrogramCanvasHeight(h);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const [spectrogramGamma, setSpectrogramGamma] = useState(3.0);
  const [spectrogramSpeed, setSpectrogramSpeed] = useState(2);
  const spectrogramGammaRef = useRef(3.0);
  const spectrogramSpeedRef = useRef(2);
  useEffect(() => { spectrogramGammaRef.current = spectrogramGamma; }, [spectrogramGamma]);
  useEffect(() => { spectrogramSpeedRef.current = spectrogramSpeed; }, [spectrogramSpeed]);

  const containerRef    = useRef<HTMLDivElement>(null);
  const [panelWeights, setPanelWeights] = useState([1, 1]);
  const panelWeightsRef = useRef([1, 1]);
  const panelDragRef = useRef<{ startX: number; startWeights: number[] } | null>(null);
  useEffect(() => { panelWeightsRef.current = panelWeights; }, [panelWeights]);

  const startPanelDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    panelDragRef.current = { startX: e.clientX, startWeights: [...panelWeightsRef.current] };
  };

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const drag = panelDragRef.current;
      if (!drag || !containerRef.current) return;
      const total = drag.startWeights[0] + drag.startWeights[1];
      const dw    = ((e.clientX - drag.startX) / containerRef.current.offsetWidth) * total;
      const w     = [...drag.startWeights];
      w[0] = Math.max(0.15, w[0] + dw);
      w[1] = Math.max(0.15, w[1] - dw);
      setPanelWeights([...w]);
    };
    const onUp = () => { panelDragRef.current = null; };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
  }, []);

  useEffect(() => {
    const t = textareaRef.current;
    if (t) t.scrollTop = t.scrollHeight;
  }, [state.text]);

  // ── Drawing ───────────────────────────────────────────────────────────────

  const drawSpectrum = useCallback((canvas: HTMLCanvasElement) => {
    const analyser = getAnalyser();
    const ctx      = canvas.getContext('2d');
    if (!ctx) return;

    ctx.fillStyle = 'rgb(10,10,10)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    let visibleData: Uint8Array | undefined;

    if (analyser) {
      const bufLen   = analyser.frequencyBinCount;
      const data     = new Uint8Array(bufLen);
      analyser.getByteFrequencyData(data);
      const nq       = analyser.context.sampleRate / 2;
      const binsShow = Math.max(1, Math.floor((DISPLAY_MAX_HZ / nq) * bufLen));
      visibleData    = data.subarray(0, binsShow);

      ctx.strokeStyle = '#2ea043'; ctx.lineWidth = 2;
      ctx.beginPath();
      const bw = canvas.width / binsShow;
      for (let i = 0; i < binsShow; i++) {
        const x = i * bw;
        const y = PLOT_H - (visibleData[i] / 255) * PLOT_H;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();

      const tf   = toneFreqRef.current;
      const tBin = Math.min(Math.round((tf / DISPLAY_MAX_HZ) * (binsShow - 1)), binsShow - 1);
      const tLvl = tBin >= 0 ? (visibleData[tBin] ?? 0) : 0;
      tonePeakRef.current = tLvl > tonePeakRef.current ? tLvl : Math.max(0, tonePeakRef.current - 0.4);
    } else {
      tonePeakRef.current = Math.max(0, tonePeakRef.current - 0.4);
    }

    drawToneMarker(ctx, canvas.width, PLOT_H, toneFreqRef.current, tonePeakRef.current);
    drawSqlLine(ctx, canvas.width, PLOT_H, squelchRef.current);
    drawAxisLabels(ctx, canvas.width, PLOT_H, DISPLAY_MAX_HZ);
    return visibleData;
  }, [getAnalyser]);

  const drawSpectrogram = useCallback((canvas: HTMLCanvasElement, freqData: Uint8Array) => {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const newRow = ctx.createImageData(canvas.width, 1);
    for (let px = 0; px < canvas.width; px++) {
      const binF  = (px / canvas.width) * (freqData.length - 1);
      const b0    = Math.floor(binF);
      const b1    = Math.min(b0 + 1, freqData.length - 1);
      const t     = binF - b0;
      const value = freqData[b0] * (1 - t) + freqData[b1] * t;
      const gamma = spectrogramGammaRef.current;
      const adj   = gamma === 1 ? value : Math.pow(value / 255, gamma) * 255;
      let r: number, g: number, b: number;
      if (adj < 128) { r = 0; g = 0; b = Math.round(adj * 2); }
      else           { r = Math.round((adj - 128) * 2); g = 0; b = Math.round(255 - (adj - 128) * 2); }
      const i = px * 4;
      newRow.data[i] = r; newRow.data[i+1] = g; newRow.data[i+2] = b; newRow.data[i+3] = 255;
    }
    ctx.putImageData(ctx.getImageData(0, 0, canvas.width, canvas.height - 1), 0, 1);
    ctx.putImageData(newRow, 0, 0);
  }, []);

  useEffect(() => {
    const tick = () => {
      const specCanvas = spectrumCanvasRef.current;
      const sgCanvas   = spectrogramCanvasRef.current;
      if (specCanvas) {
        const freqData = drawSpectrum(specCanvas);
        spectrogramFrameRef.current++;
        if (sgCanvas && freqData && spectrogramFrameRef.current % spectrogramSpeedRef.current === 0) {
          drawSpectrogram(sgCanvas, freqData);
        }
      }
      animationFrameRef.current = requestAnimationFrame(tick);
    };
    animationFrameRef.current = requestAnimationFrame(tick);
    return () => { if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current); };
  }, [drawSpectrum, drawSpectrogram]);

  // Spectrum interaction — horizontal drag = tone freq, vertical drag on SQL line = squelch
  useEffect(() => {
    const canvas = spectrumCanvasRef.current;
    if (!canvas) return;

    const getSqlClientY = () => {
      const rect = canvas.getBoundingClientRect();
      return rect.top + PLOT_H * (1 - squelchRef.current / 100) * (rect.height / CANVAS_H);
    };

    const isNearSql = (clientY: number) =>
      squelchRef.current > 0 && Math.abs(clientY - getSqlClientY()) < 10;

    const applyTone = (clientX: number) => {
      const rect = canvas.getBoundingClientRect();
      const relX = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      setToneFreq(Math.round(relX * DISPLAY_MAX_HZ));
    };

    const applySquelch = (clientY: number) => {
      const rect     = canvas.getBoundingClientRect();
      const plotH_px = rect.height * (PLOT_H / CANVAS_H);
      const relY     = Math.max(0, Math.min(1, (clientY - rect.top) / plotH_px));
      setSquelch(Math.max(0, Math.min(100, Math.round((1 - relY) * 100))));
    };

    const onMouseDown = (e: MouseEvent) => {
      if (isNearSql(e.clientY)) { dragModeRef.current = 'squelch'; applySquelch(e.clientY); }
      else                      { dragModeRef.current = 'tone';    applyTone(e.clientX); }
    };
    const onMouseMove = (e: MouseEvent) => {
      const mode = dragModeRef.current;
      if      (mode === 'tone')    applyTone(e.clientX);
      else if (mode === 'squelch') applySquelch(e.clientY);
      else canvas.style.cursor = isNearSql(e.clientY) ? 'ns-resize' : 'crosshair';
    };
    const onMouseUp = () => { dragModeRef.current = null; };

    const onTouchStart = (e: TouchEvent) => {
      e.preventDefault();
      const t = e.touches[0];
      if (isNearSql(t.clientY)) { dragModeRef.current = 'squelch'; applySquelch(t.clientY); }
      else                      { dragModeRef.current = 'tone';    applyTone(t.clientX); }
    };
    const onTouchMove = (e: TouchEvent) => {
      e.preventDefault();
      const t = e.touches[0];
      const mode = dragModeRef.current;
      if      (mode === 'tone')    applyTone(t.clientX);
      else if (mode === 'squelch') applySquelch(t.clientY);
    };
    const onTouchEnd = () => { dragModeRef.current = null; };

    canvas.addEventListener('mousedown',  onMouseDown);
    canvas.addEventListener('touchstart', onTouchStart, { passive: false });
    window.addEventListener('mousemove',  onMouseMove);
    window.addEventListener('mouseup',    onMouseUp);
    window.addEventListener('touchmove',  onTouchMove as EventListener, { passive: false });
    window.addEventListener('touchend',   onTouchEnd);
    return () => {
      canvas.removeEventListener('mousedown',  onMouseDown);
      canvas.removeEventListener('touchstart', onTouchStart);
      window.removeEventListener('mousemove',  onMouseMove);
      window.removeEventListener('mouseup',    onMouseUp);
      window.removeEventListener('touchmove',  onTouchMove as EventListener);
      window.removeEventListener('touchend',   onTouchEnd);
    };
  }, []);

  // ── Handlers ─────────────────────────────────────────────────────────────

  const handleReset = () => { resetDecoder(); tonePeakRef.current = 0; };

  const handleCopyText = () => {
    if (!state.text) return;
    navigator.clipboard.writeText(state.text).catch(() => {
      const t = textareaRef.current;
      if (t) { t.select(); document.execCommand('copy'); }
    });
  };

  // ── Derived ───────────────────────────────────────────────────────────────

  const stats    = state.stats;
  const snrColor = stats?.snrDb == null ? 'text-[#8b949e]'
    : stats.snrDb < 6  ? 'text-[#da3633]'
    : stats.snrDb < 15 ? 'text-[#e3b341]'
    : 'text-[#2ea043]';

  const toneBandLow  = Math.max(0, toneFreq - 100);
  const toneBandHigh = Math.min(DISPLAY_MAX_HZ, toneFreq + 100);

  return (
    <div className="space-y-4 sm:space-y-6">

      {/* ── Controls ── */}
      <div className="bg-[#161b22] border border-[#30363d] rounded-lg p-4 sm:p-6 space-y-4">
        <div className="flex flex-col sm:flex-row gap-3 sm:gap-4">
          {!state.isRecording ? (
            <button
              onClick={startRecording}
              disabled={!state.isSupported}
              className="w-full sm:flex-1 bg-[#238636] hover:bg-[#2ea043] disabled:opacity-50 text-white font-semibold px-6 py-3 rounded-md transition-colors text-base border border-transparent flex items-center justify-center gap-2"
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM9.555 7.168A1 1 0 008 8v4a1 1 0 001.555.832l3-2a1 1 0 000-1.664l-3-2z" clipRule="evenodd" />
              </svg>
              Start Decoding
            </button>
          ) : (
            <button
              onClick={stopRecording}
              className="w-full sm:flex-1 bg-[#da3633] hover:bg-[#f85149] text-white font-semibold px-6 py-3 rounded-md transition-colors text-base flex items-center justify-center gap-2"
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8 7a1 1 0 00-1 1v4a1 1 0 001 1h4a1 1 0 001-1V8a1 1 0 00-1-1H8z" clipRule="evenodd" />
              </svg>
              Stop
            </button>
          )}

          <button
            onClick={handleReset}
            className="w-full sm:flex-1 bg-[#21262d] hover:bg-[#30363d] text-white font-semibold px-6 py-3 rounded-md transition-colors text-base border border-[#30363d] flex items-center justify-center gap-2"
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M4 2a1 1 0 011 1v2.101a7.002 7.002 0 0111.601 2.566 1 1 0 11-1.885.666A5.002 5.002 0 005.999 7H9a1 1 0 010 2H4a1 1 0 01-1-1V3a1 1 0 011-1zm.008 9.057a1 1 0 011.276.61A5.002 5.002 0 0014.001 13H11a1 1 0 110-2h5a1 1 0 011 1v5a1 1 0 11-2 0v-2.101a7.002 7.002 0 01-11.601-2.566 1 1 0 01.61-1.276z" clipRule="evenodd" />
            </svg>
            Reset
          </button>

          <button
            onClick={handleCopyText}
            disabled={!state.text}
            className="w-full sm:flex-1 bg-[#21262d] hover:bg-[#30363d] disabled:opacity-40 disabled:cursor-not-allowed text-white font-semibold px-6 py-3 rounded-md transition-colors text-base border border-[#30363d] flex items-center justify-center gap-2"
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
              <path d="M8 3a1 1 0 011-1h2a1 1 0 110 2H9a1 1 0 01-1-1z" />
              <path d="M6 3a2 2 0 00-2 2v11a2 2 0 002 2h8a2 2 0 002-2V5a2 2 0 00-2-2 3 3 0 01-3 3H9a3 3 0 01-3-3z" />
            </svg>
            Copy Text
          </button>
        </div>

        {state.error && (
          <div className="bg-[#da3633]/10 border border-[#f85149]/30 rounded-md p-3 text-[#f85149] text-sm">
            {state.error}
          </div>
        )}

        {state.isRecording && (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4 text-sm">
            <div className="bg-[#0d1117] border border-[#30363d] rounded-lg p-3">
              <div className="text-[#8b949e] text-xs mb-1">Speed</div>
              <div className="font-mono font-semibold text-sm text-[#2ea043]">
                {stats?.wpm ?? '—'} <span className="text-[#8b949e] font-normal text-xs">WPM</span>
              </div>
            </div>
            <div className="bg-[#0d1117] border border-[#30363d] rounded-lg p-3">
              <div className="text-[#8b949e] text-xs mb-1">Tone / SQL</div>
              <div className="font-mono font-semibold text-sm">
                {stats?.squelched
                  ? <span className="text-[#e3b341]">Squelched</span>
                  : stats?.toneDetected
                    ? <span className="text-[#79c0ff] flex items-center gap-1.5"><span className="inline-block w-2 h-2 rounded-full bg-[#79c0ff] animate-pulse shrink-0" />Mark</span>
                    : <span className="text-[#8b949e]">Space</span>
                }
              </div>
            </div>
            <div className="bg-[#0d1117] border border-[#30363d] rounded-lg p-3">
              <div className="text-[#8b949e] text-xs mb-1">Chars</div>
              <div className="font-mono font-semibold text-sm">{state.text.replace(/ /g, '').length}</div>
            </div>
            <div className="bg-[#0d1117] border border-[#30363d] rounded-lg p-3">
              <div className="text-[#8b949e] text-xs mb-1">SNR</div>
              <div className={`font-mono font-semibold text-sm ${snrColor}`}>
                {stats?.snrDb != null ? `${stats.snrDb.toFixed(1)} dB` : '-- dB'}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ── Main panels ── */}
      <div ref={containerRef} className="flex flex-col lg:flex-row lg:items-stretch gap-4 lg:gap-0">

        {/* Panel 1 — CW Output */}
        <div
          className="bg-[#161b22] border border-[#30363d] rounded-lg p-3 sm:p-4 flex flex-col min-w-0"
          style={{ flex: panelWeights[0] }}
        >
          <div className="flex items-center justify-between mb-2 sm:mb-3">
            <h2 className="text-lg sm:text-xl font-semibold">CW Output</h2>
            <div className="flex items-center gap-3">
              <span className="text-xs text-[#8b949e] font-mono">{state.text.replace(/ /g, '').length} chars</span>
              <button
                onClick={clearText}
                disabled={!state.text}
                className="text-xs px-2 py-0.5 rounded border border-[#30363d] text-[#8b949e] hover:text-[#f85149] hover:border-[#f85149]/40 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              >
                Clear
              </button>
            </div>
          </div>
          <textarea
            ref={textareaRef}
            readOnly
            value={state.text}
            placeholder="Decoded CW text will appear here..."
            className="flex-1 min-h-[300px] w-full bg-[#0d1117] border border-[#30363d] rounded font-mono text-sm p-3 resize-none focus:outline-none placeholder:text-[#30363d] leading-snug text-[#c9d1d9]"
          />
        </div>

        {/* Drag handle */}
        <div
          className="hidden lg:flex w-3 self-stretch cursor-col-resize items-center justify-center group shrink-0"
          onMouseDown={startPanelDrag}
        >
          <div className="w-px h-full bg-[#30363d] group-hover:bg-[#2ea043]/50 transition-colors" />
        </div>

        {/* Panel 2 — Audio Analysis */}
        <div
          className="bg-[#161b22] border border-[#30363d] rounded-lg p-3 sm:p-4 min-w-0 flex flex-col"
          style={{ flex: panelWeights[1] }}
        >
          <div className="flex items-center justify-between mb-2 sm:mb-3">
            <h2 className="text-lg sm:text-xl font-semibold">Audio Analysis</h2>
            {state.isRecording && <SignalMeter envelopeLevel={stats?.envelopeLevel ?? 0} />}
          </div>

          {/* Spectrum */}
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-medium text-[#8b949e]">Spectrum</h3>
              <span className="text-xs text-[#8b949e] font-mono">drag ← → tone · drag ↕ SQL line</span>
            </div>
            <canvas
              ref={spectrumCanvasRef}
              width={640} height={CANVAS_H}
              className="w-full border border-[#30363d] rounded bg-[#0d1117] touch-manipulation cursor-crosshair select-none"
            />
          </div>

          {/* Freq readout */}
          <div className="flex flex-wrap items-center gap-4 mt-2 text-xs font-mono text-[#8b949e]">
            <span>Tone:&nbsp;<span className="text-[#79c0ff]">{toneFreq} Hz</span></span>
            <label className="flex items-center gap-1">
              Set:
              <input
                type="number"
                value={toneFreq}
                min={100} max={DISPLAY_MAX_HZ}
                onChange={(e) => {
                  const v = parseInt(e.target.value);
                  if (!isNaN(v)) setToneFreq(Math.max(100, Math.min(DISPLAY_MAX_HZ, v)));
                }}
                className="bg-[#0d1117] border border-[#30363d] rounded px-2 py-0.5 w-20 text-[#c9d1d9] focus:outline-none focus:border-[#79c0ff] transition-colors"
              />
              <span>Hz</span>
            </label>
          </div>

          {/* Spectrogram */}
          <div className="flex flex-col flex-1 gap-2 mt-3 sm:mt-4 min-h-0">
            <h3 className="text-sm font-medium text-[#8b949e] shrink-0">Spectrogram</h3>
            <div ref={spectrogramContainerRef} className="relative flex-1 min-h-[150px]">
              <canvas
                ref={spectrogramCanvasRef}
                width={640}
                height={spectrogramCanvasHeight}
                style={{ height: spectrogramCanvasHeight }}
                className="w-full border border-[#30363d] rounded bg-[#0d1117] block"
              />
              <div className="absolute inset-y-0 pointer-events-none" style={{
                left:            `${(toneBandLow  / DISPLAY_MAX_HZ) * 100}%`,
                width:           `${((toneBandHigh - toneBandLow) / DISPLAY_MAX_HZ) * 100}%`,
                backgroundColor: 'rgba(121,192,255,0.07)',
                borderLeft:      '1px solid rgba(121,192,255,0.28)',
                borderRight:     '1px solid rgba(121,192,255,0.28)',
              }} />
              {toneFreq >= 0 && toneFreq <= DISPLAY_MAX_HZ && (
                <div className="absolute inset-y-0 pointer-events-none" style={{
                  left: `${(toneFreq / DISPLAY_MAX_HZ) * 100}%`, width: '2px',
                  backgroundColor: '#79c0ff', opacity: 0.9,
                }}>
                  <span className="absolute top-1 left-1 text-[10px] font-mono font-bold text-[#79c0ff] leading-none drop-shadow-md">T</span>
                </div>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-4 text-xs text-[#8b949e] shrink-0">
              <label className="flex items-center gap-2">
                Contrast
                <input
                  type="range" min={0.5} max={6} step={0.1}
                  value={spectrogramGamma}
                  onChange={(e) => setSpectrogramGamma(parseFloat(e.target.value))}
                  className="w-32 accent-[#2ea043] cursor-pointer"
                />
              </label>
              <label className="flex items-center gap-2">
                Speed
                <select
                  value={spectrogramSpeed}
                  onChange={(e) => setSpectrogramSpeed(parseInt(e.target.value))}
                  className="bg-[#0d1117] border border-[#30363d] rounded px-2 py-0.5 text-[#c9d1d9] focus:outline-none focus:border-[#2ea043] transition-colors cursor-pointer"
                >
                  <option value={1}>Fast</option>
                  <option value={2}>Normal</option>
                  <option value={4}>Slow</option>
                  <option value={8}>Very Slow</option>
                </select>
              </label>
            </div>
          </div>
        </div>
      </div>

      {/* ── How to Use ── */}
      <details className="bg-[#161b22] border border-[#30363d] rounded-lg">
        <summary className="cursor-pointer p-4 sm:p-6 font-semibold text-lg sm:text-xl hover:bg-[#21262d] rounded-lg transition-colors select-none">
          How to Use
        </summary>
        <div className="px-4 pb-4 sm:px-6 sm:pb-6">
          <ol className="list-decimal list-inside space-y-2 text-sm sm:text-base text-[#c9d1d9]">
            <li>Click <strong>Start Decoding</strong> and allow microphone access</li>
            <li>Tune your radio to a CW (Morse code) signal</li>
            <li>On the Spectrum panel, drag left/right to place the <span className="text-[#79c0ff] font-mono">T</span> marker over the CW tone peak</li>
            <li>Drag the <span className="text-[#e3b341] font-mono">SQL</span> line up or down to set the squelch — hover over it to see the ↕ cursor, then drag it just above the noise floor</li>
            <li>Speed is detected automatically — the WPM counter updates as it tracks the sender</li>
            <li>Decoded text appears in the output area character by character</li>
          </ol>
          <p className="mt-4 text-xs sm:text-sm text-[#8b949e]">
            Tip: On the spectrogram, a CW signal appears as a single intermittent vertical line. Align the T marker with that line.
          </p>
        </div>
      </details>
    </div>
  );
}
