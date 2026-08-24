// Port of src/hooks/useAudioProcessor.ts (Next.js app).
import { createSignal } from 'solid-js'
import { SSTVDecoder, type DecoderStats } from '$decoder-lib/sstv/decoder'
import { VISDetector } from '$decoder-lib/sstv/vis-detector'
import { SyncIntervalDetector } from '$decoder-lib/sstv/sync-interval-detector'
import { SSTV_MODES } from '$decoder-lib/sstv/constants'
import { transmittedLines } from '$decoder-lib/sstv/encoder'
import { createCaptureNode, type CaptureNode } from '$decoder-lib/audio/captureNode'
import { estimateSignalReport, type SignalReport } from '$decoder-lib/sstv/signalReport'
import { GoertzelFilter } from '$decoder-lib/sstv/dsp'
import { acquireMicrophoneSource, acquireBridgeSource, type AudioSourceKind, type AudioSourceHandle } from '$decoder-lib/audio/audioSource'
import type { AudioBridge } from '$decoder-lib/cat/useAudioBridge'
import type { IQBridge } from '$decoder-lib/cat/useIQBridge'

export type SSTVMode = keyof typeof SSTV_MODES

export interface CapturedImage {
  id: string
  mode: SSTVMode
  width: number
  height: number
  data: Uint8ClampedArray
  thumbnailUrl: string
  captureTime: Date
  duration: number
  signalReport: SignalReport
}

export interface AudioProcessorState {
  isRecording: boolean
  isSupported: boolean
  error: string | null
  stats: DecoderStats | null
  isListeningForVIS: boolean
  detectionStatus: string
  activeMode: SSTVMode
  capturedImages: CapturedImage[]
}

const SILENCE_DURATION_MS = 2500
// Hard backstop, independent of the silence heuristic below: if a decode
// makes no line progress at all for this long, something is wrong (the
// transmission ended and the tone/silence classifier missed it, a new
// unrelated transmission started, the signal degraded, etc.) — force a
// capture and re-arm auto-detect rather than risk getting stuck forever.
// Comfortably longer than the slowest single-line scan time across all
// modes (PD290 ≈ 1.2s/line) plus the silence timeout itself.
const STALL_TIMEOUT_MS = 6000
// A VIS header (unlike a sync-timing-only lock) tells us the mode directly,
// so the transmission's total length is fully predictable: scanTime *
// transmittedLines(mode) — see encoder.ts, shared so this can't drift out of
// sync with the encoder's own duration estimate again (it previously used
// raw `height`, which is exactly 2x too long for PD modes: they pack two
// image rows into every transmitted scan line/sync interval). A
// VIS-confirmed decode is therefore a known-duration event, not something
// that needs guessing at when it's over — auto-detect scanning (VIS + sync
// timing) has no business running again until that deadline passes, and once
// it does pass the decode should be considered finished regardless of how
// many lines actually landed (line-count/slant errors, dropped sync pulses,
// etc. can leave currentLine short of totalLines even on a clean signal).
// A tolerance margin absorbs modest clock drift/slant between transmitter
// and receiver without cutting off a still-legitimately-finishing image;
// decodingStart is stamped right as VIS/sync-timing detection completes
// (after the leader/header), so this intentionally excludes VIS header time
// — it only covers the scan lines.
const EXPECTED_DURATION_TOLERANCE = 1.15

export function expectedDurationMs(mode: SSTVMode): number {
  const cfg = SSTV_MODES[mode]
  return transmittedLines(mode) * cfg.scanTime * EXPECTED_DURATION_TOLERANCE
}
// Raw RMS amplitude is a poor silence proxy on a real radio: a weak/noisy
// signal (e.g. -80dBm+ HF, fading, AGC pumping) can dip under any fixed
// absolute threshold for seconds at a time while a transmission is still very
// much in progress, which was firing the silence-completion path every few
// seconds and produced a loop of mostly-black partial captures. Instead,
// compare in-band SSTV tone energy (sync/VIS/luminance/chrominance all live
// in 1100-2300Hz) against out-of-band noise energy — true silence has no tone
// energy at all, regardless of the ambient noise floor's absolute level.
// Several bins spanning the SSTV tone range, and many broadband reference
// bins spread well outside it — averaged (not maxed) on both sides so a
// single noisy bin can't swing the ratio. A lone Goertzel bin on white noise
// has too much chunk-to-chunk variance on its own to trust individually.
const SILENCE_INBAND_FREQS = [1100, 1300, 1500, 1700, 1900, 2100, 2300]
const SILENCE_NOISE_FREQS = [100, 200, 300, 500, 700, 900, 3000, 3300, 3600, 4000, 4500, 5000]
const SILENCE_SNR_THRESHOLD = 2.5 // in-band/noise-band average-magnitude ratio below this counts as silence

