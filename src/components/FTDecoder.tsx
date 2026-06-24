'use client';

import { Fragment, forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { DecoderControls, DecoderProps } from './DecoderControls';
import { fmtAbsHz } from '@/lib/formatFreq';
import AudioAnalysisPanel from './AudioAnalysisPanel';
import { useFTProcessor } from '@/hooks/useFTProcessor';
import { FTMode, FT_WINDOW_SECONDS } from '@/lib/ft/decoder';
import { Contact, mergeContacts } from '@/lib/ft/parser';
import FTContactsPanel from './FTContactsPanel';

// ── Clock ring (rAF-driven, no setState) ──────────────────────────────────────

function ClockRing({ status, windowSec }: { status: string; windowSec: number }) {
  const r    = 28;
  const cx   = 36;
  const cy   = 36;
  const circ = 2 * Math.PI * r;

  const svgRef     = useRef<SVGSVGElement>(null);
  const rafRef     = useRef<number | null>(null);
  const prevRef    = useRef('');

  useEffect(() => {
    const tick = () => {
      const svg = svgRef.current;
      if (!svg) { rafRef.current = requestAnimationFrame(tick); return; }

      const totalMs   = windowSec * 1000;
      const now       = new Date();
      const elapsed   = (now.getSeconds() * 1000 + now.getMilliseconds()) % totalMs;
      const progress  = elapsed / totalMs;
      const nextMs    = totalMs - elapsed;
      const secVal    = (nextMs / 1000).toFixed(1);

      if (secVal === prevRef.current) { rafRef.current = requestAnimationFrame(tick); return; }
      prevRef.current = secVal;

      const arcColor    = status === 'recording' ? '#2ea043' : status === 'decoding' ? '#e3b341' : '#30363d';
      const lblColor    = status === 'recording' ? '#2ea043' : status === 'decoding' ? '#e3b341' : '#484f58';
      const label       = status === 'decoding' ? 'DEC' : status === 'recording' ? 'REC' : 'WAIT';
      const filled      = circ * progress;

      svg.querySelector<SVGCircleElement>('.ft-arc')?.setAttribute('stroke', arcColor);
      svg.querySelector<SVGCircleElement>('.ft-arc')?.setAttribute('stroke-dasharray', `${filled} ${circ - filled}`);
      const txt = svg.querySelector<SVGTextElement>('.ft-sec');
      if (txt) txt.textContent = status === 'idle' ? '--' : secVal;
      const lbl = svg.querySelector<SVGTextElement>('.ft-lbl');
      if (lbl) { lbl.setAttribute('fill', lblColor); lbl.textContent = label; }

      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, [status, windowSec, circ]);

  const arcColor = status === 'recording' ? '#2ea043' : status === 'decoding' ? '#e3b341' : '#30363d';
  const lblColor = status === 'recording' ? '#2ea043' : status === 'decoding' ? '#e3b341' : '#484f58';
  const label    = status === 'decoding' ? 'DEC' : status === 'recording' ? 'REC' : 'WAIT';

  return (
    <svg ref={svgRef} width={72} height={72} viewBox="0 0 72 72" className="shrink-0">
      <circle cx={cx} cy={cy} r={r} fill="none" stroke="#21262d" strokeWidth={5} />
      <circle
        className="ft-arc"
        cx={cx} cy={cy} r={r}
        fill="none" stroke={arcColor} strokeWidth={5}
        strokeDasharray={`0 ${circ}`} strokeDashoffset={circ * 0.25}
      />
      <text className="ft-lbl" x={cx} y={cy - 4} textAnchor="middle" fontSize={7.5} fill={lblColor}
        fontFamily="monospace" fontWeight="bold">{label}</text>
      <text x={cx} y={cy + 7} textAnchor="middle" fontSize={11} fill="#c9d1d9"
        fontFamily="monospace" fontWeight="bold">
        <tspan className="ft-sec">{status === 'idle' ? '--' : '0.0'}</tspan>
      </text>
      <text x={cx} y={cy + 16} textAnchor="middle" fontSize={7} fill="#484f58" fontFamily="monospace">
        {status !== 'idle' ? `/${windowSec}s` : ''}
      </text>
    </svg>
  );
}

// ── FT sub-mode selector (exported for page.tsx) ──────────────────────────────

const FT_MODES: FTMode[] = ['FT8', 'FT4', 'FT2'];

export function FTModeSelector({ mode, onChange }: {
  mode: FTMode;
  onChange: (m: FTMode) => void;
}) {
  return (
    <div className="flex items-center gap-1 bg-[#0d1117] border border-[#30363d] rounded-lg p-1">
      {FT_MODES.map(m => (
        <button
          key={m}
          onClick={() => m !== 'FT2' && onChange(m)}
          title={m === 'FT2' ? 'FT2 is experimental — no decoder available yet' : undefined}
          className={`px-3 py-1 rounded-md text-xs font-semibold transition-colors ${
            mode === m
              ? m === 'FT2' ? 'bg-[#30363d] text-[#8b949e]' : 'bg-[#238636] text-white'
              : m === 'FT2' ? 'text-[#484f58] cursor-default' : 'text-[#8b949e] hover:text-[#c9d1d9]'
          }`}
        >
          {m}
          {m === 'FT2' && <span className="ml-1 text-[9px] text-[#30363d]">beta</span>}
        </button>
      ))}
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function msgColor(msg: string, snr: number): string {
  if (msg.startsWith('CQ ') || msg.startsWith('CQ\t')) return '#2ea043';
  if (snr <= -20) return '#484f58';
  return '#c9d1d9';
}

// Quality colors shared by the dB column and signal reports inside messages
function snrColor(db: number): string {
  return db >= -5 ? '#2ea043' : db >= -15 ? '#e3b341' : '#8b949e';
}
// Δ (time offset) quality — FT modes need clocks within ~1 s; small is healthy
function dtColor(dt: number): string {
  const a = Math.abs(dt);
  return a <= 0.2 ? '#2ea043' : a <= 0.5 ? '#e3b341' : '#f85149';
}

function utcTime(d: Date): string { return d.toISOString().slice(11, 19); }
function formatFreq(hz: number, vfoHz = 0): string {
  if (vfoHz > 0) return fmtAbsHz(vfoHz + hz);
  return hz.toFixed(0).padStart(4, ' ');
}
function formatDT(dt: number): string { return (dt >= 0 ? '+' : '') + dt.toFixed(1); }

const RPT_TOKEN = /^R?[+-][0-9]{1,2}$/;

// Message text with known callsigns colored + linked to their contact card,
// and signal reports colored by the same quality scheme as the dB column
function MsgText({ msg, contacts, onSelect }: {
  msg: string;
  contacts: Map<string, Contact>;
  onSelect: (cs: string) => void;
}) {
  return (
    <>
      {msg.trim().split(/\s+/).map((w, i) => {
        const sep = i > 0 ? ' ' : '';
        const c = contacts.get(w);
        if (c) {
          return (
            <Fragment key={i}>
              {sep}
              <button
                onClick={() => onSelect(w)}
                className="hover:underline font-bold"
                style={{ color: c.color }}
                title={`Show ${w} in Contacts`}
              >
                {w}
              </button>
            </Fragment>
          );
        }
        if (RPT_TOKEN.test(w)) {
          return (
            <Fragment key={i}>
              {sep}
              <span style={{ color: snrColor(parseInt(w.replace(/^R/, ''), 10)) }}>{w}</span>
            </Fragment>
          );
        }
        return <Fragment key={i}>{sep}{w}</Fragment>;
      })}
    </>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

const FTDecoder = forwardRef<DecoderControls, { ftMode: FTMode } & DecoderProps>(function FTDecoder({ ftMode, onStateChange, analyser, vfoFrequency }, ref) {
  const {
    state, startRecording, stopRecording, clearResults, ftSupported,
  } = useFTProcessor(ftMode);

  // ── Contact tracking ────────────────────────────────────────────────────────
  const [contacts, setContacts] = useState<Map<string, Contact>>(new Map());
  const [contactFocus, setContactFocus] = useState<{ cs: string; n: number } | null>(null);
  const selectContact = useCallback(
    (cs: string) => setContactFocus(prev => ({ cs, n: (prev?.n ?? 0) + 1 })),
    [],
  );
  const prevResultLenRef = useRef(0);
  // Always-current VFO ref — readable synchronously inside effects without stale closure
  const vfoRef = useRef<number>(0);
  useEffect(() => { vfoRef.current = vfoFrequency ?? 0; }, [vfoFrequency]);

  // Frozen VFO per decoded window: windowStart.getTime() → vfoHz at that moment.
  // Keyed by timestamp so entries survive result-array prepends without index shifting.
  const frozenVfoRef = useRef<Map<number, number>>(new Map());

  useEffect(() => {
    const { results } = state;
    if (results.length < prevResultLenRef.current) {
      prevResultLenRef.current = 0;
      frozenVfoRef.current.clear();
      return;
    }
    const newCount = results.length - prevResultLenRef.current;
    if (newCount <= 0) return;

    // Snapshot VFO for each new window (results is newest-first)
    const currentVfo = vfoRef.current;
    const fresh = results.slice(0, newCount);
    for (const r of fresh) {
      frozenVfoRef.current.set(r.windowStart.getTime(), currentVfo);
    }

    // Bake absolute freq into ContactMsg so contacts panel never needs VFO
    setContacts(prev => {
      let m = prev;
      for (const r of fresh.slice().reverse()) {
        const msgsWithAbsFreq = r.messages.map(msg => ({
          ...msg,
          freq: currentVfo > 0 ? currentVfo + msg.freq : msg.freq,
        }));
        m = mergeContacts(m, r.windowStart, msgsWithAbsFreq, 0);
      }
      return m;
    });
    prevResultLenRef.current = results.length;
  }, [state.results]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleReset = useCallback(() => {
    clearResults();
    setContacts(new Map());
    prevResultLenRef.current = 0;
    frozenVfoRef.current.clear();
  }, [clearResults]);

  // ── 2-panel drag ────────────────────────────────────────────────────────────
  const containerRef    = useRef<HTMLDivElement>(null);
  const [panelWeights, setPanelWeights] = useState([0.8, 0.6, 1.2]);
  const panelWeightsRef = useRef([0.8, 0.6, 1.2]);
  const panelDragRef    = useRef<{ divider: number; startX: number; startW: number[] } | null>(null);
  useEffect(() => { panelWeightsRef.current = panelWeights; }, [panelWeights]);

  const startPanelDrag = (divider: number) => (e: React.MouseEvent) => {
    e.preventDefault();
    panelDragRef.current = { divider, startX: e.clientX, startW: [...panelWeightsRef.current] };
  };
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const d = panelDragRef.current;
      if (!d || !containerRef.current) return;
      const total = d.startW.reduce((a, b) => a + b, 0);
      const dw    = ((e.clientX - d.startX) / containerRef.current.offsetWidth) * total;
      const nw    = [...d.startW];
      nw[d.divider]     = Math.max(0.15, d.startW[d.divider] + dw);
      nw[d.divider + 1] = Math.max(0.15, d.startW[d.divider + 1] - dw);
      setPanelWeights(nw);
    };
    const onUp = () => { panelDragRef.current = null; };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup',   onUp);
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
  }, []);

  // ── Derived ─────────────────────────────────────────────────────────────────
  const { results, status } = state;
  const windowSec = FT_WINDOW_SECONDS[ftMode];
  const totalMsgs = results.reduce((s, r) => s + r.messages.length, 0);
  const hasData   = results.length > 0 || contacts.size > 0;

  type SepRow = { kind: 'sep'; time: Date; mode: FTMode; empty: boolean; key: string };
  type MsgRow = { kind: 'msg'; absFreq: string; dt: number; snr: number; msg: string; time: Date; key: string };
  type TableRow = SepRow | MsgRow;

  // Use the VFO that was active at the moment each window was decoded (frozen).
  const tableRows: TableRow[] = results.flatMap((r, ri) => {
    const frozenVfo = frozenVfoRef.current.get(r.windowStart.getTime()) ?? 0;
    return [
      { kind: 'sep' as const, time: r.windowStart, mode: r.mode, empty: r.messages.length === 0, key: `sep-${ri}` },
      ...r.messages.map((m, mi) => ({
        kind: 'msg' as const,
        absFreq: formatFreq(m.freq, frozenVfo),
        dt: m.dt, snr: m.snr, msg: m.msg,
        time: r.windowStart, key: `msg-${ri}-${mi}`,
      })),
    ];
  });

  const controls: DecoderControls = {
    isRecording: state.isRecording,
    isSupported: ftSupported,
    error: state.error ?? null,
    start: startRecording,
    stop: stopRecording,
    reset: handleReset,
  };
  useImperativeHandle(ref, () => controls, [state.isRecording, ftSupported, state.error, startRecording, stopRecording, handleReset]); // eslint-disable-line react-hooks/exhaustive-deps
  const onStateChangeRef = useRef(onStateChange);
  onStateChangeRef.current = onStateChange;
  useEffect(() => { onStateChangeRef.current?.(controls); }, [state.isRecording, ftSupported, state.error]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="space-y-3 sm:space-y-4">

      {/* ── 3-panel layout ───────────────────────────────────────────────────── */}
      {/* Bounded height on lg so panel content scrolls instead of growing the page */}
      <div ref={containerRef} className="flex flex-col lg:flex-row lg:items-stretch gap-4 lg:gap-0 lg:h-[max(480px,calc(100vh-280px))]" style={{ minHeight: 480 }}>

        {/* Panel 1 — Decoded Messages */}
        <div
          className="bg-[#161b22] border border-[#30363d] rounded-lg p-3 sm:p-4 flex flex-col min-w-0"
          style={{ flex: panelWeights[0] }}
        >
          <div className="flex items-start justify-between mb-3 shrink-0 gap-3">
            <h2 className="text-lg sm:text-xl font-semibold">Decoded Messages</h2>
            {/* Clock + counters — always visible, dimmed when idle */}
            <div className={`flex items-center gap-2 shrink-0 transition-opacity ${!state.isRecording ? 'opacity-30' : ''}`}>
              <ClockRing status={status} windowSec={windowSec} />
              <div className="flex flex-wrap gap-1.5">
                {[
                  { label: 'Mode',    value: ftMode },
                  { label: 'Windows', value: results.length },
                  { label: 'Total',   value: totalMsgs },
                  { label: 'Last #',  value: results[0] ? results[0].messages.length : '—' },
                ].map(({ label, value }) => (
                  <div key={label} className="bg-[#0d1117] border border-[#21262d] rounded px-2 py-1">
                    <div className="text-[#484f58] text-[9px]">{label}</div>
                    <div className="font-mono font-semibold text-xs text-[#c9d1d9]">{value}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {state.error && (
            <div className="mb-2 bg-[#da3633]/10 border border-[#f85149]/30 rounded-md p-2 text-[#f85149] text-xs shrink-0">
              {state.error}
            </div>
          )}

          {!ftSupported && (
            <div className="mb-2 bg-[#e3b341]/10 border border-[#e3b341]/30 rounded-md p-2 text-[#e3b341] text-xs flex items-start gap-2 shrink-0">
              <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5 mt-0.5 shrink-0" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
              </svg>
              <span>
                <strong>FT2 is experimental</strong> — no JS decoder available yet. Switch to FT8 or FT4 to decode.
              </span>
            </div>
          )}


          <div className="flex-1 overflow-y-auto min-h-0 max-h-[60vh] lg:max-h-none font-mono text-xs">
            {results.length === 0 ? (
              <div className="flex items-center justify-center h-full">
                <div className="text-center text-[#484f58] space-y-2">
                  <div className="text-4xl">📻</div>
                  <div>{state.isRecording
                    ? `Waiting for next ${ftMode} window…`
                    : `Start decoding to receive ${ftMode} signals`}
                  </div>
                  {state.isRecording && ftSupported && (
                    <div className="text-[#30363d]">UTC-synchronized · {windowSec}s windows</div>
                  )}
                </div>
              </div>
            ) : (
              <table className="w-full border-collapse">
                <thead className="sticky top-0 bg-[#0d1117] z-10">
                  <tr className="text-[#8b949e] border-b border-[#30363d]">
                    <th className="text-left py-1.5 px-2 font-semibold whitespace-nowrap">UTC</th>
                    <th className="text-right py-1.5 px-2 font-semibold">Hz</th>
                    <th className="text-right py-1.5 px-2 font-semibold">dB</th>
                    <th className="text-right py-1.5 px-2 font-semibold" title="Time offset vs UTC window">Δ</th>
                    <th className="text-left py-1.5 px-2 font-semibold w-full">Message</th>
                  </tr>
                </thead>
                <tbody>
                  {tableRows.map(row =>
                    row.kind === 'sep' ? (
                      <tr key={row.key}>
                        <td colSpan={5} className="px-2 py-0.5 text-[10px] text-[#484f58] border-t border-[#21262d] bg-[#0d1117]/60">
                          {utcTime(row.time)} UTC — {row.mode}
                          {row.empty && <span className="ml-2 text-[#30363d]">no signals</span>}
                        </td>
                      </tr>
                    ) : (
                      <tr key={row.key} className="border-b border-[#21262d]/50 hover:bg-[#21262d]/40 transition-colors">
                        <td className="py-1 px-2 text-[#484f58] whitespace-nowrap">{utcTime(row.time)}</td>
                        <td className="py-1 px-2 text-right text-[#8b949e] whitespace-nowrap">{row.absFreq}</td>
                        <td className="py-1 px-2 text-right whitespace-nowrap" style={{ color: snrColor(row.snr) }}>
                          {row.snr > 0 ? '+' : ''}{row.snr.toFixed(4)}
                        </td>
                        <td className="py-1 px-2 text-right whitespace-nowrap" style={{ color: dtColor(row.dt) }}>
                          {formatDT(row.dt)}
                        </td>
                        <td className="py-1 px-2 truncate max-w-0" style={{ color: msgColor(row.msg, row.snr) }}>
                          <MsgText msg={row.msg} contacts={contacts} onSelect={selectContact} />
                        </td>
                      </tr>
                    )
                  )}
                </tbody>
              </table>
            )}
          </div>
        </div>

        {/* Drag handle 0↔1 */}
        <div
          className="hidden lg:flex w-3 self-stretch cursor-col-resize items-center justify-center group shrink-0"
          onMouseDown={startPanelDrag(0)}
        >
          <div className="w-px h-full bg-[#30363d] group-hover:bg-[#2ea043]/50 transition-colors" />
        </div>

        {/* Panel 2 — Audio Analysis */}
        <AudioAnalysisPanel
          analyser={analyser ?? null}
          isRecording={state.isRecording}
          vfoFrequency={vfoFrequency}
          className="min-w-0"
          style={{ flex: panelWeights[1] }}
        />

        {/* Drag handle 1↔2 */}
        <div
          className="hidden lg:flex w-3 self-stretch cursor-col-resize items-center justify-center group shrink-0"
          onMouseDown={startPanelDrag(1)}
        >
          <div className="w-px h-full bg-[#30363d] group-hover:bg-[#2ea043]/50 transition-colors" />
        </div>

        {/* Panel 3 — Contacts */}
        <div
          className="bg-[#161b22] border border-[#30363d] rounded-lg p-3 sm:p-4 min-w-0 flex flex-col"
          style={{ flex: panelWeights[2] }}
        >
          <FTContactsPanel
            contacts={contacts}
            mode={ftMode}
            onClearContacts={() => setContacts(new Map())}
            focus={contactFocus}
          />
        </div>
      </div>

      {/* ── How to Use ── */}
      <details className="bg-[#161b22] border border-[#30363d] rounded-lg">
        <summary className="cursor-pointer p-4 sm:p-5 font-semibold text-base sm:text-lg hover:bg-[#21262d] rounded-lg transition-colors select-none">
          How to Use
        </summary>
        <div className="px-4 pb-4 sm:px-5 sm:pb-5 space-y-3">
          <ol className="list-decimal list-inside space-y-1.5 text-sm text-[#c9d1d9]">
            <li>Ensure your clock is NTP-synchronized — FT8/FT4 requires UTC sync within ±1 second</li>
            <li>Select <strong>FT8</strong> (15 s) or <strong>FT4</strong> (7.5 s) in the mode selector above</li>
            <li>Click <strong>Start</strong> and allow microphone access</li>
            <li>Tune to a FT8/FT4 frequency in USB mode (e.g. 14.074 MHz for 20m FT8)</li>
            <li>Decoder waits for the next UTC window, then records and decodes automatically</li>
            <li><span className="text-[#2ea043]">Green</span> rows are CQ calls — Contacts panel tracks unique callsigns with QSO history</li>
          </ol>
          <div className="bg-[#0d1117] border border-[#30363d] rounded-md p-3 text-xs text-[#8b949e] space-y-1">
            <p><strong className="text-[#c9d1d9]">Common frequencies:</strong></p>
            <p>FT8 — 1.840 · 3.573 · 7.074 · 10.136 · 14.074 · 18.100 · 21.074 · 24.915 · 28.074 MHz</p>
            <p>FT4 — 3.575 · 7.047 · 10.140 · 14.080 · 18.104 · 21.140 · 24.919 · 28.180 MHz</p>
          </div>
        </div>
      </details>

      <details className="bg-[#161b22] border border-[#30363d] rounded-lg">
        <summary className="cursor-pointer p-4 sm:p-5 font-semibold text-base sm:text-lg hover:bg-[#21262d] rounded-lg transition-colors select-none">
          Privacy
        </summary>
        <div className="px-4 pb-4 sm:px-5 sm:pb-5 text-sm text-[#c9d1d9] space-y-1.5">
          <p>All decoding runs entirely in your browser. No audio or decoded messages are transmitted to any server.</p>
          <p className="text-xs text-[#8b949e]">FT8/FT4 decoding powered by <a href="https://github.com/e04/ft8ts" target="_blank" rel="noopener noreferrer" className="underline hover:text-[#c9d1d9]">ft8ts</a> (GPL-3.0).</p>
        </div>
      </details>
    </div>
  );
});

export default FTDecoder;
