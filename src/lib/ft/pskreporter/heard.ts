/**
 * "Was my TX heard?" for the FT Sent Log (doc/plans/tx-heard/PLAN.md): PSK
 * Reporter's reception reports of my callsign, matched to the Sent Log rows
 * they belong to, and summed up per row: how many stations heard it, from
 * which countries, and whether the station I called is among them.
 *
 * A report carries no message text, only when, where and in which mode it
 * was decoded, so a report belongs to a row when its window is one of the
 * row's TX windows and its frequency is the row's.
 */
import { callsignCountry } from '../prefixes'
import { gridToLatLon, haversineKm, parseFTMsg } from '../parser'

/** One reception report, as the relay's GET /heard returns it (proxy/pskreporter-worker/src/heard.ts). */
export interface HeardReport {
  rx: string
  grid: string
  hz: number
  /** Start of the decoded window, Unix seconds. */
  t: number
  snr: number | null
  /** PSK Reporter's DXCC name of the receiver, or ''. */
  dxcc: string
  mode: string
}

/** What a Sent Log row needs for matching. */
export interface HeardRow {
  message: string
  mode: 'FT8' | 'FT4'
  /** Start of every TX the row stands for (a repeated message keeps one row), ms epoch. */
  windows: readonly number[]
  vfoHz: number
  audioHz: number
  error?: string
}

export interface HeardStation {
  call: string
  grid: string
  /** Its best SNR of my signal, dB, or null. */
  snr: number | null
  /** Distance from my grid, km, or null. */
  km: number | null
}

export interface HeardCountry {
  /** ISO 3166 code from the callsign prefix, or '' when unknown. */
  cc: string
  flag: string
  name: string
  /** Farthest first. */
  stations: HeardStation[]
}

export interface HeardSummary {
  /** Distinct stations that heard the row (one station hearing five repeats counts once). */
  total: number
  /** The station the row's message was addressed to heard it. */
  calleeHeard: boolean
  /** Most stations first. */
  countries: HeardCountry[]
}

export const FT_WINDOW_MS = { FT8: 15_000, FT4: 7_500 } as const
/** Slack around a TX window for a report's time. Receivers do not agree on
 *  what flowStartSeconds is: for one FT8 TX seen live, one reported the
 *  window start, one its decode time (+12 s), one the next boundary (+15 s);
 *  so a report matches anywhere from the window start to its end, give or take this. */
const WINDOW_SLACK_MS = 3_000
/** How far a report's frequency may sit from the row's: receivers disagree by tens of Hz. */
const FREQ_SLACK_HZ = 150

/** The reports that belong to a row. */
export function reportsForRow(row: HeardRow, reports: readonly HeardReport[]): HeardReport[] {
  if (row.error || !row.windows.length) return []
  const windowMs = FT_WINDOW_MS[row.mode]
  const starts = row.windows.map((w) => Math.floor(w / windowMs) * windowMs)
  const hz = row.vfoHz > 0 ? row.vfoHz + row.audioHz : 0
  return reports.filter((r) =>
    (r.mode === row.mode || r.mode === '') &&
    starts.some((s) => r.t * 1000 >= s - WINDOW_SLACK_MS && r.t * 1000 <= s + windowMs + WINDOW_SLACK_MS) &&
    (!hz || Math.abs(r.hz - hz) <= FREQ_SLACK_HZ))
}

/** A row's reports summed up, or null when nobody heard it. myGrid: for distances, may be ''. */
export function summarize(row: HeardRow, reports: readonly HeardReport[], myGrid: string): HeardSummary | null {
  return summarizeReports(reportsForRow(row, reports), parseFTMsg(row.message).callee?.toUpperCase(), myGrid)
}

/**
 * PSK Reporter keeps one report per receiving station and sender for about
 * 20 minutes (repeats inside that are dropped), so a station that reported my
 * CQ does not report my next transmissions, though it most likely still hears
 * them. For a row nobody reported: the stations that reported me in the 20
 * minutes before it, or null. An inference, shown as such (dimmed).
 */
export const RECENT_MS = 20 * 60_000

export function recentSummary(row: HeardRow, reports: readonly HeardReport[], myGrid: string): HeardSummary | null {
  if (row.error || !row.windows.length || summarize(row, reports, myGrid)) return null
  const latest = Math.max(...row.windows)
  const before = reports.filter((r) => (r.mode === row.mode || r.mode === '') && r.t * 1000 < Math.floor(latest / 1000) * 1000 - WINDOW_SLACK_MS && r.t * 1000 >= latest - RECENT_MS)
  return summarizeReports(before, parseFTMsg(row.message).callee?.toUpperCase(), myGrid)
}

/** The newest report in which `call` heard me (it decoded my signal), or null. */
export function heardYouBy(reports: readonly HeardReport[], call: string): HeardReport | null {
  const up = call.toUpperCase()
  return reports.reduce<HeardReport | null>((best, r) => (r.rx === up && (!best || r.t > best.t) ? r : best), null)
}

