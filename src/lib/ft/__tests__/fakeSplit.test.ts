// Regression tests for Fake Split's encode-time behavior (see
// doc/FAKE_SPLIT_AND_WINDOW_PARITY_DESIGN.md). Fake Split mirrors WSJT-X's
// real "Fake It" mechanism: TX audio is ALWAYS encoded at a FIXED sweet-spot
// tone (fakeSplitSweetSpotHz — independent of the operator's chosen Audio
// Hz / any per-entry pinned tone), and the operator's actual intended TX
// frequency is instead recovered as a VFO shift at TX time (runLoop, not
// exercised here — see the design doc's Sequencing section for why that
// part needs real hardware, not a unit test). This file pins the
// encode-time half: what actually gets baked into the waveform, and what
// fakeSplitEncodedHz records for the TX loop to later compute its delta
// against ((entry.audioHz ?? Audio Hz) - fakeSplitEncodedHz).
//
// An earlier, INCORRECT version of this feature conflated the sweet spot
// with the operator's own Audio Hz setting, which made the VFO delta
// always zero for ordinary (non-pinned-tone) traffic — silently defeating
// the whole feature. These tests exist specifically to catch a regression
// back to that state: the sweet spot and Audio Hz must be independent
// values, and the delta must be nonzero whenever they differ.
import { createFTTransmit, DEFAULT_FAKE_SPLIT_SWEET_SPOT_HZ } from '../useFTTransmit';

// Echoes the requested baseFrequency back as samples[0] so tests can assert
// exactly what tone the encoder was actually asked to produce, instead of
// just "some samples arrived."
class EchoWorker {
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  postMessage(data: { id: number; baseFrequency: number }) {
    const samples = new Float32Array([data.baseFrequency]);
    queueMicrotask(() => this.onmessage?.({ data: { id: data.id, samples } } as MessageEvent));
  }
  terminate() {}
  addEventListener() {}
  removeEventListener() {}
}

beforeAll(() => {
  (globalThis as unknown as { Worker: unknown }).Worker = EchoWorker;
});

beforeEach(() => localStorage.clear());

const PANEL_AUDIO_HZ = 500;   // deliberately far from the sweet spot default (1750)
const QSY_AUDIO_HZ = 2400;

function makeTx() {
  return createFTTransmit(
    () => 'FT8',
    () => PANEL_AUDIO_HZ,
    () => 14_074_000,
    () => undefined,   // no PTT setter needed for these encode-only tests
    () => undefined,   // no CAT frequency setter needed either
    () => 'speaker',
    () => undefined,
  );
}

async function waitForEncode(tx: ReturnType<typeof makeTx>, id: string) {
  for (let i = 0; i < 50; i++) {
    const entry = tx.state().queue.find(e => e.id === id);
    if (entry?.encodeStatus === 'ready') return entry;
    await new Promise(r => queueMicrotask(() => r(undefined)));
  }
  throw new Error(`entry ${id} never reached encodeStatus 'ready'`);
}

