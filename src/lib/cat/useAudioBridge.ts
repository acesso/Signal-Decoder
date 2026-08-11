// Bidirectional audio bridge to the ESP32 CAT bridge's onboard ES8388 codec
// (see firmware/esp32-cat-bridge/main/audio_ws.h) — NOT real WebRTC: there's
// no mature, maintained WebRTC library for bare ESP-IDF, so this rides a
// second WebSocket (/audio, alongside /cat) carrying raw 16-bit signed PCM,
// mono, 8kHz, in both directions:
//   bridge -> browser: radio speaker audio (ES8388 ADC)
//   browser -> bridge: this browser's mic, resampled to 8kHz (ES8388 DAC ->
//                       radio mic input)
// Gated on the bridge's GET /info reporting the "audio" feature — see
// hasFeature('audio') in RadioCATPanel.tsx's BridgeStatusPanel.
import { createSignal, onCleanup } from 'solid-js'
import { createCaptureNode, type CaptureNode } from '$decoder-lib/audio/captureNode'

const BRIDGE_AUDIO_SAMPLE_RATE = 8000 // must match ES8388_SAMPLE_RATE_HZ in bridge_config.h

// ws://host/cat -> ws://host/audio — same host/port, different path, same
// transform philosophy as useRadioCAT.ts's bridgeHttpBase (ws:// -> http://
// for the REST endpoints).
function bridgeAudioWsUrl(catWsUrl: string): string | null {
  try {
    const u = new URL(catWsUrl)
    if (u.protocol !== 'ws:' && u.protocol !== 'wss:') return null
    u.pathname = '/audio'
    return u.toString()
  } catch {
    return null
  }
}

// Linear-interpolation resample — plenty for voice at these rates (both
// directions cross an 8kHz boundary, never anything near Nyquist-sensitive
// territory), and cheap enough to run on the main thread for mic capture
// chunks or per-received-frame on playback without any worker/worklet math.
function resampleLinear(
  input: Float32Array<ArrayBufferLike>,
  fromRate: number,
  toRate: number,
): Float32Array<ArrayBuffer> {
  const outLength = fromRate === toRate ? input.length : Math.round(input.length / (fromRate / toRate))
  const out = new Float32Array(outLength)
  if (fromRate === toRate) {
    out.set(input)
    return out
  }
  const ratio = fromRate / toRate
  for (let i = 0; i < outLength; i++) {
    const srcPos = i * ratio
    const i0 = Math.floor(srcPos)
    const i1 = Math.min(i0 + 1, input.length - 1)
    const frac = srcPos - i0
    out[i] = input[i0] * (1 - frac) + input[i1] * frac
  }
  return out
}

function floatToInt16(samples: Float32Array<ArrayBufferLike>): Int16Array<ArrayBuffer> {
  const out = new Int16Array(samples.length)
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]))
    out[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff
  }
  return out
}

function int16ToFloat(samples: Int16Array<ArrayBufferLike>): Float32Array<ArrayBuffer> {
  const out = new Float32Array(samples.length)
  for (let i = 0; i < samples.length; i++) {
    out[i] = samples[i] / (samples[i] < 0 ? 0x8000 : 0x7fff)
  }
  return out
}

function rmsLevel(samples: Float32Array<ArrayBufferLike>): number {
  if (samples.length === 0) return 0
  let sumSq = 0
  for (let i = 0; i < samples.length; i++) sumSq += samples[i] * samples[i]
  // sqrt-compressed 0-1, same non-linear curve as the firmware's own LED
  // brightness mapping (audio_monitor.c's rms_to_led_level) — kept in sync
  // deliberately so the browser meter and the physical LED "agree" on what
  // a given signal looks like, even though they're computed independently.
  return Math.sqrt(Math.min(1, Math.sqrt(sumSq / samples.length)))
}

export interface AudioBridgeState {
  connected: boolean
  micActive: boolean
  playbackActive: boolean
  levelIn: number // 0-1, radio -> browser (speaker audio), sqrt-compressed
  levelOut: number // 0-1, browser -> radio (mic audio), sqrt-compressed
  error: string | null
}

