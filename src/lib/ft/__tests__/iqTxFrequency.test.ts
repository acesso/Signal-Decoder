// Pins the TX frequency arithmetic in I/Q mode, where the operator tunes
// WITHIN the received spectrum: the passband sits away from the dial (to
// dodge a noise peak), so their "Audio Hz" is measured from the passband,
// not from the dial.
//
// The reported bug: RX already knew this (effectiveVfoForIQ, so a decode
// reports its true RF frequency) but TX did not, so a reply went out one
// passband-offset BELOW the station being answered. With the dial at
// 7.069.000 and the passband at 7.074.000, audio 800 transmitted at
// 7.069.800 instead of the expected 7.074.800.
//
// These reproduce the computation the TX loop performs rather than driving
// the loop itself (which needs timers, workers and a bridge) — the point is
// that BOTH paths, Fake Split on and off, land on the same on-air
// frequency, and that it is the right one.

const DIAL = 7_069_000;
const PASSBAND_ABS = 7_074_000;
const IQ_OFFSET = PASSBAND_ABS - DIAL; // 5000
const AUDIO_HZ = 800;
const EXPECTED_ON_AIR = PASSBAND_ABS + AUDIO_HZ; // 7_074_800
const SWEET_SPOT = 1750;

/** The retune the TX loop computes. Mirrors useFTTransmit's own:
 *  desiredHz is dial-relative, encodedAtHz is what the samples hold. */
function planTx(opts: { fakeSplit: boolean; iqOffsetHz: number; audioHz: number; sweetSpotHz: number; dialHz: number }) {
  const { fakeSplit, iqOffsetHz, audioHz, sweetSpotHz, dialHz } = opts;
  const desiredHz = audioHz + iqOffsetHz;
  const encodedAtHz = fakeSplit ? sweetSpotHz : audioHz;
  const delta = desiredHz - encodedAtHz;
  const txDialHz = delta !== 0 ? dialHz + delta : dialHz;
  return { encodedAtHz, txDialHz, onAirHz: txDialHz + encodedAtHz };
}

describe('I/Q TX frequency', () => {
  it('transmits where the operator expects, with Fake Split OFF', () => {
    const p = planTx({ fakeSplit: false, iqOffsetHz: IQ_OFFSET, audioHz: AUDIO_HZ, sweetSpotHz: SWEET_SPOT, dialHz: DIAL });
    expect(p.encodedAtHz).toBe(800);       // the operator's own tone
    expect(p.txDialHz).toBe(7_074_000);    // dial moved up by the passband offset
    expect(p.onAirHz).toBe(EXPECTED_ON_AIR);
  });

  it('transmits where the operator expects, with Fake Split ON', () => {
    const p = planTx({ fakeSplit: true, iqOffsetHz: IQ_OFFSET, audioHz: AUDIO_HZ, sweetSpotHz: SWEET_SPOT, dialHz: DIAL });
    expect(p.encodedAtHz).toBe(1750);      // the fixed sweet spot
    expect(p.txDialHz).toBe(7_073_050);    // a different dial...
    expect(p.onAirHz).toBe(EXPECTED_ON_AIR); // ...but the SAME on-air result
  });

  it('both paths agree — that is the property that matters', () => {
    const off = planTx({ fakeSplit: false, iqOffsetHz: IQ_OFFSET, audioHz: AUDIO_HZ, sweetSpotHz: SWEET_SPOT, dialHz: DIAL });
    const on = planTx({ fakeSplit: true, iqOffsetHz: IQ_OFFSET, audioHz: AUDIO_HZ, sweetSpotHz: SWEET_SPOT, dialHz: DIAL });
    expect(off.onAirHz).toBe(on.onAirHz);
    // ...while reaching it by genuinely different dial/audio splits.
    expect(off.txDialHz).not.toBe(on.txDialHz);
    expect(off.encodedAtHz).not.toBe(on.encodedAtHz);
  });

  it('does not retune at all on an audio source (no passband offset)', () => {
    // The ordinary case must be untouched: no I/Q offset and no Fake Split
    // means the dial stays exactly where the operator put it.
    const p = planTx({ fakeSplit: false, iqOffsetHz: 0, audioHz: AUDIO_HZ, sweetSpotHz: SWEET_SPOT, dialHz: DIAL });
    expect(p.txDialHz).toBe(DIAL);
    expect(p.onAirHz).toBe(DIAL + AUDIO_HZ);
  });

  it('still honours Fake Split on an audio source', () => {
    const p = planTx({ fakeSplit: true, iqOffsetHz: 0, audioHz: AUDIO_HZ, sweetSpotHz: SWEET_SPOT, dialHz: DIAL });
    expect(p.encodedAtHz).toBe(SWEET_SPOT);
    expect(p.onAirHz).toBe(DIAL + AUDIO_HZ); // unchanged from the operator's intent
  });

  it('keeps the encoded tone inside the radio passband', () => {
    // Why a retune is required rather than just encoding higher: the
    // dial-relative target here is 5800Hz, far outside an SSB passband.
    const desired = AUDIO_HZ + IQ_OFFSET;
    expect(desired).toBe(5800);
    const p = planTx({ fakeSplit: false, iqOffsetHz: IQ_OFFSET, audioHz: AUDIO_HZ, sweetSpotHz: SWEET_SPOT, dialHz: DIAL });
    expect(p.encodedAtHz).toBeLessThanOrEqual(3000);
  });
});

