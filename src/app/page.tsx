'use client';

import { useRef, useState, useCallback, useMemo, useEffect } from 'react';
import RTTYDecoder from "@/components/RTTYDecoder";
import SSTVDecoder from "@/components/SSTVDecoder";
import CWDecoder from "@/components/CWDecoder";
import FTDecoder, { FTModeSelector } from "@/components/FTDecoder";
import MFSKDecoder from "@/components/MFSKDecoder";
import FTTransmitPanel, { type TxStatus } from "@/components/FTTransmitPanel";
import type { DecoderControls } from '@/components/DecoderControls';
import { useGlobalAudio } from '@/hooks/useGlobalAudio';
import {
  FTMode,
  type FTDecoderStats,
  type FTDecoderStatus,
  subscribeDecoderStats,
  subscribeDecoderStatus,
} from '@/lib/ft/decoder';
import RadioCATPanel, { useRadioCAT } from '@/components/RadioCATPanel';
import type { Contact } from '@/lib/ft/parser';
import { audioRecorder, REC_DURATION_CHOICES_SEC } from '@/lib/audio/ringRecorder';

type DecoderMode = 'rtty' | 'sstv' | 'cw' | 'ft' | 'mfsk';

const MODE_META: Record<DecoderMode, { label: string; description: string }> = {
  rtty: {
    label: 'RTTY',
    description: 'Real-time Radioteletype signal decoder from microphone',
  },
  sstv: {
    label: 'SSTV',
    description: 'Slow Scan Television image decoder — Robot, Scottie, PD modes',
  },
  cw: {
    label: 'CW',
    description: 'Continuous Wave (Morse code) decoder — adaptive speed, real-time text output',
  },
  ft: {
    label: 'FT8/4',
    description: 'FT8 & FT4 weak-signal decoder — UTC clock-synchronized, structured QSO messages',
  },
  mfsk: {
    label: 'MFSK',
    description: 'Multiple Frequency Shift Keying decoder — configurable tones, live bit-stream grid',
  },
};

// ── Memory / resource debug bar ────────────────────────────────────────────

