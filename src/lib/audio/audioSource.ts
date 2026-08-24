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
import type { IQBridge } from '$decoder-lib/cat/useIQBridge'

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
//
// Accepts EITHER the demodulated-audio bridge (useAudioBridge.ts,
// input_mode "audio") or the I/Q bridge (useIQBridge.ts, input_mode "iq",
// demodulated client-side — see that file's header comment on why I/Q is a
// superset, not a separate/incompatible mode). Both expose the identical
// getPlaybackSource(): {ctx, node} shape, so this function — and every
// decoder built on AudioSourceHandle — doesn't need to know or care which
// one is actually live.
export function acquireBridgeSource(bridge: AudioBridge | IQBridge): AudioSourceHandle | null {
  const playback = bridge.getPlaybackSource()
  if (!playback) return null
  return {
    kind: 'bridge',
    ctx: playback.ctx,
    node: playback.node,
    // Nothing to release — the bridge owns this context/node for as long as
    // "Listen to Radio" (or, for the I/Q bridge, "Start I/Q Spectrum")
    // stays on; a decoder switching away just stops reading from it.
    // Tearing it down here would kill playback/decode for anyone else
    // (e.g. the operator's own ears, or another decoder) still on the same
    // feed.
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
//
// getWsUrl: the CAT bridge's WebSocket URL, needed to auto-connect
// bridge.startMic()'s underlying /audio WebSocket if it isn't already open.
// Before this was added, selecting "ESP32 Bridge" as the TX output without
// having separately clicked "Listen to Radio" first caused a REAL,
// confirmed-on-real-hardware silent failure: startMic() requires ws to
// already be OPEN (see useAudioBridge.ts's startMic() guard) and returned
// false immediately otherwise — but that return value was never checked
// here (bridge.startMic(...) was a fire-and-forget void call), so TX
// appeared to run/log as sent in the UI while zero audio ever reached the
// bridge, with no error shown to the operator at all.
export function bridgeSink(bridge: AudioBridge, ctx: AudioContext, getWsUrl: () => string | undefined): AudioSinkHandle {
  const dest = ctx.createMediaStreamDestination()
  let started = false
  const ensureMicStarted = () => {
    if (started) return
    started = true
    // 'ft8-tx' owner tag — see MicOwner in useAudioBridge.ts. If the
    // Bridge panel's own "Send Mic to Radio" already holds the session,
    // this call is rejected rather than stealing it out from under the
    // operator; the UI (FTTransmitPanel.tsx) also disables picking this
    // sink at all while that's the case, so this is a backstop, not the
    // primary guard.
    void (async () => {
      if (!bridge.state().connected) {
        const wsUrl = getWsUrl()
        if (!wsUrl) {
          started = false // nothing to retry against — allow a later connectSource() call to try again
          return
        }
        const ok = await bridge.connect(wsUrl)
        if (!ok) {
          started = false // connect failed — allow a later call (e.g. next TX cycle) to retry
          return
        }
      }
      const ok = await bridge.startMic(dest.stream, 'ft8-tx')
      if (!ok) started = false // startMic failed (e.g. session already held elsewhere) — allow a retry later
    })()
  }
  return {
    kind: 'bridge',
    connectSource(node) {
      node.connect(dest)
      ensureMicStarted()
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
