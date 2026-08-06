// RTTY transmit panel — text composer (one-shot or live/streaming) that
// encodes and plays FSK audio, reusing the same TX-gain/output-device/
// Auto-PTT patterns as FTTransmitPanel.tsx / SSTVComposer.tsx.
import { createEffect, createMemo, createSignal, For, onCleanup, Show, type JSX } from 'solid-js'
import { createRTTYTransmit } from '../lib/rtty/useRTTYTransmit'
import { encodeBaudotChars, encodeAsciiChars } from '../lib/rtty/encoder'
import type { RTTYConfig } from '$decoder-lib/rtty/decoder'
import { loadBoolean, saveBoolean } from '$decoder-lib/storage'
import NumberField from './NumberField'

const BAUD_RATES = [45, 45.45, 50, 65, 75, 100, 110, 150, 200, 300]
// Common amateur/commercial RTTY shifts — 170Hz is the near-universal
// amateur standard, 425/450/850 cover common commercial/military gear.
const CARRIER_SHIFTS = [170, 200, 425, 450, 850]

// TX panel intentionally does NOT seed carrier shift/baud from the active
// decoder session — 170Hz/45.45 baud (the standard amateur RTTY parameters)
// are far more likely to be what someone wants to transmit than whatever a
// decoder session happens to be tuned to for receiving a specific signal.
const DEFAULT_TX_SHIFT = 170
const DEFAULT_TX_BAUD = 45.45

export interface RTTYTxStatus {
  phase: 'idle' | 'encoding' | 'playing'
  live: boolean
}

interface Props {
  /** Seeds the panel's own carrier shift/baud/bits/parity/stop/sideband
   *  controls from the active decoder session — independent afterward, so
   *  editing one doesn't fight the other, but starts in sync. */
  seedConfig: RTTYConfig
  vfoFrequency?: number
  onSetPTT?: (tx: boolean) => Promise<void>
  onStatusChange?: (s: RTTYTxStatus) => void
}

const LS_LIVE = 'rtty_tx_live'

