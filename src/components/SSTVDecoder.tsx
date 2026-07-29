// Port of src/components/SSTVDecoder.tsx (Next.js app).
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show, type JSX } from 'solid-js'
import type { DecoderProps, DecoderControls } from '../lib/decoderControls'
import AudioAnalysisPanel from './AudioAnalysisPanel'
import { createAudioProcessor, type CapturedImage, type SSTVMode } from '../lib/sstv/audioProcessor'
import { SSTV_MODES } from '$decoder-lib/sstv/constants'
import { DecoderState } from '$decoder-lib/sstv/decoder'
import { loadNumberArray, saveNumberArray } from '$decoder-lib/storage'
import { formatSignalReport } from '$decoder-lib/sstv/signalReport'

const DEFAULT_PANEL_WEIGHTS = [1.5, 1, 0.75]
const LS_PANEL_WEIGHTS = 'sstv_panel_weights'

function GalleryCard(props: { img: CapturedImage; onClick: () => void }) {
  return (
    <button
      onClick={props.onClick}
      class="group w-36 shrink-0 overflow-hidden rounded-lg border border-[#30363d] bg-[#0d1117] transition-colors hover:border-[#2ea043]"
    >
      <div class="relative w-full" style={{ 'aspect-ratio': `${props.img.width}/${props.img.height}` }}>
        <img src={props.img.thumbnailUrl} alt={props.img.mode} class="h-full w-full object-cover" />
        <div class="absolute inset-0 bg-black/0 transition-colors group-hover:bg-black/20" />
      </div>
      <div class="p-1.5 text-left">
        <div class="truncate font-mono text-[10px] text-[#2ea043]">{SSTV_MODES[props.img.mode].name}</div>
        <div class="text-[10px] text-[#8b949e]">{props.img.captureTime.toLocaleTimeString()}</div>
      </div>
    </button>
  )
}

