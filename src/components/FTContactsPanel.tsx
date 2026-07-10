// Port of src/components/FTContactsPanel.tsx (Next.js app). Leaflet map is a
// plain Solid component here (no dynamic()/ssr:false — this app has no SSR).
import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show, type JSX } from 'solid-js'
import { Portal } from 'solid-js/web'
import {
  Contact, ContactMsg, MSG_TYPE_LABEL, MSG_TYPE_COLOR, generateADIFFromRecords, parseADIF, gridToLatLon, haversineKm,
  classifyCallsign, baseCallsign,
} from '$decoder-lib/ft/parser'
import { qsoLogRecords } from '$decoder-lib/ft/qsoLog'
import { callsignCountry } from '$decoder-lib/ft/prefixes'

import { FT_WINDOW_SECONDS, type FTMode } from '$decoder-lib/ft/decoder'
import { fmtAbsHz } from '$decoder-lib/formatFreq'
import VirtualList from './VirtualList'
import { loadNumber, saveNumber, loadBoolean, saveBoolean } from '$decoder-lib/storage'
import FTLeafletMap from './FTLeafletMap'

const LS_MAP_HEIGHT       = 'ft_map_height'
const LS_CONTACTS_SORT_KEY = 'ft_contacts_sort_key'
const LS_CONTACTS_SORT_REV = 'ft_contacts_sort_rev'
const LS_ADIF_INCLUDE_PARTIAL = 'ft_adif_include_partial'
const CONTACTS_SORT_KEYS = ['date', 'tx', 'rx', 'worked', 'alpha', 'snr-hi', 'snr-lo', 'near', 'far'] as const

// Virtualized contact list geometry: collapsed cards are fixed-height
// (summary row 28px + 2px borders + 6px gap); the expanded card is measured
// live via ResizeObserver, with a fallback used until the first measurement.
const CARD_GAP_H = 6
const COLLAPSED_CARD_H = 30 + CARD_GAP_H
const EXPANDED_CARD_FALLBACK_H = 420

// Map day/night overlay preference — a UI-only toggle, remembered per browser
// so it doesn't reset to off every time the page loads.
const LS_SHOW_TERMINATOR = 'ft_map_show_terminator'
function loadShowTerminator(): boolean {
  return localStorage.getItem(LS_SHOW_TERMINATOR) === 'true'
}
function saveShowTerminator(v: boolean) {
  localStorage.setItem(LS_SHOW_TERMINATOR, String(v))
}

// Map tile style preference — dark (default) or light basemap. Remembered
// per browser like the terminator toggle.
type MapTileStyle = 'dark' | 'light'
const LS_MAP_STYLE = 'ft_map_tile_style'
function loadMapStyle(): MapTileStyle {
  return localStorage.getItem(LS_MAP_STYLE) === 'light' ? 'light' : 'dark'
}
function saveMapStyle(v: MapTileStyle) {
  localStorage.setItem(LS_MAP_STYLE, v)
}

// Map pin color mode — mutually exclusive, remembered per browser.
const MAP_COLOR_MODES = ['default', 'age', 'worked', 'distance'] as const
type MapColorModeStored = typeof MAP_COLOR_MODES[number]
const LS_MAP_COLOR_MODE = 'ft_map_color_mode'
function loadMapColorMode(): MapColorModeStored {
  const v = localStorage.getItem(LS_MAP_COLOR_MODE)
  return (MAP_COLOR_MODES as readonly string[]).includes(v ?? '') ? (v as MapColorModeStored) : 'default'
}
function saveMapColorMode(v: MapColorModeStored) {
  localStorage.setItem(LS_MAP_COLOR_MODE, v)
}

// Map VFO filter — independent of color mode, remembered per browser.
const LS_MAP_VFO_FILTER = 'ft_map_vfo_filter'
function loadMapVfoFilter(): boolean {
  return localStorage.getItem(LS_MAP_VFO_FILTER) === 'true'
}
function saveMapVfoFilter(v: boolean) {
  localStorage.setItem(LS_MAP_VFO_FILTER, String(v))
}

// Format a stored absolute frequency. Values > 1 MHz are already absolute (VFO
// was set at decode time); smaller values are raw audio offsets (no VFO then).
function formatMsgFreq(freq: number): string {
  if (freq <= 0) return '—'
  if (freq > 1_000_000) return fmtAbsHz(freq)
  return `${freq.toFixed(0)} Hz`
}

