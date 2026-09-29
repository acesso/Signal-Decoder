/**
 * IPFIX (RFC 7011) encoder for PSK Reporter reception reports.
 *
 * PSK Reporter ingests reports as IPFIX messages on report.pskreporter.info:4739
 * (14739 is a test listener that echoes a parse of whatever it received to
 * https://report.pskreporter.info/cgi-bin/psk-analysis.pl). The wire format is
 * documented at https://pskreporter.info/pskdev.html.
 *
 * Transport-agnostic on purpose: this returns bytes, and the same bytes are
 * valid over UDP or over a TCP stream (RFC 7011 section 10.4), which is what
 * lets a Cloudflare Worker relay them — Workers can open TCP sockets but not
 * UDP ones.
 *
 * Two encoding details cause almost every hand-rolled implementation to fail
 * the server's parser, so they are spelled out here:
 *
 *  - An *enterprise-specific* field specifier is 8 bytes, not 4: the 4-byte
 *    enterprise number follows the id and length. Only standard IEs (high bit
 *    clear, e.g. flowStartSeconds = 150) use the short 4-byte form. Omitting
 *    the enterprise number makes the collector read the next field specifier as
 *    an enterprise number and walk off the end of the template.
 *  - Variable-length strings are a single length byte followed by the bytes,
 *    with no NUL terminator.
 */

const IPFIX_VERSION = 0x000a
const HEADER_BYTES = 16

/** Set id for the receiver's options template / options data. */
export const RECEIVER_TEMPLATE_ID = 0x9992
/** Set id for the sender (spot) template / data. */
export const SENDER_TEMPLATE_ID = 0x9993

/** A variable-length string field can carry at most 254 bytes. */
const MAX_STRING_BYTES = 254

/**
 * Template descriptors, copied verbatim from the protocol documentation rather
 * than generated, so they cannot drift from what the collector expects.
 *
 * Every enterprise field carries PSK Reporter's enterprise number 30351
 * (0x0000768F). Receiver info is an *options* template (set id 3); sender info is a plain
 * template (set id 2). Trailing `00 00` is the pad to a 4-byte boundary and is
 * counted in the set length.
 */

/** receiverCallsign, receiverLocator, decoderSoftware. */
const RECEIVER_TEMPLATE_3 = Uint8Array.from([
  0x00, 0x03, 0x00, 0x24, 0x99, 0x92, 0x00, 0x03, 0x00, 0x01,
  0x80, 0x02, 0xff, 0xff, 0x00, 0x00, 0x76, 0x8f,
  0x80, 0x04, 0xff, 0xff, 0x00, 0x00, 0x76, 0x8f,
  0x80, 0x08, 0xff, 0xff, 0x00, 0x00, 0x76, 0x8f,
  0x00, 0x00,
])

/** …plus antennaInformation. */
const RECEIVER_TEMPLATE_4 = Uint8Array.from([
  0x00, 0x03, 0x00, 0x2c, 0x99, 0x92, 0x00, 0x04, 0x00, 0x01,
  0x80, 0x02, 0xff, 0xff, 0x00, 0x00, 0x76, 0x8f,
  0x80, 0x04, 0xff, 0xff, 0x00, 0x00, 0x76, 0x8f,
  0x80, 0x08, 0xff, 0xff, 0x00, 0x00, 0x76, 0x8f,
  0x80, 0x09, 0xff, 0xff, 0x00, 0x00, 0x76, 0x8f,
  0x00, 0x00,
])

/**
 * senderCallsign, frequency, sNR, iMD, mode, informationSource, senderLocator,
 * flowStartSeconds. Data records must be written in exactly this order.
 */
const SENDER_TEMPLATE = Uint8Array.from([
  0x00, 0x02, 0x00, 0x44, 0x99, 0x93, 0x00, 0x08,
  0x80, 0x01, 0xff, 0xff, 0x00, 0x00, 0x76, 0x8f,
  0x80, 0x05, 0x00, 0x04, 0x00, 0x00, 0x76, 0x8f,
  0x80, 0x06, 0x00, 0x01, 0x00, 0x00, 0x76, 0x8f,
  0x80, 0x07, 0x00, 0x01, 0x00, 0x00, 0x76, 0x8f,
  0x80, 0x0a, 0xff, 0xff, 0x00, 0x00, 0x76, 0x8f,
  0x80, 0x0b, 0x00, 0x01, 0x00, 0x00, 0x76, 0x8f,
  0x80, 0x03, 0xff, 0xff, 0x00, 0x00, 0x76, 0x8f,
  0x00, 0x96, 0x00, 0x04,
])

export interface PskReceiver {
  /** The reporting station's own callsign. */
  callsign: string
  /** The reporting station's Maidenhead locator. */
  locator: string
  /** Free-form software identification, e.g. "Signal-Decoder 0.21.1". */
  decoderSoftware: string
  /** Optional free-form antenna description. */
  antenna?: string
}

