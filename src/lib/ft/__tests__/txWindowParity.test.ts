// Regression test for the TX window-parity toggle's epoch-alignment math
// (see doc/FAKE_SPLIT_AND_WINDOW_PARITY_DESIGN.md). The design doc calls
// out that "parity 0 means :00/:30" is a claim that needs verifying against
// a real clock, not just assumed from epoch alignment — this pins that
// against four known UTC window-boundary timestamps.
import { isWrongWindowParity } from '../useFTTransmit';

const FT8_WINDOW_MS = 15_000;

// 2026-01-01T00:00:00Z is exactly on a 15s boundary (epoch is UTC midnight
// on a day boundary, which always divides evenly into 15s).
const T00 = Date.UTC(2026, 0, 1, 0, 0, 0);
const T15 = T00 + 15_000;
const T30 = T00 + 30_000;
const T45 = T00 + 45_000;

describe('isWrongWindowParity', () => {
  it('never restricts FT4 or FT2 — only FT8 splits cleanly into 2 slots per 30s period', () => {
    expect(isWrongWindowParity(T00, FT8_WINDOW_MS, 'FT4', 'even')).toBe(false);
    expect(isWrongWindowParity(T15, FT8_WINDOW_MS, 'FT4', 'even')).toBe(false);
    expect(isWrongWindowParity(T00, FT8_WINDOW_MS, 'FT2', 'odd')).toBe(false);
  });

  it('"even" allows :00 and :30, blocks :15 and :45', () => {
    expect(isWrongWindowParity(T00, FT8_WINDOW_MS, 'FT8', 'even')).toBe(false);
    expect(isWrongWindowParity(T30, FT8_WINDOW_MS, 'FT8', 'even')).toBe(false);
    expect(isWrongWindowParity(T15, FT8_WINDOW_MS, 'FT8', 'even')).toBe(true);
    expect(isWrongWindowParity(T45, FT8_WINDOW_MS, 'FT8', 'even')).toBe(true);
  });

  it('"odd" allows :15 and :45, blocks :00 and :30', () => {
    expect(isWrongWindowParity(T15, FT8_WINDOW_MS, 'FT8', 'odd')).toBe(false);
    expect(isWrongWindowParity(T45, FT8_WINDOW_MS, 'FT8', 'odd')).toBe(false);
    expect(isWrongWindowParity(T00, FT8_WINDOW_MS, 'FT8', 'odd')).toBe(true);
    expect(isWrongWindowParity(T30, FT8_WINDOW_MS, 'FT8', 'odd')).toBe(true);
  });

  it('parity is periodic with a 30s period, not just correct at the epoch', () => {
    // A window boundary 10 periods (300s) after a known :00 must have the
    // same parity as that :00 — this is what would break if the modulo
    // math were subtly off (e.g. using windowMs*2 incorrectly).
    const tenPeriodsLater = T00 + 10 * 30_000;
    expect(isWrongWindowParity(tenPeriodsLater, FT8_WINDOW_MS, 'FT8', 'even')).toBe(false);
    const tenPeriodsLaterOdd = T15 + 10 * 30_000;
    expect(isWrongWindowParity(tenPeriodsLaterOdd, FT8_WINDOW_MS, 'FT8', 'odd')).toBe(false);
  });
});
