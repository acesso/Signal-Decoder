/**
 * Unit tests for the frequency-calibration math (src/lib/cat/calibration.ts).
 * Pure math — no audio hardware, no radio.
 */

import {
  TONE_HZ,
  parabolicPeakOffset,
  findTonePeak,
  median,
  medianAbsDeviation,
  computeCorrection,
  summarizeReadings,
  MIN_SNR_DB,
  MIN_PROMINENCE_DB,
  MIN_READINGS,
  haversineKm,
  greatCircleMidpoint,
  solarElevationDeg,
  rankReferenceStations,
  REFERENCE_STATIONS,
  type TonePeak,
} from '../calibration';

// Build a synthetic AnalyserNode-style dB spectrum containing one tone.
// The tone's energy is spread over the two nearest bins so parabolic
// interpolation has something realistic to chew on.
function syntheticSpectrum(toneHz: number, sampleRate = 48000, fftSize = 32768, peakDb = -20, floorDb = -90): Float32Array {
  const bins = fftSize / 2;
  const db = new Float32Array(bins).fill(floorDb);
  const binHz = sampleRate / fftSize;
  const exact = toneHz / binHz;
  const center = Math.round(exact);
  const frac = exact - center; // -0.5..0.5
  // Simple symmetric leakage model: neighbors get less energy the further
  // the true tone sits from them (in dB, quadratic falloff like a window lobe).
  db[center]     = peakDb - 6 * frac * frac;
  db[center - 1] = peakDb - 6 * (1 + frac) * (1 + frac);
  db[center + 1] = peakDb - 6 * (1 - frac) * (1 - frac);
  return db;
}

describe('parabolicPeakOffset', () => {
  test('symmetric peak → no offset', () => {
    expect(parabolicPeakOffset(-40, -20, -40)).toBeCloseTo(0, 6);
  });

  test('leans toward the stronger neighbor', () => {
    expect(parabolicPeakOffset(-40, -20, -30)).toBeGreaterThan(0);
    expect(parabolicPeakOffset(-30, -20, -40)).toBeLessThan(0);
  });

  test('flat/non-peak input → 0 (no divide-by-zero)', () => {
    expect(parabolicPeakOffset(-20, -20, -20)).toBe(0);
  });

  test('clamped to ±0.5 bin', () => {
    expect(Math.abs(parabolicPeakOffset(-20.01, -20, -60))).toBeLessThanOrEqual(0.5);
  });
});

describe('findTonePeak', () => {
  const SR = 48000, N = 32768;

  test('recovers an on-bin tone exactly', () => {
    const toneHz = 1000.34; // near 1 kHz, arbitrary
    const peak = findTonePeak(syntheticSpectrum(toneHz), SR, N);
    expect(peak).not.toBeNull();
    expect(peak!.hz).toBeCloseTo(toneHz, 0);      // within a fraction of the 1.46 Hz bin
    expect(Math.abs(peak!.hz - toneHz)).toBeLessThan(0.5);
    expect(peak!.snrDb).toBeGreaterThan(MIN_SNR_DB);
  });

  test('sub-bin accuracy across fractional positions', () => {
    for (const toneHz of [999.2, 1000.0, 1000.7, 1001.3]) {
      const peak = findTonePeak(syntheticSpectrum(toneHz), SR, N)!;
      expect(Math.abs(peak.hz - toneHz)).toBeLessThan(0.5);
    }
  });

  test('ignores peaks outside the search band', () => {
    const spectrum = syntheticSpectrum(100); // below 300 Hz default min
    const peak = findTonePeak(spectrum, SR, N);
    // The only actual tone is out of band; whatever bin wins is at the floor,
    // so SNR must be ~0 — a caller filtering on MIN_SNR_DB rejects it.
    expect(peak === null || peak.snrDb < 3).toBe(true);
  });

  test('empty/silent spectrum (all -Infinity) → null', () => {
    const db = new Float32Array(16384).fill(-Infinity);
    expect(findTonePeak(db, SR, N)).toBeNull();
  });

  test('a real carrier has high prominence over the rest of the band', () => {
    const peak = findTonePeak(syntheticSpectrum(1002), SR, N)!;
    expect(peak.prominenceDb).toBeGreaterThan(MIN_PROMINENCE_DB);
  });

  // Regression for a live finding: with no real carrier tuned in, a receiver
  // still reports "signal" everywhere (band noise, images, birdies) — the
  // tallest of many similar-height bumps can still clear the SNR-vs-median
  // bar despite there being no genuine single tone. This is exactly what was
  // captured live when the calibration wizard's audio input was NOT actually
  // hearing the radio (wrong OS input device selected): a spectrum with many
  // peaks all within ~2 dB of each other, none towering over the others.
  test('a noisy/no-carrier spectrum can pass SNR-vs-median but fails prominence', () => {
    const bins = SR / N; // ~1.46 Hz/bin
    const db = new Float32Array(N / 2).fill(-90);
    // Scatter a few dozen similar-height bumps across the audio band — no
    // single one dominates, unlike a real carrier's one tall spike.
    let seed = 7;
    const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    for (let f = 300; f < 3000; f += 40) {
      const bin = Math.round(f / bins);
      db[bin] = -55 + rand() * 3; // all within ~3 dB of each other
    }
    const peak = findTonePeak(db, SR, N)!;
    expect(peak).not.toBeNull();
    expect(peak.snrDb).toBeGreaterThan(MIN_SNR_DB); // passes the old, insufficient check
    expect(peak.prominenceDb).toBeLessThan(MIN_PROMINENCE_DB); // correctly rejected by the new one
  });
});

