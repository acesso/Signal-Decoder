'use client';

import { useEffect, useRef, useCallback, useState } from 'react';
import { useAudioProcessor, CapturedImage, SSTVMode } from '@/hooks/useAudioProcessor';
import SettingsPanel from '@/components/SettingsPanel';
import { SSTV_MODES } from '@/lib/sstv/constants';
import { DecoderState } from '@/lib/sstv/decoder';

const SPECTRUM_MAX_HZ = 3000;

function drawFreqAxis(ctx: CanvasRenderingContext2D, w: number, plotH: number) {
  ctx.strokeStyle = '#30363d'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, plotH); ctx.lineTo(w, plotH); ctx.stroke();
  for (let f = 0; f <= SPECTRUM_MAX_HZ; f += 100) {
    const x   = (f / SPECTRUM_MAX_HZ) * w;
    const maj = f % 500 === 0;
    ctx.strokeStyle = maj ? '#8b949e' : '#30363d';
    ctx.beginPath(); ctx.moveTo(x, plotH); ctx.lineTo(x, plotH + (maj ? 6 : 2)); ctx.stroke();
    if (maj) {
      ctx.fillStyle = '#8b949e'; ctx.font = '10px monospace'; ctx.textAlign = 'center';
      ctx.fillText(f >= 1000 ? `${f / 1000}k` : `${f}`, x, plotH + 17);
    }
  }
}

// ── Gallery thumbnail card ────────────────────────────────────────────────────

