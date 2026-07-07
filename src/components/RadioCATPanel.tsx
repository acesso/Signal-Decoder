'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import { useRadioCAT, type CATMode, type CATConnectionConfig, type RigProfile, type RadioCATControls, type PABias, type FactoryDefaults } from '@/hooks/useRadioCAT';
import CalibrationWizard from '@/components/CalibrationWizard';
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
  { label: 'uSDX BLACK_BRICK (PU7FTW)',          baudRate: 38400,  dataBits: 8, stopBits: 1, parity: 'none', notes: 'PU7FTW custom firmware — adds volume, attenuator, noise reduction, AGC, filter, TX drive, backlight, PA bias and S-meter controls, batched CAT polling', rigProfile: 'usdx-blackbrick' },
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

// AGC firmware behavior note: since the 2026-07-06 firmware the radio has a single
// AGC algorithm (M0PUB fast-attack/slow-decay, ~60dB range) as a plain OFF/ON toggle —
// the old FAST_AGC Fast/Slow tri-state is gone and AG0 SET rejects values above 1.
// The AGC target level is a separate 1..14 setting (AL command, default 4): output
// peaks are held between level*256 and level*384, so higher = louder before clamping.
const AGC_ON = 1;
const AGC_OFF = 0;
const AGC_LEVEL_MIN = 1;
const AGC_LEVEL_MAX = 14;

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

// ── BacklightToggle ───────────────────────────────────────────────────────────
// Icon-only LCD backlight switch (BL command). Lit = amber bulb, off = gray.

function BacklightToggle({ backlight, onToggle }: {
  backlight: number | null;
  onToggle: (n: number) => void;
}) {
  const on = backlight === 1;
  return (
    <button
      onClick={() => onToggle(on ? 0 : 1)}
      disabled={backlight === null}
      title={backlight === null ? 'LCD backlight (state unknown)' : `LCD backlight ${on ? 'on — click to switch off' : 'off — click to switch on'}`}
      className={`w-7 h-7 flex items-center justify-center rounded border transition-colors disabled:opacity-30
        ${on
          ? 'bg-[#3a2d12] border-[#d29922] text-[#e3b341]'
          : 'bg-[#21262d] border-[#30363d] text-[#8b949e] hover:text-[#c9d1d9] hover:border-[#8b949e]'
        }`}
    >
      {/* light-bulb icon (heroicons v1 solid) */}
      <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor">
        <path d="M11 3a1 1 0 10-2 0v1a1 1 0 102 0V3zM15.657 5.757a1 1 0 00-1.414-1.414l-.707.707a1 1 0 001.414 1.414l.707-.707zM18 10a1 1 0 01-1 1h-1a1 1 0 110-2h1a1 1 0 011 1zM5.05 6.464A1 1 0 106.464 5.05l-.707-.707a1 1 0 00-1.414 1.414l.707.707zM5 10a1 1 0 01-1 1H3a1 1 0 110-2h1a1 1 0 011 1zM8 16v-1h4v1a2 2 0 11-4 0zM12 14c.015-.34.208-.646.477-.859a4 4 0 10-4.954 0c.27.213.462.519.476.859h4.002z" />
      </svg>
    </button>
  );
}

// ── RestartRadioButton ────────────────────────────────────────────────────────
// Soft-restarts the radio over CAT (SR; → watchdog reset, like a power cycle).
// Single click, no confirm — a restart is harmless (settings survive), the
// radio is just off the wire for a few seconds.

function RestartRadioButton({ onReset }: { onReset: () => void }) {
  return (
    <button
      onClick={onReset}
      title="Restart radio (soft power cycle) — drops off CAT for a few seconds"
      className="w-7 h-7 flex items-center justify-center rounded border transition-colors bg-[#da3633] border-[#da3633] text-white hover:bg-[#f85149] hover:border-[#f85149]"
    >
      {/* refresh/restart icon (heroicons v1 solid) */}
      <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5 shrink-0" viewBox="0 0 20 20" fill="currentColor">
        <path fillRule="evenodd" d="M4 2a1 1 0 011 1v2.101a7.002 7.002 0 0111.601 2.566 1 1 0 11-1.885.666A5.002 5.002 0 005.999 7H9a1 1 0 010 2H4a1 1 0 01-1-1V3a1 1 0 011-1zm.008 9.057a1 1 0 011.276.61A5.002 5.002 0 0014.001 13H11a1 1 0 110-2h5a1 1 0 011 1v5a1 1 0 11-2 0v-2.101a7.002 7.002 0 01-11.601-2.566 1 1 0 01.61-1.276z" clipRule="evenodd" />
      </svg>
    </button>
  );
}