describe('median / medianAbsDeviation', () => {
  test('median odd/even', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
  });

  test('MAD is robust to one outlier', () => {
    expect(medianAbsDeviation([1000, 1000.1, 999.9, 1000, 5000])).toBeLessThan(0.2);
  });
});

describe('computeCorrection', () => {
  const FXTAL = 25_000_000;
  const WWV10 = 10_000_000;

  test('perfect tone → no change', () => {
    const r = computeCorrection(TONE_HZ, WWV10, FXTAL);
    expect(r.newFxtal).toBe(FXTAL);
    expect(r.errorHz).toBe(0);
    expect(r.errorPpm).toBe(0);
    expect(r.fxtalDeltaHz).toBe(0);
  });

  test('tone 4.2 Hz high → crystal actually LOW → fxtal decreases proportionally', () => {
    // M > T means the LO landed low, i.e. the real crystal is slower than
    // assumed. k = 1 + (1000 − 1004.2)/9,999,000 ≈ 1 − 0.42 ppm.
    const r = computeCorrection(1004.2, WWV10, FXTAL);
    expect(r.errorHz).toBeCloseTo(4.2, 6);
    expect(r.errorPpm).toBeCloseTo(0.42, 2);
    // exact: −10.50105 Hz, rounded to the integer fxtal grid
    expect(r.fxtalDeltaHz).toBe(-11);
    expect(r.newFxtal).toBe(FXTAL + r.fxtalDeltaHz);
  });

  test('tone low → fxtal increases', () => {
    const r = computeCorrection(997.0, WWV10, FXTAL);
    expect(r.fxtalDeltaHz).toBeGreaterThan(0);
  });

  test('correction converges: applying it makes the model tone exact', () => {
    // Simulate: real crystal 24,999,990 Hz, firmware assumes 25,000,000.
    const realFxtal = 24_999_990;
    const dial = WWV10 - TONE_HZ;
    const k = realFxtal / FXTAL;
    const simulatedTone = WWV10 - dial * k; // what the wizard would measure
    const r = computeCorrection(simulatedTone, WWV10, FXTAL);
    expect(r.newFxtal).toBe(realFxtal);
    // After applying, dividers use the true value → tone becomes exactly 1000.
    const toneAfter = WWV10 - dial * (realFxtal / r.newFxtal);
    expect(toneAfter).toBeCloseTo(TONE_HZ, 6);
  });

  test('scales with the reference frequency (same tone error → double ppm at half the freq)', () => {
    // 10 Hz tone error keeps integer rounding of fxtal negligible
    const at10 = computeCorrection(1010, 10_000_000, FXTAL);
    const at5  = computeCorrection(1010, 5_000_000, FXTAL);
    expect(Math.abs(at5.errorPpm)).toBeGreaterThan(Math.abs(at10.errorPpm) * 1.9);
    expect(Math.abs(at5.fxtalDeltaHz)).toBeGreaterThan(Math.abs(at10.fxtalDeltaHz) * 1.9);
  });
});

