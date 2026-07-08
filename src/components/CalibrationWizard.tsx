// Port of src/components/CalibrationWizard.tsx (Next.js app).
import { createSignal, onCleanup, Show, Switch, Match } from 'solid-js'
import type { RadioCATControls, CATMode } from '../lib/cat/useRadioCAT'
import {
  TONE_HZ, REFERENCE_STATIONS, findTonePeak, summarizeReadings, computeCorrection,
  rankReferenceStations, MIN_SNR_DB, MIN_PROMINENCE_DB,
  type TonePeak, type MeasurementSummary, type CalibrationResult, type StationScore,
  type ReferenceStation,
} from '$decoder-lib/cat/calibration'

// ── Frequency calibration wizard ──────────────────────────────────────────────
// Guides the operator through calibrating the radio's reference oscillator
// (si5351.fxtal / menu "Ref frq") against an off-air standard station.
//
// The whole procedure is RECEIVE-ONLY: the radio never transmits, so no dummy
// load is involved — only the normal receive antenna. The wizard tunes the
// radio 1 kHz below the reference carrier in USB, measures the resulting
// audio tone from the same soundcard input used for decoding, converts the
// deviation from exactly 1 kHz into a corrected fxtal, writes it via the XF
// CAT command, and re-measures to verify.

type Step = 'intro' | 'reference' | 'scan' | 'measure' | 'apply' | 'verify' | 'done'

const TARGET_READINGS = 50 // ~10 s at one reading each 200 ms
// Same length as the initial measurement — a shorter verify window used to
// be twice as noisy as the baseline, which meant a correction that genuinely
// converged (confirmed live: 1.27 Hz residual on a real radio) could still
// miss the tight <2 Hz confirmation threshold on a bad-luck short sample and
// get reported as "did not converge" even though it worked.
const VERIFY_READINGS = TARGET_READINGS
const READ_INTERVAL_MS = 200
const SCAN_PROBE_READINGS = 8 // ~1.6 s per station while auto-scanning — quick, not a full measurement
const SCAN_SETTLE_MS = 700 // let the retune + AGC settle before probing each candidate

interface ScanAttempt {
  station: ReferenceStation
  locked: boolean
  bestProminenceDb: number
}

interface RadioSnapshot {
  frequency: number | null
  mode: CATMode | null
  nr: number | null
  /** fxtal read at wizard start — restored on Cancel/close/unmount UNLESS the
   *  operator explicitly kept the new calibration (see keptCalibration). */
  fxtal: number | null
}

