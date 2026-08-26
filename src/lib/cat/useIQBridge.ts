// Read-only bridge to the ESP32 CAT bridge's raw wideband I/Q stream (see
// firmware/esp32-cat-bridge/main/audio_iq.h) — a SEPARATE WebSocket
// (/iq-data) from the existing demodulated-audio /audio bridge
// (useAudioBridge.ts), because the two carry different DATA (raw stereo I/Q,
// I on the left channel, Q on the right — confirmed on real hardware, vs.
// already-demodulated mono audio) even though I/Q is a strict superset:
// demodulated audio is just I/Q run through a demodulator, which is exactly
// what SSBDemodulator below does. The bridge's own input_mode setting (GET
// /status's "input_mode", "audio" or "iq") decides which PATH is physically
// sampled at any given time — they are mutually exclusive on the firmware
// side (one ADC, reboot-to-apply), but I/Q mode alone carries everything a
// decoder needs: this hook demodulates it client-side (see
// getPlaybackSource() below) so FT8/MFSK/etc. work identically whether the
// bridge is in "audio" or "iq" mode — see audioSource.ts's
// acquireBridgeSource(), which reads getPlaybackSource() and doesn't care
// which path produced it.
//
// Gated on the bridge's GET /info reporting the "input_mode_select"
// feature — see hasFeature('input_mode_select') in RadioCATPanel.tsx's
// BridgeStatusPanel.
import { createSignal, onCleanup } from 'solid-js'
import type { CATMode } from './useRadioCAT'

// Always-on, matching useAudioBridge.ts's log() — see that file's comment
// for why silent failure here was a real, hard-to-diagnose bug once
// already (a wrong URL scheme silently fell back to the microphone with
// zero console output).
function log(level: 'info' | 'warn' | 'error', ...args: unknown[]) {
  console[level]('[iq-bridge]', ...args)
}

// Fallback only — used if GET /status can't be reached at connect() time.
// The bridge's actual rate/mode are otherwise always read live from GET
// /status (see fetchBridgeIQInfo()), since POST /sample-rate and POST
// /input-mode on the bridge's own control page can change either at any
// time (both reboot to apply).
const FALLBACK_SAMPLE_RATE = 96000

// ── localStorage persistence — the I/Q diagnostic toggles below used to be
// deliberately session-only ("confirm/rule out a wiring theory, don't let a
// stale browser-side workaround silently mask a real firmware/hardware
// fix"), but in practice an operator who found a setting that actually
// helps their specific hardware wants it to survive a reload, not to
// re-discover and re-apply it every session. Same LS_ naming convention as
// useFTTransmit.ts.
const LS_IQ_CORRECTION = 'iq_correction'
const LS_DC_REMOVAL = 'iq_dc_removal'
const LS_IMBALANCE_CORRECTION = 'iq_imbalance_correction'
const LS_AGC_ENABLED = 'iq_agc_enabled'
const LS_AGC_LEVEL = 'iq_agc_level'
const LS_HIGHPASS_ENABLED = 'iq_highpass_enabled'
const LS_NOISE_REDUCER_ENABLED = 'iq_noise_reducer_enabled'
const LS_PLAY_THROUGH_SPEAKERS = 'iq_play_through_speakers'
const LS_FORCE_IQ_MODE = 'iq_force_mode'
const LS_FORCE_SAMPLE_RATE = 'iq_force_sample_rate'
const LS_PASSBAND_CENTER_HZ = 'iq_passband_center_hz'
const LS_PASSBAND_BANDWIDTH_HZ = 'iq_passband_bandwidth_hz'

function loadIQCorrection(): IQCorrection {
  if (typeof window === 'undefined') return 'none'
  const stored = localStorage.getItem(LS_IQ_CORRECTION)
  return stored === 'swap' || stored === 'negateI' || stored === 'negateQ' ? stored : 'none'
}
function saveIQCorrection(v: IQCorrection) {
  if (typeof window !== 'undefined') localStorage.setItem(LS_IQ_CORRECTION, v)
}
function loadDCRemoval(): boolean {
  if (typeof window === 'undefined') return false
  return localStorage.getItem(LS_DC_REMOVAL) === 'true'
}
function saveDCRemoval(v: boolean) {
  if (typeof window !== 'undefined') localStorage.setItem(LS_DC_REMOVAL, String(v))
}
function loadImbalanceCorrection(): boolean {
  if (typeof window === 'undefined') return false
  return localStorage.getItem(LS_IMBALANCE_CORRECTION) === 'true'
}
function saveImbalanceCorrection(v: boolean) {
  if (typeof window !== 'undefined') localStorage.setItem(LS_IMBALANCE_CORRECTION, String(v))
}
// Defaults ON. Reverted back from a same-session attempt at defaulting
// this OFF (the reasoning: this AGC is a direct port of the uSDX
// firmware's own per-sample gain-riding compressor, exactly right for a
// human listening to voice/CW on speakers but seemingly unnecessary for
// this app's data-only modes) — that reasoning doesn't hold up as a
// PROVEN mechanism (ft8mon normalizes internally against its own
// per-window noise-floor estimate, so overall input gain alone shouldn't
// change its decode count either way), and real-world testing after
// flipping the default found MORE noise and FEWER FT8 decodes with AGC
// off, not more. Left ON pending an actual root-caused explanation for
// that observation — reverting on an unconfirmed hypothesis while a real
// regression is still unexplained is worse than leaving the previously-
// working default in place. Still fully toggleable either way.
function loadAGCEnabled(): boolean {
  if (typeof window === 'undefined') return true
  return localStorage.getItem(LS_AGC_ENABLED) !== 'false'
}
function saveAGCEnabled(v: boolean) {
  if (typeof window !== 'undefined') localStorage.setItem(LS_AGC_ENABLED, String(v))
}
// [1,14], default 4 — see AGC_LEVEL_MIN/MAX/DEFAULT's own comment (matches
// the uSDX firmware's agc_lvl menu item exactly). Literal 4 here rather
// than referencing AGC_LEVEL_DEFAULT since that constant is declared later
// in this file, alongside the AGC class itself — kept in sync by hand,
// same as this codebase's other small forward-reference-avoiding literals.
function loadAGCLevel(): number {
  if (typeof window === 'undefined') return 4
  const stored = Number(localStorage.getItem(LS_AGC_LEVEL))
  return Number.isFinite(stored) && stored >= 1 && stored <= 14 ? stored : 4
}
function saveAGCLevel(v: number) {
  if (typeof window !== 'undefined') localStorage.setItem(LS_AGC_LEVEL, String(v))
}
// Defaults OFF — see the same reasoning as loadAGCEnabled() above. This
// fixed 300Hz corner matches the uSDX firmware's own voice/CW filt_var
// stage, but every one of this app's modes can legitimately carry content
// below 300Hz: FT8/MFSK tones are commonly tuned close to the passband's
// low edge (the whole point of a wide, per-mode passband — see App.tsx's
// IQ_PASSBAND_DEFAULTS), and this filter was confirmed on real signal to
// cut real tones there, not just DC/hum. Opt-in for whoever specifically
// wants it (e.g. listening to CW/voice-like content where sub-300Hz really
// is just rumble), not opt-out for every decode.
function loadHighpassEnabled(): boolean {
  if (typeof window === 'undefined') return false
  return localStorage.getItem(LS_HIGHPASS_ENABLED) === 'true'
}
function saveHighpassEnabled(v: boolean) {
  if (typeof window !== 'undefined') localStorage.setItem(LS_HIGHPASS_ENABLED, String(v))
}
// Defaults OFF — unlike agcEnabled/highpassEnabled above (both direct
// ports of a real radio's own long-proven DSP), NoiseReducer is genuinely
// NEW, unproven-on-real-signal DSP (see its own header comment) with real,
// well-documented failure modes (musical noise, added latency) that a
// firmware port doesn't carry — opt-in until validated against real HF
// conditions, not opt-out like the other two.
function loadNoiseReducerEnabled(): boolean {
  if (typeof window === 'undefined') return false
  return localStorage.getItem(LS_NOISE_REDUCER_ENABLED) === 'true'
}
function saveNoiseReducerEnabled(v: boolean) {
  if (typeof window !== 'undefined') localStorage.setItem(LS_NOISE_REDUCER_ENABLED, String(v))
}
function loadPlayThroughSpeakers(): boolean {
  if (typeof window === 'undefined') return false
  return localStorage.getItem(LS_PLAY_THROUGH_SPEAKERS) === 'true'
}
function savePlayThroughSpeakers(v: boolean) {
  if (typeof window !== 'undefined') localStorage.setItem(LS_PLAY_THROUGH_SPEAKERS, String(v))
}
// Persisted for the same reason as the diagnostic toggles above — an
// operator who's tuned into a specific signal doesn't want the marker
// snapping back to 0Hz/2700Hz on every reload; every decoder reads this
// via iqBridge.state().passbandCenterHz/passbandBandwidthHz (see
// SignalAnalysisPanel's passband marker), so persisting it here at the
// source covers all of them at once. null center means "never set" (kept
// distinct from a legitimate 0Hz center) so the initial state below can
// fall back to its own default instead of a stored zero.
// NOTE: App.tsx now ALSO persists a passband setting PER DECODER MODE
// (IQ_PASSBAND_DEFAULTS/loadPassbandByMode()) and applies its own
// mode-specific value via setPassband() on mount and on every mode
// switch — that call runs almost immediately and supersedes whatever this
// single, mode-agnostic value seeded the demodulator with at
// construction. This single-value fallback is kept anyway as the sane
// default for any hypothetical future caller of useIQBridge() outside
// App.tsx's own orchestration, not because both are meant to be the
// active source of truth simultaneously.
function loadPassbandCenterHz(): number | null {
  if (typeof window === 'undefined') return null
  const stored = localStorage.getItem(LS_PASSBAND_CENTER_HZ)
  const n = stored !== null ? Number(stored) : NaN
  return Number.isFinite(n) ? n : null
}
function savePassbandCenterHz(v: number) {
  if (typeof window !== 'undefined') localStorage.setItem(LS_PASSBAND_CENTER_HZ, String(v))
}
function loadPassbandBandwidthHz(): number | null {
  if (typeof window === 'undefined') return null
  const stored = localStorage.getItem(LS_PASSBAND_BANDWIDTH_HZ)
  const n = stored !== null ? Number(stored) : NaN
  return Number.isFinite(n) && n > 0 ? n : null
}
function savePassbandBandwidthHz(v: number) {
  if (typeof window !== 'undefined') localStorage.setItem(LS_PASSBAND_BANDWIDTH_HZ, String(v))
}
// Bypasses GET /status entirely — for a bridge that doesn't serve /status
// at all (e.g. firmware/esp32-iq-minimal, a deliberately status-less
// single-purpose test build with only /iq-data) rather than a real bridge
// glitch. fetchBridgeIQInfo() has no way to distinguish "this bridge is in
// audio mode" from "this bridge has no /status handler" — both look like a
// failed fetch — so it correctly defaults to "audio" (the safer assumption
// for a real bridge hiccup) UNLESS this override says otherwise. Persisted
// like the other diagnostic toggles above: an operator testing one of
// these minimal firmwares wants it to stay on across reloads, not
// rediscover it every session.
function loadForceIQMode(): boolean {
  if (typeof window === 'undefined') return false
  return localStorage.getItem(LS_FORCE_IQ_MODE) === 'true'
}
function saveForceIQMode(v: boolean) {
  if (typeof window !== 'undefined') localStorage.setItem(LS_FORCE_IQ_MODE, String(v))
}
// Same reasoning as forceIQMode above, for the OTHER field GET /status
// normally supplies: without a real /status to read, fetchBridgeIQInfo()'s
// fallback reports FALLBACK_SAMPLE_RATE (96000) regardless of what rate
// the bridge is actually running — silently mismatched against a bridge
// like firmware/esp32-iq-minimal that's hardcoded to 48000Hz, this doubles
// every frequency the demodulator/spectrum computes against and badly
// aliases the signal (reported as "metallic crackling, FT8 barely audible
// underneath" — exactly this symptom). null means "no override, trust
// whatever fetchBridgeIQInfo() returns" — the normal path for a real
// bridge that actually serves /status.
function loadForceSampleRateHz(): number | null {
  if (typeof window === 'undefined') return null
  const stored = localStorage.getItem(LS_FORCE_SAMPLE_RATE)
  const n = stored ? Number(stored) : NaN
  return Number.isFinite(n) && n > 0 ? n : null
}
function saveForceSampleRateHz(v: number | null) {
  if (typeof window === 'undefined') return
  if (v === null) localStorage.removeItem(LS_FORCE_SAMPLE_RATE)
  else localStorage.setItem(LS_FORCE_SAMPLE_RATE, String(v))
}