describe('summarizeReadings', () => {
  const good = (hz: number): TonePeak => ({ hz, snrDb: MIN_SNR_DB + 10, prominenceDb: MIN_PROMINENCE_DB + 10 });
  const weak = (hz: number): TonePeak => ({ hz, snrDb: MIN_SNR_DB - 10, prominenceDb: MIN_PROMINENCE_DB - 10 });

  test('stable strong series → ok, median tone', () => {
    const readings = Array.from({ length: 30 }, (_, i) => good(1002 + (i % 3) * 0.1));
    const s = summarizeReadings(readings);
    expect(s.ok).toBe(true);
    expect(s.toneHz).toBeCloseTo(1002.1, 1);
    expect(s.reason).toBeNull();
  });

  test('weak readings are discarded → not enough data', () => {
    const readings = Array.from({ length: 30 }, () => weak(1002));
    const s = summarizeReadings(readings);
    expect(s.ok).toBe(false);
    expect(s.readings).toBe(0);
    expect(s.reason).toMatch(/clean readings/);
  });

  test('unstable tone → rejected with spread reason', () => {
    const readings = Array.from({ length: MIN_READINGS * 2 }, (_, i) => good(1000 + (i % 2 ? 8 : -8)));
    const s = summarizeReadings(readings);
    expect(s.ok).toBe(false);
    expect(s.reason).toMatch(/unstable/);
  });

  test('robust to a few dropout outliers', () => {
    const readings = [
      ...Array.from({ length: 28 }, () => good(1001.5)),
      good(500), good(2900), // two garbage frames
    ];
    const s = summarizeReadings(readings);
    expect(s.ok).toBe(true);
    expect(s.toneHz).toBeCloseTo(1001.5, 3);
  });

  // Regression: high SNR but low prominence (band noise, not a locked carrier)
  // must be rejected with a distinct, actionable reason — not silently treated
  // as "too weak", which would send the operator looking for a stronger signal
  // instead of checking whether their audio input is even the radio.
  test('high SNR but low prominence → rejected with a distinct "not locked" reason', () => {
    const noisy = (hz: number): TonePeak => ({ hz, snrDb: MIN_SNR_DB + 5, prominenceDb: MIN_PROMINENCE_DB - 3 });
    const readings = Array.from({ length: 30 }, (_, i) => noisy(800 + i * 20));
    const s = summarizeReadings(readings);
    expect(s.ok).toBe(false);
    expect(s.reason).toMatch(/not a single clean tone/);
  });
});

describe('geo helpers', () => {
  // Fortaleza, Brazil (the operator's rough QTH) and the two transmitter sites
  const FORTALEZA = { lat: -3.73, lon: -38.52 };

  test('haversine — known distances', () => {
    // Fortaleza → Ft. Collins (WWV) ≈ 8,500 km; → Ottawa (CHU) ≈ 6,600 km
    expect(haversineKm(FORTALEZA.lat, FORTALEZA.lon, 40.6805, -105.0406)).toBeGreaterThan(7500);
    expect(haversineKm(FORTALEZA.lat, FORTALEZA.lon, 40.6805, -105.0406)).toBeLessThan(9500);
    expect(haversineKm(FORTALEZA.lat, FORTALEZA.lon, 45.2947, -75.7573)).toBeGreaterThan(5500);
    expect(haversineKm(FORTALEZA.lat, FORTALEZA.lon, 45.2947, -75.7573)).toBeLessThan(7500);
    expect(haversineKm(10, 20, 10, 20)).toBe(0);
  });

  test('greatCircleMidpoint — antimeridian-safe', () => {
    const [lat, lon] = greatCircleMidpoint(0, 179, 0, -179);
    expect(lat).toBeCloseTo(0, 5);
    expect(Math.abs(lon)).toBeCloseTo(180, 1); // NOT 0 — naive averaging would say 0
  });

  test('solarElevationDeg — sanity at the equator on the equinox', () => {
    // ~2026-03-20, 12:00 UTC at (0°, 0°): sun near zenith
    const noon = new Date(Date.UTC(2026, 2, 20, 12, 0, 0));
    expect(solarElevationDeg(0, 0, noon)).toBeGreaterThan(80);
    // Same instant on the opposite side of the planet: deep night
    expect(solarElevationDeg(0, 180, noon)).toBeLessThan(-80);
  });
});

