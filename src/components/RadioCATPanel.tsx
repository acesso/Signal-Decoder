'use client';

import { useState, useCallback, useRef } from 'react';
import { useRadioCAT, type CATMode, type CATConnectionConfig, type RigProfile, type RadioCATControls } from '@/hooks/useRadioCAT';
export { useRadioCAT };

// ── Constants ─────────────────────────────────────────────────────────────────

const MODES: CATMode[] = ['USB', 'LSB', 'AM', 'FM', 'CW', 'RTTY'];

const BAUD_RATES = [1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200];

interface RadioPreset {
  label: string;
  baudRate: number;
  dataBits: number;
  stopBits: number;
  parity: 'none' | 'even' | 'odd';
  notes: string;
  rigProfile: RigProfile;
}

const RADIO_PRESETS: RadioPreset[] = [
  { label: 'uSDX BLACK_BRICK 4.00e',            baudRate: 38400,  dataBits: 8, stopBits: 1, parity: 'none', notes: 'PU7FTW custom firmware — adds volume, attenuator, noise reduction, AGC, filter, TX drive and S-meter controls, batched CAT polling', rigProfile: 'usdx-blackbrick' },
  { label: 'Kenwood TS-480 / TS-590 / TS-2000', baudRate: 9600,   dataBits: 8, stopBits: 1, parity: 'none', notes: 'Default 9600 8N1', rigProfile: 'generic' },
  { label: 'Kenwood TS-480 (high speed)',        baudRate: 57600,  dataBits: 8, stopBits: 1, parity: 'none', notes: 'Configure in menu 60', rigProfile: 'generic' },
  { label: 'Icom IC-7300 / IC-7610',             baudRate: 9600,   dataBits: 8, stopBits: 1, parity: 'none', notes: 'Set CI-V USB Baud Rate to 9600', rigProfile: 'generic' },
  { label: 'Icom IC-7300 (high speed)',          baudRate: 115200, dataBits: 8, stopBits: 1, parity: 'none', notes: 'Set CI-V USB Baud Rate to Auto', rigProfile: 'generic' },
  { label: 'Yaesu FT-817 / FT-818',             baudRate: 4800,   dataBits: 8, stopBits: 2, parity: 'none', notes: 'Default 4800 8N2', rigProfile: 'generic' },
  { label: 'Yaesu FT-991A',                     baudRate: 38400,  dataBits: 8, stopBits: 1, parity: 'none', notes: 'Menu 031 = 38400', rigProfile: 'generic' },
  { label: 'Elecraft K3 / KX3',                 baudRate: 38400,  dataBits: 8, stopBits: 1, parity: 'none', notes: 'CONFIG > BAUD = 38400', rigProfile: 'generic' },
  { label: 'Custom / Other',                     baudRate: 9600,   dataBits: 8, stopBits: 1, parity: 'none', notes: 'Manually set baud rate below', rigProfile: 'generic' },
];

// ── Frequency helpers ─────────────────────────────────────────────────────────

type FreqUnit = 'MHz' | 'KHz';

function parseFreqInput(raw: string, unit: FreqUnit): number | null {
  const s = raw.replace(/[,_\s]/g, '');
  const n = parseFloat(s);
  if (isNaN(n) || n <= 0) return null;
  if (unit === 'MHz') return Math.round(n * 1_000_000);
  return Math.round(n * 1_000); // KHz → Hz
}

function freqToDisplay(hz: number, unit: FreqUnit): string {
  if (unit === 'MHz') return (hz / 1_000_000).toFixed(6);
  return (hz / 1_000).toFixed(3);
}

// ── FrequencyInput ────────────────────────────────────────────────────────────
// Display mode: three color-coded groups  XX.XXX.XXX
// Edit mode:    plain input with MHz/kHz toggle + scroll wheel nudge

