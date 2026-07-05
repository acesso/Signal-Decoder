'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  useFTTransmit, TxQueueEntry, loadMyCall, saveMyCall, loadMyGrid, saveMyGrid,
  loadAutoReply, saveAutoReply, loadBaseFreq, saveBaseFreq,
} from '@/hooks/useFTTransmit';
import { buildFTMessage, nextTxMsgType, parseFTMsg, isValidCallsign, Contact, MsgType, MSG_TYPE_COLOR, MSG_TYPE_LABEL, gridToLatLon, haversineKm } from '@/lib/ft/parser';
import { callsignCountry } from '@/lib/ft/prefixes';
import { FT_WINDOW_SECONDS, type FTMode } from '@/lib/ft/decoder';
import { fmtAbsHz } from '@/lib/formatFreq';

// rAF-driven hook: returns seconds until next window boundary, updated at ~4 Hz
function useWindowCountdown(windowSec: number): number {
  const [secs, setSecs] = useState(0);
  useEffect(() => {
    let raf: number;
    let last = -1;
    const tick = () => {
      const totalMs = windowSec * 1000;
      const now = new Date();
      const elapsed = (now.getSeconds() * 1000 + now.getMilliseconds()) % totalMs;
      const remaining = (totalMs - elapsed) / 1000;
      const rounded = Math.ceil(remaining * 100) / 100; // 0.01s resolution
      if (rounded !== last) { last = rounded; setSecs(rounded); }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [windowSec]);
  return secs;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function uid() { return Math.random().toString(36).slice(2, 9); }

const GRID_RE = /^[A-R]{2}[0-9]{2}([A-X]{2})?$/i;
const CALL_RE = /^[A-Z0-9]{1,3}[0-9][A-Z]{1,4}(\/[A-Z0-9]+)?$/i;

function validCall(s: string) { return CALL_RE.test(s.trim().toUpperCase()); }
function validGrid(s: string) { return s === '' || GRID_RE.test(s.trim().toUpperCase()); }

// Convert lat/lon to 4-char Maidenhead grid square
function latLonToGrid(lat: number, lon: number): string {
  const adjLon = lon + 180;
  const adjLat = lat + 90;
  const fieldLon = Math.floor(adjLon / 20);
  const fieldLat = Math.floor(adjLat / 10);
  const squareLon = Math.floor((adjLon % 20) / 2);
  const squareLat = Math.floor(adjLat % 10);
  return String.fromCharCode(65 + fieldLon) +
         String.fromCharCode(65 + fieldLat) +
         squareLon.toString() +
         squareLat.toString();
}

const STATUS_COLOR: Record<string, string> = {
  idle:     '#484f58',
  waiting:  '#e3b341',
  encoding: '#58a6ff',
  playing:  '#2ea043',
};
const STATUS_LABEL: Record<string, string> = {
  idle:     'IDLE',
  waiting:  'WAIT',
  encoding: 'ENC',
  playing:  'TX',
};

// ── TX window progress ring (rAF-driven) ──────────────────────────────────────

function TxRing({ status, windowSec, playing }: { status: string; windowSec: number; playing: boolean }) {
  const svgRef  = useRef<SVGSVGElement>(null);
  const rafRef  = useRef<number | null>(null);
  const prevRef = useRef('');
  const r = 28, cx = 36, cy = 36;
  const circ = 2 * Math.PI * r;

  useEffect(() => {
    const tick = () => {
      const svg = svgRef.current;
      if (!svg) { rafRef.current = requestAnimationFrame(tick); return; }

      const totalMs  = windowSec * 1000;
      const now      = new Date();
      const elapsed  = (now.getSeconds() * 1000 + now.getMilliseconds()) % totalMs;
      const progress = elapsed / totalMs;
      const nextMs   = totalMs - elapsed;
      const secVal   = (nextMs / 1000).toFixed(1);

      if (secVal === prevRef.current) { rafRef.current = requestAnimationFrame(tick); return; }
      prevRef.current = secVal;

      const color  = STATUS_COLOR[status] ?? '#484f58';
      const filled = circ * progress;

      svg.querySelector<SVGCircleElement>('.tx-arc')?.setAttribute('stroke', color);
      svg.querySelector<SVGCircleElement>('.tx-arc')?.setAttribute('stroke-dasharray', `${filled} ${circ - filled}`);
      const sec = svg.querySelector<SVGTextElement>('.tx-sec');
      if (sec) sec.textContent = status === 'idle' ? '--' : secVal;
      const lbl = svg.querySelector<SVGTextElement>('.tx-lbl');
      if (lbl) { lbl.setAttribute('fill', color); lbl.textContent = STATUS_LABEL[status] ?? status.toUpperCase(); }

      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, [status, windowSec, circ]);

  const initColor = STATUS_COLOR[status] ?? '#484f58';

  return (
    <svg ref={svgRef} width={72} height={72} viewBox="0 0 72 72" className="shrink-0">
      {/* Pulsing outer ring when actively transmitting */}
      {playing && (
        <circle cx={cx} cy={cy} r={r + 6} fill="none" stroke="#2ea043" strokeWidth={2}
          opacity={0.4} className="animate-ping" style={{ animationDuration: '1s' }} />
      )}
      <circle cx={cx} cy={cy} r={r} fill="none" stroke="#21262d" strokeWidth={5} />
      <circle className="tx-arc" cx={cx} cy={cy} r={r} fill="none"
        stroke={initColor} strokeWidth={5}
        strokeDasharray={`0 ${circ}`} strokeDashoffset={circ * 0.25} />
      <text className="tx-lbl" x={cx} y={cy - 4} textAnchor="middle" fontSize={7.5}
        fill={initColor} fontFamily="monospace" fontWeight="bold">
        {STATUS_LABEL[status] ?? status.toUpperCase()}
      </text>
      <text x={cx} y={cy + 7} textAnchor="middle" fontSize={11} fill="#c9d1d9"
        fontFamily="monospace" fontWeight="bold">
        <tspan className="tx-sec">{status === 'idle' ? '--' : '0.0'}</tspan>
      </text>
      <text x={cx} y={cy + 16} textAnchor="middle" fontSize={7} fill="#484f58" fontFamily="monospace">
        {status !== 'idle' ? `/${windowSec}s` : ''}
      </text>
    </svg>
  );
}

// ── Output device selector ────────────────────────────────────────────────────

function OutputSelector({ value, onChange, supported }: {
  value: string; onChange: (id: string) => void; supported: boolean;
}) {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);

  useEffect(() => {
    if (!supported) return;
    navigator.mediaDevices.enumerateDevices()
      .then(all => setDevices(all.filter(d => d.kind === 'audiooutput')))
      .catch(() => null);
  }, [supported]);

  if (!supported) {
    return <span className="text-[#484f58] text-xs font-mono">Output selection requires Chrome 110+</span>;
  }

  return (
    <select value={value} onChange={e => onChange(e.target.value)}
      className="bg-[#0d1117] border border-[#30363d] rounded px-2 py-1 text-xs text-[#c9d1d9] font-mono focus:outline-none focus:border-[#388bfd]">
      <option value="">System default</option>
      {devices.map(d => (
        <option key={d.deviceId} value={d.deviceId}>
          {d.label || `Output ${d.deviceId.slice(0, 8)}`}
        </option>
      ))}
    </select>
  );
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
  countryCode?: string;
  // true when the contact has directly addressed our callsign — warrants highlight
  repliedToMe: boolean;
  // recent exchange thread for this contact (newest last, up to ~4 entries)
  thread: QSOStep[];
  // for sorting
  maxSnr: number;
  latLon?: [number, number];
}

// Priority: stations actively in QSO with us rank above stations we merely heard.
function contactPriority(c: Contact, myCall: string): number {
  const myCallUp = myCall.toUpperCase();
  const repliedToUs = c.msgs.some(m => m.role === 'tx' && m.parsed.callee?.toUpperCase() === myCallUp);
  return repliedToUs ? 1 : 0;
}

function buildSuggestions(myCall: string, myGrid: string, contacts: Map<string, Contact>): Suggestion[] {
  const sugs: Suggestion[] = [];

  sugs.push({
    type: 'cq',
    message: buildFTMessage('cq', myCall, '', undefined, myGrid),
    label: 'CQ',
    repliedToMe: false,
    thread: [],
    maxSnr: -99,
  });

  const candidates = [...contacts.values()]
    .filter(c => isValidCallsign(c.callsign) && c.callsign.toUpperCase() !== myCall.toUpperCase())
    .sort((a, b) => {
      const pd = contactPriority(b, myCall) - contactPriority(a, myCall);
      if (pd !== 0) return pd;
      return b.lastSeen.getTime() - a.lastSeen.getTime();
    });

  const myCallUp = myCall.toUpperCase();

  for (const c of candidates) {
    const theirMsgs  = c.msgs.filter(m => m.role === 'tx');
    const replieToUs = theirMsgs.filter(m => m.parsed.callee?.toUpperCase() === myCallUp);
    const ourMsgs    = c.msgs.filter(m => m.role === 'rx' && m.parsed.caller?.toUpperCase() === myCallUp);

    const repliedToMe   = replieToUs.length > 0;
    const lastTheirMsg  = replieToUs[replieToUs.length - 1] ?? theirMsgs[theirMsgs.length - 1];
    const lastOurMsg    = ourMsgs[ourMsgs.length - 1];
    const lastRx        = lastTheirMsg?.parsed.type ?? null;
    const lastSent      = lastOurMsg?.parsed.type ?? null;

    let nextTxType: ReturnType<typeof nextTxMsgType>;
    if (!lastSent) {
      nextTxType = 'answer';
    } else {
      nextTxType = nextTxMsgType(lastSent, lastRx);
      if (nextTxType === 'cq') continue;
    }

    // Use best SNR across all their messages to us (not just the latest)
    const bestSnr  = replieToUs.length
      ? replieToUs.reduce((best, m) => m.snr > best ? m.snr : best, -99)
      : (lastTheirMsg ? lastTheirMsg.snr : 0);
    const reportDb = Math.round(bestSnr);
    const message  = buildFTMessage(nextTxType, myCall, c.callsign, reportDb, myGrid);

    // Build exchange thread: interleave their direct messages and our replies,
    // sorted by time, keep the last 4 entries.
    const threadMsgs: Array<{ t: Date; raw: string; mine: boolean; snr?: number }> = [
      ...repliedToMe
        ? replieToUs.map(m => ({ t: m.windowStart, raw: m.raw, mine: false, snr: m.snr }))
        : theirMsgs.slice(-2).map(m => ({ t: m.windowStart, raw: m.raw, mine: false, snr: m.snr })),
      ...ourMsgs.map(m => ({ t: m.windowStart, raw: m.raw, mine: true })),
    ].sort((a, b) => a.t.getTime() - b.t.getTime()).slice(-4);

    const thread: QSOStep[] = threadMsgs.map(m => ({ raw: m.raw, mine: m.mine, snr: m.snr, time: m.t }));

    const labelMap: Record<string, string> = {
      answer:   'Answer',
      report:   'Report',
      r_report: 'R+Report',
      rr73:     'RR73',
      tx73:     '73',
    };

    const pfx = callsignCountry(c.callsign);
    const lastTxParsedType = theirMsgs[theirMsgs.length - 1]?.parsed.type;
    sugs.push({
      type: nextTxType as MsgType,
      message,
      label: labelMap[nextTxType] ?? 'Reply',
      callsign: c.callsign,
      color: c.color,
      countryCode: pfx?.countryCode,
      isCQ: lastTxParsedType === 'cq',
      repliedToMe,
      thread,
      maxSnr: c.msgs.reduce((best, m) => m.snr > best ? m.snr : best, -99),
      latLon: c.latLon,
    });
  }

  return sugs;
}

// Render a suggestion message with the user's callsign highlighted
function SugMsgText({ message, myCall, contactColor }: { message: string; myCall: string; contactColor?: string }) {
  const upper = myCall.toUpperCase();
  return (
    <>
      {message.trim().split(/\s+/).map((w, i) => {
        const sep = i > 0 ? ' ' : '';
        if (upper && w.toUpperCase() === upper) {
          return (
            <span key={i}>
              {sep}
              <span className="font-bold px-0.5 rounded" style={{ color: '#f0e68c', background: 'rgba(240,230,140,0.13)' }}>{w}</span>
            </span>
          );
        }
        if (contactColor && w.toUpperCase() === w && w.length > 2 && /^[A-Z0-9/]+$/.test(w) && w !== 'CQ' && w !== 'RR73' && w !== 'RRR') {
          return <span key={i}><span className="font-bold" style={{ color: contactColor }}>{sep}{w}</span></span>;
        }
        return <span key={i}>{sep}{w}</span>;
      })}
    </>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export interface TxStatus {
  status: string;       // 'idle' | 'waiting' | 'encoding' | 'playing'
  isRunning: boolean;
  queueLen: number;
  pendingReplies: number; // contacts that have messaged us but we haven't replied yet
  autoReply: boolean;
  autoCQ: boolean;
  autoPTT: boolean;
  allowConsecutiveTx: boolean;
  windowSec: number;
  txAudioHz: number;    // current TX audio frequency in Hz (baseFreq)
}

interface FTTransmitPanelProps {
  mode: FTMode;
  contacts: Map<string, Contact>;
  vfoFrequency?: number;
  onMyCallChange?: (call: string) => void;
  onMyGridChange?: (grid: string) => void;
  onSetPTT?: (tx: boolean) => Promise<void>;
  onStatusChange?: (s: TxStatus) => void;
  onReset?: (clearSentFn: () => void) => void;
}

export default function FTTransmitPanel({ mode, contacts, vfoFrequency = 0, onMyCallChange, onMyGridChange, onSetPTT, onStatusChange, onReset }: FTTransmitPanelProps) {
  const [myCall, setMyCallState]   = useState(() => { const v = loadMyCall(); return v; });
  const [myGrid, setMyGridState]   = useState(() => loadMyGrid());
  const [baseFreq, setBaseFreqState] = useState(() => loadBaseFreq());
  const setBaseFreq = useCallback((v: number) => { setBaseFreqState(v); saveBaseFreq(v); }, []);
  const [editMsg, setEditMsg]      = useState('');
  const [editLabel, setEditLabel]  = useState('');
  const [callErr, setCallErr]      = useState(false);
  const [gridErr, setGridErr]      = useState(false);
  const [isRunning, setIsRunning]  = useState(false);
  const [geoStatus, setGeoStatus]  = useState<'idle' | 'loading' | 'done' | 'denied'>('idle');

  const { state, start, stop, enqueue, enqueueFirst, dequeue, moveUp, setAutoCQ, setAutoCQMessage, setOutputDevice, setTxGain, setAutoPTT, setAllowConsecutiveTx, clearSent } =
    useFTTransmit(mode, baseFreq, vfoFrequency, onSetPTT);

  // Register clearSent with parent so the global Reset button can clear TX history
  useEffect(() => { onReset?.(clearSent); }, [onReset, clearSent]);

  // dB ↔ linear helpers (slider operates in dB, GainNode needs linear)
  const gainToDb  = (g: number) => g <= 0 ? -60 : 20 * Math.log10(g);
  const dbToGain  = (db: number) => db <= -60 ? 0 : Math.pow(10, db / 20);
  const txDb      = Math.round(gainToDb(state.txGain));

  // Push persisted callsign/grid to parent on first render
  useEffect(() => {
    if (myCall) onMyCallChange?.(myCall);
    if (myGrid) onMyGridChange?.(myGrid);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Geolocation on mount (if no saved grid) ──────────────────────────────
  useEffect(() => {
    if (loadMyGrid() || typeof navigator === 'undefined' || !navigator.geolocation) return;
    setGeoStatus('loading');
    navigator.geolocation.getCurrentPosition(
      pos => {
        const grid = latLonToGrid(pos.coords.latitude, pos.coords.longitude);
        setMyGridState(grid);
        saveMyGrid(grid);
        onMyGridChange?.(grid);
        setGeoStatus('done');
      },
      () => setGeoStatus('denied'),
      { timeout: 8000 },
    );
  }, []);

  const setMyCall = useCallback((v: string) => {
    setMyCallState(v); saveMyCall(v); setCallErr(v !== '' && !validCall(v));
    onMyCallChange?.(v);
  }, [onMyCallChange]);

  const setMyGrid = useCallback((v: string) => {
    setMyGridState(v); saveMyGrid(v); setGridErr(!validGrid(v));
    onMyGridChange?.(v);
  }, [onMyGridChange]);

  useEffect(() => {
    if (myCall) setAutoCQMessage(buildFTMessage('cq', myCall.toUpperCase(), '', undefined, myGrid.toUpperCase()));
  }, [myCall, myGrid, setAutoCQMessage]);

  const canOperate = validCall(myCall) && validGrid(myGrid) && mode !== 'FT2';

  const handleStart = async () => { if (!canOperate) return; setIsRunning(true); await start(); };
  const handleStop  = () => { setIsRunning(false); stop(); };

  // ── Auto-reply ───────────────────────────────────────────────────────────────
  const [autoReply, setAutoReplyState] = useState(() => loadAutoReply());
  // Track the last-processed message fingerprint per callsign:
  // callsign → "lastTheirMsgCount|lastOurMsgCount" so we re-fire when new messages arrive
  const autoRepliedRef = useRef(new Map<string, string>());

  const setAutoReply = useCallback((v: boolean) => {
    setAutoReplyState(v);
    saveAutoReply(v);
    if (!v) autoRepliedRef.current.clear();
  }, []);

  // Reset seen-map when TX engine stops so replies fire again next session
  useEffect(() => {
    if (!isRunning) autoRepliedRef.current.clear();
  }, [isRunning]);

  // Report status to parent (for collapsed summary display)
  useEffect(() => {
    if (!onStatusChange) return;
    const myCallUp = myCall.toUpperCase();
    let pendingReplies = 0;
    for (const c of contacts.values()) {
      const addressedUs = c.msgs.some(m => m.role === 'tx' && m.parsed.callee?.toUpperCase() === myCallUp);
      if (addressedUs) pendingReplies++;
    }
    onStatusChange({
      status: state.status, isRunning, queueLen: state.queue.length, pendingReplies, autoReply,
      autoCQ: state.autoCQ, autoPTT: state.autoPTT, allowConsecutiveTx: state.allowConsecutiveTx,
      windowSec: FT_WINDOW_SECONDS[mode] ?? 15, txAudioHz: baseFreq,
    });
  }, [state.status, isRunning, state.queue.length, contacts, myCall, autoReply, state.autoCQ, state.autoPTT, state.allowConsecutiveTx, mode, onStatusChange, baseFreq]);

  useEffect(() => {
    if (!autoReply || !isRunning || !canOperate) return;
    const myCallUp = myCall.toUpperCase();
    const myGridUp = myGrid.toUpperCase();

    for (const contact of contacts.values()) {
      const callsign = contact.callsign.toUpperCase();
      if (callsign === myCallUp) continue;

      // Messages they sent addressed to us
      const theirMsgsToUs = contact.msgs.filter(m =>
        m.role === 'tx' && m.parsed.callee?.toUpperCase() === myCallUp
      );
      if (theirMsgsToUs.length === 0) continue;

      // What we've already sent them — read from the TX sent log, not from decoded
      // contacts (our own transmissions are never decoded back by the receiver).
      // state.sent is newest-first, so filter then take index 0 for the most recent.
      const sentToThem = state.sent.filter(e =>
        parseFTMsg(e.message).callee?.toUpperCase() === callsign
      );

      // Fingerprint: re-fire whenever either side has a new message
      const fingerprint = `${theirMsgsToUs.length}|${sentToThem.length}`;
      if (autoRepliedRef.current.get(callsign) === fingerprint) continue;

      const lastTheirMsg  = theirMsgsToUs[theirMsgsToUs.length - 1];
      const lastTheirType = lastTheirMsg.parsed.type;

      // state.sent is newest-first — index 0 is the most recently sent message
      const lastSentMsg  = sentToThem.length ? sentToThem[0] : null;
      const lastSentType = lastSentMsg ? parseFTMsg(lastSentMsg.message).type : null;

      // For the very first reply to a station, treat as if we just sent CQ
      const effectiveLastSent: MsgType = lastSentType ?? 'cq';
      const nextType = nextTxMsgType(effectiveLastSent, lastTheirType);

      // 'cq' means complete or unrecognised — nothing to send
      if (nextType === 'cq') { autoRepliedRef.current.set(callsign, fingerprint); continue; }

      // Use best SNR from all their messages to us
      const bestSnr = theirMsgsToUs.reduce((best, m) => m.snr > best ? m.snr : best, -99);
      const message = buildFTMessage(nextType, myCallUp, callsign, Math.round(bestSnr), myGridUp);

      // Don't enqueue if this exact message is already queued or already sent
      if (state.queue.some(e => e.message === message)) { autoRepliedRef.current.set(callsign, fingerprint); continue; }
      if (state.sent.some(e => e.message === message))  { autoRepliedRef.current.set(callsign, fingerprint); continue; }

      const labelMap: Record<string, string> = {
        answer: 'Answer', report: 'Report', r_report: 'R+Report', rr73: 'RR73', tx73: '73',
      };

      autoRepliedRef.current.set(callsign, fingerprint);
      enqueueFirst({ id: uid(), message, label: `Auto → ${contact.callsign} (${labelMap[nextType] ?? nextType})` });
    }
  }, [contacts, myCall, myGrid, state.queue, state.sent, enqueueFirst, autoReply, isRunning, canOperate]);

  // ── Suggestion sort / filter state ──────────────────────────────────────────
  type SugSort = 'default' | 'snr-hi' | 'snr-lo' | 'near' | 'far';
  const [sugSort,          setSugSort]          = useState<SugSort>('default');
  const [sugCountryFilter, setSugCountryFilter] = useState('');
  const [sugMyOnly,        setSugMyOnly]        = useState(false);
  const [sugCQOnly,        setSugCQOnly]        = useState(false);

  const DISPLAY_LIMIT = 8;

  const myCallUp = myCall.toUpperCase();
  const myGridUp = myGrid.toUpperCase();

  const allSuggestions = useMemo(
    () => buildSuggestions(myCallUp, myGridUp, contacts),
    [myCallUp, myGridUp, contacts],
  );

  const myLatLon = useMemo(
    () => myGridUp ? (gridToLatLon(myGridUp) ?? null) : null,
    [myGridUp],
  );

  // Build country list from non-CQ suggestions — only recomputes when suggestions change
  const sugCountryOptions = useMemo(() => Array.from(
    allSuggestions.filter(s => s.callsign && s.countryCode).reduce((acc, s) => {
      const pfx = callsignCountry(s.callsign!);
      if (pfx?.countryCode && pfx.country && pfx.flag) {
        const existing = acc.get(pfx.countryCode);
        acc.set(pfx.countryCode, existing
          ? { ...existing, count: existing.count + 1 }
          : { code: pfx.countryCode, country: pfx.country, flag: pfx.flag, count: 1 });
      }
      return acc;
    }, new Map<string, { code: string; country: string; flag: string; count: number }>())
  .values()).sort((a, b) => b.count - a.count || a.country.localeCompare(b.country)),
  [allSuggestions]);

  const distKm = useCallback((s: Suggestion): number =>
    (myLatLon && s.latLon) ? haversineKm(myLatLon, s.latLon) : Infinity,
  [myLatLon]);

  // Separate CQ (always first, never reordered/filtered) from contact suggestions
  const [cqSug, ...contactSugs] = allSuggestions;
  const suggestions = useMemo(() => {
    const filteredSugs = contactSugs.filter(s => {
      if (sugMyOnly && s.thread.length === 0) return false;
      if (sugCountryFilter && s.countryCode !== sugCountryFilter) return false;
      if (sugCQOnly && !s.isCQ) return false;
      return true;
    });
    const sortedSugs = [...filteredSugs].sort((a, b) => {
      if (sugSort === 'snr-hi') return b.maxSnr - a.maxSnr;
      if (sugSort === 'snr-lo') return a.maxSnr - b.maxSnr;
      if (sugSort === 'near')   return distKm(a) - distKm(b);
      if (sugSort === 'far')    return distKm(b) - distKm(a);
      return 0; // default: keep buildSuggestions order (priority + recency)
    });
    return [cqSug, ...sortedSugs.slice(0, DISPLAY_LIMIT - 1)];
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allSuggestions, sugSort, sugCountryFilter, sugMyOnly, sugCQOnly, distKm]);

  const addSuggestion = (sug: Suggestion) => {
    if (!canOperate) return;
    if (state.queue.some(e => e.message === sug.message)) return;
    enqueue({ id: uid(), message: sug.message, label: sug.label });
  };

  const addCustom = () => {
    const msg = editMsg.trim().toUpperCase();
    if (!msg) return;
    if (state.queue.some(e => e.message === msg)) return;
    enqueue({ id: uid(), message: msg, label: editLabel.trim() || msg });
    setEditMsg(''); setEditLabel('');
  };

  const windowSec     = FT_WINDOW_SECONDS[mode] ?? 15;
  const isPlaying     = state.status === 'playing';
  const secToWindow   = useWindowCountdown(windowSec);

  return (
    <div className="space-y-4">

      {/* ── Top row: identity + ring + controls ── */}
      <div className="flex flex-wrap gap-3 items-end">

        {/* TX window ring */}
        <div className={`transition-opacity ${!isRunning ? 'opacity-30' : ''}`}>
          <TxRing status={state.status} windowSec={windowSec} playing={isPlaying} />
        </div>

        {/* Callsign */}
        <div className="flex flex-col gap-1">
          <label className="text-[#8b949e] text-[10px] font-semibold tracking-wide">My Callsign</label>
          <input value={myCall} onChange={e => setMyCall(e.target.value.toUpperCase())}
            placeholder="PU7FWT" maxLength={12}
            className={`bg-[#0d1117] border rounded px-2 py-1.5 text-sm font-mono text-[#c9d1d9] w-28 focus:outline-none focus:border-[#388bfd] ${callErr ? 'border-[#f85149]' : 'border-[#30363d]'}`} />
          {callErr && <span className="text-[#f85149] text-[10px]">Invalid callsign</span>}
        </div>

        {/* Grid */}
        <div className="flex flex-col gap-1">
          <label className="text-[#8b949e] text-[10px] font-semibold tracking-wide">
            My Grid
            {geoStatus === 'loading' && <span className="ml-1 text-[#484f58]">locating…</span>}
            {geoStatus === 'done'    && <span className="ml-1 text-[#2ea043]">✓ GPS</span>}
          </label>
          <input value={myGrid} onChange={e => setMyGrid(e.target.value.toUpperCase())}
            placeholder="GG54" maxLength={6}
            className={`bg-[#0d1117] border rounded px-2 py-1.5 text-sm font-mono text-[#c9d1d9] w-20 focus:outline-none focus:border-[#388bfd] ${gridErr ? 'border-[#f85149]' : 'border-[#30363d]'}`} />
          {gridErr && <span className="text-[#f85149] text-[10px]">Invalid grid</span>}
        </div>

        {/* Audio offset */}
        <div className="flex flex-col gap-1">
          <label className="text-[#8b949e] text-[10px] font-semibold tracking-wide">Audio Hz</label>
          <input type="number" value={baseFreq}
            onChange={e => setBaseFreq(Math.max(200, Math.min(3000, Number(e.target.value))))}
            min={200} max={3000} step={50}
            className="bg-[#0d1117] border border-[#30363d] rounded px-2 py-1.5 text-sm font-mono text-[#c9d1d9] w-24 focus:outline-none focus:border-[#388bfd]" />
        </div>

        {/* TX gain */}
        <div className="flex flex-col gap-1">
          <label className="text-[#8b949e] text-[10px] font-semibold tracking-wide">
            TX Level
            <span className="ml-1.5 font-mono text-[#c9d1d9]">{txDb === 0 ? '0 dB' : `${txDb} dB`}</span>
          </label>
          <div className="flex items-center gap-2">
            <input type="range"
              min={-60} max={0} step={1}
              value={txDb}
              onChange={e => setTxGain(dbToGain(Number(e.target.value)))}
              className="w-28 accent-[#388bfd] cursor-pointer"
            />
          </div>
        </div>

        {/* Output device */}
        <div className="flex flex-col gap-1">
          <label className="text-[#8b949e] text-[10px] font-semibold tracking-wide">Output</label>
          <OutputSelector value={state.outputDeviceId} onChange={setOutputDevice} supported={state.sinkIdSupported} />
        </div>

        {/* TX Engine + all toggles — grouped together */}
        <div className="flex flex-col gap-1 ml-auto">
          <label className="text-[#8b949e] text-[10px] font-semibold tracking-wide">TX Engine</label>
          <div className="flex items-center gap-2 flex-wrap">
            {!isRunning ? (
              <button onClick={handleStart} disabled={!canOperate}
                className="px-3 py-1.5 rounded text-xs font-semibold bg-[#238636] text-white hover:bg-[#2ea043] disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
                Start TX
              </button>
            ) : (
              <button onClick={handleStop}
                className="px-3 py-1.5 rounded text-xs font-semibold bg-[#da3633] text-white hover:bg-[#f85149] transition-colors">
                Stop TX
              </button>
            )}
            {/* Auto-CQ */}
            <div onClick={() => setAutoCQ(!state.autoCQ)}
              title="Automatically send CQ when the queue is empty"
              className="flex items-center gap-1.5 cursor-pointer select-none px-2 py-1.5 rounded border transition-colors"
              style={{
                borderColor: state.autoCQ ? 'rgba(46,160,67,0.5)' : 'rgba(48,54,61,1)',
                background:  state.autoCQ ? 'rgba(46,160,67,0.08)' : 'transparent',
              }}>
              <div className={`w-6 h-3 rounded-full transition-colors relative shrink-0 ${state.autoCQ ? 'bg-[#238636]' : 'bg-[#30363d]'}`}>
                <div className={`absolute top-0.5 w-2 h-2 rounded-full bg-white transition-transform ${state.autoCQ ? 'translate-x-3' : 'translate-x-0.5'}`} />
              </div>
              <span className="text-[10px] text-[#8b949e] whitespace-nowrap">Auto-CQ</span>
            </div>
            {/* Auto-PTT */}
            <div onClick={() => setAutoPTT(!state.autoPTT)}
              title={onSetPTT ? 'Automatically key radio PTT via CAT while transmitting' : 'Auto-PTT requires CAT connection'}
              className={`flex items-center gap-1.5 cursor-pointer select-none px-2 py-1.5 rounded border transition-colors ${!onSetPTT ? 'opacity-40' : ''}`}
              style={{
                borderColor: state.autoPTT ? 'rgba(227,179,65,0.5)' : 'rgba(48,54,61,1)',
                background:  state.autoPTT ? 'rgba(227,179,65,0.08)' : 'transparent',
              }}>
              <div className={`w-6 h-3 rounded-full transition-colors relative shrink-0 ${state.autoPTT ? 'bg-[#e3b341]' : 'bg-[#30363d]'}`}>
                <div className={`absolute top-0.5 w-2 h-2 rounded-full bg-white transition-transform ${state.autoPTT ? 'translate-x-3' : 'translate-x-0.5'}`} />
              </div>
              <span className="text-[10px] text-[#8b949e] whitespace-nowrap">Auto-PTT</span>
            </div>
            {/* Consecutive TX */}
            <div onClick={() => setAllowConsecutiveTx(!state.allowConsecutiveTx)}
              title={state.allowConsecutiveTx
                ? 'Consecutive TX on — transmits every window (turn off for single RX/TX radios)'
                : 'Consecutive TX off — one listen window between transmissions'}
              className="flex items-center gap-1.5 cursor-pointer select-none px-2 py-1.5 rounded border transition-colors"
              style={{
                borderColor: state.allowConsecutiveTx ? 'rgba(248,81,73,0.5)' : 'rgba(48,54,61,1)',
                background:  state.allowConsecutiveTx ? 'rgba(248,81,73,0.08)' : 'transparent',
              }}>
              <div className={`w-6 h-3 rounded-full transition-colors relative shrink-0 ${state.allowConsecutiveTx ? 'bg-[#f85149]' : 'bg-[#30363d]'}`}>
                <div className={`absolute top-0.5 w-2 h-2 rounded-full bg-white transition-transform ${state.allowConsecutiveTx ? 'translate-x-3' : 'translate-x-0.5'}`} />
              </div>
              <span className="text-[10px] text-[#8b949e] whitespace-nowrap">Consecutive TX</span>
            </div>
            {/* Auto-Reply */}
            <div onClick={() => setAutoReply(!autoReply)}
              title={autoReply
                ? 'Auto-Reply on — automatically enqueues a reply when someone responds to your CQ'
                : 'Auto-Reply off — manually pick replies from suggestions'}
              className="flex items-center gap-1.5 cursor-pointer select-none px-2 py-1.5 rounded border transition-colors"
              style={{
                borderColor: autoReply ? 'rgba(88,166,255,0.5)' : 'rgba(48,54,61,1)',
                background:  autoReply ? 'rgba(88,166,255,0.08)' : 'transparent',
              }}>
              <div className={`w-6 h-3 rounded-full transition-colors relative shrink-0 ${autoReply ? 'bg-[#58a6ff]' : 'bg-[#30363d]'}`}>
                <div className={`absolute top-0.5 w-2 h-2 rounded-full bg-white transition-transform ${autoReply ? 'translate-x-3' : 'translate-x-0.5'}`} />
              </div>
              <span className="text-[10px] text-[#8b949e] whitespace-nowrap">Auto-Reply</span>
            </div>
          </div>
        </div>
      </div>

      {/* ── Active TX banner ── */}
      {isPlaying && (
        <div className="flex items-center gap-3 bg-[#2ea043]/10 border border-[#2ea043]/40 rounded px-3 py-2">
          {/* Animated bar visualiser */}
          <div className="flex items-end gap-px h-5 shrink-0">
            {Array.from({ length: 7 }).map((_, i) => (
              <div key={i} className="w-1 bg-[#2ea043] rounded-sm"
                style={{
                  animation: `txBar 0.6s ease-in-out infinite alternate`,
                  animationDelay: `${i * 0.08}s`,
                  minHeight: 3,
                }}
              />
            ))}
          </div>
          <span className="text-[#2ea043] text-xs font-mono font-bold">
            TRANSMITTING — {state.queue[0]?.message ?? state.sent[0]?.message ?? ''}
          </span>
          <style>{`
            @keyframes txBar {
              from { height: 3px; }
              to   { height: 20px; }
            }
          `}</style>
        </div>
      )}

      {mode === 'FT2' && (
        <div className="bg-[#e3b341]/10 border border-[#e3b341]/30 rounded p-2 text-[#e3b341] text-xs">
          FT2 encoding is not yet supported. Switch to FT8 or FT4 to transmit.
        </div>
      )}

      {state.error && (
        <div className="bg-[#da3633]/10 border border-[#f85149]/30 rounded p-2 text-[#f85149] text-xs">
          {state.error}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">

        {/* ── Left: suggestions + composer ── */}
        <div className="space-y-3">
          <div className="flex items-center gap-2 flex-wrap">
            <div className="text-[#8b949e] text-[10px] font-semibold uppercase tracking-wide">Suggested Messages</div>
            {/* Sort buttons */}
            {contactSugs.length > 1 && (
              <div className="flex items-center gap-1 flex-wrap">
                {([
                  { key: 'snr-hi', label: 'Strongest', title: 'Strongest signal first (highest SNR)' },
                  { key: 'snr-lo', label: 'Weakest',   title: 'Weakest signal first (lowest SNR)' },
                  { key: 'near',   label: 'Nearest',   title: myLatLon ? 'Geographically closest first' : 'Nearest (set your grid first)' },
                  { key: 'far',    label: 'Farthest',  title: myLatLon ? 'Geographically farthest first' : 'Farthest (set your grid first)' },
                ] as Array<{ key: SugSort; label: string; title: string }>).map(({ key, label, title }) => (
                  <button
                    key={key}
                    onClick={() => setSugSort(s => s === key ? 'default' : key)}
                    title={title}
                    disabled={(key === 'near' || key === 'far') && !myLatLon}
                    className={`text-[9px] font-mono px-1.5 py-0.5 rounded border transition-colors disabled:opacity-30 disabled:cursor-not-allowed ${
                      sugSort === key
                        ? 'border-[#2ea043]/50 text-[#2ea043] bg-[#2ea043]/10'
                        : 'border-[#30363d] text-[#484f58] hover:text-[#8b949e]'
                    }`}
                  >
                    {label}
                  </button>
                ))}
                {/* My conversations filter */}
                {contactSugs.some(s => s.thread.length > 0) && (
                  <button
                    onClick={() => setSugMyOnly(v => !v)}
                    title="Show only contacts that have exchanged with you"
                    className={`text-[9px] font-mono px-1.5 py-0.5 rounded border transition-colors ${
                      sugMyOnly
                        ? 'border-[#79c0ff]/50 text-[#79c0ff] bg-[#79c0ff]/10'
                        : 'border-[#30363d] text-[#484f58] hover:text-[#8b949e]'
                    }`}
                  >
                    My QSOs
                  </button>
                )}
                {/* CQ-only filter */}
                {contactSugs.some(s => s.isCQ) && (
                  <button
                    onClick={() => setSugCQOnly(v => !v)}
                    title="Show only stations that are calling CQ"
                    className={`text-[9px] font-mono px-1.5 py-0.5 rounded border transition-colors ${
                      sugCQOnly
                        ? 'border-[#2ea043]/50 text-[#2ea043] bg-[#2ea043]/10'
                        : 'border-[#30363d] text-[#484f58] hover:text-[#8b949e]'
                    }`}
                  >
                    CQ only
                  </button>
                )}
                {/* Country select */}
                {sugCountryOptions.length > 1 && (
                  <select
                    value={sugCountryFilter}
                    onChange={e => setSugCountryFilter(e.target.value)}
                    title="Filter suggestions by country"
                    className={`text-[9px] font-mono px-1 py-0.5 rounded border bg-[#0d1117] transition-colors cursor-pointer ${
                      sugCountryFilter
                        ? 'border-[#e3b341]/50 text-[#e3b341]'
                        : 'border-[#30363d] text-[#484f58]'
                    }`}
                  >
                    <option value="">🌍 All</option>
                    {sugCountryOptions.map(({ code, country, flag, count }) => (
                      <option key={code} value={code}>{flag} {country} ({count})</option>
                    ))}
                  </select>
                )}
                {(sugSort !== 'default' || sugCountryFilter || sugMyOnly || sugCQOnly) && (
                  <button
                    onClick={() => { setSugSort('default'); setSugCountryFilter(''); setSugMyOnly(false); setSugCQOnly(false); }}
                    className="text-[9px] font-mono px-1 py-0.5 rounded border border-[#30363d] text-[#484f58] hover:text-[#8b949e]"
                    title="Reset sort and filters"
                  >
                    ✕
                  </button>
                )}
              </div>
            )}
          </div>

          <div className="space-y-2">
            {suggestions.map((sug, i) => {
              const borderColor = sug.repliedToMe
                ? (sug.color ?? '#f0e68c')
                : '#30363d';
              const hoverBorder = sug.repliedToMe
                ? (sug.color ?? '#f0e68c')
                : '#388bfd';
              return (
                <div key={i}
                  className="rounded overflow-hidden"
                  style={{ border: `1px solid ${borderColor}` }}>
                  {/* Thread — only shown when there's exchange history */}
                  {sug.thread.length > 0 && (
                    <div className="bg-[#0d1117] px-3 pt-2 pb-1 space-y-0.5 border-b" style={{ borderColor }}>
                      {sug.thread.map((step, si) => (
                        <div key={si} className={`flex gap-2 items-baseline text-[11px] font-mono ${step.mine ? 'justify-end' : 'justify-start'}`}>
                          <span className="text-[#484f58] text-[10px] shrink-0 tabular-nums">
                            {step.time.toLocaleTimeString(undefined, { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                          </span>
                          {!step.mine && (
                            <span className="text-[10px] shrink-0" style={{ color: sug.color }}>
                              {sug.callsign}
                            </span>
                          )}
                          <span className={`px-1.5 py-0.5 rounded text-[11px] ${step.mine ? 'bg-[#238636]/20 text-[#7ee787]' : 'bg-[#388bfd]/10 text-[#79c0ff]'}`}>
                            {step.raw}
                          </span>
                          {step.mine && <span className="text-[10px] text-[#8b949e] shrink-0">me</span>}
                          {!step.mine && step.snr !== undefined && (
                            <span className="text-[10px] shrink-0" style={{ color: step.snr >= -5 ? '#2ea043' : step.snr >= -15 ? '#e3b341' : '#8b949e' }}>
                              {step.snr > 0 ? '+' : ''}{step.snr.toFixed(1)}dB
                            </span>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                  {/* Action button */}
                  <button
                    onClick={() => addSuggestion(sug)}
                    disabled={!canOperate || !isRunning}
                    title={!isRunning ? 'Start TX engine first' : undefined}
                    className="w-full text-left bg-[#0d1117] hover:bg-[#161b22] disabled:opacity-40 disabled:cursor-not-allowed px-3 py-2 transition-colors group"
                    style={{ ['--hover-border' as string]: hoverBorder }}
                    onMouseEnter={e => (e.currentTarget.closest<HTMLDivElement>('.rounded')!).style.borderColor = hoverBorder}
                    onMouseLeave={e => (e.currentTarget.closest<HTMLDivElement>('.rounded')!).style.borderColor = borderColor}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-1.5 shrink-0">
                        {sug.repliedToMe && (
                          <span className="text-[10px]" title="They replied to you" style={{ color: sug.color }}>▶</span>
                        )}
                        <span className="text-[#8b949e] text-[10px] font-semibold uppercase">{sug.label}</span>
                        {sug.callsign && (
                          <span className="flex items-center gap-1 text-[10px] font-mono font-bold" style={{ color: sug.color }}>
                            {(() => {
                              const info = callsignCountry(sug.callsign);
                              return info?.flag ? (
                                <span className="text-sm leading-none" title={info.country}>{info.flag}</span>
                              ) : null;
                            })()}
                            {sug.callsign}
                          </span>
                        )}
                      </div>
                      <span className="font-mono text-xs text-[#c9d1d9] group-hover:text-white truncate">
                        <SugMsgText message={sug.message} myCall={myCall} contactColor={sug.color} />
                      </span>
                    </div>
                  </button>
                </div>
              );
            })}
          </div>

          {/* Custom message */}
          <div className="border-t border-[#21262d] pt-3 space-y-2">
            <div className="text-[#8b949e] text-[10px] font-semibold uppercase tracking-wide">Custom Message</div>
            <div className="flex gap-2">
              <input value={editMsg} onChange={e => setEditMsg(e.target.value.toUpperCase())}
                onKeyDown={e => e.key === 'Enter' && addCustom()}
                placeholder="CQ PU7FWT GG54" maxLength={13}
                className="flex-1 bg-[#0d1117] border border-[#30363d] rounded px-2 py-1.5 text-xs font-mono text-[#c9d1d9] focus:outline-none focus:border-[#388bfd]" />
              <input value={editLabel} onChange={e => setEditLabel(e.target.value)}
                placeholder="Label (opt)"
                className="w-28 bg-[#0d1117] border border-[#30363d] rounded px-2 py-1.5 text-xs text-[#c9d1d9] focus:outline-none focus:border-[#388bfd]" />
              <button onClick={addCustom}
                disabled={!editMsg.trim() || !canOperate || !isRunning}
                className="px-3 py-1.5 text-xs font-semibold bg-[#21262d] border border-[#30363d] hover:border-[#388bfd] text-[#c9d1d9] rounded disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
                Queue
              </button>
            </div>
            <p className="text-[#484f58] text-[10px]">Max 13 chars · FT8/FT4 message format</p>
          </div>
        </div>

        {/* ── Right: queue + sent log ── */}
        <div className="space-y-3">
          <div className="text-[#8b949e] text-[10px] font-semibold uppercase tracking-wide flex items-center justify-between">
            <span>TX Queue</span>
            <span className="text-[#484f58]">{state.queue.length} pending</span>
          </div>

          {/* Auto-CQ virtual entry — always shown at top when active, separate from queue state */}
          {state.autoCQ && (
            <div className="flex items-center gap-2 rounded px-2 py-1.5 border border-[#238636]/40 bg-[#238636]/5">
              <span className="text-[10px] font-mono w-5 shrink-0 flex items-center justify-center">
                {isPlaying && state.queue.length === 0
                  ? <span className="text-[#2ea043]">📡</span>
                  : <span className="text-[#238636]">∞</span>}
              </span>
              <div className="flex-1 min-w-0">
                <div className="font-mono text-xs text-[#c9d1d9] truncate">{buildFTMessage('cq', myCall.toUpperCase(), '', undefined, myGrid.toUpperCase())}</div>
                <div className="text-[#484f58] text-[10px]">Auto-CQ · repeats every eligible window</div>
              </div>
              <button onClick={() => setAutoCQ(false)}
                className="text-[#484f58] hover:text-[#f85149] text-xs px-1 shrink-0" title="Disable Auto-CQ">✕</button>
            </div>
          )}

          {state.queue.length === 0 && !state.autoCQ ? (
            <div className="text-[#484f58] text-xs font-mono py-3 text-center border border-dashed border-[#21262d] rounded">
              No messages queued
            </div>
          ) : state.queue.length > 0 ? (
            <div className="space-y-1">
              {state.queue.map((entry, idx) => {
                const etaSec = idx === 0
                  ? (isPlaying ? 0 : secToWindow)
                  : secToWindow + idx * windowSec;
                const etaLabel = isPlaying && idx === 0 ? 'TX' : `${etaSec.toFixed(2)}s`;
                const isPending = entry.encodeStatus === 'pending';
                const isError   = entry.encodeStatus === 'error';
                return (
                  <div key={entry.id}
                    className={`flex items-center gap-2 rounded px-2 py-1.5 border ${
                      idx === 0 && isPlaying
                        ? 'border-[#2ea043]/60 bg-[#2ea043]/5'
                        : idx === 0
                          ? 'border-[#388bfd]/50 bg-[#388bfd]/5'
                          : 'border-[#21262d] bg-[#0d1117]'
                    }`}>
                    {/* Status icon */}
                    <span className="text-[10px] font-mono w-5 shrink-0 flex items-center justify-center">
                      {idx === 0 && isPlaying ? (
                        <span className="text-[#2ea043]">📡</span>
                      ) : isPending ? (
                        <svg className="animate-spin w-3 h-3 text-[#e3b341]" viewBox="0 0 24 24" fill="none">
                          <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeDasharray="31.4 31.4" strokeLinecap="round" />
                        </svg>
                      ) : isError ? (
                        <span className="text-[#f85149]">!</span>
                      ) : idx === 0 ? (
                        <span className="text-[#388bfd]">▶</span>
                      ) : (
                        <span className="text-[#484f58]">{idx + 1}</span>
                      )}
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="font-mono text-xs text-[#c9d1d9] truncate">{entry.message}</div>
                      <div className="text-[#484f58] text-[10px] truncate">
                        {isError ? <span className="text-[#f85149]">{entry.encodeError}</span> : entry.label}
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <span className={`text-[10px] font-mono tabular-nums font-semibold ${
                        isPlaying && idx === 0 ? 'text-[#2ea043]' : 'text-white'
                      }`}>{etaLabel}</span>
                      {idx > 0 && (
                        <button onClick={() => moveUp(entry.id)}
                          className="text-[#484f58] hover:text-[#c9d1d9] text-xs px-1" title="Move up">↑</button>
                      )}
                      <button onClick={() => dequeue(entry.id)}
                        className="text-[#484f58] hover:text-[#f85149] text-xs px-1" title="Remove">✕</button>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : null}

          {/* Sent log — newest first, no enclosing box */}
          {state.sent.length > 0 && (
            <div className="mt-2 pt-2 border-t border-[#21262d]">
              <div className="text-[#8b949e] text-[10px] font-semibold uppercase tracking-wide mb-1 flex items-center justify-between">
                <span>Sent Log</span>
                <span className="text-[#484f58] normal-case">{state.sent.length}</span>
              </div>
              <div className="space-y-px">
                {state.sent.map(entry => {
                  const absFreq = entry.vfoHz > 0 ? entry.vfoHz + entry.audioHz : 0;
                  const parsed  = parseFTMsg(entry.message);
                  const typeColor = MSG_TYPE_COLOR[parsed.type];
                  const typeLabel = MSG_TYPE_LABEL[parsed.type];
                  return (
                    <div key={entry.id}
                      className="flex items-center gap-1.5 text-[11px] font-mono py-0.5">
                      <span className="shrink-0 text-[10px] text-[#484f58] tabular-nums w-[56px]">
                        {entry.windowStart.toLocaleTimeString(undefined, { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                      </span>
                      <span
                        className="shrink-0 px-1 py-px rounded text-[8px] font-bold w-[36px] text-center"
                        style={{ background: `${typeColor}1a`, color: typeColor }}
                      >
                        {typeLabel}
                      </span>
                      <span className={`truncate flex-1 ${entry.error ? 'text-[#f85149]' : 'text-[#c9d1d9]'}`}>
                        {entry.message}
                      </span>
                      <span className="shrink-0 text-[10px] text-[#484f58]">
                        {absFreq > 0 ? fmtAbsHz(absFreq) : `${entry.audioHz} Hz`}
                      </span>
                      {entry.error && (
                        <span className="shrink-0 text-[10px] text-[#f85149]" title={entry.error}>⚠</span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