// ws://host/cat -> ws://host/iq-data — same transform philosophy as
// useAudioBridge.ts's bridgeAudioWsUrl().
function bridgeIQWsUrl(catWsUrl: string): string | null {
  try {
    const u = new URL(catWsUrl)
    if (u.protocol !== 'ws:' && u.protocol !== 'wss:') return null
    u.pathname = '/iq-data'
    return u.toString()
  } catch {
    return null
  }
}

export type InputMode = 'audio' | 'iq'

// ws://host/cat -> http://host/status — duplicated locally rather than
// shared with useRadioCAT.ts's BridgeStatus, same reasoning as
// useAudioBridge.ts's fetchBridgeSampleRate(): this hook needs
// input_mode/sample_rate_hz, which aren't (and per that file's own
// precedent, shouldn't be) part of the generic CAT-bridge status type.
async function fetchBridgeIQInfo(catWsUrl: string): Promise<{ inputMode: InputMode; sampleRateHz: number }> {
  const fallback = { inputMode: 'audio' as InputMode, sampleRateHz: FALLBACK_SAMPLE_RATE }
  try {
    const u = new URL(catWsUrl)
    if (u.protocol !== 'ws:' && u.protocol !== 'wss:') return fallback
    u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:'
    u.pathname = '/status'
    const res = await fetch(u.toString())
    if (!res.ok) return fallback
    const data = (await res.json()) as { input_mode?: unknown; sample_rate_hz?: unknown }
    const inputMode = data.input_mode === 'iq' ? 'iq' : 'audio'
    const sampleRateHz = typeof data.sample_rate_hz === 'number' ? data.sample_rate_hz : FALLBACK_SAMPLE_RATE
    return { inputMode, sampleRateHz }
  } catch {
    return fallback
  }
}

export interface IQBridgeState {
  connected: boolean
  // True while a PREVIOUSLY-connected socket has dropped and an automatic
  // reconnect is scheduled/in flight (see openSocket()'s onclose) — false
  // once reconnected, and false (not true) for the very first connect()
  // attempt, a genuine unrecoverable failure, or an operator-initiated
  // disconnect(). Distinct from !connected, which is also true in all of
  // those other cases — this exists so the UI can show "reconnecting…"
  // specifically for the case a bridge reboot/Wi-Fi hiccup causes, without
  // also lighting up on every ordinary "not connected yet" state.
  reconnecting: boolean
  // Mirrors GET /status's input_mode, refreshed on every (re)connect — lets
  // the UI tell "connected, but the bridge is in audio mode so nothing
  // meaningful will ever arrive" apart from "connected and actually
  // streaming I/Q," without a second /status poll of its own.
  inputMode: InputMode
  sampleRateHz: number
  // Count of interleaved I/Q sample PAIRS received in the most recent
  // frame — 0 while inactive. Not a running total: this is a liveness
  // signal (see feedIQSamples()'s comment on why there's no
  // retry/replay/buffering here), not a metric to accumulate.
  lastFramePairs: number
  // Mirrors SSBDemodulator's current passband — see setPassband(). Kept in
  // reactive state (not just read from the demodulator instance) so
  // SignalAnalysisPanel's marker reflects the current selection reactively.
  passbandCenterHz: number
  passbandBandwidthHz: number
  error: string | null
  // Whether the demodulated I/Q audio is also being played out the
  // browser's own speakers — see setPlayThroughSpeakers(). Independent of
  // getPlaybackSource()/decoder consumption; this is purely for an
  // operator who wants to listen to what's being demodulated, same
  // purpose as useAudioBridge.ts's "Listen to Radio" but for I/Q mode
  // (which never had a speaker path at all before this).
  playThroughSpeakers: boolean
  // Which I/Q correction (if any) is applied before both the spectrum
  // display and the demodulator see the raw stream — see
  // setIQCorrection()'s comment for what each mode actually does and why
  // there are four instead of just an on/off swap.
  iqCorrection: IQCorrection
  // Independent of iqCorrection — see DCRemover/ImbalanceCorrector's own
  // comments for what each fixes and why they're separate, stackable
  // toggles rather than folded into iqCorrection's options.
  dcRemovalEnabled: boolean
  imbalanceCorrectionEnabled: boolean
  // Automatic gain control on demodulated audio — see the AGC class's own
  // comment (ported from the uSDX radio firmware's "M0PUB" AGC). Applied
  // AFTER demodulation, unlike the three flags above (all pre-demod, on
  // raw I/Q) — kept in this same state object for a consistent single
  // place to look for every I/Q-mode signal-processing toggle.
  agcEnabled: boolean
  // Target level, [1,14] — matches the radio's own AGC Level control
  // exactly (same range, same "higher = louder before it clamps"
  // semantics) so an operator already familiar with that CAT control
  // reads this one the same way. See AGC.setLevel()'s comment.
  agcLevel: number
  // 300Hz highpass on demodulated audio — see SSBDemodulator's own
  // `highpass` field comment (ported from the uSDX firmware's own
  // filt_var corner). Also post-demod, alongside agcEnabled above.
  highpassEnabled: boolean
  // Spectral noise reduction (FFT-overlap-add, Wiener gain) — see
  // NoiseReducer's own header comment. Last stage in the post-demod
  // chain, after agcEnabled/highpassEnabled above. Off by default — see
  // loadNoiseReducerEnabled()'s comment for why (new, unproven-on-air
  // DSP, unlike the two ports above).
  noiseReducerEnabled: boolean
  // See setForceIQMode()'s comment — when true, inputMode above is always
  // reported as "iq" regardless of what (or whether) GET /status answers.
  forceIQMode: boolean
  // See setForceSampleRateHz()'s comment — null means "no override," a
  // number pins sampleRateHz above to that value regardless of what (or
  // whether) GET /status answers.
  forceSampleRateHz: number | null
  // RMS power of the demodulated audio, in dBFS (0 = full-scale), measured
  // BEFORE agcEnabled's AGC.process() runs — see playDemodulatedFrame()'s
  // comment for why pre-AGC is the only tap point that means anything as a
  // signal-strength reading (AGC's whole job is to flatten this out).
  // Unlike the radio's own CAT `sMeter` reading (measured across uSDX's
  // entire analog RX chain, independent of whatever narrow slice of the
  // wideband I/Q spectrum this app is actually tuned to — see
  // firmware/usdxBLACKBRICK/usdxBLACKBRICK.ino's smeter()), this reflects
  // only the passband actually selected here. null until the first frame
  // is demodulated.
  iqSignalDbfs: number | null
}

// A mirrored spectrum (signals above the tuned frequency appearing as if
// below, and vice versa) comes from the two mixer outputs' 90-degree
// phase relationship having the wrong sign — which can happen two
// physically distinct ways that are NOT interchangeable to fix: a
// literal channel swap (I/Q wiring crossed, e.g. on the ADC's left/right
// pins) needs 'swap'; a single channel's sign/phase being wrong (e.g. an
// inverted mixer stage or single-ended-to-differential conversion on just
// one channel) needs 'negateI' or 'negateQ' instead — swapping wouldn't
// fix that case, only negating the specific wrong channel would. All
// three undo the SAME symptom (mirroring) but only one matches the real
// underlying defect; exposing all of them lets an operator try each
// against a real signal and see which one actually clears it, rather
// than guessing.
export type IQCorrection = 'none' | 'swap' | 'negateI' | 'negateQ'

// Plain radix-2 iterative FFT, no library — same "no bundler-friendly FFT
// dependency justified for one feature" reasoning as the ESP32 control
// page's own hand-rolled version (firmware/esp32-cat-bridge/spiffs_data/
// app.js's fftRadix2) — this is genuinely the same algorithm, kept
// independent rather than shared since the two run in completely separate
// JS runtimes (browser vs. none — that one's plain vanilla JS on the
// ESP32's own page) with no natural shared-module boundary.
function fftRadix2(re: Float64Array, im: Float64Array): void {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t
      t = im[i]; im[i] = im[j]; im[j] = t
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len
    const wRe = Math.cos(ang), wIm = Math.sin(ang)
    for (let i = 0; i < n; i += len) {
      let curRe = 1, curIm = 0
      for (let k = 0; k < len / 2; k++) {
        const uRe = re[i + k], uIm = im[i + k]
        const vRe = re[i + k + len / 2] * curRe - im[i + k + len / 2] * curIm
        const vIm = re[i + k + len / 2] * curIm + im[i + k + len / 2] * curRe
        re[i + k] = uRe + vRe
        im[i + k] = uIm + vIm
        re[i + k + len / 2] = uRe - vRe
        im[i + k + len / 2] = uIm - vIm
        const nextRe = curRe * wRe - curIm * wIm
        const nextIm = curRe * wIm + curIm * wRe
        curRe = nextRe; curIm = nextIm
      }
    }
  }
}

export const IQ_FFT_SIZE = 4096
const IQ_MIN_DB = -90
const IQ_MAX_DB = -10

// Owns the accumulate-a-window / FFT / fftshift / byte-map pipeline, kept
// as its own class (rather than closures inside useIQBridge, like the rest
// of this file) specifically so IQSpectrumPanel.tsx can hold one instance
// per rendered channel without re-deriving this math — mirrors
// AudioQualityPanel.tsx's AudioQualityChannel owning its own per-channel
// scratch state.
export class IQSpectrumComputer {
  private accumRe = new Float64Array(IQ_FFT_SIZE)
  private accumIm = new Float64Array(IQ_FFT_SIZE)
  private accumCount = 0
  private fftRe = new Float64Array(IQ_FFT_SIZE)
  private fftIm = new Float64Array(IQ_FFT_SIZE)
  // fftshift'd (bin 0 = most-negative frequency, center bin = 0Hz, last
  // bin = just below +Nyquist) byte-scaled magnitude, same 0-255
  // log-dB-mapped convention as AnalyserNode.getByteFrequencyData() so
  // this can feed GLSpectrogram.pushRow() exactly like AudioQualityPanel's
  // real-valued analyser data does.
  magBytes = new Uint8Array(IQ_FFT_SIZE)
  peakDb = -Infinity
  private hasFreshWindow = false