function MemDebugBar({ contacts }: { contacts: Map<string, Contact> }) {
  const [snap, setSnap] = useState<{
    heapMB: number | null;
    heapLimitMB: number | null;
    contacts: number;
    totalMsgs: number;
    domNodes: number;
  } | null>(null);
  const [wasmStats,  setWasmStats]  = useState<FTDecoderStats | null>(null);
  const [wasmStatus, setWasmStatus] = useState<FTDecoderStatus | null>(null);

  useEffect(() => {
    const unsubStats  = subscribeDecoderStats(setWasmStats);
    const unsubStatus = subscribeDecoderStatus(setWasmStatus);
    return () => { unsubStats(); unsubStatus(); };
  }, []);

  useEffect(() => {
    const update = () => {
      const mem = (performance as unknown as { memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number } }).memory;
      let totalMsgs = 0;
      for (const c of contacts.values()) totalMsgs += c.msgs.length;
      setSnap({
        heapMB:      mem ? Math.round(mem.usedJSHeapSize / 1024 / 1024) : null,
        heapLimitMB: mem ? Math.round(mem.jsHeapSizeLimit / 1024 / 1024) : null,
        contacts:    contacts.size,
        totalMsgs,
        domNodes:    document.querySelectorAll('*').length,
      });
    };
    update();
    const id = setInterval(update, 2000);
    return () => clearInterval(id);
  }, [contacts]);

  if (!snap) return null;

  const heapPct = snap.heapMB !== null && snap.heapLimitMB
    ? Math.round((snap.heapMB / snap.heapLimitMB) * 100)
    : null;
  const heapColor = heapPct === null ? '#484f58' : heapPct > 75 ? '#f85149' : heapPct > 50 ? '#e3b341' : '#2ea043';

  return (
    <div className="px-4 sm:px-6 lg:px-8 py-1 border-t border-[#21262d] bg-[#0d1117]/80 shrink-0">
      <div className="flex flex-wrap gap-x-4 gap-y-0.5 items-center font-mono text-[10px] text-[#484f58]">
        <span className="text-[#30363d] select-none">⬡ mem</span>
        {snap.heapMB !== null ? (
          <span style={{ color: heapColor }}>
            heap {snap.heapMB} MB{heapPct !== null ? ` (${heapPct}%)` : ''}
          </span>
        ) : (
          <span title="Chrome only — enable chrome://flags/#enable-precise-memory-info for accuracy">heap n/a</span>
        )}
        <span>contacts <span className="text-[#8b949e]">{snap.contacts}</span></span>
        <span>msgs <span className="text-[#8b949e]">{snap.totalMsgs}</span></span>
        <span>DOM <span className="text-[#8b949e]">{snap.domNodes}</span></span>
        {wasmStatus && wasmStatus.generation > 0 && (
          <>
            <span className="text-[#30363d] select-none">· ⬡ wasm</span>
            <span title="active decode engine">
              {wasmStats?.engine ?? (wasmStatus.engines.length ? wasmStatus.engines.join('+') : 'loading…')}
            </span>
            {wasmStats && (
              <>
                <span title="WASM memory: live allocations / reserved linear memory">
                  heap <span className="text-[#8b949e]">
                    {(wasmStats.heapUsedBytes / 1024 / 1024).toFixed(1)}/{Math.round(wasmStats.heapBytes / 1024 / 1024)} MB
                  </span>
                </span>
                <span title="last decode time inside the worker">
                  dec <span className="text-[#8b949e]">{(wasmStats.decodeMs / 1000).toFixed(1)}s</span>
                </span>
              </>
            )}
            {wasmStatus.generation > 1 && (
              <span title="worker respawn count">gen <span className="text-[#8b949e]">{wasmStatus.generation}</span></span>
            )}
          </>
        )}
        <span className="ml-auto flex items-center gap-2">
          <span title="app version">v{process.env.NEXT_PUBLIC_APP_VERSION}</span>
          <a
            href="https://github.com/acesso/Signal-Decoder"
            target="_blank"
            rel="noopener noreferrer"
            className="text-[#8b949e] hover:text-[#58a6ff] transition-colors"
            title="source code on GitHub"
          >
            GitHub ↗
          </a>
        </span>
      </div>
    </div>
  );
}

// ── Shared top bar ──────────────────────────────────────────────────────────

function recDurationLabel(sec: number): string {
  return sec < 60 ? `${sec} s` : `${sec / 60} min`;
}