export function useAudioBridge() {
  const [state, setState] = createSignal<AudioBridgeState>({
    connected: false,
    micActive: false,
    playbackActive: false,
    levelIn: 0,
    levelOut: 0,
    error: null,
  })

  let ws: WebSocket | null = null
  let playCtx: AudioContext | null = null
  let nextPlayTime = 0
  let micCtx: AudioContext | null = null
  let micStream: MediaStream | null = null
  let micSource: MediaStreamAudioSourceNode | null = null
  let micTap: CaptureNode | null = null

  function disconnect() {
    ws?.close()
    ws = null
    stopMic()
    playCtx?.close()
    playCtx = null
    nextPlayTime = 0
    setState((s) => ({ ...s, connected: false, playbackActive: false, levelIn: 0 }))
  }

  function stopMic() {
    micTap?.disconnect()
    micTap = null
    micSource?.disconnect()
    micSource = null
    micStream?.getTracks().forEach((t) => t.stop())
    micStream = null
    micCtx?.close()
    micCtx = null
    setState((s) => ({ ...s, micActive: false, levelOut: 0 }))
  }

  // Schedules a decoded PCM frame to play back-to-back with whatever's
  // already queued — AudioBufferSourceNode has no "append to an ongoing
  // stream" primitive, so each incoming WS frame becomes its own buffer
  // source, started at the end time of the previous one (or "now" if we've
  // fallen behind, e.g. after a network hiccup) rather than overlapping or
  // leaving gaps.
  function playFrame(int16: Int16Array) {
    if (!playCtx) return
    const floatSamples = int16ToFloat(int16)
    const resampled = resampleLinear(floatSamples, BRIDGE_AUDIO_SAMPLE_RATE, playCtx.sampleRate)

    const buffer = playCtx.createBuffer(1, resampled.length, playCtx.sampleRate)
    buffer.copyToChannel(resampled, 0)

    const source = playCtx.createBufferSource()
    source.buffer = buffer
    source.connect(playCtx.destination)

    const startAt = Math.max(nextPlayTime, playCtx.currentTime)
    source.start(startAt)
    nextPlayTime = startAt + buffer.duration

    setState((s) => ({ ...s, levelIn: rmsLevel(floatSamples) }))
  }

  async function connect(catWsUrl: string): Promise<boolean> {
    disconnect()
    const audioUrl = bridgeAudioWsUrl(catWsUrl)
    if (!audioUrl) {
      setState((s) => ({ ...s, error: `Could not derive /audio URL from ${catWsUrl}` }))
      return false
    }

    try {
      playCtx = new AudioContext()
      nextPlayTime = 0
    } catch (err) {
      setState((s) => ({ ...s, error: err instanceof Error ? err.message : 'AudioContext failed' }))
      return false
    }

    return new Promise((resolve) => {
      const socket = new WebSocket(audioUrl)
      socket.binaryType = 'arraybuffer'

      socket.onopen = () => {
        ws = socket
        setState((s) => ({ ...s, connected: true, playbackActive: true, error: null }))
        resolve(true)
      }
      socket.onerror = () => {
        setState((s) => ({ ...s, error: `Failed to connect to ${audioUrl}` }))
        resolve(false)
      }
      socket.onclose = () => {
        if (ws === socket) disconnect()
      }
      socket.onmessage = (ev: MessageEvent<ArrayBuffer>) => {
        if (!(ev.data instanceof ArrayBuffer)) return
        playFrame(new Int16Array(ev.data))
      }
    })
  }

  async function startMic(): Promise<boolean> {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      setState((s) => ({ ...s, error: 'Not connected to the bridge' }))
      return false
    }
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      })
      micCtx = new AudioContext()
      micSource = micCtx.createMediaStreamSource(micStream)

      // 400-sample chunks at the mic's native rate resample down to roughly
      // BRIDGE_AUDIO_SAMPLE_RATE-ish frame sizes — not exact (native rate
      // varies by device/browser), but that's fine, the bridge has no
      // fixed-frame-size expectation on receive, just a byte stream of
      // Int16 samples.
      micTap = await createCaptureNode(micCtx, 2048, (samples) => {
        if (!ws || ws.readyState !== WebSocket.OPEN) return
        const resampled = resampleLinear(samples, micCtx!.sampleRate, BRIDGE_AUDIO_SAMPLE_RATE)
        const int16 = floatToInt16(resampled)
        ws.send(int16.buffer)
        setState((s) => ({ ...s, levelOut: rmsLevel(resampled) }))
      })
      micSource.connect(micTap.node)

      setState((s) => ({ ...s, micActive: true, error: null }))
      return true
    } catch (err) {
      stopMic()
      setState((s) => ({ ...s, error: err instanceof Error ? err.message : 'Microphone access failed' }))
      return false
    }
  }

  onCleanup(disconnect)

  return { state, connect, disconnect, startMic, stopMic }
}