function localHMS(d: Date): string {
  return d.toLocaleTimeString(undefined, { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

interface LocationParts {
  flag: string
  country: string
  grids: string
}

function locationParts(contact: Contact): LocationParts | null {
  const pfx     = callsignCountry(contact.callsign)
  const flag    = pfx?.flag ?? ''
  const country = pfx?.country ?? ''
  const grids   = contact.grid
    ? contact.grid + (contact.grids.length > 1 ? ` +${contact.grids.length - 1}` : '')
    : ''
  if (!flag && !country && !grids) return null
  return { flag, country, grids }
}

function qrzUrl(callsign: string): string {
  // QRZ only resolves the operator's base call — for compound/portable forms
  // (9A/S55X/P, YS3/PY8WW) link the base callsign, not the leading prefix.
  return `https://www.qrz.com/db/${encodeURIComponent(baseCallsign(callsign))}`
}

// Visible badge shown in the card title next to the callsign: Brazilian
// license class (A/B/C, per ANATEL Res. 449/2006 — encoded in prefix +
// suffix length) and whether the callsign uses FT8/FT4's "nonstandard"
// (58-bit) wire encoding — compound/portable form, a 3-char prefix, or a
// longer special-event-style suffix that doesn't fit the compact 28-bit field.
// Brazilian license classes read as a rank ladder — style them like medals:
// A gold, B silver, C bronze. Compound/special keep the neutral blue.
const BADGE_STYLE = {
  gold:   { background: 'rgba(227,179,65,0.15)',  color: '#e3b341', border: '1px solid rgba(227,179,65,0.45)' },
  silver: { background: 'rgba(176,186,196,0.15)', color: '#b1bac4', border: '1px solid rgba(176,186,196,0.45)' },
  bronze: { background: 'rgba(205,127,80,0.15)',  color: '#d0885a', border: '1px solid rgba(205,127,80,0.45)' },
  blue:   { background: 'rgba(88,166,255,0.15)',  color: '#58a6ff', border: '1px solid rgba(88,166,255,0.4)' },
} as const

function callsignBadge(callsign: string): { text: string; title: string; style: JSX.CSSProperties } | null {
  const info = classifyCallsign(callsign)
  if (info.brazilLicenseClass) {
    const style = info.brazilLicenseClass === 'A' ? BADGE_STYLE.gold
                : info.brazilLicenseClass === 'B' ? BADGE_STYLE.silver
                : BADGE_STYLE.bronze
    return { text: `BR-${info.brazilLicenseClass}`, title: `Brazil Class ${info.brazilLicenseClass} license`, style }
  }
  if (info.kind === 'compound') {
    return { text: 'CPD', title: 'Compound/portable callsign (58-bit encoding)', style: BADGE_STYLE.blue }
  }
  if (info.kind === 'nonstandard') {
    return { text: 'SPEC', title: 'Special/nonstandard-format callsign (58-bit encoding)', style: BADGE_STYLE.blue }
  }
  return null
}

function formatKm(km: number): string {
  return `${Math.round(km).toLocaleString('en-US')} km`
}


// All messages involving a specific peer with this contact, sorted by time
function conversationWith(contact: Contact, peer: string): ContactMsg[] {
  return contact.msgs
    .filter(m => {
      const other = m.role === 'tx' ? m.parsed.callee : m.parsed.caller
      return other === peer || m.parsed.caller === peer
    })
    .sort((a, b) => a.windowStart.getTime() - b.windowStart.getTime())
}

// Partial handshake: the contact transmitted to the peer AND received from the peer
function isHandshake(contact: Contact, peer: string): boolean {
  const msgs = conversationWith(contact, peer)
  const sentToPeer       = msgs.some(m => m.role === 'tx' && m.parsed.callee === peer)
  const receivedFromPeer = msgs.some(m => m.role === 'rx' && m.parsed.caller === peer)
  return sentToPeer && receivedFromPeer
}

// Full QSO: handshake confirmed AND a signal report was exchanged AND the
// conversation ended with a sign-off (RR73 / RRR / 73)
function isFullQSO(contact: Contact, peer: string): boolean {
  if (!isHandshake(contact, peer)) return false
  const types = conversationWith(contact, peer).map(m => m.parsed.type)
  const hasReport  = types.includes('report') || types.includes('r_report')
  const hasSignOff = types.includes('rr73') || types.includes('rrr') || types.includes('tx73')
  return hasReport && hasSignOff
}

function longestDistances(contact: Contact, contactMap: Map<string, Contact>) {
  let tx: { km: number; peer: string } | null = null
  let rx: { km: number; peer: string } | null = null
  if (!contact.latLon) return { tx, rx }
  for (const m of contact.msgs) {
    const peer    = m.role === 'tx' ? m.parsed.callee : m.parsed.caller
    const peerLoc = peer ? contactMap.get(peer)?.latLon : undefined
    if (!peer || !peerLoc) continue
    const km = haversineKm(contact.latLon, peerLoc)
    if (m.role === 'tx') { if (!tx || km > tx.km) tx = { km, peer } }
    else                 { if (!rx || km > rx.km) rx = { km, peer } }
  }
  return { tx, rx }
}

// ── Conversation balloon (portal — renders above all card overflow) ────────────

function ConversationBalloon(props: {
  contact: Contact
  peer: string
  contactMap: Map<string, Contact>
  pos: { top: number; left: number }
}): JSX.Element | null {
  const msgs        = createMemo(() => conversationWith(props.contact, props.peer))
  const peerContact  = createMemo(() => props.contactMap.get(props.peer))
  const handshake    = createMemo(() => isHandshake(props.contact, props.peer))
  const fullQSO      = createMemo(() => isFullQSO(props.contact, props.peer))

  return (
    <Show when={msgs().length > 0}>
      <Portal mount={document.body}>
        <div
          class="fixed z-[9999] w-72 bg-[#161b22] border border-[#30363d] rounded-lg shadow-2xl p-2.5 pointer-events-none"
          style={{ top: `${props.pos.top}px`, left: `${props.pos.left}px` }}
        >
          <div class="flex items-center gap-1.5 mb-1.5 border-b border-[#21262d] pb-1.5">
            <span class="font-mono font-bold text-[11px]" style={{ color: props.contact.color }}>
              {props.contact.callsign}
            </span>
            <span class="text-[#484f58] text-[10px]">↔</span>
            <span class="font-mono font-bold text-[11px]" style={{ color: peerContact()?.color ?? '#8b949e' }}>
              {props.peer}
            </span>
            <Show when={fullQSO()} fallback={
              <Show when={handshake()}>
                <span class="ml-auto text-[10px]" title="Partial handshake — both sides transmitted">🤝</span>
              </Show>
            }>
              <span class="ml-auto text-[10px]" title="Full QSO — report exchanged and signed off">⭐</span>
            </Show>
          </div>
          <div class="space-y-0.5 max-h-52 overflow-y-auto">
            <For each={msgs()}>
              {(m) => {
                const isTx = m.role === 'tx'
                return (
                  <div class="flex items-start gap-1.5 font-mono text-[9px]">
                    <span class="text-[#30363d] shrink-0 w-[44px]">{localHMS(m.windowStart)}</span>
                    <span class="text-[#484f58] shrink-0 w-[60px]" title="Frequency">
                      {formatMsgFreq(m.freq)}
                    </span>
                    <span
                      class="shrink-0 px-1 rounded text-[8px] font-bold"
                      style={{
                        background: `${MSG_TYPE_COLOR[m.parsed.type]}1a`,
                        color: MSG_TYPE_COLOR[m.parsed.type],
                      }}
                    >
                      {isTx ? '▶' : '◀'}{MSG_TYPE_LABEL[m.parsed.type]}
                    </span>
                    <span
                      class="truncate"
                      style={{ color: isTx ? props.contact.color : peerContact()?.color ?? '#8b949e', opacity: 0.9 }}
                    >
                      {m.raw}
                    </span>
                  </div>
                )
              }}
            </For>
          </div>
        </div>
      </Portal>
    </Show>
  )
}

// ── Contact card ──────────────────────────────────────────────────────────────

function PeerChip(props: {
  peer: string
  contact: Contact
  contactMap: Map<string, Contact>
  onSelect: (callsign: string) => void
  onPeerEnter: (p: string) => void
  onPeerLeave: () => void
  hoveredPeer: string | null
  balloonPos: { top: number; left: number } | null
}): JSX.Element {
  const pc = createMemo(() => props.contactMap.get(props.peer))
  return (
    <span class="inline-block">
      <button
        onClick={() => props.onSelect(props.peer)}
        onMouseEnter={() => props.onPeerEnter(props.peer)}
        onMouseLeave={props.onPeerLeave}
        class="text-[9px] font-mono font-bold hover:underline"
        style={{ color: pc()?.color ?? '#8b949e' }}
      >
        {props.peer}{pc()?.grid ? ` ${pc()!.grid}` : ''}
      </button>
      <Show when={props.hoveredPeer === props.peer && props.balloonPos}>
        <ConversationBalloon
          contact={props.contact}
          peer={props.peer}
          contactMap={props.contactMap}
          pos={props.balloonPos!}
        />
      </Show>
    </span>
  )
}

function ContactCard(props: {
  contact: Contact
  expanded: boolean
  onToggle: () => void
  onSelect: (callsign: string) => void
  contactMap: Map<string, Contact>
  myCall?: string
  /** 1 = just added, fading to 0 over the decode window; 0 = no highlight. */
  newFraction?: number
}): JSX.Element {
  const [hoveredPeer, setHoveredPeer] = createSignal<string | null>(null)
  const [balloonPos,  setBalloonPos]  = createSignal<{ top: number; left: number } | null>(null)
  let hoverTimeout: ReturnType<typeof setTimeout> | null = null
  let cursor = { x: 0, y: 0 }

  // Track cursor position precisely — read synchronously in hover handler
  onMount(() => {
    const update = (e: MouseEvent) => { cursor = { x: e.clientX, y: e.clientY } }
    window.addEventListener('mousemove', update, { passive: true })
    onCleanup(() => window.removeEventListener('mousemove', update))
  })

  const handlePeerEnter = (p: string) => {
    if (hoverTimeout) clearTimeout(hoverTimeout)
    const { x: cx, y: cy } = cursor
    const vh  = window.innerHeight
    const vw  = window.innerWidth
    const bH  = 280
    const bW  = 288 // w-72 = 18rem
    const top  = cy + 20 + bH > vh ? Math.max(4, cy - bH - 4) : cy + 20
    const left = cx + 20 + bW > vw ? Math.max(4, cx - bW - 4) : cx + 20
    setBalloonPos({ top, left })
    setHoveredPeer(p)
  }
  const handlePeerLeave = () => {
    hoverTimeout = setTimeout(() => {
      setHoveredPeer(null)
      setBalloonPos(null)
    }, 120)
  }

  const txMsgs = createMemo(() => props.contact.msgs.filter(m => m.role === 'tx'))
  const rxMsgs = createMemo(() => props.contact.msgs.filter(m => m.role === 'rx'))

  const groups = createMemo(() => {
    const g: ContactMsg[][] = []
    for (const m of props.contact.msgs) {
      const last = g[g.length - 1]
      if (last && last[0].raw === m.raw && last[0].role === m.role) last.push(m)
      else g.push([m])
    }
    return g
  })
  const history = createMemo(() => groups().slice(-12))

  const locParts = createMemo(() => locationParts(props.contact))
  const longest = createMemo(() => props.expanded ? longestDistances(props.contact, props.contactMap) : { tx: null, rx: null })
  const badge = createMemo(() => callsignBadge(props.contact.callsign))

  // Split peers into groups
  const peerGroups = createMemo(() => {
    const receivedFrom = new Set<string>()
    const repliedTo    = new Set<string>()
    for (const m of props.contact.msgs) {
      const peer = m.role === 'tx' ? m.parsed.callee : m.parsed.caller
      if (!peer || peer === props.contact.callsign) continue
      if (m.role === 'tx') repliedTo.add(peer)
      else receivedFrom.add(peer)
    }
    const handshakes = new Set(
      Array.from(repliedTo).filter(p => receivedFrom.has(p) && isHandshake(props.contact, p))
    )
    const fullQSOs = new Set(
      Array.from(handshakes).filter(p => isFullQSO(props.contact, p))
    )
    return { receivedFrom, repliedTo, handshakes, fullQSOs }
  })

  // QSO status with the local operator
  const myQSOFull = createMemo(() => {
    const myCallUp = (props.myCall ?? '').toUpperCase()
    return myCallUp ? isFullQSO(props.contact, myCallUp) : false
  })
  const myQSOPart = createMemo(() => {
    const myCallUp = (props.myCall ?? '').toUpperCase()
    return myCallUp && !myQSOFull() ? isHandshake(props.contact, myCallUp) : false
  })

  return (
    <div
      class="mb-1.5 rounded-md border border-[#21262d] transition-shadow duration-500"
      style={{
        'border-left-color': props.contact.color,
        'border-left-width': '3px',
        'box-shadow': (props.newFraction ?? 0) > 0
          ? `0 0 0 1px ${props.contact.color}${Math.round((props.newFraction ?? 0) * 55).toString(16).padStart(2, '0')}`
          : undefined,
      }}
    >
      {/* Summary row */}
      <div
        role="button"
        tabIndex={0}
        onClick={props.onToggle}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); props.onToggle() } }}
        class="w-full text-left px-2.5 py-1.5 flex items-center gap-2 hover:bg-[#21262d]/40 transition-colors min-w-0 cursor-pointer"
      >
        <a
          href={qrzUrl(props.contact.callsign)}
          target="_blank"
          rel="noopener noreferrer"
          onClick={e => e.stopPropagation()}
          title={`${props.contact.callsign} on QRZ.com`}
          class="font-mono font-bold text-xs shrink-0 hover:underline"
          style={{ color: props.contact.color }}
        >
          {props.contact.callsign}
        </a>
        <Show when={badge()}>
          <span
            class="shrink-0 text-[9px] font-bold font-mono px-1 py-px rounded"
            style={badge()!.style}
            title={badge()!.title}
          >
            {badge()!.text}
          </span>
        </Show>
        {/* QSO badge — only shown when the local operator has exchanged with this station */}
        <Show when={myQSOFull()}>
          <span
            class="shrink-0 text-[9px] font-bold font-mono px-1 py-px rounded"
            style={{ background: 'rgba(46,160,67,0.15)', color: '#2ea043', border: '1px solid rgba(46,160,67,0.4)' }}
            title="Full QSO completed with you (signal reports + sign-off exchanged)"
          >
            QSO✓
          </span>
        </Show>
        <Show when={myQSOPart()}>
          <span
            class="shrink-0 text-[9px] font-bold font-mono px-1 py-px rounded"
            style={{ background: 'rgba(227,179,65,0.15)', color: '#e3b341', border: '1px solid rgba(227,179,65,0.4)' }}
            title="Partial QSO — exchange started but not fully signed off"
          >
            QSO…
          </span>
        </Show>
        <Show when={locParts()}>
          <span class="font-mono text-[10px] text-[#484f58] flex items-center gap-1 truncate min-w-0"
            title={props.contact.grids.join(' · ')}>
            <Show when={locParts()!.flag}>
              <span title={locParts()!.country} class="not-italic">{locParts()!.flag}</span>
            </Show>
            <Show when={locParts()!.grids}>
              <span>({locParts()!.grids})</span>
            </Show>
          </span>
        </Show>
        <span class="flex-1 min-w-0" />
        <span
          class="font-mono text-[11px] font-semibold text-[#2ea043] shrink-0"
          title="Messages transmitted by this station"
        >
          {txMsgs().length}tx
        </span>
        <span
          class="font-mono text-[11px] font-semibold text-[#79c0ff] shrink-0"
          title="Messages addressed to this station"
        >
          {rxMsgs().length}rx
        </span>
        <span
          class="font-mono text-[11px] font-semibold text-[#d2a8ff] shrink-0"
          title={`Worked ${props.contact.peers.size} station${props.contact.peers.size === 1 ? '' : 's'}`}
        >
          {props.contact.peers.size}w
        </span>
        <svg
          viewBox="0 0 20 20" fill="currentColor"
          class="shrink-0 text-[#484f58] ml-1 transition-transform duration-150"
          style={{ width: '10px', height: '10px', transform: props.expanded ? 'rotate(180deg)' : 'rotate(0)' }}
        >
          <path fill-rule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clip-rule="evenodd" />
        </svg>
      </div>

      {/* Expanded history */}
      <Show when={props.expanded}>
        <div class="border-t border-[#21262d] bg-[#0d1117]/70 px-2.5 py-2">
          <Show when={props.contact.grids.length > 1}>
            <div class="mb-1.5 pb-1.5 border-b border-[#21262d] text-[10px] font-mono flex items-center gap-1.5 flex-wrap">
              <span class="text-[#484f58]">grids:</span>
              <For each={props.contact.grids}>
                {(g) => (
                  <span class={g === props.contact.grid ? 'text-[#c9d1d9] font-bold' : 'text-[#8b949e]'}
                    title={g === props.contact.grid ? 'Most recent locator' : undefined}>
                    {g}
                  </span>
                )}
              </For>
            </div>
          </Show>

          <Show when={longest().tx || longest().rx}>
            <div class="mb-1.5 pb-1.5 border-b border-[#21262d] text-[10px] font-mono flex flex-wrap gap-x-3 gap-y-0.5">
              <Show when={longest().tx}>
                <span title="Longest transmission — distance to the addressed station">
                  <span class="text-[#2ea043]">longest tx:</span>{' '}
                  <span class="text-[#c9d1d9]">{formatKm(longest().tx!.km)}</span>{' '}
                  <button onClick={() => props.onSelect(longest().tx!.peer)}
                    class="font-bold hover:underline"
                    style={{ color: props.contactMap.get(longest().tx!.peer)?.color ?? '#8b949e' }}>
                    → {longest().tx!.peer}
                  </button>
                </span>
              </Show>
              <Show when={longest().rx}>
                <span title="Longest reception — distance to the transmitting station">
                  <span class="text-[#79c0ff]">longest rx:</span>{' '}
                  <span class="text-[#c9d1d9]">{formatKm(longest().rx!.km)}</span>{' '}
                  <button onClick={() => props.onSelect(longest().rx!.peer)}
                    class="font-bold hover:underline"
                    style={{ color: props.contactMap.get(longest().rx!.peer)?.color ?? '#8b949e' }}>
                    ← {longest().rx!.peer}
                  </button>
                </span>
              </Show>
            </div>
          </Show>

          <Show when={history().length > 0} fallback={
            <p class="text-[10px] font-mono text-[#484f58]">no messages</p>
          }>
            <div class="space-y-1">
              <For each={history()}>
                {(group) => {
                  const m      = group[group.length - 1]
                  const isTx   = m.role === 'tx'
                  const peerCs = isTx ? m.parsed.callee : m.parsed.caller
                  const peerColor    = peerCs ? props.contactMap.get(peerCs)?.color : undefined
                  const repeatsTitle = group.map(g => `${localHMS(g.windowStart)}  ${g.raw}`).join('\n')
                  const gridLoc  = m.parsed.grid ? gridToLatLon(m.parsed.grid) : null
                  const otherLoc = isTx
                    ? (peerCs ? props.contactMap.get(peerCs)?.latLon : undefined)
                    : props.contact.latLon
                  const km = gridLoc && otherLoc ? haversineKm(gridLoc, otherLoc) : null
                  return (
                    <div class="font-mono text-[10px] flex items-center gap-1.5 min-w-0">
                      <span class="text-[#30363d] shrink-0 w-[56px]">{localHMS(m.windowStart)}</span>
                      <span class="text-[#484f58] shrink-0 w-[60px]" title="Frequency">
                        {formatMsgFreq(m.freq)}
                      </span>
                      <Show when={isTx} fallback={
                        <span
                          class="shrink-0 px-1 py-px rounded text-[8px] font-bold w-[34px] text-center border"
                          style={{
                            background: `${MSG_TYPE_COLOR[m.parsed.type]}11`,
                            color: MSG_TYPE_COLOR[m.parsed.type],
                            'border-color': `${MSG_TYPE_COLOR[m.parsed.type]}30`,
                          }}
                        >
                          ←{MSG_TYPE_LABEL[m.parsed.type]}
                        </span>
                      }>
                        <span
                          class="shrink-0 px-1 py-px rounded text-[8px] font-bold w-[34px] text-center"
                          style={{ background: `${MSG_TYPE_COLOR[m.parsed.type]}1a`, color: MSG_TYPE_COLOR[m.parsed.type] }}
                        >
                          {MSG_TYPE_LABEL[m.parsed.type]}
                        </span>
                      </Show>
                      <span
                        class="text-[#8b949e] truncate"
                        title={group.length > 1 ? repeatsTitle : m.raw}
                        style={{ color: isTx ? props.contact.color : peerColor ?? '#8b949e', opacity: isTx ? 0.85 : 0.55 }}
                      >
                        {m.raw}
                      </span>
                      <Show when={km !== null}>
                        <span class="shrink-0 text-[9px] text-[#484f58]">{formatKm(km!)}</span>
                      </Show>
                      <Show when={group.length > 1}>
                        <span class="shrink-0 px-1 py-px rounded text-[8px] font-bold bg-[#30363d] text-[#8b949e] cursor-help" title={repeatsTitle}>
                          ×{group.length}
                        </span>
                      </Show>
                    </div>
                  )
                }}
              </For>
            </div>
          </Show>

          {/* Peers — grouped as Full QSOs / Handshakes / Received from / Replied to */}
          <Show when={props.contact.peers.size > 0}>
            <div class="mt-2 pt-1.5 border-t border-[#21262d] space-y-1.5">
              <Show when={peerGroups().fullQSOs.size > 0}>
                <div>
                  <span class="text-[9px] text-[#e3b341] font-mono font-semibold block mb-0.5">
                    ⭐ full QSO ({peerGroups().fullQSOs.size})
                  </span>
                  <div class="flex flex-wrap gap-x-2 gap-y-0.5 pl-3">
                    <For each={Array.from(peerGroups().fullQSOs)}>
                      {(p) => (
                        <PeerChip
                          peer={p}
                          contact={props.contact}
                          contactMap={props.contactMap}
                          onSelect={props.onSelect}
                          onPeerEnter={handlePeerEnter}
                          onPeerLeave={handlePeerLeave}
                          hoveredPeer={hoveredPeer()}
                          balloonPos={balloonPos()}
                        />
                      )}
                    </For>
                  </div>
                </div>
              </Show>

              <Show when={Array.from(peerGroups().handshakes).some(p => !peerGroups().fullQSOs.has(p))}>
                <div>
                  <span class="text-[9px] text-[#d2a8ff] font-mono font-semibold block mb-0.5">
                    🤝 handshake ({Array.from(peerGroups().handshakes).filter(p => !peerGroups().fullQSOs.has(p)).length})
                  </span>
                  <div class="flex flex-wrap gap-x-2 gap-y-0.5 pl-3">
                    <For each={Array.from(peerGroups().handshakes).filter(p => !peerGroups().fullQSOs.has(p))}>
                      {(p) => (
                        <PeerChip
                          peer={p}
                          contact={props.contact}
                          contactMap={props.contactMap}
                          onSelect={props.onSelect}
                          onPeerEnter={handlePeerEnter}
                          onPeerLeave={handlePeerLeave}
                          hoveredPeer={hoveredPeer()}
                          balloonPos={balloonPos()}
                        />
                      )}
                    </For>
                  </div>
                </div>
              </Show>

              <Show when={peerGroups().receivedFrom.size > 0 && Array.from(peerGroups().receivedFrom).some(p => !peerGroups().handshakes.has(p))}>
                <div>
                  <span class="text-[9px] text-[#79c0ff] font-mono font-semibold block mb-0.5">
                    ← received from ({Array.from(peerGroups().receivedFrom).filter(p => !peerGroups().handshakes.has(p)).length})
                  </span>
                  <div class="flex flex-wrap gap-x-2 gap-y-0.5 pl-3">
                    <For each={Array.from(peerGroups().receivedFrom).filter(p => !peerGroups().handshakes.has(p))}>
                      {(p) => (
                        <PeerChip
                          peer={p}
                          contact={props.contact}
                          contactMap={props.contactMap}
                          onSelect={props.onSelect}
                          onPeerEnter={handlePeerEnter}
                          onPeerLeave={handlePeerLeave}
                          hoveredPeer={hoveredPeer()}
                          balloonPos={balloonPos()}
                        />
                      )}
                    </For>
                  </div>
                </div>
              </Show>

              <Show when={peerGroups().repliedTo.size > 0 && Array.from(peerGroups().repliedTo).some(p => !peerGroups().handshakes.has(p))}>
                <div>
                  <span class="text-[9px] text-[#2ea043] font-mono font-semibold block mb-0.5">
                    → replied to ({Array.from(peerGroups().repliedTo).filter(p => !peerGroups().handshakes.has(p)).length})
                  </span>
                  <div class="flex flex-wrap gap-x-2 gap-y-0.5 pl-3">
                    <For each={Array.from(peerGroups().repliedTo).filter(p => !peerGroups().handshakes.has(p))}>
                      {(p) => (
                        <PeerChip
                          peer={p}
                          contact={props.contact}
                          contactMap={props.contactMap}
                          onSelect={props.onSelect}
                          onPeerEnter={handlePeerEnter}
                          onPeerLeave={handlePeerLeave}
                          hoveredPeer={hoveredPeer()}
                          balloonPos={balloonPos()}
                        />
                      )}
                    </For>
                  </div>
                </div>
              </Show>
            </div>
          </Show>
        </div>
      </Show>
    </div>
  )
}