function TopBar({
  controls,
  mode,
  ftMode,
  onFTModeChange,
}: {
  controls: DecoderControls | null;
  mode: DecoderMode;
  ftMode: FTMode;
  onFTModeChange: (m: FTMode) => void;
}) {
  const isRecording = controls?.isRecording ?? false;
  const isSupported = controls?.isSupported ?? true;
  const error       = controls?.error ?? null;

  // Audio ring buffer (global Rec) — poll fill state once per second; the
  // interval only causes re-renders while the buffered amount is changing.
  const [recStatus, setRecStatus]   = useState(() => ({ inputSec: 0, outputSec: 0, durationSec: 60 }));
  const [showGlobals, setShowGlobals] = useState(false);
  useEffect(() => {
    const tick = () => setRecStatus(prev => {
      const s = audioRecorder.status();
      return prev.inputSec === s.inputSec && prev.outputSec === s.outputSec
          && prev.durationSec === s.durationSec ? prev : s;
    });
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, []);
  const recHasAudio = recStatus.inputSec > 0 || recStatus.outputSec > 0;

  return (
    <div className="bg-[#161b22] border border-[#30363d] rounded-lg px-4 py-3 shrink-0">
      <div className="flex items-center gap-3 flex-wrap">
        {!isRecording ? (
          <button
            onClick={() => controls?.start()}
            disabled={!isSupported || !controls}
            className="bg-[#238636] hover:bg-[#2ea043] disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold px-5 py-2 rounded-md transition-colors text-sm flex items-center gap-2"
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM9.555 7.168A1 1 0 008 8v4a1 1 0 001.555.832l3-2a1 1 0 000-1.664l-3-2z" clipRule="evenodd" />
            </svg>
            Start Decoding
          </button>
        ) : (
          <button
            onClick={() => controls?.stop()}
            className="bg-[#da3633] hover:bg-[#f85149] text-white font-semibold px-5 py-2 rounded-md transition-colors text-sm flex items-center gap-2"
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8 7a1 1 0 00-1 1v4a1 1 0 001 1h4a1 1 0 001-1V8a1 1 0 00-1-1H8z" clipRule="evenodd" />
            </svg>
            Stop
          </button>
        )}

        <button
          onClick={() => controls?.reset()}
          disabled={!controls}
          className="bg-[#21262d] hover:bg-[#30363d] disabled:opacity-40 disabled:cursor-not-allowed text-[#c9d1d9] font-semibold px-4 py-2 rounded-md transition-colors text-sm border border-[#30363d] flex items-center gap-1.5"
        >
          <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M4 2a1 1 0 011 1v2.101a7.002 7.002 0 0111.601 2.566 1 1 0 11-1.885.666A5.002 5.002 0 005.999 7H9a1 1 0 010 2H4a1 1 0 01-1-1V3a1 1 0 011-1zm.008 9.057a1 1 0 011.276.61A5.002 5.002 0 0014.001 13H11a1 1 0 110-2h5a1 1 0 011 1v5a1 1 0 11-2 0v-2.101a7.002 7.002 0 01-11.601-2.566 1 1 0 01.61-1.276z" clipRule="evenodd" />
          </svg>
          Reset
        </button>

        {/* Retroactive audio capture: the ring buffer always holds the last
            N of input/TX audio while running; Rec downloads it as WAV. */}
        <button
          onClick={() => audioRecorder.saveAll()}
          disabled={!recHasAudio}
          title={
            recHasAudio
              ? `Download the last ${recDurationLabel(recStatus.durationSec)} of audio as WAV `
                + `(input ${recStatus.inputSec}s buffered${recStatus.outputSec > 0 ? `, TX out ${recStatus.outputSec}s` : ''})`
              : 'Nothing buffered yet — audio is captured while decoding runs'
          }
          className="bg-[#21262d] hover:bg-[#30363d] disabled:opacity-40 disabled:cursor-not-allowed text-[#c9d1d9] font-semibold px-4 py-2 rounded-md transition-colors text-sm border border-[#30363d] flex items-center gap-1.5"
        >
          <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
            <circle cx="10" cy="10" r="6" fill={isRecording ? '#f85149' : 'currentColor'} />
          </svg>
          Rec
        </button>

        <button
          onClick={() => setShowGlobals(v => !v)}
          title="Global settings"
          aria-expanded={showGlobals}
          className={`bg-[#21262d] hover:bg-[#30363d] text-[#c9d1d9] font-semibold px-3 py-2 rounded-md transition-colors text-sm border ${showGlobals ? 'border-[#58a6ff]' : 'border-[#30363d]'} flex items-center`}
        >
          <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.532 1.532 0 01-2.286.948c-1.372-.836-2.942.734-2.106 2.106.54.886.061 2.042-.947 2.287-1.561.379-1.561 2.6 0 2.978a1.532 1.532 0 01.947 2.287c-.836 1.372.734 2.942 2.106 2.106a1.532 1.532 0 012.287.947c.379 1.561 2.6 1.561 2.978 0a1.533 1.533 0 012.287-.947c1.372.836 2.942-.734 2.106-2.106a1.533 1.533 0 01.947-2.287c1.561-.379 1.561-2.6 0-2.978a1.532 1.532 0 01-.947-2.287c.836-1.372-.734-2.942-2.106-2.106a1.532 1.532 0 01-2.287-.947zM10 13a3 3 0 100-6 3 3 0 000 6z" clipRule="evenodd" />
          </svg>
        </button>

        {/* FT sub-mode selector — inline in the bar when FT is active */}
        {mode === 'ft' && (
          <div className="ml-2 pl-3 border-l border-[#30363d]">
            <FTModeSelector mode={ftMode} onChange={onFTModeChange} />
          </div>
        )}

        {error && (
          <span className="text-[#f85149] text-xs font-mono ml-auto">{error}</span>
        )}
      </div>

      {showGlobals && (
        <div className="mt-3 pt-3 border-t border-[#30363d] flex items-center gap-x-4 gap-y-2 flex-wrap text-xs text-[#8b949e]">
          <span className="font-semibold text-[#c9d1d9]">Audio ring buffer</span>
          <label className="flex items-center gap-1.5">
            keep last
            <select
              value={recStatus.durationSec}
              onChange={e => {
                audioRecorder.setDurationSec(Number(e.target.value));
                setRecStatus(audioRecorder.status());
              }}
              className="bg-[#0d1117] border border-[#30363d] rounded px-2 py-1 text-[#c9d1d9]"
            >
              {REC_DURATION_CHOICES_SEC.map(sec => (
                <option key={sec} value={sec}>{recDurationLabel(sec)}</option>
              ))}
            </select>
          </label>
          <span className="font-mono">
            buffered: input {recStatus.inputSec}s · TX out {recStatus.outputSec}s
          </span>
          <button
            onClick={() => { audioRecorder.clear(); setRecStatus(audioRecorder.status()); }}
            disabled={!recHasAudio}
            className="bg-[#21262d] hover:bg-[#30363d] disabled:opacity-40 disabled:cursor-not-allowed text-[#c9d1d9] px-2.5 py-1 rounded border border-[#30363d] transition-colors"
          >
            Clear
          </button>
          <span className="italic">
            Rec saves each stream as its own mono 16-bit WAV — capture runs whenever decoding is on.
          </span>
        </div>
      )}
    </div>
  );
}

// ── TX collapsed summary chips ───────────────────────────────────────────────

const TX_STATUS_COLOR: Record<string, string> = {
  idle:     '#484f58',
  waiting:  '#e3b341',
  encoding: '#58a6ff',
  playing:  '#2ea043',
};
const TX_STATUS_LABEL: Record<string, string> = {
  idle:     'IDLE',
  waiting:  'WAIT',
  encoding: 'ENC',
  playing:  'TX',
};

// Miniature rAF-driven progress ring — pure SVG DOM mutations, no React re-renders
function TxRingMini({ status, windowSec, playing }: { status: string; windowSec: number; playing: boolean }) {
  const svgRef = useRef<SVGSVGElement>(null);
  const rafRef = useRef<number | null>(null);
  const prevRef = useRef('');
  // viewBox 0 0 72 72, rendered at 28×28
  const r = 28, cx = 36, cy = 36;
  const circ = 2 * Math.PI * r;

  useEffect(() => {
    const tick = () => {
      const svg = svgRef.current;
      if (!svg) { rafRef.current = requestAnimationFrame(tick); return; }
      const totalMs = windowSec * 1000;
      const now = new Date();
      const elapsed = (now.getSeconds() * 1000 + now.getMilliseconds()) % totalMs;
      const progress = elapsed / totalMs;
      const secVal = ((totalMs - elapsed) / 1000).toFixed(1);
      if (secVal === prevRef.current) { rafRef.current = requestAnimationFrame(tick); return; }
      prevRef.current = secVal;
      const color = TX_STATUS_COLOR[status] ?? '#484f58';
      const filled = circ * progress;
      svg.querySelector<SVGCircleElement>('.mring-arc')?.setAttribute('stroke', color);
      svg.querySelector<SVGCircleElement>('.mring-arc')?.setAttribute('stroke-dasharray', `${filled} ${circ - filled}`);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, [status, windowSec, circ]);

  const initColor = TX_STATUS_COLOR[status] ?? '#484f58';
  return (
    <svg ref={svgRef} width={28} height={28} viewBox="0 0 72 72" className="shrink-0">
      {playing && (
        <circle cx={cx} cy={cy} r={r + 6} fill="none" stroke="#2ea043" strokeWidth={3}
          opacity={0.35} className="animate-ping" style={{ animationDuration: '1s' }} />
      )}
      <circle cx={cx} cy={cy} r={r} fill="none" stroke="#21262d" strokeWidth={7} />
      <circle className="mring-arc" cx={cx} cy={cy} r={r} fill="none"
        stroke={initColor} strokeWidth={7}
        strokeDasharray={`0 ${circ}`} strokeDashoffset={circ * 0.25} />
    </svg>
  );
}

function TxSummaryChips({ s }: { s: TxStatus | null }) {
  if (!s) return null;
  const stColor = TX_STATUS_COLOR[s.status] ?? '#484f58';
  const stLabel = TX_STATUS_LABEL[s.status] ?? s.status.toUpperCase();
  const dimColor = '#30363d';
  return (
    <span className="tx-summary-chips inline-flex items-center gap-2 ml-3 align-middle" style={{ lineHeight: 1 }}>
      {/* Mini animated ring */}
      <TxRingMini status={s.isRunning ? s.status : 'idle'} windowSec={s.windowSec} playing={s.status === 'playing'} />
      {/* Status label */}
      <span className="font-mono text-[10px] font-bold" style={{ color: s.isRunning ? stColor : '#484f58' }}>
        {stLabel}
      </span>
      {/* Queue tag — always shown */}
      <span className="inline-flex items-center gap-1 font-mono text-[10px] px-1.5 py-0.5 rounded border"
        style={{
          borderColor: s.queueLen > 0 ? 'rgba(88,166,255,0.4)' : dimColor,
          color:        s.queueLen > 0 ? '#58a6ff' : '#484f58',
          background:   s.queueLen > 0 ? 'rgba(88,166,255,0.08)' : 'transparent',
        }}>
        <span style={{ color: s.queueLen > 0 ? '#8b949e' : '#30363d' }}>Queue</span>
        <span className="font-bold">{s.queueLen}</span>
      </span>
      {/* Replies tag — always shown */}
      <span className="inline-flex items-center gap-1 font-mono text-[10px] px-1.5 py-0.5 rounded border"
        style={{
          borderColor: s.pendingReplies > 0 ? 'rgba(227,179,65,0.4)' : dimColor,
          color:        s.pendingReplies > 0 ? '#e3b341' : '#484f58',
          background:   s.pendingReplies > 0 ? 'rgba(227,179,65,0.08)' : 'transparent',
        }}>
        <span style={{ color: s.pendingReplies > 0 ? '#8b949e' : '#30363d' }}>Replies</span>
        <span className="font-bold">{s.pendingReplies}</span>
      </span>
      {/* Auto-reply badge */}
      {s.autoReply && (
        <span className="font-mono text-[10px] px-1.5 py-0.5 rounded border"
          style={{ color: '#58a6ff', borderColor: 'rgba(88,166,255,0.3)', background: 'rgba(88,166,255,0.08)' }}>
          auto
        </span>
      )}
    </span>
  );
}

// ── Page ────────────────────────────────────────────────────────────────────

export default function Home() {
  const [mode, setMode]     = useState<DecoderMode>('rtty');
  const [ftMode, setFTMode] = useState<FTMode>('FT8');
  const [ftContacts, setFtContacts] = useState<Map<string, Contact>>(new Map());
  const [ftMyCall, setFtMyCall] = useState('');
  const [ftMyGrid, setFtMyGrid] = useState('');
  const [txStatus, setTxStatus] = useState<TxStatus | null>(null);
  const txAudioHz = txStatus?.txAudioHz ?? 0;

  // ── Radio CAT — lifted here so VFO frequency flows to all decoders ────────
  const cat = useRadioCAT();
  const vfoFrequency = cat.state.connected ? (cat.state.frequency ?? undefined) : undefined;

  // ── Global audio — single shared AudioContext + AnalyserNode ─────────────
  const { state: audioState, analyser, analyserRef, start: audioStart, stop: audioStop } = useGlobalAudio();

  // Global recording state — driven by the global audio hook
  const isRecording    = audioState.isRecording;
  const isSupported    = audioState.isSupported;
  const recordingError = audioState.error;

  const rttyRef = useRef<DecoderControls>(null);
  const sstvRef = useRef<DecoderControls>(null);
  const cwRef   = useRef<DecoderControls>(null);
  const ftRef   = useRef<DecoderControls>(null);
  const mfskRef = useRef<DecoderControls>(null);

  const refForMode = useCallback((m: DecoderMode) => {
    return m === 'rtty' ? rttyRef : m === 'sstv' ? sstvRef : m === 'cw' ? cwRef : m === 'ft' ? ftRef : mfskRef;
  }, []);

  // When a decoder reports a state change, we no longer rely on it for
  // isRecording/isSupported — those are owned by useGlobalAudio. We keep
  // onStateChange so existing components don't need structural changes.
  const modeRef = useRef(mode);
  modeRef.current = mode;

  const onStateChangeCbs = useMemo(() => {
    // Callbacks are kept for future use (e.g., per-decoder error reporting)
    // but global recording state is now owned by useGlobalAudio.
    const make = (_m: DecoderMode) => (_controls: DecoderControls) => { /* no-op */ };
    return {
      rtty: make('rtty'), sstv: make('sstv'), cw: make('cw'), ft: make('ft'), mfsk: make('mfsk'),
    };
  }, []);

  const activeRef = refForMode(mode);

  // ── Unified start / stop ─────────────────────────────────────────────────

  const handleStart = useCallback(async () => {
    const node = await audioStart();
    if (node) await activeRef.current?.start();
  }, [audioStart, activeRef]);

  const handleStop = useCallback(() => {
    activeRef.current?.stop();
    audioStop();
  }, [audioStop, activeRef]);

  const clearSentRef = useRef<(() => void) | null>(null);
  const handleReset = useCallback(() => {
    activeRef.current?.reset();
    clearSentRef.current?.();
  }, [activeRef]);

  // Switching mode: stop previous decoder (but keep global audio), connect new decoder
  const handleModeChange = useCallback(async (newMode: DecoderMode) => {
    if (newMode === modeRef.current) return;
    const prevRef = refForMode(modeRef.current);
    const wasRecording = isRecording;
    if (wasRecording) prevRef.current?.stop();
    setMode(newMode);
    const nextRef = refForMode(newMode);
    if (wasRecording && analyserRef.current) {
      // Start the new decoder immediately using the stable ref (no React state lag)
      await nextRef.current?.start();
    }
  }, [refForMode, isRecording, analyserRef]);

  const globalControls: DecoderControls = {
    isRecording,
    isSupported,
    error: recordingError,
    start: handleStart,
    stop:  handleStop,
    reset: handleReset,
  };

  const meta = MODE_META[mode];

  return (
    <main className="h-screen flex flex-col overflow-hidden">
      {/* Header */}
      <div className="px-4 sm:px-6 lg:px-8 pt-4 sm:pt-6 lg:pt-8 pb-3 shrink-0">
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
          <div>
            <h1 className="text-2xl sm:text-3xl lg:text-4xl font-bold mb-1 text-[#c9d1d9]">
              Radio Signal Decoder
            </h1>
            <p className="text-sm sm:text-base text-[#8b949e]">
              {meta.description}
            </p>
          </div>

          {/* Mode selector */}
          <div className="flex items-center gap-1 bg-[#0d1117] border border-[#30363d] rounded-lg p-1 shrink-0 self-start sm:self-auto">
            {(['rtty', 'sstv', 'cw', 'ft', 'mfsk'] as DecoderMode[]).map((m) => (
              <button
                key={m}
                onClick={() => handleModeChange(m)}
                className={`px-4 py-1.5 rounded-md text-sm font-semibold transition-colors ${
                  mode === m
                    ? 'bg-[#238636] text-white'
                    : 'text-[#8b949e] hover:text-[#c9d1d9]'
                }`}
              >
                {MODE_META[m].label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Shared top bar — Start/Stop/Reset + FT sub-mode when active */}
      <div className="px-4 sm:px-6 lg:px-8 pb-2 shrink-0">
        <TopBar
          controls={globalControls}
          mode={mode}
          ftMode={ftMode}
          onFTModeChange={setFTMode}
        />
      </div>

      {/* Scrollable body — CAT + TX panel + decoder content */}
      <div className="flex-1 min-h-0 overflow-y-auto px-4 sm:px-6 lg:px-8 pb-8">

        {/* CAT radio control panel */}
        <div className="pb-3">
          <RadioCATPanel cat={cat} />
        </div>

        {/* FT Transmit panel — only shown when FT mode is active */}
        {mode === 'ft' && (
          <div className="pb-3">
            {/* chips hidden via CSS when panel is open */}
            <style>{`
              details[open] .tx-summary-chips { display: none !important; }
            `}</style>
            <details className="bg-[#161b22] border border-[#30363d] rounded-lg" open>
              <summary className="cursor-pointer px-4 py-3 sm:px-5 font-semibold text-sm hover:bg-[#21262d] rounded-lg transition-colors select-none flex items-center">
                Transmit
                <TxSummaryChips s={txStatus} />
              </summary>
              <div className="px-4 pb-4 sm:px-5 sm:pb-5">
                <FTTransmitPanel
                  mode={ftMode}
                  contacts={ftContacts}
                  vfoFrequency={vfoFrequency}
                  onMyCallChange={setFtMyCall}
                  onMyGridChange={setFtMyGrid}
                  onSetPTT={cat.state.connected ? cat.setPTT : undefined}
                  onStatusChange={setTxStatus}
                  onReset={(fn) => { clearSentRef.current = fn; }}
                />
              </div>
            </details>
          </div>
        )}

        {/* All decoders mounted persistently, toggled via CSS */}
        <div className={mode === 'rtty' ? '' : 'hidden'}>
          <RTTYDecoder ref={rttyRef} onStateChange={onStateChangeCbs.rtty} analyser={analyser} vfoFrequency={vfoFrequency} />
        </div>
        <div className={mode === 'sstv' ? '' : 'hidden'}>
          <SSTVDecoder ref={sstvRef} onStateChange={onStateChangeCbs.sstv} analyser={analyser} vfoFrequency={vfoFrequency} />
        </div>
        <div className={mode === 'cw' ? '' : 'hidden'}>
          <CWDecoder ref={cwRef} onStateChange={onStateChangeCbs.cw} analyser={analyser} vfoFrequency={vfoFrequency} />
        </div>
        <div className={mode === 'mfsk' ? '' : 'hidden'}>
          <MFSKDecoder ref={mfskRef} onStateChange={onStateChangeCbs.mfsk} analyser={analyser} vfoFrequency={vfoFrequency} />
        </div>
        <div className={mode === 'ft' ? '' : 'hidden'}>
          <FTDecoder ref={ftRef} ftMode={ftMode} myCall={ftMyCall} myGrid={ftMyGrid} onStateChange={onStateChangeCbs.ft} onContactsChange={setFtContacts} analyser={analyser} vfoFrequency={vfoFrequency} txAudioHz={txAudioHz} />
        </div>

      </div>

      {/* Memory / resource debug bar — always visible at the bottom */}
      <MemDebugBar contacts={ftContacts} />
    </main>
  );
}