function summarizeReports(mine: readonly HeardReport[], callee: string | undefined, myGrid: string): HeardSummary | null {
  if (!mine.length) return null
  const home = myGrid.length >= 4 ? gridToLatLon(myGrid) : null
  const byCall = new Map<string, HeardStation & { dxcc: string }>()
  for (const r of mine) {
    const seen = byCall.get(r.rx)
    if (seen) {
      if (r.snr !== null && (seen.snr === null || r.snr > seen.snr)) seen.snr = r.snr
      continue
    }
    const there = r.grid.length >= 4 ? gridToLatLon(r.grid) : null
    byCall.set(r.rx, { call: r.rx, grid: r.grid, snr: r.snr, km: home && there ? Math.round(haversineKm(home, there)) : null, dxcc: r.dxcc })
  }
  const countries = new Map<string, HeardCountry>()
  for (const s of byCall.values()) {
    const c = callsignCountry(s.call)
    const key = c?.countryCode || s.dxcc || '?'
    let entry = countries.get(key)
    if (!entry) {
      entry = { cc: c?.countryCode ?? '', flag: c?.flag ?? '🏳️', name: c?.country || s.dxcc || 'Unknown', stations: [] }
      countries.set(key, entry)
    }
    entry.stations.push({ call: s.call, grid: s.grid, snr: s.snr, km: s.km })
  }
  for (const c of countries.values()) c.stations.sort((a, b) => (b.km ?? -1) - (a.km ?? -1) || a.call.localeCompare(b.call))
  return {
    total: byCall.size,
    calleeHeard: !!callee && byCall.has(callee),
    countries: [...countries.values()].sort((a, b) => b.stations.length - a.stations.length || a.name.localeCompare(b.name)),
  }
}

/** The station a message is addressed to, in capitals (undefined for a CQ). */
export const parseCallee = (message: string) => parseFTMsg(message).callee?.toUpperCase()

// ── Answers I may have missed ───────────────────────────────────────────────
// A report has no message text, so PSK Reporter cannot say whom a station
// called. But when I called X and, in the very next window (X's turn), other
// stations heard X transmit while my decoder heard nothing from X, X was most
// likely answering me. Only checked for stations I effectively tried to work
// (replyCheckCandidates), and with a separate lookup per station, so few.

/** Calls I addressed in at least this many TX ... */
export const REPLY_CHECK_MIN_ATTEMPTS = 2
/** ... within this long, without decoding them since my first of those. */
export const REPLY_CHECK_WINDOW_MS = 10 * 60_000
/** At most this many such lookups per check. */
export const REPLY_CHECK_MAX = 3

/**
 * The stations worth a reply-slot lookup now, most recently called first:
 * addressed (not CQ) in REPLY_CHECK_MIN_ATTEMPTS+ TX within
 * REPLY_CHECK_WINDOW_MS, and not decoded since the first of them.
 * lastDecodedMs: when my decoder last decoded a transmission of that call (0: never).
 */
export function replyCheckCandidates(rows: readonly HeardRow[], lastDecodedMs: (call: string) => number, nowMs: number): string[] {
  const tries = new Map<string, number[]>()
  for (const r of rows) {
    if (r.error) continue
    const callee = parseCallee(r.message)
    if (!callee || callee === 'CQ' || callee.startsWith('CQ ')) continue
    for (const w of r.windows) if (nowMs - w <= REPLY_CHECK_WINDOW_MS) tries.set(callee, [...(tries.get(callee) ?? []), w])
  }
  return [...tries.entries()]
    .filter(([call, ws]) => ws.length >= REPLY_CHECK_MIN_ATTEMPTS && lastDecodedMs(call) < Math.min(...ws))
    .sort((a, b) => Math.max(...b[1]) - Math.max(...a[1]))
    .slice(0, REPLY_CHECK_MAX)
    .map(([call]) => call)
}

export interface ReplySlotEvidence {
  /** Start of the window after my call in which X was heard, ms epoch. */
  slotMs: number
  /** How many stations heard X then. */
  receivers: number
  /** The one that heard X best. */
  best: HeardReport
}

/**
 * The latest window right after one of my calls to X in which others heard X
 * transmit and my decoder did not: or null. myWindows: when I called X;
 * xReports: reports of X as the sender; decodedMs: when my decoder decoded X.
 */
export function replySlotEvidence(
  myWindows: readonly number[], mode: 'FT8' | 'FT4', xReports: readonly HeardReport[], decodedMs: readonly number[],
): ReplySlotEvidence | null {
  const windowMs = FT_WINDOW_MS[mode]
  let found: ReplySlotEvidence | null = null
  for (const w of myWindows) {
    const slot = Math.floor(w / windowMs) * windowMs + windowMs
    const inSlot = (ms: number) => ms >= slot - WINDOW_SLACK_MS && ms <= slot + windowMs + WINDOW_SLACK_MS
    if (decodedMs.some((d) => d >= slot - WINDOW_SLACK_MS && d < slot + windowMs)) continue // I heard X then
    const heard = xReports.filter((r) => (r.mode === mode || r.mode === '') && inSlot(r.t * 1000))
    if (!heard.length || (found && found.slotMs >= slot)) continue
    const best = heard.reduce((a, b) => ((b.snr ?? -99) > (a.snr ?? -99) ? b : a))
    found = { slotMs: slot, receivers: new Set(heard.map((r) => r.rx)).size, best }
  }
  return found
}