// ── Panel ─────────────────────────────────────────────────────────────────────

interface Props {
  contacts: Map<string, Contact>
  mode: FTMode
  myCall?: string
  myGrid?: string
  vfoHz?: number
  onClearContacts: () => void
  onImportADIF?: (content: string) => void
  focus?: { cs: string; n: number } | null
}

type SortKey = 'date' | 'tx' | 'rx' | 'worked' | 'alpha' | 'snr-hi' | 'snr-lo' | 'near' | 'far'
type QuickFilter = 'full-qso' | 'handshake' | 'tx-only' | 'rx-only' | 'special-call' // country/CQ-tag handled separately

function loadContactsSortKey(): SortKey {
  const raw = localStorage.getItem(LS_CONTACTS_SORT_KEY)
  return (CONTACTS_SORT_KEYS as readonly string[]).includes(raw ?? '') ? (raw as SortKey) : 'date'
}

const SORT_OPTIONS: Array<{ key: SortKey; label: string; title: string }> = [
  { key: 'date',   label: 'Time',     title: 'Most recently heard first' },
  { key: 'tx',     label: 'TX',       title: 'Most transmissions first' },
  { key: 'rx',     label: 'RX',       title: 'Most receptions first' },
  { key: 'worked', label: 'Worked',   title: 'Most unique stations worked first' },
  { key: 'snr-hi', label: 'Strongest', title: 'Strongest signal (highest SNR) first' },
  { key: 'snr-lo', label: 'Weakest',  title: 'Weakest signal (lowest SNR) first' },
  { key: 'near',   label: 'Nearest',  title: 'Geographically closest first (requires your grid)' },
  { key: 'far',    label: 'Farthest', title: 'Geographically farthest first (requires your grid)' },
  { key: 'alpha',  label: 'A–Z',      title: 'Alphabetical by callsign' },
]

