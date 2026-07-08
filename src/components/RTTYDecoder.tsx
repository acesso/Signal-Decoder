'use client';

import { useEffect, useRef, useState, useCallback, useReducer, forwardRef, useImperativeHandle } from 'react';
import type { DecoderControls, DecoderProps } from './DecoderControls';
import { useMultiRTTYProcessor } from '@/hooks/useMultiRTTYProcessor';
import { SessionCard } from '@/components/SessionCard';
import { sessionsReducer, makeSession } from '@/lib/rtty/sessions';
import type { RTTYConfig } from '@/lib/rtty/decoder';
import AudioAnalysisPanel from './AudioAnalysisPanel';
import { loadNumberArray, saveNumberArray } from '@/lib/storage';

const DISPLAY_MAX_HZ = 1500;
const DEFAULT_PANEL_WEIGHTS = [1, 1, 1];
const LS_PANEL_WEIGHTS = 'rtty_panel_weights';

const DEFAULT_CONFIG: RTTYConfig = {
  centerFreq: 500,
  carrierShift: 450,
  baudRate: 50,
  bitsPerChar: 5,
  parity: 'none',
  stopBits: 1.5,
  reverseShift: false,
};

// Initialise once at module level to avoid ID mismatch between the two useStates
const _initialSession = makeSession(DEFAULT_CONFIG);
const _initialState = { sessions: [_initialSession], activeSessionId: _initialSession.id };

