import { LTRS_TABLE, FIGS_TABLE, LTRS_SHIFT_CODE, FIGS_SHIFT_CODE } from './baudot';

export interface RTTYConfig {
  centerFreq: number;   // Hz — midpoint between mark and space
  carrierShift: number; // Hz — total separation between tones
  baudRate: number;     // baud (symbols per second)
  bitsPerChar: number;  // 5, 7, or 8
  parity: 'none' | 'even' | 'odd' | 'zero' | 'one';
  stopBits: number;     // 1, 1.5, or 2
  // USB RTTY convention: mark = lower tone (default false = standard USB).
  // Set true for LSB or inverted signals ("Rev" mode).
  reverseShift?: boolean;
}

type FSMState = 'IDLE' | 'DATA' | 'PARITY' | 'STOP';

export class RTTYDecoder {
  private sampleRate: number;
  private config: RTTYConfig;

  // Mark oscillator rotation coefficients
  private mCos = 1; private mSin = 0;
  private mDCos = 1; private mDSin = 0;

  // Space oscillator rotation coefficients
  private sCos = 1; private sSin = 0;
  private sDCos = 1; private sDSin = 0;

  // Two-stage IIR lowpass state per channel
  private mI1 = 0; private mQ1 = 0; private mI2 = 0; private mQ2 = 0;
  private sI1 = 0; private sQ1 = 0; private sI2 = 0; private sQ2 = 0;
  private lpfAlpha = 0.01;

  // Baud clock — edge-triggered, not free-running
  private samplesPerBit = 882;
  private samplesUntilSample = 0;
  private prevSymbol = 1; // 1=mark; idle RTTY line = mark

  // FSM
  private fsmState: FSMState = 'IDLE';
  private dataBits = 0;
  private bitIndex = 0;

  // Baudot shift state
  private inFigs = false;
  // CRLF normalization: skip LF that immediately follows CR
  private lastDecodedChar = '';

  constructor(sampleRate: number, config: RTTYConfig) {
    this.sampleRate = sampleRate;
    this.config = { ...config };
    this.reconfigure();
  }

  updateConfig(config: RTTYConfig): void {
    this.config = { ...config };
    this.reconfigure();
    // Abort any in-progress frame so we re-sync on the new parameters
    this.fsmState = 'IDLE';
  }

  private reconfigure(): void {
    const { centerFreq, carrierShift, baudRate } = this.config;
    const Fs = this.sampleRate;

    // Standard USB RTTY: mark = lower tone, space = higher tone.
    // reverseShift = true flips this (for LSB or inverted signals).
    const halfShift = carrierShift / 2;
    const markF  = this.config.reverseShift
      ? centerFreq + halfShift   // mark = higher (LSB / Rev)
      : centerFreq - halfShift;  // mark = lower  (USB, default)
    const spaceF = this.config.reverseShift
      ? centerFreq - halfShift
      : centerFreq + halfShift;

    const mW = (2 * Math.PI * markF)  / Fs;
    const sW = (2 * Math.PI * spaceF) / Fs;
    this.mDCos = Math.cos(mW); this.mDSin = Math.sin(mW);
    this.sDCos = Math.cos(sW); this.sDSin = Math.sin(sW);

    // LPF cutoff: wide enough to respond within half a bit period,
    // narrow enough to reject the opposite tone.
    // Practical sweet-spot: between baudRate/2 and carrierShift/3.
    const cutoff = Math.max(baudRate * 0.6, Math.min(carrierShift / 3, baudRate * 4));
    this.lpfAlpha = 1 - Math.exp(-2 * Math.PI * cutoff / Fs);

    this.samplesPerBit = Fs / baudRate;
  }

  private advanceOscillators(): void {
    let t: number;
    t = this.mDCos * this.mCos - this.mDSin * this.mSin;
    this.mSin = this.mDSin * this.mCos + this.mDCos * this.mSin;
    this.mCos = t;

    t = this.sDCos * this.sCos - this.sDSin * this.sSin;
    this.sSin = this.sDSin * this.sCos + this.sDCos * this.sSin;
    this.sCos = t;
  }

  private lpf(x: number, y: number): number {
    return y + this.lpfAlpha * (x - y);
  }

