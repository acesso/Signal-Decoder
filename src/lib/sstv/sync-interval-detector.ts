/**
 * Mid-stream SSTV mode detector — a fallback for when the VIS header was
 * missed (e.g. tuning in after a transmission has already started). VIS
 * detection only works if the leader/break/VIS-bits header is caught intact;
 * miss it and the app has no way to know the mode without this.
 *
 * Every SSTV mode transmits a fixed-width 1200Hz sync pulse once per scan
 * line, at an interval equal to that mode's scanTime (constants.ts) — this is
 * true regardless of mode family (interlaced YUV, sequential YUV/PD, RGB
 * positive or negative timing), since scanTime is defined as the sync-to-sync
 * period in every case. So: keep detecting raw sync pulses (reusing
 * SyncDetector, mode-agnostically) while idle, measure the interval between
 * consecutive pulses, and match it against the closest mode's scanTime. A
 * single interval isn't reliable enough (dropped/spurious pulses, jitter), so
 * this requires several consecutive intervals to agree before declaring a
 * match — exactly like VISDetector requires a clean leader before accepting
 * a break.
 */
import { SyncDetector } from './sync-detector';
import { SSTV_MODES } from './constants';

// Sorted ascending; closest pair is PD90 (703.04) vs WRAASE_SC2_180 (712.0225),
// ~9ms apart — MATCH_TOLERANCE_MS must resolve tighter than half that gap.
const MODE_SCAN_TIMES: Array<{ mode: keyof typeof SSTV_MODES; scanTimeMs: number }> = Object.entries(SSTV_MODES).map(([k, v]) => ({
  mode: k as keyof typeof SSTV_MODES,
  scanTimeMs: v.scanTime,
}));

const MATCH_TOLERANCE_MS = 3; // must beat half the closest scanTime gap (~4.5ms)
const REQUIRED_CONSISTENT_INTERVALS = 3; // consecutive intervals agreeing on the same mode before declaring detection
const MAX_INTERVAL_MS = 1300; // longer than the slowest mode's scanTime (PD290 ≈ 1199.68ms) — anything beyond is not a real line-to-line gap
const MIN_INTERVAL_MS = 140; // shorter than the fastest mode's scanTime (ROBOT36 = 150ms) — reject spurious near-instant repeats

function closestMode(intervalMs: number): { mode: keyof typeof SSTV_MODES; diffMs: number } | null {
  let best: { mode: keyof typeof SSTV_MODES; diffMs: number } | null = null;
  for (const { mode, scanTimeMs } of MODE_SCAN_TIMES) {
    const diffMs = Math.abs(intervalMs - scanTimeMs);
    if (!best || diffMs < best.diffMs) best = { mode, diffMs };
  }
  return best;
}

export interface SyncIntervalResult {
  detected: boolean;
  modeName?: keyof typeof SSTV_MODES;
}

export class SyncIntervalDetector {
  private syncDetector: SyncDetector;
  private sampleRate: number;
  private absoluteSamplePos = 0;
  private lastPulseSamplePos: number | null = null;
  private candidateMode: keyof typeof SSTV_MODES | null = null;
  private consistentCount = 0;

  constructor(sampleRate: number) {
    this.sampleRate = sampleRate;
    this.syncDetector = new SyncDetector(sampleRate);
  }

  reset(): void {
    this.syncDetector.reset();
    this.absoluteSamplePos = 0;
    this.lastPulseSamplePos = null;
    this.candidateMode = null;
    this.consistentCount = 0;
  }

  /** Feed audio samples. Returns a result with detected=true once enough
   *  consecutive sync-to-sync intervals agree on the same mode. */
  process(samples: Float32Array): SyncIntervalResult {
    const demodulated = new Float32Array(samples.length);
    const result = this.syncDetector.process(samples, demodulated);
    this.absoluteSamplePos += samples.length;

    if (!result.detected) return { detected: false };

    // result.offset is relative to the start of this chunk — convert to an
    // absolute sample position so intervals span across chunk boundaries.
    const pulseSamplePos = this.absoluteSamplePos - samples.length + result.offset;

    if (this.lastPulseSamplePos === null) {
      this.lastPulseSamplePos = pulseSamplePos;
      return { detected: false };
    }

    const intervalMs = ((pulseSamplePos - this.lastPulseSamplePos) / this.sampleRate) * 1000;
    this.lastPulseSamplePos = pulseSamplePos;

    if (intervalMs < MIN_INTERVAL_MS || intervalMs > MAX_INTERVAL_MS) {
      // Too short/long to be a real line interval (echo, noise burst,
      // dropped pulse) — doesn't disprove the current candidate, just
      // uninformative, so don't reset the streak on it.
      return { detected: false };
    }

    const match = closestMode(intervalMs);
    if (!match || match.diffMs > MATCH_TOLERANCE_MS) {
      // No mode fits this interval closely enough — likely still mid-sync
      // (VIS bits, or a non-line sync artifact) rather than a real line
      // cadence yet. Reset the streak; a stray interval shouldn't count
      // against an otherwise-consistent run, but an interval that actively
      // contradicts the running candidate should.
      this.consistentCount = 0;
      this.candidateMode = null;
      return { detected: false };
    }

    if (match.mode === this.candidateMode) {
      this.consistentCount++;
    } else {
      this.candidateMode = match.mode;
      this.consistentCount = 1;
    }

    if (this.consistentCount >= REQUIRED_CONSISTENT_INTERVALS) {
      const modeName = this.candidateMode;
      this.reset();
      return { detected: true, modeName };
    }

    return { detected: false };
  }
}
