/**
 * MFSK (Multiple Frequency Shift Keying) decoder
 *
 * Two processing paths, selected by syncMode:
 *
 * 'free'      — Goertzel block algorithm. One MFSKSymbol per block (baudRate ×
 *               oversampleFactor). Drives onSymbol only. No framing.
 *
 * 'start-bit' — IQ per-sample demodulation. Detects the Mark→Space falling
 *               edge, jumps 1.5 bit-periods to the center of the first data bit,
 *               then samples once per bit period. Every sample point emits one
 *               MFSKSymbol (grid) AND advances the frame state machine (text).
 *               Grid and text therefore show exactly the same bit decisions.
 */

export interface MFSKChannel {
  id:    string;
  freq:  number;   // Hz
  color: string;   // hex colour for UI
  label: string;   // short label, e.g. "T0"
}

export interface MFSKSymbol {
  symbolIndex:   number;
  winnerChannel: MFSKChannel | null;
  bits:          boolean[];   // per bitOrder option
  powers:        number[];    // relative power per channel, 0–1
  rawPower:      number;      // absolute magnitude of winner, 0–1
  squelched:     boolean;
}

/** One complete framed word decoded by the start-bit sync state machine. */
export interface MFSKWord {
  bits:      boolean[];              // charBits bits in time order
  channels:  (MFSKChannel | null)[]; // dominant channel per data bit
  squelched: boolean;
  validStop: boolean;                // true if stop period was non-Space
}

export interface MFSKDecoderOptions {
  /** Bit encoding order of the MFSKSymbol.bits array. */
  bitOrder:         'msb' | 'lsb';
  /** Goertzel oversampling factor (free mode only). */
  oversampleFactor: number;
  /** 'free' = emit one symbol per Goertzel window; 'start-bit' = IQ edge sync. */
  syncMode:         'free' | 'start-bit';
  /** Data bits per framed word (start-bit sync mode). */
  charBits:         number;
  /** Stop period in symbol periods (may be fractional, e.g. 1.5). */
  stopBitSymbols:   number;
  /**
   * false (default, USB): channel 0 = Mark (lower freq) = idle/logical-1.
   *   Edge trigger: Mark→Space (dom 0→non-0). Start bit = Space = dom≠0.
   * true  (LSB): channel 0 = Space (higher in LSB convention) = logical-0.
   *   Edge trigger: Mark→Space (dom non-0→0). Start bit = Space = dom=0.
   */
  reverseShift:     boolean;
  /**
   * Apply Gray code to the winning tone index before computing the symbol's
   * bit pattern.  Required for MFSK16/8/32 where tone N carries Gray(N).
   */
  useGrayCode:      boolean;
}

export const DEFAULT_DECODER_OPTIONS: MFSKDecoderOptions = {
  bitOrder:         'msb',
  oversampleFactor: 1,
  syncMode:         'free',
  charBits:         8,
  stopBitSymbols:   1,
  reverseShift:     false,
  useGrayCode:      false,
};

export interface MFSKStats {
  baudRate:      number;
  bitsPerSymbol: number;
  totalSymbols:  number;
  numChannels:   number;
}

export class MFSKDecoder {
  private readonly sampleRate: number;
  private channels:            MFSKChannel[] = [];
  private baudRate:            number;
  private squelchThreshold  = 0;
  private opts:               MFSKDecoderOptions;

  // ── Goertzel state (free mode) ─────────────────────────────────────────────
  private buffer:    Float32Array;
  private bufferPos  = 0;
  private totalSymbols = 0;

  // ── IQ per-sample state (start-bit sync mode) ──────────────────────────────
  // Arrays have length === channels.length when IQ path is active, else 0.
  private _iqCos:  number[] = [];
  private _iqSin:  number[] = [];
  private _iqDCos: number[] = [];
  private _iqDSin: number[] = [];
  private _iqI1:   number[] = [];   // LPF stage 1 I
  private _iqQ1:   number[] = [];   // LPF stage 1 Q
  private _iqI2:   number[] = [];   // LPF stage 2 I
  private _iqQ2:   number[] = [];   // LPF stage 2 Q
  private _iqAlpha  = 0;
  private _iqSpb    = 882;          // samples per bit  (sampleRate / baudRate)
  private _iqClock  = 0;            // samples until next bit-center sample
  private _iqPrevDom = 1;           // previous dominant channel (1 = Mark = idle)
  // Frame state machine
  private _iqPhase: 'idle' | 'data' | 'stop' = 'idle';
  private _iqBits:  boolean[]             = [];
  private _iqChans: (MFSKChannel | null)[] = [];

