import { SSTV_MODES } from './constants';

const FREQ_LEADER = 1900;
const FREQ_BREAK  = 1200;
const FREQ_BIT1   = 1100;
const FREQ_BIT0   = 1300;

const WINDOW_MS     = 10;   // Goertzel window size in ms
const LEADER_MIN_MS = 200;  // minimum leader duration before accepting
const BREAK_MIN_MS  = 5;
const BIT_MS        = 30;

// Real off-air recordings can carry a genuine hard-silence dropout (a
// recording-chain glitch, not radio noise) of 100ms+ landing right inside a
// ~300ms leader tone — verified against a real captured transmission. A
// consecutive-miss counter can't absorb that: any fixed miss budget large
// enough to survive a 100ms+ gap would also have to survive the same length
// of unrelated noise anywhere else, which stops meaningfully gating
// anything. What actually distinguishes "one real tone with a dropout in
// the middle" from "noise that happens to classify as this tone briefly" is
// the *ratio* of matched-tone time to total elapsed time over the phase —
// tracked as matchedMs/elapsedMs below. A real tone accumulates matchedMs
// steadily even around gaps; noise does not, because DOMINANCE_RATIO
// already filters out most of it per-window, so what's left rarely strings
// together enough matched windows to clear the ratio.
const MIN_MATCH_RATIO = 0.5; // matchedMs / elapsedMs must stay at least this high
// The ratio above is meaningless on too little data — one non-matching
// window right at phase entry (elapsedMs=WINDOW_MS, matchedMs=0) is a ratio
// of 0 regardless of how good the tone is about to be, which instantly
// killed the very case requireNextTone=false exists for (a short BREAK
// starting right after LEADER1 transitions in with matchedMs reset to 0).
// Don't let the ratio check fire until elapsed time clears this floor —
// long enough to be meaningful for the shortest real phase (BREAK, minMs=5)
// without materially delaying when a genuinely bad run gets abandoned.
const MIN_RATIO_SAMPLE_MS = 30;
// Absolute ceiling on how long a phase can drag on trying to reach minMs —
// independent of the ratio, so a very slow trickle of matches over a very
// long stretch (which could still clear MIN_MATCH_RATIO on a short enough
// window) can't stall detection indefinitely on a long noisy file.
const MAX_PHASE_ELAPSED_MS = 900;

const VIS_CODE_MAP: Record<number, keyof typeof SSTV_MODES> = {} as Record<number, keyof typeof SSTV_MODES>;
for (const [k, v] of Object.entries(SSTV_MODES)) {
  VIS_CODE_MAP[v.visCode] = k as keyof typeof SSTV_MODES;
}

enum Phase {
  IDLE,
  LEADER1,
  BREAK,
  LEADER2,
  START,
  BITS,
}

function goertzelPower(samples: Float32Array, targetFreq: number, sampleRate: number): number {
  const n     = samples.length;
  const k     = Math.round((n * targetFreq) / sampleRate);
  const omega = (2 * Math.PI * k) / n;
  const coeff = 2 * Math.cos(omega);
  let q1 = 0, q2 = 0;
  for (let i = 0; i < n; i++) {
    const q0 = coeff * q1 - q2 + samples[i];
    q2 = q1;
    q1 = q0;
  }
  return q1 * q1 + q2 * q2 - q1 * q2 * coeff;
}

interface FreqPowers {
  leader: number;
  break: number;
  bit1: number;
  bit0: number;
}

// offsetHz shifts all 4 target frequencies together — calibrated once from
// the leader tone (see calibrateFrequencyOffset) to compensate for a real
// receive-chain tuning offset. Verified against a real recording: a normal
// ~2% SSB tuning error measured the leader tone at 1936-1945Hz instead of
// nominal 1900Hz, which is already most of the way to the 1100/1200/1300Hz
// bit tones' 100Hz spacing — without correcting for it, classification
// degrades long before any noise/dropout issue even comes into play.
function goertzelPowers(samples: Float32Array, sampleRate: number, offsetHz: number): FreqPowers {
  return {
    leader: goertzelPower(samples, FREQ_LEADER + offsetHz, sampleRate),
    break: goertzelPower(samples, FREQ_BREAK + offsetHz, sampleRate),
    bit1: goertzelPower(samples, FREQ_BIT1 + offsetHz, sampleRate),
    bit0: goertzelPower(samples, FREQ_BIT0 + offsetHz, sampleRate),
  };
}

// Scans a small band around the nominal leader frequency for the true peak,
// once enough clean leader tone has been seen to measure it reliably (called
// only after LEADER_MIN_MS is first satisfied — see _advanceTonePhase).
// ±60Hz covers real-world tuning error with margin (observed ~40Hz on a
// real recording) without wandering far enough to risk locking onto a
// harmonic or unrelated tone.
const CALIBRATION_SCAN_HZ = 60;
const CALIBRATION_STEP_HZ = 2;

