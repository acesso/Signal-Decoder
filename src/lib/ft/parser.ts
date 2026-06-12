import type { FTMode } from './decoder';

export type MsgType = 'cq' | 'answer' | 'report' | 'r_report' | 'rrr' | 'rr73' | 'tx73' | 'other';

export interface ParsedFTMsg {
  type: MsgType;
  caller: string;   // the transmitting station (second callsign in standard messages)
  callee?: string;  // the addressed station (first callsign)
  grid?: string;    // Maidenhead grid — always belongs to the caller
  report?: number;  // signal report in dB
  raw: string;
  clean: boolean;   // every word classified as a known FT token — safe to track
}

const CS = '[A-Z0-9]{1,3}[0-9][A-Z]{1,4}(?:/[A-Z0-9]+)?';
const CS_EXACT = new RegExp(`^${CS}$`);
// "RR73" is lexically a valid Maidenhead square but is reserved as a QSO
// sign-off message and must never be read as a locator (same as WSJT-X)
const GRID_EXACT = /^(?!RR73)[A-R]{2}[0-9]{2}$/;
// Signal report: optional R (roger) + signed dB value
const RPT_EXACT = /^(R?)([+-][0-9]{1,2})$/;

// "<...>" hashed-callsign placeholders stand for a callsign that didn't fit the
// payload — a legitimate token, but not a usable callsign
const isPlaceholder = (w: string) => w.includes('<') || w.includes('>');
const isCallsignish = (w: string | undefined): boolean =>
  !!w && (CS_EXACT.test(w) || isPlaceholder(w));

// "<...>" placeholders and the literal "CQ" are not callsigns
export function isValidCallsign(cs: string | undefined): cs is string {
  if (!cs) return false;
  if (cs === 'CQ' || cs.includes('<') || cs.includes('>')) return false;
  return CS_EXACT.test(cs);
}

// Every FT message is a handful of words, each one of: a callsign (or <...>
// placeholder), a Maidenhead grid, a signal report (R±nn / ±nn), or a short
// sign-off (73 / RRR / RR73). Classify word-by-word instead of whole-message
// regexes so partially-captured messages still yield their usable parts —
// e.g. "<...> PU7FTW HI72" must still record PU7FTW's locator.
export function parseFTMsg(raw: string): ParsedFTMsg {
  const words = raw.trim().toUpperCase().split(/\s+/).filter(Boolean);

  // CQ form: CQ [DIR] CALLER [GRID]
  if (words[0] === 'CQ') {
    let i = 1;
    // Directed-CQ tag (DX, NA, POTA, …) — letters only, not a callsign or grid
    if (words[i] && /^[A-Z]{1,4}$/.test(words[i]) && !CS_EXACT.test(words[i]) && !GRID_EXACT.test(words[i])) i++;
    const caller = words[i] ?? raw;
    const grid   = words[i + 1] && GRID_EXACT.test(words[i + 1]) ? words[i + 1] : undefined;
    const clean  = words.length <= i + 2 && isCallsignish(caller) &&
                   (words[i + 1] === undefined || grid !== undefined);
    return { type: 'cq', caller, grid, raw, clean };
  }

  // Partial-capture fragment "CALLER GRID" (e.g. a CQ with the CQ word lost,
  // or a 3-word message missing its addressee): the locator follows its owner,
  // so the location info is still usable
  if (words.length === 2 && isCallsignish(words[0]) && GRID_EXACT.test(words[1])) {
    return { type: 'answer', caller: words[0], grid: words[1], raw, clean: isValidCallsign(words[0]) };
  }

  // Standard form: CALLEE CALLER PAYLOAD — the SECOND callsign is the
  // transmitting station; any grid/report in the payload is theirs
  const [callee, caller, payload] = words;
  const clean = words.length === 3 && isCallsignish(callee) && isCallsignish(caller) &&
                (isValidCallsign(callee) || isValidCallsign(caller));
  const base = { caller: caller ?? words[0] ?? raw, callee, raw };

  if (payload !== undefined) {
    let m: RegExpMatchArray | null;
    if (GRID_EXACT.test(payload))       return { type: 'answer',  ...base, grid: payload, clean };
    if ((m = payload.match(RPT_EXACT))) return { type: m[1] ? 'r_report' : 'report', ...base, report: parseInt(m[2]), clean };
    if (payload === 'RR73')             return { type: 'rr73', ...base, clean };
    if (payload === 'RRR')              return { type: 'rrr',  ...base, clean };
    if (payload === '73')               return { type: 'tx73', ...base, clean };
  }
  return { type: 'other', ...base, clean: false };
}

