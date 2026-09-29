/**
 * Decides which admitted decodes may be reported onward.
 *
 * mergeContacts' gate already establishes that a decode is trustworthy — clean
 * parse, valid callsign, no OSD quarantine, no implausible grid. This adds the
 * constraints that are specific to reporting to a public network.
 */
import type { AdmittedDecode } from '../parser'
import type { FTMode } from '../decoder'
import type { PskSpot } from './ipfix'

/**
 * FT2 is this app's own experiment, not something PSK Reporter knows, so those
 * decodes are never reported rather than being mislabelled as something else.
 */
const REPORTABLE_MODES: Partial<Record<FTMode, string>> = {
  FT8: 'FT8',
  FT4: 'FT4',
}

/**
 * Decodes carry a bare audio offset until a radio reports its dial frequency,
 * and the app marks the difference by magnitude — the same discriminator
 * extractQSORecords uses. A spot without a real RF frequency is worse than no
 * spot at all, so it is dropped rather than guessed at.
 */
const MIN_ABSOLUTE_HZ = 1_000_000

export type IneligibleReason = 'mode' | 'frequency' | 'self' | 'callsign'

export type Eligibility =
  | { ok: true; spot: PskSpot }
  | { ok: false; reason: IneligibleReason }

export function toSpot(
  decode: AdmittedDecode,
  mode: FTMode,
  myCallsign: string | undefined,
): Eligibility {
  const pskMode = REPORTABLE_MODES[mode]
  if (!pskMode) return { ok: false, reason: 'mode' }

  if (!Number.isFinite(decode.freq) || decode.freq < MIN_ABSOLUTE_HZ) {
    return { ok: false, reason: 'frequency' }
  }

  const callsign = decode.callsign.toUpperCase()
  // Hashed callsigns (<...>) carry no identity to report.
  if (!callsign || callsign.includes('<') || callsign.includes('>')) {
    return { ok: false, reason: 'callsign' }
  }
  // Hearing your own signal (or a spurious decode of it) is not propagation data.
  if (myCallsign && callsign === myCallsign.trim().toUpperCase()) {
    return { ok: false, reason: 'self' }
  }

  return {
    ok: true,
    spot: {
      senderCallsign: callsign,
      frequencyHz: Math.round(decode.freq),
      snrDb: decode.snr,
      mode: pskMode,
      locator: decode.grid,
      flowStartSeconds: Math.floor(decode.windowStart.getTime() / 1000),
    },
  }
}
