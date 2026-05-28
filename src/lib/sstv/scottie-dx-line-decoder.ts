/**
 * Scottie DX Line Decoder
 * Decodes a single Scottie DX scan line using RGB sequential format
 * Scottie DX uses the same negative-timing structure as S1/S2 but with much longer channels (345.6ms each)
 *
 * Key Features:
 * - RGB sequential encoding (no YUV conversion needed)
 * - Slower high-quality transmission (~1049ms per line)
 * - Same negative timing structure as S1/S2
 * - Transmission order: Green → Blue → [SYNC] → Red
 *
 * Based on xdsopl/robot36 RGBDecoder.java and RGBModes.Scottie()
 */

import { ExponentialMovingAverage } from './fm-demodulator';

export interface DecodedLine {
  pixels: Uint8ClampedArray; // RGBA pixel data
  width: number;
  height: number; // Always 1 for Scottie DX (sequential RGB)
  isOddLine: boolean; // Not used for Scottie DX, always false
}

export class ScottieDXLineDecoder {
  private lowPassFilter: ExponentialMovingAverage;

  private readonly horizontalPixels = 320;
  private readonly verticalPixels = 256;
  private readonly scanLineSamples: number;
  private readonly firstSyncPulseSamples: number;

  // Channel timing (all in samples)
  private readonly channelSamples: number; // 345.6ms per channel
  private readonly redSamples: number;
  private readonly greenSamples: number;
  private readonly blueSamples: number;

  // Begin positions for R, G, B channels
  private readonly beginSamples: number;
  private readonly redBeginSamples: number;
  private readonly greenBeginSamples: number;
  private readonly blueBeginSamples: number;
  private readonly endSamples: number;

  constructor(sampleRate: number) {
    // Scottie DX timing (in seconds)
    const syncPulseSeconds = 0.009; // 9ms sync pulse
    const separatorSeconds = 0.0015; // 1.5ms separator
    const channelSeconds = 0.3456; // 345.6ms per color channel (R, G, B) - much longer than S1/S2

    // First line is special: sync(9) + sep(1.5) + G(345.6) + sep(1.5) + B(345.6) + sync(9) + sep(1.5) + R(345.6)
    const firstSyncPulseSeconds = syncPulseSeconds + 2 * (separatorSeconds + channelSeconds);

    // Regular scan line: sync(9) + R(345.6) + sep(1.5) + G(345.6) + sep(1.5) + B(345.6) = 1049.3ms
    const scanLineSeconds = syncPulseSeconds + 3 * (channelSeconds + separatorSeconds);

    this.scanLineSamples = Math.round(scanLineSeconds * sampleRate);
    this.firstSyncPulseSamples = Math.round(firstSyncPulseSeconds * sampleRate);
    this.channelSamples = Math.round(channelSeconds * sampleRate);

    // Scottie DX transmission order: Green → Blue → [SYNC] → Red (same as S1/S2)
    // The "negative timing" means green and blue are transmitted BEFORE the sync pulse!

    // From RGBModes.Scottie() - exact timing relative to sync pulse:
    const blueEndSeconds = -syncPulseSeconds;                     // Blue ends 9ms before sync
    const blueBeginSeconds = blueEndSeconds - channelSeconds;     // Blue: -354.6ms to -9ms
    const greenEndSeconds = blueBeginSeconds - separatorSeconds;  // 1.5ms separator
    const greenBeginSeconds = greenEndSeconds - channelSeconds;   // Green: -701.7ms to -356.1ms
    const redBeginSeconds = separatorSeconds;                      // Red starts 1.5ms after sync
    const redEndSeconds = redBeginSeconds + channelSeconds;       // Red: +1.5ms to +347.1ms

    // Calculate sample positions
    // beginSamples is the earliest start point (green channel, negative value)
    const beginSeconds = greenBeginSeconds;
    this.beginSamples = Math.round(beginSeconds * sampleRate);

    // endSamples is the latest end point (red channel)
    const endSeconds = redEndSeconds;
    this.endSamples = Math.round(endSeconds * sampleRate);

    // Calculate channel positions relative to beginSamples offset
    this.redBeginSamples = Math.round(redBeginSeconds * sampleRate) - this.beginSamples;
    this.redSamples = Math.round((redEndSeconds - redBeginSeconds) * sampleRate);

    this.greenBeginSamples = Math.round(greenBeginSeconds * sampleRate) - this.beginSamples;
    this.greenSamples = Math.round((greenEndSeconds - greenBeginSeconds) * sampleRate);

    this.blueBeginSamples = Math.round(blueBeginSeconds * sampleRate) - this.beginSamples;
    this.blueSamples = Math.round((blueEndSeconds - blueBeginSeconds) * sampleRate);

    this.lowPassFilter = new ExponentialMovingAverage();
  }

