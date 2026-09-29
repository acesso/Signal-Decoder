// Sessions are independent decoders over the same audio, each tuned to its
// own signal. The behaviours worth pinning down are the ones where one
// session could wrongly affect another.
import { sessionsReducer, makeSession, type SessionsState } from '../sessions';
import type { RTTYConfig } from '../decoder';

const CONFIG: RTTYConfig = {
  centerFreq: 1000,
  carrierShift: 170,
  baudRate: 45.45,
  bitsPerChar: 5,
  parity: 'none',
  stopBits: 1.5,
  reverseShift: false,
};

function initial(): SessionsState {
  const s = makeSession(CONFIG);
  return { sessions: [s], activeSessionId: s.id };
}

describe('CLONE_SESSION', () => {
  it('copies the source config, including squelch', () => {
    let state = initial();
    const srcId = state.sessions[0].id;
    state = sessionsReducer(state, {
      type: 'UPDATE_CONFIG',
      id: srcId,
      patch: { squelch: 42, carrierShift: 850, reverseShift: true },
    });
    state = sessionsReducer(state, { type: 'CLONE_SESSION', id: srcId });

    expect(state.sessions).toHaveLength(2);
    const clone = state.sessions[1];
    expect(clone.config.squelch).toBe(42);
    expect(clone.config.carrierShift).toBe(850);
    expect(clone.config.reverseShift).toBe(true);
  });

  it('gives the clone its own identity', () => {
    let state = initial();
    const src = state.sessions[0];
    state = sessionsReducer(state, { type: 'CLONE_SESSION', id: src.id });
    const clone = state.sessions[1];
    expect(clone.id).not.toBe(src.id);
    // A distinct colour/label is what makes two decoders on similar
    // frequencies tellable apart at a glance.
    expect(clone.label).not.toBe(src.label);
  });

  it('does not copy decoded text', () => {
    let state = initial();
    const srcId = state.sessions[0].id;
    state = sessionsReducer(state, { type: 'APPEND_TEXT', id: srcId, chars: 'CQ CQ DE PU7FTW' });
    state = sessionsReducer(state, { type: 'CLONE_SESSION', id: srcId });

    // The clone never received that audio; inheriting the transcript would
    // claim it did.
    expect(state.sessions[1].fullText).toBe('');
    expect(state.sessions[1].preview).toBe('');
    expect(state.sessions[0].fullText).toBe('CQ CQ DE PU7FTW');
  });

  it('inserts the clone directly after its source', () => {
    let state = initial();
    state = sessionsReducer(state, { type: 'ADD_SESSION', config: CONFIG });
    const [first, second] = state.sessions;
    state = sessionsReducer(state, { type: 'CLONE_SESSION', id: first.id });

    expect(state.sessions.map((s) => s.id)).toEqual([first.id, state.sessions[1].id, second.id]);
  });

  it('leaves the active session alone', () => {
    let state = initial();
    const srcId = state.sessions[0].id;
    state = sessionsReducer(state, { type: 'CLONE_SESSION', id: srcId });
    // Cloning is a setup action, not a focus change — promoting the clone
    // would yank the operator away from what they were reading.
    expect(state.activeSessionId).toBe(srcId);
  });

  it('is a no-op for an unknown id', () => {
    const state = initial();
    expect(sessionsReducer(state, { type: 'CLONE_SESSION', id: 'nope' })).toBe(state);
  });

  it('decouples the clone from later edits to its source', () => {
    let state = initial();
    const srcId = state.sessions[0].id;
    state = sessionsReducer(state, { type: 'CLONE_SESSION', id: srcId });
    const cloneId = state.sessions[1].id;
    state = sessionsReducer(state, { type: 'UPDATE_CONFIG', id: srcId, patch: { squelch: 90 } });

    expect(state.sessions.find((s) => s.id === cloneId)!.config.squelch).toBeUndefined();
  });
});

describe('per-session squelch', () => {
  it('changes only the targeted session', () => {
    let state = initial();
    state = sessionsReducer(state, { type: 'ADD_SESSION', config: CONFIG });
    const [a, b] = state.sessions;
    state = sessionsReducer(state, { type: 'UPDATE_CONFIG', id: a.id, patch: { squelch: 60 } });

    expect(state.sessions.find((s) => s.id === a.id)!.config.squelch).toBe(60);
    // A threshold suiting a loud local station must not mute a weak one in
    // the next card.
    expect(state.sessions.find((s) => s.id === b.id)!.config.squelch).toBeUndefined();
  });
});
