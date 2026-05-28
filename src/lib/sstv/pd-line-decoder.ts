/**
 * Generic parameterized PD decoder (dual-luminance YUV, 4 channels per scan line)
 * Used for PD50, PD90, PD240, PD290
 * Produces 2 pixel rows per scan line (Y-even + shared UV + Y-odd)
 *
 * All PD modes share the same structure:
 *   sync(20ms) + porch(2.08ms) + Y-even + V-avg + U-avg + Y-odd
 * Only the channel duration and image width differ between modes.
 */

import { ExponentialMovingAverage } from './fm-demodulator';

export interface DecodedLine {
  pixels: Uint8ClampedArray; // RGBA pixel data
  width: number;
  height: number; // Always 2 for PD modes (two rows per scan line)
  isOddLine: boolean; // Not used for PD modes, always false
}

export class PDLineDecoder {
  private lowPassFilter: ExponentialMovingAverage;

  private readonly horizontalPixels: number;
  private readonly channelSamples: number;
  private readonly beginSamples: number;

  // Begin positions for each of the 4 channels
  private readonly yEvenBeginSamples: number;
  private readonly vAvgBeginSamples: number;  // V = R-Y
  private readonly uAvgBeginSamples: number;  // U = B-Y
  private readonly yOddBeginSamples: number;
  private readonly endSamples: number;

  constructor(sampleRate: number, horizontalPixels: number, channelSeconds: number) {
    this.horizontalPixels = horizontalPixels;

    // All PD modes share the same sync/porch timing
    const syncPulseSeconds = 0.020;    // 20ms sync pulse
    const syncPorchSeconds = 0.00208;  // 2.08ms porch after sync

    this.channelSamples = Math.round(channelSeconds * sampleRate);

    // Calculate begin positions for each channel
    // Structure: sync + porch + Y-even + V-avg + U-avg + Y-odd
    const yEvenBeginSeconds = syncPorchSeconds;
    this.yEvenBeginSamples = Math.round(yEvenBeginSeconds * sampleRate);
    this.beginSamples = this.yEvenBeginSamples;

    const vAvgBeginSeconds = yEvenBeginSeconds + channelSeconds;
    this.vAvgBeginSamples = Math.round(vAvgBeginSeconds * sampleRate);

    const uAvgBeginSeconds = vAvgBeginSeconds + channelSeconds;
    this.uAvgBeginSamples = Math.round(uAvgBeginSeconds * sampleRate);

    const yOddBeginSeconds = uAvgBeginSeconds + channelSeconds;
    this.yOddBeginSamples = Math.round(yOddBeginSeconds * sampleRate);

    const yOddEndSeconds = yOddBeginSeconds + channelSeconds;
    this.endSamples = Math.round(yOddEndSeconds * sampleRate);

    this.lowPassFilter = new ExponentialMovingAverage();
  }

  /**
   * Convert normalized frequency (-1 to +1) to level (0 to 1)
   */
  private freqToLevel(frequency: number, offset: number): number {
    return 0.5 * (frequency - offset + 1.0);
  }

  /**
   * Convert YUV to RGB
   * For PD modes: Y is luminance (0-255), RY is R-Y difference, BY is B-Y difference
   * Uses ITU-R BT.601 color space conversion (same as Robot36/PD120)
   */
  private yuv2rgb(y: number, ry: number, by: number): { r: number; g: number; b: number } {
    const yAdj = y - 16;
    const uAdj = by - 128;  // B-Y
    const vAdj = ry - 128;  // R-Y

    const r = Math.max(0, Math.min(255, ((298 * yAdj + 409 * vAdj + 128) >> 8)));
    const g = Math.max(0, Math.min(255, ((298 * yAdj - 100 * uAdj - 208 * vAdj + 128) >> 8)));
    const b = Math.max(0, Math.min(255, ((298 * yAdj + 516 * uAdj + 128) >> 8)));

    return { r, g, b };
  }

