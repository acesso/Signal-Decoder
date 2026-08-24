import { SSBDemodulator } from '../useIQBridge'

// A single-tone SSB (USB) signal at RF offset f0 from baseband is exactly a
// complex exponential e^{j*2*pi*f0*n/fs} — the simplest synthetic case that
// still exercises the full mixer -> lowpass -> Hilbert-combine chain
// end-to-end: after shifting f0 down to 0Hz, the demodulator should recover
// a clean real sinusoid at f0's own original offset from the chosen center.
function makeComplexToneInt16(freqHz: number, sampleRateHz: number, count: number): Int16Array {
  const out = new Int16Array(count * 2)
  for (let n = 0; n < count; n++) {
    const ang = (2 * Math.PI * freqHz * n) / sampleRateHz
    out[n * 2] = Math.round(Math.cos(ang) * 20000) // I
    out[n * 2 + 1] = Math.round(Math.sin(ang) * 20000) // Q
  }
  return out
}

function goertzelMagnitude(samples: Float32Array, freqHz: number, sampleRateHz: number): number {
  const w = (2 * Math.PI * freqHz) / sampleRateHz
  const cw = 2 * Math.cos(w)
  let s0 = 0, s1 = 0, s2 = 0
  for (let n = 0; n < samples.length; n++) {
    s0 = samples[n] + cw * s1 - s2
    s2 = s1
    s1 = s0
  }
  const real = s1 - s2 * Math.cos(w)
  const imag = s2 * Math.sin(w)
  return Math.sqrt(real * real + imag * imag) / samples.length
}

describe('SSBDemodulator', () => {
  const SAMPLE_RATE = 48000

  it('recovers a tone shifted to the marker center as a clean baseband tone', () => {
    const demod = new SSBDemodulator()
    const centerHz = 3000
    const audioHz = 700
    demod.setPassband(centerHz, 2700, SAMPLE_RATE)

    // Prime the filters with a few frames of settling before measuring.
    const toneRfHz = centerHz + audioHz
    for (let i = 0; i < 10; i++) {
      demod.demodulate(makeComplexToneInt16(toneRfHz, SAMPLE_RATE, 2400), true, SAMPLE_RATE)
    }
    const out = demod.demodulate(makeComplexToneInt16(toneRfHz, SAMPLE_RATE, 4800), true, SAMPLE_RATE)

    const magAtAudioHz = goertzelMagnitude(out, audioHz, SAMPLE_RATE)
    const magAtWrongHz = goertzelMagnitude(out, audioHz + 1000, SAMPLE_RATE)
    expect(magAtAudioHz).toBeGreaterThan(0.05)
    expect(magAtAudioHz).toBeGreaterThan(magAtWrongHz * 5)
  })

  it('rejects a tone well outside the selected bandwidth', () => {
    const demod = new SSBDemodulator()
    const centerHz = 0
    demod.setPassband(centerHz, 500, SAMPLE_RATE) // narrow passband, +-250Hz

    const outsideHz = 5000 // far outside the 500Hz-wide passband
    for (let i = 0; i < 10; i++) {
      demod.demodulate(makeComplexToneInt16(outsideHz, SAMPLE_RATE, 2400), true, SAMPLE_RATE)
    }
    const out = demod.demodulate(makeComplexToneInt16(outsideHz, SAMPLE_RATE, 4800), true, SAMPLE_RATE)

    let rms = 0
    for (let i = 0; i < out.length; i++) rms += out[i] * out[i]
    rms = Math.sqrt(rms / out.length)
    expect(rms).toBeLessThan(0.05)
  })

  it('retunes cleanly when setPassband is called again with a new center', () => {
    const demod = new SSBDemodulator()
    demod.setPassband(1000, 2700, SAMPLE_RATE)
    demod.demodulate(makeComplexToneInt16(1000 + 500, SAMPLE_RATE, 2400), true, SAMPLE_RATE)

    demod.setPassband(6000, 2700, SAMPLE_RATE)
    const audioHz = 500
    for (let i = 0; i < 10; i++) {
      demod.demodulate(makeComplexToneInt16(6000 + audioHz, SAMPLE_RATE, 2400), true, SAMPLE_RATE)
    }
    const out = demod.demodulate(makeComplexToneInt16(6000 + audioHz, SAMPLE_RATE, 4800), true, SAMPLE_RATE)
    const mag = goertzelMagnitude(out, audioHz, SAMPLE_RATE)
    const magAtWrongHz = goertzelMagnitude(out, audioHz + 1000, SAMPLE_RATE)
    expect(mag).toBeGreaterThan(0.05)
    expect(mag).toBeGreaterThan(magAtWrongHz * 5)
  })
})
