// The FT8/FT4 session view for the bridge's LCD (doc/plans/lcd-client-views/PLAN.md),
// picked from the FT transmit panel, made for unattended operation (auto-CQ and auto-reply on): this session's
// completed QSOs at a glance, drawn into the 84 x 39 area under the title bar.
// Each QSO completing is announced by drawQsoOverlay(), laid over whatever
// view is on the glass (LcdFeed.overlay(), like the bridge's upload overlay).
//
//   ↓ CALLING CQ          ◔    what the station does now; a clock filling up over the TX/RX window
//   12  QSOS SINCE 11:30       this session (since the page opened, local time): completed QSOs (big),
//       7 COUNTRIES            countries worked
//   LU1ABC   -14 -08  11:58    the last two: call, report sent and received, local time
//   K1XX     -10 -12  11:51

import { QSO_STEPS, type QsoActivity } from '../../ft/conversation'
import type { QSORecord } from '../../ft/parser'
import { callsignCountry } from '../../ft/prefixes'
import { OVERLAY_H, OVERLAY_W, OVERLAY_X, OVERLAY_Y } from '../feed'
import { ICONS, LCD_BODY_TOP, LCD_W, OFF, ON, type Gfx } from '../gfx'
import type { DecodeSummary } from '../../ft/decodeSummary'

export interface FtSessionViewData {
  nowMs: number
  /** The mode's slot length, s (15 for FT8, 7.5 for FT4). */
  windowSec: number
  /** The transmitter: armed (running) and what it does now. */
  armed: boolean
  txStatus: 'idle' | 'waiting' | 'playing'
  activity: QsoActivity
  sessionStartMs: number
  /** This session's completed QSOs, newest first (sessionQsos()). */
  session: readonly QSORecord[]
  /** What the decoder hears (lib/ft/decodeSummary.ts): fills the view before the first QSO. */
  decodes?: DecodeSummary | null
}

/** Completed QSOs (reports exchanged both ways) that ended since sinceMs, newest first. */
export function sessionQsos(records: readonly QSORecord[], sinceMs: number): QSORecord[] {
  return records.filter((r) => r.confirmed && r.endMs >= sinceMs).sort((a, b) => b.endMs - a.endMs)
}

const qsoKey = (r: QSORecord) => `${r.callsign}|${r.mode}|${r.startMs}`

/**
 * Notices QSOs completing: update() returns the newest one it has not seen
 * before, once. QSOs already there at the first update are not announced.
 */
export class QsoAnnouncer {
  private seen: Set<string> | null = null

  update(qsos: readonly QSORecord[]): QSORecord | null {
    if (!this.seen) { this.seen = new Set(qsos.map(qsoKey)); return null }
    let fresh: QSORecord | null = null
    for (const r of qsos) {
      const k = qsoKey(r)
      if (this.seen.has(k)) continue
      this.seen.add(k)
      fresh ??= r // the newest, if several at once
    }
    return fresh
  }
}

const fmtReport = (r: number | undefined) =>
  r === undefined || r === -99 ? '--' : `${r >= 0 ? '+' : '-'}${String(Math.abs(Math.round(r))).padStart(2, '0')}`

const hhmm = (ms: number) => {
  const t = new Date(ms)
  return `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`
}

function statusLine(g: Gfx, tick: number, d: FtSessionViewData, y: number): void {
  const q = d.activity.qso
  const text = !d.armed ? 'TX OFF'
    : q && !q.done && !q.movedOn ? `${q.call} ${QSO_STEPS[q.step]}`
    : d.activity.callingCq ? 'CALLING CQ'
    : 'LISTENING'
  if (d.txStatus === 'playing') g.icon(0, y - 1, ICONS.ANTENNA, tick, ON)
  else if (d.armed) g.icon(1, y, ICONS.ARROW_DOWN, 0, ON)
  else g.tiny(1, y + 1, '-', ON)
  g.tiny(9, y + 1, text.slice(0, 16), ON)
  const windowMs = d.windowSec * 1000
  slotClock(g, LCD_W - 7, y, (d.nowMs % windowMs) / windowMs)
  g.hline(0, LCD_W - 1, y + 8, ON)
}

/**
 * The FT window as a clock, 7 x 7 at (x, y): a dial that fills clockwise from
 * 12 o'clock as the window runs (frac 0..1), a step per second in FT8.
 */