describe('rankReferenceStations', () => {
  const FORTALEZA = { lat: -3.73, lon: -38.52 };
  // 15:00 UTC = midday across the Americas; 06:00 UTC = night over the whole path
  const DAY   = new Date(Date.UTC(2026, 6, 5, 15, 0, 0));
  const NIGHT = new Date(Date.UTC(2026, 6, 5, 6, 0, 0));

  test('daytime transcontinental path → a high band (15/14.67/10 MHz) on top', () => {
    const top = rankReferenceStations(DAY, FORTALEZA.lat, FORTALEZA.lon)[0];
    expect(top.daylight).toBe(true);
    expect(top.station.hz).toBeGreaterThanOrEqual(10_000_000);
  });

  test('night long path → low bands rank above 15 MHz', () => {
    const ranked = rankReferenceStations(NIGHT, FORTALEZA.lat, FORTALEZA.lon);
    const idx = (hz: number) => ranked.findIndex(r => r.station.hz === hz);
    expect(idx(10_000_000)).toBeLessThan(idx(15_000_000));  // 10 MHz beats 15 at night
    expect(ranked[0].daylight).toBe(false);
  });

  test('close to the transmitter at night → the low bands win', () => {
    // ~200 km from Ottawa, night: CHU 3.33 / WWV low bands should outrank 15 MHz
    const ranked = rankReferenceStations(NIGHT, 46.8, -71.2); // Québec City
    const idx = (hz: number) => ranked.findIndex(r => r.station.hz === hz);
    expect(idx(3_330_000)).toBeLessThan(idx(14_670_000));
    expect(idx(3_330_000)).toBeLessThan(idx(15_000_000));
  });

  test('no location → still ranks using the local-clock day/night proxy', () => {
    const ranked = rankReferenceStations(new Date(2026, 6, 5, 12, 0, 0)); // local noon
    expect(ranked).toHaveLength(REFERENCE_STATIONS.length);
    expect(ranked[0].distanceKm).toBeNull();
    expect(ranked[0].daylight).toBe(true);
    expect(ranked[0].station.dayScore).toBe(1.0); // a day-strong band on top
    const night = rankReferenceStations(new Date(2026, 6, 5, 2, 0, 0)); // local 2 am
    expect(night[0].daylight).toBe(false);
    expect(night[0].station.nightScore).toBeGreaterThanOrEqual(0.9);
  });

  test('every entry carries a human-readable reason', () => {
    for (const r of rankReferenceStations(DAY, FORTALEZA.lat, FORTALEZA.lon)) {
      expect(r.reason).toMatch(/^(daytime|night) path, ≈[\d,]+ km$/);
    }
  });

  test('Rádio Nacional da Amazônia ranks well from a short regional path (Fortaleza)', () => {
    const ranked = rankReferenceStations(DAY, FORTALEZA.lat, FORTALEZA.lon);
    const idx = (hz: number) => ranked.findIndex(r => r.station.hz === hz);
    // Short intra-Brazil path — should comfortably outrank the long-haul
    // low bands that need a full night's D-layer absorption relief to work.
    expect(idx(11_780_000)).toBeLessThan(idx(2_500_000));
    expect(idx(11_780_000)).toBeLessThan(idx(3_330_000));
  });

  test('is-precision-standard flag: only WWV/CHU are true frequency standards', () => {
    const rna = REFERENCE_STATIONS.find(s => s.hz === 11_780_000)!;
    expect(rna.isPrecisionStandard).toBe(false);
    for (const s of REFERENCE_STATIONS) {
      if (s.label.startsWith('WWV') || s.label.startsWith('CHU')) {
        expect(s.isPrecisionStandard).toBe(true);
      }
    }
  });
});
