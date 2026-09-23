// Regression test for decoded messages being reported at the wrong RF
// frequency in I/Q mode.
//
// On an ordinary audio input the radio's own passband produces the audio,
// so a decode at audio f sits at VFO + f. In I/Q mode that is not true: the
// app tunes WITHIN the received spectrum (SignalAnalysisPanel's passband
// marker -> SSBDemodulator's complex mixer, which shifts passbandCenterHz
// down to 0Hz audio), so audio is measured from VFO + passbandCenterHz.
//
// Reported from real use with a 6500Hz offset — the operator had parked the
// passband away from the dial to dodge a noise peak, and every decode was
// displayed 6500Hz low. The numbers below are that exact session.
import { effectiveVfoForIQ, axisRefForTap } from '../iqFreq';

const VFO = 21_069_000;        // dial, from the screenshot
const PASSBAND_CENTER = 6_500; // offset within the I/Q spectrum
const PASSBAND_ABS = VFO + PASSBAND_CENTER; // 21.075.500 — what the panel showed

describe('effectiveVfoForIQ', () => {
  it('adds the passband offset when I/Q is live', () => {
    expect(effectiveVfoForIQ(VFO, { connected: true, inputMode: 'iq', passbandCenterHz: PASSBAND_CENTER }))
      .toBe(PASSBAND_ABS);
  });

  it('places the reported session decodes back inside the passband', () => {
    const dial = effectiveVfoForIQ(VFO, { connected: true, inputMode: 'iq', passbandCenterHz: PASSBAND_CENTER });
    // Audio offsets recovered from the screenshot's own (wrong) display.
    const audioHz = [301, 543, 1340, 1786, 251, 1845, 197, 1058];
    const BW = 3000; // the Width field in that same screenshot
    for (const a of audioHz) {
      const rf = dial + a;
      // The whole point: a decode must land inside the window the operator
      // is actually listening to. Before the fix these came out at
      // VFO + audio, i.e. 6500Hz BELOW the passband — outside it entirely.
      expect(rf).toBeGreaterThanOrEqual(PASSBAND_ABS);
      expect(rf).toBeLessThanOrEqual(PASSBAND_ABS + BW);
      expect(rf).not.toBe(VFO + a);
    }
  });

  it('leaves an ordinary audio input untouched', () => {
    // The bridge keeps its last passbandCenterHz when idle or in audio
    // mode, so a stale offset must not leak into the normal path.
    expect(effectiveVfoForIQ(VFO, { connected: false, inputMode: 'iq', passbandCenterHz: PASSBAND_CENTER })).toBe(VFO);
    expect(effectiveVfoForIQ(VFO, { connected: true, inputMode: 'audio', passbandCenterHz: PASSBAND_CENTER })).toBe(VFO);
    expect(effectiveVfoForIQ(VFO, undefined)).toBe(VFO);
  });

  it('passes an undefined VFO through rather than inventing one', () => {
    // No CAT connection means no absolute frequency at all; the table falls
    // back to showing a bare audio offset.
    expect(effectiveVfoForIQ(undefined, { connected: true, inputMode: 'iq', passbandCenterHz: PASSBAND_CENTER }))
      .toBeUndefined();
  });

  it('handles a zero offset (passband sitting on the dial)', () => {
    expect(effectiveVfoForIQ(VFO, { connected: true, inputMode: 'iq', passbandCenterHz: 0 })).toBe(VFO);
  });
});

describe('axisRefForTap', () => {
  const BW = 3000;

  it('labels the raw I/Q axis against the bare VFO', () => {
    // Raw I/Q bins really are centred on the dial, so -12000..+12000 spans
    // VFO-12k..VFO+12k — matching what the reported screenshots showed for
    // that tap (21.057 .. 21.081 around a 21.069 dial).
    expect(axisRefForTap(VFO, true, PASSBAND_CENTER)).toBe(VFO);
    expect(VFO - 12_000).toBe(21_057_000);
    expect(VFO + 12_000).toBe(21_081_000);
  });

  it('labels the processed axis against the passband', () => {
    expect(axisRefForTap(VFO, false, PASSBAND_CENTER)).toBe(PASSBAND_ABS);
  });

  it('puts the decoded audio band inside the passband window', () => {
    // The bug: the processed view used the raw view's own axis, so the
    // demodulated signal was drawn around 21.069-21.071 instead of inside
    // the window actually being demodulated.
    const ref = axisRefForTap(VFO, false, PASSBAND_CENTER)!;
    expect(ref).toBe(21_075_500);
    expect(ref + BW).toBe(21_078_500);
    // ...and specifically NOT where it was being drawn before.
    expect(ref).not.toBe(VFO);
  });

  it('falls back to the VFO when there is no passband to reference', () => {
    // Ordinary audio-mode decoders pass no passband at all.
    expect(axisRefForTap(VFO, false, undefined)).toBe(VFO);
  });

  it('passes an undefined VFO through', () => {
    expect(axisRefForTap(undefined, false, PASSBAND_CENTER)).toBeUndefined();
  });
});
