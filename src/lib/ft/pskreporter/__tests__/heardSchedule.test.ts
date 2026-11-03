import {
  HEARD_BACKOFF_MS, HEARD_FIRST_AFTER_MS, HEARD_FOLLOW_MS, HEARD_MIN_GAP_MS,
  emptyShared, mergeReports, nextCheckAt, readShared, withPeer,
} from '../heardSchedule'

const NOW = 1_800_000_000_000
const MIN = 60_000

test('nothing to ask about: no TX, or only old ones', () => {
  expect(nextCheckAt([], emptyShared('PU7FTW'), NOW)).toBeNull()
  expect(nextCheckAt([NOW - HEARD_FOLLOW_MS - 1], emptyShared('PU7FTW'), NOW)).toBeNull()
})

test('the first check waits for the receivers, later ones keep 5 minutes apart', () => {
  const tx = NOW - 30_000
  expect(nextCheckAt([tx], emptyShared('PU7FTW'), NOW)).toBe(tx + HEARD_FIRST_AFTER_MS)
  const asked = { ...emptyShared('PU7FTW'), askedAt: NOW - 1 * MIN, okAt: NOW - 1 * MIN }
  expect(nextCheckAt([NOW - 10 * MIN], asked, NOW)).toBe(asked.askedAt + HEARD_MIN_GAP_MS)
})

test('failures wait longer each time, up to an hour', () => {
  const tx = NOW - 10 * MIN
  const at = (failures: number) => nextCheckAt([tx], { ...emptyShared('X1X'), askedAt: NOW, failures }, NOW)! - NOW
  expect([1, 2, 3, 4, 9].map(at)).toEqual([HEARD_BACKOFF_MS[0], HEARD_BACKOFF_MS[1], HEARD_BACKOFF_MS[2], HEARD_BACKOFF_MS[3], HEARD_BACKOFF_MS[3]])
})

test('shared state is per callsign and survives garbage', () => {
  const s = { ...emptyShared('PU7FTW'), askedAt: 5, reports: [] }
  expect(readShared(JSON.stringify(s), 'PU7FTW').askedAt).toBe(5)
  expect(readShared(JSON.stringify(s), 'K1AA')).toEqual(emptyShared('K1AA'))
  expect(readShared('{nope', 'K1AA')).toEqual(emptyShared('K1AA'))
})

test('merging keeps one copy of a report and drops the old ones', () => {
  const r = (rx: string, t: number) => ({ rx, grid: '', hz: 14_075_000, t, snr: -10, dxcc: '', mode: 'FT8' })
  const tNow = NOW / 1000
  const merged = mergeReports([r('K1AA', tNow - 60), r('OLD1', tNow - 3 * 3600)], [r('K1AA', tNow - 60), r('W2BB', tNow - 30)], NOW)
  expect(merged.map((x) => x.rx).sort()).toEqual(['K1AA', 'W2BB'])
})

test('peers: fresh reports in, stale peers out', () => {
  const r = (rx: string) => ({ rx, grid: '', hz: 1, t: NOW / 1000, snr: null, dxcc: '', mode: 'FT8' })
  const s = { ...emptyShared('PU7FTW'), peers: { OLD1: { okAt: NOW - 20 * MIN, reports: [] } } }
  const next = withPeer(s, 'CX3VB', [r('PY5JO')], NOW)
  expect(Object.keys(next.peers)).toEqual(['CX3VB'])
  expect(next.peers.CX3VB.reports.map((x) => x.rx)).toEqual(['PY5JO'])
})
