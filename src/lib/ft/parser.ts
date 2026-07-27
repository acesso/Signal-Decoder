import type { FTMode } from './decoder';
import { isExactKnownPrefix, callsignCountry } from './prefixes';
import { latLonPlausibleForCountry } from './geo';
import { DecodeGate, isNearTwin, type HoldReason, type PendingMsg } from './gate';

export type MsgType = 'cq' | 'answer' | 'report' | 'r_report' | 'rrr' | 'rr73' | 'tx73' | 'other';

export interface ParsedFTMsg {
  type: MsgType;
  caller: string;   // the transmitting station (second callsign in standard messages)
  callee?: string;  // the addressed station (first callsign)
  grid?: string;    // Maidenhead grid — always belongs to the caller
  report?: number;  // signal report in dB
  /** Directed-CQ tag (DX, POTA, SOTA, IOTA, NA, TEST, …) or a 3-digit QSY
   *  frequency ("CQ 573 K1ABC" = answer 573 Hz above the band base). */
  cqTag?: string;
  raw: string;
  clean: boolean;   // every word classified as a known FT token — safe to track
}

// ── Callsign shape ───────────────────────────────────────────────────────────
// FT8/FT4 pack callsigns one of two ways (see "The FT4 and FT8 Communication
// Protocols", Taylor/Franke/Somerville, QEX): a "standard" callsign fits a
// fixed 28-bit field — a 1-2 char prefix (at least one letter), a digit, and
// a suffix of up to 3 letters. Anything that doesn't fit (compound calls like
// PJ4/K1ABC, special-event calls like PA2EVENT or YW18FIFA with a longer or
// irregular suffix) is packed instead as a 58-bit "nonstandard" field. Both
// are real, valid callsigns — the encoding choice is a wire-format detail,
// not a validity signal — so both shapes are accepted here; which one a
// given callsign used is exposed separately via classifyCallsign() for the
// UI to show a "special/compound" indicator, not to reject anything.
// Each shape matcher below returns the MATCHED PREFIX substring (or null) —
// not just a boolean — so isValidCallsign can check that exact substring
// against the ITU allocation table (prefixes.ts), rather than independently
// re-scanning 1/2/3 characters and risking a false match against a SHORTER
// real prefix that happens to be a substring of a longer, non-allocated one
// (e.g. "ZZ9" isn't real, but its first 2 chars "ZZ" coincidentally are —
// checking the exact matched-prefix length avoids that false positive).

// Standard/28-bit shape: 1-2 char prefix (≥1 letter) + 1 digit + ≤3 letter
// suffix. See "The FT4 and FT8 Communication Protocols" (Taylor/Franke/
// Somerville, QEX) for the packing this mirrors.
const CS_STANDARD = /^([A-Z0-9]{1,2})[0-9][A-Z]{1,3}$/;
function standardPrefix(w: string): string | null {
  const m = w.match(CS_STANDARD);
  if (!m || !/[A-Z]/.test(m[1])) return null;
  // Some real ITU allocations are a LETTER+DIGIT pair (D2 Angola, V2 Antigua,
  // A2 Botswana, T7 San Marino, ...). When the whole callsign is only 4 chars
  // (e.g. "D2UY"), the regex's own required digit and the prefix's digit are
  // the same character, and JS regex backtracking always resolves the greedy
  // {1,2} group down to the 1-char reading ("D") — there's no textual way to
  // tell "D2UY" apart from a hypothetical 1-char-prefix "D2UY" up front. Retry
  // with the 2-char letter+digit reading and prefer it when IT is the one
  // that's actually allocated (the 1-char reading never is, for these).
  if (m[1].length === 1 && w.length >= 2 && /[0-9]/.test(w[1]) && isExactKnownPrefix(w.slice(0, 2))) {
    return w.slice(0, 2);
  }
  return m[1];
}
// Nonstandard/58-bit shape (no slash): everything real that doesn't fit the
// 28-bit standard field above — a 3-character prefix (many real ITU
// allocations are 3 chars, e.g. 3DA Eswatini — an ordinary callsign, just
// outside the 28-bit prefix-length limit), OR a longer/irregular suffix
// (special-event calls like YW18FIFA, PA2EVENT).
const CS_NONSTANDARD_3CHAR_PREFIX = /^([A-Z0-9]{3})[0-9][A-Z0-9]{1,3}$/;
const CS_NONSTANDARD_LONG_SUFFIX  = /^([A-Z0-9]{1,2})[0-9][A-Z0-9]{4,7}$/;
function nonstandardPrefix(w: string): string | null {
  const m3 = w.match(CS_NONSTANDARD_3CHAR_PREFIX);
  const mLong = w.match(CS_NONSTANDARD_LONG_SUFFIX);
  if (m3 && /[A-Z]/.test(m3[1])) {
    // Same digit-boundary ambiguity as standardPrefix's D2/A2/etc case, one
    // level up: some real 2-char allocations (9A Croatia, S5 Slovenia, ...)
    // followed by a region digit and a longer suffix (9A60CBM) parse just as
    // validly as a 3-char prefix (9A6) + digit + short suffix. Prefer the
    // 2-char reading when it's the one that's actually allocated — the 3-char
    // reading never is, for these.
    if (mLong && mLong[1].length === 2 && /[A-Z]/.test(mLong[1]) && isExactKnownPrefix(mLong[1])) {
      return mLong[1];
    }
    return m3[1];
  }
  return mLong && /[A-Z]/.test(mLong[1]) ? mLong[1] : null;
}

function matchedPrefix(w: string): string | null {
  return standardPrefix(w) ?? nonstandardPrefix(w);
}

// Portable/mobile designators that may trail a call as a final slash part.
const PORTABLE_SUFFIXES = new Set(['P', 'R', 'M', 'MM', 'AM', 'QRP']);

