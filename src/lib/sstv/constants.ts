// SSTV Mode Specifications
export interface SSTVMode {
  readonly name: string;
  readonly visCode: number;
  readonly width: number;
  readonly height: number;
  readonly scanTime: number; // milliseconds per line
  readonly syncPulse: number; // milliseconds
  readonly syncPorch: number; // milliseconds
  readonly porchFreq: number; // Hz
  readonly separatorPulse: number; // milliseconds (default separator)
  readonly separatorPulses?: readonly number[]; // Optional: different separator after each channel (for Robot36)
  readonly colorScanTime: number; // milliseconds per color component (for uniform modes)
  readonly colorScanTimes?: readonly number[]; // Optional: different scan time per channel (for Robot36)
  readonly colorOrder: readonly ('R' | 'G' | 'B')[];
}

// SSTV modes
export const SSTV_MODES = {
  ROBOT36: {
    name: 'Robot 36',
    visCode: 8,
    width: 320,
    height: 240,
    // Actual line: sync(9) + syncPorch(3) + Y(88) + separator(4.5) + porch(1.5) + chrominance(44) = 150ms
    scanTime: 150,
    syncPulse: 9,
    syncPorch: 3,
    porchFreq: 1500,
    separatorPulse: 4.5,
    separatorPulses: [4.5], // Only one separator after Y
    colorScanTime: 88,
    colorScanTimes: [88, 44], // Y=88ms, then ONE chrominance channel=44ms (alternates R-Y/B-Y)
    colorOrder: ['G', 'R', 'B'], // Not used for Robot36 (it's interlaced)
  },
  ROBOT72: {
    name: 'Robot 72',
    visCode: 12,
    width: 320,
    height: 240,
    // Robot72 line: sync(9) + syncPorch(3) + Y(138) + separator(4.5) + porch(1.5) + V(69) + separator(4.5) + porch(1.5) + U(69) = 300ms
    // Sequential YUV encoding (no interlacing) - better color fidelity than Robot36
    scanTime: 300,
    syncPulse: 9,
    syncPorch: 3,
    porchFreq: 1500,
    separatorPulse: 4.5,
    separatorPulses: [4.5, 4.5], // Two separators (after Y and after V)
    colorScanTime: 138,
    colorScanTimes: [138, 69, 69], // Y=138ms, V=69ms, U=69ms (all three channels per line)
    colorOrder: ['G', 'R', 'B'], // Actually Y, V (R-Y), U (B-Y)
  },
  PD120: {
    name: 'PD 120',
    visCode: 95,
    width: 640,
    height: 496,
    // PD120 line format: sync(20) + porch(2.08) + Y-even(121.6) + V-avg(121.6) + U-avg(121.6) + Y-odd(121.6) = 508.48ms per line
    // PD120 is a dual-luminance YUV mode (like PD180/PD160) with NO separators between channels
    scanTime: 508.48,
    syncPulse: 20,
    syncPorch: 2.08,
    porchFreq: 1500,
    separatorPulse: 0,
    separatorPulses: [],
    colorScanTime: 121.6,
    colorScanTimes: [121.6, 121.6, 121.6, 121.6], // Y-even, V-avg, U-avg, Y-odd all 121.6ms
    colorOrder: ['G', 'R', 'B'], // Actually Y, V, U for PD modes (dual-luminance)
  },
  PD160: {
    name: 'PD 160',
    visCode: 98,
    width: 512,
    height: 400,
    // PD160 line format: sync(20) + porch(2.08) + Y-even(195.584) + V-avg(195.584) + U-avg(195.584) + Y-odd(195.584) = 804.416ms per line
    // Balanced mode: 382µs per pixel (between PD120's 190µs and PD180's 286µs)
    // Total transmission time: ~160s for 200 scan lines (400 rows / 2)
    scanTime: 804.416,
    syncPulse: 20,
    syncPorch: 2.08,
    porchFreq: 1500,
    separatorPulse: 0, // PD160 uses dual-luminance, no separators
    separatorPulses: [], // No separators in PD160
    colorScanTime: 195.584,
    colorScanTimes: [195.584, 195.584, 195.584, 195.584], // Y-even, V-avg, U-avg, Y-odd channels all 195.584ms
    colorOrder: ['G', 'R', 'B'], // Actually Y, V, U for PD modes (dual-luminance)
  },
  PD180: {
    name: 'PD 180',
    visCode: 96,
    width: 640,
    height: 496,
    // PD180 line format: sync(20) + porch(2.08) + Y-even(182.4) + V-avg(182.4) + U-avg(182.4) + Y-odd(182.4) = 751.68ms per line
    // Higher quality than PD120: 286µs per pixel vs 190µs per pixel
    scanTime: 751.68,
    syncPulse: 20,
    syncPorch: 2.08,
    porchFreq: 1500,
    separatorPulse: 0, // PD180 uses dual-luminance, no separators
    separatorPulses: [], // No separators in PD180
    colorScanTime: 182.4,
    colorScanTimes: [182.4, 182.4, 182.4, 182.4], // Y-even, V-avg, U-avg, Y-odd channels all 182.4ms
    colorOrder: ['G', 'R', 'B'], // Actually Y, V, U for PD modes (dual-luminance)
  },
  SCOTTIE_S1: {
    name: 'Scottie S1',
    visCode: 60,
    width: 320,
    height: 256,
    // Scottie S1 line format (after first line): sync(9) + R(138.24) + sep(1.5) + G(138.24) + sep(1.5) + B(138.24) = 428.22ms
    // First line is special: sync(9) + sep(1.5) + G(138.24) + sep(1.5) + B(138.24) + sync(9) + sep(1.5) + R(138.24) = 438.72ms
    // RGB sequential encoding (no YUV conversion needed)
    scanTime: 428.22,
    syncPulse: 9,
    syncPorch: 0, // Scottie uses separator, not sync porch
    porchFreq: 1500,
    separatorPulse: 1.5,
    separatorPulses: [1.5, 1.5], // Two separators (after R and after G)
    colorScanTime: 138.24,
    colorScanTimes: [138.24, 138.24, 138.24], // R, G, B channels all 138.24ms
    colorOrder: ['R', 'G', 'B'], // RGB sequential (sync-R-sep-G-sep-B)
  },
  SCOTTIE_S2: {
    name: 'Scottie S2',
    visCode: 56,
    width: 320,
    height: 256,
    // Scottie S2 is faster than S1: sync(9) + R(88.064) + sep(1.5) + G(88.064) + sep(1.5) + B(88.064) = 277.692ms
    // Same RGB sequential encoding as S1, just faster transmission
    // Transmission order: Green → Blue → [SYNC] → Red (negative timing like S1)
    scanTime: 277.692,
    syncPulse: 9,
    syncPorch: 0, // Scottie uses separator, not sync porch
    porchFreq: 1500,
    separatorPulse: 1.5,
    separatorPulses: [1.5, 1.5], // Two separators (after R and after G)
    colorScanTime: 88.064,
    colorScanTimes: [88.064, 88.064, 88.064], // R, G, B channels all 88.064ms
    colorOrder: ['R', 'G', 'B'], // RGB sequential (G-B-sync-R order in time)
  },
  MARTIN_M1: {
    name: 'Martin M1',
    visCode: 44,
    width: 320,
    height: 256,
    // Martin M1: sync(4.862) + porch(0.572) + G(146.432) + sep(0.572) + B(146.432) + sep(0.572) + R(146.432) = 445.874ms
    scanTime: 445.874,
    syncPulse: 4.862,
    syncPorch: 0.572,
    porchFreq: 1500,
    separatorPulse: 0.572,
    separatorPulses: [0.572, 0.572],
    colorScanTime: 146.432,
    colorScanTimes: [146.432, 146.432, 146.432],
    colorOrder: ['G', 'B', 'R'],  // Martin transmits Green, Blue, Red
  },
  MARTIN_M2: {
    name: 'Martin M2',
    visCode: 40,
    width: 320,
    height: 256,
    // Martin M2: sync(4.862) + porch(0.572) + G(73.216) + sep(0.572) + B(73.216) + sep(0.572) + R(73.216) = 226.226ms
    scanTime: 226.226,
    syncPulse: 4.862,
    syncPorch: 0.572,
    porchFreq: 1500,
    separatorPulse: 0.572,
    separatorPulses: [0.572, 0.572],
    colorScanTime: 73.216,
    colorScanTimes: [73.216, 73.216, 73.216],
    colorOrder: ['G', 'B', 'R'],  // Martin transmits Green, Blue, Red
  },
  SCOTTIE_DX: {
    name: 'Scottie DX',
    visCode: 76,
    width: 320,
    height: 256,
    // ScottieDX: same structure as S1/S2 but 345.6ms per channel
    // G(345.6) + sep(1.5) + B(345.6) + sync(9) + sep(1.5) + R(345.6) = 1049.3ms
    scanTime: 1049.3,
    syncPulse: 9,
    syncPorch: 0,
    porchFreq: 1500,
    separatorPulse: 1.5,
    separatorPulses: [1.5, 1.5],
    colorScanTime: 345.6,
    colorScanTimes: [345.6, 345.6, 345.6],
    colorOrder: ['R', 'G', 'B'],
  },
  WRAASE_SC2_180: {
    name: 'Wraase SC2-180',
    visCode: 55,
    width: 320,
    height: 256,
    // SC2-180: sync(5.5225) + porch(0.5) + R(235) + sep(0.5) + G(235) + sep(0.5) + B(235) = 712.0225ms
    scanTime: 712.0225,
    syncPulse: 5.5225,
    syncPorch: 0.5,
    porchFreq: 1500,
    separatorPulse: 0.5,
    separatorPulses: [0.5, 0.5],
    colorScanTime: 235,
    colorScanTimes: [235, 235, 235],
    colorOrder: ['R', 'G', 'B'],  // Wraase transmits R, G, B
  },
  PD50: {
    name: 'PD 50',
    visCode: 93,
    width: 320,
    height: 240,
    // PD50: sync(20) + porch(2.08) + Y-even(91.52) + V(91.52) + U(91.52) + Y-odd(91.52) = 388.16ms
    scanTime: 388.16,
    syncPulse: 20,
    syncPorch: 2.08,
    porchFreq: 1500,
    separatorPulse: 0,
    separatorPulses: [],
    colorScanTime: 91.52,
    colorScanTimes: [91.52, 91.52, 91.52, 91.52],
    colorOrder: ['G', 'R', 'B'],
  },
  PD90: {
    name: 'PD 90',
    visCode: 99,
    width: 320,
    height: 240,
    // PD90: sync(20) + porch(2.08) + Y-even(170.24) + V(170.24) + U(170.24) + Y-odd(170.24) = 703.04ms
    scanTime: 703.04,
    syncPulse: 20,
    syncPorch: 2.08,
    porchFreq: 1500,
    separatorPulse: 0,
    separatorPulses: [],
    colorScanTime: 170.24,
    colorScanTimes: [170.24, 170.24, 170.24, 170.24],
    colorOrder: ['G', 'R', 'B'],
  },
  PD240: {
    name: 'PD 240',
    visCode: 97,
    width: 640,
    height: 496,
    // PD240: sync(20) + porch(2.08) + Y-even(243.2) + V(243.2) + U(243.2) + Y-odd(243.2) = 994.88ms
    scanTime: 994.88,
    syncPulse: 20,
    syncPorch: 2.08,
    porchFreq: 1500,
    separatorPulse: 0,
    separatorPulses: [],
    colorScanTime: 243.2,
    colorScanTimes: [243.2, 243.2, 243.2, 243.2],
    colorOrder: ['G', 'R', 'B'],
  },
  PD290: {
    name: 'PD 290',
    visCode: 94,
    width: 640,
    height: 496,
    // PD290: sync(20) + porch(2.08) + Y-even(294.4) + V(294.4) + U(294.4) + Y-odd(294.4) = 1199.68ms
    scanTime: 1199.68,
    syncPulse: 20,
    syncPorch: 2.08,
    porchFreq: 1500,
    separatorPulse: 0,
    separatorPulses: [],
    colorScanTime: 294.4,
    colorScanTimes: [294.4, 294.4, 294.4, 294.4],
    colorOrder: ['G', 'R', 'B'],
  },
} as const;

// Frequency constants
export const FREQ_SYNC = 1200; // Hz - sync pulse
export const FREQ_BLACK = 1500; // Hz - black level
export const FREQ_WHITE = 2300; // Hz - white level
export const FREQ_VIS_BIT1 = 1100; // Hz - VIS bit 1
export const FREQ_VIS_BIT0 = 1300; // Hz - VIS bit 0
export const FREQ_VIS_START = 1900; // Hz - VIS start bit
export const FREQ_VIS_STOP = 1200; // Hz - VIS stop bit

export const SAMPLE_RATE = 44100; // Standard audio sample rate
