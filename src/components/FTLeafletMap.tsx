'use client';

// This file is loaded via dynamic() with { ssr: false } — safe to import Leaflet here
import { Fragment, useEffect, useState } from 'react';
import { MapContainer, TileLayer, Marker, Popup, Polyline, CircleMarker, Tooltip, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { Contact, haversineKm } from '@/lib/ft/parser';

// QSO line colors by direction relative to the hovered station
const TX_COLOR = '#2ea043'; // hovered station transmitting (solid)
const RX_COLOR = '#79c0ff'; // hovered station receiving (dashed)

function makeIcon(color: string) {
  return L.divIcon({
    className: '',
    html: `<div style="width:11px;height:11px;background:${color};border:2px solid rgba(0,0,0,0.55);border-radius:50%;box-shadow:0 0 7px ${color}88;"></div>`,
    iconSize: [11, 11],
    iconAnchor: [5, 5],
    popupAnchor: [0, -9],
  });
}

// Invalidate size when the container becomes visible (handles hidden-panel mount).
function InvalidateOnShow() {
  const map = useMap();
  useEffect(() => {
    const container = map.getContainer();
    if (container.offsetWidth > 0 && container.offsetHeight > 0) {
      map.invalidateSize();
      return;
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

interface Props {
  contacts: Map<string, Contact>;
  onSelect?: (callsign: string) => void;
  selected?: string | null;
}

interface QsoLine {
  from: [number, number];
  to: [number, number];
  dir: 'tx' | 'rx';
  km: number;
  peer: string;
}

export default function FTLeafletMap({ contacts, onSelect, selected }: Props) {
  const [hoverCs, setHoverCs] = useState<string | null>(null);
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
      center={[20, 10]}
      zoom={1.5}
      minZoom={0}
      maxZoom={12}
      zoomSnap={0.5}
      style={{ height: '100%', width: '100%' }}
      zoomControl={false}
      scrollWheelZoom={true}
    >
      <TileLayer
        url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/attributions">CARTO</a>'
        subdomains="abcd"
        maxZoom={19}
      />
      <InvalidateOnShow />
      <AutoBounds count={markers.length} />
      <FlyTo pos={selContact?.latLon ?? null} />
      {selContact?.latLon && (
        <CircleMarker
          center={selContact.latLon}
          radius={11}
          pathOptions={{ color: selContact.color, weight: 2, fill: false, opacity: 0.9, dashArray: '4 4' }}
        />
      )}

      {lines.map(l => {
        const color     = l.dir === 'tx' ? TX_COLOR : RX_COLOR;
        const isLongest = lines.length > 1 && l.km === maxKm;
        // Direction cue: a dot near the receiving end of the line
        const head: [number, number] = [
          l.from[0] + (l.to[0] - l.from[0]) * 0.85,
          l.from[1] + (l.to[1] - l.from[1]) * 0.85,
        ];
        return (
          <Fragment key={`${l.peer}-${l.dir}`}>
            <Polyline
              positions={[l.from, l.to]}
              pathOptions={{
                color,
                weight: isLongest ? 3.5 : 2,
                opacity: isLongest ? 0.95 : 0.6,
                dashArray: l.dir === 'rx' ? '6 6' : undefined,
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
              radius={isLongest ? 4 : 3}
              pathOptions={{ color, fillColor: color, fillOpacity: 1, weight: 1 }}
            />
          </Fragment>
        );
      })}

      {markers.map(c => {
        const [lat, lon] = c.latLon!;
        const txCount = c.msgs.filter(m => m.role === 'tx').length;
        const rxCount = c.msgs.filter(m => m.role === 'rx').length;
        return (
          <Marker
            key={c.callsign}
            position={[lat, lon]}
            icon={makeIcon(c.color)}
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
