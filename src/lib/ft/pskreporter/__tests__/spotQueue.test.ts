import {
  PskSpotQueue,
  MIN_SEND_INTERVAL_MS,
  SEND_JITTER_MS,
  RETRY_INTERVAL_MS,
  MAX_PACKET_BYTES,
  WINDOW_SEND_JITTER_MS,
  clampIntervalMinutes,
  type SendCadence,
} from '../spotQueue';
import type { PskReceiver, PskSpot } from '../ipfix';

const RECEIVER: PskReceiver = {
  callsign: 'ZZ9TEST',
  locator: 'GG60',
  decoderSoftware: 'Signal-Decoder test',
};

function spot(callsign: string, overrides: Partial<PskSpot> = {}): PskSpot {
  return {
    senderCallsign: callsign,
    frequencyHz: 14074500,
    snrDb: -12,
    mode: 'FT8',
    locator: 'GG66',
    flowStartSeconds: 1790000000,
    ...overrides,
  };
}

/** A queue with a controllable clock and a send that records what it got. */
function harness(opts: {
  receiver?: () => PskReceiver | null;
  random?: () => number;
  cadence?: () => SendCadence;
} = {}) {
  let now = 1_000_000;
  const sent: Uint8Array[] = [];
  let fail: string | null = null;

  const queue = new PskSpotQueue({
    send: async (packet) => {
      if (fail) throw new Error(fail);
      sent.push(packet);
    },
    receiver: opts.receiver ?? (() => RECEIVER),
    sessionId: 0xdeadbeef,
    cadence: opts.cadence,
    now: () => now,
    random: opts.random ?? (() => 0.5),
  });

  return {
    queue,
    sent,
    advance: (ms: number) => { now += ms; },
    at: () => now,
    failWith: (message: string | null) => { fail = message; },
    /** First set id after the 16-byte header — 0x0003 when templates are present. */
    firstSetId: (packet: Uint8Array) => new DataView(packet.buffer, packet.byteOffset).getUint16(16),
  };
}

