'use client';

import dynamic from 'next/dynamic';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Contact, ContactMsg, MSG_TYPE_LABEL, MSG_TYPE_COLOR, generateADIF, gridToLatLon, haversineKm,
} from '@/lib/ft/parser';
import { GeoInfo, OperatorInfo, resolveGridLocation, lookupOperator } from '@/lib/ft/lookup';
import { callsignCountry } from '@/lib/ft/prefixes';
import type { FTMode } from '@/lib/ft/decoder';
import { fmtAbsHz } from '@/lib/formatFreq';

// Format a stored absolute frequency. Values > 1 MHz are already absolute (VFO
// was set at decode time); smaller values are raw audio offsets (no VFO then).
function formatMsgFreq(freq: number): string {
  if (freq <= 0) return '—';
  if (freq > 1_000_000) return fmtAbsHz(freq);
  return `${freq.toFixed(0)} Hz`;
}

// Loaded only in the browser — Leaflet must not run in SSR
const FTLeafletMap = dynamic(() => import('./FTLeafletMap'), {
  ssr: false,
  loading: () => (
    <div className="h-full flex items-center justify-center text-xs text-[#484f58] font-mono">
      Loading map…
    </div>
  ),
});

function utcHMS(d: Date): string { return d.toISOString().slice(11, 19); }

function gridWithFlag(grid: string, geoMap: Map<string, GeoInfo>): string {
  const flag = geoMap.get(grid)?.flag;
  return flag ? `${flag} ${grid}` : grid;
}

interface LocationParts {
  flag: string;
  country: string;
  grids: string;
}

function locationParts(contact: Contact, geoMap: Map<string, GeoInfo>): LocationParts | null {
  const geo     = contact.grid ? geoMap.get(contact.grid) : undefined;
  const pfx     = callsignCountry(contact.callsign);
  const flag    = geo?.flag ?? pfx?.flag ?? '';
  const country = geo?.country ?? pfx?.country ?? '';
  const grids   = contact.grid
    ? contact.grid + (contact.grids.length > 1 ? ` +${contact.grids.length - 1}` : '')
    : '';
  if (!flag && !country && !grids) return null;
  return { flag, country, grids };
}

// Keep the string version for places that already use it as text
function locationLabel(contact: Contact, geoMap: Map<string, GeoInfo>): string | null {
  const p = locationParts(contact, geoMap);
  if (!p) return null;
  const parts = [p.flag, p.country, p.grids].filter(Boolean);
  return parts.length ? parts.join(' ') : null;
}

function qrzUrl(callsign: string): string {
  return `https://www.qrz.com/db/${encodeURIComponent(callsign.split('/')[0])}`;
}

function formatKm(km: number): string {
  return `${Math.round(km).toLocaleString('en-US')} km`;
}


// All messages involving a specific peer with this contact, sorted by time
function conversationWith(contact: Contact, peer: string): ContactMsg[] {
  return contact.msgs
    .filter(m => {
      const other = m.role === 'tx' ? m.parsed.callee : m.parsed.caller;
      return other === peer || m.parsed.caller === peer;
    })
    .sort((a, b) => a.windowStart.getTime() - b.windowStart.getTime());
}

// Partial handshake: the contact transmitted to the peer AND received from the peer
function isHandshake(contact: Contact, peer: string): boolean {
  const msgs = conversationWith(contact, peer);
  const sentToPeer       = msgs.some(m => m.role === 'tx' && m.parsed.callee === peer);
  const receivedFromPeer = msgs.some(m => m.role === 'rx' && m.parsed.caller === peer);
  return sentToPeer && receivedFromPeer;
}

// Full QSO: handshake confirmed AND a signal report was exchanged AND the
// conversation ended with a sign-off (RR73 / RRR / 73)
function isFullQSO(contact: Contact, peer: string): boolean {
  if (!isHandshake(contact, peer)) return false;
  const types = conversationWith(contact, peer).map(m => m.parsed.type);
  const hasReport  = types.includes('report') || types.includes('r_report');
  const hasSignOff = types.includes('rr73') || types.includes('rrr') || types.includes('tx73');
  return hasReport && hasSignOff;
}

function longestDistances(contact: Contact, contactMap: Map<string, Contact>) {
  let tx: { km: number; peer: string } | null = null;
  let rx: { km: number; peer: string } | null = null;
  if (!contact.latLon) return { tx, rx };
  for (const m of contact.msgs) {
    const peer    = m.role === 'tx' ? m.parsed.callee : m.parsed.caller;
    const peerLoc = peer ? contactMap.get(peer)?.latLon : undefined;
    if (!peer || !peerLoc) continue;
    const km = haversineKm(contact.latLon, peerLoc);
    if (m.role === 'tx') { if (!tx || km > tx.km) tx = { km, peer }; }
    else                 { if (!rx || km > rx.km) rx = { km, peer }; }
  }
  return { tx, rx };
}