  /**
   * Decode a single PD scan line producing TWO pixel rows
   * @param scanLineBuffer Demodulated frequency values for the entire line
   * @param syncPulseIndex Index where sync pulse starts
   * @param frequencyOffset Frequency calibration offset
   * @returns Decoded line data (TWO rows: even + odd)
   */
  decodeScanLine(
    scanLineBuffer: Float32Array,
    syncPulseIndex: number,
    frequencyOffset: number
  ): DecodedLine | null {
    // Check buffer bounds
    if (syncPulseIndex + this.endSamples > scanLineBuffer.length) {
      console.warn(`PDLineDecoder: Buffer too short for full line decode`);
      return null;
    }

    // Apply bidirectional low-pass filter
    const scratchBuffer = new Float32Array(this.endSamples);

    // Configure filter for horizontal resolution
    this.lowPassFilter.cutoff(this.horizontalPixels, 2 * this.channelSamples, 2);

    this.lowPassFilter.reset();

    // Forward pass - apply lowpass filtering
    for (let i = this.beginSamples; i < this.endSamples; i++) {
      scratchBuffer[i] = this.lowPassFilter.avg(scanLineBuffer[syncPulseIndex + i]);
    }

    // Backward pass
    this.lowPassFilter.reset();
    for (let i = this.endSamples - 1; i >= this.beginSamples; i--) {
      scratchBuffer[i] = this.freqToLevel(this.lowPassFilter.avg(scratchBuffer[i]), frequencyOffset);
    }

    // Allocate pixels for TWO rows (even + odd)
    const pixels = new Uint8ClampedArray(this.horizontalPixels * 2 * 4);

    // Decode both rows: even row (first) and odd row (second)
    // Structure: Y-even + V-avg(R-Y) + U-avg(B-Y) + Y-odd
    for (let i = 0; i < this.horizontalPixels; i++) {
      // Calculate sample position within each channel
      const position = Math.floor((i * this.channelSamples) / this.horizontalPixels);

      // Sample positions for each of the 4 channels
      const yEvenPos = position + this.yEvenBeginSamples;
      const vAvgPos  = position + this.vAvgBeginSamples;  // V = R-Y (red difference)
      const uAvgPos  = position + this.uAvgBeginSamples;  // U = B-Y (blue difference)
      const yOddPos  = position + this.yOddBeginSamples;

      // Extract and convert values (0-1 range to 0-255)
      const yEven = Math.max(0, Math.min(1, scratchBuffer[yEvenPos])) * 255;
      const uAvg  = Math.max(0, Math.min(1, scratchBuffer[uAvgPos]))  * 255;  // U = B-Y
      const vAvg  = Math.max(0, Math.min(1, scratchBuffer[vAvgPos]))  * 255;  // V = R-Y
      const yOdd  = Math.max(0, Math.min(1, scratchBuffer[yOddPos]))  * 255;

      // Convert YUV to RGB for even row (first row)
      const rgbEven = this.yuv2rgb(yEven, vAvg, uAvg);
      pixels[i * 4]     = rgbEven.r;
      pixels[i * 4 + 1] = rgbEven.g;
      pixels[i * 4 + 2] = rgbEven.b;
      pixels[i * 4 + 3] = 255;

      // Convert YUV to RGB for odd row (second row)
      // Note: Same U and V (chroma averaged) for both even and odd rows
      const rgbOdd = this.yuv2rgb(yOdd, vAvg, uAvg);
      pixels[(i + this.horizontalPixels) * 4]     = rgbOdd.r;
      pixels[(i + this.horizontalPixels) * 4 + 1] = rgbOdd.g;
      pixels[(i + this.horizontalPixels) * 4 + 2] = rgbOdd.b;
      pixels[(i + this.horizontalPixels) * 4 + 3] = 255;
    }

    return {
      pixels,
      width: this.horizontalPixels,
      height: 2, // PD modes return TWO rows per scan line
      isOddLine: false,
    };
  }

  reset(): void {
    this.lowPassFilter.reset();
  }
}