describe('PskSpotQueue', () => {
  describe('deduplication', () => {
    it('rejects a callsign already waiting in the queue', () => {
      const { queue } = harness();
      expect(queue.offer(spot('PY2ABC'))).toBe('queued');
      expect(queue.offer(spot('PY2ABC'))).toBe('duplicate');
      expect(queue.status().pending).toBe(1);
    });

    it('rejects a callsign reported within the last five minutes', async () => {
      const h = harness();
      h.queue.offer(spot('PY2ABC'));
      await h.queue.flushIfDue();

      h.advance(4 * 60_000);
      expect(h.queue.offer(spot('PY2ABC'))).toBe('duplicate');
    });

    it('accepts it again once the window has passed', async () => {
      const h = harness();
      h.queue.offer(spot('PY2ABC'));
      await h.queue.flushIfDue();

      h.advance(5 * 60_000 + 1);
      expect(h.queue.offer(spot('PY2ABC'))).toBe('queued');
    });

    it('is case-insensitive about callsigns', () => {
      const { queue } = harness();
      queue.offer(spot('PY2ABC'));
      expect(queue.offer(spot('py2abc'))).toBe('duplicate');
    });
  });

  describe('send cadence', () => {
    it('sends the first batch immediately', async () => {
      const h = harness();
      h.queue.offer(spot('PY2ABC'));
      expect(await h.queue.flushIfDue()).toBe(1);
      expect(h.sent).toHaveLength(1);
    });

    it('then holds off for five minutes', async () => {
      const h = harness();
      h.queue.offer(spot('PY2ABC'));
      await h.queue.flushIfDue();

      h.queue.offer(spot('K1ABC'));
      h.advance(MIN_SEND_INTERVAL_MS - 1000);
      expect(await h.queue.flushIfDue()).toBe(0);

      h.advance(2000);
      expect(await h.queue.flushIfDue()).toBe(1);
    });

    it('jitters the next send so reporters do not sync to the clock', async () => {
      // The protocol asks for this explicitly: without it every client in the
      // world would report on the same boundary.
      const early = harness({ random: () => 0 });
      early.queue.offer(spot('PY2ABC'));
      await early.queue.flushIfDue();
      early.queue.offer(spot('K1ABC'));
      early.advance(MIN_SEND_INTERVAL_MS - SEND_JITTER_MS);
      expect(await early.queue.flushIfDue()).toBe(1);

      const late = harness({ random: () => 1 });
      late.queue.offer(spot('PY2ABC'));
      await late.queue.flushIfDue();
      late.queue.offer(spot('K1ABC'));
      late.advance(MIN_SEND_INTERVAL_MS + SEND_JITTER_MS - 1000);
      expect(await late.queue.flushIfDue()).toBe(0);
    });

    it('sends early rather than overflowing a packet', async () => {
      const h = harness();
      h.queue.offer(spot('PY2ABC'));
      await h.queue.flushIfDue();

      // Nowhere near the five-minute mark, but the queue has filled up.
      h.advance(1000);
      for (let i = 0; i < 60; i++) h.queue.offer(spot(`K${i}ABC`));
      expect(await h.queue.flushIfDue()).toBeGreaterThan(0);
    });

    it('does nothing when there is nothing queued', async () => {
      const h = harness();
      expect(await h.queue.flushIfDue()).toBe(0);
      expect(h.sent).toHaveLength(0);
    });

    it('does nothing until a receiver is configured', async () => {
      const h = harness({ receiver: () => null });
      h.queue.offer(spot('PY2ABC'));
      expect(await h.queue.flushIfDue()).toBe(0);
      expect(h.queue.status().pending).toBe(1);
    });
  });

  describe('packet sizing', () => {
    it('splits a large backlog across packets instead of one oversized one', async () => {
      const h = harness();
      for (let i = 0; i < 120; i++) h.queue.offer(spot(`PY${i}ABC`));

      const first = await h.queue.flushIfDue();
      expect(first).toBeGreaterThan(0);
      expect(first).toBeLessThan(120);
      expect(h.sent[0].length).toBeLessThanOrEqual(MAX_PACKET_BYTES);
      expect(h.queue.status().pending).toBe(120 - first);
    });
  });

  describe('templates', () => {
    it('primes the first three packets with templates', async () => {
      const h = harness();
      for (let i = 0; i < 3; i++) {
        h.queue.offer(spot(`PY${i}ABC`));
        await h.queue.flushIfDue();
        h.advance(MIN_SEND_INTERVAL_MS + SEND_JITTER_MS);
      }
      for (const packet of h.sent) expect(h.firstSetId(packet)).toBe(0x0003);
    });

    it('drops them afterwards, then re-sends them hourly', async () => {
      const h = harness();
      for (let i = 0; i < 4; i++) {
        h.queue.offer(spot(`PY${i}ABC`));
        await h.queue.flushIfDue();
        h.advance(MIN_SEND_INTERVAL_MS + SEND_JITTER_MS);
      }
      expect(h.firstSetId(h.sent[3])).toBe(0x9992);

      h.advance(60 * 60_000);
      h.queue.offer(spot('K1ABC'));
      await h.queue.flushIfDue();
      expect(h.firstSetId(h.sent[4])).toBe(0x0003);
    });
  });

  describe('failure handling', () => {
    it('keeps the batch queued and retries sooner than the normal cadence', async () => {
      const h = harness();
      h.failWith('network down');
      h.queue.offer(spot('PY2ABC'));

      expect(await h.queue.flushIfDue()).toBe(0);
      expect(h.queue.status().pending).toBe(1);
      expect(h.queue.status().lastError).toBe('network down');

      h.failWith(null);
      h.advance(RETRY_INTERVAL_MS - 1000);
      expect(await h.queue.flushIfDue()).toBe(0);

      h.advance(2000);
      expect(await h.queue.flushIfDue()).toBe(1);
      expect(h.queue.status().lastError).toBeNull();
    });

    it('does not mark a failed callsign as reported', async () => {
      const h = harness();
      h.failWith('nope');
      h.queue.offer(spot('PY2ABC'));
      await h.queue.flushIfDue();

      // Still pending, so re-offering is a duplicate of the queued entry rather
      // than being silently swallowed as already-reported.
      expect(h.queue.status().pending).toBe(1);
    });
  });

  describe('status', () => {
    it('counts spots sent across packets', async () => {
      const h = harness();
      h.queue.offer(spot('PY2ABC'));
      h.queue.offer(spot('K1ABC'));
      await h.queue.flushIfDue();

      const status = h.queue.status();
      expect(status.totalSpotsSent).toBe(2);
      expect(status.lastSpotCount).toBe(2);
      expect(status.lastSentAt).toBe(h.at());
      expect(status.pending).toBe(0);
    });

    it('clears everything on reset', async () => {
      const h = harness();
      h.queue.offer(spot('PY2ABC'));
      h.queue.reset();
      expect(h.queue.status().pending).toBe(0);
      expect(await h.queue.flushIfDue()).toBe(0);
    });
  });
});

