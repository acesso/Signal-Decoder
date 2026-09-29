import { toSpot } from '../eligibility';
import type { AdmittedDecode } from '../../parser';

const WINDOW = new Date('2026-09-29T18:00:00Z');

function decode(overrides: Partial<AdmittedDecode> = {}): AdmittedDecode {
  return {
    callsign: 'PY2ABC',
    grid: 'GG66',
    windowStart: WINDOW,
    freq: 14074500,
    snr: -12,
    ...overrides,
  };
}

describe('toSpot', () => {
  it('maps an admitted decode onto a spot', () => {
    const result = toSpot(decode(), 'FT8', 'PU7FWT');
    expect(result).toEqual({
      ok: true,
      spot: {
        senderCallsign: 'PY2ABC',
        frequencyHz: 14074500,
        snrDb: -12,
        mode: 'FT8',
        locator: 'GG66',
        flowStartSeconds: Math.floor(WINDOW.getTime() / 1000),
      },
    });
  });

  it('carries FT4 through under its own name', () => {
    const result = toSpot(decode(), 'FT4', 'PU7FWT');
    expect(result.ok && result.spot.mode).toBe('FT4');
  });

  it('refuses FT2, which PSK Reporter does not know', () => {
    // Better to report nothing than to mislabel it as a mode it is not.
    expect(toSpot(decode(), 'FT2', 'PU7FWT')).toEqual({ ok: false, reason: 'mode' });
  });

  it('refuses a decode with only an audio offset', () => {
    // Without a radio reporting its dial frequency the absolute frequency is
    // unknown, and a spot on the wrong band is worse than no spot.
    expect(toSpot(decode({ freq: 1500 }), 'FT8', 'PU7FWT')).toEqual({ ok: false, reason: 'frequency' });
  });

  it('refuses hearing itself', () => {
    expect(toSpot(decode({ callsign: 'PU7FWT' }), 'FT8', 'pu7fwt')).toEqual({ ok: false, reason: 'self' });
  });

  it('refuses a hashed callsign', () => {
    expect(toSpot(decode({ callsign: '<PY2ABC>' }), 'FT8', 'PU7FWT')).toEqual({ ok: false, reason: 'callsign' });
  });

  it('omits a locator that was not decoded', () => {
    const result = toSpot(decode({ grid: undefined }), 'FT8', 'PU7FWT');
    expect(result.ok && result.spot.locator).toBeUndefined();
  });

  it('uppercases the reported callsign', () => {
    const result = toSpot(decode({ callsign: 'py2abc' }), 'FT8', 'PU7FWT');
    expect(result.ok && result.spot.senderCallsign).toBe('PY2ABC');
  });

  it('still reports when the operator has no callsign set', () => {
    const result = toSpot(decode(), 'FT8', undefined);
    expect(result.ok).toBe(true);
  });
});
