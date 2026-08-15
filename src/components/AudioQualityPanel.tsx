// Live audio-quality visualization for tuning the bridge interface board's
// analog RC filter trimpots (both audio-in from the radio and audio-out to
// the radio's mic) by eye instead of by ear — see useAudioBridge.ts, which
// exposes an AnalyserNode per direction already wired into the existing
// playback/capture graphs. Runs entirely in the browser (real CPU/GPU
// budget here, unlike the ESP32) — deliberately more thorough than a bare
// meter: several automated "notice this for the operator" analyses on top
// of the raw views, since a trimpot problem can be easy to miss just
// eyeballing a constantly-moving trace.
//
// Views/readouts, all driven by the same AnalyserNode each animation frame:
//   - Bar spectrum + estimated cutoff/rolloff marker: shows the filter's
//     passband shape directly, PLUS a computed -3dB-ish rolloff point drawn
//     as a vertical marker with a Hz readout — turns "eyeball the bar
//     heights" into an actual number that moves as a trimpot turns.
//   - Waterfall (reusing GLSpectrogram, the same GPU component the
//     decoders use): scrolling history, so an intermittent issue or a
//     filter sweep is visible over time, not just this instant.
//   - Oscilloscope + peak/clip: a spectrum alone can't show clipping (looks
//     like broadband harmonic energy in frequency domain, but the scope
//     shows the actual flat-topping directly).
//   - Clip event marker + rolling count: a trimpot set too hot clips only
//     intermittently — easy to miss on a 60fps scope trace, obvious as an
//     accumulating "N clips in last 10s" counter with a flash-on-event border.
//   - DC offset: a misadjusted analog stage can bias the signal off zero,
//     eating into headroom before anything even looks "loud."
//   - Noise floor: rolling minimum spectrum level, so "is this trimpot
//     position noisier" has a number instead of just a vibe.
import { createSignal, onCleanup, onMount, type JSX } from 'solid-js'
import GLSpectrogram, { type GLSpectrogramHandle } from './GLSpectrogram'

const CLIP_THRESHOLD = 0.98 // fraction of full-scale (Web Audio's -1..1 float range)
const CLIP_WINDOW_MS = 10000 // rolling window for the "N clips in the last 10s" counter
const CLIP_FLASH_MS = 250 // how long the clip-event border flash stays visible
const NOISE_FLOOR_WINDOW_MS = 4000 // how far back "recent quiet" looks for the floor readout
const DC_OFFSET_WARN = 0.03 // ~3% of full-scale — flagged as visibly eating into headroom

function drawBarSpectrum(canvas: HTMLCanvasElement, data: Uint8Array, cutoffFrac: number | null) {
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const w = canvas.width,
    h = canvas.height
  ctx.fillStyle = '#0a0a0a'
  ctx.fillRect(0, 0, w, h)
  const barW = w / data.length
  for (let i = 0; i < data.length; i++) {
    const v = data[i] / 255
    const barH = v * h
    // Green-to-red gradient by level, same visual language as a VU meter —
    // a filter that's letting through too much energy in a band reads as
    // "that bar is red" at a glance, not just "taller."
    ctx.fillStyle = v > 0.85 ? '#f85149' : v > 0.6 ? '#e3b341' : '#2ea043'
    ctx.fillRect(i * barW, h - barH, Math.max(1, barW - 1), barH)
  }
  if (cutoffFrac != null && cutoffFrac >= 0 && cutoffFrac <= 1) {
    const x = cutoffFrac * w
    ctx.save()
    ctx.strokeStyle = '#58a6ff'
    ctx.shadowColor = '#58a6ff'
    ctx.shadowBlur = 6
    ctx.lineWidth = 1.5
    ctx.setLineDash([4, 3])
    ctx.beginPath()
    ctx.moveTo(x, 0)
    ctx.lineTo(x, h)
    ctx.stroke()
    ctx.restore()
  }
}

function drawScope(canvas: HTMLCanvasElement, data: Uint8Array, clipping: boolean, dcOffsetFrac: number) {
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const w = canvas.width,
    h = canvas.height
  ctx.fillStyle = '#0a0a0a'
  ctx.fillRect(0, 0, w, h)
  ctx.strokeStyle = '#3d444d'
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(0, h / 2)
  ctx.lineTo(w, h / 2)
  ctx.stroke()

  // DC-offset reference line — only drawn once it's large enough to matter,
  // so a healthy near-zero offset doesn't clutter the trace with a second
  // line sitting right on top of the zero line.
  if (Math.abs(dcOffsetFrac) >= DC_OFFSET_WARN) {
    const dcY = h / 2 - dcOffsetFrac * (h / 2) * 0.95
    ctx.strokeStyle = '#e3b341'
    ctx.lineWidth = 1
    ctx.setLineDash([3, 3])
    ctx.beginPath()
    ctx.moveTo(0, dcY)
    ctx.lineTo(w, dcY)
    ctx.stroke()
    ctx.setLineDash([])
  }

  ctx.strokeStyle = clipping ? '#f85149' : '#2ea043'
  ctx.lineWidth = 1.5
  ctx.beginPath()
  const step = w / data.length
  for (let i = 0; i < data.length; i++) {
    const v = (data[i] - 128) / 128 // Uint8 time-domain data centers on 128
    const y = h / 2 - v * (h / 2) * 0.95
    i === 0 ? ctx.moveTo(0, y) : ctx.lineTo(i * step, y)
  }
  ctx.stroke()

  // Clip markers: bold vertical red ticks at the top/bottom of the scope
  // wherever a sample actually crossed the threshold — the scope line
  // itself gets faint at 60fps, these persist for the whole frame.
  if (clipping) {
    ctx.fillStyle = '#f85149'
    for (let i = 0; i < data.length; i++) {
      const v = (data[i] - 128) / 128
      if (Math.abs(v) >= CLIP_THRESHOLD) {
        const x = i * step
        ctx.fillRect(x, 0, 2, 4)
        ctx.fillRect(x, h - 4, 2, 4)
      }
    }
  }
}

