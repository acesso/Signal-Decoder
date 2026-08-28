// Port of src/components/FTTransmitPanel.tsx (Next.js app).
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show, type JSX } from 'solid-js'
import {
  createFTTransmit, loadMyCall, saveMyCall, loadMyGrid, saveMyGrid,
  loadAutoReply, saveAutoReply, loadBaseFreq, saveBaseFreq,
  loadAudioSinkKind, saveAudioSinkKind,
  loadSuspendIQDuringTx, saveSuspendIQDuringTx,
} from '../lib/ft/useFTTransmit'
import {
  buildFTMessage, nextTxMsgType, parseFTMsg, isValidCallsign, needsHashedExchange, qsyAudioOffsetHz,
  classifyCallsign, type Contact, type MsgType,
  MSG_TYPE_COLOR, MSG_TYPE_LABEL, gridToLatLon, haversineKm,
} from '$decoder-lib/ft/parser'
import { callsignCountry } from '$decoder-lib/ft/prefixes'
import { FT_WINDOW_SECONDS, DEFAULT_DECODER_PARAMS, type FTMode } from '$decoder-lib/ft/decoder'
import { fmtAbsHz } from '$decoder-lib/formatFreq'
import NumberField from './NumberField'
import type { AudioBridge } from '$decoder-lib/cat/useAudioBridge'
import type { AudioSinkKind } from '$decoder-lib/audio/audioSource'
import type { IQBridge } from '$decoder-lib/cat/useIQBridge'