describe('Fake Split encode-time behavior', () => {
  it('off: a pinned-tone entry encodes at its own audioHz, not the panel Audio Hz', async () => {
    const tx = makeTx();
    tx.enqueue({ id: 'a', message: 'TEST MSG', label: 'reply', audioHz: QSY_AUDIO_HZ });
    const entry = await waitForEncode(tx, 'a');
    expect(entry.samples![0]).toBe(QSY_AUDIO_HZ);
    expect(entry.fakeSplitEncodedHz).toBeUndefined();
  });

  it('off: an entry with no pinned tone encodes at the panel Audio Hz', async () => {
    const tx = makeTx();
    tx.enqueue({ id: 'b', message: 'TEST MSG', label: 'cq' });
    const entry = await waitForEncode(tx, 'b');
    expect(entry.samples![0]).toBe(PANEL_AUDIO_HZ);
    expect(entry.fakeSplitEncodedHz).toBeUndefined();
  });

  it('on: a plain CQ (no pinned tone) encodes at the FIXED sweet spot, NOT the panel Audio Hz', async () => {
    const tx = makeTx();
    tx.setFakeSplit(true);
    tx.enqueue({ id: 'c', message: 'CQ TEST', label: 'cq' });
    const entry = await waitForEncode(tx, 'c');
    // This is the exact case the original buggy implementation got wrong:
    // sweet spot must NOT equal Audio Hz, or the VFO delta silently
    // collapses to zero for the most common kind of traffic.
    expect(entry.samples![0]).toBe(DEFAULT_FAKE_SPLIT_SWEET_SPOT_HZ);
    expect(entry.samples![0]).not.toBe(PANEL_AUDIO_HZ);
    expect(entry.fakeSplitEncodedHz).toBe(DEFAULT_FAKE_SPLIT_SWEET_SPOT_HZ);
  });

  it('on: a pinned-tone entry ALSO encodes at the sweet spot, but keeps its intended tone as data', async () => {
    const tx = makeTx();
    tx.setFakeSplit(true);
    tx.enqueue({ id: 'd', message: 'TEST MSG', label: 'reply', audioHz: QSY_AUDIO_HZ });
    const entry = await waitForEncode(tx, 'd');
    // The pinned intent must survive as data (audioHz), even though it's no
    // longer what got encoded — runLoop needs both values to compute the
    // VFO delta: (entry.audioHz ?? Audio Hz) - fakeSplitEncodedHz.
    expect(entry.audioHz).toBe(QSY_AUDIO_HZ);
    expect(entry.samples![0]).toBe(DEFAULT_FAKE_SPLIT_SWEET_SPOT_HZ);
    expect(entry.fakeSplitEncodedHz).toBe(DEFAULT_FAKE_SPLIT_SWEET_SPOT_HZ);
  });

  it('a configured (non-default) sweet spot is honored', async () => {
    const tx = makeTx();
    tx.setFakeSplitSweetSpotHz(1600);
    tx.setFakeSplit(true);
    tx.enqueue({ id: 'e', message: 'CQ TEST', label: 'cq' });
    const entry = await waitForEncode(tx, 'e');
    expect(entry.samples![0]).toBe(1600);
    expect(entry.fakeSplitEncodedHz).toBe(1600);
  });

  it('setFakeSplitSweetSpotHz clamps to the documented [300, 2800] Hz range', () => {
    const tx = makeTx();
    tx.setFakeSplitSweetSpotHz(50);
    expect(tx.state().fakeSplitSweetSpotHz).toBe(300);
    tx.setFakeSplitSweetSpotHz(5000);
    expect(tx.state().fakeSplitSweetSpotHz).toBe(2800);
  });

  it('persists fakeSplit and fakeSplitSweetSpotHz across a fresh createFTTransmit() call, like the other toggles', () => {
    const tx1 = makeTx();
    tx1.setFakeSplit(true);
    tx1.setFakeSplitSweetSpotHz(1600);
    const tx2 = makeTx();
    expect(tx2.state().fakeSplit).toBe(true);
    expect(tx2.state().fakeSplitSweetSpotHz).toBe(1600);
  });
});

describe('Fake Split — auto-CQ path (separate cache, was the second half of the original bug)', () => {
  // rebuildAutoCQCache() is a SEPARATE encode path from startEncode()/the
  // queue (auto-CQ never enters the queue — see its own comment), so the
  // sweet-spot fix above had to be applied there independently. Verified
  // indirectly via state().bridgeSlots: uploadIfBridgeSink()'s speaker-sink
  // branch records whatever `audioHz` it was called with directly into
  // bridgeSlots[TX_SLOT_AUTOCQ] (slot 0) even when nothing is actually
  // uploaded anywhere — see its own early-return comment — which exposes
  // rebuildAutoCQCache's private encodeHz choice without needing runLoop.
  const AUTOCQ_SLOT = 0;

  async function waitForAutoCQSlot(tx: ReturnType<typeof makeTx>) {
    for (let i = 0; i < 50; i++) {
      const slot = tx.state().bridgeSlots[AUTOCQ_SLOT];
      if (slot?.uploaded) return slot;
      await new Promise(r => queueMicrotask(() => r(undefined)));
    }
    throw new Error('auto-CQ slot never marked uploaded');
  }

  it('off: auto-CQ encodes at the panel Audio Hz', async () => {
    const tx = makeTx();
    tx.setAutoCQMessage('CQ TEST GRID');
    const slot = await waitForAutoCQSlot(tx);
    expect(slot.audioHz).toBe(PANEL_AUDIO_HZ);
  });

  it('on: auto-CQ encodes at the FIXED sweet spot, NOT the panel Audio Hz', async () => {
    const tx = makeTx();
    tx.setFakeSplit(true);
    tx.setAutoCQMessage('CQ TEST GRID');
    const slot = await waitForAutoCQSlot(tx);
    expect(slot.audioHz).toBe(DEFAULT_FAKE_SPLIT_SWEET_SPOT_HZ);
    expect(slot.audioHz).not.toBe(PANEL_AUDIO_HZ);
  });
});
