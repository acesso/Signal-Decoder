// Persistent QSO log — the safe, separate store ADIF export reads from.
//
// Contact records rotate: each contact keeps only its last 60 messages, and
// whole contacts are evicted once MAX_CONTACTS is hit. A busy station's CQ
// loop alone pushes a completed exchange out of its 60-message ring within
// the hour, so deriving ADIF from live contact messages at export time
// silently loses QSOs. Instead, FTDecoder extracts QSORecords the moment an
// exchange is decoded and upserts them here; the log survives message
// rotation, contact eviction, and page reloads (localStorage). Only the
// contacts panel's explicit Clear empties it.
import { createSignal } from 'solid-js';
import type { QSORecord } from './parser';

const LS_KEY = 'ft_qso_log';
const MAX_RECORDS = 5000;

function load(): QSORecord[] {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (r): r is QSORecord =>
        !!r && typeof r === 'object' &&
        typeof (r as QSORecord).callsign === 'string' &&
        typeof (r as QSORecord).startMs === 'number' &&
        typeof (r as QSORecord).confirmed === 'boolean',
    );
  } catch {
    return [];
  }
}

function save(records: QSORecord[]): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(records));
  } catch {
    // quota exceeded / storage unavailable — in-memory log still serves the session
  }
}

const [records, setRecords] = createSignal<QSORecord[]>(load());

/** Reactive accessor over all logged QSOs. */
export const qsoLogRecords = records;

// Same station, same mode, overlapping exchange time span = the same QSO
// seen again — possibly with its earliest messages already rotated out, or
// with new messages appended since the last capture.
function sameQSO(a: QSORecord, b: QSORecord): boolean {
  return a.callsign === b.callsign && a.mode === b.mode &&
    a.startMs <= b.endMs && b.startMs <= a.endMs;
}

// Re-captures only ever add information: keep the earliest start (stable
// QSO_DATE/TIME_ON even after the opening message rotates out of the
// contact), extend the end, and keep the best-known value of everything
// else. A partial handshake upgrades to confirmed, never the reverse.
function mergeQSO(ex: QSORecord, rec: QSORecord): QSORecord {
  return {
    ...ex,
    startMs:   Math.min(ex.startMs, rec.startMs),
    endMs:     Math.max(ex.endMs, rec.endMs),
    freqHz:    ex.freqHz > 0 ? ex.freqHz : rec.freqHz,
    audioHz:   ex.audioHz ?? rec.audioHz,
    grid:      rec.grid ?? ex.grid,
    rstRcvd:   Math.max(ex.rstRcvd, rec.rstRcvd),
    rstSent:   rec.rstSent !== undefined && (ex.rstSent === undefined || rec.rstSent > ex.rstSent)
      ? rec.rstSent : ex.rstSent,
    sentCount: Math.max(ex.sentCount, rec.sentCount),
    rcvdCount: Math.max(ex.rcvdCount, rec.rcvdCount),
    confirmed: ex.confirmed || rec.confirmed,
    comment:   rec.comment ?? ex.comment,
  };
}

function recEqual(a: QSORecord, b: QSORecord): boolean {
  return a.startMs === b.startMs && a.endMs === b.endMs && a.freqHz === b.freqHz &&
    a.audioHz === b.audioHz &&
    a.grid === b.grid && a.rstRcvd === b.rstRcvd && a.rstSent === b.rstSent &&
    a.sentCount === b.sentCount && a.rcvdCount === b.rcvdCount &&
    a.confirmed === b.confirmed && a.comment === b.comment;
}

export function qsoLogUpsert(incoming: QSORecord[]): void {
  if (incoming.length === 0) return;
  let next: QSORecord[] | null = null;
  for (const rec of incoming) {
    const list = next ?? records();
    const i = list.findIndex(ex => sameQSO(ex, rec));
    if (i >= 0) {
      const merged = mergeQSO(list[i], rec);
      if (!recEqual(merged, list[i])) {
        next = next ?? [...records()];
        next[i] = merged;
      }
    } else {
      next = next ?? [...records()];
      next.push(rec);
    }
  }
  if (next) {
    if (next.length > MAX_RECORDS) next.splice(0, next.length - MAX_RECORDS);
    setRecords(next);
    save(next);
  }
}

export function qsoLogClear(): void {
  setRecords([]);
  try {
    localStorage.removeItem(LS_KEY);
  } catch {
    // storage unavailable — in-memory log already cleared
  }
}