export default function CalibrationWizard(props: { cat: RadioCATControls; onClose: () => void }) {
  const [step, setStep] = createSignal<Step>('intro')
  const [refHz, setRefHz] = createSignal<number>(REFERENCE_STATIONS[0].hz)
  const [customRef, setCustomRef] = createSignal('')
  const [useCustom, setUseCustom] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)

  // Station suggestion: ranked by time of day (immediately) and refined with
  // the browser's geolocation once/if the user grants it. The top-ranked
  // station is pre-selected until the operator picks one manually.
  const [ranking, setRanking] = createSignal<StationScore[] | null>(null)
  const [rankingBasis, setRankingBasis] = createSignal<'time' | 'geo'>('time')
  let userPicked = false

  const [liveTone, setLiveTone] = createSignal<TonePeak | null>(null)
  const [readCount, setReadCount] = createSignal(0)
  const [summary, setSummary] = createSignal<MeasurementSummary | null>(null)
  // Time-domain RMS of the input, sampled alongside the FFT — catches the
  // "wrong/disconnected audio device" failure mode independent of the tone
  // detector, which can otherwise mistake a quiet noise spur for a real peak.
  const [fxtalBefore, setFxtalBefore] = createSignal<number | null>(null)
  const [result, setResult] = createSignal<CalibrationResult | null>(null)
  const [verifyTone, setVerifyTone] = createSignal<MeasurementSummary | null>(null)
  const [busy, setBusy] = createSignal(false)

  // ── Auto-scan: try each station in ranked order, stop at the first genuine
  // carrier lock (see probeStation). Loops the FULL list regardless of the
  // time/geo ranking's guess, since that ranking is only a prior — actual
  // propagation on a given day can easily favor a station it ranked low. ──
  const [scanAttempts, setScanAttempts] = createSignal<ScanAttempt[]>([])
  const [scanIdx, setScanIdx] = createSignal(0)
  let scanAbort = false
  // Late-bound handle to beginMeasure (declared further down, after
  // effectiveRefHz) — avoids a circular dependency between the scanner and
  // the measurement step while keeping both as stable functions.
  let beginMeasureRef: (overrideRefHz?: number) => void = () => {}

  // ── Audio capture (own context — independent of the app's decoder audio) ──
  let audioCtx: AudioContext | null = null
  let analyser: AnalyserNode | null = null
  let stream: MediaStream | null = null
  let timer: ReturnType<typeof setInterval> | null = null
  let readings: TonePeak[] = []
  let snapshot: RadioSnapshot | null = null
  // Set only when the operator picks "Keep new calibration" on the done step —
  // otherwise close()/unmount ALWAYS reverts fxtal along with freq/mode/NR,
  // even after a successful apply. This is deliberate: a wizard the operator
  // is still looking at should be fully reversible until they say "keep it".
  let keptCalibration = false

  function stopAudio() {
    if (timer) { clearInterval(timer); timer = null }
    stream?.getTracks().forEach(t => t.stop())
    stream = null
    analyser = null
    audioCtx?.close().catch(() => {})
    audioCtx = null
  }

  async function startAudio(): Promise<AnalyserNode | null> {
    stopAudio()
    try {
      const s = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      })
      stream = s
      const ctx = new AudioContext()
      audioCtx = ctx
      const a = ctx.createAnalyser()
      a.fftSize = 32768 // 1.46 Hz/bin at 48 kHz; interpolation gets well below that
      a.smoothingTimeConstant = 0 // no temporal smearing — each frame is independent
      ctx.createMediaStreamSource(s).connect(a)
      analyser = a
      return a
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Microphone access failed')
      return null
    }
  }

  // ── Radio state save/restore ──
  // Restores freq/mode/NR AND fxtal (the calibration value itself) unless the
  // operator explicitly chose to keep the new calibration on the done step.
  // Without this, "Finish (restore previous tuning)" was misleading: it put
  // frequency/mode back but silently left whatever fxtal the last apply (or
  // even a bad measurement) had written — the wizard's own "Cancel" and
  // "close" paths could not undo a correction once written.
  //
  // setRefFreq's return value is CHECKED and RETRIED — a query can drop its
  // reply (serial hiccup, a stray poll-cadence race, momentary port latency)
  // and resolve with the OLD value or null instead of throwing, so a bare
  // `.catch(() => {})` around it previously treated "the radio silently
  // ignored/missed the command" identically to "it worked". That is the
  // likely explanation for reports of "the UI says it reverted but the radio
  // didn't change": the write went out, got no usable reply, and nothing
  // retried or told the operator.
  async function restoreXfWithRetry(targetFxtal: number): Promise<boolean> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const confirmed = await props.cat.setRefFreq(targetFxtal).catch(() => null)
      if (confirmed === targetFxtal) return true
      await new Promise(r => setTimeout(r, 250))
    }
    return false
  }

  async function restoreRadio(): Promise<boolean> {
    const snap = snapshot
    if (!snap) return true
    snapshot = null
    if (snap.frequency !== null) props.cat.setFrequency(snap.frequency).catch(() => {})
    if (snap.mode !== null) props.cat.setMode(snap.mode).catch(() => {})
    if (snap.nr !== null) props.cat.setNR(snap.nr).catch(() => {})
    if (!keptCalibration && snap.fxtal !== null) {
      const ok = await restoreXfWithRetry(snap.fxtal)
      if (!ok) {
        // Put it back so the operator gets another shot at reverting instead
        // of the value being silently lost on a failed attempt.
        snapshot = snap
      }
      return ok
    }
    return true
  }

  function close() {
    stopAudio()
    restoreRadio().then(ok => {
      if (ok) { props.onClose(); return }
      setError('Could not confirm the radio accepted the reverted reference frequency — click Revert again, or check the CAT connection.')
    })
  }

  // Safety net: restore + release on unmount, whatever state we're in. Fires
  // even if the operator closes the browser tab mid-wizard rather than
  // clicking a button — a half-applied calibration should not stick silently.
  // (No retry-visibility possible here — the component is gone — but the
  // retry logic in restoreXfWithRetry still gives it three tries before giving up.)
  onCleanup(() => { stopAudio(); restoreRadio() })

  // ── Measurement loop (shared by measure & verify) ──
  async function runMeasurement(target: number, onDone: (s: MeasurementSummary) => void) {
    const a = analyser ?? await startAudio()
    if (!a || !audioCtx) return
    const sampleRate = audioCtx.sampleRate
    const bins = new Float32Array(a.frequencyBinCount)
    readings = []
    setReadCount(0)
    setLiveTone(null)

    if (timer) clearInterval(timer)
    timer = setInterval(() => {
      a.getFloatFrequencyData(bins)
      const peak = findTonePeak(bins, sampleRate, a.fftSize)
      if (peak) {
        readings.push(peak)
        setLiveTone(peak)
        setReadCount(readings.length)
      }
      if (readings.length >= target) {
        clearInterval(timer!)
        timer = null
        onDone(summarizeReadings(readings))
      }
    }, READ_INTERVAL_MS)
  }

  // Collects `count` FFT readings without touching the measurement UI state —
  // used by the scanner to quickly probe a candidate station without
  // resetting/animating the full measure-step progress bar for every try.
  function collectProbeReadings(count: number): Promise<TonePeak[]> {
    return new Promise(resolve => {
      const a = analyser
      if (!a || !audioCtx) { resolve([]); return }
      const sampleRate = audioCtx.sampleRate
      const bins = new Float32Array(a.frequencyBinCount)
      const collected: TonePeak[] = []
      const t = setInterval(() => {
        a.getFloatFrequencyData(bins)
        const peak = findTonePeak(bins, sampleRate, a.fftSize)
        if (peak) { collected.push(peak); setLiveTone(peak) }
        if (collected.length >= count) { clearInterval(t); resolve(collected) }
      }, READ_INTERVAL_MS)
    })
  }

  // Tunes to one candidate and checks for a genuine carrier lock — the SAME
  // prominence-based criterion the real measurement uses (see calibration.ts),
  // so a station that only shows scattered noise is correctly rejected here
  // too, instead of being accepted on S-meter strength alone (S-meter reads
  // "signal" for band noise just as readily as for an actual carrier).
  async function probeStation(station: ReferenceStation): Promise<ScanAttempt> {
    await props.cat.setMode('USB')
    await props.cat.setFrequency(station.hz - TONE_HZ)
    if (!analyser) await startAudio()
    await new Promise(r => setTimeout(r, SCAN_SETTLE_MS))
    const probeReadings = await collectProbeReadings(SCAN_PROBE_READINGS)
    const bestProminenceDb = probeReadings.reduce((m, r) => Math.max(m, r.prominenceDb), -Infinity)
    const strongEnough = probeReadings.filter(r => r.snrDb >= MIN_SNR_DB && r.prominenceDb >= MIN_PROMINENCE_DB)
    return { station, locked: strongEnough.length >= Math.ceil(SCAN_PROBE_READINGS * 0.5), bestProminenceDb }
  }

  async function runScan(stations: ReferenceStation[]) {
    // Snapshot BEFORE the first retune — probing changes frequency/mode
    // immediately, so if the operator cancels mid-scan there must already be
    // something to restore to. fxtal is read once too so a cancel mid-scan
    // (which never applies a correction) still has a defined revert target.
    if (!snapshot) {
      const fx = await props.cat.getRefFreq()
      const st = props.cat.state()
      snapshot = { frequency: st.frequency, mode: st.mode, nr: st.nr, fxtal: fx }
      setFxtalBefore(fx)
    }
    scanAbort = false
    setScanAttempts([])
    setStep('scan')
    for (let i = 0; i < stations.length; i++) {
      if (scanAbort) return
      setScanIdx(i)
      const attempt = await probeStation(stations[i])
      if (scanAbort) return
      setScanAttempts(prev => [...prev, attempt])
      if (attempt.locked) {
        userPicked = true
        setUseCustom(false)
        setRefHz(attempt.station.hz)
        beginMeasureRef(attempt.station.hz)
        return
      }
    }
    setError('None of the reference stations showed a clean carrier right now. Try again later, check your antenna, or pick one manually and try anyway.')
    setStep('reference')
  }

  // ── Station suggestion (time-of-day first, refined by geolocation) ──
  function ensureRanking() {
    if (step() !== 'reference' || ranking() !== null) return

    const applyRanking = (scores: StationScore[], basis: 'time' | 'geo') => {
      setRanking(scores)
      setRankingBasis(basis)
      if (!userPicked) { setUseCustom(false); setRefHz(scores[0].station.hz) }
    }

    // Immediate: local-clock day/night proxy, no permissions involved
    applyRanking(rankReferenceStations(new Date()), 'time')

    // Refine with geolocation when available/granted; silently keep the
    // time-based ranking otherwise (denied, timeout, no support).
    if (typeof navigator !== 'undefined' && navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        pos => applyRanking(rankReferenceStations(new Date(), pos.coords.latitude, pos.coords.longitude), 'geo'),
        () => {},
        { timeout: 8000, maximumAge: 600_000, enableHighAccuracy: false },
      )
    }
  }

  // ── Step transitions ──

  function effectiveRefHz(): number | null {
    if (!useCustom()) return refHz()
    const n = Math.round(parseFloat(customRef().replace(/[,\s]/g, '')) * 1) // Hz
    return isFinite(n) && n >= 1_000_000 && n <= 30_000_000 ? n : null
  }

  // Accepts an explicit refHz override so the scanner can jump straight into
  // a full measurement on the station it just found locked, without a render
  // round-trip through the refHz signal first.
  async function beginMeasure(overrideRefHz?: number) {
    const ref = overrideRefHz ?? effectiveRefHz()
    if (ref === null) { setError('Enter a valid reference carrier frequency in Hz (1–30 MHz).'); return }
    setError(null)
    setBusy(true)
    try {
      const fx = await props.cat.getRefFreq()
      if (fx === null) { setError('Could not read the current reference frequency (XF;) from the radio.'); return }
      // Snapshot once (first entry only) so a re-measure doesn't overwrite it —
      // fxtal included, so Cancel/close can always get back to where we started.
      if (!snapshot) {
        const st = props.cat.state()
        snapshot = { frequency: st.frequency, mode: st.mode, nr: st.nr, fxtal: fx }
      }
      setFxtalBefore(fx)
      await props.cat.setMode('USB')
      await props.cat.setNR(0) // NR would distort the tone measurement
      await props.cat.setFrequency(ref - TONE_HZ) // carrier becomes a ~1 kHz tone
      setSummary(null)
      setStep('measure')
      runMeasurement(TARGET_READINGS, s => {
        setSummary(s)
        if (s.ok) {
          setResult(computeCorrection(s.toneHz, ref, fx))
          setStep('apply')
        }
      })
    } finally {
      setBusy(false)
    }
  }
  beginMeasureRef = beginMeasure

  function startScan() {
    const order = (ranking() ?? REFERENCE_STATIONS.map(station => ({ station }))).map(r => r.station)
    runScan(order as ReferenceStation[])
  }

  function cancelScan() {
    scanAbort = true
    setStep('reference')
  }

  async function applyCorrection() {
    const res = result()
    if (!res) return
    setBusy(true)
    setError(null)
    try {
      // Retry a couple of times before giving up — a dropped/late reply on a
      // real serial link would otherwise report a spurious "radio did not
      // accept" even though a resend would have gone through fine.
      let confirmed: number | null = null
      for (let attempt = 0; attempt < 3 && confirmed !== res.newFxtal; attempt++) {
        if (attempt > 0) await new Promise(r => setTimeout(r, 250))
        confirmed = await props.cat.setRefFreq(res.newFxtal).catch(() => null)
      }
      if (confirmed !== res.newFxtal) {
        setError(`Radio did not accept the new value after 3 attempts (last reply: ${confirmed ?? 'no reply'}). Check the CAT connection and try again.`)
        return
      }
      setStep('verify')
      setVerifyTone(null)
      runMeasurement(VERIFY_READINGS, s => {
        setVerifyTone(s)
        setStep('done')
      })
    } finally {
      setBusy(false)
    }
  }

  function keepAndFinish() {
    keptCalibration = true // restoreRadio() will skip fxtal
    close()
  }

  function revertAndFinish() {
    keptCalibration = false // restoreRadio() will put fxtal back
    close()
  }

  // ── Rendering helpers ──
  const btn = 'text-xs font-semibold px-3 py-1.5 rounded-md transition-colors'
  const btnPrimary = `${btn} bg-[#238636] hover:bg-[#2ea043] text-white`
  const btnGhost = `${btn} bg-[#21262d] border border-[#30363d] text-[#8b949e] hover:text-[#c9d1d9] hover:border-[#8b949e]`
  const mono = 'font-mono tabular-nums text-[#79c0ff]'

  const snrOk = () => liveTone() !== null && liveTone()!.snrDb >= MIN_SNR_DB

  // Kick off the station ranking as soon as we're on the reference step —
  // React's original used a useEffect keyed on [step, ranking]; here we just
  // call it whenever the reference step renders (ensureRanking() itself is
  // idempotent once ranking is set).
  ensureRanking()

  return (
    <div class="mt-2 bg-[#161b22] border border-[#30363d] rounded-lg p-4 flex flex-col gap-3">
      <div class="flex items-center justify-between">
        <span class="text-[10px] font-bold uppercase tracking-widest text-[#8b949e] select-none">
          Frequency Calibration
        </span>
        <button onClick={close} class="text-[#8b949e] hover:text-[#c9d1d9] text-xs" title="Close (restores previous frequency/mode)">✕</button>
      </div>

      <Switch>
        {/* ── Step: intro / hardware checklist ── */}
        <Match when={step() === 'intro'}>
          <p class="text-xs text-[#c9d1d9]">
            This calibrates the radio&apos;s reference oscillator (&quot;Ref frq&quot;) against an off-air standard
            station, fixing any dial-vs-reality frequency offset.
          </p>
          <ul class="text-xs text-[#8b949e] list-disc pl-5 flex flex-col gap-1">
            <li>
              <span class="text-[#3fb950] font-semibold">Receive-only</span> — the radio never transmits during
              this procedure, so <span class="text-[#c9d1d9]">no dummy load is needed</span>.
            </li>
            <li>Connect your normal <span class="text-[#c9d1d9]">receive antenna</span> — you need to actually hear the reference station.</li>
            <li>Radio audio must reach this computer&apos;s audio input (same hookup you use for decoding FT8).</li>
            <li>Let the radio <span class="text-[#c9d1d9]">warm up for ~5 minutes</span> first — the oscillator drifts slightly until it reaches temperature.</li>
            <li>The wizard will retune the radio and switch it to USB; your current frequency, mode and NR are restored afterwards.</li>
          </ul>
          <div class="flex gap-2">
            <button class={btnPrimary} onClick={() => setStep('reference')}>Start</button>
            <button class={btnGhost} onClick={close}>Cancel</button>
          </div>
        </Match>

        {/* ── Step: pick reference station ── */}
        <Match when={step() === 'reference'}>
          <p class="text-xs text-[#c9d1d9]">
            Pick a reference you can receive right now — stations are ordered by how likely they are
            to be receivable{' '}
            {rankingBasis() === 'geo'
              ? 'from your location at this hour (browser geolocation + day/night on the path)'
              : 'at this hour (allow location access for a distance-aware suggestion)'}.
          </p>
          <div class="flex flex-col gap-1.5">
            {(ranking() ?? REFERENCE_STATIONS.map(station => ({ station, score: 0, distanceKm: null, daylight: true, reason: '' }))).map((r, i) => (
              <label class="flex items-center gap-2 text-xs text-[#c9d1d9] cursor-pointer">
                <input
                  type="radio" name="refstation" class="accent-[#388bfd]"
                  checked={!useCustom() && refHz() === r.station.hz}
                  onChange={() => { userPicked = true; setUseCustom(false); setRefHz(r.station.hz) }}
                />
                <span class="w-28">{r.station.label}</span>
                {i === 0 && ranking() && (
                  <span class="text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded bg-[#1f6feb33] text-[#79c0ff] border border-[#388bfd]">
                    Suggested
                  </span>
                )}
                {!r.station.isPrecisionStandard && (
                  <span class="text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded bg-[#3a2d1233] text-[#e3b341] border border-[#9e6a03]" title="An ordinary broadcast transmitter, not a referenced frequency/time standard like WWV/CHU — usually accurate to a few Hz, which is fine here, but less authoritative.">
                    Not a standard
                  </span>
                )}
                <span class="text-[#8b949e] text-[10px]">
                  {ranking() && r.reason ? `${r.reason} — ` : ''}{r.station.notes}
                </span>
              </label>
            ))}
            <label class="flex items-center gap-2 text-xs text-[#c9d1d9] cursor-pointer">
              <input
                type="radio" name="refstation" class="accent-[#388bfd]"
                checked={useCustom()}
                onChange={() => { userPicked = true; setUseCustom(true) }}
              />
              <span class="w-28">Custom carrier</span>
              <input
                value={customRef()}
                onInput={e => { userPicked = true; setUseCustom(true); setCustomRef(e.currentTarget.value) }}
                placeholder="carrier Hz, e.g. 9700000"
                class="w-40 bg-[#0d1117] border border-[#30363d] text-[#c9d1d9] text-xs rounded px-2 py-1 focus:outline-none focus:border-[#388bfd] font-mono"
              />
              <span class="text-[#8b949e] text-[10px]">any AM broadcast with an exactly-known carrier works</span>
            </label>
          </div>
          <Show when={error()}>
            <p class="text-xs text-[#f85149]">{error()}</p>
          </Show>
          <div class="flex gap-2">
            <button class={btnPrimary} onClick={() => beginMeasure()} disabled={busy()}>
              {busy() ? 'Tuning…' : 'Tune & Measure'}
            </button>
            <button class={btnGhost} onClick={startScan} disabled={busy()} title="Try every reference station in order and stop at the first one with a clean carrier">
              Auto-scan all stations
            </button>
            <button class={btnGhost} onClick={() => setStep('intro')}>Back</button>
          </div>
        </Match>

        {/* ── Step: auto-scanning stations ── */}
        <Match when={step() === 'scan'}>
          <p class="text-xs text-[#c9d1d9]">
            Trying each reference station in turn — checking for a genuine locked carrier
            (not just band noise), ~2&nbsp;s each. Stops at the first one that locks.
          </p>
          <div class="flex flex-col gap-1">
            {scanAttempts().map(a => (
              <div class="flex items-center gap-2 text-xs">
                <span class={a.locked ? 'text-[#3fb950]' : 'text-[#8b949e]'}>{a.locked ? '✓' : '✗'}</span>
                <span class="text-[#c9d1d9] w-28">{a.station.label}</span>
                <span class="text-[10px] text-[#8b949e] font-mono">prominence {isFinite(a.bestProminenceDb) ? `${a.bestProminenceDb.toFixed(0)} dB` : '—'}</span>
              </div>
            ))}
            <Show when={scanIdx() < (ranking() ?? REFERENCE_STATIONS.map(s => ({ station: s }))).length && scanAttempts().length === scanIdx()}>
              <div class="flex items-center gap-2 text-xs">
                <span class="text-[#8b949e] animate-pulse">…</span>
                <span class="text-[#c9d1d9] w-28">
                  {(ranking() ?? REFERENCE_STATIONS.map(s => ({ station: s })))[scanIdx()]?.station.label}
                </span>
                <span class="text-[10px] text-[#8b949e]">
                  tone {liveTone() ? `${liveTone()!.hz.toFixed(0)} Hz` : '—'}
                </span>
              </div>
            </Show>
          </div>
          <div class="flex gap-2">
            <button class={btnGhost} onClick={cancelScan}>Cancel scan</button>
          </div>
        </Match>

        {/* ── Step: measuring ── */}
        <Match when={step() === 'measure'}>
          <p class="text-xs text-[#c9d1d9]">
            Radio tuned to <span class={mono}>{((effectiveRefHz() ?? 0) - TONE_HZ).toLocaleString()} Hz</span> USB —
            the reference carrier should be audible as a steady ~1&nbsp;kHz tone.
          </p>
          <div class="flex items-center gap-4 text-xs">
            <span class="text-[#8b949e]">Tone:</span>
            <span class={`${mono} text-sm`}>{liveTone() ? `${liveTone()!.hz.toFixed(2)} Hz` : '—'}</span>
            <span class="text-[#8b949e]">SNR:</span>
            <span class={`font-mono ${snrOk() ? 'text-[#3fb950]' : 'text-[#f0883e]'}`}>
              {liveTone() ? `${liveTone()!.snrDb.toFixed(0)} dB` : '—'}
            </span>
            <span class="text-[#8b949e]">{readCount()}/{TARGET_READINGS}</span>
          </div>
          <div class="h-1.5 bg-[#21262d] rounded overflow-hidden">
            <div class="h-full bg-[#388bfd] transition-all" style={{ width: `${(readCount() / TARGET_READINGS) * 100}%` }} />
          </div>
          <Show when={!snrOk() && liveTone() !== null}>
            <p class="text-[10px] text-[#f0883e]">
              Weak/absent tone — check that the station is audible and the audio input level is reasonable.
            </p>
          </Show>
          <Show
            when={summary() && !summary()!.ok}
            fallback={
              <Show when={!summary() || summary()!.ok}>
                <div class="flex gap-2">
                  <button class={btnGhost} onClick={close}>Cancel</button>
                </div>
              </Show>
            }
          >
            <p class="text-xs text-[#f85149]">{summary()!.reason}</p>
            <div class="flex gap-2">
              <button class={btnPrimary} onClick={() => beginMeasure()}>Retry</button>
              <button class={btnGhost} onClick={() => setStep('reference')}>Pick another reference</button>
            </div>
          </Show>
        </Match>

        {/* ── Step: review & apply ── */}
        <Match when={step() === 'apply' && result() && summary() && fxtalBefore() !== null}>
          <p class="text-xs text-[#c9d1d9]">
            Measured tone <span class={mono}>{summary()!.toneHz.toFixed(2)} Hz</span>{' '}
            (±{summary()!.spreadHz.toFixed(2)} Hz over {summary()!.readings} readings) — expected exactly {TONE_HZ} Hz.
          </p>
          <div class="text-xs text-[#c9d1d9] flex flex-col gap-1 bg-[#0d1117] border border-[#30363d] rounded p-3 font-mono tabular-nums">
            <span>Dial error: <span class={mono}>{result()!.errorHz >= 0 ? '+' : ''}{result()!.errorHz.toFixed(2)} Hz</span> ({result()!.errorPpm >= 0 ? '+' : ''}{result()!.errorPpm.toFixed(3)} ppm)</span>
            <span>Ref frq: <span class={mono}>{fxtalBefore()!.toLocaleString()}</span> → <span class={mono}>{result()!.newFxtal.toLocaleString()}</span> Hz (Δ {result()!.fxtalDeltaHz >= 0 ? '+' : ''}{result()!.fxtalDeltaHz})</span>
          </div>
          <Show when={Math.abs(result()!.errorPpm) > 20}>
            <p class="text-[10px] text-[#f0883e]">
              That&apos;s a large error for a TCXO — double-check that the reference frequency is correct before applying.
            </p>
          </Show>
          <Show when={error()}>
            <p class="text-xs text-[#f85149]">{error()}</p>
          </Show>
          <div class="flex gap-2">
            <button class={btnPrimary} onClick={applyCorrection} disabled={busy() || result()!.fxtalDeltaHz === 0}>
              {result()!.fxtalDeltaHz === 0 ? 'Already spot-on' : busy() ? 'Writing…' : 'Apply & Verify'}
            </button>
            <button class={btnGhost} onClick={() => beginMeasure()}>Re-measure</button>
            <button class={btnGhost} onClick={close}>Cancel</button>
          </div>
        </Match>

        {/* ── Step: verifying ── */}
        <Match when={step() === 'verify'}>
          <p class="text-xs text-[#c9d1d9]">Correction written — re-measuring to confirm…</p>
          <div class="flex items-center gap-4 text-xs">
            <span class="text-[#8b949e]">Tone:</span>
            <span class={`${mono} text-sm`}>{liveTone() ? `${liveTone()!.hz.toFixed(2)} Hz` : '—'}</span>
            <span class="text-[#8b949e]">{readCount()}/{VERIFY_READINGS}</span>
          </div>
          <div class="h-1.5 bg-[#21262d] rounded overflow-hidden">
            <div class="h-full bg-[#388bfd] transition-all" style={{ width: `${(readCount() / VERIFY_READINGS) * 100}%` }} />
          </div>
        </Match>

        {/* ── Step: done ── */}
        <Match when={step() === 'done' && result() && fxtalBefore() !== null}>
          <Show
            when={verifyTone() && verifyTone()!.ok && Math.abs(verifyTone()!.toneHz - TONE_HZ) < 2}
            fallback={
              <>
                {/* Whether the correction moved the tone TOWARD 1000 Hz at all —
                    computed from the actual pre-apply measurement (summary),
                    never asserted without checking. A verify miss can still be
                    real progress that just missed the tight <2Hz bar on a
                    shorter, noisier sample (25 readings vs. 50 for the initial
                    measurement) — that is NOT the same as "nothing happened". */}
                <Show
                  when={verifyTone() && isFinite(verifyTone()!.toneHz) && summary() && isFinite(summary()!.toneHz)}
                  fallback={
                    <p class="text-xs text-[#f0883e]">
                      Correction was written, but the verification {verifyTone() ? 'reading was inconclusive' : 'did not get a clean tone'}.
                    </p>
                  }
                >
                  <p class="text-xs text-[#f0883e]">
                    Verification tone came back at <span class="font-mono">{verifyTone()!.toneHz.toFixed(2)} Hz</span>{' '}
                    (residual {(verifyTone()!.toneHz - TONE_HZ) >= 0 ? '+' : ''}{(verifyTone()!.toneHz - TONE_HZ).toFixed(2)} Hz from the 1000&nbsp;Hz target) —
                    outside the &lt;2&nbsp;Hz confirmation threshold.{' '}
                    {Math.abs(verifyTone()!.toneHz - TONE_HZ) < Math.abs(summary()!.toneHz - TONE_HZ)
                      ? <>It DID move closer to 1000&nbsp;Hz than the {summary()!.toneHz.toFixed(2)}&nbsp;Hz baseline, just not close enough yet — likely measurement noise on this shorter verify pass rather than a failed correction. Try Re-measure for a longer, more averaged reading.</>
                      : <>It did NOT move closer to 1000&nbsp;Hz than the {summary()!.toneHz.toFixed(2)}&nbsp;Hz baseline — this correction likely did not take effect as expected.</>}
                  </p>
                </Show>
                <p class="text-[10px] text-[#8b949e]">
                  If every run ends up here, the measurement is probably not hearing the radio at all — double-check
                  that the browser&apos;s selected microphone/input really is the radio&apos;s audio output (not the laptop&apos;s
                  built-in mic), and that the level isn&apos;t clipping or silent. A steady single tone should be visible/audible;
                  a scattered, drifting spectrum means it&apos;s picking up something else. Otherwise it may simply be
                  fading/QSB — try again or pick another reference.
                </p>
              </>
            }
          >
            <p class="text-xs text-[#3fb950]">
              ✓ Calibrated. Verification tone: <span class="font-mono">{verifyTone()!.toneHz.toFixed(2)} Hz</span>{' '}
              (residual {(verifyTone()!.toneHz - TONE_HZ) >= 0 ? '+' : ''}{(verifyTone()!.toneHz - TONE_HZ).toFixed(2)} Hz).
            </p>
          </Show>
          <div class="text-xs text-[#c9d1d9] flex flex-col gap-1 bg-[#0d1117] border border-[#30363d] rounded p-3 font-mono tabular-nums">
            <span>Ref frq now: <span class={mono}>{result()!.newFxtal.toLocaleString()}</span> Hz (was <span class={mono}>{fxtalBefore()!.toLocaleString()}</span>)</span>
          </div>
          <p class="text-[10px] text-[#8b949e]">
            Keep it only if you trust the measurement above. A factory reset restores the compile-time default and loses any kept calibration either way.
          </p>
          <div class="flex gap-2">
            <button class={btnPrimary} onClick={keepAndFinish}>Keep new calibration</button>
            <button class={btnGhost} onClick={revertAndFinish}>Revert to {fxtalBefore()!.toLocaleString()} Hz</button>
          </div>
        </Match>
      </Switch>
    </div>
  )
}
