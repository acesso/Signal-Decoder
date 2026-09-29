// Under the bridge sink, RTTY audio must reach the DEVICE, never the local
// speakers — in I/Q operation the radio is not on the computer's output at
// all, so anything played locally is silently off the air. These pin the
// guards that enforce that, independently of whatever the panel's UI
// happens to disable.
import { createRoot } from 'solid-js';
import { createRTTYTransmit } from '../useRTTYTransmit';
import type { RTTYConfig } from '../decoder';

const WS_URL = 'ws://10.0.0.5:80/ws';

const CONFIG: RTTYConfig = {
  centerFreq: 1500,
  carrierShift: 170,
  baudRate: 45.45,
  bitsPerChar: 5,
  parity: 'none',
  stopBits: 1.5,
  reverseShift: false,
};

// jsdom provides no Worker. The FSK encoding itself is pure and covered
// directly by encoder.test.ts, so this stands in for the worker round-trip
// and lets these tests exercise what they are actually about: where the
// audio goes, and what keys the radio.
class StubWorker {
  onmessage: ((e: MessageEvent) => void) | null = null;
  postMessage(data: { id: number; text: string }) {
    const samples = new Float32Array(Math.max(1, data.text.length) * 100);
    queueMicrotask(() => this.onmessage?.({ data: { id: data.id, samples, dropped: [] } } as MessageEvent));
  }
  terminate() { /* nothing to tear down */ }
}

/** Accepts uploads and reports a play that starts then finishes. */
function mockBridge() {
  const posted: string[] = [];
  let playing: number | null = null;
  const fetchMock = jest.fn((url: string) => {
    const u = new URL(url);
    posted.push(u.pathname);
    if (u.pathname === '/tx-play') {
      playing = Number(u.searchParams.get('slot'));
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ duration_ms: 5 }) } as unknown as Response);
    }
    if (u.pathname === '/tx-status') {
      const was = playing;
      playing = null;
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ playing: was !== null, playing_slot: was ?? -1, slots: [] }),
      } as unknown as Response);
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as unknown as Response);
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return { posted };
}

describe('RTTY bridge sink', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    localStorage.clear();
    // Any local playback path would need Web Audio; leaving it undefined
    // means a test that accidentally takes that path fails loudly rather
    // than quietly "succeeding" with audio sent nowhere useful.
    // @ts-expect-error — deliberately absent
    delete global.AudioContext;
    global.Worker = StubWorker as unknown as typeof Worker;
  });

  it('stages instead of playing locally when encodeAndTransmit is called on the bridge', async () => {
    const { posted } = mockBridge();
    await createRoot(async (dispose) => {
      const tx = createRTTYTransmit(undefined, () => WS_URL);
      tx.setAudioSink('bridge');
      await tx.encodeAndTransmit('CQ TEST DE PU7FTW', CONFIG);
      // Reached the device, not an AudioContext.
      expect(posted).toContain('/tx-audio');
      expect(tx.bridgeSlots().some((s) => s.uploaded)).toBe(true);
      dispose();
    });
  });

  it('refuses live keying on the bridge and says why', async () => {
    mockBridge();
    await createRoot(async (dispose) => {
      const tx = createRTTYTransmit(undefined, () => WS_URL);
      tx.setAudioSink('bridge');
      await tx.startLive();
      // A slot is a complete buffer, so there is nothing to key into.
      expect(tx.state().error).toMatch(/live keying is unavailable/i);
      expect(tx.state().live).toBe(false);
      dispose();
    });
  });

  it('keys PTT around a staged send, and unkeys afterwards', async () => {
    mockBridge();
    const ptt: boolean[] = [];
    await createRoot(async (dispose) => {
      const tx = createRTTYTransmit(() => async (on: boolean) => { ptt.push(on); }, () => WS_URL);
      tx.setAudioSink('bridge');
      tx.setAutoPTT(true);
      const staged = await tx.stageToBridge('CQ DE PU7FTW', CONFIG);
      expect(staged).toBe(true);
      const slot = tx.bridgeSlots().find((s) => s.uploaded)!.slot;
      await tx.sendStagedSlot(slot);
      expect(ptt).toEqual([true, false]);
      dispose();
    });
  });

  it('does not key PTT merely for staging — staging puts nothing on the air', async () => {
    mockBridge();
    const ptt: boolean[] = [];
    await createRoot(async (dispose) => {
      const tx = createRTTYTransmit(() => async (on: boolean) => { ptt.push(on); }, () => WS_URL);
      tx.setAudioSink('bridge');
      tx.setAutoPTT(true);
      await tx.stageToBridge('CQ DE PU7FTW', CONFIG);
      expect(ptt).toEqual([]);
      dispose();
    });
  });

  it('stops device playback, not just local state', async () => {
    const { posted } = mockBridge();
    await createRoot(async (dispose) => {
      const tx = createRTTYTransmit(undefined, () => WS_URL);
      tx.setAudioSink('bridge');
      tx.stop();
      // Without this the ESP32 transmits to the end of its buffer while the
      // browser believes it has stopped.
      expect(posted).toContain('/tx-stop');
      dispose();
    });
  });

  it('persists the chosen sink across sessions', async () => {
    mockBridge();
    await createRoot(async (dispose) => {
      createRTTYTransmit(undefined, () => WS_URL).setAudioSink('bridge');
      dispose();
    });
    await createRoot(async (dispose) => {
      expect(createRTTYTransmit(undefined, () => WS_URL).state().audioSink).toBe('bridge');
      dispose();
    });
  });
});
