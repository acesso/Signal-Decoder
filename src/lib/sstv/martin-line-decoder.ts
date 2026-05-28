/**
 * Martin M1/M2 Line Decoder
 * Martin modes use positive timing (sync-first) with RGB sequential format
 * Transmission order: sync → porch → Green → sep → Blue → sep → Red
 * Color order differs from Scottie: G, B, R (not R, G, B)
 *
 * Refactored to accept optional timing and channel order parameters so it can
 * also be used for Wraase SC2-180 and other similar modes.
 */

import { ExponentialMovingAverage } from './fm-demodulator';

export interface DecodedLine {
  pixels: Uint8ClampedArray;
  width: number;
  height: number;
  isOddLine: boolean;
}

type ColorChannel = 'R' | 'G' | 'B';

export class MartinLineDecoder {
  private lowPassFilter: ExponentialMovingAverage;

  private readonly horizontalPixels = 320;

  // Absolute sample positions within the line buffer (from sync start)
  private readonly ch1BeginSamples: number;
  private readonly ch1Samples: number;
  private readonly ch2BeginSamples: number;
  private readonly ch2Samples: number;
  private readonly ch3BeginSamples: number;
  private readonly ch3Samples: number;
  private readonly endSamples: number;

  private readonly channelOrder: [ColorChannel, ColorChannel, ColorChannel];

  constructor(
    sampleRate: number,
    channelSeconds: number,
    syncMs: number = 4.862,
    porchMs: number = 0.572,
    sepMs: number = 0.572,
    channelOrder: [ColorChannel, ColorChannel, ColorChannel] = ['G', 'B', 'R']
  ) {
    const syncPulseSeconds = syncMs / 1000;
    const syncPorchSeconds = porchMs / 1000;
    const separatorSeconds = sepMs / 1000;

    this.channelOrder = channelOrder;

    // ch1 starts after sync + porch
    const ch1Begin = syncPulseSeconds + syncPorchSeconds;
    const ch2Begin = ch1Begin + channelSeconds + separatorSeconds;
    const ch3Begin = ch2Begin + channelSeconds + separatorSeconds;
    const end      = ch3Begin + channelSeconds;

    this.ch1BeginSamples = Math.round(ch1Begin * sampleRate);
    this.ch1Samples      = Math.round(channelSeconds * sampleRate);
    this.ch2BeginSamples = Math.round(ch2Begin * sampleRate);
    this.ch2Samples      = Math.round(channelSeconds * sampleRate);
    this.ch3BeginSamples = Math.round(ch3Begin * sampleRate);
    this.ch3Samples      = Math.round(channelSeconds * sampleRate);
    this.endSamples      = Math.round(end * sampleRate);

    this.lowPassFilter = new ExponentialMovingAverage();
  }

  private freqToLevel(frequency: number, offset: number): number {
    return 0.5 * (frequency - offset + 1.0);
  }

  private levelToRGB(level: number): number {
    return Math.max(0, Math.min(255, Math.round(level * 255)));
  }

  decodeScanLine(
    scanLineBuffer: Float32Array,
    syncPulseIndex: number,
    frequencyOffset: number
  ): DecodedLine | null {
    const start = syncPulseIndex;
    const end   = syncPulseIndex + this.endSamples;
    if (start < 0 || end > scanLineBuffer.length) return null;

    const totalSamples = this.endSamples;
    const scratch = new Float32Array(totalSamples);

    // Apply bidirectional low-pass filter
    this.lowPassFilter.cutoff(this.horizontalPixels, 2 * this.ch1Samples, 2);
    this.lowPassFilter.reset();
    for (let i = 0; i < totalSamples; i++) {
      scratch[i] = this.lowPassFilter.avg(scanLineBuffer[start + i]);
    }
    this.lowPassFilter.reset();
    for (let i = totalSamples - 1; i >= 0; i--) {
      scratch[i] = this.freqToLevel(this.lowPassFilter.avg(scratch[i]), frequencyOffset);
    }

    const pixels = new Uint8ClampedArray(this.horizontalPixels * 4);
    for (let i = 0; i < this.horizontalPixels; i++) {
      const ch1Pos = this.ch1BeginSamples + Math.floor((i * this.ch1Samples) / this.horizontalPixels);
      const ch2Pos = this.ch2BeginSamples + Math.floor((i * this.ch2Samples) / this.horizontalPixels);
      const ch3Pos = this.ch3BeginSamples + Math.floor((i * this.ch3Samples) / this.horizontalPixels);

      // Determine which channel position gives R, G, B
      const channelPositions = [ch1Pos, ch2Pos, ch3Pos]; // positions for channelOrder[0], [1], [2]
      const colorMap: Record<ColorChannel, number> = { R: 0, G: 0, B: 0 };
      for (let c = 0; c < 3; c++) {
        colorMap[this.channelOrder[c]] = this.levelToRGB(Math.max(0, Math.min(1, scratch[channelPositions[c]])));
      }

      pixels[i * 4]     = colorMap.R;
      pixels[i * 4 + 1] = colorMap.G;
      pixels[i * 4 + 2] = colorMap.B;
      pixels[i * 4 + 3] = 255;
    }

    return { pixels, width: this.horizontalPixels, height: 1, isOddLine: false };
  }

  reset(): void {
    this.lowPassFilter.reset();
  }
}