function ImageModal(props: { img: CapturedImage; onClose: () => void; onReply?: (img: CapturedImage) => void }) {
  function handleDownload() {
    const canvas = document.createElement('canvas')
    canvas.width = props.img.width
    canvas.height = props.img.height
    const ctx = canvas.getContext('2d')!
    const clamped = new Uint8ClampedArray(props.img.data.buffer as ArrayBuffer, props.img.data.byteOffset, props.img.data.byteLength)
    ctx.putImageData(new ImageData(clamped, props.img.width, props.img.height), 0, 0)
    const link = document.createElement('a')
    link.download = `sstv-${props.img.mode.toLowerCase()}-${props.img.captureTime.getTime()}.png`
    link.href = canvas.toDataURL('image/png')
    link.click()
  }

  const dur = createMemo(() =>
    props.img.duration >= 60 ? `${Math.floor(props.img.duration / 60)}m ${Math.round(props.img.duration % 60)}s` : `${Math.round(props.img.duration)}s`,
  )

  return (
    <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4" onClick={props.onClose}>
      <div
        class="flex max-h-[90vh] w-full max-w-3xl flex-col rounded-lg border border-[#30363d] bg-[#161b22] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div class="flex shrink-0 items-center justify-between border-b border-[#30363d] p-4">
          <div>
            <span class="font-semibold text-[#c9d1d9]">{SSTV_MODES[props.img.mode].name}</span>
            <span class="ml-2 text-sm text-[#8b949e]">
              {props.img.width}×{props.img.height} px
            </span>
          </div>
          <button onClick={props.onClose} class="text-[#8b949e] transition-colors hover:text-[#c9d1d9]">
            <svg xmlns="http://www.w3.org/2000/svg" class="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width={2}>
              <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div class="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-[#0d1117] p-4">
          <img src={props.img.thumbnailUrl} alt={props.img.mode} style={{ 'max-width': '100%', 'max-height': '60vh', 'image-rendering': 'pixelated' }} />
        </div>

        <div class="shrink-0 space-y-3 border-t border-[#30363d] p-4">
          <div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <For
              each={[
                { label: 'Mode', value: SSTV_MODES[props.img.mode].name },
                { label: 'Captured', value: props.img.captureTime.toLocaleTimeString() },
                { label: 'Duration', value: dur() },
                { label: 'Resolution', value: `${props.img.width}×${props.img.height}` },
                { label: 'Signal Report', value: `${formatSignalReport(props.img.signalReport)} (RSV)` },
              ]}
            >
              {({ label, value }) => (
                <div class="rounded border border-[#30363d] bg-[#0d1117] p-2">
                  <div class="mb-0.5 text-[10px] text-[#8b949e]">{label}</div>
                  <div class="font-mono text-xs font-semibold text-[#c9d1d9]">{value}</div>
                </div>
              )}
            </For>
          </div>
          <div class="flex justify-end gap-2">
            <button
              onClick={props.onClose}
              class="rounded-md border border-[#30363d] bg-[#21262d] px-4 py-2 text-sm font-semibold text-[#c9d1d9] transition-colors hover:bg-[#30363d]"
            >
              Close
            </button>
            <Show when={props.onReply}>
              <button
                onClick={() => props.onReply?.(props.img)}
                class="flex items-center gap-2 rounded-md border border-[#58a6ff]/40 bg-[#58a6ff]/10 px-4 py-2 text-sm font-semibold text-[#58a6ff] transition-colors hover:bg-[#58a6ff]/20"
                title="Open the Compose & Transmit panel with this image, your callsign, timestamp, and signal report pre-filled"
              >
                Reply
              </button>
            </Show>
            <button
              onClick={handleDownload}
              class="flex items-center gap-2 rounded-md bg-[#238636] px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-[#2ea043]"
            >
              <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                <path
                  fill-rule="evenodd"
                  d="M3 17a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm3.293-7.707a1 1 0 011.414 0L9 10.586V3a1 1 0 112 0v7.586l1.293-1.293a1 1 0 111.414 1.414l-3 3a1 1 0 01-1.414 0l-3-3a1 1 0 010-1.414z"
                  clip-rule="evenodd"
                />
              </svg>
              Download PNG
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

export default function SSTVDecoder(props: DecoderProps & { onReply?: (img: CapturedImage) => void }): JSX.Element {
  const [manualMode, setManualMode] = createSignal<SSTVMode>('ROBOT36')
  const [autoDetect, setAutoDetect] = createSignal(true)
  const [autoSlant, setAutoSlant] = createSignal(true)
  const [selectedImage, setSelectedImage] = createSignal<CapturedImage | null>(null)

  let imageCanvasEl: HTMLCanvasElement | undefined

  let containerEl: HTMLDivElement | undefined
  const [panelWeights, setPanelWeights] = createSignal(loadNumberArray(LS_PANEL_WEIGHTS, DEFAULT_PANEL_WEIGHTS))
  let dragState: { handle: number; startX: number; startWeights: number[] } | null = null

  createEffect(() => saveNumberArray(LS_PANEL_WEIGHTS, panelWeights()))

  function startDrag(e: MouseEvent, handle: number) {
    e.preventDefault()
    dragState = { handle, startX: e.clientX, startWeights: [...panelWeights()] }
  }

  onMount(() => {
    const onMove = (e: MouseEvent) => {
      const drag = dragState
      if (!drag || !containerEl) return
      const total = drag.startWeights.reduce((a, b) => a + b, 0)
      const dw = ((e.clientX - drag.startX) / containerEl.offsetWidth) * total
      const w = [...drag.startWeights]
      w[drag.handle] = Math.max(0.15, w[drag.handle] + dw)
      w[drag.handle + 1] = Math.max(0.15, w[drag.handle + 1] - dw)
      setPanelWeights(w)
    }
    const onUp = () => {
      dragState = null
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    onCleanup(() => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    })
  })

  const processor = createAudioProcessor({ manualMode, autoDetect, autoSlant })

  createEffect(() => {
    void manualMode()
    void autoDetect()
    processor.syncManualMode()
  })

  const dimensions = createMemo(() => processor.getDimensions())

  function drawImage() {
    const canvas = imageCanvasEl
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const data = processor.getImageData()
    if (data) {
      const { width: w, height: h } = processor.getDimensions()
      if (w > 0 && h > 0 && data.length === w * h * 4) {
        const clamped = new Uint8ClampedArray(data.buffer as ArrayBuffer, data.byteOffset, data.byteLength)
        ctx.putImageData(new ImageData(clamped, w, h), 0, 0)
      }
    }
  }

  onMount(() => {
    let animFrame: number | null = null
    const tick = () => {
      drawImage()
      animFrame = requestAnimationFrame(tick)
    }
    animFrame = requestAnimationFrame(tick)
    onCleanup(() => {
      if (animFrame) cancelAnimationFrame(animFrame)
    })
  })

  const stats = createMemo(() => processor.state().stats)
  const activeMode = createMemo(() => processor.state().activeMode)
  const modeCfg = createMemo(() => SSTV_MODES[activeMode()])
  const isDecoding = createMemo(() => stats()?.state === DecoderState.DECODING_IMAGE)
  const progress = createMemo(() => stats()?.progress ?? 0)
  const snrColor = createMemo(() => {
    const snr = stats()?.snr
    if (snr == null) return 'text-[#8b949e]'
    if (snr < 10) return 'text-[#da3633]'
    if (snr < 18) return 'text-[#e3b341]'
    return 'text-[#2ea043]'
  })

  function handleReset() {
    processor.resetDecoder()
  }

  function isSupported() {
    return processor.state().isSupported
  }

  onMount(() => {
    if (props.handle) {
      props.handle.current = {
        get isRecording() {
          return processor.state().isRecording
        },
        get isSupported() {
          return isSupported()
        },
        get error() {
          return processor.state().error
        },
        start: processor.startRecording,
        stop: processor.stopRecording,
        reset: handleReset,
      }
    }
  })

  createEffect(() => {
    const controls: DecoderControls = {
      isRecording: processor.state().isRecording,
      isSupported: isSupported(),
      error: processor.state().error,
      start: processor.startRecording,
      stop: processor.stopRecording,
      reset: handleReset,
    }
    props.onStateChange?.(controls)
  })

  return (
    <div class="space-y-4 sm:space-y-6">
      <div ref={containerEl} class="flex flex-col gap-4 lg:flex-row lg:items-stretch lg:gap-0">
        {/* Panel 1 — Received Image */}
        <div class="flex min-w-0 flex-col rounded-lg border border-[#30363d] bg-[#161b22] p-3 sm:p-4" style={{ flex: panelWeights()[0] }}>
          <div class="mb-2 flex items-center justify-between sm:mb-3">
            <h2 class="text-lg font-semibold sm:text-xl">Received Image</h2>
            <span class="font-mono text-xs text-[#8b949e]">
              {dimensions().width}×{dimensions().height} px
            </span>
          </div>
          <div class="flex min-h-[200px] flex-1 items-center justify-center overflow-hidden rounded border border-[#30363d] bg-[#0d1117]">
            <canvas
              ref={imageCanvasEl}
              width={dimensions().width}
              height={dimensions().height}
              style={{ 'max-width': '100%', height: 'auto', 'image-rendering': 'pixelated' }}
            />
          </div>
        </div>

        {/* Drag handle 0<->1 */}
        <div
          class="group hidden w-3 shrink-0 cursor-col-resize items-center justify-center self-stretch lg:flex"
          onMouseDown={(e) => startDrag(e, 0)}
        >
          <div class="h-full w-px bg-[#30363d] transition-colors group-hover:bg-[#2ea043]/50" />
        </div>

        {/* Panel 2 — Audio Analysis */}
        <AudioAnalysisPanel
          analyser={props.analyser ?? null}
          isRecording={processor.state().isRecording}
          vfoFrequency={props.vfoFrequency}
          storageKeyPrefix="sstv"
          class="min-w-0"
          style={{ flex: panelWeights()[1] }}
        />

        {/* Drag handle 1<->2 */}
        <div
          class="group hidden w-3 shrink-0 cursor-col-resize items-center justify-center self-stretch lg:flex"
          onMouseDown={(e) => startDrag(e, 1)}
        >
          <div class="h-full w-px bg-[#30363d] transition-colors group-hover:bg-[#2ea043]/50" />
        </div>

        {/* Panel 3 — Reception Info */}
        <div class="flex min-w-0 flex-col gap-3 rounded-lg border border-[#30363d] bg-[#161b22] p-3 sm:p-4" style={{ flex: panelWeights()[2] }}>
          <h2 class="text-lg font-semibold sm:text-xl">Reception Info</h2>

          <div class="flex items-center gap-2.5">
            <button
              role="switch"
              aria-checked={autoDetect()}
              onClick={() => setAutoDetect((v) => !v)}
              class={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors focus:outline-none ${
                autoDetect() ? 'border-[#2ea043] bg-[#238636]' : 'border-[#30363d] bg-[#21262d]'
              }`}
            >
              <span
                class={`inline-block h-4 w-4 transform rounded-full bg-white shadow-sm transition-transform ${
                  autoDetect() ? 'translate-x-4' : 'translate-x-0.5'
                }`}
              />
            </button>
            <span class="cursor-default text-sm text-[#c9d1d9] select-none">Auto Detect</span>
          </div>

          <div class="flex items-center gap-2.5">
            <button
              role="switch"
              aria-checked={autoSlant()}
              onClick={() => setAutoSlant((v) => !v)}
              class={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors focus:outline-none ${
                autoSlant() ? 'border-[#2ea043] bg-[#238636]' : 'border-[#30363d] bg-[#21262d]'
              }`}
            >
              <span
                class={`inline-block h-4 w-4 transform rounded-full bg-white shadow-sm transition-transform ${
                  autoSlant() ? 'translate-x-4' : 'translate-x-0.5'
                }`}
              />
            </button>
            <span class="cursor-default text-sm text-[#c9d1d9] select-none">Auto Slant</span>
          </div>

          <div class={`space-y-1.5 transition-opacity ${autoDetect() ? 'opacity-40' : 'opacity-100'}`}>
            <div class="text-xs text-[#8b949e]">Manual Mode</div>
            <select
              disabled={autoDetect()}
              value={manualMode()}
              onChange={(e) => setManualMode(e.currentTarget.value as SSTVMode)}
              class="w-full rounded border border-[#30363d] bg-[#0d1117] px-2 py-1.5 font-mono text-xs text-[#c9d1d9] transition-colors focus:border-[#2ea043] focus:outline-none disabled:cursor-not-allowed"
            >
              <For each={Object.keys(SSTV_MODES) as SSTVMode[]}>{(k) => <option value={k}>{SSTV_MODES[k].name}</option>}</For>
            </select>
          </div>

          <div class="rounded-lg border border-[#30363d] bg-[#0d1117] p-3">
            <div class="mb-1 text-xs text-[#8b949e]">Active Mode</div>
            <div class="font-mono text-sm font-semibold text-[#2ea043]">{modeCfg().name}</div>
            <div class="mt-0.5 text-xs text-[#8b949e]">
              {modeCfg().width}×{modeCfg().height} px
            </div>
            <Show when={autoDetect()}>
              <div class="mt-1 text-[10px] text-[#8b949e] italic">
                {processor.state().isListeningForVIS ? 'Listening for VIS or sync timing…' : (processor.state().detectionStatus || 'Auto-detected')}
              </div>
            </Show>
          </div>

          <div class="rounded-lg border border-[#30363d] bg-[#0d1117] p-3">
            <div class="mb-1 text-xs text-[#8b949e]">State</div>
            <div class={`font-mono text-sm font-semibold ${isDecoding() ? 'text-[#2ea043]' : 'text-gray-400'}`}>
              {processor.state().isListeningForVIS ? 'LISTENING' : (stats()?.state ?? 'IDLE')}
            </div>
          </div>

          <div class="rounded-lg border border-[#30363d] bg-[#0d1117] p-3">
            <div class="mb-1 text-xs text-[#8b949e]">Line</div>
            <div class="font-mono text-sm font-semibold">{stats() ? `${stats()!.currentLine} / ${stats()!.totalLines}` : '—'}</div>
          </div>

          <div class="rounded-lg border border-[#30363d] bg-[#0d1117] p-3">
            <div class="mb-1 text-xs text-[#8b949e]">SNR</div>
            <div class={`font-mono text-sm font-semibold ${snrColor()}`}>{stats()?.snr != null ? `${stats()!.snr!.toFixed(1)} dB` : '-- dB'}</div>
          </div>

          <Show when={progress() > 0}>
            <div>
              <div class="mb-1 flex justify-between text-xs text-[#8b949e]">
                <span>Progress</span>
                <span class="font-mono">{Math.round(progress())}%</span>
              </div>
              <div class="h-1.5 w-full rounded-full bg-[#21262d]">
                <div class="h-1.5 rounded-full bg-[#238636] transition-all duration-200" style={{ width: `${Math.min(progress(), 100)}%` }} />
              </div>
            </div>
          </Show>
        </div>
      </div>

      {/* Image gallery */}
      <Show when={processor.state().capturedImages.length > 0}>
        <div class="rounded-lg border border-[#30363d] bg-[#161b22] p-3 sm:p-4">
          <div class="mb-3 flex items-center justify-between">
            <h2 class="text-lg font-semibold">
              Captured Images
              <span class="ml-2 text-sm font-normal text-[#8b949e]">({processor.state().capturedImages.length})</span>
            </h2>
            <button
              onClick={processor.clearImages}
              class="rounded border border-transparent px-2 py-1 text-xs text-[#8b949e] transition-colors hover:border-[#da3633]/30 hover:text-[#da3633]"
            >
              Clear all
            </button>
          </div>
          <div class="flex gap-3 overflow-x-auto pb-2">
            <For each={processor.state().capturedImages}>{(img) => <GalleryCard img={img} onClick={() => setSelectedImage(img)} />}</For>
          </div>
        </div>
      </Show>

      {/* How to Use */}
      <details class="rounded-lg border border-[#30363d] bg-[#161b22]">
        <summary class="cursor-pointer rounded-lg p-4 text-lg font-semibold transition-colors select-none hover:bg-[#21262d] sm:p-6 sm:text-xl">
          How to Use
        </summary>
        <div class="px-4 pb-4 sm:px-6 sm:pb-6">
          <ol class="list-inside list-decimal space-y-2 text-sm text-[#c9d1d9] sm:text-base">
            <li>
              Click <strong>Start Decoding</strong> and allow microphone access when prompted
            </li>
            <li>Leave mode on Auto to let VIS code detection pick the mode automatically, or select a specific mode from the selector</li>
            <li>Play or tune to an SSTV signal — the image builds progressively on the canvas</li>
            <li>Use the spectrum analyser and SNR indicator to optimise audio levels</li>
            <li>
              Click <strong>Save Image</strong> to download the decoded image as a PNG file
            </li>
            <li>Previously decoded images are kept in the gallery below the canvas</li>
            <li>
              Click <strong>Reset</strong> to clear the canvas and start a new decode
            </li>
          </ol>
          <p class="mt-4 text-xs text-[#8b949e] sm:text-sm">
            Tip: The sync pulses in an SSTV signal appear as periodic bright lines in the spectrogram. A strong, stable signal produces the best
            image quality.
          </p>
        </div>
      </details>

      {/* Privacy */}
      <details class="rounded-lg border border-[#30363d] bg-[#161b22]">
        <summary class="cursor-pointer rounded-lg p-4 text-lg font-semibold transition-colors select-none hover:bg-[#21262d] sm:p-6 sm:text-xl">
          Privacy
        </summary>
        <div class="space-y-3 px-4 pb-4 text-sm text-[#c9d1d9] sm:px-6 sm:pb-6 sm:text-base">
          <p>This application runs entirely in your browser. No audio data or decoded images are ever transmitted to any server.</p>
          <p>The microphone permission is only used to capture and process the audio signal in real-time for SSTV decoding using the Web Audio API.</p>
          <p class="text-xs text-[#8b949e] sm:text-sm">Your privacy is fully protected — we don't collect, store, or transmit any of your data.</p>
        </div>
      </details>

      <Show when={selectedImage()}>{(img) => <ImageModal img={img()} onClose={() => setSelectedImage(null)} onReply={props.onReply} />}</Show>
    </div>
  )
}
