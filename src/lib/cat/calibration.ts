/**
 * Frequency-calibration math for the uSDX BLACK_BRICK reference oscillator.
 *
 * Method (receive-only — the radio never transmits, so no dummy load is
 * involved): tune the radio in USB exactly TONE_HZ below a known off-air
 * reference carrier (WWV, CHU, …). The carrier appears as an audio tone that
 * should be exactly TONE_HZ; any deviation is the radio's frequency error at
 * the dial frequency. Because every frequency the radio generates scales
 * linearly with its assumed TCXO value (si5351.fxtal, CAT command XF), the
 * measured error converts directly into a corrected fxtal.
 *
 * All functions here are pure math — measured spectra in, numbers out — so
 * they are unit-testable without audio hardware or a radio.
 */

/** Audio tone the wizard tunes for: dial = reference − TONE_HZ (USB). */
export const TONE_HZ = 1000;

/**
 * Off-air reference stations with carrier frequencies in Hz, transmitter
 * coordinates, and crude propagation priors used by rankReferenceStations():
 * dayScore/nightScore capture how well the band survives D-layer absorption
 * vs. needing ionospheric support, and [skipMinKm, skipMaxKm] is the rough
 * sweet-spot distance window for one/two-hop skywave on that band.
 */
export interface ReferenceStation {
  label: string;
  hz: number;
  notes: string;
  lat: number;
  lon: number;
  dayScore: number;
  nightScore: number;
  skipMinKm: number;
  skipMaxKm: number;
  /** True for stations that are actual frequency/time standards (WWV, CHU —
   *  referenced to a cesium/GPS-disciplined source, accurate to a tiny
   *  fraction of a Hz). False for ordinary broadcast transmitters, which are
   *  only crystal/synthesizer-locked to their nominal channel — typically
   *  accurate to within a few Hz, plenty for this purpose, but not a true
   *  standard. Drives an honest caveat in the UI rather than treating every
   *  entry as equally authoritative. */
  isPrecisionStandard: boolean;
}

const WWV = { lat: 40.6805, lon: -105.0406 };   // Ft. Collins, Colorado
const CHU = { lat: 45.2947, lon: -75.7573 };    // Ottawa, Canada
const RNA = { lat: -3.0906, lon: -59.9825 };    // Rádio Nacional da Amazônia, Manaus, Brazil

export const REFERENCE_STATIONS: ReferenceStation[] = [
  { label: 'WWV 10 MHz',    hz: 10_000_000, notes: 'Ft. Collins, USA — the all-rounder, works day and night', ...WWV, dayScore: 1.0,  nightScore: 0.7,  skipMinKm: 400, skipMaxKm: 6000, isPrecisionStandard: true },
  { label: 'WWV 15 MHz',    hz: 15_000_000, notes: 'Best daytime long-distance propagation',                  ...WWV, dayScore: 1.0,  nightScore: 0.15, skipMinKm: 800, skipMaxKm: 10000, isPrecisionStandard: true },
  { label: 'WWV 5 MHz',     hz: 5_000_000,  notes: 'Best at night',                                           ...WWV, dayScore: 0.45, nightScore: 1.0,  skipMinKm: 200, skipMaxKm: 2500, isPrecisionStandard: true },
  { label: 'WWV 2.5 MHz',   hz: 2_500_000,  notes: 'Night, short range',                                      ...WWV, dayScore: 0.15, nightScore: 0.8,  skipMinKm: 0,   skipMaxKm: 800, isPrecisionStandard: true },
  { label: 'CHU 7.850 MHz', hz: 7_850_000,  notes: 'Ottawa, Canada (USB voice + carrier)',                    ...CHU, dayScore: 0.75, nightScore: 0.9,  skipMinKm: 300, skipMaxKm: 4000, isPrecisionStandard: true },
  { label: 'CHU 3.330 MHz', hz: 3_330_000,  notes: 'Night',                                                   ...CHU, dayScore: 0.25, nightScore: 0.9,  skipMinKm: 0,   skipMaxKm: 1500, isPrecisionStandard: true },
  { label: 'CHU 14.670 MHz', hz: 14_670_000, notes: 'Day',                                                    ...CHU, dayScore: 1.0,  nightScore: 0.15, skipMinKm: 800, skipMaxKm: 10000, isPrecisionStandard: true },
  // Not a time/frequency standard — an ordinary AM broadcast transmitter on a
  // fixed 11,780 kHz channel. Its carrier is only as accurate as its own
  // crystal/synthesizer, but that's normally within a few Hz — close enough
  // to be a useful LOCAL reference for this region when WWV/CHU are weak.
  // Very short path from NE/N Brazil → strong via groundwave/near-vertical
  // skywave both day and evening, so no meaningful day/night skip-zone gap.
  { label: 'R. Nac. da Amazônia 11.78 MHz', hz: 11_780_000, notes: 'Manaus, Brazil — strong local reference, not an official time standard', ...RNA, dayScore: 0.9, nightScore: 0.9, skipMinKm: 0, skipMaxKm: 5000, isPrecisionStandard: false },
];

