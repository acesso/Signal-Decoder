import { computeSliceCount, sliceHzRange, MAX_SLICE_WIDTH_HZ } from '../decoder';

describe('computeSliceCount', () => {
  // Pre-existing behavior: a band at or under MAX_SLICE_WIDTH_HZ (today's
  // default 150-3100) slices purely for throughput, one slice per pool slot.
  it('slices by pool size alone when the band fits in one MAX_SLICE_WIDTH_HZ slice', () => {
    expect(computeSliceCount(150, 3100, 1)).toBe(1);
    expect(computeSliceCount(150, 3100, 4)).toBe(4);
  });

  // New behavior: a band wider than MAX_SLICE_WIDTH_HZ must split regardless
  // of pool size, since a single _ftm_decode() call can't search it (see
  // MAX_SLICE_WIDTH_HZ's own comment on ft8mon's fixed 12kHz decode rate).
  it('slices by width when the band exceeds MAX_SLICE_WIDTH_HZ, even with a single-slot pool', () => {
    expect(computeSliceCount(0, MAX_SLICE_WIDTH_HZ + 1, 1)).toBe(2);
    expect(computeSliceCount(0, MAX_SLICE_WIDTH_HZ * 2, 1)).toBe(2);
    expect(computeSliceCount(0, MAX_SLICE_WIDTH_HZ * 2 + 1, 1)).toBe(3);
  });

  it('takes the larger of width-driven and pool-driven slice counts', () => {
    // 6000Hz band needs 2 width-slices, but an 8-slot pool should still use all 8.
    expect(computeSliceCount(0, MAX_SLICE_WIDTH_HZ * 2, 8)).toBe(8);
    // 24000Hz band needs 8 width-slices, exceeding a 4-slot pool — width wins,
    // and the caller is expected to round-robin extra slices onto existing slots.
    expect(computeSliceCount(0, MAX_SLICE_WIDTH_HZ * 8, 4)).toBe(8);
  });

  it('never returns fewer than 1 slice', () => {
    expect(computeSliceCount(0, 100, 1)).toBe(1);
  });
});

describe('sliceHzRange', () => {
  it('splits contiguous bands with overlap only at internal boundaries', () => {
    const ranges = sliceHzRange(0, 9000, 3);
    expect(ranges).toHaveLength(3);
    expect(ranges[0].min).toBe(0); // outer edge, no overlap
    expect(ranges[ranges.length - 1].max).toBe(9000); // outer edge, no overlap
    // internal boundary between slice 0 and 1 overlaps in both directions
    expect(ranges[0].max).toBeGreaterThan(3000);
    expect(ranges[1].min).toBeLessThan(3000);
  });

  it('covers the full requested range with no gaps', () => {
    const ranges = sliceHzRange(200, 12200, 4);
    for (let i = 0; i < ranges.length - 1; i++) {
      expect(ranges[i].max).toBeGreaterThanOrEqual(ranges[i + 1].min);
    }
  });
});
