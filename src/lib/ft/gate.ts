// Quarantine for suspicious new callsigns.
//
// A callsign never heard before that arrives via a low-confidence decode
// (OSD fallback) or with a geographically implausible grid is NOT admitted
// to the contacts/map immediately. It is held in a hidden table, its
// messages buffered, until either:
//   - a confident sighting arrives (clean LDPC decode with a plausible
//     grid) → released immediately, buffered messages replayed; or
//   - it is heard in RELEASE_SIGHTING_WINDOWS distinct decode windows →
//     a persistent station is real; released (unless it is a near-twin of
//     an existing contact — a repeating marginal signal can make the OSD
//     mis-decode the SAME wrong callsign every window, so twins only get
//     out on a clean decode); or
//   - QUARANTINE_WINDOWS decode cycles pass without that → silently
//     dropped.
//
// Established contacts are never gated — corroboration already happened.
// The gate is deliberately dumb about parsing: mergeContacts() decides
// what is suspicious and what a sighting means; this class only does the
// bookkeeping.

/** Window cycles a suspicious callsign is held before being dropped. */
export const QUARANTINE_WINDOWS = 6;
/** Distinct windows a held callsign must be heard in to self-corroborate. */
export const RELEASE_SIGHTING_WINDOWS = 3;
/** Max buffered messages per held callsign. */
const MAX_PENDING = 12;

export type HoldReason = 'osd' | 'geo' | 'twin';

/** A buffered message, replayable through mergeContacts on release. */
export interface PendingMsg {
  windowStartMs: number;
  msg: string;
  freq: number;
  snr: number;
  osd?: number;
}

interface QEntry {
  cycleAdded: number;
  windowsSeen: Set<number>;
  reasons: Set<HoldReason>;
  pending: PendingMsg[];
}

export class DecodeGate {
  private cycle = 0;
  private seenWindows = new Set<number>();
  private entries = new Map<string, QEntry>();

  /**
   * Advance the window cycle. Idempotent per distinct windowStart — partials
   * stream into mergeContacts several times per window, and a slow decode can
   * deliver window W's late partials after window W+1 already began merging,
   * so revisits (not just consecutive repeats) must not re-count. Returns the
   * callsigns whose quarantine expired this cycle.
   */
  beginWindow(windowStart: Date): string[] {
    const ms = windowStart.getTime();
    if (this.seenWindows.has(ms)) return [];
    this.seenWindows.add(ms);
    if (this.seenWindows.size > 64) {
      const oldest = this.seenWindows.values().next().value!;
      this.seenWindows.delete(oldest);
    }
    this.cycle++;
    const expired: string[] = [];
    for (const [cs, e] of this.entries) {
      if (this.cycle - e.cycleAdded >= QUARANTINE_WINDOWS) {
        expired.push(cs);
        this.entries.delete(cs);
      }
    }
    return expired;
  }

  isHeld(callsign: string): boolean {
    return this.entries.has(callsign);
  }

  /** Put a new suspicious callsign in quarantine (or add to its buffer). */
  hold(callsign: string, reasons: HoldReason[], msg: PendingMsg): void {
    let e = this.entries.get(callsign);
    if (!e) {
      e = { cycleAdded: this.cycle, windowsSeen: new Set(), reasons: new Set(), pending: [] };
      this.entries.set(callsign, e);
    }
    for (const r of reasons) e.reasons.add(r);
    e.windowsSeen.add(msg.windowStartMs);
    if (e.pending.length < MAX_PENDING) e.pending.push(msg);
  }

  /**
   * Record a sighting of an already-held callsign. Returns the buffered
   * messages (in arrival order) if this sighting releases it, else null.
   * `confident` = clean (non-OSD) decode whose grid (if any) is plausible.
   */
  sighting(callsign: string, confident: boolean, msg: PendingMsg): PendingMsg[] | null {
    const e = this.entries.get(callsign);
    if (!e) return null;
    e.windowsSeen.add(msg.windowStartMs);
    const selfCorroborated =
      e.windowsSeen.size >= RELEASE_SIGHTING_WINDOWS && !e.reasons.has('twin');
    if (confident || selfCorroborated) {
      this.entries.delete(callsign);
      return e.pending;
    }
    if (e.pending.length < MAX_PENDING) e.pending.push(msg);
    return null;
  }

  heldCount(): number {
    return this.entries.size;
  }

  reset(): void {
    this.cycle = 0;
    this.seenWindows.clear();
    this.entries.clear();
  }
}

/**
 * Same-length near-twin check: `cs` differs from `other` by at most 2
 * substituted characters, and when exactly 2, at non-adjacent positions —
 * the shape of an OSD mis-decode of a real neighboring signal. (FT8's
 * callsign fields are integer-packed, so a wrong decode is usually a
 * wholesale different codeword; but ghosts of a strong repeating station
 * typically land 1-2 characters away from the real call.)
 */
export function isNearTwin(cs: string, other: string): boolean {
  if (cs.length !== other.length || cs === other) return false;
  let first = -1;
  let diffs = 0;
  for (let i = 0; i < cs.length; i++) {
    if (cs[i] !== other[i]) {
      if (diffs === 0) first = i;
      else if (diffs === 1 && i === first + 1) return false; // adjacent pair
      if (++diffs > 2) return false;
    }
  }
  return diffs > 0;
}
