import { Gfx, LCD_BODY_TOP, LCD_H, LCD_W } from '../../gfx'
import { ago, drawFtContact } from '../ftContact'
import { exchangeWith } from '../../../ft/conversation'
import { parseFTMsg, type Contact, type ContactMsg } from '../../../ft/parser'

const T0 = Date.UTC(2026, 9, 29, 12, 0, 0)
const msg = (raw: string, slot: number, snr = -10): ContactMsg => ({ windowStart: new Date(T0 + slot * 15000), raw, parsed: parseFTMsg(raw), freq: 1500, snr, role: 'tx' })
const lu: Contact = { callsign: 'LU1ABC', grid: 'GF05', grids: ['GF05'], color: '#fff', firstSeen: new Date(T0), lastSeen: new Date(T0 + 60000), peers: new Set(),
  msgs: [msg('CQ LU1ABC GF05', 0), msg('PY2ME LU1ABC -08', 2, -14), msg('K1XX LU1ABC R-12', 4, -11)] }
const sent = [{ id: '1', message: 'LU1ABC PY2ME GG66', label: '', windowStart: new Date(T0 + 15000), vfoHz: 0, audioHz: 0 }]

const lit = (g: Gfx, y0: number, y1: number) => { let n = 0; for (let y = y0; y < y1; y++) for (let x = 0; x < LCD_W; x++) if (g.get(x, y)) n++; return n }

test('ago', () => {
  expect([ago(45_000), ago(12 * 60_000), ago(3 * 3_600_000), ago(2 * 86_400_000)]).toEqual(['45S', '12M', '3H', '2D'])
})

test.each([
  ['in a QSO with me', lu, exchangeWith('LU1ABC', 'PY2ME', lu, sent)],
  ['heard, no QSO', lu, null],
  ['not heard', undefined, null],
])('%s: draws under the title bar only', (_, contact, exchange) => {
  const g = new Gfx()
  drawFtContact(g, 1, { nowMs: T0 + 120_000, call: 'LU1ABC', contact, exchange })
  expect(lit(g, 0, LCD_BODY_TOP)).toBe(0)
  expect(lit(g, LCD_BODY_TOP, LCD_H)).toBeGreaterThan(20)
})

test('the next step of a QSO in progress blinks', () => {
  const d = { nowMs: T0 + 120_000, call: 'LU1ABC', contact: lu, exchange: exchangeWith('LU1ABC', 'PY2ME', lu, sent) }
  const a = new Gfx(), b = new Gfx()
  drawFtContact(a, 0, d)
  drawFtContact(b, 2, d)
  expect(a.frame).not.toEqual(b.frame)
})
