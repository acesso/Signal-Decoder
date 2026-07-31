import { isChunkSilent } from '../audioProcessor'

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
