// One station on the bridge's LCD (doc/plans/lcd-client-views/PLAN.md), picked
// from its contact card: to keep an eye on it while it works others or me.
// Drawn into the 84 x 39 area under the title bar (which shows the call).
//
//   GF05 AR          -14 2M    grid, country; its last SNR as I heard it, how long ago
//   GRID > [RPT] > R-RPT       my QSO with it: the step before, the one reached, the next (blinking),
//                              out of CQ GRID RPT R-RPT RR73 73; or NO QSO WITH ME, QSO DONE
//   SENT -14  RCVD -08         the reports
//   ·······················
//   PY2ME LU1ABC R-08          its last two messages
//   CQ LU1ABC GF05

import { QSO_STEPS, type CurrentQso } from '../../ft/conversation'
import type { Contact } from '../../ft/parser'
import { callsignCountry } from '../../ft/prefixes'
import { LCD_BODY_TOP, LCD_W, ON, type Gfx } from '../gfx'

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

  const q = d.exchange
  steps(g, tick, q, y + 7)
  if (q) center(g, `SENT ${fmtReport(q.rstSent)}  RCVD ${fmtReport(q.rstRcvd)}`, y + 15)

  for (let x = 0; x < LCD_W; x += 2) g.px(x, y + 21, ON)
  heard.slice(0, 2).forEach((m, i) => g.tiny(0, y + 24 + i * 6, fit(g, m.raw.toUpperCase(), LCD_W), ON))
  if (!heard.length) g.tiny(0, y + 24, 'NOTHING HEARD FROM IT', ON)
}
