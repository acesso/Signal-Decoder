/**
 * Wires "was my TX heard?" (doc/plans/tx-heard/PLAN.md) to the network and
 * the Sent Log: asks the relay's GET /heard when heardSchedule.ts says a
 * check is due, keeps the reports every tab shares in localStorage, and
 * sums them up per Sent Log row (heard.ts).
 *
 * Reads import.meta.env (through usePskReporter.ts), so tests stay with the
 * pure modules, as for usePskReporter.ts.
 */
import { createEffect, createMemo, createRoot, createSignal, onCleanup, type Accessor } from 'solid-js'
import type { Contact } from '../parser'
import type { SentEntry } from '../useFTTransmit'
import {
  heardYouBy, recentSummary, replyCheckCandidates, replySlotEvidence, summarize, parseCallee,
  type HeardReport, type HeardRow, type HeardSummary, type ReplySlotEvidence,
} from './heard'
import { HEARD_FIRST_AFTER_MS, HEARD_MIN_GAP_MS, emptyShared, mergeReports, nextCheckAt, readShared, withPeer, type HeardShared } from './heardSchedule'
import { heardChecks } from './heardSettings'
import { PROXY_URL } from './usePskReporter'

const LS_KEY = 'psk_heard_v1'
/** How often the schedule is looked at; a check itself is minutes apart. */
const TICK_MS = 15_000
const TIMEOUT_MS = 10_000

const HEARD_URL = import.meta.env.DEV ? '/__psk/heard' : `${PROXY_URL}/heard`

export interface HeardStatus {
  /** Last successful check, ms epoch, or 0. */
  okAt: number
  /** Next check (ms epoch), or null when no TX is waiting for reports. */
  nextAt: number | null
  /** The last check failed (and later ones wait longer). */
  failing: boolean
}

export interface Heard {
  /** The row's summary, or null when nobody has reported it (yet). */
  summary(entry: SentEntry): HeardSummary | null
  /** For a row nobody reported: who reported me in the 20 minutes before it (heard.ts recentSummary),
   *  once a check has run late enough to have seen this row's own reports. */
  recent(entry: SentEntry): HeardSummary | null
  /** The row has had no check yet that could see its reports: when the next one is due, else null. */
  pendingUntil(entry: SentEntry): number | null
  status: Accessor<HeardStatus>
  enabled: Accessor<boolean>
}

function load(call: string): HeardShared {
  try { return readShared(localStorage.getItem(LS_KEY), call) } catch { return emptyShared(call) }
}

function save(s: HeardShared): void {
  try { localStorage.setItem(LS_KEY, JSON.stringify(s)) } catch { /* full or blocked: this tab still has it */ }
}

const rowWindows = (e: SentEntry) => e.windows ?? (e.error ? [] : [e.windowStart.getTime()])
const toRow = (e: SentEntry): HeardRow | null =>
  e.mode ? { message: e.message, mode: e.mode, windows: rowWindows(e), vfoHz: e.vfoHz, audioHz: e.audioHz, error: e.error } : null

/** When my decoder decoded transmissions of a station, ms epoch. */
const decodedMs = (c: Contact | undefined) => (c ? c.msgs.filter((m) => m.role === 'tx').map((m) => m.windowStart.getTime()) : [])

// What the contact cards read (heardNoteFor): one page, one Sent Log, so a
// module-level signal set by the transmit panel's createHeard.
interface HeardContext { reports: HeardReport[]; peers: HeardShared['peers']; rows: HeardRow[] }
const [context, setContext] = createRoot(() => createSignal<HeardContext | null>(null))

export interface HeardNote {
  /** The station reported hearing me: its newest report. */
  heardYou: HeardReport | null
  /** Others heard it in my reply slot while I decoded nothing from it. */
  replySlot: ReplySlotEvidence | null
}

/** What PSK Reporter says about my exchange with this station, or null. */
export function heardNoteFor(contact: Contact): HeardNote | null {
  const ctx = context()
  if (!ctx) return null
  const call = contact.callsign.toUpperCase()
  const heardYou = heardYouBy(ctx.reports, call)
  let replySlot: ReplySlotEvidence | null = null
  const peer = ctx.peers[call]
  if (peer?.reports.length) {
    const mine = ctx.rows.filter((r) => !r.error && parseCallee(r.message) === call)
    for (const mode of ['FT8', 'FT4'] as const) {
      const ws = mine.filter((r) => r.mode === mode).flatMap((r) => r.windows)
      const ev = ws.length ? replySlotEvidence(ws, mode, peer.reports, decodedMs(contact)) : null
      if (ev && (!replySlot || ev.slotMs > replySlot.slotMs)) replySlot = ev
    }
  }
  return heardYou || replySlot ? { heardYou, replySlot } : null
}

