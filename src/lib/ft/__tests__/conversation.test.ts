import { currentQso, latestMessage, messagesToMe, QSO_STALE_MS, sentTo } from '../conversation'
import { parseFTMsg, type Contact, type ContactMsg } from '../parser'
import type { SentEntry } from '../useFTTransmit'

const ME = 'PY2ME'
const T0 = Date.UTC(2026, 9, 29, 12, 0, 0)
const at = (slot: number) => new Date(T0 + slot * 15_000)

function msg(raw: string, slot: number, snr = -10): ContactMsg {
  return { windowStart: at(slot), raw, parsed: parseFTMsg(raw), freq: 1500, snr, role: 'tx' }
}

function contact(call: string, msgs: ContactMsg[], grid?: string): Contact {
  return { callsign: call, grid, grids: grid ? [grid] : [], color: '#fff', msgs, peers: new Set(), firstSeen: at(0), lastSeen: at(99) }
}

let n = 0
function sent(message: string, slot: number): SentEntry {
  return { id: String(n++), message, label: '', windowStart: at(slot), vfoHz: 14074000, audioHz: 1500 }
}

const now = (slot: number) => at(slot).getTime() + 5000

test('messagesToMe, latestMessage, sentTo', () => {
  const c = contact('LU1ABC', [msg('PY2ME LU1ABC -08', 3), msg('CQ LU1ABC GF05', 1), msg('PY2ME LU1ABC RR73', 5), msg('K1XX LU1ABC -10', 6)])
  expect(messagesToMe(c, ME).map((m) => m.raw)).toEqual(['PY2ME LU1ABC -08', 'PY2ME LU1ABC RR73'])
  expect(latestMessage([c.msgs[2], c.msgs[0]])?.raw).toBe('PY2ME LU1ABC RR73') // by window, not by order
  expect(latestMessage([])).toBeNull()
  const log = [sent('LU1ABC PY2ME R-12', 4), sent('K1XX PY2ME GG66', 2), sent('LU1ABC PY2ME GG66', 2)]
  expect(sentTo('LU1ABC', log).map((e) => e.message)).toEqual(['LU1ABC PY2ME R-12', 'LU1ABC PY2ME GG66'])
})

test('answering a CQ: steps, reports and SNR as the exchange goes', () => {
  const lu = contact('LU1ABC', [msg('CQ LU1ABC GF05', 0), msg('PY2ME LU1ABC -08', 2, -14)], 'GF05')
  const log = [sent('LU1ABC PY2ME GG66', 1)]
  let q = currentQso(ME, new Map([['LU1ABC', lu]]), log, now(2)).qso!
  expect(q).toMatchObject({ call: 'LU1ABC', grid: 'GF05', lastSent: 'answer', lastRcvd: 'report', step: 2, rstRcvd: -8, snr: -14, done: false })
  expect(q.rstSent).toBeUndefined()

  log.unshift(sent('LU1ABC PY2ME R-14', 3))
  q = currentQso(ME, new Map([['LU1ABC', lu]]), log, now(3)).qso!
  expect(q).toMatchObject({ lastSent: 'r_report', step: 3, rstSent: -14, rstRcvd: -8, done: false })

  lu.msgs.push(msg('PY2ME LU1ABC RR73', 4, -12))
  q = currentQso(ME, new Map([['LU1ABC', lu]]), log, now(4)).qso!
  expect(q).toMatchObject({ lastRcvd: 'rr73', step: 4, snr: -12, done: false })

  log.unshift(sent('LU1ABC PY2ME 73', 5))
  q = currentQso(ME, new Map([['LU1ABC', lu]]), log, now(5)).qso!
  expect(q).toMatchObject({ lastSent: 'tx73', step: 5, done: true })
})

test('the newest exchange wins; an old one goes stale', () => {
  const a = contact('LU1ABC', [msg('PY2ME LU1ABC -08', 2)])
  const b = contact('K1XX', [msg('PY2ME K1XX FN42', 4)])
  const contacts = new Map([['LU1ABC', a], ['K1XX', b]])
  expect(currentQso(ME, contacts, [], now(4)).qso?.call).toBe('K1XX')
  expect(currentQso(ME, contacts, [sent('LU1ABC PY2ME R-10', 5)], now(5)).qso?.call).toBe('LU1ABC')
  expect(currentQso(ME, contacts, [], now(4) + QSO_STALE_MS).qso).toBeNull()
})

test('a station I called that has not answered yet', () => {
  const q = currentQso(ME, new Map(), [sent('JA1ZZ PY2ME GG66', 1)], now(1)).qso!
  expect(q).toMatchObject({ call: 'JA1ZZ', lastSent: 'answer', lastRcvd: null, step: 1 })
  expect(q.snr).toBeUndefined()
})

test('calling CQ: after a finished QSO the QSO is no longer shown', () => {
  const lu = contact('LU1ABC', [msg('PY2ME LU1ABC RR73', 2)])
  const log = [sent('CQ PY2ME GG66', 4), sent('LU1ABC PY2ME 73', 3)]
  expect(currentQso(ME, new Map([['LU1ABC', lu]]), log, now(4))).toEqual({ qso: null, callingCq: true })
  // A CQ while a QSO is still open keeps the QSO (and says I'm calling).
  const open = [sent('CQ PY2ME GG66', 4), sent('LU1ABC PY2ME R-10', 3)]
  const r = currentQso(ME, new Map([['LU1ABC', contact('LU1ABC', [msg('PY2ME LU1ABC -08', 2)])]]), open, now(4))
  expect(r.callingCq).toBe(true)
  expect(r.qso?.call).toBe('LU1ABC')
})

test('nothing going on', () => {
  expect(currentQso(ME, new Map([['X1', contact('LU1ABC', [msg('CQ LU1ABC GF05', 1)])]]), [], now(1))).toEqual({ qso: null, callingCq: false })
})
