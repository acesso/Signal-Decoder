import { designLowPassFir, applyFir, resampleTo12k } from '../resample';

// Generates a pure tone so tests can check the resampler's effect on a known
// frequency component via RMS amplitude (a simple, robust stand-in for a
// full spectral analysis — good enough to tell "passed through" from
// "attenuated" from "aliased down to a different frequency").
function tone(freqHz: number, sampleRate: number, durationSec: number): Float32Array {
  const n = Math.round(sampleRate * durationSec);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.sin((2 * Math.PI * freqHz * i) / sampleRate);
  return out;
}

function rms(samples: Float32Array): number {
  let sum = 0;
  for (const s of samples) sum += s * s;
  return Math.sqrt(sum / samples.length);
}

// Goertzel-style single-frequency power detector — measures the energy at
// exactly targetHz in `samples` (sampled at sampleRate), so aliasing (energy
// showing up at the wrong frequency) is distinguishable from simple
// attenuation (energy reduced but still at the same frequency).
function goertzelMagnitude(samples: Float32Array, targetHz: number, sampleRate: number): number {
  const n = samples.length;
  const k = (targetHz * n) / sampleRate;
  const omega = (2 * Math.PI * k) / n;
  const coeff = 2 * Math.cos(omega);
  let s0 = 0, s1 = 0, s2 = 0;
  for (let i = 0; i < n; i++) {
    s0 = samples[i] + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  const real = s1 - s2 * Math.cos(omega);
  const imag = s2 * Math.sin(omega);
  return Math.sqrt(real * real + imag * imag) / (n / 2);
}

describe('designLowPassFir', () => {
  test('has unity gain at DC', () => {
    const taps = designLowPassFir(5400, 12000, 63);
    const sum = Array.from(taps).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 6);
  });

  test('is symmetric (linear phase)', () => {
    const taps = designLowPassFir(5400, 12000, 63);
    for (let i = 0; i < taps.length; i++) {
      expect(taps[i]).toBeCloseTo(taps[taps.length - 1 - i], 9);
    }
  });
});

describe('applyFir', () => {
  test('passes a DC signal through at unity gain', () => {
    const taps = designLowPassFir(5400, 12000, 63);
    const dc = new Float32Array(256).fill(1);
    const out = applyFir(dc, taps);
    // Edges are attenuated (zero-padded boundary), but the interior should
    // sit at ~1.0 since the filter has unity DC gain.
    expect(out[128]).toBeCloseTo(1, 2);
  });
});

describe('resampleTo12k anti-aliasing', () => {
  const IN_RATE = 48000;
  const OUT_RATE = 12000;
  const DURATION = 0.5;

  test('passes a low frequency (well within the new passband) through with little attenuation', () => {
    const freq = 1000; // well below 5400 Hz cutoff and 6000 Hz Nyquist
    const input = tone(freq, IN_RATE, DURATION);
    const output = resampleTo12k(input, IN_RATE);
    const mag = goertzelMagnitude(output, freq, OUT_RATE);
    expect(mag).toBeGreaterThan(0.8);
  });

  test('does not alias a tone above the new Nyquist down into the passband', () => {
    // 9000 Hz sampled at 48kHz, decimated to 12kHz (Nyquist 6000 Hz): naive
    // linear-interpolation decimation aliases this down to 12000-9000=3000Hz,
    // landing squarely in FT8's decode band. The anti-alias filter should
    // suppress it well before that happens.
    const aliasSourceFreq = 9000;
    const aliasedTargetFreq = OUT_RATE - aliasSourceFreq; // 3000 Hz
    const input = tone(aliasSourceFreq, IN_RATE, DURATION);
    const output = resampleTo12k(input, IN_RATE);
    const aliasedEnergy = goertzelMagnitude(output, aliasedTargetFreq, OUT_RATE);
    expect(aliasedEnergy).toBeLessThan(0.1);
  });

  test('strongly attenuates energy above the new Nyquist compared to a passband tone', () => {
    const passbandTone = tone(1000, IN_RATE, DURATION);
    const stopbandTone = tone(9000, IN_RATE, DURATION);
    const passbandOut = resampleTo12k(passbandTone, IN_RATE);
    const stopbandOut = resampleTo12k(stopbandTone, IN_RATE);
    expect(rms(stopbandOut)).toBeLessThan(rms(passbandOut) * 0.2);
  });

  test('is a no-op when input is already at the decode rate', () => {
    const input = tone(1000, OUT_RATE, DURATION);
    const output = resampleTo12k(input, OUT_RATE);
    expect(output).toBe(input);
  });

  test('output length matches the expected decimation ratio', () => {
    const input = tone(1000, IN_RATE, DURATION);
    const output = resampleTo12k(input, IN_RATE);
    const expectedLen = Math.floor((input.length * OUT_RATE) / IN_RATE);
    expect(output.length).toBe(expectedLen);
  });
});
