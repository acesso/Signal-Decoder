import { isChunkSilent, expectedDurationMs } from '../audioProcessor'
import { SSTV_MODES } from '../constants'
import { transmittedLines } from '../encoder'

const SAMPLE_RATE = 44100
const CHUNK_SIZE = 4096

function makeNoise(rms: number, seed = 1): Float32Array {
  let state = seed
  const rand = () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff
    return (state / 0x7fffffff) * 2 - 1
  }
  const out = new Float32Array(CHUNK_SIZE)
  for (let i = 0; i < CHUNK_SIZE; i++) out[i] = rand() * rms
  return out
}

function makeTone(freq: number, amplitude: number): Float32Array {
  const out = new Float32Array(CHUNK_SIZE)
  for (let i = 0; i < CHUNK_SIZE; i++) {
    out[i] = amplitude * Math.sin((2 * Math.PI * freq * i) / SAMPLE_RATE)
  }
  return out
}

function add(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(a.length)
  for (let i = 0; i < a.length; i++) out[i] = a[i] + b[i]
  return out
}

describe('isChunkSilent', () => {
  test('pure noise (no tone) is classified as silent across many random realizations', () => {
    // Amplitude alone (what the old RMS check used) should NOT be enough to
    // count as "signal present" — this is the exact failure mode from the
    // bug report: a loud-but-tone-free noise floor must not look like SSTV.
    // A single Goertzel bin on white noise is noisy chunk-to-chunk, so this
    // must hold across many independent seeds, not just one lucky draw.
    for (let seed = 1; seed <= 20; seed++) {
      expect(isChunkSilent(makeNoise(0.02, seed), SAMPLE_RATE)).toBe(true)
    }
  })

  test('noise amplitude does not affect the silent classification', () => {
    // The ratio is scale-invariant — silence should be silence at any level.
    for (const rms of [0.001, 0.01, 0.05, 0.2]) {
      expect(isChunkSilent(makeNoise(rms, 3), SAMPLE_RATE)).toBe(true)
    }
  })

  test('a strong in-band tone (e.g. Robot36 black-level luminance) is not silent', () => {
    const tone = makeTone(1500, 0.3)
    expect(isChunkSilent(tone, SAMPLE_RATE)).toBe(false)
  })

  test('a weak in-band tone well above the noise floor is not silent', () => {
    // Mirrors the reported bug: a real signal must not be misclassified as
    // silence just because its raw amplitude is low.
    const weakTone = makeTone(1900, 0.02)
    const noise = makeNoise(0.01, 7)
    expect(isChunkSilent(add(weakTone, noise), SAMPLE_RATE)).toBe(false)
  })

  test('digital silence (all zeros) is silent', () => {
    expect(isChunkSilent(new Float32Array(CHUNK_SIZE), SAMPLE_RATE)).toBe(true)
  })
})

describe('expectedDurationMs', () => {
  test('matches transmittedLines * scanTime with a tolerance margin, for every mode', () => {
    // transmittedLines, not raw height, is the number of sync intervals a
    // mode actually sends — PD modes pack 2 image rows per scan line, so
    // using height there would make the deadline 2x too long. Must stay in
    // lockstep with encoder.ts's own duration estimate (estimateEncodedSeconds).
    for (const name of Object.keys(SSTV_MODES)) {
      const mode = name as keyof typeof SSTV_MODES
      const raw = transmittedLines(mode) * SSTV_MODES[mode].scanTime
      const expected = expectedDurationMs(mode)
      expect(expected).toBeGreaterThanOrEqual(raw)
      // Tolerance margin should be modest — enough to absorb slant/clock
      // drift, not so much that a real dead transmission gets decoded as
      // still-active for many extra seconds.
      expect(expected).toBeLessThan(raw * 1.3)
    }
  })

  test('Robot36 (150ms/line, 240 lines = 36s) is on the right order of magnitude', () => {
    const ms = expectedDurationMs('ROBOT36')
    expect(ms).toBeGreaterThan(35_000)
    expect(ms).toBeLessThan(45_000)
  })

  test('PD120 deadline reflects height/2 transmitted lines, not raw height', () => {
    // Regression pin: PD120 is 640x496, scanTime ~508.48ms, but each scan
    // line/sync interval carries 2 image rows, so only 248 lines are
    // actually transmitted (~126s), not 496 (~252s). Using raw height here
    // previously made the auto-detect deadline 2x too long for every PD mode.
    const ms = expectedDurationMs('PD120')
    expect(ms).toBeGreaterThan(120_000)
    expect(ms).toBeLessThan(150_000)
  })
})