// ── Conversation balloon (portal — renders above all card overflow) ────────────

function ConversationBalloon({
  contact, peer, contactMap, pos,
}: {
  contact: Contact;
  peer: string;
  contactMap: Map<string, Contact>;
  pos: { top: number; left: number };
}) {
  const msgs        = conversationWith(contact, peer);
  const peerContact = contactMap.get(peer);
  const handshake   = isHandshake(contact, peer);
  const fullQSO     = isFullQSO(contact, peer);

  if (!msgs.length) return null;

  return createPortal(
    <div
      className="fixed z-[9999] w-72 bg-[#161b22] border border-[#30363d] rounded-lg shadow-2xl p-2.5 pointer-events-none"
      style={{ top: pos.top, left: pos.left }}
    >
      <div className="flex items-center gap-1.5 mb-1.5 border-b border-[#21262d] pb-1.5">
        <span className="font-mono font-bold text-[11px]" style={{ color: contact.color }}>
          {contact.callsign}
        </span>
        <span className="text-[#484f58] text-[10px]">↔</span>
        <span className="font-mono font-bold text-[11px]" style={{ color: peerContact?.color ?? '#8b949e' }}>
          {peer}
        </span>
        {fullQSO ? (
          <span className="ml-auto text-[10px]" title="Full QSO — report exchanged and signed off">⭐</span>
        ) : handshake ? (
          <span className="ml-auto text-[10px]" title="Partial handshake — both sides transmitted">🤝</span>
        ) : null}
      </div>
      <div className="space-y-0.5 max-h-52 overflow-y-auto">
        {msgs.map((m, i) => {
          const isTx = m.role === 'tx';
          return (
            <div key={i} className="flex items-start gap-1.5 font-mono text-[9px]">
              <span className="text-[#30363d] shrink-0 w-[44px]">{utcHMS(m.windowStart)}z</span>
              <span className="text-[#484f58] shrink-0 w-[60px]" title="Frequency">
                {formatMsgFreq(m.freq)}
              </span>
              <span
                className="shrink-0 px-1 rounded text-[8px] font-bold"
                style={{
                  background: `${MSG_TYPE_COLOR[m.parsed.type]}1a`,
                  color: MSG_TYPE_COLOR[m.parsed.type],
                }}
              >
                {isTx ? '▶' : '◀'}{MSG_TYPE_LABEL[m.parsed.type]}
              </span>
              <span
                className="truncate"
                style={{ color: isTx ? contact.color : peerContact?.color ?? '#8b949e', opacity: 0.9 }}
              >
                {m.raw}
              </span>
            </div>
          );
        })}
      </div>
    </div>,
    document.body,
  );
}

// ── Contact card ──────────────────────────────────────────────────────────────

