// Port of src/hooks/useCWProcessor.ts (Next.js app).
//
// Squelch is applied per-buffer in processAudioChunk via FFT, not via a fixed
// amplitude threshold — this ensures the visual squelch line on the canvas
// directly gates the decoder.
//
// squelch: 0-100 (0 = open, 100 = completely closed). Internally maps to
// 0-0.05 on a square curve so the low end is sensitive and the high end only
// passes strong signals.
import { createSignal } from 'solid-js'
import { CWDecoder, type CWStats } from '$decoder-lib/cw/decoder'
import { createCaptureNode, type CaptureNode } from '$decoder-lib/audio/captureNode'
import { acquireMicrophoneSource, acquireBridgeSource, type AudioSourceKind, type AudioSourceHandle } from '$decoder-lib/audio/audioSource'
import type { AudioBridge } from '$decoder-lib/cat/useAudioBridge'
import type { IQBridge } from '$decoder-lib/cat/useIQBridge'

export interface TextToken {
  text: string
  channel: 0 | 1
}

export interface CWProcessorState {
  isRecording: boolean
  isSupported: boolean
  error: string | null
  stats: CWStats | null
  stats2: CWStats | null
  tokens: TextToken[]
}

export interface CWProcessorParams {
  toneFreq: () => number
  squelch: () => number
  adaptiveDitLength: () => boolean
  dualMode: () => boolean
  toneFreq2: () => number
  wpm: () => number
  filterQ: () => number
}

