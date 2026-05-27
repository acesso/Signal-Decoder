'use client';

import { useEffect, useRef, useState, useCallback, useReducer } from 'react';
import { useMultiRTTYProcessor } from '@/hooks/useMultiRTTYProcessor';
import { SessionCard } from '@/components/SessionCard';
import { sessionsReducer, makeSession } from '@/lib/rtty/sessions';
import type { RTTYConfig } from '@/lib/rtty/decoder';

const DISPLAY_MAX_HZ = 1500;

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

export default function SSTVDecoder() {
  // Canvas / animation refs
  const spectrumCanvasRef    = useRef<HTMLCanvasElement>(null);
  const spectrogramCanvasRef = useRef<HTMLCanvasElement>(null);
  const animationFrameRef    = useRef<number | null>(null);
  const textareaRef          = useRef<HTMLTextAreaElement>(null);
  const isDraggingRef        = useRef(false);
  const spectrogramFrameRef  = useRef(0);

  // Sessions state
  const [sessionState, dispatch] = useReducer(sessionsReducer, _initialState);
  const { sessions, activeSessionId } = sessionState;
  const activeSession = sessions.find(s => s.id === activeSessionId) ?? sessions[0];
  const activeConfig  = activeSession.config;

  // Spectrogram display controls
  const [spectrogramGamma, setSpectrogramGamma] = useState(3.0);
  const [spectrogramSpeed, setSpectrogramSpeed] = useState(2);
  const spectrogramGammaRef = useRef(3.0);
  const spectrogramSpeedRef = useRef(2);
  useEffect(() => { spectrogramGammaRef.current = spectrogramGamma; }, [spectrogramGamma]);
  useEffect(() => { spectrogramSpeedRef.current = spectrogramSpeed; }, [spectrogramSpeed]);

  // Dynamic spectrogram height — follows the Audio Analysis panel's available space
  const spectrogramContainerRef = useRef<HTMLDivElement>(null);
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

  // Resizable panels
  const containerRef    = useRef<HTMLDivElement>(null);
  const [panelWeights, setPanelWeights] = useState([1, 1, 1]);
  const panelWeightsRef = useRef([1, 1, 1]);
  const dragRef = useRef<{ handle: number; startX: number; startWeights: number[] } | null>(null);
  useEffect(() => { panelWeightsRef.current = panelWeights; }, [panelWeights]);

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

  const drawSpectrum = useCallback((canvas: HTMLCanvasElement) => {
    const analyser = getAnalyser();
    if (!analyser) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const bufferLength = analyser.frequencyBinCount;
    const dataArray    = new Uint8Array(bufferLength);
    analyser.getByteFrequencyData(dataArray);

    const nq = analyser.context.sampleRate / 2;
    nyquistRef.current = nq;

    const binsToShow  = Math.max(1, Math.floor((DISPLAY_MAX_HZ / nq) * bufferLength));
    const visibleData = dataArray.subarray(0, binsToShow);
    const axisHeight  = 25;
    const plotHeight  = canvas.height - axisHeight;

    ctx.fillStyle = 'rgb(10, 10, 10)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.strokeStyle = '#2ea043'; ctx.lineWidth = 2;
    ctx.beginPath();
    const barWidth = canvas.width / binsToShow;
    for (let i = 0; i < binsToShow; i++) {
      const x = i * barWidth;
      const y = plotHeight - (visibleData[i] / 255) * plotHeight;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();

    const PEAK_DECAY = 0.4;
    const _half  = carrierShiftRef.current / 2;
    const mark   = reverseShiftRef.current ? centerFreqRef.current + _half : centerFreqRef.current - _half;
    const space  = reverseShiftRef.current ? centerFreqRef.current - _half : centerFreqRef.current + _half;
    const mBin   = Math.min(Math.round((mark  / DISPLAY_MAX_HZ) * (binsToShow - 1)), binsToShow - 1);
    const sBin   = Math.min(Math.round((space / DISPLAY_MAX_HZ) * (binsToShow - 1)), binsToShow - 1);
    const mLvl   = mBin >= 0 ? (visibleData[mBin]  ?? 0) : 0;
    const sLvl   = sBin >= 0 ? (visibleData[sBin]  ?? 0) : 0;
    markPeakRef.current  = mLvl > markPeakRef.current  ? mLvl  : Math.max(0, markPeakRef.current  - PEAK_DECAY);
    spacePeakRef.current = sLvl > spacePeakRef.current ? sLvl  : Math.max(0, spacePeakRef.current - PEAK_DECAY);

    drawFrequencyMarkers(ctx, canvas.width, plotHeight, DISPLAY_MAX_HZ);
    drawAxisLabels(ctx, canvas.width, plotHeight, DISPLAY_MAX_HZ);
    return visibleData;
  }, [getAnalyser, drawFrequencyMarkers, drawAxisLabels]);

  const drawIdleSpectrum = useCallback((canvas: HTMLCanvasElement) => {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const axisHeight = 25;
    const plotHeight = canvas.height - axisHeight;
    markPeakRef.current  = Math.max(0, markPeakRef.current  - 0.4);
    spacePeakRef.current = Math.max(0, spacePeakRef.current - 0.4);
    ctx.fillStyle = 'rgb(10, 10, 10)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    drawFrequencyMarkers(ctx, canvas.width, plotHeight, DISPLAY_MAX_HZ);
    drawAxisLabels(ctx, canvas.width, plotHeight, DISPLAY_MAX_HZ);
  }, [drawFrequencyMarkers, drawAxisLabels]);

  const drawSpectrogram = useCallback((canvas: HTMLCanvasElement, frequencyData: Uint8Array) => {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const binCount = frequencyData.length;
    const newRow   = ctx.createImageData(canvas.width, 1);

    for (let px = 0; px < canvas.width; px++) {
      const binF  = (px / canvas.width) * (binCount - 1);
      const b0    = Math.floor(binF);
      const b1    = Math.min(b0 + 1, binCount - 1);
      const t     = binF - b0;
      const value = frequencyData[b0] * (1 - t) + frequencyData[b1] * t;

      const gamma    = spectrogramGammaRef.current;
      const adjusted = gamma === 1 ? value : Math.pow(value / 255, gamma) * 255;
      const v = adjusted;
      let r: number, g: number, b: number;
      // black → deep blue → purple → red
      if (v < 128) { r = 0;                    g = 0; b = Math.round(v * 2); }
      else         { r = Math.round((v-128)*2); g = 0; b = Math.round(255-(v-128)*2); }

      const i = px * 4;
      newRow.data[i]     = r;
      newRow.data[i + 1] = g;
      newRow.data[i + 2] = b;
      newRow.data[i + 3] = 255;
    }

    const existing = ctx.getImageData(0, 0, canvas.width, canvas.height - 1);
    ctx.putImageData(existing, 0, 1);
    ctx.putImageData(newRow, 0, 0);
  }, []);

  // Animation loop
  useEffect(() => {
    const tick = () => {
      const spectrumCanvas    = spectrumCanvasRef.current;
      const spectrogramCanvas = spectrogramCanvasRef.current;

      if (procState.isRecording && spectrumCanvas) {
        const frequencyData = drawSpectrum(spectrumCanvas);
        spectrogramFrameRef.current++;
        if (spectrogramCanvas && frequencyData && spectrogramFrameRef.current % spectrogramSpeedRef.current === 0) {
          drawSpectrogram(spectrogramCanvas, frequencyData);
        }
      } else if (spectrumCanvas) {
        drawIdleSpectrum(spectrumCanvas);
      }

      animationFrameRef.current = requestAnimationFrame(tick);
    };
    animationFrameRef.current = requestAnimationFrame(tick);
    return () => { if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current); };
  }, [procState.isRecording, drawSpectrum, drawSpectrogram, drawIdleSpectrum]);

  // Spectrum click / drag — reposition center freq of active session
  useEffect(() => {
    const canvas = spectrumCanvasRef.current;
    if (!canvas) return;

    const applyFreq = (clientX: number) => {
      const rect = canvas.getBoundingClientRect();
      const relX = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      dispatchRef.current({
        type: 'UPDATE_CONFIG',
        id: activeSessionIdRef.current,
        patch: { centerFreq: Math.round(relX * DISPLAY_MAX_HZ) },
      });
    };

    const onMouseDown  = (e: MouseEvent)  => { isDraggingRef.current = true; applyFreq(e.clientX); };
    const onMouseMove  = (e: MouseEvent)  => { if (isDraggingRef.current) applyFreq(e.clientX); };
    const onMouseUp    = ()               => { isDraggingRef.current = false; };
    const onTouchStart = (e: TouchEvent)  => { e.preventDefault(); isDraggingRef.current = true; applyFreq(e.touches[0].clientX); };
    const onTouchMove  = (e: TouchEvent)  => { e.preventDefault(); if (isDraggingRef.current) applyFreq(e.touches[0].clientX); };
    const onTouchEnd   = ()               => { isDraggingRef.current = false; };

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

  const signalStrengthPct = Math.round(procState.signalStrength * 100);

  const inputCls = "bg-[#0d1117] border border-[#30363d] rounded px-3 py-2 font-mono text-sm text-[#c9d1d9] focus:outline-none focus:border-[#2ea043] w-full transition-colors";
  const labelCls = "text-[#8b949e] text-xs mb-1 block";

  return (
    <div className="space-y-4 sm:space-y-6">

      {/* ── Controls ── */}
      <div className="bg-[#161b22] border border-[#30363d] rounded-lg p-4 sm:p-6 space-y-4">
        <div className="flex flex-col sm:flex-row gap-3 sm:gap-4">
          {!procState.isRecording ? (
            <button
              onClick={handleStart}
              className="w-full sm:flex-1 bg-[#238636] hover:bg-[#2ea043] text-white font-semibold px-6 py-3 rounded-md transition-colors text-base border border-transparent flex items-center justify-center gap-2"
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM9.555 7.168A1 1 0 008 8v4a1 1 0 001.555.832l3-2a1 1 0 000-1.664l-3-2z" clipRule="evenodd" />
              </svg>
              Start Decoding
            </button>
          ) : (
            <button
              onClick={handleStop}
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
            disabled={!activeSession.fullText}
            className="w-full sm:flex-1 bg-[#21262d] hover:bg-[#30363d] disabled:opacity-40 disabled:cursor-not-allowed text-white font-semibold px-6 py-3 rounded-md transition-colors text-base border border-[#30363d] flex items-center justify-center gap-2"
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
              <path d="M8 3a1 1 0 011-1h2a1 1 0 110 2H9a1 1 0 01-1-1z" />
              <path d="M6 3a2 2 0 00-2 2v11a2 2 0 002 2h8a2 2 0 002-2V5a2 2 0 00-2-2 3 3 0 01-3 3H9a3 3 0 01-3-3z" />
            </svg>
            Copy Text
          </button>
        </div>

        {procState.errorMessage && (
          <div className="bg-[#da3633]/10 border border-[#f85149]/30 rounded-md p-3 text-[#f85149] text-sm">
            {procState.errorMessage}
          </div>
        )}

        {procState.isRecording && (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4 text-sm">
            <div className="bg-[#0d1117] border border-[#30363d] rounded-lg p-3">
              <div className="text-[#8b949e] text-xs mb-1">State</div>
              <div className={`font-mono font-semibold text-sm ${getStateColor()}`}>{procState.status.toUpperCase()}</div>
            </div>
            <div className="bg-[#0d1117] border border-[#30363d] rounded-lg p-3">
              <div className="text-[#8b949e] text-xs mb-1">Mode</div>
              <div className="font-mono font-semibold text-sm text-[#2ea043]">RTTY</div>
            </div>
            <div className="bg-[#0d1117] border border-[#30363d] rounded-lg p-3">
              <div className="text-[#8b949e] text-xs mb-1">Chars</div>
              <div className="font-mono font-semibold text-sm">{activeSession.fullText.length}</div>
            </div>
            <div className="bg-[#0d1117] border border-[#30363d] rounded-lg p-3">
              <div className="text-[#8b949e] text-xs mb-1">SNR</div>
              <div className={`font-mono font-semibold text-sm ${
                procState.snr === null ? 'text-[#8b949e]' :
                procState.snr < 10    ? 'text-[#da3633]' :
                procState.snr < 18    ? 'text-[#e3b341]' : 'text-[#2ea043]'
              }`}>
                {procState.snr !== null ? `${procState.snr.toFixed(1)} dB` : '-- dB'}
              </div>
            </div>
          </div>
        )}
      </div>

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
        <div
          className="hidden lg:flex w-3 self-stretch cursor-col-resize items-center justify-center group shrink-0"
          onMouseDown={(e) => startDrag(e, 0)}
        >
          <div className="w-px h-full bg-[#30363d] group-hover:bg-[#2ea043]/50 transition-colors" />
        </div>

        {/* Audio Analysis */}
        <div
          className="bg-[#161b22] border border-[#30363d] rounded-lg p-3 sm:p-4 min-w-0 flex flex-col"
          style={{ flex: panelWeights[1] }}
        >
          <div className="flex items-center justify-between mb-2 sm:mb-3">
            <h2 className="text-lg sm:text-xl font-semibold">Audio Analysis</h2>
            {procState.isRecording && (
              <div className="flex items-center gap-2">
                <span className="text-xs text-[#8b949e]">Signal</span>
                <div className="flex items-center gap-1">
                  {[0, 1, 2, 3, 4].map((bar) => {
                    const isActive = signalStrengthPct > bar * 20;
                    const color = !isActive ? 'bg-[#21262d]'
                      : signalStrengthPct < 30 ? 'bg-[#da3633]'
                      : signalStrengthPct < 60 ? 'bg-[#e3b341]'
                      : 'bg-[#2ea043]';
                    return <div key={bar} className={`w-1.5 sm:w-2 rounded-sm transition-colors ${color}`} style={{ height: `${8 + bar * 3}px` }} />;
                  })}
                </div>
                <span className="text-xs font-mono text-[#c9d1d9] min-w-[3ch]">{signalStrengthPct}%</span>
              </div>
            )}
          </div>

          {/* Spectrum */}
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-medium text-[#8b949e]">Spectrum</h3>
              <span className="text-xs text-[#8b949e] font-mono">click &amp; drag to tune</span>
            </div>
            <canvas
              ref={spectrumCanvasRef}
              width={640} height={200}
              className="w-full border border-[#30363d] rounded bg-[#0d1117] touch-manipulation cursor-crosshair select-none"
            />
          </div>

          {/* Freq readout + center + sideband */}
          <div className="flex flex-wrap items-center gap-4 mt-2 text-xs font-mono text-[#8b949e]">
            <span>Mark:&nbsp;<span className="text-[#58a6ff]">{markFreq} Hz</span></span>
            <span>Space:&nbsp;<span className="text-[#f0883e]">{spaceFreq} Hz</span></span>
            <label className="flex items-center gap-1">
              Center:
              <input
                type="number"
                value={centerFreq}
                min={0} max={DISPLAY_MAX_HZ}
                onChange={(e) => {
                  const v = parseInt(e.target.value);
                  if (!isNaN(v)) patchActive({ centerFreq: Math.max(0, Math.min(DISPLAY_MAX_HZ, v)) });
                }}
                className="bg-[#0d1117] border border-[#30363d] rounded px-2 py-0.5 w-20 text-[#c9d1d9] focus:outline-none focus:border-[#2ea043] transition-colors"
              />
              <span>Hz</span>
            </label>
            <span className="flex items-center gap-1">
              Sideband:
              <button
                onClick={() => patchActive({ reverseShift: !reverseShift })}
                className={`px-2 py-0.5 rounded border transition-colors ${
                  reverseShift
                    ? 'bg-[#f0883e]/10 border-[#f0883e]/50 text-[#f0883e]'
                    : 'bg-[#0d1117] border-[#30363d] text-[#8b949e] hover:border-[#58a6ff]/40 hover:text-[#58a6ff]'
                }`}
              >
                {reverseShift ? 'LSB' : 'USB'}
              </button>
            </span>
          </div>

          {/* Spectrogram — flex-1 so it fills remaining panel height */}
          <div className="flex flex-col flex-1 gap-2 mt-3 sm:mt-4 min-h-0">
            <h3 className="text-sm font-medium text-[#8b949e] shrink-0">Spectrogram</h3>
            <div ref={spectrogramContainerRef} className="relative flex-1 min-h-[150px]">
              <canvas
                ref={spectrogramCanvasRef}
                width={640}
                height={spectrogramCanvasHeight}
                className="w-full h-full border border-[#30363d] rounded bg-[#0d1117] touch-manipulation block"
              />
              <div className="absolute inset-y-0 pointer-events-none" style={{
                left: `${(spaceBandLow / DISPLAY_MAX_HZ) * 100}%`,
                width: `${((spaceBandHigh - spaceBandLow) / DISPLAY_MAX_HZ) * 100}%`,
                backgroundColor: 'rgba(240,136,62,0.07)',
                borderLeft: '1px solid rgba(240,136,62,0.28)', borderRight: '1px solid rgba(240,136,62,0.28)',
              }} />
              <div className="absolute inset-y-0 pointer-events-none" style={{
                left: `${(markBandLow / DISPLAY_MAX_HZ) * 100}%`,
                width: `${((markBandHigh - markBandLow) / DISPLAY_MAX_HZ) * 100}%`,
                backgroundColor: 'rgba(88,166,255,0.07)',
                borderLeft: '1px solid rgba(88,166,255,0.28)', borderRight: '1px solid rgba(88,166,255,0.28)',
              }} />
              {spaceFreq >= 0 && spaceFreq <= DISPLAY_MAX_HZ && (
                <div className="absolute inset-y-0 pointer-events-none" style={{ left: `${(spaceFreq / DISPLAY_MAX_HZ) * 100}%`, width: '2px', backgroundColor: '#f0883e', opacity: 0.9 }}>
                  <span className="absolute top-1 left-1 text-[10px] font-mono font-bold text-[#f0883e] leading-none drop-shadow-md">S</span>
                </div>
              )}
              {markFreq >= 0 && markFreq <= DISPLAY_MAX_HZ && (
                <div className="absolute inset-y-0 pointer-events-none" style={{ left: `${(markFreq / DISPLAY_MAX_HZ) * 100}%`, width: '2px', backgroundColor: '#58a6ff', opacity: 0.9 }}>
                  <span className="absolute top-1 left-1 text-[10px] font-mono font-bold text-[#58a6ff] leading-none drop-shadow-md">M</span>
                </div>
              )}
            </div>
            {/* Contrast + Speed */}
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
        {/* Drag handle 1↔2 */}
        <div
          className="hidden lg:flex w-3 self-stretch cursor-col-resize items-center justify-center group shrink-0"
          onMouseDown={(e) => startDrag(e, 1)}
        >
          <div className="w-px h-full bg-[#30363d] group-hover:bg-[#2ea043]/50 transition-colors" />
        </div>

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
}
