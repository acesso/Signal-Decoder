'use client';

import { useEffect, useRef, useCallback, useState, forwardRef, useImperativeHandle } from 'react';
import type { DecoderControls, DecoderProps } from './DecoderControls';
import AudioAnalysisPanel from './AudioAnalysisPanel';
import { useAudioProcessor, CapturedImage, SSTVMode } from '@/hooks/useAudioProcessor';
import { SSTV_MODES } from '@/lib/sstv/constants';
import { DecoderState } from '@/lib/sstv/decoder';

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

const SSTVDecoder = forwardRef<DecoderControls, DecoderProps>(function SSTVDecoder({ onStateChange, analyser }, ref) {
  const [manualMode, setManualMode] = useState<SSTVMode>('ROBOT36');
  const [autoDetect, setAutoDetect] = useState(true);
  const [autoSlant, setAutoSlant] = useState(true);
  const [selectedImage, setSelectedImage] = useState<CapturedImage | null>(null);

  // Canvas refs
  const imageCanvasRef = useRef<HTMLCanvasElement>(null);

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

  const { state, startRecording, stopRecording, resetDecoder, clearImages, getImageData, getDimensions } =
    useAudioProcessor(manualMode, autoDetect, autoSlant);

  // Used only for canvas element sizing and the header label — NOT passed into the draw callback
  const { width, height } = getDimensions();

  // ── Drawing ──────────────────────────────────────────────────────────────────

  const drawImage = useCallback(() => {
    const canvas = imageCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const data = getImageData();
    if (data) {
      const { width: w, height: h } = getDimensions();
      if (w > 0 && h > 0 && data.length === w * h * 4) {
        const clamped = new Uint8ClampedArray(data.buffer as ArrayBuffer, data.byteOffset, data.byteLength);
        ctx.putImageData(new ImageData(clamped, w, h), 0, 0);
      }
    }
  }, [getImageData, getDimensions]);

  useEffect(() => {
    let animFrameRef: number | null = null;
    const tick = () => {
      drawImage();
      animFrameRef = requestAnimationFrame(tick);
    };
    animFrameRef = requestAnimationFrame(tick);
    return () => { if (animFrameRef) cancelAnimationFrame(animFrameRef); };
  }, [drawImage]);

  // ── Handlers ─────────────────────────────────────────────────────────────────

  const handleModeChange = (newMode: SSTVMode) => {
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

  const handleReset = useCallback(() => { resetDecoder(); }, [resetDecoder]);

  const controls: DecoderControls = {
    isRecording: state.isRecording,
    isSupported: state.isSupported,
    error: state.error,
    start: startRecording,
    stop: stopRecording,
    reset: handleReset,
  };
  useImperativeHandle(ref, () => controls, [state.isRecording, state.isSupported, state.error, startRecording, stopRecording, handleReset]); // eslint-disable-line react-hooks/exhaustive-deps
  const onStateChangeRef = useRef(onStateChange);
  onStateChangeRef.current = onStateChange;
  useEffect(() => { onStateChangeRef.current?.(controls); }, [state.isRecording, state.isSupported, state.error]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="space-y-4 sm:space-y-6">

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
        <AudioAnalysisPanel
          analyser={analyser ?? null}
          isRecording={state.isRecording}
          className="min-w-0"
          style={{ flex: panelWeights[1] }}
        />

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

          {/* Auto-detect toggle */}
          <div className="flex items-center gap-2.5">
            <button
              role="switch"
              aria-checked={autoDetect}
              onClick={() => setAutoDetect(v => !v)}
              className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors focus:outline-none ${
                autoDetect ? 'bg-[#238636] border-[#2ea043]' : 'bg-[#21262d] border-[#30363d]'
              }`}
            >
              <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow-sm transition-transform ${
                autoDetect ? 'translate-x-4' : 'translate-x-0.5'
              }`} />
            </button>
            <span className="text-sm text-[#c9d1d9] cursor-default select-none">Auto Detect</span>
          </div>

          {/* Auto-slant toggle */}
          <div className="flex items-center gap-2.5">
            <button
              role="switch"
              aria-checked={autoSlant}
              onClick={() => setAutoSlant(v => !v)}
              className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors focus:outline-none ${
                autoSlant ? 'bg-[#238636] border-[#2ea043]' : 'bg-[#21262d] border-[#30363d]'
              }`}
            >
              <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow-sm transition-transform ${
                autoSlant ? 'translate-x-4' : 'translate-x-0.5'
              }`} />
            </button>
            <span className="text-sm text-[#c9d1d9] cursor-default select-none">Auto Slant</span>
          </div>

          {/* Manual mode selector — always visible, locked when auto-detect is on */}
          <div className={`space-y-1.5 transition-opacity ${autoDetect ? 'opacity-40' : 'opacity-100'}`}>
            <div className="text-xs text-[#8b949e]">Manual Mode</div>
            <select
              disabled={autoDetect}
              value={manualMode}
              onChange={(e) => handleModeChange(e.target.value as SSTVMode)}
              className="w-full bg-[#0d1117] border border-[#30363d] rounded px-2 py-1.5 text-[#c9d1d9] font-mono text-xs focus:outline-none focus:border-[#2ea043] transition-colors disabled:cursor-not-allowed"
            >
              {(Object.keys(SSTV_MODES) as SSTVMode[]).map(k => (
                <option key={k} value={k}>{SSTV_MODES[k].name}</option>
              ))}
            </select>
          </div>

          {/* Active mode box */}
          <div className="bg-[#0d1117] border border-[#30363d] rounded-lg p-3">
            <div className="text-[#8b949e] text-xs mb-1">Active Mode</div>
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

      {/* ── How to Use ── */}
      <details className="bg-[#161b22] border border-[#30363d] rounded-lg">
        <summary className="cursor-pointer p-4 sm:p-6 font-semibold text-lg sm:text-xl hover:bg-[#21262d] rounded-lg transition-colors select-none">
          How to Use
        </summary>
        <div className="px-4 pb-4 sm:px-6 sm:pb-6">
          <ol className="list-decimal list-inside space-y-2 text-sm sm:text-base text-[#c9d1d9]">
            <li>Click <strong>Start Decoding</strong> and allow microphone access when prompted</li>
            <li>Leave mode on <strong>Auto</strong> to let VIS code detection pick the mode automatically, or select a specific mode from the selector</li>
            <li>Play or tune to an SSTV signal — the image builds progressively on the canvas</li>
            <li>Use the spectrum analyser and SNR indicator to optimise audio levels</li>
            <li>Click <strong>Save Image</strong> to download the decoded image as a PNG file</li>
            <li>Previously decoded images are kept in the gallery below the canvas</li>
            <li>Click <strong>Reset</strong> to clear the canvas and start a new decode</li>
          </ol>
          <p className="mt-4 text-xs sm:text-sm text-[#8b949e]">
            Tip: The sync pulses in an SSTV signal appear as periodic bright lines in the spectrogram. A strong, stable signal produces the best image quality.
          </p>
        </div>
      </details>

      {/* ── Privacy ── */}
      <details className="bg-[#161b22] border border-[#30363d] rounded-lg">
        <summary className="cursor-pointer p-4 sm:p-6 font-semibold text-lg sm:text-xl hover:bg-[#21262d] rounded-lg transition-colors select-none">
          Privacy
        </summary>
        <div className="px-4 pb-4 sm:px-6 sm:pb-6 space-y-3 text-sm sm:text-base text-[#c9d1d9]">
          <p>This application runs entirely in your browser. No audio data or decoded images are ever transmitted to any server.</p>
          <p>The microphone permission is only used to capture and process the audio signal in real-time for SSTV decoding using the Web Audio API.</p>
          <p className="text-xs sm:text-sm text-[#8b949e]">Your privacy is fully protected — we don&apos;t collect, store, or transmit any of your data.</p>
        </div>
      </details>

      {/* ── Modals ── */}
      {selectedImage && (
        <ImageModal img={selectedImage} onClose={() => setSelectedImage(null)} />
      )}

    </div>
  );
});

export default SSTVDecoder;