export function createHeard(opts: {
  myCall: Accessor<string>
  myGrid: Accessor<string>
  sent: Accessor<SentEntry[]>
  /** The decoder's contacts: who I decoded, for the reply-slot check. */
  contacts?: Accessor<ReadonlyMap<string, Contact>>
}): Heard {
  const call = () => opts.myCall().trim().toUpperCase()
  const [shared, setShared] = createSignal<HeardShared>(load(call()))
  const [now, setNow] = createSignal(Date.now())
  let busy = false

  // Another tab asked: take its answer.
  const onStorage = (ev: StorageEvent) => { if (ev.key === LS_KEY) setShared(load(call())) }
  window.addEventListener('storage', onStorage)

  async function check(c: string): Promise<void> {
    busy = true
    // Claim the check first, so other tabs hold off meanwhile.
    const before = { ...load(c), askedAt: Date.now() }
    save(before)
    setShared(before)
    try {
      const res = await fetch(`${HEARD_URL}?call=${encodeURIComponent(c)}`, { signal: AbortSignal.timeout(TIMEOUT_MS) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const body = (await res.json()) as { reports?: HeardReport[] }
      const cur = load(c)
      const next = { ...cur, failures: 0, okAt: Date.now(), reports: mergeReports(cur.reports, body.reports ?? [], Date.now()) }
      save(next)
      setShared(next)
      await checkPeers(c)
    } catch {
      const cur = load(c)
      const next = { ...cur, failures: cur.failures + 1 }
      save(next)
      setShared(next)
    } finally {
      busy = false
    }
  }

  // Answers I may have missed: one lookup per station I kept calling without
  // hearing it (heard.ts replyCheckCandidates, at most 3), only right after a
  // successful check of my own call, so never more often than that.
  async function checkPeers(c: string): Promise<void> {
    const contacts = opts.contacts?.()
    if (!contacts) return
    const byCall = new Map([...contacts.values()].map((x) => [x.callsign.toUpperCase(), x]))
    const rows = opts.sent().map(toRow).filter((r): r is HeardRow => r !== null)
    const last = (call: string) => Math.max(0, ...decodedMs(byCall.get(call)))
    for (const peer of replyCheckCandidates(rows, last, Date.now())) {
      if (Date.now() - (load(c).peers[peer]?.okAt ?? 0) < HEARD_MIN_GAP_MS) continue
      try {
        const res = await fetch(`${HEARD_URL}?call=${encodeURIComponent(peer)}`, { signal: AbortSignal.timeout(TIMEOUT_MS) })
        if (!res.ok) return // the relay is struggling: leave the rest for the next check
        const body = (await res.json()) as { reports?: HeardReport[] }
        const next = withPeer(load(c), peer, body.reports ?? [], Date.now())
        save(next)
        setShared(next)
      } catch {
        return
      }
    }
  }

  const windows = createMemo(() => opts.sent().flatMap((e) => (e.mode ? rowWindows(e) : [])))
  const due = createMemo(() => {
    const c = call()
    if (!heardChecks() || !c) return null
    const s = shared().call === c ? shared() : emptyShared(c)
    return nextCheckAt(windows(), s, now())
  })

  const timer = setInterval(() => {
    setNow(Date.now())
    const c = call()
    if (shared().call !== c) setShared(load(c))
    const at = due()
    if (busy || at === null || Date.now() < at || document.visibilityState !== 'visible') return
    void check(c)
  }, TICK_MS)
  onCleanup(() => {
    clearInterval(timer)
    window.removeEventListener('storage', onStorage)
  })

  const summaries = createMemo(() => {
    const out = new Map<SentEntry, HeardSummary | null>()
    if (!heardChecks()) return out
    const reports = shared().call === call() ? shared().reports : []
    if (!reports.length) return out
    for (const e of opts.sent()) {
      if (!e.mode) continue
      out.set(e, summarize({ message: e.message, mode: e.mode, windows: rowWindows(e), vfoHz: e.vfoHz, audioHz: e.audioHz, error: e.error }, reports, opts.myGrid()))
    }
    return out
  })

  // A successful check HEARD_FIRST_AFTER_MS or more after the row's last TX
  // could have seen that TX reported; before that, "nobody reported it" means nothing yet.
  const checkedAfter = (row: HeardRow) =>
    row.windows.length > 0 && shared().okAt >= Math.max(...row.windows) + HEARD_FIRST_AFTER_MS

  const recents = createMemo(() => {
    const out = new Map<SentEntry, HeardSummary | null>()
    const reports = heardChecks() && shared().call === call() ? shared().reports : []
    if (!reports.length) return out
    for (const e of opts.sent()) {
      const row = toRow(e)
      if (row && checkedAfter(row)) out.set(e, recentSummary(row, reports, opts.myGrid()))
    }
    return out
  })

  createEffect(() => {
    const own = shared().call === call()
    setContext(heardChecks() && own
      ? { reports: shared().reports, peers: shared().peers, rows: opts.sent().map(toRow).filter((r): r is HeardRow => r !== null) }
      : null)
  })
  onCleanup(() => setContext(null))

  return {
    summary: (e) => summaries().get(e) ?? null,
    recent: (e) => recents().get(e) ?? null,
    pendingUntil: (e) => {
      if (!heardChecks()) return null
      const row = toRow(e)
      if (!row || row.error || !row.windows.length || checkedAfter(row) || summaries().get(e)) return null
      if (now() - Math.max(...row.windows) > 30 * 60_000) return null
      return due()
    },
    status: () => ({ okAt: shared().okAt, nextAt: due(), failing: shared().failures > 0 }),
    enabled: heardChecks,
  }
}
