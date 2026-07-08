'use client';

// This file is loaded via dynamic() with { ssr: false } — safe to import Leaflet here
import { Fragment, useEffect, useMemo, useState } from 'react';
import { MapContainer, TileLayer, Marker, Popup, Polyline, Polygon, CircleMarker, Tooltip, useMap, useMapEvents } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { Contact, haversineKm } from '@/lib/ft/parser';

// Map view (center/zoom) persistence. This component is dynamically imported
// with { ssr: false } (see FTContactsPanel.tsx), so it never runs on the
// server — safe to read localStorage synchronously here, unlike the
// SSR-safe-default-then-restore-post-mount dance used elsewhere in this app.
const LS_MAP_VIEW = 'ft_map_view';
const DEFAULT_CENTER: [number, number] = [20, 10];
const DEFAULT_ZOOM = 1.5;

function loadMapView(): { center: [number, number]; zoom: number } | null {
  if (typeof window === 'undefined') return null;
  const raw = localStorage.getItem(LS_MAP_VIEW);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (
      Array.isArray(parsed.center) && parsed.center.length === 2
      && typeof parsed.center[0] === 'number' && typeof parsed.center[1] === 'number'
      && typeof parsed.zoom === 'number'
    ) {
      return { center: [parsed.center[0], parsed.center[1]], zoom: parsed.zoom };
    }
  } catch { /* malformed — ignore */ }
  return null;
}

function saveMapView(center: [number, number], zoom: number): void {
  if (typeof window !== 'undefined') localStorage.setItem(LS_MAP_VIEW, JSON.stringify({ center, zoom }));
}

// QSO line colors by direction relative to the hovered station
const TX_COLOR = '#2ea043'; // hovered station transmitting
const RX_COLOR = '#79c0ff'; // hovered station receiving

// Bow a straight lat/lon segment into a gentle arc — flat lines read as
// clutter once a few overlap; a slight curve separates tx/rx pairs visually
// and reads more like a great-circle path than a ruler line.
function arcPoints(from: [number, number], to: [number, number], bendFrac = 0.12): [number, number][] {
  const midLat = (from[0] + to[0]) / 2;
  const midLon = (from[1] + to[1]) / 2;
  const dLat = to[0] - from[0];
  const dLon = to[1] - from[1];
  // Perpendicular offset, scaled to the segment length so short/long hops bend similarly
  const perpLat = -dLon * bendFrac;
  const perpLon = dLat * bendFrac;
  const control: [number, number] = [midLat + perpLat, midLon + perpLon];
  const steps = 24;
  const pts: [number, number][] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const lat = (1 - t) ** 2 * from[0] + 2 * (1 - t) * t * control[0] + t ** 2 * to[0];
    const lon = (1 - t) ** 2 * from[1] + 2 * (1 - t) * t * control[1] + t ** 2 * to[1];
    pts.push([lat, lon]);
  }
  return pts;
}

// ── Day/night terminator ────────────────────────────────────────────────────
// Same subsolar-point + great-circle approach as the Leaflet.Terminator
// plugin, reimplemented directly so no extra dependency is needed. Computes
// the night-side polygon at `date` and returns it as a lat/lon ring the
// caller draws as a shaded overlay.
const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;

function julianDay(date: Date): number {
  return date.getTime() / 86400000 + 2440587.5;
}

// Sun's ecliptic position → declination and right ascension (low-precision,
// ~0.01° error — plenty for a visual day/night overlay).
function sunEqCoords(jd: number): { decl: number; ra: number } {
  const d = jd - 2451545.0; // days since J2000.0
  const meanLon = (280.460 + 0.9856474 * d) % 360;
  const meanAnom = ((357.528 + 0.9856003 * d) % 360) * RAD;
  const eclLon = (meanLon + 1.915 * Math.sin(meanAnom) + 0.020 * Math.sin(2 * meanAnom)) * RAD;
  const obliquity = (23.439 - 0.0000004 * d) * RAD;
  const ra = Math.atan2(Math.cos(obliquity) * Math.sin(eclLon), Math.cos(eclLon));
  const decl = Math.asin(Math.sin(obliquity) * Math.sin(eclLon));
  return { decl, ra: ra * DEG };
}

// Greenwich Mean Sidereal Time in degrees — needed to convert the sun's RA
// into a geographic longitude (the subsolar point).
function gmstDeg(jd: number): number {
  const d = jd - 2451545.0;
  return (280.46061837 + 360.98564736629 * d) % 360;
}