const RTTYDecoder = forwardRef<DecoderControls, DecoderProps>(function RTTYDecoder({ onStateChange, analyser, vfoFrequency }, ref) {
  // Canvas / animation refs
  const textareaRef          = useRef<HTMLTextAreaElement>(null);

  // Sessions state
  const [sessionState, dispatch] = useReducer(sessionsReducer, _initialState);
  const { sessions, activeSessionId } = sessionState;
  const activeSession = sessions.find(s => s.id === activeSessionId) ?? sessions[0];
  const activeConfig  = activeSession.config;

  // Resizable panels — starts at the SSR-safe default, restored from
  // localStorage post-mount (see the mode-restore comment in page.tsx for why).
  const containerRef    = useRef<HTMLDivElement>(null);
  const [panelWeights, setPanelWeights] = useState(DEFAULT_PANEL_WEIGHTS);
  const panelWeightsRef = useRef(DEFAULT_PANEL_WEIGHTS);
  const dragRef = useRef<{ handle: number; startX: number; startWeights: number[] } | null>(null);
  useEffect(() => { panelWeightsRef.current = panelWeights; }, [panelWeights]);
  useEffect(() => { setPanelWeights(loadNumberArray(LS_PANEL_WEIGHTS, DEFAULT_PANEL_WEIGHTS)); }, []);
  useEffect(() => { saveNumberArray(LS_PANEL_WEIGHTS, panelWeights); }, [panelWeights]);

  const startDrag = (e: React.MouseEvent, handle: number) => {
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
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  // Draw-callback refs — updated from active session config
  const nyquistRef      = useRef(22050);
  const centerFreqRef   = useRef(activeConfig.centerFreq);
  const carrierShiftRef = useRef(activeConfig.carrierShift);
  const baudRateRef     = useRef(activeConfig.baudRate);
  const reverseShiftRef = useRef(activeConfig.reverseShift);
  const markPeakRef     = useRef(0);
  const spacePeakRef    = useRef(0);

  useEffect(() => { centerFreqRef.current   = activeConfig.centerFreq;   }, [activeConfig.centerFreq]);
  useEffect(() => { carrierShiftRef.current  = activeConfig.carrierShift; }, [activeConfig.carrierShift]);
  useEffect(() => { baudRateRef.current      = activeConfig.baudRate;     }, [activeConfig.baudRate]);
  useEffect(() => { reverseShiftRef.current  = activeConfig.reverseShift; }, [activeConfig.reverseShift]);

  // Stable ref to dispatch for use in [] effects
  const dispatchRef        = useRef(dispatch);
  const activeSessionIdRef = useRef(activeSessionId);
  useEffect(() => { dispatchRef.current = dispatch; }, []);
  useEffect(() => { activeSessionIdRef.current = activeSessionId; }, [activeSessionId]);

  // Derived display values from active config
  const { centerFreq, carrierShift, baudRate, reverseShift } = activeConfig;
  const markFreq  = Math.round(reverseShift ? centerFreq + carrierShift / 2 : centerFreq - carrierShift / 2);
  const spaceFreq = Math.round(reverseShift ? centerFreq - carrierShift / 2 : centerFreq + carrierShift / 2);
  const halfBW         = baudRate / 2;
  const markBandLow    = Math.max(0, markFreq  - halfBW);
  const markBandHigh   = Math.min(DISPLAY_MAX_HZ, markFreq  + halfBW);
  const spaceBandLow   = Math.max(0, spaceFreq - halfBW);
  const spaceBandHigh  = Math.min(DISPLAY_MAX_HZ, spaceFreq + halfBW);

  // ── Multi-decoder hook ────────────────────────────────────────────────────

  const handleText = useCallback((sessionId: string, chars: string) => {
    dispatchRef.current({ type: 'APPEND_TEXT', id: sessionId, chars });
  }, []);

  const {
    state: procState,
    startRecording,
    stopRecording,
    addSession:          hookAddSession,
    removeSession:       hookRemoveSession,
    updateSessionConfig: hookUpdateConfig,
    resetSession:        hookResetSession,
    setActiveSession:    hookSetActive,
    getAnalyser,
  } = useMultiRTTYProcessor(handleText);

  const isRecording = procState?.isRecording ?? false;

  // Register initial session with the hook on mount
  useEffect(() => {
    hookAddSession(_initialSession.id, _initialSession.config);
    hookSetActive(_initialSession.id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Session management ────────────────────────────────────────────────────

  const [addPanelOpen, setAddPanelOpen] = useState(false);
  const [addShift, setAddShift] = useState(450);
  const [addBaud, setAddBaud] = useState(50);
  const addPanelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!addPanelOpen) return;
    const handler = (e: MouseEvent) => {
      if (!addPanelRef.current?.contains(e.target as Node)) setAddPanelOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [addPanelOpen]);

  const addNewSession = useCallback(() => {
    dispatch({ type: 'ADD_SESSION', config: { ...activeConfig, carrierShift: addShift, baudRate: addBaud } });
    setAddPanelOpen(false);
  }, [activeConfig, addShift, addBaud]);

  // After ADD_SESSION, register the newest session with the hook
  const prevSessionCount = useRef(sessions.length);
  useEffect(() => {
    if (sessions.length > prevSessionCount.current) {
      const newest = sessions[sessions.length - 1];
      hookAddSession(newest.id, newest.config);
    }
    prevSessionCount.current = sessions.length;
  }, [sessions, hookAddSession]);

  const removeSession = useCallback((id: string) => {
    dispatch({ type: 'REMOVE_SESSION', id });
    hookRemoveSession(id);
  }, [hookRemoveSession]);

  const promoteSession = useCallback((id: string) => {
    dispatch({ type: 'ACTIVATE', id });
    hookSetActive(id);
    markPeakRef.current  = 0;
    spacePeakRef.current = 0;
  }, [hookSetActive]);

  const updateSessionConfig = useCallback((id: string, patch: Partial<RTTYConfig>) => {
    dispatch({ type: 'UPDATE_CONFIG', id, patch });
    const current = sessions.find(s => s.id === id)?.config;
    if (current) hookUpdateConfig(id, { ...current, ...patch });
  }, [sessions, hookUpdateConfig]);

  const updateSessionColor = useCallback((id: string, color: string) => {
    dispatch({ type: 'UPDATE_COLOR', id, color });
  }, []);

  // Sync active session config changes to the hook
  useEffect(() => {
    hookUpdateConfig(activeSessionId, activeConfig);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeConfig]);

  // Sync active session id to hook
  useEffect(() => {
    hookSetActive(activeSessionId);
  }, [activeSessionId, hookSetActive]);

  // ── Active-config setters (RTTY Configuration panel) ─────────────────────

  const patchActive = useCallback((patch: Partial<RTTYConfig>) => {
    dispatch({ type: 'UPDATE_CONFIG', id: activeSessionIdRef.current, patch });
  }, []);

  // ── Drawing callbacks ─────────────────────────────────────────────────────

  const drawFrequencyMarkers = useCallback((
    ctx: CanvasRenderingContext2D,
    canvasWidth: number,
    plotHeight: number,
    nq: number,
  ) => {
    const half  = carrierShiftRef.current / 2;
    const mark  = reverseShiftRef.current ? centerFreqRef.current + half : centerFreqRef.current - half;
    const space = reverseShiftRef.current ? centerFreqRef.current - half : centerFreqRef.current + half;
    const markX  = (mark  / nq) * canvasWidth;
    const spaceX = (space / nq) * canvasWidth;

    ctx.fillStyle = 'rgba(88, 166, 255, 0.06)';
    ctx.fillRect(Math.min(markX, spaceX), 0, Math.abs(markX - spaceX), plotHeight);

    const hw = baudRateRef.current / 2;
    const mLoX = Math.max(0, ((mark  - hw) / nq) * canvasWidth);
    const mHiX = Math.min(canvasWidth, ((mark  + hw) / nq) * canvasWidth);
    const sLoX = Math.max(0, ((space - hw) / nq) * canvasWidth);
    const sHiX = Math.min(canvasWidth, ((space + hw) / nq) * canvasWidth);

    ctx.lineWidth = 1;
    ctx.setLineDash([2, 4]);
    ctx.strokeStyle = 'rgba(88, 166, 255, 0.30)';
    ctx.beginPath(); ctx.moveTo(mLoX, 0); ctx.lineTo(mLoX, plotHeight); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(mHiX, 0); ctx.lineTo(mHiX, plotHeight); ctx.stroke();
    ctx.strokeStyle = 'rgba(240, 136, 62, 0.30)';
    ctx.beginPath(); ctx.moveTo(sLoX, 0); ctx.lineTo(sLoX, plotHeight); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(sHiX, 0); ctx.lineTo(sHiX, plotHeight); ctx.stroke();
    ctx.setLineDash([]);

    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 3]);
    ctx.strokeStyle = '#f0883e';
    ctx.beginPath(); ctx.moveTo(spaceX, 0); ctx.lineTo(spaceX, plotHeight); ctx.stroke();
    ctx.strokeStyle = '#58a6ff';
    ctx.beginPath(); ctx.moveTo(markX,  0); ctx.lineTo(markX,  plotHeight); ctx.stroke();
    ctx.setLineDash([]);

    const mPeak = markPeakRef.current;
    const sPeak = spacePeakRef.current;
    if (mPeak > 0) {
      const y = plotHeight * (1 - mPeak / 255);
      ctx.strokeStyle = '#58a6ff'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(mLoX, y); ctx.lineTo(mHiX, y); ctx.stroke();
    }
    if (sPeak > 0) {
      const y = plotHeight * (1 - sPeak / 255);
      ctx.strokeStyle = '#f0883e'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(sLoX, y); ctx.lineTo(sHiX, y); ctx.stroke();
    }

    ctx.font = '10px monospace'; ctx.textAlign = 'center';
    ctx.fillStyle = '#f0883e'; ctx.fillText('S', spaceX, 14);
    ctx.fillStyle = '#58a6ff'; ctx.fillText('M', markX,  14);
  }, []);

  const drawAxisLabels = useCallback((
    ctx: CanvasRenderingContext2D,
    canvasWidth: number,
    plotHeight: number,
    maxFreq: number,
  ) => {
    ctx.strokeStyle = '#30363d'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, plotHeight); ctx.lineTo(canvasWidth, plotHeight); ctx.stroke();

    for (let freq = 0; freq <= maxFreq; freq += 10) {
      const xPos     = (freq / maxFreq) * canvasWidth;
      const isMajor  = freq % 100 === 0;
      const isMedium = !isMajor && freq % 50 === 0;
      const tickLen  = isMajor ? 6 : isMedium ? 4 : 2;
      ctx.strokeStyle = isMajor ? '#8b949e' : '#30363d';
      ctx.beginPath(); ctx.moveTo(xPos, plotHeight); ctx.lineTo(xPos, plotHeight + tickLen); ctx.stroke();
      if (isMajor) {
        ctx.fillStyle = '#8b949e'; ctx.font = '10px monospace'; ctx.textAlign = 'center';
        ctx.fillText(freq >= 1000 ? `${freq / 1000}k` : `${freq}`, xPos, plotHeight + 17);
      }
    }
  }, []);

  // Auto-scroll textarea when active session text changes
  useEffect(() => {
    const t = textareaRef.current;
    if (t) t.scrollTop = t.scrollHeight;
  }, [activeSession.fullText]);

  // ── UI helpers ────────────────────────────────────────────────────────────

  const handleStart = async () => { await startRecording(); };
  const handleStop  = () => { stopRecording(); };
  const handleReset = () => {
    hookResetSession(activeSessionId);
    dispatch({ type: 'CLEAR_TEXT', id: activeSessionId });
    markPeakRef.current = 0; spacePeakRef.current = 0;
  };
  const handleCopyText = () => {
    const text = activeSession.fullText;
    if (!text) return;
    navigator.clipboard.writeText(text).catch(() => {
      const t = textareaRef.current;
      if (t) { t.select(); document.execCommand('copy'); }
    });
  };

  const getStateColor = () => {
    switch (procState.status) {
      case 'receiving': return 'text-green-400';
      case 'syncing':   return 'text-[#e3b341]';
      case 'error':     return 'text-[#f85149]';
      default:          return 'text-gray-400';
    }
  };

  const controls: DecoderControls = {
    isRecording: procState.isRecording,
    isSupported: typeof window !== 'undefined' && !!(window.AudioContext ?? (window as unknown as Record<string, unknown>).webkitAudioContext),
    error: procState.errorMessage ?? null,
    start: startRecording,
    stop: stopRecording,
    reset: handleReset,
  };
  useImperativeHandle(ref, () => controls, [procState.isRecording, procState.errorMessage, startRecording, stopRecording, handleReset]); // eslint-disable-line react-hooks/exhaustive-deps
  const onStateChangeRef = useRef(onStateChange);
  onStateChangeRef.current = onStateChange;
  useEffect(() => { onStateChangeRef.current?.(controls); }, [procState.isRecording, procState.errorMessage]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="space-y-4 sm:space-y-6">

      {/* ── Main display — fluid resizable columns ── */}
      <div ref={containerRef} className="flex flex-col lg:flex-row lg:items-stretch gap-4 lg:gap-0">

        {/* RTTY Output terminal */}
        <div
          className="bg-[#161b22] border border-[#30363d] rounded-lg p-3 sm:p-4 flex flex-col min-w-0"
          style={{ flex: panelWeights[0] }}
        >
          <div className="flex items-center justify-between mb-2 sm:mb-3">
            <h2 className="text-lg sm:text-xl font-semibold">
              RTTY Output
              {sessions.length > 1 && (
                <span className="ml-2 text-xs font-normal text-[#8b949e]">— {activeSession.label}</span>
              )}
            </h2>
            <div className="flex items-center gap-3">
              <span className="text-xs text-[#8b949e] font-mono">{activeSession.fullText.length} chars</span>
              <button
                onClick={() => dispatch({ type: 'CLEAR_TEXT', id: activeSessionId })}
                disabled={!activeSession.fullText}
                className="text-xs px-2 py-0.5 rounded border border-[#30363d] text-[#8b949e] hover:text-[#f85149] hover:border-[#f85149]/40 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              >
                Clear
              </button>
            </div>
          </div>
          <textarea
            ref={textareaRef}
            readOnly
            value={activeSession.fullText}
            placeholder="Decoded RTTY text will appear here..."
            style={{ color: activeSession.color }}
            className="flex-1 min-h-[300px] w-full bg-[#0d1117] border border-[#30363d] rounded font-mono text-sm p-3 resize-none focus:outline-none placeholder:text-[#30363d] leading-snug"
          />
        </div>

        {/* Drag handle 0↔1 */}
        <div className="hidden lg:flex w-3 self-stretch cursor-col-resize items-center justify-center group shrink-0" onMouseDown={(e) => startDrag(e, 0)}><div className="w-px h-full bg-[#30363d] group-hover:bg-[#2ea043]/50 transition-colors" /></div>

        {/* Audio Analysis — 2nd column */}
        <AudioAnalysisPanel
          analyser={analyser ?? null}
          isRecording={isRecording}
          defaultMaxHz={DISPLAY_MAX_HZ}
          storageKeyPrefix="rtty"
          markers={[
            { freq: markFreq,  color: '#58a6ff', label: 'M', bandwidthHz: halfBW * 2 },
            { freq: spaceFreq, color: '#f0883e', label: 'S', bandwidthHz: halfBW * 2 },
          ]}
          onMarkerDrag={(idx, newHz) => {
            // Both markers share a fixed shift — drag either one to re-center
            const half = carrierShift / 2;
            const newCenter = idx === 0
              ? (reverseShift ? newHz - half : newHz + half)   // dragged M
              : (reverseShift ? newHz + half : newHz - half);  // dragged S
            updateSessionConfig(activeSessionId, { centerFreq: Math.round(newCenter) });
          }}
          vfoFrequency={vfoFrequency}
          className="min-w-0"
          style={{ flex: panelWeights[1] }}
        />

        {/* Drag handle 1↔2 */}
        <div className="hidden lg:flex w-3 self-stretch cursor-col-resize items-center justify-center group shrink-0" onMouseDown={(e) => startDrag(e, 1)}><div className="w-px h-full bg-[#30363d] group-hover:bg-[#2ea043]/50 transition-colors" /></div>

        {/* Decoder Sessions — 3rd column */}
        <div
          className="bg-[#161b22] border border-[#30363d] rounded-lg p-3 sm:p-4 min-w-0"
          style={{ flex: panelWeights[2] }}
        >
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-lg sm:text-xl font-semibold">Decoder Sessions</h2>
            <div ref={addPanelRef} className="relative">
              <button
                onClick={() => setAddPanelOpen(v => !v)}
                className="flex items-center gap-1 px-2.5 py-1 rounded-md bg-[#238636]/10 border border-[#238636]/40 text-[#2ea043] text-xs font-mono hover:bg-[#238636]/20 hover:border-[#238636]/60 transition-colors"
              >
                <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor">
                  <path fillRule="evenodd" d="M10 3a1 1 0 011 1v5h5a1 1 0 110 2h-5v5a1 1 0 11-2 0v-5H4a1 1 0 110-2h5V4a1 1 0 011-1z" clipRule="evenodd" />
                </svg>
                Add
              </button>
              {addPanelOpen && (
                <div className="absolute right-0 top-full mt-1 z-10 bg-[#161b22] border border-[#30363d] rounded-lg p-3 shadow-lg w-48">
                  <div className="mb-2">
                    <div className="text-[10px] text-[#8b949e] mb-1.5">Carrier Shift</div>
                    <div className="flex gap-1">
                      {[170, 200, 450].map(s => (
                        <button
                          key={s}
                          onClick={() => setAddShift(s)}
                          className={`flex-1 text-xs py-0.5 rounded border transition-colors ${
                            addShift === s
                              ? 'border-[#2ea043]/60 bg-[#2ea043]/10 text-[#2ea043]'
                              : 'border-[#30363d] text-[#8b949e] hover:border-[#8b949e]/50'
                          }`}
                        >{s}</button>
                      ))}
                    </div>
                  </div>
                  <div className="mb-3">
                    <div className="text-[10px] text-[#8b949e] mb-1.5">Baud Rate</div>
                    <div className="flex gap-1">
                      {[45, 45.45, 50].map(b => (
                        <button
                          key={b}
                          onClick={() => setAddBaud(b)}
                          className={`flex-1 text-xs py-0.5 rounded border transition-colors ${
                            addBaud === b
                              ? 'border-[#2ea043]/60 bg-[#2ea043]/10 text-[#2ea043]'
                              : 'border-[#30363d] text-[#8b949e] hover:border-[#8b949e]/50'
                          }`}
                        >{b}</button>
                      ))}
                    </div>
                  </div>
                  <button
                    onClick={addNewSession}
                    className="w-full text-xs py-1 rounded bg-[#238636]/20 border border-[#238636]/50 text-[#2ea043] hover:bg-[#238636]/30 transition-colors"
                  >
                    Create Session
                  </button>
                </div>
              )}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            {sessions.map(session => (
              <SessionCard
                key={session.id}
                session={session}
                isActive={session.id === activeSessionId}
                canRemove={sessions.length > 1}
                vfoFrequency={vfoFrequency}
                onActivate={promoteSession}
                onRemove={removeSession}
                onConfigChange={updateSessionConfig}
                onLabelChange={(id, label) => dispatch({ type: 'UPDATE_LABEL', id, label })}
                onColorChange={updateSessionColor}
              />
            ))}
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
            <li>Click &quot;Start Decoding&quot; to begin capturing audio from your microphone</li>
            <li>Tune your radio to an RTTY signal (typically 45 or 50 baud, 170 or 450 Hz shift)</li>
            <li>On the Spectrum panel, click and drag to position the <span className="text-[#58a6ff] font-mono">M</span> (mark) and <span className="text-[#f0883e] font-mono">S</span> (space) markers over the two signal peaks</li>
            <li>Adjust Carrier Shift and Baud Rate in the configuration panel to match the transmission</li>
            <li>Use <strong>Add Decoder</strong> to run multiple decoders simultaneously with different settings — promote the best one to take over the main output</li>
            <li>Decoded text will appear in the terminal output area as characters are received</li>
            <li>Click &quot;Copy Text&quot; to copy the decoded output to clipboard</li>
          </ol>
          <p className="mt-4 text-xs sm:text-sm text-[#8b949e]">
            Tip: On the spectrogram, an RTTY signal appears as two persistent vertical lines — align the M/S markers with those lines using the spectrum panel.
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
          <p>The microphone permission is only used to capture and process the audio signal in real-time for RTTY decoding using the Web Audio API.</p>
          <p className="text-xs sm:text-sm text-[#8b949e]">Your privacy is fully protected — we don&apos;t collect, store, or transmit any of your data.</p>
        </div>
      </details>
    </div>
  );
});

export default RTTYDecoder;
