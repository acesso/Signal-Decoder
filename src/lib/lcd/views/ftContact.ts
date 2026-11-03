// One station on the bridge's LCD (doc/plans/lcd-client-views/PLAN.md), picked
// from its contact card: to keep an eye on it while it works others or me.
// Drawn into the 84 x 39 area under the title bar (which shows the call).
//
//   GF05 AR          -14 2M    grid, country; its last SNR as I heard it, how long ago
//   ⏚42        ↓3              what I decoded of it: its transmissions and the times it was called;
//                              an icon animates as its count rises
//   GRID > [RPT] > R-RPT       my QSO with it: the step before, the one reached, the next (blinking),
//                              out of CQ GRID RPT R-RPT RR73 73; or NO QSO WITH ME, QSO DONE,
//                              or MOVED ON (GRID): no reply since my last call, it works others
//   SENT -14  RCVD -08         the reports
//   ·······················
//   PY2ME LU1ABC R-08          its last different messages, two (one in a QSO with me; a repeat: X2)
//   CQ LU1ABC GF05 X3

import { QSO_STEPS, type CurrentQso } from '../../ft/conversation'
import type { Contact } from '../../ft/parser'
import { callsignCountry } from '../../ft/prefixes'
import { ICONS, LCD_BODY_TOP, LCD_W, ON, type Gfx } from '../gfx'

export interface FtContactViewData {
  nowMs: number
  /** The station, in capitals. */
  call: string
  /** What I have heard from it (undefined: not heard, or gone from the contact list). */
  contact?: Contact
  /** My exchange with it (exchangeWith()), or null. */
  exchange: CurrentQso | null
}

const fmtReport = (r: number | undefined) =>
  r === undefined || r === -99 ? '--' : `${r >= 0 ? '+' : '-'}${String(Math.abs(Math.round(r))).padStart(2, '0')}`

/** How long ago, short: 45S, 12M, 3H, 2D. */
export function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 60 ? `${s}S` : s < 3600 ? `${Math.floor(s / 60)}M` : s < 86400 ? `${Math.floor(s / 3600)}H` : `${Math.floor(s / 86400)}D`
}

/** The text cut to fit w pixels in the tiny font. */
function fit(g: Gfx, text: string, w: number): string {
  let t = text
  while (t && g.tinyWidth(t) > w) t = t.slice(0, -1)
  return t
}

// Where the QSO is, in words: the step before, the step reached (filled), the
// next one (outlined, blinking): "GRID › [RPT] › R-RPT".
function steps(g: Gfx, tick: number, q: CurrentQso | null, y: number): void {
  if (!q) { center(g, 'NO QSO WITH ME', y + 1); return }
  if (q.done) { center(g, `QSO DONE (${QSO_STEPS[q.step]})`, y + 1); return }
  if (q.movedOn) { center(g, `MOVED ON (${QSO_STEPS[q.step]})`, y + 1); return }
  const parts: { text: string; style: 'prev' | 'now' | 'next' }[] = []
  if (q.step > 0) parts.push({ text: QSO_STEPS[q.step - 1], style: 'prev' })
  parts.push({ text: QSO_STEPS[q.step], style: 'now' })
  if (q.step + 1 < QSO_STEPS.length) parts.push({ text: QSO_STEPS[q.step + 1], style: 'next' })
  const ARROW = 7
  const width = (p: { text: string; style: string }) => (p.style === 'prev' ? g.tinyWidth(p.text) : g.tinyWidth(p.text) + 6)
  let x = (LCD_W - parts.reduce((w, p) => w + width(p), 0) - ARROW * (parts.length - 1)) >> 1
  parts.forEach((p, i) => {
    if (i) { g.tiny(x + 2, y + 1, '>', ON); x += ARROW }
    if (p.style === 'prev') g.tiny(x, y + 1, p.text, ON)
    else if (p.style === 'now') g.pill(x, y, p.text, true)
    else if (tick % 4 < 2) g.pill(x, y, p.text, false)
    x += width(p)
  })
}

function center(g: Gfx, text: string, y: number): void {
  g.tiny((LCD_W - g.tinyWidth(text)) >> 1, y, text, ON)
}

export interface ContactCounts {
  /** Its transmissions I decoded. */
  tx: number
  /** Times others called it. */
  rx: number
}

