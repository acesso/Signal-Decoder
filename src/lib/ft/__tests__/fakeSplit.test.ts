// Regression tests for Fake Split's encode-time behavior (see
// doc/FAKE_SPLIT_AND_WINDOW_PARITY_DESIGN.md): when Fake Split is on, every
// entry must be ENCODED at the panel's Audio Hz (the "sweet spot"), never at
// a per-entry QSY audioHz — that offset is meant to be recovered as a VFO
// delta at TX time instead (runLoop, not exercised here — see the design
// doc's Sequencing section for why that part needs real hardware, not a
// unit test). This file only pins the encode-time half: what actually gets
// baked into the waveform, and what fakeSplitEncodedHz records for the TX
// loop to later compute its delta against.
import { createFTTransmit } from '../useFTTransmit';

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

const PANEL_AUDIO_HZ = 1850;
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
  it('off: a QSY entry encodes at its own pinned audioHz, not the panel Audio Hz', async () => {
    const tx = makeTx();
    tx.enqueue({ id: 'a', message: 'TEST MSG', label: 'reply', audioHz: QSY_AUDIO_HZ });
    const entry = await waitForEncode(tx, 'a');
    expect(entry.samples![0]).toBe(QSY_AUDIO_HZ);
    expect(entry.fakeSplitEncodedHz).toBeUndefined();
  });

  it('off: an entry with no pinned audioHz encodes at the panel Audio Hz', async () => {
    const tx = makeTx();
    tx.enqueue({ id: 'b', message: 'TEST MSG', label: 'cq' });
    const entry = await waitForEncode(tx, 'b');
    expect(entry.samples![0]).toBe(PANEL_AUDIO_HZ);
    expect(entry.fakeSplitEncodedHz).toBeUndefined();
  });

  it('on: a QSY entry still encodes at the panel Audio Hz, not its pinned audioHz', async () => {
    const tx = makeTx();
    tx.setFakeSplit(true);
    tx.enqueue({ id: 'c', message: 'TEST MSG', label: 'reply', audioHz: QSY_AUDIO_HZ });
    const entry = await waitForEncode(tx, 'c');
    // The QSY intent must survive as data (audioHz), even though it's no
    // longer what got encoded — runLoop needs both values to compute the
    // VFO delta later.
    expect(entry.audioHz).toBe(QSY_AUDIO_HZ);
    expect(entry.samples![0]).toBe(PANEL_AUDIO_HZ);
    expect(entry.fakeSplitEncodedHz).toBe(PANEL_AUDIO_HZ);
  });

  it('on: a plain CQ entry (no QSY) also encodes at the panel Audio Hz, with fakeSplitEncodedHz recorded', async () => {
    const tx = makeTx();
    tx.setFakeSplit(true);
    tx.enqueue({ id: 'd', message: 'CQ TEST', label: 'cq' });
    const entry = await waitForEncode(tx, 'd');
    expect(entry.samples![0]).toBe(PANEL_AUDIO_HZ);
    expect(entry.fakeSplitEncodedHz).toBe(PANEL_AUDIO_HZ);
  });

  it('persists across a fresh createFTTransmit() call via localStorage, like the other toggles', () => {
    const tx1 = makeTx();
    tx1.setFakeSplit(true);
    const tx2 = makeTx();
    expect(tx2.state().fakeSplit).toBe(true);
  });
});
