// RTTY transmit panel — text composer (one-shot or live/streaming) that
// encodes and plays FSK audio, reusing the same TX-gain/output-device/
// Auto-PTT patterns as FTTransmitPanel.tsx / SSTVComposer.tsx.
import { createEffect, createMemo, createSignal, For, onCleanup, Show, type JSX } from 'solid-js'
import { createRTTYTransmit } from '../lib/rtty/useRTTYTransmit'
import { encodeBaudotChars, encodeAsciiChars, CARRIER_SHIFTS } from '../lib/rtty/encoder'
import type { RTTYConfig } from '$decoder-lib/rtty/decoder'
import { loadBoolean, saveBoolean } from '$decoder-lib/storage'
import NumberField from './NumberField'

const BAUD_RATES = [45, 45.45, 50, 65, 75, 100, 110, 150, 200, 300]

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
  /** The ESP32 bridge's CAT WebSocket URL, when one is connected. Enables
   *  the Bridge output option — the only way to transmit RTTY when the radio
   *  is reached over I/Q, since local playback goes to the computer's
   *  speakers rather than to the radio. */
  bridgeWsUrl?: string
}

const LS_LIVE = 'rtty_tx_live'

export default function RTTYTransmitPanel(props: Props): JSX.Element {
  const tx = createRTTYTransmit(() => props.onSetPTT, () => props.bridgeWsUrl)

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

  const onBridge = createMemo(() => tx.state().audioSink === 'bridge')
  const bridgeReady = createMemo(() => !!props.bridgeWsUrl)

  // Live keying cannot work through slots: a slot is a complete buffer
  // uploaded before playback starts, and per-character uploads would need a
  // WiFi round-trip inside each 165ms character period at 45.45 baud. The
  // control is disabled with the reason shown rather than silently dropped.
  const liveAvailable = createMemo(() => !onBridge())

  const handleSend = async () => {
    const text = message().trim()
    if (!text || isPlaying() || isEncoding()) return
    await tx.encodeAndTransmit(text, config())
  }

  const handleStage = async () => {
    const text = message().trim()
    // Deliberately not gated on isPlaying(): staging the next message while
    // the current one is on the air is much of the point of a slot pool.
    if (!text || staging()) return
    const ok = await tx.stageToBridge(text, config())
    // Clear the composer only on success, so a failed stage doesn't lose
    // what the operator typed.
    if (ok) setMessage('')
  }

  // Ask the device what it actually holds, so the pool shows real staged
  // content — including slots this browser never staged, and other modes'.
  // Keyed on the URL rather than done once on mount, since the CAT panel
  // usually resolves it later.
  createEffect(() => {
    if (props.bridgeWsUrl) void tx.refreshBridgeSlots()
  })

  const fmtSlotDuration = (sec: number): string => (sec > 0 ? fmtDuration(sec) : '')

  const slotsFull = createMemo(() => tx.bridgeSlots().every((s) => s.uploaded))

  // Per-slot progress, not the shared TX phase: staging the next message
  // while the current one is on the air is much of why a slot pool exists.
  const staging = createMemo(() => tx.bridgeSlots().some((s) => s.phase === 'encoding' || s.phase === 'uploading'))

  // Slot size warning. The firmware caps a slot at 5 minutes, but the real
  // constraint is PSRAM: 8MB across all four slots, at the wire rate of
  // Int16 mono @ 16kHz (32 kB/s). Much past ~2MB in one slot and several
  // messages can no longer be staged at once — which is the whole point of
  // the pool. Warn at compose time rather than failing an upload the
  // operator already committed to.
  const SLOT_WIRE_BYTES_PER_SEC = 16000 * 2
  const SLOT_SOFT_LIMIT_BYTES = 2 * 1024 * 1024
  const stagedBytes = createMemo(() => Math.round(estimatedSeconds() * SLOT_WIRE_BYTES_PER_SEC))
  const slotTooLong = createMemo(() => onBridge() && stagedBytes() > SLOT_SOFT_LIMIT_BYTES)

  // Only RTTY's own staged audio is sendable from this panel. An untagged
  // slot (staged before mode tagging, or by something else) is treated as
  // not ours — better to leave it alone than to key the radio on audio we
  // cannot describe.
  const canSend = (mode: string | null) => mode === 'RTTY'

  const phaseLabel = (phase: string): string =>
    phase === 'encoding' ? 'encoding…' : phase === 'uploading' ? 'uploading…' : phase === 'playing' ? 'transmitting' : ''

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
      {/* Output sink — bridge staging is the only way to transmit RTTY when
          the radio is reached over I/Q, since local playback would go to the
          computer's speakers instead of the radio. */}
      <Show when={bridgeReady()}>
        <div class="flex flex-wrap items-center gap-2">
          <span class="text-[10px] text-[#8b949e]">Output</span>
          <div class="flex rounded border border-[#30363d] overflow-hidden">
            <button
              onClick={() => tx.setAudioSink('speaker')}
              class={`px-2.5 py-1 text-xs transition-colors ${
                !onBridge() ? 'bg-[#238636] text-white' : 'bg-[#0d1117] text-[#8b949e] hover:text-[#c9d1d9]'
              }`}
            >
              Local speaker
            </button>
            <button
              onClick={() => tx.setAudioSink('bridge')}
              class={`px-2.5 py-1 text-xs transition-colors ${
                onBridge() ? 'bg-[#238636] text-white' : 'bg-[#0d1117] text-[#8b949e] hover:text-[#c9d1d9]'
              }`}
            >
              ESP32 Bridge
            </button>
          </div>
          <Show when={onBridge()}>
            <span class="text-[10px] text-[#484f58]">
              Type a message, stage it to a slot, then send it when you're ready.
            </span>
          </Show>
        </div>
      </Show>

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
            title={liveAvailable()
              ? 'Live: each character transmits as you type it. Off: type a full message, then press Send.'
              : 'Live keying is unavailable over the bridge: a slot holds a complete message, uploaded before playback starts. Switch output to Local speaker to key live.'}
          >
            Live
            <button
              role="switch"
              aria-checked={live() && liveAvailable()}
              disabled={!liveAvailable()}
              onClick={() => setLive(!live())}
              class={`relative inline-flex h-4 w-7 shrink-0 items-center rounded-full border transition-colors focus:outline-none disabled:cursor-not-allowed disabled:opacity-40 ${
                live() && liveAvailable() ? 'border-[#2ea043] bg-[#238636]' : 'border-[#30363d] bg-[#21262d]'
              }`}
            >
              <span class={`inline-block h-3 w-3 transform rounded-full bg-white shadow-sm transition-transform ${live() && liveAvailable() ? 'translate-x-3' : 'translate-x-0.5'}`} />
            </button>
          </label>
        </div>
        <Show when={!liveAvailable()}>
          <p class="text-[10px] text-[#8b949e]">
            Live keying is unavailable over the bridge — a slot holds a complete message, uploaded before playback
            begins. Switch output to Local speaker to key live.
          </p>
        </Show>
        <textarea
          value={message()}
          onInput={(e) => handleLiveInput(e.currentTarget.value)}
          placeholder={live() ? 'Type — characters transmit as you type…' : 'Type your message, then press Send…'}
          class="min-h-[70px] w-full resize-none rounded border border-[#30363d] bg-[#0d1117] p-2 font-mono text-sm text-[#c9d1d9] placeholder:text-[#30363d] focus:outline-none focus:border-[#2ea043]"
        />
        <Show when={slotTooLong()}>
          <p class="text-[10px] text-[#e3b341]">
            ~{(stagedBytes() / (1024 * 1024)).toFixed(1)} MB in one slot — the bridge has 8 MB of PSRAM across all
            four, so a message this long leaves little room to stage others.
          </p>
        </Show>
        <Show when={tx.state().droppedChars.length > 0}>
          <p class="text-[10px] text-[#e3b341]">
            Dropped (no {config().bitsPerChar === 5 ? 'Baudot' : 'ASCII'} representation): {tx.state().droppedChars.join(' ')}
          </p>
        </Show>
      </div>

      {/* TX controls */}
      <div class="flex flex-wrap items-end gap-3">
        <Show
          when={!onBridge()}
          fallback={
            /* Bridge: staging is a deliberate, visible step. Nothing goes on
               the air here — transmitting is a separate click on a staged
               slot below. */
            <Show
              when={!isPlaying()}
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
                  onClick={handleStage}
                  disabled={!message().trim() || staging() || slotsFull()}
                  class="rounded-md bg-[#1f6feb] px-4 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-[#388bfd] disabled:cursor-not-allowed disabled:opacity-40"
                  title={slotsFull()
                    ? 'All bridge slots are full — clear one first'
                    : 'Encode this message and upload it to a free bridge slot. It does not transmit yet.'}
                >
                  {staging() ? 'Staging…' : 'Stage to bridge'}
                </button>
                <Show when={estimatedSeconds() > 0}>
                  <span class="font-mono text-[10px] text-[#8b949e]">~{fmtDuration(estimatedSeconds())}</span>
                </Show>
              </div>
            </Show>
          }
        >
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

      {/* Bridge slot pool — what is actually staged on the device right now.
          Populated both from this session's own staging and, on mount, from
          the device itself: the firmware stores each slot's message/label
          alongside the audio, so a freshly loaded page (or a different
          browser) can describe slots it never staged — including another
          mode's, since the pool is shared. */}
      <Show when={onBridge()}>
        <div class="rounded border border-[#21262d] bg-[#0d1117] p-2">
          <div class="mb-1.5 flex items-center justify-between">
            <span class="text-[10px] font-semibold uppercase tracking-wide text-[#8b949e]">Bridge TX Slots</span>
            <Show when={slotsFull()}>
              <span class="text-[10px] text-[#e3b341]">All slots full — clear one to stage another</span>
            </Show>
          </div>
          <div class="space-y-1">
            <For each={tx.bridgeSlots()}>
              {(slot) => (
                <div class={`flex items-center gap-2 rounded border px-1.5 py-1 ${
                  slot.uploaded ? 'border-[#30363d]' : 'border-[#21262d] opacity-50'
                }`}>
                  <span class="w-3 shrink-0 font-mono text-[9px] text-[#484f58]">{slot.slot}</span>
                  <div class="min-w-0 flex-1">
                    <div class="truncate font-mono text-[10px] text-[#c9d1d9]">
                      {slot.uploaded ? (slot.description || slot.message) : '— empty —'}
                    </div>
                    <Show when={slot.uploaded}>
                      <div class="truncate text-[9px] text-[#484f58]">
                        {[slot.mode ?? 'unknown mode', fmtSlotDuration(slot.durationSec), phaseLabel(slot.phase)]
                          .filter(Boolean)
                          .join(' · ')}
                      </div>
                    </Show>
                  </div>
                  <Show when={slot.uploaded}>
                    {/* Transmitting is an explicit act on a slot already
                        proven to be on the device — and it keys PTT, exactly
                        as FT8 does. Only RTTY's own slots are sendable from
                        here: another mode's audio is not this panel's to put
                        on the air. */}
                    <button
                      onClick={() => void tx.sendStagedSlot(slot.slot)}
                      disabled={!canSend(slot.mode) || isPlaying()}
                      class="shrink-0 rounded bg-[#238636] px-2 py-0.5 text-[10px] font-semibold text-white transition-colors hover:bg-[#2ea043] disabled:cursor-not-allowed disabled:opacity-30"
                      title={canSend(slot.mode)
                        ? 'Transmit this staged message now (keys PTT)'
                        : `Staged by ${slot.mode}, not RTTY — send it from that mode's panel`}
                    >
                      {slot.phase === 'playing' ? 'Sending…' : 'Send'}
                    </button>
                    <button
                      onClick={() => void tx.clearBridgeSlot(slot.slot)}
                      disabled={slot.phase === 'playing'}
                      class="shrink-0 px-1 text-xs text-[#484f58] transition-colors hover:text-[#f85149] disabled:opacity-30"
                      title="Remove from bridge"
                    >
                      ✕
                    </button>
                  </Show>
                </div>
              )}
            </For>
          </div>
        </div>
      </Show>
    </div>
  )
}