// ── FactoryResetButton ────────────────────────────────────────────────────────
// SR2; — wipes ALL stored settings (band memories, ref-freq calibration) and
// reboots. Destructive, so unlike the restart button this keeps a two-step
// confirm: first click arms ("Wipe everything?"), auto-disarms after 4s.

function FactoryResetButton({ onConfirm }: { onConfirm: () => void }) {
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(t);
  }, [armed]);

  return (
    <button
      onClick={() => { if (!armed) { setArmed(true); return; } setArmed(false); onConfirm(); }}
      title={armed
        ? 'Click again to confirm — wipes ALL stored settings and reboots'
        : 'Factory reset — restores the defaults shown here, wiping band memories and calibration'}
      className={`text-[10px] font-semibold px-2.5 py-1.5 rounded border transition-colors whitespace-nowrap
        ${armed
          ? 'bg-[#da3633] border-[#f85149] text-white'
          : 'bg-[#21262d] border-[#f85149] text-[#f85149] hover:bg-[#da3633] hover:text-white'
        }`}
    >
      {armed ? 'Wipe everything?' : 'Factory Reset'}
    </button>
  );
}

// ── BlackBrickControls ────────────────────────────────────────────────────────
// uSDX BLACK_BRICK 4.01a custom extension controls: volume, attenuators, noise
// reduction, AGC, filter, TX drive, backlight. Wraps onto its own row below the
// main toolbar. S-Meter is shown separately in the main toolbar since it's a
// read-only reading, not a control. PA bias and TX timeout live in the
// advanced-settings panel (PABiasPanel) behind the wrench button.

function BlackBrickControls({ volume, att1, att2, nr, agc, agcLevel, filter, drive, backlight, firmwareVersion, paOpen, onVolume, onAtt1, onAtt2, onNR, onAGC, onAgcLevel, onFilter, onDrive, onBacklight, onTogglePA, onReset }: {
  volume: number | null;
  att1: number | null;
  att2: number | null;
  nr: number | null;
  agc: number | null;
  agcLevel: number | null;
  filter: number | null;
  drive: number | null;
  backlight: number | null;
  firmwareVersion: string | null;
  paOpen: boolean;
  onVolume: (n: number) => void;
  onAtt1: (n: number) => void;
  onAtt2: (n: number) => void;
  onNR: (n: number) => void;
  onAGC: (n: number) => void;
  onAgcLevel: (n: number) => void;
  onFilter: (n: number) => void;
  onDrive: (n: number) => void;
  onBacklight: (n: number) => void;
  onTogglePA: () => void;
  onReset: () => void;
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

      {/* AGC target level (AL command) — only meaningful while AGC is on */}
      {agcOn && (
        <NumberStepper label="AGC Level" value={agcLevel} min={AGC_LEVEL_MIN} max={AGC_LEVEL_MAX} onChange={onAgcLevel} />
      )}

      <BacklightToggle backlight={backlight} onToggle={onBacklight} />

      {firmwareVersion && (
        <span className="text-[10px] text-[#8b949e] whitespace-nowrap" title="Firmware version reported by the radio (FV command)">
          FW {firmwareVersion}
        </span>
      )}

      <div className="ml-auto flex items-center gap-1.5">
        <RestartRadioButton onReset={onReset} />

        {/* Advanced settings — tucked away, opens the on-demand panel */}
        <button
          onClick={onTogglePA}
          title="Advanced settings"
          className={`w-7 h-7 flex items-center justify-center rounded border transition-colors
            ${paOpen
              ? 'bg-[#21262d] border-[#388bfd] text-[#79c0ff]'
              : 'bg-[#21262d] border-[#30363d] text-[#8b949e] hover:text-[#c9d1d9] hover:border-[#8b949e]'
            }`}
        >
          {/* wrench icon (heroicons v1 solid, adjustments) */}
          <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor">
            <path d="M5 4a1 1 0 00-2 0v7.268a2 2 0 000 3.464V16a1 1 0 102 0v-1.268a2 2 0 000-3.464V4zM11 4a1 1 0 10-2 0v1.268a2 2 0 000 3.464V16a1 1 0 102 0V8.732a2 2 0 000-3.464V4zM16 3a1 1 0 011 1v7.268a2 2 0 010 3.464V16a1 1 0 11-2 0v-1.268a2 2 0 010-3.464V4a1 1 0 011-1z" />
          </svg>
        </button>
      </div>
    </div>
  );
}

