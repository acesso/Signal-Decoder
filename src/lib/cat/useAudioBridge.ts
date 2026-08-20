// Bidirectional audio bridge to the ESP32 CAT bridge's onboard ES8388 codec
// (see firmware/esp32-cat-bridge/main/audio_ws.h) — NOT real WebRTC: there's
// no mature, maintained WebRTC library for bare ESP-IDF, so this rides a
// second WebSocket (/audio, alongside /cat) carrying raw 16-bit signed
// mono PCM, in both directions:
//   bridge -> browser: radio speaker audio (ES8388 ADC)
//   browser -> bridge: this browser's mic, resampled to the bridge's rate
//                       (ES8388 DAC -> radio mic input)
// The sample rate is NOT fixed at 8kHz — the bridge's own control page can
// change it (POST /sample-rate, one of 8000/16000/22050/32000/44100/48000
// Hz, applied on reboot) — see fetchBridgeSampleRate(), which reads the
// bridge's actual current rate from GET /status fresh on every connect.
// Gated on the bridge's GET /info reporting the "audio" feature — see
// hasFeature('audio') in RadioCATPanel.tsx's BridgeStatusPanel.
import { createSignal, onCleanup } from 'solid-js'
import { createCaptureNode, type CaptureNode } from '$decoder-lib/audio/captureNode'

// Always-on (no debug flag, unlike useRadioCAT.ts's log()) — this module's
// failures used to be completely silent (state().error is the only signal,
// and nothing upstream reliably surfaces it), which made a real bug — the
// /audio connect failing during App.tsx's "Start Decoding" auto-connect,
// silently falling back to the microphone with zero console output —
// nearly undiagnosable. Cheap enough to always log; this path isn't hot.
function log(level: 'info' | 'warn' | 'error', ...args: unknown[]) {
  console[level]('[audio-bridge]', ...args)
}

// Fallback only — used if GET /status can't be reached at connect() time
// (bridge unreachable, older firmware without "sample_rate_select" in its
// feature list, etc). The bridge's actual rate is otherwise always read
// live from GET /status (see fetchBridgeSampleRate()) since POST
// /sample-rate on the bridge's own control page can change it at any time
// — this used to be a hardcoded constant that had to be kept in sync with
// bridge_config.h by hand, which stopped being viable once the rate
// became operator-configurable there.
const FALLBACK_SAMPLE_RATE = 8000

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

// ws://host/cat -> http://host/status — same transform as
// useRadioCAT.ts's bridgeHttpBase, duplicated locally rather than shared
// specifically to avoid coupling this module to useRadioCAT.ts's
// BridgeStatus type, which doesn't (and shouldn't need to) know about
// audio-specific fields like sample_rate_hz.
async function fetchBridgeSampleRate(catWsUrl: string): Promise<number> {
  try {
    const u = new URL(catWsUrl)
    if (u.protocol !== 'ws:' && u.protocol !== 'wss:') return FALLBACK_SAMPLE_RATE
    u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:'
    u.pathname = '/status'
    const res = await fetch(u.toString())
    if (!res.ok) return FALLBACK_SAMPLE_RATE
    const data = (await res.json()) as { sample_rate_hz?: unknown }
    return typeof data.sample_rate_hz === 'number' ? data.sample_rate_hz : FALLBACK_SAMPLE_RATE
  } catch {
    return FALLBACK_SAMPLE_RATE
  }
}

// Carries a linear resampler's position across successive chunks of the
// SAME stream. Mic capture hands resampleLinear() one 2048-sample chunk at
// a time (see createCaptureNode() below) — treating each chunk as an
// independent 0..N-1 buffer (as a stateless version of this function
// would) throws away the fractional sample position AND the true next
// sample just past the chunk boundary, both of which are real signal that
// belongs to the interpolation. That produced an audible periodic click
// every chunk boundary (~43ms at a 48kHz mic and 2048-sample chunks) —
// confirmed on real hardware via the ESP32 control page's mic-sniff
// waterfall: dense broadband stripes at a strict, regular cadence, while
// the same synthesized tone played back locally (no resampling) was clean.
// One instance of this state belongs to exactly one startMic() session —
// see makeResampleState()/the reset in startMic().
export interface ResampleState {
  // Fractional position into the NEXT unconsumed input sample, carried
  // over so consecutive chunks interpolate as one continuous stream
  // instead of each restarting at position 0.
  phase: number
  // The final sample of the previous chunk, needed as the left-hand
  // sample for an interpolation that starts before this chunk's first
  // sample has fully arrived. NaN means "no previous chunk yet" (first
  // call in a session) — first output sample then just holds at input[0]
  // rather than interpolating against a fabricated predecessor.
  prevSample: number
}

