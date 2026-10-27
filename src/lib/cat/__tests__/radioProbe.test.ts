// Turning the radio's answers to ID; FV; CL; into a report.
import { reportFromFrames, effectiveQueries } from '../radioProbe'

describe('radio probe report', () => {
  it('reads a radio with the capability report', () => {
    const r = reportFromFrames(['ID020;', 'FV4.02c;', 'CLFA,MD,IF,SM,DG,CL;'])
    expect(r.id).toBe('020')
    expect(r.model).toContain('TS-480')
    expect(r.firmware).toBe('4.02c')
    expect(r.queries).toEqual(['FA', 'MD', 'IF', 'SM', 'DG', 'CL'])
  })

  it('falls back to the legacy query list on older firmware', () => {
    const r = reportFromFrames(['ID020;', 'FV4.01a;', '?;'])
    expect(r.queries).toBe('unsupported')
    expect(effectiveQueries(r)).toContain('FA')
  })

  it('reports nothing when the radio is silent', () => {
    expect(reportFromFrames([])).toEqual({ id: null, model: null, firmware: null, queries: null })
  })
})