// ── Geo/time-based station ranking ───────────────────────────────────────────

const DEG = Math.PI / 180;

/** Great-circle distance between two points, in km. */
export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = (lat2 - lat1) * DEG;
  const dLon = (lon2 - lon1) * DEG;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Great-circle midpoint via unit vectors (antimeridian-safe). Returns [lat, lon]. */
export function greatCircleMidpoint(lat1: number, lon1: number, lat2: number, lon2: number): [number, number] {
  const toVec = (lat: number, lon: number) => [
    Math.cos(lat * DEG) * Math.cos(lon * DEG),
    Math.cos(lat * DEG) * Math.sin(lon * DEG),
    Math.sin(lat * DEG),
  ];
  const a = toVec(lat1, lon1), b = toVec(lat2, lon2);
  const m = [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  const len = Math.hypot(m[0], m[1], m[2]) || 1;
  return [Math.asin(m[2] / len) / DEG, Math.atan2(m[1], m[0]) / DEG];
}

/**
 * Approximate solar elevation (degrees) at a location and UTC instant.
 * Standard declination/hour-angle formula, ±1° — plenty for day/night
 * classification of an HF path.
 */
export function solarElevationDeg(lat: number, lon: number, date: Date): number {
  const start = Date.UTC(date.getUTCFullYear(), 0, 0);
  const dayOfYear = (date.getTime() - start) / 86_400_000;
  const decl = -23.44 * Math.cos((360 / 365) * (dayOfYear + 10) * DEG);
  const utcHours = date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600;
  const solarTime = utcHours + lon / 15;
  const hourAngle = (solarTime - 12) * 15;
  const sinEl = Math.sin(lat * DEG) * Math.sin(decl * DEG)
    + Math.cos(lat * DEG) * Math.cos(decl * DEG) * Math.cos(hourAngle * DEG);
  return Math.asin(Math.max(-1, Math.min(1, sinEl))) / DEG;
}

export interface StationScore {
  station: ReferenceStation;
  score: number;
  /** Great-circle distance to the transmitter, null when no location given */
  distanceKm: number | null;
  /** Sun up at the path midpoint (or local-clock day proxy without location) */
  daylight: boolean;
  /** Short human-readable justification, e.g. "daytime path, ≈7,900 km" */
  reason: string;
}

/**
 * Rank the reference stations by how likely their carrier is receivable from
 * the given location right now. Falls back to a local-clock day/night proxy
 * (no distance term) when coordinates are unavailable. Purely heuristic —
 * one-hop skip-zone windows and D-layer day/night priors — but reliably puts
 * WWV 15 MHz on top for a daytime transcontinental path and the low bands on
 * top at night nearby, which is all a "Suggested" badge needs.
 */
export function rankReferenceStations(date: Date, lat?: number | null, lon?: number | null): StationScore[] {
  const hasGeo = lat !== null && lat !== undefined && lon !== null && lon !== undefined;

  const scored = REFERENCE_STATIONS.map(station => {
    let distanceKm: number | null = null;
    let daylight: boolean;

    if (hasGeo) {
      distanceKm = haversineKm(lat, lon, station.lat, station.lon);
      const [midLat, midLon] = greatCircleMidpoint(lat, lon, station.lat, station.lon);
      daylight = solarElevationDeg(midLat, midLon, date) > 0;
    } else {
      const h = date.getHours();
      daylight = h >= 7 && h < 19; // local-clock proxy
    }

    let distFactor = 1;
    if (distanceKm !== null) {
      if (station.skipMinKm > 0 && distanceKm < station.skipMinKm) {
        // Inside the skip zone — one-hop skywave lands beyond the listener
        distFactor = Math.max(0.15, distanceKm / station.skipMinKm);
      } else if (distanceKm > station.skipMaxKm) {
        // Beyond the sweet spot — each extra window-length halves the odds
        distFactor = Math.max(0.05, 1 - (distanceKm - station.skipMaxKm) / station.skipMaxKm);
      }
    }

    const score = (daylight ? station.dayScore : station.nightScore) * distFactor;
    const reason = `${daylight ? 'daytime' : 'night'} path${
      distanceKm !== null ? `, ≈${Math.round(distanceKm).toLocaleString('en-US')} km` : ''
    }`;
    return { station, score, distanceKm, daylight, reason };
  });

  return scored.sort((a, b) => b.score - a.score);
}

/**
 * Parabolic (quadratic) interpolation of an FFT magnitude peak.
 * Given the bin magnitudes in dB around a peak, returns the peak's position
 * as a fractional bin offset in (-0.5, +0.5) relative to the center bin.
 */
export function parabolicPeakOffset(dbLeft: number, dbCenter: number, dbRight: number): number {
  const denom = dbLeft - 2 * dbCenter + dbRight;
  if (denom >= 0) return 0; // not a peak / flat — no interpolation possible
  const off = 0.5 * (dbLeft - dbRight) / denom;
  // Clamp: interpolation beyond ±0.5 bin means the neighbor is the real peak
  return Math.max(-0.5, Math.min(0.5, off));
}

export interface TonePeak {
  /** Interpolated tone frequency in Hz */
  hz: number;
  /** Peak level minus the median in-band level, in dB — a crude SNR */
  snrDb: number;
  /** Peak level minus the second-highest peak that's NOT one of its immediate
   *  neighbors, in dB. A real carrier towers over everything else in the band
   *  (prominence tens of dB); a noisy/no-signal spectrum has many similar-
   *  height bumps (prominence just a few dB), even when its single tallest
   *  bump still clears the SNR-vs-median threshold. This is what actually
   *  distinguishes "locked onto the carrier" from "locked onto a noise spur". */
  prominenceDb: number;
}

/** A measurement only counts as a genuine carrier lock above this prominence. */
export const MIN_PROMINENCE_DB = 8;

/**
 * Find the strongest spectral peak inside [minHz, maxHz] of an FFT dB
 * spectrum (as produced by AnalyserNode.getFloatFrequencyData) and refine it
 * with parabolic interpolation. Returns null when the band is empty.
 */
export function findTonePeak(
  db: Float32Array,
  sampleRate: number,
  fftSize: number,
  minHz = 300,
  maxHz = 3000,
): TonePeak | null {
  const binHz = sampleRate / fftSize;
  const lo = Math.max(1, Math.ceil(minHz / binHz));
  const hi = Math.min(db.length - 2, Math.floor(maxHz / binHz));
  if (hi <= lo) return null;

  let peak = lo;
  for (let i = lo; i <= hi; i++) {
    if (db[i] > db[peak]) peak = i;
  }
  if (!isFinite(db[peak])) return null;

  const off = parabolicPeakOffset(db[peak - 1], db[peak], db[peak + 1]);
  const hz = (peak + off) * binHz;

  // Median of the band as the noise floor reference
  const band = Array.from(db.slice(lo, hi + 1)).filter(v => isFinite(v)).sort((a, b) => a - b);
  if (band.length === 0) return null;
  const median = band[Math.floor(band.length / 2)];

  // Second-highest peak at least 5 bins away from the main one (skips its
  // own interpolation skirt) — the gap to THAT, not to the median, is what
  // separates a real single carrier from a noisy/multi-signal spectrum.
  const exclusionBins = 5;
  let secondPeak = -Infinity;
  for (let i = lo; i <= hi; i++) {
    if (Math.abs(i - peak) <= exclusionBins) continue;
    if (db[i] > secondPeak) secondPeak = db[i];
  }
  const prominenceDb = isFinite(secondPeak) ? db[peak] - secondPeak : db[peak] - median;

  return { hz, snrDb: db[peak] - median, prominenceDb };
}

/** Median of an array (copy-safe). */
export function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Median absolute deviation — robust spread estimate for stability checks. */
export function medianAbsDeviation(values: number[]): number {
  const m = median(values);
  return median(values.map(v => Math.abs(v - m)));
}

export interface CalibrationResult {
  /** Measured audio tone (Hz) */
  measuredToneHz: number;
  /** Radio frequency error at the dial frequency: positive = radio reads high */
  errorHz: number;
  /** Error in parts-per-million */
  errorPpm: number;
  /** Corrected reference-oscillator value to write via XF */
  newFxtal: number;
  /** Change relative to the current fxtal, in Hz */
  fxtalDeltaHz: number;
}

/**
 * Convert a measured tone into a corrected fxtal.
 *
 * Model: the firmware computes si5351 dividers assuming `fxtalOld`, so every
 * generated frequency scales by k = fxtal_actual / fxtalOld. With the dial at
 * D = ref − TONE_HZ (USB), the audio tone is  M = ref − D·k, and the expected
 * tone is  T = ref − D. Solving:  k = 1 + (T − M) / D, and the true crystal
 * frequency (which is what fxtal must be set to) is  fxtalOld · k.
 */
export function computeCorrection(
  measuredToneHz: number,
  referenceHz: number,
  fxtalOld: number,
  toneHz: number = TONE_HZ,
): CalibrationResult {
  const dial = referenceHz - toneHz;
  const k = 1 + (toneHz - measuredToneHz) / dial;
  const newFxtal = Math.round(fxtalOld * k);
  // errorHz: how far off the radio's tuning is at the dial frequency.
  // M > T means the LO is low → the radio's real RX freq is below the dial
  // reading → displayed frequency reads high by (M − T).
  const errorHz = measuredToneHz - toneHz;
  return {
    measuredToneHz,
    errorHz,
    errorPpm: (errorHz / dial) * 1e6,
    newFxtal,
    fxtalDeltaHz: newFxtal - fxtalOld,
  };
}

/** Acceptance thresholds for a trustworthy measurement. */
export const MIN_SNR_DB = 15;      // peak must stand this far above the band median
export const MAX_SPREAD_HZ = 2;    // MAD of the reading series must be tighter than this
export const MIN_READINGS = 20;    // minimum accepted readings before computing

export interface MeasurementSummary {
  toneHz: number;
  spreadHz: number;
  readings: number;
  ok: boolean;
  reason: string | null;
}

/** Aggregate a series of per-frame tone readings into one robust measurement. */
export function summarizeReadings(readings: TonePeak[]): MeasurementSummary {
  const passingSnr = readings.filter(r => r.snrDb >= MIN_SNR_DB);
  const good = passingSnr.filter(r => r.prominenceDb >= MIN_PROMINENCE_DB).map(r => r.hz);
  if (good.length < MIN_READINGS) {
    // Distinguish "no signal at all" from "signal present but not a single
    // locked carrier" (e.g. band noise, multiple similar-strength stations) —
    // the latter means "you're on the wrong device/frequency", the former
    // means "too quiet", and the fix for each is different.
    const noisyNotLocked = passingSnr.length >= MIN_READINGS && good.length < MIN_READINGS;
    return {
      toneHz: NaN, spreadHz: NaN, readings: good.length, ok: false,
      reason: noisyNotLocked
        ? `Signal present but not a single clean tone (${passingSnr.length} readings had SNR but low prominence) — likely band noise, multiple signals, or the audio input isn't actually the radio`
        : `Only ${good.length} clean readings (need ${MIN_READINGS}) — signal too weak or noisy`,
    };
  }
  const tone = median(good);
  const spread = medianAbsDeviation(good);
  if (spread > MAX_SPREAD_HZ) {
    return {
      toneHz: tone, spreadHz: spread, readings: good.length, ok: false,
      reason: `Reading unstable (±${spread.toFixed(1)} Hz) — QSB/interference, try another reference`,
    };
  }
  return { toneHz: tone, spreadHz: spread, readings: good.length, ok: true, reason: null };
}
