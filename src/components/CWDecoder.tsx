'use client';

import { useEffect, useRef, useCallback, useState, useMemo } from 'react';
import { useCWProcessor, TextToken } from '@/hooks/useCWProcessor';

const DISPLAY_MAX_HZ = 1500;
const CANVAS_H = 200;
const AXIS_H   = 25;
const PLOT_H   = CANVAS_H - AXIS_H;

// Channel colour palette
const CH_COLORS = {
  0: { primary: '#79c0ff', dot: '#79c0ff', dash: '#2ea043', recv: '#e3b341', text: '#c9d1d9', flash: '#f0f6fc' },
  1: { primary: '#ffa657', dot: '#ffa657', dash: '#d2a8ff', recv: '#ff7b72', text: '#ffa657', flash: '#ffa657' },
} as const;

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
  ctx.fillStyle = '#e3b341';
  ctx.beginPath(); ctx.moveTo(0, y - 5); ctx.lineTo(9, y); ctx.lineTo(0, y + 5); ctx.closePath(); ctx.fill();
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
  color = '#79c0ff',
  label = 'CF',
  halfBandHz = 90,
) {
  const toneX  = (toneFreq / DISPLAY_MAX_HZ) * canvasWidth;
  const bandLo = Math.max(0, ((toneFreq - halfBandHz) / DISPLAY_MAX_HZ) * canvasWidth);
  const bandHi = Math.min(canvasWidth, ((toneFreq + halfBandHz) / DISPLAY_MAX_HZ) * canvasWidth);

  // Band fill
  const [r, g, b] = color === '#ffa657' ? [255, 166, 87] : [121, 192, 255];
  ctx.fillStyle = `rgba(${r},${g},${b},0.07)`;
  ctx.fillRect(bandLo, 0, bandHi - bandLo, plotHeight);

  // Band edges
  ctx.lineWidth = 1; ctx.setLineDash([2, 4]);
  ctx.strokeStyle = `rgba(${r},${g},${b},0.30)`;
  ctx.beginPath(); ctx.moveTo(bandLo, 0); ctx.lineTo(bandLo, plotHeight); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(bandHi, 0); ctx.lineTo(bandHi, plotHeight); ctx.stroke();
  ctx.setLineDash([]);

  // Centre line
  ctx.lineWidth = 1.5; ctx.setLineDash([4, 3]);
  ctx.strokeStyle = color;
  ctx.beginPath(); ctx.moveTo(toneX, 0); ctx.lineTo(toneX, plotHeight); ctx.stroke();
  ctx.setLineDash([]);

  // Peak hold
  if (peakLevel > 0) {
    const y = plotHeight * (1 - peakLevel / 255);
    ctx.strokeStyle = color; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(bandLo, y); ctx.lineTo(bandHi, y); ctx.stroke();
  }

  // Label
  ctx.font = '10px monospace'; ctx.textAlign = 'center';
  ctx.fillStyle = color;
  ctx.fillText(label, toneX, 14);
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

// ── Toggle switch ─────────────────────────────────────────────────────────────

function Toggle({ checked, onChange }: { checked: boolean; onChange: () => void }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      onClick={onChange}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors focus:outline-none ${
        checked ? 'bg-[#238636] border-[#2ea043]' : 'bg-[#21262d] border-[#30363d]'
      }`}
    >
      <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow-sm transition-transform ${
        checked ? 'translate-x-4' : 'translate-x-0.5'
      }`} />
    </button>
  );
}

// ── Morse Visualizer ─────────────────────────────────────────────────────────

interface MorseElementEntry { id: number; type: 'dot' | 'dash'; }
interface RecentCharEntry   { id: number; char: string; symbol: string; }

