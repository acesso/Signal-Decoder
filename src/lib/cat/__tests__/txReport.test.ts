import { assessTxReport, parseTxReport } from '../txReport'

describe('parseTxReport', () => {
  it('reads the five fields', () => {
    expect(parseTxReport('TA174,307,100,290,0;')).toEqual({ micPeak: 174, envPeak: 307, clipPct: 100, envAvg: 290, gatedPct: 0 })
  })
  it('rejects other frames', () => {
    expect(parseTxReport('TA;')).toBeNull()
    expect(parseTxReport('SM-115;')).toBeNull()
  })
})

// Values from the diag-mode sweep at drive 2 (1500 Hz tone from the S3 bridge).
describe('assessTxReport', () => {
  it('-20 dBFS: full power with margin', () => {
    expect(assessTxReport(parseTxReport('TA174,307,100,290,0;')!, 2)).toMatchObject({ level: 'ok', summary: 'full power', micPct: 36 })
  })
  it('-10.5 dBFS: mic clipping', () => {
    expect(assessTxReport(parseTxReport('TA483,848,100,795,0;')!, 2).level).toBe('bad')
  })
  it('-14 dBFS: close to clipping', () => {
    expect(assessTxReport(parseTxReport('TA400,700,100,650,0;')!, 2).summary).toBe('close to clipping')
  })
  it('-40 dBFS: below full power at drive 2', () => {
    expect(assessTxReport(parseTxReport('TA19,33,0,27,0;')!, 2).summary).toBe('below full power')
  })
  it('the same envelope is full power at a higher drive', () => {
    expect(assessTxReport(parseTxReport('TA19,33,100,27,0;')!, 3).level).toBe('ok')
  })
  it('gated carrier', () => {
    expect(assessTxReport(parseTxReport('TA10,20,0,5,40;')!, 2).summary).toBe('carrier off 40%')
  })
})
