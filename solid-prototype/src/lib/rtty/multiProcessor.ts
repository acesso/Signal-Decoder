// Port of src/hooks/useMultiRTTYProcessor.ts (Next.js app) — manages its own
// AudioContext/analyser independent of globalAudio.ts (used only for the
// spectrogram display), decodes audio through one RTTYDecoder instance per
// session, and reports SNR/status derived from the active session's band.
//
// Preserved as-is from the original even though running two separate
// getUserMedia()+AudioContext pairs (this one, plus globalAudio's) at once is
// a pre-existing quirk of the React app, not something to fix in this port.

import { createSignal } from 'solid-js'
import { RTTYDecoder as RTTYCoreDecoder, type RTTYConfig } from '$decoder-lib/rtty/decoder'

export interface ProcessorState {
  isRecording: boolean
  status: 'idle' | 'syncing' | 'receiving' | 'error'
  snr: number | null
  signalStrength: number
  errorMessage: string | null
}

export function createMultiRTTYProcessor(onText: (sessionId: string, chars: string) => void) {
  const [state, setState] = createSignal<ProcessorState>({
    isRecording: false,
    status: 'idle',
    snr: null,
    signalStrength: 0,
    errorMessage: null,
  })

  let audioContext: AudioContext | null = null
  let stream: MediaStream | null = null
  let source: MediaStreamAudioSourceNode | null = null
  let processor: ScriptProcessorNode | null = null
  let analyser: AnalyserNode | null = null
  let snrInterval: ReturnType<typeof setInterval> | null = null

  const decoders = new Map<string, RTTYCoreDecoder>()
  const configs = new Map<string, RTTYConfig>()
  let activeId = ''

  function getAnalyser() {
    return analyser
  }

  function addSession(id: string, config: RTTYConfig) {
    configs.set(id, { ...config })
    if (audioContext) {
      decoders.set(id, new RTTYCoreDecoder(audioContext.sampleRate, config))
    }
  }

  function removeSession(id: string) {
    configs.delete(id)
    decoders.delete(id)
  }

  function updateSessionConfig(id: string, config: RTTYConfig) {
    configs.set(id, { ...config })
    decoders.get(id)?.updateConfig(config)
  }

  function resetSession(id: string) {
    decoders.get(id)?.reset()
  }

  function setActiveSession(id: string) {
    activeId = id
  }

  function computeSNR() {
    if (!analyser || !audioContext) return

    const buf = new Uint8Array(analyser.frequencyBinCount)
    analyser.getByteFrequencyData(buf)

    const nyquist = audioContext.sampleRate / 2
    const hzPerBin = nyquist / analyser.frequencyBinCount

    const cfg = configs.get(activeId)
    if (!cfg) return

    const halfShift = cfg.carrierShift / 2
    const markF = cfg.reverseShift ? cfg.centerFreq + halfShift : cfg.centerFreq - halfShift
    const spaceF = cfg.reverseShift ? cfg.centerFreq - halfShift : cfg.centerFreq + halfShift
    const bw = cfg.baudRate

    const bandEnergy = (lo: number, hi: number): number => {
      const b0 = Math.max(0, Math.round(lo / hzPerBin))
      const b1 = Math.min(buf.length - 1, Math.round(hi / hzPerBin))
      if (b1 <= b0) return 0
      let sum = 0
      for (let k = b0; k <= b1; k++) sum += buf[k]
      return sum / (b1 - b0 + 1)
    }

    const signalE = Math.max(bandEnergy(markF - bw, markF + bw), bandEnergy(spaceF - bw, spaceF + bw))
    const noiseE =
      (bandEnergy(Math.max(0, spaceF - bw * 5), Math.max(0, spaceF - bw * 2)) +
        bandEnergy(markF + bw * 2, markF + bw * 5)) /
      2

    const strength = signalE / 255
    const snr = noiseE > 1 ? 20 * Math.log10(signalE / noiseE) : null

    setState((prev) => ({
      ...prev,
      snr,
      signalStrength: strength,
      status: strength > 0.15 ? 'receiving' : 'syncing',
    }))
  }

  async function startRecording() {
    try {
      const mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      })
      stream = mediaStream

      const ctx = new AudioContext()
      audioContext = ctx
      const sampleRate = ctx.sampleRate

      decoders.clear()
      configs.forEach((config, id) => {
        decoders.set(id, new RTTYCoreDecoder(sampleRate, config))
      })

      const analyserNode = ctx.createAnalyser()
      analyserNode.fftSize = 2048
      analyserNode.smoothingTimeConstant = 0.75
      analyser = analyserNode

      const sourceNode = ctx.createMediaStreamSource(mediaStream)
      source = sourceNode

      const processorNode = ctx.createScriptProcessor(4096, 1, 1)
      processor = processorNode

      processorNode.onaudioprocess = (e) => {
        const input = e.inputBuffer.getChannelData(0)
        decoders.forEach((decoder, id) => {
          const text = decoder.processSamples(input)
          if (text) onText(id, text)
        })
      }

      sourceNode.connect(analyserNode)
      sourceNode.connect(processorNode)
      processorNode.connect(ctx.destination)

      snrInterval = setInterval(computeSNR, 200)
      setState((prev) => ({ ...prev, isRecording: true, errorMessage: null, status: 'syncing' }))
    } catch (err) {
      setState((prev) => ({
        ...prev,
        isRecording: false,
        status: 'error',
        errorMessage: err instanceof Error ? err.message : 'Microphone access failed',
      }))
    }
  }

  function stopRecording() {
    if (snrInterval) {
      clearInterval(snrInterval)
      snrInterval = null
    }
    processor?.disconnect()
    source?.disconnect()
    analyser?.disconnect()
    stream?.getTracks().forEach((t) => t.stop())
    audioContext?.close()

    processor = null
    source = null
    analyser = null
    stream = null
    audioContext = null

    decoders.forEach((d) => d.reset())
    setState((prev) => ({ ...prev, isRecording: false, status: 'idle', snr: null, signalStrength: 0 }))
  }

  function destroy() {
    if (snrInterval) clearInterval(snrInterval)
    processor?.disconnect()
    source?.disconnect()
    analyser?.disconnect()
    stream?.getTracks().forEach((t) => t.stop())
    audioContext?.close()
  }

  return {
    state,
    startRecording,
    stopRecording,
    addSession,
    removeSession,
    updateSessionConfig,
    resetSession,
    setActiveSession,
    getAnalyser,
    destroy,
  }
}

export type MultiRTTYProcessor = ReturnType<typeof createMultiRTTYProcessor>
