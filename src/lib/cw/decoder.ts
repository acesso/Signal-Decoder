/**
 * CW (Morse code) decoder — per-sample IIR pipeline
 *
 * Pipeline per sample:
 *   audio → biquad bandpass (Q=8 around tone freq)
 *         → envelope detector (fast attack, moderate release)
 *         → peak follower (fast rise ~10 ms, slow fall ~300 ms)
 *         → 50 % / 25 % hysteresis against peak → mark / space FSM
 *         → adaptive dit-length tracking → Morse table lookup
 *
 * Squelch is a hard gate: when the envelope is below the user-set
 * threshold the state machine receives forced-space, so background
 * noise never accumulates phantom elements in the symbol buffer.
 */

import { MORSE_TABLE } from './morse-table';

export interface CWStats {
  wpm:           number;
  partialSymbol: string;
  toneDetected:  boolean;
  snrDb:         number | null;
  /** Raw envelope level (0–1 range) for the signal-level meter */
  envelopeLevel: number;
  /** True when the squelch is gating the output */
  squelched:     boolean;
}

export class CWDecoder {
  private readonly sampleRate: number;
  private toneFreq:            number;

  // Biquad bandpass filter coefficients (recomputed on tone change)
  private bpB0 = 0; private bpB2 = 0;
  private bpA1 = 0; private bpA2 = 0;
  // Biquad state
  private bpX1 = 0; private bpX2 = 0;
  private bpY1 = 0; private bpY2 = 0;

  // Envelope detector — asymmetric IIR (fast attack, moderate release)
  private envelope = 0;
  private readonly attackAlpha:  number; // ~3 ms
  private readonly releaseAlpha: number; // ~5 ms

  // Peak follower — tracks signal amplitude for AGC-style thresholding.
  // Fast rise so it locks onto the signal quickly; slow fall so the
  // thresholds stay stable across inter-element and inter-character gaps.
  private peak = 0;
  private readonly peakRiseAlpha: number; // ~10 ms
  private readonly peakFallAlpha: number; // ~300 ms

  // Noise floor — used only for SNR display, not for mark detection.
  private noiseFloor:              number;
  private readonly noiseDownAlpha: number; // ~50 ms
  private readonly noiseUpAlpha:   number; // ~10 s

  // Squelch — hard gate: envelope < threshold → forced space
  private squelchThreshold = 0;

  // Mark / space FSM
  private isMark        = false;
  private markSamples   = 0;
  private spaceSamples  = 0;
  private wordSpaceOut  = false; // prevents duplicate word-space emission

  // Adaptive dit-length estimate (samples)
  private ditSamples: number;

  // Partial symbol for the character being assembled
  private symbolBuffer = '';

  /** Called with each decoded character or space */
  onText?: (chars: string) => void;

  constructor(sampleRate: number, toneFreq = 700, wpmInit = 20) {
    this.sampleRate = sampleRate;
    this.toneFreq   = toneFreq;
    this.ditSamples = this.wpmToDit(wpmInit);

    this.attackAlpha    = 1 - Math.exp(-1 / (0.003 * sampleRate)); // 3 ms
    this.releaseAlpha   = 1 - Math.exp(-1 / (0.005 * sampleRate)); // 5 ms

    this.peakRiseAlpha  = 1 - Math.exp(-1 / (0.010 * sampleRate)); // 10 ms
    this.peakFallAlpha  = 1 - Math.exp(-1 / (0.300 * sampleRate)); // 300 ms

    this.noiseDownAlpha = 1 - Math.exp(-1 / (0.050 * sampleRate)); // 50 ms
    this.noiseUpAlpha   = 1 - Math.exp(-1 / (10    * sampleRate)); // 10 s
    this.noiseFloor     = 1e-6;

    this.setupFilter(toneFreq);
  }

  // ── Filter ─────────────────────────────────────────────────────────────────

  private setupFilter(freq: number): void {
    // Standard biquad bandpass (unity gain at centre frequency)
    // Q=8 → bandwidth ≈ 88 Hz, passes ±44 Hz around the tone
    const Q     = 8;
    const w0    = (2 * Math.PI * freq) / this.sampleRate;
    const sinW0 = Math.sin(w0);
    const cosW0 = Math.cos(w0);
    const alpha = sinW0 / (2 * Q);
    const a0    = 1 + alpha;
    this.bpB0 =  (sinW0 / 2) / a0;
    this.bpB2 = -(sinW0 / 2) / a0;
    this.bpA1 = (-2 * cosW0)  / a0;
    this.bpA2 =  (1 - alpha)  / a0;
    this.bpX1 = this.bpX2 = this.bpY1 = this.bpY2 = 0;
  }

  setToneFreq(freq: number): void {
    this.toneFreq = freq;
    this.setupFilter(freq);
  }

  getToneFreq(): number { return this.toneFreq; }

  // ── Per-sample processing ──────────────────────────────────────────────────

