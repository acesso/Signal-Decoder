// Regression test for the bridge-TX logging bug.
//
// Bridge TX uploads the encoded message to the ESP32 and plays it from
// firmware PSRAM, so our own transmission never passes through the browser's
// audio graph and is never decoded locally. mergeContacts() is fed only by
// decoder output, so without an explicit injection the contact store ends up
// holding ONLY the peer's half of the exchange — which makes
// segmentIsConfirmed() fail and silently degrades every QSO to a partial (or
// drops it from ADIF export entirely).
//
// These tests pin both halves of that: the broken shape (peer-only) must not
// confirm, and the injected shape (both halves) must produce a complete,
// exportable QSO record.
import { mergeContacts, extractQSORecords, generateADIFFromRecords, type Contact } from '../parser';

const ME = 'K1ABC';
const PEER = 'W9XYZ';
const VFO = 14_074_000;
const AUDIO_HZ = 1500;

// FT8 windows are 15s apart; a normal QSO alternates peer/me.
const W = (n: number) => new Date(1_700_000_000_000 + n * 15_000);

type Msg = { msg: string; fromMe: boolean };

// A complete, textbook FT8 exchange: CQ, reply, report, R-report, RRR, 73.
const FULL_QSO: Msg[] = [
  { msg: `CQ ${PEER} FN42`,        fromMe: false },
  { msg: `${PEER} ${ME} EM48`,     fromMe: true  },
  { msg: `${ME} ${PEER} -09`,      fromMe: false },
  { msg: `${PEER} ${ME} R-12`,     fromMe: true  },
  { msg: `${ME} ${PEER} RRR`,      fromMe: false },
  { msg: `${PEER} ${ME} 73`,       fromMe: true  },
];

// Feed a message sequence through mergeContacts the way the app does,
// optionally dropping our own transmissions to simulate the bridge-TX gap.
function buildContacts(msgs: Msg[], includeMine: boolean): Map<string, Contact> {
  let contacts = new Map<string, Contact>();
  msgs.forEach((m, i) => {
    if (m.fromMe && !includeMine) return;
    ({ contacts } = mergeContacts(
      contacts,
      W(i),
      [{ msg: m.msg, freq: VFO + AUDIO_HZ, snr: m.fromMe ? 0 : -9 }],
      0,
    ));
  });
  return contacts;
}

describe('bridge TX self-logging', () => {
  it('REGRESSION: peer-only decodes (bridge TX, no injection) never confirm the QSO', () => {
    const contacts = buildContacts(FULL_QSO, /* includeMine */ false);
    const recs = extractQSORecords(contacts.get(PEER)!, ME, 'FT8', VFO);

    // This is exactly the broken behavior the operator saw: the exchange
    // looks one-sided, so nothing is confirmed and no report was ever "sent".
    expect(recs.every(r => !r.confirmed)).toBe(true);
    expect(recs.every(r => r.sentCount === 0)).toBe(true);
    expect(recs.every(r => r.rstSent === undefined)).toBe(true);
  });

  it('injecting our own transmissions confirms the QSO and records both halves', () => {
    const contacts = buildContacts(FULL_QSO, /* includeMine */ true);
    const recs = extractQSORecords(contacts.get(PEER)!, ME, 'FT8', VFO);

    expect(recs).toHaveLength(1);
    const r = recs[0];
    expect(r.confirmed).toBe(true);
    expect(r.callsign).toBe(PEER);
    expect(r.sentCount).toBe(3);   // my answer, R-report and 73
    // Their CQ is addressed to nobody (callee=undefined), so it is not an
    // exchange message — only their report and RRR count as received.
    expect(r.rcvdCount).toBe(2);
    expect(r.rstRcvd).toBe(-9);    // best SNR heard FROM them
    expect(r.rstSent).toBe(-12);   // the report I sent them, parsed from R-12
    expect(r.freqHz).toBe(VFO + AUDIO_HZ);
  });

  it('the injected QSO survives into ADIF with both report fields populated', () => {
    const contacts = buildContacts(FULL_QSO, /* includeMine */ true);
    const recs = extractQSORecords(contacts.get(PEER)!, ME, 'FT8', VFO);
    const adif = generateADIFFromRecords(recs, { myCall: ME, myGrid: 'EM48', vfoHz: VFO });

    expect(adif).toContain(`${PEER}`);
    expect(adif).toContain('RST_SENT');
    expect(adif).toContain('RST_RCVD');
    expect(adif).toContain('FT8');
  });

  it('does not fabricate a self-worked QSO from our own injected messages', () => {
    const contacts = buildContacts(FULL_QSO, /* includeMine */ true);
    // Our own callsign gets a contact entry (mergeContacts tracks every
    // callsign it sees), but it must never export as a QSO with ourselves.
    const mine = contacts.get(ME);
    if (mine) expect(extractQSORecords(mine, ME, 'FT8', VFO)).toHaveLength(0);
  });
});
