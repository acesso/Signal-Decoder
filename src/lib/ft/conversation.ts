// One FT8/FT4 conversation seen from my station: what the other station sent
// me and what I last sent them. The auto-reply (components/FTTransmitPanel.tsx)
// decides its next message from these; currentQso() turns them into "who am I
// working and how far along are we" for displays (the bridge's LCD QSO view).

import { parseFTMsg, type Contact, type ContactMsg, type MsgType } from './parser';
import type { SentEntry } from './useFTTransmit';

/** Their messages addressed to me (myCallUp in capitals). */
export function messagesToMe(contact: Contact, myCallUp: string): ContactMsg[] {
  return contact.msgs.filter((m) => m.role === 'tx' && m.parsed.callee?.toUpperCase() === myCallUp);
}

/** The latest message by its window — the quarantine gate can replay released
 *  messages out of push order, so the last pushed is not always the newest. */
export function latestMessage(msgs: readonly ContactMsg[]): ContactMsg | null {
  return msgs.length ? msgs.reduce((latest, m) => (m.windowStart > latest.windowStart ? m : latest), msgs[0]) : null;
}

/** What I sent them, newest first. Read from the TX sent log (newest first),
 *  not from decodes: my own transmissions are never decoded back. */
export function sentTo(callUp: string, sent: readonly SentEntry[]): SentEntry[] {
  return sent.filter((e) => parseFTMsg(e.message).callee?.toUpperCase() === callUp);
}

/** How far a QSO has come: 0 CQ, 1 grid answer, 2 report, 3 R+report, 4 RR73/RRR, 5 73. */
export const QSO_STEPS = ['CQ', 'GRID', 'RPT', 'R-RPT', 'RR73', '73'] as const;

export function qsoStepIndex(type: MsgType | null): number {
  switch (type) {
    case 'cq': return 0;
    case 'answer': return 1;
    case 'report': return 2;
    case 'r_report': return 3;
    case 'rr73': case 'rrr': return 4;
    case 'tx73': return 5;
    default: return -1;
  }
}

export interface CurrentQso {
  /** The other station, in capitals. */
  call: string;
  grid?: string;
  /** The type of the last message I sent them, and of their last one to me. */
  lastSent: MsgType | null;
  lastRcvd: MsgType | null;
  /** The furthest step either side has reached (QSO_STEPS index). */
  step: number;
  /** The report in my last report to them, and in theirs to me. */
  rstSent?: number;
  rstRcvd?: number;
  /** Their best SNR as I heard them, in messages to me. */
  snr?: number;
  /** The newest message of the exchange (ms epoch). */
  lastMs: number;
  /** 73 sent or received, or RR73 sent: nothing more is needed from me. */
  done: boolean;
}

export interface QsoActivity {
  /** The QSO in progress (or just finished), or null. */
  qso: CurrentQso | null;
  /** I'm calling CQ: my newest transmission is a CQ, newer than any exchange. */
  callingCq: boolean;
}

/** A conversation older than this is no longer "current". */
export const QSO_STALE_MS = 3 * 60_000;

function reportOf(msg: string | undefined): number | undefined {
  return msg === undefined ? undefined : parseFTMsg(msg).report;
}

/**
 * My exchange with one station (call in capitals): their messages to me, mine
 * to them. null when neither side has sent the other anything.
 */
export function exchangeWith(call: string, myCallUp: string, contact: Contact | undefined, sent: readonly SentEntry[]): CurrentQso | null {
  const toMe = contact ? messagesToMe(contact, myCallUp) : [];
  const theirs = latestMessage(toMe);
  const mineAll = sentTo(call, sent);
  const mine = mineAll[0] ?? null;
  if (!theirs && !mine) return null;
  const lastSent = mine ? parseFTMsg(mine.message).type : null;
  const lastRcvd = theirs?.parsed.type ?? null;
  const myReport = mineAll.find((e) => reportOf(e.message) !== undefined);
  const theirReport = [...toMe].sort((a, b) => b.windowStart.getTime() - a.windowStart.getTime()).find((m) => m.parsed.report !== undefined);
  return {
    call,
    grid: contact?.grid,
    lastSent,
    lastRcvd,
    step: Math.max(qsoStepIndex(lastSent), qsoStepIndex(lastRcvd), 0),
    rstSent: reportOf(myReport?.message),
    rstRcvd: theirReport?.parsed.report,
    snr: toMe.length ? toMe.reduce((s, m) => Math.max(s, m.snr), -99) : undefined,
    lastMs: Math.max(theirs?.windowStart.getTime() ?? 0, mine?.windowStart.getTime() ?? 0),
    done: lastSent === 'rr73' || lastSent === 'tx73' || lastRcvd === 'tx73',
  };
}

/**
 * The QSO in progress: the station whose exchange with me (their messages to
 * me, my messages to them) has the newest message, if that is within staleMs.
 */
export function currentQso(
  myCall: string,
  contacts: ReadonlyMap<string, Contact>,
  sent: readonly SentEntry[],
  nowMs: number,
  staleMs = QSO_STALE_MS,
): QsoActivity {
  const myCallUp = myCall.toUpperCase();
  const since = nowMs - staleMs;

  // Everyone in an exchange with me lately: those who called me, those I called.
  const calls = new Set<string>();
  for (const e of sent) {
    if (e.windowStart.getTime() < since) break; // newest first
    const callee = parseFTMsg(e.message).callee?.toUpperCase();
    if (callee) calls.add(callee);
  }
  for (const c of contacts.values()) {
    const m = latestMessage(messagesToMe(c, myCallUp));
    if (m && m.windowStart.getTime() >= since) calls.add(c.callsign.toUpperCase());
  }

  let best: CurrentQso | null = null;
  for (const call of calls) {
    if (call === myCallUp) continue;
    const contact = [...contacts.values()].find((c) => c.callsign.toUpperCase() === call);
    const q = exchangeWith(call, myCallUp, contact, sent);
    if (q && q.lastMs >= since && (!best || q.lastMs > best.lastMs)) best = q;
  }

  const newestSent = sent[0];
  const callingCq = !!newestSent && newestSent.windowStart.getTime() >= since &&
    parseFTMsg(newestSent.message).type === 'cq' && newestSent.windowStart.getTime() >= (best?.lastMs ?? 0);
  return { qso: callingCq && best?.done ? null : best, callingCq };
}
