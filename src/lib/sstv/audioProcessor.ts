// Port of src/hooks/useAudioProcessor.ts (Next.js app).
import { createSignal } from 'solid-js'
import { SSTVDecoder, type DecoderStats } from '$decoder-lib/sstv/decoder'
import { VISDetector } from '$decoder-lib/sstv/vis-detector'
import { SSTV_MODES } from '$decoder-lib/sstv/constants'
import { createCaptureNode, type CaptureNode } from '$decoder-lib/audio/captureNode'

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

const SILENCE_THRESHOLD = 0.008
const SILENCE_DURATION_MS = 2500

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

export function createAudioProcessor(params: AudioProcessorParams) {
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
  let stream: MediaStream | null = null
  let decoder: SSTVDecoder | null = null
  let visDetector: VISDetector | null = null
  let processorNode: CaptureNode | null = null

  let activeMode: SSTVMode = params.manualMode()
  let isDecoding = false
  let decodingStart = 0
  let silenceMs = 0
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

  function captureCurrentImage(sampleRate: number, nextMode?: SSTVMode) {
    if (!decoder) return
    const { width, height } = decoder.getDimensions()
    const rawData = decoder.getImageData()
    const dataCopy = new Uint8ClampedArray(rawData.buffer.slice(rawData.byteOffset, rawData.byteOffset + rawData.byteLength))
    const thumbUrl = makeThumbnail(dataCopy, width, height)
    const duration = (Date.now() - decodingStart) / 1000
    const mode = activeMode

    const img: CapturedImage = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      mode,
      width,
      height,
      data: dataCopy,
      thumbnailUrl: thumbUrl,
      captureTime: new Date(),
      duration,
    }

    capturedImages = [img, ...capturedImages]
    isDecoding = false
    silenceMs = 0

    if (nextMode) {
      activeMode = nextMode
      decoder = new SSTVDecoder(sampleRate, nextMode, params.autoSlant())
      decoder.start()
      isDecoding = true
      decodingStart = Date.now()
      visDetector?.reset()
      setState((prev) => ({
        ...prev,
        stats: null,
        activeMode: nextMode,
        isListeningForVIS: false,
        detectionStatus: `VIS detected: ${SSTV_MODES[nextMode].name}`,
        capturedImages,
      }))
    } else if (params.autoDetect()) {
      visDetector?.reset()
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
      setState((prev) => ({ ...prev, stats: null, capturedImages }))
    }
  }

  function processAudioChunk(inputData: Float32Array, sampleRate: number) {
    let rmsSum = 0
    for (let i = 0; i < inputData.length; i++) rmsSum += inputData[i] * inputData[i]
    const rms = Math.sqrt(rmsSum / inputData.length)
    const chunkMs = (inputData.length / sampleRate) * 1000

    if (params.autoDetect() && !isDecoding) {
      if (visDetector) {
        const result = visDetector.process(inputData)
        if (result.detected && result.modeName) {
          const detectedMode = result.modeName as SSTVMode
          activeMode = detectedMode
          isDecoding = true
          decodingStart = Date.now()
          silenceMs = 0

          decoder = new SSTVDecoder(sampleRate, detectedMode, params.autoSlant())
          decoder.start()

          setState((prev) => ({
            ...prev,
            activeMode: detectedMode,
            isListeningForVIS: false,
            detectionStatus: `VIS detected: ${SSTV_MODES[detectedMode].name}`,
          }))
        }
      }
    } else if (isDecoding && decoder) {
      decoder.processSamples(inputData)
      const stats = decoder.getStats()

      if (stats.currentLine >= stats.totalLines && stats.totalLines > 0) {
        captureCurrentImage(sampleRate)
        return
      }

      if (params.autoDetect() && visDetector) {
        const visResult = visDetector.process(inputData)
        if (visResult.detected && visResult.modeName) {
          captureCurrentImage(sampleRate, visResult.modeName as SSTVMode)
          return
        }
      }

      if (rms < SILENCE_THRESHOLD) {
        silenceMs += chunkMs
        if (silenceMs >= SILENCE_DURATION_MS) {
          captureCurrentImage(sampleRate)
          return
        }
      } else {
        silenceMs = 0
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

      const mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      })
      stream = mediaStream

      const ctx = new AudioContext()
      audioContext = ctx

      const source = ctx.createMediaStreamSource(mediaStream)
      const analyserNode = ctx.createAnalyser()
      analyserNode.fftSize = 2048
      analyser = analyserNode
      source.connect(analyserNode)

      const sampleRate = ctx.sampleRate

      if (params.autoDetect()) {
        visDetector = new VISDetector(sampleRate)
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
    if (stream) {
      stream.getTracks().forEach((t) => t.stop())
      stream = null
    }
    if (processorNode) {
      processorNode.disconnect()
      processorNode = null
    }
    if (analyser) {
      analyser.disconnect()
      analyser = null
    }
    if (audioContext) {
      audioContext.close()
      audioContext = null
    }
    if (decoder) decoder.stop()
    if (visDetector) visDetector.reset()
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