// A decode caught WHILE a Fake Split transmission has the dial retuned.
// The app can hear its own signal, and in I/Q mode there is often other
// traffic worth decoding in that same window — so decoding continues; only
// the frequency stamp needs correcting.
describe('decode stamping during a Fake Split retune', () => {
  // A different session from the constants above: 21MHz, dial 21.069.000,
  // passband 21.074.000 (same 5000Hz offset), sweet spot 1000, audio 850.
  const DIAL2 = 21_069_000;
  const PASSBAND2 = 21_074_000;
  const OFFSET2 = PASSBAND2 - DIAL2;
  const SWEET = 1000;
  const AUDIO = 850;
  // The self-decode sat at audio 1014 — the same tone the correctly-stamped
  // TX rows in that session show (21.075.014). Derived from the observed
  // phantom rather than guessed: 21_079_864 - (retunedDial + offset) = 1014.
  const OBSERVED_AUDIO = 1014;

  /** What the decoder stamps a window with. Mirrors FTDecoder's currentVfo:
   *  the pre-retune dial plus the I/Q offset while a retune is in effect,
   *  otherwise the live effective VFO. */
  function stampFor(opts: { retunedOriginalDial: number | null; liveDial: number; iqOffsetHz: number }) {
    const { retunedOriginalDial, liveDial, iqOffsetHz } = opts;
    return retunedOriginalDial != null ? retunedOriginalDial + iqOffsetHz : liveDial + iqOffsetHz;
  }

  it('reproduces the reported phantom row without the fix', () => {
    // The dial is retuned for the transmission...
    const delta = AUDIO + OFFSET2 - SWEET;
    const retunedDial = DIAL2 + delta; // 21_073_850
    expect(retunedDial).toBe(21_073_850);
    // ...and stamping against the LIVE (retuned) dial double-counts the
    // offset, putting the decode 5kHz above the real traffic.
    const wrong = stampFor({ retunedOriginalDial: null, liveDial: retunedDial, iqOffsetHz: OFFSET2 }) + OBSERVED_AUDIO;
    expect(wrong).toBe(21_079_864); // exactly the phantom row that was observed
  });

  it('stamps against the operator dial while retuned', () => {
    const delta = AUDIO + OFFSET2 - SWEET;
    const retunedDial = DIAL2 + delta;
    const right = stampFor({ retunedOriginalDial: DIAL2, liveDial: retunedDial, iqOffsetHz: OFFSET2 }) + OBSERVED_AUDIO;
    // Back beside the real traffic, which sat at 21.074.8-21.075.0.
    // Lands on 21.075.014 — precisely where the other TX rows in that same
    // session appear, beside PY5JO at 21.074.809.
    expect(right).toBe(21_075_014);
    expect(right).toBeGreaterThanOrEqual(PASSBAND2);
    expect(right).toBeLessThanOrEqual(PASSBAND2 + 3000);
  });

  it('is a no-op when no retune is in effect', () => {
    const s = stampFor({ retunedOriginalDial: null, liveDial: DIAL2, iqOffsetHz: OFFSET2 });
    expect(s).toBe(PASSBAND2);
  });
});
