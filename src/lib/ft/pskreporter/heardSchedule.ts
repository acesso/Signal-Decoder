/**
 * When the Sent Log asks PSK Reporter (through the relay's GET /heard) who
 * heard my transmissions (doc/plans/tx-heard/PLAN.md). PSK Reporter asks for
 * "no more often than once every five minutes", a few minutes after a TX so
 * the receivers have reported; this follows that, and asks nothing at all
 * while no recent TX is waiting for reports.
 *
 * Pure: the wiring (useHeard.ts) passes the clock and the stored state, which
 * every tab shares through localStorage, so several tabs still ask once.
 */
import type { HeardReport } from './heard'

/** At most one check per this long, whatever the number of tabs. */
export const HEARD_MIN_GAP_MS = 5 * 60_000
/** The first check for a TX waits this long: receivers upload every few minutes. */
export const HEARD_FIRST_AFTER_MS = 2 * 60_000
/** A TX is followed this long; after that its row is settled and never asked about. */
export const HEARD_FOLLOW_MS = 30 * 60_000
/** Wait after 1, 2, 3, 4+ failures in a row. */
export const HEARD_BACKOFF_MS = [5, 10, 20, 60].map((m) => m * 60_000)

/** What every tab shares (localStorage). */
export interface HeardShared {
  /** The callsign the reports are for. */
  call: string
  /** Last check started, ms epoch (set before asking, so other tabs hold off). */
  askedAt: number
  /** Failures in a row since the last success. */
  failures: number
  /** Last successful answer, ms epoch, or 0. */
  okAt: number
  reports: HeardReport[]
  /** Reports of other stations as the sender (heard.ts replyCheckCandidates), by their call. */
  peers: Record<string, { okAt: number; reports: HeardReport[] }>
}

export const emptyShared = (call: string): HeardShared => ({ call, askedAt: 0, failures: 0, okAt: 0, reports: [], peers: {} })

/** TX windows still followed, at nowMs. */
export function openWindows(windows: readonly number[], nowMs: number): number[] {
  return windows.filter((w) => nowMs - w <= HEARD_FOLLOW_MS && w <= nowMs)
}

/**
 * When the next check is due (ms epoch), or null when no TX is waiting for
 * reports. windows: the start of every TX in the Sent Log.
 */
export function nextCheckAt(windows: readonly number[], shared: HeardShared, nowMs: number): number | null {
  const open = openWindows(windows, nowMs)
  if (!open.length) return null
  const firstUseful = Math.min(...open) + HEARD_FIRST_AFTER_MS
  const gap = shared.failures > 0 ? HEARD_BACKOFF_MS[Math.min(shared.failures, HEARD_BACKOFF_MS.length) - 1] : HEARD_MIN_GAP_MS
  return Math.max(firstUseful, shared.askedAt + gap)
}

/** Reads the shared state for this callsign; anything else (another call, garbage) starts fresh. */
export function readShared(raw: string | null, call: string): HeardShared {
  try {
    const v = raw ? (JSON.parse(raw) as Partial<HeardShared>) : null
    if (!v || v.call !== call || !Array.isArray(v.reports)) return emptyShared(call)
    return {
      call,
      askedAt: Number(v.askedAt) || 0,
      failures: Number(v.failures) || 0,
      okAt: Number(v.okAt) || 0,
      reports: v.reports,
      peers: v.peers && typeof v.peers === 'object' ? v.peers : {},
    }
  } catch {
    return emptyShared(call)
  }
}

/** Keeps reports for this long: nothing older can match a followed TX. */
export const HEARD_KEEP_MS = HEARD_FOLLOW_MS + 15 * 60_000

/** New reports merged into the old ones (same receiver, window and frequency once), old ones dropped. */
export function mergeReports(
  old: readonly HeardReport[],
  fresh: readonly HeardReport[],
  nowMs: number,
): HeardReport[] {
  const keepFrom = (nowMs - HEARD_KEEP_MS) / 1000
  const out = new Map<string, HeardReport>()
  for (const r of [...old, ...fresh]) if (r.t >= keepFrom) out.set(`${r.rx}|${r.t}|${r.hz}`, r)
  return [...out.values()]
}

/** Peers whose reports are older than this are dropped from the shared state. */
const PEER_KEEP_MS = 15 * 60_000

/** The shared state with one peer's fresh reports, and peers gone stale dropped. */
export function withPeer(s: HeardShared, call: string, reports: readonly HeardReport[], nowMs: number): HeardShared {
  const peers: HeardShared['peers'] = {}
  for (const [c, p] of Object.entries(s.peers)) if (nowMs - p.okAt <= PEER_KEEP_MS) peers[c] = p
  peers[call] = { okAt: nowMs, reports: mergeReports(peers[call]?.reports ?? [], reports, nowMs) }
  return { ...s, peers }
}
