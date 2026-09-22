// The whole point of this module is a guarantee — same callsign, same
// colour, always — so these tests pin the guarantee itself rather than the
// specific hex values it currently produces (which are free to change if
// the palette band is ever retuned, as long as the properties hold).
import { callsignColor, CALLSIGN_COLOR_SPACE } from '../callsignColor';
import { mergeContacts } from '../parser';

const HEX = /^#[0-9a-f]{6}$/;

describe('callsignColor', () => {
  it('is deterministic — the same callsign always gets the same colour', () => {
    for (const cs of ['PU7FTW', 'K1ABC', 'JA1XYZ', 'VK3ABC', 'EA5/G4XYZ']) {
      expect(callsignColor(cs)).toBe(callsignColor(cs));
    }
  });

  it('does not depend on insertion order or on what else has been heard', () => {
    // The regression this module exists for: colour used to be
    // CONTACT_PALETTE[contacts.size % 15], so a station's colour depended on
    // WHEN it was first heard. Two sessions hearing the same stations in a
    // different order must now agree.
    const t = new Date('2026-01-01T00:00:00Z');
    const mk = (msg: string) => ({ msg, freq: 1500, snr: -10 });
    const a = mergeContacts(new Map(), t, [mk('CQ K1ABC FN42'), mk('CQ W9XYZ EM48'), mk('CQ PY2AB GG66')]).contacts;
    const b = mergeContacts(new Map(), t, [mk('CQ PY2AB GG66'), mk('CQ K1ABC FN42'), mk('CQ W9XYZ EM48')]).contacts;
    for (const cs of ['K1ABC', 'W9XYZ', 'PY2AB']) {
      expect(a.get(cs)!.color).toBe(b.get(cs)!.color);
    }
  });

  it('normalizes case and surrounding whitespace', () => {
    expect(callsignColor('pu7ftw')).toBe(callsignColor('PU7FTW'));
    expect(callsignColor('  PU7FTW  ')).toBe(callsignColor('PU7FTW'));
    expect(callsignColor('Pu7FtW')).toBe(callsignColor('PU7FTW'));
  });

  it('treats a compound/portable call as its own identity', () => {
    // Deliberate: the app tracks PU7FTW and PU7FTW/P as separate contacts
    // everywhere else, so giving them one colour would make two rows look
    // like one station.
    expect(callsignColor('PU7FTW/P')).not.toBe(callsignColor('PU7FTW'));
  });

  it('always returns a valid 6-digit hex colour', () => {
    for (const cs of ['K1A', 'PU7FTW', 'VP2E/K1ABC', '9A1ABC', 'LU8', 'ZZZZZZ']) {
      expect(callsignColor(cs)).toMatch(HEX);
    }
  });

  it('falls back to the neutral grey for an empty callsign', () => {
    expect(callsignColor('')).toBe('#8b949e');
    expect(callsignColor('   ')).toBe('#8b949e');
  });

  it('stays inside the light/saturated band the dark UI needs', () => {
    // A colour outside this band would be unreadable as text on the app's
    // #0d1117/#161b22 surfaces — the reason hue (not lightness) carries the
    // identity here.
    const toHsl = (hex: string) => {
      const r = parseInt(hex.slice(1, 3), 16) / 255;
      const g = parseInt(hex.slice(3, 5), 16) / 255;
      const b = parseInt(hex.slice(5, 7), 16) / 255;
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
      const l = (mx + mn) / 2;
      const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
      return { s: s * 100, l: l * 100 };
    };
    for (let i = 0; i < 400; i++) {
      const { s, l } = toHsl(callsignColor(`TEST${i}X`));
      expect(l).toBeGreaterThanOrEqual(55);
      // Upper bound allows for the rounding introduced by the HSL -> 8-bit
      // hex round-trip (a nominal L=72% reads back as ~78% at low chroma).
      expect(l).toBeLessThanOrEqual(80);
      expect(s).toBeGreaterThanOrEqual(60);
    }
  });

  it('spreads a realistic session across many distinct colours', () => {
    // Not a uniformity proof — just a guard against a regression that
    // collapses the space (e.g. reusing the same hash bits for all three
    // channels, which would turn it into a 1-D ramp).
    const calls = new Set<string>();
    const L = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    for (let i = 0; i < 60; i++) calls.add(`K${i % 10}${L[i % 26]}${L[(i * 7) % 26]}`);
    const colors = new Set([...calls].map(callsignColor));
    // 60 callsigns over a 315-colour space: a few collisions are expected,
    // wholesale collapse is not.
    expect(colors.size).toBeGreaterThan(calls.size * 0.8);
  });

  it('exposes a colour space far larger than the 15-entry palette it replaced', () => {
    expect(CALLSIGN_COLOR_SPACE).toBeGreaterThan(200);
  });
});