export default function FTContactsPanel(props: Props): JSX.Element {
  const [expanded,       setExpanded]      = createSignal<string | null>(null)
  const [sortKey,        setSortKey]       = createSignal<SortKey>(loadContactsSortKey())
  const [sortRev,        setSortRev]       = createSignal(loadBoolean(LS_CONTACTS_SORT_REV, false))
  createEffect(() => localStorage.setItem(LS_CONTACTS_SORT_KEY, sortKey()))
  createEffect(() => saveBoolean(LS_CONTACTS_SORT_REV, sortRev()))
  const [query,          setQuery]         = createSignal('')
  const [quickFilter,    setQuickFilter]   = createSignal<QuickFilter | null>(null)
  const [countryFilter,  setCountryFilter] = createSignal<string>('') // country code or ''
  const [cqTagFilter,    setCqTagFilter]   = createSignal<string>('') // directed-CQ tag or ''
  const [mapHeight,      setMapHeight]     = createSignal(loadNumber(LS_MAP_HEIGHT, 160))
  createEffect(() => saveNumber(LS_MAP_HEIGHT, mapHeight()))
  const [showTerminator, setShowTerminator] = createSignal(loadShowTerminator())
  const [mapStyle, setMapStyle] = createSignal<MapTileStyle>(loadMapStyle())
  const [mapColorMode, setMapColorMode] = createSignal<MapColorModeStored>(loadMapColorMode())
  const [mapVfoFilter, setMapVfoFilter] = createSignal(loadMapVfoFilter())
  let panelEl: HTMLDivElement | undefined
  let mapDrag: { startY: number; startH: number } | null = null

  // "New contact" highlight — cards (and map markers) fade in a highlight for
  // one decode window after firstSeen. Ticks only while any contact is still
  // within that window, so the interval goes idle on a quiet band.
  const windowMs = createMemo(() => FT_WINDOW_SECONDS[props.mode] * 1000)
  const [highlightTick, setHighlightTick] = createSignal(0)
  createEffect(() => {
    const contacts = props.contacts
    const wMs = windowMs()
    void highlightTick()
    const hasRecent = () => {
      const now = Date.now()
      for (const c of contacts.values()) if (now - c.firstSeen.getTime() < wMs) return true
      return false
    }
    if (!hasRecent()) return
    const id = setInterval(() => setHighlightTick(t => t + 1), 250)
    onCleanup(() => clearInterval(id))
  })

  onMount(() => {
    const onMove = (e: MouseEvent) => {
      const d = mapDrag
      if (!d || !panelEl) return
      const panelH = panelEl.offsetHeight
      const maxH   = Math.floor(panelH * 0.5)
      const newH   = Math.max(80, Math.min(maxH, d.startH + (e.clientY - d.startY)))
      setMapHeight(newH)
    }
    const onUp = () => { mapDrag = null }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup',   onUp)
    onCleanup(() => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) })
  })

  const select = (callsign: string) => {
    if (props.contacts.has(callsign)) setExpanded(callsign)
  }

  // ── Virtualized list plumbing ────────────────────────────────────────────
  // Collapsed cards have a fixed height; the (single) expanded card is
  // measured live so rows below it are positioned correctly.
  const [expandedH, setExpandedH] = createSignal(EXPANDED_CARD_FALLBACK_H)
  const [heightsVersion, setHeightsVersion] = createSignal(0)
  createEffect(() => { void expanded(); void expandedH(); setHeightsVersion(v => v + 1) })

  let expandedRO: ResizeObserver | null = null
  const measureExpanded = (el: HTMLDivElement | null) => {
    expandedRO?.disconnect()
    if (!el) return
    if (!expandedRO) {
      expandedRO = new ResizeObserver(entries => {
        const box = entries[0]
        const h = (box.borderBoxSize?.[0]?.blockSize ?? box.contentRect.height) + CARD_GAP_H
        setExpandedH(prev => (Math.abs(prev - h) > 2 ? h : prev))
      })
    }
    expandedRO.observe(el)
  }
  onCleanup(() => expandedRO?.disconnect())

  // Scroll the expanded card into view (replaces the old scrollIntoView refs)
  const [scrollIdx, setScrollIdx] = createSignal(-1)
  // scroll on expansion change only — not when the list reorders under it
  createEffect(on(expanded, (exp) => {
    if (exp) setScrollIdx(filtered().findIndex(c => c.callsign === exp))
    else setScrollIdx(-1)
  }))

  createEffect(on(() => props.focus, (focus) => {
    if (focus && props.contacts.has(focus.cs)) setExpanded(focus.cs)
  }))

  const myGridUp = createMemo(() => (props.myGrid ?? '').toUpperCase())

  const myLatLon = createMemo<[number, number] | null>(
    () => myGridUp() ? (gridToLatLon(myGridUp()) ?? null) : null,
  )

  // Per-contact derived values — computed once per contacts Map reference, not per render
  const contactStats = createMemo(() => {
    const map = new Map<string, {
      txCount: number; rxCount: number; maxSnr: number; distKm: number
      countryCode: string | undefined
    }>()
    const myLL = myLatLon()
    for (const c of props.contacts.values()) {
      let txCount = 0, rxCount = 0, snrMax = -99
      for (const m of c.msgs) {
        if (m.role === 'tx') txCount++
        else rxCount++
        if (m.snr > snrMax) snrMax = m.snr
      }
      const dkm = (myLL && c.latLon) ? haversineKm(myLL, c.latLon) : Infinity
      const pfx  = callsignCountry(c.callsign)
      map.set(c.callsign, { txCount, rxCount, maxSnr: snrMax, distKm: dkm, countryCode: pfx?.countryCode })
    }
    return map
  })

  // Build the list of unique countries for the country select dropdown
  const countryOptions = createMemo(() => Array.from(
    Array.from(props.contacts.values()).reduce((acc, c) => {
      const pfx = callsignCountry(c.callsign)
      const flag    = pfx?.flag
      const country = pfx?.country
      const code    = pfx?.countryCode
      if (code && country && flag) {
        const existing = acc.get(code)
        acc.set(code, existing
          ? { ...existing, count: existing.count + 1 }
          : { code, country, flag, count: 1 })
      }
      return acc
    }, new Map<string, { code: string; country: string; flag: string; count: number }>())
    .values()).sort((a, b) => b.count - a.count || a.country.localeCompare(b.country)),
  )

  // Sort contacts — only when contacts, sortKey, sortRev, or stats change
  const sorted = createMemo(() => Array.from(props.contacts.values()).sort((a, b) => {
    const stats = contactStats()
    const sa = stats.get(a.callsign)!
    const sb = stats.get(b.callsign)!
    const key = sortKey()
    let cmp: number
    if      (key === 'date')   cmp = b.lastSeen.getTime() - a.lastSeen.getTime()
    else if (key === 'tx')     cmp = sb.txCount - sa.txCount
    else if (key === 'rx')     cmp = sb.rxCount - sa.rxCount
    else if (key === 'worked') cmp = b.peers.size - a.peers.size
    else if (key === 'snr-hi') cmp = sb.maxSnr - sa.maxSnr
    else if (key === 'snr-lo') cmp = sa.maxSnr - sb.maxSnr
    else if (key === 'near')   cmp = sa.distKm - sb.distKm
    else if (key === 'far')    cmp = sb.distKm - sa.distKm
    else                       cmp = a.callsign.localeCompare(b.callsign)
    return sortRev() ? -cmp : cmp
  }))

  // Stats for filter chip counts — computed once over sorted, not re-run per filter change
  const filterStats = createMemo(() => {
    const stats = contactStats()
    let withLocation = 0, fullQSOCount = 0, handshakeCount = 0, txOnlyCount = 0, rxOnlyCount = 0, specialCount = 0
    for (const c of sorted()) {
      const s = stats.get(c.callsign)!
      if (c.latLon) withLocation++
      if (s.txCount > 0 && s.rxCount === 0) txOnlyCount++
      if (s.rxCount > 0 && s.txCount === 0) rxOnlyCount++
      if (classifyCallsign(c.callsign).kind !== 'standard') specialCount++
      const peers = Array.from(c.peers)
      const hasFull = peers.some(p => isFullQSO(c, p))
      const hasHand = peers.some(p => isHandshake(c, p) && !isFullQSO(c, p))
      if (hasFull) fullQSOCount++
      if (hasHand) handshakeCount++
    }
    return { withLocation, fullQSOCount, handshakeCount, txOnlyCount, rxOnlyCount, specialCount }
  })

  // Directed-CQ tags seen across contacts (DX, POTA, …), most frequent first.
  const cqTagOptions = createMemo(() => {
    const counts = new Map<string, number>()
    for (const c of props.contacts.values()) {
      for (const t of c.cqTags ?? []) counts.set(t, (counts.get(t) ?? 0) + 1)
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
  })

  // Apply quick filter + country filter + CQ-tag filter
  const quickFiltered = createMemo(() => sorted().filter(c => {
    const stats = contactStats()
    const s = stats.get(c.callsign)!
    const qf = quickFilter()
    const cf = countryFilter()
    const tf = cqTagFilter()
    if (qf === 'full-qso'  && !Array.from(c.peers).some(p => isFullQSO(c, p))) return false
    if (qf === 'handshake' && !Array.from(c.peers).some(p => isHandshake(c, p) && !isFullQSO(c, p))) return false
    if (qf === 'tx-only'   && !(s.txCount > 0 && s.rxCount === 0)) return false
    if (qf === 'rx-only'   && !(s.rxCount > 0 && s.txCount === 0)) return false
    if (qf === 'special-call' && classifyCallsign(c.callsign).kind === 'standard') return false
    if (tf && !(c.cqTags ?? []).includes(tf)) return false
    if (cf) {
      const code = callsignCountry(c.callsign)?.countryCode
      if (code !== cf) return false
    }
    return true
  }))

  // Free-text search on top
  const q = createMemo(() => query().trim().toLowerCase())
  const filtered = createMemo(() => {
    const qq = q()
    return qq
      ? quickFiltered().filter(c => {
          const pfx = callsignCountry(c.callsign)
          return [c.callsign, ...c.grids, pfx?.country, pfx?.countryCode]
            .some(s => s?.toLowerCase().includes(qq))
        })
      : quickFiltered()
  })

  const hasAnyFilter = createMemo(() => !!quickFilter() || !!countryFilter() || !!cqTagFilter())

  let importFileEl: HTMLInputElement | undefined
  const [importStatus, setImportStatus] = createSignal<{ count: number; err?: string } | null>(null)
  const [includePartial, setIncludePartial] = createSignal(loadBoolean(LS_ADIF_INCLUDE_PARTIAL, false))
  createEffect(() => saveBoolean(LS_ADIF_INCLUDE_PARTIAL, includePartial()))

  // Export reads the persistent QSO log (see qsoLog.ts), not live contacts —
  // contact messages rotate, so QSOs decoded hours ago may no longer be
  // derivable from them at export time.
  const confirmedQSOCount = createMemo(() => qsoLogRecords().filter(r => r.confirmed).length)

  const partialQSOCount = createMemo(() => qsoLogRecords().filter(r => !r.confirmed).length)

  const exportQSOCount = createMemo(() => confirmedQSOCount() + (includePartial() ? partialQSOCount() : 0))

  function downloadADIF() {
    const records = qsoLogRecords().filter(r => r.confirmed || includePartial())
    const content = generateADIFFromRecords(records, {
      myCall: props.myCall ?? '', myGrid: props.myGrid ?? '',
    })
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' })
    const url  = URL.createObjectURL(blob)
    const a    = document.createElement('a')
    a.href     = url
    a.download = `ft-log-${new Date().toISOString().slice(0, 10)}.adi`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  function handleImportFile(e: Event) {
    const target = e.currentTarget as HTMLInputElement
    const file = target.files?.[0]
    if (!file) return
    target.value = ''
    const reader = new FileReader()
    reader.onload = ev => {
      const content = ev.target?.result as string
      try {
        const records = parseADIF(content)
        if (records.length === 0) { setImportStatus({ count: 0, err: 'No valid QSO records found' }); return }
        props.onImportADIF?.(content)
        setImportStatus({ count: records.length })
        setTimeout(() => setImportStatus(null), 4000)
      } catch {
        setImportStatus({ count: 0, err: 'Failed to parse ADIF file' })
      }
    }
    reader.readAsText(file)
  }

  return (
    <div ref={panelEl} class="flex flex-col h-full min-h-0">
      {/* Header */}
      <div class="flex items-center justify-between mb-2 shrink-0 gap-2">
        <h2 class="text-lg sm:text-xl font-semibold">Contacts</h2>
        <div class="flex items-center gap-1.5 flex-wrap justify-end">
          <span class="text-xs font-mono text-[#8b949e]">
            {q() || hasAnyFilter() ? `${filtered().length}/${props.contacts.size} shown` : `${props.contacts.size} found`}
            <Show when={filterStats().withLocation > 0}>
              <span class="text-[#484f58]"> · {filterStats().withLocation} located</span>
            </Show>
          </span>
          <Show when={importStatus()}>
            <span class={`text-[10px] font-mono ${importStatus()!.err ? 'text-[#f85149]' : 'text-[#2ea043]'}`}>
              {importStatus()!.err ?? `+${importStatus()!.count} imported`}
            </span>
          </Show>
          {/* Hidden file input */}
          <input
            ref={importFileEl}
            type="file"
            accept=".adi,.adif"
            class="hidden"
            onChange={handleImportFile}
          />
          <button
            onClick={() => importFileEl?.click()}
            class="text-xs px-2 py-0.5 rounded border border-[#30363d] text-[#8b949e] hover:text-[#2ea043] hover:border-[#2ea043]/40 transition-colors font-mono"
            title="Import ADIF log (.adi / .adif)"
          >
            import
          </button>
          <Show when={props.contacts.size > 0 || qsoLogRecords().length > 0}>
            <label
              class="flex items-center gap-1 text-[10px] text-[#8b949e] font-mono cursor-pointer select-none"
              title="Also export partial QSOs — two-way handshake with no signal report exchanged yet"
            >
              <input
                type="checkbox"
                checked={includePartial()}
                onChange={e => setIncludePartial(e.currentTarget.checked)}
                class="accent-[#79c0ff]"
              />
              +partial{partialQSOCount() > 0 ? ` (${partialQSOCount()})` : ''}
            </label>
            <button
              onClick={downloadADIF}
              disabled={exportQSOCount() === 0}
              class="text-xs px-2 py-0.5 rounded border border-[#30363d] text-[#8b949e] hover:text-[#79c0ff] hover:border-[#79c0ff]/40 transition-colors font-mono disabled:opacity-40 disabled:cursor-not-allowed"
              title={exportQSOCount() > 0
                ? `Download ADIF log — ${exportQSOCount()} QSO${exportQSOCount() !== 1 ? 's' : ''} (SWL entries excluded)`
                : 'No confirmed two-way QSOs to export yet'}
            >
              export{exportQSOCount() > 0 ? ` (${exportQSOCount()})` : ''}
            </button>
            <button
              onClick={props.onClearContacts}
              class="text-xs px-2 py-0.5 rounded border border-[#30363d] text-[#8b949e] hover:text-[#f85149] hover:border-[#f85149]/40 transition-colors font-mono"
              title="Clear all contacts AND the saved QSO log that ADIF export reads from"
            >
              Clear
            </button>
          </Show>
        </div>
      </div>

      {/* Map */}
      <div class="shrink-0 mb-0">
        <div class="text-[10px] text-[#484f58] font-mono mb-1 flex items-center justify-end">
          <div class="flex items-center gap-1.5">
            <button
              onClick={() => setShowTerminator(v => { saveShowTerminator(!v); return !v })}
              title={showTerminator() ? 'Hide day/night shading' : 'Show day/night shading'}
              class={`text-[9px] font-mono px-1.5 py-0.5 rounded border transition-colors ${
                showTerminator()
                  ? 'border-[#2ea043]/50 text-[#2ea043] bg-[#2ea043]/10'
                  : 'border-[#30363d] text-[#8b949e] hover:text-[#c9d1d9]'
              }`}
            >
              🌓 day/night
            </button>
            <button
              onClick={() => setMapStyle(v => { const next = v === 'dark' ? 'light' : 'dark'; saveMapStyle(next); return next })}
              title={mapStyle() === 'dark' ? 'Switch to light map' : 'Switch to dark map'}
              class={`text-[9px] font-mono px-1.5 py-0.5 rounded border transition-colors ${
                mapStyle() === 'light'
                  ? 'border-[#2ea043]/50 text-[#2ea043] bg-[#2ea043]/10'
                  : 'border-[#30363d] text-[#8b949e] hover:text-[#c9d1d9]'
              }`}
            >
              {mapStyle() === 'dark' ? '☀️ light map' : '🌑 dark map'}
            </button>
            <span class="text-[#30363d]">
              {filterStats().withLocation > 0 ? `${filterStats().withLocation} located` : 'no positions yet'}
            </span>
          </div>
        </div>
        <div class="text-[10px] font-mono mb-1 flex items-center gap-1.5 flex-wrap">
          <For each={[
            { key: 'default' as const,  label: 'colored' },
            { key: 'age' as const,      label: 'age' },
            { key: 'worked' as const,   label: 'worked' },
            { key: 'distance' as const, label: 'distance' },
          ]}>
            {opt => (
              <button
                onClick={() => setMapColorMode(v => { const next = v === opt.key ? 'default' : opt.key; saveMapColorMode(next); return next })}
                title={{
                  default:  'Pin color: each contact keeps its own palette color',
                  age:      'Pin color: fades toward the background the longer since last heard',
                  worked:   'Pin color: green = confirmed QSO, amber = handshake only, gray = never worked (needs My Callsign set)',
                  distance: 'Pin color: dims with distance from my own station (needs My Callsign set + located)',
                }[opt.key]}
                class={`px-1.5 py-0.5 rounded border transition-colors ${
                  mapColorMode() === opt.key
                    ? 'border-[#2ea043]/50 text-[#2ea043] bg-[#2ea043]/10'
                    : 'border-[#30363d] text-[#8b949e] hover:text-[#c9d1d9]'
                }`}
              >
                {opt.label}
              </button>
            )}
          </For>
          <label
            class="flex items-center gap-1 text-[#8b949e] cursor-pointer select-none ml-1"
            title="Hide pins whose last-heard frequency falls outside the current VFO passband"
          >
            <input
              type="checkbox"
              checked={mapVfoFilter()}
              onChange={e => { setMapVfoFilter(e.currentTarget.checked); saveMapVfoFilter(e.currentTarget.checked) }}
              class="accent-[#79c0ff]"
            />
            VFO only
          </label>
        </div>
        <div class="rounded overflow-hidden border border-[#21262d]" style={{ height: `${mapHeight()}px` }}>
          <FTLeafletMap
            contacts={props.contacts}
            onSelect={select}
            selected={expanded()}
            showTerminator={showTerminator()}
            tileStyle={mapStyle()}
            newWindowMs={windowMs()}
            myCall={props.myCall}
            colorMode={mapColorMode()}
            vfoFilterHz={mapVfoFilter() ? (props.vfoHz ?? 0) : 0}
          />
        </div>
        {/* Drag handle to resize map */}
        <div
          class="h-2 flex items-center justify-center cursor-ns-resize group mb-1.5"
          onMouseDown={e => {
            e.preventDefault()
            mapDrag = { startY: e.clientY, startH: mapHeight() }
          }}
        >
          <div class="w-8 h-0.5 rounded-full bg-[#30363d] group-hover:bg-[#2ea043]/60 transition-colors" />
        </div>
      </div>

      {/* Search filter */}
      <Show when={props.contacts.size > 0}>
        <div class="mb-1.5 shrink-0 relative">
          <input
            type="text"
            value={query()}
            onInput={e => setQuery(e.currentTarget.value)}
            placeholder="Search callsign, grid, city, country…"
            class="w-full bg-[#0d1117] border border-[#30363d] rounded px-2 py-1 text-xs font-mono text-[#c9d1d9] placeholder-[#484f58] focus:outline-none focus:border-[#2ea043] transition-colors"
          />
          <Show when={query()}>
            <button
              onClick={() => setQuery('')}
              class="absolute right-1.5 top-1/2 -translate-y-1/2 text-[#484f58] hover:text-[#c9d1d9] text-xs px-1"
              title="Clear search"
            >
              ✕
            </button>
          </Show>
        </div>
      </Show>

      {/* Quick filter chips + country select */}
      <Show when={props.contacts.size > 0}>
        <div class="mb-1.5 shrink-0 flex flex-wrap gap-1 items-center">
          <Show when={filterStats().fullQSOCount > 0}>
            <button
              onClick={() => setQuickFilter(f => f === 'full-qso' ? null : 'full-qso')}
              class={`text-[9px] font-mono px-1.5 py-0.5 rounded border transition-colors ${
                quickFilter() === 'full-qso'
                  ? 'border-[#e3b341]/50 text-[#e3b341] bg-[#e3b341]/10'
                  : 'border-[#30363d] text-[#8b949e] hover:text-[#e3b341] hover:border-[#e3b341]/30'
              }`}
              title="Show contacts with a complete QSO (report exchanged and signed off)"
            >
              ⭐ full QSO <span class="opacity-60">{filterStats().fullQSOCount}</span>
            </button>
          </Show>
          <Show when={filterStats().handshakeCount > 0}>
            <button
              onClick={() => setQuickFilter(f => f === 'handshake' ? null : 'handshake')}
              class={`text-[9px] font-mono px-1.5 py-0.5 rounded border transition-colors ${
                quickFilter() === 'handshake'
                  ? 'border-[#d2a8ff]/50 text-[#d2a8ff] bg-[#d2a8ff]/10'
                  : 'border-[#30363d] text-[#8b949e] hover:text-[#d2a8ff] hover:border-[#d2a8ff]/30'
              }`}
              title="Show contacts with a partial handshake (both sides transmitted, not yet complete)"
            >
              🤝 handshake <span class="opacity-60">{filterStats().handshakeCount}</span>
            </button>
          </Show>
          <Show when={filterStats().txOnlyCount > 0}>
            <button
              onClick={() => setQuickFilter(f => f === 'tx-only' ? null : 'tx-only')}
              class={`text-[9px] font-mono px-1.5 py-0.5 rounded border transition-colors ${
                quickFilter() === 'tx-only'
                  ? 'border-[#2ea043]/50 text-[#2ea043] bg-[#2ea043]/10'
                  : 'border-[#30363d] text-[#8b949e] hover:text-[#2ea043] hover:border-[#2ea043]/30'
              }`}
              title="Show stations that transmitted only (no messages addressed to them)"
            >
              tx only <span class="opacity-60">{filterStats().txOnlyCount}</span>
            </button>
          </Show>
          <Show when={filterStats().rxOnlyCount > 0}>
            <button
              onClick={() => setQuickFilter(f => f === 'rx-only' ? null : 'rx-only')}
              class={`text-[9px] font-mono px-1.5 py-0.5 rounded border transition-colors ${
                quickFilter() === 'rx-only'
                  ? 'border-[#79c0ff]/50 text-[#79c0ff] bg-[#79c0ff]/10'
                  : 'border-[#30363d] text-[#8b949e] hover:text-[#79c0ff] hover:border-[#79c0ff]/30'
              }`}
              title="Show stations seen only as addressees (never transmitted)"
            >
              rx only <span class="opacity-60">{filterStats().rxOnlyCount}</span>
            </button>
          </Show>
          <Show when={filterStats().specialCount > 0}>
            <button
              onClick={() => setQuickFilter(f => f === 'special-call' ? null : 'special-call')}
              class={`text-[9px] font-mono px-1.5 py-0.5 rounded border transition-colors ${
                quickFilter() === 'special-call'
                  ? 'border-[#f0883e]/50 text-[#f0883e] bg-[#f0883e]/10'
                  : 'border-[#30363d] text-[#8b949e] hover:text-[#f0883e] hover:border-[#f0883e]/30'
              }`}
              title="Show compound/portable and special-event callsigns (58-bit encoding)"
            >
              ✨ special calls <span class="opacity-60">{filterStats().specialCount}</span>
            </button>
          </Show>
          <For each={cqTagOptions()}>
            {([tag, count]) => (
              <button
                onClick={() => setCqTagFilter(t => t === tag ? '' : tag)}
                class={`text-[9px] font-mono px-1.5 py-0.5 rounded border transition-colors ${
                  cqTagFilter() === tag
                    ? 'border-[#56d364]/50 text-[#56d364] bg-[#56d364]/10'
                    : 'border-[#30363d] text-[#8b949e] hover:text-[#56d364] hover:border-[#56d364]/30'
                }`}
                title={`Show stations that called CQ ${tag}`}
              >
                CQ {tag} <span class="opacity-60">{count}</span>
              </button>
            )}
          </For>
          <Show when={countryOptions().length > 0}>
            <select
              value={countryFilter()}
              onChange={e => setCountryFilter(e.currentTarget.value)}
              title="Filter by country"
              class={`text-[9px] font-mono px-1 py-0.5 rounded border bg-[#0d1117] transition-colors cursor-pointer ${
                countryFilter()
                  ? 'border-[#e3b341]/50 text-[#e3b341]'
                  : 'border-[#30363d] text-[#8b949e]'
              }`}
            >
              <option value="">🌍 All countries</option>
              <For each={countryOptions()}>
                {({ code, country, flag, count }) => (
                  <option value={code}>{flag} {country} ({count})</option>
                )}
              </For>
            </select>
          </Show>
          <Show when={hasAnyFilter()}>
            <button
              onClick={() => { setQuickFilter(null); setCountryFilter(''); setCqTagFilter('') }}
              class="text-[9px] font-mono px-1.5 py-0.5 rounded border border-[#30363d] text-[#484f58] hover:text-[#c9d1d9]"
              title="Clear all filters"
            >
              ✕ clear
            </button>
          </Show>
        </div>
      </Show>

      {/* Sort controls */}
      <Show when={props.contacts.size > 1}>
        <div class="flex items-center gap-1 mb-1.5 shrink-0 flex-wrap">
          <span class="text-[9px] text-[#484f58] font-mono">sort:</span>
          <For each={SORT_OPTIONS}>
            {({ key, label, title }) => (
              <button
                onClick={() => {
                  if (sortKey() === key) setSortRev(r => !r)
                  else { setSortKey(key); setSortRev(false) }
                }}
                title={sortKey() === key ? `${title} — click to reverse` : title}
                class={`text-[9px] font-mono px-1.5 py-0.5 rounded border transition-colors ${
                  sortKey() === key
                    ? 'border-[#2ea043]/50 text-[#2ea043] bg-[#2ea043]/10'
                    : 'border-[#30363d] text-[#8b949e] hover:text-[#c9d1d9]'
                }`}
              >
                {label}{sortKey() === key ? (sortRev() ? ' ↑' : ' ↓') : ''}
              </button>
            )}
          </For>
        </div>
      </Show>

      {/* Contact list — windowed: DOM size is constant however many contacts exist */}
      <VirtualList
        items={filtered()}
        class="flex-1 overflow-y-auto min-h-0 max-h-[50vh] lg:max-h-none"
        itemKey={c => c.callsign}
        itemHeight={c => (c.callsign === expanded() ? expandedH() : COLLAPSED_CARD_H)}
        heightsVersion={heightsVersion()}
        scrollToIndex={scrollIdx()}
        overscan={5}
        empty={
          <div class="flex flex-col items-center justify-center h-28 gap-2">
            <div class="text-3xl select-none">{q() || hasAnyFilter() ? '🔍' : '🌍'}</div>
            <div class="text-xs text-[#484f58] font-mono">
              {q() ? `No contacts match "${query().trim()}"` : hasAnyFilter() ? 'No contacts match this filter' : 'No contacts yet'}
            </div>
          </div>
        }
        renderItem={c => {
          void highlightTick() // re-render on tick so the fraction below stays current
          const age = Date.now() - c.firstSeen.getTime()
          const newFraction = age < windowMs() ? 1 - age / windowMs() : 0
          return (
            <div ref={c.callsign === expanded() ? (el) => measureExpanded(el) : undefined} style={{ overflow: c.callsign === expanded() ? 'visible' : 'hidden' }}>
              <ContactCard
                contact={c}
                expanded={expanded() === c.callsign}
                onToggle={() => setExpanded(p => p === c.callsign ? null : c.callsign)}
                onSelect={select}
                contactMap={props.contacts}
                myCall={props.myCall}
                newFraction={newFraction}
              />
            </div>
          )
        }}
      />
    </div>
  )
}