// rAF-driven countdown: seconds until next window boundary, updated at ~4 Hz.
// Uses epoch time (not Date.getSeconds()) so it matches useFTTransmit's own
// boundary math (Date.now() % windowMs) exactly, with no minute-of-hour
// wraparound involved.
function useWindowCountdown(windowSec: () => number): () => number {
  const [secs, setSecs] = createSignal(0)
  let raf = 0
  let last = -1
  const tick = () => {
    const totalMs = windowSec() * 1000
    const elapsed = Date.now() % totalMs
    const remaining = (totalMs - elapsed) / 1000
    // At the exact zero-crossing instant, elapsed % totalMs collapses to 0,
    // which reads as "totalMs remaining" (a full window) instead of "we just
    // hit the boundary" — without this, the ring/ETA can flash the FULL
    // window value for one rAF tick right as a queued message actually fires,
    // making it look like TX happened a whole window early.
    const rounded = remaining >= windowSec() ? 0 : Math.ceil(remaining * 100) / 100 // 0.01s resolution
    if (rounded !== last) { last = rounded; setSecs(rounded) }
    raf = requestAnimationFrame(tick)
  }
  onMount(() => {
    raf = requestAnimationFrame(tick)
    onCleanup(() => cancelAnimationFrame(raf))
  })
  return secs
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function uid() { return Math.random().toString(36).slice(2, 9) }

const GRID_RE = /^[A-R]{2}[0-9]{2}([A-X]{2})?$/i
const CALL_RE = /^[A-Z0-9]{1,3}[0-9][A-Z]{1,4}(\/[A-Z0-9]+)?$/i

function validCall(s: string) { return CALL_RE.test(s.trim().toUpperCase()) }
function validGrid(s: string) { return s === '' || GRID_RE.test(s.trim().toUpperCase()) }

// Floor-only parse for the Audio Hz field — no live upper clamp and no
// step: NumberField's default min/max clamp (applied per keystroke) fought
// the operator mid-typing, same complaint already fixed for
// SignalAnalysisPanel's Width field via its own rawFreqParse. 0 is still
// enforced as a hard floor since a negative base frequency has no meaning
// for the encoder (see @e04/ft8ts's generateFT8Waveform, which only checks
// finiteness — nothing downstream else would catch it).
function nonNegativeFreqParse(raw: string): number | null {
  const n = parseFloat(raw)
  if (!Number.isFinite(n)) return null
  return Math.max(0, n)
}

// Convert lat/lon to 4-char Maidenhead grid square
function latLonToGrid(lat: number, lon: number): string {
  const adjLon = lon + 180
  const adjLat = lat + 90
  const fieldLon = Math.floor(adjLon / 20)
  const fieldLat = Math.floor(adjLat / 10)
  const squareLon = Math.floor((adjLon % 20) / 2)
  const squareLat = Math.floor(adjLat % 10)
  return String.fromCharCode(65 + fieldLon) +
         String.fromCharCode(65 + fieldLat) +
         squareLon.toString() +
         squareLat.toString()
}

const STATUS_COLOR: Record<string, string> = {
  idle:     '#484f58',
  waiting:  '#e3b341',
  encoding: '#58a6ff',
  playing:  '#2ea043',
}
const STATUS_LABEL: Record<string, string> = {
  idle:     'IDLE',
  waiting:  'WAIT',
  encoding: 'ENC',
  playing:  'TX',
}

// ── TX window progress ring (rAF-driven) ──────────────────────────────────────

function TxRing(props: { status: string; windowSec: number; playing: boolean }) {
  let svgEl: SVGSVGElement | undefined
  let raf = 0
  let prev = ''
  const r = 28, cx = 36, cy = 36
  const circ = 2 * Math.PI * r

  onMount(() => {
    const tick = () => {
      const svg = svgEl
      if (!svg) { raf = requestAnimationFrame(tick); return }

      const totalMs  = props.windowSec * 1000
      // Epoch-based (not Date.getSeconds()) to match useFTTransmit's own
      // boundary math exactly. At the precise zero-crossing instant this
      // collapses to elapsed=0 — treat that as "just completed a full cycle"
      // (progress=1, nextMs=0), not "no time has elapsed" (which flashed an
      // empty ring / a full-window countdown for one rAF tick right as a
      // queued message actually fired).
      const rawElapsed = Date.now() % totalMs
      const wrapped  = rawElapsed === 0
      const elapsed  = wrapped ? totalMs : rawElapsed
      const progress = elapsed / totalMs
      const nextMs   = wrapped ? 0 : totalMs - elapsed
      const secVal   = (nextMs / 1000).toFixed(1)

      if (secVal === prev) { raf = requestAnimationFrame(tick); return }
      prev = secVal

      const color  = STATUS_COLOR[props.status] ?? '#484f58'
      const filled = circ * progress

      svg.querySelector<SVGCircleElement>('.tx-arc')?.setAttribute('stroke', color)
      svg.querySelector<SVGCircleElement>('.tx-arc')?.setAttribute('stroke-dasharray', `${filled} ${circ - filled}`)
      const sec = svg.querySelector<SVGTextElement>('.tx-sec')
      if (sec) sec.textContent = props.status === 'idle' ? '--' : secVal
      const lbl = svg.querySelector<SVGTextElement>('.tx-lbl')
      if (lbl) { lbl.setAttribute('fill', color); lbl.textContent = STATUS_LABEL[props.status] ?? props.status.toUpperCase() }

      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    onCleanup(() => cancelAnimationFrame(raf))
  })

  const initColor = () => STATUS_COLOR[props.status] ?? '#484f58'

  return (
    <svg ref={svgEl} width={72} height={72} viewBox="0 0 72 72" class="shrink-0">
      {/* Pulsing outer ring when actively transmitting */}
      <Show when={props.playing}>
        <circle cx={cx} cy={cy} r={r + 6} fill="none" stroke="#2ea043" stroke-width={2}
          opacity={0.4} class="animate-ping" style={{ 'animation-duration': '1s' }} />
      </Show>
      <circle cx={cx} cy={cy} r={r} fill="none" stroke="#21262d" stroke-width={5} />
      <circle class="tx-arc" cx={cx} cy={cy} r={r} fill="none"
        stroke={initColor()} stroke-width={5}
        stroke-dasharray={`0 ${circ}`} stroke-dashoffset={circ * 0.25} />
      <text class="tx-lbl" x={cx} y={cy - 4} text-anchor="middle" font-size="7.5"
        fill={initColor()} font-family="monospace" font-weight="bold">
        {STATUS_LABEL[props.status] ?? props.status.toUpperCase()}
      </text>
      <text x={cx} y={cy + 7} text-anchor="middle" font-size="11" fill="#c9d1d9"
        font-family="monospace" font-weight="bold">
        <tspan class="tx-sec">{props.status === 'idle' ? '--' : '0.0'}</tspan>
      </text>
      <text x={cx} y={cy + 16} text-anchor="middle" font-size="7" fill="#484f58" font-family="monospace">
        {props.status !== 'idle' ? `/${props.windowSec}s` : ''}
      </text>
    </svg>
  )
}

// ── Output device selector ────────────────────────────────────────────────────

function OutputSelector(props: { value: string; onChange: (id: string) => void; supported: boolean }) {
  const [devices, setDevices] = createSignal<MediaDeviceInfo[]>([])

  createEffect(() => {
    if (!props.supported) return
    navigator.mediaDevices.enumerateDevices()
      .then(all => setDevices(all.filter(d => d.kind === 'audiooutput')))
      .catch(() => null)
  })

  return (
    // No fallback text when unsupported (Firefox, older Chrome) — that text
    // used to break the row's alignment wherever this renders; rendering
    // nothing keeps the layout intact, and "System default" output is
    // already the behavior when there's no device selection at all.
    <Show when={props.supported}>
      <select value={props.value} onChange={e => props.onChange(e.target.value)}
        class="bg-[#0d1117] border border-[#30363d] rounded px-2 py-1 text-xs text-[#c9d1d9] font-mono focus:outline-none focus:border-[#388bfd]">
        <option value="">System default</option>
        <For each={devices()}>
          {d => (
            <option value={d.deviceId}>
              {d.label || `Output ${d.deviceId.slice(0, 8)}`}
            </option>
          )}
        </For>
      </select>
    </Show>
  )
}

// ── Suggestion builder ────────────────────────────────────────────────────────

// One entry in the QSO exchange thread shown under each suggestion
interface QSOStep {
  raw: string;       // message text
  mine: boolean;     // true = sent by us
  snr?: number;
  time: Date;
}

interface Suggestion {
  type: MsgType;
  message: string;
  label: string;
  callsign?: string;
  color?: string;
  isCQ?: boolean; // contact's last heard message was a CQ
  /** They CQ'd with a numeric QSY request we can honor — the TX Audio Hz to
   *  switch to when this suggestion is queued (never a rig retune). */
  qsyHz?: number;
  countryCode?: string;
  // true when the contact has directly addressed our callsign — warrants highlight
  repliedToMe: boolean;
  // recent exchange thread for this contact (newest last, up to ~4 entries)
  thread: QSOStep[];
  // for sorting
  maxSnr: number;
  latLon?: [number, number];
  // for filter chips: last-heard time and last message's frequency (absolute
  // Hz when a VFO was connected at decode time, bare audio offset otherwise)
  lastSeenMs: number;
  lastFreqHz?: number;
}

// Priority: stations actively in QSO with us rank above stations we merely heard.
function contactPriority(c: Contact, myCall: string): number {
  const myCallUp = myCall.toUpperCase()
  const repliedToUs = c.msgs.some(m => m.role === 'tx' && m.parsed.callee?.toUpperCase() === myCallUp)
  return repliedToUs ? 1 : 0
}

// When this station was last actually HEARD (its own transmissions only).
// c.lastSeen also updates when the station is merely ADDRESSED by someone
// else, which keeps long-gone stations looking "fresh" for as long as others
// keep calling them.
function lastHeardMs(c: Contact): number {
  for (let i = c.msgs.length - 1; i >= 0; i--) {
    if (c.msgs[i].role === 'tx') return c.msgs[i].windowStart.getTime()
  }
  return 0
}

function buildSuggestions(myCall: string, myGrid: string, contacts: Map<string, Contact>, vfoHz = 0, foxHound = false): Suggestion[] {
  const sugs: Suggestion[] = []

  sugs.push({
    type: 'cq',
    message: buildFTMessage('cq', myCall, '', undefined, myGrid),
    label: 'CQ',
    repliedToMe: false,
    thread: [],
    maxSnr: -99,
    lastSeenMs: 0,
  })

  const candidates = [...contacts.values()]
    .filter(c => isValidCallsign(c.callsign) && c.callsign.toUpperCase() !== myCall.toUpperCase())
    .sort((a, b) => {
      const pd = contactPriority(b, myCall) - contactPriority(a, myCall)
      if (pd !== 0) return pd
      return lastHeardMs(b) - lastHeardMs(a)
    })

  const myCallUp = myCall.toUpperCase()

  for (const c of candidates) {
    const theirMsgs  = c.msgs.filter(m => m.role === 'tx')
    // Never actually heard this station (it only ever appeared as someone
    // else's addressee) — we can't answer what we can't hear, and its
    // SNR/recency/frequency would all be another station's.
    if (theirMsgs.length === 0) continue
    const replieToUs = theirMsgs.filter(m => m.parsed.callee?.toUpperCase() === myCallUp)
    const ourMsgs    = c.msgs.filter(m => m.role === 'rx' && m.parsed.caller?.toUpperCase() === myCallUp)

    // Latest of their transmissions by timestamp — gate replays can append
    // released messages out of push order.
    const lastHeard = theirMsgs.reduce((latest, m) => m.windowStart > latest.windowStart ? m : latest, theirMsgs[0])

    const repliedToMe   = replieToUs.length > 0
    const lastOurMsg    = ourMsgs[ourMsgs.length - 1]
    // Abandoned exchange: after our last transmission to them, the most
    // recent thing we actually heard from them was addressed to someone
    // ELSE, not us — they've moved on (e.g. working another station).
    // Treating our last stale exchange as still "in progress" would have
    // the state machine forever propose "continue" (re-send RR73/report/etc)
    // for a QSO the other side already walked away from, so this resets to
    // a fresh "answer" instead of trusting a reply that's no longer current.
    const abandoned = !!lastOurMsg && lastHeard.windowStart > lastOurMsg.windowStart
      && lastHeard.parsed.callee?.toUpperCase() !== myCallUp
    // Only a message actually ADDRESSED TO US can advance the state machine —
    // e.g. a Fox reporting a different Hound (KQ4YOL) must never be read as
    // Fox reporting us just because it's their most recent transmission
    // overall. Falling back to theirMsgs here (instead of leaving lastRx
    // null) previously caused a stale "R+Report"/"RR73" suggestion to
    // resurface after re-calling a Fox who'd moved on to another station.
    const lastTheirMsg  = abandoned ? undefined : replieToUs[replieToUs.length - 1]
    const lastRx        = lastTheirMsg?.parsed.type ?? null
    const lastSent      = abandoned ? null : (lastOurMsg?.parsed.type ?? null)

    let nextTxType: ReturnType<typeof nextTxMsgType>
    if (!lastSent) {
      nextTxType = 'answer'
    } else {
      nextTxType = nextTxMsgType(lastSent, lastRx, foxHound)
      if (nextTxType === 'cq') continue
    }

    // Use best SNR across all their messages to us (not just the latest);
    // fall back to their last heard transmission (even if abandoned/to
    // someone else) rather than 0 — it's still the best signal data we have.
    const bestSnr  = replieToUs.length
      ? replieToUs.reduce((best, m) => m.snr > best ? m.snr : best, -99)
      : lastHeard.snr
    const reportDb = Math.round(bestSnr)
    const message  = buildFTMessage(nextTxType, myCall, c.callsign, reportDb, myGrid)

    // Build exchange thread: interleave their direct messages and our replies,
    // sorted by time, keep the last 4 entries. When abandoned, append their
    // most recent transmission too (even though it's not addressed to us) —
    // otherwise the thread only ever shows OUR side of a stale exchange with
    // no visible sign they've since answered someone else.
    const threadMsgs: Array<{ t: Date; raw: string; mine: boolean; snr?: number }> = [
      ...repliedToMe
        ? replieToUs.map(m => ({ t: m.windowStart, raw: m.raw, mine: false, snr: m.snr }))
        : theirMsgs.slice(-2).map(m => ({ t: m.windowStart, raw: m.raw, mine: false, snr: m.snr })),
      ...ourMsgs.map(m => ({ t: m.windowStart, raw: m.raw, mine: true })),
      ...abandoned ? [{ t: lastHeard.windowStart, raw: lastHeard.raw, mine: false, snr: lastHeard.snr }] : [],
    ].sort((a, b) => a.t.getTime() - b.t.getTime()).slice(-4)

    const thread: QSOStep[] = threadMsgs.map(m => ({ raw: m.raw, mine: m.mine, snr: m.snr, time: m.t }))

    const labelMap: Record<string, string> = foxHound
      ? { answer: 'Call Fox', report: 'Report', r_report: 'R+Report', rr73: 'RR73', tx73: '73' }
      : { answer: 'Answer',   report: 'Report', r_report: 'R+Report', rr73: 'RR73', tx73: '73' }

    const pfx = callsignCountry(c.callsign)
    const lastTxParsed = lastHeard.parsed
    // Honor a numeric QSY request when answering their CQ: move OUR TX audio
    // to where they said they're listening (pure Audio Hz — the VFO already
    // covers the whole passband, so the rig is never touched).
    const qsyHz = nextTxType === 'answer' && lastTxParsed?.type === 'cq'
      ? qsyAudioOffsetHz(lastTxParsed.cqTag, vfoHz) ?? undefined
      : undefined
    sugs.push({
      type: nextTxType as MsgType,
      message,
      label: labelMap[nextTxType] ?? 'Reply',
      callsign: c.callsign,
      color: c.color,
      countryCode: pfx?.countryCode,
      isCQ: lastTxParsed?.type === 'cq',
      qsyHz,
      repliedToMe,
      thread,
      // Their own transmissions only — an rx-role message's SNR/time/freq
      // belongs to whoever SENT it, not to this station.
      maxSnr: theirMsgs.reduce((best, m) => m.snr > best ? m.snr : best, -99),
      latLon: c.latLon,
      lastSeenMs: lastHeard.windowStart.getTime(),
      lastFreqHz: lastHeard.freq,
    })
  }

  return sugs
}

// Render a suggestion message with the user's callsign highlighted
function SugMsgText(props: { message: string; myCall: string; contactColor?: string }) {
  const upper = () => props.myCall.toUpperCase()
  return (
    <For each={props.message.trim().split(/\s+/)}>
      {(w, i) => {
        const sep = i() > 0 ? ' ' : ''
        if (upper() && w.toUpperCase() === upper()) {
          return (
            <span>
              {sep}
              <span class="font-bold px-0.5 rounded" style={{ color: '#f0e68c', background: 'rgba(240,230,140,0.13)' }}>{w}</span>
            </span>
          )
        }
        if (props.contactColor && w.toUpperCase() === w && w.length > 2 && /^[A-Z0-9/]+$/.test(w) && w !== 'CQ' && w !== 'RR73' && w !== 'RRR') {
          return <span><span class="font-bold" style={{ color: props.contactColor }}>{sep}{w}</span></span>
        }
        return <span>{sep}{w}</span>
      }}
    </For>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export interface TxStatus {
  status: string;       // 'idle' | 'waiting' | 'encoding' | 'playing'
  isRunning: boolean;
  queueLen: number;
  pendingReplies: number; // contacts that have messaged us but we haven't replied yet
  autoReply: boolean;
  autoCQ: boolean;
  autoCQIntervalMin: number;
  autoPTT: boolean;
  allowConsecutiveTx: boolean;
  windowSec: number;
  txAudioHz: number;    // current TX audio frequency in Hz (baseFreq)
}

interface FTTransmitPanelProps {
  mode: FTMode;
  contacts: Map<string, Contact>;
  vfoFrequency?: number;
  audioBridge?: AudioBridge;
  /** For the "Suspend I/Q spectrum during TX" toggle — only shown while the
   *  bridge is actually in I/Q input mode (relocated here from
   *  RadioCATPanel.tsx's BridgeInputModeControl). */
  iqBridge?: IQBridge;
  /** CAT bridge WebSocket URL — rewritten to the bridge's plain HTTP control
   *  endpoints (not opened as a second WebSocket) so selecting "ESP32
   *  Bridge" as the TX output can upload the encoded message and trigger
   *  remote playback — see useFTTransmit.ts's uploadIfBridgeSink()/
   *  playBridgeSlotAndWait(). */
  bridgeWsUrl?: string;
  onMyCallChange?: (call: string) => void;
  onMyGridChange?: (grid: string) => void;
  onSetPTT?: (tx: boolean) => Promise<void>;
  /** Brackets each keyed TX window — see useFTTransmit.ts's
   *  getOnTxWindowStart/End comment. App.tsx wires these to suspend/resume
   *  the bridge's /iq-data spectrum connection (real-hardware WiFi/I2S DMA
   *  contention — see loadSuspendIQDuringTx()). */
  onTxWindowStart?: () => void;
  onTxWindowEnd?: () => void;
  onStatusChange?: (s: TxStatus) => void;
  onReset?: (clearSentFn: () => void) => void;
  onBaseFreqHandle?: (setFn: (v: number, committed?: boolean) => void) => void;
}

export default function FTTransmitPanel(props: FTTransmitPanelProps): JSX.Element {
  const [myCall, setMyCallState]     = createSignal(loadMyCall())
  const [myGrid, setMyGridState]     = createSignal(loadMyGrid())
  const [baseFreq, setBaseFreqState] = createSignal(loadBaseFreq())
  // Tracks whether the LATEST baseFreq update is a final, committed value —
  // false while the TX marker is actively being dragged (see
  // SignalAnalysisPanel's onMarkerDrag comment). The syncParams() effect
  // below gates its real work (encode + upload to the bridge) on this
  // being true, so a live drag only ever moves the marker/updates the
  // displayed number — never fires a network request until the drag ends.
  // REAL HARDWARE INCIDENT this fixes (2026-08-28): every live drag tick
  // used to eventually trigger a full re-encode-and-upload (via a settle-
  // timer that fires on ANY pause mid-drag, not just at release), which
  // saturated the ESP32 bridge's WiFi link badly enough to crash/reboot it.
  const [baseFreqCommitted, setBaseFreqCommitted] = createSignal(true)
  const setBaseFreq = (v: number, committed = true) => {
    const clamped = Math.max(200, Math.min(3000, Math.round(v)))
    setBaseFreqState(clamped)
    setBaseFreqCommitted(committed)
    if (committed) saveBaseFreq(clamped) // no need to persist every live drag tick — only the final value
  }
  const [editMsg, setEditMsg]        = createSignal('')
  const [editLabel, setEditLabel]    = createSignal('')
  const [callErr, setCallErr]        = createSignal(false)
  const [gridErr, setGridErr]        = createSignal(false)
  const [isRunning, setIsRunning]    = createSignal(false)
  const [geoStatus, setGeoStatus]    = createSignal<'idle' | 'loading' | 'done' | 'denied'>('idle')

  const vfoFrequency = () => props.vfoFrequency ?? 0

  // Where TX audio actually plays: the local speaker, or out through the
  // ESP32 bridge's mic-send path (so the radio itself transmits it, no
  // local sound card/PA cabling needed). Only offered when a bridge
  // instance was actually passed in (App.tsx wires this up once
  // useRadioCAT/useAudioBridge are both lifted) — see audioSource.ts.
  const hadStoredSinkKind = loadAudioSinkKind() !== null
  const [audioSinkKind, setAudioSinkKindState] = createSignal<AudioSinkKind>(loadAudioSinkKind() ?? 'speaker')
  const setAudioSinkKind = (v: AudioSinkKind) => {
    setAudioSinkKindState(v)
    saveAudioSinkKind(v)
  }
  // Auto-picks 'bridge' the moment the bridge's audio connects, same
  // principle as App.tsx's handleStart() auto-connecting bridge audio for
  // decode — if CAT is set up to use the bridge, TX should go out through
  // the radio by default too, not silently play out the browser's own
  // speakers while the operator assumes it went out over the air. Only
  // fires on the transition into "connected" (not on every render/re-check
  // of playbackActive), so an operator who deliberately switches back to
  // "Local speaker" mid-session doesn't get overridden the next time some
  // other unrelated state change re-runs this effect. Skipped entirely once
  // a preference has ever been explicitly saved (including a prior
  // auto-pick) — reload-persistence means this auto-pick should only ever
  // happen once, the very first time a bridge is seen, not re-fire every
  // session and override a deliberate "Local speaker" choice.
  let sawBridgeConnected = false
  let autoPickedOnce = hadStoredSinkKind
  createEffect(() => {
    const connected = props.audioBridge?.state().playbackActive ?? false
    if (connected && !sawBridgeConnected && !autoPickedOnce) {
      setAudioSinkKind('bridge')
      autoPickedOnce = true
    }
    sawBridgeConnected = connected
  })
  const micHeldByManual = () => {
    const s = props.audioBridge?.state()
    return !!s && s.micActive && s.micOwner === 'manual'
  }

  // Relocated from RadioCATPanel.tsx's BridgeInputModeControl — persisted
  // via useFTTransmit.ts's load/save pair since App.tsx reads
  // loadSuspendIQDuringTx() fresh at the moment each TX window starts,
  // rather than needing this threaded through as a reactive prop.
  const [suspendDuringTx, setSuspendDuringTx] = createSignal(loadSuspendIQDuringTx())

  const tx = createFTTransmit(
    () => props.mode,
    baseFreq,
    vfoFrequency,
    () => props.onSetPTT,
    audioSinkKind,
    () => props.bridgeWsUrl,
    () => props.onTxWindowStart,
    () => props.onTxWindowEnd,
  )

  // Keep the auto-CQ cache in sync with mode/baseFreq changes. Debounced:
  // baseFreq (the "Audio Hz" field) commits on every single step-button
  // click and every keystroke while typing (see NumberField's onInput/step),
  // and syncParams() spawns a real encodeAsync() DSP encode — without this
  // debounce, holding/repeatedly clicking the step buttons queued a fresh
  // encode per click, almost all of them thrown away the instant the next
  // one superseded them (see rebuildAutoCQCache's staleness guard), causing
  // visible lag. Mode changes are rare/discrete (a dropdown pick), so only
  // baseFreq's rapid-fire case needs debouncing — but both go through the
  // same timer for one code path.
  //
  // baseFreqCommitted() gates this ENTIRELY while false — a live TX marker
  // drag must never start this timer at all, only the drag's own final
  // (committed) value at mouseup should. REAL HARDWARE INCIDENT this fixes
  // (2026-08-28): the previous version armed this timer on every drag tick
  // too, and since it's a settle-timer (fires 300ms after the LAST change,
  // not after a fixed delay from drag-start), any brief pause mid-drag —
  // not just release — was enough to let it fire, triggering a full
  // re-encode-and-upload burst mid-drag. That flooded the ESP32 bridge's
  // fragile WiFi link badly enough to crash/reboot it. Gating on
  // baseFreqCommitted() means NOTHING fires until the drag genuinely ends.
  let syncParamsTimer: ReturnType<typeof setTimeout> | undefined
  createEffect(() => {
    void props.mode
    void baseFreq()
    const committed = baseFreqCommitted()
    if (syncParamsTimer) clearTimeout(syncParamsTimer)
    if (!committed) return
    syncParamsTimer = setTimeout(() => tx.syncParams(), 300)
  })
  onCleanup(() => { if (syncParamsTimer) clearTimeout(syncParamsTimer) })

  // Register clearSent with parent so the global Reset button can clear TX history
  createEffect(() => {
    props.onReset?.(tx.clearSent)
  })

  // Expose setBaseFreq to the parent so the Audio Analysis panel's TX marker
  // (rendered as a sibling under FTDecoder, not a child of this panel) can
  // drag-adjust it directly.
  createEffect(() => {
    props.onBaseFreqHandle?.(setBaseFreq)
  })

  // dB <-> linear helpers (slider operates in dB, GainNode needs linear)
  const gainToDb = (g: number) => g <= 0 ? -60 : 20 * Math.log10(g)
  const dbToGain = (db: number) => db <= -60 ? 0 : Math.pow(10, db / 20)
  const txDb = createMemo(() => Math.round(gainToDb(tx.state().txGain)))

  // Push persisted callsign/grid to parent on first render
  onMount(() => {
    if (myCall()) props.onMyCallChange?.(myCall())
    if (myGrid()) props.onMyGridChange?.(myGrid())
  })

  // ── Geolocation on mount (if no saved grid) ──────────────────────────────
  onMount(() => {
    if (loadMyGrid() || typeof navigator === 'undefined' || !navigator.geolocation) return
    setGeoStatus('loading')
    navigator.geolocation.getCurrentPosition(
      pos => {
        const grid = latLonToGrid(pos.coords.latitude, pos.coords.longitude)
        setMyGridState(grid)
        saveMyGrid(grid)
        props.onMyGridChange?.(grid)
        setGeoStatus('done')
      },
      () => setGeoStatus('denied'),
      { timeout: 8000 },
    )
  })

  const setMyCall = (v: string) => {
    setMyCallState(v); saveMyCall(v); setCallErr(v !== '' && !validCall(v))
    props.onMyCallChange?.(v)
  }

  const setMyGrid = (v: string) => {
    setMyGridState(v); saveMyGrid(v); setGridErr(!validGrid(v))
    props.onMyGridChange?.(v)
  }

  createEffect(() => {
    if (myCall()) tx.setAutoCQMessage(buildFTMessage('cq', myCall().toUpperCase(), '', undefined, myGrid().toUpperCase()))
  })

  const canOperate = createMemo(() => validCall(myCall()) && validGrid(myGrid()) && props.mode !== 'FT2')

  const handleStart = async () => { if (!canOperate()) return; setIsRunning(true); await tx.start() }
  const handleStop  = () => { setIsRunning(false); tx.stop() }

  // ── Auto-reply ───────────────────────────────────────────────────────────────
  const [autoReply, setAutoReplyState] = createSignal(loadAutoReply())
  // Track the last-processed message fingerprint per callsign:
  // callsign -> "lastTheirMsgCount|lastOurMsgCount" so we re-fire when new messages arrive
  const autoReplied = new Map<string, string>()
  // Per-conversation TX audio pins (callsign → Hz), honoring QSY requests.
  // The global Audio Hz is never moved — only the messages belonging to the
  // pinned conversation encode at the requested frequency.
  const convAudioHz = new Map<string, number>()

  const setAutoReply = (v: boolean) => {
    setAutoReplyState(v)
    saveAutoReply(v)
    if (!v) autoReplied.clear()
  }

  // Reset seen-map when TX engine stops so replies fire again next session
  createEffect(() => {
    if (!isRunning()) autoReplied.clear()
  })

  // Report status to parent (for collapsed summary display)
  createEffect(() => {
    if (!props.onStatusChange) return
    const myCallUp = myCall().toUpperCase()
    let pendingReplies = 0
    for (const c of props.contacts.values()) {
      const addressedUs = c.msgs.some(m => m.role === 'tx' && m.parsed.callee?.toUpperCase() === myCallUp)
      if (addressedUs) pendingReplies++
    }
    props.onStatusChange({
      status: tx.state().status, isRunning: isRunning(), queueLen: tx.state().queue.length, pendingReplies, autoReply: autoReply(),
      autoCQ: tx.state().autoCQ, autoCQIntervalMin: tx.state().autoCQIntervalMin,
      autoPTT: tx.state().autoPTT, allowConsecutiveTx: tx.state().allowConsecutiveTx,
      windowSec: FT_WINDOW_SECONDS[props.mode] ?? 15, txAudioHz: baseFreq(),
    })
  })

  createEffect(() => {
    if (!autoReply() || !isRunning() || !canOperate()) return
    const myCallUp = myCall().toUpperCase()
    const myGridUp = myGrid().toUpperCase()

    for (const contact of props.contacts.values()) {
      const callsign = contact.callsign.toUpperCase()
      if (callsign === myCallUp) continue

      // Messages they sent addressed to us
      const theirMsgsToUs = contact.msgs.filter(m =>
        m.role === 'tx' && m.parsed.callee?.toUpperCase() === myCallUp
      )
      if (theirMsgsToUs.length === 0) continue

      // Latest by timestamp — the quarantine gate can replay released
      // messages out of push order.
      const lastTheirMsg = theirMsgsToUs.reduce(
        (latest, m) => m.windowStart > latest.windowStart ? m : latest, theirMsgsToUs[0],
      )
      const lastTheirType = lastTheirMsg.parsed.type

      // What we've already sent them — read from the TX sent log, not from decoded
      // contacts (our own transmissions are never decoded back by the receiver).
      // state.sent is newest-first, so filter then take index 0 for the most recent.
      const sentToThem = tx.state().sent.filter(e =>
        parseFTMsg(e.message).callee?.toUpperCase() === callsign
      )
      const lastSentMsg = sentToThem.length ? sentToThem[0] : null

      // Fingerprint: re-fire whenever either side has a NEW latest message.
      // Never counts — the contact's 60-message ring rotates, so counts can
      // stay constant (one old dropped, one new added) across a new arrival.
      const fingerprint = `${lastTheirMsg.windowStart.getTime()}|${lastTheirType}|${lastSentMsg?.windowStart.getTime() ?? 0}`
      if (autoReplied.get(callsign) === fingerprint) continue

      // Turn-taking: only transmit when THEY spoke last. If our own message
      // is the newer one we're waiting on their reply — acting again here
      // would answer our own transmission and double-send every exchange.
      if (lastSentMsg && lastSentMsg.windowStart.getTime() >= lastTheirMsg.windowStart.getTime()) {
        autoReplied.set(callsign, fingerprint)
        continue
      }

      const lastSentType = lastSentMsg ? parseFTMsg(lastSentMsg.message).type : null

      // For the very first reply to a station, treat as if we just sent CQ
      const effectiveLastSent: MsgType = lastSentType ?? 'cq'
      const nextType = nextTxMsgType(effectiveLastSent, lastTheirType, foxHound())

      // 'cq' means complete or unrecognised — nothing to send
      if (nextType === 'cq') { autoReplied.set(callsign, fingerprint); continue }

      // Use best SNR from all their messages to us
      const bestSnr = theirMsgsToUs.reduce((best, m) => m.snr > best ? m.snr : best, -99)
      const message = buildFTMessage(nextType, myCallUp, callsign, Math.round(bestSnr), myGridUp)

      // Already queued → pending, nothing to add. NOTE: a matching entry in
      // the SENT log deliberately does NOT block — the peer repeating their
      // message means our earlier transmission was lost, and the correct
      // move is to re-send the exact same message (retry).
      if (tx.state().queue.some(e => e.message === message)) { autoReplied.set(callsign, fingerprint); continue }

      const labelMap: Record<string, string> = {
        answer: 'Answer', report: 'Report', r_report: 'R+Report', rr73: 'RR73', tx73: '73',
      }

      // The conversation moved on — drop any queued auto-reply to this
      // station that this message supersedes (e.g. a queued report when
      // they've already rogered), so the stale step never transmits.
      for (const e of tx.state().queue) {
        if (e.label.startsWith('Auto → ') && parseFTMsg(e.message).callee?.toUpperCase() === callsign) {
          tx.dequeue(e.id)
        }
      }

      autoReplied.set(callsign, fingerprint)
      // Keep honoring a conversation's pinned QSY frequency across the exchange
      tx.enqueueFirst({
        id: uid(), message, label: `Auto → ${contact.callsign} (${labelMap[nextType] ?? nextType})`,
        audioHz: convAudioHz.get(callsign),
      })
    }
  })

  // ── Suggestion sort / filter state ──────────────────────────────────────────
  type SugSort = 'default' | 'snr-hi' | 'snr-lo' | 'near' | 'far'
  const [sugSort,          setSugSort]          = createSignal<SugSort>('default')
  const [sugCountryFilter, setSugCountryFilter] = createSignal('')
  const [sugMyOnly,        setSugMyOnly]        = createSignal(false)
  const [sugCQOnly,        setSugCQOnly]        = createSignal(false)
  const [sugVfoOnly,       setSugVfoOnly]       = createSignal(false)
  const [sugLatestOnly,    setSugLatestOnly]    = createSignal(false)
  const [sugSpecialOnly,   setSugSpecialOnly]   = createSignal(false)
  // Fox/Hound (DXpedition) mode: compresses the call-in sequence — once Fox
  // reports us we jump straight to RR73 instead of the normal r_report step,
  // since Fox logs a Hound after one report and never round-trips an ack.
  const [foxHound,         setFoxHound]         = createSignal(false)

  const SUG_LATEST_WINDOW_MS = 5 * 60_000

  const DISPLAY_LIMIT = 8

  const myCallUp = createMemo(() => myCall().toUpperCase())
  const myGridUp = createMemo(() => myGrid().toUpperCase())

  const allSuggestions = createMemo(
    () => buildSuggestions(myCallUp(), myGridUp(), props.contacts, props.vfoFrequency ?? 0, foxHound()),
  )

  const myLatLon = createMemo(
    () => myGridUp() ? (gridToLatLon(myGridUp()) ?? null) : null,
  )

  // Build country list from non-CQ suggestions — only recomputes when suggestions change
  const sugCountryOptions = createMemo(() => Array.from(
    allSuggestions().filter(s => s.callsign && s.countryCode).reduce((acc, s) => {
      const pfx = callsignCountry(s.callsign!)
      if (pfx?.countryCode && pfx.country && pfx.flag) {
        const existing = acc.get(pfx.countryCode)
        acc.set(pfx.countryCode, existing
          ? { ...existing, count: existing.count + 1 }
          : { code: pfx.countryCode, country: pfx.country, flag: pfx.flag, count: 1 })
      }
      return acc
    }, new Map<string, { code: string; country: string; flag: string; count: number }>())
  .values()).sort((a, b) => b.count - a.count || a.country.localeCompare(b.country)))

  const distKm = (s: Suggestion): number =>
    (myLatLon() && s.latLon) ? haversineKm(myLatLon()!, s.latLon) : Infinity

  // Separate CQ (always first, never reordered/filtered) from contact suggestions
  const cqSug = createMemo(() => allSuggestions()[0])
  const contactSugs = createMemo(() => allSuggestions().slice(1))
  const suggestions = createMemo(() => {
    const vfo = props.vfoFrequency ?? 0
    const latestCutoff = Date.now() - SUG_LATEST_WINDOW_MS
    // A station that has directly answered our callsign is mid-QSO with us —
    // the discovery chips (CQ only, special, country, VFO, latest) exist to
    // narrow down who to call next, not to hide someone we already owe a
    // reply to. Only sugMyOnly is exempted from this: it's the inverse ask
    // ("show me just my own contacts"), so repliedToMe already satisfies it.
    const filteredSugs = contactSugs().filter(s => {
      if (sugMyOnly() && s.thread.length === 0) return false
      if (s.repliedToMe) return true
      if (sugCountryFilter() && s.countryCode !== sugCountryFilter()) return false
      if (sugCQOnly() && !s.isCQ) return false
      // Same rule as the map's VFO-only pin filter: keep stations whose
      // last-heard absolute frequency falls in the passband around the live
      // VFO; audio-offset-only entries (no VFO at decode time) are excluded.
      if (sugVfoOnly() && vfo > 0) {
        if (!s.lastFreqHz || s.lastFreqHz <= 1_000_000) return false
        if (s.lastFreqHz < vfo + DEFAULT_DECODER_PARAMS.minHz ||
            s.lastFreqHz > vfo + DEFAULT_DECODER_PARAMS.maxHz) return false
      }
      if (sugLatestOnly() && s.lastSeenMs < latestCutoff) return false
      if (sugSpecialOnly() && !(s.callsign && classifyCallsign(s.callsign).kind !== 'standard')) return false
      return true
    })
    const sortedSugs = [...filteredSugs].sort((a, b) => {
      if (sugSort() === 'snr-hi') return b.maxSnr - a.maxSnr
      if (sugSort() === 'snr-lo') return a.maxSnr - b.maxSnr
      if (sugSort() === 'near')   return distKm(a) - distKm(b)
      if (sugSort() === 'far')    return distKm(b) - distKm(a)
      return 0 // default: keep buildSuggestions order (priority + recency)
    })
    // Pin replied-to contacts ahead of the display cap regardless of sort —
    // a station we're mid-QSO with must never scroll off because 70 other
    // stations happened to be heard more recently or sort earlier by SNR/distance.
    const replied    = sortedSugs.filter(s => s.repliedToMe)
    const notReplied = sortedSugs.filter(s => !s.repliedToMe)
    const shown = [...replied, ...notReplied].slice(0, DISPLAY_LIMIT - 1)
    return [cqSug(), ...shown]
  })

  const addSuggestion = (sug: Suggestion) => {
    if (!canOperate()) return
    if (tx.state().queue.some(e => e.message === sug.message)) return
    const cs = sug.callsign?.toUpperCase()
    if (sug.qsyHz !== undefined && cs) convAudioHz.set(cs, sug.qsyHz)
    const pinned = sug.qsyHz ?? (cs ? convAudioHz.get(cs) : undefined)
    tx.enqueue({ id: uid(), message: sug.message, label: sug.label, audioHz: pinned })
  }

  const [customErr, setCustomErr] = createSignal('')

  const addCustom = () => {
    const msg = editMsg().trim().toUpperCase()
    if (!msg) return
    // The encoder silently truncates anything it can't pack as a structured
    // message to 13-char free text — refuse the known traps here instead of
    // transmitting a mangled message.
    const words = msg.split(/\s+/)
    if (words[0] !== 'CQ') {
      for (const w of words.slice(0, 2)) {
        if (!w.startsWith('<') && isValidCallsign(w) && needsHashedExchange(w)) {
          setCustomErr(`${w} doesn't fit a standard field — hash it: <${w}> (grids can't be sent alongside it)`)
          return
        }
      }
    }
    if (msg.length > 13 && !parseFTMsg(msg).clean) {
      setCustomErr('Not a standard FT8 form — free text is limited to 13 chars')
      return
    }
    setCustomErr('')
    if (tx.state().queue.some(e => e.message === msg)) return
    tx.enqueue({ id: uid(), message: msg, label: editLabel().trim() || msg })
    setEditMsg(''); setEditLabel('')
  }

  const windowSec   = createMemo(() => FT_WINDOW_SECONDS[props.mode] ?? 15)
  const isPlaying   = createMemo(() => tx.state().status === 'playing')
  const secToWindow = useWindowCountdown(windowSec)

  return (
    <div class="space-y-3">

      {/* ── Top row: identity + ring + Output ── */}
      <div class="flex flex-wrap gap-3 items-end">

        {/* TX window ring */}
        <div class={`transition-opacity ${!isRunning() ? 'opacity-30' : ''}`}>
          <TxRing status={tx.state().status} windowSec={windowSec()} playing={isPlaying()} />
        </div>

        {/* Callsign */}
        <div class="flex flex-col gap-1">
          <label class="text-[#8b949e] text-[10px] font-semibold tracking-wide">My Callsign</label>
          <input value={myCall()} onInput={e => setMyCall(e.currentTarget.value.toUpperCase())}
            placeholder="PU7FWT" maxLength={12}
            class={`bg-[#0d1117] border rounded px-2 py-1.5 text-sm font-mono text-[#c9d1d9] w-28 focus:outline-none focus:border-[#388bfd] ${callErr() ? 'border-[#f85149]' : 'border-[#30363d]'}`} />
          <Show when={callErr()}><span class="text-[#f85149] text-[10px]">Invalid callsign</span></Show>
        </div>

        {/* Grid */}
        <div class="flex flex-col gap-1">
          <label class="text-[#8b949e] text-[10px] font-semibold tracking-wide">
            My Grid
            <Show when={geoStatus() === 'loading'}><span class="ml-1 text-[#484f58]">locating…</span></Show>
            <Show when={geoStatus() === 'done'}><span class="ml-1 text-[#2ea043]">✓ GPS</span></Show>
          </label>
          <input value={myGrid()} onInput={e => setMyGrid(e.currentTarget.value.toUpperCase())}
            placeholder="GG54" maxLength={6}
            class={`bg-[#0d1117] border rounded px-2 py-1.5 text-sm font-mono text-[#c9d1d9] w-20 focus:outline-none focus:border-[#388bfd] ${gridErr() ? 'border-[#f85149]' : 'border-[#30363d]'}`} />
          <Show when={gridErr()}><span class="text-[#f85149] text-[10px]">Invalid grid</span></Show>
        </div>

        {/* Audio offset */}
        <div class="flex flex-col gap-1">
          <label class="text-[#8b949e] text-[10px] font-semibold tracking-wide">Audio Hz</label>
          <NumberField value={baseFreq()}
            parse={nonNegativeFreqParse}
            onCommit={setBaseFreq}
            class="bg-[#0d1117] border border-[#30363d] rounded px-2 py-1.5 text-sm font-mono text-[#c9d1d9] w-24 focus:outline-none focus:border-[#388bfd]" />
        </div>

        {/* TX gain */}
        <div class="flex flex-col gap-1">
          <label class="text-[#8b949e] text-[10px] font-semibold tracking-wide">
            TX Level
            <span class="ml-1.5 font-mono text-[#c9d1d9]">{txDb() === 0 ? '0 dB' : `${txDb()} dB`}</span>
          </label>
          <div class="flex items-center gap-2">
            <input type="range"
              min={-60} max={0} step={1}
              value={txDb()}
              onInput={e => tx.setTxGain(dbToGain(Number(e.currentTarget.value)))}
              class="w-28 accent-[#388bfd] cursor-pointer"
            />
          </div>
        </div>

        {/* Output device — sink select + OutputSelector + the I/Q-suspend
            checkbox all combined onto one row (were three stacked rows,
            taking noticeably more vertical space than the panel's other
            same-height blocks). The conditional warning paragraph is the
            one thing still allowed to wrap onto its own line below, since
            it's real text that needs room, not a compact control. */}
        <div class="flex flex-col gap-1">
          <label class="text-[#8b949e] text-[10px] font-semibold tracking-wide">Output</label>
          <div class="flex items-center gap-2 flex-wrap">
            <Show when={props.audioBridge}>
              {/* The Bridge panel's own "Send Mic to Radio" and this TX sink both
                  claim the SAME underlying bridge mic-send session (one bridge
                  connection, one useAudioBridge instance) — whichever one stops
                  first would otherwise silently kill the other's audio path.
                  Block picking "ESP32 Bridge" here while the MANUAL session
                  (not our own TX sink) already holds it, rather than letting
                  them fight over it. */}
              <select
                value={audioSinkKind()}
                onChange={(e) => setAudioSinkKind(e.currentTarget.value as AudioSinkKind)}
                disabled={audioSinkKind() === 'speaker' && micHeldByManual()}
                class="bg-[#0d1117] border border-[#30363d] rounded px-2 py-1 text-xs text-[#c9d1d9] font-mono focus:outline-none focus:border-[#388bfd] disabled:opacity-50"
              >
                <option value="speaker">Local speaker</option>
                <option value="bridge">ESP32 Bridge (radio mic-in)</option>
              </select>
            </Show>
            <div class={audioSinkKind() === 'bridge' ? 'opacity-40 pointer-events-none' : ''}>
              <OutputSelector value={tx.state().outputDeviceId} onChange={tx.setOutputDevice} supported={tx.state().sinkIdSupported} />
            </div>
            <Show when={props.iqBridge?.state().inputMode === 'iq'}>
              <label class="flex items-center gap-1.5 text-[10px] text-[#8b949e] whitespace-nowrap">
                <input
                  type="checkbox"
                  checked={suspendDuringTx()}
                  onChange={(e) => {
                    setSuspendDuringTx(e.currentTarget.checked)
                    saveSuspendIQDuringTx(e.currentTarget.checked)
                  }}
                />
                Suspend I/Q spectrum during TX
              </label>
            </Show>
          </div>
          <Show when={audioSinkKind() === 'speaker' && micHeldByManual()}>
            <p class="text-[9px] text-[#f0883e] max-w-[24rem]">
              "Send Mic to Radio" is active in the Bridge panel &mdash; stop it there first to free up the bridge's mic-send session for TX.
            </p>
          </Show>
        </div>

        {/* Start/Stop + the two auto-PTT timing fields — the parts of "TX
            Engine" that are ordinary controls, not on/off toggle chips (see
            the 2-column chip grid below, pushed to the row's far right via
            ml-auto). */}
        <div class="flex items-end gap-2 flex-wrap">
          <Show when={!isRunning()} fallback={
            <button onClick={handleStop}
              class="px-3 py-1.5 rounded text-xs font-semibold bg-[#da3633] text-white hover:bg-[#f85149] transition-colors">
              Stop TX
            </button>
          }>
            <button onClick={handleStart} disabled={!canOperate()}
              class="px-3 py-1.5 rounded text-xs font-semibold bg-[#238636] text-white hover:bg-[#2ea043] disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
              Start TX
            </button>
          </Show>
          {/* Pre-key (warm-up) delay — only meaningful with Auto-PTT */}
          <div class={`flex items-center gap-1 ${!tx.state().autoPTT ? 'opacity-40' : ''}`}
            title="Key PTT this many ms before the transmission starts, to let an external PA/relay warm up">
            <span class="text-[10px] text-[#8b949e] whitespace-nowrap">Pre-key</span>
            <NumberField value={tx.state().preKeyMs}
              onCommit={tx.setPreKeyMs}
              disabled={!tx.state().autoPTT}
              min={0} max={2000} step={10}
              class="bg-[#0d1117] border border-[#30363d] rounded px-1.5 py-1 text-xs font-mono text-[#c9d1d9] w-14 focus:outline-none focus:border-[#388bfd] disabled:cursor-not-allowed" />
            <span class="text-[10px] text-[#8b949e] whitespace-nowrap">ms</span>
          </div>
          {/* Post-key (cool-down/hang) delay — only meaningful with Auto-PTT */}
          <div class={`flex items-center gap-1 ${!tx.state().autoPTT ? 'opacity-40' : ''}`}
            title="Hold PTT this many ms after the transmission ends before unkeying, to let an external PA/relay settle">
            <span class="text-[10px] text-[#8b949e] whitespace-nowrap">Post-key</span>
            <NumberField value={tx.state().postKeyMs}
              onCommit={tx.setPostKeyMs}
              disabled={!tx.state().autoPTT}
              min={0} max={2000} step={10}
              class="bg-[#0d1117] border border-[#30363d] rounded px-1.5 py-1 text-xs font-mono text-[#c9d1d9] w-14 focus:outline-none focus:border-[#388bfd] disabled:cursor-not-allowed" />
            <span class="text-[10px] text-[#8b949e] whitespace-nowrap">ms</span>
          </div>
          {/* Auto-CQ interval — minimum minutes between unattended CQ
              transmissions. Was unlabeled and sat right after Start TX,
              far from its own Auto-CQ toggle (now in the chip grid to the
              right) — labeled and moved to the end of this row instead. */}
          <div class={`flex items-center gap-1 ${!tx.state().autoCQ ? 'opacity-40' : ''}`}
            title="Minimum time between automatic CQ transmissions">
            <span class="text-[10px] text-[#8b949e] whitespace-nowrap">Auto-CQ every</span>
            <NumberField value={tx.state().autoCQIntervalMin}
              onCommit={tx.setAutoCQIntervalMin}
              disabled={!tx.state().autoCQ}
              min={1} max={60} step={1}
              class="bg-[#0d1117] border border-[#30363d] rounded px-1.5 py-1 text-xs font-mono text-[#c9d1d9] w-12 focus:outline-none focus:border-[#388bfd] disabled:cursor-not-allowed" />
            <span class="text-[10px] text-[#8b949e] whitespace-nowrap">min</span>
          </div>
        </div>

        {/* Toggle chips — 2 columns x 2 rows, pushed to the row's far right.
            Was one long horizontal strip of 4 chips; grouping into a compact
            grid keeps the whole top row single-line instead of wrapping. */}
        <div class="grid grid-cols-2 gap-1.5 ml-auto">
          {/* Auto-CQ */}
          <div onClick={() => tx.setAutoCQ(!tx.state().autoCQ)}
            title="Automatically send CQ when the queue is empty"
            class="flex items-center gap-1.5 cursor-pointer select-none px-2 py-1 rounded border transition-colors"
            style={{
              'border-color': tx.state().autoCQ ? 'rgba(46,160,67,0.5)' : 'rgba(48,54,61,1)',
              background:  tx.state().autoCQ ? 'rgba(46,160,67,0.08)' : 'transparent',
            }}>
            <div class={`w-6 h-3 rounded-full transition-colors relative shrink-0 ${tx.state().autoCQ ? 'bg-[#238636]' : 'bg-[#30363d]'}`}>
              <div class={`absolute top-0.5 w-2 h-2 rounded-full bg-white transition-transform ${tx.state().autoCQ ? 'translate-x-3' : 'translate-x-0.5'}`} />
            </div>
            <span class="text-[10px] text-[#8b949e] whitespace-nowrap">Auto-CQ</span>
          </div>
          {/* Auto-PTT */}
          <div onClick={() => tx.setAutoPTT(!tx.state().autoPTT)}
            title={props.onSetPTT ? 'Automatically key radio PTT via CAT while transmitting' : 'Auto-PTT requires CAT connection'}
            class={`flex items-center gap-1.5 cursor-pointer select-none px-2 py-1 rounded border transition-colors ${!props.onSetPTT ? 'opacity-40' : ''}`}
            style={{
              'border-color': tx.state().autoPTT ? 'rgba(227,179,65,0.5)' : 'rgba(48,54,61,1)',
              background:  tx.state().autoPTT ? 'rgba(227,179,65,0.08)' : 'transparent',
            }}>
            <div class={`w-6 h-3 rounded-full transition-colors relative shrink-0 ${tx.state().autoPTT ? 'bg-[#e3b341]' : 'bg-[#30363d]'}`}>
              <div class={`absolute top-0.5 w-2 h-2 rounded-full bg-white transition-transform ${tx.state().autoPTT ? 'translate-x-3' : 'translate-x-0.5'}`} />
            </div>
            <span class="text-[10px] text-[#8b949e] whitespace-nowrap">Auto-PTT</span>
          </div>
          {/* Consecutive TX */}
          <div onClick={() => tx.setAllowConsecutiveTx(!tx.state().allowConsecutiveTx)}
            title={tx.state().allowConsecutiveTx
              ? 'Consecutive TX on — transmits every window (turn off for single RX/TX radios)'
              : 'Consecutive TX off — one listen window between transmissions'}
            class="flex items-center gap-1.5 cursor-pointer select-none px-2 py-1 rounded border transition-colors"
            style={{
              'border-color': tx.state().allowConsecutiveTx ? 'rgba(248,81,73,0.5)' : 'rgba(48,54,61,1)',
              background:  tx.state().allowConsecutiveTx ? 'rgba(248,81,73,0.08)' : 'transparent',
            }}>
            <div class={`w-6 h-3 rounded-full transition-colors relative shrink-0 ${tx.state().allowConsecutiveTx ? 'bg-[#f85149]' : 'bg-[#30363d]'}`}>
              <div class={`absolute top-0.5 w-2 h-2 rounded-full bg-white transition-transform ${tx.state().allowConsecutiveTx ? 'translate-x-3' : 'translate-x-0.5'}`} />
            </div>
            <span class="text-[10px] text-[#8b949e] whitespace-nowrap">Consecutive TX</span>
          </div>
          {/* Auto-Reply */}
          <div onClick={() => setAutoReply(!autoReply())}
            title={autoReply()
              ? 'Auto-Reply on — automatically enqueues a reply when someone responds to your CQ'
              : 'Auto-Reply off — manually pick replies from suggestions'}
            class="flex items-center gap-1.5 cursor-pointer select-none px-2 py-1 rounded border transition-colors"
            style={{
              'border-color': autoReply() ? 'rgba(88,166,255,0.5)' : 'rgba(48,54,61,1)',
              background:  autoReply() ? 'rgba(88,166,255,0.08)' : 'transparent',
            }}>
            <div class={`w-6 h-3 rounded-full transition-colors relative shrink-0 ${autoReply() ? 'bg-[#58a6ff]' : 'bg-[#30363d]'}`}>
              <div class={`absolute top-0.5 w-2 h-2 rounded-full bg-white transition-transform ${autoReply() ? 'translate-x-3' : 'translate-x-0.5'}`} />
            </div>
            <span class="text-[10px] text-[#8b949e] whitespace-nowrap">Auto-Reply</span>
          </div>
        </div>
      </div>
      {/* ── Active TX banner ── */}
      <Show when={isPlaying()}>
        <div class="flex items-center gap-3 bg-[#2ea043]/10 border border-[#2ea043]/40 rounded px-3 py-2">
          {/* Animated bar visualiser */}
          <div class="flex items-end gap-px h-5 shrink-0">
            <For each={Array.from({ length: 7 })}>
              {(_, i) => (
                <div class="w-1 bg-[#2ea043] rounded-sm"
                  style={{
                    animation: `txBar 0.6s ease-in-out infinite alternate`,
                    'animation-delay': `${i() * 0.08}s`,
                    'min-height': '3px',
                  }}
                />
              )}
            </For>
          </div>
          <span class="text-[#2ea043] text-xs font-mono font-bold">
            TRANSMITTING — {tx.state().queue[0]?.message ?? tx.state().sent[0]?.message ?? ''}
          </span>
          <style>{`
            @keyframes txBar {
              from { height: 3px; }
              to   { height: 20px; }
            }
          `}</style>
        </div>
      </Show>

      <Show when={props.mode === 'FT2'}>
        <div class="bg-[#e3b341]/10 border border-[#e3b341]/30 rounded p-2 text-[#e3b341] text-xs">
          FT2 encoding is not yet supported. Switch to FT8 or FT4 to transmit.
        </div>
      </Show>

      <Show when={tx.state().error}>
        <div class="bg-[#da3633]/10 border border-[#f85149]/30 rounded p-2 text-[#f85149] text-xs">
          {tx.state().error}
        </div>
      </Show>

      <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">

        {/* ── Left: suggestions + composer ── */}
        <div class="space-y-3">
          <div class="flex items-center gap-2 flex-wrap">
            <div class="text-[#8b949e] text-[10px] font-semibold uppercase tracking-wide">Suggested Messages</div>
            {/* Sort buttons */}
            <Show when={contactSugs().length > 1}>
              <div class="flex items-center gap-1 flex-wrap">
                <For each={([
                  { key: 'snr-hi', label: 'Strongest', title: 'Strongest signal first (highest SNR)' },
                  { key: 'snr-lo', label: 'Weakest',   title: 'Weakest signal first (lowest SNR)' },
                  { key: 'near',   label: 'Nearest',   title: myLatLon() ? 'Geographically closest first' : 'Nearest (set your grid first)' },
                  { key: 'far',    label: 'Farthest',  title: myLatLon() ? 'Geographically farthest first' : 'Farthest (set your grid first)' },
                ] as Array<{ key: SugSort; label: string; title: string }>)}>
                  {({ key, label, title }) => (
                    <button
                      onClick={() => setSugSort(s => s === key ? 'default' : key)}
                      title={title}
                      disabled={(key === 'near' || key === 'far') && !myLatLon()}
                      class={`text-[9px] font-mono px-1.5 py-0.5 rounded border transition-colors disabled:opacity-30 disabled:cursor-not-allowed ${
                        sugSort() === key
                          ? 'border-[#2ea043]/50 text-[#2ea043] bg-[#2ea043]/10'
                          : 'border-[#30363d] text-[#484f58] hover:text-[#8b949e]'
                      }`}
                    >
                      {label}
                    </button>
                  )}
                </For>
                {/* My conversations filter */}
                <Show when={contactSugs().some(s => s.thread.length > 0)}>
                  <button
                    onClick={() => setSugMyOnly(v => !v)}
                    title="Show only contacts that have exchanged with you"
                    class={`text-[9px] font-mono px-1.5 py-0.5 rounded border transition-colors ${
                      sugMyOnly()
                        ? 'border-[#79c0ff]/50 text-[#79c0ff] bg-[#79c0ff]/10'
                        : 'border-[#30363d] text-[#484f58] hover:text-[#8b949e]'
                    }`}
                  >
                    My QSOs
                  </button>
                </Show>
                {/* CQ-only filter */}
                <Show when={contactSugs().some(s => s.isCQ)}>
                  <button
                    onClick={() => setSugCQOnly(v => !v)}
                    title="Show only stations that are calling CQ"
                    class={`text-[9px] font-mono px-1.5 py-0.5 rounded border transition-colors ${
                      sugCQOnly()
                        ? 'border-[#2ea043]/50 text-[#2ea043] bg-[#2ea043]/10'
                        : 'border-[#30363d] text-[#484f58] hover:text-[#8b949e]'
                    }`}
                  >
                    CQ only
                  </button>
                </Show>
                {/* VFO passband filter — same rule as the map's VFO-only pins */}
                <Show when={(props.vfoFrequency ?? 0) > 0}>
                  <button
                    onClick={() => setSugVfoOnly(v => !v)}
                    title="Show only stations whose last-heard frequency falls inside the current VFO passband"
                    class={`text-[9px] font-mono px-1.5 py-0.5 rounded border transition-colors ${
                      sugVfoOnly()
                        ? 'border-[#79c0ff]/50 text-[#79c0ff] bg-[#79c0ff]/10'
                        : 'border-[#30363d] text-[#484f58] hover:text-[#8b949e]'
                    }`}
                  >
                    VFO only
                  </button>
                </Show>
                {/* Recent-activity filter */}
                <button
                  onClick={() => setSugLatestOnly(v => !v)}
                  title="Show only stations heard in the last 5 minutes"
                  class={`text-[9px] font-mono px-1.5 py-0.5 rounded border transition-colors ${
                    sugLatestOnly()
                      ? 'border-[#d2a8ff]/50 text-[#d2a8ff] bg-[#d2a8ff]/10'
                      : 'border-[#30363d] text-[#484f58] hover:text-[#8b949e]'
                  }`}
                >
                  Latest
                </button>
                {/* Special/compound callsign filter */}
                <Show when={contactSugs().some(s => s.callsign && classifyCallsign(s.callsign).kind !== 'standard')}>
                  <button
                    onClick={() => setSugSpecialOnly(v => !v)}
                    title="Show only compound/special-event callsigns (nonstandard encoding)"
                    class={`text-[9px] font-mono px-1.5 py-0.5 rounded border transition-colors ${
                      sugSpecialOnly()
                        ? 'border-[#f0883e]/50 text-[#f0883e] bg-[#f0883e]/10'
                        : 'border-[#30363d] text-[#484f58] hover:text-[#8b949e]'
                    }`}
                  >
                    ✨ special
                  </button>
                </Show>
                {/* Fox/Hound (DXpedition) mode — compresses the reply sequence */}
                <button
                  onClick={() => setFoxHound(v => !v)}
                  title={foxHound()
                    ? 'Fox/Hound mode on — call-in jumps straight to RR73 once Fox reports you (Fox never round-trips an R+report ack)'
                    : 'Fox/Hound mode off — normal QSO sequence (report → R+report → RR73)'}
                  class={`text-[9px] font-mono px-1.5 py-0.5 rounded border transition-colors ${
                    foxHound()
                      ? 'border-[#3fb950]/50 text-[#3fb950] bg-[#3fb950]/10'
                      : 'border-[#30363d] text-[#484f58] hover:text-[#8b949e]'
                  }`}
                >
                  🦊 F/H
                </button>
                {/* Country select */}
                <Show when={sugCountryOptions().length > 1}>
                  <select
                    value={sugCountryFilter()}
                    onChange={e => setSugCountryFilter(e.currentTarget.value)}
                    title="Filter suggestions by country"
                    class={`text-[9px] font-mono px-1 py-0.5 rounded border bg-[#0d1117] transition-colors cursor-pointer ${
                      sugCountryFilter()
                        ? 'border-[#e3b341]/50 text-[#e3b341]'
                        : 'border-[#30363d] text-[#484f58]'
                    }`}
                  >
                    <option value="">🌍 All</option>
                    <For each={sugCountryOptions()}>
                      {({ code, country, flag, count }) => (
                        <option value={code}>{flag} {country} ({count})</option>
                      )}
                    </For>
                  </select>
                </Show>
                <Show when={sugSort() !== 'default' || sugCountryFilter() || sugMyOnly() || sugCQOnly() || sugVfoOnly() || sugLatestOnly() || sugSpecialOnly()}>
                  <button
                    onClick={() => {
                      setSugSort('default'); setSugCountryFilter(''); setSugMyOnly(false); setSugCQOnly(false)
                      setSugVfoOnly(false); setSugLatestOnly(false); setSugSpecialOnly(false)
                    }}
                    class="text-[9px] font-mono px-1 py-0.5 rounded border border-[#30363d] text-[#484f58] hover:text-[#8b949e]"
                    title="Reset sort and filters"
                  >
                    ✕
                  </button>
                </Show>
              </div>
            </Show>
          </div>

          <div class="space-y-2">
            <For each={suggestions()}>
              {(sug) => {
                // Hashed (compound/special-call) conversations get a dashed
                // amber border — these exchange with <bracket> messages and
                // carry no grid, so they read differently on air.
                const isHashed = !!sug.callsign && needsHashedExchange(sug.callsign)
                const borderColor = sug.repliedToMe ? (sug.color ?? '#f0e68c') : isHashed ? 'rgba(240,136,62,0.55)' : '#30363d'
                const hoverBorder = sug.repliedToMe ? (sug.color ?? '#f0e68c') : isHashed ? '#f0883e' : '#388bfd'
                let wrapEl: HTMLDivElement | undefined
                return (
                  <div ref={wrapEl}
                    class="rounded overflow-hidden"
                    style={{ border: `1px ${isHashed ? 'dashed' : 'solid'} ${borderColor}` }}>
                    {/* Thread — only shown when there's exchange history */}
                    <Show when={sug.thread.length > 0}>
                      <div class="bg-[#0d1117] px-3 pt-2 pb-1 space-y-0.5 border-b" style={{ 'border-color': borderColor }}>
                        <For each={sug.thread}>
                          {(step) => (
                            <div class={`flex gap-2 items-baseline text-[11px] font-mono ${step.mine ? 'justify-end' : 'justify-start'}`}>
                              <span class="text-[#484f58] text-[10px] shrink-0 tabular-nums">
                                {step.time.toLocaleTimeString(undefined, { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                              </span>
                              <Show when={!step.mine}>
                                <span class="text-[10px] shrink-0" style={{ color: sug.color }}>
                                  {sug.callsign}
                                </span>
                              </Show>
                              <span class={`px-1.5 py-0.5 rounded text-[11px] ${step.mine ? 'bg-[#238636]/20 text-[#7ee787]' : 'bg-[#388bfd]/10 text-[#79c0ff]'}`}>
                                {step.raw}
                              </span>
                              <Show when={step.mine}><span class="text-[10px] text-[#8b949e] shrink-0">me</span></Show>
                              <Show when={!step.mine && step.snr !== undefined}>
                                <span class="text-[10px] shrink-0" style={{ color: step.snr! >= -5 ? '#2ea043' : step.snr! >= -15 ? '#e3b341' : '#8b949e' }}>
                                  {step.snr! > 0 ? '+' : ''}{step.snr!.toFixed(1)}dB
                                </span>
                              </Show>
                            </div>
                          )}
                        </For>
                      </div>
                    </Show>
                    {/* Action button */}
                    <button
                      onClick={() => addSuggestion(sug)}
                      disabled={!canOperate() || !isRunning()}
                      title={!isRunning() ? 'Start TX engine first' : undefined}
                      class="w-full text-left bg-[#0d1117] hover:bg-[#161b22] disabled:opacity-40 disabled:cursor-not-allowed px-3 py-2 transition-colors group"
                      onMouseEnter={() => { if (wrapEl) wrapEl.style.borderColor = hoverBorder }}
                      onMouseLeave={() => { if (wrapEl) wrapEl.style.borderColor = borderColor }}
                    >
                      <div class="flex items-center justify-between gap-2">
                        <div class="flex items-center gap-1.5 shrink-0">
                          <Show when={sug.repliedToMe}>
                            <span class="text-[10px]" title="They replied to you" style={{ color: sug.color }}>▶</span>
                          </Show>
                          <span class="text-[#8b949e] text-[10px] font-semibold uppercase">{sug.label}</span>
                          <Show when={sug.qsyHz !== undefined}>
                            <span
                              class="text-[9px] font-mono px-1 py-px rounded border border-[#e3b341]/40 bg-[#e3b341]/10 text-[#e3b341]"
                              title={`They asked to be answered at ${sug.qsyHz} Hz — this conversation's messages transmit there; your Audio Hz setting stays put (rig untouched)`}
                            >
                              QSY {sug.qsyHz}Hz
                            </span>
                          </Show>
                          <Show when={(() => {
                            const cs = sug.callsign?.toUpperCase()
                            return sug.qsyHz === undefined && cs !== undefined && convAudioHz.has(cs)
                          })()}>
                            <span
                              class="text-[9px] font-mono px-1 py-px rounded border border-[#e3b341]/30 bg-[#e3b341]/5 text-[#e3b341]/80"
                              title="This conversation is pinned to the frequency they QSY'd to"
                            >
                              @{convAudioHz.get(sug.callsign!.toUpperCase())}Hz
                            </span>
                          </Show>
                          <Show when={sug.callsign}>
                            <span class="flex items-center gap-1 text-[10px] font-mono font-bold" style={{ color: sug.color }}>
                              {(() => {
                                const info = callsignCountry(sug.callsign!)
                                return info?.flag ? (
                                  <span class="text-sm leading-none" title={info.country}>{info.flag}</span>
                                ) : null
                              })()}
                              {sug.callsign}
                            </span>
                          </Show>
                        </div>
                        <span class="font-mono text-xs text-[#c9d1d9] group-hover:text-white truncate">
                          <SugMsgText message={sug.message} myCall={myCall()} contactColor={sug.color} />
                        </span>
                      </div>
                    </button>
                  </div>
                )
              }}
            </For>
          </div>

          {/* Custom message */}
          <div class="border-t border-[#21262d] pt-3 space-y-2">
            <div class="text-[#8b949e] text-[10px] font-semibold uppercase tracking-wide">Custom Message</div>
            <div class="flex gap-2">
              <input value={editMsg()} onInput={e => { setEditMsg(e.currentTarget.value.toUpperCase()); setCustomErr('') }}
                onKeyDown={e => e.key === 'Enter' && addCustom()}
                placeholder="CQ PU7FWT GG54" maxLength={40}
                class="flex-1 bg-[#0d1117] border border-[#30363d] rounded px-2 py-1.5 text-xs font-mono text-[#c9d1d9] focus:outline-none focus:border-[#388bfd]" />
              <input value={editLabel()} onInput={e => setEditLabel(e.currentTarget.value)}
                placeholder="Label (opt)"
                class="w-28 bg-[#0d1117] border border-[#30363d] rounded px-2 py-1.5 text-xs text-[#c9d1d9] focus:outline-none focus:border-[#388bfd]" />
              <button onClick={addCustom}
                disabled={!editMsg().trim() || !canOperate() || !isRunning()}
                class="px-3 py-1.5 text-xs font-semibold bg-[#21262d] border border-[#30363d] hover:border-[#388bfd] text-[#c9d1d9] rounded disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
                Queue
              </button>
            </div>
            <Show when={customErr()}>
              <p class="text-[#f85149] text-[10px]">{customErr()}</p>
            </Show>
            <p class="text-[#484f58] text-[10px]">
              Standard FT8/FT4 forms, any length · free text ≤ 13 chars · compound calls use {'<'}brackets{'>'}: {'<'}YS3/PY8WW{'>'} PU7FTW
            </p>
          </div>
        </div>

        {/* ── Right: queue + sent log ── */}
        <div class="space-y-3">
          {/* Bridge TX slot pool — only meaningful once the bridge is
              actually the TX output; see useFTTransmit.ts's
              BridgeSlotInfo/uploadIfBridgeSink() comments for why this is
              browser-tracked (the firmware itself has no concept of
              message text, only raw PCM + a hash). Shows what's actually
              staged in each of the ESP32's 4 PSRAM slots so an operator
              can see (and clear) what would play if that slot were
              triggered, without having to trust it's still accurate. */}
          <Show when={audioSinkKind() === 'bridge'}>
            <div class="rounded border border-[#21262d] bg-[#0d1117] p-2">
              <div class="text-[#8b949e] text-[10px] font-semibold uppercase tracking-wide mb-1.5">
                Bridge TX Slots
              </div>
              <div class="space-y-1">
                <For each={tx.state().bridgeSlots}>
                  {(slot) => (
                    <div class={`flex items-center gap-2 rounded px-1.5 py-1 border ${
                      slot.uploaded ? 'border-[#30363d]' : 'border-[#21262d] opacity-50'
                    }`}>
                      <span class="text-[9px] font-mono text-[#484f58] w-3 shrink-0">{slot.slot}</span>
                      <div class="flex-1 min-w-0">
                        <div class="font-mono text-[10px] text-[#c9d1d9] truncate">
                          {slot.uploaded ? slot.message : '— empty —'}
                        </div>
                        <Show when={slot.uploaded}>
                          <div class="text-[#484f58] text-[9px] truncate">{slot.label}</div>
                        </Show>
                      </div>
                      <Show when={slot.uploaded}>
                        <button onClick={() => void tx.clearBridgeSlot(slot.slot)}
                          class="text-[#484f58] hover:text-[#f85149] text-xs px-1 shrink-0" title="Remove from bridge">✕</button>
                      </Show>
                    </div>
                  )}
                </For>
              </div>
            </div>
          </Show>

          <div class="text-[#8b949e] text-[10px] font-semibold uppercase tracking-wide flex items-center justify-between">
            <span>TX Queue</span>
            <span class="text-[#484f58]">{tx.state().queue.length} pending</span>
          </div>

          {/* Auto-CQ virtual entry — always shown at top when active, separate from queue state */}
          <Show when={tx.state().autoCQ}>
            <div class="flex items-center gap-2 rounded px-2 py-1.5 border border-[#238636]/40 bg-[#238636]/5">
              <span class="text-[10px] font-mono w-5 shrink-0 flex items-center justify-center">
                <Show when={isPlaying() && tx.state().queue.length === 0} fallback={<span class="text-[#238636]">∞</span>}>
                  <span class="text-[#2ea043]">📡</span>
                </Show>
              </span>
              <div class="flex-1 min-w-0">
                <div class="font-mono text-xs text-[#c9d1d9] truncate">{buildFTMessage('cq', myCall().toUpperCase(), '', undefined, myGrid().toUpperCase())}</div>
                <div class="text-[#484f58] text-[10px]">Auto-CQ · every {tx.state().autoCQIntervalMin} min</div>
              </div>
              <button onClick={() => tx.setAutoCQ(false)}
                class="text-[#484f58] hover:text-[#f85149] text-xs px-1 shrink-0" title="Disable Auto-CQ">✕</button>
            </div>
          </Show>

          <Show when={tx.state().queue.length > 0} fallback={
            <Show when={!tx.state().autoCQ}>
              <div class="text-[#484f58] text-xs font-mono py-3 text-center border border-dashed border-[#21262d] rounded">
                No messages queued
              </div>
            </Show>
          }>
            <div class="space-y-1">
              <For each={tx.state().queue}>
                {(entry, idx) => {
                  // nextTxAtMs is the loop's own confirmed next-TX boundary for
                  // the head-of-queue entry — it's null whenever the upcoming
                  // window's skip/send decision has already been made as "skip"
                  // (forced listen window, or the queue was empty when that
                  // decision was made). Falling back to secToWindow() in that
                  // case would count down to a boundary nothing will actually
                  // send on, hit zero, and then restart a full window later —
                  // this instead keeps counting through to the REAL next
                  // opportunity once the loop reports one.
                  const baseEtaSec = createMemo(() => {
                    const tick = secToWindow() // tracked dependency: re-evaluate Date.now() every countdown tick
                    const at = tx.state().nextTxAtMs
                    return at !== null ? Math.max(0, (at - Date.now()) / 1000) : tick + windowSec()
                  })
                  const etaSec = createMemo(() => idx() === 0
                    ? (isPlaying() ? 0 : baseEtaSec())
                    : baseEtaSec() + idx() * windowSec())
                  const etaLabel = createMemo(() => isPlaying() && idx() === 0 ? 'TX' : `${etaSec().toFixed(2)}s`)
                  const isPending = () => entry.encodeStatus === 'pending'
                  const isError   = () => entry.encodeStatus === 'error'
                  return (
                    <div
                      class={`flex items-center gap-2 rounded px-2 py-1.5 border ${
                        idx() === 0 && isPlaying()
                          ? 'border-[#2ea043]/60 bg-[#2ea043]/5'
                          : idx() === 0
                            ? 'border-[#388bfd]/50 bg-[#388bfd]/5'
                            : 'border-[#21262d] bg-[#0d1117]'
                      }`}>
                      {/* Status icon */}
                      <span class="text-[10px] font-mono w-5 shrink-0 flex items-center justify-center">
                        {idx() === 0 && isPlaying() ? (
                          <span class="text-[#2ea043]">📡</span>
                        ) : isPending() ? (
                          <svg class="animate-spin w-3 h-3 text-[#e3b341]" viewBox="0 0 24 24" fill="none">
                            <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="3" stroke-dasharray="31.4 31.4" stroke-linecap="round" />
                          </svg>
                        ) : isError() ? (
                          <span class="text-[#f85149]">!</span>
                        ) : idx() === 0 ? (
                          <span class="text-[#388bfd]">▶</span>
                        ) : (
                          <span class="text-[#484f58]">{idx() + 1}</span>
                        )}
                      </span>
                      <div class="flex-1 min-w-0">
                        <div class="font-mono text-xs text-[#c9d1d9] truncate">{entry.message}</div>
                        <div class="text-[#484f58] text-[10px] truncate">
                          {isError() ? <span class="text-[#f85149]">{entry.encodeError}</span> : entry.label}
                          <Show when={entry.audioHz !== undefined}>
                            <span class="ml-1 text-[#e3b341]" title="Pinned TX frequency for this conversation (QSY) — global Audio Hz unaffected">
                              @{entry.audioHz}Hz
                            </span>
                          </Show>
                        </div>
                      </div>
                      <div class="flex items-center gap-1.5 shrink-0">
                        <span class={`text-[10px] font-mono tabular-nums font-semibold ${
                          isPlaying() && idx() === 0 ? 'text-[#2ea043]' : 'text-white'
                        }`}>{etaLabel()}</span>
                        <Show when={idx() > 0}>
                          <button onClick={() => tx.moveUp(entry.id)}
                            class="text-[#484f58] hover:text-[#c9d1d9] text-xs px-1" title="Move up">↑</button>
                        </Show>
                        <button onClick={() => tx.dequeue(entry.id)}
                          class="text-[#484f58] hover:text-[#f85149] text-xs px-1" title="Remove">✕</button>
                      </div>
                    </div>
                  )
                }}
              </For>
            </div>
          </Show>

          {/* Sent log — newest first, no enclosing box */}
          <Show when={tx.state().sent.length > 0}>
            <div class="mt-2 pt-2 border-t border-[#21262d]">
              <div class="text-[#8b949e] text-[10px] font-semibold uppercase tracking-wide mb-1 flex items-center justify-between">
                <span>Sent Log</span>
                <span class="text-[#484f58] normal-case">{tx.state().sent.length}</span>
              </div>
              <div class="space-y-px">
                <For each={tx.state().sent}>
                  {(entry) => {
                    const absFreq = entry.vfoHz > 0 ? entry.vfoHz + entry.audioHz : 0
                    const parsed  = parseFTMsg(entry.message)
                    const typeColor = MSG_TYPE_COLOR[parsed.type]
                    const typeLabel = MSG_TYPE_LABEL[parsed.type]
                    return (
                      <div class="flex items-center gap-1.5 text-[11px] font-mono py-0.5">
                        <span class="shrink-0 text-[10px] text-[#484f58] tabular-nums w-[56px]">
                          {entry.windowStart.toLocaleTimeString(undefined, { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                        </span>
                        <span
                          class="shrink-0 px-1 py-px rounded text-[8px] font-bold w-[36px] text-center"
                          style={{ background: `${typeColor}1a`, color: typeColor }}
                        >
                          {typeLabel}
                        </span>
                        <span class={`truncate flex-1 ${entry.error ? 'text-[#f85149]' : 'text-[#c9d1d9]'}`}>
                          {entry.message}
                        </span>
                        <span class="shrink-0 text-[10px] text-[#484f58]">
                          {absFreq > 0 ? fmtAbsHz(absFreq) : `${entry.audioHz} Hz`}
                        </span>
                        <Show when={entry.error}>
                          <span class="shrink-0 text-[10px] text-[#f85149]" title={entry.error}>⚠</span>
                        </Show>
                        <button
                          onClick={() => tx.enqueue({ id: uid(), message: entry.message, label: entry.label })}
                          class="shrink-0 text-[#484f58] hover:text-[#58a6ff] p-0.5"
                          title="Requeue — resend this message"
                        >
                          <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M3 12a9 9 0 0 1 15.3-6.4L21 8" />
                            <path d="M21 3v5h-5" />
                            <path d="M21 12a9 9 0 0 1-15.3 6.4L3 16" />
                            <path d="M3 21v-5h5" />
                          </svg>
                        </button>
                      </div>
                    )
                  }}
                </For>
              </div>
            </div>
          </Show>
        </div>
      </div>
    </div>
  )
}
