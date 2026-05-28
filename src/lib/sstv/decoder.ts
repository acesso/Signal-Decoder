import { SSTV_MODES, SSTVMode, SAMPLE_RATE } from './constants';
import { SyncDetector, SyncPulseWidth } from './sync-detector';
import { Robot36LineDecoder, DecodedLine as Robot36DecodedLine } from './robot36-line-decoder';
import { Robot72LineDecoder, DecodedLine as Robot72DecodedLine } from './robot72-line-decoder';
import { PD120LineDecoder, DecodedLine as PD120DecodedLine } from './pd120-line-decoder';
import { PD160LineDecoder, DecodedLine as PD160DecodedLine } from './pd160-line-decoder';
import { PD180LineDecoder, DecodedLine as PD180DecodedLine } from './pd180-line-decoder';
import { PDLineDecoder, DecodedLine as PDDecodedLine } from './pd-line-decoder';
import { ScottieS1LineDecoder, DecodedLine as ScottieS1DecodedLine } from './scottie-s1-line-decoder';
import { ScottieS2LineDecoder, DecodedLine as ScottieS2DecodedLine } from './scottie-s2-line-decoder';
import { MartinLineDecoder, DecodedLine as MartinDecodedLine } from './martin-line-decoder';
import { ScottieDXLineDecoder, DecodedLine as ScottieDXDecodedLine } from './scottie-dx-line-decoder';

type DecodedLine = Robot36DecodedLine | Robot72DecodedLine | PD120DecodedLine | PD160DecodedLine | PD180DecodedLine | PDDecodedLine | ScottieS1DecodedLine | ScottieS2DecodedLine | MartinDecodedLine | ScottieDXDecodedLine;

export enum DecoderState {
  IDLE = 'IDLE',
  DECODING_IMAGE = 'DECODING_IMAGE',
}

export interface DecoderStats {
  state: DecoderState;
  mode: string | null;
  currentLine: number;
  totalLines: number;
  progress: number;
  frequency: number;
  signalStrength: number; // 0-100 percentage
  snr: number | null; // Signal-to-Noise Ratio in dB (null if not available)
}

/**
 * Main SSTV Decoder using sync detection and line-based processing
 * Architecture: Buffer audio → Detect sync pulses → Decode complete lines
 */
export class SSTVDecoder {
  private mode: SSTVMode;
  private modeName: keyof typeof SSTV_MODES;
  private state: DecoderState = DecoderState.IDLE;
  private imageData: Uint8ClampedArray;
  private currentLine: number = 0;
  private sampleRate: number;

  // Audio buffer (7 seconds max for line + safety margin)
  private audioBuffer: Float32Array;
  private demodulatedBuffer: Float32Array; // FM demodulated + compensated values
  private bufferWritePos: number = 0;
  private bufferSize: number;

  // Sync detection
  private syncDetector: SyncDetector;
  private lineDecoder: Robot36LineDecoder | Robot72LineDecoder | PD120LineDecoder | PD160LineDecoder | PD180LineDecoder | PDLineDecoder | ScottieS1LineDecoder | ScottieS2LineDecoder | MartinLineDecoder | ScottieDXLineDecoder;

  // Line boundaries detected by sync pulses
  private lastSyncPos: number = -1;
  private lastSyncWidth: SyncPulseWidth | null = null;

  // Frequency calibration
  private frequencyOffset: number = 0;

  // Signal strength tracking
  private signalStrength: number = 0;

  // Auto slant correction
  private autoSlant: boolean;

