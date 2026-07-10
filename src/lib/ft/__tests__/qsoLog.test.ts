import { qsoLogRecords, qsoLogUpsert, qsoLogClear } from '../qsoLog';
import type { QSORecord } from '../parser';

const rec = (over: Partial<QSORecord> = {}): QSORecord => ({
  callsign: 'W9XYZ',
  grid: 'FN42',
  startMs: 1_000_000,
  endMs: 1_060_000,
  freqHz: 21_075_500,
  rstRcvd: -10,
  rstSent: -5,
  sentCount: 2,
  rcvdCount: 2,
  confirmed: true,
  mode: 'FT8' as QSORecord['mode'],
  ...over,
});

beforeEach(() => qsoLogClear());

describe('qsoLog — persistent QSO store', () => {
  it('stores new records and persists them to localStorage', () => {
    qsoLogUpsert([rec()]);
    expect(qsoLogRecords()).toHaveLength(1);
    const persisted = JSON.parse(localStorage.getItem('ft_qso_log')!);
    expect(persisted).toHaveLength(1);
    expect(persisted[0].callsign).toBe('W9XYZ');
  });

  it('re-capturing the same QSO merges instead of duplicating', () => {
    qsoLogUpsert([rec()]);
    qsoLogUpsert([rec()]);
    expect(qsoLogRecords()).toHaveLength(1);
  });

  it('recognizes the same QSO after its opening message rotated out (later start, overlapping span)', () => {
    qsoLogUpsert([rec()]);
    // Same exchange re-captured with the first message gone: start shifted
    // forward, end extended, one message fewer counted.
    qsoLogUpsert([rec({ startMs: 1_030_000, endMs: 1_090_000, sentCount: 1 })]);
    const all = qsoLogRecords();
    expect(all).toHaveLength(1);
    expect(all[0].startMs).toBe(1_000_000);  // earliest start kept — stable QSO_DATE/TIME_ON
    expect(all[0].endMs).toBe(1_090_000);    // span extended
    expect(all[0].sentCount).toBe(2);        // counts never shrink on re-capture
  });

  it('upgrades a partial handshake to confirmed, never the reverse', () => {
    qsoLogUpsert([rec({ confirmed: false, rstSent: undefined })]);
    qsoLogUpsert([rec({ confirmed: true, rstSent: -5 })]);
    expect(qsoLogRecords()[0].confirmed).toBe(true);
    expect(qsoLogRecords()[0].rstSent).toBe(-5);

    qsoLogUpsert([rec({ confirmed: false })]);
    expect(qsoLogRecords()[0].confirmed).toBe(true);
  });

  it('keeps separate records for distinct QSOs with the same station', () => {
    qsoLogUpsert([rec()]);
    qsoLogUpsert([rec({ startMs: 5_000_000, endMs: 5_060_000 })]);  // hours later — a new QSO
    expect(qsoLogRecords()).toHaveLength(2);
  });

  it('keeps separate records per station', () => {
    qsoLogUpsert([rec(), rec({ callsign: 'PY5EJ' })]);
    expect(qsoLogRecords()).toHaveLength(2);
  });

  it('clear empties the store and localStorage', () => {
    qsoLogUpsert([rec()]);
    qsoLogClear();
    expect(qsoLogRecords()).toHaveLength(0);
    expect(localStorage.getItem('ft_qso_log')).toBeNull();
  });
});