/** Night-side polygon ring (lat/lon pairs) for the given moment. */
function nightPolygon(date: Date): [number, number][] {
  const jd = julianDay(date);
  const { decl, ra } = sunEqCoords(jd);
  const subsolarLon = (((ra - gmstDeg(jd)) % 360) + 540) % 360 - 180; // wrap to [-180,180]

  // For each longitude, the terminator's latitude satisfies
  // tan(lat) = -cos(hourAngle) / tan(decl)  (decl in radians)
  const ring: [number, number][] = [];
  const tanDecl = Math.tan(decl);
  for (let lon = -180; lon <= 180; lon += 2) {
    const hourAngle = (lon - subsolarLon) * RAD;
    let lat: number;
    if (Math.abs(tanDecl) < 1e-9) {
      lat = 0; // equinox: terminator is the meridian great circle through the poles
    } else {
      lat = Math.atan(-Math.cos(hourAngle) / tanDecl) * DEG;
    }
    ring.push([lat, lon]);
  }

  // Close the ring over whichever pole is currently in polar night, so the
  // shaded area covers the full night hemisphere rather than just the curve.
  const northPoleIsNight = decl < 0;
  if (northPoleIsNight) {
    ring.push([90, 180], [90, -180]);
  } else {
    ring.push([-90, 180], [-90, -180]);
  }
  return ring;
}

// Recomputed once a minute — the terminator moves ~0.25°/min, imperceptible
// at map scale over that interval, so no need for a tighter tick.
//
// Leaflet's TileLayer wraps seamlessly across repeated world copies at low
// zoom, but vector layers (Polygon here) do not — a single ring drawn in
// [-180, 180] only appears in its native copy and looks like it's been cut
// off at the seam between repeated worlds. Drawing the same ring shifted by
// ±360° alongside the original covers the adjacent copies too.
function DayNightOverlay() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(id);
  }, []);
  const ring = useMemo(() => nightPolygon(now), [now]);
  const shifted = useMemo(
    () => [-360, 0, 360].map(offset => ring.map(([lat, lon]) => [lat, lon + offset] as [number, number])),
    [ring],
  );
  return (
    <>
      {shifted.map((positions, i) => (
        <Polygon
          key={i}
          positions={positions}
          pathOptions={{ color: 'transparent', fillColor: '#000000', fillOpacity: 0.35, interactive: false }}
        />
      ))}
    </>
  );
}

// Modern map pin — a solid color disc on a short pointed drop, light ring
// stroke instead of a murky black outline, no inner dot. `isMe` decorates the
// operator's own station distinctly (gold ring + star); `isSelected` adds a
// soft outer glow in place of the old dashed selection circle.
function makeIcon(color: string, newAgeMs: number | null, isMe: boolean, isSelected: boolean) {
  const ring = newAgeMs !== null
    ? `<div class="ft-marker-new-ring" style="position:absolute;left:50%;top:8px;width:16px;height:16px;margin:-8px;border-radius:50%;background:${color};animation-duration:${newAgeMs}ms;"></div>`
    : '';
  const size  = isMe ? 26 : 20;
  const cx    = size / 2;
  const r     = isMe ? 8 : 6.5;
  const strokeColor = isMe ? '#ffd33d' : 'rgba(255,255,255,0.85)';
  const strokeWidth = isMe ? 2.5 : 1.5;
  const star = isMe
    ? `<path d="M13 4.2l1.2 2.5 2.7.4-2 1.9.5 2.7-2.4-1.3-2.4 1.3.5-2.7-2-1.9 2.7-.4z" fill="#ffd33d" stroke="rgba(13,17,23,0.5)" stroke-width="0.5" transform="translate(0,-1)"/>`
    : '';
  const selectedGlow = isSelected
    ? `<circle cx="${cx}" cy="${cx}" r="${r + 4}" fill="none" stroke="${color}" stroke-width="1.5" opacity="0.55"/>`
    : '';
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
  });
}

