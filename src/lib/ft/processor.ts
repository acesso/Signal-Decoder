// Port of src/hooks/useFTProcessor.ts (Next.js app) — captures audio in
// UTC-aligned windows and streams decode results as they're found. Kept
// close to the original's imperative timing logic verbatim (the comments
// explaining drift-correction/rollover are load-bearing, not stylistic).
import { createSignal } from 'solid-js'
import { type FTDecodeResult, type FTMessage, type FTMode, FT_WINDOW_SECONDS, FT_SUPPORTED, decodeFTAudio } from '$decoder-lib/ft/decoder'
import { createCaptureNode, type CaptureNode } from '$decoder-lib/audio/captureNode'
import { acquireMicrophoneSource, acquireBridgeSourceWithRetry, type AudioSourceKind, type AudioSourceHandle } from '$decoder-lib/audio/audioSource'
import type { AudioBridge } from '$decoder-lib/cat/useAudioBridge'
import type { IQBridge } from '$decoder-lib/cat/useIQBridge'

export interface FTProcessorState {
  isRecording: boolean
  isSupported: boolean
  error: string | null
  results: FTDecodeResult[]
  status: 'idle' | 'waiting' | 'recording' | 'decoding'
}

const PARTIAL_FLUSH_MS = 250

// FT8's 79 symbols × 0.160s = 12.64s of actual transmission in a 15s slot;
// FT4's 105 symbols × 0.048s = 5.04s in a 7.5s slot — both leave ~2.3-2.5s of
// trailing silence before the next boundary (see FT8_SYMBOL_PERIOD/FT8_NN and
// FT4_SYMBOL_PERIOD/FT4_NN in lib/ft8_lib/ft8/constants.h). Decoding this
// early — instead of waiting for the full window — uses that dead air
// productively: a message that's actually there has already fully arrived,
// so nothing is lost, and results land ~2s sooner. Default kept under the
// real silence gap (not right at 2.3-2.5s) so a slightly late-starting or
// slightly-longer-than-nominal transmission doesn't get truncated — user-
// tunable (see FTWasmPanel.tsx's "Early decode" slider) since how much
// margin is safe depends on real-world propagation/timing conditions this
// code can't predict.
export const DEFAULT_EARLY_DECODE_MS = 2000

function msUntilNextWindow(windowSec: number): number {
  const totalMs = windowSec * 1000
  const now = new Date()
  const elapsed = (now.getSeconds() * 1000 + now.getMilliseconds()) % totalMs
  return elapsed < 50 ? 0 : totalMs - elapsed
}

