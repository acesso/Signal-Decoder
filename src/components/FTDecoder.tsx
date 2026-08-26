// Port of src/components/FTDecoder.tsx (Next.js app).
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show, type JSX } from 'solid-js'
import type { DecoderControls } from '../lib/decoderControls'
import { fmtAbsHz } from '$decoder-lib/formatFreq'
import SignalAnalysisPanel from './SignalAnalysisPanel'
import { createFTProcessor } from '../lib/ft/processor'
import { type FTMode, type FTMessage, FT_WINDOW_SECONDS } from '$decoder-lib/ft/decoder'
import {
  type Contact,
  mergeContacts,
  parseFTMsgCached,
  parseADIF,
  gridToLatLon,
  CONTACT_PALETTE,
  type MergeStats,
  type QSORecord,
  extractQSORecords,
} from '$decoder-lib/ft/parser'
import { qsoLogUpsert, qsoLogClear } from '$decoder-lib/ft/qsoLog'
import { DecodeGate } from '$decoder-lib/ft/gate'
import FTContactsPanel from './FTContactsPanel'
import FTWasmPanel from './FTWasmPanel'
import VirtualList from './VirtualList'
import { loadNumberArray, saveNumberArray, loadBoolean, saveBoolean } from '$decoder-lib/storage'
import type { AudioBridge } from '$decoder-lib/cat/useAudioBridge'
import type { IQBridge } from '$decoder-lib/cat/useIQBridge'
import type { AudioSourceKind } from '$decoder-lib/audio/audioSource'

const DEFAULT_PANEL_WEIGHTS = [0.8, 0.6, 1.2]
const LS_PANEL_WEIGHTS = 'ft_panel_weights'
const LS_MSG_SORT_KEY = 'ft_messages_sort_key'
const LS_MSG_SORT_REV = 'ft_messages_sort_rev'
const MSG_SORT_COLS = ['freq', 'snr', 'dt', 'msg'] as const

// ── Clock ring (rAF-driven, no signal writes) ────────────────────────────

function ClockRing(props: { status: string; windowSec: number }) {
  const r = 28,
    cx = 36,
    cy = 36
  const circ = 2 * Math.PI * r

  let svgEl: SVGSVGElement | undefined
  let rafId: number | null = null
  let prevSecVal = ''

  onMount(() => {
    const tick = () => {
      const svg = svgEl
      if (!svg) {
        rafId = requestAnimationFrame(tick)
        return
      }

      const totalMs = props.windowSec * 1000
      const now = new Date()
      const elapsed = (now.getSeconds() * 1000 + now.getMilliseconds()) % totalMs
      const progress = elapsed / totalMs
      const nextMs = totalMs - elapsed
      const secVal = (nextMs / 1000).toFixed(1)

      if (secVal === prevSecVal) {
        rafId = requestAnimationFrame(tick)
        return
      }
      prevSecVal = secVal

      const arcColor = props.status === 'recording' ? '#2ea043' : props.status === 'decoding' ? '#e3b341' : '#30363d'
      const lblColor = props.status === 'recording' ? '#2ea043' : props.status === 'decoding' ? '#e3b341' : '#484f58'
      const label = props.status === 'decoding' ? 'DEC' : props.status === 'recording' ? 'REC' : 'WAIT'
      const filled = circ * progress

      svg.querySelector<SVGCircleElement>('.ft-arc')?.setAttribute('stroke', arcColor)
      svg.querySelector<SVGCircleElement>('.ft-arc')?.setAttribute('stroke-dasharray', `${filled} ${circ - filled}`)
      const txt = svg.querySelector<SVGTextElement>('.ft-sec')
      if (txt) txt.textContent = props.status === 'idle' ? '--' : secVal
      const lbl = svg.querySelector<SVGTextElement>('.ft-lbl')
      if (lbl) {
        lbl.setAttribute('fill', lblColor)
        lbl.textContent = label
      }

      rafId = requestAnimationFrame(tick)
    }
    rafId = requestAnimationFrame(tick)
    onCleanup(() => {
      if (rafId) cancelAnimationFrame(rafId)
    })
  })

  const arcColor = () => (props.status === 'recording' ? '#2ea043' : props.status === 'decoding' ? '#e3b341' : '#30363d')
  const lblColor = () => (props.status === 'recording' ? '#2ea043' : props.status === 'decoding' ? '#e3b341' : '#484f58')
  const label = () => (props.status === 'decoding' ? 'DEC' : props.status === 'recording' ? 'REC' : 'WAIT')

  return (
    <svg ref={svgEl} width={72} height={72} viewBox="0 0 72 72" class="shrink-0">
      <circle cx={cx} cy={cy} r={r} fill="none" stroke="#21262d" stroke-width={5} />
      <circle
        class="ft-arc"
        cx={cx}
        cy={cy}
        r={r}
        fill="none"
        stroke={arcColor()}
        stroke-width={5}
        stroke-dasharray={`0 ${circ}`}
        stroke-dashoffset={circ * 0.25}
      />
      <text class="ft-lbl" x={cx} y={cy - 4} text-anchor="middle" font-size="7.5" fill={lblColor()} font-family="monospace" font-weight="bold">
        {label()}
      </text>
      <text x={cx} y={cy + 7} text-anchor="middle" font-size="11" fill="#c9d1d9" font-family="monospace" font-weight="bold">
        <tspan class="ft-sec">{props.status === 'idle' ? '--' : '0.0'}</tspan>
      </text>
      <text x={cx} y={cy + 16} text-anchor="middle" font-size="7" fill="#484f58" font-family="monospace">
        {props.status !== 'idle' ? `/${props.windowSec}s` : ''}
      </text>
    </svg>
  )
}

// ── FT sub-mode selector (exported for App.tsx) ──────────────────────────

const FT_MODES: FTMode[] = ['FT8', 'FT4', 'FT2']