// Keep Leaflet's cached container size in sync — both when the container
// becomes visible (hidden-panel mount) and on later resizes, e.g. the
// drag-to-resize handle in FTContactsPanel changing the map's height. Without
// an observer that stays attached, Leaflet's internal size/origin cache goes
// stale after a resize and overlays computed from lat/lon (like the day/night
// terminator polygon) end up projected against the wrong container bounds.
function InvalidateOnShow() {
  const map = useMap();
  useEffect(() => {
    const container = map.getContainer();
    if (container.offsetWidth > 0 && container.offsetHeight > 0) {
      map.invalidateSize();
    }
    const ro = new ResizeObserver(() => {
      if (container.offsetWidth > 0 && container.offsetHeight > 0) {
        map.invalidateSize();
      }
    });
    ro.observe(container);
    return () => ro.disconnect();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

// Fit map to all located contacts whenever a new one is added
function AutoBounds({ count }: { count: number }) {
  const map = useMap();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { map.invalidateSize(); }, [count]);
  return null;
}

// Pan/zoom to the selected contact's position
function FlyTo({ pos }: { pos: [number, number] | null }) {
  const map = useMap();
  useEffect(() => {
    if (pos) map.flyTo(pos, Math.max(map.getZoom(), 3), { duration: 0.8 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pos?.[0], pos?.[1]]);
  return null;
}

// Center the initial view on the browser's reported location, once — no
// marker, just a better starting point than the [20, 10] world-view default.
// Skipped entirely once a saved view exists (the user's own pan/zoom already
// takes priority over a geolocation guess); an explicit contact selection
// also takes priority via FlyTo.
function CenterOnUserLocation({ skip }: { skip: boolean }) {
  const map = useMap();
  useEffect(() => {
    if (skip || typeof navigator === 'undefined' || !navigator.geolocation) return;
    let cancelled = false;
    navigator.geolocation.getCurrentPosition(
      pos => {
        if (cancelled) return;
        map.setView([pos.coords.latitude, pos.coords.longitude], 5);
      },
      () => { /* denied/unavailable — keep the default world view */ },
      { timeout: 8000 },
    );
    return () => { cancelled = true; };
  }, [skip]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

// Persist center/zoom on every pan/zoom so the map reopens where it was left.
function MapViewTracker() {
  const map = useMapEvents({
    moveend: () => saveMapView([map.getCenter().lat, map.getCenter().lng], map.getZoom()),
    zoomend: () => saveMapView([map.getCenter().lat, map.getCenter().lng], map.getZoom()),
  });
  return null;
}

interface Props {
  contacts: Map<string, Contact>;
  onSelect?: (callsign: string) => void;
  selected?: string | null;
  /** Shade the night hemisphere with a live day/night terminator overlay. */
  showTerminator?: boolean;
  /** 'dark' (default) is the standard CARTO dark basemap; 'light' swaps in
   *  the standard CARTO light basemap. */
  tileStyle?: 'dark' | 'light';
  /** Contacts newer than this (ms since firstSeen) get a fading highlight ring. */
  newWindowMs?: number;
  /** The operator's own callsign — its marker gets a distinct gold/star treatment. */
  myCall?: string;
}

const TILE_LAYERS: Record<'dark' | 'light', { url: string }> = {
  dark: {
    url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
  },
  light: {
    url: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
  },
};

interface QsoLine {
  from: [number, number];
  to: [number, number];
  dir: 'tx' | 'rx';
  km: number;
  peer: string;
}

export default function FTLeafletMap({ contacts, onSelect, selected, showTerminator = false, tileStyle = 'dark', newWindowMs = 0, myCall = '' }: Props) {
  const myCallUp = myCall.trim().toUpperCase();
  const [hoverCs, setHoverCs] = useState<string | null>(null);
  const tile = TILE_LAYERS[tileStyle];
  // Read once — MapContainer only honors center/zoom on initial mount, and
  // this component is never server-rendered (see the LS_MAP_VIEW comment above).
  const [savedView] = useState(() => loadMapView());
  const markers = Array.from(contacts.values()).filter(c => c.latLon);
  const selContact = selected ? contacts.get(selected) : undefined;

  // QSO lines for the hovered contact — one per peer per direction, drawn
  // from the transmitting end toward the receiving end
  const lines: QsoLine[] = [];
  const hovered = hoverCs ? contacts.get(hoverCs) : undefined;
  if (hovered?.latLon) {
    for (const p of hovered.peers) {
      const peer = contacts.get(p);
      if (!peer?.latLon) continue;
      const km = haversineKm(hovered.latLon, peer.latLon);
      if (hovered.msgs.some(m => m.role === 'tx' && m.parsed.callee === p)) {
        lines.push({ from: hovered.latLon, to: peer.latLon, dir: 'tx', km, peer: p });
      }
      if (hovered.msgs.some(m => m.role === 'rx' && m.parsed.caller === p)) {
        lines.push({ from: peer.latLon, to: hovered.latLon, dir: 'rx', km, peer: p });
      }
    }
  }
  const maxKm = lines.reduce((m, l) => Math.max(m, l.km), 0);

  return (
    <MapContainer
      center={savedView?.center ?? DEFAULT_CENTER}
      zoom={savedView?.zoom ?? DEFAULT_ZOOM}
      minZoom={0}
      maxZoom={12}
      zoomSnap={0.5}
      style={{ height: '100%', width: '100%' }}
      zoomControl={true}
      scrollWheelZoom={true}
    >
      <TileLayer
        key={tileStyle}
        url={tile.url}
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/attributions">CARTO</a>'
        subdomains="abcd"
        maxZoom={19}
      />
      <InvalidateOnShow />
      <AutoBounds count={markers.length} />
      <CenterOnUserLocation skip={savedView !== null} />
      <MapViewTracker />
      <FlyTo pos={selContact?.latLon ?? null} />
      {showTerminator && <DayNightOverlay />}

      {lines.map(l => {
        const color     = l.dir === 'tx' ? TX_COLOR : RX_COLOR;
        const isLongest = lines.length > 1 && l.km === maxKm;
        // tx arcs bow one way, rx the other, so paired lines between the same
        // two stations don't sit directly on top of each other
        const bend  = l.dir === 'tx' ? 0.12 : -0.12;
        const arc   = arcPoints(l.from, l.to, bend);
        const head  = arc[Math.round(arc.length * 0.92)];
        return (
          <Fragment key={`${l.peer}-${l.dir}`}>
            <Polyline
              positions={arc}
              pathOptions={{
                color,
                weight: isLongest ? 2.5 : 1.5,
                opacity: isLongest ? 0.85 : 0.5,
                lineCap: 'round',
              }}
            >
              <Tooltip sticky>
                <span style={{ fontFamily: 'monospace', fontSize: 11 }}>
                  {l.dir === 'tx' ? `${hoverCs} → ${l.peer}` : `${l.peer} → ${hoverCs}`}
                  {' · '}{Math.round(l.km).toLocaleString('en-US')} km
                  {isLongest ? ' · longest' : ''}
                </span>
              </Tooltip>
            </Polyline>
            <CircleMarker
              center={head}
              radius={isLongest ? 3.5 : 2.5}
              pathOptions={{ color, fillColor: color, fillOpacity: 1, weight: 0 }}
            />
          </Fragment>
        );
      })}

      {markers.map(c => {
        const [lat, lon] = c.latLon!;
        const txCount = c.msgs.filter(m => m.role === 'tx').length;
        const rxCount = c.msgs.filter(m => m.role === 'rx').length;
        const age = Date.now() - c.firstSeen.getTime();
        const isNew = newWindowMs > 0 && age < newWindowMs;
        const isMe  = !!myCallUp && c.callsign.toUpperCase() === myCallUp;
        return (
          <Marker
            key={c.callsign}
            position={[lat, lon]}
            icon={makeIcon(c.color, isNew ? newWindowMs - age : null, isMe, c.callsign === selected)}
            eventHandlers={{
              mouseover: () => setHoverCs(c.callsign),
              mouseout:  () => setHoverCs(prev => (prev === c.callsign ? null : prev)),
            }}
          >
            <Popup>
              <div style={{ fontFamily: 'monospace', minWidth: 110 }}>
                <div
                  style={{ color: c.color, fontWeight: 'bold', fontSize: 13, cursor: onSelect ? 'pointer' : undefined }}
                  title="Show contact details"
                  onClick={() => onSelect?.(c.callsign)}
                >
                  {c.callsign}
                </div>
                {c.grids.length > 0 && (
                  <div style={{ color: '#8b949e', fontSize: 11 }}>
                    {c.grids.join(' · ')}
                  </div>
                )}
                <div style={{ color: '#484f58', fontSize: 10, marginTop: 3 }}>
                  {txCount > 0 && <span>{txCount} tx</span>}
                  {txCount > 0 && rxCount > 0 && <span> · </span>}
                  {rxCount > 0 && <span>{rxCount} rx</span>}
                </div>
                {c.peers.size > 0 && (
                  <div style={{ color: '#484f58', fontSize: 10 }}>
                    worked:{' '}
                    {Array.from(c.peers).map(p => (
                      <span
                        key={p}
                        style={{ cursor: onSelect ? 'pointer' : undefined, textDecoration: 'underline', marginRight: 4 }}
                        onClick={() => onSelect?.(p)}
                      >
                        {p}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </Popup>
          </Marker>
        );
      })}
    </MapContainer>
  );
}
