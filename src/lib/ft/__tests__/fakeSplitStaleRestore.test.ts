// Regression tests for Fake Split's crash-recovery marker (see
// doc/FAKE_SPLIT_AND_WINDOW_PARITY_DESIGN.md and
// loadPendingFakeSplitRestoreHz's own comment in useFTTransmit.ts).
//
// The bug this closes: runLoop()'s pre-TX VFO retune kept the "what to
// restore afterward" value in a plain in-memory `let` (fakeSplitOriginalVfoHz),
// scoped to a single loop iteration. A page reload or crash between the
// retune and the restore silently lost that value forever, leaving the
// radio parked on a shifted frequency with zero on-disk trace of what the
// correct frequency was. These tests exercise the fix at its public
// boundary: createFTTransmit() reading a leftover localStorage marker into
// state on construction (simulating "app just reloaded, marker was left
// behind"), and the two operator-facing recovery actions.
import {
  createFTTransmit,
  loadPendingFakeSplitRestoreHz,
  savePendingFakeSplitRestoreHz,
  clearPendingFakeSplitRestoreHz,
} from '../useFTTransmit';

beforeEach(() => localStorage.clear());

const ORIGINAL_VFO_HZ = 14_074_000;

function makeTx(onSetFrequency?: (hz: number) => Promise<void>) {
  return createFTTransmit(
    () => 'FT8',
    () => 1850,
    () => ORIGINAL_VFO_HZ,
    () => undefined,        // no PTT setter needed for these tests
    () => onSetFrequency,   // CAT frequency setter — undefined unless a test needs it
    () => 'speaker',
    () => undefined,
  );
}

describe('Fake Split pending-restore marker (load/save/clear)', () => {
  it('is null when nothing was ever saved', () => {
    expect(loadPendingFakeSplitRestoreHz()).toBeNull();
  });

  it('round-trips through save/load', () => {
    savePendingFakeSplitRestoreHz(ORIGINAL_VFO_HZ);
    expect(loadPendingFakeSplitRestoreHz()).toBe(ORIGINAL_VFO_HZ);
  });

  it('clear removes it', () => {
    savePendingFakeSplitRestoreHz(ORIGINAL_VFO_HZ);
    clearPendingFakeSplitRestoreHz();
    expect(loadPendingFakeSplitRestoreHz()).toBeNull();
  });
});

describe('Fake Split stale-restore state surfacing', () => {
  it('a fresh createFTTransmit() has no stale-restore warning when nothing was left behind', () => {
    const tx = makeTx();
    expect(tx.state().fakeSplitStaleRestoreHz).toBeNull();
  });

  it('a leftover marker (simulating a reload mid-TX) is surfaced as fakeSplitStaleRestoreHz', () => {
    // Simulates: a previous session's runLoop() persisted this right
    // before retuning, then the page reloaded before the restore ran.
    savePendingFakeSplitRestoreHz(ORIGINAL_VFO_HZ);
    const tx = makeTx();
    expect(tx.state().fakeSplitStaleRestoreHz).toBe(ORIGINAL_VFO_HZ);
  });
});

describe('revertStaleFakeSplitVfo — one-click fix', () => {
  it('calls the CAT frequency setter with the leftover VFO and clears the marker on success', async () => {
    savePendingFakeSplitRestoreHz(ORIGINAL_VFO_HZ);
    const calls: number[] = [];
    const tx = makeTx(async (hz) => { calls.push(hz); });
    expect(tx.state().fakeSplitStaleRestoreHz).toBe(ORIGINAL_VFO_HZ);

    await tx.revertStaleFakeSplitVfo();

    expect(calls).toEqual([ORIGINAL_VFO_HZ]);
    expect(tx.state().fakeSplitStaleRestoreHz).toBeNull();
    expect(loadPendingFakeSplitRestoreHz()).toBeNull();
  });

  it('leaves the marker and warning in place if the CAT command fails', async () => {
    savePendingFakeSplitRestoreHz(ORIGINAL_VFO_HZ);
    const tx = makeTx(async () => { throw new Error('CAT not connected'); });

    await tx.revertStaleFakeSplitVfo();

    // Still there — the operator can retry, or fix it manually and dismiss.
    expect(tx.state().fakeSplitStaleRestoreHz).toBe(ORIGINAL_VFO_HZ);
    expect(loadPendingFakeSplitRestoreHz()).toBe(ORIGINAL_VFO_HZ);
  });

  it('is a no-op when there is no CAT frequency setter available', async () => {
    savePendingFakeSplitRestoreHz(ORIGINAL_VFO_HZ);
    const tx = makeTx(undefined);

    await tx.revertStaleFakeSplitVfo();

    // Nothing to call it with — must not silently clear the marker as if
    // it were fixed when nothing actually happened.
    expect(tx.state().fakeSplitStaleRestoreHz).toBe(ORIGINAL_VFO_HZ);
    expect(loadPendingFakeSplitRestoreHz()).toBe(ORIGINAL_VFO_HZ);
  });
});

describe('dismissStaleFakeSplitVfo — dismiss without reverting', () => {
  it('clears the marker and warning without touching CAT', () => {
    savePendingFakeSplitRestoreHz(ORIGINAL_VFO_HZ);
    let called = false;
    const tx = makeTx(async () => { called = true; });

    tx.dismissStaleFakeSplitVfo();

    expect(called).toBe(false);
    expect(tx.state().fakeSplitStaleRestoreHz).toBeNull();
    expect(loadPendingFakeSplitRestoreHz()).toBeNull();
  });
});