export function FTModeSelector(props: { mode: FTMode; onChange: (m: FTMode) => void }) {
  return (
    <div class="flex items-center gap-1 rounded-lg border border-[#30363d] bg-[#0d1117] p-1">
      <For each={FT_MODES}>
        {(m) => (
          <button
            onClick={() => m !== 'FT2' && props.onChange(m)}
            title={m === 'FT2' ? 'FT2 is experimental — no decoder available yet' : undefined}
            class={`rounded-md px-3 py-1 text-xs font-semibold transition-colors ${
              props.mode === m
                ? m === 'FT2'
                  ? 'bg-[#30363d] text-[#8b949e]'
                  : 'bg-[#238636] text-white'
                : m === 'FT2'
                  ? 'cursor-default text-[#484f58]'
                  : 'text-[#8b949e] hover:text-[#c9d1d9]'
            }`}
          >
            {m}
            {m === 'FT2' && <span class="ml-1 text-[9px] text-[#30363d]">beta</span>}
          </button>
        )}
      </For>
    </div>
  )
}

// ── Helpers ────────────────────────────────────────────────────────────────

function msgColor(msg: string, snr: number): string {
  if (msg.startsWith('CQ ') || msg.startsWith('CQ\t')) return '#2ea043'
  if (snr <= -20) return '#484f58'
  return '#c9d1d9'
}

function snrColor(db: number): string {
  return db >= -5 ? '#2ea043' : db >= -15 ? '#e3b341' : '#8b949e'
}
function dtColor(dt: number): string {
  const a = Math.abs(dt)
  return a <= 0.2 ? '#2ea043' : a <= 0.5 ? '#e3b341' : '#f85149'
}