// Compound/portable form (HOME/PORTABLE, e.g. PJ4/K1ABC or K1ABC/PJ4) — valid
// if EITHER side alone is a standard- or nonstandard-shape callsign; the
// other side is often just a bare prefix or region tag, not a full callsign.
// Doubly-compound PREFIX/CALL/SUFFIX (e.g. 9A/S55X/P, a Slovenian station
// portable in Croatia) is accepted when the trailing part is a recognized
// portable/mobile designator or a single region digit.
// Returns the matched prefix from whichever side matched, preferring the
// side most likely to be the operator's actual identity (the non-prefix-only
// side), which for ITU-prefix purposes is whichever side matched at all.
function compoundPrefix(w: string): string | null {
  const parts = w.split('/');
  if (parts.length === 3) {
    const last = parts[2];
    if (!PORTABLE_SUFFIXES.has(last) && !/^[0-9]$/.test(last)) return null;
    parts.pop();
  }
  if (parts.length !== 2) return null;
  for (const p of parts) {
    const prefix = matchedPrefix(p);
    if (prefix) return prefix;
  }
  return null;
}

function isRecognizedShape(w: string): boolean {
  return matchedPrefix(w) !== null || compoundPrefix(w) !== null;
}

// The operator's actual callsign inside a compound/portable form — the slash
// part that matches a callsign shape (9A/S55X/P → S55X, YS3/PY8WW → PY8WW,
// K1ABC/4 → K1ABC). Prefix-only parts (9A, YS3, PJ4) and portable
// designators (/P, /QRP, /4) have no letter suffix after the digit, so they
// never match a callsign shape; if both sides somehow match, the longer one
// wins. Used for external lookups (QRZ), where only the base call resolves.
export function baseCallsign(cs: string): string {
  const parts = cs.split('/').filter(Boolean);
  if (parts.length <= 1) return cs;
  const last = parts[parts.length - 1];
  if (PORTABLE_SUFFIXES.has(last) || /^[0-9]$/.test(last)) parts.pop();
  if (parts.length === 1) return parts[0];
  const shaped = parts.filter((p) => matchedPrefix(p) !== null);
  const pool = shaped.length > 0 ? shaped : parts;
  return pool.reduce((a, b) => (b.length > a.length ? b : a));
}

// "RR73" is lexically a valid Maidenhead square but is reserved as a QSO
// sign-off message and must never be read as a locator (same as WSJT-X)
const GRID_EXACT = /^(?!RR73)[A-R]{2}[0-9]{2}$/;
// Signal report: optional R (roger) + signed dB value
const RPT_EXACT = /^(R?)([+-][0-9]{1,2})$/;

// "<...>" hashed-callsign placeholders stand for a callsign that didn't fit the
// payload — a legitimate token, but not a usable callsign
const isPlaceholder = (w: string) => w.includes('<') || w.includes('>');
const isCallsignish = (w: string | undefined): boolean =>
  !!w && (isRecognizedShape(w) || isPlaceholder(w));

// "<...>" placeholders and the literal "CQ" are not callsigns. Beyond shape,
// also requires the EXACT matched prefix to be a real ITU allocation (see
// prefixes.ts) — this is what catches shape-plausible garbage (a random
// decode that happens to look like a callsign but whose "country" was never
// assigned by any administration). Checking the exact matched-prefix
// substring (not an independent 1/2/3-char rescan) avoids false-accepting a
// non-allocated long prefix just because its first 1-2 characters happen to
// coincide with a real, shorter allocation.
export function isValidCallsign(cs: string | undefined): cs is string {
  if (!cs) return false;
  if (cs === 'CQ' || cs.includes('<') || cs.includes('>')) return false;
  const prefix = matchedPrefix(cs) ?? compoundPrefix(cs);
  return prefix !== null && isExactKnownPrefix(prefix);
}

export interface CallsignInfo {
  /** Which FT8/FT4 wire encoding this callsign's shape implies — a protocol
   *  detail, not a validity signal (see the shape-matcher comments above).
   *  'compound' covers portable/DXpedition form (HOME/PORTABLE). */
  kind: 'standard' | 'nonstandard' | 'compound';
  /** Brazilian amateur radio license class (ANATEL Resolução 449/2006),
   *  undefined for non-Brazilian callsigns. Encoded in the prefix pair AND
   *  suffix length, not just the prefix: PU is always Class C (3-letter
   *  suffix); PP/PR/PS/PT/PV/PW/PY/ZV-ZZ are Class A (2-letter suffix) or
   *  B (3-letter suffix). */
  brazilLicenseClass?: 'A' | 'B' | 'C';
}

const BRAZIL_CLASS_C_PREFIX = /^PU[0-9]/;
const BRAZIL_CLASS_AB_PREFIX = /^(?:P[PRSTVWY]|Z[VWXYZ])[0-9]/;

function brazilLicenseClass(cs: string): 'A' | 'B' | 'C' | undefined {
  const base = cs.split('/')[0];
  const suffixLen = base.length - base.search(/[0-9]/) - 1;
  if (BRAZIL_CLASS_C_PREFIX.test(base)) return 'C';
  if (BRAZIL_CLASS_AB_PREFIX.test(base)) return suffixLen <= 2 ? 'A' : 'B';
  return undefined;
}

/** Best-effort classification for UI display (contact card indicators) —
 *  call only after isValidCallsign() has confirmed the callsign is real. */
export function classifyCallsign(cs: string): CallsignInfo {
  if (cs.includes('/')) return { kind: 'compound' };
  const kind = standardPrefix(cs) !== null ? 'standard' : 'nonstandard';
  return { kind, brazilLicenseClass: brazilLicenseClass(cs) };
}

// Parse results memoized by message text. The messages table re-renders on
// every streamed partial and used to re-parse its entire history each time
// (O(n²) per window on busy bands); the cache makes repeat parses O(1).
// Bounded: cleared wholesale when it outgrows its cap — messages repeat
// heavily (CQ cycles), so hit rates stay high even after a reset.
const parseCache = new Map<string, ParsedFTMsg>();
const PARSE_CACHE_MAX = 20_000;

export function parseFTMsgCached(raw: string): ParsedFTMsg {
  let p = parseCache.get(raw);
  if (!p) {
    if (parseCache.size >= PARSE_CACHE_MAX) parseCache.clear();
    p = parseFTMsg(raw);
    parseCache.set(raw, p);
  }
  return p;
}