  // Returns 1 (mark) or 0 (space) via envelope comparison —
  // more robust than FM discriminator for FSK.
  private demodSample(sample: number): 1 | 0 {
    this.advanceOscillators();

    // IQ baseband downconversion
    const mI0 = sample * this.mCos, mQ0 = sample * this.mSin;
    const sI0 = sample * this.sCos, sQ0 = sample * this.sSin;

    // Two-stage IIR lowpass (removes double-frequency component and opposite tone)
    this.mI1 = this.lpf(mI0, this.mI1); this.mI2 = this.lpf(this.mI1, this.mI2);
    this.mQ1 = this.lpf(mQ0, this.mQ1); this.mQ2 = this.lpf(this.mQ1, this.mQ2);
    this.sI1 = this.lpf(sI0, this.sI1); this.sI2 = this.lpf(this.sI1, this.sI2);
    this.sQ1 = this.lpf(sQ0, this.sQ1); this.sQ2 = this.lpf(this.sQ1, this.sQ2);

    // Compare envelope power — winner is the active tone
    const mPow = this.mI2 * this.mI2 + this.mQ2 * this.mQ2;
    const sPow = this.sI2 * this.sI2 + this.sQ2 * this.sQ2;
    return mPow >= sPow ? 1 : 0;
  }

  private decodeBaudot(code: number): string {
    if (code === LTRS_SHIFT_CODE) { this.inFigs = false; return ''; }
    if (code === FIGS_SHIFT_CODE) { this.inFigs = true;  return ''; }
    const ch = (this.inFigs ? FIGS_TABLE : LTRS_TABLE)[code] ?? '';
    if (!ch) return '';
    const c = ch.charCodeAt(0);
    if (c === 0 || c === 5 || c === 0x1b || c === 0x1f) return '';
    if (c === 7) return '🔔'; // BEL
    // Normalise CRLF → single \n (RTTY sends CR then LF for each line break)
    if (ch === '\r') { this.lastDecodedChar = '\r'; return '\n'; }
    if (ch === '\n') {
      const prev = this.lastDecodedChar;
      this.lastDecodedChar = '\n';
      return prev === '\r' ? '' : '\n'; // drop LF that follows the CR we already emitted
    }
    this.lastDecodedChar = ch;
    return ch;
  }

  private decodeASCII(code: number): string {
    if (code < 0x20 || code > 0x7e) return '';
    return String.fromCharCode(code);
  }

  processSamples(samples: Float32Array): string {
    let output = '';

    for (let i = 0; i < samples.length; i++) {
      const symbol = this.demodSample(samples[i]);

      if (this.fsmState === 'IDLE') {
        // Detect mark→space falling edge = start of start bit
        if (this.prevSymbol === 1 && symbol === 0) {
          // First data bit center is at 1.5 bit periods from this edge
          this.samplesUntilSample = Math.round(this.samplesPerBit * 1.5);
          this.dataBits = 0;
          this.bitIndex = 0;
          this.fsmState = 'DATA';
        }
        this.prevSymbol = symbol;
        continue;
      }

      this.prevSymbol = symbol;
      if (--this.samplesUntilSample > 0) continue;

      // Clock tick — schedule next sample exactly one bit period later
      this.samplesUntilSample = Math.round(this.samplesPerBit);

      switch (this.fsmState) {
        case 'DATA':
          // LSB first
          this.dataBits |= symbol << this.bitIndex;
          if (++this.bitIndex >= this.config.bitsPerChar) {
            this.fsmState = this.config.parity !== 'none' ? 'PARITY' : 'STOP';
          }
          break;

        case 'PARITY':
          // Consume and discard — parity errors are silently tolerated
          this.fsmState = 'STOP';
          break;

        case 'STOP': {
          // Any framing error still returns to IDLE so the next start bit is caught
          if (symbol === 1) {
            const code = this.dataBits & ((1 << this.config.bitsPerChar) - 1);
            output += this.config.bitsPerChar === 5
              ? this.decodeBaudot(code)
              : this.decodeASCII(code);
          }
          this.fsmState = 'IDLE';
          break;
        }
      }
    }

    return output;
  }

  reset(): void {
    this.mCos = 1; this.mSin = 0;
    this.sCos = 1; this.sSin = 0;
    this.mI1 = 0; this.mQ1 = 0; this.mI2 = 0; this.mQ2 = 0;
    this.sI1 = 0; this.sQ1 = 0; this.sI2 = 0; this.sQ2 = 0;
    this.samplesUntilSample = 0;
    this.prevSymbol = 1;
    this.fsmState = 'IDLE';
    this.dataBits = 0;
    this.bitIndex = 0;
    this.inFigs = false;
    this.lastDecodedChar = '';
  }
}
