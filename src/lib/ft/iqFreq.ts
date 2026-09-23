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
 *  - PROCESSED (decoded audio): bins are baseband audio 0..Nyquist carrying
 *    the demodulated passband, so audio 0 is the passband's LOW EDGE —
 *    centerHz minus half the width. The passband marker is drawn as
 *    centerHz +- bandwidthHz/2 (see drawChannelMarker), so a 3000Hz-wide
 *    passband centred on 21075.5 covers 21074.0..21077.0, and the decoded
 *    audio view should label exactly that span.
 *
 * Referencing the CENTRE here (as an earlier version did) put the whole
 * audio view half a bandwidth too high: with that same passband it labelled
 * 21075.5..21078.5 instead of 21074.0..21077.0, so switching from the I/Q
 * view to the demodulated one moved the signal to a frequency it isn't at.
 *
 * This affects ONLY the plot axis. The frequencies reported for decoded
 * MESSAGES come from effectiveVfoForIQ above and are already correct — the
 * decoder measures its audio from the same point the demodulator's mixer
 * does, which is a separate question from where the axis tick labels go.
 */
export function axisRefForTap(
  vfoHz: number | undefined,
  onRawTap: boolean,
  passbandCenterHz: number | undefined,
  passbandBandwidthHz: number | undefined,
): number | undefined {
  if (vfoHz === undefined) return undefined
  if (onRawTap || passbandCenterHz === undefined) return vfoHz
  return vfoHz + passbandCenterHz - (passbandBandwidthHz ?? 0) / 2
}
