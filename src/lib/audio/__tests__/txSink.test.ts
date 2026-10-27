// One TX output for every mode, seeded once from the older per-mode keys.
describe('shared TX output', () => {
  beforeEach(() => { localStorage.clear(); jest.resetModules() })

  it('migrates the first older per-mode choice it finds', async () => {
    localStorage.setItem('rtty_tx_audio_sink', 'bridge')
    localStorage.setItem('sstv_tx_output_device', 'dev-7')
    const { txSink } = await import('../txSink')
    expect(txSink.kind()).toBe('bridge')
    expect(txSink.hasExplicitKind()).toBe(true)
    expect(txSink.device()).toBe('dev-7')
    expect(localStorage.getItem('tx_sink_kind')).toBe('bridge')
  })

  it('defaults to the local sound card, not yet an explicit choice', async () => {
    const { txSink } = await import('../txSink')
    expect(txSink.kind()).toBe('speaker')
    expect(txSink.hasExplicitKind()).toBe(false)
    txSink.setKind('bridge')
    expect(txSink.hasExplicitKind()).toBe(true)
    expect(localStorage.getItem('tx_sink_kind')).toBe('bridge')
  })
})
