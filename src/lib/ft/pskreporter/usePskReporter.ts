/**
 * Wires the spot queue to settings, the network, and the UI.
 *
 * This file reads `import.meta.env`, which @swc/jest cannot compile, so it must
 * stay out of anything a test imports — the same split that exists between
 * analytics.ts and analyticsInit.ts. The logic worth testing lives in
 * ipfix.ts, spotQueue.ts and eligibility.ts, none of which touch the network.
 */
import { createEffect, createSignal, onCleanup, type Accessor } from 'solid-js'
import type { AdmittedDecode } from '../parser'
import type { FTMode } from '../decoder'
import {
  PskSpotQueue,
  clampIntervalMinutes,
  type SendCadence,
  type SpotQueueStatus,
} from './spotQueue'
import { toSpot, type IneligibleReason } from './eligibility'
import { loadPskSettings, savePskSettings } from './settings'
import type { PskReceiver } from './ipfix'

/**
 * Cloudflare Worker that relays reports, because PSK Reporter only listens on
 * a socket a browser cannot open (see proxy/pskreporter-worker/). The URL is
 * not a secret — it is a public endpoint that accepts PSK Reporter packets
 * from this app's origin and nothing else — so it is hard-coded rather than
 * injected, and forks get working reporting without configuring anything.
 * VITE_PSKREPORTER_PROXY_URL overrides it for testing against another relay.
 *
 * `||`, not `??`: GitHub Actions substitutes an UNSET secret as the empty
 * string, so the published bundle saw a DEFINED '' here and `??` passed it
 * straight through. PROXY_URL then fell empty, and the app reported itself
 * blocked with 'no-proxy' — reporting worked in dev (where the variable is
 * genuinely absent, so the default applied) and silently never sent in
 * production. Empty means "not configured", same as absent.
 */
const DEFAULT_PROXY_URL = 'https://pskreporter.signal-decoder.workers.dev'
const PROXY_URL: string = (import.meta.env.VITE_PSKREPORTER_PROXY_URL || DEFAULT_PROXY_URL).replace(/\/+$/, '')

/**
 * How often the queue is asked whether a send is due. Short enough that a
 * window-cadence send is not held up noticeably past its scheduled moment; the
 * check is a couple of comparisons when nothing is due.
 */
const TICK_MS = 3_000

/** Why nothing is being reported right now; null means reporting is live. */
export type ReporterBlocked =
  | 'disabled'
  | 'no-proxy'
  | 'no-callsign'
  | 'no-grid'
  | 'no-frequency'
  | null

export interface ReporterStatus extends SpotQueueStatus {
  blocked: ReporterBlocked
}

export interface PskReporter {
  enabled: Accessor<boolean>
  setEnabled(value: boolean): void
  antenna: Accessor<string>
  setAntenna(value: string): void
  cadenceMode: Accessor<SendCadence['mode']>
  setCadenceMode(value: SendCadence['mode']): void
  intervalMinutes: Accessor<number>
  setIntervalMinutes(value: number): void
  /** Call when a decode window finishes; only acted on in window cadence. */
  notifyWindowComplete(): void
  status: Accessor<ReporterStatus>
  /** True when the proxy is configured at all — false in forks and dev. */
  available: boolean
  /** Offers one window's admitted decodes to the queue. */
  report(admitted: AdmittedDecode[], mode: FTMode): void
}

export interface PskReporterOptions {
  myCall: Accessor<string | undefined>
  myGrid: Accessor<string | undefined>
}

async function postPacket(packet: Uint8Array): Promise<void> {
  const res = await fetch(`${PROXY_URL}/report`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    // Copied into a fresh buffer: the queue keeps no reference, but fetch
    // must not be handed a view that could be reused.
    body: new Uint8Array(packet).buffer as ArrayBuffer,
  })
  if (!res.ok) throw new Error(`proxy ${res.status}: ${(await res.text()).trim().slice(0, 120)}`)
}

