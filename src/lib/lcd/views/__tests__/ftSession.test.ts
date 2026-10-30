import { Gfx, LCD_BODY_TOP, LCD_H, LCD_W } from '../../gfx'
import { OVERLAY_H, OVERLAY_W, OVERLAY_X, OVERLAY_Y } from '../../feed'
import { drawFtSession, drawQsoOverlay, QsoAnnouncer, sessionQsos, type FtSessionViewData } from '../ftSession'
import type { QSORecord } from '../../../ft/parser'

const T0 = Date.UTC(2026, 9, 29, 12, 0, 0)
const rec = (call: string, endMin: number, confirmed = true): QSORecord => ({
  callsign: call, startMs: T0 + (endMin - 2) * 60_000, endMs: T0 + endMin * 60_000, freqHz: 14_074_000,
  rstRcvd: -12, rstSent: -10, sentCount: 3, rcvdCount: 3, confirmed, mode: 'FT8',
})

const base: FtSessionViewData = {
  nowMs: T0 + 9000, windowSec: 15, armed: true, txStatus: 'waiting',
  activity: { qso: null, callingCq: false }, sessionStartMs: T0, session: [],
}
const working = { call: 'LU1ABC', grid: 'GF05', lastSent: 'answer' as const, lastRcvd: 'report' as const, step: 2, rstRcvd: -8, snr: -14, lastMs: 0, done: false }
const two = [rec('LU1ABC', 5), rec('K1XX', 3)]

const states: Record<string, FtSessionViewData> = {
  idle: base,
  off: { ...base, armed: false },
  callingCq: { ...base, txStatus: 'playing', activity: { qso: null, callingCq: true }, session: two },
  working: { ...base, activity: { qso: working, callingCq: false }, session: two },
  ft4: { ...base, windowSec: 7.5 },
}

const lit = (g: Gfx, x0: number, y0: number, x1: number, y1: number) => {
  let n = 0
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (g.get(x, y)) n++
  return n
}

test.each(Object.entries(states))('%s: draws under the title bar only', (_, d) => {
  const g = new Gfx()
  drawFtSession(g, 1, d)
  expect(lit(g, 0, 0, LCD_W, LCD_BODY_TOP)).toBe(0)
  expect(lit(g, 0, LCD_BODY_TOP, LCD_W, LCD_H)).toBeGreaterThan(50)
})

test('the QSO overlay stays inside the bridge\'s overlay panel, and its stars twinkle', () => {
  const a = new Gfx(), b = new Gfx()
  drawQsoOverlay(a, 0, two[0], 2)
  drawQsoOverlay(b, 2, two[0], 2)
  const inside = lit(a, OVERLAY_X, OVERLAY_Y, OVERLAY_X + OVERLAY_W, OVERLAY_Y + OVERLAY_H)
  expect(inside).toBeGreaterThan(100)
  expect(lit(a, 0, 0, LCD_W, LCD_H)).toBe(inside)
  expect(a.frame).not.toEqual(b.frame)
})

test('sessionQsos: completed ones since the start, newest first', () => {
  const all = [rec('OLD', -10), rec('A', 2), rec('PARTIAL', 4, false), rec('B', 6)]
  expect(sessionQsos(all, T0).map((r) => r.callsign)).toEqual(['B', 'A'])
})

test('QsoAnnouncer: each new QSO once; those there at the start are not announced', () => {
  const q = new QsoAnnouncer()
  expect(q.update([rec('A', 1)])).toBeNull()
  expect(q.update([rec('A', 1)])).toBeNull()
  const b = rec('B', 2)
  expect(q.update([b, rec('A', 1)])).toBe(b)
  expect(q.update([b, rec('A', 1)])).toBeNull()
  const d = rec('D', 4), e = rec('E', 5)
  expect(q.update([e, d, b])).toBe(e) // two at once: the newest
  expect(q.update([e, d, b])).toBeNull()
})
