// Port of src/hooks/useFTProcessor.ts (Next.js app) — captures audio in
// UTC-aligned windows and streams decode results as they're found. Kept
// close to the original's imperative timing logic verbatim (the comments
// explaining drift-correction/rollover are load-bearing, not stylistic).
import { createSignal } from 'solid-js'
import { type FTDecodeResult, type FTMessage, type FTMode, FT_WINDOW_SECONDS, FT_SUPPORTED, decodeFTAudio } from '$decoder-lib/ft/decoder'
import { createCaptureNode, type CaptureNode } from '$decoder-lib/audio/captureNode'

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
// so nothing is lost, and results land ~2s sooner. Kept under the real
// silence gap (not right at 2.3-2.5s) so a slightly late-starting or
// slightly-longer-than-nominal transmission doesn't get truncated.
const EARLY_DECODE_MS = 2000

function msUntilNextWindow(windowSec: number): number {
  const totalMs = windowSec * 1000
  const now = new Date()
  const elapsed = (now.getSeconds() * 1000 + now.getMilliseconds()) % totalMs
  return elapsed < 50 ? 0 : totalMs - elapsed
}

export function createFTProcessor(getMode: () => FTMode) {
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
  let stream: MediaStream | null = null
  let processorNode: CaptureNode | null = null
  let sampleBuf: Float32Array | null = null
  let sampleCount = 0
  let windowStart: Date | null = null
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
      if (!sampleBuf || sampleBuf.length !== capacity) {
        sampleBuf = new Float32Array(capacity)
        sampleCount = 0
        windowStart = new Date()
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
      // Wake up EARLY_DECODE_MS before the real boundary and decode whatever
      // has accumulated so far — a real transmission has already finished by
      // then (see EARLY_DECODE_MS comment), so this loses nothing but the
      // trailing silence. Too-short windows (or a loop that's arming more
      // than EARLY_DECODE_MS late) fall back to the old boundary-exact wake.
      const earlyMs = toBoundaryMs - EARLY_DECODE_MS
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
        await sleep(EARLY_DECODE_MS)
        if (!isRunning) break
        setState((prev) => ({ ...prev, status: 'recording' }))
      }

      const nowMs = Date.now()
      const sinceBoundary = nowMs % windowMs
      const total = sampleCount
      const tailSamples = sinceBoundary > 50 && sinceBoundary < windowMs / 2 ? Math.min(Math.round((sinceBoundary / 1000) * sampleRate), total) : 0
      if (sinceBoundary > 300 && sinceBoundary < windowMs - 300) {
        console.debug(`[ft] window rollover ${sinceBoundary} ms after the UTC boundary — carrying ${tailSamples} samples into the next window`)
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
    try {
      if (!state().isSupported) throw new Error('Web Audio API not supported')

      const mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      })
      stream = mediaStream

      const ctx = new AudioContext()
      audioContext = ctx

      const source = ctx.createMediaStreamSource(mediaStream)
      const analyserNode = ctx.createAnalyser()
      analyserNode.fftSize = 4096
      analyser = analyserNode
      source.connect(analyserNode)

      // AudioWorkletNode's capture runs on the audio thread, not the main
      // thread — unlike the old ScriptProcessorNode, dropped/delayed
      // samples here directly cost decodable FT8 windows, so this is the
      // most consequential of this app's several ScriptProcessorNode->
      // AudioWorklet migration sites.
      const proc = await createCaptureNode(ctx, 4096, (input) => {
        const buf = sampleBuf
        if (!buf) return
        const space = buf.length - sampleCount
        const copy = Math.min(input.length, space)
        buf.set(input.subarray(0, copy), sampleCount)
        sampleCount += copy
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
    isRunning = false
    clearTimers()
    stream?.getTracks().forEach((t) => t.stop())
    stream = null
    sampleBuf = null
    if (processorNode) {
      processorNode.disconnect()
      processorNode = null
    }
    if (analyser) {
      analyser.disconnect()
      analyser = null
    }
    if (audioContext) {
      audioContext.close()
      audioContext = null
    }
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