export function createFTProcessor(
  getMode: () => FTMode,
  // Where capture comes from — the local mic (default, matches all prior
  // behavior when omitted) or the ESP32 bridge's live incoming-radio-audio
  // (see audioSource.ts's acquireMicrophoneSource()/acquireBridgeSource()).
  getAudioSourceKind: () => AudioSourceKind = () => 'microphone',
  getAudioBridge: () => AudioBridge | IQBridge | undefined = () => undefined,
  getEarlyDecodeMs: () => number = () => DEFAULT_EARLY_DECODE_MS,
) {
  const [state, setState] = createSignal<FTProcessorState>({
    isRecording: false,
    isSupported:
      typeof window !== 'undefined' && 'AudioContext' in window && !!navigator.mediaDevices?.getUserMedia,
    error: null,
    results: [],
    status: 'idle',
  })

  let audioContext: AudioContext | null = null
  let analyser: AnalyserNode | null = null
  let source: AudioSourceHandle | null = null
  let processorNode: CaptureNode | null = null
  let sampleBuf: Float32Array | null = null
  let sampleCount = 0
  let windowStart: Date | null = null
  // Bumped by stopRecording() so a startRecording() call that's mid-retry
  // waiting for a forced bridge source (see acquireBridgeSourceWithRetry())
  // notices it's been superseded and gives up instead of eventually
  // resolving into a session that's already been torn down.
  let startGeneration = 0
  // Sample-clock anchor for window-boundary bookkeeping — see the rollover
  // block in runLoop() for why this replaced a per-window Date.now() read.
  // anchorUtcMs/samplesSinceAnchor correlate ONE (UTC time, cumulative
  // captured sample count) pair, established once when capture starts;
  // every later window boundary is located by comparing samplesSinceAnchor
  // (a running total advanced by exactly how many real samples the
  // AudioWorklet delivered — audio-thread-accurate, never approximated)
  // against that fixed anchor, instead of re-deriving "how far into this
  // window are we" from a fresh Date.now() read each rollover.
  let anchorUtcMs = 0
  let samplesSinceAnchor = 0
  // Resolved by the capture callback below on the first sample it actually
  // writes into the CURRENT sampleBuf — see that callback's own comment.
  // Re-created every time sampleBuf is (re)allocated, so runLoop() can await
  // "a real sample has now landed in THIS buffer" instead of guessing at it
  // from its own clock.
  let pendingAnchor: { resolve: (ms: number) => void; promise: Promise<number> } | null = null
  // Set by the AudioContext's onstatechange handler (see startRecording())
  // when the context comes back to 'running' after having left it —
  // suspended by the OS reclaiming audio focus (a notification, a call, tab
  // backgrounding/power-saving throttling), or, on the bridge path, any
  // other reason connect() might leave playCtx briefly non-running. While
  // suspended, the AudioWorkletNode's process() callback simply isn't
  // invoked at all — no quanta, empty or otherwise — so samplesSinceAnchor
  // silently stops advancing for the entire suspended span while real wall-
  // clock time keeps passing, exactly reproducing the startup gap the
  // pendingAnchor mechanism above already fixes, except mid-session instead
  // of only at t=0. runLoop()'s existing allocation/re-anchor block already
  // does the right thing for a resized buffer; this flag makes it also run
  // for "same buffer, but audio silently stopped and restarted."
  let needsReanchor = false
  // Detaches the statechange listener startRecording() attaches below —
  // null when nothing is currently attached. Called from stopRecording()
  // so a long-lived shared context (the bridge's playCtx, reused across
  // many start/stop cycles in one page session) doesn't accumulate one
  // dead listener per past session; the generation guard already makes a
  // stale listener harmless, but "harmless" isn't the same as "not still
  // attached and taking up memory forever."
  let detachCtxStateListener: (() => void) | null = null
  let isRunning = false
  const timers = new Set<ReturnType<typeof setTimeout>>()

  function clearTimers() {
    for (const t of timers) clearTimeout(t)
    timers.clear()
  }

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        timers.delete(t)
        resolve()
      }, ms)
      timers.add(t)
    })
  }

  // Dev-only synthetic decode injection — lets perf tests simulate a long
  // run (hundreds of contacts) in seconds without audio. Exercises the same
  // streaming path as real decodes: placeholder -> partials -> final replace.
  // Tree-shaken out of production builds (import.meta.env.DEV).
  function installInjectHook() {
    if (!import.meta.env.DEV) return () => {}
    ;(window as unknown as Record<string, unknown>).__ftInjectWindow = (messages: FTMessage[], partialMs = 50) => {
      const injWindowStart = new Date()
      const key = injWindowStart.getTime()
      const patch = (fn: (r: FTDecodeResult) => FTDecodeResult) =>
        setState((prev) => ({
          ...prev,
          results: prev.results.map((r) => (r.windowStart.getTime() === key ? fn(r) : r)),
        }))
      setState((prev) => ({
        ...prev,
        results: [{ windowStart: injWindowStart, mode: getMode(), messages: [], decodeMs: 0, decoding: true }, ...prev.results].slice(0, 100),
      }))
      const perBatch = Math.max(1, Math.round(PARTIAL_FLUSH_MS / partialMs))
      for (let i = 0; i < messages.length; i += perBatch) {
        const batch = messages.slice(0, i + perBatch)
        setTimeout(() => patch((r) => ({ ...r, messages: batch })), (i + perBatch) * partialMs)
      }
      setTimeout(
        () => patch((r) => ({ ...r, messages, decodeMs: messages.length * partialMs, decoding: false })),
        (messages.length + 2) * partialMs,
      )
    }
    return () => {
      delete (window as unknown as Record<string, unknown>).__ftInjectWindow
    }
  }
  const uninstallInjectHook = installInjectHook()

  async function runLoop() {
    const dispatchDecode = (captured: Float32Array, sampleRate: number, dWindowStart: Date) => {
      const t0 = performance.now()
      const key = dWindowStart.getTime()
      const patchWindow = (patch: (r: FTDecodeResult) => FTDecodeResult) =>
        setState((prev) => ({
          ...prev,
          results: prev.results.map((r) => (r.windowStart.getTime() === key ? patch(r) : r)),
        }))

      const placeholder: FTDecodeResult = { windowStart: dWindowStart, mode: getMode(), messages: [], decodeMs: 0, decoding: true }
      setState((prev) => ({ ...prev, results: [placeholder, ...prev.results].slice(0, 100) }))

      // Batch streamed partials: one state update per ~250ms instead of one
      // per message — each update walks the whole render/contacts pipeline,
      // which dominates UI cost on busy bands.
      const buffer: FTMessage[] = []
      let flushTimer: ReturnType<typeof setTimeout> | null = null
      const flush = () => {
        flushTimer = null
        if (buffer.length === 0) return
        const batch = buffer.splice(0)
        patchWindow((r) => ({ ...r, messages: [...r.messages, ...batch] }))
      }

      const onPartial = (msg: FTMessage) => {
        if (!isRunning) return
        buffer.push(msg)
        if (flushTimer === null) flushTimer = setTimeout(flush, PARTIAL_FLUSH_MS)
      }

      decodeFTAudio(captured, sampleRate, getMode(), onPartial)
        .then((messages) => ({ messages, decodeMs: performance.now() - t0 }))
        .catch(() => ({ messages: [] as FTMessage[], decodeMs: performance.now() - t0 }))
        .then(({ messages, decodeMs }) => {
          if (flushTimer !== null) {
            clearTimeout(flushTimer)
            flushTimer = null
          }
          buffer.length = 0
          if (!isRunning) return
          patchWindow((r) => ({ ...r, messages, decodeMs, decoding: false }))
        })
    }

    const windowSec = FT_WINDOW_SECONDS[getMode()]
    const waitMs = msUntilNextWindow(windowSec)
    if (waitMs > 100) {
      setState((prev) => ({ ...prev, status: 'waiting' }))
      await sleep(waitMs)
    }

    let firstWindow = true
    while (isRunning) {
      const curWindowSec = FT_WINDOW_SECONDS[getMode()]

      const sampleRate = audioContext?.sampleRate ?? 48000
      const capacity = Math.ceil((curWindowSec + 2) * sampleRate)
      if (!sampleBuf || sampleBuf.length !== capacity || needsReanchor) {
        needsReanchor = false
        // A resize allocates a fresh buffer; a plain re-anchor (context
        // resumed after suspending) keeps using the same one — either way,
        // sampleCount/samplesSinceAnchor restart at 0 for it, so whatever
        // was captured before the gap (now stale/discontinuous with what's
        // coming) is dropped rather than silently spliced together with
        // post-gap audio as if no time had passed.
        sampleBuf = sampleBuf && sampleBuf.length === capacity ? sampleBuf : new Float32Array(capacity)
        sampleCount = 0
        samplesSinceAnchor = 0
        // BUG this fixes (reported 2026-09-01: dt drifts steadily worse,
        // present on the ESP32 bridge, a directly-plugged soundcard, AND a
        // WebSDR-loopback source — worse on the bridge): anchorUtcMs used
        // to be stamped from a plain `new Date()` read taken right here,
        // treating "the instant this main-thread loop happens to allocate
        // sampleBuf" as if it were "the instant real audio starts landing
        // in it." Those are NOT the same instant. Between an
        // AudioWorkletNode being constructed/connected and its process()
        // callback receiving a genuinely non-empty inputs[0][0] (spec-legal
        // and normal — the upstream graph briefly delivers empty/absent
        // input for the first few render quanta right after connect()),
        // captureWorklet.js's own `if (input && input.length > 0)` guard
        // silently skips forwarding those quanta — correctly, since
        // there's nothing real to send, but each one is real wall-clock
        // time samplesSinceAnchor never learns about. Stamping the anchor
        // from Date.now() before that startup gap closed silently baked
        // that gap's whole length into every window boundary computed for
        // the rest of the session — a ONE-TIME deficit, not a per-window
        // compounding drift (matching the reported stable-band-not-a-ramp
        // shape), larger on the bridge (WebSocket connect + first /status
        // fetch + first playFrame() all sit in that gap) than on direct mic
        // capture (shorter gap, smaller deficit, still nonzero).
        //
        // Fix: don't guess when the first real sample will land — wait for
        // it. pendingAnchor is a promise the capture callback resolves on
        // the first write it actually makes into THIS buffer (audio-thread
        // timestamp, audio-thread accurate); anchorUtcMs is stamped from
        // that value once it resolves, not before. A short bounded timeout
        // is the only safety net (a source that never delivers a single
        // sample has bigger problems than an unanchored window), so this
        // can't hang the loop forever.
        let resolveAnchor: (ms: number) => void
        const anchorPromise = new Promise<number>((resolve) => { resolveAnchor = resolve })
        pendingAnchor = { resolve: resolveAnchor!, promise: anchorPromise }
        const ANCHOR_WAIT_TIMEOUT_MS = 2000
        // sleep() (not a raw setTimeout) so this timer is tracked in the
        // same `timers` set stopRecording()'s clearTimers() sweeps — a
        // stop mid-wait shouldn't leave an orphaned timer running, even
        // though its only effect (resolving an internal promise) would be
        // harmless either way.
        const firstSampleAtMs = await Promise.race([
          anchorPromise,
          sleep(ANCHOR_WAIT_TIMEOUT_MS).then(() => Date.now()),
        ])
        if (!isRunning) break
        windowStart = new Date(firstSampleAtMs)
        anchorUtcMs = firstSampleAtMs
      }
      if (firstWindow) {
        firstWindow = false
        setState((prev) => ({ ...prev, status: 'recording' }))
      }

      const lateMs = (windowStart?.getTime() ?? 0) % (curWindowSec * 1000)
      if (lateMs > 300 && lateMs < curWindowSec * 1000 - 300) {
        console.debug(`[ft] window armed ${lateMs} ms after the UTC boundary — decode Δ will shift by ~+${(lateMs / 1000).toFixed(1)}s`)
      }

      const windowMs = curWindowSec * 1000
      const toBoundaryMs = msUntilNextWindow(curWindowSec) || windowMs
      const earlyDecodeMs = getEarlyDecodeMs()
      // Wake up earlyDecodeMs before the real boundary and decode whatever
      // has accumulated so far — a real transmission has already finished by
      // then (see DEFAULT_EARLY_DECODE_MS's comment), so this loses nothing
      // but the trailing silence. Too-short windows (or a loop that's
      // arming more than earlyDecodeMs late) fall back to the old
      // boundary-exact wake. This sleep's precision doesn't matter for
      // correctness — it only decides roughly WHEN to look, never where the
      // window boundary actually is; that's the sample-clock math below.
      const earlyMs = toBoundaryMs - earlyDecodeMs
      const sleepMs = earlyMs > 100 ? earlyMs : toBoundaryMs
      await sleep(sleepMs)
      if (!isRunning) break

      const dWindowStart = windowStart!
      const decodedEarly = sleepMs === earlyMs
      if (decodedEarly) {
        setState((prev) => ({ ...prev, status: 'decoding' }))
        // Snapshot without resetting sampleBuf — capture keeps filling it
        // (the AudioWorklet callback doesn't know or care about this early
        // wake) through the remaining trailing silence up to the real
        // boundary, where the rollover logic below still runs normally.
        dispatchDecode(sampleBuf.slice(0, sampleCount), sampleRate, dWindowStart)
        await sleep(earlyDecodeMs)
        if (!isRunning) break
        setState((prev) => ({ ...prev, status: 'recording' }))
      }

      // Locate the boundary from the SAMPLE clock, not a fresh Date.now()
      // read here. REAL HARDWARE/BROWSER BUG this fixes (reported
      // 2026-08-27): the previous version computed `Date.now() % windowMs`
      // at exactly this point, after the `await sleep(...)` calls above —
      // but setTimeout has no minimum-delay guarantee, and under CPU load
      // (confirmed by the user across multiple browser tabs each running
      // their own decode pipeline, and even in a pipeline that never
      // touches this app's own ESP32 bridge code, e.g. WebSDR-loopback
      // mic capture) that resolve can land arbitrarily late. Every bit of
      // that lateness got misread as "more samples belong to the next
      // window than actually do," permanently shifting windowStart earlier
      // than the samples' true first-sample instant — and because
      // setTimeout lateness is one-directional (always late, never early),
      // that misattribution compounded window over window instead of
      // averaging out, matching the reported "deltas start accurate, then
      // get steadily worse after 5-10 windows" symptom. samplesSinceAnchor
      // instead counts exactly how many real samples the audio-thread
      // AudioWorklet has ever delivered since a single anchor taken once
      // at capture start (see its own comment) — that count cannot drift
      // relative to the actual audio, regardless of how late this main-
      // thread loop iteration happens to run.
      const windowSamples = Math.round((windowMs / 1000) * sampleRate)
      const sinceBoundarySamples = windowSamples > 0 ? samplesSinceAnchor % windowSamples : 0
      const sinceBoundary = (sinceBoundarySamples / sampleRate) * 1000
      const total = sampleCount
      const tailSamples = sinceBoundary > 50 && sinceBoundary < windowMs / 2 ? Math.min(sinceBoundarySamples, total) : 0
      const nowMs = anchorUtcMs + (samplesSinceAnchor / sampleRate) * 1000
      if (sinceBoundary > 300 && sinceBoundary < windowMs - 300) {
        console.debug(`[ft] window rollover ${sinceBoundary.toFixed(0)} ms after the UTC boundary — carrying ${tailSamples} samples into the next window`)
      }

      // Already decoded this window early — the samples captured between
      // then and the real boundary are the expected trailing silence, not a
      // second message, so there's nothing left to dispatch; skip the slice.
      const captured = decodedEarly ? null : sampleBuf.slice(0, total - tailSamples)
      const nextBuf = new Float32Array(capacity)
      if (tailSamples > 0) nextBuf.set(sampleBuf.subarray(total - tailSamples, total))
      sampleBuf = nextBuf
      sampleCount = tailSamples
      windowStart = tailSamples > 0 ? new Date(nowMs - sinceBoundary) : new Date()

      if (captured) dispatchDecode(captured, sampleRate, dWindowStart)
    }
  }

  async function startRecording() {
    const myGeneration = ++startGeneration
    try {
      if (!state().isSupported) throw new Error('Web Audio API not supported')

      const kind = getAudioSourceKind()
      let handle: AudioSourceHandle
      if (kind === 'bridge') {
        const bridge = getAudioBridge()
        if (!bridge) throw new Error('No bridge is configured for this decoder')
        // Retries instead of failing immediately — clicking Start with a
        // bridge source selected is a clear statement of intent, even if
        // the bridge isn't connected THIS instant (see
        // acquireBridgeSourceWithRetry()'s own comment). Aborts if this
        // call has been superseded by a newer startRecording()/
        // stopRecording() while waiting.
        setState((prev) => ({ ...prev, isRecording: true, error: null, status: 'waiting' }))
        const bridgeSource = await acquireBridgeSourceWithRetry(bridge, () => startGeneration !== myGeneration)
        if (!bridgeSource) return // superseded/stopped while waiting — stopRecording() already reset state
        handle = bridgeSource
      } else {
        handle = await acquireMicrophoneSource()
      }
      source = handle
      const ctx = handle.ctx
      audioContext = ctx

      // Detects the mid-session suspend/resume gap needsReanchor exists
      // for (see its own comment) — addEventListener, not assigning
      // ctx.onstatechange directly, since on the bridge path this context
      // is useAudioBridge.ts's own playCtx, shared with (and outliving)
      // this decoder session; a plain assignment would silently clobber
      // any handler that module attaches, now or later, and vice versa.
      // Guarded by generation (myGeneration) the same way every other
      // async continuation in this function is — belt-and-suspenders
      // alongside stopRecording()'s explicit removeEventListener() below:
      // the guard covers the narrow window where a statechange event is
      // already queued/in-flight at the exact moment stopRecording() runs,
      // so it fires once more before the removal takes effect.
      let sawNonRunning = ctx.state !== 'running'
      const onCtxStateChange = () => {
        if (startGeneration !== myGeneration) return
        if (ctx.state !== 'running') {
          sawNonRunning = true
          return
        }
        if (sawNonRunning) {
          sawNonRunning = false
          needsReanchor = true
        }
      }
      ctx.addEventListener('statechange', onCtxStateChange)
      detachCtxStateListener = () => ctx.removeEventListener('statechange', onCtxStateChange)

      const analyserNode = ctx.createAnalyser()
      analyserNode.fftSize = 4096
      analyser = analyserNode
      handle.node.connect(analyserNode)

      // AudioWorkletNode's capture runs on the audio thread, not the main
      // thread — unlike the old ScriptProcessorNode, dropped/delayed
      // samples here directly cost decodable FT8 windows, so this is the
      // most consequential of this app's several ScriptProcessorNode->
      // AudioWorklet migration sites.
      const proc = await createCaptureNode(ctx, 4096, (input) => {
        const buf = sampleBuf
        if (!buf) return
        // The very first write into a freshly (re)allocated buffer
        // (sampleCount === 0 at entry — see runLoop()'s allocation block)
        // is exactly the sample this buffer's anchor needs to correlate
        // to: same write, same timestamp, no gap between "when we decided
        // to start counting" and "the first thing we actually counted."
        if (sampleCount === 0 && pendingAnchor) {
          pendingAnchor.resolve(Date.now())
          pendingAnchor = null
        }
        const space = buf.length - sampleCount
        const copy = Math.min(input.length, space)
        buf.set(input.subarray(0, copy), sampleCount)
        sampleCount += copy
        samplesSinceAnchor += copy
      })
      processorNode = proc
      analyserNode.connect(proc.node)

      isRunning = true
      setState((prev) => ({ ...prev, isRecording: true, error: null, status: 'waiting' }))
      runLoop()
    } catch (err) {
      setState((prev) => ({
        ...prev,
        error: err instanceof Error ? err.message : 'Failed to access microphone',
        isRecording: false,
      }))
    }
  }

  function stopRecording() {
    startGeneration++ // see its own comment — aborts any in-flight bridge-retry wait
    isRunning = false
    clearTimers()
    detachCtxStateListener?.()
    detachCtxStateListener = null
    sampleBuf = null
    if (processorNode) {
      processorNode.disconnect()
      processorNode = null
    }
    if (analyser) {
      analyser.disconnect()
      analyser = null
    }
    // audioContext is the SOURCE's context (mic: our own, created in
    // acquireMicrophoneSource(); bridge: the bridge's own playCtx, owned by
    // useAudioBridge, not us) — release() (not a raw ctx.close()) is what
    // correctly distinguishes "tear this down" from "just stop reading from
    // it," matching acquireBridgeSource()'s no-op release.
    source?.release()
    source = null
    audioContext = null
    setState((prev) => ({ ...prev, isRecording: false, status: 'idle' }))
  }

  function clearResults() {
    setState((prev) => ({ ...prev, results: [] }))
  }

  function getAnalyser(): AnalyserNode | null {
    return analyser
  }

  // Restart the decode loop when mode changes mid-session — call from a
  // createEffect that depends on the mode signal.
  function restartForModeChange() {
    if (!isRunning) return
    clearTimers()
    sampleBuf = null
    runLoop()
  }

  function destroy() {
    stopRecording()
    uninstallInjectHook()
  }

  return {
    state,
    startRecording,
    stopRecording,
    clearResults,
    getAnalyser,
    restartForModeChange,
    destroy,
    get ftSupported() {
      return FT_SUPPORTED[getMode()]
    },
  }
}

export type FTProcessor = ReturnType<typeof createFTProcessor>
