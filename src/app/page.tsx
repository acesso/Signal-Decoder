'use client';

import { useRef, useState, useCallback, useMemo, useEffect } from 'react';
import RTTYDecoder from "@/components/RTTYDecoder";
import SSTVDecoder from "@/components/SSTVDecoder";
import CWDecoder from "@/components/CWDecoder";
import FTDecoder, { FTModeSelector } from "@/components/FTDecoder";
import MFSKDecoder from "@/components/MFSKDecoder";
import type { DecoderControls } from '@/components/DecoderControls';
import { useGlobalAudio } from '@/hooks/useGlobalAudio';
import { FTMode } from '@/lib/ft/decoder';
import RadioCATPanel from '@/components/RadioCATPanel';

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

// ── Shared top bar ──────────────────────────────────────────────────────────

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
    </div>
  );
}

// ── Page ────────────────────────────────────────────────────────────────────

export default function Home() {
  const [mode, setMode]   = useState<DecoderMode>('rtty');
  const [ftMode, setFTMode] = useState<FTMode>('FT8');

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

  const handleReset = useCallback(() => { activeRef.current?.reset(); }, [activeRef]);

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

      {/* CAT radio control panel */}
      <div className="px-4 sm:px-6 lg:px-8 pb-3 shrink-0">
        <RadioCATPanel />
      </div>

      {/* Content — all decoders mounted persistently, toggled via CSS */}
      <div className="flex-1 min-h-0 overflow-y-auto px-4 sm:px-6 lg:px-8 pb-8">
        <div className={mode === 'rtty' ? '' : 'hidden'}>
          <RTTYDecoder ref={rttyRef} onStateChange={onStateChangeCbs.rtty} analyser={analyser} />
        </div>
        <div className={mode === 'sstv' ? '' : 'hidden'}>
          <SSTVDecoder ref={sstvRef} onStateChange={onStateChangeCbs.sstv} analyser={analyser} />
        </div>
        <div className={mode === 'cw' ? '' : 'hidden'}>
          <CWDecoder ref={cwRef} onStateChange={onStateChangeCbs.cw} analyser={analyser} />
        </div>
        <div className={mode === 'mfsk' ? '' : 'hidden'}>
          <MFSKDecoder ref={mfskRef} onStateChange={onStateChangeCbs.mfsk} analyser={analyser} />
        </div>
        <div className={mode === 'ft' ? '' : 'hidden'}>
          <FTDecoder ref={ftRef} ftMode={ftMode} onStateChange={onStateChangeCbs.ft} analyser={analyser} />
        </div>
      </div>
    </main>
  );
}