function ContactCard({
  contact, expanded, onToggle, onSelect, contactMap, geoMap, op, myCall = '',
}: {
  contact: Contact;
  expanded: boolean;
  onToggle: () => void;
  onSelect: (callsign: string) => void;
  contactMap: Map<string, Contact>;
  geoMap: Map<string, GeoInfo>;
  op?: OperatorInfo;
  myCall?: string;
}) {
  const [hoveredPeer, setHoveredPeer] = useState<string | null>(null);
  const [balloonPos,  setBalloonPos]  = useState<{ top: number; left: number } | null>(null);
  const hoverTimeout                  = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cursorRef                     = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

  // Track cursor position precisely — read synchronously in hover handler
  useEffect(() => {
    const update = (e: MouseEvent) => { cursorRef.current = { x: e.clientX, y: e.clientY }; };
    window.addEventListener('mousemove', update, { passive: true });
    return () => window.removeEventListener('mousemove', update);
  }, []);

  const handlePeerEnter = (p: string) => {
    if (hoverTimeout.current) clearTimeout(hoverTimeout.current);
    const { x: cx, y: cy } = cursorRef.current;
    const vh  = window.innerHeight;
    const vw  = window.innerWidth;
    const bH  = 280;
    const bW  = 288; // w-72 = 18rem
    const top  = cy + 20 + bH > vh ? Math.max(4, cy - bH - 4) : cy + 20;
    const left = cx + 20 + bW > vw ? Math.max(4, cx - bW - 4) : cx + 20;
    setBalloonPos({ top, left });
    setHoveredPeer(p);
  };
  const handlePeerLeave = () => {
    hoverTimeout.current = setTimeout(() => {
      setHoveredPeer(null);
      setBalloonPos(null);
    }, 120);
  };

  const txMsgs = contact.msgs.filter(m => m.role === 'tx');
  const rxMsgs = contact.msgs.filter(m => m.role === 'rx');

  const groups: ContactMsg[][] = [];
  for (const m of contact.msgs) {
    const last = groups[groups.length - 1];
    if (last && last[0].raw === m.raw && last[0].role === m.role) last.push(m);
    else groups.push([m]);
  }
  const history = groups.slice(-12);

  const loc     = locationLabel(contact, geoMap);
  const locParts = locationParts(contact, geoMap);
  const longest = expanded ? longestDistances(contact, contactMap) : { tx: null, rx: null };

  // Split peers into groups
  const receivedFrom = new Set<string>();
  const repliedTo    = new Set<string>();
  for (const m of contact.msgs) {
    const peer = m.role === 'tx' ? m.parsed.callee : m.parsed.caller;
    if (!peer || peer === contact.callsign) continue;
    if (m.role === 'tx') repliedTo.add(peer);
    else receivedFrom.add(peer);
  }
  const handshakes = new Set(
    Array.from(repliedTo).filter(p => receivedFrom.has(p) && isHandshake(contact, p))
  );
  const fullQSOs = new Set(
    Array.from(handshakes).filter(p => isFullQSO(contact, p))
  );

  // QSO status with the local operator
  const myCallUp   = myCall.toUpperCase();
  const myQSOFull  = myCallUp ? isFullQSO(contact, myCallUp) : false;
  const myQSOPart  = myCallUp && !myQSOFull ? isHandshake(contact, myCallUp) : false;

  function PeerChip({ peer }: { peer: string }) {
    const pc = contactMap.get(peer);
    return (
      <span className="inline-block">
        <button
          onClick={() => onSelect(peer)}
          onMouseEnter={() => handlePeerEnter(peer)}
          onMouseLeave={handlePeerLeave}
          className="text-[9px] font-mono font-bold hover:underline"
          style={{ color: pc?.color ?? '#8b949e' }}
        >
          {peer}{pc?.grid ? ` ${gridWithFlag(pc.grid, geoMap)}` : ''}
        </button>
        {hoveredPeer === peer && balloonPos && (
          <ConversationBalloon
            contact={contact}
            peer={peer}
            contactMap={contactMap}
            pos={balloonPos}
          />
        )}
      </span>
    );
  }

  return (
    <div
      className="mb-1.5 rounded-md border border-[#21262d]"
      style={{ borderLeftColor: contact.color, borderLeftWidth: '3px' }}
    >
      {/* Summary row */}
      <div
        role="button"
        tabIndex={0}
        onClick={onToggle}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); } }}
        className="w-full text-left px-2.5 py-1.5 flex items-center gap-2 hover:bg-[#21262d]/40 transition-colors min-w-0 cursor-pointer"
      >
        <a
          href={qrzUrl(contact.callsign)}
          target="_blank"
          rel="noopener noreferrer"
          onClick={e => e.stopPropagation()}
          title={`${contact.callsign} on QRZ.com`}
          className="font-mono font-bold text-xs shrink-0 hover:underline"
          style={{ color: contact.color }}
        >
          {contact.callsign}
        </a>
        {/* QSO badge — only shown when the local operator has exchanged with this station */}
        {myQSOFull && (
          <span
            className="shrink-0 text-[9px] font-bold font-mono px-1 py-px rounded"
            style={{ background: 'rgba(46,160,67,0.15)', color: '#2ea043', border: '1px solid rgba(46,160,67,0.4)' }}
            title="Full QSO completed with you (signal reports + sign-off exchanged)"
          >
            QSO✓
          </span>
        )}
        {myQSOPart && (
          <span
            className="shrink-0 text-[9px] font-bold font-mono px-1 py-px rounded"
            style={{ background: 'rgba(227,179,65,0.15)', color: '#e3b341', border: '1px solid rgba(227,179,65,0.4)' }}
            title="Partial QSO — exchange started but not fully signed off"
          >
            QSO…
          </span>
        )}
        {locParts && (
          <span className="font-mono text-[10px] text-[#484f58] flex items-center gap-1 truncate min-w-0"
            title={contact.grids.map(g => gridWithFlag(g, geoMap)).join(' · ')}>
            {locParts.flag && (
              <span title={locParts.country} className="not-italic">{locParts.flag}</span>
            )}
            {locParts.grids && <span>({locParts.grids})</span>}
          </span>
        )}
        <span className="flex-1 min-w-0" />
        <span
          className="font-mono text-[11px] font-semibold text-[#2ea043] shrink-0"
          title="Messages transmitted by this station"
        >
          {txMsgs.length}tx
        </span>
        <span
          className="font-mono text-[11px] font-semibold text-[#79c0ff] shrink-0"
          title="Messages addressed to this station"
        >
          {rxMsgs.length}rx
        </span>
        <span
          className="font-mono text-[11px] font-semibold text-[#d2a8ff] shrink-0"
          title={`Worked ${contact.peers.size} station${contact.peers.size === 1 ? '' : 's'}`}
        >
          {contact.peers.size}w
        </span>
        <svg
          viewBox="0 0 20 20" fill="currentColor"
          className="shrink-0 text-[#484f58] ml-1 transition-transform duration-150"
          style={{ width: 10, height: 10, transform: expanded ? 'rotate(180deg)' : 'rotate(0)' }}
        >
          <path fillRule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clipRule="evenodd" />
        </svg>
      </div>

      {/* Expanded history */}
      {expanded && (
        <div className="border-t border-[#21262d] bg-[#0d1117]/70 px-2.5 py-2">
          {op && (op.name || op.email) && (
            <div className="mb-1.5 pb-1.5 border-b border-[#21262d] text-[10px] font-mono flex items-center gap-1.5 flex-wrap">
              <span className="text-[#484f58]">op:</span>
              {op.name && <span className="text-[#c9d1d9]">{op.name}</span>}
              {op.email && (
                <a href={`mailto:${op.email}`} className="text-[#79c0ff] hover:underline">{op.email}</a>
              )}
            </div>
          )}

          {contact.grids.length > 1 && (
            <div className="mb-1.5 pb-1.5 border-b border-[#21262d] text-[10px] font-mono flex items-center gap-1.5 flex-wrap">
              <span className="text-[#484f58]">grids:</span>
              {contact.grids.map(g => (
                <span key={g} className={g === contact.grid ? 'text-[#c9d1d9] font-bold' : 'text-[#8b949e]'}
                  title={g === contact.grid ? 'Most recent locator' : undefined}>
                  {gridWithFlag(g, geoMap)}
                </span>
              ))}
            </div>
          )}

          {(longest.tx || longest.rx) && (
            <div className="mb-1.5 pb-1.5 border-b border-[#21262d] text-[10px] font-mono flex flex-wrap gap-x-3 gap-y-0.5">
              {longest.tx && (
                <span title="Longest transmission — distance to the addressed station">
                  <span className="text-[#2ea043]">longest tx:</span>{' '}
                  <span className="text-[#c9d1d9]">{formatKm(longest.tx.km)}</span>{' '}
                  <button onClick={() => onSelect(longest.tx!.peer)}
                    className="font-bold hover:underline"
                    style={{ color: contactMap.get(longest.tx.peer)?.color ?? '#8b949e' }}>
                    → {longest.tx.peer}
                  </button>
                </span>
              )}
              {longest.rx && (
                <span title="Longest reception — distance to the transmitting station">
                  <span className="text-[#79c0ff]">longest rx:</span>{' '}
                  <span className="text-[#c9d1d9]">{formatKm(longest.rx.km)}</span>{' '}
                  <button onClick={() => onSelect(longest.rx!.peer)}
                    className="font-bold hover:underline"
                    style={{ color: contactMap.get(longest.rx.peer)?.color ?? '#8b949e' }}>
                    ← {longest.rx.peer}
                  </button>
                </span>
              )}
            </div>
          )}

          {history.length === 0 ? (
            <p className="text-[10px] font-mono text-[#484f58]">no messages</p>
          ) : (
            <div className="space-y-1">
              {history.map((group, i) => {
                const m      = group[group.length - 1];
                const isTx   = m.role === 'tx';
                const peerCs = isTx ? m.parsed.callee : m.parsed.caller;
                const peerColor    = peerCs ? contactMap.get(peerCs)?.color : undefined;
                const repeatsTitle = group.map(g => `${utcHMS(g.windowStart)}z  ${g.raw}`).join('\n');
                const gridLoc  = m.parsed.grid ? gridToLatLon(m.parsed.grid) : null;
                const otherLoc = isTx
                  ? (peerCs ? contactMap.get(peerCs)?.latLon : undefined)
                  : contact.latLon;
                const km = gridLoc && otherLoc ? haversineKm(gridLoc, otherLoc) : null;
                return (
                  <div key={i} className="font-mono text-[10px] flex items-center gap-1.5 min-w-0">
                    <span className="text-[#30363d] shrink-0 w-[56px]">{utcHMS(m.windowStart)}z</span>
                    <span className="text-[#484f58] shrink-0 w-[60px]" title="Frequency">
                      {formatMsgFreq(m.freq)}
                    </span>
                    {isTx ? (
                      <span
                        className="shrink-0 px-1 py-px rounded text-[8px] font-bold w-[34px] text-center"
                        style={{ background: `${MSG_TYPE_COLOR[m.parsed.type]}1a`, color: MSG_TYPE_COLOR[m.parsed.type] }}
                      >
                        {MSG_TYPE_LABEL[m.parsed.type]}
                      </span>
                    ) : (
                      <span
                        className="shrink-0 px-1 py-px rounded text-[8px] font-bold w-[34px] text-center border"
                        style={{
                          background: `${MSG_TYPE_COLOR[m.parsed.type]}11`,
                          color: MSG_TYPE_COLOR[m.parsed.type],
                          borderColor: `${MSG_TYPE_COLOR[m.parsed.type]}30`,
                        }}
                      >
                        ←{MSG_TYPE_LABEL[m.parsed.type]}
                      </span>
                    )}
                    <span
                      className="text-[#8b949e] truncate"
                      title={group.length > 1 ? repeatsTitle : m.raw}
                      style={{ color: isTx ? contact.color : peerColor ?? '#8b949e', opacity: isTx ? 0.85 : 0.55 }}
                    >
                      {m.raw}
                    </span>
                    {km !== null && (
                      <span className="shrink-0 text-[9px] text-[#484f58]">{formatKm(km)}</span>
                    )}
                    {group.length > 1 && (
                      <span className="shrink-0 px-1 py-px rounded text-[8px] font-bold bg-[#30363d] text-[#8b949e] cursor-help" title={repeatsTitle}>
                        ×{group.length}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* Peers — grouped as Full QSOs / Handshakes / Received from / Replied to */}
          {contact.peers.size > 0 && (
            <div className="mt-2 pt-1.5 border-t border-[#21262d] space-y-1.5">
              {fullQSOs.size > 0 && (
                <div>
                  <span className="text-[9px] text-[#e3b341] font-mono font-semibold block mb-0.5">
                    ⭐ full QSO ({fullQSOs.size})
                  </span>
                  <div className="flex flex-wrap gap-x-2 gap-y-0.5 pl-3">
                    {Array.from(fullQSOs).map(p => <PeerChip key={p} peer={p} />)}
                  </div>
                </div>
              )}

              {Array.from(handshakes).some(p => !fullQSOs.has(p)) && (
                <div>
                  <span className="text-[9px] text-[#d2a8ff] font-mono font-semibold block mb-0.5">
                    🤝 handshake ({Array.from(handshakes).filter(p => !fullQSOs.has(p)).length})
                  </span>
                  <div className="flex flex-wrap gap-x-2 gap-y-0.5 pl-3">
                    {Array.from(handshakes).filter(p => !fullQSOs.has(p)).map(p => <PeerChip key={p} peer={p} />)}
                  </div>
                </div>
              )}

              {receivedFrom.size > 0 && Array.from(receivedFrom).some(p => !handshakes.has(p)) && (
                <div>
                  <span className="text-[9px] text-[#79c0ff] font-mono font-semibold block mb-0.5">
                    ← received from ({Array.from(receivedFrom).filter(p => !handshakes.has(p)).length})
                  </span>
                  <div className="flex flex-wrap gap-x-2 gap-y-0.5 pl-3">
                    {Array.from(receivedFrom).filter(p => !handshakes.has(p)).map(p => <PeerChip key={p} peer={p} />)}
                  </div>
                </div>
              )}

              {repliedTo.size > 0 && Array.from(repliedTo).some(p => !handshakes.has(p)) && (
                <div>
                  <span className="text-[9px] text-[#2ea043] font-mono font-semibold block mb-0.5">
                    → replied to ({Array.from(repliedTo).filter(p => !handshakes.has(p)).length})
                  </span>
                  <div className="flex flex-wrap gap-x-2 gap-y-0.5 pl-3">
                    {Array.from(repliedTo).filter(p => !handshakes.has(p)).map(p => <PeerChip key={p} peer={p} />)}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Panel ─────────────────────────────────────────────────────────────────────

interface Props {
  contacts: Map<string, Contact>;
  mode: FTMode;
  myCall?: string;
  onClearContacts: () => void;
  focus?: { cs: string; n: number } | null;
}

type SortKey = 'date' | 'tx' | 'rx' | 'worked' | 'alpha';
type QuickFilter = 'full-qso' | 'handshake' | 'tx-only' | 'rx-only' | string; // string = country code

const SORT_OPTIONS: Array<{ key: SortKey; label: string }> = [
  { key: 'date',   label: 'time' },
  { key: 'tx',     label: 'tx' },
  { key: 'rx',     label: 'rx' },
  { key: 'worked', label: 'worked' },
  { key: 'alpha',  label: 'a–z' },
];

export default function FTContactsPanel({ contacts, mode, myCall = '', onClearContacts, focus }: Props) {
  const [expanded,      setExpanded]      = useState<string | null>(null);
  const [sortKey,       setSortKey]       = useState<SortKey>('date');
  const [sortRev,       setSortRev]       = useState(false);
  const [query,         setQuery]         = useState('');
  const [quickFilter,   setQuickFilter]   = useState<QuickFilter | null>(null);
  const [mapHeight,     setMapHeight]     = useState(160);
  const panelRef    = useRef<HTMLDivElement>(null);
  const mapDragRef  = useRef<{ startY: number; startH: number } | null>(null);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const d = mapDragRef.current;
      if (!d || !panelRef.current) return;
      const panelH = panelRef.current.offsetHeight;
      const maxH   = Math.floor(panelH * 0.5);
      const newH   = Math.max(80, Math.min(maxH, d.startH + (e.clientY - d.startY)));
      setMapHeight(newH);
    };
    const onUp = () => { mapDragRef.current = null; };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup',   onUp);
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
  }, []);

  const [geoMap, setGeoMap] = useState<Map<string, GeoInfo>>(new Map());
  const [opMap,  setOpMap]  = useState<Map<string, OperatorInfo>>(new Map());
  const geoRequested = useRef(new Set<string>());
  const opRequested  = useRef(new Set<string>());

  const cardRefs = useRef(new Map<string, HTMLDivElement>());

  useEffect(() => {
    for (const c of contacts.values()) {
      for (const grid of c.grids) {
        if (geoRequested.current.has(grid)) continue;
        const latLon = gridToLatLon(grid);
        if (!latLon) continue;
        geoRequested.current.add(grid);
        resolveGridLocation(grid, latLon).then(info => {
          if (info) setGeoMap(prev => new Map(prev).set(grid, info));
        });
      }
      if (!opRequested.current.has(c.callsign)) {
        opRequested.current.add(c.callsign);
        const callsign = c.callsign;
        lookupOperator(callsign).then(info => {
          if (info) setOpMap(prev => new Map(prev).set(callsign, info));
        });
      }
    }
  }, [contacts]);

  const select = useCallback((callsign: string) => {
    if (contacts.has(callsign)) setExpanded(callsign);
  }, [contacts]);

  useEffect(() => {
    if (expanded) {
      cardRefs.current.get(expanded)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [expanded]);

  useEffect(() => {
    if (focus && contacts.has(focus.cs)) setExpanded(focus.cs);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus]);

  const txCount = (c: Contact) => c.msgs.filter(m => m.role === 'tx').length;
  const rxCount = (c: Contact) => c.msgs.filter(m => m.role === 'rx').length;

  // Build the list of unique countries for the quick-filter chips, with counts
  const countryOptions = Array.from(
    Array.from(contacts.values()).reduce((acc, c) => {
      const geo = c.grid ? geoMap.get(c.grid) : undefined;
      const pfx = callsignCountry(c.callsign);
      const flag    = geo?.flag ?? pfx?.flag;
      const country = geo?.country ?? pfx?.country;
      const code    = geo?.countryCode ?? pfx?.countryCode;
      if (code && country && flag) {
        const existing = acc.get(code);
        acc.set(code, existing
          ? { ...existing, count: existing.count + 1 }
          : { code, country, flag, count: 1 });
      }
      return acc;
    }, new Map<string, { code: string; country: string; flag: string; count: number }>())
  .values()).sort((a, b) => b.count - a.count || a.country.localeCompare(b.country));

  const sorted = Array.from(contacts.values()).sort((a, b) => {
    let cmp: number;
    if (sortKey === 'date')        cmp = b.lastSeen.getTime() - a.lastSeen.getTime();
    else if (sortKey === 'tx')     cmp = txCount(b) - txCount(a);
    else if (sortKey === 'rx')     cmp = rxCount(b) - rxCount(a);
    else if (sortKey === 'worked') cmp = b.peers.size - a.peers.size;
    else                           cmp = a.callsign.localeCompare(b.callsign);
    return sortRev ? -cmp : cmp;
  });

  // Apply quick filter
  const quickFiltered = quickFilter
    ? sorted.filter(c => {
        if (quickFilter === 'full-qso') {
          return Array.from(c.peers).some(p => isFullQSO(c, p));
        }
        if (quickFilter === 'handshake') {
          return Array.from(c.peers).some(p => isHandshake(c, p) && !isFullQSO(c, p));
        }
        if (quickFilter === 'tx-only') {
          return txCount(c) > 0 && rxCount(c) === 0;
        }
        if (quickFilter === 'rx-only') {
          return rxCount(c) > 0 && txCount(c) === 0;
        }
        // country code filter
        const geo = c.grid ? geoMap.get(c.grid) : undefined;
        const pfx = callsignCountry(c.callsign);
        const code = geo?.countryCode ?? pfx?.countryCode;
        return code === quickFilter;
      })
    : sorted;

  // Free-text search on top
  const q        = query.trim().toLowerCase();
  const filtered = q
    ? quickFiltered.filter(c => {
        const op  = opMap.get(c.callsign);
        const pfx = callsignCountry(c.callsign);
        const geoFields = c.grids.flatMap(g => {
          const geo = geoMap.get(g);
          return [geo?.country, geo?.countryCode];
        });
        return [c.callsign, ...c.grids, ...geoFields, pfx?.country, pfx?.countryCode, op?.name]
          .some(s => s?.toLowerCase().includes(q));
      })
    : quickFiltered;

  const withLocation   = sorted.filter(c => c.latLon).length;
  const fullQSOCount   = sorted.filter(c => Array.from(c.peers).some(p => isFullQSO(c, p))).length;
  const handshakeCount = sorted.filter(c => Array.from(c.peers).some(p => isHandshake(c, p) && !isFullQSO(c, p))).length;
  const txOnlyCount    = sorted.filter(c => txCount(c) > 0 && rxCount(c) === 0).length;
  const rxOnlyCount    = sorted.filter(c => rxCount(c) > 0 && txCount(c) === 0).length;

  function downloadADIF() {
    const content = generateADIF(contacts, mode);
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `ft-log-${new Date().toISOString().slice(0, 10)}.adi`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  return (
    <div ref={panelRef} className="flex flex-col h-full min-h-0">
      {/* Header */}
      <div className="flex items-center justify-between mb-2 shrink-0 gap-2">
        <h2 className="text-lg sm:text-xl font-semibold">Contacts</h2>
        <div className="flex items-center gap-1.5 flex-wrap justify-end">
          <span className="text-xs font-mono text-[#8b949e]">
            {q || quickFilter ? `${filtered.length}/${contacts.size} shown` : `${contacts.size} found`}
            {withLocation > 0 && <span className="text-[#484f58]"> · {withLocation} located</span>}
          </span>
          {contacts.size > 0 && (
            <>
              <button
                onClick={downloadADIF}
                className="text-xs px-2 py-0.5 rounded border border-[#30363d] text-[#8b949e] hover:text-[#79c0ff] hover:border-[#79c0ff]/40 transition-colors font-mono"
                title="Download ADIF log (.adi)"
              >
                .adi
              </button>
              <button
                onClick={onClearContacts}
                className="text-xs px-2 py-0.5 rounded border border-[#30363d] text-[#8b949e] hover:text-[#f85149] hover:border-[#f85149]/40 transition-colors font-mono"
              >
                Clear
              </button>
            </>
          )}
        </div>
      </div>

      {/* Map */}
      <div className="shrink-0 mb-0">
        <div className="text-[10px] text-[#484f58] font-mono mb-1 flex items-center justify-between">
          <span>World Map</span>
          <span className="text-[#30363d]">
            {withLocation > 0 ? `${withLocation} located` : 'no positions yet'}
          </span>
        </div>
        <div className="rounded overflow-hidden border border-[#21262d]" style={{ height: mapHeight }}>
          <FTLeafletMap contacts={contacts} onSelect={select} geoMap={geoMap} selected={expanded} />
        </div>
        {/* Drag handle to resize map */}
        <div
          className="h-2 flex items-center justify-center cursor-ns-resize group mb-1.5"
          onMouseDown={e => {
            e.preventDefault();
            mapDragRef.current = { startY: e.clientY, startH: mapHeight };
          }}
        >
          <div className="w-8 h-0.5 rounded-full bg-[#30363d] group-hover:bg-[#2ea043]/60 transition-colors" />
        </div>
      </div>

      {/* Search filter */}
      {contacts.size > 0 && (
        <div className="mb-1.5 shrink-0 relative">
          <input
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search callsign, grid, city, country…"
            className="w-full bg-[#0d1117] border border-[#30363d] rounded px-2 py-1 text-xs font-mono text-[#c9d1d9] placeholder-[#484f58] focus:outline-none focus:border-[#2ea043] transition-colors"
          />
          {query && (
            <button
              onClick={() => setQuery('')}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[#484f58] hover:text-[#c9d1d9] text-xs px-1"
              title="Clear search"
            >
              ✕
            </button>
          )}
        </div>
      )}

      {/* Quick filter chips */}
      {contacts.size > 0 && (
        <div className="mb-1.5 shrink-0 flex flex-wrap gap-1">
          {fullQSOCount > 0 && (
            <button
              onClick={() => setQuickFilter(f => f === 'full-qso' ? null : 'full-qso')}
              className={`text-[9px] font-mono px-1.5 py-0.5 rounded border transition-colors ${
                quickFilter === 'full-qso'
                  ? 'border-[#e3b341]/50 text-[#e3b341] bg-[#e3b341]/10'
                  : 'border-[#30363d] text-[#8b949e] hover:text-[#e3b341] hover:border-[#e3b341]/30'
              }`}
              title="Show contacts with a complete QSO (report exchanged and signed off)"
            >
              ⭐ full QSO <span className="opacity-60">{fullQSOCount}</span>
            </button>
          )}
          {handshakeCount > 0 && (
            <button
              onClick={() => setQuickFilter(f => f === 'handshake' ? null : 'handshake')}
              className={`text-[9px] font-mono px-1.5 py-0.5 rounded border transition-colors ${
                quickFilter === 'handshake'
                  ? 'border-[#d2a8ff]/50 text-[#d2a8ff] bg-[#d2a8ff]/10'
                  : 'border-[#30363d] text-[#8b949e] hover:text-[#d2a8ff] hover:border-[#d2a8ff]/30'
              }`}
              title="Show contacts with a partial handshake (both sides transmitted, not yet complete)"
            >
              🤝 handshake <span className="opacity-60">{handshakeCount}</span>
            </button>
          )}
          {txOnlyCount > 0 && (
            <button
              onClick={() => setQuickFilter(f => f === 'tx-only' ? null : 'tx-only')}
              className={`text-[9px] font-mono px-1.5 py-0.5 rounded border transition-colors ${
                quickFilter === 'tx-only'
                  ? 'border-[#2ea043]/50 text-[#2ea043] bg-[#2ea043]/10'
                  : 'border-[#30363d] text-[#8b949e] hover:text-[#2ea043] hover:border-[#2ea043]/30'
              }`}
              title="Show stations that transmitted only (no messages addressed to them)"
            >
              tx only <span className="opacity-60">{txOnlyCount}</span>
            </button>
          )}
          {rxOnlyCount > 0 && (
            <button
              onClick={() => setQuickFilter(f => f === 'rx-only' ? null : 'rx-only')}
              className={`text-[9px] font-mono px-1.5 py-0.5 rounded border transition-colors ${
                quickFilter === 'rx-only'
                  ? 'border-[#79c0ff]/50 text-[#79c0ff] bg-[#79c0ff]/10'
                  : 'border-[#30363d] text-[#8b949e] hover:text-[#79c0ff] hover:border-[#79c0ff]/30'
              }`}
              title="Show stations seen only as addressees (never transmitted)"
            >
              rx only <span className="opacity-60">{rxOnlyCount}</span>
            </button>
          )}
          {countryOptions.map(({ code, country, flag, count }) => (
            <button
              key={code}
              onClick={() => setQuickFilter(f => f === code ? null : code)}
              title={country}
              className={`text-[9px] font-mono px-1.5 py-0.5 rounded border transition-colors ${
                quickFilter === code
                  ? 'border-[#e3b341]/50 text-[#e3b341] bg-[#e3b341]/10'
                  : 'border-[#30363d] text-[#8b949e] hover:text-[#e3b341] hover:border-[#e3b341]/30'
              }`}
            >
              {flag} {code} <span className="opacity-60">{count}</span>
            </button>
          ))}
          {quickFilter && (
            <button
              onClick={() => setQuickFilter(null)}
              className="text-[9px] font-mono px-1.5 py-0.5 rounded border border-[#30363d] text-[#484f58] hover:text-[#c9d1d9]"
              title="Clear filter"
            >
              ✕ clear
            </button>
          )}
        </div>
      )}

      {/* Sort controls */}
      {contacts.size > 1 && (
        <div className="flex items-center gap-1 mb-1.5 shrink-0 flex-wrap">
          <span className="text-[9px] text-[#484f58] font-mono">sort:</span>
          {SORT_OPTIONS.map(({ key, label }) => (
            <button
              key={key}
              onClick={() => {
                if (sortKey === key) setSortRev(r => !r);
                else { setSortKey(key); setSortRev(false); }
              }}
              title={sortKey === key ? 'Click again to reverse' : `Sort by ${label}`}
              className={`text-[9px] font-mono px-1.5 py-0.5 rounded border transition-colors ${
                sortKey === key
                  ? 'border-[#2ea043]/50 text-[#2ea043] bg-[#2ea043]/10'
                  : 'border-[#30363d] text-[#8b949e] hover:text-[#c9d1d9]'
              }`}
            >
              {label}{sortKey === key ? (sortRev ? ' ↑' : ' ↓') : ''}
            </button>
          ))}
        </div>
      )}

      {/* Contact list */}
      <div className="flex-1 overflow-y-auto min-h-0 max-h-[50vh] lg:max-h-none">
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-28 gap-2">
            <div className="text-3xl select-none">{q || quickFilter ? '🔍' : '🌍'}</div>
            <div className="text-xs text-[#484f58] font-mono">
              {q ? `No contacts match "${query.trim()}"` : quickFilter ? 'No contacts match this filter' : 'No contacts yet'}
            </div>
          </div>
        ) : (
          filtered.map(c => (
            <div
              key={c.callsign}
              ref={el => {
                if (el) cardRefs.current.set(c.callsign, el);
                else cardRefs.current.delete(c.callsign);
              }}
            >
              <ContactCard
                contact={c}
                expanded={expanded === c.callsign}
                onToggle={() => setExpanded(p => p === c.callsign ? null : c.callsign)}
                onSelect={select}
                contactMap={contacts}
                geoMap={geoMap}
                op={opMap.get(c.callsign)}
                myCall={myCall}
              />
            </div>
          ))
        )}
      </div>
    </div>
  );
}