export function createPskReporter(opts: PskReporterOptions): PskReporter {
  const stored = loadPskSettings()
  const [enabled, setEnabledSignal] = createSignal(stored.enabled)
  const [antenna, setAntennaSignal] = createSignal(stored.antenna)
  const [cadenceMode, setCadenceModeSignal] = createSignal<SendCadence['mode']>(stored.cadenceMode)
  const [intervalMinutes, setIntervalMinutesSignal] = createSignal(stored.intervalMinutes)
  const [status, setStatus] = createSignal<ReporterStatus>({
    pending: 0,
    lastSentAt: null,
    lastSpotCount: 0,
    totalSpotsSent: 0,
    lastError: null,
    blocked: 'disabled',
  })

  /** Set when a window produced decodes but none could be reported. */
  let lastIneligible: IneligibleReason | null = null

  const callsign = () => (opts.myCall() ?? '').trim().toUpperCase()
  const locator = () => (opts.myGrid() ?? '').trim().toUpperCase()

  function blockedReason(): ReporterBlocked {
    if (!enabled()) return 'disabled'
    if (!PROXY_URL) return 'no-proxy'
    if (!callsign()) return 'no-callsign'
    if (!locator()) return 'no-grid'
    if (lastIneligible === 'frequency') return 'no-frequency'
    return null
  }

  function receiver(): PskReceiver | null {
    if (blockedReason() !== null && blockedReason() !== 'no-frequency') return null
    return {
      callsign: callsign(),
      locator: locator(),
      decoderSoftware: `Signal-Decoder ${__APP_VERSION__}`,
      antenna: antenna().trim() || undefined,
    }
  }

  const queue = new PskSpotQueue({
    send: postPacket,
    receiver,
    sessionId: stored.sessionId,
    cadence: (): SendCadence =>
      cadenceMode() === 'window' ? { mode: 'window' } : { mode: 'interval', minutes: intervalMinutes() },
  })

  function refreshStatus(): void {
    setStatus({ ...queue.status(), blocked: blockedReason() })
  }

  function persist(): void {
    savePskSettings({
      enabled: enabled(),
      antenna: antenna(),
      cadenceMode: cadenceMode(),
      intervalMinutes: intervalMinutes(),
      sessionId: stored.sessionId,
    })
  }

  createEffect(() => {
    // Read every setting so an edit to any of them persists.
    enabled()
    antenna()
    cadenceMode()
    intervalMinutes()
    persist()
  })

  const timer = setInterval(() => {
    if (!enabled()) return
    void queue.flushIfDue().finally(refreshStatus)
  }, TICK_MS)
  onCleanup(() => clearInterval(timer))

  return {
    enabled,
    antenna,
    available: Boolean(PROXY_URL),
    setEnabled(value: boolean) {
      setEnabledSignal(value)
      if (!value) queue.reset()
      lastIneligible = null
      refreshStatus()
    },
    setAntenna(value: string) {
      setAntennaSignal(value)
    },
    cadenceMode,
    setCadenceMode(value: SendCadence['mode']) {
      setCadenceModeSignal(value)
    },
    intervalMinutes,
    setIntervalMinutes(value: number) {
      setIntervalMinutesSignal(clampIntervalMinutes(value))
    },
    notifyWindowComplete() {
      if (!enabled()) return
      queue.notifyWindowComplete()
    },
    status,
    report(admitted: AdmittedDecode[], mode: FTMode) {
      if (!enabled() || admitted.length === 0) return
      if (blockedReason() !== null && blockedReason() !== 'no-frequency') return

      let queued = 0
      let reason: IneligibleReason | null = null
      for (const decode of admitted) {
        const result = toSpot(decode, mode, callsign())
        if (!result.ok) {
          // 'self' is routine and says nothing about configuration.
          if (result.reason !== 'self') reason ??= result.reason
          continue
        }
        if (queue.offer(result.spot) === 'queued') queued++
      }
      lastIneligible = queued > 0 ? null : reason
      refreshStatus()
    },
  }
}