// Every FT message is a handful of words, each one of: a callsign (or <...>
// placeholder), a Maidenhead grid, a signal report (R±nn / ±nn), or a short
// sign-off (73 / RRR / RR73). Classify word-by-word instead of whole-message
// regexes so partially-captured messages still yield their usable parts —
// e.g. "<...> PU7FTW HI72" must still record PU7FTW's locator.
export function parseFTMsg(raw: string): ParsedFTMsg {
  // Hashed-call messages (protocol types 1/4 with a nonstandard call) show
  // the hashed call in <angle brackets> once the decoder resolves it, e.g.
  // "<YS3/PY8WW> PU7FTW RR73" — treat a bracketed call as the call itself.
  // The unresolved-hash placeholder "<...>" stays as-is (invalid, by design).
  let hadHashedCall = false;
  const words = raw.trim().toUpperCase().split(/\s+/).filter(Boolean).map((w) => {
    if (w.length > 2 && w.startsWith('<') && w.endsWith('>') && w !== '<...>') {
      hadHashedCall = true;
      return w.slice(1, -1);
    }
    return w;
  });

  // CQ form: CQ [DIR] CALLER [GRID]
  if (words[0] === 'CQ') {
    let i = 1;
    let cqTag: string | undefined;
    // Directed-CQ tag: 1-4 letters (DX, NA, POTA, SOTA, IOTA, TEST, …) — a
    // letters-only word can never match a callsign shape, which requires a
    // digit, so only the grid check is needed there — or a 3-digit QSY
    // frequency ("CQ 573 K1ABC FN42"), which the protocol packs as CQ_nnn.
    if (words[i] && ((/^[A-Z]{1,4}$/.test(words[i]) && !GRID_EXACT.test(words[i])) || /^[0-9]{3}$/.test(words[i]))) {
      cqTag = words[i];
      i++;
    }
    const caller = words[i] ?? raw;
    const grid   = words[i + 1] && GRID_EXACT.test(words[i + 1]) ? words[i + 1] : undefined;
    // isValidCallsign (not just isCallsignish) — a CQ's caller populates the
    // map/contacts directly, so it needs the full ITU-prefix check too, not
    // just shape-plausibility.
    const clean  = words.length <= i + 2 && isValidCallsign(caller) &&
                   (words[i + 1] === undefined || grid !== undefined);
    return { type: 'cq', caller, grid, raw, clean, cqTag };
  }

  // Partial-capture fragment "CALLER GRID" (e.g. a CQ with the CQ word lost,
  // or a 3-word message missing its addressee): the locator follows its owner,
  // so the location info is still usable
  if (words.length === 2 && isCallsignish(words[0]) && GRID_EXACT.test(words[1])) {
    return { type: 'answer', caller: words[0], grid: words[1], raw, clean: isValidCallsign(words[0]) };
  }

  // Two-word hashed answer "<THEIR> MINE" (type 4 — carries no grid).
  // Trusted when a bracketed call was present, OR when either callsign's
  // shape REQUIRES the hashed exchange (compound/nonstandard, e.g.
  // "W5C/H PU7FTW" — decoders render the resolved hash without brackets):
  // such exchanges genuinely have no grid to lose, so two words is the
  // complete message. A plain two-word pair of STANDARD calls is more
  // likely a garbled three-word capture and stays rejected (see the
  // fragment tests).
  const hashShape = (w: string) => !isPlaceholder(w) && needsHashedExchange(w);
  if (words.length === 2 && isCallsignish(words[0]) && isCallsignish(words[1]) &&
      (hadHashedCall || hashShape(words[0]) || hashShape(words[1]))) {
    return {
      type: 'answer', caller: words[1], callee: words[0], raw,
      clean: isValidCallsign(words[0]) || isValidCallsign(words[1]),
    };
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
  /** Directed-CQ tags this station has called with (DX, POTA, …), unique. */
  cqTags?: string[];
  firstSeen: Date;
  lastSeen: Date;
}

// Maximum unique callsigns to keep in memory at once.
// On a busy band (20m FT8) you can hear 200+ unique calls/hour — cap prevents
// unbounded growth. Oldest-seen contacts are evicted first when the limit is hit.
// 1200 gives headroom over the validated 1000-contact performance target
// (virtualized lists keep render cost independent of contact count).
const MAX_CONTACTS = 1200;

/** One decoded message as fed into mergeContacts. `osd` is FTMessage.osd:
 *  -1/undefined = clean LDPC decode, >=0 = OSD fallback (low confidence). */
export interface MergeMsgIn {
  msg: string;
  freq: number;
  snr: number;
  osd?: number;
}

/** Per-call admission telemetry, aggregated per window by the UI. */
export interface MergeStats {
  /** new contacts created from a SENDER (caller) callsign */
  newContacts: number;
  /** new callsigns put into quarantine this call */
  held: number;
  /** quarantined callsigns released (admitted) this call */
  released: number;
  /** quarantine entries silently dropped (never corroborated) this call */
  expired: number;
  /** grids rejected as geographically implausible for the callsign's country */
  gridRejected: number;
}

// Is this lat/lon plausible for the country of this callsign's ITU prefix?
// Compound/portable calls (PJ4/K1ABC) are exempt — operating away from the
// home country is their whole point. Unknown prefix/table gaps fail open.
function gridPlausible(callsign: string, latLon: [number, number] | null): boolean {
  if (!latLon || callsign.includes('/')) return true;
  const cc = callsignCountry(callsign)?.countryCode;
  return !cc || latLonPlausibleForCountry(cc, latLon);
}

export function mergeContacts(
  existing: Map<string, Contact>,
  windowStart: Date,
  messages: MergeMsgIn[],
  colorOffset: number,
  gate?: DecodeGate,
): { contacts: Map<string, Contact>; stats: MergeStats } {
  const contacts = new Map(existing);
  const stats: MergeStats = { newContacts: 0, held: 0, released: 0, expired: 0, gridRejected: 0 };
  stats.expired = gate?.beginWindow(windowStart).length ?? 0;

  const getOrCreate = (callsign: string, when: Date): Contact => {
    if (!contacts.has(callsign)) {
      const idx = (contacts.size + colorOffset) % CONTACT_PALETTE.length;
      contacts.set(callsign, {
        callsign,
        grids: [],
        color: CONTACT_PALETTE[idx],
        msgs: [],
        peers: new Set(),
        firstSeen: when,
        lastSeen: when,
      });
    }
    return contacts.get(callsign)!;
  };

  const hasNearTwin = (cs: string): boolean => {
    for (const c of contacts.values()) if (isNearTwin(cs, c.callsign)) return true;
    return false;
  };

  // Gate decision for one side of a message. Returns true when the callsign
  // may be materialized in the contacts map right now; false when it was
  // quarantined (or is still held). `release` receives buffered messages to
  // replay when this sighting frees a held callsign.
  const admitCallsign = (
    cs: string,
    confident: boolean,
    pend: PendingMsg,
    suspicions: HoldReason[],
    release: (pending: PendingMsg[]) => void,
  ): boolean => {
    if (!gate || contacts.has(cs)) return true; // established → always admitted
    if (gate.isHeld(cs)) {
      const pending = gate.sighting(cs, confident, pend);
      if (!pending) return false;
      stats.released++;
      release(pending);
      return true;
    }
    if (suspicions.length === 0) return true;
    const reasons = [...suspicions];
    if (hasNearTwin(cs)) reasons.push('twin');
    gate.hold(cs, reasons, pend);
    stats.held++;
    return false;
  };

  // `onlyFor` restricts processing to that callsign's side — used when
  // replaying a released callsign's buffered messages, whose OTHER side was
  // already handled (or separately quarantined) when the message first arrived.
  const processMessage = (when: Date, { msg: raw, freq, snr, osd }: MergeMsgIn, onlyFor?: string): void => {
    const parsed = parseFTMsg(raw);
    // Garbled decodes (any unclassifiable word) are not tracked. Partial
    // captures with <...> placeholders ARE clean — their valid side is used.
    if (!parsed.clean) return;

    const callerValid = isValidCallsign(parsed.caller);
    const calleeValid = isValidCallsign(parsed.callee);
    if (!callerValid && !calleeValid) return;

    const lowConfidence = (osd ?? -1) >= 0;
    const latLon  = parsed.grid && callerValid ? gridToLatLon(parsed.grid) : null;
    const gridOk  = !callerValid || gridPlausible(parsed.caller, latLon);
    const pend: PendingMsg = { windowStartMs: when.getTime(), msg: raw, freq, snr, osd };
    const suspicions: HoldReason[] = [];
    if (lowConfidence) suspicions.push('osd');
    if (!gridOk) suspicions.push('geo');
    const confident = suspicions.length === 0;

    if (callerValid && (!onlyFor || parsed.caller === onlyFor)) {
      // Replays (onlyFor set) bypass the gate — the callsign was just released
      // and its buffered messages must not re-quarantine it.
      if (onlyFor !== undefined ||
          admitCallsign(parsed.caller, confident, pend, suspicions,
                        pending => { for (const pm of pending) processMessage(new Date(pm.windowStartMs), pm, parsed.caller); })) {
        // after admitCallsign: a release replay may have just created it
        const wasNew = !contacts.has(parsed.caller);
        const caller = getOrCreate(parsed.caller, when);
        if (wasNew) stats.newContacts++;
        caller.msgs.push({ windowStart: when, raw, parsed, freq, snr, role: 'tx' });
        // Keep only the last 60 messages per contact — enough for full QSO history
        if (caller.msgs.length > 60) caller.msgs.splice(0, caller.msgs.length - 60);
        if (when.getTime() > caller.lastSeen.getTime()) caller.lastSeen = when;

        // The grid always belongs to the transmitting station. A station can
        // legitimately report several locators (portable/rover) — keep them all,
        // with `grid`/`latLon` tracking the most recent one. Geographically
        // implausible grids never update the position, even for established
        // contacts — a "Norwegian" gridding in Korea is a false decode, not a trip.
        if (parsed.grid && gridOk) {
          if (!caller.grids.includes(parsed.grid)) caller.grids.push(parsed.grid);
          if (caller.grids.length > 10) caller.grids.splice(0, caller.grids.length - 10);
          if (caller.grid !== parsed.grid) {
            caller.grid   = parsed.grid;
            caller.latLon = latLon ?? undefined;
          }
        } else if (parsed.grid && !gridOk) {
          stats.gridRejected++;
        }
        // Remember what the station CQs for (DX, POTA, …) — feeds the
        // contacts panel's directed-CQ filter chips.
        if (parsed.type === 'cq' && parsed.cqTag) {
          caller.cqTags ??= [];
          if (!caller.cqTags.includes(parsed.cqTag)) {
            caller.cqTags.push(parsed.cqTag);
            if (caller.cqTags.length > 6) caller.cqTags.splice(0, caller.cqTags.length - 6);
          }
        }
        if (calleeValid) {
          caller.peers.add(parsed.callee!);
          if (caller.peers.size > 50) {
            const first = caller.peers.values().next().value;
            if (first !== undefined) caller.peers.delete(first);
          }
        }
      }
    }

    if (calleeValid && (!onlyFor || parsed.callee === onlyFor)) {
      // The callee never carries the grid, so geo suspicion of the caller
      // still taints the whole decode — same suspicion set gates both sides.
      if (onlyFor !== undefined ||
          admitCallsign(parsed.callee!, confident, pend, suspicions,
                        pending => { for (const pm of pending) processMessage(new Date(pm.windowStartMs), pm, parsed.callee); })) {
        const callee = getOrCreate(parsed.callee!, when);
        if (callerValid) {
          callee.peers.add(parsed.caller);
          if (callee.peers.size > 50) {
            const first = callee.peers.values().next().value;
            if (first !== undefined) callee.peers.delete(first);
          }
        }
        callee.msgs.push({ windowStart: when, raw, parsed, freq, snr, role: 'rx' });
        if (callee.msgs.length > 60) callee.msgs.splice(0, callee.msgs.length - 60);
        if (when.getTime() > callee.lastSeen.getTime()) callee.lastSeen = when;
      }
    }
  };

  for (const m of messages) processMessage(windowStart, m);

  // Evict oldest contacts when over the limit — sort by lastSeen ascending,
  // drop the stalest ones. Never evict a contact that has messages in this window
  // (they're active right now).
  if (contacts.size > MAX_CONTACTS) {
    const sorted = [...contacts.values()].sort(
      (a, b) => a.lastSeen.getTime() - b.lastSeen.getTime()
    );
    for (const c of sorted) {
      if (contacts.size <= MAX_CONTACTS) break;
      if (c.lastSeen.getTime() === windowStart.getTime()) continue; // active this window
      contacts.delete(c.callsign);
    }
  }

  return { contacts, stats };
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

// ── Message builder ───────────────────────────────────────────────────────────
// Produces valid FT8/FT4 message strings for transmission.

export type TxMsgType = 'cq' | 'answer' | 'report' | 'r_report' | 'rr73' | 'tx73';

// True when a callsign cannot ride in a standard 28-bit callsign field —
// compound (PJ4/K1ABC) or nonstandard shape (YW18FIFA) — EXCEPT a standard
// base with a /P or /R suffix, which message types 1/2 carry natively. Such
// calls need the hashed <angle bracket> message forms below.
export function needsHashedExchange(call: string): boolean {
  if (!call) return false;
  if (classifyCallsign(call).kind === 'standard') return false;
  const m = call.toUpperCase().match(/^(.+)\/[RP]$/);
  return !(m && classifyCallsign(m[1]).kind === 'standard');
}

export function buildFTMessage(
  type: TxMsgType,
  myCall: string,
  theirCall = '',
  reportDb?: number,
  myGrid = '',
): string {
  const rpt = reportDb !== undefined
    ? (reportDb >= 0 ? `+${String(reportDb).padStart(2, '0')}` : `-${String(Math.abs(reportDb)).padStart(2, '0')}`)
    : '+00';

  // Hashed exchange, mirroring WSJT-X: when either call can't fit a standard
  // 28-bit field the protocol cannot carry a grid at all, the answer hashes
  // their call and spells mine in full (type 4), reports ride type 1 with the
  // hash in a callsign field, and sign-offs flip to spell THEIR call in full —
  // each side gets its call confirmed over the air at least once.
  if (needsHashedExchange(myCall) || needsHashedExchange(theirCall)) {
    switch (type) {
      case 'cq':       return `CQ ${myCall}`;
      case 'answer':   return `<${theirCall}> ${myCall}`;
      case 'report':   return `<${theirCall}> ${myCall} ${rpt}`;
      case 'r_report': return `<${theirCall}> ${myCall} R${rpt}`;
      case 'rr73':     return `${theirCall} <${myCall}> RR73`;
      case 'tx73':     return `${theirCall} <${myCall}> 73`;
    }
  }

  switch (type) {
    case 'cq':       return myGrid ? `CQ ${myCall} ${myGrid}` : `CQ ${myCall}`;
    case 'answer':   return myGrid ? `${theirCall} ${myCall} ${myGrid}` : `${theirCall} ${myCall}`;
    case 'report':   return `${theirCall} ${myCall} ${rpt}`;
    case 'r_report': return `${theirCall} ${myCall} R${rpt}`;
    case 'rr73':     return `${theirCall} ${myCall} RR73`;
    case 'tx73':     return `${theirCall} ${myCall} 73`;
  }
}

// Audio-Hz interpretation of a numeric directed-CQ tag ("CQ 573 K1ABC" — the
// caller asks to be answered on a specific frequency). Protocol semantics:
// nnn is the kHz part of the requested dial frequency; from a fixed VFO
// that's an audio offset of (MHz base + nnn·1000 − vfo) Hz, honorable WITHOUT
// touching the rig whenever it lands inside the audio passband. When that
// reading is impossible (no VFO connected, or outside the passband) fall back
// to reading nnn as a literal audio offset when plausible. Returns null when
// the request can't be honored from the current VFO — never retune the rig.
export function qsyAudioOffsetHz(cqTag: string | undefined, vfoHz: number): number | null {
  if (!cqTag || !/^[0-9]{3}$/.test(cqTag)) return null;
  const nnn = parseInt(cqTag, 10);
  if (vfoHz > 0) {
    const target = Math.floor(vfoHz / 1_000_000) * 1_000_000 + nnn * 1000;
    const offset = target - vfoHz;
    if (offset >= 200 && offset <= 3000) return offset;
  }
  if (nnn >= 200 && nnn <= 999) return nnn;
  return null;
}

// Derive the natural next message type given the last message we sent and the
// last message received from that station, following WSJT-X auto-sequencing:
//   CQ → (they answer) → report → (they r_report) → rr73 → (they tx73) done
//   (we answer their CQ) → answer → (they report) → r_report → (they rr73) → tx73
// Crucially this includes RETRIES: the peer repeating an earlier message
// means our last transmission was lost on their end — the right move is to
// re-send that transmission, not to advance the sequence or go silent.
// Callers must only act on the result when the peer's message is the NEWER
// of the two (it's our turn); 'cq' means the exchange needs nothing from us.
// A received 73 is never answered — replying to a sign-off would 73-ping-pong
// between two auto-sequencers.
export function nextTxMsgType(lastSent: MsgType | null, lastRx: MsgType | null): TxMsgType {
  if (!lastSent) return 'cq';

  // We CQ'd (or never addressed them): grid answer → report; a direct
  // report (tail-ender skipping the grid) → R+report; R+report (our report
  // reached them but our log rotated) → RR73; RR73/RRR → confirm with 73.
  if (lastSent === 'cq') {
    if (lastRx === 'report')                        return 'r_report';
    if (lastRx === 'r_report')                      return 'rr73';
    if (lastRx === 'rr73' || lastRx === 'rrr')      return 'tx73';
    if (lastRx === 'tx73')                          return 'cq';
    return 'report';
  }

  // We answered their CQ: they report → R+report; they close → 73 back;
  // anything else (incl. their repeated CQ) → keep answering.
  if (lastSent === 'answer') {
    if (lastRx === 'report' || lastRx === 'r_report') return 'r_report';
    if (lastRx === 'rr73' || lastRx === 'rrr')        return 'tx73';
    if (lastRx === 'tx73')                            return 'cq';
    return 'answer';
  }

  // We sent a report: rogered (R+report/RRR) → RR73; they closed → 73;
  // a repeated grid answer means they missed our report → re-send it.
  if (lastSent === 'report') {
    if (lastRx === 'r_report' || lastRx === 'rrr') return 'rr73';
    if (lastRx === 'rr73')                         return 'tx73';
    if (lastRx === 'tx73')                         return 'cq';
    return 'report';
  }

  // We sent R+report: RR73/RRR → 73 back; their 73 → done; a repeated
  // report means they missed our R+report → re-send it.
  if (lastSent === 'r_report') {
    if (lastRx === 'rr73' || lastRx === 'rrr') return 'tx73';
    if (lastRx === 'tx73')                     return 'cq';
    return 'r_report';
  }

  // We sent RR73/RRR: their 73 (or anything new like a fresh CQ) → done;
  // a repeated R+report/report means they missed it → re-send RR73;
  // their RR73 crossing ours → 73.
  if (lastSent === 'rr73' || lastSent === 'rrr') {
    if (lastRx === 'r_report' || lastRx === 'report' || lastRx === 'rrr') return 'rr73';
    if (lastRx === 'rr73')                                                return 'tx73';
    return 'cq';
  }

  // We sent 73: only a repeated RR73/RRR (they missed our 73) warrants
  // re-sending it — never reply to their 73.
  if (lastSent === 'tx73') {
    if (lastRx === 'rr73' || lastRx === 'rrr') return 'tx73';
    return 'cq';
  }

  return 'cq';
}

// ── ADIF export / import ──────────────────────────────────────────────────────

const APP_URL = 'https://acesso.github.io/Signal-Decoder/';

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

// ADIF 3.1.7: FT8 is its own primary MODE; FT4 is a SUBMODE of MFSK.
function adifMode(ftMode: FTMode): [string, string][] {
  if (ftMode === 'FT8') return [['MODE', 'FT8']];
  if (ftMode === 'FT4') return [['MODE', 'MFSK'], ['SUBMODE', 'FT4']];
  return [['MODE', ftMode]];
}

// ADIF 3.1.7 BAND enumeration — maps frequency in MHz to band name.
// Ranges are inclusive lower bound, exclusive upper bound.
const BAND_RANGES: [number, number, string][] = [
  [0.1357,  0.1378,  '2190m'],
  [0.472,   0.479,   '630m'],
  [0.501,   0.504,   '560m'],
  [1.8,     2.0,     '160m'],
  [3.5,     4.0,     '80m'],
  [5.06,    5.45,    '60m'],
  [7.0,     7.3,     '40m'],
  [10.1,    10.15,   '30m'],
  [14.0,    14.35,   '20m'],
  [18.068,  18.168,  '17m'],
  [21.0,    21.45,   '15m'],
  [24.890,  24.99,   '12m'],
  [28.0,    29.7,    '10m'],
  [50.0,    54.0,    '6m'],
  [70.0,    71.0,    '4m'],
  [144.0,   148.0,   '2m'],
  [222.0,   225.0,   '1.25m'],
  [420.0,   450.0,   '70cm'],
  [902.0,   928.0,   '33cm'],
  [1240.0,  1300.0,  '23cm'],
  [2300.0,  2450.0,  '13cm'],
  [3300.0,  3500.0,  '9cm'],
  [5650.0,  5925.0,  '6cm'],
  [10000.0, 10500.0, '3cm'],
  [24000.0, 24050.0, '1.25cm'],
  [47000.0, 47200.0, '6mm'],
  [75500.0, 81000.0, '4mm'],
];

export function freqMhzToBand(mhz: number): string | undefined {
  for (const [lo, hi, band] of BAND_RANGES) {
    if (mhz >= lo && mhz < hi) return band;
  }
  return undefined;
}

export interface ADIFOptions {
  myCall?: string;
  myGrid?: string;
  // VFO frequency in Hz — used to derive FREQ and BAND for each contact.
  // Contacts store their audio offset; the absolute freq = vfoHz + audioOffsetHz.
  // If 0 / absent, FREQ and BAND are omitted.
  vfoHz?: number;
  // Also export partial QSOs (two-way handshake with no report exchanged yet).
  // Off by default — only confirmed (full) QSOs are exported.
  includePartial?: boolean;
}

const REPORT_TYPES: ReadonlySet<MsgType> = new Set(['report', 'r_report']);
const CLOSING_TYPES: ReadonlySet<MsgType> = new Set(['rr73', 'rrr', 'tx73']);
const REOPEN_TYPES:  ReadonlySet<MsgType> = new Set(['cq', 'answer']);

// Segment a contact's messages into discrete QSO exchanges.
// A new segment starts at the first message and restarts whenever a closing
// message (RR73/RRR/73) is followed by a CQ or answer from either side.
function segmentQSOs(msgs: ContactMsg[]): ContactMsg[][] {
  if (msgs.length === 0) return [];
  const sorted = [...msgs].sort((a, b) => a.windowStart.getTime() - b.windowStart.getTime());
  const segments: ContactMsg[][] = [];
  let current: ContactMsg[] = [];
  let pendingClose = false;

  for (const m of sorted) {
    if (pendingClose && REOPEN_TYPES.has(m.parsed.type)) {
      if (current.length > 0) segments.push(current);
      current = [];
      pendingClose = false;
    }
    current.push(m);
    if (CLOSING_TYPES.has(m.parsed.type)) pendingClose = true;
  }
  if (current.length > 0) segments.push(current);
  return segments;
}

// Returns true if both sides transmitted to each other within the segment —
// the basic two-way handshake, with or without a signal report.
// NOTE: `msgs` belongs to the PEER's contact record (c), not mine — role='tx'
// means the peer transmitted, role='rx' means the peer was addressed (i.e. I
// transmitted to them).
function segmentIsHandshake(msgs: ContactMsg[], me: string): { iSent: ContactMsg[]; theySent: ContactMsg[] } | null {
  // Messages they transmitted (peer is caller, role='tx' on the peer's contact entry)
  const theySent = msgs.filter(m => m.role === 'tx' && m.parsed.callee?.toUpperCase() === me);
  // Messages I transmitted to them (peer is callee, role='rx' on the peer's contact entry
  // because the peer was addressed while I was the caller)
  const iSent    = msgs.filter(m => m.role === 'rx' && m.parsed.caller?.toUpperCase() === me);
  if (iSent.length === 0 || theySent.length === 0) return null;
  return { iSent, theySent };
}

// Returns true if the segment/contact's messages constitute a confirmed two-way QSO.
// Rules:
//   1. Both sides must have transmitted to each other (basic handshake).
//   2. At least one signal report must have been exchanged in either direction:
//      - They sent me a report (they reported my signal), OR
//      - I sent them a report (I reported their signal).
//   This covers all standard FT8 QSO flows regardless of who called CQ.
function segmentIsConfirmed(msgs: ContactMsg[], me: string): boolean {
  const hs = segmentIsHandshake(msgs, me);
  if (!hs) return false;
  const iSentReport    = hs.iSent.some(m => REPORT_TYPES.has(m.parsed.type));
  const theySentReport = hs.theySent.some(m => REPORT_TYPES.has(m.parsed.type));
  return iSentReport || theySentReport;
}

// Without myCall we cannot determine participation, so all contacts pass through.
export function isConfirmedQSO(c: Contact, myCall: string): boolean {
  if (!myCall) return true;
  return segmentIsConfirmed(c.msgs, myCall.toUpperCase());
}

// A partial QSO: the two-way handshake happened but no signal report was
// exchanged yet (e.g. only CQ + answer). Excludes segments that already
// qualify as a confirmed (full) QSO.
export function isPartialQSO(c: Contact, myCall: string): boolean {
  if (!myCall) return false;
  const me = myCall.toUpperCase();
  return segmentQSOs(c.msgs).some(seg => segmentIsHandshake(seg, me) && !segmentIsConfirmed(seg, me));
}

/** One QSO exchange, snapshotted as a self-contained record. Contact message
 *  lists rotate (60 per contact) and whole contacts get evicted at
 *  MAX_CONTACTS, so QSOs must be extracted into records the moment they are
 *  decoded and kept in a separate store (see qsoLog.ts) — deriving them from
 *  live contacts at export time silently loses exchanges whose messages have
 *  already rotated out. */
export interface QSORecord {
  callsign: string;
  grid?: string;
  /** First / last exchange-message time (ms epoch). QSO_DATE/TIME_ON come
   *  from startMs; endMs lets re-captures of the same QSO be recognized by
   *  time overlap even after its earliest messages rotate out. */
  startMs: number;
  endMs: number;
  /** Absolute Hz when known (VFO already folded in at capture), 0 = unknown. */
  freqHz: number;
  /** Audio offset (Hz) when no VFO was connected at capture — lets export
   *  fall back to the export-time VFO to derive FREQ/BAND. */
  audioHz?: number;
  /** Best SNR received from them; -99 when nothing was heard (SWL edge). */
  rstRcvd: number;
  /** Report I sent them, when one went out. */
  rstSent?: number;
  sentCount: number;
  rcvdCount: number;
  /** true = report exchanged (full QSO); false = handshake only (partial). */
  confirmed: boolean;
  mode: FTMode;
  /** Verbatim COMMENT override (preserves comments on imported records). */
  comment?: string;
}

// NOTE: `c.msgs` belong to the PEER's contact record — role='tx' means the
// peer transmitted, role='rx' means the peer was addressed (I transmitted).
export function extractQSORecords(
  c: Contact,
  myCall: string,
  ftMode: FTMode,
  vfoHz = 0,
  includePartial = true,
): QSORecord[] {
  const me = myCall.toUpperCase();
  // Skip the entry keyed by our own callsign — mergeContacts tracks every
  // caller/callee it sees, including us, so a "contact" for myCall is not a
  // real QSO partner. Without this guard a completed exchange produces an
  // ADIF record with CALL === STATION_CALLSIGN (a bogus self-worked QSO).
  if (me && c.callsign.toUpperCase() === me) return [];
  // Without myCall participation can't be determined, so the whole history
  // passes through as a single unconditional record.
  const segments = me
    ? segmentQSOs(c.msgs).filter(
        seg => segmentIsConfirmed(seg, me) || (includePartial && segmentIsHandshake(seg, me) !== null),
      )
    : [c.msgs];

  const out: QSORecord[] = [];
  for (const seg of segments) {
    // Messages I transmitted to them: role='rx' on their contact (they were addressed), I am the caller
    const iSentMsgs    = seg.filter(m => m.role === 'rx' && m.parsed.caller?.toUpperCase() === me);
    // Messages they transmitted to me: role='tx' on their contact (they are caller), callee=me
    const theySentMsgs = seg.filter(m => m.role === 'tx' && m.parsed.callee?.toUpperCase() === me);
    const confirmed    = me ? segmentIsConfirmed(seg, me) : true;

    // RST_RCVD = best SNR on signals I received from them (their tx, stored as my rx)
    const bestSnrRcvd = theySentMsgs.reduce((best, m) => m.snr > best ? m.snr : best, -99);
    // RST_SENT = the report value I sent them (in my tx messages of type report/r_report)
    const reportedSnr = iSentMsgs
      .filter(m => REPORT_TYPES.has(m.parsed.type))
      .map(m => m.parsed.report)
      .filter((v): v is number => v !== undefined);
    const bestSnrSent = reportedSnr.length > 0
      ? reportedSnr.reduce((a, b) => a > b ? a : b)
      : undefined;

    // QSO start/end = first/last exchange message in this segment
    const allExchange = [...iSentMsgs, ...theySentMsgs].sort(
      (a, b) => a.windowStart.getTime() - b.windowStart.getTime(),
    );
    const qsoStart = allExchange[0]?.windowStart ?? c.firstSeen;
    const qsoEnd   = allExchange[allExchange.length - 1]?.windowStart ?? qsoStart;

    const firstMsg = allExchange[0];
    const absHz = firstMsg
      ? (firstMsg.freq > 1_000_000 ? firstMsg.freq : (vfoHz > 0 ? vfoHz + firstMsg.freq : 0))
      : (vfoHz > 0 ? vfoHz : 0);
    // No VFO connected at capture: keep the bare audio offset so export can
    // still derive an absolute frequency from the export-time VFO.
    const audioHz = absHz === 0 && firstMsg && firstMsg.freq <= 1_000_000 ? firstMsg.freq : undefined;

    out.push({
      callsign: c.callsign,
      grid: c.grid,
      startMs: qsoStart.getTime(),
      endMs: qsoEnd.getTime(),
      freqHz: absHz,
      audioHz,
      rstRcvd: Math.round(bestSnrRcvd),
      rstSent: bestSnrSent,
      sentCount: iSentMsgs.length,
      rcvdCount: theySentMsgs.length,
      confirmed,
      mode: ftMode,
    });
  }
  return out;
}

export function generateADIFFromRecords(
  records: QSORecord[],
  opts: Pick<ADIFOptions, 'myCall' | 'myGrid' | 'vfoHz'> = {},
): string {
  const { myCall, myGrid, vfoHz = 0 } = opts;
  const me        = (myCall ?? '').toUpperCase();
  const now       = new Date();
  const timestamp = `${adifDate(now)} ${adifTime(now)}`;

  const lines: string[] = [
    af('ADIF_VER', '3.1.7'),
    af('PROGRAMID', `Signal Decoder — ${APP_URL}`),
    af('PROGRAMVERSION', '1.0'),
    af('CREATED_TIMESTAMP', timestamp),
    '<EOH>',
    '',
  ];

  for (const r of [...records].sort((a, b) => a.startMs - b.startMs)) {
    const qsoStart = new Date(r.startMs);
    // Absolute frequency from capture; else fall back to folding the
    // record's audio offset into the export-time VFO (legacy behavior for
    // QSOs decoded before the radio was connected).
    const absHz    = r.freqHz > 0 ? r.freqHz : (vfoHz > 0 && r.audioHz ? vfoHz + r.audioHz : 0);
    const freqMhz  = absHz > 0 ? absHz / 1_000_000 : 0;
    const band     = freqMhz > 0 ? freqMhzToBand(freqMhz) : undefined;

    const fields: [string, string][] = [
      ['CALL',     r.callsign],
      ...adifMode(r.mode),
      ['QSO_DATE', adifDate(qsoStart)],
      ['TIME_ON',  adifTime(qsoStart)],
    ];

    if (band)        fields.push(['BAND',       band]);
    if (freqMhz > 0) fields.push(['FREQ',       freqMhz.toFixed(6)]);
    if (r.grid)      fields.push(['GRIDSQUARE', r.grid]);
    // Round at format time too — records logged before rounding was added
    // at capture hold raw decoder floats (-8.161644894026992).
    const rstRcvd = Math.round(r.rstRcvd);
    fields.push(['RST_RCVD', `${rstRcvd >= 0 ? '+' : ''}${rstRcvd}`]);
    if (r.rstSent !== undefined) {
      const rstSent = Math.round(r.rstSent);
      fields.push(['RST_SENT', `${rstSent >= 0 ? '+' : ''}${rstSent}`]);
    }
    if (myCall) fields.push(['STATION_CALLSIGN', me]);
    if (myGrid) fields.push(['MY_GRIDSQUARE',    myGrid.toUpperCase()]);
    const partialNote = r.confirmed ? '' : ' (partial: handshake only, no report exchanged)';
    fields.push(['COMMENT', r.comment ?? `${r.mode} QSO: ${r.sentCount} sent, ${r.rcvdCount} rcvd${partialNote}`]);

    lines.push(fields.map(([k, v]) => af(k, v)).join(' ') + ' <EOR>');
  }

  return lines.join('\n') + '\n';
}

export function generateADIF(
  contacts: Map<string, Contact>,
  ftMode: FTMode,
  opts: ADIFOptions = {},
): string {
  const { myCall, myGrid, vfoHz = 0, includePartial = false } = opts;
  const me = (myCall ?? '').toUpperCase();
  const records: QSORecord[] = [];
  for (const c of contacts.values()) {
    records.push(...extractQSORecords(c, me, ftMode, vfoHz, includePartial));
  }
  return generateADIFFromRecords(records, { myCall, myGrid, vfoHz });
}

// ── ADIF import ───────────────────────────────────────────────────────────────

export interface ADIFRecord {
  call: string;
  qsoDate?: string;   // YYYYMMDD
  timeOn?: string;    // HHMMSS
  mode?: string;
  submode?: string;
  gridsquare?: string;
  rstRcvd?: string;
  freq?: string;      // MHz
  comment?: string;
}

function parseADIFValue(text: string, fieldName: string): string | undefined {
  const re = new RegExp(`<${fieldName}:(\\d+)(?::[^>]*)?>`, 'i');
  const m  = re.exec(text);
  if (!m) return undefined;
  const len   = parseInt(m[1], 10);
  const start = m.index + m[0].length;
  return text.slice(start, start + len);
}

export function parseADIF(content: string): ADIFRecord[] {
  // Split on <EOR> (end of record), case-insensitive
  const rawRecords = content.split(/<EOR>/i).map(s => s.trim()).filter(Boolean);
  const records: ADIFRecord[] = [];

  for (const raw of rawRecords) {
    // Skip header block (before <EOH>)
    if (/<EOH>/i.test(raw)) continue;
    const call = parseADIFValue(raw, 'CALL');
    if (!call || !isValidCallsign(call.trim().toUpperCase())) continue;
    records.push({
      call:        call.trim().toUpperCase(),
      qsoDate:     parseADIFValue(raw, 'QSO_DATE'),
      timeOn:      parseADIFValue(raw, 'TIME_ON'),
      mode:        parseADIFValue(raw, 'MODE'),
      submode:     parseADIFValue(raw, 'SUBMODE'),
      gridsquare:  parseADIFValue(raw, 'GRIDSQUARE'),
      rstRcvd:     parseADIFValue(raw, 'RST_RCVD'),
      freq:        parseADIFValue(raw, 'FREQ'),
      comment:     parseADIFValue(raw, 'COMMENT'),
    });
  }

  // Deduplicate by callsign — keep first occurrence
  const seen = new Set<string>();
  return records.filter(r => { if (seen.has(r.call)) return false; seen.add(r.call); return true; });
}