function calibrateFrequencyOffset(samples: Float32Array, sampleRate: number): number {
  let bestOffset = 0;
  let bestPower = -Infinity;
  for (let offset = -CALIBRATION_SCAN_HZ; offset <= CALIBRATION_SCAN_HZ; offset += CALIBRATION_STEP_HZ) {
    const power = goertzelPower(samples, FREQ_LEADER + offset, sampleRate);
    if (power > bestPower) {
      bestPower = power;
      bestOffset = offset;
    }
  }
  return bestOffset;
}

// A real VIS tone concentrates energy in one of these 4 narrow bins; random
// broadband noise spreads roughly evenly across all of them. Comparing the
// winner against a fixed absolute power threshold (the previous approach)
// doesn't work on real HF audio: a weak signal's true tone can fall under
// any fixed floor while still clearly dominating the noise around it, and a
// strong noise floor can clear that same fixed floor without containing any
// tone at all. Requiring the winner to beat the *other three bins* by a
// ratio is scale-invariant, like the in-band/out-of-band SNR check
// audioProcessor.ts's silence detector already uses for the same reason.
const DOMINANCE_RATIO = 2.0;
const ABSOLUTE_FLOOR = 1e-7; // still reject true digital silence (all bins ~0)

type ToneClass = 'leader' | 'break' | 'bit1' | 'bit0' | 'noise';

function classifyPowers(p: FreqPowers): ToneClass {
  const entries: Array<['leader' | 'break' | 'bit1' | 'bit0', number]> = [
    ['leader', p.leader], ['break', p.break], ['bit1', p.bit1], ['bit0', p.bit0],
  ];
  entries.sort((a, b) => b[1] - a[1]);
  const [bestName, bestPower] = entries[0];
  const runnerUpPower = entries[1][1];
  if (bestPower < ABSOLUTE_FLOOR) return 'noise';
  if (bestPower < runnerUpPower * DOMINANCE_RATIO) return 'noise';
  return bestName;
}

function dominantFreq(samples: Float32Array, sampleRate: number, offsetHz: number): ToneClass {
  return classifyPowers(goertzelPowers(samples, sampleRate, offsetHz));
}

export interface VISResult {
  detected: boolean;
  modeName?: keyof typeof SSTV_MODES;
  visCode?: number;
}

export class VISDetector {
  private sampleRate: number;
  private windowSize: number;
  private buf: Float32Array;
  private bufPos = 0;

  private phase    = Phase.IDLE;
  // phaseMs tracks matched-tone time only (what actually satisfies minMs);
  // phaseElapsedMs tracks total wall-clock time since entering the phase,
  // matched or not. Their ratio is what MIN_MATCH_RATIO gates on — see the
  // comment above MIN_MATCH_RATIO for why this replaced a consecutive-miss
  // counter.
  private phaseMs  = 0;
  private phaseElapsedMs = 0;
  private bits: number[] = [];
  // Bit classification integrates Goertzel power across the whole 30ms bit
  // period (3 windows) rather than trusting a single trailing 10ms window —
  // one noisy window out of three averaging out is far less likely to flip
  // a data bit (and silently decode the wrong mode, or no mode at all) than
  // one noisy window being the *only* window that decided the bit.
  private bitPowerSum: FreqPowers = { leader: 0, break: 0, bit1: 0, bit0: 0 };
  // Calibrated once per detection attempt from the leader tone (see
  // calibrateFrequencyOffset) — a real receive-chain tuning offset shifts
  // all 4 VIS tones together, and correcting for it matters more than any
  // noise-tolerance mechanism here: verified against a real recording with
  // a ~2% tuning offset, classification was unreliable even in otherwise
  // clean, high-SNR audio until this was applied.
  private freqOffsetHz = 0;
  private calibrated = false;
  // Accumulates matched-leader audio (WINDOW_MS windows) during LEADER1,
  // consumed once by calibrateFrequencyOffset right before the LEADER1
  // phase would transition out. A single 10ms window has ~100Hz Goertzel
  // bin resolution (sampleRate/windowLength) — far too coarse to resolve a
  // tuning offset against VIS tones only 100-200Hz apart; calibrating from
  // one window returned garbage (the whole ±60Hz scan collapsed onto one
  // aliased bin) even on a perfectly clean signal. Buffering ~200ms
  // (LEADER_MIN_MS) of real matched leader tone gives ~5Hz resolution,
  // comfortably enough for a meaningful 2Hz-step scan.
  private calibrationBuffer: number[] = [];

