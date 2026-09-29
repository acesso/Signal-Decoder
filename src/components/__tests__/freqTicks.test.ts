// The spectrum's frequency ruler. With a VFO set the ruler reads ABSOLUTE
// frequency, so ticks have to land on round absolute values — picking them
// on round AUDIO offsets and then labelling to kHz precision is what made a
// 3kHz view at 7.069 MHz render "7.071" three times in a row.
import { computeTicks } from '../SignalAnalysisPanel';

const VFO_7069 = 7_069_000;

const majorLabels = (minHz: number, maxHz: number, vfo = 0) =>
  computeTicks(minHz, maxHz, vfo).filter((t) => t.isMaj).map((t) => t.label);

describe('computeTicks with a VFO (absolute frequency)', () => {
  it('never repeats a label', () => {
    // The reported bug, at the reported settings.
    const labels = majorLabels(0, 3000, VFO_7069);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('lands on whole kHz for a typical passband view', () => {
    expect(majorLabels(0, 3000, VFO_7069)).toEqual(['7.069', '7.070', '7.071', '7.072']);
  });

  it('keeps labels distinct across a range of span widths', () => {
    for (const span of [500, 1000, 2400, 3000, 5000, 6000, 12000, 48000, 192000]) {
      const labels = majorLabels(0, span, VFO_7069);
      expect(new Set(labels).size).toBe(labels.length);
      // A ruler with nothing on it is not a ruler.
      expect(labels.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('puts exactly ONE prominent mark between adjacent labels', () => {
    // Four equal marks between 7.663 and 7.664 meant each was worth 200Hz,
    // so reading a frequency became counting ticks and multiplying. One
    // mid-tier mark needs no counting: it is the midpoint.
    const ticks = computeTicks(0, 3000, VFO_7069);
    expect(ticks.filter((t) => !t.isMaj).every((t) => t.label === null)).toBe(true);

    const majIdx = ticks.map((t, i) => (t.isMaj ? i : -1)).filter((i) => i >= 0);
    for (let k = 0; k < majIdx.length - 1; k++) {
      const between = ticks.slice(majIdx[k] + 1, majIdx[k + 1]);
      expect(between.filter((t) => t.kind === 'mid')).toHaveLength(1);
    }
  });

  it('places the mid mark at the midpoint between labels', () => {
    const ticks = computeTicks(0, 3000, VFO_7069);
    const majors = ticks.filter((t) => t.isMaj);
    const mids = ticks.filter((t) => t.kind === 'mid');
    expect(mids.length).toBeGreaterThan(0);
    for (const m of mids) {
      const below = majors.filter((t) => t.x < m.x).pop();
      const above = majors.find((t) => t.x > m.x);
      if (!below || !above) continue;
      expect(m.x).toBeCloseTo((below.x + above.x) / 2, 6);
    }
  });

  it('keeps faint quarter marks either side of the midpoint', () => {
    // On a 3kHz view the majors are 1kHz apart, so the quarters land on
    // 250Hz — fine texture for judging a position, never counted.
    const ticks = computeTicks(0, 3000, VFO_7069);
    const majIdx = ticks.map((t, i) => (t.isMaj ? i : -1)).filter((i) => i >= 0);
    for (let k = 0; k < majIdx.length - 1; k++) {
      const between = ticks.slice(majIdx[k] + 1, majIdx[k + 1]);
      expect(between.map((t) => t.kind)).toEqual(['sub', 'mid', 'sub']);
    }
  });

  it('keeps the same 1 mid + 2 sub shape across span widths', () => {
    for (const span of [500, 1000, 2400, 3000, 6000, 48000, 192000]) {
      const ticks = computeTicks(0, span, VFO_7069);
      const majIdx = ticks.map((t, i) => (t.isMaj ? i : -1)).filter((i) => i >= 0);
      for (let k = 0; k < majIdx.length - 1; k++) {
        const between = ticks.slice(majIdx[k] + 1, majIdx[k + 1]);
        expect(between.map((t) => t.kind)).toEqual(['sub', 'mid', 'sub']);
      }
    }
  });

  it('never labels anything below the major tier', () => {
    const ticks = computeTicks(0, 3000, VFO_7069);
    for (const t of ticks) {
      if (t.kind !== 'maj') expect(t.label).toBeNull();
    }
  });

  it('keeps every tick inside the plot', () => {
    for (const t of computeTicks(0, 3000, VFO_7069)) {
      expect(t.x).toBeGreaterThanOrEqual(0);
      expect(t.x).toBeLessThanOrEqual(1);
    }
  });

  it('places labels at the frequency they claim', () => {
    // x is a fraction across the span, so the label must match the
    // absolute frequency at that position.
    const span = 3000;
    for (const t of computeTicks(0, span, VFO_7069)) {
      if (!t.isMaj) continue;
      const atHz = VFO_7069 + t.x * span;
      expect(Number(t.label)).toBeCloseTo(atHz / 1_000_000, 4);
    }
  });

  it('handles a non-zero low edge', () => {
    const labels = majorLabels(500, 3500, VFO_7069);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('adds decimals only when the span is too narrow for whole kHz', () => {
    // A 3kHz span reads like a dial; a 500Hz one cannot, and takes the
    // extra precision rather than repeating itself.
    expect(majorLabels(0, 3000, VFO_7069).every((l) => l!.split('.')[1].length === 3)).toBe(true);
    const narrow = majorLabels(0, 500, VFO_7069);
    expect(new Set(narrow).size).toBe(narrow.length);
  });
});

describe('computeTicks without a VFO (audio offset)', () => {
  it('labels in audio Hz and k', () => {
    const labels = majorLabels(0, 3000);
    expect(labels).toContain('1k');
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('returns nothing for an empty or inverted span', () => {
    expect(computeTicks(1000, 1000)).toEqual([]);
    expect(computeTicks(2000, 1000)).toEqual([]);
  });
});
