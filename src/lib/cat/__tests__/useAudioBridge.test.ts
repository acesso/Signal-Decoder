/**
 * Unit tests for useAudioBridge.ts's MicOwner conflict-resolution rules
 * (micStartConflicts/micStopAllowed). Pure logic, no AudioContext/WebSocket
 * mocking needed — the rest of the hook is Web Audio glue exercised far
 * more meaningfully by manual hardware testing than by a jsdom mock of
 * AudioWorkletNode/MediaStreamAudioDestinationNode/WebSocket.
 *
 * What these two functions exist to prevent: the Bridge panel's own "Send
 * Mic to Radio" button and FT8 TX's "ESP32 Bridge" output option both call
 * startMic()/stopMic() on the SAME shared useAudioBridge instance (one
 * bridge connection per app). Without this, whichever caller stops first
 * would silently kill the other's audio session too.
 */

import { micStartConflicts, micStopAllowed, makeResampleState, resampleLinear, type MicOwner } from '../useAudioBridge';

describe('micStartConflicts', () => {
  it('allows starting when nothing is active', () => {
    expect(micStartConflicts(false, null, 'manual')).toBe(false);
    expect(micStartConflicts(false, null, 'ft8-tx')).toBe(false);
  });

  it('allows the SAME owner to start again while already active (idempotent re-start)', () => {
    expect(micStartConflicts(true, 'manual', 'manual')).toBe(false);
    expect(micStartConflicts(true, 'ft8-tx', 'ft8-tx')).toBe(false);
  });

  it('blocks a DIFFERENT owner from starting while active', () => {
    expect(micStartConflicts(true, 'manual', 'ft8-tx')).toBe(true);
    expect(micStartConflicts(true, 'ft8-tx', 'manual')).toBe(true);
  });

  it('is not fooled by a stale owner once micActive is false', () => {
    // e.g. the session naturally ended (bridge disconnected) but the last
    // known owner tag hasn't been cleared for some reason — inactive means
    // inactive, a fresh start should never be blocked by a stale owner.
    expect(micStartConflicts(false, 'manual', 'ft8-tx')).toBe(false);
    expect(micStartConflicts(false, 'ft8-tx', 'manual')).toBe(false);
  });
});

describe('micStopAllowed', () => {
  it('allows an unconditional stop (no requiredOwner) regardless of current owner', () => {
    expect(micStopAllowed(null)).toBe(true);
    expect(micStopAllowed('manual')).toBe(true);
    expect(micStopAllowed('ft8-tx')).toBe(true);
  });

  it('allows a stop when the requiredOwner matches the current owner', () => {
    expect(micStopAllowed('manual', 'manual')).toBe(true);
    expect(micStopAllowed('ft8-tx', 'ft8-tx')).toBe(true);
  });

  it('blocks a stop when the requiredOwner does NOT match the current owner', () => {
    // This is the core guarantee: FT8 TX switching its sink away from
    // "bridge" must not kill a manual "Send Mic to Radio" session, and
    // vice versa.
    expect(micStopAllowed('manual', 'ft8-tx')).toBe(false);
    expect(micStopAllowed('ft8-tx', 'manual')).toBe(false);
  });

  it('blocks an owned stop request when nothing is actually active', () => {
    expect(micStopAllowed(null, 'manual')).toBe(false);
    expect(micStopAllowed(null, 'ft8-tx')).toBe(false);
  });
});

describe('start/stop symmetry', () => {
  // The two functions should agree: whoever is allowed to "win" a start
  // conflict should also be the only one allowed to stop it.
  it.each<MicOwner>(['manual', 'ft8-tx'])('owner %s can stop what it started, the other owner cannot', (owner) => {
    const other: MicOwner = owner === 'manual' ? 'ft8-tx' : 'manual';
    // owner starts a fresh session
    expect(micStartConflicts(false, null, owner)).toBe(false);
    // now active, held by `owner`
    expect(micStopAllowed(owner, owner)).toBe(true);
    expect(micStopAllowed(owner, other)).toBe(false);
    // the other owner trying to start while `owner` holds it is blocked
    expect(micStartConflicts(true, owner, other)).toBe(true);
  });
});

