'use client';

import { useRef, useEffect } from 'react';
import type { DecoderSession } from '@/lib/rtty/sessions';
import { PASTEL_COLORS } from '@/lib/rtty/sessions';
import type { RTTYConfig } from '@/lib/rtty/decoder';

const BAUD_RATES = [45, 45.45, 50, 65, 75, 100, 110, 150, 200, 300];

interface Props {
  session: DecoderSession;
  isActive: boolean;
  canRemove: boolean;
  onActivate: (id: string) => void;
  onRemove: (id: string) => void;
  onConfigChange: (id: string, patch: Partial<RTTYConfig>) => void;
  onLabelChange: (id: string, label: string) => void;
  onColorChange: (id: string, color: string) => void;
}

const inputCls = 'bg-[#0d1117] border border-[#30363d] rounded px-1 py-0.5 text-[#c9d1d9] text-xs font-mono focus:outline-none focus:border-[#2ea043] transition-colors w-full';

export function SessionCard({
  session,
  isActive,
  canRemove,
  onActivate,
  onRemove,
  onConfigChange,
  onLabelChange,
  onColorChange,
}: Props) {
  const { id, label, color, config, preview } = session;

  const stopProp = (e: React.MouseEvent | React.ChangeEvent<HTMLElement>) =>
    e.stopPropagation();

  // Translate inner content upward to always expose the bottom lines
  const previewOuterRef = useRef<HTMLDivElement>(null);
  const previewInnerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const outer = previewOuterRef.current;
    const inner = previewInnerRef.current;
    if (!outer || !inner) return;
    const overflow = inner.scrollHeight - outer.clientHeight;
    inner.style.transform = overflow > 0 ? `translateY(-${overflow}px)` : '';
  }, [preview]);

  return (
    <div
      onClick={() => !isActive && onActivate(id)}
      style={{ borderColor: `${color}60` }}
      className={`border rounded-lg p-3 transition-all overflow-hidden min-w-0 ${
        isActive
          ? 'bg-[#161b22] cursor-default'
          : 'bg-[#0d1117] cursor-pointer hover:brightness-110'
      }`}
    >
      {/* Header row */}
      <div className="flex items-center justify-between mb-2 gap-2">
        <div className="flex items-center gap-2 min-w-0">
          {isActive && (
            <span className="shrink-0 text-[10px] font-mono uppercase tracking-wide" style={{ color }}>
              ● active
            </span>
          )}
          <input
            value={label}
            onChange={(e) => { stopProp(e); onLabelChange(id, e.target.value); }}
            onClick={stopProp}
            className="min-w-0 flex-1 bg-transparent text-sm font-mono text-[#c9d1d9] focus:outline-none border-b border-transparent focus:border-[#30363d] truncate"
          />
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {!isActive && (
            <button
              onClick={(e) => { stopProp(e); onActivate(id); }}
              className="text-xs px-2 py-0.5 rounded border border-[#30363d] text-[#8b949e] hover:text-[#2ea043] hover:border-[#2ea043]/40 transition-colors"
            >
              Promote
            </button>
          )}
          {canRemove && (
            <button
              onClick={(e) => { stopProp(e); onRemove(id); }}
              className="text-xs px-2 py-0.5 rounded border border-[#30363d] text-[#8b949e] hover:text-[#f85149] hover:border-[#f85149]/40 transition-colors"
            >
              ✕
            </button>
          )}
        </div>
      </div>

      {/* 2×2 config grid — full labels, label above input */}
      <div className="grid grid-cols-2 gap-x-2 gap-y-2 mb-2" onClick={stopProp}>
        <label className="flex flex-col gap-0.5">
          <span className="text-[10px] text-[#8b949e]">Carrier Shift (Hz)</span>
          <input
            type="number"
            value={config.carrierShift}
            min={1}
            onChange={(e) => { stopProp(e); onConfigChange(id, { carrierShift: Math.max(1, parseInt(e.target.value) || 450) }); }}
            onClick={stopProp}
            className={inputCls}
          />
        </label>

        <label className="flex flex-col gap-0.5">
          <span className="text-[10px] text-[#8b949e]">Center Freq (Hz)</span>
          <input
            type="number"
            value={config.centerFreq}
            min={0} max={1500}
            onChange={(e) => { stopProp(e); onConfigChange(id, { centerFreq: parseInt(e.target.value) || 0 }); }}
            onClick={stopProp}
            className={inputCls}
          />
        </label>

        <label className="flex flex-col gap-0.5">
          <span className="text-[10px] text-[#8b949e]">Baud Rate</span>
          <select
            value={config.baudRate}
            onChange={(e) => { stopProp(e); onConfigChange(id, { baudRate: parseFloat(e.target.value) }); }}
            onClick={stopProp}
            className={inputCls}
          >
            {BAUD_RATES.map(b => <option key={b} value={b}>{b}</option>)}
          </select>
        </label>

        <div className="flex flex-col gap-0.5" onClick={stopProp}>
          <span className="text-[10px] text-[#8b949e]">Sideband</span>
          <button
            onClick={(e) => { stopProp(e); onConfigChange(id, { reverseShift: !config.reverseShift }); }}
            className={`text-xs px-2 py-0.5 rounded border transition-colors ${
              config.reverseShift
                ? 'bg-[#f0883e]/10 border-[#f0883e]/50 text-[#f0883e]'
                : 'bg-[#0d1117] border-[#30363d] text-[#8b949e] hover:border-[#58a6ff]/40 hover:text-[#58a6ff]'
            }`}
          >
            {config.reverseShift ? 'LSB' : 'USB'}
          </button>
        </div>
      </div>

      {/* Color palette */}
      <div className="flex flex-wrap gap-1 mb-2" onClick={stopProp}>
        {PASTEL_COLORS.map(c => (
          <button
            key={c}
            onClick={(e) => { stopProp(e); onColorChange(id, c); }}
            title={c}
            style={{
              backgroundColor: c,
              outline: c === color ? `2px solid ${c}` : 'none',
              outlineOffset: '2px',
              transform: c === color ? 'scale(1.25)' : 'scale(1)',
            }}
            className="w-4 h-4 rounded-full transition-all"
          />
        ))}
      </div>

      {/* Preview — overflow:hidden + translateY trick to always show the bottom */}
      <div
        ref={previewOuterRef}
        className={`font-mono text-xs rounded px-2 py-1.5 overflow-hidden ${isActive ? 'bg-[#0d1117]' : 'bg-[#0a0a0a]'}`}
        style={{ height: '3rem' }}
      >
        <div ref={previewInnerRef}>
          {preview
            ? <span className="whitespace-pre-wrap break-all" style={{ color }}>{preview}</span>
            : <span className="text-[#30363d]">No output yet…</span>
          }
        </div>
      </div>
    </div>
  );
}
