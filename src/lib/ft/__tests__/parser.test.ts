import {
  parseFTMsg, mergeContacts, isValidCallsign, classifyCallsign, gridToLatLon, haversineKm,
  generateADIF, isConfirmedQSO, isPartialQSO, buildFTMessage, needsHashedExchange, qsyAudioOffsetHz,
  baseCallsign, extractQSORecords, generateADIFFromRecords, nextTxMsgType,
  type TxMsgType,
} from '../parser';
import { encodeFT8 } from '@e04/ft8ts';
import { callsignCountry } from '../prefixes';

describe('parseFTMsg', () => {
  it('parses CQ with grid', () => {
    const p = parseFTMsg('CQ PU7FTW HI72');
    expect(p).toMatchObject({ type: 'cq', caller: 'PU7FTW', grid: 'HI72', clean: true });
  });

  it('parses directed CQ and captures the tag', () => {
    const p = parseFTMsg('CQ DX K1ABC FN42');
    expect(p).toMatchObject({ type: 'cq', caller: 'K1ABC', grid: 'FN42', cqTag: 'DX', clean: true });
    expect(parseFTMsg('CQ POTA K1ABC FN42')).toMatchObject({ type: 'cq', caller: 'K1ABC', cqTag: 'POTA', clean: true });
    expect(parseFTMsg('CQ SOTA K1ABC')).toMatchObject({ type: 'cq', caller: 'K1ABC', cqTag: 'SOTA', clean: true });
    expect(parseFTMsg('CQ K1ABC FN42').cqTag).toBeUndefined();
  });

  it('parses a numeric QSY CQ ("CQ nnn CALL GRID")', () => {
    const p = parseFTMsg('CQ 573 K1ABC FN42');
    expect(p).toMatchObject({ type: 'cq', caller: 'K1ABC', grid: 'FN42', cqTag: '573', clean: true });
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

  it('accepts a doubly-compound portable CQ (the 9A/S55X/P case)', () => {
    const p = parseFTMsg('CQ 9A/S55X/P');
    expect(p).toMatchObject({ type: 'cq', caller: '9A/S55X/P', clean: true });
  });

  // Hashed-call exchanges (protocol types 1/4 for nonstandard calls) — the
  // decoder shows the hashed call in <angle brackets> once resolved.
  it('parses a hashed two-word answer "<THEIR> MINE"', () => {
    const p = parseFTMsg('<YS3/PY8WW> PU7FTW');
    expect(p).toMatchObject({ type: 'answer', caller: 'PU7FTW', callee: 'YS3/PY8WW', clean: true });
  });

  it('parses hashed report and sign-off forms', () => {
    expect(parseFTMsg('<YS3/PY8WW> PU7FTW R-08')).toMatchObject({ type: 'r_report', caller: 'PU7FTW', callee: 'YS3/PY8WW', report: -8, clean: true });
    expect(parseFTMsg('YS3/PY8WW <PU7FTW> RR73')).toMatchObject({ type: 'rr73', caller: 'PU7FTW', callee: 'YS3/PY8WW', clean: true });
  });

  it('parses a plain two-word answer when either call requires the hashed exchange', () => {
    // Type-4 exchanges carry no grid, and decoders render the resolved hash
    // WITHOUT brackets — so for compound/nonstandard calls two words IS the
    // complete message, not a fragment.
    expect(parseFTMsg('W5C/H PU7FTW')).toMatchObject({ type: 'answer', caller: 'PU7FTW', callee: 'W5C/H', clean: true });
    expect(parseFTMsg('ZY32MMDC PU7FTW')).toMatchObject({ type: 'answer', caller: 'PU7FTW', callee: 'ZY32MMDC', clean: true });
    expect(parseFTMsg('PU7FTW YS3/PY8WW')).toMatchObject({ type: 'answer', caller: 'YS3/PY8WW', callee: 'PU7FTW', clean: true });
  });

  it('a standard-base /P or /R portable does not unlock the two-word form (it rides types 1/2)', () => {
    expect(parseFTMsg('K1ABC/P W9XYZ').clean).toBe(false);
    expect(parseFTMsg('K1ABC/R W9XYZ').clean).toBe(false);
  });

  it('still rejects plain two-word pairs of standard calls and keeps <...> placeholders invalid', () => {
    // No bracket marker and no hash-requiring shape → treat as a likely
    // garbled 3-word capture, as before
    expect(parseFTMsg('K1ABC W9XYZ').clean).toBe(false);
    expect(parseFTMsg('<...> PU7FTW').clean).toBe(false);
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

  it('accepts doubly-compound PREFIX/CALL/SUFFIX portable calls', () => {
    expect(isValidCallsign('9A/S55X/P')).toBe(true);   // Slovenian op portable in Croatia
    expect(isValidCallsign('EA8/K1ABC/M')).toBe(true);
    expect(isValidCallsign('PJ4/K1ABC/7')).toBe(true); // region-digit suffix
    // Unknown trailing part / no valid call anywhere → still rejected
    expect(isValidCallsign('9A/S55X/XYZQ')).toBe(false);
    expect(isValidCallsign('A/B/P')).toBe(false);
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

  it('accepts real-world callsigns previously missed by an incomplete/exact-only prefix table', () => {
    expect(isValidCallsign('Z62NS')).toBe(true);       // Kosovo
    expect(isValidCallsign('IS0/IK2YCW')).toBe(true);  // Italy, portable in Sardinia
    expect(isValidCallsign('IZ6OUX')).toBe(true);       // Italy
    expect(isValidCallsign('BG4UCZ')).toBe(true);       // China
    expect(isValidCallsign('ON7DE')).toBe(true);        // Belgium
  });

  it('accepts a LETTER+DIGIT allocation whose digit doubles as the FT8 packing digit (4-char call, no separate digit)', () => {
    // "D2UY": Angola's prefix is itself "D2" — with only a 2-letter suffix
    // there's no second digit, so the regex's own required digit and the
    // prefix's digit are the same character. Must prefer the 2-char
    // letter+digit reading ("D2") over backtracking to a bare "D" (never
    // itself allocated) plus digit "2".
    expect(isValidCallsign('D2UY')).toBe(true);
  });

  it('accepts a 2-char allocation whose region digit could otherwise be misread as a 3-char prefix', () => {
    // "9A60CBM": Croatia's prefix is "9A" (2 chars) + region digit "6" + a
    // longer suffix "0CBM" — but the same string also parses as a 3-char
    // prefix "9A6" + digit "0" + suffix "CBM", and "9A6" was never itself
    // allocated. Must prefer the 2-char reading that IS allocated.
    expect(isValidCallsign('9A60CBM')).toBe(true);
  });

  // Regression: a real decode of "VP2MAA" (Anguilla) was rejected as
  // invalid. CS_STANDARD's greedy {1,2} group correctly read the prefix
  // letters as "VP" (2 chars) + digit "2" + suffix "MAA" — but "VP" alone
  // isn't an ITU allocation; only "VP2"/"VP5"/"VP9" specifically are (see
  // prefixes.ts's own comment on why these need explicit 3-char entries).
  // Same class of ambiguity as the D2UY case above, one prefix-length up.
  it('accepts a 2-LETTER+DIGIT allocation whose bare 2-letter prefix is not itself allocated (VP2/VP5/VP9)', () => {
    expect(isValidCallsign('VP2MAA')).toBe(true);  // Anguilla
    expect(isValidCallsign('VP5ABC')).toBe(true);  // Turks & Caicos
    expect(isValidCallsign('VP9XYZ')).toBe(true);  // Bermuda
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

  it('accumulates directed-CQ tags on the caller contact', () => {
    const contacts = merge(['CQ POTA K1ABC FN42', 'CQ DX K1ABC FN42', 'CQ POTA K1ABC FN42']);
    expect(contacts.get('K1ABC')!.cqTags).toEqual(['POTA', 'DX']);
  });

  it('accumulates multiple grids, latest becoming primary', () => {
    const contacts = merge(['CQ PU7FTW HI72', 'K1ABC PU7FTW HI73', 'W9XYZ PU7FTW HI72']);
    const c = contacts.get('PU7FTW')!;
    expect(c.grids).toEqual(['HI72', 'HI73']);
    expect(c.grid).toBe('HI72'); // most recent report
    expect(c.latLon).toEqual(gridToLatLon('HI72'));
  });

  it('tracks plain two-word type-4 answers on both contact cards (compound peer)', () => {
    const contacts = merge(['CQ PU7FTW HI22', 'W5C/H PU7FTW']);
    const caller = contacts.get('PU7FTW')!;
    expect(caller.msgs.some(m => m.raw === 'W5C/H PU7FTW' && m.role === 'tx')).toBe(true);
    const callee = contacts.get('W5C/H')!;
    expect(callee).toBeDefined();
    expect(callee.msgs.some(m => m.raw === 'W5C/H PU7FTW' && m.role === 'rx')).toBe(true);
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

  // Handshake only: THEM calls CQ, ME answers, THEM replies to ME with a grid —
  // both sides have transmitted directly to each other but no signal report
  // has been exchanged yet.
  const handshakeMsgs = [`CQ ${them} FN42`, `${them} ${me} FN31`, `${me} ${them} FN42`];

  it('a handshake with no report is partial, not confirmed, and excluded from export by default', () => {
    const contacts = merge(handshakeMsgs);
    expect(isConfirmedQSO(contacts.get(them)!, me)).toBe(false);
    expect(isPartialQSO(contacts.get(them)!, me)).toBe(true);

    const adif = generateADIF(contacts, 'FT8' as any, { myCall: me, myGrid: 'FN31' });
    expect(adif).not.toContain(`<CALL:${them.length}>${them}`);
  });

  it('includes a partial (handshake-only) QSO in export when includePartial is set', () => {
    const contacts = merge(handshakeMsgs);
    const adif = generateADIF(contacts, 'FT8' as any, { myCall: me, myGrid: 'FN31', includePartial: true });
    expect(adif).toContain(`<CALL:${them.length}>${them}`);
    expect(adif).toContain('partial: handshake only');
  });

  it('does not mark a confirmed (full) QSO as partial even with includePartial set', () => {
    const contacts = merge(qsoMsgs);
    const adif = generateADIF(contacts, 'FT8' as any, { myCall: me, myGrid: 'FN31', includePartial: true });
    expect(adif).not.toContain('partial: handshake only');
  });
});

describe('baseCallsign — operator base call inside compound/portable forms', () => {
  it('plain calls pass through unchanged', () => {
    expect(baseCallsign('PU7FTW')).toBe('PU7FTW');
    expect(baseCallsign('K1ABC')).toBe('K1ABC');
  });

  it('prefix/call forms return the call, not the leading prefix', () => {
    expect(baseCallsign('YS3/PY8WW')).toBe('PY8WW');
    expect(baseCallsign('PJ4/K1ABC')).toBe('K1ABC');
  });

  it('call/suffix portable forms drop the designator or region digit', () => {
    expect(baseCallsign('K1ABC/4')).toBe('K1ABC');
    expect(baseCallsign('K1ABC/P')).toBe('K1ABC');
    expect(baseCallsign('K1ABC/QRP')).toBe('K1ABC');
  });

  it('doubly-compound prefix/call/designator returns the middle call', () => {
    expect(baseCallsign('9A/S55X/P')).toBe('S55X');
  });
});

describe('QSO log records — capture at decode time, export after rotation', () => {
  const t  = new Date('2026-06-12T12:00:00Z');
  const me   = 'K1ABC';
  const them = 'W9XYZ';
  const qsoMsgs = [
    `CQ ${them} FN42`,
    `${them} ${me} FN31`,
    `${me} ${them} -10`,
    `${them} ${me} R-05`,
    `${me} ${them} RR73`,
  ];

  it('extracts a confirmed record with report, counts, and exchange time span', () => {
    const { contacts } = mergeContacts(new Map(), t, qsoMsgs.map(msg => ({ msg, freq: 21_075_500, snr: -7 })), 0);
    const recs = extractQSORecords(contacts.get(them)!, me, 'FT8' as any);
    expect(recs).toHaveLength(1);
    const r = recs[0];
    expect(r.callsign).toBe(them);
    expect(r.confirmed).toBe(true);
    expect(r.rstSent).toBe(-5);    // the R-05 I sent them
    expect(r.rstRcvd).toBe(-7);    // best SNR I heard them at
    expect(r.sentCount).toBe(2);   // my answer + R-05
    expect(r.rcvdCount).toBe(2);   // their -10 report + RR73 (their CQ is not addressed to me)
    expect(r.startMs).toBe(t.getTime());
    expect(r.freqHz).toBe(21_075_500);
  });

  it('a record captured before message rotation still exports after the QSO rotates out of the contact', () => {
    let contacts = mergeContacts(new Map(), t, qsoMsgs.map(msg => ({ msg, freq: 1500, snr: -10 })), 0).contacts;
    // Capture at decode time — what FTDecoder feeds the persistent QSO log.
    const recs = extractQSORecords(contacts.get(them)!, me, 'FT8' as any);
    expect(recs).toHaveLength(1);

    // The peer keeps CQing: 60 further messages push the whole exchange out
    // of the contact's 60-message ring.
    const later = new Date(t.getTime() + 60_000);
    const cqSpam = Array.from({ length: 60 }, () => ({ msg: `CQ ${them} FN42`, freq: 1500, snr: -10 }));
    contacts = mergeContacts(contacts, later, cqSpam, 0).contacts;

    // Deriving from live contacts now silently loses the QSO — the old export bug.
    expect(isConfirmedQSO(contacts.get(them)!, me)).toBe(false);
    const fromContacts = generateADIF(contacts, 'FT8' as any, { myCall: me });
    expect(fromContacts).not.toContain(`<CALL:${them.length}>${them}`);

    // The captured record is rotation-proof.
    const fromLog = generateADIFFromRecords(recs, { myCall: me, myGrid: 'FN31' });
    expect(fromLog).toContain(`<CALL:${them.length}>${them}`);
    expect(fromLog).toContain('<RST_SENT:2>-5');
    expect(fromLog).toContain(`<STATION_CALLSIGN:${me.length}>${me}`);
    expect(fromLog).not.toContain('partial: handshake only');
  });

  it('rounds raw decoder SNR floats in RST fields', () => {
    const { contacts } = mergeContacts(new Map(), t, qsoMsgs.map(msg => ({ msg, freq: 21_075_500, snr: -8.161644894026992 })), 0);
    const recs = extractQSORecords(contacts.get(them)!, me, 'FT8' as any);
    expect(recs[0].rstRcvd).toBe(-8);
    const adif = generateADIFFromRecords(recs, { myCall: me });
    expect(adif).toContain('<RST_RCVD:2>-8');
    expect(adif).not.toContain('161644894026992');
    // Records logged before capture-time rounding hold floats — the
    // formatter must round those too.
    const legacy = generateADIFFromRecords([{ ...recs[0], rstRcvd: -8.161644894026992 }], { myCall: me });
    expect(legacy).toContain('<RST_RCVD:2>-8');
  });

  it('falls back to the export-time VFO for records captured without one (audio offset only)', () => {
    // Decoded with no radio connected: message freqs are bare audio offsets.
    const { contacts } = mergeContacts(new Map(), t, qsoMsgs.map(msg => ({ msg, freq: 1500, snr: -10 })), 0);
    const recs = extractQSORecords(contacts.get(them)!, me, 'FT8' as any, 0);
    expect(recs[0].freqHz).toBe(0);
    expect(recs[0].audioHz).toBe(1500);

    // No VFO at export either → FREQ/BAND omitted.
    expect(generateADIFFromRecords(recs, { myCall: me })).not.toContain('<FREQ:');
    // Radio connected at export → offset folds into the current dial.
    const adif = generateADIFFromRecords(recs, { myCall: me, vfoHz: 21_074_000 });
    expect(adif).toContain('<FREQ:9>21.075500');
    expect(adif).toContain('<BAND:3>15m');
  });

  it('a handshake-only exchange yields an unconfirmed (partial) record', () => {
    const handshake = [`CQ ${them} FN42`, `${them} ${me} FN31`, `${me} ${them} FN42`];
    const { contacts } = mergeContacts(new Map(), t, handshake.map(msg => ({ msg, freq: 1500, snr: -10 })), 0);
    const recs = extractQSORecords(contacts.get(them)!, me, 'FT8' as any);
    expect(recs).toHaveLength(1);
    expect(recs[0].confirmed).toBe(false);
  });

  it('a station merely heard (no exchange with me) yields no record', () => {
    const { contacts } = mergeContacts(new Map(), t, [{ msg: `CQ ${them} FN42`, freq: 1500, snr: -10 }], 0);
    expect(extractQSORecords(contacts.get(them)!, me, 'FT8' as any)).toHaveLength(0);
  });

  it('never yields a record for my own contact entry', () => {
    const { contacts } = mergeContacts(new Map(), t, qsoMsgs.map(msg => ({ msg, freq: 1500, snr: -10 })), 0);
    expect(extractQSORecords(contacts.get(me)!, me, 'FT8' as any)).toHaveLength(0);
  });
});

describe('nextTxMsgType — QSO auto-sequencing incl. retries', () => {
  it('advances the flow where I called CQ', () => {
    expect(nextTxMsgType('cq', 'answer')).toBe('report');       // they answered with grid
    expect(nextTxMsgType('report', 'r_report')).toBe('rr73');   // they rogered my report
    expect(nextTxMsgType('rr73', 'tx73')).toBe('cq');           // their 73 — done
  });

  it('advances the flow where I answered their CQ', () => {
    expect(nextTxMsgType(null, null)).toBe('cq');
    expect(nextTxMsgType('answer', 'report')).toBe('r_report'); // they sent me a report
    expect(nextTxMsgType('r_report', 'rr73')).toBe('tx73');     // confirm their RR73 with 73
  });

  it('answers a direct (tail-end) report with R+report even with no prior exchange', () => {
    expect(nextTxMsgType('cq', 'report')).toBe('r_report');
  });

  it('re-sends the lost transmission when the peer repeats an earlier message', () => {
    expect(nextTxMsgType('answer', 'cq')).toBe('answer');         // they re-CQ'd, keep calling
    expect(nextTxMsgType('report', 'answer')).toBe('report');     // they missed my report
    expect(nextTxMsgType('r_report', 'report')).toBe('r_report'); // they missed my R+report
    expect(nextTxMsgType('rr73', 'r_report')).toBe('rr73');       // they missed my RR73
    expect(nextTxMsgType('tx73', 'rr73')).toBe('tx73');           // they missed my 73
  });

  it('never advances past what the peer has confirmed', () => {
    // No RR73 before any roger of my report — the old table sent RR73
    // unconditionally after a report.
    expect(nextTxMsgType('report', 'cq')).toBe('report');
    expect(nextTxMsgType('report', 'other')).toBe('report');
  });

  it('never replies to a received 73 (no sign-off ping-pong)', () => {
    expect(nextTxMsgType('tx73', 'tx73')).toBe('cq');
    expect(nextTxMsgType('cq', 'tx73')).toBe('cq');
    expect(nextTxMsgType('r_report', 'tx73')).toBe('cq');
  });

  it('QSO is over once they move on (fresh CQ after my RR73)', () => {
    expect(nextTxMsgType('rr73', 'cq')).toBe('cq');
    expect(nextTxMsgType('rr73', 'answer')).toBe('cq');
  });
});

describe('nextTxMsgType — Fox/Hound (DXpedition) mode', () => {
  it('jumps straight to RR73 once Fox reports us, skipping the normal r_report step', () => {
    expect(nextTxMsgType('answer', 'report', true)).toBe('rr73');
    expect(nextTxMsgType('answer', 'r_report', true)).toBe('rr73');
  });

  it('defaults to normal-QSO behavior when foxHound is omitted or false', () => {
    expect(nextTxMsgType('answer', 'report')).toBe('r_report');
    expect(nextTxMsgType('answer', 'report', false)).toBe('r_report');
  });

  it('leaves every other state unaffected by foxHound', () => {
    expect(nextTxMsgType('cq', 'answer', true)).toBe('report');
    expect(nextTxMsgType('rr73', 'tx73', true)).toBe('cq');
    expect(nextTxMsgType('answer', 'rr73', true)).toBe('tx73');
    expect(nextTxMsgType('answer', 'cq', true)).toBe('answer'); // keep calling in
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

describe('qsyAudioOffsetHz — numeric directed-CQ (QSY) requests', () => {
  const VFO = 14_074_000; // dial 14.074 MHz

  it('reads nnn as the requested dial kHz when reachable from the VFO passband', () => {
    expect(qsyAudioOffsetHz('076', VFO)).toBe(2000); // 14.076 = VFO + 2000 Hz audio
    expect(qsyAudioOffsetHz('075', VFO)).toBe(1000);
  });

  it('never asks for a rig retune — unreachable dial requests return null', () => {
    expect(qsyAudioOffsetHz('080', VFO)).toBeNull(); // 6 kHz up: outside the passband
    expect(qsyAudioOffsetHz('074', VFO)).toBeNull(); // 0 Hz offset: below the passband floor
  });

  it('falls back to literal audio Hz when the kHz reading is impossible', () => {
    expect(qsyAudioOffsetHz('573', VFO)).toBe(573); // 14.573 is nonsense → 573 Hz audio
    expect(qsyAudioOffsetHz('573', 0)).toBe(573);   // no CAT/VFO: literal audio Hz
    expect(qsyAudioOffsetHz('080', 0)).toBeNull();  // 80 Hz below passband → unusable
  });

  it('ignores non-numeric or absent tags', () => {
    expect(qsyAudioOffsetHz('DX', VFO)).toBeNull();
    expect(qsyAudioOffsetHz(undefined, VFO)).toBeNull();
  });
});

describe('buildFTMessage — hashed exchange for nonstandard calls', () => {
  it('classifies which calls need the hashed forms', () => {
    expect(needsHashedExchange('K1ABC')).toBe(false);
    expect(needsHashedExchange('K1ABC/P')).toBe(false); // /P rides type 2 natively
    expect(needsHashedExchange('K1ABC/R')).toBe(false);
    expect(needsHashedExchange('YS3/PY8WW')).toBe(true);
    expect(needsHashedExchange('PJ4/K1ABC')).toBe(true);
    expect(needsHashedExchange('YW18FIFA')).toBe(true);
    expect(needsHashedExchange('')).toBe(false);
  });

  it('builds WSJT-X-style hashed forms when their call is compound', () => {
    const my = 'PU7FTW', their = 'YS3/PY8WW';
    expect(buildFTMessage('answer', my, their, undefined, 'HI22')).toBe('<YS3/PY8WW> PU7FTW'); // grid dropped
    expect(buildFTMessage('report', my, their, -8)).toBe('<YS3/PY8WW> PU7FTW -08');
    expect(buildFTMessage('r_report', my, their, -8)).toBe('<YS3/PY8WW> PU7FTW R-08');
    expect(buildFTMessage('rr73', my, their)).toBe('YS3/PY8WW <PU7FTW> RR73');
    expect(buildFTMessage('tx73', my, their)).toBe('YS3/PY8WW <PU7FTW> 73');
  });

  it('keeps standard forms untouched for standard calls', () => {
    expect(buildFTMessage('answer', 'W9XYZ', 'K1ABC', undefined, 'FN42')).toBe('K1ABC W9XYZ FN42');
    expect(buildFTMessage('rr73', 'W9XYZ', 'K1ABC')).toBe('K1ABC W9XYZ RR73');
  });

  it('drops the grid from a compound-call CQ', () => {
    expect(buildFTMessage('cq', 'YS3/PY8WW', '', undefined, 'HI22')).toBe('CQ YS3/PY8WW');
  });

  // The point of it all: every generated hashed form must actually pack into
  // a 77-bit FT8 payload. This drives the real encoder end to end.
  it('every hashed form round-trips through the FT8 encoder', () => {
    const types: TxMsgType[] = ['cq', 'answer', 'report', 'r_report', 'rr73', 'tx73'];
    for (const t of types) {
      const msg = buildFTMessage(t, 'PU7FTW', 'YS3/PY8WW', -8, 'HI22');
      expect(() => encodeFT8(msg, { sampleRate: 12000, baseFrequency: 1500 })).not.toThrow();
    }
    // My call compound, theirs standard — the other direction
    for (const t of types) {
      const msg = buildFTMessage(t, 'YS3/PY8WW', 'PU7FTW', -8, 'HI22');
      expect(() => encodeFT8(msg, { sampleRate: 12000, baseFrequency: 1500 })).not.toThrow();
    }
  });

  it('replies to a doubly-compound portable call with encodable hashed forms', () => {
    expect(needsHashedExchange('9A/S55X/P')).toBe(true);
    const answer = buildFTMessage('answer', 'PU7FTW', '9A/S55X/P', undefined, 'HI22');
    expect(answer).toBe('<9A/S55X/P> PU7FTW');
    expect(() => encodeFT8(answer, { sampleRate: 12000, baseFrequency: 1500 })).not.toThrow();
  });

  it('documents the protocol trap: compound call + grid silently truncates to free text', () => {
    // Unbracketed compound calls fit no structured type, so the packer falls
    // back to free text and silently truncates to 13 chars ("YS3/PY8WW PU7")
    // — it does NOT throw. This is why the hashed forms above exist and why
    // the transmit panel refuses to enqueue this shape.
    expect(() => encodeFT8('YS3/PY8WW PU7FTW HI22', { sampleRate: 12000, baseFrequency: 1500 })).not.toThrow();
  });
});
