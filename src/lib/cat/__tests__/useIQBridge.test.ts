import { SSBDemodulator, IQSpectrumComputer, IQ_FFT_SIZE } from '../useIQBridge'

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

  // Regression guard for a real bug (2026-08-26, found while investigating
  // a live report that the I/Q decode path produced measurably fewer
  // confirmed decodes than the radio's own analog SSB demodulator on the
  // identical signal): a phasing-method demod's image rejection depends on
  // the Hilbert-filtered branch and the plain-delayed branch having EQUAL
  // magnitude at the audio frequency in question — a too-short Hilbert FIR
  // (the OLD fixed HILBERT_TAPS=129) has a magnitude response that rolls
  // off badly toward DC, so it can't cancel the unwanted sideband there.
  // Measured directly: the old fixed-129-tap design gave only ~12dB of
  // rejection at a typical 700Hz FT8 audio offset; this test's threshold
  // (40dB — matching the uSDX firmware's OWN documented analog rejection,
  // usdxBLACKBRICK.ino's Hilbert-transform comments) would have failed
  // against that old design and should hold comfortably now.
  it('rejects a strong tone on the mirror-image sideband by at least 40dB', () => {
    const centerHz = 1500
    const audioHz = 700
    const wantedRfHz = centerHz + audioHz // real USB content, above the carrier
    const imageRfHz = centerHz - audioHz // this frequency's OWN mirror — should be rejected in USB mode

    function measureAt(rfHz: number): number {
      const demod = new SSBDemodulator()
      demod.setPassband(centerHz, 3000, SAMPLE_RATE)
      for (let i = 0; i < 10; i++) {
        demod.demodulate(makeComplexTone(rfHz, SAMPLE_RATE, 2400), true, SAMPLE_RATE)
      }
      const out = demod.demodulate(makeComplexTone(rfHz, SAMPLE_RATE, 9600), true, SAMPLE_RATE)
      // Both the wanted tone and its image demodulate to the SAME audio
      // frequency (|audioHz|) — rejection shows up as reduced AMPLITUDE at
      // that frequency when fed the image alone, not a different frequency.
      return goertzelMagnitude(out.subarray(out.length - 8000), audioHz, SAMPLE_RATE)
    }

    const wantedMag = measureAt(wantedRfHz)
    const imageMag = measureAt(imageRfHz)
    const rejectionDb = 20 * Math.log10(wantedMag / imageMag)
    expect(rejectionDb).toBeGreaterThan(40)
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

  // Regression guard for the 300Hz highpass ported from the uSDX firmware's
  // own filt_var stage (usdxBLACKBRICK.ino) — confirms it actually
  // suppresses a sub-300Hz tone while passing a normal in-band tone
  // through, and that disabling it (setHighpassEnabled(false)) restores
  // the un-filtered behavior.
  it('suppresses a sub-300Hz tone when the highpass is enabled, passes it when disabled', () => {
    const centerHz = 3000
    const lowAudioHz = 150 // below the 300Hz corner
    const sampleCount = 24000

    const withHighpass = new SSBDemodulator()
    withHighpass.setPassband(centerHz, 2700, SAMPLE_RATE)
    withHighpass.setHighpassEnabled(true)
    for (let i = 0; i < 10; i++) withHighpass.demodulate(makeComplexTone(centerHz + lowAudioHz, SAMPLE_RATE, 2400), true, SAMPLE_RATE)
    const outWithHighpass = withHighpass.demodulate(makeComplexTone(centerHz + lowAudioHz, SAMPLE_RATE, sampleCount), true, SAMPLE_RATE)
    const magWithHighpass = goertzelMagnitude(outWithHighpass, lowAudioHz, SAMPLE_RATE)

    const withoutHighpass = new SSBDemodulator()
    withoutHighpass.setPassband(centerHz, 2700, SAMPLE_RATE)
    withoutHighpass.setHighpassEnabled(false)
    for (let i = 0; i < 10; i++) withoutHighpass.demodulate(makeComplexTone(centerHz + lowAudioHz, SAMPLE_RATE, 2400), true, SAMPLE_RATE)
    const outWithoutHighpass = withoutHighpass.demodulate(makeComplexTone(centerHz + lowAudioHz, SAMPLE_RATE, sampleCount), true, SAMPLE_RATE)
    const magWithoutHighpass = goertzelMagnitude(outWithoutHighpass, lowAudioHz, SAMPLE_RATE)

    expect(magWithoutHighpass).toBeGreaterThan(0.3)
    expect(magWithHighpass).toBeLessThan(magWithoutHighpass * 0.3)
  })
})

// Regression guard for a real report: the Signal Analysis panel's graphs
// felt slower after I/Q mode was introduced, especially when zoomed into a
// small slice of a wide I/Q band or while viewing "decoded audio" — traced
// to IQSpectrumComputer always running a full IQ_FFT_SIZE-point FFT +
// magnitude scan on every incoming frame, even when nothing on screen was
// reading magBytes. setActive()/isActive gate that work; feed() below must
// still be safe to call while inactive (a real caller keeps calling it
// every incoming frame regardless of what the UI currently shows).
describe('IQSpectrumComputer — active gating', () => {
  function makeFrame(sampleCount: number): Float64Array {
    const iq = new Float64Array(sampleCount * 2)
    for (let n = 0; n < sampleCount; n++) {
      iq[n * 2] = Math.sin(n * 0.1)
      iq[n * 2 + 1] = Math.cos(n * 0.1)
    }
    return iq
  }

  it('does not update magBytes while inactive (no watchers)', () => {
    const spectrum = new IQSpectrumComputer()
    const before = spectrum.magBytes.slice()
    spectrum.feed(makeFrame(IQ_FFT_SIZE)) // a full window's worth, no active watcher
    expect(spectrum.magBytes).toEqual(before) // untouched — feed() returned early
  });

  it('resumes updating magBytes once a watcher activates', () => {
    const spectrum = new IQSpectrumComputer()
    spectrum.setActive(true)
    spectrum.feed(makeFrame(IQ_FFT_SIZE))
    const someBinIsNonzero = spectrum.magBytes.some(b => b > 0)
    expect(someBinIsNonzero).toBe(true)
  });

  it('reference-counts multiple watchers — only fully inactive once ALL release', () => {
    const spectrum = new IQSpectrumComputer()
    spectrum.setActive(true) // watcher A
    spectrum.setActive(true) // watcher B
    spectrum.setActive(false) // A releases — B still active
    spectrum.feed(makeFrame(IQ_FFT_SIZE))
    expect(spectrum.magBytes.some(b => b > 0)).toBe(true)

    spectrum.setActive(false) // B releases — now nobody's watching
    const before = spectrum.magBytes.slice()
    spectrum.magBytes.fill(0) // clear so the next assertion can't pass by coincidence
    spectrum.feed(makeFrame(IQ_FFT_SIZE))
    expect(spectrum.magBytes).toEqual(new Uint8Array(IQ_FFT_SIZE)) // still all zero — feed() was a no-op
    expect(before.some(b => b > 0)).toBe(true) // sanity: it really had real data before clearing
  });

  it('never lets the watcher count go negative on an extra release', () => {
    const spectrum = new IQSpectrumComputer()
    spectrum.setActive(false) // release with no matching activate — must not underflow
    spectrum.setActive(true)
    spectrum.feed(makeFrame(IQ_FFT_SIZE))
    expect(spectrum.magBytes.some(b => b > 0)).toBe(true)
  });
})