  constructor(sampleRate: number) {
    this.sampleRate = sampleRate;
    this.windowSize = Math.floor((WINDOW_MS / 1000) * sampleRate);
    this.buf = new Float32Array(this.windowSize);
  }

  reset(): void {
    this.phase   = Phase.IDLE;
    this.phaseMs = 0;
    this.phaseElapsedMs = 0;
    this.bits    = [];
    this.bufPos  = 0;
    this.buf.fill(0);
    this.bitPowerSum = { leader: 0, break: 0, bit1: 0, bit0: 0 };
    this.freqOffsetHz = 0;
    this.calibrated = false;
    this.calibrationBuffer = [];
  }

  /**
   * Feed audio samples. Returns a VISResult when a VIS code is fully decoded,
   * or { detected: false } on each partial call.
   */
  process(samples: Float32Array): VISResult {
    for (let i = 0; i < samples.length; i++) {
      this.buf[this.bufPos++] = samples[i];
      if (this.bufPos < this.windowSize) continue;
      this.bufPos = 0;

      const result = this._processWindow(this.buf);
      if (result.detected) return result;
    }
    return { detected: false };
  }

  // Advances a leader/break-style phase: `matchFreq` continues it (advancing
  // both matched and elapsed time), `nextFreq` (once matched phaseMs clears
  // `minMs`) transitions to `nextPhase`, and anything else is a gap — it
  // still advances elapsed time (so the ratio below can see it) but not
  // matched time. Giving up on the whole run happens only if the
  // matched/elapsed ratio drops too low (this reads as noise, not a real
  // tone with dropouts) or elapsed time blows past MAX_PHASE_ELAPSED_MS
  // (this tone should have finished by now regardless of ratio).
  //
  // This replaced an earlier consecutive-miss counter: verified against a
  // real off-air recording, a single hard-silence dropout inside a leader
  // tone can run 100ms+ (a recording-chain glitch, not radio noise) — far
  // longer than any consecutive-miss budget could absorb without also
  // tolerating that much unrelated noise anywhere else. Tracking the ratio
  // over the whole phase instead handles one big gap exactly like many
  // small ones, as long as enough real tone survives elsewhere in the phase.
  //
  // requireNextTone=false additionally lets minMs being satisfied trigger
  // the transition even without ever seeing a `nextFreq`-classified window —
  // for the break tone (~10ms) and VIS start bit (~30ms, same frequency as
  // break), both short enough that a dropout can leave the whole tone too
  // diluted to ever score as its own frequency, so nothing will ever
  // explicitly confirm the next phase started.
  private _advanceTonePhase(
    freq: ReturnType<typeof dominantFreq>,
    matchFreq: 'leader' | 'break',
    nextFreq: 'leader' | 'break',
    minMs: number,
    nextPhase: Phase,
    requireNextTone = true,
  ): void {
    if (freq === matchFreq) {
      this.phaseMs += WINDOW_MS;
      this.phaseElapsedMs += WINDOW_MS;
      if (!requireNextTone && this.phaseMs >= minMs) {
        this.phase = nextPhase;
        this.phaseMs = 0;
        this.phaseElapsedMs = 0;
        return;
      }
    } else if (freq === nextFreq && this.phaseMs >= minMs) {
      this.phase = nextPhase;
      this.phaseMs = WINDOW_MS;
      this.phaseElapsedMs = WINDOW_MS;
      return;
    } else {
      this.phaseElapsedMs += WINDOW_MS;
    }

    if (this.phaseElapsedMs > MAX_PHASE_ELAPSED_MS) {
      this._reset();
      return;
    }
    // The matched/elapsed ratio is only meaningful with enough data to
    // average over, and only for phases with a real matchFreq tone to
    // accumulate against (requireNextTone=true — the ~300ms leader tones).
    // requireNextTone=false phases (break, start bit) are short enough that
    // there often isn't a clean matchFreq window before their true
    // successor tone appears at all — the whole point of requireNextTone
    // was to not require one. Gating them on the same ratio would give up
    // before that successor tone had a chance to show up. MAX_PHASE_ELAPSED_MS
    // above remains their real ceiling.
    if (!requireNextTone) return;
    if (this.phaseElapsedMs >= MIN_RATIO_SAMPLE_MS && this.phaseMs / this.phaseElapsedMs < MIN_MATCH_RATIO) {
      this._reset();
    }
  }

