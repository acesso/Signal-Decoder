// What decoded audio is measured FROM — "the dial", as far as every
// decoder, table and log is concerned.
//
// On an ordinary audio input that is just the radio's VFO: the receiver's
// own passband produced the audio, so a tone at 1500Hz is VFO+1500.
//
// In I/Q mode it is NOT. The app tunes within the received spectrum itself
// — SignalAnalysisPanel's passband marker drives SSBDemodulator's complex
// mixer, which shifts passbandCenterHz down to 0Hz audio (see that class's
// setPassband comment: the wanted sideband then occupies baseband 0..+bw,
// entirely on one side of zero). So audio is measured from
// VFO + passbandCenterHz.
//
// The bug this fixes: an operator who parks the passband well away from the
// dial to dodge a noise peak — a normal, useful thing to do in I/Q mode —
// saw every decode reported low by exactly that offset. Reported from real
// use at 6500Hz: decodes listed near 21.069 while the passband was actually
// listening at 21.075.5.
//
// Deliberately NOT applied to the spectrum plots: those draw the passband
// marker as an offset FROM the raw VFO, so they take the VFO directly.
// Nor to the real TX frequency, which goes out through the radio's own
// audio path rather than through the I/Q receive passband.

/** The subset of IQBridgeState this needs — kept structural so callers can
 *  pass the live state object and tests can pass a literal. */
export interface IQTuneState {
  connected: boolean
  inputMode: string
  passbandCenterHz: number
}

/**
 * VFO plus the I/Q passband offset, when I/Q is genuinely the live source.
 *
 * The offset is applied ONLY when connected and actually in "iq" input
 * mode: passbandCenterHz keeps its last value when the bridge is idle or
 * feeding plain demodulated audio, and adding a stale offset there would
 * corrupt the ordinary path.
 *
 * An undefined VFO passes through unchanged — no CAT connection means no
 * absolute frequency at all, and the caller falls back to displaying a bare
 * audio offset rather than a fabricated one.
 */
export function effectiveVfoForIQ(vfoHz: number | undefined, iq: IQTuneState | undefined): number | undefined {
  if (vfoHz === undefined) return undefined
  if (!iq || !iq.connected || iq.inputMode !== 'iq') return vfoHz
  return vfoHz + iq.passbandCenterHz
}

/**
 * The frequency the Signal Analysis plot's horizontal axis is measured
 * from, for turning a bin offset into an absolute RF label.
 *
 * The panel has two taps and they need different references:
 *
 *  - RAW I/Q: bins are centred on the dial, so the VFO is correct.
 *  - PROCESSED (decoded audio): bins are baseband audio, and the mixer
 *    shifts centerHz to audio 0 (see SSBDemodulator.setPassband — the
 *    wanted sideband then occupies baseband 0..+bw, entirely on one side of
 *    zero). So the reference is vfo + centerHz.
 *
 * centerHz is the BOTTOM of the demodulated window despite its name, not
 * its middle. An earlier version of this function subtracted bandwidthHz/2
 * to match the passband marker, which was drawn centred — but the marker
 * was the thing that was wrong, and the subtraction put the whole decoded-
 * audio axis half a bandwidth low. Confirmed against live signal: with the
 * dial at 7.069.000 and the passband at 7074.971, a station decoded at
 * 7.075.491 is 520Hz above the passband value, i.e. audio 520 — which only
 * holds if centerHz maps to audio 0.
 *
 * Affects ONLY the plot axis. Decoded MESSAGE frequencies come from
 * effectiveVfoForIQ above, which has always used this same reference and
 * has always been right.
 */
export function axisRefForTap(
  vfoHz: number | undefined,
  onRawTap: boolean,
  passbandCenterHz: number | undefined,
): number | undefined {
  if (vfoHz === undefined) return undefined
  if (onRawTap || passbandCenterHz === undefined) return vfoHz
  return vfoHz + passbandCenterHz
}