  // Feeds one incoming interleaved I/Q Int16Array frame (I,Q,I,Q,...) into
  // the accumulator, running the FFT every time a full IQ_FFT_SIZE window
  // fills. A frame can be smaller or larger than the remaining space, so
  // this loops rather than assuming a 1:1 frame-to-window relationship —
  // frame size depends on the bridge's configured sample rate (its 50ms
  // read window), window size here is fixed. Deliberately NOT
  // overlapping/carrying phase across windows the way useAudioBridge.ts's
  // ResampleState does for its resampler — a fresh, independent FFT window
  // each time is simpler and correct for a diagnostic spectrum view; there
  // is no continuity requirement between windows the way there is for a
  // resampled audio *waveform*.
  // iq: interleaved I,Q pairs, already float-normalized to roughly [-1,1]
  // and already through whatever upstream correction stages (DC removal,
  // imbalance correction, swap/negate) are enabled — see onmessage's own
  // comment for the full pipeline order. This class no longer does the
  // int16-to-float conversion itself so every consumer of the corrected
  // stream (this, and SSBDemodulator.demodulate()) agrees on exactly the
  // same corrected values.
  feed(iq: Float64Array): void {
    let offset = 0
    const pairCount = iq.length >> 1
    while (offset < pairCount) {
      const remaining = IQ_FFT_SIZE - this.accumCount
      const take = Math.min(remaining, pairCount - offset)
      for (let i = 0; i < take; i++) {
        this.accumRe[this.accumCount + i] = iq[(offset + i) * 2]
        this.accumIm[this.accumCount + i] = iq[(offset + i) * 2 + 1]
      }
      this.accumCount += take
      offset += take
      if (this.accumCount >= IQ_FFT_SIZE) {
        this.processWindow()
        this.accumCount = 0
      }
    }
  }

  private processWindow(): void {
    this.fftRe.set(this.accumRe)
    this.fftIm.set(this.accumIm)
    fftRadix2(this.fftRe, this.fftIm)

    const n = IQ_FFT_SIZE
    const half = n / 2
    let peakDb = -Infinity
    for (let i = 0; i < n; i++) {
      // fftshift: natural FFT order is 0..+Nyquist then -Nyquist..0; bin i
      // maps to display bin (i + half) % n, so the display array reads
      // most-negative-frequency-first with 0Hz exactly at the center —
      // matches the ESP32 control page's own I/Q spectrum view convention.
      const dstIdx = (i + half) % n
      const mag = Math.sqrt(this.fftRe[i] * this.fftRe[i] + this.fftIm[i] * this.fftIm[i]) / n
      const db = 20 * Math.log10(Math.max(mag, 1e-12))
      if (db > peakDb) peakDb = db
      const frac = (db - IQ_MIN_DB) / (IQ_MAX_DB - IQ_MIN_DB)
      this.magBytes[dstIdx] = Math.max(0, Math.min(255, Math.round(frac * 255)))
    }
    this.peakDb = peakDb
    this.hasFreshWindow = true
  }

  // True exactly once after a window actually completed since the last
  // call — lets a consumer's render loop skip redundant work (re-pushing
  // the same row to a waterfall) between arrivals, without needing its own
  // dirty-tracking.
  consumeFreshFlag(): boolean {
    const was = this.hasFreshWindow
    this.hasFreshWindow = false
    return was
  }
}

// Removes DC offset/LO-leakage from each channel independently — a
// one-pole leaky integrator tracking each channel's running mean,
// subtracted per-sample. Real hardware direct-conversion I/Q receivers
// commonly show a spike exactly at 0Hz from mixer self-mixing or ADC/
// analog-frontend DC offset; left in place, that offset gets frequency-
// TRANSLATED by SSBDemodulator's complex mixer into a tone at exactly
// centerHz (the tuned frequency) — i.e. it doesn't just look bad in the
// spectrum display, it actively corrupts demodulated audio at the exact
// frequency being listened to. Applied once, upstream of both
// spectrum.feed() and the demodulator (see onmessage's pipeline comment),
// so both agree and the imbalance corrector below (which assumes
// near-zero-mean I/Q for its statistics to be unbiased) sees clean input.
//
// alpha sets the cutoff frequency (roughly alpha * sampleRateHz / 2π) —
// small enough to sit well below any signal of interest (a few Hz) while
// still tracking slow thermal/analog drift. Per-sample (not per-frame)
// update to avoid a step discontinuity at each ~50ms frame boundary,
// which the demodulator's carried-history filters would otherwise see as
// a periodic click.
const DC_REMOVAL_ALPHA = 0.001
class DCRemover {
  private dcI = 0
  private dcQ = 0

  // iq: interleaved I,Q pairs, modified in place.
  process(iq: Float64Array): void {
    const pairCount = iq.length >> 1
    for (let n = 0; n < pairCount; n++) {
      this.dcI += DC_REMOVAL_ALPHA * (iq[n * 2] - this.dcI)
      this.dcQ += DC_REMOVAL_ALPHA * (iq[n * 2 + 1] - this.dcQ)
      iq[n * 2] -= this.dcI
      iq[n * 2 + 1] -= this.dcQ
    }
  }
}

// Corrects I/Q gain and phase imbalance — the two ADC/mixer channels not
// being exactly equal amplitude and exactly 90 degrees apart. Unlike a
// literal channel swap or a single channel's wrong sign (see IQCorrection
// below, which fixes a FULL spectral mirror), this defect produces a
// real signal's PARTIAL mirror image at reduced amplitude on the
// opposite side of 0Hz while the true signal stays in place — a
// continuous calibration error, not a discrete flip, and swap/negate
// cannot fix it.
//
// Model: let a(n),b(n) be the true orthogonal baseband I/Q. An
// imbalanced front-end produces I=a, Q=g*(b*cosφ + a*sinφ) — g is Q's
// gain relative to I, φ is the phase error. Assuming a broadband/generic
// signal (E[a²]=E[b²]=P, E[ab]≈0 — true for noise or any signal that
// isn't a single perfectly-real tone exactly at DC, see below):
//   E[I²]=P, E[Q²]=g²P, E[IQ]=g·P·sinφ
// so g_est=sqrt(E[Q²]/E[I²]), sinPhi_est=E[IQ]/sqrt(E[I²]·E[Q²]).
// Inverting for b given I=a known: b=(Q/g - I·sinφ)/cosφ, giving the
// correction Q'=(Q/g_est - I·sinPhi_est)/sqrt(1-sinPhi_est²), I'=I. This
// is the standard moment-based blind I/Q imbalance estimator used in SDR
// software generally (sometimes attributed to Cordesses) — verified here
// by direct derivation from the imbalance model above, not assumed.
//
// Continuously adaptive (slow EMA, not a one-shot calibration button):
// gain/phase imbalance is a physical front-end property that changes
// slowly if at all (thermal drift), so a slow-moving estimate is
// appropriate — the correction APPLIED to a given frame uses the
// estimate as converged BEFORE that frame (updated from stats that
// include this frame, applied starting next frame), avoiding a circular
// same-sample dependency. Guards: freezes (does not update, and does not
// apply an invalid value) when signal power is too low to estimate from
// (near-silence, where the ratio is dominated by quantization noise) or
// when the estimate would produce a numerically invalid correction
// (sinPhi_est clamped inside [-1,1], sqrt(1-sinPhi²) guarded from
// hitting zero/imaginary).
const IMBALANCE_EMA_ALPHA = 0.001
const IMBALANCE_POWER_FLOOR = 1e-6 // ~-60dBFS-ish on this app's [-1,1]-normalized scale
class ImbalanceCorrector {
  private emaI2 = 1
  private emaQ2 = 1
  private emaIQ = 0
  private gEst = 1
  private sinPhiEst = 0

  // iq: interleaved I,Q pairs, modified in place using the estimate as
  // converged BEFORE this call, then updates the estimate from this
  // call's own (pre-correction) statistics for use starting next call.
  process(iq: Float64Array): void {
    const pairCount = iq.length >> 1
    const cosPhi = Math.sqrt(Math.max(0, 1 - this.sinPhiEst * this.sinPhiEst))
    for (let n = 0; n < pairCount; n++) {
      const i = iq[n * 2]
      const q = iq[n * 2 + 1]
      iq[n * 2 + 1] = (q / this.gEst - i * this.sinPhiEst) / cosPhi
      // i unchanged — the model treats I as the reference channel.

      this.emaI2 += IMBALANCE_EMA_ALPHA * (i * i - this.emaI2)
      this.emaQ2 += IMBALANCE_EMA_ALPHA * (q * q - this.emaQ2)
      this.emaIQ += IMBALANCE_EMA_ALPHA * (i * q - this.emaIQ)
    }

    const signalPower = this.emaI2 + this.emaQ2
    if (signalPower < IMBALANCE_POWER_FLOOR || this.emaI2 < IMBALANCE_POWER_FLOOR) {
      return // not enough signal to estimate from — freeze at last-known-good values
    }
    const gEst = Math.sqrt(this.emaQ2 / this.emaI2)
    const denom = Math.sqrt(this.emaI2 * this.emaQ2)
    let sinPhiEst = denom > 0 ? this.emaIQ / denom : 0
    sinPhiEst = Math.max(-0.99, Math.min(0.99, sinPhiEst))
    if (gEst > 0.1 && gEst < 10 && Number.isFinite(gEst) && Number.isFinite(sinPhiEst)) {
      this.gEst = gEst
      this.sinPhiEst = sinPhiEst
    }
  }
}

// Automatic gain control on the DEMODULATED AUDIO (applied to
// SSBDemodulator's output, not the raw I/Q — see playDemodulatedFrame()'s
// call site) — ported from the uSDX BLACK_BRICK radio firmware's own
// "M0PUB" AGC (usdxBLACKBRICK.ino's process_agc(), the algorithm an actual
// SSB radio ships with), NOT from any browser-DSP-project source: this
// fills a gap neither this app nor BrowSDR ever had — there was no gain
// leveling on decoded audio at all before this, so a strong signal could
// clip while a weak one sat inaudibly quiet.
//
// Ported behavior, not mechanics: the firmware's version is fixed-point
// int16 arithmetic (centiGain, HI()/LO() byte-shift tricks) built for an
// FPU-less AVR — none of that has any value on a browser with a real
// float64 ALU, so this reimplements the same THREE-PART shape in plain
// floats against this app's [-1,1]-normalized sample scale instead of the
// firmware's int16 one:
//   1. Fast attack: the moment a peak exceeds the upper threshold, cut
//      gain by a fixed fraction immediately (per-sample, no delay).
//   2. Slow, WINDOWED decay: gain only adjusts once per AGC_WINDOW_SAMPLES
//      samples, not per-sample — this "settle, don't hunt" behavior (the
//      firmware's own comment, process_agc() line ~2782) is what
//      distinguishes this from a naive peak-follower AGC (e.g. BrowSDR's
//      3-line version, which lacks windowing and pumps more visibly).
//   3. A target WINDOW (not a single setpoint) between lowerThreshold and
//      upperThreshold — gain only ramps up if EVERY sample in a whole
//      window stayed below the lower threshold, and eases back down
//      (at half the up-rate, matching the firmware) if any sample in the
//      window reached the target range or above.
// gainMin/gainMax bound the same way CENTIGAIN_MAX does in the firmware
// (never below 0.25x, matching the firmware's 32/128 floor; capped well
// above what any real headroom needs so a dead/silent band can't have its
// noise floor amplified into a loud hiss).
const AGC_ATTACK_FACTOR = 1 - 1 / 16 // matches centiGain -= centiGain>>4
const AGC_DECAY_UP_FACTOR = 1 + 1 / 16 // matches centiGain += centiGain>>4
const AGC_DECAY_DOWN_FACTOR = 1 - 1 / 32 // half the up-rate, matches the firmware's own comment
const AGC_WINDOW_SAMPLES = 400 // matches DECAY_FACTOR
const AGC_GAIN_MIN = 0.25
const AGC_GAIN_MAX = 255
// Matches the firmware's own agc_lvl menu item exactly: [1,14], default 4
// (see usdxBLACKBRICK.ino's "agc_lvl" comment — "higher = louder output
// before AGC clamps"). Target window (as a fraction of this app's [-1,1]
// full-scale) is agcLevel/128 .. agcLevel*1.5/128, the same
// agc_lvl*256/384-out-of-32768 relationship the firmware uses, just
// re-expressed on a float scale instead of int16.
export const AGC_LEVEL_MIN = 1
export const AGC_LEVEL_MAX = 14
export const AGC_LEVEL_DEFAULT = 4
export class AGC {
  private gain = 1
  private decayCount = AGC_WINDOW_SAMPLES
  private staySmall = true // true until any sample in the current window reaches the lower threshold
  private lowerThreshold: number
  private upperThreshold: number

