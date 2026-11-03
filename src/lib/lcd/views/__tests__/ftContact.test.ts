import { Gfx, LCD_BODY_TOP, LCD_H, LCD_W } from '../../gfx'
import { ago, contactCounts, drawFtContact } from '../ftContact'
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
  // its newest message is to me: still in the QSO (lu's newest went to K1XX: moved on)
  const inQso: Contact = { ...lu, msgs: lu.msgs.slice(0, 2) }
  const d = { nowMs: T0 + 120_000, call: 'LU1ABC', contact: inQso, exchange: exchangeWith('LU1ABC', 'PY2ME', inQso, sent) }
  const a = new Gfx(), b = new Gfx()
  drawFtContact(a, 0, d)
  drawFtContact(b, 2, d)
  expect(a.frame).not.toEqual(b.frame)
})

test('moved on: no blinking next step; repeated messages are one line', () => {
  const pw: Contact = { ...lu, callsign: 'PW2DSY', msgs: [msg('CQ PW2DSY GH64', 0), msg('DL9FFM PW2DSY -02', 2), msg('CQ PW2DSY GH64', 4), msg('CQ PW2DSY GH64', 6)] }
  const log = [{ ...sent[0], message: 'PW2DSY PY2ME GG66' }]
  const ex = exchangeWith('PW2DSY', 'PY2ME', pw, log)!
  expect(ex.movedOn).toBe(true)
  const d = { nowMs: T0 + 120_000, call: 'PW2DSY', contact: pw, exchange: ex }
  const a = new Gfx(), b = new Gfx()
  drawFtContact(a, 0, d)
  drawFtContact(b, 2, d)
  expect(a.frame).toEqual(b.frame) // nothing blinks
  // two lines: the CQ (x2) and the report before it, not the CQ twice
  const one = new Gfx()
  drawFtContact(one, 0, { ...d, contact: { ...pw, msgs: pw.msgs.slice(0, 3) } })
  expect(lit(a, LCD_BODY_TOP + 25, LCD_BODY_TOP + 37)).toBeGreaterThan(lit(one, LCD_BODY_TOP + 25, LCD_BODY_TOP + 31))
})

test('tx and rx counters: what I decoded of it; a rise animates', () => {
  const rx = (raw: string, slot: number): ContactMsg => ({ ...msg(raw, slot), role: 'rx' })
  const st: Contact = { ...lu, callsign: 'ZZ1ZZ', msgs: [msg('CQ ZZ1ZZ GF05', 0), msg('CQ ZZ1ZZ GF05', 2), rx('ZZ1ZZ K1XX FN42', 1)] }
  expect(contactCounts(st)).toEqual({ tx: 2, rx: 1 })
  const at = (contact: Contact, tick: number, nowMs: number) => { const g = new Gfx(); drawFtContact(g, tick, { nowMs, call: 'ZZ1ZZ', contact, exchange: null }); return g.frame }
  const t = T0 + 120_000
  // first sight: still, same picture on any tick
  expect(at(st, 0, t)).toEqual(at(st, 1, t))
  // rx rises: for a moment the picture changes tick to tick
  const more: Contact = { ...st, msgs: [...st.msgs, rx('ZZ1ZZ W2BB EM10', 3)] }
  expect(at(more, 0, t + 200)).not.toEqual(at(more, 1, t + 300))
  // and settles after it
  expect(at(more, 0, t + 5000)).toEqual(at(more, 1, t + 5000))
})