  processSamples(samples: Float32Array): CWStats {
    for (let i = 0; i < samples.length; i++) {
      const x = samples[i];

      // 1. Bandpass filter
      const y = this.bpB0 * x + this.bpB2 * this.bpX2
                - this.bpA1 * this.bpY1 - this.bpA2 * this.bpY2;
      this.bpX2 = this.bpX1; this.bpX1 = x;
      this.bpY2 = this.bpY1; this.bpY1 = y;

      // 2. Envelope detection (asymmetric IIR on |filtered|)
      const abs    = Math.abs(y);
      const eAlpha = abs > this.envelope ? this.attackAlpha : this.releaseAlpha;
      this.envelope += eAlpha * (abs - this.envelope);

      // 3. Peak follower (fast rise, slow fall — AGC reference level)
      if (this.envelope > this.peak) {
        this.peak += this.peakRiseAlpha * (this.envelope - this.peak);
      } else {
        this.peak *= (1 - this.peakFallAlpha);
      }
      if (this.peak < 1e-9) this.peak = 1e-9;

      // 4. Noise floor (SNR display only — not used for mark detection)
      const floorDiff = this.envelope - this.noiseFloor;
      this.noiseFloor += floorDiff < 0
        ? floorDiff * this.noiseDownAlpha
        : floorDiff * this.noiseUpAlpha;
      if (this.noiseFloor < 1e-9) this.noiseFloor = 1e-9;

      // 5. Squelch gate + peak-relative hysteresis
      //    markThresh  = 50 % of peak  (rising edge)
      //    spaceThresh = 25 % of peak  (falling edge — gives clean trailing edges)
      const squelched   = this.squelchThreshold > 0 && this.envelope < this.squelchThreshold;
      const markThresh  = this.peak * 0.50;
      const spaceThresh = this.peak * 0.25;
      const nowMark = !squelched && (this.isMark
        ? this.envelope > spaceThresh
        : this.envelope > markThresh);

      // 6. State transitions
      if (nowMark !== this.isMark) {
        if (nowMark) {
          this.handleSpaceEnd(this.spaceSamples);
          this.spaceSamples = 0;
          this.wordSpaceOut = false;
        } else {
          this.handleMarkEnd(this.markSamples);
          this.markSamples = 0;
        }
        this.isMark = nowMark;
      }

      if (this.isMark) {
        this.markSamples++;
      } else {
        this.spaceSamples++;
        // Emit word space in real-time — once, when the gap reaches 5 dits.
        // Threshold is 5 rather than 7 because the slow-release envelope
        // makes measured gaps appear ~5–8 ms shorter than their true duration.
        if (!this.wordSpaceOut
            && this.spaceSamples >= Math.round(this.ditSamples * 5)
            && this.symbolBuffer.length > 0) {
          this.flushSymbol();
          this.onText?.(' ');
          this.wordSpaceOut = true;
        }
      }
    }

    const squelchedNow = this.squelchThreshold > 0 && this.envelope < this.squelchThreshold;
    return {
      wpm:           Math.round(1.2 / (this.ditSamples / this.sampleRate)),
      partialSymbol: this.symbolBuffer,
      toneDetected:  this.isMark,
      snrDb:         this.noiseFloor > 1e-9
                       ? 10 * Math.log10(Math.max(this.envelope / this.noiseFloor, 1))
                       : null,
      envelopeLevel: this.envelope,
      squelched:     squelchedNow,
    };
  }

  // ── Element handlers ───────────────────────────────────────────────────────

  private handleMarkEnd(samples: number): void {
    // Ignore pulses shorter than 20 % of a dit (key clicks, noise)
    if (samples < this.ditSamples * 0.2) return;

    const isDot = samples < this.ditSamples * 2.0;
    this.symbolBuffer += isDot ? '.' : '-';

    // Adapt dit estimate: dot duration directly, dash duration / 3.
    // 10 % learning rate converges faster than 5 % while staying smooth.
    const measured  = isDot ? samples : samples / 3;
    this.ditSamples = this.ditSamples * 0.90 + measured * 0.10;
    this.ditSamples = Math.max(this.wpmToDit(70), Math.min(this.wpmToDit(3), this.ditSamples));
  }

  private handleSpaceEnd(samples: number): void {
    // Intra-element gap (< 0.3 dit) — key-click / noise, keep accumulating
    if (samples < this.ditSamples * 0.3) return;

    // Character boundary at 1.5 dits.
    // With 5 ms envelope release, measured inter-element gaps are ~55 ms at
    // 20 WPM (0.87 dits) and inter-character gaps are ~175 ms (2.8 dits).
    // 1.5 dits sits cleanly between the two so neither is misclassified.
    if (samples >= this.ditSamples * 1.5 && this.symbolBuffer.length > 0) {
      this.flushSymbol();
    }
  }

  private flushSymbol(): void {
    if (this.symbolBuffer.length === 0) return;
    const char = MORSE_TABLE[this.symbolBuffer] ?? '?';
    this.onText?.(char);
    this.symbolBuffer = '';
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private wpmToDit(wpm: number): number {
    return Math.round((1.2 / wpm) * this.sampleRate);
  }

  getStats(): CWStats {
    const squelchedNow = this.squelchThreshold > 0 && this.envelope < this.squelchThreshold;
    return {
      wpm:           Math.round(1.2 / (this.ditSamples / this.sampleRate)),
      partialSymbol: this.symbolBuffer,
      toneDetected:  this.isMark,
      snrDb:         this.noiseFloor > 1e-9
                       ? 10 * Math.log10(Math.max(this.envelope / this.noiseFloor, 1))
                       : null,
      envelopeLevel: this.envelope,
      squelched:     squelchedNow,
    };
  }

  setSquelch(threshold: number): void {
    this.squelchThreshold = Math.max(0, threshold);
  }

  reset(): void {
    this.bpX1 = this.bpX2 = this.bpY1 = this.bpY2 = 0;
    this.envelope     = 0;
    this.peak         = 0;
    this.noiseFloor   = 1e-6;
    this.isMark       = false;
    this.markSamples  = this.spaceSamples = 0;
    this.wordSpaceOut = false;
    this.symbolBuffer = '';
    this.ditSamples   = this.wpmToDit(20);
  }
}
