// The zoom chips name a WIDTH; where that width sits depends on the
// source's own shape. The two spectrum kinds have different origins:
//
//   - Decoded audio runs 0..Nyquist — 0 is the bottom of the band.
//   - Raw I/Q is centred on the dial — 0 IS the carrier, with real signal
//     on both sides of it.
//
// So a 24k chip on raw I/Q must mean [-12000, +12000]; [0, 24000] would
// discard the entire lower half of the spectrum.
import { computeZoomPresets } from '../SignalAnalysisPanel';

const byLabel = (presets: ReturnType<typeof computeZoomPresets>, label: string) =>
  presets.find((p) => p.label === label)!;

describe('computeZoomPresets on a raw I/Q (bipolar) source', () => {
  // 48kHz sample rate -> -24k..+24k
  const presets = computeZoomPresets(-24_000, 24_000);

  it('centres each fixed width on the carrier', () => {
    expect(byLabel(presets, '1k')).toMatchObject({ lo: -500, hi: 500 });
    expect(byLabel(presets, '2k')).toMatchObject({ lo: -1000, hi: 1000 });
    expect(byLabel(presets, '3k')).toMatchObject({ lo: -1500, hi: 1500 });
    expect(byLabel(presets, '6k')).toMatchObject({ lo: -3000, hi: 3000 });
  });

  it('keeps every preset symmetric about zero', () => {
    for (const p of presets) expect(p.lo).toBe(-p.hi);
  });

  it('offers the whole span, named by its real width', () => {
    // 48k, not 24k: the chip names the width it selects, and the span runs
    // from -24k to +24k.
    expect(byLabel(presets, '48k (full)')).toMatchObject({ lo: -24_000, hi: 24_000 });
  });

  it('never exceeds the source span', () => {
    for (const p of presets) {
      expect(p.lo).toBeGreaterThanOrEqual(-24_000);
      expect(p.hi).toBeLessThanOrEqual(24_000);
    }
  });

  it('drops widths the source cannot cover, and marks the widest as full', () => {
    // A narrow 3kHz-wide I/Q source: 3k and 6k cannot fit.
    const narrow = computeZoomPresets(-1500, 1500);
    expect(narrow.map((p) => p.label)).toEqual(['1k', '2k', '3k (full)']);
    expect(byLabel(narrow, '3k (full)')).toMatchObject({ lo: -1500, hi: 1500 });
  });
});

describe('computeZoomPresets on a decoded-audio (baseband) source', () => {
  const presets = computeZoomPresets(0, 24_000);

  it('anchors each width at zero, unchanged from before', () => {
    expect(byLabel(presets, '1k')).toMatchObject({ lo: 0, hi: 1000 });
    expect(byLabel(presets, '3k')).toMatchObject({ lo: 0, hi: 3000 });
    expect(byLabel(presets, '6k')).toMatchObject({ lo: 0, hi: 6000 });
  });

  it('never produces a negative edge', () => {
    for (const p of presets) expect(p.lo).toBe(0);
  });

  it('offers the full span', () => {
    expect(byLabel(presets, '24k (full)')).toMatchObject({ lo: 0, hi: 24_000 });
  });

  it('avoids a duplicate chip when a fixed width IS the full span', () => {
    const labels = computeZoomPresets(0, 3000).map((p) => p.label);
    expect(labels).toEqual(['1k', '2k', '3k (full)']);
    expect(labels.filter((l) => l.startsWith('3k'))).toHaveLength(1);
  });
});

describe('computeZoomPresets edge cases', () => {
  it('returns nothing for an empty or inverted span', () => {
    expect(computeZoomPresets(0, 0)).toEqual([]);
    expect(computeZoomPresets(1000, 0)).toEqual([]);
  });

  it('handles an asymmetric span without exceeding either edge', () => {
    for (const p of computeZoomPresets(-1000, 5000)) {
      expect(p.lo).toBeGreaterThanOrEqual(-1000);
      expect(p.hi).toBeLessThanOrEqual(5000);
    }
  });
});
