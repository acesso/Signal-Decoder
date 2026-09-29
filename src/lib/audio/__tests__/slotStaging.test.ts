// Staging holds an encoded message in one of the bridge's 4 TX slots until
// the operator explicitly sends it. The behaviours worth pinning down are the
// ones that could put the wrong audio on the air, or lose a message the
// operator deliberately staged.
import { createRoot } from 'solid-js';
import { createSlotStaging } from '../slotStaging';

const WS_URL = 'ws://10.0.0.5:80/ws';

function samples(n = 800): Float32Array {
  return new Float32Array(n);
}

/** Minimal bridge: accepts uploads, reports slots ready, plays once. */
function mockBridge() {
  const uploaded: { slot: number; label: string | null; message: string | null }[] = [];
  let playing: number | null = null;
  const fetchMock = jest.fn((url: string, init?: RequestInit) => {
    const u = new URL(url);
    if (u.pathname === '/tx-audio') {
      uploaded.push({
        slot: Number(u.searchParams.get('slot')),
        label: u.searchParams.get('label'),
        message: u.searchParams.get('message'),
      });
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as unknown as Response);
    }
    if (u.pathname === '/tx-play') {
      playing = Number(u.searchParams.get('slot'));
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ duration_ms: 10 }) } as unknown as Response);
    }
    if (u.pathname === '/tx-stop') {
      playing = null;
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as unknown as Response);
    }
    if (u.pathname === '/tx-status') {
      // Report the play as already in flight, then finished, so
      // playBridgeSlotAndWait's startup-race guard is satisfied.
      const wasPlaying = playing;
      playing = null;
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ playing: wasPlaying !== null, playing_slot: wasPlaying ?? -1, slots: [] }),
      } as unknown as Response);
    }
    if (u.pathname === '/tx-clear') {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as unknown as Response);
    }
    throw new Error(`unexpected ${u.pathname} (${init?.method})`);
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return { uploaded, fetchMock };
}

function makeStaging(getWsUrl: () => string | undefined = () => WS_URL) {
  return createSlotStaging<string>({
    getWsUrl,
    mode: 'RTTY',
    getGain: () => 1,
    encode: async (text: string) => ({ samples: samples(text.length * 100), sampleRateHz: 8000 }),
  });
}

describe('createSlotStaging', () => {
  beforeEach(() => jest.restoreAllMocks());

  // Note: bridgeSlots' hash cache is module-level and keyed by bridge URL,
  // so it deliberately outlives any one staging instance (that is what lets a
  // reconnect skip re-uploading content the device already holds). Tests
  // therefore assert against the slot stage() actually resolved to, not a
  // hardcoded index — identical audio legitimately dedupes to an existing
  // slot rather than occupying a second one.

  it('stages into the first free slot and tags it with the owning mode', async () => {
    const { uploaded } = mockBridge();
    await createRoot(async (dispose) => {
      const s = makeStaging();
      const res = await s.stage('CQ TEST', 'CQ TEST', 'CQ TEST');
      expect(res).toEqual({ ok: true, slot: 0 });
      expect(uploaded[0].slot).toBe(0);
      // The mode tag is what stops another mode reusing this slot.
      expect(uploaded[0].label).toBe('RTTY · CQ TEST');
      expect(s.slots()[0].phase).toBe('ready');
      expect(s.slots()[0].mode).toBe('RTTY');
      expect(s.slots()[0].description).toBe('CQ TEST');
      dispose();
    });
  });

  it('fills successive slots rather than overwriting the first', async () => {
    mockBridge();
    await createRoot(async (dispose) => {
      const s = makeStaging();
      // Distinct text per stage: identical audio would be deduplicated by
      // uploadToBridgeSlot's content-addressed reuse, which is a separate
      // behaviour from allocation.
      expect((await s.stage('A', 'A', 'A')).slot).toBe(0);
      expect((await s.stage('BB', 'BB', 'BB')).slot).toBe(1);
      expect((await s.stage('CCC', 'CCC', 'CCC')).slot).toBe(2);
      expect(s.slots().filter(x => x.uploaded)).toHaveLength(3);
      dispose();
    });
  });

  it('refuses to stage into a full pool instead of clobbering a staged message', async () => {
    mockBridge();
    await createRoot(async (dispose) => {
      const s = makeStaging();
      for (const t of ['A', 'BB', 'CCC', 'DDDD']) await s.stage(t, t, t);
      const res = await s.stage('EEEEE', 'EEEEE', 'EEEEE');
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/full/i);
      // Nothing already staged was disturbed.
      expect(s.slots().filter(x => x.uploaded)).toHaveLength(4);
      expect(s.slots()[0].message).toBe('A');
      dispose();
    });
  });

  it('reports a missing bridge rather than pretending to stage', async () => {
    mockBridge();
    await createRoot(async (dispose) => {
      const s = makeStaging(() => undefined);
      const res = await s.stage('A', 'A', 'A');
      expect(res.ok).toBe(false);
      expect(s.slots().every(x => !x.uploaded)).toBe(true);
      dispose();
    });
  });

  it('leaves a slot empty when encoding fails', async () => {
    mockBridge();
    await createRoot(async (dispose) => {
      const s = createSlotStaging<string>({
        getWsUrl: () => WS_URL,
        mode: 'RTTY',
        getGain: () => 1,
        encode: () => Promise.reject(new Error('bad char')),
      });
      const res = await s.stage('x', 'x', 'x');
      expect(res.ok).toBe(false);
      expect(s.error()).toBe('bad char');
      expect(s.slots()[0].uploaded).toBe(false);
      expect(s.slots()[0].phase).toBe('empty');
      dispose();
    });
  });

  it('keeps a slot staged after sending it, so it can be sent again', async () => {
    mockBridge();
    await createRoot(async (dispose) => {
      const s = makeStaging();
      const staged = await s.stage('CQ-resend', 'CQ-resend', 'CQ-resend');
      const slot = staged.slot!;
      const ok = await s.send(slot);
      expect(ok).toBe(true);
      // A contest operator sends the same exchange repeatedly — playing a
      // slot must not consume it.
      expect(s.slots()[slot].phase).toBe('ready');
      expect(s.slots()[slot].uploaded).toBe(true);
      dispose();
    });
  });

  it('clears a slot on the device, not just locally', async () => {
    const { fetchMock } = mockBridge();
    await createRoot(async (dispose) => {
      const s = makeStaging();
      const staged = await s.stage('CQ-clear', 'CQ-clear', 'CQ-clear');
      const slot = staged.slot!;
      await s.clear(slot);
      expect(s.slots()[slot].uploaded).toBe(false);
      expect(s.slots()[slot].mode).toBeNull();
      // Without the real /tx-clear the device would still play stale audio.
      const cleared = fetchMock.mock.calls.some(([u]) => String(u).includes('/tx-clear'));
      expect(cleared).toBe(true);
      dispose();
    });
  });

  it('stops playback on the device', async () => {
    const { fetchMock } = mockBridge();
    await createRoot(async (dispose) => {
      const s = makeStaging();
      await s.stopPlayback();
      expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/tx-stop'))).toBe(true);
      dispose();
    });
  });
});