function FrequencyInput({ frequency, onCommit }: {
  frequency: number | null;
  onCommit: (hz: number) => void;
}) {
  const [editing, setEditing]   = useState(false);
  const [draft,   setDraft]     = useState('');
  const [unit,    setUnit]      = useState<FreqUnit>('KHz');
  const inputRef = useRef<HTMLInputElement>(null);

  const startEdit = () => {
    setDraft(frequency !== null ? freqToDisplay(frequency, unit) : '');
    setEditing(true);
    setTimeout(() => { inputRef.current?.select(); }, 0);
  };

  const commit = (raw = draft) => {
    const hz = parseFreqInput(raw, unit);
    if (hz !== null) onCommit(hz);
    setEditing(false);
  };

  const onWheel = (e: React.WheelEvent<HTMLInputElement>) => {
    e.preventDefault();
    const step = unit === 'MHz' ? 0.001 : 1; // 1 kHz steps
    const n = parseFloat(draft) || 0;
    const next = n + (e.deltaY < 0 ? step : -step);
    const nextStr = unit === 'MHz' ? next.toFixed(6) : next.toFixed(3);
    setDraft(nextStr);
    const hz = parseFreqInput(nextStr, unit);
    if (hz && hz > 0) onCommit(hz);
  };

  const toggleUnit = () => {
    const next: FreqUnit = unit === 'MHz' ? 'KHz' : 'MHz';
    setUnit(next);
    if (frequency !== null) setDraft(freqToDisplay(frequency, next));
  };

  // The unit toggle is always visible (both display and edit mode), at the
  // right side of the frequency — click to switch MHz/kHz for both the
  // display formatting and the next edit's input format.
  const unitToggle = (
    <button
      onMouseDown={e => { e.preventDefault(); toggleUnit(); }}
      className="text-[10px] font-bold px-1.5 py-1 rounded bg-[#21262d] border border-[#30363d] text-[#8b949e] hover:text-[#c9d1d9] hover:border-[#8b949e] transition-colors select-none shrink-0"
      title="Switch between MHz and kHz"
    >
      {unit}
    </button>
  );

  // ── Display (non-editing) ──
  if (!editing) {
    let mhzPart = '——', khzPart = '———', hzPart = '———';
    if (frequency !== null) {
      const s = frequency.toString().padStart(9, '0');
      mhzPart = s.slice(0, s.length - 6);
      khzPart = s.slice(-6, -3);
      hzPart  = s.slice(-3);
    }
    return (
      <div className="flex items-center gap-1.5">
        <button
          onClick={startEdit}
          title="Click to edit frequency"
          className="flex items-center gap-0 font-mono text-sm tabular-nums tracking-wider hover:opacity-80 transition-opacity"
        >
          <span className="text-[#c9d1d9]">{mhzPart}</span>
          <span className="text-[#484f58]">.</span>
          <span className="text-[#79c0ff]">{khzPart}</span>
          <span className="text-[#484f58]">.</span>
          <span className="text-[#6e7681]">{hzPart}</span>
        </button>
        {unitToggle}
      </div>
    );
  }

  // ── Edit mode ──
  return (
    <div className="flex items-center gap-1">
      <input
        ref={inputRef}
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onBlur={() => commit()}
        onKeyDown={e => {
          if (e.key === 'Enter')  { e.preventDefault(); commit(); }
          if (e.key === 'Escape') { setEditing(false); }
        }}
        onWheel={onWheel}
        placeholder={unit === 'MHz' ? '14.225000' : '14225.000'}
        className="w-32 bg-[#0d1117] border border-[#388bfd] text-[#79c0ff] font-mono text-sm px-2 py-1 rounded focus:outline-none"
      />
      {unitToggle}
    </div>
  );
}

// ── ModeSelector ──────────────────────────────────────────────────────────────

function ModeSelector({ mode, onChange }: {
  mode: CATMode | null; onChange: (m: CATMode) => void;
}) {
  return (
    <div className="flex items-center gap-0.5">
      {MODES.map(m => (
        <button
          key={m}
          onClick={() => onChange(m)}
          className={`text-[10px] font-semibold px-1.5 py-1 rounded transition-colors
            ${mode === m ? 'bg-[#388bfd] text-white' : 'text-[#8b949e] hover:text-[#c9d1d9]'}`}
        >
          {m}
        </button>
      ))}
    </div>
  );
}

// ── PTTButton ─────────────────────────────────────────────────────────────────

