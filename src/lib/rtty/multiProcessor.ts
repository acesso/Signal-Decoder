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
import { createCaptureNode, type CaptureNode } from '$decoder-lib/audio/captureNode'
import { acquireMicrophoneSource, acquireBridgeSourceWithRetry, type AudioSourceKind, type AudioSourceHandle } from '$decoder-lib/audio/audioSource'
import type { AudioBridge } from '$decoder-lib/cat/useAudioBridge'
import type { IQBridge } from '$decoder-lib/cat/useIQBridge'

export interface ProcessorState {
  isRecording: boolean
  status: 'idle' | 'syncing' | 'receiving' | 'error'
  snr: number | null
  signalStrength: number
  errorMessage: string | null
}

/** Should this session's decoder be gated, given its band energy?
 *
 *  Pure and exported so the per-session gate decision is testable without a
 *  live AudioContext/AnalyserNode. `sql` is 0-100 (0 = open); `signalEnergy`
 *  is an average FFT magnitude on the 0-255 byte scale, as bandEnergy()
 *  returns for this session's own mark/space bands. */
export function shouldGate(sql: number, signalEnergy: number): boolean {
  if (sql <= 0) return false
  return signalEnergy < (sql / 100) * 255
}

export function createMultiRTTYProcessor(
  onText: (sessionId: string, chars: string) => void,
  // Squelch is PER-SESSION (config.squelch, 0-100, 0 = open — matching
  // cw/processor.ts's convention), not a single shared level: sessions are
  // routinely tuned to different signals at very different strengths, so one
  // threshold that suits a loud local station would mute a weak DX one in
  // the next card. Each session is gated against its OWN mark/space band.
  // This callback is now only a fallback for a session whose config predates
  // the field.
  getSquelch: () => number = () => 0,
  // Where capture comes from — see ft/processor.ts's identical params for
  // the full reasoning; audioSource.ts's shape is deliberately mode-agnostic.
  getAudioSourceKind: () => AudioSourceKind = () => 'microphone',
  getAudioBridge: () => AudioBridge | IQBridge | undefined = () => undefined,
) {
  const [state, setState] = createSignal<ProcessorState>({
    isRecording: false,
    status: 'idle',
    snr: null,
    signalStrength: 0,
    errorMessage: null,
  })

  let audioContext: AudioContext | null = null
  let source: AudioSourceHandle | null = null
  let processor: CaptureNode | null = null
  let analyser: AnalyserNode | null = null
  let snrInterval: ReturnType<typeof setInterval> | null = null
  let fftBuf: Uint8Array<ArrayBuffer> | null = null
  // Bumped by stopRecording() — see ft/processor.ts's identical field for
  // why (aborts a startRecording() call mid-retry for a forced bridge
  // source once it's been superseded).
  let startGeneration = 0

  const decoders = new Map<string, RTTYCoreDecoder>()
  const configs = new Map<string, RTTYConfig>()
  let activeId = ''

  // Average FFT magnitude (0-255 scale) across [lo, hi] Hz — shared by SNR
  // and squelch so both agree on what "signal energy" means for a band.
  function bandEnergy(buf: Uint8Array, hzPerBin: number, lo: number, hi: number): number {
    const b0 = Math.max(0, Math.round(lo / hzPerBin))
    const b1 = Math.min(buf.length - 1, Math.round(hi / hzPerBin))
    if (b1 <= b0) return 0
    let sum = 0
    for (let k = b0; k <= b1; k++) sum += buf[k]
    return sum / (b1 - b0 + 1)
  }

  // A session's own threshold, falling back to the legacy shared one for a
  // config that predates the field (0 = open either way).
  function squelchFor(cfg: RTTYConfig): number {
    return cfg.squelch ?? getSquelch()
  }

  // Per-chunk squelch gate — same cadence as decoding (unlike computeSNR's
  // 200ms interval, which is too coarse relative to a symbol period at RTTY
  // baud rates). Mirrors cw/processor.ts's binary gate (Infinity/0 there,
  // closed/open here), but thresholded PER SESSION from one shared FFT read:
  // the read is the expensive part and every session measures its own band
  // out of the same buffer, so per-session thresholds cost nothing extra.
  function applySquelch() {
    // Nothing gated at all — skip the FFT read entirely, which is the common
    // case when no session has set a threshold.
    let anyGated = false
    for (const cfg of configs.values()) {
      if (squelchFor(cfg) > 0) { anyGated = true; break }
    }
    if (!anyGated) {
      decoders.forEach((d) => d.setSquelch(false))
      return
    }
    if (!analyser || !audioContext) return
    const binCount = analyser.frequencyBinCount
    if (!fftBuf || fftBuf.length !== binCount) fftBuf = new Uint8Array(binCount) as Uint8Array<ArrayBuffer>
    analyser.getByteFrequencyData(fftBuf)
    const nyquist = audioContext.sampleRate / 2
    const hzPerBin = nyquist / binCount

    decoders.forEach((decoder, id) => {
      const cfg = configs.get(id)
      if (!cfg) return
      const sql = squelchFor(cfg)
      // An open session stays open regardless of what its neighbours are
      // gating at.
      if (sql === 0) { decoder.setSquelch(false); return }
      const halfShift = cfg.carrierShift / 2
      const markF = cfg.reverseShift ? cfg.centerFreq + halfShift : cfg.centerFreq - halfShift
      const spaceF = cfg.reverseShift ? cfg.centerFreq - halfShift : cfg.centerFreq + halfShift
      const bw = cfg.baudRate
      const signalE = Math.max(
        bandEnergy(fftBuf!, hzPerBin, markF - bw, markF + bw),
        bandEnergy(fftBuf!, hzPerBin, spaceF - bw, spaceF + bw),
      )
      decoder.setSquelch(shouldGate(sql, signalE))
    })
  }

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

    const signalE = Math.max(bandEnergy(buf, hzPerBin, markF - bw, markF + bw), bandEnergy(buf, hzPerBin, spaceF - bw, spaceF + bw))
    const noiseE =
      (bandEnergy(buf, hzPerBin, Math.max(0, spaceF - bw * 5), Math.max(0, spaceF - bw * 2)) +
        bandEnergy(buf, hzPerBin, markF + bw * 2, markF + bw * 5)) /
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
    const myGeneration = ++startGeneration
    try {
      const kind = getAudioSourceKind()
      let handle: AudioSourceHandle
      if (kind === 'bridge') {
        const bridge = getAudioBridge()
        if (!bridge) throw new Error('No bridge is configured for this decoder')
        // Retries instead of failing immediately — see
        // acquireBridgeSourceWithRetry()'s own comment.
        setState((prev) => ({ ...prev, isRecording: true, errorMessage: null }))
        const bridgeSource = await acquireBridgeSourceWithRetry(bridge, () => startGeneration !== myGeneration)
        if (!bridgeSource) return // superseded/stopped while waiting
        handle = bridgeSource
      } else {
        handle = await acquireMicrophoneSource()
      }
      source = handle

      const ctx = handle.ctx
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

      const proc = await createCaptureNode(ctx, 4096, (input) => {
        applySquelch()
        decoders.forEach((decoder, id) => {
          const text = decoder.processSamples(input)
          if (text) onText(id, text)
        })
      })
      processor = proc

      handle.node.connect(analyserNode)
      handle.node.connect(proc.node)

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
    startGeneration++ // aborts any in-flight bridge-retry wait — see its own comment
    if (snrInterval) {
      clearInterval(snrInterval)
      snrInterval = null
    }
    processor?.disconnect()
    analyser?.disconnect()
    // source's own context is the SOURCE's, not necessarily ours (bridge
    // mode: the bridge's shared playCtx) — release() (not a raw ctx.close())
    // is what correctly distinguishes "tear this down" from "just stop
    // reading from it," matching ft/processor.ts's identical reasoning.
    source?.release()

    processor = null
    source = null
    analyser = null
    audioContext = null

    decoders.forEach((d) => d.reset())
    setState((prev) => ({ ...prev, isRecording: false, status: 'idle', snr: null, signalStrength: 0 }))
  }

  function destroy() {
    if (snrInterval) clearInterval(snrInterval)
    processor?.disconnect()
    analyser?.disconnect()
    source?.release()
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