  constructor(sampleRate: number = SAMPLE_RATE, modeName: keyof typeof SSTV_MODES = 'ROBOT36', autoSlant: boolean = true) {
    this.sampleRate = sampleRate;
    this.modeName = modeName;
    this.autoSlant = autoSlant;
    this.mode = SSTV_MODES[modeName];

    // Initialize image data based on mode dimensions
    this.imageData = new Uint8ClampedArray(this.mode.width * this.mode.height * 4);

    // Initialize with black
    for (let i = 0; i < this.imageData.length; i += 4) {
      this.imageData[i] = 0;       // R
      this.imageData[i + 1] = 0;   // G
      this.imageData[i + 2] = 0;   // B
      this.imageData[i + 3] = 255; // A
    }

    // Buffer size: 7 seconds (max line ~1200ms for PD290 + safety margin)
    this.bufferSize = Math.floor(sampleRate * 7);
    this.audioBuffer = new Float32Array(this.bufferSize);
    this.demodulatedBuffer = new Float32Array(this.bufferSize);

    // Create sync detector and mode-specific line decoder
    this.syncDetector = new SyncDetector(sampleRate);
    if (modeName === 'ROBOT36') {
      this.lineDecoder = new Robot36LineDecoder(sampleRate);
    } else if (modeName === 'ROBOT72') {
      this.lineDecoder = new Robot72LineDecoder(sampleRate);
    } else if (modeName === 'SCOTTIE_S1') {
      this.lineDecoder = new ScottieS1LineDecoder(sampleRate);
    } else if (modeName === 'SCOTTIE_S2') {
      this.lineDecoder = new ScottieS2LineDecoder(sampleRate);
    } else if (modeName === 'PD120') {
      this.lineDecoder = new PD120LineDecoder(sampleRate);
    } else if (modeName === 'PD160') {
      this.lineDecoder = new PD160LineDecoder(sampleRate);
    } else if (modeName === 'PD180') {
      this.lineDecoder = new PD180LineDecoder(sampleRate);
    } else if (modeName === 'MARTIN_M1') {
      this.lineDecoder = new MartinLineDecoder(sampleRate, 0.146432);
    } else if (modeName === 'MARTIN_M2') {
      this.lineDecoder = new MartinLineDecoder(sampleRate, 0.073216);
    } else if (modeName === 'SCOTTIE_DX') {
      this.lineDecoder = new ScottieDXLineDecoder(sampleRate);
    } else if (modeName === 'WRAASE_SC2_180') {
      this.lineDecoder = new MartinLineDecoder(sampleRate, 0.235, 5.5225, 0.5, 0.5, ['R', 'G', 'B']);
    } else if (modeName === 'PD50') {
      this.lineDecoder = new PDLineDecoder(sampleRate, 320, 0.09152);
    } else if (modeName === 'PD90') {
      this.lineDecoder = new PDLineDecoder(sampleRate, 320, 0.17024);
    } else if (modeName === 'PD240') {
      this.lineDecoder = new PDLineDecoder(sampleRate, 640, 0.2432);
    } else if (modeName === 'PD290') {
      this.lineDecoder = new PDLineDecoder(sampleRate, 640, 0.2944);
    } else {
      // Default to PD120 for unknown modes
      this.lineDecoder = new PD120LineDecoder(sampleRate);
    }
  }

  // Sample counter for periodic logging
  private sampleCounter: number = 0;
  private lastLogTime: number = 0;
  private absoluteSamplePosition: number = 0;

