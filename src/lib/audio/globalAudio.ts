// Port of src/hooks/useGlobalAudio.ts (Next.js app) — manages the single
// shared AudioContext + AnalyserNode used by whichever decoder is active.
// SolidJS signals are plain functions, so this module exports the store
// directly (no provider/context needed) — any component importing it reads
// the same live signal.

import { createSignal } from 'solid-js'
import { audioRecorder } from '$decoder-lib/audio/ringRecorder'
import { createCaptureNode, type CaptureNode } from '$decoder-lib/audio/captureNode'
import { acquireMicrophoneSource, acquireBridgeSource, type AudioSourceKind, type AudioSourceHandle } from '$decoder-lib/audio/audioSource'
import type { AudioBridge } from '$decoder-lib/cat/useAudioBridge'
import type { IQBridge } from '$decoder-lib/cat/useIQBridge'

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

  // Set by App.tsx once the bridge is lifted — lets "Start Decoding"
  // source from the ESP32 bridge's live radio audio instead of always
  // prompting for a local mic. This mirrors the per-decoder audioSourceKind
  // selector (see ft/processor.ts), but at the app-wide level: globalAudio
  // gates EVERY mode's "Start Decoding" (see App.tsx's handleStart()), so
  // without this, selecting "ESP32 Bridge" in a decoder's own dropdown was
  // never enough — globalAudio.start() ran first and always grabbed the
  // mic regardless, which is exactly the bug this fixes.
  let sourceKind: AudioSourceKind = 'microphone'
  let bridge: AudioBridge | IQBridge | undefined

  function configureSource(kind: AudioSourceKind, bridgeInstance: AudioBridge | IQBridge | undefined) {
    sourceKind = kind
    bridge = bridgeInstance
  }

  let source: AudioSourceHandle | null = null
  let recTap: CaptureNode | null = null

  function stop() {
    if (recTap) {
      recTap.disconnect()
      recTap = null
    }

    analyser()?.disconnect()
    setAnalyser(null)

    // release() is a no-op for a bridge source (the bridge owns its own
    // AudioContext lifecycle — see acquireBridgeSource()'s comment) and a
    // real teardown (stop mic tracks, close the context) for a microphone
    // source. Either way, this is the only call needed; there's nothing
    // left for this module to close/stop directly.
    source?.release()
    source = null

    setState((prev) => ({ ...prev, isRecording: false, error: null }))
  }

  async function start(): Promise<AnalyserNode | null> {
    try {
      if (source) stop()

      let handle: AudioSourceHandle
      if (sourceKind === 'bridge') {
        const bridgeSource = bridge ? acquireBridgeSource(bridge) : null
        if (!bridgeSource) throw new Error('Connect to the bridge (Listen to Radio) before selecting it as the audio source')
        handle = bridgeSource
      } else {
        handle = await acquireMicrophoneSource()
      }
      source = handle
      const ctx = handle.ctx

      const node = ctx.createAnalyser()
      node.fftSize = 4096
      node.smoothingTimeConstant = 0.75
      handle.node.connect(node)

      // Keep the audio graph alive with a near-silent gain node. A
      // microphone AudioContext has no other path to destination at all.
      // useAudioBridge.ts's ("Listen to Radio") context already has one
      // via its own playback graph, so this is redundant there — but
      // useIQBridge.ts's context deliberately has NO destination
      // connection (see that file's comment: opening the I/Q spectrum
      // view shouldn't start playing audio out loud), so without this it
      // would have no real path to destination either and could be
      // throttled/suspended by a browser's autoplay/power-saving policy.
      // Always attaching this is simplest and harmless for the
      // already-audible bridge case too.
      {
        const silencer = ctx.createGain()
        silencer.gain.value = 0.001
        node.connect(silencer)
        silencer.connect(ctx.destination)
      }

      // Ring-buffer tap for the retroactive "Rec" feature — continuously
      // feeds the last N seconds of input audio to audioRecorder so it can
      // be saved as a WAV after the fact. AudioWorkletNode's capture runs on
      // the audio thread, not the main thread — this isn't subject to the
      // main-thread jank ScriptProcessorNode's onaudioprocess was.
      const tap = await createCaptureNode(ctx, 4096, (samples) => {
        audioRecorder.write('input', samples, ctx.sampleRate)
      })
      node.connect(tap.node)
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

  return { state, analyser, start, stop, configureSource }
}

export const globalAudio = createGlobalAudio()
