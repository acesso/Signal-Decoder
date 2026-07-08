import {
  parseFTMsg, mergeContacts, isValidCallsign, classifyCallsign, gridToLatLon, haversineKm,
  generateADIF, isConfirmedQSO,
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

  // ft8mon's own internal fallback for an unrecognized message type/subtype
  // ("i3=%d n3=%d" in ft8mon_wasm.cc) is a real observed false decode — no
  // callsign-shaped word in it at all, so it must never register as clean.
  it('rejects ft8mon\'s "i3=X n3=Y" internal fallback string', () => {
    expect(parseFTMsg('i3=0 n3=5').clean).toBe(false);
  });

  it('rejects a CQ whose caller has an unallocated ITU prefix', () => {
    // "Q" is not an allocated amateur-radio prefix — shape-plausible garbage
    // that isValidCallsign's shape check alone wouldn't catch.
    expect(parseFTMsg('CQ Q9AAA FN20').clean).toBe(false);
  });

  it('accepts compound/portable callsigns in a standard exchange', () => {
    const p = parseFTMsg('PJ4/K1ABC W1AW RRR');
    expect(p).toMatchObject({ type: 'rrr', caller: 'W1AW', callee: 'PJ4/K1ABC', clean: true });
  });

  it('accepts a special-event CQ (long/irregular suffix, no slash)', () => {
    const p = parseFTMsg('CQ YW18FIFA FK68');
    expect(p).toMatchObject({ type: 'cq', caller: 'YW18FIFA', clean: true });
  });
});

describe('isValidCallsign — ITU prefix + shape', () => {
  it('accepts standard-shape callsigns with an allocated prefix', () => {
    expect(isValidCallsign('K1ABC')).toBe(true);
    expect(isValidCallsign('PU7FTW')).toBe(true);
    expect(isValidCallsign('VE3ABC')).toBe(true);
  });

  it('accepts a digit-led prefix as long as it has ≥1 letter (9A1AA, 3DA0XY)', () => {
    expect(isValidCallsign('9A1AA')).toBe(true);   // Croatia, 2-char digit+letter prefix
    expect(isValidCallsign('3DA0XY')).toBe(true);  // Eswatini, 3-char prefix (nonstandard shape)
  });

  it('accepts compound/portable form when either side is a real callsign', () => {
    expect(isValidCallsign('PJ4/K1ABC')).toBe(true);
    expect(isValidCallsign('K1ABC/PJ4')).toBe(true);
  });

  it('accepts special-event callsigns with a longer suffix', () => {
    expect(isValidCallsign('YW18FIFA')).toBe(true);
    expect(isValidCallsign('PA2EVENT')).toBe(true);
  });

  it('rejects an unallocated prefix even when the shape looks plausible', () => {
    expect(isValidCallsign('Q9AAA')).toBe(false); // Q is not ITU-allocated
  });

  it('rejects a longer prefix that only coincidentally starts with a real one', () => {
    // "ZZ" (Brazil) is real, but "ZZ9" as a 3-char prefix is not — must not
    // fall back to the shorter allocation once a longer shape has matched.
    expect(isValidCallsign('ZZ99ZZ')).toBe(false);
  });

  it('rejects non-callsign tokens regardless of shape', () => {
    expect(isValidCallsign('CQ')).toBe(false);
    expect(isValidCallsign('<...>')).toBe(false);
    expect(isValidCallsign('13=0')).toBe(false);
  });
});

describe('classifyCallsign', () => {
  it('flags compound/portable callsigns', () => {
    expect(classifyCallsign('PJ4/K1ABC').kind).toBe('compound');
  });

  it('flags nonstandard-shape (58-bit) callsigns', () => {
    expect(classifyCallsign('YW18FIFA').kind).toBe('nonstandard');
    expect(classifyCallsign('3DA0XY').kind).toBe('nonstandard');
  });

  it('flags standard-shape (28-bit) callsigns', () => {
    expect(classifyCallsign('K1ABC').kind).toBe('standard');
  });

  it('derives Brazilian license class from prefix + suffix length', () => {
    // PU is always Class C regardless of suffix length
    expect(classifyCallsign('PU7FTW').brazilLicenseClass).toBe('C');
    expect(classifyCallsign('PU1AB').brazilLicenseClass).toBe('C');
    // PP/PR/PS/PT/PV/PW/PY/ZV-ZZ: 2-letter suffix = A, 3-letter suffix = B
    expect(classifyCallsign('PY2AB').brazilLicenseClass).toBe('A');
    expect(classifyCallsign('PY2ABC').brazilLicenseClass).toBe('B');
    expect(classifyCallsign('PP5XYZ').brazilLicenseClass).toBe('B');
    expect(classifyCallsign('ZZ1AB').brazilLicenseClass).toBe('A');
  });

  it('leaves brazilLicenseClass undefined for non-Brazilian callsigns', () => {
    expect(classifyCallsign('K1ABC').brazilLicenseClass).toBeUndefined();
    expect(classifyCallsign('9A1AA').brazilLicenseClass).toBeUndefined();
  });
});

describe('mergeContacts', () => {
  const t = new Date('2026-06-12T12:00:00Z');
  const merge = (msgs: string[]) =>
    mergeContacts(new Map(), t, msgs.map(msg => ({ msg, freq: 1500, snr: -10 })), 0).contacts;

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

describe('generateADIF', () => {
  const t = new Date('2026-06-12T12:00:00Z');
  // Standard WSJT-X exchange: THEM calls CQ, ME answers and completes the QSO.
  const me   = 'K1ABC';
  const them = 'W9XYZ';
  const qsoMsgs = [
    `CQ ${them} FN42`,
    `${them} ${me} FN31`,
    `${me} ${them} -10`,
    `${them} ${me} R-05`,
    `${me} ${them} RR73`,
  ];
  const merge = (msgs: string[]) =>
    mergeContacts(new Map(), t, msgs.map(msg => ({ msg, freq: 1500, snr: -10 })), 0).contacts;

  it('never emits a record for our own callsign (the self-QSO bug)', () => {
    const contacts = merge(qsoMsgs);
    // mergeContacts tracks every caller/callee it sees, including us —
    // confirm the self-entry exists so this test actually exercises the guard.
    expect(contacts.has(me)).toBe(true);

    const adif = generateADIF(contacts, 'FT8' as any, { myCall: me, myGrid: 'FN31' });
    expect(adif).not.toContain(`<CALL:${me.length}>${me}`);
  });

  it('records CALL as the other station and STATION_CALLSIGN as ours', () => {
    const contacts = merge(qsoMsgs);
    const adif = generateADIF(contacts, 'FT8' as any, { myCall: me, myGrid: 'FN31' });
    expect(adif).toContain(`<CALL:${them.length}>${them}`);
    expect(adif).toContain(`<STATION_CALLSIGN:${me.length}>${me}`);
  });

  it('marks a completed exchange with the peer as a confirmed QSO', () => {
    const contacts = merge(qsoMsgs);
    expect(isConfirmedQSO(contacts.get(them)!, me)).toBe(true);
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