  /**
   * Process audio samples
   */
  processSamples(samples: Float32Array): void {
    // Calculate signal strength (RMS amplitude as percentage) - ALWAYS, even when not decoding
    const rms = Math.sqrt(samples.reduce((sum, val) => sum + val * val, 0) / samples.length);
    // Convert RMS to percentage with more sensitive scaling for typical SSTV signals
    // SSTV signals are often quieter, so scale more aggressively
    const currentStrength = Math.min(100, rms * 500); // More sensitive scaling
    this.signalStrength = this.signalStrength * 0.8 + currentStrength * 0.2;

    if (this.state !== DecoderState.DECODING_IMAGE) {
      return;
    }

    this.sampleCounter += samples.length;

    // Process samples through sync detector FIRST to get demodulated values
    const demodulated = new Float32Array(samples.length);
    const result = this.syncDetector.process(samples, demodulated);

    // Store both raw audio AND demodulated samples in circular buffers
    for (let i = 0; i < samples.length; i++) {
      this.audioBuffer[this.bufferWritePos] = samples[i];
      this.demodulatedBuffer[this.bufferWritePos] = demodulated[i];
      this.bufferWritePos = (this.bufferWritePos + 1) % this.bufferSize;
    }

    // Log periodically (every 2 seconds)
    const now = Date.now();
    if (now - this.lastLogTime > 2000) {
      const avgAmplitude = samples.reduce((sum, val) => sum + Math.abs(val), 0) / samples.length;
      console.log(`Processing audio: ${this.sampleCounter} samples, avgAmp=${avgAmplitude.toFixed(4)}, bufferPos=${this.bufferWritePos}`);
      this.lastLogTime = now;
    }

    if (result.detected) {
      console.log(`🎯 Sync DETECTED! width=${result.width}, offset=${result.offset}, freqOffset=${result.frequencyOffset.toFixed(1)}Hz`);

      // Calculate absolute position in buffer (where sync pulse ended)
      const syncEndPos = (this.bufferWritePos - samples.length + result.offset + this.bufferSize) % this.bufferSize;

      // Martin M1/M2 use a 4.862ms sync pulse, Wraase SC2-180 uses 5.5225ms — both classified as FiveMilliSeconds
      const isMartinMode = this.modeName === 'MARTIN_M1' || this.modeName === 'MARTIN_M2';
      const isShortSyncMode = isMartinMode || this.modeName === 'WRAASE_SC2_180';
      const isValidLineSync =
        result.width === SyncPulseWidth.NineMilliSeconds ||
        result.width === SyncPulseWidth.TwentyMilliSeconds ||
        (isShortSyncMode && result.width === SyncPulseWidth.FiveMilliSeconds);

      if (isValidLineSync &&
          (this.lastSyncPos === -1 || this.distanceInBuffer(this.lastSyncPos, syncEndPos) > this.sampleRate * 0.1)) {

        // Update frequency calibration
        this.frequencyOffset = result.frequencyOffset;

        // If we have a previous sync, decode the line between them
        if (this.lastSyncPos !== -1) {
          const distance = this.distanceInBuffer(this.lastSyncPos, syncEndPos);
          console.log(`📏 Decoding line between syncs: distance=${distance} samples (${(distance/this.sampleRate*1000).toFixed(1)}ms)`);
          this.decodeLine(this.lastSyncPos, syncEndPos);
        }

        this.lastSyncPos = syncEndPos;
        this.lastSyncWidth = result.width;
      } else if (result.width === SyncPulseWidth.FiveMilliSeconds && !isShortSyncMode) {
        console.log(`⏭️ Skipping 5ms sync (VIS code)`);
      } else {
        console.log(`⏭️ Skipping sync: too close to last`);
      }
    }

    this.absoluteSamplePosition += samples.length;
  }

  /**
   * Calculate distance between two positions in circular buffer
   */
  private distanceInBuffer(start: number, end: number): number {
    if (end >= start) {
      return end - start;
    } else {
      return (this.bufferSize - start) + end;
    }
  }

  /**
   * Decode a complete line between two sync pulses
   */
  private decodeLine(startPos: number, endPos: number): void {
    const lineLength = this.distanceInBuffer(startPos, endPos);

    console.log(`🔍 decodeLine: lineLength=${lineLength} samples (${(lineLength/this.sampleRate*1000).toFixed(1)}ms)`);

    // For Scottie modes, we need data BEFORE the sync pulse (negative timing)
    // Check if decoder has getBeginSamples method (for negative timing support)
    const hasNegativeTiming = 'getBeginSamples' in this.lineDecoder;
    const beginOffset = hasNegativeTiming ? (this.lineDecoder as any).getBeginSamples() : 0;
    const endOffset = hasNegativeTiming ? (this.lineDecoder as any).getEndSamples() : lineLength;

    // Calculate total buffer needed including negative timing
    const totalSamples = hasNegativeTiming ? endOffset - beginOffset : lineLength;
    const extractStart = hasNegativeTiming ? (startPos + beginOffset + this.bufferSize) % this.bufferSize : startPos;

    console.log(`🔍 Decoder timing: beginOffset=${beginOffset}, endOffset=${endOffset}, totalSamples=${totalSamples}`);

    // Extract DEMODULATED line samples into contiguous buffer
    const rawSamples = new Float32Array(totalSamples);
    for (let i = 0; i < totalSamples; i++) {
      const pos = (extractStart + i) % this.bufferSize;
      rawSamples[i] = this.demodulatedBuffer[pos]; // Use demodulated, not raw audio
    }

    // Slant correction: resample to expected line length for positive-timing modes.
    // For negative-timing modes (Scottie), the buffer size is already based on expected timing.
    const lineSamples = (this.autoSlant && !hasNegativeTiming)
      ? this.applySlantCorrection(rawSamples, lineLength)
      : rawSamples;

    // Check sample quality
    const avgAmp = lineSamples.reduce((sum, val) => sum + Math.abs(val), 0) / lineSamples.length;
    console.log(`📊 Demodulated line: avgAmp=${avgAmp.toFixed(1)}, slant=${!hasNegativeTiming && this.autoSlant ? ((lineLength / Math.round(this.mode.scanTime * this.sampleRate / 1000) - 1) * 100).toFixed(2) + '%' : 'N/A'}`);

    // Decode the scan line (sync pulse is at -beginOffset for negative timing modes, 0 for others)
    const syncPulsePos = hasNegativeTiming ? -beginOffset : 0;
    const line = this.lineDecoder.decodeScanLine(lineSamples, syncPulsePos, this.frequencyOffset);

    // Copy decoded pixels to image data
    if (line && line.height > 0) {
      // height=0 for even lines (Robot36 stores data), height=1 for PD120, height=2 for Robot36 odd lines (outputs 2 lines)
      const pixelsPerLine = line.width;
      const numLines = line.height;

      for (let lineIdx = 0; lineIdx < numLines; lineIdx++) {
        const targetLine = this.currentLine + lineIdx;
        if (targetLine >= this.mode.height) continue;

        for (let x = 0; x < pixelsPerLine && x < this.mode.width; x++) {
          const srcIdx = (lineIdx * pixelsPerLine + x) * 4;
          const destIdx = (targetLine * this.mode.width + x) * 4;

          this.imageData[destIdx] = line.pixels[srcIdx];       // R
          this.imageData[destIdx + 1] = line.pixels[srcIdx + 1]; // G
          this.imageData[destIdx + 2] = line.pixels[srcIdx + 2]; // B
          this.imageData[destIdx + 3] = 255; // A
        }
      }

      this.currentLine += numLines;
      console.log(`Decoded ${numLines} line(s), now at line ${this.currentLine}/${this.mode.height}`);
    } else if (line && line.height === 0) {
      console.log(`Stored even line for interlacing (Robot36)`);
    }
  }