function MorseVisualizer({
  elements,
  flashChar,
  recentChars,
  isReceiving,
  channel = 0,
  label,
}: {
  elements:    MorseElementEntry[];
  flashChar:   RecentCharEntry | null;
  recentChars: RecentCharEntry[];
  isReceiving: boolean;
  channel?:    0 | 1;
  label?:      string;
}) {
  const c = CH_COLORS[channel];

  return (
    <div>
      <style>{`
        @keyframes cwElementPop {
          0%   { transform: scale(0) translateY(6px); opacity: 0; }
          55%  { transform: scale(1.25) translateY(-3px); opacity: 1; }
          100% { transform: scale(1) translateY(0); opacity: 1; }
        }
        @keyframes cwMarkPulse {
          0%, 100% { opacity: 0.25; transform: scale(0.75); }
          50%       { opacity: 1;    transform: scale(1.05); }
        }
        @keyframes cwCharReveal {
          0%   { transform: scale(0.2) translateY(10px); opacity: 0; filter: blur(6px); }
          25%  { transform: scale(1.2) translateY(-5px); opacity: 1; filter: blur(0); }
          55%  { transform: scale(1)   translateY(0);    opacity: 1; filter: blur(0); }
          80%  { transform: scale(1)   translateY(0);    opacity: 1; filter: blur(0); }
          100% { transform: scale(1.1) translateY(-6px); opacity: 0; filter: blur(3px); }
        }
        @keyframes cwRecentPop {
          0%   { transform: translateY(8px) scale(0.7); opacity: 0; }
          100% { transform: translateY(0)   scale(1);   opacity: 1; }
        }
      `}</style>

      <div className="flex items-center justify-between mb-1.5">
        {label
          ? <h3 className="text-xs font-semibold" style={{ color: c.primary }}>{label}</h3>
          : <h3 className="text-sm font-medium text-[#8b949e]">Morse Display</h3>
        }
        <span className="text-[10px] font-mono text-[#484f58]">
          {isReceiving ? '⏺ receiving' : elements.length > 0 ? 'building…' : 'monitoring'}
        </span>
      </div>

      <div className="bg-[#0d1117] border border-[#30363d] rounded-lg px-3 py-2.5 space-y-2.5">
        {/* Elements row */}
        <div className="flex items-center justify-center gap-2.5 min-h-[24px] flex-wrap">
          {elements.map((el) =>
            el.type === 'dot' ? (
              <div
                key={el.id}
                className="w-4 h-4 rounded-full shrink-0"
                style={{
                  background: c.dot,
                  boxShadow: `0 0 8px 2px ${c.dot}80`,
                  animation: 'cwElementPop 0.2s cubic-bezier(0.34,1.56,0.64,1) forwards',
                }}
              />
            ) : (
              <div
                key={el.id}
                className="w-10 h-4 rounded-full shrink-0"
                style={{
                  background: c.dash,
                  boxShadow: `0 0 8px 2px ${c.dash}80`,
                  animation: 'cwElementPop 0.2s cubic-bezier(0.34,1.56,0.64,1) forwards',
                }}
              />
            )
          )}
          {isReceiving && (
            <div
              className="w-4 h-4 rounded-full shrink-0"
              style={{
                background: c.recv,
                boxShadow: `0 0 10px 3px ${c.recv}80`,
                animation: 'cwMarkPulse 0.5s ease-in-out infinite',
              }}
            />
          )}
          {elements.length === 0 && !isReceiving && (
            <span className="text-[#30363d] text-xs font-mono tracking-[0.4em] select-none">· · ·</span>
          )}
        </div>

        {/* Flash character */}
        <div className="flex items-center justify-center" style={{ minHeight: 48 }}>
          {flashChar ? (
            <span
              key={flashChar.id}
              className={`font-mono font-bold leading-none select-none ${
                flashChar.char.startsWith('<') ? 'text-xl' :
                flashChar.char === '?' ? 'text-3xl' :
                'text-4xl'
              }`}
              style={{
                color: flashChar.char === '?' ? '#da3633' : c.flash,
                textShadow: flashChar.char === '?'
                  ? '0 0 16px rgba(218,54,51,0.8)'
                  : `0 0 18px ${c.flash}88, 0 0 36px ${c.primary}44`,
                animation: 'cwCharReveal 1.8s ease-in-out forwards',
              }}
            >
              {flashChar.char}
            </span>
          ) : (
            <div className="w-6 h-px bg-[#21262d]" />
          )}
        </div>

        {/* Recent chars strip */}
        {recentChars.length > 0 && (
          <div className="border-t border-[#21262d] pt-2 flex flex-wrap gap-x-2.5 gap-y-1 justify-center items-end">
            {recentChars.map((rc, i) => (
              <div
                key={rc.id}
                className="flex flex-col items-center gap-px"
                style={{
                  opacity: (i + 1) / recentChars.length * 0.85 + 0.15,
                  animation: i === recentChars.length - 1
                    ? 'cwRecentPop 0.25s cubic-bezier(0.34,1.56,0.64,1) forwards'
                    : 'none',
                }}
              >
                <span
                  className={`font-mono font-semibold leading-none ${
                    rc.char.startsWith('<') ? 'text-sm' :
                    rc.char === '?' ? 'text-base' :
                    'text-lg'
                  }`}
                  style={{ color: rc.char === '?' ? '#da3633' : c.text }}
                >
                  {rc.char}
                </span>
                <span className="text-[8px] font-mono text-[#484f58] tracking-wide">
                  {rc.symbol}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function CWDecoder() {
  const [toneFreq,          setToneFreq]          = useState(700);
  const [toneFreq2,         setToneFreq2]         = useState(800);
  const [squelch,           setSquelch]           = useState(20);
  const [adaptiveDitLength, setAdaptiveDitLength] = useState(false);
  const [manualWpm,         setManualWpm]         = useState(20);
  const [dualMode,          setDualMode]          = useState(false);
  // Filter bandwidth in Hz — Q is derived per-render so bandwidth stays constant
  // when the center frequency changes (Q = freq / bandwidth).
  const [filterBandwidth,   setFilterBandwidth]   = useState(90);

  const toneFreqRef        = useRef(700);
  const toneFreq2Ref       = useRef(800);
  const squelchRef         = useRef(20);
  const dualModeRef        = useRef(false);
  const filterBandwidthRef = useRef(90);
  useEffect(() => { toneFreqRef.current        = toneFreq;        }, [toneFreq]);
  useEffect(() => { toneFreq2Ref.current       = toneFreq2;       }, [toneFreq2]);
  useEffect(() => { squelchRef.current         = squelch;         }, [squelch]);
  useEffect(() => { dualModeRef.current        = dualMode;        }, [dualMode]);
  useEffect(() => { filterBandwidthRef.current = filterBandwidth; }, [filterBandwidth]);

  // Q is derived each render; stays stable for spectrum drawing via ref
  const filterQ    = useMemo(() => Math.max(1, toneFreq / filterBandwidth),  [toneFreq, filterBandwidth]);
  const filterQRef = useRef(filterQ);
  useEffect(() => { filterQRef.current = filterQ; }, [filterQ]);

  // Visualizer state — ch1
  const [morseElements, setMorseElements] = useState<MorseElementEntry[]>([]);
  const [flashChar,     setFlashChar]     = useState<RecentCharEntry | null>(null);
  const [recentChars,   setRecentChars]   = useState<RecentCharEntry[]>([]);
  // Visualizer state — ch2
  const [morseElements2, setMorseElements2] = useState<MorseElementEntry[]>([]);
  const [flashChar2,     setFlashChar2]     = useState<RecentCharEntry | null>(null);
  const [recentChars2,   setRecentChars2]   = useState<RecentCharEntry[]>([]);

  const visCounterRef    = useRef(0);
  const flashTimeoutRef  = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flashTimeout2Ref = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Track previous partialSymbol to detect appended elements vs resets
  const prevSym1Ref = useRef('');
  const prevSym2Ref = useRef('');

  const {
    state, startRecording, stopRecording, clearText, resetDecoder, getAnalyser,
    onCharRef, onCharRef2,
    // onElementRef / onElementRef2 intentionally unused — elements are derived
    // from stats.partialSymbol instead, avoiding React-batch ordering issues.
  } = useCWProcessor(toneFreq, squelch, adaptiveDitLength, dualMode, toneFreq2, manualWpm, filterQ);

  // ── Element display driven by stats.partialSymbol (source of truth) ──────────
  // This avoids React-batch ordering bugs that occurred when onElement callbacks
  // and onCharDecoded clears landed in the same render cycle.

  useEffect(() => {
    const sym  = state.stats?.partialSymbol ?? '';
    const prev = prevSym1Ref.current;
    if (sym === prev) return;

    if (sym.length > prev.length && sym.startsWith(prev)) {
      // Symbol grew — append new elements
      const newEls = sym.slice(prev.length).split('').map(ch => ({
        id:   visCounterRef.current++,
        type: (ch === '.' ? 'dot' : 'dash') as 'dot' | 'dash',
      }));
      setMorseElements(els => [...els, ...newEls]);
    } else {
      // Symbol reset or shortened — rebuild (handles character flush & decoder reset)
      const newEls = sym.split('').map(ch => ({
        id:   visCounterRef.current++,
        type: (ch === '.' ? 'dot' : 'dash') as 'dot' | 'dash',
      }));
      setMorseElements(newEls);
    }

    prevSym1Ref.current = sym;
  }, [state.stats?.partialSymbol]);

  useEffect(() => {
    const sym  = state.stats2?.partialSymbol ?? '';
    const prev = prevSym2Ref.current;
    if (sym === prev) return;

    if (sym.length > prev.length && sym.startsWith(prev)) {
      const newEls = sym.slice(prev.length).split('').map(ch => ({
        id:   visCounterRef.current++,
        type: (ch === '.' ? 'dot' : 'dash') as 'dot' | 'dash',
      }));
      setMorseElements2(els => [...els, ...newEls]);
    } else {
      const newEls = sym.split('').map(ch => ({
        id:   visCounterRef.current++,
        type: (ch === '.' ? 'dot' : 'dash') as 'dot' | 'dash',
      }));
      setMorseElements2(newEls);
    }

    prevSym2Ref.current = sym;
  }, [state.stats2?.partialSymbol]);

  // ── onCharRef — flash character + recent strip only ───────────────────────────

  useEffect(() => {
    onCharRef.current = (char, symbol) => {
      if (char === ' ') return;
      const id = visCounterRef.current++;
      if (flashTimeoutRef.current) clearTimeout(flashTimeoutRef.current);
      const entry: RecentCharEntry = { id, char, symbol };
      setFlashChar(entry);
      setRecentChars(prev => [...prev.slice(-9), entry]);
      flashTimeoutRef.current = setTimeout(() => setFlashChar(null), 1800);
    };
    return () => { onCharRef.current = null; };
  }, [onCharRef]);

  useEffect(() => {
    onCharRef2.current = (char, symbol) => {
      if (char === ' ') return;
      const id = visCounterRef.current++;
      if (flashTimeout2Ref.current) clearTimeout(flashTimeout2Ref.current);
      const entry: RecentCharEntry = { id, char, symbol };
      setFlashChar2(entry);
      setRecentChars2(prev => [...prev.slice(-9), entry]);
      flashTimeout2Ref.current = setTimeout(() => setFlashChar2(null), 1800);
    };
    return () => { onCharRef2.current = null; };
  }, [onCharRef2]);

  // Clear live visualizer state when recording stops
  useEffect(() => {
    if (!state.isRecording) {
      setMorseElements([]); setFlashChar(null);
      setMorseElements2([]); setFlashChar2(null);
      prevSym1Ref.current = '';
      prevSym2Ref.current = '';
      if (flashTimeoutRef.current)  { clearTimeout(flashTimeoutRef.current);  flashTimeoutRef.current  = null; }
      if (flashTimeout2Ref.current) { clearTimeout(flashTimeout2Ref.current); flashTimeout2Ref.current = null; }
    }
  }, [state.isRecording]);

  const spectrumCanvasRef    = useRef<HTMLCanvasElement>(null);
  const spectrogramCanvasRef = useRef<HTMLCanvasElement>(null);
  const animationFrameRef    = useRef<number | null>(null);
  const textDivRef           = useRef<HTMLDivElement>(null);
  const dragModeRef          = useRef<'tone' | 'tone2' | 'squelch' | null>(null);
  const spectrogramFrameRef  = useRef(0);
  const tonePeakRef          = useRef(0);
  const tonePeak2Ref         = useRef(0);

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
    window.addEventListener('mouseup',   onUp);
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
  }, []);

  // Auto-scroll text div when new tokens arrive
  useEffect(() => {
    const el = textDivRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [state.tokens]);

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

      // Track T1 peak
      const tf   = toneFreqRef.current;
      const tBin = Math.min(Math.round((tf / DISPLAY_MAX_HZ) * (binsShow - 1)), binsShow - 1);
      const tLvl = tBin >= 0 ? (visibleData[tBin] ?? 0) : 0;
      tonePeakRef.current = tLvl > tonePeakRef.current ? tLvl : Math.max(0, tonePeakRef.current - 0.4);

      // Track T2 peak (only in dual mode)
      if (dualModeRef.current) {
        const tf2   = toneFreq2Ref.current;
        const tBin2 = Math.min(Math.round((tf2 / DISPLAY_MAX_HZ) * (binsShow - 1)), binsShow - 1);
        const tLvl2 = tBin2 >= 0 ? (visibleData[tBin2] ?? 0) : 0;
        tonePeak2Ref.current = tLvl2 > tonePeak2Ref.current ? tLvl2 : Math.max(0, tonePeak2Ref.current - 0.4);
      }
    } else {
      tonePeakRef.current  = Math.max(0, tonePeakRef.current  - 0.4);
      tonePeak2Ref.current = Math.max(0, tonePeak2Ref.current - 0.4);
    }

    const isDual = dualModeRef.current;
    const halfBw = filterBandwidthRef.current / 2;
    drawToneMarker(ctx, canvas.width, PLOT_H, toneFreqRef.current, tonePeakRef.current, '#79c0ff', isDual ? 'A' : 'CF', halfBw);
    if (isDual) {
      drawToneMarker(ctx, canvas.width, PLOT_H, toneFreq2Ref.current, tonePeak2Ref.current, '#ffa657', 'B', halfBw);
    }
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

  // ── Spectrum interaction ───────────────────────────────────────────────────

  useEffect(() => {
    const canvas = spectrumCanvasRef.current;
    if (!canvas) return;

    const getSqlClientY = () => {
      const rect = canvas.getBoundingClientRect();
      return rect.top + PLOT_H * (1 - squelchRef.current / 100) * (rect.height / CANVAS_H);
    };
    const isNearSql = (clientY: number) =>
      squelchRef.current > 0 && Math.abs(clientY - getSqlClientY()) < 10;

    const getToneClientX = (freq: number) => {
      const rect = canvas.getBoundingClientRect();
      return rect.left + (freq / DISPLAY_MAX_HZ) * rect.width;
    };
    const isNearTone2 = (clientX: number) => {
      if (!dualModeRef.current) return false;
      return Math.abs(clientX - getToneClientX(toneFreq2Ref.current)) < 15;
    };

    const freqFromClientX = (clientX: number) => {
      const rect = canvas.getBoundingClientRect();
      return Math.round(Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) * DISPLAY_MAX_HZ);
    };
    const applyTone  = (x: number) => setToneFreq(freqFromClientX(x));
    const applyTone2 = (x: number) => setToneFreq2(freqFromClientX(x));
    const applySquelch = (clientY: number) => {
      const rect    = canvas.getBoundingClientRect();
      const plotPx  = rect.height * (PLOT_H / CANVAS_H);
      const relY    = Math.max(0, Math.min(1, (clientY - rect.top) / plotPx));
      setSquelch(Math.max(0, Math.min(100, Math.round((1 - relY) * 100))));
    };

    const onMouseDown = (e: MouseEvent) => {
      if (isNearSql(e.clientY))    { dragModeRef.current = 'squelch'; applySquelch(e.clientY); }
      else if (isNearTone2(e.clientX)) { dragModeRef.current = 'tone2'; applyTone2(e.clientX); }
      else                          { dragModeRef.current = 'tone';    applyTone(e.clientX); }
    };
    const onMouseMove = (e: MouseEvent) => {
      const mode = dragModeRef.current;
      if      (mode === 'tone')    applyTone(e.clientX);
      else if (mode === 'tone2')   applyTone2(e.clientX);
      else if (mode === 'squelch') applySquelch(e.clientY);
      else {
        if      (isNearSql(e.clientY))    canvas.style.cursor = 'ns-resize';
        else if (isNearTone2(e.clientX))  canvas.style.cursor = 'ew-resize';
        else                              canvas.style.cursor = 'crosshair';
      }
    };
    const onMouseUp = () => { dragModeRef.current = null; };

    const onTouchStart = (e: TouchEvent) => {
      e.preventDefault();
      const t = e.touches[0];
      if (isNearSql(t.clientY))    { dragModeRef.current = 'squelch'; applySquelch(t.clientY); }
      else if (isNearTone2(t.clientX)) { dragModeRef.current = 'tone2'; applyTone2(t.clientX); }
      else                          { dragModeRef.current = 'tone';    applyTone(t.clientX); }
    };
    const onTouchMove = (e: TouchEvent) => {
      e.preventDefault();
      const t = e.touches[0];
      const mode = dragModeRef.current;
      if      (mode === 'tone')    applyTone(t.clientX);
      else if (mode === 'tone2')   applyTone2(t.clientX);
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

  const handleReset = () => {
    resetDecoder();
    tonePeakRef.current  = 0;
    tonePeak2Ref.current = 0;
    prevSym1Ref.current  = '';
    prevSym2Ref.current  = '';
    setMorseElements([]); setFlashChar(null); setRecentChars([]);
    setMorseElements2([]); setFlashChar2(null); setRecentChars2([]);
    if (flashTimeoutRef.current)  { clearTimeout(flashTimeoutRef.current);  flashTimeoutRef.current  = null; }
    if (flashTimeout2Ref.current) { clearTimeout(flashTimeout2Ref.current); flashTimeout2Ref.current = null; }
  };

  const handleCopyText = () => {
    const text = state.tokens.map(t => t.text).join('');
    if (!text) return;
    navigator.clipboard.writeText(text).catch(() => {});
  };

  // ── Derived ───────────────────────────────────────────────────────────────

  const stats  = state.stats;
  const stats2 = state.stats2;

  const snrColor = stats?.snrDb == null ? 'text-[#8b949e]'
    : stats.snrDb < 6  ? 'text-[#da3633]'
    : stats.snrDb < 15 ? 'text-[#e3b341]'
    : 'text-[#2ea043]';

  const hasText = state.tokens.length > 0;
  const charCount = useMemo(
    () => state.tokens.map(t => t.text).join('').replace(/ /g, '').length,
    [state.tokens],
  );

  // Coalesce consecutive same-channel tokens to minimise DOM span count
  const coalescedTokens = useMemo<TextToken[]>(() => {
    const result: TextToken[] = [];
    for (const tok of state.tokens) {
      const last = result[result.length - 1];
      if (last && last.channel === tok.channel) {
        result[result.length - 1] = { text: last.text + tok.text, channel: tok.channel };
      } else {
        result.push({ text: tok.text, channel: tok.channel });
      }
    }
    return result;
  }, [state.tokens]);

  const halfBw      = filterBandwidth / 2;
  const tone1BandLo = Math.max(0, toneFreq - halfBw);
  const tone1BandHi = Math.min(DISPLAY_MAX_HZ, toneFreq + halfBw);
  const tone2BandLo = Math.max(0, toneFreq2 - halfBw);
  const tone2BandHi = Math.min(DISPLAY_MAX_HZ, toneFreq2 + halfBw);

  // ── Render ───────────────────────────────────────────────────────────────

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
            disabled={!hasText}
            className="w-full sm:flex-1 bg-[#21262d] hover:bg-[#30363d] disabled:opacity-40 disabled:cursor-not-allowed text-white font-semibold px-6 py-3 rounded-md transition-colors text-base border border-[#30363d] flex items-center justify-center gap-2"
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
              <path d="M8 3a1 1 0 011-1h2a1 1 0 110 2H9a1 1 0 01-1-1z" />
              <path d="M6 3a2 2 0 00-2 2v11a2 2 0 002 2h8a2 2 0 002-2V5a2 2 0 00-2-2 3 3 0 01-3 3H9a3 3 0 01-3-3z" />
            </svg>
            Copy Text
          </button>
        </div>

        {/* Options row */}
        <div className="flex flex-wrap items-center gap-x-5 gap-y-3 pt-0.5 text-sm">

          {/* Adaptive WPM: adaptive estimate always visible; input is editable when mode is off */}
          <div className="flex items-center gap-2.5">
            <Toggle
              checked={adaptiveDitLength}
              onChange={() => {
                // Seed the manual input with the background adaptive estimate when turning off
                if (adaptiveDitLength && stats?.adaptiveWpm) setManualWpm(stats.adaptiveWpm);
                setAdaptiveDitLength(v => !v);
              }}
            />
            <span className="text-[#c9d1d9] cursor-default select-none">Adaptive WPM</span>
            {adaptiveDitLength ? (
              // ON: adaptive estimate drives the decoder — show it as the live speed
              <div className="flex items-center gap-1.5">
                <span className="font-mono text-sm text-[#2ea043] tabular-nums min-w-[2.5ch]">
                  {stats?.adaptiveWpm ?? '—'}
                </span>
                <span className="text-xs text-[#484f58]">WPM</span>
              </div>
            ) : (
              // OFF: manual input + always-running adaptive estimate shown as suggestion
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  value={manualWpm}
                  min={3} max={70}
                  onChange={(e) => {
                    const v = parseInt(e.target.value);
                    if (!isNaN(v)) setManualWpm(Math.max(3, Math.min(70, v)));
                  }}
                  className="bg-[#0d1117] border border-[#30363d] rounded px-2 py-0.5 w-14 text-[#c9d1d9] font-mono text-sm focus:outline-none focus:border-[#79c0ff] transition-colors"
                />
                <span className="text-xs text-[#8b949e]">WPM</span>
                {stats?.adaptiveWpm != null && (
                  <span className="text-xs text-[#484f58]">
                    (suggest&nbsp;
                    <button
                      className="text-[#2ea043] hover:underline font-mono"
                      onClick={() => setManualWpm(stats.adaptiveWpm!)}
                    >
                      {stats.adaptiveWpm}
                    </button>
                    )
                  </span>
                )}
              </div>
            )}
          </div>

          {/* Center frequency + bandwidth */}
          <div className="flex items-center gap-2">
            <span className="text-[#8b949e]">Center</span>
            <input
              type="number"
              value={toneFreq}
              min={100} max={DISPLAY_MAX_HZ}
              onChange={(e) => {
                const v = parseInt(e.target.value);
                if (!isNaN(v)) setToneFreq(Math.max(100, Math.min(DISPLAY_MAX_HZ, v)));
              }}
              className="bg-[#0d1117] border border-[#30363d] rounded px-2 py-0.5 w-20 text-[#79c0ff] font-mono text-sm focus:outline-none focus:border-[#79c0ff] transition-colors"
            />
            {dualMode && (
              <>
                <span className="text-[#484f58] text-xs">/</span>
                <input
                  type="number"
                  value={toneFreq2}
                  min={100} max={DISPLAY_MAX_HZ}
                  onChange={(e) => {
                    const v = parseInt(e.target.value);
                    if (!isNaN(v)) setToneFreq2(Math.max(100, Math.min(DISPLAY_MAX_HZ, v)));
                  }}
                  className="bg-[#0d1117] border border-[#ffa657]/40 rounded px-2 py-0.5 w-20 text-[#ffa657] font-mono text-sm focus:outline-none focus:border-[#ffa657] transition-colors"
                />
              </>
            )}
            <span className="text-xs text-[#8b949e]">Hz</span>
          </div>

          {/* Filter bandwidth */}
          <div className="flex items-center gap-2">
            <span className="text-[#8b949e]">Bandwidth</span>
            <input
              type="number"
              value={filterBandwidth}
              min={30} max={500} step={10}
              onChange={(e) => {
                const v = parseInt(e.target.value);
                if (!isNaN(v)) setFilterBandwidth(Math.max(30, Math.min(500, v)));
              }}
              className="bg-[#0d1117] border border-[#30363d] rounded px-2 py-0.5 w-20 text-[#c9d1d9] font-mono text-sm focus:outline-none focus:border-[#2ea043] transition-colors"
            />
            <span className="text-xs text-[#8b949e]">Hz</span>
          </div>

          {/* A/B mode */}
          <div className="flex items-center gap-2.5">
            <Toggle checked={dualMode} onChange={() => setDualMode(v => !v)} />
            <span className="text-[#c9d1d9] cursor-default select-none">A/B Mode</span>
          </div>

        </div>

        {state.error && (
          <div className="bg-[#da3633]/10 border border-[#f85149]/30 rounded-md p-3 text-[#f85149] text-sm">
            {state.error}
          </div>
        )}

        {state.isRecording && (
          <div className={`grid gap-3 sm:gap-4 text-sm ${dualMode ? 'grid-cols-2 lg:grid-cols-6' : 'grid-cols-2 lg:grid-cols-4'}`}>
            {/* Speed */}
            <div className="bg-[#0d1117] border border-[#30363d] rounded-lg p-3">
              <div className="text-[#8b949e] text-xs mb-1">{dualMode ? 'Speed A' : 'Speed'}</div>
              <div className="font-mono font-semibold text-sm text-[#79c0ff]">
                {stats?.wpm ?? '—'} <span className="text-[#8b949e] font-normal text-xs">WPM</span>
              </div>
            </div>
            {dualMode && (
              <div className="bg-[#0d1117] border border-[#30363d] rounded-lg p-3">
                <div className="text-[#8b949e] text-xs mb-1">Speed B</div>
                <div className="font-mono font-semibold text-sm text-[#ffa657]">
                  {stats2?.wpm ?? '—'} <span className="text-[#8b949e] font-normal text-xs">WPM</span>
                </div>
              </div>
            )}
            {/* Tone state */}
            <div className="bg-[#0d1117] border border-[#30363d] rounded-lg p-3">
              <div className="text-[#8b949e] text-xs mb-1">{dualMode ? 'Ch A State' : 'Tone / SQL'}</div>
              <div className="font-mono font-semibold text-sm">
                {stats?.squelched
                  ? <span className="text-[#e3b341]">Squelched</span>
                  : stats?.toneDetected
                    ? <span className="text-[#79c0ff] flex items-center gap-1.5"><span className="inline-block w-2 h-2 rounded-full bg-[#79c0ff] animate-pulse shrink-0" />Mark</span>
                    : <span className="text-[#8b949e]">Space</span>
                }
              </div>
            </div>
            {dualMode && (
              <div className="bg-[#0d1117] border border-[#30363d] rounded-lg p-3">
                <div className="text-[#8b949e] text-xs mb-1">Ch B State</div>
                <div className="font-mono font-semibold text-sm">
                  {stats2?.squelched
                    ? <span className="text-[#e3b341]">Squelched</span>
                    : stats2?.toneDetected
                      ? <span className="text-[#ffa657] flex items-center gap-1.5"><span className="inline-block w-2 h-2 rounded-full bg-[#ffa657] animate-pulse shrink-0" />Mark</span>
                      : <span className="text-[#8b949e]">Space</span>
                  }
                </div>
              </div>
            )}
            {/* Chars */}
            <div className="bg-[#0d1117] border border-[#30363d] rounded-lg p-3">
              <div className="text-[#8b949e] text-xs mb-1">Chars</div>
              <div className="font-mono font-semibold text-sm">{charCount}</div>
            </div>
            {/* SNR */}
            <div className="bg-[#0d1117] border border-[#30363d] rounded-lg p-3">
              <div className="text-[#8b949e] text-xs mb-1">SNR (T1)</div>
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
              {dualMode && (
                <div className="flex items-center gap-2 text-xs font-mono">
                  <span className="flex items-center gap-1"><span className="inline-block w-2 h-2 rounded-full bg-[#79c0ff]" />Ch A</span>
                  <span className="flex items-center gap-1"><span className="inline-block w-2 h-2 rounded-full bg-[#ffa657]" />Ch B</span>
                </div>
              )}
              <span className="text-xs text-[#8b949e] font-mono">{charCount} chars</span>
              <button
                onClick={clearText}
                disabled={!hasText}
                className="text-xs px-2 py-0.5 rounded border border-[#30363d] text-[#8b949e] hover:text-[#f85149] hover:border-[#f85149]/40 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              >
                Clear
              </button>
            </div>
          </div>

          {/* Coloured text output (replaces textarea for dual-channel colour support) */}
          <div
            ref={textDivRef}
            className="flex-1 min-h-[300px] w-full bg-[#0d1117] border border-[#30363d] rounded font-mono text-sm p-3 overflow-y-auto focus:outline-none leading-snug whitespace-pre-wrap break-words"
            tabIndex={0}
            aria-label="Decoded CW text"
            aria-live="polite"
          >
            {coalescedTokens.length === 0 ? (
              <span className="text-[#30363d]">Decoded CW text will appear here{dualMode ? ' — Ch A blue · Ch B orange' : '…'}</span>
            ) : (
              coalescedTokens.map((tok, i) => (
                <span key={i} style={{ color: CH_COLORS[tok.channel].text }}>
                  {tok.text}
                </span>
              ))
            )}
          </div>
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
              <span className="text-xs text-[#8b949e] font-mono">
                {dualMode ? 'drag A/B · drag ↕ SQL' : 'drag ← → CF · drag ↕ SQL line'}
              </span>
            </div>
            <canvas
              ref={spectrumCanvasRef}
              width={640} height={CANVAS_H}
              className="w-full border border-[#30363d] rounded bg-[#0d1117] touch-manipulation cursor-crosshair select-none"
            />
          </div>

          {/* Freq readout */}
          <div className="flex flex-wrap items-center gap-3 mt-2 text-xs font-mono text-[#8b949e]">
            <span><span className="text-[#79c0ff]">{dualMode ? 'A' : 'CF'}</span> {toneFreq} Hz</span>
            {dualMode && <span><span className="text-[#ffa657]">B</span> {toneFreq2} Hz</span>}
            <span>BW {filterBandwidth} Hz</span>
          </div>

          {/* Morse Visualizer(s) */}
          {state.isRecording && (
            <div className={`mt-3 sm:mt-4 ${dualMode ? 'grid grid-cols-2 gap-3' : ''}`}>
              <MorseVisualizer
                elements={morseElements}
                flashChar={flashChar}
                recentChars={recentChars}
                isReceiving={stats?.toneDetected ?? false}
                channel={0}
                label={dualMode ? 'Channel 1' : undefined}
              />
              {dualMode && (
                <MorseVisualizer
                  elements={morseElements2}
                  flashChar={flashChar2}
                  recentChars={recentChars2}
                  isReceiving={stats2?.toneDetected ?? false}
                  channel={1}
                  label="Channel 2"
                />
              )}
            </div>
          )}

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

              {/* T1 band overlay */}
              <div className="absolute inset-y-0 pointer-events-none" style={{
                left:            `${(tone1BandLo / DISPLAY_MAX_HZ) * 100}%`,
                width:           `${((tone1BandHi - tone1BandLo) / DISPLAY_MAX_HZ) * 100}%`,
                backgroundColor: 'rgba(121,192,255,0.07)',
                borderLeft:      '1px solid rgba(121,192,255,0.28)',
                borderRight:     '1px solid rgba(121,192,255,0.28)',
              }} />
              {toneFreq >= 0 && toneFreq <= DISPLAY_MAX_HZ && (
                <div className="absolute inset-y-0 pointer-events-none" style={{
                  left: `${(toneFreq / DISPLAY_MAX_HZ) * 100}%`, width: '2px',
                  backgroundColor: '#79c0ff', opacity: 0.9,
                }}>
                  <span className="absolute top-1 left-1 text-[10px] font-mono font-bold text-[#79c0ff] leading-none drop-shadow-md">
                    {dualMode ? 'A' : 'CF'}
                  </span>
                </div>
              )}

              {/* T2 band overlay */}
              {dualMode && (
                <>
                  <div className="absolute inset-y-0 pointer-events-none" style={{
                    left:            `${(tone2BandLo / DISPLAY_MAX_HZ) * 100}%`,
                    width:           `${((tone2BandHi - tone2BandLo) / DISPLAY_MAX_HZ) * 100}%`,
                    backgroundColor: 'rgba(255,166,87,0.07)',
                    borderLeft:      '1px solid rgba(255,166,87,0.28)',
                    borderRight:     '1px solid rgba(255,166,87,0.28)',
                  }} />
                  {toneFreq2 >= 0 && toneFreq2 <= DISPLAY_MAX_HZ && (
                    <div className="absolute inset-y-0 pointer-events-none" style={{
                      left: `${(toneFreq2 / DISPLAY_MAX_HZ) * 100}%`, width: '2px',
                      backgroundColor: '#ffa657', opacity: 0.9,
                    }}>
                      <span className="absolute top-1 left-1 text-[10px] font-mono font-bold text-[#ffa657] leading-none drop-shadow-md">B</span>
                    </div>
                  )}
                </>
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
            <li>Drag the <span className="text-[#e3b341] font-mono">SQL</span> line up or down to set squelch — hover it to see the ↕ cursor, then drag just above the noise floor</li>
            <li>Enable <strong>A/B Mode</strong> to decode two simultaneous CW stations — drag the <span className="text-[#ffa657] font-mono">B</span> marker to the second tone, or type its frequency in the B input</li>
            <li>In A/B mode, <span className="text-[#79c0ff]">Ch A text is blue</span> and <span className="text-[#ffa657]">Ch B text is orange</span> in the output panel</li>
            <li>Use <strong>Bandwidth</strong> to widen or narrow the bandpass filter — narrow (50–80 Hz) for clean signals, wider (150–300 Hz) for drifting or noisy ones</li>
          </ol>
          <p className="mt-4 text-xs sm:text-sm text-[#8b949e]">
            Tip: On the spectrogram, a CW signal appears as a single intermittent vertical line. Align the T marker with that line.
          </p>
        </div>
      </details>

      {/* ── Privacy ── */}
      <details className="bg-[#161b22] border border-[#30363d] rounded-lg">
        <summary className="cursor-pointer p-4 sm:p-6 font-semibold text-lg sm:text-xl hover:bg-[#21262d] rounded-lg transition-colors select-none">
          Privacy
        </summary>
        <div className="px-4 pb-4 sm:px-6 sm:pb-6 space-y-3 text-sm sm:text-base text-[#c9d1d9]">
          <p>This application runs entirely in your browser. No audio data or decoded text is ever transmitted to any server.</p>
          <p>The microphone permission is only used to capture and process the audio signal in real-time for CW decoding using the Web Audio API.</p>
          <p className="text-xs sm:text-sm text-[#8b949e]">Your privacy is fully protected — we don&apos;t collect, store, or transmit any of your data.</p>
        </div>
      </details>
    </div>
  );
}