describe('resampleLinear with a carried ResampleState', () => {
  // Real bug, found via real hardware: mic capture hands resampleLinear()
  // one 2048-sample chunk at a time (see startMic() in useAudioBridge.ts).
  // Calling it fresh per chunk (no state) throws away the fractional
  // sample position AND the true next sample just past each chunk boundary
  // — the ESP32 control page's mic-sniff waterfall showed this as dense
  // periodic broadband stripes at a strict, regular cadence (the same
  // synthesized tone played back locally, no resampling involved, was
  // clean). These tests assert the carried-state version produces a
  // continuous stream indistinguishable from one long resample, rather
  // than reasserting a specific numeric output (which would be tied to
  // this exact algorithm's internals).

  function chunk(samples: number[]): Float32Array {
    return new Float32Array(samples);
  }

  it('is a no-op passthrough when fromRate === toRate, state included', () => {
    const state = makeResampleState();
    const input = chunk([1, 2, 3, 4]);
    const out = resampleLinear(input, 8000, 8000, state);
    expect(Array.from(out)).toEqual([1, 2, 3, 4]);
  });

  it('resampling one long buffer in one call matches resampling it as two state-carried chunks', () => {
    // A ramp is the simplest signal where any boundary discontinuity is
    // immediately visible as a break in the otherwise-constant slope.
    const fromRate = 48000;
    const toRate = 8000; // exact integer ratio (6) — the case that broke hardest without state, see useAudioBridge.ts's ResampleState comment
    const full: number[] = [];
    for (let i = 0; i < 4096; i++) full.push(i);

    const wholeState = makeResampleState();
    const whole = resampleLinear(chunk(full), fromRate, toRate, wholeState);

    const chunkedState = makeResampleState();
    const part1 = resampleLinear(chunk(full.slice(0, 2048)), fromRate, toRate, chunkedState);
    const part2 = resampleLinear(chunk(full.slice(2048)), fromRate, toRate, chunkedState);
    const chunked = Float32Array.from([...part1, ...part2]);

    expect(chunked.length).toBe(whole.length);
    for (let i = 0; i < whole.length; i++) {
      expect(chunked[i]).toBeCloseTo(whole[i], 5);
    }
  });

  it('has no discontinuity at a chunk boundary for a smooth signal (the actual regression)', () => {
    // Same scenario as the real hardware bug: many 2048-sample chunks of a
    // sine tone, fed through resampleLinear() one at a time with one
    // shared state, exactly like startMic()'s createCaptureNode() callback.
    const fromRate = 48000;
    const toRate = 8000;
    const freq = 1200;
    const chunkLen = 2048;
    const numChunks = 10;

    const state = makeResampleState();
    const outChunks: Float32Array[] = [];
    let t = 0;
    for (let c = 0; c < numChunks; c++) {
      const input = new Float32Array(chunkLen);
      for (let i = 0; i < chunkLen; i++) {
        input[i] = Math.sin((2 * Math.PI * freq * t) / fromRate);
        t++;
      }
      outChunks.push(resampleLinear(input, fromRate, toRate, state));
    }

    // The maximum possible per-sample step for this tone at this output
    // rate (a generous multiple of the theoretical bound, since this is a
    // guard against a gross discontinuity, not a precision assertion).
    const maxNormalStep = 2 * Math.PI * (freq / toRate) * 1.5;

    for (let c = 1; c < outChunks.length; c++) {
      const prevLast = outChunks[c - 1][outChunks[c - 1].length - 1];
      const curFirst = outChunks[c][0];
      expect(Math.abs(curFirst - prevLast)).toBeLessThan(maxNormalStep);
    }
  });

  it('never reads out of bounds (no NaN) across many chunks at an exact integer ratio', () => {
    // Regression guard: an earlier version of the bounds check only
    // clamped i0 < 0, not i0 >= input.length — floating-point drift in the
    // carried `phase` eventually pushed i0 to exactly input.length after
    // enough chunks at a clean integer ratio (48000/8000 = 6), producing
    // `undefined` reads and NaN output.
    const state = makeResampleState();
    let sampleCounter = 0;
    for (let c = 0; c < 50; c++) {
      const input = new Float32Array(2048);
      for (let i = 0; i < 2048; i++) input[i] = Math.sin(sampleCounter++ * 0.01);
      const out = resampleLinear(input, 48000, 8000, state);
      expect(out.some((v) => Number.isNaN(v))).toBe(false);
    }
  });
});