/** The contact card's tx and rx counters, from what I decoded of the station. */
export function contactCounts(c: Contact): ContactCounts {
  let tx = 0
  for (const m of c.msgs) if (m.role === 'tx') tx++
  return { tx, rx: c.msgs.length - tx }
}

/** How long an icon animates after its count rises. */
const RISE_MS = 2_000
// Last counts seen per station, and when each last rose (one LCD view per station).
const seen = new Map<string, { counts: ContactCounts; rose: Record<keyof ContactCounts, number> }>()

function counters(g: Gfx, tick: number, call: string, counts: ContactCounts, nowMs: number, y: number): void {
  let s = seen.get(call)
  if (!s) { s = { counts, rose: { tx: 0, rx: 0 } }; seen.set(call, s) } // first sight: no animation
  for (const k of ['tx', 'rx'] as const) if (counts[k] > s.counts[k]) s.rose[k] = nowMs
  s.counts = counts
  const items = [
    { k: 'tx' as const, icon: ICONS.ANTENNA, x: 0 },
    { k: 'rx' as const, icon: ICONS.ARROW_DOWN, x: 42 },
  ]
  for (const it of items) {
    const live = nowMs - s.rose[it.k] < RISE_MS
    // Rising: the icon runs its frames and hops; the number blinks inverted.
    const frame = live ? tick : it.icon.frames - 1 // at rest, its fullest frame (the antenna radiating)
    const hop = live && it.icon.frames === 1 ? (tick % 2) : 0
    g.icon(it.x + (it.icon.w < 7 ? 1 : 0), y - hop, it.icon, frame, ON)
    const n = String(Math.min(counts[it.k], 999))
    if (live && tick % 2 === 0) g.pill(it.x + 8, y, n, true)
    else g.tiny(it.x + 9, y + 1, n, ON)
  }
}

/** Draws the contact view under the title bar. */
export function drawFtContact(g: Gfx, tick: number, d: FtContactViewData): void {
  const y = LCD_BODY_TOP + 1
  const c = d.contact
  if (!c && !d.exchange) {
    const t = 'NOT HEARD YET'
    g.tiny((LCD_W - g.tinyWidth(t)) >> 1, y + 14, t, ON)
    return
  }

  const heard = c ? [...c.msgs].filter((m) => m.role === 'tx').sort((a, b) => b.windowStart.getTime() - a.windowStart.getTime()) : []
  const where = [c?.grid?.slice(0, 4), callsignCountry(d.call)?.countryCode?.toUpperCase()].filter(Boolean).join(' ')
  const right = heard.length ? `${fmtReport(heard[0].snr)} ${ago(d.nowMs - heard[0].windowStart.getTime())}` : ''
  g.tiny(0, y, fit(g, where, LCD_W - g.tinyWidth(right) - 4), ON)
  g.tiny(LCD_W - g.tinyWidth(right), y, right, ON)

  if (c) counters(g, tick, d.call, contactCounts(c), d.nowMs, y + 7)

  const q = d.exchange
  steps(g, tick, q, y + 15)
  if (q) center(g, `SENT ${fmtReport(q.rstSent)}  RCVD ${fmtReport(q.rstRcvd)}`, y + 23)
  const rule = q ? y + 29 : y + 22
  for (let x = 0; x < LCD_W; x += 2) g.px(x, rule, ON)
  const maxLines = q ? 1 : 2
  // Its last two different messages, newest first; a message repeated in a
  // row (a CQ every other window) is one line with its count.
  const lines: { raw: string; n: number }[] = []
  for (const m of heard) {
    const raw = m.raw.toUpperCase()
    if (lines.length && lines[lines.length - 1].raw === raw) lines[lines.length - 1].n++
    else if (lines.length < maxLines) lines.push({ raw, n: 1 })
    else break
  }
  lines.forEach((l, i) => {
    const count = l.n > 1 ? ` X${l.n}` : ''
    const y1 = rule + 3 + i * 6
    g.tiny(0, y1, fit(g, l.raw, LCD_W - g.tinyWidth(count)), ON)
    if (count) g.tiny(LCD_W - g.tinyWidth(count), y1, count, ON)
  })
  if (!heard.length) g.tiny(0, rule + 3, 'NOTHING HEARD FROM IT', ON)
}