export function createCWProcessor(
  params: CWProcessorParams,
  // Where capture comes from — see ft/processor.ts's identical params for
  // the full reasoning; audioSource.ts's shape is deliberately mode-agnostic.
  getAudioSourceKind: () => AudioSourceKind = () => 'microphone',
  getAudioBridge: () => AudioBridge | IQBridge | undefined = () => undefined,
) {
  const [state, setState] = createSignal<CWProcessorState>({
    isRecording: false,
    isSupported:
      typeof window !== 'undefined' &&
      'AudioContext' in window &&
      typeof navigator !== 'undefined' &&
      !!navigator.mediaDevices?.getUserMedia,
    error: null,
    stats: null,
    stats2: null,
    tokens: [],
  })

  let audioContext: AudioContext | null = null
  let analyser: AnalyserNode | null = null
  let source: AudioSourceHandle | null = null
  let decoder: CWDecoder | null = null
  let decoder2: CWDecoder | null = null
  let processorNode: CaptureNode | null = null

  let fftBuf: Uint8Array<ArrayBuffer> | null = null
  let tokens: TextToken[] = []

  let onElement: ((type: 'dot' | 'dash') => void) | null = null
  let onChar: ((char: string, symbol: string) => void) | null = null
  let onElement2: ((type: 'dot' | 'dash') => void) | null = null
  let onChar2: ((char: string, symbol: string) => void) | null = null

  function setOnChar(fn: ((char: string, symbol: string) => void) | null) {
    onChar = fn
  }
  function setOnChar2(fn: ((char: string, symbol: string) => void) | null) {
    onChar2 = fn
  }
  function setOnElement(fn: ((type: 'dot' | 'dash') => void) | null) {
    onElement = fn
  }
  function setOnElement2(fn: ((type: 'dot' | 'dash') => void) | null) {
    onElement2 = fn
  }

  // ── Sync params to live decoders — call this from a createEffect in the
  // component so it re-runs whenever any of the params() signals change.
  function syncParams() {
    decoder?.setToneFreq(params.toneFreq())
    const sql = params.squelch()
    if (sql === 0) {
      decoder?.setSquelch(0)
      decoder2?.setSquelch(0)
    }
    decoder?.setAdaptiveDitLength(params.adaptiveDitLength())
    decoder2?.setAdaptiveDitLength(params.adaptiveDitLength())
    if (!params.adaptiveDitLength()) {
      decoder?.setWpm(params.wpm())
      decoder2?.setWpm(params.wpm())
    }
    decoder?.setFilterQ(params.filterQ())
    decoder2?.setFilterQ(params.filterQ())
    decoder2?.setToneFreq(params.toneFreq2())

    const dual = params.dualMode()
    if (dual && !decoder2 && audioContext) {
      const sampleRate = audioContext.sampleRate
      const d2 = new CWDecoder(sampleRate, params.toneFreq2(), params.wpm(), params.filterQ())
      d2.setAdaptiveDitLength(params.adaptiveDitLength())
      d2.onText = (chars) => {
        tokens = [...tokens, { text: chars, channel: 1 }]
      }
      d2.onElement = (type) => onElement2?.(type)
      d2.onCharDecoded = (char, sym) => onChar2?.(char, sym)
      decoder2 = d2
    } else if (!dual) {
      decoder2 = null
    }
  }

  function processAudioChunk(input: Float32Array) {
    if (!decoder) return

    const sql = params.squelch()
    if (sql > 0 && analyser) {
      const binCount = analyser.frequencyBinCount
      if (!fftBuf || fftBuf.length !== binCount) {
        fftBuf = new Uint8Array(binCount) as Uint8Array<ArrayBuffer>
      }
      analyser.getByteFrequencyData(fftBuf)
      const nq = analyser.context.sampleRate / 2
      const thr = sql / 100

      const bin1 = Math.min(Math.round((params.toneFreq() / nq) * binCount), binCount - 1)
      decoder.setSquelch(fftBuf[bin1] / 255 < thr ? Infinity : 0)

      if (decoder2) {
        const bin2 = Math.min(Math.round((params.toneFreq2() / nq) * binCount), binCount - 1)
        decoder2.setSquelch(fftBuf[bin2] / 255 < thr ? Infinity : 0)
      }
    }

    const stats = decoder.processSamples(input)
    const stats2 = decoder2?.processSamples(input) ?? null
    setState((prev) => ({ ...prev, stats, stats2, tokens }))
  }

  async function startRecording() {
    try {
      if (!state().isSupported) throw new Error('Web Audio API not supported')

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
      tokens = []

      const d1 = new CWDecoder(sampleRate, params.toneFreq(), params.wpm(), params.filterQ())
      d1.setAdaptiveDitLength(params.adaptiveDitLength())
      d1.onText = (chars) => {
        tokens = [...tokens, { text: chars, channel: 0 }]
      }
      d1.onElement = (type) => onElement?.(type)
      d1.onCharDecoded = (char, sym) => onChar?.(char, sym)
      decoder = d1

      if (params.dualMode()) {
        const d2 = new CWDecoder(sampleRate, params.toneFreq2(), params.wpm(), params.filterQ())
        d2.setAdaptiveDitLength(params.adaptiveDitLength())
        d2.onText = (chars) => {
          tokens = [...tokens, { text: chars, channel: 1 }]
        }
        d2.onElement = (type) => onElement2?.(type)
        d2.onCharDecoded = (char, sym) => onChar2?.(char, sym)
        decoder2 = d2
      }

      const proc = await createCaptureNode(ctx, 4096, processAudioChunk)
      processorNode = proc
      analyserNode.connect(proc.node)

      setState((prev) => ({ ...prev, isRecording: true, error: null, tokens: [] }))
    } catch (err) {
      setState((prev) => ({
        ...prev,
        error: err instanceof Error ? err.message : 'Failed to access microphone',
        isRecording: false,
      }))
    }
  }

  function stopRecording() {
    source?.release()
    source = null
    if (processorNode) {
      processorNode.disconnect()
      processorNode = null
    }
    if (analyser) {
      analyser.disconnect()
      analyser = null
    }
    audioContext = null
    decoder = null
    decoder2 = null
    setState((prev) => ({ ...prev, isRecording: false }))
  }

  function clearText() {
    tokens = []
    setState((prev) => ({ ...prev, tokens: [] }))
  }

  function resetDecoder() {
    decoder?.reset()
    decoder2?.reset()
    tokens = []
    setState((prev) => ({ ...prev, stats: null, stats2: null, tokens: [] }))
  }

  function getAnalyser(): AnalyserNode | null {
    return analyser
  }

  return {
    state,
    startRecording,
    stopRecording,
    clearText,
    resetDecoder,
    getAnalyser,
    syncParams,
    setOnChar,
    setOnChar2,
    setOnElement,
    setOnElement2,
  }
}

export type CWProcessor = ReturnType<typeof createCWProcessor>
