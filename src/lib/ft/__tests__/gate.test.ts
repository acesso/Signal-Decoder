import { DecodeGate, isNearTwin, QUARANTINE_WINDOWS, RELEASE_SIGHTING_WINDOWS } from '../gate';
import { latLonPlausibleForCountry, geoTableCountries } from '../geo';
import { mergeContacts, gridToLatLon, type MergeMsgIn } from '../parser';
import { callsignCountry } from '../prefixes';

const W = (n: number) => new Date(Date.UTC(2026, 5, 12, 12, 0, n * 15)); // window n

const msg = (text: string, osd = -1): MergeMsgIn => ({ msg: text, freq: 1500, snr: -12, osd });

// Run a sequence of windows through mergeContacts with a shared gate,
// returning the final contacts map and per-window stats.
function run(windows: MergeMsgIn[][]) {
  const gate = new DecodeGate();
  let contacts = new Map();
  const stats = [];
  for (let i = 0; i < windows.length; i++) {
    const r = mergeContacts(contacts, W(i), windows[i], 0, gate);
    contacts = r.contacts;
    stats.push(r.stats);
  }
  return { contacts, stats, gate };
}

describe('latLonPlausibleForCountry', () => {
  it('accepts a station in its own country', () => {
    expect(latLonPlausibleForCountry('NO', gridToLatLon('JO59')!)).toBe(true);  // Oslo
    expect(latLonPlausibleForCountry('BR', gridToLatLon('GG66')!)).toBe(true);  // São Paulo
    expect(latLonPlausibleForCountry('US', gridToLatLon('FN20')!)).toBe(true);  // NJ
    expect(latLonPlausibleForCountry('JP', gridToLatLon('PM95')!)).toBe(true);  // Tokyo
  });

  it('rejects continent-scale nonsense (the observed false positives)', () => {
    expect(latLonPlausibleForCountry('NO', gridToLatLon('HL53')!)).toBe(false); // "Norway" in Korea
    expect(latLonPlausibleForCountry('US', gridToLatLon('II29')!)).toBe(false); // "US" in the S. Atlantic
    expect(latLonPlausibleForCountry('MW', gridToLatLon('II71')!)).toBe(false); // "Malawi" in the S. Atlantic
    expect(latLonPlausibleForCountry('PE', gridToLatLon('EH17')!)).toBe(false); // "Peru" in the ocean W of Chile
  });

  it('accepts distant territories of the same country', () => {
    expect(latLonPlausibleForCountry('US', gridToLatLon('BL11')!)).toBe(true);  // Hawaii
    expect(latLonPlausibleForCountry('US', gridToLatLon('FK68')!)).toBe(true);  // Puerto Rico
    expect(latLonPlausibleForCountry('PT', gridToLatLon('HM77')!)).toBe(true);  // Azores
    expect(latLonPlausibleForCountry('NO', gridToLatLon('JQ78')!)).toBe(true);  // Svalbard
    expect(latLonPlausibleForCountry('ES', gridToLatLon('IL18')!)).toBe(true);  // Canaries
  });

  it('fails open for countries missing from the table', () => {
    expect(latLonPlausibleForCountry('XX', [0, 0])).toBe(true);
  });

  it('covers every country code used by the prefix table', () => {
    // Spot-audit: the geo table must include every country callsignCountry
    // can produce, or geo checks would silently fail open for gaps.
    const covered = new Set(geoTableCountries());
    for (const cs of ['K1ABC', 'PY2X', 'LA1B', 'JA1AA', 'VK2AB', 'ZS1A', '9A1AA', 'C31AA', 'T77AA', 'ZD7AA', '3DA0XY', 'E51AA', 'KH2AB']) {
      const cc = callsignCountry(cs)?.countryCode;
      expect(cc).toBeDefined();
      expect(covered.has(cc!)).toBe(true);
    }
  });
});

describe('isNearTwin', () => {
  it('matches 1- and 2-char substitutions at non-adjacent positions', () => {
    expect(isNearTwin('PY2ABC', 'PY2ABD')).toBe(true);   // 1 substitution
    expect(isNearTwin('PY2ABC', 'PY2XBD')).toBe(true);   // 2, positions 3 and 5 (non-adjacent)
  });

  it('rejects adjacent double substitutions, distance > 2, length changes, identity', () => {
    expect(isNearTwin('PY2ABC', 'PY2AXY')).toBe(false);  // 2 adjacent
    expect(isNearTwin('PY2ABC', 'PXQAYC')).toBe(false);  // 3 diffs
    expect(isNearTwin('PY2ABC', 'PY2AB')).toBe(false);   // length differs
    expect(isNearTwin('PY2ABC', 'PY2ABC')).toBe(false);  // identical
  });
});

