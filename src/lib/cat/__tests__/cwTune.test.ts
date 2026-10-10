/**
 * CW Tune retune-suggestion tests — drift window (MHz × 3.5 kHz) and
 * amateur band-edge crossings (IARU R2 on HF, via freqMhzToBand).
 *
 * Run with: npm test src/lib/cat/__tests__/cwTune.test.ts
 */

import { retuneWindowHz, retuneSuggestion, RETUNE_KHZ_PER_MHZ } from '../cwTune';

describe('retuneWindowHz — MHz × 3.5 kHz', () => {
  test('formula constant', () => {
    expect(RETUNE_KHZ_PER_MHZ).toBe(3.5);
  });

  test.each([
    [3_573_000, 12_505.5],
    [7_074_000, 24_759],
    [14_074_000, 49_259],
    [21_074_000, 73_759],
    [28_074_000, 98_259],
  ])('%d Hz → %d Hz', (hz, expected) => {
    expect(retuneWindowHz(hz)).toBeCloseTo(expected, 3);
  });
});

describe('retuneSuggestion', () => {
  test('never tuned → plain suggestion with reason "never"', () => {
    expect(retuneSuggestion(7_074_000, null)).toEqual({ suggest: true, reason: 'never', windowHz: null });
  });

  test('inside the drift window → no suggestion', () => {
    const r = retuneSuggestion(7_074_000 + 24_000, 7_074_000);
    expect(r.suggest).toBe(false);
    expect(r.reason).toBeNull();
  });

  test('beyond the drift window, same band → "drift"', () => {
    const r = retuneSuggestion(7_074_000 + 25_000, 7_074_000);
    expect(r).toMatchObject({ suggest: true, reason: 'drift' });
    expect(r.windowHz).toBeCloseTo(24_759, 3);
  });

  test('drift is symmetric (VFO moved down)', () => {
    expect(retuneSuggestion(14_074_000 - 50_000, 14_074_000).reason).toBe('drift');
  });

  test('crossing a band edge → "band", even for a tiny move', () => {
    // 7.299 → 7.301 MHz: same uSDX LPF and band memory, but out of 40 m
    expect(retuneSuggestion(7_301_000, 7_299_000).reason).toBe('band');
  });

  test('band change between bands sharing a uSDX LPF → "band" (15 m ↔ 12 m)', () => {
    expect(retuneSuggestion(24_915_000, 21_074_000).reason).toBe('band');
  });

  test('unknown current frequency (0) → no suggestion', () => {
    expect(retuneSuggestion(0, 7_074_000).suggest).toBe(false);
  });
});