describe('send cadence', () => {
  it('clamps a configured interval into the supported range', () => {
    expect(clampIntervalMinutes(0)).toBe(1);
    expect(clampIntervalMinutes(500)).toBe(30);
    expect(clampIntervalMinutes(7.4)).toBe(7);
    expect(clampIntervalMinutes(NaN)).toBe(5);
  });

  it('honours a shorter configured interval', async () => {
    const h = harness({ cadence: () => ({ mode: 'interval', minutes: 1 }) });
    h.queue.offer(spot('PY2ABC'));
    await h.queue.flushIfDue();

    h.queue.offer(spot('K1ABC'));
    h.advance(60_000 + SEND_JITTER_MS);
    expect(await h.queue.flushIfDue()).toBe(1);
  });

  describe('window mode', () => {
    const windowCadence = () => ({ mode: 'window' }) as SendCadence;

    it('waits for a window to close rather than a timer', async () => {
      const h = harness({ cadence: windowCadence });
      h.queue.offer(spot('PY2ABC'));
      await h.queue.flushIfDue();

      h.queue.offer(spot('K1ABC'));
      // No timer will ever make this due — only a window can.
      h.advance(60 * 60_000);
      expect(await h.queue.flushIfDue()).toBe(0);

      h.queue.notifyWindowComplete();
      h.advance(WINDOW_SEND_JITTER_MS);
      expect(await h.queue.flushIfDue()).toBe(1);
    });

    it('scatters the send so clock-aligned decoders do not all upload at once', async () => {
      // FT windows are UTC-aligned, so without this every decoder in the world
      // would upload on the same instant.
      const h = harness({ cadence: windowCadence, random: () => 1 });
      h.queue.offer(spot('PY2ABC'));
      await h.queue.flushIfDue();

      h.queue.offer(spot('K1ABC'));
      h.queue.notifyWindowComplete();
      expect(await h.queue.flushIfDue()).toBe(0);

      h.advance(WINDOW_SEND_JITTER_MS);
      expect(await h.queue.flushIfDue()).toBe(1);
    });

    it('ignores window notifications while on an interval', async () => {
      const h = harness({ cadence: () => ({ mode: 'interval', minutes: 5 }) });
      h.queue.offer(spot('PY2ABC'));
      await h.queue.flushIfDue();

      h.queue.offer(spot('K1ABC'));
      h.queue.notifyWindowComplete();
      h.advance(WINDOW_SEND_JITTER_MS);
      expect(await h.queue.flushIfDue()).toBe(0);
    });

    it('still reports each station at most once per five minutes', async () => {
      // Window cadence changes how often packets go out, never how often a
      // given callsign may appear in them.
      const h = harness({ cadence: windowCadence });
      h.queue.offer(spot('PY2ABC'));
      await h.queue.flushIfDue();

      h.advance(15_000);
      expect(h.queue.offer(spot('PY2ABC'))).toBe('duplicate');

      h.advance(5 * 60_000);
      expect(h.queue.offer(spot('PY2ABC'))).toBe('queued');
    });
  });
});