  onSymbol?: (symbol: MFSKSymbol) => void;
  onWord?:   (word: MFSKWord)     => void;

  constructor(
    sampleRate: number,
    channels: MFSKChannel[]           = [],
    baudRate                          = 31.25,
    opts: Partial<MFSKDecoderOptions> = {},
  ) {
    this.sampleRate = sampleRate;
    this.channels   = [...channels];
    this.baudRate   = Math.max(1, baudRate);
    this.opts       = { ...DEFAULT_DECODER_OPTIONS, ...opts };
    this.buffer     = new Float32Array(this._bufferLen());
    this._iqInit();
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  updateChannels(channels: MFSKChannel[]): void {
    this.channels = [...channels];
    this._iqInit();
    this._resetBuffer();
  }

  updateBaudRate(baudRate: number): void {
    this.baudRate = Math.max(1, baudRate);
    this._iqInit();
    this._resetBuffer();
  }

  updateOptions(opts: Partial<MFSKDecoderOptions>): void {
    this.opts = { ...this.opts, ...opts };
    this._iqInit();
    this._resetBuffer();
  }

  setSquelch(threshold: number): void {
    this.squelchThreshold = threshold;
  }

  processSamples(input: Float32Array): MFSKSymbol[] {
    if (this._iqActive()) {
      // IQ path: one unified pipeline drives both onSymbol and onWord
      return this._processIQ(input);
    }

    // Goertzel path (free mode): symbols only, no framing
    const results: MFSKSymbol[] = [];
    const bufLen = this.buffer.length;
    let i = 0;
    while (i < input.length) {
      const space = bufLen - this.bufferPos;
      const take  = Math.min(space, input.length - i);
      this.buffer.set(input.subarray(i, i + take), this.bufferPos);
      this.bufferPos += take;
      i += take;
      if (this.bufferPos >= bufLen) {
        const sym = this._goertzelBlock();
        if (sym) { results.push(sym); this.onSymbol?.(sym); this.totalSymbols++; }
        this.bufferPos = 0;
      }
    }
    return results;
  }

  reset(): void {
    this.buffer.fill(0);
    this.bufferPos    = 0;
    this.totalSymbols = 0;
    this._iqInit();
  }

  get stats(): MFSKStats {
    const n = Math.max(2, this.channels.length);
    return {
      baudRate:      this.baudRate,
      bitsPerSymbol: Math.ceil(Math.log2(n)),
      totalSymbols:  this.totalSymbols,
      numChannels:   this.channels.length,
    };
  }

  // ── IQ demodulator ─────────────────────────────────────────────────────────

  private _iqActive(): boolean {
    return this.opts.syncMode === 'start-bit'
      && this._iqDCos.length === this.channels.length
      && this.channels.length >= 2;
  }

  private _iqInit(): void {
    if (this.opts.syncMode !== 'start-bit' || this.channels.length < 2) {
      this._iqDCos = [];
      return;
    }
    const n = this.channels.length;
    this._iqCos  = new Array(n).fill(1);
    this._iqSin  = new Array(n).fill(0);
    this._iqDCos = new Array(n).fill(0);
    this._iqDSin = new Array(n).fill(0);
    this._iqI1   = new Array(n).fill(0);
    this._iqQ1   = new Array(n).fill(0);
    this._iqI2   = new Array(n).fill(0);
    this._iqQ2   = new Array(n).fill(0);

    for (let i = 0; i < n; i++) {
      const w = (2 * Math.PI * this.channels[i].freq) / this.sampleRate;
      this._iqDCos[i] = Math.cos(w);
      this._iqDSin[i] = Math.sin(w);
    }

    this._iqSpb = this.sampleRate / this.baudRate;

    // LPF cutoff: respond within half a bit, reject adjacent tones
    const minSep = this.channels.slice(1).reduce(
      (m, ch, i) => Math.min(m, Math.abs(ch.freq - this.channels[i].freq)),
      Infinity,
    );
    const cutoff = Math.max(
      this.baudRate * 0.6,
      Math.min(isFinite(minSep) ? minSep / 3 : this.baudRate * 4, this.baudRate * 4),
    );
    this._iqAlpha = 1 - Math.exp(-2 * Math.PI * cutoff / this.sampleRate);

    this._iqClock    = Math.round(this._iqSpb);
    // USB (reverseShift=false): idle = Mark = ch0 = dom 0
    // LSB (reverseShift=true):  idle = Mark = ch1 = dom 1
    this._iqPrevDom  = (this.opts.reverseShift ?? false) ? 1 : 0;
    this._iqPhase    = 'idle';
    this._iqBits     = [];
    this._iqChans    = [];
  }

  /** Per-sample IQ downconvert + 2-stage LPF → dominant channel index & power. */
  private _iqDemod(s: number): { dom: number; maxPow: number } {
    const n = this._iqDCos.length;
    const a = this._iqAlpha;
    let maxPow = -Infinity, dom = 0;
    for (let i = 0; i < n; i++) {
      const c  = this._iqDCos[i] * this._iqCos[i] - this._iqDSin[i] * this._iqSin[i];
      const ss = this._iqDSin[i] * this._iqCos[i] + this._iqDCos[i] * this._iqSin[i];
      this._iqCos[i] = c; this._iqSin[i] = ss;
      const I0 = s * c,  Q0 = s * ss;
      this._iqI1[i] += a * (I0 - this._iqI1[i]);
      this._iqQ1[i] += a * (Q0 - this._iqQ1[i]);
      this._iqI2[i] += a * (this._iqI1[i] - this._iqI2[i]);
      this._iqQ2[i] += a * (this._iqQ1[i] - this._iqQ2[i]);
      const pow = this._iqI2[i] * this._iqI2[i] + this._iqQ2[i] * this._iqQ2[i];
      if (pow > maxPow) { maxPow = pow; dom = i; }
    }
    return { dom, maxPow };
  }

  /**
   * Unified IQ processing pipeline.
   *
   * Every baud-clock tick emits one MFSKSymbol (grid) and advances the frame
   * state machine (text decode). Both use the same dom decision, so grid and
   * text are always consistent.
   *
   * Edge detection (Mark→Space falling edge) re-aligns the baud clock to
   * land at bit centers, exactly like RTTYDecoder.processSamples.
   */
  private _processIQ(input: Float32Array): MFSKSymbol[] {
    const results: MFSKSymbol[] = [];
    const n          = this.channels.length;
    const bitsNeeded = Math.max(1, Math.ceil(Math.log2(Math.max(2, n))));

    // USB (reverseShift=false): ch0=Mark=idle; edge fires when dom leaves 0.
    // LSB (reverseShift=true):  ch1=Mark=idle; edge fires when dom reaches 0.
    const usbMode = !(this.opts.reverseShift ?? false);

    for (let i = 0; i < input.length; i++) {
      const { dom, maxPow } = this._iqDemod(input[i]);

      // Mark→Space edge = start of start bit (re-sync only from idle)
      const edgeFired = usbMode
        ? (this._iqPrevDom === 0 && dom !== 0)   // USB: Mark(0)→Space(≠0)
        : (this._iqPrevDom !== 0 && dom === 0);  // LSB: Mark(≠0)→Space(0)

      if (this._iqPhase === 'idle' && edgeFired) {
        this._iqClock = Math.round(this._iqSpb * 1.5);  // skip to center of bit 0
        this._iqBits  = [];
        this._iqChans = [];
        this._iqPhase = 'data';
      }
      this._iqPrevDom = dom;

      // Baud clock — fires at each bit center
      if (--this._iqClock > 0) continue;
      this._iqClock = Math.round(this._iqSpb);

      // Build symbol from IQ powers at this sample point
      const bits: boolean[] = [];
      if (this.opts.bitOrder === 'lsb') {
        for (let b = 0; b < bitsNeeded; b++) bits.push(!!(dom & (1 << b)));
      } else {
        for (let b = bitsNeeded - 1; b >= 0; b--) bits.push(!!(dom & (1 << b)));
      }
      let peakIQ = 0;
      const rawPows = new Array<number>(n);
      for (let j = 0; j < n; j++) {
        rawPows[j] = this._iqI2[j] * this._iqI2[j] + this._iqQ2[j] * this._iqQ2[j];
        if (rawPows[j] > peakIQ) peakIQ = rawPows[j];
      }
      const normPowers = rawPows.map(p => peakIQ > 1e-24 ? Math.min(1, p / peakIQ) : 0);

      const sym: MFSKSymbol = {
        symbolIndex:   dom,
        winnerChannel: this.channels[dom] ?? null,
        bits,
        powers:        normPowers,
        rawPower:      Math.sqrt(Math.max(0, peakIQ)),
        squelched:     false,
      };
      results.push(sym);
      this.onSymbol?.(sym);
      this.totalSymbols++;

      // Frame state machine — same dom drives text decode
      switch (this._iqPhase) {
        case 'idle':
          break;  // free-running clock in idle: symbol emitted, no framing action

        case 'data': {
          // USB: ch0=Mark=1, ch1=Space=0 → bit = (dom===0)
          // LSB: ch1=Mark=1, ch0=Space=0 → bit = (dom!==0)
          const bitVal = usbMode ? (dom === 0) : (dom !== 0);
          this._iqBits.push(bitVal);
          this._iqChans.push(this.channels[dom] ?? null);
          if (this._iqBits.length >= this.opts.charBits) {
            this._iqPhase = 'stop';
          }
          break;
        }

        case 'stop': {
          const stopIsMark = usbMode ? (dom === 0) : (dom !== 0);
          this.onWord?.({
            bits:      [...this._iqBits],
            channels:  [...this._iqChans],
            squelched: false,
            validStop: stopIsMark,
          });
          this._iqPhase = 'idle';
          break;
        }
      }
    }
    return results;
  }

  // ── Goertzel block processing (free mode) ──────────────────────────────────

  private _bufferLen(): number {
    return Math.max(
      1,
      Math.round(this.sampleRate / (this.baudRate * Math.max(1, this.opts.oversampleFactor))),
    );
  }

  private _resetBuffer(): void {
    this.buffer    = new Float32Array(this._bufferLen());
    this.bufferPos = 0;
  }

  private _goertzel(freq: number): number {
    const len   = this.buffer.length;
    const k     = (freq * len) / this.sampleRate;
    const omega = (2 * Math.PI * k) / len;
    const coeff = 2 * Math.cos(omega);
    let s1 = 0, s2 = 0;
    for (let i = 0; i < len; i++) {
      const s0 = this.buffer[i] + coeff * s1 - s2;
      s2 = s1; s1 = s0;
    }
    return (s1 * s1 + s2 * s2 - s1 * s2 * coeff) / (len * len * 0.25);
  }

  private _goertzelBlock(): MFSKSymbol | null {
    if (this.channels.length === 0) return null;

    const rawPowers = this.channels.map(ch => this._goertzel(ch.freq));
    let maxIdx = 0;
    for (let i = 1; i < rawPowers.length; i++) {
      if (rawPowers[i] > rawPowers[maxIdx]) maxIdx = i;
    }
    const peakRaw   = rawPowers[maxIdx];
    const absAmp    = Math.sqrt(Math.max(0, peakRaw));
    const norm      = rawPowers.map(p => (peakRaw > 1e-12 ? Math.min(1, p / peakRaw) : 0));
    const squelched = this.squelchThreshold > 0 && absAmp < this.squelchThreshold;

    const bitsNeeded = Math.max(1, Math.ceil(Math.log2(Math.max(2, this.channels.length))));
    // Apply Gray decode if requested (MFSK16/8: tone N carries gray(N))
    const symBits = this.opts.useGrayCode
      ? maxIdx ^ (maxIdx >> 1)
      : maxIdx;
    const bits: boolean[] = [];
    if (this.opts.bitOrder === 'lsb') {
      for (let b = 0; b < bitsNeeded; b++) bits.push(!!(symBits & (1 << b)));
    } else {
      for (let b = bitsNeeded - 1; b >= 0; b--) bits.push(!!(symBits & (1 << b)));
    }

    return {
      symbolIndex:   maxIdx,
      winnerChannel: this.channels[maxIdx] ?? null,
      bits,
      powers:        norm,
      rawPower:      absAmp,
      squelched,
    };
  }
}
