// Port of src/hooks/useGlobalAudio.ts (Next.js app) — manages the single
// shared AudioContext + AnalyserNode used by whichever decoder is active.
// SolidJS signals are plain functions, so this module exports the store
// directly (no provider/context needed) — any component importing it reads
// the same live signal.

import { createSignal } from 'solid-js'

export interface GlobalAudioState {
  isRecording: boolean
  isSupported: boolean
  error: string | null
}

function createGlobalAudio() {
  const [state, setState] = createSignal<GlobalAudioState>({
    isRecording: false,
    isSupported:
      typeof window !== 'undefined' &&
      typeof window.AudioContext !== 'undefined' &&
      typeof navigator !== 'undefined' &&
      typeof navigator.mediaDevices?.getUserMedia === 'function',
    error: null,
  })

  const [analyser, setAnalyser] = createSignal<AnalyserNode | null>(null)

  let stream: MediaStream | null = null
  let audioCtx: AudioContext | null = null
  let recTap: ScriptProcessorNode | null = null

  function stop() {
    stream?.getTracks().forEach((t) => t.stop())
    stream = null

    if (recTap) {
      recTap.onaudioprocess = null
      recTap.disconnect()
      recTap = null
    }

    analyser()?.disconnect()
    setAnalyser(null)

    audioCtx?.close()
    audioCtx = null

    setState((prev) => ({ ...prev, isRecording: false, error: null }))
  }

  async function start(): Promise<AnalyserNode | null> {
    try {
      if (audioCtx) stop()

      const mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      })
      stream = mediaStream

      const ctx = new AudioContext()
      audioCtx = ctx

      const node = ctx.createAnalyser()
      node.fftSize = 4096
      node.smoothingTimeConstant = 0.75

      const source = ctx.createMediaStreamSource(mediaStream)
      source.connect(node)

      // Keep the audio graph alive with a near-silent gain node
      const silencer = ctx.createGain()
      silencer.gain.value = 0.001
      node.connect(silencer)
      silencer.connect(ctx.destination)

      // Ring-buffer tap for the retroactive "Rec" feature — not yet ported
      // (out of scope for the initial multi-mode pass); a no-op tap keeps
      // the audio graph shape identical to the Next.js version.
      const tap = ctx.createScriptProcessor(4096, 1, 1)
      source.connect(tap)
      tap.connect(ctx.destination)
      recTap = tap

      setAnalyser(node)
      setState((prev) => ({ ...prev, isRecording: true, error: null }))
      return node
    } catch (err) {
      setState((prev) => ({
        ...prev,
        isRecording: false,
        error: err instanceof Error ? err.message : 'Microphone access failed',
      }))
      return null
    }
  }

  return { state, analyser, start, stop }
}

export const globalAudio = createGlobalAudio()
