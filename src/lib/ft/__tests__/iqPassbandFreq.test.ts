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
    // Raw I/Q bins really are centred on the dial.
    expect(axisRefForTap(VFO, true, PASSBAND_CENTER)).toBe(VFO);
    expect(VFO - 12_000).toBe(21_057_000);
    expect(VFO + 12_000).toBe(21_081_000);
  });

  it('labels the decoded-audio axis at centerHz, which IS audio 0', () => {
    // The mixer shifts centerHz to baseband 0, so centerHz is the bottom of
    // the demodulated window despite its name — NOT its middle.
    expect(axisRefForTap(VFO, false, PASSBAND_CENTER)).toBe(PASSBAND_ABS);
  });

  it('matches a live-signal observation', () => {
    // Dial 7.069.000, passband field 7074.971 (= vfo + centerHz), a station
    // decoded at 7.075.491. That is passband + 520Hz, i.e. audio 520 — which
    // only holds if centerHz maps to audio 0. A half-bandwidth offset (an
    // earlier version of this function) would have put it at audio 2020.
    const vfo = 7_069_000;
    const centerHz = 7_074_971 - vfo;
    const ref = axisRefForTap(vfo, false, centerHz)!;
    expect(ref).toBe(7_074_971);
    expect(7_075_491 - ref).toBe(520);
  });

  it('does not shift by half the bandwidth', () => {
    // Regression guard for the specific error this had: subtracting bw/2 to
    // match a passband marker that was itself drawn wrongly centred.
    expect(axisRefForTap(VFO, false, PASSBAND_CENTER)).not.toBe(PASSBAND_ABS - BW / 2);
  });

  it('falls back to the VFO when there is no passband to reference', () => {
    // Ordinary audio-mode decoders pass no passband at all.
    expect(axisRefForTap(VFO, false, undefined)).toBe(VFO);
  });

  it('passes an undefined VFO through', () => {
    expect(axisRefForTap(undefined, false, PASSBAND_CENTER)).toBeUndefined();
  });
});
