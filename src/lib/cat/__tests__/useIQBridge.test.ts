import { SSBDemodulator } from '../useIQBridge'

// A single-tone SSB (USB) signal at RF offset f0 from baseband is exactly a
// complex exponential e^{j*2*pi*f0*n/fs} — the simplest synthetic case that
// still exercises the full mixer -> lowpass -> Hilbert-combine chain
// end-to-end: after shifting f0 down to 0Hz, the demodulator should recover
// a clean real sinusoid at f0's own original offset from the chosen center.
function makeComplexTone(freqHz: number, sampleRateHz: number, count: number): Float64Array {
  const out = new Float64Array(count * 2)
  const amp = 20000 / 32768 // same peak amplitude as the old Int16-based helper, normalized
  for (let n = 0; n < count; n++) {
    const ang = (2 * Math.PI * freqHz * n) / sampleRateHz
    out[n * 2] = Math.cos(ang) * amp // I
    out[n * 2 + 1] = Math.sin(ang) * amp // Q
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
      demod.demodulate(makeComplexTone(toneRfHz, SAMPLE_RATE, 2400), true, SAMPLE_RATE)
    }
    const out = demod.demodulate(makeComplexTone(toneRfHz, SAMPLE_RATE, 4800), true, SAMPLE_RATE)

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
      demod.demodulate(makeComplexTone(outsideHz, SAMPLE_RATE, 2400), true, SAMPLE_RATE)
    }
    const out = demod.demodulate(makeComplexTone(outsideHz, SAMPLE_RATE, 4800), true, SAMPLE_RATE)

    let rms = 0
    for (let i = 0; i < out.length; i++) rms += out[i] * out[i]
    rms = Math.sqrt(rms / out.length)
    expect(rms).toBeLessThan(0.05)
  })

  it('retunes cleanly when setPassband is called again with a new center', () => {
    const demod = new SSBDemodulator()
    demod.setPassband(1000, 2700, SAMPLE_RATE)
    demod.demodulate(makeComplexTone(1000 + 500, SAMPLE_RATE, 2400), true, SAMPLE_RATE)

    demod.setPassband(6000, 2700, SAMPLE_RATE)
    const audioHz = 500
    for (let i = 0; i < 10; i++) {
      demod.demodulate(makeComplexTone(6000 + audioHz, SAMPLE_RATE, 2400), true, SAMPLE_RATE)
    }
    const out = demod.demodulate(makeComplexTone(6000 + audioHz, SAMPLE_RATE, 4800), true, SAMPLE_RATE)
    const mag = goertzelMagnitude(out, audioHz, SAMPLE_RATE)
    const magAtWrongHz = goertzelMagnitude(out, audioHz + 1000, SAMPLE_RATE)
    expect(mag).toBeGreaterThan(0.05)
    expect(mag).toBeGreaterThan(magAtWrongHz * 5)
  })

  // Regression guard for a real bug found during the FIRFilter rewrite: the
  // Hilbert kernel's taps were generated in the wrong order for
  // FIRFilter.processOne()'s convention (oldest-sample-first instead of
  // newest-sample-first) — for this odd-symmetric kernel specifically,
  // that's equivalent to negating every tap, which doesn't just attenuate
  // image rejection, it INVERTS which sideband gets cancelled vs.
  // reinforced. Directly exercises USB vs. LSB selectivity: a tone on the
  // correct side of centerHz for the selected sideband must come through
  // much stronger than an equal-amplitude tone the same distance on the
  // WRONG side (the image) — the property that silently broke.
  it('rejects the image sideband (USB passes above center, suppresses below; LSB the reverse)', () => {
    const centerHz = 3000
    const audioHz = 700
    const sampleCount = 24000

    for (const usb of [true, false]) {
      const demod = new SSBDemodulator()
      demod.setPassband(centerHz, 2700, SAMPLE_RATE)
      // USB should pass centerHz+audioHz strongly and suppress centerHz-audioHz;
      // LSB the reverse.
      const wantedHz = usb ? centerHz + audioHz : centerHz - audioHz
      const imageHz = usb ? centerHz - audioHz : centerHz + audioHz

      const demodWanted = demod
      for (let i = 0; i < 10; i++) demodWanted.demodulate(makeComplexTone(wantedHz, SAMPLE_RATE, 2400), usb, SAMPLE_RATE)
      const outWanted = demodWanted.demodulate(makeComplexTone(wantedHz, SAMPLE_RATE, sampleCount), usb, SAMPLE_RATE)
      const magWanted = goertzelMagnitude(outWanted, audioHz, SAMPLE_RATE)

      const demodImage = new SSBDemodulator()
      demodImage.setPassband(centerHz, 2700, SAMPLE_RATE)
      for (let i = 0; i < 10; i++) demodImage.demodulate(makeComplexTone(imageHz, SAMPLE_RATE, 2400), usb, SAMPLE_RATE)
      const outImage = demodImage.demodulate(makeComplexTone(imageHz, SAMPLE_RATE, sampleCount), usb, SAMPLE_RATE)
      const magImage = goertzelMagnitude(outImage, audioHz, SAMPLE_RATE)

      expect(magWanted).toBeGreaterThan(0.3)
      expect(magWanted).toBeGreaterThan(magImage * 5)
    }
  })

  // Regression guard for the class of bug this file's FIRFilter rewrite was
  // meant to fix once and for all: a genuinely causal, correctly-streaming
  // filter must produce numerically identical output whether its input
  // arrives as one big call or many small ones — there is no other way for
  // a real-time pipeline (arbitrary WebSocket frame sizes) to behave
  // correctly. A "centered"/forward-looking convolution (this file's
  // pre-FIRFilter implementation) fails this hard; a tap-ordering bug (also
  // found and fixed during this rewrite — an odd-symmetric Hilbert kernel
  // applied in the wrong direction) does NOT fail this specific test (both
  // orderings are equally self-consistent across chunk sizes), which is why
  // this test alone wasn't sufficient to catch that bug — see the other
  // tests above (image rejection, passband selectivity) for that coverage.
  it('produces identical output whether fed as one call or many small chunks', () => {
    const centerHz = 1500
    const audioHz = 700
    const sampleCount = 24000 // 500ms at 48kHz — several frames' worth either way

    const whole = new SSBDemodulator()
    whole.setPassband(centerHz, 2700, SAMPLE_RATE)
    const fullTone = makeComplexTone(centerHz + audioHz, SAMPLE_RATE, sampleCount)
    const wholeOut = whole.demodulate(fullTone, true, SAMPLE_RATE)

    const chunked = new SSBDemodulator()
    chunked.setPassband(centerHz, 2700, SAMPLE_RATE)
    const chunkSize = 137 // deliberately not a divisor of sampleCount or of any filter length
    const chunkedOut = new Float32Array(sampleCount)
    let offset = 0
    while (offset < sampleCount) {
      const n = Math.min(chunkSize, sampleCount - offset)
      const chunk = fullTone.subarray(offset * 2, (offset + n) * 2)
      const out = chunked.demodulate(chunk, true, SAMPLE_RATE)
      chunkedOut.set(out, offset)
      offset += n
    }

    // Skip the first ~2 filter lengths (mixer/lowpass/Hilbert group delay +
    // settling) — only the STEADY-STATE streaming behavior needs to match
    // exactly, not the transient while filters are still filling.
    let maxDiff = 0
    for (let i = 1000; i < sampleCount; i++) {
      maxDiff = Math.max(maxDiff, Math.abs(wholeOut[i] - chunkedOut[i]))
    }
    // 1e-6, not tighter — demodulate() returns Float32Array, so both paths
    // go through an extra float32 rounding step each; real algorithmic
    // divergence shows up orders of magnitude larger than float32 rounding
    // noise, not at it.
    expect(maxDiff).toBeLessThan(1e-6)
  })
})
