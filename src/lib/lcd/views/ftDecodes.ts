// The FT decoder on the bridge's LCD (doc/plans/lcd-client-views/PLAN.md),
// picked from the Decoded Messages panel: what the decoder is doing and what
// it heard last, drawn into the 84 x 39 area under the title bar.
//
//   21 DEC 1.2S  15 STN    ◔    the newest window: messages, decode time;
//   ·······················         stations heard (10 min); the window clock
//   CQ PP5NK GG53       -15     the newest messages, newest window first,
//   ▌PU7FTW K1ABC -08    -9▐    strongest first; a message to me inverted
//   EA4AB W4PSK EL98    -18
//   CQ DX R2SL KO94     -21

import type { DecodeSummary } from '../../ft/decodeSummary'
import { LCD_BODY_TOP, LCD_W, ON, OFF, type Gfx } from '../gfx'
import { slotClock } from './ftSession'

export interface FtDecodesViewData {
  nowMs: number
  windowSec: number
  summary: DecodeSummary | null
}

const ROWS = 4

function fit(g: Gfx, text: string, w: number): string {
  let t = text
  while (t && g.tinyWidth(t) > w) t = t.slice(0, -1)
  return t
}

const fmtSnr = (snr: number) => { const r = Math.round(snr); return `${r >= 0 ? '+' : '-'}${String(Math.abs(r)).padStart(2, '0')}` }

export function drawFtDecodes(g: Gfx, tick: number, d: FtDecodesViewData): void {
  const y = LCD_BODY_TOP + 1
  const s = d.summary
  slotClock(g, LCD_W - 7, y, (d.nowMs % (d.windowSec * 1000)) / (d.windowSec * 1000))
  let head: string
  if (!s || !s.recording) head = 'DECODER OFF'
  else if (s.decoding && tick % 4 < 2) head = 'DECODING'
  else if (!s.last) head = 'LISTENING'
  else head = `${s.last.count} DEC ${(s.last.decodeMs / 1000).toFixed(1)}S  ${s.stations} STN`
  g.tiny(0, y + 1, fit(g, head, LCD_W - 10), ON)
  for (let x = 0; x < LCD_W; x += 2) g.px(x, y + 8, ON)

  const lines = s?.recent ?? []
  if (!lines.length) { const t = 'NOTHING DECODED YET'; g.tiny((LCD_W - g.tinyWidth(t)) >> 1, y + 18, t, ON); return }
  lines.slice(0, ROWS).forEach((l, i) => {
    const ry = y + 11 + i * 7
    const snr = fmtSnr(l.snr)
    const text = fit(g, l.msg.toUpperCase(), LCD_W - g.tinyWidth(snr) - 4)
    if (l.toMe) {
      g.fill(0, ry - 1, LCD_W, 7, ON)
      g.tiny(1, ry, text, OFF)
      g.tiny(LCD_W - 1 - g.tinyWidth(snr), ry, snr, OFF)
    } else {
      g.tiny(0, ry, text, ON)
      g.tiny(LCD_W - g.tinyWidth(snr), ry, snr, ON)
    }
  })
}