export function makeResampleState(): ResampleState {
  return { phase: 0, prevSample: NaN }
}

// Linear-interpolation resample — plenty for voice at these rates (both
// directions cross an 8kHz boundary, never anything near Nyquist-sensitive
// territory), and cheap enough to run on the main thread for mic capture
// chunks or per-received-frame on playback without any worker/worklet math.
// `state`, if given, makes this call continue exactly where the previous
// call on the same stream left off (see ResampleState's comment) — omit it
// for a one-shot resample with no prior/later chunks (e.g. tests).
export function resampleLinear(
  input: Float32Array<ArrayBufferLike>,
  fromRate: number,
  toRate: number,
  state?: ResampleState,
): Float32Array<ArrayBuffer> {
  if (fromRate === toRate) {
    const out = new Float32Array(input.length)
    out.set(input)
    if (state) state.prevSample = input.length > 0 ? input[input.length - 1] : state.prevSample
    return out
  }
  const ratio = fromRate / toRate
  const startPhase = state ? state.phase : 0
  const outLength = Math.floor((input.length - startPhase) / ratio) + 1
  const out = new Float32Array(Math.max(0, outLength))
  for (let i = 0; i < out.length; i++) {
    const srcPos = startPhase + i * ratio
    const i0 = Math.floor(srcPos)
    const frac = srcPos - i0
    // i0 === -1 only happens on a state-carrying call's very first sample,
    // when srcPos lands just before this chunk's start — interpolate
    // against the previous chunk's true final sample instead of clamping
    // into this chunk (which is what produced the periodic click). i0 can
    // also land exactly on input.length when floating-point drift in
    // `phase` accumulates past the last valid index over many chunks —
    // clamp to the final sample rather than reading past the array end.
    const left =
      i0 < 0
        ? state && !Number.isNaN(state.prevSample)
          ? state.prevSample
          : input[0]
        : i0 < input.length
          ? input[i0]
          : input[input.length - 1]
    const right = i0 + 1 < input.length ? input[i0 + 1] : left
    out[i] = left * (1 - frac) + right * frac
  }
  if (state) {
    state.phase = startPhase + out.length * ratio - input.length
    state.prevSample = input.length > 0 ? input[input.length - 1] : state.prevSample
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

// Both the Bridge panel's own "Send Mic to Radio" button and FT8 TX's
// "ESP32 Bridge" output option call startMic()/stopMic() on this SAME
// shared instance (there's only one bridge connection/useAudioBridge per
// app — see App.tsx). Without tracking who actually holds the session,
// whichever caller stops first would silently kill the other's audio too.
// null = idle, 'manual' = the Bridge panel's own button, 'ft8-tx' = FT8's
// TX sink — callers use this to disable their own control while the OTHER
// owns the session, rather than fighting over it.
export type MicOwner = 'manual' | 'ft8-tx'

// Pulled out as pure, Web-Audio-free functions (rather than inlined in
// startMic()/stopMic() below) specifically so the conflict-resolution rules
// — the one part of this file with real correctness risk and no AudioContext/
// WebSocket to mock — can be unit-tested in isolation. See
// src/lib/cat/__tests__/useAudioBridge.test.ts.

// true => reject the start(): someone ELSE already holds the session.
// Same owner re-starting (e.g. a re-render calling startMic() again) is
// allowed through — this only blocks a genuinely different claimant.
export function micStartConflicts(micActive: boolean, currentOwner: MicOwner | null, requestedOwner: MicOwner): boolean {
  return micActive && currentOwner !== requestedOwner
}

// true => this stop() call should actually run. No requiredOwner means an
// unconditional stop (disconnect()/error-cleanup paths, where tearing down
// regardless of who holds it is correct). With a requiredOwner, only that
// owner's own stop request takes effect — one consumer's stop() can never
// silently kill a session a DIFFERENT consumer is holding.
export function micStopAllowed(currentOwner: MicOwner | null, requiredOwner?: MicOwner): boolean {
  return requiredOwner === undefined || currentOwner === requiredOwner
}

export interface AudioBridgeState {
  connected: boolean
  micActive: boolean
  micOwner: MicOwner | null
  playbackActive: boolean
  levelIn: number // 0-1, radio -> browser (speaker audio), sqrt-compressed
  levelOut: number // 0-1, browser -> radio (mic audio), sqrt-compressed
  error: string | null
}

export function useAudioBridge() {
  const [state, setState] = createSignal<AudioBridgeState>({
    connected: false,
    micActive: false,
    micOwner: null,
    playbackActive: false,
    levelIn: 0,
    levelOut: 0,
    error: null,
  })
  // Exposed for a live spectrum/waterfall/scope view (see AudioQualityPanel)
  // — filter-tuning by eye needs frequency-domain data an RMS number can't
  // give. Plain signals, not part of AudioBridgeState: an AnalyserNode isn't
  // serializable/comparable state, it's a live handle a consumer reads from
  // directly every animation frame.
  const [analyserIn, setAnalyserIn] = createSignal<AnalyserNode | null>(null)
  const [analyserOut, setAnalyserOut] = createSignal<AnalyserNode | null>(null)

  let ws: WebSocket | null = null
  let playCtx: AudioContext | null = null
  let playAnalyserNode: AnalyserNode | null = null
  let nextPlayTime = 0
  let micCtx: AudioContext | null = null
  let micStream: MediaStream | null = null
  let micStreamIsExternal = false // true when startMic() was given a stream to use, not asked to open the mic itself — its owner (e.g. an FT8 TX MediaStreamAudioDestinationNode) manages that track's lifecycle, not us
  let micSource: MediaStreamAudioSourceNode | null = null
  let micAnalyserNode: AnalyserNode | null = null
  let micTap: CaptureNode | null = null
  // One resampler-state instance per mic session — see ResampleState's
  // comment for why this must persist across chunks rather than being
  // recreated per-chunk. Recreated fresh in startMic() so a NEW session
  // never inherits a previous session's leftover phase/prevSample.
  let micResampleState: ResampleState | null = null
  // The bridge's actual /audio wire rate — fetched fresh from GET /status
  // at the start of every connect() (see fetchBridgeSampleRate()), since
  // POST /sample-rate on the bridge's own control page can change this at
  // any time and there's no push notification when it does. Starts at the
  // fallback so playFrame()/startMic() have a sane value even for the
  // brief window before the first connect() call's fetch resolves.
  let bridgeSampleRate = FALLBACK_SAMPLE_RATE

  // Tracks whether the OPERATOR wants a connection right now (set by
  // connect(), cleared by disconnect()) — distinguishes "the socket closed
  // because the ESP32 rebooted, reconnect automatically" from "the operator
  // clicked Stop Listening, leave it closed." Without this, an ESP32
  // restart (e.g. after changing a setting in the Bridge panel, or the PA
  // watchdog/Wi-Fi reconnect cycle) silently killed playback until the
  // whole web app was reloaded — the socket's onclose fired, but nothing
  // ever tried to reopen it.
  let wantConnected = false
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null

  function clearReconnectTimer() {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
  }

  function disconnect() {
    wantConnected = false
    connectGeneration++ // invalidate any in-flight/reconnecting socket's callbacks
    reconnectAttempt = 0 // a fresh connect() afterward should start at the fast end of the backoff, not inherit a stale count
    clearReconnectTimer()
    ws?.close()
    ws = null
    stopMic()
    playCtx?.close()
    playCtx = null
    playAnalyserNode = null
    nextPlayTime = 0
    setAnalyserIn(null)
    setState((s) => ({ ...s, connected: false, playbackActive: false, levelIn: 0 }))
  }

  // requireOwner: if given, only stops the session when it's actually held
  // by that owner — a no-op otherwise, so e.g. FT8 TX switching away from
  // the bridge sink can't accidentally kill a manual "Send Mic to Radio"
  // session (or vice versa). Omit to force-stop regardless of owner (used
  // by disconnect()/onCleanup, where tearing down everything is correct).
  function stopMic(requireOwner?: MicOwner) {
    if (!micStopAllowed(state().micOwner, requireOwner)) return
    micTap?.disconnect()
    micTap = null
    micSource?.disconnect()
    micSource = null
    micAnalyserNode = null
    micResampleState = null
    if (!micStreamIsExternal) micStream?.getTracks().forEach((t) => t.stop())
    micStream = null
    micStreamIsExternal = false
    micCtx?.close()
    micCtx = null
    setAnalyserOut(null)
    setState((s) => ({ ...s, micActive: false, micOwner: null, levelOut: 0 }))
  }

  // Schedules a decoded PCM frame to play back-to-back with whatever's
  // already queued — AudioBufferSourceNode has no "append to an ongoing
  // stream" primitive, so each incoming WS frame becomes its own buffer
  // source, started at the end time of the previous one (or "now" if we've
  // fallen behind, e.g. after a network hiccup) rather than overlapping or
  // leaving gaps.
  //
  // The buffer is created at bridgeSampleRate (the bridge's actual, live
  // rate — see its own comment) rather than pre-resampled to
  // playCtx.sampleRate with
  // resampleLinear() — createBuffer() accepts any sample rate and
  // AudioBufferSourceNode resamples to the context's rendering rate
  // natively on playback (spec-guaranteed: MDN's createBuffer() docs state
  // a buffer at a different rate "will be automatically resampled").
  // Confirmed this matters here: an A/B test on real hardware found a
  // materially worse broadband noise floor on this bridge path vs. the
  // exact same source captured directly by a laptop's sound card — Firefox
  // resamples internally via libspeex, a band-limited/sinc-based resampler
  // with real anti-aliasing filtering, categorically better than the naive
  // linear interpolation resampleLinear() does (no reconstruction filter
  // at all, which is exactly the kind of thing that shows up as a raised
  // noise floor in an FFT view rather than as an obviously "wrong" sound).
  function playFrame(int16: Int16Array) {
    if (!playCtx) return
    const floatSamples = int16ToFloat(int16)

    const buffer = playCtx.createBuffer(1, floatSamples.length, bridgeSampleRate)
    buffer.copyToChannel(floatSamples, 0)

    const source = playCtx.createBufferSource()
    source.buffer = buffer
    // Routed through the shared analyser (created once in connect(), already
    // wired to destination there) rather than straight to destination — one
    // AnalyserNode persists across every frame's own short-lived buffer
    // source, so AudioQualityPanel can keep reading from the same node.
    source.connect(playAnalyserNode ?? playCtx.destination)

    const startAt = Math.max(nextPlayTime, playCtx.currentTime)
    source.start(startAt)
    nextPlayTime = startAt + buffer.duration

    setState((s) => ({ ...s, levelIn: rmsLevel(floatSamples) }))
  }

  // Opens the /audio WebSocket + playback AudioContext, and — unlike a
  // one-shot connect — keeps retrying if the socket ever closes
  // unexpectedly (ESP32 reboot, Wi-Fi hiccup) for as long as the operator
  // hasn't explicitly disconnected. openSocket() is the retryable core;
  // connect() is the public one-shot entry point that also resolves once
  // the FIRST attempt settles (matching its previous Promise<boolean>
  // contract — later reconnects happen silently in the background and are
  // reflected via the `connected`/`playbackActive` state signal instead of
  // a promise anyone's still awaiting).
  //
  // Exponential backoff (2s, 4s, 8s, ... capped at 30s), not a fixed
  // interval — found on real hardware that a fixed 2s retry, running
  // alongside useRadioCAT.ts's own independent 2s CAT reconnect loop,
  // turned one marginal Wi-Fi link into a self-sustaining retry storm: up
  // to 30 combined reconnect attempts/minute across both sockets, each one
  // itself consuming the ESP32's limited Wi-Fi/TCP resources, which never
  // gave a struggling link a quiet window to actually settle — the bridge
  // sat in continuous connect-fail-close churn for 6+ minutes straight
  // rather than a handful of failed attempts before recovering or giving
  // up. reconnectAttempt resets to 0 on every successful open (see
  // socket.onopen below), so a connection that's actually stable goes
  // right back to fast (2s) retries the next time it genuinely drops.
  const RECONNECT_BASE_DELAY_MS = 2000
  const RECONNECT_MAX_DELAY_MS = 30000
  let reconnectAttempt = 0
  // Bumped on every disconnect()/new connect() — a socket's callbacks
  // compare their own captured generation against this before acting, so a
  // stale socket (superseded by a fresh connect(), or torn down by an
  // explicit disconnect()) can never resurrect state or schedule a
  // reconnect on top of a newer attempt.
  let connectGeneration = 0

  // Re-fetches the bridge's current sample rate on every (re)open, not
  // just the first — a reconnect after the bridge itself rebooted (e.g.
  // POST /sample-rate was just called from its own control page) would
  // otherwise keep using whatever rate was current before that reboot,
  // silently mismatching the bridge's new actual rate until the whole
  // page reloaded.
  function openSocket(audioUrl: string, catWsUrl: string, generation: number, resolveFirstAttempt?: (ok: boolean) => void) {
    void fetchBridgeSampleRate(catWsUrl).then((rate) => {
      if (generation === connectGeneration) bridgeSampleRate = rate
    })

    const socket = new WebSocket(audioUrl)
    socket.binaryType = 'arraybuffer'

    socket.onopen = () => {
      if (generation !== connectGeneration) return
      log('info', `connected — ${audioUrl}`)
      reconnectAttempt = 0
      ws = socket
      setState((s) => ({ ...s, connected: true, playbackActive: true, error: null }))
      resolveFirstAttempt?.(true)
    }
    socket.onerror = () => {
      if (generation !== connectGeneration) return
      log('warn', `connection error — ${audioUrl}`)
      setState((s) => ({ ...s, error: `Failed to connect to ${audioUrl}` }))
      resolveFirstAttempt?.(false)
    }
    socket.onclose = () => {
      if (generation !== connectGeneration) return
      const delay = Math.min(RECONNECT_BASE_DELAY_MS * 2 ** reconnectAttempt, RECONNECT_MAX_DELAY_MS)
      log('info', `closed — ${audioUrl}${wantConnected ? `, retrying in ${delay}ms (attempt ${reconnectAttempt + 1})` : ''}`)
      ws = null
      setState((s) => ({ ...s, connected: false, playbackActive: false }))
      if (!wantConnected) return
      // Keep retrying — the operator asked to listen and hasn't said
      // otherwise; a reboot/hiccup shouldn't require reloading the whole
      // page to hear the radio again. playCtx/playAnalyserNode are left
      // alone (not torn down) so AudioQualityPanel etc. keep their
      // reference; playFrame() just has nothing to feed until we reopen.
      clearReconnectTimer()
      reconnectAttempt++
      reconnectTimer = setTimeout(() => openSocket(audioUrl, catWsUrl, generation), delay)
    }
    socket.onmessage = (ev: MessageEvent<ArrayBuffer>) => {
      if (generation !== connectGeneration) return
      if (!(ev.data instanceof ArrayBuffer)) return
      playFrame(new Int16Array(ev.data))
    }
  }

  async function connect(catWsUrl: string): Promise<boolean> {
    disconnect()
    const audioUrl = bridgeAudioWsUrl(catWsUrl)
    if (!audioUrl) {
      log('error', `could not derive /audio URL from ${catWsUrl}`)
      setState((s) => ({ ...s, error: `Could not derive /audio URL from ${catWsUrl}` }))
      return false
    }
    log('info', `connecting — ${audioUrl}`)
    wantConnected = true

    try {
      playCtx = new AudioContext()
      nextPlayTime = 0
      playAnalyserNode = playCtx.createAnalyser()
      playAnalyserNode.fftSize = 2048
      playAnalyserNode.connect(playCtx.destination)
      setAnalyserIn(playAnalyserNode)
    } catch (err) {
      log('error', 'AudioContext creation failed:', err)
      setState((s) => ({ ...s, error: err instanceof Error ? err.message : 'AudioContext failed' }))
      return false
    }

    const generation = connectGeneration
    return new Promise((resolve) => openSocket(audioUrl, catWsUrl, generation, resolve))
  }

  // externalStream: lets a caller (e.g. an FT8 TX MediaStreamAudioDestinationNode
  // — see src/lib/audio/audioSource.ts's bridgeSink()) supply a synthetic
  // stream instead of a real microphone. Everything from createMediaStreamSource
  // onward is source-agnostic, so this is the only branch point needed.
  // owner: which consumer is claiming the session (see MicOwner) — rejected
  // if a DIFFERENT owner already holds it, so the manual Bridge-panel button
  // and FT8 TX's bridge sink can't silently steal/kill each other's session.
  async function startMic(externalStream?: MediaStream, owner: MicOwner = 'manual'): Promise<boolean> {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      setState((s) => ({ ...s, error: 'Not connected to the bridge' }))
      return false
    }
    if (micStartConflicts(state().micActive, state().micOwner, owner)) {
      setState((s) => ({ ...s, error: 'Mic-send session is already in use elsewhere' }))
      return false
    }
    try {
      micStream = externalStream ?? await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      })
      micStreamIsExternal = externalStream !== undefined
      micCtx = new AudioContext()
      micSource = micCtx.createMediaStreamSource(micStream)

      // AnalyserNode doesn't need a destination connection to be readable —
      // it just needs to sit in the signal path, so tapping it here doesn't
      // change the fact that the mic is never routed to local speakers
      // (that would be a feedback loop, not a tuning tool).
      micAnalyserNode = micCtx.createAnalyser()
      micAnalyserNode.fftSize = 2048
      micSource.connect(micAnalyserNode)
      setAnalyserOut(micAnalyserNode)

      // 400-sample chunks at the mic's native rate resample down to roughly
      // bridgeSampleRate-ish frame sizes — not exact (native rate varies by
      // device/browser), but that's fine, the bridge has no
      // fixed-frame-size expectation on receive, just a byte stream of
      // Int16 samples. This direction still uses resampleLinear() rather
      // than the native-createBuffer trick playFrame() uses — we're
      // producing a raw wire-format byte stream to send over WebSocket
      // here, not playing through an AudioBufferSourceNode, so there's no
      // browser resampler to hand this off to. micResampleState is fresh
      // per session (reset just above) and threaded through every chunk of
      // THIS session so the resampler treats them as one continuous stream
      // — see ResampleState's comment for the audible click this fixes.
      micResampleState = makeResampleState()
      micTap = await createCaptureNode(micCtx, 2048, (samples) => {
        if (!ws || ws.readyState !== WebSocket.OPEN) return
        const resampled = resampleLinear(samples, micCtx!.sampleRate, bridgeSampleRate, micResampleState!)
        const int16 = floatToInt16(resampled)
        ws.send(int16.buffer)
        setState((s) => ({ ...s, levelOut: rmsLevel(resampled) }))
      })
      micSource.connect(micTap.node)

      setState((s) => ({ ...s, micActive: true, micOwner: owner, error: null }))
      return true
    } catch (err) {
      stopMic()
      setState((s) => ({ ...s, error: err instanceof Error ? err.message : 'Microphone access failed' }))
      return false
    }
  }

  onCleanup(disconnect)

  // Exposes the incoming-radio-audio graph itself (not just its AnalyserNode,
  // already available via the analyserIn signal for metering) so a decoder
  // can attach its OWN createCaptureNode() tap onto the same context/node —
  // see acquireBridgeSource() in src/lib/audio/audioSource.ts. Null whenever
  // playback isn't active (nothing to tap yet).
  function getPlaybackSource(): { ctx: AudioContext; node: AnalyserNode } | null {
    if (!playCtx || !playAnalyserNode) return null
    return { ctx: playCtx, node: playAnalyserNode }
  }

  return { state, connect, disconnect, startMic, stopMic, analyserIn, analyserOut, getPlaybackSource }
}

export type AudioBridge = ReturnType<typeof useAudioBridge>