// ── PABiasPanel ───────────────────────────────────────────────────────────────
// On-demand advanced settings: PA bias endpoints editor (PM = idle bias,
// PX = full-drive PWM), the TX time-out guard, and the factory-reset control.
// Deliberately NOT part of the poll loop: PA bias and the factory-default
// values, and TX timeout, are read once when the panel opens (so the user
// sees the radio's current numbers before touching anything) and written
// only on commit — none of this is part of the poll loop, to save the radio
// cycles on options that only matter while this panel is visible. Plain
// bounded number inputs, no sliders.

function PABiasPanel({ getPABias, setPABias, getFactoryDefaults, onFactoryReset, onOpenCalibration, getTxTimeout, setTxTimeout }: {
  getPABias: () => Promise<PABias | null>;
  setPABias: (which: 'min' | 'max', n: number) => Promise<number | null>;
  getFactoryDefaults: () => Promise<FactoryDefaults | null>;
  onFactoryReset: () => void;
  onOpenCalibration: () => void;
  getTxTimeout: () => Promise<number | null>;
  setTxTimeout: (n: number) => Promise<number | null>;
}) {
  const [bias, setBias]         = useState<PABias | null>(null);
  const [defaults, setDefaults] = useState<FactoryDefaults | null>(null);
  const [failed, setFailed]     = useState(false);
  const [minDraft, setMinDraft] = useState('');
  const [maxDraft, setMaxDraft] = useState('');
  const [busy, setBusy]         = useState(false);
  const [txTimeout, setTxTimeoutState] = useState<number | null>(null);
  const [ttBusy, setTtBusy]     = useState(false);
  // Guards against overlapping load() runs: the effect below re-fires whenever
  // its callback deps get a new identity (they're recreated on parent
  // re-renders), which was queuing duplicate PM/PX/FD/TT queries — the CAT
  // queue's own dedup then resolved the second copy of each with a sentinel
  // ('__dedup__') instead of the real reply, and whichever run's state update
  // landed last could stomp a good reading with that garbage. Only the latest
  // call is allowed to commit its results.
  const loadSeqRef = useRef(0);

  const load = useCallback(async () => {
    const seq = ++loadSeqRef.current;
    setBias(null); setDefaults(null); setFailed(false); setTxTimeoutState(null);
    const [b, d, tt] = await Promise.all([getPABias(), getFactoryDefaults(), getTxTimeout()]);
    if (seq !== loadSeqRef.current) return;  // a newer load() superseded this one
    if (b) {
      setBias(b);
      setMinDraft(String(b.min));
      setMaxDraft(String(b.max));
    } else {
      setFailed(true);
    }
    setDefaults(d);
    setTxTimeoutState(tt);
  }, [getPABias, getFactoryDefaults, getTxTimeout]);

  useEffect(() => { load(); }, [load]);  // query on open

  const commitTxTimeout = async (n: number) => {
    if (ttBusy) return;
    setTtBusy(true);
    const confirmed = await setTxTimeout(n);
    setTtBusy(false);
    // Trust the radio's echo (it returns the old value if the SET was rejected)
    setTxTimeoutState(prev => confirmed ?? prev);
  };

  const commit = async (which: 'min' | 'max') => {
    if (!bias || busy) return;
    const raw = which === 'min' ? minDraft : maxDraft;
    const n = parseInt(raw, 10);
    // Clamp to what the firmware will accept: min ∈ [0, max-1], max ∈ [min+1, 255]
    const clamped = isNaN(n)
      ? (which === 'min' ? bias.min : bias.max)
      : which === 'min'
        ? Math.max(0, Math.min(bias.max - 1, n))
        : Math.max(bias.min + 1, Math.min(255, n));
    if (clamped === (which === 'min' ? bias.min : bias.max)) {
      // No effective change — just normalize the draft back
      (which === 'min' ? setMinDraft : setMaxDraft)(String(which === 'min' ? bias.min : bias.max));
      return;
    }
    setBusy(true);
    const confirmed = await setPABias(which, clamped);
    setBusy(false);
    // Trust the radio's echo (it returns the old value if the SET was rejected)
    const effective = confirmed ?? (which === 'min' ? bias.min : bias.max);
    setBias(prev => prev ? { ...prev, [which]: effective } : prev);
    (which === 'min' ? setMinDraft : setMaxDraft)(String(effective));
  };

  const inputCls = 'w-16 bg-[#0d1117] border border-[#30363d] text-[#c9d1d9] text-xs rounded px-2 py-1.5 focus:outline-none focus:border-[#388bfd] font-mono disabled:opacity-40';
  const keyHandler = (which: 'min' | 'max') => (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter')  { e.preventDefault(); commit(which); }
    if (e.key === 'Escape') { setMinDraft(String(bias?.min ?? '')); setMaxDraft(String(bias?.max ?? '')); }
  };

  // Human-readable one-liner of what a factory reset would restore, built from
  // the radio's own FD; reply (never hardcoded).
  const defaultsSummary = defaults === null ? null : [
    `Volume ${defaults.volume}`,
    `Mode ${defaults.mode ?? '?'}`,
    `AGC ${defaults.agc === 1 ? 'On' : 'Off'}`,
    `Filter ${FILTER_LABELS[defaults.filter] ?? defaults.filter}`,
    `ATT ${ANALOG_ATTENUATOR_DB_LABELS[defaults.att1] ?? defaults.att1}/${DIGITAL_ATTENUATOR_DB_LABELS[defaults.att2] ?? defaults.att2}`,
    `NR ${defaults.nr}`,
    `Drive ${defaults.drive}`,
    `Backlight ${defaults.backlight === 1 ? 'On' : 'Off'}`,
    `PA bias ${defaults.paMin}/${defaults.paMax}`,
  ].join(' · ');

  return (
    <div className="mt-2 bg-[#161b22] border border-[#30363d] rounded-lg p-4 flex flex-col gap-3">
      <span className="text-[10px] font-bold uppercase tracking-widest text-[#8b949e] select-none">
        Advanced Settings
      </span>

      {failed ? (
        <div className="flex items-center gap-3">
          <span className="text-xs text-[#f85149]">Could not read PA bias from the radio.</span>
          <button
            onClick={load}
            className="text-[10px] font-semibold px-2 py-1 rounded bg-[#21262d] border border-[#30363d] text-[#8b949e] hover:text-[#c9d1d9] hover:border-[#8b949e] transition-colors"
          >
            Retry
          </button>
        </div>
      ) : bias === null ? (
        <span className="text-xs text-[#8b949e]">Reading current values from the radio…</span>
      ) : (
        <div className="flex items-center gap-6 flex-wrap">
          <div className="flex items-center gap-2" title={`PA bias min — PWM at zero drive (idle bias). Valid: 0 to ${bias.max - 1}.`}>
            <span className="text-[10px] font-semibold text-[#8b949e] whitespace-nowrap">Bias Min</span>
            <input
              type="number" min={0} max={bias.max - 1} step={1}
              value={minDraft} disabled={busy}
              onChange={e => setMinDraft(e.target.value)}
              onBlur={() => commit('min')}
              onKeyDown={keyHandler('min')}
              className={inputCls}
            />
          </div>
          <div className="flex items-center gap-2" title={`PA max — PWM at full drive. Valid: ${bias.min + 1} to 255.`}>
            <span className="text-[10px] font-semibold text-[#8b949e] whitespace-nowrap">PA Max</span>
            <input
              type="number" min={bias.min + 1} max={255} step={1}
              value={maxDraft} disabled={busy}
              onChange={e => setMaxDraft(e.target.value)}
              onBlur={() => commit('max')}
              onKeyDown={keyHandler('max')}
              className={inputCls}
            />
          </div>
          {busy && <span className="text-[10px] text-[#8b949e]">writing…</span>}
        </div>
      )}

      <p className="text-[10px] text-[#f0883e]">
        Sets the PA MOSFET bias PWM endpoints (0–255) and rebuilds the TX lookup table immediately.
        Too-high values can overheat the finals — change with care.
      </p>

      {/* ── TX time-out guard ── */}
      <div className="border-t border-[#21262d] pt-3 flex items-center gap-3 flex-wrap">
        <NumberStepper label="TX Timeout (s)" value={txTimeout} min={0} max={255} onChange={commitTxTimeout} />
        {ttBusy && <span className="text-[10px] text-[#8b949e]">writing…</span>}
        <p className="text-[10px] text-[#8b949e] flex-1 min-w-[16rem]">
          Firmware force-unkeys the PA if TX stays keyed past this many seconds. 0 disables the guard.
        </p>
      </div>

      {/* ── Frequency calibration ── */}
      <div className="border-t border-[#21262d] pt-3 flex items-center gap-3 flex-wrap">
        <button
          onClick={onOpenCalibration}
          className="text-[10px] font-semibold px-2.5 py-1.5 rounded border transition-colors whitespace-nowrap bg-[#21262d] border-[#30363d] text-[#8b949e] hover:text-[#c9d1d9] hover:border-[#8b949e]"
          title="Calibrate the reference oscillator against an off-air standard station (receive-only)"
        >
          Calibrate Frequency…
        </button>
        <p className="text-[10px] text-[#8b949e] flex-1 min-w-[16rem]">
          Guided, receive-only calibration of the dial frequency against WWV/CHU. No transmission — no dummy load needed.
        </p>
      </div>

      {/* ── Factory reset ── */}
      <div className="border-t border-[#21262d] pt-3 flex items-center gap-3 flex-wrap">
        <FactoryResetButton onConfirm={onFactoryReset} />
        <p className="text-[10px] text-[#8b949e] flex-1 min-w-[16rem]">
          Restores all settings to firmware defaults and reboots — band memories and frequency calibration are wiped too.
          {defaultsSummary
            ? <> Defaults (reported by the radio): <span className="text-[#c9d1d9]">{defaultsSummary}</span>.</>
            : <span className="text-[#f0883e]"> Could not read the default values from the radio.</span>}
        </p>
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

export default function RadioCATPanel({ cat, collapsed = false }: { cat: ReturnType<typeof useRadioCAT>; collapsed?: boolean }) {
  const { state, connect, disconnect, setFrequency, setMode, setPTT, setVolume, setAtt1, setAtt2, setNR, setAGC, setAgcLevel, setFilter, setDrive, setBacklight, getPABias, setPABias, getTxTimeout, setTxTimeout, resetRadio, getFactoryDefaults, factoryResetRadio } = cat;
  const { connected, frequency, mode, ptt, error, isSupported, volume, att1, att2, nr, agc, agcLevel, filter, sMeter, drive, backlight, firmwareVersion } = state;

  const [showSettings, setShowSettings] = useState(false);
  const [showPABias, setShowPABias] = useState(false);
  const [showCalibration, setShowCalibration] = useState(false);
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
  const handleAgcLevel   = useCallback((n: number) => { setAgcLevel(n).catch(() => {}); }, [setAgcLevel]);
  const handleFilter     = useCallback((n: number) => { setFilter(n).catch(() => {}); }, [setFilter]);
  const handleDrive      = useCallback((n: number) => { setDrive(n).catch(() => {}); }, [setDrive]);
  const handleBacklight  = useCallback((n: number) => { setBacklight(n).catch(() => {}); }, [setBacklight]);
  const handleTogglePA   = useCallback(() => { setShowPABias(s => !s); }, []);
  const handleReset      = useCallback(() => { setShowPABias(false); resetRadio().catch(() => {}); }, [resetRadio]);
  const handleFactoryReset = useCallback(() => { setShowPABias(false); factoryResetRadio().catch(() => {}); }, [factoryResetRadio]);
  const handleOpenCalibration = useCallback(() => { setShowPABias(false); setShowCalibration(true); }, []);
  const handleCloseCalibration = useCallback(() => { setShowCalibration(false); }, []);

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
            {config.rigProfile === 'usdx-blackbrick' && firmwareVersion !== null && (
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

            {/* uSDX BLACK_BRICK 4.01a extensions */}
            {config.rigProfile === 'usdx-blackbrick' && firmwareVersion !== null && !collapsed && (
              <BlackBrickControls
                volume={volume} att1={att1} att2={att2} nr={nr}
                agc={agc} agcLevel={agcLevel} filter={filter} drive={drive} backlight={backlight} firmwareVersion={firmwareVersion}
                paOpen={showPABias}
                onVolume={handleVolume} onAtt1={handleAtt1} onAtt2={handleAtt2}
                onNR={handleNR}
                onAGC={handleAGC} onAgcLevel={handleAgcLevel} onFilter={handleFilter} onDrive={handleDrive}
                onBacklight={handleBacklight} onTogglePA={handleTogglePA}
                onReset={handleReset}
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

      {!collapsed && showSettings && !connected && (
        <SettingsPanel config={config} onConfigChange={setConfig} onConnect={handleConnect} />
      )}

      {!collapsed && showPABias && connected && config.rigProfile === 'usdx-blackbrick' && (
        <PABiasPanel
          getPABias={getPABias} setPABias={setPABias}
          getFactoryDefaults={getFactoryDefaults} onFactoryReset={handleFactoryReset}
          onOpenCalibration={handleOpenCalibration}
          getTxTimeout={getTxTimeout} setTxTimeout={setTxTimeout}
        />
      )}

      {!collapsed && showCalibration && connected && config.rigProfile === 'usdx-blackbrick' && (
        <CalibrationWizard cat={cat} onClose={handleCloseCalibration} />
      )}
    </div>
  );
}
