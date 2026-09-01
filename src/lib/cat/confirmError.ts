// Tracks whether the CURRENTLY displayed error was raised by a failed
// confirmedSet(), so a later success can clear it without ever wiping an
// unrelated error.
//
// The bug this fixes: every confirmedSet() caller set an error on failure, but
// nothing cleared it on a subsequent success. The only places that reset error
// were the initial state, disconnect() and a successful connect() — so one
// dropped frame on a busy Wi-Fi link left a red CAT banner up indefinitely,
// with disconnect/reconnect the only way to clear it. Notably a VFO change
// did NOT clear it: setFrequency() only ever writes error on failure, and the
// poll loop (which reads FA;/MD; back every tick) never touched error at all.
//
// Why a flag rather than matching the message text: connection-state errors
// ("CAT bridge connection lost", "Radio connection lost") describe a condition
// that is still true and own their own lifecycle via reconnect/connect. A
// successful confirm on some other command must never erase those, and text
// matching would be one refactor away from silently doing exactly that.
export function createConfirmErrorTracker(setError: (error: string | null) => void) {
  let active = false;
  return {
    /** Raise a confirm-failure error, and remember that we own it. */
    note(message: string) {
      active = true;
      setError(message);
    },
    /** Clear the error ONLY if it was one we raised. No-op otherwise. */
    clear() {
      if (!active) return;
      active = false;
      setError(null);
    },
    /** Drop ownership without touching the error (caller resets it itself). */
    forget() {
      active = false;
    },
    get isActive() { return active; },
  };
}