  constructor(agcLevel: number = AGC_LEVEL_DEFAULT) {
    this.lowerThreshold = agcLevel / 128
    this.upperThreshold = (agcLevel * 1.5) / 128
  }

  // Same "remembered until changed again" pattern as the other I/Q
  // controls — does not reset gain/decay state, so adjusting the target
  // mid-session doesn't cause an audible glitch, just a smoother retarget
  // over the next few decay windows.
  setLevel(agcLevel: number): void {
    const clamped = Math.max(AGC_LEVEL_MIN, Math.min(AGC_LEVEL_MAX, agcLevel))
    this.lowerThreshold = clamped / 128
    this.upperThreshold = (clamped * 1.5) / 128
  }

  // samples: demodulated audio, modified in place.
  process(samples: Float32Array): void {
    for (let n = 0; n < samples.length; n++) {
      const out = samples[n] * this.gain
      samples[n] = out
      const mag = Math.abs(out)

      if (mag > this.upperThreshold) {
        this.gain *= AGC_ATTACK_FACTOR // fast attack, every sample while over threshold
      } else {
        if (mag > this.lowerThreshold) this.staySmall = false
        if (--this.decayCount === 0) {
          if (this.staySmall) {
            this.gain = Math.min(AGC_GAIN_MAX, this.gain * AGC_DECAY_UP_FACTOR)
          } else if (this.gain > AGC_GAIN_MIN) {
            this.gain = Math.max(AGC_GAIN_MIN, this.gain * AGC_DECAY_DOWN_FACTOR)
          }
          this.decayCount = AGC_WINDOW_SAMPLES
          this.staySmall = true
        }
      }
    }
  }
}

// ── Spectral noise reduction ─────────────────────────────────────────────
// FFT-overlap-add spectral subtraction on the DEMODULATED AUDIO — applied
// after AGC/highpass (see playDemodulatedFrame()'s call site), the last
// stage before playback/decode. This is NEW work, not a port: neither the
// uSDX firmware nor jLynx/BrowSDR implement spectral/Wiener-style noise
// reduction anywhere (confirmed directly against both — the firmware's own
// "NR" levels are just fixed-cutoff audio-bandwidth narrowing, see
// process_nr()'s own comment in usdxBLACKBRICK.ino; BrowSDR's DSP chain has
// no noise-reduction stage at all beyond AGC/squelch/DC-blocking). This
// fills a gap neither reference implementation covers.
//
// Algorithm (rewritten 2026-08-25 — see PER-FRAME MEDIAN note below for
// why): overlap-add spectral subtraction against a PER-FRAME median noise
// estimate, not a cross-frame minimum-statistics history —
//   1. Frame the input into NR_FFT_SIZE-sample windows, NR_HOP_SIZE apart
//      (50% overlap — NR_HOP_SIZE = NR_FFT_SIZE/2), each windowed with a
//      Hann window. 50% overlap with a Hann window is the standard choice
//      because summing two Hann-windowed, half-overlapped frames
//      reconstructs a FLAT unity gain — no separate normalization step
//      needed at the overlap-add stage.
//   2. Forward FFT (reusing fftRadix2 above) to get a complex spectrum per
//      frame.
//   3. Take the MEDIAN magnitude across all bins in THIS SINGLE FRAME as
//      the noise-floor estimate, scaled by NR_MEDIAN_MULT. No cross-frame
//      history at all — every frame is normalized independently against
//      its own median. This is a real, different failure-mode profile
//      than the earlier minimum-statistics-over-time approach it replaces
//      (see PER-FRAME MEDIAN note).
//   4. Apply a Wiener-style gain per bin: gain = signalPower / (signalPower
//      + noisePower), soft-floored at NR_GAIN_FLOOR rather than allowed to
//      hit zero — a hard zero-gain bin is exactly what produces "musical
//      noise" (isolated tone-like artifacts as bins randomly hit the noise
//      floor and get muted then unmuted) — the classic, well-documented
//      failure mode of naive spectral subtraction. The soft floor trades a
//      little residual noise for avoiding that artifact entirely.
//   5. Inverse FFT, re-window (Hann again — matched analysis/synthesis
//      windowing, standard for overlap-add), overlap-add into the output.
//
// PER-FRAME MEDIAN, not cross-frame minimum-statistics: an earlier version
// of this class tracked each bin's noise floor as the minimum magnitude
// seen over a sliding history of past frames (the standard minimum-
// statistics technique) — real-world testing (2026-08-25) found it made
// live FT8 audio sound "eerie/blurred," and a synthetic multi-station
// FT8-like signal (several simultaneous stations, each hopping among 8
// tones roughly every 160ms) proved why: any bin carrying a SUSTAINED real
// tone over several seconds eventually has its own recent history —
// including its own tone — become the "minimum ever seen," so the
// estimator's inflation factor pushed the inferred noise floor ABOVE the
// tone's own magnitude, and the resulting decision-directed feedback loop
// (needed to protect real signal from single-frame noise spikes) then
// ground that bin's gain down toward zero over several seconds — a
// continuous 700kHz-style test tone measured fine at 1 second in (matching
// the OLD test suite's 1-second-duration check) but was crushed to ~15% of
// its original amplitude by 15 seconds in, exactly FT8's own window
// length. No tuning of that history/bias approach's constants fixed this
// without also destroying its actual noise suppression (see
// noiseReducer.test.ts's git history for the tuning sweep). A per-frame
// median has no history to poison in the first place — verified directly
// against both the original single-tone test AND the new multi-station
// test, with STABLE tone preservation from 1 second through 15 seconds.
const NR_FFT_SIZE = 1024
const NR_HOP_SIZE = NR_FFT_SIZE / 2 // 50% overlap
const NR_GAIN_FLOOR = 0.15 // soft floor — see algorithm step 4's comment on why this isn't 0
// How far above the per-frame median a bin's magnitude must sit to read as
// mostly-signal rather than mostly-noise — see noiseFloor()'s own comment.
// Tuned empirically (noiseReducer.test.ts) against the synthetic
// multi-station FT8-like signal (want: output RMS stays a healthy fraction
// of input, i.e. real tone energy survives) and pure-noise-floor
// suppression (want: a clear, measurable RMS reduction) simultaneously.
const NR_MEDIAN_MULT = 3.0

function hannWindow(n: number, size: number): number {
  return 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / (size - 1))
}

