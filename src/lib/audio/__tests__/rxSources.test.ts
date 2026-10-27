// The two RX selections map onto the decoders' single source override, and
// an older saved override splits back into the pair it meant.
import { deriveAudioSourceOverride, splitAudioSourceOverride, type AudioSourceOverride } from '../audioSource'

describe('RX source selections', () => {
  it('maps decode audio onto the decoders\' source', () => {
    expect(deriveAudioSourceOverride('auto', 'auto')).toBe('auto')
    expect(deriveAudioSourceOverride('soundcard', 'iq')).toBe('soundcard-iq')
    expect(deriveAudioSourceOverride('usb', 'iq')).toBe('usb-iq')
    expect(deriveAudioSourceOverride('bridge', 'iq')).toBe('bridge-iq')
    // Mixed: I/Q from the sound card while decoders listen to the bridge.
    expect(deriveAudioSourceOverride('soundcard', 'bridge')).toBe('bridge-audio')
    expect(deriveAudioSourceOverride('bridge', 'soundcard')).toBe('microphone')
  })

  it('round-trips every older single override', () => {
    const all: AudioSourceOverride[] = ['auto', 'microphone', 'bridge-audio', 'bridge-iq', 'soundcard-iq', 'usb-iq']
    for (const v of all) {
      const { iq, audio } = splitAudioSourceOverride(v)
      expect(deriveAudioSourceOverride(iq, audio)).toBe(v)
    }
  })
})