function average(values: number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length
}

export function isChunkSilent(samples: Float32Array, sampleRate: number): boolean {
  const inBand = SILENCE_INBAND_FREQS.map((f) => new GoertzelFilter(sampleRate, f))
  const noiseBand = SILENCE_NOISE_FREQS.map((f) => new GoertzelFilter(sampleRate, f))
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i]
    for (const f of inBand) f.processSample(s)
    for (const f of noiseBand) f.processSample(s)
  }
  const inBandPower = average(inBand.map((f) => f.getMagnitude()))
  const noisePower = Math.max(1e-6, average(noiseBand.map((f) => f.getMagnitude())))
  return inBandPower / noisePower < SILENCE_SNR_THRESHOLD
}

function makeThumbnail(data: Uint8ClampedArray, width: number, height: number): string {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')!
  const clamped = new Uint8ClampedArray(data.buffer as ArrayBuffer, data.byteOffset, data.byteLength)
  ctx.putImageData(new ImageData(clamped, width, height), 0, 0)
  return canvas.toDataURL('image/jpeg', 0.7)
}

function calculateSNRFromAnalyser(analyser: AnalyserNode | null, audioContext: AudioContext | null): number | null {
  if (!analyser || !audioContext) return null
  const bufLen = analyser.frequencyBinCount
  const data = new Uint8Array(bufLen)
  analyser.getByteFrequencyData(data)
  const nyquist = audioContext.sampleRate / 2
  const freqToBin = (f: number) => Math.floor((f / nyquist) * bufLen)

  const sum = (lo: number, hi: number) => {
    let p = 0,
      n = 0
    for (let i = freqToBin(lo); i <= freqToBin(hi); i++) {
      p += data[i] * data[i]
      n++
    }
    return n > 0 ? p / n : 1
  }

  const sig = sum(1200, 2300)
  const noise = (sum(300, 1000) + sum(2500, 4000)) / 2
  return 10 * Math.log10(Math.max(sig, 1) / Math.max(noise, 1))
}

export interface AudioProcessorParams {
  manualMode: () => SSTVMode
  autoDetect: () => boolean
  autoSlant: () => boolean
}

