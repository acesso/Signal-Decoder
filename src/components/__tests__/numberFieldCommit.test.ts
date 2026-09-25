// Regression guard for a field that could not be typed into.
//
// NumberField commits on every keystroke by default. That is fine when the
// setter accepts what it is given, but the Fake Split "Sweet Spot" setter
// CLAMPS to a 300Hz minimum — so typing the first digit of "1000" committed
// 1, the setter clamped it to 300, and state pushed 300 straight back into
// the input. The operator could never get past one character.
//
// These test the commit TIMING rule directly rather than mounting Solid:
// the bug was entirely about when onCommit fires relative to typing.

/** Mirrors NumberField's handlers: per-keystroke by default, deferred to
 *  blur/Enter when commitOnBlur is set. */
function simulateTyping(opts: { commitOnBlur: boolean; keystrokes: string[]; clampMin: number }) {
  const { commitOnBlur, keystrokes, clampMin } = opts;
  const commits: number[] = [];
  let displayed = '';
  // The setter clamps and the clamped value is pushed back into the field —
  // this is what made the bug unrecoverable rather than merely annoying.
  const onCommit = (n: number) => {
    const clamped = Math.max(clampMin, Math.round(n));
    commits.push(clamped);
    displayed = String(clamped);
  };
  for (const k of keystrokes) {
    displayed += k;
    if (!commitOnBlur) {
      const parsed = parseFloat(displayed);
      if (Number.isFinite(parsed)) onCommit(parsed);
    }
  }
  if (commitOnBlur) {
    const parsed = parseFloat(displayed);
    if (Number.isFinite(parsed)) onCommit(parsed);
  }
  return { commits, finalValue: commits[commits.length - 1] };
}

describe('NumberField commit timing with a clamping setter', () => {
  const KEYS = ['1', '0', '0', '0']; // the operator types "1000"

  it('reproduces the bug: per-keystroke commits fight the typist', () => {
    const r = simulateTyping({ commitOnBlur: false, keystrokes: KEYS, clampMin: 300 });
    // The very first digit is clamped to 300 and written back, so every
    // subsequent keystroke appends to "300" instead of to "1".
    expect(r.commits[0]).toBe(300);
    expect(r.finalValue).not.toBe(1000);
  });

  it('commitOnBlur lets the full value be typed', () => {
    const r = simulateTyping({ commitOnBlur: true, keystrokes: KEYS, clampMin: 300 });
    expect(r.commits).toHaveLength(1); // exactly one commit, at the end
    expect(r.finalValue).toBe(1000);
  });

  it('still enforces the bound — deferring the commit does not bypass it', () => {
    // Typing something genuinely below the minimum is still clamped; only
    // the MOMENT of clamping moved.
    const r = simulateTyping({ commitOnBlur: true, keystrokes: ['5', '0'], clampMin: 300 });
    expect(r.finalValue).toBe(300);
  });

  it('is unaffected for a setter whose minimum is 0', () => {
    // Pre-key/Post-key clamp to 0, so per-keystroke commits never fought
    // typing — which is why only the min>0 fields needed changing.
    const r = simulateTyping({ commitOnBlur: false, keystrokes: ['1', '5', '0'], clampMin: 0 });
    expect(r.finalValue).toBe(150);
  });
});