// In-place median of a Float64Array via a full sort — binCount is small
// (513 for NR_FFT_SIZE=1024) and this runs once per hop (~10.7ms of audio
// at 48kHz), not per-sample, so an O(n log n) sort here is negligible next
// to the FFT this class already does every frame.
function median(sorted: Float64Array): number {
  sorted.sort()
  const mid = sorted.length >> 1
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

export class NoiseReducer {
  private readonly window = new Float64Array(NR_FFT_SIZE)
  // Analysis frame buffer — holds the last NR_FFT_SIZE samples seen, laid
  // out oldest-first. Since a new frame is only ever assembled once a full
  // NR_HOP_SIZE (= NR_FFT_SIZE/2) of new samples has arrived, this can be
  // rebuilt each time by keeping the OLD frame's second half (which is
  // exactly the previous hop's new samples) and appending the new hop's
  // samples — two Float64Array.set() block copies per frame, not a
  // per-sample shift (an earlier draft of this class shifted the whole
  // buffer one sample at a time here, an O(N) operation PER INPUT SAMPLE
  // — O(N²) overall for a 1024-sample frame, easily 10s of millions of
  // wasted array-copy operations per second of real audio; caught before
  // this ever ran against real audio, fixed by only ever moving whole
  // half-frame blocks).
  private inputBuf = new Float64Array(NR_FFT_SIZE)
  // Accumulates new samples until a full hop is ready to assemble a frame.
  private readonly pendingHop = new Float64Array(NR_HOP_SIZE)
  private pendingFill = 0
  // Output overlap-add accumulator — one frame's inverse-FFT result is
  // added into this buffer at the current write position, then
  // NR_HOP_SIZE samples are drained from the front once ready.
  private outputAcc = new Float64Array(NR_FFT_SIZE)
  private readonly binCount = NR_FFT_SIZE / 2 + 1 // real-signal FFT has this many independent bins (0..Nyquist)
  // Scratch buffer for this frame's per-bin magnitudes, indexed by bin —
  // read back by processFrame()'s second loop, so must survive
  // noiseFloor()'s median() call unmodified.
  private readonly magScratch = new Float64Array(this.binCount)
  // Separate scratch median() actually sorts in place — kept distinct from
  // magScratch (a copy taken each frame) specifically so sorting for the
  // median doesn't scramble magScratch's bin-index ordering, which the
  // second loop still needs.
  private readonly sortScratch = new Float64Array(this.binCount)

  private readonly fftRe = new Float64Array(NR_FFT_SIZE)
  private readonly fftIm = new Float64Array(NR_FFT_SIZE)

  constructor() {
    for (let n = 0; n < NR_FFT_SIZE; n++) this.window[n] = hannWindow(n, NR_FFT_SIZE)
  }

  // Estimates THIS FRAME's noise floor as the median magnitude across all
  // bins, scaled by NR_MEDIAN_MULT — see this section's header comment for
  // why per-frame median replaced the earlier cross-frame minimum-
  // statistics approach. A multiplier above 1 is needed because the raw
  // median alone barely suppresses stationary noise at all (roughly half
  // of any bin population sits above its own median by definition) — a
  // bin sitting exactly AT the median reads as "typical for this
  // instant," not automatically "real signal," so gain needs the
  // multiplier's headroom before the Wiener formula meaningfully favors
  // passing a bin through.
  private noiseFloor(): number {
    this.sortScratch.set(this.magScratch)
    return median(this.sortScratch) * NR_MEDIAN_MULT
  }

  private processFrame(): void {
    // Analysis: window the current NR_FFT_SIZE input frame, forward FFT.
    for (let n = 0; n < NR_FFT_SIZE; n++) {
      this.fftRe[n] = this.inputBuf[n] * this.window[n]
      this.fftIm[n] = 0
    }
    fftRadix2(this.fftRe, this.fftIm)

    // Only the independent bins (0..Nyquist) need computing; bin k's
    // magnitude mirrors bin (N-k) for a real input, and fftRadix2 leaves
    // that conjugate symmetry intact automatically since fftIm started at
    // 0. Magnitudes are computed once up front (into magScratch) so
    // noiseFloor() can take THIS FRAME's median before any bin's gain is
    // applied — order matters: applying gain to fftRe/fftIm in the same
    // pass would corrupt later bins' magnitude if read from there instead.
    for (let bin = 0; bin < this.binCount; bin++) {
      const re = this.fftRe[bin]
      const im = this.fftIm[bin]
      this.magScratch[bin] = Math.sqrt(re * re + im * im)
    }
    const noiseMag = this.noiseFloor()
    const noisePower = noiseMag * noiseMag

    for (let bin = 0; bin < this.binCount; bin++) {
      const mag = this.magScratch[bin]
      const signalPower = mag * mag
      // Wiener gain: gain = signalPower / (signalPower + noisePower) ==
      // snr / (1 + snr) — no cross-frame smoothing needed (see this
      // section's header comment for why a per-frame estimate replaced
      // the earlier decision-directed approach entirely, not just its
      // bias constant).
      const snr = noisePower > 0 ? signalPower / noisePower : signalPower > 0 ? Infinity : 0
      const rawGain = snr / (1 + snr)
      // Floor applied only to the gain actually used to scale this bin —
      // see algorithm step 4's comment on why 0 would be wrong here.
      const gain = NR_GAIN_FLOOR + (1 - NR_GAIN_FLOOR) * rawGain

      this.fftRe[bin] *= gain
      this.fftIm[bin] *= gain
      if (bin > 0 && bin < NR_FFT_SIZE - bin) {
        // Mirror bin (conjugate) — keep the inverse FFT's output real by
        // applying the SAME real-valued gain to both halves of the pair.
        const mirror = NR_FFT_SIZE - bin
        this.fftRe[mirror] *= gain
        this.fftIm[mirror] *= gain
      }
    }

    // Synthesis: inverse FFT (conjugate trick: forward-FFT the conjugated
    // spectrum, conjugate and scale the result — avoids a second,
    // separately-tested inverse-transform implementation), re-window, and
    // overlap-add into the output accumulator.
    for (let n = 0; n < NR_FFT_SIZE; n++) this.fftIm[n] = -this.fftIm[n]
    fftRadix2(this.fftRe, this.fftIm)
    for (let n = 0; n < NR_FFT_SIZE; n++) {
      const sample = (this.fftRe[n] / NR_FFT_SIZE) * this.window[n]
      this.outputAcc[n] += sample
    }
  }

  // samples: demodulated audio (post-AGC/highpass). Returns a NEW
  // Float32Array of however many fully-reconstructed output samples are
  // ready this call — 0 length is normal (and expected on early calls,
  // before the first NR_FFT_SIZE-sample frame has even accumulated) since
  // this stage adds real latency, same as any block-based FFT technique.
  // Return type explicitly pinned to Float32Array<ArrayBuffer> — the
  // underlying array is always constructed via `new Float32Array(number)`
  // (see maxOutLen below), which TypeScript's own typed-array constructor
  // overload types as exactly this, but .subarray()'s return type widens
  // to the more general ArrayBufferLike-backed form regardless of what it
  // was actually called on. AudioBuffer.copyToChannel() (this class's only
  // real caller, via playDemodulatedFrame()) requires the narrower type.
  process(samples: Float32Array): Float32Array<ArrayBuffer> {
    // Pre-allocated against the worst case (a hop fully completes on
    // every single input sample) rather than an unbounded number[] +
    // Float32Array conversion at the end — that intermediate array both
    // costs an extra allocation/boxing pass AND (the reason this changed)
    // produces a Float32Array backed by a plain ArrayBufferLike, not the
    // concrete ArrayBuffer type AudioBuffer.copyToChannel() requires,
    // which TypeScript's typed-array generics now distinguish.
    const maxOutLen = Math.ceil(samples.length / NR_HOP_SIZE) * NR_HOP_SIZE
    const out = new Float32Array(maxOutLen)
    let outLen = 0

    let offset = 0
    while (offset < samples.length) {
      const take = Math.min(NR_HOP_SIZE - this.pendingFill, samples.length - offset)
      for (let i = 0; i < take; i++) this.pendingHop[this.pendingFill + i] = samples[offset + i]
      this.pendingFill += take
      offset += take

      if (this.pendingFill >= NR_HOP_SIZE) {
        this.pendingFill = 0
        // Assemble the new analysis frame: the OLD frame's second half
        // (already exactly the previous hop's samples) becomes the new
        // frame's first half, and this hop's new samples become the
        // second half — two block copies, no per-sample work.
        this.inputBuf.copyWithin(0, NR_HOP_SIZE)
        for (let i = 0; i < NR_HOP_SIZE; i++) this.inputBuf[NR_HOP_SIZE + i] = this.pendingHop[i]

        this.processFrame()
        // Drain the first NR_HOP_SIZE samples of the overlap-add
        // accumulator — those positions have now received their full
        // contribution from every overlapping frame (this frame's tail
        // half, and the previous frame's head half), and shift the
        // remainder down to make room for the next frame's contribution.
        for (let n = 0; n < NR_HOP_SIZE; n++) out[outLen + n] = this.outputAcc[n]
        outLen += NR_HOP_SIZE
        this.outputAcc.copyWithin(0, NR_HOP_SIZE)
        this.outputAcc.fill(0, NR_FFT_SIZE - NR_HOP_SIZE)
      }
    }
    return out.subarray(0, outLen)
  }
}

// ── FIR filter math — ported from jLynx/BrowSDR (github.com/jLynx/BrowSDR),
// src/client/worker/dsp-pipeline.ts, itself modeled on SDR++'s dsp/taps &
// dsp/window. Copyright (c) 2026, jLynx <https://github.com/jLynx>; BSD-3-
// Clause-style license (see that file). Adopted here specifically because
// FIRFilter's per-sample circular-buffer convolution is genuinely, provably
// causal (never reads a "future" sample relative to the one just pushed) —
// a hand-rolled "centered" convolution attempted earlier in this file's
// history read up to (taps/2) samples FORWARD of the current position to
// keep the window symmetric, which only exist within the SAME processing
// call; no forward history is ever carried across calls, only backward, so
// every call's trailing ~(taps/2) samples silently ran off the end of the
// buffer and got convolved with a truncated kernel — inaudible at a short
// filter length, but an audible, periodic (every processing-call boundary)
// discontinuity once a filter is long enough for that truncation to matter.
// FIRFilter's design has no such failure mode: every tap read is strictly
// backward-looking by construction.
export const sinc = (x: number): number => (x === 0.0 ? 1.0 : Math.sin(x) / x)

export const cosineWindow = (n: number, N: number, coefs: number[]): number => {
  let win = 0.0
  let sign = 1.0
  for (let i = 0; i < coefs.length; i++) {
    win += sign * coefs[i] * Math.cos((i * 2.0 * Math.PI * n) / N)
    sign = -sign
  }
  return win
}

// 4-term Nuttall window — lower sidelobes than the Blackman window this
// codebase used previously, at the same tap count.
export const nuttall = (n: number, N: number): number => {
  const coefs = [0.355768, 0.487396, 0.144232, 0.012604]
  return cosineWindow(n, N, coefs)
}

export const hzToRads = (freq: number, samplerate: number): number => 2.0 * Math.PI * (freq / samplerate)

export const estimateTapCount = (transWidth: number, samplerate: number): number => {
  return Math.floor((3.8 * samplerate) / transWidth)
}

export const windowedSincBase = (
  count: number,
  omega: number,
  windowFunc: (n: number, N: number) => number,
  norm = 1.0,
): Float64Array => {
  const taps = new Float64Array(count)
  const half = count / 2.0
  const corr = (norm * omega) / Math.PI
  for (let i = 0; i < count; i++) {
    const t = i - half + 0.5
    taps[i] = sinc(t * omega) * windowFunc(t - half, count) * corr
  }
  return taps
}

// oddTapCount not exposed — this app always wants FIRFilter's plain
// circular-buffer form, which has no even/odd-length requirement (unlike a
// "centered" convolution, which needs an odd length for a well-defined
// middle tap).
export const lowPassTaps = (cutoff: number, transWidth: number, samplerate: number): Float64Array => {
  const count = estimateTapCount(transWidth, samplerate)
  const omega = hzToRads(cutoff, samplerate)
  return windowedSincBase(count, omega, (n, N) => nuttall(n, N))
}

// Spectral inversion of a lowpass kernel — negate every tap, then add 1 to
// the CENTER tap (a highpass = an all-pass delta minus the lowpass; the
// delta is 1 at the center sample, 0 elsewhere). Same technique BrowSDR
// uses for its own highpass — deferred in this app's earlier BrowSDR
// import pass ("hold off until the FIR rewrite is stable"), unblocked now
// that FIRFilter has been in production a while. Requires an ODD tap
// count so there's a single unambiguous center index — lowPassTaps'
// estimateTapCount() has no odd/even guarantee, so this bumps by one if
// needed (harmless: one extra tap is immaterial to the filter's shape).
export const highPassTaps = (cutoff: number, transWidth: number, samplerate: number): Float64Array => {
  const low = lowPassTaps(cutoff, transWidth, samplerate)
  const count = low.length % 2 === 1 ? low.length : low.length + 1
  const omega = hzToRads(cutoff, samplerate)
  const taps = windowedSincBase(count, omega, (n, N) => nuttall(n, N))
  for (let i = 0; i < taps.length; i++) taps[i] = -taps[i]
  taps[(taps.length - 1) / 2] += 1
  return taps
}

// Genuinely causal, per-sample FIR — see this section's header comment for
// why this replaced a hand-rolled "centered" convolution. Circular history
// buffer, O(taps) per sample, taps.length can differ from history.length
// only briefly during setTaps() (both are always resized together).
export class FIRFilter {
  taps: Float64Array
  history: Float64Array
  histIdx: number

  constructor(taps?: Float64Array) {
    this.taps = taps ?? new Float64Array([1.0])
    this.history = new Float64Array(this.taps.length)
    this.histIdx = 0
  }

  setTaps(taps: Float64Array): void {
    this.taps = taps
    this.history = new Float64Array(this.taps.length)
    this.histIdx = 0
  }

  reset(): void {
    this.history.fill(0)
    this.histIdx = 0
  }

  processOne(sample: number): number {
    this.history[this.histIdx] = sample
    let out = 0
    let tapIdx = 0
    // Circular buffer dot product: from histIdx down to 0, then from the
    // end of the history buffer down to histIdx+1 — together these visit
    // every history sample exactly once, most-recent-first, which is what
    // convolving against taps[0..] (also most-recent-tap-first) requires.
    for (let i = this.histIdx; i >= 0; i--) out += this.history[i] * this.taps[tapIdx++]
    for (let i = this.history.length - 1; i > this.histIdx; i--) out += this.history[i] * this.taps[tapIdx++]
    this.histIdx++
    if (this.histIdx >= this.history.length) this.histIdx = 0
    return out
  }
}

// Demodulates raw interleaved I/Q into real-valued mono audio at the SAME
// sample rate the I/Q arrived at (no resampling/decimation here — playFrame()
// -style playback below hands rate conversion to AudioBuffer/
// AudioBufferSourceNode exactly like useAudioBridge.ts's playFrame() already
// does for /audio). Two stages per call, both streaming (state carried
// across calls so a frame boundary never introduces a phase/filter
// discontinuity):
//   1. Complex mixer — shifts the operator-selected center frequency down to
//      0Hz by multiplying I/Q by e^{-j*2*pi*f_offset*n/fs}, via a running
//      phase accumulator (see setPassband()/mixerPhase), then a per-channel
//      FIRFilter (real lowpass, applied identically to shifted-I and
//      shifted-Q) rejects everything outside the chosen bandwidth.
//   2. Hilbert-transform phasing combine — same technique the uSDX radio's
//      own receiver uses: audio = (delayed I) ± Hilbert(Q), sign by
//      sideband. (An earlier version of this rewrite tried porting
//      BrowSDR's "rotate by ±bandwidth/2 and take the real part" technique
//      here instead — that trick assumes the PRECEDING complex filter has
//      already re-centered the passband so the carrier sits at
//      -bandwidth/2 from 0Hz, a different reference frame than this
//      pipeline's centerHz convention (audio content spans 0..+bandwidth/2
//      above centerHz, not centered around bandwidth/2) — applying it
//      directly double-shifted the audio by bandwidth/2 and was reverted
//      after a unit test caught the tone landing at the wrong frequency
//      entirely. The Hilbert combine below is the same, already-correct
//      math this file used before this rewrite; only its FILTER
//      IMPLEMENTATION changed, to FIRFilter's genuinely causal circular
//      buffer — see this section's header comment for why.)
function buildHilbertTaps(count: number): Float64Array {
  // Odd-symmetry FIR: even-indexed taps (including center) are exactly
  // zero, odd-indexed taps are the ideal Hilbert response 2/(pi*k) (k =
  // tap offset from center), Nuttall-windowed — same coefficients/window
  // family as this file's other ported tap generators, applied to the
  // Hilbert kernel shape specifically rather than a lowpass shape.
  if (count % 2 === 0) count++ // needs a well-defined center tap
  const center = (count - 1) / 2
  const taps = new Float64Array(count)
  for (let i = 0; i < count; i++) {
    const k = i - center
    if (k === 0 || k % 2 === 0) continue
    const ideal = 2 / (Math.PI * k)
    taps[i] = ideal * nuttall(i, count - 1)
  }
  // Reverse: this loop built taps[i] indexed so i=0 is the MOST NEGATIVE
  // offset from center (oldest relative sample) — but FIRFilter.processOne()
  // expects taps[0] to pair with the MOST RECENT history sample (see its
  // own comment: "convolving against taps[0..] (also most-recent-tap-
  // first)"). A real bug was found and fixed here: without this reversal,
  // an odd-symmetric kernel like this one gets applied with every tap's
  // sign effectively flipped (reversing an odd-symmetric array is
  // numerically equivalent to negating it), which doesn't just attenuate
  // the Hilbert transform's effect — it flips which sideband gets
  // reinforced vs. cancelled, collapsing SSB image rejection entirely
  // (confirmed by comparing output magnitude at the wanted frequency vs.
  // its mirror image: both came out IDENTICAL before this fix, meaning no
  // image rejection was happening at all — the two sidebands were being
  // combined in a way that split power evenly rather than cancelling one).
  taps.reverse()
  return taps
}
// Pure delay line (an impulse at the center tap) matching a same-length
// Hilbert filter's own group delay — I needs no actual filtering, just
// the same (count-1)/2-sample delay the Hilbert-filtered Q rail
// accumulates, so both rails stay time-aligned at the combine step.
function buildDelayTaps(count: number): Float64Array {
  if (count % 2 === 0) count++
  const taps = new Float64Array(count)
  taps[(count - 1) / 2] = 1
  return taps
}
const HILBERT_TAPS = 129 // odd; ~64-tap-equivalent transition band either side, plenty for a 2.7kHz-ish SSB passband well under any of this bridge's I/Q sample rates

// Fixed transition-band width for the passband lowpass — see
// SSBDemodulator.setPassband()'s comment for why this is an absolute Hz
// value (not scaled to the requested bandwidth) and why it's placed AFTER
// the requested edge rather than centered on it.
const PASSBAND_GUARD_HZ = 300

export class SSBDemodulator {
  private centerHz = 0
  private bandwidthHz = 2700 // a typical SSB voice passband width; overridden by setPassband()
  private mixerPhase = 0 // radians, carried across calls for phase continuity

  private lowpassSampleRateHz = FALLBACK_SAMPLE_RATE
  private lowpassI = new FIRFilter()
  private lowpassQ = new FIRFilter()
  private hilbertDelay = new FIRFilter(buildDelayTaps(HILBERT_TAPS))
  private hilbertQ = new FIRFilter(buildHilbertTaps(HILBERT_TAPS))
  // Applied to the DEMODULATED AUDIO (post-combine), matching the uSDX
  // radio firmware's own filt_var stage — a fixed 300Hz highpass corner
  // (usdxBLACKBRICK.ino). Off by default here (see loadHighpassEnabled()'s
  // comment) — this app has no voice mode, and real-signal testing found
  // this cutting genuine FT8/digital tone content, not just DC/hum. Built
  // via highPassTaps' spectral inversion of the SAME lowPassTaps machinery
  // already used for the main passband filter — see that function's own
  // comment for why this was deferred until now. The literal default below
  // is immediately overridden by useIQBridge()'s own
  // setHighpassEnabled(loadHighpassEnabled()) call at construction; kept
  // false here too so this class's OWN default matches, in case anything
  // ever constructs one directly without going through that hook.
  private highpass = new FIRFilter()
  private highpassEnabled = false

  // centerHz: how far the desired signal sits from the I/Q capture's own
  // 0Hz (baseband) center — positive/negative, driven by dragging the
  // SignalAnalysisPanel marker in I/Q mode. bandwidthHz: the marker's width,
  // clamped to a sane minimum so the lowpass taps stay well-defined.
  setPassband(centerHz: number, bandwidthHz: number, sampleRateHz: number): void {
    const bw = Math.max(50, bandwidthHz)
    this.centerHz = centerHz
    if (bw === this.bandwidthHz && sampleRateHz === this.lowpassSampleRateHz) return
    this.bandwidthHz = bw
    this.lowpassSampleRateHz = sampleRateHz
    // Cutoff at the FULL requested bandwidth, not half of it. This is a
    // phasing-method SSB demod: after the complex mixer shifts centerHz to
    // baseband 0Hz, the desired sideband's audio content occupies baseband
    // 0Hz..+bw (or 0Hz..-bw for LSB) — entirely on ONE side of zero, not
    // split symmetrically around it the way a DSB/AM signal would be. A
    // real bug lived here: this filter used to cut off at bw/2, which — for
    // a 3000Hz-wide passband — meant baseband content above +1500Hz (i.e.
    // audio above 1500Hz post-demod) was already deep in the transition
    // band or fully attenuated, silently capping every mode's decoded
    // audio bandwidth at roughly half of whatever width was configured
    // regardless of the per-mode default (see App.tsx's
    // IQ_PASSBAND_DEFAULTS) or this control's own Width field.
    //
    // transWidth is a FIXED absolute guard band (PASSBAND_GUARD_HZ),
    // placed just past the edge, rather than scaled relative to the
    // cutoff itself. A relative transition width (tried previously, see
    // below) makes sense for a voice/SSB passband, where a soft several-
    // hundred-Hz rolloff right at the nominal edge is inaudible and not
    // decode-relevant. It's the wrong shape for FT8/MFSK: many
    // simultaneous weak stations are decoded from tones spread across the
    // WHOLE nominal passband (down to real signals right at the edge WSJT-
    // X-style software tunes to), so a transition band that eats into the
    // last 30-50% of the passband (as `transWidth == cutoff` did) tilts
    // decode sensitivity against exactly the weak/edge signals a wideband
    // digital-mode passband exists to capture. Anchoring the guard band
    // AFTER bw instead keeps the entire requested passband flat to within
    // a few hundredths of a dB and pushes all the rolloff into a narrow
    // guard strip the operator never asked to receive in the first place.
    // A fixed (not bw-relative) guard also keeps tap count — and therefore
    // settling time — from scaling with bw: at 96kHz, this comes out to
    // ~1200 taps / ~12.5ms regardless of whether bw is CW's 500Hz or FT's
    // 3000Hz, comfortably inside this app's ~50ms/2400-sample frame
    // cadence (the constraint that ruled out an EARLIER, since-superseded
    // attempt at a relative transition width here: 10% of the old bw/2
    // cutoff produced estimateTapCount(135, 48000) = 1351 taps for a
    // typical 2700Hz-wide SSB passband, whose settling time — many tens of
    // thousands of samples for a sinc that long — badly exceeded one
    // frame, which is why a relative width was adopted in the first place;
    // a FIXED guard sidesteps that failure mode entirely instead of
    // reproducing it at a different ratio).
    const cutoffHz = bw + PASSBAND_GUARD_HZ / 2
    const taps = lowPassTaps(cutoffHz, PASSBAND_GUARD_HZ, sampleRateHz)
    this.lowpassI.setTaps(taps)
    // Q needs its OWN FIRFilter instance (not the same taps object shared
    // by reference issue — setTaps() already copies into a fresh history
    // buffer per instance) so its circular-buffer history stays
    // independent of I's, even though the tap coefficients themselves are
    // identical real values applied to both rails.
    this.lowpassQ.setTaps(taps)
    // 300Hz highpass, same fixed corner as the uSDX firmware's own
    // filt_var stage — see this.highpass's own comment. transWidth equal
    // to the cutoff itself, same 100%-relative reasoning as the lowpass
    // above (a narrow transition here would need a very long kernel for
    // essentially no audible benefit at this specific corner).
    this.highpass.setTaps(highPassTaps(300, 300, sampleRateHz))
  }

  setHighpassEnabled(enabled: boolean): void {
    this.highpassEnabled = enabled
  }

  // sideband: true = USB, false = LSB — matches the uSDX's own mode==USB
  // branch. CW/RTTY are treated as USB (a keyed/shifted tone within an
  // SSB-shaped passband, standard SDR practice); AM/FM aren't meaningfully
  // decodable via this technique, but defaulting them to USB is harmless
  // here since only the sideband mirror is affected, not decode
  // correctness for the modes that matter (FT8/MFSK only ever run on
  // USB/LSB-tuned signals).
  // iq: interleaved I,Q pairs, already float-normalized and already
  // through whatever upstream correction stages are enabled — see
  // IQSpectrumComputer.feed()'s comment; same contract.
  demodulate(iq: Float64Array, sideband: boolean, sampleRateHz: number): Float32Array<ArrayBuffer> {
    const pairCount = iq.length >> 1
    const out = new Float32Array(pairCount)
    if (sampleRateHz !== this.lowpassSampleRateHz) this.setPassband(this.centerHz, this.bandwidthHz, sampleRateHz)

    const mixAngStep = (-2 * Math.PI * this.centerHz) / sampleRateHz
    let mixPhase = this.mixerPhase
    const sign = sideband ? 1 : -1

    for (let n = 0; n < pairCount; n++) {
      const i = iq[n * 2]
      const q = iq[n * 2 + 1]

      // Stage 1: complex mixer (shift centerHz to 0Hz) then per-channel
      // lowpass — complex multiply (i + jq) * (c + js) = (i*c - q*s) +
      // j(i*s + q*c).
      const mc = Math.cos(mixPhase)
      const ms = Math.sin(mixPhase)
      const mixedI = i * mc - q * ms
      const mixedQ = i * ms + q * mc
      mixPhase += mixAngStep

      const filtI = this.lowpassI.processOne(mixedI)
      const filtQ = this.lowpassQ.processOne(mixedQ)

      // Stage 2: Hilbert-transform phasing combine — delayedI (via a pure
      // delay FIRFilter matching the Hilbert filter's own group delay) ±
      // Hilbert(Q), sign by sideband.
      const delayedI = this.hilbertDelay.processOne(filtI)
      const hilbertQ = this.hilbertQ.processOne(filtQ)
      const combined = delayedI + sign * hilbertQ
      out[n] = this.highpassEnabled ? this.highpass.processOne(combined) : combined
    }

    // Wrap to keep phase from growing unbounded over a long-running session
    // (float precision would otherwise degrade after many hours).
    this.mixerPhase = mixPhase % (2 * Math.PI)

    return out
  }
}

export function useIQBridge() {
  const [state, setState] = createSignal<IQBridgeState>({
    connected: false,
    reconnecting: false,
    inputMode: 'audio',
    sampleRateHz: FALLBACK_SAMPLE_RATE,
    lastFramePairs: 0,
    passbandCenterHz: loadPassbandCenterHz() ?? 0,
    passbandBandwidthHz: loadPassbandBandwidthHz() ?? 2700,
    error: null,
    playThroughSpeakers: loadPlayThroughSpeakers(),
    iqCorrection: loadIQCorrection(),
    dcRemovalEnabled: loadDCRemoval(),
    imbalanceCorrectionEnabled: loadImbalanceCorrection(),
    agcEnabled: loadAGCEnabled(),
    agcLevel: loadAGCLevel(),
    highpassEnabled: loadHighpassEnabled(),
    noiseReducerEnabled: loadNoiseReducerEnabled(),
    forceIQMode: loadForceIQMode(),
    forceSampleRateHz: loadForceSampleRateHz(),
    iqSignalDbfs: null,
  })

  let ws: WebSocket | null = null
  const spectrum = new IQSpectrumComputer()
  const demod = new SSBDemodulator()
  const dcRemover = new DCRemover()
  const imbalanceCorrector = new ImbalanceCorrector()
  const agc = new AGC(loadAGCLevel())
  const noiseReducer = new NoiseReducer()

  // Applied to every incoming frame before either the spectrum display or
  // the demodulator sees it — see onmessage's own comment for exactly
  // where, and IQCorrection's own comment for what each mode means and
  // why there are four. Persisted across reloads — this started as a
  // session-only diagnostic control (so a stale browser-side workaround
  // couldn't silently mask a real firmware/hardware fix), but an operator
  // who finds a setting that actually helps their specific hardware wants
  // it to survive a reload rather than re-discovering it every session.
  let iqCorrection: IQCorrection = loadIQCorrection()
  function setIQCorrection(mode: IQCorrection) {
    iqCorrection = mode
    saveIQCorrection(mode)
    setState((s) => ({ ...s, iqCorrection: mode }))
  }

  // Independent of iqCorrection and of each other — an operator might
  // need any combination (e.g. a real hardware swap AND genuine DC
  // leakage AND some residual imbalance, all at once). See
  // DCRemover/ImbalanceCorrector's own comments.
  let dcRemovalEnabled = loadDCRemoval()
  function setDCRemoval(enabled: boolean) {
    dcRemovalEnabled = enabled
    saveDCRemoval(enabled)
    setState((s) => ({ ...s, dcRemovalEnabled: enabled }))
  }
  let imbalanceCorrectionEnabled = loadImbalanceCorrection()
  function setImbalanceCorrection(enabled: boolean) {
    imbalanceCorrectionEnabled = enabled
    saveImbalanceCorrection(enabled)
    setState((s) => ({ ...s, imbalanceCorrectionEnabled: enabled }))
  }
  // Applied to demodulated AUDIO, not raw I/Q (see loadAGCEnabled()'s own
  // comment for why it defaults OFF) — independent of the three above,
  // which all operate on I/Q.
  let agcEnabled = loadAGCEnabled()
  function setAGCEnabled(enabled: boolean) {
    agcEnabled = enabled
    saveAGCEnabled(enabled)
    setState((s) => ({ ...s, agcEnabled: enabled }))
  }
  // See AGC.setLevel()'s comment — [1,14], matching the radio's own AGC
  // Level control.
  function setAGCLevel(level: number) {
    agc.setLevel(level)
    saveAGCLevel(level)
    setState((s) => ({ ...s, agcLevel: Math.max(AGC_LEVEL_MIN, Math.min(AGC_LEVEL_MAX, level)) }))
  }
  demod.setHighpassEnabled(loadHighpassEnabled())
  function setHighpassEnabled(enabled: boolean) {
    demod.setHighpassEnabled(enabled)
    saveHighpassEnabled(enabled)
    setState((s) => ({ ...s, highpassEnabled: enabled }))
  }
  let noiseReducerEnabled = loadNoiseReducerEnabled()
  function setNoiseReducerEnabled(enabled: boolean) {
    noiseReducerEnabled = enabled
    saveNoiseReducerEnabled(enabled)
    setState((s) => ({ ...s, noiseReducerEnabled: enabled }))
  }

  // USB unless told otherwise — see setCatMode()/SSBDemodulator's own
  // comment on why CW/RTTY/AM/FM all fall back to the USB branch here.
  let sideband = true
  function setCatMode(mode: CATMode | null) {
    if (mode === 'LSB') sideband = false
    else sideband = true
  }

  // Driven by SignalAnalysisPanel's draggable bandwidth marker in I/Q mode
  // — centerHz is the marker's offset from the I/Q capture's own 0Hz
  // (baseband) center, bandwidthHz its width. See SSBDemodulator.setPassband().
  // Persisted across reloads (see savePassbandCenterHz/BandwidthHz's own
  // comment) — seed demod with the SAME persisted values state() already
  // initialized from, so the demodulator and the reactive marker position
  // agree from the very first frame instead of only syncing once the
  // operator drags the marker again after a reload.
  demod.setPassband(state().passbandCenterHz, state().passbandBandwidthHz, state().sampleRateHz)
  function setPassband(centerHz: number, bandwidthHz: number) {
    demod.setPassband(centerHz, bandwidthHz, state().sampleRateHz)
    savePassbandCenterHz(centerHz)
    savePassbandBandwidthHz(bandwidthHz)
    setState((s) => ({ ...s, passbandCenterHz: centerHz, passbandBandwidthHz: bandwidthHz }))
  }

  // Demodulated-audio playback graph — mirrors useAudioBridge.ts's
  // playCtx/playAnalyserNode/playFrame()/nextPlayTime exactly (same
  // AudioBuffer-per-frame, back-to-back-scheduled jitter buffer, same
  // reasoning for letting createBuffer()+AudioBufferSourceNode handle
  // resampling to the context's own rate rather than a hand-rolled
  // resampler — see that file's comment on the real-hardware noise-floor
  // A/B test behind that choice). A SEPARATE AudioContext from
  // useAudioBridge.ts's, since the two are never live at once (mutually
  // exclusive input_mode) and sharing one across files would need this
  // hook to reach into that one's internals.
  let playCtx: AudioContext | null = null
  let playAnalyserNode: AnalyserNode | null = null
  let nextPlayTime = 0
  // Separate gain stage between playAnalyserNode and destination — muted
  // (gain 0) by default so opening the I/Q spectrum stays silent unless
  // the operator explicitly asks to hear it (see setPlayThroughSpeakers()).
  // A gain mute rather than connect()/disconnect() on toggle so flipping
  // it mid-stream doesn't click, same reasoning as other mute-via-gain
  // spots in this codebase (e.g. useFTTransmit.ts's TX gain node).
  let speakersGainNode: GainNode | null = null
  let speakersOn = loadPlayThroughSpeakers()

  function teardownPlayback() {
    playCtx?.close().catch(() => null)
    playCtx = null
    playAnalyserNode = null
    speakersGainNode = null
    nextPlayTime = 0
  }

  // Peak-hold with exponential decay, same shape as the uSDX firmware's own
  // max_absavg256 (see usdxBLACKBRICK.ino's smeter()) but on a real-time
  // decay per call rather than a fixed sample-count cadence, since this
  // runs once per received I/Q frame (frame size varies with the bridge's
  // configured sample rate) rather than once per audio sample. Holds the
  // peak briefly so a short burst (a few characters of CW/data) is still
  // readable rather than needing a continuous tone to register, then decays
  // back down so a meter reading from ten seconds ago doesn't linger.
  let meterPeakRms = 0
  function updateSignalMeter(samples: Float32Array): void {
    let sumSq = 0
    for (let i = 0; i < samples.length; i++) sumSq += samples[i] * samples[i]
    const rms = Math.sqrt(sumSq / samples.length)
    meterPeakRms = Math.max(rms, meterPeakRms * 0.85)
    const dbfs = 20 * Math.log10(Math.max(meterPeakRms, 1e-9))
    setState((s) => ({ ...s, iqSignalDbfs: dbfs }))
  }

  function playDemodulatedFrame(iq: Float64Array, sampleRateHz: number) {
    if (!playCtx) return
    let floatSamples: Float32Array<ArrayBuffer> = demod.demodulate(iq, sideband, sampleRateHz)
    if (floatSamples.length === 0) return
    updateSignalMeter(floatSamples)
    if (agcEnabled) agc.process(floatSamples)
    // Last stage — see NoiseReducer's own header comment. Its
    // FFT-overlap-add pipeline is BLOCK-based, not per-sample like every
    // stage before it: a given call's input rarely lines up exactly with
    // one internal analysis frame, so the number of samples it actually
    // has ready to emit varies call to call — often 0 (still
    // accumulating), sometimes a full block at once. Skip playback
    // entirely for a call that has nothing ready yet, same as the
    // existing "floatSamples.length === 0" guard above.
    if (noiseReducerEnabled) {
      floatSamples = noiseReducer.process(floatSamples)
      if (floatSamples.length === 0) return
    }

    const buffer = playCtx.createBuffer(1, floatSamples.length, sampleRateHz)
    buffer.copyToChannel(floatSamples, 0)

    const source = playCtx.createBufferSource()
    source.buffer = buffer
    source.connect(playAnalyserNode ?? playCtx.destination)

    const startAt = Math.max(nextPlayTime, playCtx.currentTime)
    source.start(startAt)
    nextPlayTime = startAt + buffer.duration
  }

  // Exposes the demodulated-audio graph in the exact shape
  // audioSource.ts's acquireBridgeSource() expects from
  // useAudioBridge.ts's getPlaybackSource() — see this file's header
  // comment. Null while input_mode isn't "iq" or nothing's connected yet,
  // same "ask the operator to connect first" contract as the audio-bridge
  // version.
  function getPlaybackSource(): { ctx: AudioContext; node: AnalyserNode } | null {
    if (!playCtx || !playAnalyserNode) return null
    return { ctx: playCtx, node: playAnalyserNode }
  }

  let wantConnected = false
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null

  function clearReconnectTimer() {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
  }

  // Silence watchdog — a plain receive-only WebSocket has no way to notice
  // the PEER died without a clean close handshake, which an ESP32 reboot
  // (power blip, watchdog reset, crash) never performs: no FIN/RST is ever
  // sent, so the browser's TCP stack can sit on a half-open socket for
  // MINUTES before onclose fires on its own — confirmed as the actual
  // cause of "I/Q never shows reconnecting" (CAT's own reconnect works
  // because its poll loop actively sends requests and times out waiting
  // for a reply; this socket only ever passively waits for data). Frames
  // normally arrive every ~50ms, so IQ_SILENCE_TIMEOUT_MS is a generous
  // multiple of that — comfortably above any real jitter this investigation
  // measured (worst case ~340ms) but far below "wait for the OS to notice."
  // Resets on every message; if it ever fires, force-closing the socket is
  // enough — that alone triggers the SAME onclose/reconnect path a real
  // network-level close would, so no separate reconnect logic is needed.
  const IQ_SILENCE_TIMEOUT_MS = 5000
  let silenceTimer: ReturnType<typeof setTimeout> | null = null
  function clearSilenceTimer() {
    if (silenceTimer !== null) {
      clearTimeout(silenceTimer)
      silenceTimer = null
    }
  }
  function armSilenceTimer(socket: WebSocket) {
    clearSilenceTimer()
    silenceTimer = setTimeout(() => {
      log('warn', `no I/Q frame in ${IQ_SILENCE_TIMEOUT_MS}ms — assuming the connection is dead, forcing reconnect`)
      socket.close() // triggers onclose, which does the actual reconnect scheduling
    }, IQ_SILENCE_TIMEOUT_MS)
  }

  // Same exponential backoff as useAudioBridge.ts/useRadioCAT.ts — see
  // either file's comment for the real-hardware retry-storm history this
  // prevents. A THIRD socket sharing this pattern independently (rather
  // than sharing a combined backoff counter with useAudioBridge.ts) is
  // deliberate: /audio and /iq-data are mutually exclusive on the
  // firmware side, so in practice only one of these two hooks is ever
  // actually retrying against a live bridge at once — RadioCATPanel.tsx's
  // UI only opens this connection while input_mode is "iq".
  const RECONNECT_BASE_DELAY_MS = 2000
  const RECONNECT_MAX_DELAY_MS = 30000
  let reconnectAttempt = 0
  let connectGeneration = 0

  function disconnect() {
    wantConnected = false
    connectGeneration++
    reconnectAttempt = 0
    hasConnectedOnce = false
    clearReconnectTimer()
    clearSilenceTimer()
    ws?.close()
    ws = null
    teardownPlayback()
    meterPeakRms = 0
    setState((s) => ({ ...s, connected: false, reconnecting: false, lastFramePairs: 0, iqSignalDbfs: null }))
  }

  // True once this connect() session's socket has opened successfully at
  // least once — see IQBridgeState.reconnecting's comment for why this is
  // tracked separately from wantConnected: the FIRST connect attempt
  // failing is an ordinary "couldn't connect" case (surfaced via `error`),
  // not a "was working, now reconnecting" case, even though both look
  // identical from onclose's point of view (wantConnected is true, the
  // socket just closed) without this flag.
  let hasConnectedOnce = false

  function openSocket(iqUrl: string, catWsUrl: string, generation: number, resolveFirstAttempt?: (ok: boolean) => void) {
    void fetchBridgeIQInfo(catWsUrl).then(({ inputMode, sampleRateHz }) => {
      if (generation === connectGeneration) {
        setState((s) => ({
          ...s,
          inputMode: s.forceIQMode ? 'iq' : inputMode,
          sampleRateHz: s.forceSampleRateHz ?? sampleRateHz,
        }))
      }
    })

    const socket = new WebSocket(iqUrl)
    socket.binaryType = 'arraybuffer'

    socket.onopen = () => {
      if (generation !== connectGeneration) return
      log('info', `connected — ${iqUrl}`)
      reconnectAttempt = 0
      hasConnectedOnce = true
      ws = socket
      // playCtx/playAnalyserNode/speakersGainNode are built once in
      // connect(), NOT recreated here on every (re)open — see connect()'s
      // own comment for why. This graph primarily exists to feed decoders
      // (via getPlaybackSource()) and hasFramePairs-style liveness, which
      // is also why playAnalyserNode isn't wired straight to
      // playCtx.destination the way useAudioBridge.ts's "Listen to Radio"
      // graph is: an AnalyserNode reads its input whether or not it's
      // connected onward, so decoders/visualizers tapping it work
      // regardless of the speaker path — speakersGainNode is the optional,
      // muted-by-default speaker tap (see setPlayThroughSpeakers()).
      armSilenceTimer(socket)
      setState((s) => ({ ...s, connected: true, reconnecting: false, error: null }))
      resolveFirstAttempt?.(true)
    }
    socket.onerror = () => {
      if (generation !== connectGeneration) return
      log('warn', `connection error — ${iqUrl}`)
      setState((s) => ({ ...s, error: `Failed to connect to ${iqUrl}` }))
      resolveFirstAttempt?.(false)
    }
    socket.onclose = () => {
      if (generation !== connectGeneration) return
      clearSilenceTimer()
      const delay = Math.min(RECONNECT_BASE_DELAY_MS * 2 ** reconnectAttempt, RECONNECT_MAX_DELAY_MS)
      log('info', `closed — ${iqUrl}${wantConnected ? `, retrying in ${delay}ms (attempt ${reconnectAttempt + 1})` : ''}`)
      ws = null
      // See IQBridgeState.reconnecting's comment — only true once this
      // session has actually connected before; a still-failing FIRST
      // attempt keeps reconnecting false so the UI shows the plain
      // "not connected"/error state instead.
      setState((s) => ({ ...s, connected: false, reconnecting: wantConnected && hasConnectedOnce, lastFramePairs: 0 }))
      if (!wantConnected) return
      // Keep retrying — the operator asked to decode and hasn't said
      // otherwise; a reboot/hiccup shouldn't require reloading the whole
      // page. playCtx/playAnalyserNode are left alone (not torn down —
      // see connect()'s comment) so any decoder holding a reference via
      // getPlaybackSource() keeps working once we reopen; onmessage just
      // has nothing to feed it until then.
      clearReconnectTimer()
      reconnectAttempt++
      reconnectTimer = setTimeout(() => openSocket(iqUrl, catWsUrl, generation), delay)
    }
    socket.onmessage = (ev: MessageEvent<ArrayBuffer>) => {
      if (generation !== connectGeneration) return
      armSilenceTimer(socket)
      if (!(ev.data instanceof ArrayBuffer)) return
      const int16 = new Int16Array(ev.data)
      // Convert to float once, here, then run every correction stage on
      // that SAME buffer in a fixed order — the single choke point both
      // spectrum.feed() and playDemodulatedFrame() read from, so the
      // spectrum display and the demodulated audio always agree on
      // exactly what correction(s) are active.
      //
      // Order: DC removal first (so the imbalance corrector's E[I]≈0/
      // E[Q]≈0 assumption actually holds — a DC bias would bias its
      // E[I²]/E[Q²]/E[IQ] estimates), then imbalance correction, then
      // swap/negate last (those reindex/sign-flip which physical channel
      // is "I" and which is "Q" — applying them last means DC removal and
      // the imbalance estimator's g/φ operate on the channels in their
      // pre-swap physical roles, which is what a hardware defect actually
      // affects; swap/negate is closer to "how the app INTERPRETS the two
      // channels" than a per-channel property to correct before that).
      const iq = new Float64Array(int16.length)
      for (let n = 0; n < int16.length; n++) iq[n] = int16[n] / 32768
      if (dcRemovalEnabled) dcRemover.process(iq)
      if (imbalanceCorrectionEnabled) imbalanceCorrector.process(iq)
      switch (iqCorrection) {
        case 'swap':
          for (let n = 0; n + 1 < iq.length; n += 2) {
            const tmp = iq[n]
            iq[n] = iq[n + 1]
            iq[n + 1] = tmp
          }
          break
        case 'negateI':
          for (let n = 0; n < iq.length; n += 2) iq[n] = -iq[n]
          break
        case 'negateQ':
          for (let n = 1; n < iq.length; n += 2) iq[n] = -iq[n]
          break
      }
      spectrum.feed(iq)
      playDemodulatedFrame(iq, state().sampleRateHz)
      setState((s) => ({ ...s, lastFramePairs: iq.length >> 1 }))
    }
  }

  async function connect(catWsUrl: string): Promise<boolean> {
    disconnect()
    const iqUrl = bridgeIQWsUrl(catWsUrl)
    if (!iqUrl) {
      log('error', `could not derive /iq-data URL from ${catWsUrl}`)
      setState((s) => ({ ...s, error: `Could not derive /iq-data URL from ${catWsUrl}` }))
      return false
    }
    log('info', `connecting — ${iqUrl}`)
    wantConnected = true

    // Built ONCE here, not in openSocket()'s onopen — see that handler's
    // own comment for the real bug this fixes: a decoder that calls
    // getPlaybackSource() (via acquireBridgeSource()) captures this
    // ctx/node pair once, at decode-start, and holds onto it for its whole
    // session. Recreating them on every reconnect (the previous behavior)
    // left that decoder silently pointing at a closed AudioContext after
    // any bridge reboot/Wi-Fi hiccup — the UI still showed "connected"
    // once the socket reopened, but no audio ever reached the decoder
    // again without a full page reload. Matches useAudioBridge.ts's own
    // connect()/onclose split, which already gets this right.
    try {
      playCtx = new AudioContext()
      playAnalyserNode = playCtx.createAnalyser()
      playAnalyserNode.fftSize = 2048
      speakersGainNode = playCtx.createGain()
      speakersGainNode.gain.value = speakersOn ? 1 : 0
      playAnalyserNode.connect(speakersGainNode)
      speakersGainNode.connect(playCtx.destination)
    } catch (err) {
      log('error', 'AudioContext creation failed:', err)
      setState((s) => ({ ...s, error: err instanceof Error ? err.message : 'AudioContext failed' }))
      return false
    }

    const generation = connectGeneration
    return new Promise((resolve) => openSocket(iqUrl, catWsUrl, generation, resolve))
  }

  // Reads input_mode/sample_rate_hz from GET /status WITHOUT opening the
  // /iq-data WebSocket — for a mode-selector UI that needs to show the
  // bridge's current mode before the operator has connected anything (the
  // full connect() only refreshes this as a side effect of opening the
  // socket). Ignored if a real connect()/reconnect is already in flight
  // for a DIFFERENT generation, so a stale standalone refresh can't
  // clobber a newer connection's own state.
  async function refreshInfo(catWsUrl: string): Promise<void> {
    const generation = connectGeneration
    const { inputMode, sampleRateHz } = await fetchBridgeIQInfo(catWsUrl)
    if (generation === connectGeneration) {
      setState((s) => ({
        ...s,
        inputMode: s.forceIQMode ? 'iq' : inputMode,
        sampleRateHz: s.forceSampleRateHz ?? sampleRateHz,
      }))
    }
  }

  // See IQBridgeState.forceIQMode's comment — for a bridge with no /status
  // handler at all (a minimal single-purpose test firmware), not a normal
  // operator control. Takes effect on the next refreshInfo()/connect(),
  // same "remembered until changed again" pattern as the other setters
  // here — it does not retroactively fix already-stale inputMode state.
  function setForceIQMode(enabled: boolean) {
    saveForceIQMode(enabled)
    setState((s) => {
      // Turning this on also seeds a sample-rate override if none is set
      // yet — a status-less bridge needs BOTH overrides to actually work
      // (see IQBridgeState.forceSampleRateHz's comment: mode alone still
      // leaves sampleRateHz at fetchBridgeIQInfo()'s 96000 fallback,
      // silently doubling every frequency the demodulator computes
      // against). 48000 matches firmware/esp32-iq-minimal, the one
      // status-less bridge that exists today; the UI's own sample-rate
      // field lets the operator correct this if a different one is ever
      // built. Never overwrites an override the operator already set.
      const forceSampleRateHz = enabled ? (s.forceSampleRateHz ?? 48000) : s.forceSampleRateHz
      if (forceSampleRateHz !== s.forceSampleRateHz) saveForceSampleRateHz(forceSampleRateHz)
      return {
        ...s,
        forceIQMode: enabled,
        inputMode: enabled ? 'iq' : s.inputMode,
        forceSampleRateHz,
        sampleRateHz: enabled ? forceSampleRateHz ?? s.sampleRateHz : s.sampleRateHz,
      }
    })
  }

  // See IQBridgeState.forceSampleRateHz's comment. hz === null clears the
  // override (back to trusting fetchBridgeIQInfo()/its fallback).
  function setForceSampleRateHz(hz: number | null) {
    saveForceSampleRateHz(hz)
    setState((s) => ({ ...s, forceSampleRateHz: hz, sampleRateHz: hz ?? s.sampleRateHz }))
  }

  // Live-mutes/unmutes speakersGainNode — see that field's own comment for
  // why a gain mute, not connect/disconnect. Takes effect immediately if
  // already connected; otherwise just seeds the value the NEXT connect()
  // creates speakersGainNode with, same "remembered until changed again"
  // behavior as setCatMode()/setPassband() above.
  function setPlayThroughSpeakers(enabled: boolean) {
    speakersOn = enabled
    savePlayThroughSpeakers(enabled)
    if (speakersGainNode) speakersGainNode.gain.value = enabled ? 1 : 0
    setState((s) => ({ ...s, playThroughSpeakers: enabled }))
  }

  onCleanup(disconnect)

  return {
    state, connect, disconnect, refreshInfo, spectrum, setCatMode, setPassband, getPlaybackSource,
    setPlayThroughSpeakers, setIQCorrection, setDCRemoval, setImbalanceCorrection, setForceIQMode,
    setForceSampleRateHz, setAGCEnabled, setAGCLevel, setHighpassEnabled, setNoiseReducerEnabled,
  }
}

export type IQBridge = ReturnType<typeof useIQBridge>