  private _processWindow(win: Float32Array): VISResult {
    // IDLE and IDLE's leader detection always run at the nominal frequency —
    // there is nothing calibrated yet to apply, and this is also how a
    // fresh leader tone gets first noticed at all.
    const powers = goertzelPowers(win, this.sampleRate, this.calibrated ? this.freqOffsetHz : 0);
    const freq = classifyPowers(powers);

    switch (this.phase) {
      case Phase.IDLE:
        if (freq === 'leader') {
          this.phase = Phase.LEADER1;
          this.phaseMs = WINDOW_MS;
          this.phaseElapsedMs = WINDOW_MS;
        }
        break;

      case Phase.LEADER1:
        if (!this.calibrated && freq === 'leader') {
          // Accumulate matched leader audio — a single WINDOW_MS window has
          // nowhere near enough frequency resolution to calibrate from (see
          // calibrationBuffer's comment); this needs to grow across many
          // matched windows first.
          for (let i = 0; i < win.length; i++) this.calibrationBuffer.push(win[i]);
        }
        if (!this.calibrated && this.phaseMs + WINDOW_MS >= LEADER_MIN_MS && freq === 'leader') {
          // About to satisfy LEADER_MIN_MS on this window — calibrate now,
          // from the accumulated buffer of real, already-confirmed leader
          // tone, before it's used to classify anything past this point
          // (break/bits, where a consistent offset matters most since
          // they're tightly spaced).
          this.freqOffsetHz = calibrateFrequencyOffset(new Float32Array(this.calibrationBuffer), this.sampleRate);
          this.calibrated = true;
          this.calibrationBuffer = [];
        }
        this._advanceTonePhase(freq, 'leader', 'break', LEADER_MIN_MS, Phase.BREAK, false);
        break;

      case Phase.BREAK:
        this._advanceTonePhase(freq, 'break', 'leader', BREAK_MIN_MS, Phase.LEADER2, false);
        break;

      case Phase.LEADER2:
        // requireNextTone=true here (unlike LEADER1's transition into
        // BREAK): LEADER2 is a full ~300ms tone with plenty of margin to
        // actually wait for the real start-bit tone (also 'break'
        // frequency) to appear, and BITS' bit boundaries are counted
        // relative to when START begins — an early, timer-only transition
        // (the requireNextTone=false fallback) starts that count before
        // the real start bit has actually happened, and every subsequent
        // bit boundary drifts from where its real tone actually is.
        // Verified on a clean synthetic header: this fallback firing here
        // shifted BITS' internal clock enough that a data bit landed on
        // the wrong 30ms slice and read back as the wrong value even with
        // zero noise and correct frequency calibration.
        this._advanceTonePhase(freq, 'leader', 'break', LEADER_MIN_MS, Phase.START);
        break;

      case Phase.START:
        // Simple BIT_MS timer, anchored correctly now: LEADER2 above only
        // transitions here once the real start-bit tone was actually seen
        // (requireNextTone=true), so this phase's entry point already
        // coincides with that tone's first window — counting BIT_MS from
        // here lands on the real boundary, unlike before.
        this.phaseMs += WINDOW_MS;
        if (this.phaseMs >= BIT_MS) {
          this.phase = Phase.BITS; this.phaseMs = 0; this.bits = [];
          this.bitPowerSum = { leader: 0, break: 0, bit1: 0, bit0: 0 };
        }
        break;

      case Phase.BITS: {
        this.phaseMs += WINDOW_MS;
        this.bitPowerSum.leader += powers.leader;
        this.bitPowerSum.break += powers.break;
        this.bitPowerSum.bit1 += powers.bit1;
        this.bitPowerSum.bit0 += powers.bit0;
        if (this.phaseMs >= BIT_MS) {
          // Classify the whole 30ms bit period from its summed power, not
          // just this last 10ms window — skip parity (index 7).
          const bitFreq = classifyPowers(this.bitPowerSum);
          this.bitPowerSum = { leader: 0, break: 0, bit1: 0, bit0: 0 };
          if (this.bits.length < 7) {
            this.bits.push(bitFreq === 'bit1' ? 1 : 0);
          } else if (this.bits.length === 7) {
            // parity bit — consume but don't store
            this.bits.push(-1);
          } else {
            // stop bit — decode VIS code
            return this._decode();
          }
          this.phaseMs = 0;
        }
        break;
      }
    }
    return { detected: false };
  }

  private _decode(): VISResult {
    // bits[0..6] are data bits, LSB first
    let code = 0;
    for (let i = 0; i < 7; i++) {
      code |= (this.bits[i] & 1) << i;
    }
    this._reset();
    const modeName = VIS_CODE_MAP[code];
    if (modeName) {
      return { detected: true, modeName, visCode: code };
    }
    // Unknown code — go back to listening
    return { detected: false };
  }

  private _reset(): void {
    this.phase   = Phase.IDLE;
    this.phaseMs = 0;
    this.phaseElapsedMs = 0;
    this.bits    = [];
    this.bitPowerSum = { leader: 0, break: 0, bit1: 0, bit0: 0 };
    this.freqOffsetHz = 0;
    this.calibrated = false;
    this.calibrationBuffer = [];
  }
}
