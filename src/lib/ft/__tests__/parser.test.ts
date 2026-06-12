import {
  parseFTMsg, mergeContacts, isValidCallsign, gridToLatLon, haversineKm,
} from '../parser';
import { callsignCountry } from '../prefixes';

describe('parseFTMsg', () => {
  it('parses CQ with grid', () => {
    const p = parseFTMsg('CQ PU7FTW HI72');
    expect(p).toMatchObject({ type: 'cq', caller: 'PU7FTW', grid: 'HI72', clean: true });
  });

  it('parses directed CQ', () => {
    const p = parseFTMsg('CQ DX K1ABC FN42');
    expect(p).toMatchObject({ type: 'cq', caller: 'K1ABC', grid: 'FN42', clean: true });
  });

  it('parses bare CQ without grid', () => {
    expect(parseFTMsg('CQ K1ABC')).toMatchObject({ type: 'cq', caller: 'K1ABC', clean: true });
  });

  it('attributes the grid to the SECOND callsign (the transmitter)', () => {
    const p = parseFTMsg('K1ABC W9XYZ FN42');
    expect(p).toMatchObject({
      type: 'answer', caller: 'W9XYZ', callee: 'K1ABC', grid: 'FN42', clean: true,
    });
  });

  it('parses signal reports with and without roger', () => {
    expect(parseFTMsg('K1ABC W9XYZ -12')).toMatchObject({ type: 'report', report: -12, clean: true });
    expect(parseFTMsg('K1ABC W9XYZ R+05')).toMatchObject({ type: 'r_report', report: 5, clean: true });
    expect(parseFTMsg('K1ABC W9XYZ R-3')).toMatchObject({ type: 'r_report', report: -3, clean: true });
  });

  it('parses sign-offs and never reads RR73 as a grid', () => {
    expect(parseFTMsg('K1ABC W9XYZ RR73')).toMatchObject({ type: 'rr73', clean: true });
    expect(parseFTMsg('K1ABC W9XYZ RRR')).toMatchObject({ type: 'rrr', clean: true });
    expect(parseFTMsg('K1ABC W9XYZ 73')).toMatchObject({ type: 'tx73', clean: true });
    expect(parseFTMsg('K1ABC W9XYZ RR73').grid).toBeUndefined();
  });

  it('keeps usable info from partial captures with <...> placeholders', () => {
    const p = parseFTMsg('<...> PU7FTW HI72');
    expect(p).toMatchObject({ type: 'answer', caller: 'PU7FTW', grid: 'HI72', clean: true });
    expect(isValidCallsign(p.callee)).toBe(false);
  });

  it('rejects garbled decodes containing unclassifiable words', () => {
    expect(parseFTMsg('K1ABC QWERTY ZZ').clean).toBe(false);
    expect(parseFTMsg('HELLO WORLD 73').clean).toBe(false);
    expect(parseFTMsg('K1ABC W9XYZ FN42 EXTRA').clean).toBe(false);
  });

  it('rejects two-word fragments without payload', () => {
    expect(parseFTMsg('K1ABC W9XYZ').clean).toBe(false);
  });

  it('parses "CALLER GRID" fragments — the locator follows its owner', () => {
    const p = parseFTMsg('PU7FTW HI72');
    expect(p).toMatchObject({ caller: 'PU7FTW', grid: 'HI72', clean: true });
    expect(parseFTMsg('<...> HI72').clean).toBe(false); // placeholder owner is useless
  });
});

describe('mergeContacts', () => {
  const t = new Date('2026-06-12T12:00:00Z');
  const merge = (msgs: string[]) =>
    mergeContacts(new Map(), t, msgs.map(msg => ({ msg, freq: 1500, snr: -10 })), 0);

  it('records grids from partial captures (the old bug)', () => {
    const contacts = merge(['<...> PU7FTW HI72']);
    const c = contacts.get('PU7FTW')!;
    expect(c).toBeDefined();
    expect(c.grid).toBe('HI72');
    expect(c.latLon).toBeDefined();
    expect(contacts.has('<...>')).toBe(false);
  });

  it('assigns tx to the transmitter and rx to the addressee', () => {
    const contacts = merge(['K1ABC W9XYZ FN42']);
    expect(contacts.get('W9XYZ')!.msgs[0].role).toBe('tx');
    expect(contacts.get('W9XYZ')!.grid).toBe('FN42');
    expect(contacts.get('K1ABC')!.msgs[0].role).toBe('rx');
    expect(contacts.get('K1ABC')!.grid).toBeUndefined();
  });

  it('never creates contacts for CQ or placeholders', () => {
    const contacts = merge(['CQ PU7FTW HI72', 'K1ABC <...> 73']);
    expect(contacts.has('CQ')).toBe(false);
    expect(Array.from(contacts.keys()).some(k => k.includes('<'))).toBe(false);
  });

  it('skips garbled decodes entirely', () => {
    const contacts = merge(['K1ABC GARBAGE1X ##']);
    expect(contacts.size).toBe(0);
  });

  it('locates stations from grid fragments', () => {
    const contacts = merge(['PU7FTW HI72']);
    const c = contacts.get('PU7FTW')!;
    expect(c.grid).toBe('HI72');
    expect(c.latLon).toBeDefined();
  });

  it('accumulates multiple grids, latest becoming primary', () => {
    const contacts = merge(['CQ PU7FTW HI72', 'K1ABC PU7FTW HI73', 'W9XYZ PU7FTW HI72']);
    const c = contacts.get('PU7FTW')!;
    expect(c.grids).toEqual(['HI72', 'HI73']);
    expect(c.grid).toBe('HI72'); // most recent report
    expect(c.latLon).toEqual(gridToLatLon('HI72'));
  });
});

describe('callsignCountry', () => {
  it('resolves countries from callsign prefixes', () => {
    expect(callsignCountry('LX1TI')?.countryCode).toBe('LU');
    expect(callsignCountry('UR5WCS')?.countryCode).toBe('UA');
    expect(callsignCountry('PU7FTW')?.countryCode).toBe('BR');
    expect(callsignCountry('K1ABC')?.countryCode).toBe('US');
    expect(callsignCountry('W9XYZ')?.countryCode).toBe('US');
    expect(callsignCountry('JA1NUT')?.countryCode).toBe('JP');
    expect(callsignCountry('VK3GA')?.countryCode).toBe('AU');
    expect(callsignCountry('EA8/K1ABC')?.countryCode).toBe('ES'); // portable prefix
  });

  it('prefers the longest matching prefix', () => {
    expect(callsignCountry('BV2A')?.countryCode).toBe('TW'); // BV beats B (China)
    expect(callsignCountry('BY1QH')?.countryCode).toBe('CN');
  });

  it('returns null for unallocated prefixes', () => {
    expect(callsignCountry('QQ1AA')).toBeNull();
  });
});

describe('distance helpers', () => {
  it('computes plausible great-circle distances', () => {
    const a = gridToLatLon('HI72')!; // João Pessoa, Brazil
    const b = gridToLatLon('FN42')!; // New England, USA
    const km = haversineKm(a, b);
    expect(km).toBeGreaterThan(5500);
    expect(km).toBeLessThan(8000);
  });

  it('is zero for identical points', () => {
    expect(haversineKm([10, 20], [10, 20])).toBe(0);
  });
});
