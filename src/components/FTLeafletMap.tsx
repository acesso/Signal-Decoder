// Port of src/components/FTLeafletMap.tsx (Next.js app). react-leaflet has no
// Solid equivalent, so this drives Leaflet's own vanilla JS API directly:
// `onMount` creates a plain `L.map(...)` instance and imperative layers
// (`L.tileLayer`, `L.marker`, `L.polyline`, `L.polygon`, `L.circleMarker`),
// and `createEffect`s diff the current props against plain (non-signal) Maps
// of live Leaflet objects, adding/updating/removing them to match — Leaflet
// objects are not reactive, so this hand-rolled diff is the bridge between
// the two worlds instead of trying to make Leaflet itself reactive.
import { createEffect, createSignal, onCleanup, onMount } from 'solid-js'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { Contact, haversineKm, isConfirmedQSO, isPartialQSO } from '$decoder-lib/ft/parser'
import { DEFAULT_DECODER_PARAMS } from '$decoder-lib/ft/decoder'

// Map view (center/zoom) persistence. This is a plain client-side SPA (no
// SSR), so reading localStorage synchronously on mount is always safe here.
const LS_MAP_VIEW = 'ft_map_view'
const DEFAULT_CENTER: [number, number] = [20, 10]
const DEFAULT_ZOOM = 1.5

function loadMapView(): { center: [number, number]; zoom: number } | null {
  const raw = localStorage.getItem(LS_MAP_VIEW)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    if (
      Array.isArray(parsed.center) && parsed.center.length === 2
      && typeof parsed.center[0] === 'number' && typeof parsed.center[1] === 'number'
      && typeof parsed.zoom === 'number'
    ) {
      return { center: [parsed.center[0], parsed.center[1]], zoom: parsed.zoom }
    }
  } catch { /* malformed — ignore */ }
  return null
}

function saveMapView(center: [number, number], zoom: number): void {
  localStorage.setItem(LS_MAP_VIEW, JSON.stringify({ center, zoom }))
}

// QSO line colors by direction relative to the hovered station
const TX_COLOR = '#2ea043' // hovered station transmitting
const RX_COLOR = '#79c0ff' // hovered station receiving

export type MapColorMode = 'default' | 'age' | 'worked' | 'distance'

const WORKED_FULL_COLOR    = '#2ea043' // confirmed two-way QSO (report exchanged)
const WORKED_PARTIAL_COLOR = '#d29922' // handshake only, no report yet
const WORKED_NONE_COLOR    = '#484f58' // heard/decoded, never exchanged with me

// Blend two hex colors — used to fade a pin's color toward the map's dark
// background as it ages or gets farther away, without touching opacity
// (which Leaflet's divIcon renders inconsistently across the SVG + halo).
function mixHex(hex: string, toward: string, t: number): string {
  const c = Math.max(0, Math.min(1, t))
  const pa = parseInt(hex.slice(1), 16), pb = parseInt(toward.slice(1), 16)
  const ra = (pa >> 16) & 255, ga = (pa >> 8) & 255, ba = pa & 255
  const rb = (pb >> 16) & 255, gb = (pb >> 8) & 255, bb = pb & 255
  const r = Math.round(ra + (rb - ra) * c)
  const g = Math.round(ga + (gb - ga) * c)
  const b = Math.round(ba + (bb - ba) * c)
  return `#${[r, g, b].map(v => v.toString(16).padStart(2, '0')).join('')}`
}

const MAP_BG = '#0d1117'

