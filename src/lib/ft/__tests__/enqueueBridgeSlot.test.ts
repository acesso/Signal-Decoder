// Tests for requeuing a message already staged in one of the bridge's TX
// slots — the cross-session resend path (see enqueueBridgeSlot's comment).
//
// The slot's message/label/Hz come back from the DEVICE
// (syncBridgeSlotsFromDevice -> /tx-status), which is what makes this work
// for a slot the current browser session never staged itself.
import { createFTTransmit } from '../useFTTransmit';

// The encode worker is constructed lazily on the first encode. Enqueuing
// starts one, so stub it out — these tests are about queue/slot bookkeeping,
// not DSP. Left permanently 'pending' (no message ever posted back), which is
// exactly the state a real entry sits in until its encode lands.
class StubWorker {
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  postMessage() { /* never replies — entry stays encodeStatus 'pending' */ }
  terminate() {}
  addEventListener() {}
  removeEventListener() {}
}

beforeAll(() => {
  (globalThis as unknown as { Worker: unknown }).Worker = StubWorker;
});

beforeEach(() => localStorage.clear());

function makeTx(sinkKind: 'speaker' | 'bridge' = 'bridge') {
  return createFTTransmit(
    () => 'FT8',
    () => 1500,        // panel's global Audio Hz
    () => 14_074_000,
    () => undefined,
    () => sinkKind,
    () => undefined,   // no bridge URL — keeps uploads out of these tests
  );
}

// Simulate what syncBridgeSlotsFromDevice() does after reading /tx-status:
// replace the slot table with what the device reports it holds.
function stageSlot(
  tx: ReturnType<typeof makeTx>,
  slot: number,
  message: string,
  label: string,
  audioHz: number,
) {
  const cur = tx.state().bridgeSlots.find(s => s.slot === slot)!;
  Object.assign(cur, { message, label, uploaded: true, audioHz });
}

describe('enqueueBridgeSlot', () => {
  it('queues a slot staged by a previous session, pinning its recorded Hz', () => {
    const tx = makeTx();
    stageSlot(tx, 2, 'CQ K1ABC EM48', 'CQ', 1234);

    expect(tx.enqueueBridgeSlot(2)).toBe(true);

    const q = tx.state().queue;
    expect(q).toHaveLength(1);
    expect(q[0].message).toBe('CQ K1ABC EM48');
    expect(q[0].label).toBe('CQ');
    // Pinned to what the slot was encoded at (1234), NOT the panel's
    // global Audio Hz (1500) — resending a staged message means that
    // message, not a copy retuned to wherever the marker sits now.
    expect(q[0].audioHz).toBe(1234);
  });

  it('refuses to queue an empty slot', () => {
    const tx = makeTx();
    expect(tx.enqueueBridgeSlot(1)).toBe(false);
    expect(tx.state().queue).toHaveLength(0);
  });

  it('refuses a slot marked uploaded but holding no message text', () => {
    const tx = makeTx();
    // Older firmware can report a ready slot without descriptive metadata;
    // there is no message to resend, so this must not queue a blank entry.
    stageSlot(tx, 0, '', '', 0);
    expect(tx.enqueueBridgeSlot(0)).toBe(false);
    expect(tx.state().queue).toHaveLength(0);
  });

  it('falls back to the panel Audio Hz when the slot records none', () => {
    const tx = makeTx();
    stageSlot(tx, 1, 'W9XYZ K1ABC 73', '73', 0);

    expect(tx.enqueueBridgeSlot(1)).toBe(true);
    // audioHz left undefined so the entry follows the global Audio Hz,
    // rather than pinning a bogus 0 Hz.
    expect(tx.state().queue[0].audioHz).toBeUndefined();
  });

  it('gives each requeue a distinct id so the same slot can be sent twice', () => {
    const tx = makeTx();
    stageSlot(tx, 3, 'CQ K1ABC EM48', 'CQ', 1500);

    tx.enqueueBridgeSlot(3);
    tx.enqueueBridgeSlot(3);

    const q = tx.state().queue;
    expect(q).toHaveLength(2);
    expect(q[0].id).not.toBe(q[1].id);
  });

  it('appends to the queue rather than jumping ahead of pending entries', () => {
    const tx = makeTx();
    stageSlot(tx, 2, 'CQ K1ABC EM48', 'CQ', 1500);
    tx.enqueue({ id: 'first', message: 'W9XYZ K1ABC EM48', label: 'reply' });

    tx.enqueueBridgeSlot(2);

    const q = tx.state().queue;
    expect(q.map(e => e.id)[0]).toBe('first');
    expect(q).toHaveLength(2);
  });

  it('leaves the slot itself staged and untouched', () => {
    const tx = makeTx();
    stageSlot(tx, 2, 'CQ K1ABC EM48', 'CQ', 1234);

    tx.enqueueBridgeSlot(2);

    // Requeuing sends a copy — it must not consume or clear the staged slot.
    const slot = tx.state().bridgeSlots.find(s => s.slot === 2)!;
    expect(slot.uploaded).toBe(true);
    expect(slot.message).toBe('CQ K1ABC EM48');
  });
});
