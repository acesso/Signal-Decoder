import { SSTV_MODES } from './constants';

const FREQ_LEADER = 1900;
const FREQ_BREAK  = 1200;
const FREQ_BIT1   = 1100;
const FREQ_BIT0   = 1300;

const WINDOW_MS     = 10;   // Goertzel window size in ms
const LEADER_MIN_MS = 200;  // minimum leader duration before accepting
const BREAK_MIN_MS  = 5;
const BIT_MS        = 30;

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

function dominantFreq(samples: Float32Array, sampleRate: number): 'leader' | 'break' | 'bit1' | 'bit0' | 'noise' {
  const noise = 1e-5;
  const pLeader = goertzelPower(samples, FREQ_LEADER, sampleRate);
  const pBreak  = goertzelPower(samples, FREQ_BREAK,  sampleRate);
  const pBit1   = goertzelPower(samples, FREQ_BIT1,   sampleRate);
  const pBit0   = goertzelPower(samples, FREQ_BIT0,   sampleRate);
  const best    = Math.max(pLeader, pBreak, pBit1, pBit0);
  if (best < noise) return 'noise';
  if (best === pLeader) return 'leader';
  if (best === pBreak)  return 'break';
  if (best === pBit1)   return 'bit1';
  return 'bit0';
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
  private phaseMs  = 0;
  private bits: number[] = [];

  constructor(sampleRate: number) {
    this.sampleRate = sampleRate;
    this.windowSize = Math.floor((WINDOW_MS / 1000) * sampleRate);
    this.buf = new Float32Array(this.windowSize);
  }

  reset(): void {
    this.phase   = Phase.IDLE;
    this.phaseMs = 0;
    this.bits    = [];
    this.bufPos  = 0;
    this.buf.fill(0);
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

  private _processWindow(win: Float32Array): VISResult {
    const freq = dominantFreq(win, this.sampleRate);

    switch (this.phase) {
      case Phase.IDLE:
        if (freq === 'leader') { this.phase = Phase.LEADER1; this.phaseMs = WINDOW_MS; }
        break;

      case Phase.LEADER1:
        if (freq === 'leader') {
          this.phaseMs += WINDOW_MS;
        } else if (freq === 'break' && this.phaseMs >= LEADER_MIN_MS) {
          this.phase = Phase.BREAK; this.phaseMs = WINDOW_MS;
        } else {
          this._reset();
        }
        break;

      case Phase.BREAK:
        if (freq === 'break') {
          this.phaseMs += WINDOW_MS;
        } else if (freq === 'leader' && this.phaseMs >= BREAK_MIN_MS) {
          this.phase = Phase.LEADER2; this.phaseMs = WINDOW_MS;
        } else {
          this._reset();
        }
        break;

      case Phase.LEADER2:
        if (freq === 'leader') {
          this.phaseMs += WINDOW_MS;
        } else if (freq === 'break' && this.phaseMs >= LEADER_MIN_MS) {
          this.phase = Phase.START; this.phaseMs = WINDOW_MS;
        } else {
          this._reset();
        }
        break;

      case Phase.START:
        this.phaseMs += WINDOW_MS;
        if (this.phaseMs >= BIT_MS) {
          this.phase = Phase.BITS; this.phaseMs = 0; this.bits = [];
        }
        break;

      case Phase.BITS:
        this.phaseMs += WINDOW_MS;
        if (this.phaseMs >= BIT_MS) {
          // Classify accumulated window as a bit (skip parity — index 7)
          if (this.bits.length < 7) {
            this.bits.push(freq === 'bit1' ? 1 : 0);
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
    this.bits    = [];
  }
}