  /**
   * Convert normalized frequency (-1 to +1) to level (0 to 1)
   */
  private freqToLevel(frequency: number, offset: number): number {
    return 0.5 * (frequency - offset + 1.0);
  }

  /**
   * Convert RGB level (0-1) to 8-bit value (0-255)
   * Scottie uses direct RGB encoding, no YUV conversion needed
   */
  private levelToRGB(level: number): number {
    return Math.max(0, Math.min(255, Math.round(level * 255)));
  }

  /**
   * Decode a single Scottie DX scan line
   * @param scanLineBuffer Demodulated frequency values for the entire line
   * @param syncPulseIndex Index where sync pulse starts
   * @param frequencyOffset Frequency calibration offset
   * @returns Decoded line data (1 row for Scottie DX, RGB sequential)
   */
  decodeScanLine(
    scanLineBuffer: Float32Array,
    syncPulseIndex: number,
    frequencyOffset: number
  ): DecodedLine | null {
    // Check buffer bounds
    // Note: Scottie has negative timing (blue/green before sync), so beginSamples is negative
    if (syncPulseIndex + this.beginSamples < 0 || syncPulseIndex + this.endSamples > scanLineBuffer.length) {
      return null;
    }

    // Apply bidirectional low-pass filter
    const scratchBuffer = new Float32Array(this.endSamples - this.beginSamples);

    // Configure filter for horizontal resolution
    // Use green samples as reference (typical channel length)
    this.lowPassFilter.cutoff(this.horizontalPixels, 2 * this.greenSamples, 2);

    this.lowPassFilter.reset();

    // Forward pass - apply lowpass filtering
    for (let i = 0; i < this.endSamples - this.beginSamples; i++) {
      scratchBuffer[i] = this.lowPassFilter.avg(scanLineBuffer[syncPulseIndex + this.beginSamples + i]);
    }

    // Backward pass
    this.lowPassFilter.reset();
    for (let i = this.endSamples - this.beginSamples - 1; i >= 0; i--) {
      scratchBuffer[i] = this.freqToLevel(this.lowPassFilter.avg(scratchBuffer[i]), frequencyOffset);
    }

    // Allocate pixels for one row
    const pixels = new Uint8ClampedArray(this.horizontalPixels * 4);

    // Decode pixels: R, G, B are transmitted sequentially
    for (let i = 0; i < this.horizontalPixels; i++) {
      // Calculate sample position within each channel
      const redPos = this.redBeginSamples + Math.floor((i * this.redSamples) / this.horizontalPixels);
      const greenPos = this.greenBeginSamples + Math.floor((i * this.greenSamples) / this.horizontalPixels);
      const bluePos = this.blueBeginSamples + Math.floor((i * this.blueSamples) / this.horizontalPixels);

      // Extract normalized values (0-1 range)
      const r = Math.max(0, Math.min(1, scratchBuffer[redPos]));
      const g = Math.max(0, Math.min(1, scratchBuffer[greenPos]));
      const b = Math.max(0, Math.min(1, scratchBuffer[bluePos]));

      // Store pixel (RGBA) - direct RGB, no conversion needed
      pixels[i * 4] = this.levelToRGB(r);
      pixels[i * 4 + 1] = this.levelToRGB(g);
      pixels[i * 4 + 2] = this.levelToRGB(b);
      pixels[i * 4 + 3] = 255;
    }

    return {
      pixels,
      width: this.horizontalPixels,
      height: 1, // Scottie DX returns ONE row per scan line (RGB sequential)
      isOddLine: false,
    };
  }

  /**
   * Get the special first sync pulse index for Scottie DX
   * First line has longer sync sequence
   */
  getFirstSyncPulseSamples(): number {
    return this.firstSyncPulseSamples;
  }

  /**
   * Get the earliest sample offset needed (negative for Scottie)
   * This is needed by the main decoder to extract enough buffer data
   */
  getBeginSamples(): number {
    return this.beginSamples;
  }

  /**
   * Get the latest sample offset needed
   */
  getEndSamples(): number {
    return this.endSamples;
  }

  reset(): void {
    this.lowPassFilter.reset();
  }
}
