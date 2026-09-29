/**
 * Batches admitted decodes into PSK Reporter packets and paces them.
 *
 * The protocol asks callers to hold to three rules, all enforced here rather
 * than in the UI so they can be tested without a browser:
 *
 *  - no more than one packet every five minutes, unless the packet fills up;
 *  - each callsign reported at most once per five-minute period;
 *  - sends must NOT be aligned to the system clock, so the whole network does
 *    not report in lockstep on the minute. Hence the jitter.
 *
 * Templates are re-sent hourly, and with the first few packets after start
 * because the collector may have missed them.
 *
 * Time and randomness are injected so tests can drive this deterministically.
 */
import { buildPskReporterPacket, type PskReceiver, type PskSpot } from './ipfix'

/** Default gap between packets — what the protocol asks for. */
export const MIN_SEND_INTERVAL_MS = 5 * 60_000
export const DEFAULT_INTERVAL_MINUTES = 5
export const MIN_INTERVAL_MINUTES = 1
export const MAX_INTERVAL_MINUTES = 30

/**
 * Window cadence sends as soon as a decode window finishes, which gets new
 * stations onto the map within seconds instead of minutes. The catch is that
 * FT windows are UTC-aligned, so every decoder running this way would fire at
 * the same instant — exactly the lockstep the protocol warns against. Sends are
 * therefore scattered across this many milliseconds after the window closes.
 */
export const WINDOW_SEND_JITTER_MS = 8_000

/**
 * How often packets go out. Per-callsign deduplication stays at five minutes in
 * both modes, so 'window' does not report the same station more often — it only
 * gets stations reported sooner after they are first heard.
 */
export type SendCadence = { mode: 'window' } | { mode: 'interval'; minutes: number }

export function clampIntervalMinutes(minutes: number): number {
  if (!Number.isFinite(minutes)) return DEFAULT_INTERVAL_MINUTES
  return Math.min(MAX_INTERVAL_MINUTES, Math.max(MIN_INTERVAL_MINUTES, Math.round(minutes)))
}
/** A callsign already reported within this window is dropped as a duplicate. */
export const DEDUP_WINDOW_MS = 5 * 60_000
/** Comfortably inside the ~1400 byte ceiling the relay enforces. */
export const MAX_PACKET_BYTES = 1200
/** Spread sends across ±30s so reporters do not synchronise. */
export const SEND_JITTER_MS = 30_000
/** Retry sooner than the normal cadence when a send fails. */
export const RETRY_INTERVAL_MS = 60_000

const TEMPLATE_REFRESH_MS = 60 * 60_000
/** Packets after start that carry templates regardless, in case one is lost. */
const TEMPLATE_PRIMING_PACKETS = 3

/** Beyond this the oldest spots are dropped rather than grow without bound. */
const MAX_QUEUED = 250

export type OfferResult = 'queued' | 'duplicate'

export interface SpotQueueOptions {
  /** Delivers the bytes. Rejecting keeps the batch queued for a retry. */
  send(packet: Uint8Array): Promise<void>
  /**
   * The reporting station, or null when it is not configured yet. Read at send
   * time so edits to callsign or grid take effect without rebuilding anything.
   */
  receiver(): PskReceiver | null
  /** Stable per session; identifies this reporter behind a shared NAT address. */
  sessionId: number
  /** Read at send time, so changing the cadence takes effect immediately. */
  cadence?(): SendCadence
  now?(): number
  random?(): number
}

export interface SpotQueueStatus {
  pending: number
  lastSentAt: number | null
  lastSpotCount: number
  totalSpotsSent: number
  lastError: string | null
}

/** Conservative size of one sender record, matching the encoder's layout. */
function senderRecordBytes(spot: PskSpot): number {
  return spot.senderCallsign.length + spot.mode.length + (spot.locator?.length ?? 0) + 14
}

function receiverOverheadBytes(receiver: PskReceiver): number {
  const strings =
    receiver.callsign.length + receiver.locator.length + receiver.decoderSoftware.length +
    (receiver.antenna?.length ?? 0)
  // message header + both templates + receiver set header and padding
  return 16 + 112 + strings + 16
}

export class PskSpotQueue {
  private queue: PskSpot[] = []
  private reportedAt = new Map<string, number>()
  private sequence = 1
  private packetsSent = 0
  private templatesSentAt = 0
  private nextDueAt = 0
  private sending = false

  private lastSentAt: number | null = null
  private lastSpotCount = 0
  private totalSpotsSent = 0
  private lastError: string | null = null

  constructor(private readonly opts: SpotQueueOptions) {}

  private now(): number {
    return this.opts.now?.() ?? Date.now()
  }

  private random(): number {
    return this.opts.random?.() ?? Math.random()
  }

  private cadence(): SendCadence {
    return this.opts.cadence?.() ?? { mode: 'interval', minutes: DEFAULT_INTERVAL_MINUTES }
  }

