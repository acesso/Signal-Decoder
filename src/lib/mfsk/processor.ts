// Port of src/hooks/useMFSKProcessor.ts (Next.js app).
import { createSignal } from 'solid-js'
import {
  MFSKDecoder,
  type MFSKChannel,
  type MFSKSymbol,
  type MFSKWord,
  type MFSKDecoderOptions,
} from '$decoder-lib/mfsk/decoder'
import { createCaptureNode, type CaptureNode } from '$decoder-lib/audio/captureNode'
import { acquireMicrophoneSource, acquireBridgeSource, type AudioSourceKind, type AudioSourceHandle } from '$decoder-lib/audio/audioSource'
import type { AudioBridge } from '$decoder-lib/cat/useAudioBridge'
import type { IQBridge } from '$decoder-lib/cat/useIQBridge'

export type { MFSKSymbol, MFSKWord }

export interface MFSKProcessorState {
  isRecording: boolean
  isSupported: boolean
  error: string | null
  totalSymbols: number
  clearId: number // increments every time the symbol buffer is wiped
}

export interface MFSKProcessorParams {
  channels: () => MFSKChannel[]
  baudRate: () => number
  squelch: () => number
  decoderOptions: () => Partial<MFSKDecoderOptions>
}

const MAX_HISTORY = 2048

export function createMFSKProcessor(
  params: MFSKProcessorParams,
  // Where capture comes from — see ft/processor.ts's identical params for
  // the full reasoning; audioSource.ts's shape is deliberately mode-agnostic.
  getAudioSourceKind: () => AudioSourceKind = () => 'microphone',
  getAudioBridge: () => AudioBridge | IQBridge | undefined = () => undefined,
) {
  const [state, setState] = createSignal<MFSKProcessorState>({
    isRecording: false,
    isSupported:
      typeof window !== 'undefined' &&
      'AudioContext' in window &&
      typeof navigator !== 'undefined' &&
      !!navigator.mediaDevices?.getUserMedia,
    error: null,
    totalSymbols: 0,
    clearId: 0,
  })

  let clearIdCounter = 0

  let audioContext: AudioContext | null = null
  let analyser: AnalyserNode | null = null
  let source: AudioSourceHandle | null = null
  let decoder: MFSKDecoder | null = null
  let processorNode: CaptureNode | null = null
  let fftBuf: Uint8Array<ArrayBuffer> | null = null

  let symbols: MFSKSymbol[] = []
  let words: MFSKWord[] = []
  let symCount = 0

  // ── Param sync ────────────────────────────────────────────────────────────

  // Wipe accumulated symbols and notify the component via clearId bump.
  // Called whenever a parameter change makes old symbols invalid.
  function flushSymbols() {
    symbols = []
    words = []
    symCount = 0
    decoder?.reset()
    clearIdCounter++
    setState((prev) => ({ ...prev, totalSymbols: 0, clearId: clearIdCounter }))
  }

  // ── Sync params to the live decoder — call this from a createEffect in the
  // component so it re-runs whenever any of the params() signals change.
  // Mirrors the four separate useEffects in the original hook (one per
  // param), collapsed into a single function the caller drives.
  let prevChannels: MFSKChannel[] | null = null
  let prevBaudRate: number | null = null
  let prevDecoderOptions: Partial<MFSKDecoderOptions> | null = null
  function syncParams() {
    const channels = params.channels()
    if (decoder && prevChannels !== channels) {
      decoder.updateChannels(channels)
      flushSymbols()
    }
    prevChannels = channels

    const baudRate = params.baudRate()
    if (decoder && prevBaudRate !== null && prevBaudRate !== baudRate) {
      decoder.updateBaudRate(baudRate)
      flushSymbols()
    }
    prevBaudRate = baudRate

    const squelch = params.squelch()
    if (squelch === 0) decoder?.setSquelch(0)

    const decoderOptions = params.decoderOptions()
    if (decoder && prevDecoderOptions !== decoderOptions) {
      decoder.updateOptions(decoderOptions)
      flushSymbols()
    }
    prevDecoderOptions = decoderOptions
  }

  // ── Audio processing ──────────────────────────────────────────────────────

  function processAudioChunk(input: Float32Array) {
    if (!decoder) return

    const sql = params.squelch()
    const channels = params.channels()
    if (sql > 0 && analyser && channels.length > 0) {
      const binCount = analyser.frequencyBinCount
      if (!fftBuf || fftBuf.length !== binCount) {
        fftBuf = new Uint8Array(binCount) as Uint8Array<ArrayBuffer>
      }
      analyser.getByteFrequencyData(fftBuf)
      const nq = analyser.context.sampleRate / 2
      const thr = sql / 100

      const maxPow = channels.reduce((mx, ch) => {
        const bin = Math.min(Math.round((ch.freq / nq) * binCount), binCount - 1)
        return Math.max(mx, (fftBuf![bin] ?? 0) / 255)
      }, 0)

      decoder.setSquelch(maxPow < thr ? thr : 0)
    }

    decoder.processSamples(input)
  }

  // ── Start / Stop ──────────────────────────────────────────────────────────

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
      analyserNode.fftSize = 4096
      analyser = analyserNode
      handle.node.connect(analyserNode)

      symbols = []
      words = []
      symCount = 0

      const d = new MFSKDecoder(ctx.sampleRate, params.channels(), params.baudRate(), params.decoderOptions())

      d.onSymbol = (sym) => {
        symbols = symbols.length >= MAX_HISTORY ? [...symbols.slice(1), sym] : [...symbols, sym]
        symCount++
        if (symCount % 8 === 0) {
          setState((prev) => ({ ...prev, totalSymbols: symCount }))
        }
      }

      d.onWord = (word) => {
        words = words.length >= MAX_HISTORY ? [...words.slice(1), word] : [...words, word]
      }

      decoder = d

      const proc = await createCaptureNode(ctx, 4096, processAudioChunk)
      processorNode = proc
      analyserNode.connect(proc.node)

      setState((prev) => ({ ...prev, isRecording: true, error: null, totalSymbols: 0 }))
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
    setState((prev) => ({ ...prev, isRecording: false }))
  }

  function clearSymbols() {
    symbols = []
    words = []
    symCount = 0
    decoder?.reset()
    clearIdCounter++
    setState((prev) => ({ ...prev, totalSymbols: 0, clearId: clearIdCounter }))
  }

  function getAnalyser(): AnalyserNode | null {
    return analyser
  }
  function getSymbols(): MFSKSymbol[] {
    return symbols
  }
  function getWords(): MFSKWord[] {
    return words
  }
  function getSymbolCount(): number {
    return symCount
  }

  return {
    state,
    startRecording,
    stopRecording,
    clearSymbols,
    getAnalyser,
    getSymbols,
    getWords,
    getSymbolCount,
    syncParams,
  }
}

export type MFSKProcessor = ReturnType<typeof createMFSKProcessor>