  /**
   * Resample line buffer to expected length to correct for clock skew (slant).
   * Only applied when the correction factor is within ±10% of 1.0.
   */
  private applySlantCorrection(samples: Float32Array, measuredSamples: number): Float32Array {
    const expectedSamples = Math.round(this.mode.scanTime * this.sampleRate / 1000);
    const corrFactor = measuredSamples / expectedSamples;
    if (Math.abs(corrFactor - 1.0) < 0.0005 || corrFactor < 0.9 || corrFactor > 1.1) {
      return samples;
    }
    const resampled = new Float32Array(expectedSamples);
    for (let i = 0; i < expectedSamples; i++) {
      const srcF = i * corrFactor;
      const srcI = Math.floor(srcF);
      const frac = srcF - srcI;
      resampled[i] = samples[srcI] * (1 - frac) + samples[Math.min(srcI + 1, samples.length - 1)] * frac;
    }
    return resampled;
  }

  /**
   * Get current image data
   */
  getImageData(): Uint8ClampedArray {
    return this.imageData;
  }

  /**
   * Get decoder statistics
   */
  getStats(): DecoderStats {
    return {
      state: this.state,
      mode: this.mode.name,
      currentLine: this.currentLine,
      totalLines: this.mode.height,
      progress: (this.currentLine / this.mode.height) * 100,
      frequency: Math.round(1900 + this.frequencyOffset), // Center frequency + offset
      signalStrength: Math.round(this.signalStrength),
      snr: null, // SNR will be calculated by the audio processor with AnalyserNode
    };
  }

  /**
   * Get image dimensions
   */
  getDimensions(): { width: number; height: number } {
    return {
      width: this.mode.width,
      height: this.mode.height,
    };
  }

  /**
   * Reset decoder
   */
  reset(): void {
    this.currentLine = 0;
    this.bufferWritePos = 0;
    this.lastSyncPos = -1;
    this.lastSyncWidth = null;
    this.frequencyOffset = 0;
    this.sampleCounter = 0;
    this.lastLogTime = 0;
    this.absoluteSamplePosition = 0;

    // Reset sync detector state
    this.syncDetector.reset();
    this.lineDecoder.reset();

    // Clear audio buffer
    this.audioBuffer.fill(0);

    // Clear image data to black
    for (let i = 0; i < this.imageData.length; i += 4) {
      this.imageData[i] = 0;       // R
      this.imageData[i + 1] = 0;   // G
      this.imageData[i + 2] = 0;   // B
      this.imageData[i + 3] = 255; // A
    }
  }

  /**
   * Start decoding
   */
  start(): void {
    this.reset();
    this.state = DecoderState.DECODING_IMAGE;
    console.log('Starting SSTV decode with sync detection');
  }

  /**
   * Stop decoding
   */
  stop(): void {
    this.state = DecoderState.IDLE;
  }
}