function PTTButton({ ptt, onToggle }: { ptt: boolean; onToggle: () => void }) {
  return (
    <button
      onClick={onToggle}
      title={ptt ? 'Transmitting — click to go back to RX' : 'Push to Talk — click to transmit'}
      className={`flex items-center justify-center gap-1.5 text-xs font-bold w-16 py-1.5 rounded-md transition-colors border shrink-0
        ${ptt
          ? 'bg-[#f85149] border-[#f85149] text-white'
          : 'bg-[#21262d] border-[#30363d] text-[#8b949e] hover:text-[#c9d1d9] hover:border-[#8b949e]'
        }`}
    >
      {ptt ? (
        // Transmitting — pulsing dot replaces mic icon, label stays PTT
        <>
          <span className="w-2 h-2 rounded-full bg-white animate-pulse shrink-0" />
          PTT
        </>
      ) : (
        <>
          <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5 shrink-0" viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M7 4a3 3 0 016 0v4a3 3 0 11-6 0V4zm4 10.93A7.001 7.001 0 0017 8a1 1 0 10-2 0A5 5 0 015 8a1 1 0 00-2 0 7.001 7.001 0 006 6.93V17H6a1 1 0 100 2h8a1 1 0 100-2h-3v-2.07z" clipRule="evenodd" />
          </svg>
          PTT
        </>
      )}
    </button>
  );
}

// ── SettingsPanel ─────────────────────────────────────────────────────────────

