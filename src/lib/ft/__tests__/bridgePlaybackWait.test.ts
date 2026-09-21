// Regression test for FT bridge-sink TX replaying the same message over and
// over within a single window.
//
// Root cause: the ESP32 firmware sets its `playing` flag from INSIDE the
// spawned playback task, not in the POST /tx-play HTTP handler (see
// s_tx_play_task_alive_slot's comment in audio_monitor.c). /tx-status
// therefore legitimately reports playing:false for a moment AFTER /tx-play
// has already returned 200. playBridgeSlotAndWait treated that first false
// as "playback finished" and resolved ~150ms into a 12.6s FT8 window; the
// TX loop then ran its next iteration while still inside the SAME window
// and keyed up the identical message again, repeatedly.
import { playBridgeSlotAndWait } from '../useFTTransmit';

const WS_URL = 'ws://10.0.0.5:80/ws';
const SLOT = 1;
const DURATION_MS = 12_600; // nominal FT8 waveform length

type StatusReply = { playing: boolean; playing_slot: number };

// Drives fetch: one /tx-play, then a scripted sequence of /tx-status polls.
// Returns the number of status polls actually made, so a test can assert the
// wait didn't bail out early.
function mockBridge(statuses: StatusReply[], opts: { playOk?: boolean; durationMs?: number | null; statusOk?: boolean } = {}) {
  const { playOk = true, durationMs = DURATION_MS, statusOk = true } = opts;
  let polls = 0;
  const fetchMock = jest.fn((url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      return Promise.resolve({
        ok: playOk,
        json: () => durationMs === null
          ? Promise.reject(new Error('no JSON body'))
          : Promise.resolve({ slot: SLOT, playing: true, duration_ms: durationMs }),
      } as unknown as Response);
    }
    // /tx-status — walk the script, repeating its last entry once exhausted.
    const reply = statuses[Math.min(polls, statuses.length - 1)];
    polls++;
    return Promise.resolve({
      ok: statusOk,
      json: () => Promise.resolve(reply),
    } as unknown as Response);
  });
  (globalThis as unknown as { fetch: unknown }).fetch = fetchMock;
  return { get polls() { return polls; } };
}

const PLAYING: StatusReply  = { playing: true,  playing_slot: SLOT };
const FINISHED: StatusReply = { playing: false, playing_slot: -1 };

beforeEach(() => jest.useFakeTimers({ doNotFake: ['performance'] }));
afterEach(() => jest.useRealTimers());

// The wait loop interleaves setTimeout with awaited fetches, so advancing
// timers alone isn't enough — each tick has to let microtasks drain too.
async function runFor(ms: number, stepMs = 150) {
  for (let elapsed = 0; elapsed < ms; elapsed += stepMs) {
    await jest.advanceTimersByTimeAsync(stepMs);
  }
}

describe('playBridgeSlotAndWait', () => {
  it('does NOT resolve while the firmware is still spawning its playback task', async () => {
    // The bug: playing:false on the first few polls is startup, not
    // completion. Nothing has gone out on air yet at this point.
    const bridge = mockBridge([FINISHED, FINISHED, PLAYING]);
    let resolved = false;
    const wait = playBridgeSlotAndWait(WS_URL, SLOT, () => true).then(v => { resolved = true; return v; });

    await runFor(600); // well past the two startup polls
    expect(resolved).toBe(false);

    // Once playback is genuinely reported done, it resolves.
    mockBridge([FINISHED]);
    await runFor(DURATION_MS + 2000);
    await expect(wait).resolves.toBe(true);
  });

  it('waits for the whole waveform, not just the first poll', async () => {
    const bridge = mockBridge([PLAYING]); // never finishes on its own
    let resolved = false;
    const wait = playBridgeSlotAndWait(WS_URL, SLOT, () => true).then(v => { resolved = true; return v; });

    await runFor(5000);
    expect(resolved).toBe(false);
    expect(bridge.polls).toBeGreaterThan(10); // genuinely polling, not spinning
    await jest.runOnlyPendingTimersAsync();
  });

  it('resolves once playback is seen running and then stops', async () => {
    // Plays for ~3 polls, then reports finished — the normal happy path.
    const statuses = [PLAYING, PLAYING, PLAYING, FINISHED];
    mockBridge(statuses);
    const wait = playBridgeSlotAndWait(WS_URL, SLOT, () => true);
    await runFor(2000);
    await expect(wait).resolves.toBe(true);
  });

  it('a status-poll failure does not shortcut the wait to "finished"', async () => {
    // Losing contact with the bridge mid-playback is not evidence that the
    // audio stopped — resolving early here put the TX loop back inside the
    // still-live window, which is what caused the repeat.
    mockBridge([PLAYING], { statusOk: false });
    let resolved = false;
    const wait = playBridgeSlotAndWait(WS_URL, SLOT, () => true).then(v => { resolved = true; return v; });

    await runFor(1000);
    expect(resolved).toBe(false);

    // It does eventually give up, rather than polling a dead bridge forever.
    await runFor(DURATION_MS + 2000);
    await expect(wait).resolves.toBe(true);
  });

  it('still bounds the wait when the firmware reports no duration', async () => {
    // Older firmware without duration_ms in the /tx-play body: fall back to
    // the startup grace period rather than waiting forever.
    mockBridge([FINISHED], { durationMs: null });
    const wait = playBridgeSlotAndWait(WS_URL, SLOT, () => true);
    await runFor(3000);
    await expect(wait).resolves.toBe(true);
  });

  it('returns false when /tx-play itself fails', async () => {
    mockBridge([FINISHED], { playOk: false });
    await expect(playBridgeSlotAndWait(WS_URL, SLOT, () => true)).resolves.toBe(false);
  });

  it('stops polling promptly when the session is torn down', async () => {
    mockBridge([PLAYING]);
    const wait = playBridgeSlotAndWait(WS_URL, SLOT, () => false);
    await runFor(300);
    await expect(wait).resolves.toBe(true);
  });
});
