// The squelch gate decision, per session. Each decoder is thresholded
// against energy measured in its OWN mark/space bands, so two sessions
// watching different signals gate independently.
import { shouldGate } from '../multiProcessor';

describe('shouldGate', () => {
  it('never gates when squelch is off', () => {
    // 0 is "open" — silence must still pass through, or a session the
    // operator never configured would go mute.
    expect(shouldGate(0, 0)).toBe(false);
    expect(shouldGate(0, 255)).toBe(false);
  });

  it('gates signal below the threshold and passes signal above it', () => {
    // 50% of the 0-255 byte scale is ~127.5.
    expect(shouldGate(50, 100)).toBe(true);
    expect(shouldGate(50, 200)).toBe(false);
  });

  it('passes a signal exactly at the threshold', () => {
    expect(shouldGate(50, 127.5)).toBe(false);
  });

  it('gates everything at full squelch', () => {
    expect(shouldGate(100, 254)).toBe(true);
  });

  it('lets two sessions gate independently at the same energy', () => {
    // The point of per-session squelch: one weak signal, two thresholds.
    // A setting that suits a loud local station must not mute a weak one.
    const weakSignal = 60;
    expect(shouldGate(80, weakSignal)).toBe(true);  // tightly squelched session
    expect(shouldGate(10, weakSignal)).toBe(false); // open session still decodes
  });

  it('treats a negative threshold as open rather than inverting', () => {
    expect(shouldGate(-5, 0)).toBe(false);
  });
});
