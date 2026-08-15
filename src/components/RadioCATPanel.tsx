// Port of src/components/RadioCATPanel.tsx (Next.js app).
import { createSignal, createEffect, onCleanup, For, Show, type JSX } from 'solid-js'
import {
  useRadioCAT,
  type CATMode,
  type CATConnectionConfig,
  type RigProfile,
  type RadioCATControls,
  type PABias,
  type FactoryDefaults,
  type BridgeStatus,
  type BridgeInfo,
} from '../lib/cat/useRadioCAT'
import { useAudioBridge } from '../lib/cat/useAudioBridge'
import CalibrationWizard from './CalibrationWizard'
import NumberField from './NumberField'
import { loadObject, saveObject } from '../lib/storage'
export { useRadioCAT }

// Persisted across sessions (localStorage) so the transport choice, bridge
// address, and serial port settings survive a reload — everything else in
// CATConnectionConfig (timeoutMs/pollIntervalMs/debug) is left at its
// hardcoded default each time; only the "which radio, how do I reach it"
// half of the config is worth remembering.
const CAT_CONFIG_STORAGE_KEY = 'signal-decoder:cat-connection-config';

// ── Constants ─────────────────────────────────────────────────────────────────

const MODES: CATMode[] = ['USB', 'LSB', 'AM', 'FM', 'CW', 'RTTY']

const BAUD_RATES = [1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200]

interface RadioPreset {
  label: string
  baudRate: number
  dataBits: number
  stopBits: number
  parity: 'none' | 'even' | 'odd'
  notes: string
  rigProfile: RigProfile
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
]

// ── Frequency helpers ─────────────────────────────────────────────────────────

type FreqUnit = 'MHz' | 'KHz'

function parseFreqInput(raw: string, unit: FreqUnit): number | null {
  const s = raw.replace(/[,_\s]/g, '')
  const n = parseFloat(s)
  if (isNaN(n) || n <= 0) return null
  if (unit === 'MHz') return Math.round(n * 1_000_000)
  return Math.round(n * 1_000) // KHz → Hz
}

function freqToDisplay(hz: number, unit: FreqUnit): string {
  if (unit === 'MHz') return (hz / 1_000_000).toFixed(6)
  return (hz / 1_000).toFixed(3)
}

// ── FrequencyInput ────────────────────────────────────────────────────────────
// Display mode: three color-coded groups  XX.XXX.XXX
// Edit mode:    plain input with MHz/kHz toggle + scroll wheel nudge

function FrequencyInput(props: { frequency: number | null; onCommit: (hz: number) => void }) {
  const [editing, setEditing] = createSignal(false)
  const [draft, setDraft] = createSignal('')
  const [unit, setUnit] = createSignal<FreqUnit>('KHz')
  let inputEl: HTMLInputElement | undefined

  const startEdit = () => {
    setDraft(props.frequency !== null ? freqToDisplay(props.frequency, unit()) : '')
    setEditing(true)
    setTimeout(() => { inputEl?.select() }, 0)
  }

  const commit = (raw = draft()) => {
    const hz = parseFreqInput(raw, unit())
    if (hz !== null) props.onCommit(hz)
    setEditing(false)
  }

  const onWheel: JSX.EventHandler<HTMLInputElement, WheelEvent> = (e) => {
    e.preventDefault()
    const step = unit() === 'MHz' ? 0.001 : 1 // 1 kHz steps
    const n = parseFloat(draft()) || 0
    const next = n + (e.deltaY < 0 ? step : -step)
    const nextStr = unit() === 'MHz' ? next.toFixed(6) : next.toFixed(3)
    setDraft(nextStr)
    const hz = parseFreqInput(nextStr, unit())
    if (hz && hz > 0) props.onCommit(hz)
  }

  const toggleUnit = () => {
    const next: FreqUnit = unit() === 'MHz' ? 'KHz' : 'MHz'
    setUnit(next)
    if (props.frequency !== null) setDraft(freqToDisplay(props.frequency, next))
  }

  // The unit toggle is always visible (both display and edit mode), at the
  // right side of the frequency — click to switch MHz/kHz for both the
  // display formatting and the next edit's input format.
  const unitToggle = (
    <button
      onMouseDown={(e) => { e.preventDefault(); toggleUnit() }}
      class="text-[10px] font-bold px-1.5 py-1 rounded bg-[#21262d] border border-[#30363d] text-[#8b949e] hover:text-[#c9d1d9] hover:border-[#8b949e] transition-colors select-none shrink-0"
      title="Switch between MHz and kHz"
    >
      {unit()}
    </button>
  )

  return (
    <Show
      when={editing()}
      fallback={
        <div class="flex items-center gap-1.5">
          <button
            onClick={startEdit}
            title="Click to edit frequency"
            class="flex items-center gap-0 font-mono text-sm tabular-nums tracking-wider hover:opacity-80 transition-opacity"
          >
            {(() => {
              let mhzPart = '——', khzPart = '———', hzPart = '———'
              if (props.frequency !== null) {
                const s = props.frequency.toString().padStart(9, '0')
                mhzPart = s.slice(0, s.length - 6)
                khzPart = s.slice(-6, -3)
                hzPart = s.slice(-3)
              }
              return (
                <>
                  <span class="text-[#c9d1d9]">{mhzPart}</span>
                  <span class="text-[#484f58]">.</span>
                  <span class="text-[#79c0ff]">{khzPart}</span>
                  <span class="text-[#484f58]">.</span>
                  <span class="text-[#6e7681]">{hzPart}</span>
                </>
              )
            })()}
          </button>
          {unitToggle}
        </div>
      }
    >
      <div class="flex items-center gap-1">
        <input
          ref={inputEl}
          value={draft()}
          onInput={(e) => setDraft(e.currentTarget.value)}
          onBlur={() => commit()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); commit() }
            if (e.key === 'Escape') { setEditing(false) }
          }}
          onWheel={onWheel}
          placeholder={unit() === 'MHz' ? '14.225000' : '14225.000'}
          class="w-32 bg-[#0d1117] border border-[#388bfd] text-[#79c0ff] font-mono text-sm px-2 py-1 rounded focus:outline-none"
        />
        {unitToggle}
      </div>
    </Show>
  )
}

// ── ModeSelector ──────────────────────────────────────────────────────────────

function ModeSelector(props: { mode: CATMode | null; onChange: (m: CATMode) => void }) {
  return (
    <div class="flex items-center gap-0.5">
      <For each={MODES}>
        {(m) => (
          <button
            onClick={() => props.onChange(m)}
            class={`text-[10px] font-semibold px-1.5 py-1 rounded transition-colors
              ${props.mode === m ? 'bg-[#388bfd] text-white' : 'text-[#8b949e] hover:text-[#c9d1d9]'}`}
          >
            {m}
          </button>
        )}
      </For>
    </div>
  )
}

// ── PTTButton ─────────────────────────────────────────────────────────────────

function PTTButton(props: { ptt: boolean; onToggle: () => void; confirmAlarm?: boolean }) {
  return (
    <div class="flex flex-col items-center gap-1 shrink-0">
      <button
        onClick={props.onToggle}
        title={
          props.confirmAlarm
            ? 'RADIO DID NOT CONFIRM RX — it may still be transmitting. Bridge is retrying automatically.'
            : props.ptt ? 'Transmitting — click to go back to RX' : 'Push to Talk — click to transmit'
        }
        class={`flex items-center justify-center gap-1.5 text-xs font-bold w-16 py-1.5 rounded-md transition-colors border
          ${props.confirmAlarm
            ? 'bg-[#f85149] border-[#f85149] text-white animate-pulse ring-2 ring-[#f85149] ring-offset-2 ring-offset-[#0d1117]'
            : props.ptt
              ? 'bg-[#f85149] border-[#f85149] text-white'
              : 'bg-[#21262d] border-[#30363d] text-[#8b949e] hover:text-[#c9d1d9] hover:border-[#8b949e]'
          }`}
      >
        <Show
          when={props.ptt || props.confirmAlarm}
          fallback={
            <>
              <svg xmlns="http://www.w3.org/2000/svg" class="h-3.5 w-3.5 shrink-0" viewBox="0 0 20 20" fill="currentColor">
                <path fill-rule="evenodd" d="M7 4a3 3 0 016 0v4a3 3 0 11-6 0V4zm4 10.93A7.001 7.001 0 0017 8a1 1 0 10-2 0A5 5 0 015 8a1 1 0 00-2 0 7.001 7.001 0 006 6.93V17H6a1 1 0 100 2h8a1 1 0 100-2h-3v-2.07z" clip-rule="evenodd" />
              </svg>
              PTT
            </>
          }
        >
          {/* Transmitting (or unconfirmed-RX alarm) — pulsing dot replaces mic icon, label stays PTT */}
          <span class="w-2 h-2 rounded-full bg-white animate-pulse shrink-0" />
          PTT
        </Show>
      </button>
      <Show when={props.confirmAlarm}>
        <span class="text-[9px] font-bold text-[#f85149] whitespace-nowrap animate-pulse">⚠ TX NOT CONFIRMED OFF</span>
      </Show>
    </div>
  )
}

// ── SettingsPanel ─────────────────────────────────────────────────────────────

