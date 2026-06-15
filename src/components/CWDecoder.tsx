'use client';

import { useEffect, useRef, useCallback, useState, useMemo, forwardRef, useImperativeHandle } from 'react';
import type { DecoderControls, DecoderProps } from './DecoderControls';
import AudioAnalysisPanel from './AudioAnalysisPanel';
import { useCWProcessor, TextToken } from '@/hooks/useCWProcessor';

const DISPLAY_MAX_HZ = 4000;

// Channel colour palette
const CH_COLORS = {
  0: { primary: '#79c0ff', dot: '#79c0ff', dash: '#2ea043', recv: '#e3b341', text: '#c9d1d9', flash: '#f0f6fc' },
  1: { primary: '#ffa657', dot: '#ffa657', dash: '#d2a8ff', recv: '#ff7b72', text: '#ffa657', flash: '#ffa657' },
} as const;

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

const CWDecoder = forwardRef<DecoderControls, DecoderProps>(function CWDecoder({ onStateChange, analyser }, ref) {
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

  // Resizable panels
  const containerRef    = useRef<HTMLDivElement>(null);
  const [panelWeights, setPanelWeights] = useState([1, 1, 0.75]);
  const panelWeightsRef = useRef([1, 1, 0.75]);
  const dragRef = useRef<{ handle: number; startX: number; startWeights: number[] } | null>(null);
  useEffect(() => { panelWeightsRef.current = panelWeights; }, [panelWeights]);

  const startDrag = (e: { preventDefault: () => void; clientX: number }, handle: number) => {
    e.preventDefault();
    dragRef.current = { handle, startX: e.clientX, startWeights: [...panelWeightsRef.current] };
  };

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const drag = dragRef.current;
      if (!drag || !containerRef.current) return;
      const containerWidth = containerRef.current.offsetWidth;
      const dx = e.clientX - drag.startX;
      const total = drag.startWeights.reduce((a, b) => a + b, 0);
      const dw = (dx / containerWidth) * total;
      const w = [...drag.startWeights];
      w[drag.handle]     = Math.max(0.15, w[drag.handle]     + dw);
      w[drag.handle + 1] = Math.max(0.15, w[drag.handle + 1] - dw);
      setPanelWeights([...w]);
    };
    const onUp = () => { dragRef.current = null; };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
  }, []);

  // Track previous partialSymbol to detect appended elements vs resets
  const prevSym1Ref = useRef('');
  const prevSym2Ref = useRef('');

  const {
    state, startRecording, stopRecording, clearText, resetDecoder,
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

  const textDivRef = useRef<HTMLDivElement>(null);

  // Auto-scroll text div when new tokens arrive
  useEffect(() => {
    const el = textDivRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [state.tokens]);

  // ── Handlers ─────────────────────────────────────────────────────────────

  const handleReset = useCallback(() => {
    resetDecoder();
    prevSym1Ref.current  = '';
    prevSym2Ref.current  = '';
    setMorseElements([]); setFlashChar(null); setRecentChars([]);
    setMorseElements2([]); setFlashChar2(null); setRecentChars2([]);
    if (flashTimeoutRef.current)  { clearTimeout(flashTimeoutRef.current);  flashTimeoutRef.current  = null; }
    if (flashTimeout2Ref.current) { clearTimeout(flashTimeout2Ref.current); flashTimeout2Ref.current = null; }
  }, [resetDecoder]);

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

  const controls: DecoderControls = {
    isRecording: state.isRecording,
    isSupported: state.isSupported,
    error: state.error ?? null,
    start: startRecording,
    stop: stopRecording,
    reset: handleReset,
  };
  useImperativeHandle(ref, () => controls, [state.isRecording, state.isSupported, state.error, startRecording, stopRecording, handleReset]); // eslint-disable-line react-hooks/exhaustive-deps
  const onStateChangeRef = useRef(onStateChange);
  onStateChangeRef.current = onStateChange;
  useEffect(() => { onStateChangeRef.current?.(controls); }, [state.isRecording, state.isSupported, state.error]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="space-y-4 sm:space-y-6">

      {/* ── 3-panel layout ── */}
      <div ref={containerRef} className="flex flex-col lg:flex-row lg:items-stretch gap-4 lg:gap-0">

        {/* Panel 1 — CW Output */}
        <div className="bg-[#161b22] border border-[#30363d] rounded-lg p-3 sm:p-4 flex flex-col min-w-0" style={{ flex: panelWeights[0] }}>
          <div className="flex items-center justify-between mb-2 sm:mb-3">
            <h2 className="text-lg sm:text-xl font-semibold">CW Output</h2>
            <div className="flex items-center gap-3">
              <div className={`flex items-center gap-2 text-xs font-mono transition-opacity ${dualMode ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}>
                <span className="flex items-center gap-1"><span className="inline-block w-2 h-2 rounded-full bg-[#79c0ff]" />Ch A</span>
                <span className="flex items-center gap-1"><span className="inline-block w-2 h-2 rounded-full bg-[#ffa657]" />Ch B</span>
              </div>
              <span className="text-xs text-[#8b949e] font-mono">{charCount} chars</span>
              <button
                onClick={handleCopyText}
                disabled={!hasText}
                className="text-xs px-2 py-0.5 rounded border border-[#30363d] text-[#8b949e] hover:text-[#79c0ff] hover:border-[#79c0ff]/40 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              >
                Copy
              </button>
              <button
                onClick={clearText}
                disabled={!hasText}
                className="text-xs px-2 py-0.5 rounded border border-[#30363d] text-[#8b949e] hover:text-[#f85149] hover:border-[#f85149]/40 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              >
                Clear
              </button>
            </div>
          </div>

          {/* Coloured text output */}
          <div
            ref={textDivRef}
            className="flex-1 min-h-[200px] w-full bg-[#0d1117] border border-[#30363d] rounded font-mono text-sm p-3 overflow-y-auto focus:outline-none leading-snug whitespace-pre-wrap break-words"
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

          {/* Morse Visualizer(s) — always rendered, dimmed when not recording */}
          <div className={`mt-3 sm:mt-4 grid gap-3 transition-opacity ${dualMode ? 'grid-cols-2' : 'grid-cols-1'} ${!state.isRecording ? 'opacity-30' : ''}`}>
            <MorseVisualizer
              elements={morseElements}
              flashChar={flashChar}
              recentChars={recentChars}
              isReceiving={stats?.toneDetected ?? false}
              channel={0}
              label={dualMode ? 'Channel A' : undefined}
            />
            <div className={`transition-opacity ${dualMode ? 'opacity-100' : 'opacity-0 pointer-events-none h-0 overflow-hidden'}`}>
              <MorseVisualizer
                elements={morseElements2}
                flashChar={flashChar2}
                recentChars={recentChars2}
                isReceiving={stats2?.toneDetected ?? false}
                channel={1}
                label="Channel B"
              />
            </div>
          </div>
        </div>

        {/* Drag handle 0↔1 */}
        <div className="hidden lg:flex w-3 self-stretch cursor-col-resize items-center justify-center group shrink-0" onMouseDown={(e) => startDrag(e, 0)}><div className="w-px h-full bg-[#30363d] group-hover:bg-[#2ea043]/50 transition-colors" /></div>

        {/* Panel 2 — Audio Analysis */}
        <AudioAnalysisPanel
          analyser={analyser ?? null}
          isRecording={state.isRecording}
          markers={[
            { freq: toneFreq, color: '#79c0ff', label: 'T', bandwidthHz: filterBandwidth },
            ...(dualMode ? [{ freq: toneFreq2, color: '#ffa657', label: 'T2', bandwidthHz: filterBandwidth }] : []),
          ]}
          onMarkerDrag={(idx, newHz) => {
            const f = Math.max(50, newHz);
            if (idx === 0) setToneFreq(f);
            else setToneFreq2(f);
          }}
          squelch={squelch}
          onSquelchChange={setSquelch}
          className="min-w-0"
          style={{ flex: panelWeights[1] }}
        />

        {/* Drag handle 1↔2 */}
        <div className="hidden lg:flex w-3 self-stretch cursor-col-resize items-center justify-center group shrink-0" onMouseDown={(e) => startDrag(e, 1)}><div className="w-px h-full bg-[#30363d] group-hover:bg-[#2ea043]/50 transition-colors" /></div>

        {/* Panel 3 — Decoder Options */}
        <div className="bg-[#161b22] border border-[#30363d] rounded-lg p-3 sm:p-4 flex flex-col gap-3 min-w-0" style={{ flex: panelWeights[2] }}>
          <h2 className="text-lg sm:text-xl font-semibold">Decoder Options</h2>

          {state.error && (
            <div className="bg-[#da3633]/10 border border-[#f85149]/30 rounded-md p-3 text-[#f85149] text-xs">
              {state.error}
            </div>
          )}

          {/* A/B Mode toggle */}
          <div className="flex items-center gap-2.5">
            <Toggle checked={dualMode} onChange={() => setDualMode(v => !v)} />
            <span className="text-[#c9d1d9] text-sm cursor-default select-none">A/B Mode</span>
          </div>

          {/* Adaptive WPM */}
          <div className="flex items-center gap-2.5 flex-wrap">
            <Toggle
              checked={adaptiveDitLength}
              onChange={() => {
                if (adaptiveDitLength && stats?.adaptiveWpm) setManualWpm(stats.adaptiveWpm);
                setAdaptiveDitLength(v => !v);
              }}
            />
            <span className="text-[#c9d1d9] text-sm cursor-default select-none">Adaptive WPM</span>
            {adaptiveDitLength ? (
              <div className="flex items-center gap-1.5">
                <span className="font-mono text-sm text-[#2ea043] tabular-nums min-w-[2.5ch]">
                  {stats?.adaptiveWpm ?? '—'}
                </span>
                <span className="text-xs text-[#484f58]">WPM</span>
              </div>
            ) : (
              <div className="flex items-center gap-2 flex-wrap">
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
                    <button className="text-[#2ea043] hover:underline font-mono" onClick={() => setManualWpm(stats.adaptiveWpm!)}>
                      {stats.adaptiveWpm}
                    </button>
                    )
                  </span>
                )}
              </div>
            )}
          </div>

          {/* Center frequency Ch A */}
          <div className="space-y-1">
            <div className="text-xs text-[#8b949e]">Center Ch A</div>
            <div className="flex items-center gap-2">
              <input
                type="number"
                value={toneFreq}
                min={50}
                onChange={(e) => {
                  const v = parseInt(e.target.value);
                  if (!isNaN(v) && v >= 50) setToneFreq(v);
                }}
                className="bg-[#0d1117] border border-[#30363d] rounded px-2 py-0.5 w-20 text-[#79c0ff] font-mono text-sm focus:outline-none focus:border-[#79c0ff] transition-colors"
              />
              <span className="text-xs text-[#8b949e]">Hz</span>
            </div>
          </div>

          {/* Center frequency Ch B — always visible, greyed when not in dual mode */}
          <div className={`space-y-1 transition-opacity ${dualMode ? 'opacity-100' : 'opacity-30'}`}>
            <div className="text-xs text-[#8b949e]">Center Ch B</div>
            <div className="flex items-center gap-2">
              <input
                type="number"
                value={toneFreq2}
                min={50}
                disabled={!dualMode}
                onChange={(e) => {
                  const v = parseInt(e.target.value);
                  if (!isNaN(v) && v >= 50) setToneFreq2(v);
                }}
                className="bg-[#0d1117] border border-[#30363d] rounded px-2 py-0.5 w-20 text-[#ffa657] font-mono text-sm focus:outline-none focus:border-[#ffa657] transition-colors disabled:cursor-not-allowed"
              />
              <span className="text-xs text-[#8b949e]">Hz</span>
            </div>
          </div>

          {/* Filter bandwidth */}
          <div className="space-y-1">
            <div className="text-xs text-[#8b949e]">Bandwidth</div>
            <div className="flex items-center gap-2">
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
          </div>

          {/* Status grid — always visible, dimmed when not recording */}
          <div className={`grid grid-cols-2 gap-2 text-sm mt-auto transition-opacity ${!state.isRecording ? 'opacity-40' : ''}`}>
            <div className="bg-[#0d1117] border border-[#30363d] rounded-lg p-2.5">
              <div className="text-[#8b949e] text-[10px] mb-0.5">Speed A</div>
              <div className="font-mono font-semibold text-xs text-[#79c0ff]">
                {stats?.wpm ?? '—'} <span className="text-[#8b949e] font-normal">WPM</span>
              </div>
            </div>
            <div className={`bg-[#0d1117] border border-[#30363d] rounded-lg p-2.5 transition-opacity ${dualMode ? 'opacity-100' : 'opacity-40'}`}>
              <div className="text-[#8b949e] text-[10px] mb-0.5">Speed B</div>
              <div className="font-mono font-semibold text-xs text-[#ffa657]">
                {stats2?.wpm ?? '—'} <span className="text-[#8b949e] font-normal">WPM</span>
              </div>
            </div>
            <div className="bg-[#0d1117] border border-[#30363d] rounded-lg p-2.5">
              <div className="text-[#8b949e] text-[10px] mb-0.5">Ch A State</div>
              <div className="font-mono font-semibold text-xs">
                {stats?.squelched
                  ? <span className="text-[#e3b341]">Squelched</span>
                  : stats?.toneDetected
                    ? <span className="text-[#79c0ff] flex items-center gap-1"><span className="inline-block w-1.5 h-1.5 rounded-full bg-[#79c0ff] animate-pulse shrink-0" />Mark</span>
                    : <span className="text-[#8b949e]">Space</span>
                }
              </div>
            </div>
            <div className={`bg-[#0d1117] border border-[#30363d] rounded-lg p-2.5 transition-opacity ${dualMode ? 'opacity-100' : 'opacity-40'}`}>
              <div className="text-[#8b949e] text-[10px] mb-0.5">Ch B State</div>
              <div className="font-mono font-semibold text-xs">
                {stats2?.squelched
                  ? <span className="text-[#e3b341]">Squelched</span>
                  : stats2?.toneDetected
                    ? <span className="text-[#ffa657] flex items-center gap-1"><span className="inline-block w-1.5 h-1.5 rounded-full bg-[#ffa657] animate-pulse shrink-0" />Mark</span>
                    : <span className="text-[#8b949e]">Space</span>
                }
              </div>
            </div>
            <div className="bg-[#0d1117] border border-[#30363d] rounded-lg p-2.5">
              <div className="text-[#8b949e] text-[10px] mb-0.5">Chars</div>
              <div className="font-mono font-semibold text-xs">{charCount}</div>
            </div>
            <div className="bg-[#0d1117] border border-[#30363d] rounded-lg p-2.5">
              <div className="text-[#8b949e] text-[10px] mb-0.5">SNR (Ch A)</div>
              <div className={`font-mono font-semibold text-xs ${snrColor}`}>
                {stats?.snrDb != null ? `${stats.snrDb.toFixed(1)} dB` : '-- dB'}
              </div>
            </div>
          </div>

          {/* Reset */}
          <button
            onClick={handleReset}
            className="text-xs px-3 py-1.5 rounded border border-[#30363d] text-[#8b949e] hover:text-[#e3b341] hover:border-[#e3b341]/40 transition-colors self-start"
          >
            Reset Decoder
          </button>
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
            <li>Set the <strong>Center Ch A</strong> frequency to match the CW tone (typically 600–800 Hz)</li>
            <li>Use <strong>Bandwidth</strong> to widen or narrow the bandpass filter — narrow (50–80 Hz) for clean signals, wider (150–300 Hz) for noisy ones</li>
            <li>Enable <strong>A/B Mode</strong> to decode two simultaneous CW stations — set each center frequency separately</li>
            <li>In A/B mode, <span className="text-[#79c0ff]">Ch A text is blue</span> and <span className="text-[#ffa657]">Ch B text is orange</span> in the output panel</li>
          </ol>
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
});

export default CWDecoder;