describe('mergeContacts with gate', () => {
  it('admits clean, geo-plausible new callsigns immediately', () => {
    const { contacts, stats } = run([[msg('CQ PU7FTW HI22')]]);
    expect(contacts.has('PU7FTW')).toBe(true);
    expect(stats[0].newContacts).toBe(1);
    expect(stats[0].held).toBe(0);
  });

  it('quarantines a new callsign arriving via OSD decode', () => {
    const { contacts, stats } = run([[msg('CQ K1ABC FN42', 0)]]);
    expect(contacts.has('K1ABC')).toBe(false);
    expect(stats[0].held).toBe(1);
  });

  it('quarantines a new callsign with a geo-implausible grid', () => {
    // clean decode, but a "Norwegian" gridding in Korea
    const { contacts, stats } = run([[msg('CQ LA2XJJ HL53')]]);
    expect(contacts.has('LA2XJJ')).toBe(false);
    expect(stats[0].held).toBe(1);
  });

  it('releases a held callsign on a later clean sighting and replays history', () => {
    const { contacts, stats } = run([
      [msg('CQ K1ABC FN42', 0)],   // OSD → held
      [msg('CQ K1ABC FN42')],      // clean → released
    ]);
    const c = contacts.get('K1ABC')!;
    expect(c).toBeDefined();
    expect(stats[1].released).toBe(1);
    expect(stats[1].newContacts).toBe(1);
    // both the buffered and the releasing message are in the history
    expect(c.msgs.length).toBe(2);
    expect(c.firstSeen.getTime()).toBe(W(0).getTime()); // replay keeps original window time
    expect(c.grid).toBe('FN42');
  });

  it('releases after persistent sightings across enough windows', () => {
    const windows = Array.from({ length: RELEASE_SIGHTING_WINDOWS }, () => [msg('CQ K1ABC FN42', 0)]);
    const { contacts } = run(windows);
    expect(contacts.has('K1ABC')).toBe(true);
    expect(contacts.get('K1ABC')!.msgs.length).toBe(RELEASE_SIGHTING_WINDOWS);
  });

  it('expires an uncorroborated callsign after the quarantine period', () => {
    const windows: MergeMsgIn[][] = [[msg('CQ K1ABC FN42', 0)]];
    for (let i = 0; i < QUARANTINE_WINDOWS; i++) windows.push([msg('CQ PY2AB GG66')]); // unrelated traffic
    const { contacts, stats, gate } = run(windows);
    expect(contacts.has('K1ABC')).toBe(false);
    expect(gate.isHeld('K1ABC')).toBe(false);
    expect(stats.reduce((s, x) => s + x.expired, 0)).toBe(1);
  });

  it('requires a clean decode to release a near-twin of an existing contact', () => {
    // PY2ABC is established; PY2ABD then repeats via OSD — repetition alone
    // must NOT release it (ghosts of a repeating station repeat too).
    const windows: MergeMsgIn[][] = [[msg('CQ PY2ABC GG66')]];
    for (let i = 0; i < RELEASE_SIGHTING_WINDOWS + 1; i++) windows.push([msg('CQ PY2ABD GG66', 0)]);
    const { contacts } = run(windows);
    expect(contacts.has('PY2ABC')).toBe(true);
    expect(contacts.has('PY2ABD')).toBe(false);
    // ...but a clean decode does release it
    windows.push([msg('CQ PY2ABD GG66')]);
    expect(run(windows).contacts.has('PY2ABD')).toBe(true);
  });

  it('never gates established contacts, even on OSD decodes', () => {
    const { contacts } = run([
      [msg('CQ PU7FTW HI22')],          // established cleanly
      [msg('CQ PU7FTW HI22', 1)],       // OSD sighting still lands
    ]);
    expect(contacts.get('PU7FTW')!.msgs.length).toBe(2);
  });

  it('never updates position from a geo-implausible grid, even for established contacts', () => {
    const { contacts, stats } = run([
      [msg('CQ PU7FTW HI22')],
      [msg('CQ PU7FTW HL53')],          // "Brazil" suddenly gridding in Korea
    ]);
    const c = contacts.get('PU7FTW')!;
    expect(c.grid).toBe('HI22');
    expect(c.grids).toEqual(['HI22']);
    expect(stats[1].gridRejected).toBe(1);
  });

  it('does not advance the cycle when an older window is revisited by late partials', () => {
    const gate = new DecodeGate();
    let contacts = new Map();
    ({ contacts } = mergeContacts(contacts, W(0), [msg('CQ K1ABC FN42', 0)], 0, gate)); // held, cycle 1
    // Windows interleave: W1 begins, then W0's late partials arrive, then W1 again…
    const seq = [W(1), W(0), W(1), W(0), W(1)];
    for (const w of seq) ({ contacts } = mergeContacts(contacts, w, [msg('CQ PY2AB GG66')], 0, gate));
    // Only 2 distinct windows so far — nowhere near the 6-cycle expiry.
    expect(gate.isHeld('K1ABC')).toBe(true);
  });

  it('does not double-count messages when partials stream the same window twice', () => {
    const gate = new DecodeGate();
    let contacts = new Map();
    ({ contacts } = mergeContacts(contacts, W(0), [msg('CQ PU7FTW HI22')], 0, gate));
    ({ contacts } = mergeContacts(contacts, W(0), [msg('K1AA PU7FTW +05')], 0, gate));
    expect(contacts.get('PU7FTW')!.msgs.length).toBe(2);
    expect(gate.beginWindow(W(0))).toEqual([]); // same window — no cycle advance
  });

  it('exempts compound/portable callsigns from the geo check', () => {
    // A US op portable in Japan: grid PM95 is implausible for "US" but the
    // compound form is exactly how that's legally signed.
    const { contacts } = run([[msg('CQ JA1/K1ABC PM95')]]);
    expect(contacts.has('JA1/K1ABC')).toBe(true);
  });
});