  /**
   * Called when a decode window finishes. In window cadence this brings the
   * next send forward to just after the window, scattered so UTC-aligned
   * decoders do not all transmit on the same instant. Ignored otherwise.
   */
  notifyWindowComplete(): void {
    if (this.cadence().mode !== 'window') return
    const due = this.now() + this.random() * WINDOW_SEND_JITTER_MS
    if (due < this.nextDueAt) this.nextDueAt = due
  }

  /**
   * Queues a spot unless this callsign was already reported inside the dedup
   * window. Re-offering the same station from a later window is a duplicate by
   * design: the protocol wants one report per callsign per five minutes, not
   * one per decode.
   */
  offer(spot: PskSpot): OfferResult {
    const now = this.now()
    const key = spot.senderCallsign.toUpperCase()

    const last = this.reportedAt.get(key)
    if (last !== undefined && now - last < DEDUP_WINDOW_MS) return 'duplicate'
    if (this.queue.some((q) => q.senderCallsign.toUpperCase() === key)) return 'duplicate'

    this.queue.push(spot)
    if (this.queue.length > MAX_QUEUED) this.queue.splice(0, this.queue.length - MAX_QUEUED)
    return 'queued'
  }

  /** True when the queue has grown enough to justify sending ahead of schedule. */
  private isFull(receiver: PskReceiver): boolean {
    let total = receiverOverheadBytes(receiver)
    for (const spot of this.queue) {
      total += senderRecordBytes(spot)
      if (total > MAX_PACKET_BYTES) return true
    }
    return false
  }

  /** Greedily takes as many spots as fit in one packet; the rest wait. */
  private takeBatch(receiver: PskReceiver): PskSpot[] {
    const batch: PskSpot[] = []
    let total = receiverOverheadBytes(receiver)
    while (this.queue.length > 0) {
      const next = this.queue[0]
      const size = senderRecordBytes(next)
      if (batch.length > 0 && total + size > MAX_PACKET_BYTES) break
      total += size
      batch.push(this.queue.shift()!)
    }
    return batch
  }

  /**
   * Sends one packet if the cadence allows it (or the queue has filled up).
   * Resolves with the number of spots sent; 0 means nothing was due.
   */
  async flushIfDue(): Promise<number> {
    if (this.sending || this.queue.length === 0) return 0

    const receiver = this.opts.receiver()
    if (!receiver) return 0

    const now = this.now()
    if (now < this.nextDueAt && !this.isFull(receiver)) return 0

    const batch = this.takeBatch(receiver)
    if (batch.length === 0) return 0

    const includeTemplates =
      this.packetsSent < TEMPLATE_PRIMING_PACKETS || now - this.templatesSentAt >= TEMPLATE_REFRESH_MS

    const packet = buildPskReporterPacket({
      receiver,
      spots: batch,
      sequenceNumber: this.sequence,
      sessionId: this.opts.sessionId,
      sentAtSeconds: Math.floor(now / 1000),
      includeTemplates,
    })

    this.sending = true
    try {
      await this.opts.send(packet)
    } catch (err) {
      // Put them back at the front so nothing is lost, and try again sooner
      // than the normal cadence.
      this.queue.unshift(...batch)
      this.lastError = err instanceof Error ? err.message : String(err)
      this.nextDueAt = now + RETRY_INTERVAL_MS
      return 0
    } finally {
      this.sending = false
    }

    for (const spot of batch) this.reportedAt.set(spot.senderCallsign.toUpperCase(), now)
    this.pruneReported(now)

    this.sequence++
    this.packetsSent++
    if (includeTemplates) this.templatesSentAt = now
    this.lastSentAt = now
    this.lastSpotCount = batch.length
    this.totalSpotsSent += batch.length
    this.lastError = null

    const cadence = this.cadence()
    if (cadence.mode === 'window') {
      // Nothing is due until another window closes; notifyWindowComplete sets it.
      this.nextDueAt = Number.POSITIVE_INFINITY
    } else {
      const base = clampIntervalMinutes(cadence.minutes) * 60_000
      this.nextDueAt = now + base + (this.random() * 2 - 1) * SEND_JITTER_MS
    }

    return batch.length
  }

  private pruneReported(now: number): void {
    for (const [callsign, at] of this.reportedAt) {
      if (now - at >= DEDUP_WINDOW_MS) this.reportedAt.delete(callsign)
    }
  }

  status(): SpotQueueStatus {
    return {
      pending: this.queue.length,
      lastSentAt: this.lastSentAt,
      lastSpotCount: this.lastSpotCount,
      totalSpotsSent: this.totalSpotsSent,
      lastError: this.lastError,
    }
  }

  /** Drops everything — used when reporting is switched off. */
  reset(): void {
    this.queue = []
    this.reportedAt.clear()
    this.nextDueAt = 0
    this.lastError = null
  }
}