function localHMS(d: Date): string {
  return d.toLocaleTimeString(undefined, { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
}
function formatFreq(hz: number, vfoHz = 0): string {
  if (vfoHz > 0) return fmtAbsHz(vfoHz + hz)
  return hz.toFixed(0).padStart(4, ' ')
}
function formatDT(dt: number): string {
  return (dt >= 0 ? '+' : '') + dt.toFixed(1)
}

const RPT_TOKEN = /^R?[+-][0-9]{1,2}$/

export type MsgRowData = {
  kind: 'msg'
  absFreq: string
  dt: number
  snr: number
  msg: string
  time: Date
  addressedToMe: boolean
  osd: boolean
  colorSig: string
  key: string
}

export const MSG_ROW_H = 24
export const SEP_ROW_H = 22
const CONTACTS_PUBLISH_MS = 800
const MSG_GRID_COLS = 'grid grid-cols-[78px_92px_54px_46px_minmax(0,1fr)]'

type MsgSortCol = 'freq' | 'snr' | 'dt' | 'msg'

function loadMsgSortKey(): MsgSortCol | null {
  if (typeof window === 'undefined') return null
  const raw = localStorage.getItem(LS_MSG_SORT_KEY)
  return (MSG_SORT_COLS as readonly string[]).includes(raw ?? '') ? (raw as MsgSortCol) : null
}

function SortableHeader(props: {
  label: string
  col: MsgSortCol
  sortKey: MsgSortCol | null
  sortRev: boolean
  onSort: (col: MsgSortCol) => void
  align: 'left' | 'right'
  title?: string
}) {
  const active = () => props.sortKey === props.col
  return (
    <button
      onClick={() => props.onSort(props.col)}
      title={props.title ?? (active() ? `Sort by ${props.label} — click to ${props.sortRev ? 'clear' : 'reverse'}` : `Sort by ${props.label}`)}
      class={`flex items-center gap-0.5 px-2 py-1.5 transition-colors hover:text-[#c9d1d9] ${
        props.align === 'right' ? 'justify-end' : 'justify-start'
      } ${active() ? 'text-[#2ea043]' : ''}`}
    >
      {props.label}
      {active() && <span class="text-[9px]">{props.sortRev ? '↑' : '↓'}</span>}
    </button>
  )
}

function MessageRow(props: { row: MsgRowData; timeStr: string; myCall: string; getContact: (cs: string) => Contact | undefined; onSelect: (cs: string) => void }) {
  return (
    <div
      class={`${MSG_GRID_COLS} h-full items-center border-b border-[#21262d]/50 transition-colors ${
        props.row.addressedToMe ? 'bg-[#f0e68c]/5 hover:bg-[#f0e68c]/10' : 'hover:bg-[#21262d]/40'
      }`}
    >
      <div class="px-2 whitespace-nowrap" style={{ color: props.row.addressedToMe ? '#f0e68c' : '#484f58' }}>
        {props.row.addressedToMe && <span class="mr-1 text-[10px]">▶</span>}
        {props.timeStr}
      </div>
      <div class="px-2 text-right whitespace-nowrap text-[#8b949e]">{props.row.absFreq}</div>
      <div class="px-2 text-right whitespace-nowrap" style={{ color: snrColor(props.row.snr) }}>
        {props.row.snr > 0 ? '+' : ''}
        {props.row.snr.toFixed(1)}
      </div>
      <div class="px-2 text-right whitespace-nowrap" style={{ color: dtColor(props.row.dt) }}>
        {formatDT(props.row.dt)}
      </div>
      <div class="truncate px-2" style={{ color: msgColor(props.row.msg, props.row.snr) }}>
        {props.row.osd && (
          <span
            class="mr-1 align-middle text-[9px] text-[#e3b341]/70"
            title="OSD decode — LDPC didn't converge cleanly; this 'best guess' is prone to false positives"
          >
            osd
          </span>
        )}
        <MsgTextStable msg={props.row.msg} myCall={props.myCall} getContact={props.getContact} onSelect={props.onSelect} />
      </div>
    </div>
  )
}

function MsgTextStable(props: { msg: string; myCall: string; getContact: (cs: string) => Contact | undefined; onSelect: (cs: string) => void }) {
  return (
    <For each={props.msg.trim().split(/\s+/)}>
      {(w, i) => {
        const sep = i() > 0 ? ' ' : ''
        const isMe = props.myCall && w.toUpperCase() === props.myCall.toUpperCase()
        if (isMe) {
          return (
            <>
              {sep}
              <span class="rounded px-0.5 font-bold" style={{ color: '#f0e68c', background: 'rgba(240,230,140,0.12)' }}>
                {w}
              </span>
            </>
          )
        }
        const c = props.getContact(w)
        if (c) {
          return (
            <>
              {sep}
              <button onClick={() => props.onSelect(w)} class="font-bold hover:underline" style={{ color: c.color }} title={`Show ${w} in Contacts`}>
                {w}
              </button>
            </>
          )
        }
        if (RPT_TOKEN.test(w)) {
          return (
            <>
              {sep}
              <span style={{ color: snrColor(parseInt(w.replace(/^R/, ''), 10)) }}>{w}</span>
            </>
          )
        }
        return (
          <>
            {sep}
            {w}
          </>
        )
      }}
    </For>
  )
}

// ── Main component ──────────────────────────────────────────────────────────

interface Props {
  ftMode: FTMode
  myCall?: string
  myGrid?: string
  onContactsChange?: (c: Map<string, Contact>) => void
  txAudioHz?: number
  onTxAudioHzChange?: (hz: number) => void
  analyser?: AnalyserNode | null
  vfoFrequency?: number
  onStateChange?: (controls: DecoderControls) => void
  handle?: { current: DecoderControls | null }
  audioBridge?: AudioBridge
  iqBridge?: IQBridge
}

export default function FTDecoder(props: Props): JSX.Element {
  // Where decode input comes from — the ESP32 bridge's live radio audio
  // whenever it's actually connected (matches globalAudio's own
  // auto-detection in App.tsx's handleStart(), so both agree without a
  // separate manual selector), falling back to the local mic otherwise.
  // Checks iqBridge FIRST: while the bridge is in "iq" input mode,
  // audioBridge is never connected (see App.tsx's handleStart()) and
  // wouldn't report playbackActive even though the bridge is very much
  // live — iqBridge's own connected+getPlaybackSource() (demodulated
  // client-side, see useIQBridge.ts's header comment) is the actual
  // source of truth in that mode.
  const audioSourceKind = (): AudioSourceKind =>
    props.iqBridge?.state().connected ? 'bridge' : props.audioBridge?.state().playbackActive ? 'bridge' : 'microphone'
  const getBridge = () => (props.iqBridge?.state().connected ? props.iqBridge : props.audioBridge)
  const processor = createFTProcessor(() => props.ftMode, audioSourceKind, getBridge)

  createEffect((prevMode: FTMode | undefined) => {
    const mode = props.ftMode
    if (prevMode !== undefined && prevMode !== mode) processor.restartForModeChange()
    return mode
  }, undefined as FTMode | undefined)

  onCleanup(() => processor.destroy())

  // ── Contact tracking ──────────────────────────────────────────────────
  const [contacts, setContacts] = createSignal<Map<string, Contact>>(new Map())
  const [contactFocus, setContactFocus] = createSignal<{ cs: string; n: number } | null>(null)

  // Message-table column sort: applied WITHIN each decode window only — a
  // window's messages are re-ordered among themselves, but windows never mix,
  // so a freshly-decoded window always lands in its own natural (newest-first)
  // slot rather than jumping around the list. null = natural decode order.
  const [sortKey, setSortKey] = createSignal<MsgSortCol | null>(loadMsgSortKey())
  const [sortRev, setSortRev] = createSignal(loadBoolean(LS_MSG_SORT_REV, false))
  createEffect(() => {
    if (typeof window !== 'undefined') localStorage.setItem(LS_MSG_SORT_KEY, sortKey() ?? '')
  })
  createEffect(() => saveBoolean(LS_MSG_SORT_REV, sortRev()))
  function toggleSort(key: MsgSortCol) {
    setSortKey((prev) => {
      if (prev !== key) {
        setSortRev(false)
        return key
      }
      if (!sortRev()) {
        setSortRev(true)
        return key
      }
      setSortRev(false)
      return null
    })
  }
  function selectContact(cs: string) {
    setContactFocus((prev) => ({ cs, n: (prev?.n ?? 0) + 1 }))
  }

  // Free-text filter over the decoded message table — matches the raw
  // decoded text (callsigns, grids, reports), not persisted across reloads.
  const [msgQuery, setMsgQuery] = createSignal('')

  let prevResultLen = 0
  // Always-current VFO — readable synchronously without stale closure.
  let vfoVal = props.vfoFrequency ?? 0
  createEffect(() => {
    vfoVal = props.vfoFrequency ?? 0
  })

  // Stable contact accessor for message rows: reads through a plain mutable
  // holder so the function identity never changes while always seeing the
  // latest contacts (no equivalent memoization concern in Solid — kept for
  // parity with the original's rationale, still avoids an extra Map lookup
  // indirection at each render).
  let contactsSnapshot = contacts()
  createEffect(() => {
    contactsSnapshot = contacts()
  })
  const getContactStable = (cs: string) => contactsSnapshot.get(cs)

  // ── UTC clock skew check ────────────────────────────────────────────────
  // Fetch once against Cloudflare's edge trace endpoint (plain text `ts=<unix
  // seconds>`, CORS-open via `Access-Control-Allow-Origin: *`, and backed by
  // Cloudflare's own network — far more reliable than dedicated "time API"
  // services, which have a history of outages/CORS resets). Warn if local
  // clock is off by >1s, since FT8/4 timing is UTC-slot-synchronized.
  //
  // On a genuinely fresh page load (first visit in a tab/profile, competing
  // with service-worker registration, WASM fetch/compile, and audio-node
  // setup for the browser's attention), this fetch/RTT measurement has been
  // observed to occasionally produce a wildly implausible skew (thousands of
  // seconds) that a plain reload immediately clears — some one-time first-
  // load contention delays either t0's capture or the response's arrival in
  // a way that breaks the RTT-midpoint assumption, without there being an
  // actual multi-hour clock error. A REAL clock skew is never this large in
  // practice (even a totally unconfigured NTP-less clock drifts by seconds
  // to minutes, not hours) — so treat an extreme first reading as a bad
  // measurement, not a bad clock: silently retry once (past whatever
  // start-of-page contention caused it) before ever showing the warning.
  const IMPLAUSIBLE_SKEW_S = 3600 // 1 hour — real NTP drift never gets close to this
  const [clockSkewS, setClockSkewS] = createSignal<number | null>(null)
  onMount(() => {
    const controller = new AbortController()
    let cancelled = false
    function checkSkew(isRetry: boolean) {
      const t0 = Date.now()
      fetch('https://cloudflare.com/cdn-cgi/trace', { signal: controller.signal, cache: 'no-store' })
        .then((r) => r.text())
        .then((text) => {
          if (cancelled) return
          const m = text.match(/^ts=([\d.]+)/m)
          if (!m) return
          const rtt = Date.now() - t0
          const serverMs = parseFloat(m[1]) * 1000 + rtt / 2
          const skewS = (Date.now() - serverMs) / 1000
          if (Math.abs(skewS) > IMPLAUSIBLE_SKEW_S && !isRetry) {
            // Bad first-load measurement, not a real clock error — try once
            // more rather than surface a false-positive warning.
            checkSkew(true)
            return
          }
          setClockSkewS(skewS)
        })
        .catch(() => {})
    }
    checkSkew(false)
    onCleanup(() => {
      cancelled = true
      controller.abort()
    })
  })

  // Frozen VFO per decoded window: windowStart.getTime() -> vfoHz at that moment.
  const frozenVfo = new Map<number, number>()
  // Messages already merged into contacts, per window (windowStart ms -> count).
  const mergedCount = new Map<number, number>()
  // Admission gate for suspicious new callsigns — lives for the session.
  const gate = new DecodeGate()

  const [windowStats, setWindowStats] = createSignal<Map<number, MergeStats>>(new Map())

  // Authoritative contacts live in a plain mutable holder (always current, no
  // data loss); the signal copy that drives the heavy consumers — contacts
  // panel sort/stats, Leaflet markers, auto-reply — is published at most once
  // per interval.
  let contactsAuth = new Map<string, Contact>()
  let publishTimer: ReturnType<typeof setTimeout> | null = null
  function publishContacts() {
    publishTimer = null
    setContacts(contactsAuth)
    props.onContactsChange?.(contactsAuth)
  }
  onCleanup(() => {
    if (publishTimer) clearTimeout(publishTimer)
  })

  createEffect(() => {
    const { results } = processor.state()
    if (results.length === 0) {
      prevResultLen = 0
      frozenVfo.clear()
      mergedCount.clear()
      contactsAuth = new Map()
      gate.reset()
      setWindowStats((prev) => (prev.size ? new Map() : prev))
      return
    }

    const currentVfo = vfoVal

    if (frozenVfo.size > results.length + 10) {
      const live = new Set(results.map((r) => r.windowStart.getTime()))
      for (const k of frozenVfo.keys()) if (!live.has(k)) frozenVfo.delete(k)
      for (const k of mergedCount.keys()) if (!live.has(k)) mergedCount.delete(k)
    }

    let next = contactsAuth
    let changed = false
    const statDeltas = new Map<number, MergeStats>()
    const myUp = (props.myCall ?? '').trim().toUpperCase()
    const qsoTouched = new Set<string>()
    for (const r of results.slice().reverse()) {
      const key = r.windowStart.getTime()
      if (!frozenVfo.has(key)) frozenVfo.set(key, currentVfo)
      const vfo = frozenVfo.get(key)!
      const merged = mergedCount.get(key) ?? 0
      if (r.messages.length <= merged) continue

      const freshMsgs = r.messages.slice(merged).map((msg) => ({
        ...msg,
        freq: vfo > 0 ? vfo + msg.freq : msg.freq,
      }))
      const { contacts: mergedContacts, stats } = mergeContacts(next, r.windowStart, freshMsgs, 0, gate)
      next = mergedContacts
      statDeltas.set(key, stats)
      mergedCount.set(key, r.messages.length)
      changed = true

      // Peers exchanging with me in this batch — their QSO segments get
      // snapshotted into the persistent QSO log below, before rotation
      // (60-msg cap / contact eviction) can flush the exchange.
      if (myUp) {
        for (const fm of freshMsgs) {
          const p = parseFTMsgCached(fm.msg)
          if (!p.clean) continue
          if (p.caller?.toUpperCase() === myUp && p.callee) qsoTouched.add(p.callee)
          else if (p.callee?.toUpperCase() === myUp && p.caller) qsoTouched.add(p.caller)
        }
      }
    }
    if (qsoTouched.size > 0) {
      const recs: QSORecord[] = []
      for (const cs of qsoTouched) {
        const c = next.get(cs)
        if (c) recs.push(...extractQSORecords(c, myUp, props.ftMode, currentVfo))
      }
      qsoLogUpsert(recs)
    }
    if (changed) {
      contactsAuth = next
      setWindowStats((prev) => {
        const map = new Map(prev)
        for (const [key, d] of statDeltas) {
          const s = map.get(key) ?? { newContacts: 0, held: 0, released: 0, expired: 0, gridRejected: 0 }
          map.set(key, {
            newContacts: s.newContacts + d.newContacts,
            held: s.held + d.held,
            released: s.released + d.released,
            expired: s.expired + d.expired,
            gridRejected: s.gridRejected + d.gridRejected,
          })
        }
        if (map.size > results.length + 10) {
          const live = new Set(results.map((r) => r.windowStart.getTime()))
          for (const k of map.keys()) if (!live.has(k)) map.delete(k)
        }
        return map
      })
      if (publishTimer === null) publishTimer = setTimeout(publishContacts, CONTACTS_PUBLISH_MS)
    }
    prevResultLen = results.length
  })

  function handleReset() {
    processor.clearResults()
    contactsAuth = new Map()
    if (publishTimer) {
      clearTimeout(publishTimer)
      publishTimer = null
    }
    setContacts(new Map())
    props.onContactsChange?.(new Map())
    prevResultLen = 0
    frozenVfo.clear()
    mergedCount.clear()
    gate.reset()
    setWindowStats(new Map())
    // Restart audio capture to flush the capture AudioWorklet and AudioContext —
    // same effect as mode-switch; clears any stale accumulated sample buffer.
    if (processor.state().isRecording) {
      processor.stopRecording()
      setTimeout(() => {
        processor.startRecording()
      }, 100)
    }
  }

  function handleImportADIF(content: string) {
    const records = parseADIF(content)
    if (!records.length) return
    const importedRecs: QSORecord[] = []
    setContacts((prev) => {
      const next = new Map(prev)
      for (const r of records) {
        const ts =
          r.qsoDate && r.timeOn
            ? new Date(
                parseInt(r.qsoDate.slice(0, 4)),
                parseInt(r.qsoDate.slice(4, 6)) - 1,
                parseInt(r.qsoDate.slice(6, 8)),
                parseInt(r.timeOn.slice(0, 2)),
                parseInt(r.timeOn.slice(2, 4)),
                parseInt(r.timeOn.slice(4, 6)),
              )
            : new Date()
        // Imported QSOs go straight into the persistent QSO log so they
        // survive contact rotation and round-trip through export.
        const rstRcvd = parseInt(r.rstRcvd ?? '', 10)
        importedRecs.push({
          callsign: r.call,
          grid: r.gridsquare?.toUpperCase(),
          startMs: ts.getTime(),
          endMs: ts.getTime(),
          freqHz: r.freq ? Math.round(parseFloat(r.freq) * 1_000_000) || 0 : 0,
          rstRcvd: Number.isNaN(rstRcvd) ? -99 : rstRcvd,
          sentCount: 0,
          rcvdCount: 0,
          confirmed: !r.comment?.includes('partial:'),
          mode: r.mode === 'FT8' ? 'FT8' : r.mode === 'FT4' || r.submode === 'FT4' ? 'FT4' : props.ftMode,
          comment: r.comment,
        })
        if (next.has(r.call)) continue
        const idx = next.size % CONTACT_PALETTE.length
        const c: Contact = {
          callsign: r.call,
          grid: r.gridsquare?.toUpperCase(),
          grids: r.gridsquare ? [r.gridsquare.toUpperCase()] : [],
          latLon: r.gridsquare ? (gridToLatLon(r.gridsquare.toUpperCase()) ?? undefined) : undefined,
          color: CONTACT_PALETTE[idx],
          msgs: [],
          peers: new Set<string>(),
          firstSeen: ts,
          lastSeen: ts,
        }
        next.set(r.call, c)
      }
      props.onContactsChange?.(next)
      return next
    })
    qsoLogUpsert(importedRecs)
  }

  // ── 2-panel drag ────────────────────────────────────────────────────────
  let containerEl: HTMLDivElement | undefined
  const [panelWeights, setPanelWeights] = createSignal(loadNumberArray(LS_PANEL_WEIGHTS, DEFAULT_PANEL_WEIGHTS))
  let dragState: { divider: number; startX: number; startW: number[] } | null = null

  createEffect(() => saveNumberArray(LS_PANEL_WEIGHTS, panelWeights()))

  function startPanelDrag(divider: number) {
    return (e: MouseEvent) => {
      e.preventDefault()
      dragState = { divider, startX: e.clientX, startW: [...panelWeights()] }
    }
  }
  onMount(() => {
    const onMove = (e: MouseEvent) => {
      const d = dragState
      if (!d || !containerEl) return
      const total = d.startW.reduce((a, b) => a + b, 0)
      const dw = ((e.clientX - d.startX) / containerEl.offsetWidth) * total
      const nw = [...d.startW]
      nw[d.divider] = Math.max(0.15, d.startW[d.divider] + dw)
      nw[d.divider + 1] = Math.max(0.15, d.startW[d.divider + 1] - dw)
      setPanelWeights(nw)
    }
    const onUp = () => {
      dragState = null
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    onCleanup(() => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    })
  })

  // ── Derived ───────────────────────────────────────────────────────────
  const windowSec = createMemo(() => FT_WINDOW_SECONDS[props.ftMode])
  const totalMsgs = createMemo(() => processor.state().results.reduce((s, r) => s + r.messages.length, 0))

  type SepRow = {
    kind: 'sep'
    time: Date
    mode: FTMode
    empty: boolean
    decoding: boolean
    decodeMs: number
    msgCount: number
    stats?: MergeStats
    key: string
  }
  type TableRow = SepRow | MsgRowData

  const myCallUpper = createMemo(() => (props.myCall ?? '').toUpperCase())

  function sortMessages(msgs: FTMessage[]): FTMessage[] {
    const key = sortKey()
    if (!key) return msgs
    const rev = sortRev()
    return msgs.slice().sort((a, b) => {
      const cmp = key === 'freq' ? a.freq - b.freq : key === 'snr' ? a.snr - b.snr : key === 'dt' ? a.dt - b.dt : a.msg.localeCompare(b.msg)
      return rev ? -cmp : cmp
    })
  }

  const tableRows = createMemo<TableRow[]>(() => {
    const results = processor.state().results
    const cs = contacts()
    const myUp = myCallUpper()
    const stats = windowStats()
    const q = msgQuery().trim().toUpperCase()
    return results.flatMap((r, ri) => {
      const frozen = frozenVfo.get(r.windowStart.getTime()) ?? vfoVal
      const msgs = sortMessages(r.messages).filter(m => !q || m.msg.toUpperCase().includes(q))
      if (q && msgs.length === 0) return []
      return [
        {
          kind: 'sep' as const,
          time: r.windowStart,
          mode: r.mode,
          empty: r.messages.length === 0,
          decoding: !!r.decoding,
          decodeMs: r.decodeMs,
          msgCount: r.messages.length,
          stats: stats.get(r.windowStart.getTime()),
          key: `sep-${ri}`,
        },
        ...msgs.map((m) => {
          const parsed = parseFTMsgCached(m.msg)
          const addressedToMe = !!myUp && parsed.callee?.toUpperCase() === myUp
          let colorSig = ''
          for (const w of [parsed.caller, parsed.callee]) {
            const c = w ? cs.get(w) : undefined
            if (c) colorSig += `${w}:${c.color};`
          }
          return {
            kind: 'msg' as const,
            absFreq: formatFreq(m.freq, frozen),
            dt: m.dt,
            snr: m.snr,
            msg: m.msg,
            osd: (m.osd ?? -1) >= 0,
            time: r.windowStart,
            addressedToMe,
            colorSig,
            key: `msg-${ri}-${m.freq}-${m.dt}-${m.snr}-${m.msg}`,
          }
        }),
      ]
    })
  })

  function isSupported() {
    return processor.ftSupported
  }

  onMount(() => {
    if (props.handle) {
      props.handle.current = {
        get isRecording() {
          return processor.state().isRecording
        },
        get isSupported() {
          return isSupported()
        },
        get error() {
          return processor.state().error
        },
        start: processor.startRecording,
        stop: processor.stopRecording,
        reset: handleReset,
      }
    }
  })

  createEffect(() => {
    const controls: DecoderControls = {
      isRecording: processor.state().isRecording,
      isSupported: isSupported(),
      error: processor.state().error,
      start: processor.startRecording,
      stop: processor.stopRecording,
      reset: handleReset,
    }
    props.onStateChange?.(controls)
  })

  return (
    <div class="space-y-3 sm:space-y-4">
      {/* 3-panel layout — bounded height on lg so panel content scrolls instead of growing the page */}
      <div
        ref={containerEl}
        class="flex flex-col gap-4 lg:h-[max(480px,calc(100vh-280px))] lg:flex-row lg:items-stretch lg:gap-0"
        style={{ 'min-height': '480px' }}
      >
        {/* Panel 1 — Decoded Messages */}
        <div class="flex min-w-0 flex-col rounded-lg border border-[#30363d] bg-[#161b22] p-3 sm:p-4" style={{ flex: panelWeights()[0] }}>
          <div class="mb-3 flex shrink-0 items-start justify-between gap-3">
            <h2 class="text-lg font-semibold sm:text-xl">Decoded Messages</h2>
            <div class={`flex shrink-0 items-center gap-2 transition-opacity ${!processor.state().isRecording ? 'opacity-30' : ''}`}>
              <ClockRing status={processor.state().status} windowSec={windowSec()} />
              <div class="flex flex-wrap gap-1.5">
                <For
                  each={[
                    { label: 'Mode', value: props.ftMode },
                    { label: 'Windows', value: processor.state().results.length },
                    { label: 'Total', value: totalMsgs() },
                    { label: 'Last #', value: processor.state().results[0] ? processor.state().results[0].messages.length : '—' },
                  ]}
                >
                  {({ label, value }) => (
                    <div class="rounded border border-[#21262d] bg-[#0d1117] px-2 py-1">
                      <div class="text-[9px] text-[#484f58]">{label}</div>
                      <div class="font-mono text-xs font-semibold text-[#c9d1d9]">{value}</div>
                    </div>
                  )}
                </For>
              </div>
            </div>
          </div>

          <Show when={processor.state().error}>
            <div class="mb-2 shrink-0 rounded-md border border-[#f85149]/30 bg-[#da3633]/10 p-2 text-xs text-[#f85149]">
              {processor.state().error}
            </div>
          </Show>

          <Show when={!isSupported()}>
            <div class="mb-2 flex shrink-0 items-start gap-2 rounded-md border border-[#e3b341]/30 bg-[#e3b341]/10 p-2 text-xs text-[#e3b341]">
              <svg xmlns="http://www.w3.org/2000/svg" class="mt-0.5 h-3.5 w-3.5 shrink-0" viewBox="0 0 20 20" fill="currentColor">
                <path
                  fill-rule="evenodd"
                  d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z"
                  clip-rule="evenodd"
                />
              </svg>
              <span>
                <strong>FT2 is experimental</strong> — no JS decoder available yet. Switch to FT8 or FT4 to decode.
              </span>
            </div>
          </Show>

          <Show when={clockSkewS() !== null && Math.abs(clockSkewS()!) > 1}>
            <div class="mb-2 flex shrink-0 items-start gap-2 rounded-md border border-[#e3b341]/30 bg-[#e3b341]/10 p-2 text-xs text-[#e3b341]">
              <svg xmlns="http://www.w3.org/2000/svg" class="mt-0.5 h-3.5 w-3.5 shrink-0" viewBox="0 0 20 20" fill="currentColor">
                <path
                  fill-rule="evenodd"
                  d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z"
                  clip-rule="evenodd"
                />
              </svg>
              <span>
                <strong>Clock skew detected:</strong> your system clock is{' '}
                {clockSkewS()! > 0 ? `${clockSkewS()!.toFixed(1)} s ahead` : `${Math.abs(clockSkewS()!).toFixed(1)} s behind`} UTC. FT8/FT4 requires
                sync within ±1 s — enable NTP to fix this.
              </span>
            </div>
          </Show>

          {/* Filter */}
          <Show when={processor.state().results.length > 0}>
            <div class="mb-1.5 shrink-0 relative">
              <input
                type="text"
                value={msgQuery()}
                onInput={e => setMsgQuery(e.currentTarget.value)}
                placeholder="Filter messages…"
                class="w-full bg-[#0d1117] border border-[#30363d] rounded px-2 py-1 text-xs font-mono text-[#c9d1d9] placeholder-[#484f58] focus:outline-none focus:border-[#2ea043] transition-colors"
              />
              <Show when={msgQuery()}>
                <button
                  onClick={() => setMsgQuery('')}
                  class="absolute right-1.5 top-1/2 -translate-y-1/2 text-[#484f58] hover:text-[#c9d1d9] text-xs px-1"
                  title="Clear filter"
                >
                  ✕
                </button>
              </Show>
            </div>
          </Show>

          {/* column header (outside the scroller — no sticky tricks needed).
              Hz/dB/Δ/Message are sortable — but only WITHIN each decode window;
              windows themselves always stay in newest-first decode order. */}
          <Show when={processor.state().results.length > 0}>
            <div class={`${MSG_GRID_COLS} shrink-0 border-b border-[#30363d] font-mono text-xs font-semibold text-[#8b949e]`}>
              <div class="px-2 py-1.5 text-left whitespace-nowrap">UTC</div>
              <SortableHeader label="Hz" col="freq" sortKey={sortKey()} sortRev={sortRev()} onSort={toggleSort} align="right" />
              <SortableHeader label="dB" col="snr" sortKey={sortKey()} sortRev={sortRev()} onSort={toggleSort} align="right" />
              <SortableHeader label="Δ" col="dt" sortKey={sortKey()} sortRev={sortRev()} onSort={toggleSort} align="right" title="Time offset vs UTC window" />
              <SortableHeader label="Message" col="msg" sortKey={sortKey()} sortRev={sortRev()} onSort={toggleSort} align="left" />
            </div>
          </Show>

          {/* Windowed list: DOM size stays constant regardless of history length */}
          <VirtualList
            items={tableRows()}
            class="min-h-0 max-h-[60vh] flex-1 overflow-y-auto font-mono text-xs lg:max-h-none"
            itemKey={(row) => row.key}
            itemHeight={(row) => (row.kind === 'sep' ? SEP_ROW_H : MSG_ROW_H)}
            overscan={10}
            preserveScrollOnPrepend
            empty={
              <div class="flex h-full items-center justify-center">
                <div class="space-y-2 text-center text-[#484f58]">
                  <div class="text-4xl">📻</div>
                  <div>
                    {msgQuery()
                      ? `No messages match "${msgQuery().trim()}"`
                      : processor.state().isRecording ? `Waiting for next ${props.ftMode} window…` : `Start decoding to receive ${props.ftMode} signals`}
                  </div>
                  <Show when={!msgQuery() && processor.state().isRecording && isSupported()}>
                    <div class="text-[#30363d]">UTC-synchronized · {windowSec()}s windows</div>
                  </Show>
                </div>
              </div>
            }
            renderItem={(row) =>
              row.kind === 'sep' ? (
                <div class="flex h-full items-center border-t border-[#21262d] bg-[#0d1117]/60 px-2 text-[10px] text-[#484f58]">
                  {localHMS(row.time)} — {row.mode}
                  {row.decoding && <span class="ml-2 animate-pulse text-[#e3b341]">decoding…</span>}
                  {!row.decoding && row.empty && <span class="ml-2 text-[#30363d]">no signals</span>}
                  {!row.decoding && row.decodeMs > 0 && (
                    <span class="ml-2 text-[#30363d]" title="decode time">
                      dec {(row.decodeMs / 1000).toFixed(1)}s
                    </span>
                  )}
                  {!row.decoding && row.msgCount > 0 && (
                    <span class="ml-2" title="decoded messages this window">
                      {row.msgCount} msg
                    </span>
                  )}
                  {!row.decoding && (row.stats?.newContacts ?? 0) > 0 && (
                    <span class="ml-2 text-[#2ea043]" title="new validated contacts (senders) this window">
                      +{row.stats!.newContacts} new
                    </span>
                  )}
                  {!row.decoding && (row.stats?.held ?? 0) > 0 && (
                    <span class="ml-2 text-[#e3b341]" title="suspicious new callsigns quarantined — admitted only if corroborated within 6 windows">
                      {row.stats!.held} held
                    </span>
                  )}
                  {!row.decoding && (row.stats?.expired ?? 0) > 0 && (
                    <span
                      class="ml-2 text-[#f85149]/70"
                      title="quarantined callsigns dropped — never corroborated by a clean decode or repeat sighting within 6 windows; will never appear as a contact"
                    >
                      {row.stats!.expired} expired
                    </span>
                  )}
                  {!row.decoding && (row.stats?.gridRejected ?? 0) > 0 && (
                    <span
                      class="ml-2 text-[#f85149]/70"
                      title="grid rejected — reported locator is geographically implausible for the callsign's country (e.g. a wrong-continent decode); the contact's map position was not updated"
                    >
                      {row.stats!.gridRejected} bad grid
                    </span>
                  )}
                </div>
              ) : (
                <MessageRow row={row} timeStr={localHMS(row.time)} myCall={props.myCall ?? ''} getContact={getContactStable} onSelect={selectContact} />
              )
            }
          />

          {/* WASM engine monitor + runtime tuning */}
          <div class="mt-2 shrink-0">
            <FTWasmPanel ftMode={props.ftMode} />
          </div>
        </div>

        {/* Drag handle 0<->1 */}
        <div class="group hidden w-3 shrink-0 cursor-col-resize items-center justify-center self-stretch lg:flex" onMouseDown={startPanelDrag(0)}>
          <div class="h-full w-px bg-[#30363d] transition-colors group-hover:bg-[#2ea043]/50" />
        </div>

        {/* Panel 2 — Signal Analysis. In I/Q mode (see audioSourceKind()
            above), shows the bridge's own wideband I/Q spectrum with a
            draggable passband marker that retunes useIQBridge.ts's
            SSBDemodulator instead of the TX-tone marker used against
            already-demodulated audio — TX itself still goes out over the
            separate mic-send path regardless of RX input mode, so mixing
            both markers into one view would conflate two unrelated things. */}
        <Show
          when={props.iqBridge?.state().connected}
          fallback={
            <SignalAnalysisPanel
              analyser={props.analyser ?? null}
              isRecording={processor.state().isRecording}
              vfoFrequency={props.vfoFrequency}
              storageKeyPrefix="ft"
              markers={(props.txAudioHz ?? 0) > 0 ? [{ freq: props.txAudioHz!, color: '#f85149', label: 'TX' }] : undefined}
              onMarkerDrag={props.onTxAudioHzChange ? (_i, hz) => props.onTxAudioHzChange!(hz) : undefined}
              markerFieldLabel="Tx"
              class="min-w-0"
              style={{ flex: panelWeights()[1] }}
            />
          }
        >
          <SignalAnalysisPanel
            analyser={props.analyser ?? null}
            iqSource={{
              computer: props.iqBridge!.spectrum,
              sampleRateHz: () => props.iqBridge!.state().sampleRateHz,
              active: () => props.iqBridge!.state().connected,
            }}
            isRecording={processor.state().isRecording}
            vfoFrequency={props.vfoFrequency}
            storageKeyPrefix="ft_iq"
            defaultMaxHz={props.iqBridge!.state().sampleRateHz / 2}
            passband={{ centerHz: props.iqBridge!.state().passbandCenterHz, bandwidthHz: props.iqBridge!.state().passbandBandwidthHz }}
            onPassbandChange={(p) => props.iqBridge!.setPassband(p.centerHz, p.bandwidthHz)}
            markerFieldLabel="Passband"
            class="min-w-0"
            style={{ flex: panelWeights()[1] }}
          />
        </Show>

        {/* Drag handle 1<->2 */}
        <div class="group hidden w-3 shrink-0 cursor-col-resize items-center justify-center self-stretch lg:flex" onMouseDown={startPanelDrag(1)}>
          <div class="h-full w-px bg-[#30363d] transition-colors group-hover:bg-[#2ea043]/50" />
        </div>

        {/* Panel 3 — Contacts */}
        <div class="flex min-w-0 flex-col rounded-lg border border-[#30363d] bg-[#161b22] p-3 sm:p-4" style={{ flex: panelWeights()[2] }}>
          <FTContactsPanel
            contacts={contacts()}
            mode={props.ftMode}
            myCall={props.myCall ?? ''}
            myGrid={props.myGrid ?? ''}
            vfoHz={props.vfoFrequency ?? 0}
            onClearContacts={() => {
              // Clear the authoritative holder too, or the next decode's
              // publish would resurrect every cleared contact from it.
              contactsAuth = new Map()
              setContacts(new Map())
              props.onContactsChange?.(contactsAuth)
              qsoLogClear()
            }}
            onImportADIF={handleImportADIF}
            focus={contactFocus()}
          />
        </div>
      </div>

      {/* How to Use */}
      <details class="rounded-lg border border-[#30363d] bg-[#161b22]">
        <summary class="cursor-pointer rounded-lg p-4 text-base font-semibold transition-colors select-none hover:bg-[#21262d] sm:p-5 sm:text-lg">
          How to Use
        </summary>
        <div class="space-y-3 px-4 pb-4 sm:px-5 sm:pb-5">
          <ol class="list-inside list-decimal space-y-1.5 text-sm text-[#c9d1d9]">
            <li>Ensure your clock is NTP-synchronized — FT8/FT4 requires UTC sync within ±1 second</li>
            <li>
              Select <strong>FT8</strong> (15 s) or <strong>FT4</strong> (7.5 s) in the mode selector above
            </li>
            <li>
              Click <strong>Start</strong> and allow microphone access
            </li>
            <li>Tune to a FT8/FT4 frequency in USB mode (e.g. 14.074 MHz for 20m FT8)</li>
            <li>Decoder waits for the next UTC window, then records and decodes automatically</li>
            <li>
              <span class="text-[#2ea043]">Green</span> rows are CQ calls — Contacts panel tracks unique callsigns with QSO history
            </li>
          </ol>
          <div class="space-y-1 rounded-md border border-[#30363d] bg-[#0d1117] p-3 text-xs text-[#8b949e]">
            <p>
              <strong class="text-[#c9d1d9]">Common frequencies:</strong>
            </p>
            <p>FT8 — 1.840 · 3.573 · 7.074 · 10.136 · 14.074 · 18.100 · 21.074 · 24.915 · 28.074 MHz</p>
            <p>FT4 — 3.575 · 7.047 · 10.140 · 14.080 · 18.104 · 21.140 · 24.919 · 28.180 MHz</p>
          </div>
        </div>
      </details>

      <details class="rounded-lg border border-[#30363d] bg-[#161b22]">
        <summary class="cursor-pointer rounded-lg p-4 text-base font-semibold transition-colors select-none hover:bg-[#21262d] sm:p-5 sm:text-lg">
          Privacy
        </summary>
        <div class="space-y-1.5 px-4 pb-4 text-sm text-[#c9d1d9] sm:px-5 sm:pb-5">
          <p>All decoding runs entirely in your browser. No audio or decoded messages are transmitted to any server.</p>
          <p class="text-xs text-[#8b949e]">
            FT8/FT4 decoding powered by{' '}
            <a href="https://github.com/e04/ft8ts" target="_blank" rel="noopener noreferrer" class="underline hover:text-[#c9d1d9]">
              ft8ts
            </a>{' '}
            (GPL-3.0).
          </p>
        </div>
      </details>
    </div>
  )
}
