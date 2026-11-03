import { heardYouBy, recentSummary, replyCheckCandidates, replySlotEvidence, reportsForRow, summarize, type HeardReport, type HeardRow } from '../heard'

const W = Date.UTC(2026, 9, 30, 12, 0, 0) // a window start, ms
const row = (over: Partial<HeardRow> = {}): HeardRow => ({
  message: 'CQ PU7FTW HI22', mode: 'FT8', windows: [W + 180], vfoHz: 21_074_000, audioHz: 1_750, ...over,
})
const rep = (rx: string, over: Partial<HeardReport> = {}): HeardReport => ({
  rx, grid: 'FN20', hz: 21_075_760, t: W / 1000, snr: -12, dxcc: '', mode: 'FT8', ...over,
})

test('a report belongs to a row by window, frequency and mode', () => {
  const reports = [
    rep('K1AA'),                                   // yes: same window (TX started 180 ms late), +10 Hz
    rep('K2BB', { hz: 21_075_500 }),               // no: 250 Hz off
    rep('K3CC', { t: W / 1000 + 30 }),             // no: two windows later
    rep('K5EE', { t: W / 1000 + 12 }),             // yes: a receiver reporting its decode time
    rep('K6FF', { t: W / 1000 + 15 }),             // yes: one reporting the window's end
    rep('K4DD', { mode: 'FT4' }),                  // no: other mode
  ]
  expect(reportsForRow(row(), reports).map((r) => r.rx)).toEqual(['K1AA', 'K5EE', 'K6FF'])
  expect(reportsForRow(row({ error: 'encode failed' }), reports)).toEqual([])
  expect(reportsForRow(row({ vfoHz: 0 }), reports).map((r) => r.rx)).toEqual(['K1AA', 'K2BB', 'K5EE', 'K6FF']) // no CAT: time and mode only
})

test('any repeat of a row counts, and a station counts once, with its best SNR', () => {
  const r = row({ windows: [W + 30_100, W + 200] })
  const s = summarize(r, [rep('K1AA', { snr: -20 }), rep('K1AA', { t: W / 1000 + 30, snr: -8 }), rep('LU1XYZ', { grid: 'GF05' })], 'HI22nu')!
  expect(s.total).toBe(2)
  const us = s.countries.find((c) => c.cc === 'US')!
  expect(us.stations).toEqual([expect.objectContaining({ call: 'K1AA', snr: -8 })])
  expect(us.stations[0].km).toBeGreaterThan(4000)
})

test('countries most stations first; the callee is spotted', () => {
  const r = row({ message: 'LU1XYZ PU7FTW HI22' })
  const s = summarize(r, [rep('K1AA'), rep('W2BB'), rep('LU1XYZ'), rep('N3CC')], '')!
  expect(s.countries.map((c) => [c.cc, c.stations.length])).toEqual([['US', 3], ['AR', 1]])
  expect(s.calleeHeard).toBe(true)
  expect(s.countries[0].stations.every((x) => x.km === null)).toBe(true) // no grid of mine: no distances
  expect(summarize(row(), [rep('K1AA')], '')!.calleeHeard).toBe(false) // a CQ has no callee
})

test('nobody heard it: no summary', () => {
  expect(summarize(row(), [], 'HI22')).toBeNull()
  expect(summarize(row(), [rep('K1AA', { t: W / 1000 - 15 })], 'HI22')).toBeNull() // the window before
})

describe('the 20-minute repeat filter', () => {
  test('a row nobody reported gets the stations of the 20 minutes before it', () => {
    const cq = rep('LU1XYZ', { grid: 'GF05' }) // reported my CQ at W
    const later = row({ message: 'CX3VB PU7FTW HI22', windows: [W + 4 * 60_000] })
    const s = recentSummary(later, [cq, rep('K1AA', { t: W / 1000 - 25 * 60 })], 'HI22')!
    expect(s.total).toBe(1) // K1AA is older than 20 minutes
    expect(s.countries[0].cc).toBe('AR')
    expect(recentSummary(row(), [cq], 'HI22')).toBeNull() // the CQ row itself was reported: no "recently"
  })

  test('heardYouBy: the newest report from that station', () => {
    expect(heardYouBy([rep('CX3VB', { t: 100 }), rep('CX3VB', { t: 200, snr: -3 }), rep('K1AA')], 'cx3vb')).toEqual(expect.objectContaining({ t: 200, snr: -3 }))
    expect(heardYouBy([rep('K1AA')], 'CX3VB')).toBeNull()
  })
})

describe('answers I may have missed', () => {
  const NOW = W + 6 * 60_000
  const call = (to: string, windows: number[]): HeardRow => row({ message: `${to} PU7FTW HI22`, windows })

  test('candidates: called twice in 10 minutes, not decoded since, CQ never, at most 3', () => {
    const rows = [
      call('CX3VB', [W + 30_000, W]),               // twice, never decoded: yes
      call('PP5HR', [W]),                           // once: no
      call('PP5NK', [W + 60_000, W + 30_000]),      // twice but decoded after: no
      row({ windows: [W, W + 30_000] }),            // CQ: no
      call('OLD1', [NOW - 11 * 60_000, NOW - 12 * 60_000]), // too long ago: no
      call('A1AA', [W + 90_000, W + 120_000]), call('B1BB', [W + 150_000, W + 180_000]), call('C1CC', [W + 210_000, W + 240_000]),
    ]
    const decoded = (c: string) => (c === 'PP5NK' ? W + 45_000 : 0)
    expect(replyCheckCandidates(rows, decoded, NOW)).toEqual(['C1CC', 'B1BB', 'A1AA'])
    expect(replyCheckCandidates(rows.slice(0, 5), decoded, NOW)).toEqual(['CX3VB'])
  })

  test('evidence: heard by others in the window after my call, not by me', () => {
    const x = (t: number, rx: string, snr: number) => rep(rx, { t, snr, hz: 21_075_100 })
    const mine = [W, W + 30_000]
    const reports = [x(W / 1000 + 15, 'PY5JO', -12), x(W / 1000 + 16, 'LW5HR', -7), x(W / 1000 + 45, 'PY5JO', -10)]
    expect(replySlotEvidence(mine, 'FT8', reports, [])).toEqual({ slotMs: W + 45_000, receivers: 1, best: expect.objectContaining({ rx: 'PY5JO' }) })
    // I decoded it in the later slot: the earlier one is the evidence
    expect(replySlotEvidence(mine, 'FT8', reports, [W + 45_000])).toEqual({ slotMs: W + 15_000, receivers: 2, best: expect.objectContaining({ rx: 'LW5HR', snr: -7 }) })
    expect(replySlotEvidence(mine, 'FT8', reports, [W + 15_000, W + 45_000])).toBeNull()
    expect(replySlotEvidence(mine, 'FT8', [x(W / 1000, 'PY5JO', -1)], [])).toBeNull() // on air in MY slot, not the reply slot
  })
})
