import { NoiseReducer } from '../useIQBridge'

// New work, not a port — see NoiseReducer's own header comment for why
// (neither the uSDX firmware nor jLynx/BrowSDR implement spectral noise
// reduction). These tests focus on the properties that matter for a
// decode pipeline: it must not introduce gross latency/sample-count
// surprises, it must not distort a clean tone into something
// unrecognizable, and it must measurably suppress noise-floor-only input
// once the noise estimator has had time to converge.

function sineWave(freqHz: number, sampleRateHz: number, amplitude: number, count: number): Float32Array {
  const out = new Float32Array(count)
  for (let n = 0; n < count; n++) out[n] = amplitude * Math.sin((2 * Math.PI * freqHz * n) / sampleRateHz)
  return out
}

// Deterministic pseudo-noise (no Math.random() — keeps the test
// reproducible) via a simple LCG, scaled to a given RMS-ish amplitude.
function pseudoNoise(amplitude: number, count: number, seed = 12345): Float32Array {
  let state = seed
  const out = new Float32Array(count)
  for (let n = 0; n < count; n++) {
    state = (state * 1103515245 + 12345) & 0x7fffffff
    out[n] = amplitude * (state / 0x7fffffff - 0.5) * 2
  }
  return out
}

function rms(samples: Float32Array): number {
  let sum = 0
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i]
  return Math.sqrt(sum / samples.length)
}