export function createAudioProcessor(
  params: AudioProcessorParams,
  // Where capture comes from — see ft/processor.ts's identical params for
  // the full reasoning; audioSource.ts's shape is deliberately mode-agnostic.
  getAudioSourceKind: () => AudioSourceKind = () => 'microphone',
  getAudioBridge: () => AudioBridge | IQBridge | undefined = () => undefined,
) {
  const [state, setState] = createSignal<AudioProcessorState>({
    isRecording: false,
    isSupported:
      typeof window !== 'undefined' &&
      'AudioContext' in window &&
      typeof navigator !== 'undefined' &&
      typeof navigator.mediaDevices?.getUserMedia === 'function',
    error: null,
    stats: null,
    isListeningForVIS: false,
    detectionStatus: '',
    activeMode: params.manualMode(),
    capturedImages: [],
  })

  let audioContext: AudioContext | null = null
  let analyser: AnalyserNode | null = null
  let source: AudioSourceHandle | null = null
  let decoder: SSTVDecoder | null = null
  let visDetector: VISDetector | null = null
  // Fallback for tuning in mid-transmission (VIS header already passed) —
  // runs alongside visDetector while listening, mode-agnostic, and identifies
  // the mode from the timing between sync pulses instead of the VIS code.
  // See sync-interval-detector.ts for why this works for every mode.
  let syncIntervalDetector: SyncIntervalDetector | null = null
  let processorNode: CaptureNode | null = null

  let activeMode: SSTVMode = params.manualMode()
  let isDecoding = false
  let decodingStart = 0
  let silenceMs = 0
  let lastProgressLine = 0
  let lastProgressAt = 0
  // VIS gives the mode from an explicit header code — ground truth, so the
  // decode's total length is fully known and stall/silence are irrelevant
  // (a fade or gap mid-transmission is not "done", it's just quiet for a
  // while). Sync-timing is only an inference from pulse spacing, so it keeps
  // the stall/silence safety nets as a hedge against having guessed wrong.
  let visConfirmed = false
  let capturedImages: CapturedImage[] = []

  // Call from a createEffect that depends on params.manualMode()/autoDetect()
  // — mirrors the original's "sync activeMode when manual mode changes"
  // useEffect.
  function syncManualMode() {
    if (!params.autoDetect()) {
      activeMode = params.manualMode()
      setState((prev) => ({ ...prev, activeMode: params.manualMode() }))
    }
  }

  function captureCurrentImage(sampleRate: number) {
    if (!decoder) return
    const { width, height } = decoder.getDimensions()
    const rawData = decoder.getImageData()
    const dataCopy = new Uint8ClampedArray(rawData.buffer.slice(rawData.byteOffset, rawData.byteOffset + rawData.byteLength))
    const thumbUrl = makeThumbnail(dataCopy, width, height)
    const duration = (Date.now() - decodingStart) / 1000
    const mode = activeMode
    const lastStats = state().stats
    const completeness = lastStats && lastStats.totalLines > 0 ? lastStats.currentLine / lastStats.totalLines : 0
    const signalReport = estimateSignalReport(lastStats?.snr ?? null, completeness, dataCopy, width, height)

    const img: CapturedImage = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      mode,
      width,
      height,
      data: dataCopy,
      thumbnailUrl: thumbUrl,
      captureTime: new Date(),
      duration,
      signalReport,
    }

    capturedImages = [img, ...capturedImages]
    isDecoding = false
    silenceMs = 0
    visConfirmed = false

    if (params.autoDetect()) {
      visDetector?.reset()
      syncIntervalDetector?.reset()
      setState((prev) => ({
        ...prev,
        stats: null,
        isListeningForVIS: true,
        detectionStatus: 'Listening for VIS…',
        capturedImages,
      }))
    } else {
      decoder = new SSTVDecoder(sampleRate, activeMode, params.autoSlant())
      decoder.start()
      isDecoding = true
      lastProgressLine = 0
      lastProgressAt = Date.now()
      setState((prev) => ({ ...prev, stats: null, capturedImages }))
    }
  }

  function processAudioChunk(inputData: Float32Array, sampleRate: number) {
    const chunkMs = (inputData.length / sampleRate) * 1000

    if (params.autoDetect() && !isDecoding) {
      let detectedMode: SSTVMode | null = null
      let detectedVia: 'VIS' | 'sync timing' = 'VIS'

      if (visDetector) {
        const result = visDetector.process(inputData)
        if (result.detected && result.modeName) {
          detectedMode = result.modeName as SSTVMode
          detectedVia = 'VIS'
        }
      }

      // Fallback for tuning in mid-transmission — the VIS header already
      // passed, so it'll never fire; sync-pulse timing works regardless of
      // where in the transmission we joined. Only consulted when VIS hasn't
      // already found something this same chunk (VIS is authoritative when
      // both fire — it identifies the mode directly rather than inferring it).
      if (!detectedMode && syncIntervalDetector) {
        const result = syncIntervalDetector.process(inputData)
        if (result.detected && result.modeName) {
          detectedMode = result.modeName as SSTVMode
          detectedVia = 'sync timing'
        }
      }

      if (detectedMode) {
        activeMode = detectedMode
        isDecoding = true
        decodingStart = Date.now()
        silenceMs = 0
        lastProgressLine = 0
        lastProgressAt = Date.now()
        visConfirmed = detectedVia === 'VIS'

        decoder = new SSTVDecoder(sampleRate, detectedMode, params.autoSlant())
        decoder.start()
        syncIntervalDetector?.reset()

        setState((prev) => ({
          ...prev,
          activeMode: detectedMode,
          isListeningForVIS: false,
          detectionStatus: `${detectedVia} detected: ${SSTV_MODES[detectedMode].name}`,
        }))
      }
    } else if (isDecoding && decoder) {
      decoder.processSamples(inputData)
      const stats = decoder.getStats()

      if (stats.currentLine >= stats.totalLines && stats.totalLines > 0) {
        captureCurrentImage(sampleRate)
        return
      }

      const now = Date.now()
      const madeProgress = stats.currentLine > lastProgressLine
      if (madeProgress) {
        lastProgressLine = stats.currentLine
        lastProgressAt = now
      }

      if (params.autoDetect() && now - decodingStart >= expectedDurationMs(activeMode)) {
        // The mode's full expected length (known from VIS/scanTime, not a
        // guess) has elapsed — normally the transmission is over regardless
        // of how many lines actually landed, and this is the primary way an
        // auto-detected decode ends. But a VIS-confirmed decode that is still
        // visibly advancing right at the deadline (e.g. it spent real
        // wall-clock time reconstructing missed-sync lines on a weak signal,
        // see decodeLineSpan in decoder.ts) is not actually done — only treat
        // silence/no-progress at the deadline as "finished"; a live decode
        // gets bounded extensions (via the stall timeout below) instead of
        // being cut off mid-image.
        if (!visConfirmed || now - lastProgressAt >= STALL_TIMEOUT_MS) {
          captureCurrentImage(sampleRate)
          return
        }
      }

      // Both heuristics below are guesses at "the transmission is over" from
      // indirect signs (no line progress, no tone energy) — appropriate when
      // the mode was only inferred from sync timing, but moot once VIS has
      // told us exactly how long this decode should run: a fade or a quiet
      // gap mid-image isn't "done," and cutting it off early is exactly the
      // premature-capture behavior the known-duration deadline above exists
      // to avoid. Skip them for VIS-confirmed decodes and let the deadline
      // (or the hard line-count-complete check) be the only way out.
      if (!visConfirmed) {
        if (!madeProgress && now - lastProgressAt >= STALL_TIMEOUT_MS) {
          // Backstop independent of the silence heuristic below — whatever the
          // reason (transmission ended and went undetected, a new unrelated
          // transmission started, signal dropped out), no line progress for
          // this long means we're not usefully decoding anymore.
          captureCurrentImage(sampleRate)
          return
        }

        if (isChunkSilent(inputData, sampleRate)) {
          silenceMs += chunkMs
          if (silenceMs >= SILENCE_DURATION_MS) {
            captureCurrentImage(sampleRate)
            return
          }
        } else {
          silenceMs = 0
        }
      }

      const snr = calculateSNRFromAnalyser(analyser, audioContext)
      setState((prev) => ({ ...prev, stats: { ...stats, snr } }))
    } else if (!params.autoDetect() && decoder) {
      decoder.processSamples(inputData)
      const stats = decoder.getStats()
      const snr = calculateSNRFromAnalyser(analyser, audioContext)
      setState((prev) => ({ ...prev, stats: { ...stats, snr } }))
    }
  }

  async function startRecording() {
    try {
      if (!state().isSupported) throw new Error('Web Audio API not supported in this browser')

      const kind = getAudioSourceKind()
      let handle: AudioSourceHandle
      if (kind === 'bridge') {
        const bridge = getAudioBridge()
        const bridgeSource = bridge ? acquireBridgeSource(bridge) : null
        if (!bridgeSource) throw new Error('Connect to the bridge (Listen to Radio) before selecting it as the audio source')
        handle = bridgeSource
      } else {
        handle = await acquireMicrophoneSource()
      }
      source = handle

      const ctx = handle.ctx
      audioContext = ctx

      const analyserNode = ctx.createAnalyser()
      analyserNode.fftSize = 2048
      analyser = analyserNode
      handle.node.connect(analyserNode)

      const sampleRate = ctx.sampleRate

      if (params.autoDetect()) {
        visDetector = new VISDetector(sampleRate)
        syncIntervalDetector = new SyncIntervalDetector(sampleRate)
        isDecoding = false
        setState((prev) => ({ ...prev, isListeningForVIS: true, detectionStatus: 'Listening for VIS…', activeMode }))
      } else {
        decoder = new SSTVDecoder(sampleRate, activeMode, params.autoSlant())
        decoder.start()
        isDecoding = true
      }

      const proc = await createCaptureNode(ctx, 4096, (input) => {
        processAudioChunk(input, sampleRate)
      })
      processorNode = proc
      analyserNode.connect(proc.node)

      setState((prev) => ({ ...prev, isRecording: true, error: null }))
    } catch (err) {
      const error = err instanceof Error ? err.message : 'Failed to access microphone'
      setState((prev) => ({ ...prev, error, isRecording: false }))
    }
  }

  function stopRecording() {
    if (source) {
      source.release()
      source = null
    }
    if (processorNode) {
      processorNode.disconnect()
      processorNode = null
    }
    if (analyser) {
      analyser.disconnect()
      analyser = null
    }
    audioContext = null
    if (decoder) decoder.stop()
    if (visDetector) visDetector.reset()
    if (syncIntervalDetector) syncIntervalDetector.reset()
    isDecoding = false
    setState((prev) => ({ ...prev, isRecording: false, isListeningForVIS: false, detectionStatus: '' }))
  }

  function resetDecoder() {
    if (decoder) {
      decoder.reset()
      if (state().isRecording && !params.autoDetect()) decoder.start()
    }
    setState((prev) => ({ ...prev, stats: null }))
  }

  function clearImages() {
    capturedImages = []
    setState((prev) => ({ ...prev, capturedImages: [] }))
  }

  function getImageData(): Uint8ClampedArray | null {
    return decoder ? decoder.getImageData() : null
  }

  function getDimensions() {
    if (decoder) return decoder.getDimensions()
    const cfg = SSTV_MODES[activeMode]
    return { width: cfg.width, height: cfg.height }
  }

  function getAnalyser(): AnalyserNode | null {
    return analyser
  }

  return {
    state,
    startRecording,
    stopRecording,
    resetDecoder,
    clearImages,
    getImageData,
    getDimensions,
    getAnalyser,
    syncManualMode,
  }
}

export type AudioProcessor = ReturnType<typeof createAudioProcessor>
