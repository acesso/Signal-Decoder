'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { useAudioProcessor } from '@/hooks/useAudioProcessor';
import { DecoderState } from '@/lib/sstv/decoder';

// Maximum frequency rendered on spectrum and spectrogram.
// Limits display to the range where RTTY signals live, keeping them centred.
const DISPLAY_MAX_HZ = 1500;

export default function SSTVDecoder() {
  const spectrumCanvasRef = useRef<HTMLCanvasElement>(null);
  const spectrogramCanvasRef = useRef<HTMLCanvasElement>(null);
  const animationFrameRef = useRef<number | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isDraggingRef = useRef(false);
  const spectrogramFrameRef = useRef(0);

  const [decodedText, setDecodedText] = useState('');

  // RTTY configuration
  const [carrierShift, setCarrierShift] = useState(450);
  const [baudRate, setBaudRate] = useState(50);
  const [bitsPerChar, setBitsPerChar] = useState(5);
  const [parity, setParity] = useState('none');
  const [stopBits, setStopBits] = useState(1.5);
  const [centerFreq, setCenterFreq] = useState(500);
  // nyquist ref only — used to compute bin slicing inside draw callbacks
  const nyquistRef = useRef(22050);
  const centerFreqRef = useRef(500);
  const carrierShiftRef = useRef(450);
  const baudRateRef = useRef(50);
  const markPeakRef = useRef(0);
  const spacePeakRef = useRef(0);

  useEffect(() => { centerFreqRef.current = centerFreq; }, [centerFreq]);
  useEffect(() => { carrierShiftRef.current = carrierShift; }, [carrierShift]);
  useEffect(() => { baudRateRef.current = baudRate; }, [baudRate]);

  const markFreq = Math.round(centerFreq + carrierShift / 2);
  const spaceFreq = Math.round(centerFreq - carrierShift / 2);
  // Band edges for the baud rate envelope around each tone
  const halfBW = baudRate / 2;
  const markBandLow   = Math.max(0, markFreq  - halfBW);
  const markBandHigh  = Math.min(DISPLAY_MAX_HZ, markFreq  + halfBW);
  const spaceBandLow  = Math.max(0, spaceFreq - halfBW);
  const spaceBandHigh = Math.min(DISPLAY_MAX_HZ, spaceFreq + halfBW);

  const { state, startRecording, stopRecording, resetDecoder, getAnalyser } = useAudioProcessor();

  // Draw M/S marker lines, baud-rate bandwidth edges, and peak-hold indicators
  const drawFrequencyMarkers = useCallback((
    ctx: CanvasRenderingContext2D,
    canvasWidth: number,
    plotHeight: number,
    nq: number,
  ) => {
    const mark  = centerFreqRef.current + carrierShiftRef.current / 2;
    const space = centerFreqRef.current - carrierShiftRef.current / 2;
    const markX  = (mark  / nq) * canvasWidth;
    const spaceX = (space / nq) * canvasWidth;

    // ── Inter-tone shaded band ──
    ctx.fillStyle = 'rgba(88, 166, 255, 0.06)';
    ctx.fillRect(Math.min(markX, spaceX), 0, Math.abs(markX - spaceX), plotHeight);

    // ── Baud-rate bandwidth edges (very dim dashed) ──
    const hw = baudRateRef.current / 2;
    const mLoX  = Math.max(0, ((mark  - hw) / nq) * canvasWidth);
    const mHiX  = Math.min(canvasWidth, ((mark  + hw) / nq) * canvasWidth);
    const sLoX  = Math.max(0, ((space - hw) / nq) * canvasWidth);
    const sHiX  = Math.min(canvasWidth, ((space + hw) / nq) * canvasWidth);

    ctx.lineWidth = 1;
    ctx.setLineDash([2, 4]);
    ctx.strokeStyle = 'rgba(88, 166, 255, 0.30)';
    ctx.beginPath(); ctx.moveTo(mLoX, 0); ctx.lineTo(mLoX, plotHeight); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(mHiX, 0); ctx.lineTo(mHiX, plotHeight); ctx.stroke();
    ctx.strokeStyle = 'rgba(240, 136, 62, 0.30)';
    ctx.beginPath(); ctx.moveTo(sLoX, 0); ctx.lineTo(sLoX, plotHeight); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(sHiX, 0); ctx.lineTo(sHiX, plotHeight); ctx.stroke();
    ctx.setLineDash([]);

    // ── Main M / S dashed centre lines ──
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 3]);
    ctx.strokeStyle = '#f0883e';
    ctx.beginPath(); ctx.moveTo(spaceX, 0); ctx.lineTo(spaceX, plotHeight); ctx.stroke();
    ctx.strokeStyle = '#58a6ff';
    ctx.beginPath(); ctx.moveTo(markX, 0);  ctx.lineTo(markX, plotHeight);  ctx.stroke();
    ctx.setLineDash([]);

    // ── Peak-hold horizontal lines (span the baud-rate band) ──
    const mPeak = markPeakRef.current;
    const sPeak = spacePeakRef.current;
    if (mPeak > 0) {
      const y = plotHeight * (1 - mPeak / 255);
      ctx.strokeStyle = '#58a6ff';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(mLoX, y); ctx.lineTo(mHiX, y); ctx.stroke();
    }
    if (sPeak > 0) {
      const y = plotHeight * (1 - sPeak / 255);
      ctx.strokeStyle = '#f0883e';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(sLoX, y); ctx.lineTo(sHiX, y); ctx.stroke();
    }

    // ── Labels ──
    ctx.font = '10px monospace';
    ctx.textAlign = 'center';
    ctx.fillStyle = '#f0883e';
    ctx.fillText('S', spaceX, 14);
    ctx.fillStyle = '#58a6ff';
    ctx.fillText('M', markX,  14);
  }, []);

  const drawAxisLabels = useCallback((
    ctx: CanvasRenderingContext2D,
    canvasWidth: number,
    plotHeight: number,
    maxFreq: number,
  ) => {
    // Baseline
    ctx.strokeStyle = '#30363d';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, plotHeight);
    ctx.lineTo(canvasWidth, plotHeight);
    ctx.stroke();

    // Three tick levels: minor 10 Hz (2px), medium 50 Hz (4px), major 100 Hz (6px + label)
    const minorStep  = 10;
    const mediumStep = 50;
    const majorStep  = 100;

    for (let freq = 0; freq <= maxFreq; freq += minorStep) {
      const xPos = (freq / maxFreq) * canvasWidth;
      const isMajor  = freq % majorStep === 0;
      const isMedium = !isMajor && freq % mediumStep === 0;
      const tickLen  = isMajor ? 6 : isMedium ? 4 : 2;

      ctx.strokeStyle = isMajor ? '#8b949e' : '#30363d';
      ctx.beginPath();
      ctx.moveTo(xPos, plotHeight);
      ctx.lineTo(xPos, plotHeight + tickLen);
      ctx.stroke();

      if (isMajor) {
        ctx.fillStyle = '#8b949e';
        ctx.font = '10px monospace';
        ctx.textAlign = 'center';
        const label = freq >= 1000 ? `${freq / 1000}k` : `${freq}`;
        ctx.fillText(label, xPos, plotHeight + 17);
      }
    }
  }, []);

  const drawSpectrum = useCallback((canvas: HTMLCanvasElement) => {
    const analyser = getAnalyser();
    if (!analyser) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    analyser.getByteFrequencyData(dataArray);

    const nq = analyser.context.sampleRate / 2;
    nyquistRef.current = nq;

    // Only render bins up to DISPLAY_MAX_HZ
    const binsToShow = Math.max(1, Math.floor((DISPLAY_MAX_HZ / nq) * bufferLength));
    const visibleData = dataArray.subarray(0, binsToShow);

    const axisHeight = 25;
    const plotHeight = canvas.height - axisHeight;

    ctx.fillStyle = 'rgb(10, 10, 10)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.strokeStyle = '#2ea043';
    ctx.lineWidth = 2;
    ctx.beginPath();
    const barWidth = canvas.width / binsToShow;
    for (let i = 0; i < binsToShow; i++) {
      const x = i * barWidth;
      const y = plotHeight - (visibleData[i] / 255) * plotHeight;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Update peak-hold values at mark / space bins, then decay each frame
    const PEAK_DECAY = 0.4;
    const mark  = centerFreqRef.current + carrierShiftRef.current / 2;
    const space = centerFreqRef.current - carrierShiftRef.current / 2;
    const mBin  = Math.min(Math.round((mark  / DISPLAY_MAX_HZ) * (binsToShow - 1)), binsToShow - 1);
    const sBin  = Math.min(Math.round((space / DISPLAY_MAX_HZ) * (binsToShow - 1)), binsToShow - 1);
    const mLvl  = mBin  >= 0 ? (visibleData[mBin]  ?? 0) : 0;
    const sLvl  = sBin  >= 0 ? (visibleData[sBin]  ?? 0) : 0;
    markPeakRef.current  = mLvl  > markPeakRef.current  ? mLvl  : Math.max(0, markPeakRef.current  - PEAK_DECAY);
    spacePeakRef.current = sLvl  > spacePeakRef.current ? sLvl  : Math.max(0, spacePeakRef.current - PEAK_DECAY);

    drawFrequencyMarkers(ctx, canvas.width, plotHeight, DISPLAY_MAX_HZ);
    drawAxisLabels(ctx, canvas.width, plotHeight, DISPLAY_MAX_HZ);

    return visibleData;
  }, [getAnalyser, drawFrequencyMarkers, drawAxisLabels]);

  // Shown when not recording — axis + markers; peaks decay to zero
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

  // Spectrogram: per-pixel linear interpolation across bins for smooth rendering.
  // Markers are CSS overlays (drawing pixels would scroll them into history).
  const drawSpectrogram = useCallback((canvas: HTMLCanvasElement, frequencyData: Uint8Array) => {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const binCount = frequencyData.length;
    const newRow = ctx.createImageData(canvas.width, 1);

    for (let px = 0; px < canvas.width; px++) {
      // Map pixel to a (possibly fractional) bin index
      const binF = (px / canvas.width) * (binCount - 1);
      const b0 = Math.floor(binF);
      const b1 = Math.min(b0 + 1, binCount - 1);
      const t = binF - b0;
      const value = frequencyData[b0] * (1 - t) + frequencyData[b1] * t;

      let r, g, b;
      if (value < 85)       { r = 0;                g = 0;                b = value * 3; }
      else if (value < 170) { r = 0;                g = (value - 85) * 3; b = 255 - (value - 85) * 3; }
      else                  { r = (value - 170) * 3; g = 255;              b = 0; }

      const i = px * 4;
      newRow.data[i]     = r;
      newRow.data[i + 1] = g;
      newRow.data[i + 2] = b;
      newRow.data[i + 3] = 255;
    }

    // Scroll existing content down one row, then stamp new row at top
    const existing = ctx.getImageData(0, 0, canvas.width, canvas.height - 1);
    ctx.putImageData(existing, 0, 1);
    ctx.putImageData(newRow, 0, 0);
  }, []);

  // Animation loop — always runs, draws idle spectrum when not recording
  useEffect(() => {
    const tick = () => {
      const spectrumCanvas = spectrumCanvasRef.current;
      const spectrogramCanvas = spectrogramCanvasRef.current;

      if (state.isRecording && spectrumCanvas) {
        const frequencyData = drawSpectrum(spectrumCanvas);
        // Scroll spectrogram every 2nd frame (~30 rows/sec)
        spectrogramFrameRef.current++;
        if (spectrogramCanvas && frequencyData && spectrogramFrameRef.current % 2 === 0) {
          drawSpectrogram(spectrogramCanvas, frequencyData);
        }
      } else if (spectrumCanvas) {
        drawIdleSpectrum(spectrumCanvas);
      }

      animationFrameRef.current = requestAnimationFrame(tick);
    };

    animationFrameRef.current = requestAnimationFrame(tick);
    return () => { if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current); };
  }, [state.isRecording, drawSpectrum, drawSpectrogram, drawIdleSpectrum]);

  // Click/drag on spectrum canvas to reposition M/S pair
  useEffect(() => {
    const canvas = spectrumCanvasRef.current;
    if (!canvas) return;

    const applyFreq = (clientX: number) => {
      const rect = canvas.getBoundingClientRect();
      const relX = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      setCenterFreq(Math.round(relX * DISPLAY_MAX_HZ));
    };

    const onMouseDown = (e: MouseEvent) => { isDraggingRef.current = true; applyFreq(e.clientX); };
    const onMouseMove = (e: MouseEvent) => { if (isDraggingRef.current) applyFreq(e.clientX); };
    const onMouseUp   = () => { isDraggingRef.current = false; };
    const onTouchStart = (e: TouchEvent) => { e.preventDefault(); isDraggingRef.current = true; applyFreq(e.touches[0].clientX); };
    const onTouchMove  = (e: TouchEvent) => { e.preventDefault(); if (isDraggingRef.current) applyFreq(e.touches[0].clientX); };
    const onTouchEnd   = () => { isDraggingRef.current = false; };

    canvas.addEventListener('mousedown', onMouseDown);
    canvas.addEventListener('touchstart', onTouchStart, { passive: false });
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup',   onMouseUp);
    window.addEventListener('touchmove', onTouchMove as EventListener, { passive: false });
    window.addEventListener('touchend',  onTouchEnd);

    return () => {
      canvas.removeEventListener('mousedown', onMouseDown);
      canvas.removeEventListener('touchstart', onTouchStart);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup',   onMouseUp);
      window.removeEventListener('touchmove', onTouchMove as EventListener);
      window.removeEventListener('touchend',  onTouchEnd);
    };
  }, []); // refs only — no deps needed

  useEffect(() => {
    const textarea = textareaRef.current;
    if (textarea) textarea.scrollTop = textarea.scrollHeight;
  }, [decodedText]);

  const handleStart    = async () => { await startRecording(); };
  const handleStop     = () => { stopRecording(); };
  const handleReset    = () => { resetDecoder(); setDecodedText(''); markPeakRef.current = 0; spacePeakRef.current = 0; };
  const handleCopyText = () => {
    if (!decodedText) return;
    navigator.clipboard.writeText(decodedText).catch(() => {
      const t = textareaRef.current;
      if (t) { t.select(); document.execCommand('copy'); }
    });
  };

  const getStateColor = () => {
    if (!state.stats) return 'text-gray-400';
    switch (state.stats.state) {
      case DecoderState.IDLE:           return 'text-gray-400';
      case DecoderState.DECODING_IMAGE: return 'text-green-400';
      default:                          return 'text-gray-400';
    }
  };

  const inputCls = "bg-[#0d1117] border border-[#30363d] rounded px-3 py-2 font-mono text-sm text-[#c9d1d9] focus:outline-none focus:border-[#2ea043] w-full transition-colors";
  const labelCls = "text-[#8b949e] text-xs mb-1 block";

  return (
    <div className="space-y-4 sm:space-y-6">

      {/* ── Controls ── */}
      <div className="bg-[#161b22] border border-[#30363d] rounded-lg p-4 sm:p-6 space-y-4">
        <div className="flex flex-col sm:flex-row gap-3 sm:gap-4">
          {!state.isRecording ? (
            <button
              onClick={handleStart}
              disabled={!state.isSupported}
              className="w-full sm:flex-1 bg-[#238636] hover:bg-[#2ea043] disabled:bg-[#21262d] disabled:text-[#8b949e] disabled:cursor-not-allowed text-white font-semibold px-6 py-3 rounded-md transition-colors text-base border border-transparent disabled:border-[#30363d] flex items-center justify-center gap-2"
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
            disabled={!decodedText}
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
        {!state.isSupported && (
          <div className="bg-[#bb8009]/10 border border-[#bb8009]/30 rounded-md p-3 text-[#e3b341] text-sm">
            Web Audio API is not supported in this browser
          </div>
        )}

        {state.stats && (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4 text-sm">
            <div className="bg-[#0d1117] border border-[#30363d] rounded-lg p-3">
              <div className="text-[#8b949e] text-xs mb-1">State</div>
              <div className={`font-mono font-semibold text-sm ${getStateColor()}`}>{state.stats.state}</div>
            </div>
            <div className="bg-[#0d1117] border border-[#30363d] rounded-lg p-3">
              <div className="text-[#8b949e] text-xs mb-1">Mode</div>
              <div className="font-mono font-semibold text-sm text-[#2ea043]">RTTY</div>
            </div>
            <div className="bg-[#0d1117] border border-[#30363d] rounded-lg p-3">
              <div className="text-[#8b949e] text-xs mb-1">Chars</div>
              <div className="font-mono font-semibold text-sm">{decodedText.length}</div>
            </div>
            <div className="bg-[#0d1117] border border-[#30363d] rounded-lg p-3">
              <div className="text-[#8b949e] text-xs mb-1">SNR</div>
              <div className={`font-mono font-semibold text-sm ${
                state.stats.snr === null    ? 'text-[#8b949e]' :
                state.stats.snr < 10        ? 'text-[#da3633]' :
                state.stats.snr < 18        ? 'text-[#e3b341]' : 'text-[#2ea043]'
              }`}>
                {state.stats.snr !== null ? `${state.stats.snr.toFixed(1)} dB` : '-- dB'}
              </div>
            </div>
          </div>
        )}

        {state.stats && state.stats.progress > 0 && (
          <div className="w-full bg-[#21262d] rounded-full h-2 overflow-hidden border border-[#30363d]">
            <div className="bg-[#238636] h-2 rounded-full transition-all duration-300" style={{ width: `${Math.min(100, state.stats.progress)}%` }} />
          </div>
        )}
      </div>

      {/* ── RTTY Configuration ── */}
      <div className="bg-[#161b22] border border-[#30363d] rounded-lg p-4 sm:p-6">
        <h2 className="text-lg sm:text-xl font-semibold mb-4">RTTY Configuration</h2>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 sm:gap-4">

          <div>
            <label className={labelCls}>Carrier Shift (Hz)</label>
            <input
              type="number"
              value={carrierShift}
              min={1}
              onChange={(e) => setCarrierShift(Math.max(1, parseInt(e.target.value) || 450))}
              className={inputCls}
            />
          </div>

          <div>
            <label className={labelCls}>Baud Rate</label>
            <select value={baudRate} onChange={(e) => setBaudRate(parseFloat(e.target.value))} className={inputCls}>
              {[45, 45.45, 50, 65, 75, 100, 110, 150, 200, 300].map((b) => (
                <option key={b} value={b}>{b}</option>
              ))}
            </select>
          </div>

          <div>
            <label className={labelCls}>Bits / Char</label>
            <select value={bitsPerChar} onChange={(e) => setBitsPerChar(parseInt(e.target.value))} className={inputCls}>
              {[5, 7, 8].map((b) => <option key={b} value={b}>{b}</option>)}
            </select>
          </div>

          <div>
            <label className={labelCls}>Parity</label>
            <select value={parity} onChange={(e) => setParity(e.target.value)} className={inputCls}>
              {['none', 'even', 'odd', 'zero', 'one'].map((p) => (
                <option key={p} value={p}>{p.charAt(0).toUpperCase() + p.slice(1)}</option>
              ))}
            </select>
          </div>

          <div>
            <label className={labelCls}>Stop Bits</label>
            <select value={stopBits} onChange={(e) => setStopBits(parseFloat(e.target.value))} className={inputCls}>
              {[1, 1.5, 2].map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
        </div>

        {/* Derived frequency readout */}
        <div className="mt-3 flex flex-wrap gap-4 text-xs font-mono text-[#8b949e]">
          <span>Mark:&nbsp;<span className="text-[#58a6ff]">{markFreq} Hz</span></span>
          <span>Space:&nbsp;<span className="text-[#f0883e]">{spaceFreq} Hz</span></span>
          <span>Center:&nbsp;<span className="text-[#c9d1d9]">{centerFreq} Hz</span></span>
        </div>
      </div>

      {/* ── Main display ── */}
      <div className="space-y-4 lg:space-y-0 lg:grid lg:grid-cols-2 lg:gap-6">

        {/* RTTY Output terminal */}
        <div className="bg-[#161b22] border border-[#30363d] rounded-lg p-3 sm:p-4 flex flex-col">
          <div className="flex items-center justify-between mb-2 sm:mb-3">
            <h2 className="text-lg sm:text-xl font-semibold">RTTY Output</h2>
            <span className="text-xs text-[#8b949e] font-mono">{decodedText.length} chars</span>
          </div>
          <textarea
            ref={textareaRef}
            readOnly
            value={decodedText}
            placeholder="Decoded RTTY text will appear here..."
            className="flex-1 min-h-[300px] w-full bg-[#0d1117] border border-[#30363d] rounded font-mono text-sm text-[#2ea043] p-3 resize-none focus:outline-none placeholder:text-[#30363d] leading-relaxed"
          />
        </div>

        {/* Audio Analysis */}
        <div className="bg-[#161b22] border border-[#30363d] rounded-lg p-3 sm:p-4">
          <div className="flex items-center justify-between mb-2 sm:mb-3">
            <h2 className="text-lg sm:text-xl font-semibold">Audio Analysis</h2>
            {state.stats && (
              <div className="flex items-center gap-2">
                <span className="text-xs text-[#8b949e]">Signal</span>
                <div className="flex items-center gap-1">
                  {[0, 1, 2, 3, 4].map((bar) => {
                    const isActive = state.stats!.signalStrength > bar * 20;
                    const color = !isActive ? 'bg-[#21262d]'
                      : state.stats!.signalStrength < 30 ? 'bg-[#da3633]'
                      : state.stats!.signalStrength < 60 ? 'bg-[#e3b341]'
                      : 'bg-[#2ea043]';
                    return <div key={bar} className={`w-1.5 sm:w-2 rounded-sm transition-colors ${color}`} style={{ height: `${8 + bar * 3}px` }} />;
                  })}
                </div>
                <span className="text-xs font-mono text-[#c9d1d9] min-w-[3ch]">{state.stats.signalStrength}%</span>
              </div>
            )}
          </div>

          {/* Spectrum — interactive drag to tune */}
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-medium text-[#8b949e]">Spectrum</h3>
              <span className="text-xs text-[#8b949e] font-mono">click &amp; drag to tune</span>
            </div>
            <canvas
              ref={spectrumCanvasRef}
              width={640}
              height={200}
              className="w-full border border-[#30363d] rounded bg-[#0d1117] touch-manipulation cursor-crosshair select-none"
            />
          </div>

          {/* Spectrogram — CSS overlay markers to avoid scroll artifacts */}
          <div className="space-y-2 mt-3 sm:mt-4">
            <h3 className="text-sm font-medium text-[#8b949e]">Spectrogram</h3>
            <div className="relative">
              <canvas
                ref={spectrogramCanvasRef}
                width={640}
                height={500}
                className="w-full border border-[#30363d] rounded bg-[#0d1117] touch-manipulation block"
              />
              {/* Space baud-rate band fill + edges */}
              <div className="absolute inset-y-0 pointer-events-none" style={{
                left: `${(spaceBandLow / DISPLAY_MAX_HZ) * 100}%`,
                width: `${((spaceBandHigh - spaceBandLow) / DISPLAY_MAX_HZ) * 100}%`,
                backgroundColor: 'rgba(240,136,62,0.07)',
                borderLeft:  '1px solid rgba(240,136,62,0.28)',
                borderRight: '1px solid rgba(240,136,62,0.28)',
              }} />
              {/* Mark baud-rate band fill + edges */}
              <div className="absolute inset-y-0 pointer-events-none" style={{
                left: `${(markBandLow / DISPLAY_MAX_HZ) * 100}%`,
                width: `${((markBandHigh - markBandLow) / DISPLAY_MAX_HZ) * 100}%`,
                backgroundColor: 'rgba(88,166,255,0.07)',
                borderLeft:  '1px solid rgba(88,166,255,0.28)',
                borderRight: '1px solid rgba(88,166,255,0.28)',
              }} />
              {/* Space centre line */}
              {spaceFreq >= 0 && spaceFreq <= DISPLAY_MAX_HZ && (
                <div className="absolute inset-y-0 pointer-events-none" style={{ left: `${(spaceFreq / DISPLAY_MAX_HZ) * 100}%`, width: '2px', backgroundColor: '#f0883e', opacity: 0.9 }}>
                  <span className="absolute top-1 left-1 text-[10px] font-mono font-bold text-[#f0883e] leading-none drop-shadow-md">S</span>
                </div>
              )}
              {/* Mark centre line */}
              {markFreq >= 0 && markFreq <= DISPLAY_MAX_HZ && (
                <div className="absolute inset-y-0 pointer-events-none" style={{ left: `${(markFreq / DISPLAY_MAX_HZ) * 100}%`, width: '2px', backgroundColor: '#58a6ff', opacity: 0.9 }}>
                  <span className="absolute top-1 left-1 text-[10px] font-mono font-bold text-[#58a6ff] leading-none drop-shadow-md">M</span>
                </div>
              )}
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
            <li>Click &quot;Start Decoding&quot; to begin capturing audio from your microphone</li>
            <li>Tune your radio to an RTTY signal (typically 45 or 50 baud, 170 or 450 Hz shift)</li>
            <li>On the Spectrum panel, click and drag to position the <span className="text-[#58a6ff] font-mono">M</span> (mark) and <span className="text-[#f0883e] font-mono">S</span> (space) markers over the two signal peaks</li>
            <li>Adjust Carrier Shift and Baud Rate in the configuration panel to match the transmission</li>
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