export function gridToLatLon(grid: string): [number, number] | null {
  if (grid.length < 4) return null;
  const g  = grid.toUpperCase();
  const A  = 'A'.charCodeAt(0);
  const c0 = g.charCodeAt(0) - A;
  const c1 = g.charCodeAt(1) - A;
  const n0 = parseInt(g[2]);
  const n1 = parseInt(g[3]);
  if (c0 < 0 || c0 > 17 || c1 < 0 || c1 > 17 || isNaN(n0) || isNaN(n1)) return null;
  return [c1 * 10 - 90 + n1 + 0.5, c0 * 20 - 180 + n0 * 2 + 1];
}

// Great-circle distance between two [lat, lon] points
export function haversineKm(a: [number, number], b: [number, number]): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b[0] - a[0]);
  const dLon = toRad(b[1] - a[1]);
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

export const CONTACT_PALETTE = [
  '#79c0ff', '#ffa657', '#7ee787', '#ff7b72', '#d2a8ff',
  '#e3b341', '#39d353', '#58a6ff', '#bc8cff', '#ff6e64',
  '#f0883e', '#56d364', '#a5d6ff', '#ffab70', '#cae8ff',
];

export interface ContactMsg {
  windowStart: Date;
  raw: string;
  parsed: ParsedFTMsg;
  freq: number;
  snr: number;
  role: 'tx' | 'rx'; // tx = this station was transmitting; rx = this station was addressed
}

export interface Contact {
  callsign: string;
  grid?: string;             // most recently reported locator
  grids: string[];           // every locator seen, in order of first appearance
  latLon?: [number, number]; // position of the most recent locator
  color: string;
  msgs: ContactMsg[];
  peers: Set<string>;
  firstSeen: Date;
  lastSeen: Date;
}

export function mergeContacts(
  existing: Map<string, Contact>,
  windowStart: Date,
  messages: Array<{ msg: string; freq: number; snr: number }>,
  colorOffset: number,
): Map<string, Contact> {
  const contacts = new Map(existing);

  const getOrCreate = (callsign: string): Contact => {
    if (!contacts.has(callsign)) {
      const idx = (contacts.size + colorOffset) % CONTACT_PALETTE.length;
      contacts.set(callsign, {
        callsign,
        grids: [],
        color: CONTACT_PALETTE[idx],
        msgs: [],
        peers: new Set(),
        firstSeen: windowStart,
        lastSeen: windowStart,
      });
    }
    return contacts.get(callsign)!;
  };

  for (const { msg: raw, freq, snr } of messages) {
    const parsed = parseFTMsg(raw);
    // Garbled decodes (any unclassifiable word) are not tracked. Partial
    // captures with <...> placeholders ARE clean — their valid side is used.
    if (!parsed.clean) continue;

    const callerValid = isValidCallsign(parsed.caller);
    const calleeValid = isValidCallsign(parsed.callee);
    if (!callerValid && !calleeValid) continue;

    if (callerValid) {
      const caller = getOrCreate(parsed.caller);
      // Record this transmission for the sender
      caller.msgs.push({ windowStart, raw, parsed, freq, snr, role: 'tx' });
      caller.lastSeen = windowStart;

      // The grid always belongs to the transmitting station. A station can
      // legitimately report several locators (portable/rover) — keep them all,
      // with `grid`/`latLon` tracking the most recent one
      if (parsed.grid) {
        if (!caller.grids.includes(parsed.grid)) caller.grids.push(parsed.grid);
        if (caller.grid !== parsed.grid) {
          caller.grid   = parsed.grid;
          caller.latLon = gridToLatLon(parsed.grid) ?? undefined;
        }
      }
      if (calleeValid) caller.peers.add(parsed.callee!);
    }

    if (calleeValid) {
      const callee = getOrCreate(parsed.callee!);
      if (callerValid) callee.peers.add(parsed.caller);
      // Record this message in the callee's history too — they participated as the addressee
      callee.msgs.push({ windowStart, raw, parsed, freq, snr, role: 'rx' });
      callee.lastSeen = windowStart;
    }
  }

  return contacts;
}

