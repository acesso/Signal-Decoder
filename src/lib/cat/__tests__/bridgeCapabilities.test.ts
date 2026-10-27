// The app builds its source lists from what a bridge says about itself, and
// falls back to /info + /status on older firmware. These pin the parsing of
// both real board answers (captured from the S3 and A1S, firmware 0.11.0).
import { parseCapabilities, parseRouting, inputsFor, fetchBridgeDescription } from '../bridgeCapabilities'

const S3_CAPS = {
  version: 1, board: 's3', firmware_version: '0.11.0', pa: { sense: true, emergency: true }, concurrent_inputs: true,
  inputs: [
    { id: 'wm8782', chip: 'WM8782', jack: 'I/Q', kinds: ['iq', 'audio'], rate_hz: 96000, bits: 24, channels: [{ id: 'left', label: 'I' }, { id: 'right', label: 'Q' }] },
    { id: 'pcm1808', chip: 'PCM1808', jack: 'RX/loop', kinds: ['audio', 'iq'], rate_hz: 48000, bits: 24, channels: [{ id: 'left', label: 'RX' }, { id: 'right', label: 'loop' }] },
  ],
  outputs: [{ id: 'pcm5102a', chip: 'PCM5102A', jack: 'TX', kinds: ['audio'], rate_hz: 48000, channels: ['left', 'right', 'both'], delivery: ['slots', 'stream'], slots: 4, slot_rate_hz: 16000 }],
  dsp: { iq_spectrum: { fft_sizes: [1024, 2048, 4096] }, iq_passband: { rates_hz: [6000, 12000, 24000] }, iq_corrections: ['none', 'swap'], dc_removal: true, imbalance_correction: false },
}

describe('bridge capabilities', () => {
  it('parses a two-ADC bridge with its own DSP', () => {
    const c = parseCapabilities(S3_CAPS)
    expect(c.concurrentInputs).toBe(true)
    expect(inputsFor(c, 'iq').map((i) => i.id)).toEqual(['wm8782', 'pcm1808'])
    expect(c.inputs[1].channels[1]).toEqual({ id: 'right', label: 'loop' })
    expect(c.dsp?.iqPassbandRatesHz).toEqual([6000, 12000, 24000])
    expect(c.outputs[0].delivery).toContain('slots')
    expect(c.legacy).toBe(false)
  })

  it('parses a single-codec bridge with no DSP', () => {
    const c = parseCapabilities({ board: 'a1s', concurrent_inputs: false, input_kind_switch: 'reboot', inputs: [{ id: 'es8388', kinds: ['audio', 'iq'], rate_hz: 48000 }], outputs: [], dsp: null })
    expect(c.concurrentInputs).toBe(false)
    expect(c.inputKindSwitch).toBe('reboot')
    expect(c.dsp).toBeNull()
  })

  it('parses routing, with null for an unrouted stream', () => {
    const r = parseRouting({ iq: { input: 'es8388', rate_hz: 48000 }, audio: { input: null, channel: 'right', rate_hz: 48000 }, tx: { output: 'es8388', channel: 'both' }, reboot_required: true })
    expect(r.iq.input).toBe('es8388')
    expect(r.audio.input).toBeNull()
    expect(r.audio.channel).toBe('right')
    expect(r.rebootRequired).toBe(true)
  })

  it('derives a description from /info and /status on older firmware', async () => {
    global.fetch = jest.fn(async (url: string) => {
      if (url.endsWith('/info')) return { ok: true, json: async () => ({ board: 'a1s', features: ['pa_watchdog', 'input_mode_select', 'tx_buffer_playback'] }) }
      if (url.endsWith('/status')) return { ok: true, json: async () => ({ input_mode: 'iq', sample_rate_hz: 96000 }) }
      return { ok: false, json: async () => ({}) }
    }) as unknown as typeof fetch
    const d = await fetchBridgeDescription('http://bridge')
    expect(d?.capabilities.legacy).toBe(true)
    expect(d?.capabilities.inputKindSwitch).toBe('reboot')
    expect(d?.routing.iq.input).toBe('codec')
    expect(d?.routing.audio.input).toBeNull()
    expect(d?.routing.iq.rateHz).toBe(96000)
  })
})
