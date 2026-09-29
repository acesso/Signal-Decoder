// The bridge's 4 TX slots are a shared, global resource on one device:
// FT8/FT4, RTTY (and SSTV later) all stage into the same pool, and an
// operator is expected to switch modes and still find what they staged.
// These cover the two mechanisms that make that safe — first-free
// allocation, and the owning mode recorded in each slot's on-device label.
import { findFreeSlot, modeLabel, parseModeLabel, SLOT_LABEL_MAX, TX_SLOT_COUNT, type BridgeSlotInfo } from '../bridgeSlots';

function slots(occupied: Record<number, string> = {}): BridgeSlotInfo[] {
  return Array.from({ length: TX_SLOT_COUNT }, (_, slot) => ({
    slot,
    message: occupied[slot] ? 'msg' : '',
    label: occupied[slot] ?? '',
    uploaded: slot in occupied,
    audioHz: 0,
  }));
}

describe('findFreeSlot', () => {
  it('takes the lowest free slot', () => {
    expect(findFreeSlot(slots())).toBe(0);
    expect(findFreeSlot(slots({ 0: 'FT8 · a' }))).toBe(1);
    expect(findFreeSlot(slots({ 0: 'FT8 · a', 1: 'RTTY · b' }))).toBe(2);
  });

  it('returns null when the pool is full rather than overwriting', () => {
    const full = slots({ 0: 'FT8 · a', 1: 'FT8 · b', 2: 'RTTY · c', 3: 'SSTV · d' });
    expect(findFreeSlot(full)).toBeNull();
  });

  it('honours a preferred slot when it is free', () => {
    expect(findFreeSlot(slots({ 0: 'FT8 · a' }), 2)).toBe(2);
  });

  it('falls back to first-free when the preferred slot is taken', () => {
    // FT prefers slot 0 for auto-CQ, but RTTY staged there first. The
    // preference must not clobber it.
    expect(findFreeSlot(slots({ 0: 'RTTY · CQ contest' }), 0)).toBe(1);
  });

  it('is null when the preferred slot is taken and nothing else is free', () => {
    const full = slots({ 0: 'RTTY · a', 1: 'RTTY · b', 2: 'RTTY · c', 3: 'RTTY · d' });
    expect(findFreeSlot(full, 0)).toBeNull();
  });
});

describe('mode labels', () => {
  it('round-trips a mode tag through the device label', () => {
    const label = modeLabel('RTTY', 'CQ contest');
    expect(label).toBe('RTTY · CQ contest');
    expect(parseModeLabel(label)).toEqual({ mode: 'RTTY', description: 'CQ contest' });
  });

  it('fits the firmware 32-byte label field', () => {
    // The descriptive half is truncated; the mode tag must survive, since
    // that is what stops one mode clobbering another's staged audio.
    const label = modeLabel('SSTV', 'a very long description that will not fit at all');
    expect(label.length).toBeLessThanOrEqual(SLOT_LABEL_MAX);
    expect(parseModeLabel(label).mode).toBe('SSTV');
  });

  it('treats an untagged label as owned by nobody, not as free', () => {
    // A slot staged by an older session carries no mode tag. It is still
    // someone's audio, so callers must not reuse it just because the mode
    // is unknown — findFreeSlot keys off `uploaded`, never off the tag.
    expect(parseModeLabel('CQ (auto)')).toEqual({ mode: null, description: 'CQ (auto)' });
    expect(findFreeSlot(slots({ 0: 'CQ (auto)' }), 0)).toBe(1);
  });

  it('does not mistake a description containing the separator for a tag', () => {
    expect(parseModeLabel('WX · sunny')).toEqual({ mode: null, description: 'WX · sunny' });
  });
});
