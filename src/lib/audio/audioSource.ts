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

// A former bridgeSink() lived here, streaming TX audio live over the
// bridge's mic-send /audio WebSocket, chunk by chunk in real time —
// confirmed on real hardware to be "noisy, cutting and full of unwanted
// artifacts" (any single WiFi-jitter-delayed chunk glitches the audio at
// that exact instant, with no buffering margin on either end to absorb
// it). Replaced (2026-08-25) by upload-once-play-remotely: the whole
// encoded message uploads to the ESP32's own PSRAM as soon as it's ready,
// then the browser just triggers playback and polls for completion — see
// useFTTransmit.ts's uploadIfBridgeSink()/playBridgeSlotAndWait() and the
// firmware's /tx-audio, /tx-play, /tx-status, /tx-stop endpoints. The
// 'bridge' AudioSinkKind no longer routes through an AudioSinkHandle at
// all; FTTransmitPanel.tsx's sink selector still offers it as a choice, but
// createFTTransmit() branches on it directly rather than going through
// this module's connectSource()/release() shape, since there's no local
// Web Audio graph involved on that path anymore.