function SettingsPanel({ config, onConfigChange, onConnect }: {
  config: CATConnectionConfig & { presetIdx: number };
  onConfigChange: (c: CATConnectionConfig & { presetIdx: number }) => void;
  onConnect: () => void;
}) {
  const preset = RADIO_PRESETS[config.presetIdx];

  const applyPreset = (idx: number) => {
    const p = RADIO_PRESETS[idx];
    onConfigChange({ presetIdx: idx, baudRate: p.baudRate, dataBits: p.dataBits, stopBits: p.stopBits, parity: p.parity, timeoutMs: config.timeoutMs, pollIntervalMs: config.pollIntervalMs, debug: config.debug, rigProfile: p.rigProfile });
  };

  return (
    <div className="mt-2 bg-[#161b22] border border-[#30363d] rounded-lg p-4 flex flex-col gap-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="sm:col-span-2 flex flex-col gap-1.5">
          <label className="text-[10px] font-semibold uppercase tracking-widest text-[#8b949e]">Radio Model</label>
          <select
            value={config.presetIdx}
            onChange={e => applyPreset(Number(e.target.value))}
            className="bg-[#0d1117] border border-[#30363d] text-[#c9d1d9] text-xs rounded px-2 py-1.5 focus:outline-none focus:border-[#388bfd]"
          >
            {RADIO_PRESETS.map((p, i) => (
              <option key={i} value={i}>{p.label}</option>
            ))}
          </select>
          {preset.notes && <p className="text-[10px] text-[#8b949e]">{preset.notes}</p>}
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="text-[10px] font-semibold uppercase tracking-widest text-[#8b949e]">Baud Rate</label>
          <select
            value={config.baudRate}
            onChange={e => onConfigChange({ ...config, baudRate: Number(e.target.value) })}
            className="bg-[#0d1117] border border-[#30363d] text-[#c9d1d9] text-xs rounded px-2 py-1.5 focus:outline-none focus:border-[#388bfd]"
          >
            {BAUD_RATES.map(b => <option key={b} value={b}>{b}</option>)}
          </select>
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="text-[10px] font-semibold uppercase tracking-widest text-[#8b949e]">Data Bits</label>
          <select
            value={config.dataBits}
            onChange={e => onConfigChange({ ...config, dataBits: Number(e.target.value) })}
            className="bg-[#0d1117] border border-[#30363d] text-[#c9d1d9] text-xs rounded px-2 py-1.5 focus:outline-none focus:border-[#388bfd]"
          >
            {[7, 8].map(n => <option key={n} value={n}>{n}</option>)}
          </select>
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="text-[10px] font-semibold uppercase tracking-widest text-[#8b949e]">Stop Bits</label>
          <select
            value={config.stopBits}
            onChange={e => onConfigChange({ ...config, stopBits: Number(e.target.value) })}
            className="bg-[#0d1117] border border-[#30363d] text-[#c9d1d9] text-xs rounded px-2 py-1.5 focus:outline-none focus:border-[#388bfd]"
          >
            {[1, 2].map(n => <option key={n} value={n}>{n}</option>)}
          </select>
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="text-[10px] font-semibold uppercase tracking-widest text-[#8b949e]">Parity</label>
          <select
            value={config.parity}
            onChange={e => onConfigChange({ ...config, parity: e.target.value as 'none' | 'even' | 'odd' })}
            className="bg-[#0d1117] border border-[#30363d] text-[#c9d1d9] text-xs rounded px-2 py-1.5 focus:outline-none focus:border-[#388bfd]"
          >
            {(['none', 'even', 'odd'] as const).map(p => (
              <option key={p} value={p}>{p.charAt(0).toUpperCase() + p.slice(1)}</option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="text-[10px] font-semibold uppercase tracking-widest text-[#8b949e]">Cmd Timeout (ms)</label>
          <input
            type="number" min={50} max={5000} step={50}
            value={config.timeoutMs}
            onChange={e => onConfigChange({ ...config, timeoutMs: Math.max(50, Math.min(5000, Number(e.target.value))) })}
            className="bg-[#0d1117] border border-[#30363d] text-[#c9d1d9] text-xs rounded px-2 py-1.5 focus:outline-none focus:border-[#388bfd] font-mono"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="text-[10px] font-semibold uppercase tracking-widest text-[#8b949e]">Query Interval (ms)</label>
          <input
            type="number" min={200} max={10000} step={100}
            value={config.pollIntervalMs}
            onChange={e => onConfigChange({ ...config, pollIntervalMs: Math.max(200, Math.min(10000, Number(e.target.value))) })}
            className="bg-[#0d1117] border border-[#30363d] text-[#c9d1d9] text-xs rounded px-2 py-1.5 focus:outline-none focus:border-[#388bfd] font-mono"
          />
        </div>

        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            id="cat-debug"
            checked={config.debug}
            onChange={e => onConfigChange({ ...config, debug: e.target.checked })}
            className="accent-[#388bfd]"
          />
          <label htmlFor="cat-debug" className="text-[10px] font-semibold uppercase tracking-widest text-[#8b949e] cursor-pointer select-none">
            Debug logging (browser console)
          </label>
        </div>
      </div>

      <p className="text-[10px] text-[#484f58] border-t border-[#21262d] pt-3">
        <span className="text-[#8b949e] font-semibold">Linux / macOS:</span>{' '}
        ensure your user is in the <code className="text-[#79c0ff]">dialout</code> group:{' '}
        <code className="text-[#c9d1d9]">sudo usermod -a -G dialout $USER</code> then log out and back in.
        The browser will present a port picker (<code className="text-[#79c0ff]">/dev/ttyUSB*</code> or{' '}
        <code className="text-[#79c0ff]">/dev/ttyACM*</code>) when you click Connect.
      </p>

      <button
        onClick={onConnect}
        className="self-start flex items-center gap-2 bg-[#238636] hover:bg-[#2ea043] text-white text-xs font-semibold px-4 py-2 rounded-md transition-colors"
      >
        <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor">
          <path fillRule="evenodd" d="M12.586 4.586a2 2 0 112.828 2.828l-3 3a2 2 0 01-2.828 0 1 1 0 00-1.414 1.414 4 4 0 005.656 0l3-3a4 4 0 00-5.656-5.656l-1.5 1.5a1 1 0 101.414 1.414l1.5-1.5zm-5 5a2 2 0 012.828 0 1 1 0 101.414-1.414 4 4 0 00-5.656 0l-3 3a4 4 0 105.656 5.656l1.5-1.5a1 1 0 10-1.414-1.414l-1.5 1.5a2 2 0 11-2.828-2.828l3-3z" clipRule="evenodd" />
        </svg>
        Connect Radio
      </button>
    </div>
  );
}

// ── NumberStepper ─────────────────────────────────────────────────────────────
// Labeled -/+ stepper for small bounded ranges (volume, attenuators, noise reduction).
// `valueLabels[n - min]`, when provided, is shown instead of the raw index —
// used for the analog attenuator, whose firmware steps map to fixed dB presets,
// not a linear scale.

function NumberStepper({ label, value, min, max, valueLabels, onChange }: {
  label: string;
  value: number | null;
  min: number;
  max: number;
  valueLabels?: string[];
  onChange: (n: number) => void;
}) {
  const v = value ?? min;
  const step = (delta: number) => onChange(Math.max(min, Math.min(max, v + delta)));
  const display = value === null ? '—' : (valueLabels?.[value - min] ?? String(value));
  return (
    <div className="flex items-center gap-1.5" title={label}>
      <span className="text-[10px] font-semibold text-[#8b949e] whitespace-nowrap">{label}</span>
      <button
        onClick={() => step(-1)}
        disabled={value === null || v <= min}
        className="w-5 h-5 flex items-center justify-center text-xs rounded bg-[#21262d] border border-[#30363d] text-[#8b949e] hover:text-[#c9d1d9] hover:border-[#8b949e] disabled:opacity-30 disabled:hover:border-[#30363d]"
      >
        −
      </button>
      <span className="text-xs font-mono tabular-nums w-12 text-center text-[#c9d1d9]">{display}</span>
      <button
        onClick={() => step(1)}
        disabled={value === null || v >= max}
        className="w-5 h-5 flex items-center justify-center text-xs rounded bg-[#21262d] border border-[#30363d] text-[#8b949e] hover:text-[#c9d1d9] hover:border-[#8b949e] disabled:opacity-30 disabled:hover:border-[#30363d]"
      >
        +
      </button>
    </div>
  );
}

// Analog attenuator firmware preset steps — from `att_label[]` in usdxBLACKBRICK.ino
// (param enum ATT, EEPROM 0x1A). Not linear — each index is a fixed dB pad.
const ANALOG_ATTENUATOR_DB_LABELS = ['0dB', '-13dB', '-20dB', '-33dB', '-40dB', '-53dB', '-60dB', '-73dB'];

// Digital attenuator (A2, EEPROM 0x1B) is a raw bit-shift on the audio sample
// (`ac2 >>= att2` in usdxBLACKBRICK.ino) — each step halves the amplitude,
// i.e. exactly -6.02dB/step, linear across the full 0..16 range.
const DIGITAL_ATTENUATOR_DB_LABELS = [
  '0dB', '-6dB', '-12dB', '-18dB', '-24dB', '-30dB', '-36dB', '-42dB',
  '-48dB', '-54dB', '-60dB', '-66dB', '-72dB', '-78dB', '-84dB', '-90dB', '-96dB',
];

// Filter bandwidth labels — mirrors filt_label[] in firmware for F_MCU > 16MHz builds
// (this rig runs at 20MHz), param enum FILTER, EEPROM 0x13.
const FILTER_LABELS = ['Full', '3kHz', '2.4kHz', '1.8kHz', '500Hz', '200Hz', '100Hz', '50Hz'];

// AGC firmware behavior note: FAST_AGC is undefined in this build (usdxBLACKBRICK.ino),
// so the runtime only branches on agc==1 vs agc==0 (process_agc_fast vs no AGC) — agc==2
// ("Slow") has no distinct code path and is indistinguishable from off. The menu itself
// (case AGC, offon_label) exposes only OFF/ON. So the UI mirrors that as a toggle.
const AGC_ON = 1;
const AGC_OFF = 0;

// ── SMeterDisplay ─────────────────────────────────────────────────────────────
// Read-only dBm readout — no +/- controls, since there is no SM SET command.

function SMeterDisplay({ dbm }: { dbm: number | null }) {
  return (
    <div className="flex items-center gap-1.5" title="S-Meter (signal strength)">
      <span className="text-[10px] font-semibold text-[#8b949e] whitespace-nowrap">S-Meter</span>
      <span className="text-xs font-mono tabular-nums w-16 text-center text-[#79c0ff] bg-[#0d1117] border border-[#30363d] rounded px-1.5 py-0.5">
        {dbm === null ? '—' : `${dbm} dBm`}
      </span>
    </div>
  );
}

// ── BlackBrickControls ────────────────────────────────────────────────────────
// uSDX BLACK_BRICK 4.00e custom extension controls: volume, attenuators, noise
// reduction, AGC, filter, TX drive. Wraps onto its own row below the main
// toolbar. S-Meter is shown separately in the main toolbar since it's a
// read-only reading, not a control.

function BlackBrickControls({ volume, att1, att2, nr, agc, filter, drive, onVolume, onAtt1, onAtt2, onNR, onAGC, onFilter, onDrive }: {
  volume: number | null;
  att1: number | null;
  att2: number | null;
  nr: number | null;
  agc: number | null;
  filter: number | null;
  drive: number | null;
  onVolume: (n: number) => void;
  onAtt1: (n: number) => void;
  onAtt2: (n: number) => void;
  onNR: (n: number) => void;
  onAGC: (n: number) => void;
  onFilter: (n: number) => void;
  onDrive: (n: number) => void;
}) {
  const agcOn = agc === AGC_ON;
  return (
    <div className="basis-full flex items-center gap-3 flex-wrap pt-2 mt-1 border-t border-[#21262d]">
      <NumberStepper label="Volume" value={volume} min={-1} max={16} onChange={onVolume} />
      <NumberStepper label="Analog Attenuator" value={att1} min={0} max={7} valueLabels={ANALOG_ATTENUATOR_DB_LABELS} onChange={onAtt1} />
      <NumberStepper label="Digital Attenuator" value={att2} min={0} max={16} valueLabels={DIGITAL_ATTENUATOR_DB_LABELS} onChange={onAtt2} />
      <NumberStepper label="Noise Reduction" value={nr} min={0} max={8} onChange={onNR} />
      <NumberStepper label="Filter Bandwidth" value={filter} min={0} max={7} valueLabels={FILTER_LABELS} onChange={onFilter} />
      <NumberStepper label="TX Driver" value={drive} min={0} max={8} onChange={onDrive} />

      <div className="flex items-center gap-1.5" title="Auto Gain Control">
        <span className="text-[10px] font-semibold text-[#8b949e] whitespace-nowrap">Auto Gain Control</span>
        <button
          onClick={() => onAGC(agcOn ? AGC_OFF : AGC_ON)}
          disabled={agc === null}
          className={`text-[10px] font-semibold px-2 py-1 rounded transition-colors border disabled:opacity-30
            ${agcOn
              ? 'bg-[#238636] border-[#238636] text-white'
              : 'bg-[#21262d] border-[#30363d] text-[#8b949e] hover:text-[#c9d1d9] hover:border-[#8b949e]'
            }`}
        >
          {agc === null ? '—' : agcOn ? 'ON' : 'OFF'}
        </button>
      </div>
    </div>
  );
}

// ── Main panel ────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: CATConnectionConfig & { presetIdx: number } = {
  presetIdx: 0,
  baudRate: 38400, dataBits: 8, stopBits: 1, parity: 'none',
  timeoutMs: 200, pollIntervalMs: 500, debug: false,
  rigProfile: RADIO_PRESETS[0].rigProfile,
};

export default function RadioCATPanel({ cat }: { cat: ReturnType<typeof useRadioCAT> }) {
  const { state, connect, disconnect, setFrequency, setMode, setPTT, setVolume, setAtt1, setAtt2, setNR, setAGC, setFilter, setDrive } = cat;
  const { connected, frequency, mode, ptt, error, isSupported, volume, att1, att2, nr, agc, filter, sMeter, drive } = state;

  const [showSettings, setShowSettings] = useState(false);
  const [config, setConfig] = useState(DEFAULT_CONFIG);

  const handleConnect    = useCallback(() => { setShowSettings(false); connect(config).catch(() => {}); }, [connect, config]);
  const handleFreqCommit = useCallback((hz: number) => { setFrequency(hz).catch(() => {}); }, [setFrequency]);
  const handleModeChange = useCallback((m: CATMode) => { setMode(m).catch(() => {}); }, [setMode]);
  const handlePTTToggle  = useCallback(() => { setPTT(!ptt).catch(() => {}); }, [setPTT, ptt]);
  const handleVolume     = useCallback((n: number) => { setVolume(n).catch(() => {}); }, [setVolume]);
  const handleAtt1       = useCallback((n: number) => { setAtt1(n).catch(() => {}); }, [setAtt1]);
  const handleAtt2       = useCallback((n: number) => { setAtt2(n).catch(() => {}); }, [setAtt2]);
  const handleNR         = useCallback((n: number) => { setNR(n).catch(() => {}); }, [setNR]);
  const handleAGC        = useCallback((n: number) => { setAGC(n).catch(() => {}); }, [setAGC]);
  const handleFilter     = useCallback((n: number) => { setFilter(n).catch(() => {}); }, [setFilter]);
  const handleDrive      = useCallback((n: number) => { setDrive(n).catch(() => {}); }, [setDrive]);

  return (
    <div>
      {/* ── Main bar ── */}
      <div className="bg-[#0d1117] border border-[#30363d] rounded-lg px-4 py-2.5 flex items-center gap-3 flex-wrap">

        <span className="text-[10px] font-bold uppercase tracking-widest text-[#8b949e] shrink-0 select-none">
          Radio CAT
        </span>

        {connected ? (
          <button
            onClick={disconnect}
            className="flex items-center gap-1.5 bg-[#da3633] hover:bg-[#f85149] text-white text-xs font-semibold px-3 py-1.5 rounded-md transition-colors shrink-0"
          >
            <span className="w-2 h-2 rounded-full bg-white animate-pulse inline-block" />
            Disconnect
          </button>
        ) : (
          <>
            <button
              onClick={() => setShowSettings(s => !s)}
              title="Configure port settings"
              className={`flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-md transition-colors border shrink-0
                ${showSettings
                  ? 'bg-[#21262d] border-[#388bfd] text-[#79c0ff]'
                  : 'bg-[#21262d] border-[#30363d] text-[#8b949e] hover:text-[#c9d1d9] hover:border-[#8b949e]'
                }`}
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.532 1.532 0 01-2.286.948c-1.372-.836-2.942.734-2.106 2.106.54.886.061 2.042-.947 2.287-1.561.379-1.561 2.6 0 2.978a1.532 1.532 0 01.947 2.287c-.836 1.372.734 2.942 2.106 2.106a1.532 1.532 0 012.287.947c.379 1.561 2.6 1.561 2.978 0a1.533 1.533 0 012.287-.947c1.372.836 2.942-.734 2.106-2.106a1.533 1.533 0 01.947-2.287c1.561-.379 1.561-2.6 0-2.978a1.532 1.532 0 01-.947-2.287c.836-1.372-.734-2.942-2.106-2.106a1.532 1.532 0 01-2.287-.947zM10 13a3 3 0 100-6 3 3 0 000 6z" clipRule="evenodd" />
              </svg>
              {RADIO_PRESETS[config.presetIdx].label.split('/')[0].trim()}
            </button>
            <button
              onClick={handleConnect}
              className="flex items-center gap-1.5 bg-[#238636] hover:bg-[#2ea043] text-white text-xs font-semibold px-3 py-1.5 rounded-md transition-colors shrink-0"
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M12.586 4.586a2 2 0 112.828 2.828l-3 3a2 2 0 01-2.828 0 1 1 0 00-1.414 1.414 4 4 0 005.656 0l3-3a4 4 0 00-5.656-5.656l-1.5 1.5a1 1 0 101.414 1.414l1.5-1.5zm-5 5a2 2 0 012.828 0 1 1 0 101.414-1.414 4 4 0 00-5.656 0l-3 3a4 4 0 105.656 5.656l1.5-1.5a1 1 0 10-1.414-1.414l-1.5 1.5a2 2 0 11-2.828-2.828l3-3z" clipRule="evenodd" />
              </svg>
              Connect Radio
            </button>
          </>
        )}

        {connected && (
          <>
            {config.rigProfile === 'usdx-blackbrick' && (
              <>
                <div className="w-px h-6 bg-[#30363d] shrink-0" />
                {/* S-Meter — read-only, shown right after Connect/Disconnect */}
                <SMeterDisplay dbm={sMeter} />
              </>
            )}

            <div className="w-px h-6 bg-[#30363d] shrink-0" />

            {/* Frequency */}
            <FrequencyInput frequency={frequency} onCommit={handleFreqCommit} />

            <div className="w-px h-6 bg-[#30363d] shrink-0" />

            {/* Mode */}
            <ModeSelector mode={mode} onChange={handleModeChange} />

            <div className="w-px h-6 bg-[#30363d] shrink-0" />

            {/* PTT */}
            <PTTButton ptt={ptt} onToggle={handlePTTToggle} />

            {/* uSDX BLACK_BRICK 4.00e extensions */}
            {config.rigProfile === 'usdx-blackbrick' && (
              <BlackBrickControls
                volume={volume} att1={att1} att2={att2} nr={nr}
                agc={agc} filter={filter} drive={drive}
                onVolume={handleVolume} onAtt1={handleAtt1} onAtt2={handleAtt2}
                onNR={handleNR}
                onAGC={handleAGC} onFilter={handleFilter} onDrive={handleDrive}
              />
            )}
          </>
        )}

        {error && (
          <>
            <div className="w-px h-6 bg-[#30363d] shrink-0" />
            <span className="text-[#f85149] text-xs font-mono truncate max-w-xs">{error}</span>
          </>
        )}

        {!isSupported && !connected && (
          <span className="text-[10px] text-[#f0883e] ml-auto hidden sm:block shrink-0">
            Web Serial not supported — use Chrome or Edge
          </span>
        )}
      </div>

      {showSettings && !connected && (
        <SettingsPanel config={config} onConfigChange={setConfig} onConnect={handleConnect} />
      )}
    </div>
  );
}