function GalleryCard({ img, onClick }: { img: CapturedImage; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="shrink-0 w-36 rounded-lg border border-[#30363d] bg-[#0d1117] overflow-hidden hover:border-[#2ea043] transition-colors group"
    >
      <div className="relative w-full" style={{ aspectRatio: `${img.width}/${img.height}` }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={img.thumbnailUrl} alt={img.mode} className="w-full h-full object-cover" />
        <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-colors" />
      </div>
      <div className="p-1.5 text-left">
        <div className="text-[10px] font-mono text-[#2ea043] truncate">{SSTV_MODES[img.mode].name}</div>
        <div className="text-[10px] text-[#8b949e]">{img.captureTime.toLocaleTimeString()}</div>
      </div>
    </button>
  );
}

// ── Full-image modal ──────────────────────────────────────────────────────────

function ImageModal({ img, onClose }: { img: CapturedImage; onClose: () => void }) {
  const handleDownload = () => {
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext('2d')!;
    const clamped = new Uint8ClampedArray(img.data.buffer as ArrayBuffer, img.data.byteOffset, img.data.byteLength);
    ctx.putImageData(new ImageData(clamped, img.width, img.height), 0, 0);
    const link = document.createElement('a');
    link.download = `sstv-${img.mode.toLowerCase()}-${img.captureTime.getTime()}.png`;
    link.href = canvas.toDataURL('image/png');
    link.click();
  };

  const dur = img.duration >= 60
    ? `${Math.floor(img.duration / 60)}m ${Math.round(img.duration % 60)}s`
    : `${Math.round(img.duration)}s`;

  return (
    <div
      className="fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-[#161b22] border border-[#30363d] rounded-lg max-w-3xl w-full shadow-2xl max-h-[90vh] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-[#30363d] shrink-0">
          <div>
            <span className="font-semibold text-[#c9d1d9]">{SSTV_MODES[img.mode].name}</span>
            <span className="ml-2 text-[#8b949e] text-sm">{img.width}×{img.height} px</span>
          </div>
          <button onClick={onClose} className="text-[#8b949e] hover:text-[#c9d1d9] transition-colors">
            <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Image */}
        <div className="flex-1 min-h-0 overflow-auto flex items-center justify-center bg-[#0d1117] p-4">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={img.thumbnailUrl}
            alt={img.mode}
            style={{ maxWidth: '100%', maxHeight: '60vh', imageRendering: 'pixelated' }}
          />
        </div>

        {/* Metadata + actions */}
        <div className="p-4 border-t border-[#30363d] shrink-0 space-y-3">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[
              { label: 'Mode',       value: SSTV_MODES[img.mode].name },
              { label: 'Captured',   value: img.captureTime.toLocaleTimeString() },
              { label: 'Duration',   value: dur },
              { label: 'Resolution', value: `${img.width}×${img.height}` },
            ].map(({ label, value }) => (
              <div key={label} className="bg-[#0d1117] border border-[#30363d] rounded p-2">
                <div className="text-[10px] text-[#8b949e] mb-0.5">{label}</div>
                <div className="text-xs font-mono font-semibold text-[#c9d1d9]">{value}</div>
              </div>
            ))}
          </div>
          <div className="flex justify-end gap-2">
            <button
              onClick={onClose}
              className="px-4 py-2 rounded-md bg-[#21262d] hover:bg-[#30363d] text-[#c9d1d9] text-sm font-semibold border border-[#30363d] transition-colors"
            >
              Close
            </button>
            <button
              onClick={handleDownload}
              className="px-4 py-2 rounded-md bg-[#238636] hover:bg-[#2ea043] text-white text-sm font-semibold transition-colors flex items-center gap-2"
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M3 17a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm3.293-7.707a1 1 0 011.414 0L9 10.586V3a1 1 0 112 0v7.586l1.293-1.293a1 1 0 111.414 1.414l-3 3a1 1 0 01-1.414 0l-3-3a1 1 0 010-1.414z" clipRule="evenodd" />
              </svg>
              Download PNG
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function SSTVImageDecoder() {
  const [manualMode, setManualMode] = useState<SSTVMode>('ROBOT36');
  const [autoDetect, setAutoDetect] = useState(true);
  const [selectedImage, setSelectedImage] = useState<CapturedImage | null>(null);

  // Canvas refs
  const imageCanvasRef       = useRef<HTMLCanvasElement>(null);
  const spectrumCanvasRef    = useRef<HTMLCanvasElement>(null);
  const spectrogramCanvasRef = useRef<HTMLCanvasElement>(null);
  const animFrameRef         = useRef<number | null>(null);
  const spectrogramFrameRef  = useRef(0);

  // Dynamic spectrogram height
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

  // Spectrogram controls
  const [spectrogramGamma, setSpectrogramGamma] = useState(3.0);
  const [spectrogramSpeed, setSpectrogramSpeed] = useState(2);
  const spectrogramGammaRef = useRef(3.0);
  const spectrogramSpeedRef = useRef(2);
  useEffect(() => { spectrogramGammaRef.current = spectrogramGamma; }, [spectrogramGamma]);
  useEffect(() => { spectrogramSpeedRef.current = spectrogramSpeed; }, [spectrogramSpeed]);

  // Resizable panels
  const containerRef    = useRef<HTMLDivElement>(null);
  const [panelWeights, setPanelWeights] = useState([1.5, 1, 0.75]);
  const panelWeightsRef = useRef([1.5, 1, 0.75]);
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
      const total = drag.startWeights.reduce((a, b) => a + b, 0);
      const dw    = ((e.clientX - drag.startX) / containerRef.current.offsetWidth) * total;
      const w     = [...drag.startWeights];
      w[drag.handle]     = Math.max(0.15, w[drag.handle]     + dw);
      w[drag.handle + 1] = Math.max(0.15, w[drag.handle + 1] - dw);
      setPanelWeights([...w]);
    };
    const onUp = () => { dragRef.current = null; };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup',   onUp);
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
  }, []);

  // ── Audio hook ───────────────────────────────────────────────────────────────

  const { state, startRecording, stopRecording, resetDecoder, clearImages, getImageData, getDimensions, getAnalyser } =
    useAudioProcessor(manualMode, autoDetect);

  const { width, height } = getDimensions();

  // ── Drawing ──────────────────────────────────────────────────────────────────

  const drawImage = useCallback(() => {
    const canvas = imageCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const data = getImageData();
    if (data) {
      const clamped = new Uint8ClampedArray(data.buffer as ArrayBuffer, data.byteOffset, data.byteLength);
      ctx.putImageData(new ImageData(clamped, width, height), 0, 0);
    }
  }, [getImageData, width, height]);

  const drawSpectrum = useCallback((canvas: HTMLCanvasElement): Uint8Array | undefined => {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const axisH = 25;
    const plotH = canvas.height - axisH;
    ctx.fillStyle = 'rgb(10,10,10)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const analyser = getAnalyser();
    let visibleData: Uint8Array | undefined;
    if (analyser) {
      const bufLen  = analyser.frequencyBinCount;
      const data    = new Uint8Array(bufLen);
      analyser.getByteFrequencyData(data);
      const nyquist = analyser.context.sampleRate / 2;
      const binsShow = Math.max(1, Math.floor((SPECTRUM_MAX_HZ / nyquist) * bufLen));
      visibleData   = data.subarray(0, binsShow);
      ctx.strokeStyle = '#2ea043'; ctx.lineWidth = 2;
      ctx.beginPath();
      for (let i = 0; i < binsShow; i++) {
        const x = (i / binsShow) * canvas.width;
        const y = plotH - (visibleData[i] / 255) * plotH;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    drawFreqAxis(ctx, canvas.width, plotH);
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
      const value = freqData[b0] * (1 - (binF - b0)) + freqData[b1] * (binF - b0);
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
      drawImage();
      const specCanvas = spectrumCanvasRef.current;
      const sgCanvas   = spectrogramCanvasRef.current;
      if (specCanvas) {
        const freqData = drawSpectrum(specCanvas);
        spectrogramFrameRef.current++;
        if (sgCanvas && freqData && spectrogramFrameRef.current % spectrogramSpeedRef.current === 0) {
          drawSpectrogram(sgCanvas, freqData);
        }
      }
      animFrameRef.current = requestAnimationFrame(tick);
    };
    animFrameRef.current = requestAnimationFrame(tick);
    return () => { if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current); };
  }, [drawImage, drawSpectrum, drawSpectrogram]);

  // ── Handlers ─────────────────────────────────────────────────────────────────

  const handleModeChange = (newMode: SSTVMode) => {
    if (state.isRecording) stopRecording();
    setManualMode(newMode);
  };

  // ── Derived ───────────────────────────────────────────────────────────────────

  const stats      = state.stats;
  const activeMode = state.activeMode;
  const modeCfg    = SSTV_MODES[activeMode];
  const isDecoding = stats?.state === DecoderState.DECODING_IMAGE;
  const progress   = stats?.progress ?? 0;
  const snrColor   = stats?.snr == null ? 'text-[#8b949e]'
    : stats.snr < 10 ? 'text-[#da3633]'
    : stats.snr < 18 ? 'text-[#e3b341]'
    : 'text-[#2ea043]';

  return (
    <div className="space-y-4 sm:space-y-6">

      {/* ── Controls ── */}
      <div className="bg-[#161b22] border border-[#30363d] rounded-lg p-4 sm:p-6 space-y-4">
        <div className="flex flex-col sm:flex-row gap-3 sm:gap-4">
          {/* Auto-detect toggle */}
          <button
            onClick={() => { if (state.isRecording) stopRecording(); setAutoDetect(v => !v); }}
            className={`shrink-0 px-4 py-3 rounded-md text-sm font-semibold border transition-colors flex items-center gap-2 ${
              autoDetect
                ? 'bg-[#1f6feb]/20 border-[#1f6feb]/50 text-[#58a6ff] hover:bg-[#1f6feb]/30'
                : 'bg-[#21262d] border-[#30363d] text-[#8b949e] hover:text-[#c9d1d9] hover:bg-[#30363d]'
            }`}
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M11.3 1.046A1 1 0 0112 2v5h4a1 1 0 01.82 1.573l-7 10A1 1 0 018 18v-5H4a1 1 0 01-.82-1.573l7-10a1 1 0 011.12-.38z" clipRule="evenodd" />
            </svg>
            {autoDetect ? 'Auto-detect ON' : 'Auto-detect OFF'}
          </button>

          {!state.isRecording ? (
            <button
              onClick={startRecording}
              disabled={!state.isSupported}
              className="flex-1 bg-[#238636] hover:bg-[#2ea043] disabled:opacity-50 text-white font-semibold px-6 py-3 rounded-md transition-colors text-base border border-transparent flex items-center justify-center gap-2"
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM9.555 7.168A1 1 0 008 8v4a1 1 0 001.555.832l3-2a1 1 0 000-1.664l-3-2z" clipRule="evenodd" />
              </svg>
              Start Decoding
            </button>
          ) : (
            <button
              onClick={stopRecording}
              className="flex-1 bg-[#da3633] hover:bg-[#f85149] text-white font-semibold px-6 py-3 rounded-md transition-colors text-base flex items-center justify-center gap-2"
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8 7a1 1 0 00-1 1v4a1 1 0 001 1h4a1 1 0 001-1V8a1 1 0 00-1-1H8z" clipRule="evenodd" />
              </svg>
              Stop
            </button>
          )}

          <button
            onClick={resetDecoder}
            className="shrink-0 bg-[#21262d] hover:bg-[#30363d] text-white font-semibold px-6 py-3 rounded-md transition-colors text-base border border-[#30363d] flex items-center justify-center gap-2"
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M4 2a1 1 0 011 1v2.101a7.002 7.002 0 0111.601 2.566 1 1 0 11-1.885.666A5.002 5.002 0 005.999 7H9a1 1 0 010 2H4a1 1 0 01-1-1V3a1 1 0 011-1zm.008 9.057a1 1 0 011.276.61A5.002 5.002 0 0014.001 13H11a1 1 0 110-2h5a1 1 0 011 1v5a1 1 0 11-2 0v-2.101a7.002 7.002 0 01-11.601-2.566 1 1 0 01.61-1.276z" clipRule="evenodd" />
            </svg>
            Reset
          </button>
        </div>

        {/* Auto-detect status */}
        {state.isRecording && autoDetect && (
          <div className={`flex items-center gap-2 text-sm px-3 py-2 rounded-md border ${
            state.isListeningForVIS
              ? 'bg-[#1f6feb]/10 border-[#1f6feb]/30 text-[#58a6ff]'
              : 'bg-[#238636]/10 border-[#238636]/30 text-[#2ea043]'
          }`}>
            <span className={`inline-block w-2 h-2 rounded-full ${state.isListeningForVIS ? 'bg-[#58a6ff] animate-pulse' : 'bg-[#2ea043]'}`} />
            {state.detectionStatus || (state.isListeningForVIS ? 'Listening for VIS…' : 'Decoding')}
          </div>
        )}

        {state.error && (
          <div className="bg-[#da3633]/10 border border-[#f85149]/30 rounded-md p-3 text-[#f85149] text-sm">
            {state.error}
          </div>
        )}
      </div>

      {/* ── Main display — resizable columns ── */}
      <div ref={containerRef} className="flex flex-col lg:flex-row lg:items-stretch gap-4 lg:gap-0">

        {/* Panel 1 — Received Image */}
        <div
          className="bg-[#161b22] border border-[#30363d] rounded-lg p-3 sm:p-4 flex flex-col min-w-0"
          style={{ flex: panelWeights[0] }}
        >
          <div className="flex items-center justify-between mb-2 sm:mb-3">
            <h2 className="text-lg sm:text-xl font-semibold">Received Image</h2>
            <span className="text-xs text-[#8b949e] font-mono">{width}×{height} px</span>
          </div>
          <div className="flex flex-1 items-center justify-center bg-[#0d1117] border border-[#30363d] rounded min-h-[200px] overflow-hidden">
            <canvas
              ref={imageCanvasRef}
              width={width}
              height={height}
              style={{ maxWidth: '100%', height: 'auto', imageRendering: 'pixelated' }}
            />
          </div>
        </div>

        {/* Drag handle 0↔1 */}
        <div
          className="hidden lg:flex w-3 self-stretch cursor-col-resize items-center justify-center group shrink-0"
          onMouseDown={(e) => startDrag(e, 0)}
        >
          <div className="w-px h-full bg-[#30363d] group-hover:bg-[#2ea043]/50 transition-colors" />
        </div>

        {/* Panel 2 — Audio Analysis */}
        <div
          className="bg-[#161b22] border border-[#30363d] rounded-lg p-3 sm:p-4 min-w-0 flex flex-col"
          style={{ flex: panelWeights[1] }}
        >
          <h2 className="text-lg sm:text-xl font-semibold mb-2 sm:mb-3">Audio Analysis</h2>

          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-medium text-[#8b949e]">Spectrum</h3>
              <span className="text-xs text-[#8b949e] font-mono">SSTV: 1.2–2.3 kHz</span>
            </div>
            <canvas
              ref={spectrumCanvasRef}
              width={640} height={200}
              className="w-full border border-[#30363d] rounded bg-[#0d1117]"
            />
          </div>

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

        {/* Drag handle 1↔2 */}
        <div
          className="hidden lg:flex w-3 self-stretch cursor-col-resize items-center justify-center group shrink-0"
          onMouseDown={(e) => startDrag(e, 1)}
        >
          <div className="w-px h-full bg-[#30363d] group-hover:bg-[#2ea043]/50 transition-colors" />
        </div>

        {/* Panel 3 — Reception Info */}
        <div
          className="bg-[#161b22] border border-[#30363d] rounded-lg p-3 sm:p-4 min-w-0 flex flex-col gap-3"
          style={{ flex: panelWeights[2] }}
        >
          <h2 className="text-lg sm:text-xl font-semibold">Reception Info</h2>

          <div className="bg-[#0d1117] border border-[#30363d] rounded-lg p-3">
            <div className="text-[#8b949e] text-xs mb-1">Mode</div>
            <div className="font-mono font-semibold text-sm text-[#2ea043]">{modeCfg.name}</div>
            <div className="text-xs text-[#8b949e] mt-0.5">{modeCfg.width}×{modeCfg.height} px</div>
            {autoDetect && (
              <div className="text-[10px] text-[#8b949e] mt-1 italic">
                {state.isListeningForVIS ? 'Waiting for VIS…' : 'Auto-detected'}
              </div>
            )}
          </div>

          <div className="bg-[#0d1117] border border-[#30363d] rounded-lg p-3">
            <div className="text-[#8b949e] text-xs mb-1">State</div>
            <div className={`font-mono font-semibold text-sm ${isDecoding ? 'text-[#2ea043]' : 'text-gray-400'}`}>
              {state.isListeningForVIS ? 'LISTENING' : (stats?.state ?? 'IDLE')}
            </div>
          </div>

          <div className="bg-[#0d1117] border border-[#30363d] rounded-lg p-3">
            <div className="text-[#8b949e] text-xs mb-1">Line</div>
            <div className="font-mono font-semibold text-sm">
              {stats ? `${stats.currentLine} / ${stats.totalLines}` : '—'}
            </div>
          </div>

          <div className="bg-[#0d1117] border border-[#30363d] rounded-lg p-3">
            <div className="text-[#8b949e] text-xs mb-1">SNR</div>
            <div className={`font-mono font-semibold text-sm ${snrColor}`}>
              {stats?.snr != null ? `${stats.snr.toFixed(1)} dB` : '-- dB'}
            </div>
          </div>

          {progress > 0 && (
            <div>
              <div className="flex justify-between text-xs text-[#8b949e] mb-1">
                <span>Progress</span>
                <span className="font-mono">{Math.round(progress)}%</span>
              </div>
              <div className="w-full bg-[#21262d] rounded-full h-1.5">
                <div
                  className="bg-[#238636] h-1.5 rounded-full transition-all duration-200"
                  style={{ width: `${Math.min(progress, 100)}%` }}
                />
              </div>
            </div>
          )}

          {!autoDetect && (
            <div className="text-xs text-[#8b949e] leading-relaxed mt-auto pt-2 border-t border-[#30363d]">
              Use the <span className="text-[#c9d1d9]">settings button</span> (bottom-right) to change SSTV mode manually.
            </div>
          )}
        </div>
      </div>

      {/* ── Image gallery ── */}
      {state.capturedImages.length > 0 && (
        <div className="bg-[#161b22] border border-[#30363d] rounded-lg p-3 sm:p-4">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-lg font-semibold">
              Captured Images
              <span className="ml-2 text-sm font-normal text-[#8b949e]">({state.capturedImages.length})</span>
            </h2>
            <button
              onClick={clearImages}
              className="text-xs text-[#8b949e] hover:text-[#da3633] transition-colors px-2 py-1 rounded border border-transparent hover:border-[#da3633]/30"
            >
              Clear all
            </button>
          </div>
          <div className="flex gap-3 overflow-x-auto pb-2">
            {state.capturedImages.map(img => (
              <GalleryCard key={img.id} img={img} onClick={() => setSelectedImage(img)} />
            ))}
          </div>
        </div>
      )}

      {/* ── Modals ── */}
      {selectedImage && (
        <ImageModal img={selectedImage} onClose={() => setSelectedImage(null)} />
      )}

      {/* SSTV mode selector — MUI floating action button (manual mode only) */}
      {!autoDetect && (
        <SettingsPanel
          currentMode={manualMode}
          onModeChange={handleModeChange}
          disabled={state.isRecording}
        />
      )}
    </div>
  );
}
