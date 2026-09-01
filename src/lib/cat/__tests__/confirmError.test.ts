/**
 * Tests for the CAT confirm-error lifecycle (createConfirmErrorTracker).
 *
 * The reported bug: after "Could not confirm the radio keyed TX — CAT link
 * may be unreliable.", the banner never went away. Changing the VFO didn't
 * clear it — not from the panel, and not by retuning on the radio itself —
 * leaving disconnect/reconnect (or a page reload) as the only recovery.
 *
 * Cause: every confirmedSet() caller wrote error on failure and nothing ever
 * cleared it on success. setFrequency() only touches error when a confirm
 * FAILS, and the poll loop that reads FA;/MD; back every tick never touched
 * error at all — so nothing about a healthy link could retire the message.
 */
import { createConfirmErrorTracker } from '../confirmError';

// Mirrors the hook: the tracker owns the flag, setState owns the display.
function harness() {
  let error: string | null = null;
  const t = createConfirmErrorTracker(e => { error = e; });
  return { t, err: () => error };
}

const TX_ERR = 'Could not confirm the radio keyed TX — CAT link may be unreliable.';

describe('confirm-error tracker', () => {
  it('REGRESSION: a later success clears a stale confirm banner', () => {
    const { t, err } = harness();
    t.note(TX_ERR);
    expect(err()).toBe(TX_ERR);

    // What a VFO change (or any successful poll tick) now does.
    t.clear();
    expect(err()).toBeNull();
  });

  it('clear() is a no-op when no confirm error is outstanding', () => {
    const { t, err } = harness();
    // A successful poll on a healthy link must not thrash state by writing
    // null over and over — and must not clear errors it does not own.
    t.clear();
    expect(err()).toBeNull();
    expect(t.isActive).toBe(false);
  });

  it('does NOT clear an error it did not raise (connection loss survives)', () => {
    let error: string | null = null;
    const t = createConfirmErrorTracker(e => { error = e; });

    // Connection-loss errors are written directly by the read loop, not
    // through the tracker — they describe a condition that is still true.
    error = 'CAT bridge connection lost — reconnecting automatically...';

    t.clear();
    expect(error).toBe('CAT bridge connection lost — reconnecting automatically...');
  });

  it('re-raising after a clear works (a genuinely flaky link)', () => {
    const { t, err } = harness();
    t.note(TX_ERR);
    t.clear();
    expect(err()).toBeNull();

    t.note(TX_ERR);
    expect(err()).toBe(TX_ERR);
    expect(t.isActive).toBe(true);
  });

  it('forget() drops ownership without clearing the displayed error', () => {
    const { t, err } = harness();
    t.note(TX_ERR);

    // Used by connect()/disconnect()/dismissError(), which reset error
    // themselves as part of a larger setState — forget() must not fight them.
    t.forget();
    expect(err()).toBe(TX_ERR);
    expect(t.isActive).toBe(false);

    // And having forgotten, a later success must not clear anything.
    t.clear();
    expect(err()).toBe(TX_ERR);
  });

  it('a second failure overwrites the message but keeps ownership', () => {
    const { t, err } = harness();
    t.note(TX_ERR);
    t.note('Mode change to USB was not confirmed by the radio — link may be unreliable.');
    expect(err()).toContain('Mode change');
    expect(t.isActive).toBe(true);

    t.clear();
    expect(err()).toBeNull();
  });
});
