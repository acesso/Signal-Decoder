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
const LS_PLAY_THROUGH_SPEAKERS = 'iq_play_through_speakers'
const LS_FORCE_IQ_MODE = 'iq_force_mode'
const LS_FORCE_SAMPLE_RATE = 'iq_force_sample_rate'

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
function loadPlayThroughSpeakers(): boolean {
  if (typeof window === 'undefined') return false
  return localStorage.getItem(LS_PLAY_THROUGH_SPEAKERS) === 'true'
}
function savePlayThroughSpeakers(v: boolean) {
  if (typeof window !== 'undefined') localStorage.setItem(LS_PLAY_THROUGH_SPEAKERS, String(v))
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
  // See setForceIQMode()'s comment — when true, inputMode above is always
  // reported as "iq" regardless of what (or whether) GET /status answers.
  forceIQMode: boolean
  // See setForceSampleRateHz()'s comment — null means "no override," a
  // number pins sampleRateHz above to that value regardless of what (or
  // whether) GET /status answers.
  forceSampleRateHz: number | null
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

export class SSBDemodulator {
  private centerHz = 0
  private bandwidthHz = 2700 // a typical SSB voice passband width; overridden by setPassband()
  private mixerPhase = 0 // radians, carried across calls for phase continuity

  private lowpassSampleRateHz = FALLBACK_SAMPLE_RATE
  private lowpassI = new FIRFilter()
  private lowpassQ = new FIRFilter()
  private hilbertDelay = new FIRFilter(buildDelayTaps(HILBERT_TAPS))
  private hilbertQ = new FIRFilter(buildHilbertTaps(HILBERT_TAPS))

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
    // Cutoff at HALF the requested bandwidth (a lowpass from -bw/2..+bw/2
    // around the mixed-to-zero center) — same convention as before this
    // rewrite. transWidth (BrowSDR's estimateTapCount() input) set equal
    // to the cutoff itself (a 100%-relative transition width) — a real
    // bug was found and fixed here: an earlier attempt at 10% of the
    // cutoff produced estimateTapCount(135, 48000) = 1351 taps for a
    // typical 2700Hz-wide SSB passband, whose filter settling time (many
    // tens of thousands of samples for a sinc this long) is far longer
    // than this app's ~50ms/2400-sample processing frames — the
    // demodulated audio never actually reached steady state in normal
    // operation, which is exactly the kind of "sounds thin/cuts out"
    // symptom this whole rewrite was meant to fix, not reproduce with a
    // different mechanism. 100%-relative transition width keeps the tap
    // count in the same ballpark (~130-270 taps across this app's typical
    // 8-96kHz sample rates) as the pre-rewrite hand-rolled filter (65-129
    // taps), which was known to settle acceptably fast.
    const cutoffHz = bw / 2
    const taps = lowPassTaps(cutoffHz, cutoffHz, sampleRateHz)
    this.lowpassI.setTaps(taps)
    // Q needs its OWN FIRFilter instance (not the same taps object shared
    // by reference issue — setTaps() already copies into a fresh history
    // buffer per instance) so its circular-buffer history stays
    // independent of I's, even though the tap coefficients themselves are
    // identical real values applied to both rails.
    this.lowpassQ.setTaps(taps)
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
      out[n] = delayedI + sign * hilbertQ
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
    inputMode: 'audio',
    sampleRateHz: FALLBACK_SAMPLE_RATE,
    lastFramePairs: 0,
    passbandCenterHz: 0,
    passbandBandwidthHz: 2700,
    error: null,
    playThroughSpeakers: loadPlayThroughSpeakers(),
    iqCorrection: loadIQCorrection(),
    dcRemovalEnabled: loadDCRemoval(),
    imbalanceCorrectionEnabled: loadImbalanceCorrection(),
    forceIQMode: loadForceIQMode(),
    forceSampleRateHz: loadForceSampleRateHz(),
  })

  let ws: WebSocket | null = null
  const spectrum = new IQSpectrumComputer()
  const demod = new SSBDemodulator()
  const dcRemover = new DCRemover()
  const imbalanceCorrector = new ImbalanceCorrector()

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
  function setPassband(centerHz: number, bandwidthHz: number) {
    demod.setPassband(centerHz, bandwidthHz, state().sampleRateHz)
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

  function playDemodulatedFrame(iq: Float64Array, sampleRateHz: number) {
    if (!playCtx) return
    const floatSamples = demod.demodulate(iq, sideband, sampleRateHz)
    if (floatSamples.length === 0) return

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
    clearReconnectTimer()
    ws?.close()
    ws = null
    teardownPlayback()
    setState((s) => ({ ...s, connected: false, lastFramePairs: 0 }))
  }

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
      ws = socket
      teardownPlayback()
      playCtx = new AudioContext()
      playAnalyserNode = playCtx.createAnalyser()
      playAnalyserNode.fftSize = 2048
      // playAnalyserNode itself is NOT connected to playCtx.destination —
      // unlike useAudioBridge.ts's "Listen to Radio" (whose whole point is
      // speaker output), THIS graph primarily exists to feed decoders (via
      // getPlaybackSource()) and hasFramePairs-style liveness. An
      // AnalyserNode reads its input whether or not it's connected onward,
      // so decoders/visualizers tapping it here still work regardless of
      // the speaker path below. speakersGainNode is the optional, muted-
      // by-default speaker tap — see setPlayThroughSpeakers().
      speakersGainNode = playCtx.createGain()
      speakersGainNode.gain.value = speakersOn ? 1 : 0
      playAnalyserNode.connect(speakersGainNode)
      speakersGainNode.connect(playCtx.destination)
      setState((s) => ({ ...s, connected: true, error: null }))
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
      const delay = Math.min(RECONNECT_BASE_DELAY_MS * 2 ** reconnectAttempt, RECONNECT_MAX_DELAY_MS)
      log('info', `closed — ${iqUrl}${wantConnected ? `, retrying in ${delay}ms (attempt ${reconnectAttempt + 1})` : ''}`)
      ws = null
      setState((s) => ({ ...s, connected: false, lastFramePairs: 0 }))
      if (!wantConnected) return
      clearReconnectTimer()
      reconnectAttempt++
      reconnectTimer = setTimeout(() => openSocket(iqUrl, catWsUrl, generation), delay)
    }
    socket.onmessage = (ev: MessageEvent<ArrayBuffer>) => {
      if (generation !== connectGeneration) return
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
    setForceSampleRateHz,
  }
}

export type IQBridge = ReturnType<typeof useIQBridge>