export interface PskSpot {
  /** The station that was heard. */
  senderCallsign: string
  /** Absolute RF frequency in Hz. */
  frequencyHz: number
  /** Signal report in dB; clamped to a signed byte. */
  snrDb?: number
  /** Mode string as PSK Reporter knows it, e.g. "FT8" or "FT4". */
  mode: string
  /** The heard station's locator, when the message carried one. */
  locator?: string
  /** Start of the transmission window, in whole Unix seconds. */
  flowStartSeconds: number
}

export interface BuildPacketOptions {
  receiver: PskReceiver
  spots: PskSpot[]
  /** Incrementing per packet, per session. */
  sequenceNumber: number
  /**
   * A random u32 held constant for the life of a session. PSK Reporter uses it
   * to tell senders apart behind residential NAT, where the source address is
   * shared and can change.
   */
  sessionId: number
  /** Send time in Unix seconds; defaults to now. */
  sentAtSeconds?: number
  /**
   * Templates need only be re-sent hourly, but should accompany the first few
   * packets after start because UDP may drop them. Defaults to true.
   */
  includeTemplates?: boolean
}

/** informationSource = 1, "automatically extracted". Anything else is treated differently by the collector. */
const INFORMATION_SOURCE_AUTOMATIC = 1

const utf8 = new TextEncoder()

/** Encodes a variable-length string as one length byte followed by its bytes. */
function encodeString(value: string): Uint8Array {
  let bytes = utf8.encode(value)
  if (bytes.length > MAX_STRING_BYTES) bytes = bytes.subarray(0, MAX_STRING_BYTES)
  const out = new Uint8Array(bytes.length + 1)
  out[0] = bytes.length
  out.set(bytes, 1)
  return out
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.length
  }
  return out
}

/**
 * Wraps records in a set header, padding the set to a 4-byte boundary. The pad
 * is counted in the set length, per RFC 7011.
 */
function buildSet(setId: number, records: Uint8Array[]): Uint8Array {
  const body = concat(records)
  const unpadded = 4 + body.length
  const padding = (4 - (unpadded % 4)) % 4
  const set = new Uint8Array(unpadded + padding)
  const view = new DataView(set.buffer)
  view.setUint16(0, setId)
  view.setUint16(2, set.length)
  set.set(body, 4)
  return set
}

function buildReceiverRecord(receiver: PskReceiver): Uint8Array {
  const fields = [
    encodeString(receiver.callsign),
    encodeString(receiver.locator),
    encodeString(receiver.decoderSoftware),
  ]
  if (receiver.antenna !== undefined) fields.push(encodeString(receiver.antenna))
  return concat(fields)
}

function clampSnr(snr: number | undefined): number {
  if (snr === undefined || !Number.isFinite(snr)) return 0
  return Math.max(-128, Math.min(127, Math.round(snr)))
}

function buildSenderRecord(spot: PskSpot): Uint8Array {
  const callsign = encodeString(spot.senderCallsign)
  const mode = encodeString(spot.mode)
  const locator = encodeString(spot.locator ?? '')

  const record = new Uint8Array(callsign.length + 4 + 1 + 1 + mode.length + 1 + locator.length + 4)
  const view = new DataView(record.buffer)
  let at = 0

  record.set(callsign, at)
  at += callsign.length

  view.setUint32(at, Math.max(0, Math.round(spot.frequencyHz)))
  at += 4

  view.setInt8(at, clampSnr(spot.snrDb))
  at += 1

  view.setInt8(at, 0) // iMD — not measured
  at += 1

  record.set(mode, at)
  at += mode.length

  view.setUint8(at, INFORMATION_SOURCE_AUTOMATIC)
  at += 1

  record.set(locator, at)
  at += locator.length

  view.setUint32(at, Math.max(0, Math.round(spot.flowStartSeconds)))

  return record
}

/**
 * Builds one complete IPFIX message: header, optionally the two templates, the
 * receiver options record, and one sender record per spot.
 */
export function buildPskReporterPacket(options: BuildPacketOptions): Uint8Array {
  const { receiver, spots, sequenceNumber, sessionId, includeTemplates = true } = options
  const sentAt = options.sentAtSeconds ?? Math.floor(Date.now() / 1000)

  const sections: Uint8Array[] = []

  if (includeTemplates) {
    sections.push(receiver.antenna !== undefined ? RECEIVER_TEMPLATE_4 : RECEIVER_TEMPLATE_3)
    sections.push(SENDER_TEMPLATE)
  }

  sections.push(buildSet(RECEIVER_TEMPLATE_ID, [buildReceiverRecord(receiver)]))

  if (spots.length > 0) {
    sections.push(buildSet(SENDER_TEMPLATE_ID, spots.map(buildSenderRecord)))
  }

  const body = concat(sections)
  const packet = new Uint8Array(HEADER_BYTES + body.length)
  const view = new DataView(packet.buffer)
  view.setUint16(0, IPFIX_VERSION)
  view.setUint16(2, packet.length)
  view.setUint32(4, sentAt)
  view.setUint32(8, sequenceNumber >>> 0)
  view.setUint32(12, sessionId >>> 0)
  packet.set(body, HEADER_BYTES)

  return packet
}