// Effective marker color for the active color mode. `ageMs` = time since
// last heard; `distanceKm`/`maxDistanceKm` position this contact within the
// current spread of located contacts (farthest = most dimmed).
function coloredFor(
  mode: MapColorMode,
  contact: Contact,
  myCall: string,
  ageMs: number,
  distanceKm: number | null,
  maxDistanceKm: number,
): string {
  if (mode === 'age') {
    // Full-color when just heard, fading to the map background over 30 minutes.
    const DECAY_MS = 30 * 60_000
    return mixHex(contact.color, MAP_BG, ageMs / DECAY_MS)
  }
  if (mode === 'worked') {
    if (!myCall) return contact.color
    if (isConfirmedQSO(contact, myCall)) return WORKED_FULL_COLOR
    if (isPartialQSO(contact, myCall)) return WORKED_PARTIAL_COLOR
    return WORKED_NONE_COLOR
  }
  if (mode === 'distance') {
    if (distanceKm === null || maxDistanceKm <= 0) return contact.color
    return mixHex(contact.color, MAP_BG, (distanceKm / maxDistanceKm) * 0.75)
  }
  return contact.color
}

function formatAgeShort(ms: number): string {
  const mins = Math.round(ms / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m`
  return `${Math.round(mins / 60)}h`
}

// Bow a straight lat/lon segment into a gentle arc — flat lines read as
// clutter once a few overlap; a slight curve separates tx/rx pairs visually
// and reads more like a great-circle path than a ruler line.
function arcPoints(from: [number, number], to: [number, number], bendFrac = 0.12): [number, number][] {
  const midLat = (from[0] + to[0]) / 2
  const midLon = (from[1] + to[1]) / 2
  const dLat = to[0] - from[0]
  const dLon = to[1] - from[1]
  // Perpendicular offset, scaled to the segment length so short/long hops bend similarly
  const perpLat = -dLon * bendFrac
  const perpLon = dLat * bendFrac
  const control: [number, number] = [midLat + perpLat, midLon + perpLon]
  const steps = 24
  const pts: [number, number][] = []
  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    const lat = (1 - t) ** 2 * from[0] + 2 * (1 - t) * t * control[0] + t ** 2 * to[0]
    const lon = (1 - t) ** 2 * from[1] + 2 * (1 - t) * t * control[1] + t ** 2 * to[1]
    pts.push([lat, lon])
  }
  return pts
}

// ── Day/night terminator ────────────────────────────────────────────────────
// Same subsolar-point + great-circle approach as the Leaflet.Terminator
// plugin, reimplemented directly so no extra dependency is needed. Computes
// the night-side polygon at `date` and returns it as a lat/lon ring the
// caller draws as a shaded overlay.
const RAD = Math.PI / 180
const DEG = 180 / Math.PI

function julianDay(date: Date): number {
  return date.getTime() / 86400000 + 2440587.5
}

// Sun's ecliptic position → declination and right ascension (low-precision,
// ~0.01° error — plenty for a visual day/night overlay).
function sunEqCoords(jd: number): { decl: number; ra: number } {
  const d = jd - 2451545.0 // days since J2000.0
  const meanLon = (280.460 + 0.9856474 * d) % 360
  const meanAnom = ((357.528 + 0.9856003 * d) % 360) * RAD
  const eclLon = (meanLon + 1.915 * Math.sin(meanAnom) + 0.020 * Math.sin(2 * meanAnom)) * RAD
  const obliquity = (23.439 - 0.0000004 * d) * RAD
  const ra = Math.atan2(Math.cos(obliquity) * Math.sin(eclLon), Math.cos(eclLon))
  const decl = Math.asin(Math.sin(obliquity) * Math.sin(eclLon))
  return { decl, ra: ra * DEG }
}

// Greenwich Mean Sidereal Time in degrees — needed to convert the sun's RA
// into a geographic longitude (the subsolar point).
function gmstDeg(jd: number): number {
  const d = jd - 2451545.0
  return (280.46061837 + 360.98564736629 * d) % 360
}

/** Night-side polygon ring (lat/lon pairs) for the given moment. */
function nightPolygon(date: Date): [number, number][] {
  const jd = julianDay(date)
  const { decl, ra } = sunEqCoords(jd)
  const subsolarLon = (((ra - gmstDeg(jd)) % 360) + 540) % 360 - 180 // wrap to [-180,180]

  // For each longitude, the terminator's latitude satisfies
  // tan(lat) = -cos(hourAngle) / tan(decl)  (decl in radians)
  const ring: [number, number][] = []
  const tanDecl = Math.tan(decl)
  for (let lon = -180; lon <= 180; lon += 2) {
    const hourAngle = (lon - subsolarLon) * RAD
    let lat: number
    if (Math.abs(tanDecl) < 1e-9) {
      lat = 0 // equinox: terminator is the meridian great circle through the poles
    } else {
      lat = Math.atan(-Math.cos(hourAngle) / tanDecl) * DEG
    }
    ring.push([lat, lon])
  }

  // Close the ring over whichever pole is currently in polar night, so the
  // shaded area covers the full night hemisphere rather than just the curve.
  const northPoleIsNight = decl < 0
  if (northPoleIsNight) {
    ring.push([90, 180], [90, -180])
  } else {
    ring.push([-90, 180], [-90, -180])
  }
  return ring
}

// Leaflet's TileLayer wraps seamlessly across repeated world copies at low
// zoom, but vector layers (Polygon here) do not — a single ring drawn in
// [-180, 180] only appears in its native copy and looks like it's been cut
// off at the seam between repeated worlds. Drawing the same ring shifted by
// ±360° alongside the original covers the adjacent copies too.
function shiftedNightRings(date: Date): [number, number][][] {
  const ring = nightPolygon(date)
  return [-360, 0, 360].map(offset => ring.map(([lat, lon]) => [lat, lon + offset] as [number, number]))
}

// Modern map pin — a solid color disc on a short pointed drop, light ring
// stroke instead of a murky black outline, no inner dot. `isMe` decorates the
// operator's own station distinctly (gold ring + star); `isSelected` adds a
// soft outer glow in place of the old dashed selection circle.
function makeIcon(color: string, newAgeMs: number | null, isMe: boolean, isSelected: boolean) {
  const ring = newAgeMs !== null
    ? `<div class="ft-marker-new-ring" style="position:absolute;left:50%;top:8px;width:16px;height:16px;margin:-8px;border-radius:50%;background:${color};animation-duration:${newAgeMs}ms;"></div>`
    : ''
  const size  = isMe ? 26 : 20
  const cx    = size / 2
  const r     = isMe ? 8 : 6.5
  const strokeColor = isMe ? '#ffd33d' : 'rgba(255,255,255,0.85)'
  const strokeWidth = isMe ? 2.5 : 1.5
  const star = isMe
    ? `<path d="M13 4.2l1.2 2.5 2.7.4-2 1.9.5 2.7-2.4-1.3-2.4 1.3.5-2.7-2-1.9 2.7-.4z" fill="#ffd33d" stroke="rgba(13,17,23,0.5)" stroke-width="0.5" transform="translate(0,-1)"/>`
    : ''
  const selectedGlow = isSelected
    ? `<circle cx="${cx}" cy="${cx}" r="${r + 4}" fill="none" stroke="${color}" stroke-width="1.5" opacity="0.55"/>`
    : ''
  return L.divIcon({
    className: '',
    html: `
      <div style="position:relative;width:${size}px;height:${size + 6}px;">
        ${ring}
        <svg width="${size}" height="${size + 6}" viewBox="0 0 ${size} ${size + 6}" style="position:relative;filter:drop-shadow(0 2px 3px rgba(0,0,0,0.65));">
          <line x1="${cx}" y1="${cx + r - 1}" x2="${cx}" y2="${size + 4}" stroke="${color}" stroke-width="2" stroke-linecap="round"/>
          ${selectedGlow}
          <circle cx="${cx}" cy="${cx}" r="${r}" fill="${color}" stroke="${strokeColor}" stroke-width="${strokeWidth}"/>
          ${star}
        </svg>
      </div>`,
    iconSize: [size, size + 6],
    iconAnchor: [cx, size + 4],
    popupAnchor: [0, -(size + 2)],
  })
}

export interface FTLeafletMapProps {
  contacts: Map<string, Contact>
  onSelect?: (callsign: string) => void
  selected?: string | null
  /** Shade the night hemisphere with a live day/night terminator overlay. */
  showTerminator?: boolean
  /** 'dark' (default) is the standard CARTO dark basemap; 'light' swaps in
   *  the standard CARTO light basemap. */
  tileStyle?: 'dark' | 'light'
  /** Contacts newer than this (ms since firstSeen) get a fading highlight ring. */
  newWindowMs?: number
  /** The operator's own callsign — its marker gets a distinct gold/star treatment. */
  myCall?: string
  /** How to color pins: 'default' (per-contact palette color), 'age' (fades
   *  with time since last heard), 'worked' (full/partial/none QSO status with
   *  myCall), 'distance' (dims with distance from myCall's own pin). */
  colorMode?: MapColorMode
  /** When set, hide contacts whose most recent absolute frequency falls
   *  outside the decoder's passband around this VFO (Hz). 0/absent = no filter. */
  vfoFilterHz?: number
}

const TILE_LAYERS: Record<'dark' | 'light', { url: string }> = {
  dark: {
    url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
  },
  light: {
    url: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
  },
}

const TILE_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/attributions">CARTO</a>'

interface QsoLine {
  from: [number, number]
  to: [number, number]
  dir: 'tx' | 'rx'
  km: number
  peer: string
}

export default function FTLeafletMap(props: FTLeafletMapProps) {
  let containerEl: HTMLDivElement | undefined
  let map: L.Map | undefined
  let tileLayer: L.TileLayer | undefined
  let terminatorLayers: L.Polygon[] = []
  const markerLayers = new Map<string, L.Marker>()
  const lineLayers = new Map<string, { line: L.Polyline; head: L.CircleMarker }>()

  const [hoverCs, setHoverCs] = createSignal<string | null>(null)

  // Age-based coloring depends on Date.now(), which nothing else here is
  // reactive to — without a tick, a pin would freeze at whatever shade it had
  // when last (re)rendered instead of continuing to fade. Only runs the
  // interval while that mode is actually active.
  const [ageTick, setAgeTick] = createSignal(0)
  createEffect(() => {
    if ((props.colorMode ?? 'default') !== 'age') return
    const id = setInterval(() => setAgeTick(t => t + 1), 30_000)
    onCleanup(() => clearInterval(id))
  })

  // ── mount: create the map once ────────────────────────────────────────
  onMount(() => {
    if (!containerEl) return
    const savedView = loadMapView()

    map = L.map(containerEl, {
      center: savedView?.center ?? DEFAULT_CENTER,
      zoom: savedView?.zoom ?? DEFAULT_ZOOM,
      minZoom: 0,
      maxZoom: 12,
      zoomSnap: 0.5,
      zoomControl: true,
      scrollWheelZoom: true,
    })

    tileLayer = L.tileLayer(TILE_LAYERS[props.tileStyle ?? 'dark'].url, {
      attribution: TILE_ATTRIBUTION,
      subdomains: 'abcd',
      maxZoom: 19,
    }).addTo(map)

    // Keep Leaflet's cached container size in sync — both when the container
    // becomes visible (hidden-panel mount) and on later resizes, e.g. a
    // drag-to-resize handle elsewhere changing the map's height. Without an
    // observer that stays attached, Leaflet's internal size/origin cache goes
    // stale after a resize and overlays computed from lat/lon (like the
    // day/night terminator polygon) end up projected against the wrong
    // container bounds.
    const invalidateIfVisible = () => {
      if (!map) return
      const c = map.getContainer()
      if (c.offsetWidth > 0 && c.offsetHeight > 0) map.invalidateSize()
    }
    invalidateIfVisible()
    const ro = new ResizeObserver(invalidateIfVisible)
    ro.observe(containerEl)

    // Persist center/zoom on every pan/zoom so the map reopens where it was left.
    const persistView = () => {
      if (!map) return
      saveMapView([map.getCenter().lat, map.getCenter().lng], map.getZoom())
    }
    map.on('moveend', persistView)
    map.on('zoomend', persistView)

    // Center the initial view on the browser's reported location, once — no
    // marker, just a better starting point than the [20, 10] world-view
    // default. Skipped entirely once a saved view exists (the user's own
    // pan/zoom already takes priority over a geolocation guess); an explicit
    // contact selection also takes priority via the fly-to effect below.
    if (savedView === null && navigator.geolocation) {
      let cancelled = false
      navigator.geolocation.getCurrentPosition(
        pos => {
          if (cancelled || !map) return
          map.setView([pos.coords.latitude, pos.coords.longitude], 5)
        },
        () => { /* denied/unavailable — keep the default world view */ },
        { timeout: 8000 },
      )
      onCleanup(() => { cancelled = true })
    }

    onCleanup(() => {
      ro.disconnect()
      map?.remove()
      map = undefined
    })
  })

  // ── tile style swap ───────────────────────────────────────────────────
  createEffect(() => {
    const style = props.tileStyle ?? 'dark'
    if (!map) return
    tileLayer?.remove()
    tileLayer = L.tileLayer(TILE_LAYERS[style].url, {
      attribution: TILE_ATTRIBUTION,
      subdomains: 'abcd',
      maxZoom: 19,
    }).addTo(map)
  })

  // ── auto-invalidate size whenever the contact count changes ──────────
  createEffect(() => {
    const count = props.contacts.size
    void count
    map?.invalidateSize()
  })

  // ── fly-to-selected-contact ────────────────────────────────────────────
  createEffect(() => {
    const selContact = props.selected ? props.contacts.get(props.selected) : undefined
    const pos = selContact?.latLon ?? null
    if (pos && map) {
      map.flyTo(pos, Math.max(map.getZoom(), 3), { duration: 0.8 })
    }
  })

  // ── day/night terminator overlay ──────────────────────────────────────
  createEffect(() => {
    const show = props.showTerminator ?? false
    if (!map) return

    // Clear any existing terminator layers before redrawing/removing.
    for (const layer of terminatorLayers) layer.remove()
    terminatorLayers = []

    if (!show) return

    let cancelled = false
    const redraw = () => {
      if (cancelled || !map) return
      for (const layer of terminatorLayers) layer.remove()
      terminatorLayers = shiftedNightRings(new Date()).map(positions =>
        L.polygon(positions, {
          color: 'transparent',
          fillColor: '#000000',
          fillOpacity: 0.35,
          interactive: false,
        }).addTo(map!),
      )
    }
    redraw()
    // Recomputed once a minute — the terminator moves ~0.25°/min,
    // imperceptible at map scale over that interval.
    const id = setInterval(redraw, 60_000)

    onCleanup(() => {
      cancelled = true
      clearInterval(id)
      for (const layer of terminatorLayers) layer.remove()
      terminatorLayers = []
    })
  })

  // ── QSO lines for the hovered contact ─────────────────────────────────
  createEffect(() => {
    if (!map) return
    const hoverCallsign = hoverCs()
    const hovered = hoverCallsign ? props.contacts.get(hoverCallsign) : undefined

    const lines: QsoLine[] = []
    if (hovered?.latLon) {
      for (const p of hovered.peers) {
        const peer = props.contacts.get(p)
        if (!peer?.latLon) continue
        const km = haversineKm(hovered.latLon, peer.latLon)
        if (hovered.msgs.some(m => m.role === 'tx' && m.parsed.callee === p)) {
          lines.push({ from: hovered.latLon, to: peer.latLon, dir: 'tx', km, peer: p })
        }
        if (hovered.msgs.some(m => m.role === 'rx' && m.parsed.caller === p)) {
          lines.push({ from: peer.latLon, to: hovered.latLon, dir: 'rx', km, peer: p })
        }
      }
    }
    const maxKm = lines.reduce((m, l) => Math.max(m, l.km), 0)

    // Remove all existing line layers, then redraw from scratch — QSO lines
    // are cheap (bounded by one hovered contact's peer count) so a full
    // clear+redraw per hover change is simpler than diffing, unlike markers.
    for (const { line, head } of lineLayers.values()) {
      line.remove()
      head.remove()
    }
    lineLayers.clear()

    for (const l of lines) {
      const color     = l.dir === 'tx' ? TX_COLOR : RX_COLOR
      const isLongest = lines.length > 1 && l.km === maxKm
      // tx arcs bow one way, rx the other, so paired lines between the same
      // two stations don't sit directly on top of each other
      const bend = l.dir === 'tx' ? 0.12 : -0.12
      const arc  = arcPoints(l.from, l.to, bend)
      const head = arc[Math.round(arc.length * 0.92)]

      const line = L.polyline(arc, {
        color,
        weight: isLongest ? 2.5 : 1.5,
        opacity: isLongest ? 0.85 : 0.5,
        lineCap: 'round',
      }).addTo(map)
      const label = l.dir === 'tx' ? `${hoverCallsign} → ${l.peer}` : `${l.peer} → ${hoverCallsign}`
      line.bindTooltip(
        `<span style="font-family:monospace;font-size:11px;">${label} · ${Math.round(l.km).toLocaleString('en-US')} km${isLongest ? ' · longest' : ''}</span>`,
        { sticky: true },
      )

      const headMarker = L.circleMarker(head, {
        radius: isLongest ? 3.5 : 2.5,
        color,
        fillColor: color,
        fillOpacity: 1,
        weight: 0,
      }).addTo(map)

      lineLayers.set(`${l.peer}-${l.dir}`, { line, head: headMarker })
    }
  })

  // ── contact markers: diff against the live marker map ─────────────────
  createEffect(() => {
    if (!map) return
    ageTick() // re-run periodically while colorMode === 'age' (see effect above)
    const myCallUp = (props.myCall ?? '').trim().toUpperCase()
    const newWindowMs = props.newWindowMs ?? 0
    const selected = props.selected
    const colorMode = props.colorMode ?? 'default'
    const vfoHz = props.vfoFilterHz ?? 0
    let contactList = Array.from(props.contacts.values()).filter(c => c.latLon)

    // VFO filter: keep only contacts whose most recently HEARD transmission's
    // absolute frequency falls inside the decoder's passband around the live
    // VFO. Only the station's own (tx-role) messages count — an rx-role
    // message's frequency is where the SENDER transmitted, not this station.
    // Messages store either an absolute Hz (VFO baked in at decode time) or a
    // bare audio offset (no VFO set then) — only the former can be compared;
    // a contact with no absolute-frequency transmissions is excluded when
    // filtering.
    if (vfoHz > 0) {
      const lo = vfoHz + DEFAULT_DECODER_PARAMS.minHz
      const hi = vfoHz + DEFAULT_DECODER_PARAMS.maxHz
      contactList = contactList.filter(c => {
        const last = c.msgs.reduce<typeof c.msgs[number] | null>(
          (latest, m) => m.role === 'tx' && (!latest || m.windowStart > latest.windowStart) ? m : latest, null,
        )
        if (!last || last.freq <= 1_000_000) return false
        return last.freq >= lo && last.freq <= hi
      })
    }

    const myPos = myCallUp ? props.contacts.get(myCallUp)?.latLon ?? null : null
    const maxDistanceKm = colorMode === 'distance' && myPos
      ? contactList.reduce((m, c) => Math.max(m, haversineKm(myPos, c.latLon!)), 0)
      : 0

    const seen = new Set<string>()

    for (const c of contactList) {
      const [lat, lon] = c.latLon!
      seen.add(c.callsign)
      const txCount = c.msgs.filter(m => m.role === 'tx').length
      const rxCount = c.msgs.filter(m => m.role === 'rx').length
      const age = Date.now() - c.firstSeen.getTime()
      const isNew = newWindowMs > 0 && age < newWindowMs
      const isMe  = !!myCallUp && c.callsign.toUpperCase() === myCallUp
      const lastHeardMs = Date.now() - c.lastSeen.getTime()
      const distanceKm = myPos ? haversineKm(myPos, c.latLon!) : null
      const color = isMe ? c.color : coloredFor(colorMode, c, myCallUp, lastHeardMs, distanceKm, maxDistanceKm)
      const icon = makeIcon(color, isNew ? newWindowMs - age : null, isMe, c.callsign === selected)

      const popupHtml = `
        <div style="font-family:monospace;min-width:110px;">
          <div style="color:${c.color};font-weight:bold;font-size:13px;${props.onSelect ? 'cursor:pointer;' : ''}" title="Show contact details" data-ft-select="${c.callsign}">
            ${c.callsign}
          </div>
          ${c.grids.length > 0 ? `<div style="color:#8b949e;font-size:11px;">${c.grids.join(' · ')}</div>` : ''}
          <div style="color:#484f58;font-size:10px;margin-top:3px;">
            ${txCount > 0 ? `<span>${txCount} tx</span>` : ''}
            ${txCount > 0 && rxCount > 0 ? '<span> · </span>' : ''}
            ${rxCount > 0 ? `<span>${rxCount} rx</span>` : ''}
          </div>
          ${colorMode === 'distance' && distanceKm !== null
            ? `<div style="color:#484f58;font-size:10px;">${Math.round(distanceKm).toLocaleString('en-US')} km</div>`
            : ''}
          ${colorMode === 'age'
            ? `<div style="color:#484f58;font-size:10px;">heard ${formatAgeShort(lastHeardMs)} ago</div>`
            : ''}
          ${c.peers.size > 0
            ? `<div style="color:#484f58;font-size:10px;">worked: ${Array.from(c.peers).map(p =>
                `<span style="${props.onSelect ? 'cursor:pointer;' : ''}text-decoration:underline;margin-right:4px;" data-ft-select="${p}">${p}</span>`,
              ).join('')}</div>`
            : ''}
        </div>`

      let marker = markerLayers.get(c.callsign)
      if (!marker) {
        marker = L.marker([lat, lon], { icon }).addTo(map)
        marker.on('mouseover', () => setHoverCs(c.callsign))
        marker.on('mouseout', () => setHoverCs(prev => (prev === c.callsign ? null : prev)))
        marker.bindPopup(popupHtml)
        marker.on('popupopen', (e) => {
          const el = e.popup.getElement()
          el?.querySelectorAll<HTMLElement>('[data-ft-select]').forEach(node => {
            node.addEventListener('click', () => props.onSelect?.(node.dataset.ftSelect!))
          })
        })
        markerLayers.set(c.callsign, marker)
      } else {
        marker.setLatLng([lat, lon])
        marker.setIcon(icon)
        marker.setPopupContent(popupHtml)
      }
    }

    // Remove markers for contacts no longer present (or no longer located)
    for (const [callsign, marker] of markerLayers) {
      if (!seen.has(callsign)) {
        marker.remove()
        markerLayers.delete(callsign)
      }
    }
  })

  onCleanup(() => {
    for (const marker of markerLayers.values()) marker.remove()
    markerLayers.clear()
    for (const { line, head } of lineLayers.values()) {
      line.remove()
      head.remove()
    }
    lineLayers.clear()
    for (const layer of terminatorLayers) layer.remove()
    terminatorLayers = []
  })

  return <div ref={containerEl} style={{ height: '100%', width: '100%' }} />
}