describe('NoiseReducer', () => {
  const SAMPLE_RATE = 48000

  it('emits output samples eventually, with no unbounded growth or crash on varied chunk sizes', () => {
    const nr = new NoiseReducer()
    const input = sineWave(700, SAMPLE_RATE, 0.5, 10000)
    let totalOut = 0
    // Deliberately irregular chunk sizes (not a divisor of the hop/frame
    // size) — a real WebSocket frame size has no reason to align with
    // this stage's internal block size.
    let offset = 0
    const chunkSizes = [137, 500, 1, 4096, 63]
    let chunkIdx = 0
    while (offset < input.length) {
      const size = Math.min(chunkSizes[chunkIdx % chunkSizes.length], input.length - offset)
      chunkIdx++
      const chunk = input.subarray(offset, offset + size)
      const out = nr.process(chunk)
      totalOut += out.length
      offset += size
    }
    // Output count should track input count within one frame's worth of
    // latency (the overlap-add pipeline's inherent startup delay) — not
    // wildly more or fewer.
    expect(totalOut).toBeGreaterThan(input.length - 2048)
    expect(totalOut).toBeLessThanOrEqual(input.length)
  })

  function goertzelAt(samples: Float32Array, freqHz: number, sampleRateHz: number): number {
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

  // Regression guard for a real bug (2026-08-25): an earlier cross-frame
  // minimum-statistics version of this class passed a 1-second tone fine
  // but ground a CONTINUOUS tone's gain down to near-zero over several
  // seconds — invisible in a 1-second check, but exactly what a real FT8
  // 15-second decode window would experience. Runs a full 15s (FT8's own
  // window length) and checks the tone survives at a SIMILAR level at 1s
  // and at 15s, not just present at 1s.
  it('passes a clean tone through recognizably across a full 15s window, with no long-run decay', () => {
    const nr = new NoiseReducer()
    const freqHz = 700
    const durationSec = 15
    const input = sineWave(freqHz, SAMPLE_RATE, 0.5, SAMPLE_RATE * durationSec)
    const out = nr.process(input)
    expect(out.length).toBeGreaterThan(0)

    const oneSecTail = out.subarray(SAMPLE_RATE - SAMPLE_RATE / 4, SAMPLE_RATE)
    const fullTail = out.subarray(out.length - SAMPLE_RATE / 4)
    const magAt1s = goertzelAt(oneSecTail, freqHz, SAMPLE_RATE)
    const magAt15s = goertzelAt(fullTail, freqHz, SAMPLE_RATE)

    // A clean, continuous tone should read as clearly "signal" relative
    // to the noise floor, not attenuated into nothing by the Wiener gain.
    expect(magAt1s).toBeGreaterThan(0.1)
    // ...and it should NOT have decayed substantially by 15s — the actual
    // bug this test guards against.
    expect(magAt15s).toBeGreaterThan(magAt1s * 0.7)
  })

  it('measurably reduces the RMS of noise-only input once the noise estimator converges', () => {
    const nr = new NoiseReducer()
    // Feed enough noise-only frames for the minimum-statistics estimator
    // to converge (NR_NOISE_HISTORY_FRAMES worth, with margin).
    const warmup = pseudoNoise(0.3, SAMPLE_RATE * 2)
    nr.process(warmup)

    const probe = pseudoNoise(0.3, SAMPLE_RATE, 99999) // different seed, same statistics
    const out = nr.process(probe)
    expect(out.length).toBeGreaterThan(0)

    const inputRms = rms(probe)
    const outputRms = rms(out)
    // Once the estimator has learned "this whole spectrum IS the noise
    // floor," the Wiener gain should meaningfully attenuate it — this is
    // the core claim of spectral subtraction and the whole reason this
    // class exists. 0.68 (not tighter) — NR_GAIN_FLOOR intentionally
    // leaves some residual noise rather than allowing a hard 0 gain (see
    // that constant's own comment on the "musical noise" artifact that
    // would otherwise cause); ~0.65 was the measured real ratio during
    // this test's own NOISE_BIAS_CORRECTION/DD_GAIN_SMOOTHING tuning pass.
    expect(outputRms).toBeLessThan(inputRms * 0.68)
  })

  it('does not produce NaN/Infinity on silence (all-zero input)', () => {
    const nr = new NoiseReducer()
    const silence = new Float32Array(SAMPLE_RATE)
    const out = nr.process(silence)
    for (let i = 0; i < out.length; i++) {
      expect(Number.isFinite(out[i])).toBe(true)
    }
  })

  // Real-world report (2026-08-25): spectral NR made FT8 audio sound
  // "eerie/blurred" even though ft8mon's own decoder — which integrates
  // over the whole 15s window regardless — kept decoding through it fine.
  // Root cause (see this file's other 15s single-tone test, and
  // NoiseReducer's own header comment): the OLD cross-frame minimum-
  // statistics approach ground ANY sustained tone's gain toward zero over
  // several seconds, not something specific to multiple/hopping tones —
  // this synthetic multi-station signal is kept as a regression guard for
  // the realistic case (several simultaneous FT8-like stations, each
  // hopping among 8 discrete tones roughly every 160ms, plus band noise),
  // now passing under the per-frame median approach that replaced it.
  function ft8LikeSignal(durationSec: number, baseHz: number, sampleRateHz: number, amplitude: number, seed: number): Float32Array {
    const symbolSamples = Math.round((sampleRateHz * 160) / 1000)
    const n = Math.round(durationSec * sampleRateHz)
    const out = new Float32Array(n)
    let state = seed
    const rnd = () => { state = (state * 1103515245 + 12345) & 0x7fffffff; return state / 0x7fffffff }
    let phase = 0
    for (let sym = 0; sym * symbolSamples < n; sym++) {
      const toneIdx = Math.floor(rnd() * 8)
      const freq = baseHz + toneIdx * 6.25
      for (let i = 0; i < symbolSamples && sym * symbolSamples + i < n; i++) {
        out[sym * symbolSamples + i] = amplitude * Math.sin(phase)
        phase += (2 * Math.PI * freq) / sampleRateHz
      }
    }
    return out
  }

  it('does not badly crush real tone energy on a dense, multi-station FT8-like signal', () => {
    const stationBases = [500, 900, 1400, 2100, 2600]
    const durationSec = 15
    const n = Math.round(durationSec * SAMPLE_RATE)
    const mixed = new Float32Array(n)
    stationBases.forEach((base, i) => {
      const sig = ft8LikeSignal(durationSec, base, SAMPLE_RATE, 0.15, 100 + i)
      for (let s = 0; s < n; s++) mixed[s] += sig[s]
    })
    const bandNoise = pseudoNoise(0.03, n, 42)
    for (let s = 0; s < n; s++) mixed[s] += bandNoise[s]

    const nr = new NoiseReducer()
    const out = nr.process(mixed)
    expect(out.length).toBeGreaterThan(0)

    // Compare RMS over the back half (after the noise estimator has had
    // several FT8 symbol periods to converge) — real tone energy should
    // survive at a similar order of magnitude, not be pulled down to
    // roughly the residual noise floor NR_GAIN_FLOOR alone would leave.
    const half = Math.floor(mixed.length / 2)
    const inputRms = rms(mixed.subarray(half))
    const outputOffset = Math.max(0, out.length - (mixed.length - half))
    const outputRms = rms(out.subarray(outputOffset))
    expect(outputRms).toBeGreaterThan(inputRms * 0.5)
  })
})