export const MSG_TYPE_LABEL: Record<MsgType, string> = {
  cq:       'CQ',
  answer:   'ANS',
  report:   'RPT',
  r_report: 'R+RPT',
  rrr:      'RRR',
  rr73:     'RR73',
  tx73:     '73',
  other:    '?',
};

// One fixed color per message type so classifier tags read the same in every log
export const MSG_TYPE_COLOR: Record<MsgType, string> = {
  cq:       '#2ea043', // green — calling
  answer:   '#79c0ff', // blue — grid answer
  report:   '#e3b341', // yellow — signal report
  r_report: '#f0883e', // orange — roger + report
  rrr:      '#d2a8ff', // lilac — roger roger
  rr73:     '#bc8cff', // purple — rogers + 73
  tx73:     '#ff7b72', // red — sign-off
  other:    '#8b949e', // grey — unclassified
};

// ── ADIF export ───────────────────────────────────────────────────────────────

function adifDate(d: Date): string {
  return d.getUTCFullYear().toString() +
    String(d.getUTCMonth() + 1).padStart(2, '0') +
    String(d.getUTCDate()).padStart(2, '0');
}
function adifTime(d: Date): string {
  return String(d.getUTCHours()).padStart(2, '0') +
    String(d.getUTCMinutes()).padStart(2, '0') +
    String(d.getUTCSeconds()).padStart(2, '0');
}
const af = (name: string, value: string) => `<${name}:${value.length}>${value}`;

export function generateADIF(contacts: Map<string, Contact>, ftMode: FTMode): string {
  const now       = new Date();
  const timestamp = `${adifDate(now)} ${adifTime(now)}`; // 15 chars

  const lines: string[] = [
    af('ADIF_VER', '3.0'),
    af('PROGRAMID', 'rtty-decoder'),
    af('CREATED_TIMESTAMP', timestamp),
    '<EOH>',
    '',
  ];

  for (const c of contacts.values()) {
    const txMsgs = c.msgs.filter(m => m.role === 'tx');
    const rxMsgs = c.msgs.filter(m => m.role === 'rx');
    const bestSnr = txMsgs.length > 0
      ? Math.max(...txMsgs.map(m => m.snr))
      : undefined;

    const fields: [string, string][] = [
      ['CALL',      c.callsign],
      ['MODE',      ftMode],
      ['QSO_DATE',  adifDate(c.firstSeen)],
      ['TIME_ON',   adifTime(c.firstSeen)],
    ];

    if (c.grid)            fields.push(['GRIDSQUARE', c.grid]);
    if (bestSnr !== undefined) fields.push(['RST_RCVD', String(bestSnr)]);

    const comment = txMsgs.length > 0
      ? `heard direct: ${txMsgs.length} tx; addressed: ${rxMsgs.length} rx`
      : `callsign seen as addressee only; ${rxMsgs.length} msgs`;
    fields.push(['COMMENT', comment]);

    lines.push(fields.map(([k, v]) => af(k, v)).join(' ') + ' <EOR>');
  }

  return lines.join('\n') + '\n';
}