export function slotClock(g: Gfx, x: number, y: number, frac: number): void {
  const cx = x + 3, cy = y + 3
  for (let j = 0; j < 7; j++) {
    for (let i = 0; i < 7; i++) {
      const dx = i - 3, dy = j - 3, r2 = dx * dx + dy * dy
      if (r2 > 10) continue // the dial: r = 3 and its corners rounded
      if (r2 >= 7) { g.px(x + i, y + j, ON); continue } // the rim
      // angle from 12 o'clock, clockwise, 0..1
      const a = (Math.atan2(dx, -dy) / (2 * Math.PI) + 1) % 1
      if (r2 === 0 || a < frac) g.px(x + i, y + j, ON)
    }
  }
  g.px(cx, cy, ON)
}

function totals(g: Gfx, d: FtSessionViewData, y: number): void {
  const n = String(Math.min(d.session.length, 999))
  g.big(0, y, n, ON)
  const x = g.bigWidth(n) + 4
  const countries = new Set(d.session.map((r) => callsignCountry(r.callsign)?.countryCode).filter(Boolean)).size
  const since = `SINCE ${hhmm(d.sessionStartMs)}`
  const full = `${d.session.length === 1 ? 'QSO' : 'QSOS'} ${since}`
  g.tiny(x, y + 1, x + g.tinyWidth(full) <= LCD_W ? full : since, ON) // 10+ QSOs: the big number says what it counts
  g.tiny(x, y + 8, `${countries} ${countries === 1 ? 'COUNTRY' : 'COUNTRIES'}`, ON)
}

function lastQsos(g: Gfx, d: FtSessionViewData, y: number): void {
  if (!d.session.length) {
    const s = d.decodes
    if (!s?.recording) { g.tiny(0, y + 3, 'NONE YET THIS SESSION', ON); return }
    // Before the first QSO: how busy the band is, and the newest decode (to me first).
    g.tiny(0, y, `NO QSO YET  HEARD ${s.stations}`, ON)
    const line = s.recent.find((l) => l.toMe) ?? s.recent[0]
    if (line) {
      let t = line.msg.toUpperCase()
      while (t && g.tinyWidth(t) > LCD_W - 2) t = t.slice(0, -1)
      if (line.toMe) { g.fill(0, y + 5, LCD_W, 7, ON); g.tiny(1, y + 6, t, OFF) }
      else g.tiny(0, y + 6, t, ON)
    }
    return
  }
  d.session.slice(0, 2).forEach((r, i) => {
    const ry = y + i * 6
    g.tiny(0, ry, r.callsign.slice(0, 9), ON)
    g.tiny(37, ry, `${fmtReport(r.rstSent)} ${fmtReport(r.rstRcvd)}`, ON)
    const t = hhmm(r.endMs)
    g.tiny(LCD_W - g.tinyWidth(t), ry, t, ON)
  })
}

/** The "QSO n!" overlay for a QSO that just completed, inside the bridge's overlay panel. */
export function drawQsoOverlay(g: Gfx, tick: number, r: QSORecord, count: number): void {
  const x = OVERLAY_X, y = OVERLAY_Y
  g.box(x, y, OVERLAY_W, OVERLAY_H)
  const label = `QSO ${count}!`
  g.pill(x + ((OVERLAY_W - g.tinyWidth(label) - 6) >> 1), y + 3, label, true)
  g.icon(x + 5, y + 3, ICONS.STAR, tick >> 1, ON)
  g.icon(x + OVERLAY_W - 12, y + 3, ICONS.STAR, (tick >> 1) + 1, ON)
  const call = r.callsign.slice(0, 12)
  g.small(x + Math.max(3, (OVERLAY_W - g.smallWidth(call)) >> 1), y + 12, call, ON)
  const where = [r.grid?.slice(0, 4), callsignCountry(r.callsign)?.countryCode?.toUpperCase()].filter(Boolean).join(' ')
  if (where) g.tiny(x + ((OVERLAY_W - g.tinyWidth(where)) >> 1), y + 21, where, ON)
  const rep = `S${fmtReport(r.rstSent)}  R${fmtReport(r.rstRcvd)}`
  g.tiny(x + ((OVERLAY_W - g.tinyWidth(rep)) >> 1), y + 28, rep, ON)
}

/** Draws the session view under the title bar. */
export function drawFtSession(g: Gfx, tick: number, d: FtSessionViewData): void {
  const y = LCD_BODY_TOP + 1
  statusLine(g, tick, d, y)
  totals(g, d, y + 11)
  lastQsos(g, d, y + 27)
}