// Estimates where the passband rolls off: finds the peak level in the
// spectrum, then scans upward in frequency for the first bin that drops
// below half that peak's magnitude (~-6dB, a simpler and more robust
// threshold on 8-bit log-mapped analyser data than trying to reconstruct a
// true -3dB point) and stays below it for a few consecutive bins (avoids
// tripping on a single noisy dip). Returns null if the spectrum is too
// quiet overall to mean anything (silence has no "rolloff").
function estimateRolloffBin(data: Uint8Array): number | null {
  let peak = 0,
    peakIdx = 0
  for (let i = 0; i < data.length; i++) {
    if (data[i] > peak) {
      peak = data[i]
      peakIdx = i
    }
  }
  if (peak < 40) return null // effectively silent — nothing to estimate
  const halfPeak = peak / 2
  let belowRun = 0
  for (let i = peakIdx; i < data.length; i++) {
    if (data[i] < halfPeak) {
      belowRun++
      if (belowRun >= 3) return i - 2
    } else {
      belowRun = 0
    }
  }
  return null
}

function AudioQualityChannel(props: { label: string; analyser: AnalyserNode | null; active: boolean }): JSX.Element {
  let barCanvas: HTMLCanvasElement | undefined
  let scopeCanvas: HTMLCanvasElement | undefined
  const glSg: { current: GLSpectrogramHandle | null } = { current: null }
  const [peakPct, setPeakPct] = createSignal(0)
  const [clipping, setClipping] = createSignal(false)
  const [clipFlash, setClipFlash] = createSignal(false)
  const [clipCount, setClipCount] = createSignal(0)
  const [dcOffsetPct, setDcOffsetPct] = createSignal(0)
  const [noiseFloorPct, setNoiseFloorPct] = createSignal<number | null>(null)
  const [cutoffHz, setCutoffHz] = createSignal<number | null>(null)

  let freqData: Uint8Array<ArrayBuffer> | null = null
  let timeDataFloat: Float32Array<ArrayBuffer> | null = null
  let timeDataByte: Uint8Array<ArrayBuffer> | null = null
  const clipEvents: number[] = [] // timestamps (ms) of recent clip detections, for the rolling count
  let lastClipFlashAt = 0
  let noiseFloorMin = Infinity
  let noiseFloorWindowStart = 0

  onMount(() => {
    let rafId: number
    let lastWaterfallPush = 0
    const tick = (now: number) => {
      const analyser = props.analyser
      if (analyser) {
        const bc = analyser.frequencyBinCount
        if (!freqData || freqData.length !== bc) freqData = new Uint8Array(bc)
        analyser.getByteFrequencyData(freqData)

        const rolloffBin = estimateRolloffBin(freqData)
        if (rolloffBin != null) {
          const nyquist = analyser.context.sampleRate / 2
          setCutoffHz(Math.round((rolloffBin / bc) * nyquist))
        } else {
          setCutoffHz(null)
        }
        drawBarSpectrum(barCanvas!, freqData, rolloffBin != null ? rolloffBin / bc : null)

        if (now - lastWaterfallPush >= 33) {
          lastWaterfallPush = now
          glSg.current?.pushRow(freqData)
        }
        glSg.current?.render()

        // Rolling noise floor: track the minimum overall spectrum energy
        // seen in the last NOISE_FLOOR_WINDOW_MS, reset each window so an
        // old quiet moment doesn't get stuck reporting forever after the
        // signal gets consistently louder.
        let avgLevel = 0
        for (let i = 0; i < freqData.length; i++) avgLevel += freqData[i]
        avgLevel /= freqData.length
        if (now - noiseFloorWindowStart > NOISE_FLOOR_WINDOW_MS) {
          noiseFloorWindowStart = now
          noiseFloorMin = avgLevel
        } else if (avgLevel < noiseFloorMin) {
          noiseFloorMin = avgLevel
        }
        setNoiseFloorPct(Math.round((noiseFloorMin / 255) * 100))

        if (!timeDataFloat || timeDataFloat.length !== analyser.fftSize) {
          timeDataFloat = new Float32Array(analyser.fftSize)
          timeDataByte = new Uint8Array(analyser.fftSize)
        }
        analyser.getFloatTimeDomainData(timeDataFloat)
        let peak = 0
        let sum = 0
        for (let i = 0; i < timeDataFloat.length; i++) {
          const s = timeDataFloat[i]
          sum += s
          const a = Math.abs(s)
          if (a > peak) peak = a
        }
        const dcOffset = sum / timeDataFloat.length
        setDcOffsetPct(Math.round(dcOffset * 1000) / 10)

        const isClipping = peak >= CLIP_THRESHOLD
        setPeakPct(Math.round(Math.min(1, peak) * 100))
        setClipping(isClipping)
        if (isClipping) {
          clipEvents.push(now)
          if (now - lastClipFlashAt > CLIP_FLASH_MS) {
            lastClipFlashAt = now
            setClipFlash(true)
            setTimeout(() => setClipFlash(false), CLIP_FLASH_MS)
          }
        }
        while (clipEvents.length > 0 && now - clipEvents[0] > CLIP_WINDOW_MS) clipEvents.shift()
        setClipCount(clipEvents.length)

        analyser.getByteTimeDomainData(timeDataByte!)
        drawScope(scopeCanvas!, timeDataByte!, isClipping, dcOffset)
      } else {
        const bctx = barCanvas?.getContext('2d')
        const sctx = scopeCanvas?.getContext('2d')
        if (bctx && barCanvas) bctx.fillRect(0, 0, barCanvas.width, barCanvas.height)
        if (sctx && scopeCanvas) sctx.fillRect(0, 0, scopeCanvas.width, scopeCanvas.height)
        setPeakPct(0)
        setClipping(false)
        setClipCount(0)
        setDcOffsetPct(0)
        setNoiseFloorPct(null)
        setCutoffHz(null)
        clipEvents.length = 0
        noiseFloorMin = Infinity
      }
      rafId = requestAnimationFrame(tick)
    }
    rafId = requestAnimationFrame(tick)
    onCleanup(() => cancelAnimationFrame(rafId))
  })

  const dcWarn = () => Math.abs(dcOffsetPct()) / 100 >= DC_OFFSET_WARN

  return (
    <div
      class={`flex flex-col gap-1.5 rounded-md p-1.5 transition-colors ${
        clipFlash() ? 'bg-[#f85149]/20 ring-2 ring-[#f85149]' : ''
      }`}
    >
      <div class="flex items-center justify-between flex-wrap gap-x-2 gap-y-0.5">
        <span class="text-[10px] font-bold uppercase tracking-widest text-[#8b949e]">{props.label}</span>
        <span class={`text-[10px] font-mono ${clipping() ? 'text-[#f85149] font-bold' : 'text-[#8b949e]'}`}>
          {props.active ? `peak ${peakPct()}%${clipping() ? ' — CLIPPING' : ''}` : 'inactive'}
        </span>
      </div>

      <div class="relative">
        <canvas ref={barCanvas} width={320} height={60} class="block w-full rounded border border-[#30363d] bg-[#0a0a0a]" />
      </div>

      <div class="relative h-16">
        <GLSpectrogram handle={glSg} view="waterfall" gamma={1.2} height={64} maxHz={4000} minHz={0} colormap="turbo" />
      </div>

      <canvas ref={scopeCanvas} width={320} height={50} class="block w-full rounded border border-[#30363d] bg-[#0a0a0a]" />

      <div class="grid grid-cols-2 gap-x-3 gap-y-1 text-[10px] font-mono">
        <span class="text-[#8b949e]">Cutoff (~-6dB)</span>
        <span class="text-[#58a6ff] text-right">{cutoffHz() != null ? `${cutoffHz()} Hz` : '—'}</span>
        <span class="text-[#8b949e]">Noise floor</span>
        <span class="text-[#8b949e] text-right">{noiseFloorPct() != null ? `${noiseFloorPct()}%` : '—'}</span>
        <span class="text-[#8b949e]">DC offset</span>
        <span class={`text-right ${dcWarn() ? 'text-[#e3b341] font-bold' : 'text-[#8b949e]'}`}>
          {dcOffsetPct()}%{dcWarn() ? ' ⚠' : ''}
        </span>
        <span class="text-[#8b949e]">Clips (10s)</span>
        <span class={`text-right ${clipCount() > 0 ? 'text-[#f85149] font-bold' : 'text-[#8b949e]'}`}>{clipCount()}</span>
      </div>
    </div>
  )
}

export default function AudioQualityPanel(props: {
  analyserIn: AnalyserNode | null
  analyserOut: AnalyserNode | null
  playbackActive: boolean
  micActive: boolean
}): JSX.Element {
  return (
    <div class="flex flex-col gap-3 sm:flex-row sm:gap-4">
      <div class="flex-1 min-w-0">
        <AudioQualityChannel label="Speaker (in)" analyser={props.analyserIn} active={props.playbackActive} />
      </div>
      <div class="flex-1 min-w-0">
        <AudioQualityChannel label="Mic (out)" analyser={props.analyserOut} active={props.micActive} />
      </div>
    </div>
  )
}
