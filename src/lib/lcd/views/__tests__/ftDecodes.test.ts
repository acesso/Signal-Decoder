import { Gfx, LCD_BODY_TOP, LCD_H, LCD_W } from '../../gfx'
import { drawFtDecodes } from '../ftDecodes'
import type { DecodeSummary } from '../../../ft/decodeSummary'

const lit = (g: Gfx, y0: number, y1: number) => { let n = 0; for (let y = y0; y < y1; y++) for (let x = 0; x < LCD_W; x++) if (g.get(x, y)) n++; return n }
const summary: DecodeSummary = {
  recording: true, decoding: false, last: { windowStartMs: 0, count: 21, decodeMs: 1200 }, stations: 15,
  recent: [{ msg: 'CQ PP5NK GG53', snr: -15, toMe: false }, { msg: 'PU7FTW K1ABC -08', snr: -9, toMe: true }],
}

test.each([
  ['off', null],
  ['listening, nothing yet', { ...summary, last: null, recent: [] }],
  ['decoding', summary],
])('%s: draws under the title bar only', (_, s) => {
  const g = new Gfx()
  drawFtDecodes(g, 0, { nowMs: 7_500, windowSec: 15, summary: s })
  expect(lit(g, 0, LCD_BODY_TOP)).toBe(0)
  expect(lit(g, LCD_BODY_TOP, LCD_H)).toBeGreaterThan(20)
})

test('a message to me is drawn inverted', () => {
  const g = new Gfx()
  drawFtDecodes(g, 0, { nowMs: 0, windowSec: 15, summary })
  const row = (i: number) => lit(g, LCD_BODY_TOP + 1 + 10 + i * 7, LCD_BODY_TOP + 1 + 17 + i * 7)
  expect(row(1)).toBeGreaterThan(row(0) * 2) // the filled bar
})