export default function RTTYTransmitPanel(props: Props): JSX.Element {
  const tx = createRTTYTransmit(() => props.onSetPTT)

  const [config, setConfig] = createSignal<RTTYConfig>({
    ...props.seedConfig,
    carrierShift: DEFAULT_TX_SHIFT,
    baudRate: DEFAULT_TX_BAUD,
  })
  const [message, setMessage] = createSignal('')
  const [live, setLiveState] = createSignal(loadBoolean(LS_LIVE, false))

  // Bits/parity/stop/sideband still seed from the decoder session (once);
  // carrier shift/baud keep their fixed TX defaults regardless.
  let seeded = false
  createEffect(() => {
    if (seeded) return
    seeded = true
    setConfig((prev) => ({ ...props.seedConfig, carrierShift: prev.carrierShift, baudRate: prev.baudRate }))
  })

  const patchConfig = (patch: Partial<RTTYConfig>) => setConfig((prev) => ({ ...prev, ...patch }))

  const setLive = (v: boolean) => {
    setLiveState(v)
    saveBoolean(LS_LIVE, v)
    tx.setLive(v)
    if (!v) liveBuffer = ''
  }

  createEffect(() => {
    props.onStatusChange?.({ phase: tx.state().phase, live: tx.state().live })
  })

  // Estimated TX duration — pure bit-count math (start + data + parity +
  // stop bits per char, over baud rate), no need to run the actual DSP
  // synthesis just to know how long it'll take.
  const estimatedSeconds = createMemo(() => {
    const cfg = config()
    const { codes } = cfg.bitsPerChar === 5 ? encodeBaudotChars(message()) : encodeAsciiChars(message())
    if (codes.length === 0) return 0
    const bitsPerCharTotal = 1 + cfg.bitsPerChar + (cfg.parity !== 'none' ? 1 : 0) + cfg.stopBits
    return (codes.length * bitsPerCharTotal) / cfg.baudRate
  })

  const fmtDuration = (sec: number): string => {
    if (sec < 60) return `${sec.toFixed(1)}s`
    const m = Math.floor(sec / 60)
    const s = Math.round(sec % 60)
    return `${m}m ${s}s`
  }

  const txDb = createMemo(() => {
    const g = tx.state().txGain
    return g <= 0 ? -60 : Math.round(20 * Math.log10(g))
  })
  const dbToGain = (db: number) => (db <= -60 ? 0 : Math.pow(10, db / 20))

  const isPlaying = createMemo(() => tx.state().phase === 'playing')
  const isEncoding = createMemo(() => tx.state().phase === 'encoding')

  const handleSend = async () => {
    const text = message().trim()
    if (!text || isPlaying() || isEncoding()) return
    await tx.encodeAndTransmit(text, config())
  }

  // ── Live mode: characters go out as typed, not on Send ───────────────────
  // Tracks how much of the textarea's value has already been sent so pasting,
  // backspace, or programmatic edits don't resend/desync — only genuinely
  // new characters typed at the end are transmitted.
  let liveBuffer = ''

  const handleLiveInput = async (value: string) => {
    setMessage(value)
    if (!live()) return
    if (!value.startsWith(liveBuffer)) {
      // Edited earlier text (backspace/paste mid-string) — nothing sane to
      // send for a stream protocol; just resync the tracked buffer.
      liveBuffer = value
      return
    }
    const added = value.slice(liveBuffer.length)
    liveBuffer = value
    if (!added) return
    if (tx.state().phase === 'idle') await tx.startLive()
    for (const ch of added) await tx.sendLiveChar(ch, config())
  }

  createEffect(() => {
    if (live()) return
    tx.stopLive()
  })

  onCleanup(() => tx.destroy())

  const inputCls =
    'bg-[#0d1117] border border-[#30363d] rounded px-1.5 py-1 text-[#c9d1d9] text-xs font-mono focus:outline-none focus:border-[#2ea043] transition-colors w-full'

  return (
    <div class="space-y-3">
      {/* Config grid — independent from the decoder, seeded from it on mount */}
      <div class="grid grid-cols-2 gap-x-3 gap-y-2 sm:grid-cols-4">
        <label class="flex flex-col gap-0.5">
          <span class="text-[10px] text-[#8b949e]">Carrier Shift (Hz)</span>
          <select
            value={config().carrierShift}
            onChange={(e) => patchConfig({ carrierShift: parseFloat(e.currentTarget.value) })}
            class={inputCls}
          >
            <For each={CARRIER_SHIFTS}>{(s) => <option value={s}>{s}</option>}</For>
          </select>
        </label>
        <label class="flex flex-col gap-0.5">
          <span class="text-[10px] text-[#8b949e]">Center Freq (Hz)</span>
          <NumberField value={config().centerFreq} min={0} max={3000} onCommit={(n) => patchConfig({ centerFreq: n })} class={inputCls} />
        </label>
        <label class="flex flex-col gap-0.5">
          <span class="text-[10px] text-[#8b949e]">Baud Rate</span>
          <select
            value={config().baudRate}
            onChange={(e) => patchConfig({ baudRate: parseFloat(e.currentTarget.value) })}
            class={inputCls}
          >
            <For each={BAUD_RATES}>{(b) => <option value={b}>{b}</option>}</For>
          </select>
        </label>
        <label class="flex flex-col gap-0.5">
          <span class="text-[10px] text-[#8b949e]">Bits/Char</span>
          <select
            value={config().bitsPerChar}
            onChange={(e) => patchConfig({ bitsPerChar: parseInt(e.currentTarget.value, 10) })}
            class={inputCls}
          >
            <option value={5}>5 (Baudot)</option>
            <option value={7}>7 (ASCII)</option>
            <option value={8}>8 (ASCII)</option>
          </select>
        </label>
        <label class="flex flex-col gap-0.5">
          <span class="text-[10px] text-[#8b949e]">Parity</span>
          <select
            value={config().parity}
            onChange={(e) => patchConfig({ parity: e.currentTarget.value as RTTYConfig['parity'] })}
            class={inputCls}
          >
            <option value="none">None</option>
            <option value="even">Even</option>
            <option value="odd">Odd</option>
            <option value="zero">Space (0)</option>
            <option value="one">Mark (1)</option>
          </select>
        </label>
        <label class="flex flex-col gap-0.5">
          <span class="text-[10px] text-[#8b949e]">Stop Bits</span>
          <select
            value={config().stopBits}
            onChange={(e) => patchConfig({ stopBits: parseFloat(e.currentTarget.value) })}
            class={inputCls}
          >
            <option value={1}>1</option>
            <option value={1.5}>1.5</option>
            <option value={2}>2</option>
          </select>
        </label>
        <div class="flex flex-col gap-0.5">
          <span class="text-[10px] text-[#8b949e]">Sideband</span>
          <button
            onClick={() => patchConfig({ reverseShift: !config().reverseShift })}
            class={`rounded border px-2 py-1 text-xs transition-colors ${
              config().reverseShift
                ? 'border-[#f0883e]/50 bg-[#f0883e]/10 text-[#f0883e]'
                : 'border-[#30363d] bg-[#0d1117] text-[#8b949e] hover:border-[#58a6ff]/40 hover:text-[#58a6ff]'
            }`}
          >
            {config().reverseShift ? 'LSB' : 'USB'}
          </button>
        </div>
      </div>

      {/* Message composer */}
      <div class="space-y-1.5">
        <div class="flex items-center justify-between">
          <span class="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wide text-[#8b949e]">
            Message
            <Show when={estimatedSeconds() > 0}>
              <span class="font-mono font-normal normal-case text-[#8b949e]" title="Estimated transmit time at the current baud rate/framing">
                ~{fmtDuration(estimatedSeconds())} TX
              </span>
            </Show>
          </span>
          <label
            class="flex items-center gap-1.5 text-[10px] text-[#8b949e]"
            title="Live: each character transmits as you type it. Off: type a full message, then press Send."
          >
            Live
            <button
              role="switch"
              aria-checked={live()}
              onClick={() => setLive(!live())}
              class={`relative inline-flex h-4 w-7 shrink-0 items-center rounded-full border transition-colors focus:outline-none ${
                live() ? 'border-[#2ea043] bg-[#238636]' : 'border-[#30363d] bg-[#21262d]'
              }`}
            >
              <span class={`inline-block h-3 w-3 transform rounded-full bg-white shadow-sm transition-transform ${live() ? 'translate-x-3' : 'translate-x-0.5'}`} />
            </button>
          </label>
        </div>
        <textarea
          value={message()}
          onInput={(e) => handleLiveInput(e.currentTarget.value)}
          placeholder={live() ? 'Type — characters transmit as you type…' : 'Type your message, then press Send…'}
          class="min-h-[70px] w-full resize-none rounded border border-[#30363d] bg-[#0d1117] p-2 font-mono text-sm text-[#c9d1d9] placeholder:text-[#30363d] focus:outline-none focus:border-[#2ea043]"
        />
        <Show when={tx.state().droppedChars.length > 0}>
          <p class="text-[10px] text-[#e3b341]">
            Dropped (no {config().bitsPerChar === 5 ? 'Baudot' : 'ASCII'} representation): {tx.state().droppedChars.join(' ')}
          </p>
        </Show>
      </div>

      {/* TX controls */}
      <div class="flex flex-wrap items-end gap-3">
        <Show
          when={!live()}
          fallback={
            <Show when={isPlaying()} fallback={<span class="text-xs text-[#8b949e]">Live mode — start typing to transmit</span>}>
              <button
                onClick={() => tx.stopLive()}
                class="rounded-md bg-[#da3633] px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-[#f85149]"
              >
                Stop
              </button>
            </Show>
          }
        >
          <Show
            when={!isPlaying() && !isEncoding()}
            fallback={
              <button
                onClick={() => tx.stop()}
                class="rounded-md bg-[#da3633] px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-[#f85149]"
              >
                Stop
              </button>
            }
          >
            <div class="flex items-center gap-2">
              <button
                onClick={handleSend}
                disabled={!message().trim()}
                class="rounded-md bg-[#238636] px-4 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-[#2ea043] disabled:cursor-not-allowed disabled:opacity-40"
              >
                Send
              </button>
              <Show when={estimatedSeconds() > 0}>
                <span class="font-mono text-[10px] text-[#8b949e]">~{fmtDuration(estimatedSeconds())}</span>
              </Show>
            </div>
          </Show>
        </Show>

        <div class="flex flex-col gap-1">
          <label class="text-[10px] text-[#8b949e]">
            TX Level <span class="ml-1 font-mono text-[#c9d1d9]">{txDb() === 0 ? '0 dB' : `${txDb()} dB`}</span>
          </label>
          <input
            type="range"
            min={-60}
            max={0}
            step={1}
            value={txDb()}
            onInput={(e) => tx.setTxGain(dbToGain(Number(e.currentTarget.value)))}
            class="w-28 accent-[#2ea043] cursor-pointer"
          />
        </div>

        <label
          class="flex items-center gap-1.5 text-[10px] text-[#8b949e]"
          title={props.onSetPTT ? 'Automatically key radio PTT via CAT while transmitting' : 'Auto-PTT requires CAT connection'}
        >
          Auto-PTT
          <button
            role="switch"
            aria-checked={tx.state().autoPTT}
            disabled={!props.onSetPTT}
            onClick={() => tx.setAutoPTT(!tx.state().autoPTT)}
            class={`relative inline-flex h-4 w-7 shrink-0 items-center rounded-full border transition-colors focus:outline-none disabled:cursor-not-allowed disabled:opacity-40 ${
              tx.state().autoPTT ? 'border-[#2ea043] bg-[#238636]' : 'border-[#30363d] bg-[#21262d]'
            }`}
          >
            <span class={`inline-block h-3 w-3 transform rounded-full bg-white shadow-sm transition-transform ${tx.state().autoPTT ? 'translate-x-3' : 'translate-x-0.5'}`} />
          </button>
        </label>

        <Show when={tx.state().error}>
          <span class="text-xs text-[#f85149]">{tx.state().error}</span>
        </Show>
      </div>
    </div>
  )
}