function SettingsPanel(props: {
  config: CATConnectionConfig & { presetIdx: number }
  onConfigChange: (c: CATConnectionConfig & { presetIdx: number }) => void
  onConnect: () => void
}) {
  const preset = () => RADIO_PRESETS[props.config.presetIdx]
  const isWebSocket = () => props.config.transport === 'websocket'

  const applyPreset = (idx: number) => {
    const p = RADIO_PRESETS[idx]
    props.onConfigChange({ ...props.config, presetIdx: idx, baudRate: p.baudRate, dataBits: p.dataBits, stopBits: p.stopBits, parity: p.parity, rigProfile: p.rigProfile })
  }

  return (
    <div class="mt-2 bg-[#161b22] border border-[#30363d] rounded-lg p-4 flex flex-col gap-4">
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div class="sm:col-span-2 flex flex-col gap-1.5">
          <label class="text-[10px] font-semibold uppercase tracking-widest text-[#8b949e]">Connection</label>
          <div class="flex gap-1.5">
            <button
              type="button"
              onClick={() => props.onConfigChange({ ...props.config, transport: 'serial' })}
              class={`flex-1 text-xs font-semibold px-3 py-1.5 rounded-md border transition-colors
                ${!isWebSocket()
                  ? 'bg-[#21262d] border-[#388bfd] text-[#79c0ff]'
                  : 'bg-[#0d1117] border-[#30363d] text-[#8b949e] hover:text-[#c9d1d9] hover:border-[#8b949e]'
                }`}
            >
              USB / Serial cable
            </button>
            <button
              type="button"
              onClick={() => props.onConfigChange({ ...props.config, transport: 'websocket' })}
              class={`flex-1 text-xs font-semibold px-3 py-1.5 rounded-md border transition-colors
                ${isWebSocket()
                  ? 'bg-[#21262d] border-[#388bfd] text-[#79c0ff]'
                  : 'bg-[#0d1117] border-[#30363d] text-[#8b949e] hover:text-[#c9d1d9] hover:border-[#8b949e]'
                }`}
            >
              Wi-Fi CAT bridge
            </button>
          </div>
        </div>

        <div class="sm:col-span-2 flex flex-col gap-1.5">
          <label class="text-[10px] font-semibold uppercase tracking-widest text-[#8b949e]">Radio Model</label>
          <select
            value={props.config.presetIdx}
            onChange={(e) => applyPreset(Number(e.currentTarget.value))}
            class="bg-[#0d1117] border border-[#30363d] text-[#c9d1d9] text-xs rounded px-2 py-1.5 focus:outline-none focus:border-[#388bfd]"
          >
            <For each={RADIO_PRESETS}>
              {(p, i) => <option value={i()}>{p.label}</option>}
            </For>
          </select>
          <Show when={preset().notes}>
            <p class="text-[10px] text-[#8b949e]">{preset().notes}</p>
          </Show>
        </div>

        <Show
          when={isWebSocket()}
          fallback={
            <>
              <div class="flex flex-col gap-1.5">
                <label class="text-[10px] font-semibold uppercase tracking-widest text-[#8b949e]">Baud Rate</label>
                <select
                  value={props.config.baudRate}
                  onChange={(e) => props.onConfigChange({ ...props.config, baudRate: Number(e.currentTarget.value) })}
                  class="bg-[#0d1117] border border-[#30363d] text-[#c9d1d9] text-xs rounded px-2 py-1.5 focus:outline-none focus:border-[#388bfd]"
                >
                  <For each={BAUD_RATES}>{(b) => <option value={b}>{b}</option>}</For>
                </select>
              </div>

              <div class="flex flex-col gap-1.5">
                <label class="text-[10px] font-semibold uppercase tracking-widest text-[#8b949e]">Data Bits</label>
                <select
                  value={props.config.dataBits}
                  onChange={(e) => props.onConfigChange({ ...props.config, dataBits: Number(e.currentTarget.value) })}
                  class="bg-[#0d1117] border border-[#30363d] text-[#c9d1d9] text-xs rounded px-2 py-1.5 focus:outline-none focus:border-[#388bfd]"
                >
                  <For each={[7, 8]}>{(n) => <option value={n}>{n}</option>}</For>
                </select>
              </div>

              <div class="flex flex-col gap-1.5">
                <label class="text-[10px] font-semibold uppercase tracking-widest text-[#8b949e]">Stop Bits</label>
                <select
                  value={props.config.stopBits}
                  onChange={(e) => props.onConfigChange({ ...props.config, stopBits: Number(e.currentTarget.value) })}
                  class="bg-[#0d1117] border border-[#30363d] text-[#c9d1d9] text-xs rounded px-2 py-1.5 focus:outline-none focus:border-[#388bfd]"
                >
                  <For each={[1, 2]}>{(n) => <option value={n}>{n}</option>}</For>
                </select>
              </div>

              <div class="flex flex-col gap-1.5">
                <label class="text-[10px] font-semibold uppercase tracking-widest text-[#8b949e]">Parity</label>
                <select
                  value={props.config.parity}
                  onChange={(e) => props.onConfigChange({ ...props.config, parity: e.currentTarget.value as 'none' | 'even' | 'odd' })}
                  class="bg-[#0d1117] border border-[#30363d] text-[#c9d1d9] text-xs rounded px-2 py-1.5 focus:outline-none focus:border-[#388bfd]"
                >
                  <For each={['none', 'even', 'odd'] as const}>
                    {(p) => <option value={p}>{p.charAt(0).toUpperCase() + p.slice(1)}</option>}
                  </For>
                </select>
              </div>
            </>
          }
        >
          <div class="sm:col-span-2 flex flex-col gap-1.5">
            <label class="text-[10px] font-semibold uppercase tracking-widest text-[#8b949e]">CAT Bridge Address</label>
            <input
              type="text"
              value={props.config.wsUrl ?? ''}
              onChange={(e) => props.onConfigChange({ ...props.config, wsUrl: e.currentTarget.value })}
              placeholder="ws://usdx-bridge.local/cat"
              class="bg-[#0d1117] border border-[#30363d] text-[#c9d1d9] text-xs rounded px-2 py-1.5 focus:outline-none focus:border-[#388bfd] font-mono"
            />
            <p class="text-[10px] text-[#8b949e]">
              Address of the ESP32 CAT bridge's WebSocket endpoint — defaults to its mDNS name,{' '}
              <code class="text-[#79c0ff]">usdx-bridge.local</code>, if your network resolves it;
              otherwise use its IP address (shown on the bridge's LCD).
            </p>
          </div>
        </Show>

        <div class="flex flex-col gap-1.5">
          <label class="text-[10px] font-semibold uppercase tracking-widest text-[#8b949e]">Cmd Timeout (ms)</label>
          <NumberField
            min={50} max={5000}
            value={props.config.timeoutMs}
            onCommit={(n) => props.onConfigChange({ ...props.config, timeoutMs: n })}
            class="bg-[#0d1117] border border-[#30363d] text-[#c9d1d9] text-xs rounded px-2 py-1.5 focus:outline-none focus:border-[#388bfd] font-mono"
          />
        </div>

        <div class="flex flex-col gap-1.5">
          <label class="text-[10px] font-semibold uppercase tracking-widest text-[#8b949e]">Query Interval (ms)</label>
          <NumberField
            min={200} max={10000}
            value={props.config.pollIntervalMs}
            onCommit={(n) => props.onConfigChange({ ...props.config, pollIntervalMs: n })}
            class="bg-[#0d1117] border border-[#30363d] text-[#c9d1d9] text-xs rounded px-2 py-1.5 focus:outline-none focus:border-[#388bfd] font-mono"
          />
        </div>

        <div class="flex items-center gap-2">
          <input
            type="checkbox"
            id="cat-debug"
            checked={props.config.debug}
            onChange={(e) => props.onConfigChange({ ...props.config, debug: e.currentTarget.checked })}
            class="accent-[#388bfd]"
          />
          <label for="cat-debug" class="text-[10px] font-semibold uppercase tracking-widest text-[#8b949e] cursor-pointer select-none">
            Debug logging (browser console)
          </label>
        </div>
      </div>

      <Show
        when={isWebSocket()}
        fallback={
          <p class="text-[10px] text-[#484f58] border-t border-[#21262d] pt-3">
            <span class="text-[#8b949e] font-semibold">Linux / macOS:</span>{' '}
            ensure your user is in the <code class="text-[#79c0ff]">dialout</code> group:{' '}
            <code class="text-[#c9d1d9]">sudo usermod -a -G dialout $USER</code> then log out and back in.
            The browser will present a port picker (<code class="text-[#79c0ff]">/dev/ttyUSB*</code> or{' '}
            <code class="text-[#79c0ff]">/dev/ttyACM*</code>) when you click Connect.
          </p>
        }
      >
        <p class="text-[10px] text-[#484f58] border-t border-[#21262d] pt-3">
          Connects through the ESP32 CAT bridge over Wi-Fi instead of a USB cable — the radio's baud
          rate is fixed on the bridge itself (set via its own firmware config) and isn't controlled from here.
        </p>
      </Show>

      <button
        onClick={props.onConnect}
        class="self-start flex items-center gap-2 bg-[#238636] hover:bg-[#2ea043] text-white text-xs font-semibold px-4 py-2 rounded-md transition-colors"
      >
        <svg xmlns="http://www.w3.org/2000/svg" class="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor">
          <path fill-rule="evenodd" d="M12.586 4.586a2 2 0 112.828 2.828l-3 3a2 2 0 01-2.828 0 1 1 0 00-1.414 1.414 4 4 0 005.656 0l3-3a4 4 0 00-5.656-5.656l-1.5 1.5a1 1 0 101.414 1.414l1.5-1.5zm-5 5a2 2 0 012.828 0 1 1 0 101.414-1.414 4 4 0 00-5.656 0l-3 3a4 4 0 105.656 5.656l1.5-1.5a1 1 0 10-1.414-1.414l-1.5 1.5a2 2 0 11-2.828-2.828l3-3z" clip-rule="evenodd" />
        </svg>
        Connect Radio
      </button>
    </div>
  )
}

// ── NumberStepper ─────────────────────────────────────────────────────────────
// Labeled -/+ stepper for small bounded ranges (volume, attenuators, noise reduction).
// `valueLabels[n - min]`, when provided, is shown instead of the raw index —
// used for the analog attenuator, whose firmware steps map to fixed dB presets,
// not a linear scale.

function NumberStepper(props: {
  label: string
  value: number | null
  min: number
  max: number
  valueLabels?: string[]
  onChange: (n: number) => void
}) {
  const v = () => props.value ?? props.min
  const step = (delta: number) => props.onChange(Math.max(props.min, Math.min(props.max, v() + delta)))
  const display = () => props.value === null ? '—' : (props.valueLabels?.[props.value - props.min] ?? String(props.value))
  return (
    <div class="flex items-center gap-1.5" title={props.label}>
      <span class="text-[10px] font-semibold text-[#8b949e] whitespace-nowrap">{props.label}</span>
      <button
        onClick={() => step(-1)}
        disabled={props.value === null || v() <= props.min}
        class="w-5 h-5 flex items-center justify-center text-xs rounded bg-[#21262d] border border-[#30363d] text-[#8b949e] hover:text-[#c9d1d9] hover:border-[#8b949e] disabled:opacity-30 disabled:hover:border-[#30363d]"
      >
        −
      </button>
      <span class="text-xs font-mono tabular-nums w-12 text-center text-[#c9d1d9]">{display()}</span>
      <button
        onClick={() => step(1)}
        disabled={props.value === null || v() >= props.max}
        class="w-5 h-5 flex items-center justify-center text-xs rounded bg-[#21262d] border border-[#30363d] text-[#8b949e] hover:text-[#c9d1d9] hover:border-[#8b949e] disabled:opacity-30 disabled:hover:border-[#30363d]"
      >
        +
      </button>
    </div>
  )
}

// Analog attenuator firmware preset steps — from `att_label[]` in usdxBLACKBRICK.ino
// (param enum ATT, EEPROM 0x1A). Not linear — each index is a fixed dB pad.
const ANALOG_ATTENUATOR_DB_LABELS = ['0dB', '-13dB', '-20dB', '-33dB', '-40dB', '-53dB', '-60dB', '-73dB']

// Digital attenuator (A2, EEPROM 0x1B) is a raw bit-shift on the audio sample
// (`ac2 >>= att2` in usdxBLACKBRICK.ino) — each step halves the amplitude,
// i.e. exactly -6.02dB/step, linear across the full 0..16 range.
const DIGITAL_ATTENUATOR_DB_LABELS = [
  '0dB', '-6dB', '-12dB', '-18dB', '-24dB', '-30dB', '-36dB', '-42dB',
  '-48dB', '-54dB', '-60dB', '-66dB', '-72dB', '-78dB', '-84dB', '-90dB', '-96dB',
]

// Filter bandwidth labels — mirrors filt_label[] in firmware for F_MCU > 16MHz builds
// (this rig runs at 20MHz), param enum FILTER, EEPROM 0x13.
const FILTER_LABELS = ['Full', '3kHz', '2.4kHz', '1.8kHz', '500Hz', '200Hz', '100Hz', '50Hz']

// AGC firmware behavior note: since the 2026-07-06 firmware the radio has a single
// AGC algorithm (M0PUB fast-attack/slow-decay, ~60dB range) as a plain OFF/ON toggle —
// the old FAST_AGC Fast/Slow tri-state is gone and AG0 SET rejects values above 1.
// The AGC target level is a separate 1..14 setting (AL command, default 4): output
// peaks are held between level*256 and level*384, so higher = louder before clamping.
const AGC_ON = 1
const AGC_OFF = 0
const AGC_LEVEL_MIN = 1
const AGC_LEVEL_MAX = 14

// ── SMeterDisplay ─────────────────────────────────────────────────────────────
// Read-only dBm readout — no +/- controls, since there is no SM SET command.

function SMeterDisplay(props: { dbm: number | null }) {
  return (
    <div class="flex items-center gap-1.5" title="S-Meter (signal strength)">
      <span class="text-[10px] font-semibold text-[#8b949e] whitespace-nowrap">S-Meter</span>
      <span class="text-xs font-mono tabular-nums w-16 text-center text-[#79c0ff] bg-[#0d1117] border border-[#30363d] rounded px-1.5 py-0.5">
        {props.dbm === null ? '—' : `${props.dbm} dBm`}
      </span>
    </div>
  )
}

// ── BacklightToggle ───────────────────────────────────────────────────────────
// Icon-only LCD backlight switch (BL command). Lit = amber bulb, off = gray.

function BacklightToggle(props: { backlight: number | null; onToggle: (n: number) => void }) {
  const on = () => props.backlight === 1
  return (
    <button
      onClick={() => props.onToggle(on() ? 0 : 1)}
      disabled={props.backlight === null}
      title={props.backlight === null ? 'LCD backlight (state unknown)' : `LCD backlight ${on() ? 'on — click to switch off' : 'off — click to switch on'}`}
      class={`w-7 h-7 flex items-center justify-center rounded border transition-colors disabled:opacity-30
        ${on()
          ? 'bg-[#3a2d12] border-[#d29922] text-[#e3b341]'
          : 'bg-[#21262d] border-[#30363d] text-[#8b949e] hover:text-[#c9d1d9] hover:border-[#8b949e]'
        }`}
    >
      {/* light-bulb icon (heroicons v1 solid) */}
      <svg xmlns="http://www.w3.org/2000/svg" class="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor">
        <path d="M11 3a1 1 0 10-2 0v1a1 1 0 102 0V3zM15.657 5.757a1 1 0 00-1.414-1.414l-.707.707a1 1 0 001.414 1.414l.707-.707zM18 10a1 1 0 01-1 1h-1a1 1 0 110-2h1a1 1 0 011 1zM5.05 6.464A1 1 0 106.464 5.05l-.707-.707a1 1 0 00-1.414 1.414l.707.707zM5 10a1 1 0 01-1 1H3a1 1 0 110-2h1a1 1 0 011 1zM8 16v-1h4v1a2 2 0 11-4 0zM12 14c.015-.34.208-.646.477-.859a4 4 0 10-4.954 0c.27.213.462.519.476.859h4.002z" />
      </svg>
    </button>
  )
}

// ── RestartRadioButton ────────────────────────────────────────────────────────
// Soft-restarts the radio over CAT (SR; → watchdog reset, like a power cycle).
// Single click, no confirm — a restart is harmless (settings survive), the
// radio is just off the wire for a few seconds.

function RestartRadioButton(props: { onReset: () => void }) {
  return (
    <button
      onClick={props.onReset}
      title="Restart radio (soft power cycle) — drops off CAT for a few seconds"
      class="w-7 h-7 flex items-center justify-center rounded border transition-colors bg-[#da3633] border-[#da3633] text-white hover:bg-[#f85149] hover:border-[#f85149]"
    >
      {/* refresh/restart icon (heroicons v1 solid) */}
      <svg xmlns="http://www.w3.org/2000/svg" class="h-3.5 w-3.5 shrink-0" viewBox="0 0 20 20" fill="currentColor">
        <path fill-rule="evenodd" d="M4 2a1 1 0 011 1v2.101a7.002 7.002 0 0111.601 2.566 1 1 0 11-1.885.666A5.002 5.002 0 005.999 7H9a1 1 0 010 2H4a1 1 0 01-1-1V3a1 1 0 011-1zm.008 9.057a1 1 0 011.276.61A5.002 5.002 0 0014.001 13H11a1 1 0 110-2h5a1 1 0 011 1v5a1 1 0 11-2 0v-2.101a7.002 7.002 0 01-11.601-2.566 1 1 0 01.61-1.276z" clip-rule="evenodd" />
      </svg>
    </button>
  )
}

// ── FactoryResetButton ────────────────────────────────────────────────────────
// SR2; — wipes ALL stored settings (band memories, ref-freq calibration) and
// reboots. Destructive, so unlike the restart button this keeps a two-step
// confirm: first click arms ("Wipe everything?"), auto-disarms after 4s.

function FactoryResetButton(props: { onConfirm: () => void }) {
  const [armed, setArmed] = createSignal(false)

  createEffect(() => {
    if (!armed()) return
    const t = setTimeout(() => setArmed(false), 4000)
    onCleanup(() => clearTimeout(t))
  })

  return (
    <button
      onClick={() => { if (!armed()) { setArmed(true); return } setArmed(false); props.onConfirm() }}
      title={armed()
        ? 'Click again to confirm — wipes ALL stored settings and reboots'
        : 'Factory reset — restores the defaults shown here, wiping band memories and calibration'}
      class={`text-[10px] font-semibold px-2.5 py-1.5 rounded border transition-colors whitespace-nowrap
        ${armed()
          ? 'bg-[#da3633] border-[#f85149] text-white'
          : 'bg-[#21262d] border-[#f85149] text-[#f85149] hover:bg-[#da3633] hover:text-white'
        }`}
    >
      {armed() ? 'Wipe everything?' : 'Factory Reset'}
    </button>
  )
}

// ── BlackBrickControls ────────────────────────────────────────────────────────
// uSDX BLACK_BRICK 4.01a custom extension controls: volume, attenuators, noise
// reduction, AGC, filter, TX drive, backlight. Wraps onto its own row below the
// main toolbar. S-Meter is shown separately in the main toolbar since it's a
// read-only reading, not a control. PA bias and TX timeout live in the
// advanced-settings panel (PABiasPanel) behind the wrench button.

function BlackBrickControls(props: {
  volume: number | null
  att1: number | null
  att2: number | null
  nr: number | null
  agc: number | null
  agcLevel: number | null
  filter: number | null
  drive: number | null
  backlight: number | null
  firmwareVersion: string | null
  paOpen: boolean
  onVolume: (n: number) => void
  onAtt1: (n: number) => void
  onAtt2: (n: number) => void
  onNR: (n: number) => void
  onAGC: (n: number) => void
  onAgcLevel: (n: number) => void
  onFilter: (n: number) => void
  onDrive: (n: number) => void
  onBacklight: (n: number) => void
  onTogglePA: () => void
  onReset: () => void
}) {
  const agcOn = () => props.agc === AGC_ON
  return (
    <div class="basis-full flex items-center gap-3 flex-wrap pt-2 mt-1 border-t border-[#21262d]">
      <NumberStepper label="Volume" value={props.volume} min={-1} max={16} onChange={props.onVolume} />
      <NumberStepper label="Analog Attenuator" value={props.att1} min={0} max={7} valueLabels={ANALOG_ATTENUATOR_DB_LABELS} onChange={props.onAtt1} />
      <NumberStepper label="Digital Attenuator" value={props.att2} min={0} max={16} valueLabels={DIGITAL_ATTENUATOR_DB_LABELS} onChange={props.onAtt2} />
      <NumberStepper label="Noise Reduction" value={props.nr} min={0} max={8} onChange={props.onNR} />
      <NumberStepper label="Filter Bandwidth" value={props.filter} min={0} max={7} valueLabels={FILTER_LABELS} onChange={props.onFilter} />
      <NumberStepper label="TX Driver" value={props.drive} min={0} max={8} onChange={props.onDrive} />

      <div class="flex items-center gap-1.5" title="Auto Gain Control">
        <span class="text-[10px] font-semibold text-[#8b949e] whitespace-nowrap">Auto Gain Control</span>
        <button
          onClick={() => props.onAGC(agcOn() ? AGC_OFF : AGC_ON)}
          disabled={props.agc === null}
          class={`text-[10px] font-semibold px-2 py-1 rounded transition-colors border disabled:opacity-30
            ${agcOn()
              ? 'bg-[#238636] border-[#238636] text-white'
              : 'bg-[#21262d] border-[#30363d] text-[#8b949e] hover:text-[#c9d1d9] hover:border-[#8b949e]'
            }`}
        >
          {props.agc === null ? '—' : agcOn() ? 'ON' : 'OFF'}
        </button>
      </div>

      {/* AGC target level (AL command) — only meaningful while AGC is on */}
      <Show when={agcOn()}>
        <NumberStepper label="AGC Level" value={props.agcLevel} min={AGC_LEVEL_MIN} max={AGC_LEVEL_MAX} onChange={props.onAgcLevel} />
      </Show>

      <BacklightToggle backlight={props.backlight} onToggle={props.onBacklight} />

      <Show when={props.firmwareVersion}>
        <span class="text-[10px] text-[#8b949e] whitespace-nowrap" title="Firmware version reported by the radio (FV command)">
          FW {props.firmwareVersion}
        </span>
      </Show>

      <div class="ml-auto flex items-center gap-1.5">
        <RestartRadioButton onReset={props.onReset} />

        {/* Advanced settings — tucked away, opens the on-demand panel */}
        <button
          onClick={props.onTogglePA}
          title="Advanced settings"
          class={`w-7 h-7 flex items-center justify-center rounded border transition-colors
            ${props.paOpen
              ? 'bg-[#21262d] border-[#388bfd] text-[#79c0ff]'
              : 'bg-[#21262d] border-[#30363d] text-[#8b949e] hover:text-[#c9d1d9] hover:border-[#8b949e]'
            }`}
        >
          {/* wrench icon (heroicons v1 solid, adjustments) */}
          <svg xmlns="http://www.w3.org/2000/svg" class="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor">
            <path d="M5 4a1 1 0 00-2 0v7.268a2 2 0 000 3.464V16a1 1 0 102 0v-1.268a2 2 0 000-3.464V4zM11 4a1 1 0 10-2 0v1.268a2 2 0 000 3.464V16a1 1 0 102 0V8.732a2 2 0 000-3.464V4zM16 3a1 1 0 011 1v7.268a2 2 0 010 3.464V16a1 1 0 11-2 0v-1.268a2 2 0 010-3.464V4a1 1 0 011-1z" />
          </svg>
        </button>
      </div>
    </div>
  )
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

function PABiasPanel(props: {
  getPABias: () => Promise<PABias | null>
  setPABias: (which: 'min' | 'max', n: number) => Promise<number | null>
  getFactoryDefaults: () => Promise<FactoryDefaults | null>
  onFactoryReset: () => void
  onOpenCalibration: () => void
  getTxTimeout: () => Promise<number | null>
  setTxTimeout: (n: number) => Promise<number | null>
}) {
  const [bias, setBias] = createSignal<PABias | null>(null)
  const [defaults, setDefaults] = createSignal<FactoryDefaults | null>(null)
  const [failed, setFailed] = createSignal(false)
  const [minDraft, setMinDraft] = createSignal('')
  const [maxDraft, setMaxDraft] = createSignal('')
  const [busy, setBusy] = createSignal(false)
  const [txTimeout, setTxTimeoutState] = createSignal<number | null>(null)
  const [ttBusy, setTtBusy] = createSignal(false)
  // Guards against overlapping load() runs: the effect below re-fires whenever
  // its callback deps get a new identity (they're recreated on parent
  // re-renders), which was queuing duplicate PM/PX/FD/TT queries — the CAT
  // queue's own dedup then resolved the second copy of each with a sentinel
  // ('__dedup__') instead of the real reply, and whichever run's state update
  // landed last could stomp a good reading with that garbage. Only the latest
  // call is allowed to commit its results.
  let loadSeq = 0

  const load = async () => {
    const seq = ++loadSeq
    setBias(null); setDefaults(null); setFailed(false); setTxTimeoutState(null)
    const [b, d, tt] = await Promise.all([props.getPABias(), props.getFactoryDefaults(), props.getTxTimeout()])
    if (seq !== loadSeq) return // a newer load() superseded this one
    if (b) {
      setBias(b)
      setMinDraft(String(b.min))
      setMaxDraft(String(b.max))
    } else {
      setFailed(true)
    }
    setDefaults(d)
    setTxTimeoutState(tt)
  }

  // query once on open (mount) — mirrors the original's useEffect(() => { load() }, [load])
  load()

  const commitTxTimeout = async (n: number) => {
    if (ttBusy()) return
    setTtBusy(true)
    const confirmed = await props.setTxTimeout(n)
    setTtBusy(false)
    // Trust the radio's echo (it returns the old value if the SET was rejected)
    setTxTimeoutState((prev) => confirmed ?? prev)
  }

  const commit = async (which: 'min' | 'max') => {
    const b = bias()
    if (!b || busy()) return
    const raw = which === 'min' ? minDraft() : maxDraft()
    const n = parseInt(raw, 10)
    // Clamp to what the firmware will accept: min ∈ [0, max-1], max ∈ [min+1, 255]
    const clamped = isNaN(n)
      ? (which === 'min' ? b.min : b.max)
      : which === 'min'
        ? Math.max(0, Math.min(b.max - 1, n))
        : Math.max(b.min + 1, Math.min(255, n))
    if (clamped === (which === 'min' ? b.min : b.max)) {
      // No effective change — just normalize the draft back
      ;(which === 'min' ? setMinDraft : setMaxDraft)(String(which === 'min' ? b.min : b.max))
      return
    }
    setBusy(true)
    const confirmed = await props.setPABias(which, clamped)
    setBusy(false)
    // Trust the radio's echo (it returns the old value if the SET was rejected)
    const effective = confirmed ?? (which === 'min' ? b.min : b.max)
    setBias((prev) => prev ? { ...prev, [which]: effective } : prev)
    ;(which === 'min' ? setMinDraft : setMaxDraft)(String(effective))
  }

  const inputCls = 'w-16 bg-[#0d1117] border border-[#30363d] text-[#c9d1d9] text-xs rounded px-2 py-1.5 focus:outline-none focus:border-[#388bfd] font-mono disabled:opacity-40'
  const keyHandler = (which: 'min' | 'max'): JSX.EventHandler<HTMLInputElement, KeyboardEvent> => (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(which) }
    if (e.key === 'Escape') { setMinDraft(String(bias()?.min ?? '')); setMaxDraft(String(bias()?.max ?? '')) }
  }

  // Human-readable one-liner of what a factory reset would restore, built from
  // the radio's own FD; reply (never hardcoded).
  const defaultsSummary = () => {
    const defs = defaults()
    return defs === null ? null : [
      `Volume ${defs.volume}`,
      `Mode ${defs.mode ?? '?'}`,
      `AGC ${defs.agc === 1 ? 'On' : 'Off'}`,
      `Filter ${FILTER_LABELS[defs.filter] ?? defs.filter}`,
      `ATT ${ANALOG_ATTENUATOR_DB_LABELS[defs.att1] ?? defs.att1}/${DIGITAL_ATTENUATOR_DB_LABELS[defs.att2] ?? defs.att2}`,
      `NR ${defs.nr}`,
      `Drive ${defs.drive}`,
      `Backlight ${defs.backlight === 1 ? 'On' : 'Off'}`,
      `PA bias ${defs.paMin}/${defs.paMax}`,
    ].join(' · ')
  }

  return (
    <div class="mt-2 bg-[#161b22] border border-[#30363d] rounded-lg p-4 flex flex-col gap-3">
      <span class="text-[10px] font-bold uppercase tracking-widest text-[#8b949e] select-none">
        Advanced Settings
      </span>

      <Show
        when={!failed()}
        fallback={
          <div class="flex items-center gap-3">
            <span class="text-xs text-[#f85149]">Could not read PA bias from the radio.</span>
            <button
              onClick={load}
              class="text-[10px] font-semibold px-2 py-1 rounded bg-[#21262d] border border-[#30363d] text-[#8b949e] hover:text-[#c9d1d9] hover:border-[#8b949e] transition-colors"
            >
              Retry
            </button>
          </div>
        }
      >
        <Show
          when={bias()}
          fallback={<span class="text-xs text-[#8b949e]">Reading current values from the radio…</span>}
        >
          {(b) => (
            <div class="flex items-center gap-6 flex-wrap">
              <div class="flex items-center gap-2" title={`PA bias min — PWM at zero drive (idle bias). Valid: 0 to ${b().max - 1}.`}>
                <span class="text-[10px] font-semibold text-[#8b949e] whitespace-nowrap">Bias Min</span>
                <input
                  type="number" min={0} max={b().max - 1} step={1}
                  value={minDraft()} disabled={busy()}
                  onInput={(e) => setMinDraft(e.currentTarget.value)}
                  onBlur={() => commit('min')}
                  onKeyDown={keyHandler('min')}
                  class={inputCls}
                />
              </div>
              <div class="flex items-center gap-2" title={`PA max — PWM at full drive. Valid: ${b().min + 1} to 255.`}>
                <span class="text-[10px] font-semibold text-[#8b949e] whitespace-nowrap">PA Max</span>
                <input
                  type="number" min={b().min + 1} max={255} step={1}
                  value={maxDraft()} disabled={busy()}
                  onInput={(e) => setMaxDraft(e.currentTarget.value)}
                  onBlur={() => commit('max')}
                  onKeyDown={keyHandler('max')}
                  class={inputCls}
                />
              </div>
              <Show when={busy()}><span class="text-[10px] text-[#8b949e]">writing…</span></Show>
            </div>
          )}
        </Show>
      </Show>

      <p class="text-[10px] text-[#f0883e]">
        Sets the PA MOSFET bias PWM endpoints (0–255) and rebuilds the TX lookup table immediately.
        Too-high values can overheat the finals — change with care.
      </p>

      {/* ── TX time-out guard ── */}
      <div class="border-t border-[#21262d] pt-3 flex items-center gap-3 flex-wrap">
        <NumberStepper label="TX Timeout (s)" value={txTimeout()} min={0} max={255} onChange={commitTxTimeout} />
        <Show when={ttBusy()}><span class="text-[10px] text-[#8b949e]">writing…</span></Show>
        <p class="text-[10px] text-[#8b949e] flex-1 min-w-[16rem]">
          Firmware force-unkeys the PA if TX stays keyed past this many seconds. 0 disables the guard.
        </p>
      </div>

      {/* ── Frequency calibration ── */}
      <div class="border-t border-[#21262d] pt-3 flex items-center gap-3 flex-wrap">
        <button
          onClick={props.onOpenCalibration}
          class="text-[10px] font-semibold px-2.5 py-1.5 rounded border transition-colors whitespace-nowrap bg-[#21262d] border-[#30363d] text-[#8b949e] hover:text-[#c9d1d9] hover:border-[#8b949e]"
          title="Calibrate the reference oscillator against an off-air standard station (receive-only)"
        >
          Calibrate Frequency…
        </button>
        <p class="text-[10px] text-[#8b949e] flex-1 min-w-[16rem]">
          Guided, receive-only calibration of the dial frequency against WWV/CHU. No transmission — no dummy load needed.
        </p>
      </div>

      {/* ── Factory reset ── */}
      <div class="border-t border-[#21262d] pt-3 flex items-center gap-3 flex-wrap">
        <FactoryResetButton onConfirm={props.onFactoryReset} />
        <p class="text-[10px] text-[#8b949e] flex-1 min-w-[16rem]">
          Restores all settings to firmware defaults and reboots — band memories and frequency calibration are wiped too.
          <Show
            when={defaultsSummary()}
            fallback={<span class="text-[#f0883e]"> Could not read the default values from the radio.</span>}
          >
            {' '}Defaults (reported by the radio): <span class="text-[#c9d1d9]">{defaultsSummary()}</span>.
          </Show>
        </p>
      </div>
    </div>
  )
}

// ── BridgeResetButton ─────────────────────────────────────────────────────────
// Reboots the ESP32 bridge itself (not the radio). Two-step confirm like the
// factory-reset button — it's disruptive (the bridge drops off Wi-Fi for a
// few seconds) even though it's not destructive to any stored settings.

function BridgeResetButton(props: { onConfirm: () => void; busy: boolean }) {
  const [armed, setArmed] = createSignal(false)

  createEffect(() => {
    if (!armed()) return
    const t = setTimeout(() => setArmed(false), 4000)
    onCleanup(() => clearTimeout(t))
  })

  return (
    <button
      onClick={() => { if (!armed()) { setArmed(true); return } setArmed(false); props.onConfirm() }}
      disabled={props.busy}
      title={armed() ? 'Click again to confirm — reboots the bridge, briefly dropping Wi-Fi' : 'Restart the ESP32 CAT bridge'}
      class={`text-[10px] font-semibold px-2.5 py-1.5 rounded border transition-colors whitespace-nowrap disabled:opacity-50
        ${armed()
          ? 'bg-[#da3633] border-[#f85149] text-white'
          : 'bg-[#21262d] border-[#f0883e] text-[#f0883e] hover:bg-[#bd561d] hover:text-white'
        }`}
    >
      {props.busy ? 'Restarting…' : armed() ? 'Restart bridge?' : 'Restart Bridge'}
    </button>
  )
}

// ── BridgeSliderControl ───────────────────────────────────────────────────────
// Generic 0..max slider for a bridge LCD setting (backlight PWM duty,
// contrast/Vop) — applies live and persists as the bridge's new boot
// default. Local draft state so dragging the slider doesn't fire a request
// per pixel; commits on release (change), not on every input event.

function BridgeSliderControl(props: {
  label: string
  value: number
  max: number
  onCommit: (n: number) => void
  busy: boolean
}) {
  const [draft, setDraft] = createSignal(props.value)
  createEffect(() => setDraft(props.value))

  return (
    <div class="flex items-center gap-2">
      <span class="text-[10px] font-semibold text-[#8b949e] whitespace-nowrap">{props.label}</span>
      <input
        type="range" min={0} max={props.max} step={1}
        value={draft()}
        disabled={props.busy}
        onInput={(e) => setDraft(Number(e.currentTarget.value))}
        onChange={(e) => props.onCommit(Number(e.currentTarget.value))}
        class="w-28 accent-[#388bfd] disabled:opacity-50"
      />
      <span class="text-[10px] text-[#c9d1d9] font-mono w-8 text-right">{draft()}</span>
    </div>
  )
}

// ── BridgeWifiConfigForm ──────────────────────────────────────────────────────
// Change the bridge's own Wi-Fi network — persists to the bridge's NVS and
// reboots it onto the new network. Deliberately separate from the CAT
// connection settings above: this reconfigures the ESP32 hardware itself,
// not anything about how THIS browser talks to it.

function BridgeWifiConfigForm(props: {
  currentSsid: string
  onSubmit: (ssid: string, password: string) => void
  busy: boolean
}) {
  const [open, setOpen] = createSignal(false)
  const [ssid, setSsid] = createSignal('')
  const [password, setPassword] = createSignal('')

  const handleOpen = () => { setSsid(props.currentSsid); setPassword(''); setOpen(true) }
  const handleSubmit = (e: Event) => {
    e.preventDefault()
    if (!ssid().trim()) return
    props.onSubmit(ssid().trim(), password())
    setOpen(false)
  }

  return (
    <Show
      when={open()}
      fallback={
        <button
          onClick={handleOpen}
          disabled={props.busy}
          class="text-[10px] font-semibold px-2.5 py-1.5 rounded border transition-colors whitespace-nowrap disabled:opacity-50 bg-[#21262d] border-[#30363d] text-[#8b949e] hover:text-[#c9d1d9] hover:border-[#8b949e]"
        >
          Change Wi-Fi Network…
        </button>
      }
    >
      <form onSubmit={handleSubmit} class="flex flex-col gap-2 w-full">
        <div class="flex items-center gap-2 flex-wrap">
          <input
            type="text" placeholder="SSID" value={ssid()}
            onInput={(e) => setSsid(e.currentTarget.value)}
            class="bg-[#0d1117] border border-[#30363d] text-[#c9d1d9] text-xs rounded px-2 py-1.5 focus:outline-none focus:border-[#388bfd] flex-1 min-w-[8rem]"
          />
          <input
            type="password" placeholder="Password" value={password()}
            onInput={(e) => setPassword(e.currentTarget.value)}
            class="bg-[#0d1117] border border-[#30363d] text-[#c9d1d9] text-xs rounded px-2 py-1.5 focus:outline-none focus:border-[#388bfd] flex-1 min-w-[8rem]"
          />
        </div>
        <div class="flex items-center gap-2">
          <button
            type="submit"
            disabled={props.busy || !ssid().trim()}
            class="text-[10px] font-semibold px-2.5 py-1.5 rounded bg-[#238636] hover:bg-[#2ea043] text-white disabled:opacity-50"
          >
            {props.busy ? 'Saving…' : 'Save & Restart'}
          </button>
          <button
            type="button" onClick={() => setOpen(false)} disabled={props.busy}
            class="text-[10px] text-[#8b949e] hover:text-[#c9d1d9] disabled:opacity-50"
          >
            Cancel
          </button>
        </div>
        <p class="text-[10px] text-[#f0883e]">
          The bridge will restart onto the new network — this page won't be able to reach it until you know its new address.
        </p>
      </form>
    </Show>
  )
}

// ── BridgeAudioControl ────────────────────────────────────────────────────────
// Live audio bridge to the ESP32's onboard codec (see useAudioBridge.ts) —
// two level meters (radio speaker -> browser, browser mic -> radio mic) plus
// play/mic toggles. Not real WebRTC (no ICE/DTLS-SRTP on bare ESP-IDF); a
// second WebSocket (/audio) carrying raw PCM, same infra as /cat.

function AudioMeter(props: { label: string; level: number; active: boolean }) {
  const pct = () => Math.round(props.level * 100)
  return (
    <div class="flex items-center gap-2">
      <span class="text-[10px] font-semibold text-[#8b949e] whitespace-nowrap w-16">{props.label}</span>
      <div class="flex-1 h-2 rounded bg-[#0d1117] border border-[#30363d] overflow-hidden">
        <div
          class="h-full bg-[#3fb950] transition-[width] duration-75"
          style={{ width: `${props.active ? pct() : 0}%` }}
        />
      </div>
      <span class="text-[10px] text-[#8b949e] font-mono w-8 text-right">{props.active ? `${pct()}%` : '—'}</span>
    </div>
  )
}

function BridgeAudioControl(props: { wsUrl: string }) {
  const audio = useAudioBridge()
  const [busy, setBusy] = createSignal(false)

  const handlePlayToggle = async () => {
    setBusy(true)
    if (audio.state().connected) {
      audio.disconnect()
    } else {
      await audio.connect(props.wsUrl)
    }
    setBusy(false)
  }

  const handleMicToggle = async () => {
    setBusy(true)
    if (audio.state().micActive) {
      audio.stopMic()
    } else {
      await audio.startMic()
    }
    setBusy(false)
  }

  return (
    <div class="flex flex-col gap-2">
      <AudioMeter label="Speaker" level={audio.state().levelIn} active={audio.state().playbackActive} />
      <AudioMeter label="Mic" level={audio.state().levelOut} active={audio.state().micActive} />
      <div class="flex items-center gap-2 flex-wrap">
        <button
          onClick={() => void handlePlayToggle()}
          disabled={busy()}
          class={`text-[10px] font-semibold px-2.5 py-1.5 rounded border transition-colors whitespace-nowrap disabled:opacity-50
            ${audio.state().connected
              ? 'bg-[#21262d] border-[#f0883e] text-[#f0883e] hover:bg-[#bd561d] hover:text-white'
              : 'bg-[#238636] border-[#238636] text-white hover:bg-[#2ea043]'
            }`}
        >
          {audio.state().connected ? 'Stop Listening' : 'Listen to Radio'}
        </button>
        <button
          onClick={() => void handleMicToggle()}
          disabled={busy() || !audio.state().connected}
          class={`text-[10px] font-semibold px-2.5 py-1.5 rounded border transition-colors whitespace-nowrap disabled:opacity-50
            ${audio.state().micActive
              ? 'bg-[#21262d] border-[#f0883e] text-[#f0883e] hover:bg-[#bd561d] hover:text-white'
              : 'bg-[#21262d] border-[#30363d] text-[#8b949e] hover:text-[#c9d1d9] hover:border-[#8b949e]'
            }`}
        >
          {audio.state().micActive ? 'Stop Mic' : 'Send Mic to Radio'}
        </button>
      </div>
      <Show when={audio.state().error}>
        <p class="text-[10px] text-[#f0883e]">{audio.state().error}</p>
      </Show>
      <p class="text-[10px] text-[#8b949e]">
        Streams raw audio over a second WebSocket ({'/audio'}), not the CAT connection — independent of the radio's own PTT state.
      </p>
    </div>
  )
}

// ── BridgeStatusPanel ─────────────────────────────────────────────────────────
// On-demand ESP32 CAT bridge status (Wi-Fi RSSI/SSID/IP, connected client
// count, radio-link, uptime) plus firmware version/capabilities and
// controls gated on them — queried once when this panel opens via GET
// /status + GET /info, not part of any poll loop (the bridge is a separate
// device from the radio; there's no reason to hit it on every CAT poll
// tick). Only relevant for the 'websocket' transport — rendered only when
// config().transport === 'websocket' by the parent.
//
// Capability gating: every control below only renders if getBridgeInfo()
// reported the matching feature string — an older bridge firmware that
// predates a given control simply won't show it, rather than showing a
// button that 404s. See the versioning note in
// firmware/esp32-cat-bridge/main/bridge_config.h.

function BridgeStatusPanel(props: {
  wsUrl: string
  getBridgeStatus: (wsUrl: string) => Promise<BridgeStatus | null>
  resetBridge: (wsUrl: string) => Promise<boolean>
  getBridgeInfo: (wsUrl: string) => Promise<BridgeInfo | null>
  setBridgeBacklight: (wsUrl: string, duty: number) => Promise<{ duty: number; saved: boolean } | null>
  setBridgeContrast: (wsUrl: string, vop: number) => Promise<{ vop: number; saved: boolean } | null>
  setBridgeWifiConfig: (wsUrl: string, ssid: string, password: string) => Promise<boolean>
  setBridgeCatBaud: (wsUrl: string, baud: number) => Promise<{ baud: number; saved: boolean } | null>
  clearBridgePaEmergency: (wsUrl: string) => Promise<boolean | null>
}) {
  const [status, setStatus] = createSignal<BridgeStatus | null>(null)
  const [info, setInfo] = createSignal<BridgeInfo | null>(null)
  const [failed, setFailed] = createSignal(false)
  const [loading, setLoading] = createSignal(true)
  const [resetBusy, setResetBusy] = createSignal(false)
  const [backlightBusy, setBacklightBusy] = createSignal(false)
  const [backlightDuty, setBacklightDuty] = createSignal(0)
  const [contrastBusy, setContrastBusy] = createSignal(false)
  const [contrastVop, setContrastVop] = createSignal(0x3F) // matches LCD_CONTRAST_DEFAULT_VOP
  const [wifiConfigBusy, setWifiConfigBusy] = createSignal(false)
  const [catBaudBusy, setCatBaudBusy] = createSignal(false)
  const [catBaudDraft, setCatBaudDraft] = createSignal(38400)
  const [paClearBusy, setPaClearBusy] = createSignal(false)
  let loadSeq = 0

  const hasFeature = (name: string) => info()?.features.includes(name) ?? false

  const load = async () => {
    const seq = ++loadSeq
    setLoading(true); setFailed(false)
    const [s, i] = await Promise.all([props.getBridgeStatus(props.wsUrl), props.getBridgeInfo(props.wsUrl)])
    if (seq !== loadSeq) return
    setLoading(false)
    if (s) setStatus(s); else setFailed(true)
    setInfo(i)
    // Neither backlight nor contrast has a readback in GET /status — the
    // panel starts both sliders at a reasonable default (mid-range) rather
    // than lying about the bridge's actual current values, which this
    // endpoint doesn't report. cat_baud IS reported, though, so that select
    // reflects the bridge's real current setting.
    if (s?.catBaud) setCatBaudDraft(s.catBaud)
  }

  load()

  const handleRefresh = () => { void load() }

  const handleRestart = async () => {
    setResetBusy(true)
    await props.resetBridge(props.wsUrl)
    // The bridge is rebooting — don't bother re-querying status right away,
    // it won't answer for a few seconds. Leave the last-known status
    // visible (stale-but-labeled) rather than blanking the panel.
    setResetBusy(false)
  }

  const handleBacklightCommit = async (duty: number) => {
    setBacklightBusy(true)
    const result = await props.setBridgeBacklight(props.wsUrl, duty)
    if (result) setBacklightDuty(result.duty)
    setBacklightBusy(false)
  }

  const handleContrastCommit = async (vop: number) => {
    setContrastBusy(true)
    const result = await props.setBridgeContrast(props.wsUrl, vop)
    if (result) setContrastVop(result.vop)
    setContrastBusy(false)
  }

  const handleWifiConfigSubmit = async (ssid: string, password: string) => {
    setWifiConfigBusy(true)
    await props.setBridgeWifiConfig(props.wsUrl, ssid, password)
    // Same reasoning as restart: the bridge is about to drop off this
    // network entirely, so there's nothing more to query here.
    setWifiConfigBusy(false)
  }

  const handleCatBaudApply = async () => {
    setCatBaudBusy(true)
    const result = await props.setBridgeCatBaud(props.wsUrl, catBaudDraft())
    if (result) setCatBaudDraft(result.baud)
    setCatBaudBusy(false)
  }

  const handlePaEmergencyClear = async () => {
    if (!window.confirm(
      'Clear the PA emergency cutoff? Only do this if you have confirmed by eye/ear that the amplifier is actually safe to re-enable.'
    )) return
    setPaClearBusy(true)
    const tripped = await props.clearBridgePaEmergency(props.wsUrl)
    if (tripped === false) await load() // re-fetch so the panel reflects the cleared state immediately
    setPaClearBusy(false)
  }

  const rssiQuality = (rssi: number): string =>
    rssi >= -55 ? 'Excellent' : rssi >= -67 ? 'Good' : rssi >= -78 ? 'Weak' : 'Very weak'

  return (
    <div class="mt-2 bg-[#161b22] border border-[#30363d] rounded-lg p-4 flex flex-col gap-3">
      <div class="flex items-center justify-between">
        <span class="text-[10px] font-bold uppercase tracking-widest text-[#8b949e]">
          ESP32 CAT Bridge
          <Show when={info()}>{(i) => <span class="text-[#484f58] font-normal normal-case ml-1.5">v{i().firmwareVersion}</span>}</Show>
        </span>
        <button
          onClick={handleRefresh}
          disabled={loading()}
          class="text-[10px] text-[#8b949e] hover:text-[#c9d1d9] disabled:opacity-50"
        >
          {loading() ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      <Show when={status()?.paEmergencyTripped}>
        <div class="bg-[#3d1214] border border-[#f85149] rounded-md p-3 flex flex-col gap-2">
          <p class="text-[11px] font-bold text-[#f85149]">
            PA EMERGENCY CUTOFF TRIPPED — amplifier forced off, will not re-enable until cleared.
          </p>
          <p class="text-[10px] text-[#f0883e]">
            Confirm by eye/ear that the amplifier is actually safe before clearing — this does not re-check anything itself.
          </p>
          <button
            onClick={() => void handlePaEmergencyClear()}
            disabled={paClearBusy()}
            class="self-start text-[10px] font-semibold px-2.5 py-1.5 rounded bg-[#da3633] hover:bg-[#f85149] text-white disabled:opacity-50"
          >
            {paClearBusy() ? 'Clearing…' : 'Clear emergency cutoff'}
          </button>
        </div>
      </Show>

      <Show
        when={status()}
        fallback={
          <p class="text-[10px] text-[#f0883e]">
            {loading() ? 'Querying bridge…' : failed() ? 'Could not reach the bridge at ' + props.wsUrl + '.' : ''}
          </p>
        }
      >
        {(s) => (
          <div class="grid grid-cols-2 gap-x-4 gap-y-1.5 text-[11px]">
            <span class="text-[#8b949e]">Wi-Fi</span>
            <span class="text-[#c9d1d9]">{s().ssid} ({s().wifiState})</span>
            <span class="text-[#8b949e]">Signal</span>
            <span class="text-[#c9d1d9]">{s().rssi} dBm — {rssiQuality(s().rssi)}</span>
            <span class="text-[#8b949e]">IP address</span>
            <span class="text-[#c9d1d9] font-mono">{s().ip || '—'}</span>
            <span class="text-[#8b949e]">Radio link</span>
            <span class={s().radioLinked ? 'text-[#3fb950]' : 'text-[#f0883e]'}>
              {s().radioLinked ? 'linked' : 'silent'}
            </span>
            <span class="text-[#8b949e]">Connected clients</span>
            <span class="text-[#c9d1d9]">{s().wsClients} / {s().wsMaxClients}</span>
            <span class="text-[#8b949e]">CAT baud</span>
            <span class="text-[#c9d1d9]">{s().catBaud || '—'}</span>
            <Show when={hasFeature('pa_watchdog')}>
              <span class="text-[#8b949e]">PA sense</span>
              <span class={s().paSense ? 'text-[#3fb950]' : 'text-[#8b949e]'}>
                {s().paSense ? 'energized' : 'off'}
              </span>
            </Show>
            <span class="text-[#8b949e]">Uptime</span>
            <span class="text-[#c9d1d9]">{Math.floor(s().uptimeSeconds / 60)}m {s().uptimeSeconds % 60}s</span>
          </div>
        )}
      </Show>

      <Show when={hasFeature('backlight')}>
        <div class="border-t border-[#21262d] pt-3">
          <BridgeSliderControl label="Backlight" value={backlightDuty()} max={255} onCommit={(n) => void handleBacklightCommit(n)} busy={backlightBusy()} />
        </div>
      </Show>

      <Show when={hasFeature('contrast')}>
        <div class="border-t border-[#21262d] pt-3">
          <BridgeSliderControl label="Contrast" value={contrastVop()} max={127} onCommit={(n) => void handleContrastCommit(n)} busy={contrastBusy()} />
        </div>
      </Show>

      <Show when={hasFeature('cat_baud')}>
        <div class="border-t border-[#21262d] pt-3 flex flex-col gap-1.5">
          <div class="flex items-center gap-2">
            <span class="text-[10px] font-semibold text-[#8b949e] whitespace-nowrap">CAT baud</span>
            <select
              value={catBaudDraft()}
              disabled={catBaudBusy()}
              onChange={(e) => setCatBaudDraft(Number(e.currentTarget.value))}
              class="bg-[#0d1117] border border-[#30363d] text-[#c9d1d9] text-[11px] rounded px-2 py-1 disabled:opacity-50"
            >
              <option value={9600}>9600</option>
              <option value={19200}>19200</option>
              <option value={38400}>38400</option>
              <option value={57600}>57600</option>
            </select>
            <button
              onClick={() => void handleCatBaudApply()}
              disabled={catBaudBusy()}
              class="text-[10px] font-semibold px-2.5 py-1.5 rounded bg-[#21262d] border border-[#30363d] text-[#8b949e] hover:text-[#c9d1d9] hover:border-[#8b949e] disabled:opacity-50"
            >
              {catBaudBusy() ? 'Applying…' : 'Apply'}
            </button>
          </div>
          <p class="text-[10px] text-[#8b949e]">
            There's no CAT command that reports or changes the radio's own baud — if you change it in the radio's menu, set it here too, or the CAT link will desync.
          </p>
        </div>
      </Show>

      <Show when={hasFeature('wifi_config')}>
        <div class="border-t border-[#21262d] pt-3">
          <BridgeWifiConfigForm
            currentSsid={status()?.ssid ?? ''}
            onSubmit={(ssid, password) => void handleWifiConfigSubmit(ssid, password)}
            busy={wifiConfigBusy()}
          />
        </div>
      </Show>

      <Show when={hasFeature('reset')}>
        <div class="border-t border-[#21262d] pt-3 flex items-center gap-3 flex-wrap">
          <BridgeResetButton onConfirm={() => void handleRestart()} busy={resetBusy()} />
          <p class="text-[10px] text-[#8b949e] flex-1 min-w-[16rem]">
            Reboots the ESP32 bridge itself — not the radio. CAT will briefly drop while it restarts and reconnects to Wi-Fi.
          </p>
        </div>
      </Show>

      <Show when={hasFeature('audio')}>
        <div class="border-t border-[#21262d] pt-3">
          <BridgeAudioControl wsUrl={props.wsUrl} />
        </div>
      </Show>
    </div>
  )
}

// ── Main panel ────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: CATConnectionConfig & { presetIdx: number } = {
  presetIdx: 0,
  baudRate: 38400, dataBits: 8, stopBits: 1, parity: 'none',
  timeoutMs: 200, pollIntervalMs: 500, debug: false,
  rigProfile: RADIO_PRESETS[0].rigProfile,
  transport: 'serial', wsUrl: 'ws://usdx-bridge.local/cat',
}

// Restores presetIdx/transport/wsUrl from localStorage, but re-derives
// baudRate/dataBits/stopBits/parity/rigProfile from RADIO_PRESETS[presetIdx]
// rather than trusting a stored copy of them — if RADIO_PRESETS ever changes
// (reordered, added to), a stale stored value for those fields could
// silently disagree with what the preset itself says. presetIdx is range-
// checked since a shrunk preset list could otherwise index out of bounds.
function loadInitialConfig(): CATConnectionConfig & { presetIdx: number } {
  const stored = loadObject(CAT_CONFIG_STORAGE_KEY, DEFAULT_CONFIG)
  const presetIdx = stored.presetIdx >= 0 && stored.presetIdx < RADIO_PRESETS.length
    ? stored.presetIdx : DEFAULT_CONFIG.presetIdx
  const preset = RADIO_PRESETS[presetIdx]
  return {
    ...stored,
    presetIdx,
    baudRate: preset.baudRate, dataBits: preset.dataBits,
    stopBits: preset.stopBits, parity: preset.parity,
    rigProfile: preset.rigProfile,
  }
}

export default function RadioCATPanel(props: { cat: RadioCATControls; collapsed?: boolean }): JSX.Element {
  const cat = props.cat
  const state = () => cat.state()

  const [showSettings, setShowSettings] = createSignal(false)
  const [showPABias, setShowPABias] = createSignal(false)
  const [showCalibration, setShowCalibration] = createSignal(false)
  const [showBridgeStatus, setShowBridgeStatus] = createSignal(false)
  const [config, setConfig] = createSignal(loadInitialConfig())

  // Persist on every change — matches the load side: everything is saved,
  // but only presetIdx/transport/wsUrl (plus the re-derivable serial fields)
  // are meaningfully restored on the next load via loadInitialConfig().
  createEffect(() => { saveObject(CAT_CONFIG_STORAGE_KEY, config()) })

  const handleConnect    = () => { setShowSettings(false); cat.connect(config()).catch(() => {}) }
  const handleFreqCommit = (hz: number) => { cat.setFrequency(hz).catch(() => {}) }
  const handleModeChange = (m: CATMode) => { cat.setMode(m).catch(() => {}) }
  const handlePTTToggle  = () => { cat.setPTT(!state().ptt).catch(() => {}) }
  const handleVolume     = (n: number) => { cat.setVolume(n).catch(() => {}) }
  const handleAtt1       = (n: number) => { cat.setAtt1(n).catch(() => {}) }
  const handleAtt2       = (n: number) => { cat.setAtt2(n).catch(() => {}) }
  const handleNR         = (n: number) => { cat.setNR(n).catch(() => {}) }
  const handleAGC        = (n: number) => { cat.setAGC(n).catch(() => {}) }
  const handleAgcLevel   = (n: number) => { cat.setAgcLevel(n).catch(() => {}) }
  const handleFilter     = (n: number) => { cat.setFilter(n).catch(() => {}) }
  const handleDrive      = (n: number) => { cat.setDrive(n).catch(() => {}) }
  const handleBacklight  = (n: number) => { cat.setBacklight(n).catch(() => {}) }
  const handleTogglePA   = () => { setShowPABias((s) => !s) }
  const handleReset      = () => { setShowPABias(false); cat.resetRadio().catch(() => {}) }
  const handleFactoryReset = () => { setShowPABias(false); cat.factoryResetRadio().catch(() => {}) }
  const handleOpenCalibration = () => { setShowPABias(false); setShowCalibration(true) }
  const handleCloseCalibration = () => { setShowCalibration(false) }
  const handleToggleBridgeStatus = () => { setShowBridgeStatus((s) => !s) }

  return (
    <div>
      {/* ── Main bar ── */}
      <div class="bg-[#0d1117] border border-[#30363d] rounded-lg px-4 py-2.5 flex items-center gap-3 flex-wrap">

        <span class="text-[10px] font-bold uppercase tracking-widest text-[#8b949e] shrink-0 select-none">
          Radio CAT
        </span>

        <Show
          when={state().connected}
          fallback={
            <>
              <button
                onClick={() => setShowSettings((s) => !s)}
                title="Configure port settings"
                class={`flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-md transition-colors border shrink-0
                  ${showSettings()
                    ? 'bg-[#21262d] border-[#388bfd] text-[#79c0ff]'
                    : 'bg-[#21262d] border-[#30363d] text-[#8b949e] hover:text-[#c9d1d9] hover:border-[#8b949e]'
                  }`}
              >
                <svg xmlns="http://www.w3.org/2000/svg" class="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor">
                  <path fill-rule="evenodd" d="M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.532 1.532 0 01-2.286.948c-1.372-.836-2.942.734-2.106 2.106.54.886.061 2.042-.947 2.287-1.561.379-1.561 2.6 0 2.978a1.532 1.532 0 01.947 2.287c-.836 1.372.734 2.942 2.106 2.106a1.532 1.532 0 012.287.947c.379 1.561 2.6 1.561 2.978 0a1.533 1.533 0 012.287-.947c1.372.836 2.942-.734 2.106-2.106a1.533 1.533 0 01.947-2.287c1.561-.379 1.561-2.6 0-2.978a1.532 1.532 0 01-.947-2.287c.836-1.372-.734-2.942-2.106-2.106a1.532 1.532 0 01-2.287-.947zM10 13a3 3 0 100-6 3 3 0 000 6z" clip-rule="evenodd" />
                </svg>
                {RADIO_PRESETS[config().presetIdx].label.split('/')[0].trim()}
              </button>
              <Show when={config().transport === 'websocket'}>
                <button
                  onClick={handleToggleBridgeStatus}
                  title="ESP32 CAT bridge status (Wi-Fi signal, restart) — independent of the CAT connection"
                  class={`w-7 h-7 flex items-center justify-center rounded border transition-colors shrink-0
                    ${showBridgeStatus()
                      ? 'bg-[#21262d] border-[#388bfd] text-[#79c0ff]'
                      : 'bg-[#21262d] border-[#30363d] text-[#8b949e] hover:text-[#c9d1d9] hover:border-[#8b949e]'
                    }`}
                >
                  <svg xmlns="http://www.w3.org/2000/svg" class="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor">
                    <path d="M10 2a5.5 5.5 0 00-5.5 5.5c0 1.7.77 3.22 1.98 4.23L10 18l3.52-6.27A5.48 5.48 0 0015.5 7.5 5.5 5.5 0 0010 2zm0 7.5a2 2 0 110-4 2 2 0 010 4z" />
                  </svg>
                </button>
              </Show>
              <button
                onClick={handleConnect}
                class="flex items-center gap-1.5 bg-[#238636] hover:bg-[#2ea043] text-white text-xs font-semibold px-3 py-1.5 rounded-md transition-colors shrink-0"
              >
                <svg xmlns="http://www.w3.org/2000/svg" class="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor">
                  <path fill-rule="evenodd" d="M12.586 4.586a2 2 0 112.828 2.828l-3 3a2 2 0 01-2.828 0 1 1 0 00-1.414 1.414 4 4 0 005.656 0l3-3a4 4 0 00-5.656-5.656l-1.5 1.5a1 1 0 101.414 1.414l1.5-1.5zm-5 5a2 2 0 012.828 0 1 1 0 101.414-1.414 4 4 0 00-5.656 0l-3 3a4 4 0 105.656 5.656l1.5-1.5a1 1 0 10-1.414-1.414l-1.5 1.5a2 2 0 11-2.828-2.828l3-3z" clip-rule="evenodd" />
                </svg>
                Connect Radio
              </button>
            </>
          }
        >
          <button
            onClick={cat.disconnect}
            class="flex items-center gap-1.5 bg-[#da3633] hover:bg-[#f85149] text-white text-xs font-semibold px-3 py-1.5 rounded-md transition-colors shrink-0"
          >
            <span class="w-2 h-2 rounded-full bg-white animate-pulse inline-block" />
            Disconnect
          </button>
          <Show when={config().transport === 'websocket'}>
            <button
              onClick={handleToggleBridgeStatus}
              title="ESP32 CAT bridge status (Wi-Fi signal, restart) — independent of the CAT connection"
              class={`w-7 h-7 flex items-center justify-center rounded border transition-colors shrink-0
                ${showBridgeStatus()
                  ? 'bg-[#21262d] border-[#388bfd] text-[#79c0ff]'
                  : 'bg-[#21262d] border-[#30363d] text-[#8b949e] hover:text-[#c9d1d9] hover:border-[#8b949e]'
                }`}
            >
              <svg xmlns="http://www.w3.org/2000/svg" class="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor">
                <path d="M10 2a5.5 5.5 0 00-5.5 5.5c0 1.7.77 3.22 1.98 4.23L10 18l3.52-6.27A5.48 5.48 0 0015.5 7.5 5.5 5.5 0 0010 2zm0 7.5a2 2 0 110-4 2 2 0 010 4z" />
              </svg>
            </button>
          </Show>
        </Show>

        <Show when={state().connected}>
          <Show when={config().rigProfile === 'usdx-blackbrick' && state().firmwareVersion !== null}>
            <div class="w-px h-6 bg-[#30363d] shrink-0" />
            {/* S-Meter — read-only, shown right after Connect/Disconnect */}
            <SMeterDisplay dbm={state().sMeter} />
          </Show>

          <div class="w-px h-6 bg-[#30363d] shrink-0" />

          {/* Frequency */}
          <FrequencyInput frequency={state().frequency} onCommit={handleFreqCommit} />

          <div class="w-px h-6 bg-[#30363d] shrink-0" />

          {/* Mode */}
          <ModeSelector mode={state().mode} onChange={handleModeChange} />

          <div class="w-px h-6 bg-[#30363d] shrink-0" />

          {/* PTT */}
          <PTTButton ptt={state().ptt} onToggle={handlePTTToggle} confirmAlarm={state().pttConfirmAlarm} />

          {/* uSDX BLACK_BRICK 4.01a extensions */}
          <Show when={config().rigProfile === 'usdx-blackbrick' && state().firmwareVersion !== null && !props.collapsed}>
            <BlackBrickControls
              volume={state().volume} att1={state().att1} att2={state().att2} nr={state().nr}
              agc={state().agc} agcLevel={state().agcLevel} filter={state().filter} drive={state().drive} backlight={state().backlight} firmwareVersion={state().firmwareVersion}
              paOpen={showPABias()}
              onVolume={handleVolume} onAtt1={handleAtt1} onAtt2={handleAtt2}
              onNR={handleNR}
              onAGC={handleAGC} onAgcLevel={handleAgcLevel} onFilter={handleFilter} onDrive={handleDrive}
              onBacklight={handleBacklight} onTogglePA={handleTogglePA}
              onReset={handleReset}
            />
          </Show>
        </Show>

        <Show when={state().error}>
          <div class="w-px h-6 bg-[#30363d] shrink-0" />
          <span class="text-[#f85149] text-xs font-mono truncate max-w-xs">{state().error}</span>
        </Show>

        <Show when={!state().isSupported && !state().connected && config().transport !== 'websocket'}>
          <span class="text-[10px] text-[#f0883e] ml-auto hidden sm:block shrink-0">
            Web Serial not supported — use Chrome/Edge, or switch to the Wi-Fi CAT bridge
          </span>
        </Show>
      </div>

      <Show when={!props.collapsed && showSettings() && !state().connected}>
        <SettingsPanel config={config()} onConfigChange={setConfig} onConnect={handleConnect} />
      </Show>

      <Show when={!props.collapsed && showBridgeStatus() && config().transport === 'websocket' && config().wsUrl}>
        <BridgeStatusPanel
          wsUrl={config().wsUrl!}
          getBridgeStatus={cat.getBridgeStatus} resetBridge={cat.resetBridge}
          getBridgeInfo={cat.getBridgeInfo}
          setBridgeBacklight={cat.setBridgeBacklight} setBridgeContrast={cat.setBridgeContrast}
          setBridgeWifiConfig={cat.setBridgeWifiConfig} setBridgeCatBaud={cat.setBridgeCatBaud}
          clearBridgePaEmergency={cat.clearBridgePaEmergency}
        />
      </Show>

      <Show when={!props.collapsed && showPABias() && state().connected && config().rigProfile === 'usdx-blackbrick'}>
        <PABiasPanel
          getPABias={cat.getPABias} setPABias={cat.setPABias}
          getFactoryDefaults={cat.getFactoryDefaults} onFactoryReset={handleFactoryReset}
          onOpenCalibration={handleOpenCalibration}
          getTxTimeout={cat.getTxTimeout} setTxTimeout={cat.setTxTimeout}
        />
      </Show>

      <Show when={!props.collapsed && showCalibration() && state().connected && config().rigProfile === 'usdx-blackbrick'}>
        <CalibrationWizard cat={cat} onClose={handleCloseCalibration} />
      </Show>
    </div>
  )
}
