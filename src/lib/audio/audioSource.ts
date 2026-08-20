// Shared "where does decoder/TX audio come from or go to" abstraction.
// Every decoder today independently calls getUserMedia() + builds its own
// AudioContext/AnalyserNode graph (see ft/processor.ts, cw/processor.ts,
// etc.) and every TX feature independently plays into its own
// AudioContext.destination (see ft/useFTTransmit.ts). This module gives
// both directions a second option — the ESP32 CAT bridge's live radio
// audio (see useAudioBridge.ts) — behind the same shape, so a decoder can
// swap its input/output without changing how it builds its capture/replay
// graph. Only FT8 actually consumes this today; the shape is deliberately
// mode-agnostic so RTTY/SSTV/CW/MFSK can adopt it later with no changes here.
import type { AudioBridge } from '$decoder-lib/cat/useAudioBridge'

export type AudioSourceKind = 'microphone' | 'bridge'
export type AudioSinkKind = 'speaker' | 'bridge'

// What a decoder's capture graph actually needs, regardless of where the
// signal originates: a context to build nodes in, and a node to tap (via
// createCaptureNode or an AnalyserNode) for samples.
export interface AudioSourceHandle {
  kind: AudioSourceKind
  ctx: AudioContext
  node: AudioNode
  release(): void
}

const MIC_CONSTRAINTS: MediaStreamConstraints = {
  audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
}

export async function acquireMicrophoneSource(): Promise<AudioSourceHandle> {
  const stream = await navigator.mediaDevices.getUserMedia(MIC_CONSTRAINTS)
  const ctx = new AudioContext()
  const node = ctx.createMediaStreamSource(stream)
  return {
    kind: 'microphone',
    ctx,
    node,
    release() {
      stream.getTracks().forEach((t) => t.stop())
      ctx.close().catch(() => null)
    },
  }
}

// Taps the bridge's already-live incoming-radio-audio graph (see
// connect()/playFrame() in useAudioBridge.ts) rather than opening a new
// audio path — null if "Listen to Radio" isn't active, since there's
// nothing to tap yet (the caller should ask the operator to connect first
// rather than silently falling back to the mic).
export function acquireBridgeSource(bridge: AudioBridge): AudioSourceHandle | null {
  const playback = bridge.getPlaybackSource()
  if (!playback) return null
  return {
    kind: 'bridge',
    ctx: playback.ctx,
    node: playback.node,
    // Nothing to release — the bridge owns this context/node for as long as
    // "Listen to Radio" stays on; a decoder switching away just stops
    // reading from it. Tearing it down here would kill playback for anyone
    // else (e.g. the operator's own ears) still listening to the same feed.
    release() {},
  }
}

// What a TX feature's playback graph needs to send its output somewhere:
// a place for its GainNode to connect into.
export interface AudioSinkHandle {
  kind: AudioSinkKind
  connectSource(node: AudioNode): void
  release(): void
}

export function speakerSink(ctx: AudioContext): AudioSinkHandle {
  return {
    kind: 'speaker',
    connectSource(node) {
      node.connect(ctx.destination)
    },
    release() {},
  }
}

// Routes TX audio to the bridge's mic-send path without connecting nodes
// across AudioContext instances (impossible in Web Audio — every feature in
// this app owns its own AudioContext). Instead, a MediaStreamAudioDestinationNode
// lives in the TX's OWN context, producing a real MediaStream; that stream is
// handed to the bridge's startMic(), which accepts a pre-built stream instead
// of calling getUserMedia() itself. The TX code's own context/scheduling is
// untouched — this only adds a second output tap alongside (or instead of)
// ctx.destination.
export function bridgeSink(bridge: AudioBridge, ctx: AudioContext): AudioSinkHandle {
  const dest = ctx.createMediaStreamDestination()
  let started = false
  return {
    kind: 'bridge',
    connectSource(node) {
      node.connect(dest)
      if (!started) {
        started = true
        // 'ft8-tx' owner tag — see MicOwner in useAudioBridge.ts. If the
        // Bridge panel's own "Send Mic to Radio" already holds the session,
        // this call is rejected rather than stealing it out from under the
        // operator; the UI (FTTransmitPanel.tsx) also disables picking this
        // sink at all while that's the case, so this is a backstop, not the
        // primary guard.
        void bridge.startMic(dest.stream, 'ft8-tx')
      }
    },
    release() {
      // requireOwner: only stop OUR session — if the Bridge panel's manual
      // button somehow already took over ownership (shouldn't happen given
      // the UI guard, but this keeps the invariant true even so), releasing
      // the TX sink must not kill it.
      if (started) bridge.stopMic('ft8-tx')
    },
  }
}
