// Port of src/app/page.tsx (Next.js app) — the top-level shell wiring all 5
// decoder modes, the RadioCAT panel (lifted here so VFO frequency flows to
// every decoder), the FT transmit panel, and the memory/resource debug bar.
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show, type JSX } from 'solid-js'
import RTTYDecoder from './components/RTTYDecoder'
import RTTYTransmitPanel, { type RTTYTxStatus } from './components/RTTYTransmitPanel'
import SSTVDecoder from './components/SSTVDecoder'
import SSTVComposer, { type SSTVTxStatus } from './components/SSTVComposer'
import CWDecoder from './components/CWDecoder'
import FTDecoder, { FTModeSelector } from './components/FTDecoder'
import MFSKDecoder from './components/MFSKDecoder'
import FTTransmitPanel, { type TxStatus } from './components/FTTransmitPanel'
import type { RTTYConfig } from '$decoder-lib/rtty/decoder'
import RadioCATPanel, { useRadioCAT } from './components/RadioCATPanel'
import { useAudioBridge } from './lib/cat/useAudioBridge'
import { useIQBridge } from './lib/cat/useIQBridge'
import { loadSuspendIQDuringTx } from './lib/ft/useFTTransmit'
import PWAInstallPrompt from './components/PWAInstallPrompt'
import UpdateAvailablePrompt from './components/UpdateAvailablePrompt'
import { globalAudio } from './lib/audio/globalAudio'
import type { DecoderControls } from './lib/decoderControls'
import { type FTDecoderStats, type FTDecoderStatus, type FTMode, subscribeDecoderStats, subscribeDecoderStatus } from '$decoder-lib/ft/decoder'
import type { Contact } from '$decoder-lib/ft/parser'
import { audioRecorder, REC_DURATION_CHOICES_SEC } from '$decoder-lib/audio/ringRecorder'
import type { CapturedImage } from '$decoder-lib/sstv/audioProcessor'
import { trackEvent } from '$decoder-lib/analytics'
import { loadObject, saveObject, loadString, saveString } from '$decoder-lib/storage'
import { type AudioSourceOverride, resolveAudioSource } from '$decoder-lib/audio/audioSource'

type DecoderMode = 'rtty' | 'sstv' | 'cw' | 'ft' | 'mfsk'

// ── Mode selection persistence — restores the decoder tab and FT sub-mode
// across page reloads/sessions. ──────────────────────────────────────────────
const LS_MODE = 'decoder_mode'
const LS_FT_MODE = 'ft_mode'
const VALID_MODES: DecoderMode[] = ['rtty', 'sstv', 'cw', 'ft', 'mfsk']

function loadMode(): DecoderMode {
  const stored = localStorage.getItem(LS_MODE)
  return VALID_MODES.includes(stored as DecoderMode) ? (stored as DecoderMode) : 'rtty'
}
function saveMode(v: DecoderMode) {
  localStorage.setItem(LS_MODE, v)
}
const VALID_FT_MODES: FTMode[] = ['FT8', 'FT4', 'FT2']
function loadFTMode(): FTMode {
  const stored = localStorage.getItem(LS_FT_MODE)
  return (VALID_FT_MODES as readonly string[]).includes(stored ?? '') ? (stored as FTMode) : 'FT8'
}
function saveFTMode(v: FTMode) {
  localStorage.setItem(LS_FT_MODE, v)
}

// ── Audio source override — force mic/bridge instead of always auto-
// detecting. 'auto' preserves every decoder's original precedence (see
// resolveAudioSource() in audioSource.ts); the two bridge-specific values
// are the operator's own explicit choice and deliberately don't get
// second-guessed against the bridge's actual live firmware mode — see
// AudioSourceOverride's own comment. ──────────────────────────────────────
const LS_AUDIO_SOURCE_OVERRIDE = 'audio_source_override'
const VALID_AUDIO_SOURCE_OVERRIDES: AudioSourceOverride[] = ['auto', 'microphone', 'bridge-audio', 'bridge-iq']
function loadAudioSourceOverride(): AudioSourceOverride {
  return loadString(LS_AUDIO_SOURCE_OVERRIDE, 'auto', VALID_AUDIO_SOURCE_OVERRIDES)
}

// ── I/Q passband width, per decoder mode ─────────────────────────────────
// useIQBridge.ts's SSBDemodulator holds exactly ONE passband (centerHz/
// bandwidthHz), shared across whichever decoder mode is currently active
// — a real gap this surfaced: its own default (2700Hz, a generic
// voice-SSB width) left FT8 missing roughly the top third of its actual
// signal band (confirmed directly: FT8 stations spread across close to
// the full 0-3000Hz audio passband, but a 2700Hz-wide passband centered
// at 1370Hz only reaches ~2720Hz, and the demodulator's own lowpass
// transition band erodes a few hundred Hz more before that — matching a
// real report of visible signal energy cut off around 2-2.3kHz). Modes
// genuinely differ in how wide a band they need (FT8/MFSK spread many
// simultaneous signals across most of the audio band; CW is one narrow
// tone; RTTY sits in a modest, well-known range — see RTTYDecoder.tsx's
// own DISPLAY_MAX_HZ=1500 convention), so this remembers each mode's own
// last-used {centerHz, bandwidthHz} and re-applies it via
// iqBridge.setPassband() on every mode switch (see handleModeChange())
// instead of leaving every mode fighting over one shared setting.
const LS_IQ_PASSBAND_BY_MODE = 'iq_passband_by_mode'
interface IQPassbandSetting { centerHz: number; bandwidthHz: number }
const IQ_PASSBAND_DEFAULTS: Record<DecoderMode, IQPassbandSetting> = {
  ft: { centerHz: 1500, bandwidthHz: 3000 }, // FT8/FT4/FT2: many simultaneous stations across ~0-3000Hz
  mfsk: { centerHz: 1500, bandwidthHz: 3000 }, // same reasoning — multi-tone signals can spread across the band (see MFSKDecoder.tsx's own 3000Hz references)
  sstv: { centerHz: 1500, bandwidthHz: 2700 }, // voice-bandwidth-ish audio
  rtty: { centerHz: 1000, bandwidthHz: 1200 }, // covers RTTYDecoder.tsx's own DISPLAY_MAX_HZ=1500 range with margin
  cw: { centerHz: 700, bandwidthHz: 500 }, // one narrow tone
}
function loadPassbandByMode(): Record<DecoderMode, IQPassbandSetting> {
  return loadObject(LS_IQ_PASSBAND_BY_MODE, IQ_PASSBAND_DEFAULTS)
}
function savePassbandForMode(all: Record<DecoderMode, IQPassbandSetting>, mode: DecoderMode, setting: IQPassbandSetting) {
  const next = { ...all, [mode]: setting }
  saveObject(LS_IQ_PASSBAND_BY_MODE, next)
  return next
}

const MODE_META: Record<DecoderMode, { label: string; description: string }> = {
  rtty: { label: 'RTTY', description: 'Real-time Radioteletype signal decoder from microphone' },
  sstv: { label: 'SSTV', description: 'Slow Scan Television image decoder — Robot, Scottie, PD modes' },
  cw: { label: 'CW', description: 'Continuous Wave (Morse code) decoder — adaptive speed, real-time text output' },
  ft: { label: 'FT8/4', description: 'FT8 & FT4 weak-signal decoder — UTC clock-synchronized, structured QSO messages' },
  mfsk: { label: 'MFSK', description: 'Multiple Frequency Shift Keying decoder — configurable tones, live bit-stream grid' },
}

// ── Memory / resource debug bar ────────────────────────────────────────────

function MemDebugBar(props: { contacts: Map<string, Contact> }) {
  const [snap, setSnap] = createSignal<{ heapMB: number | null; heapLimitMB: number | null; contacts: number; totalMsgs: number; domNodes: number } | null>(null)
  const [wasmStats, setWasmStats] = createSignal<FTDecoderStats | null>(null)
  const [wasmStatus, setWasmStatus] = createSignal<FTDecoderStatus | null>(null)

  onMount(() => {
    const unsubStats = subscribeDecoderStats(setWasmStats)
    const unsubStatus = subscribeDecoderStatus(setWasmStatus)
    onCleanup(() => {
      unsubStats()
      unsubStatus()
    })
  })

  onMount(() => {
    const update = () => {
      const mem = (performance as unknown as { memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number } }).memory
      let totalMsgs = 0
      for (const c of props.contacts.values()) totalMsgs += c.msgs.length
      setSnap({
        heapMB: mem ? Math.round(mem.usedJSHeapSize / 1024 / 1024) : null,
        heapLimitMB: mem ? Math.round(mem.jsHeapSizeLimit / 1024 / 1024) : null,
        contacts: props.contacts.size,
        totalMsgs,
        domNodes: document.querySelectorAll('*').length,
      })
    }
    update()
    const id = setInterval(update, 2000)
    onCleanup(() => clearInterval(id))
  })
  createEffect(() => {
    void props.contacts // re-run the interval's next tick sees fresh contacts automatically; this just tracks the dependency for immediate feedback
  })

  const heapPct = createMemo(() => {
    const s = snap()
    return s && s.heapMB !== null && s.heapLimitMB ? Math.round((s.heapMB / s.heapLimitMB) * 100) : null
  })
  const heapColor = createMemo(() => {
    const pct = heapPct()
    return pct === null ? '#484f58' : pct > 75 ? '#f85149' : pct > 50 ? '#e3b341' : '#2ea043'
  })

  return (
    <Show when={snap()}>
      <div class="shrink-0 border-t border-[#21262d] bg-[#0d1117]/80 px-4 py-1 sm:px-6 lg:px-8">
        <div class="flex flex-wrap items-center gap-x-4 gap-y-0.5 font-mono text-[10px] text-[#484f58]">
          <span class="text-[#30363d] select-none">⬡ mem</span>
          <Show
            when={snap()!.heapMB !== null}
            fallback={<span title="Chrome only — enable chrome://flags/#enable-precise-memory-info for accuracy">heap n/a</span>}
          >
            <span style={{ color: heapColor() }}>
              heap {snap()!.heapMB} MB{heapPct() !== null ? ` (${heapPct()}%)` : ''}
            </span>
          </Show>
          <span>
            contacts <span class="text-[#8b949e]">{snap()!.contacts}</span>
          </span>
          <span>
            msgs <span class="text-[#8b949e]">{snap()!.totalMsgs}</span>
          </span>
          <span>
            DOM <span class="text-[#8b949e]">{snap()!.domNodes}</span>
          </span>
          <Show when={wasmStatus() && wasmStatus()!.generation > 0}>
            <span class="text-[#30363d] select-none">· ⬡ wasm</span>
            <span title="active decode engine">{wasmStats()?.engine ?? (wasmStatus()!.engines.length ? wasmStatus()!.engines.join('+') : 'loading…')}</span>
            <Show when={wasmStats()}>
              <span title="WASM memory: live allocations / reserved linear memory">
                heap{' '}
                <span class="text-[#8b949e]">
                  {(wasmStats()!.heapUsedBytes / 1024 / 1024).toFixed(1)}/{Math.round(wasmStats()!.heapBytes / 1024 / 1024)} MB
                </span>
              </span>
              <span title="last decode time inside the worker">
                dec <span class="text-[#8b949e]">{(wasmStats()!.decodeMs / 1000).toFixed(1)}s</span>
              </span>
            </Show>
            <Show when={wasmStatus()!.generation > 1}>
              <span title="worker respawn count">
                gen <span class="text-[#8b949e]">{wasmStatus()!.generation}</span>
              </span>
            </Show>
          </Show>
          <span class="ml-auto flex items-center gap-2">
            <span title="app version">v{__APP_VERSION__}</span>
            <a href="https://github.com/acesso/Signal-Decoder" target="_blank" rel="noopener noreferrer" class="text-[#8b949e] transition-colors hover:text-[#58a6ff]" title="source code on GitHub">
              GitHub ↗
            </a>
          </span>
        </div>
      </div>
    </Show>
  )
}

// ── Shared top bar ──────────────────────────────────────────────────────────

function recDurationLabel(sec: number): string {
  return sec < 60 ? `${sec} s` : `${sec / 60} min`
}

// 'iq' is its own distinct value (not folded into 'bridge') so this line can
// say "ESP32 Bridge (I/Q, demodulated)" rather than leaving the operator to
// infer that from the Bridge status panel's input-mode toggle, which no
// longer shows any signal info of its own — see RadioCATPanel.tsx's
// BridgeInputModeControl/BridgeAudioControl (now controls-only).
type AudioSourceDisplay = 'microphone' | 'bridge' | 'bridge-iq'

function TopBar(props: {
  controls: DecoderControls | null
  mode: DecoderMode
  ftMode: FTMode
  onFTModeChange: (m: FTMode) => void
  audioSource: AudioSourceDisplay | null
  audioSourceOverride: AudioSourceOverride
  onAudioSourceOverrideChange: (v: AudioSourceOverride) => void
  // True while the bridge audio source currently feeding decode (whichever
  // of iqBridge/audioBridge audioSource above reflects) has dropped and is
  // retrying automatically — see useIQBridge.ts's/useAudioBridge.ts's
  // reconnecting field. Shown next to Start Decoding/Stop so "why did
  // decoding just go quiet" has an answer without opening the Bridge panel.
  bridgeReconnecting: boolean
}): JSX.Element {
  const isRecording = () => props.controls?.isRecording ?? false
  const isSupported = () => props.controls?.isSupported ?? true
  const error = () => props.controls?.error ?? null

  // Audio ring buffer (global Rec) — poll fill state once per second; the
  // interval only causes re-renders while the buffered amount is changing.
  const [recStatus, setRecStatus] = createSignal(audioRecorder.status())
  const [showGlobals, setShowGlobals] = createSignal(false)
  onMount(() => {
    const tick = () =>
      setRecStatus((prev) => {
        const s = audioRecorder.status()
        return prev.inputSec === s.inputSec && prev.outputSec === s.outputSec && prev.durationSec === s.durationSec ? prev : s
      })
    tick()
    const t = setInterval(tick, 1000)
    onCleanup(() => clearInterval(t))
  })
  const recHasAudio = createMemo(() => recStatus().inputSec > 0 || recStatus().outputSec > 0)

  return (
    <div class="shrink-0 rounded-lg border border-[#30363d] bg-[#161b22] px-4 py-3">
      <div class="flex flex-wrap items-center gap-3">
        <Show
          when={!isRecording()}
          fallback={
            <button onClick={() => props.controls?.stop()} class="flex items-center gap-2 rounded-md bg-[#da3633] px-5 py-2 text-sm font-semibold text-white transition-colors hover:bg-[#f85149]">
              <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                <path
                  fill-rule="evenodd"
                  d="M10 18a8 8 0 100-16 8 8 0 000 16zM8 7a1 1 0 00-1 1v4a1 1 0 001 1h4a1 1 0 001-1V8a1 1 0 00-1-1H8z"
                  clip-rule="evenodd"
                />
              </svg>
              Stop
            </button>
          }
        >
          <button
            onClick={() => props.controls?.start()}
            disabled={!isSupported() || !props.controls}
            class="flex items-center gap-2 rounded-md bg-[#238636] px-5 py-2 text-sm font-semibold text-white transition-colors hover:bg-[#2ea043] disabled:cursor-not-allowed disabled:opacity-50"
          >
            <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
              <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM9.555 7.168A1 1 0 008 8v4a1 1 0 001.555.832l3-2a1 1 0 000-1.664l-3-2z" clip-rule="evenodd" />
            </svg>
            Start Decoding
          </button>
        </Show>

        <Show when={props.bridgeReconnecting}>
          <span
            class="flex items-center gap-1.5 text-xs font-semibold text-[#d29922]"
            title="The bridge's audio/I-Q connection dropped (Wi-Fi hiccup or bridge reboot) — retrying automatically"
          >
            <svg xmlns="http://www.w3.org/2000/svg" class="h-3.5 w-3.5 animate-spin" viewBox="0 0 20 20" fill="currentColor">
              <path fill-rule="evenodd" d="M4 2a1 1 0 011 1v2.101a7.002 7.002 0 0111.601 2.566 1 1 0 11-1.885.666A5.002 5.002 0 005.999 7H9a1 1 0 010 2H4a1 1 0 01-1-1V3a1 1 0 011-1zm.008 9.057a1 1 0 011.276.61A5.002 5.002 0 0014.001 13H11a1 1 0 110-2h5a1 1 0 011 1v5a1 1 0 11-2 0v-2.101a7.002 7.002 0 01-11.601-2.566 1 1 0 01.61-1.276z" clip-rule="evenodd" />
            </svg>
            Reconnecting to bridge…
          </span>
        </Show>

        <button
          onClick={() => props.controls?.reset()}
          disabled={!props.controls}
          class="flex items-center gap-1.5 rounded-md border border-[#30363d] bg-[#21262d] px-4 py-2 text-sm font-semibold text-[#c9d1d9] transition-colors hover:bg-[#30363d] disabled:cursor-not-allowed disabled:opacity-40"
        >
          <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
            <path
              fill-rule="evenodd"
              d="M4 2a1 1 0 011 1v2.101a7.002 7.002 0 0111.601 2.566 1 1 0 11-1.885.666A5.002 5.002 0 005.999 7H9a1 1 0 010 2H4a1 1 0 01-1-1V3a1 1 0 011-1zm.008 9.057a1 1 0 011.276.61A5.002 5.002 0 0014.001 13H11a1 1 0 110-2h5a1 1 0 011 1v5a1 1 0 11-2 0v-2.101a7.002 7.002 0 01-11.601-2.566 1 1 0 01.61-1.276z"
              clip-rule="evenodd"
            />
          </svg>
          Reset
        </button>

        {/* Retroactive audio capture: the ring buffer always holds the last
            N of input/TX audio while running; Rec downloads it as WAV. */}
        <button
          onClick={() => audioRecorder.saveAll()}
          disabled={!recHasAudio()}
          title={
            recHasAudio()
              ? `Download the last ${recDurationLabel(recStatus().durationSec)} of audio as WAV (input ${recStatus().inputSec}s buffered${recStatus().outputSec > 0 ? `, TX out ${recStatus().outputSec}s` : ''})`
              : 'Nothing buffered yet — audio is captured while decoding runs'
          }
          class="flex items-center gap-1.5 rounded-md border border-[#30363d] bg-[#21262d] px-4 py-2 text-sm font-semibold text-[#c9d1d9] transition-colors hover:bg-[#30363d] disabled:cursor-not-allowed disabled:opacity-40"
        >
          <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
            <circle cx="10" cy="10" r="6" fill={isRecording() ? '#f85149' : 'currentColor'} />
          </svg>
          Rec
        </button>

        <button
          onClick={() => setShowGlobals((v) => !v)}
          title="Global settings"
          aria-expanded={showGlobals()}
          class={`flex items-center rounded-md border bg-[#21262d] px-3 py-2 text-sm font-semibold text-[#c9d1d9] transition-colors hover:bg-[#30363d] ${showGlobals() ? 'border-[#58a6ff]' : 'border-[#30363d]'}`}
        >
          <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
            <path
              fill-rule="evenodd"
              d="M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.532 1.532 0 01-2.286.948c-1.372-.836-2.942.734-2.106 2.106.54.886.061 2.042-.947 2.287-1.561.379-1.561 2.6 0 2.978a1.532 1.532 0 01.947 2.287c-.836 1.372.734 2.942 2.106 2.106a1.532 1.532 0 012.287.947c.379 1.561 2.6 1.561 2.978 0a1.533 1.533 0 012.287-.947c1.372.836 2.942-.734 2.106-2.106a1.533 1.533 0 01.947-2.287c1.561-.379 1.561-2.6 0-2.978a1.532 1.532 0 01-.947-2.287c.836-1.372-.734-2.942-2.106-2.106a1.532 1.532 0 01-2.287-.947zM10 13a3 3 0 100-6 3 3 0 000 6z"
              clip-rule="evenodd"
            />
          </svg>
        </button>

        {/* FT sub-mode selector — inline in the bar when FT is active */}
        <Show when={props.mode === 'ft'}>
          <div class="ml-2 border-l border-[#30363d] pl-3">
            <FTModeSelector mode={props.ftMode} onChange={props.onFTModeChange} />
          </div>
        </Show>

        <div class="ml-auto flex items-center gap-1.5 text-[10px] text-[#8b949e] whitespace-nowrap">
          <span class="shrink-0">Audio source</span>
          <select
            value={props.audioSourceOverride}
            onChange={(e) => props.onAudioSourceOverrideChange(e.currentTarget.value as AudioSourceOverride)}
            title="Force which source decoders read from — Auto keeps the existing bridge/microphone auto-detection. Forcing a bridge choice reads from that socket only if it's actually connected right now; it does not switch the bridge's own firmware mode."
            class="cursor-pointer rounded border border-[#30363d] bg-[#0d1117] px-1.5 py-0.5 font-mono text-[#c9d1d9] focus:border-[#2ea043] focus:outline-none"
          >
            <option value="auto">Auto</option>
            <option value="microphone">Microphone</option>
            <option value="bridge-audio">Bridge (radio audio)</option>
            <option value="bridge-iq">Bridge (I/Q)</option>
          </select>
          <Show when={isRecording() && props.audioSource}>
            <span class="text-[#c9d1d9] font-semibold">
              {props.audioSource === 'bridge-iq'
                ? '— ESP32 Bridge (I/Q, demodulated)'
                : props.audioSource === 'bridge'
                  ? '— ESP32 Bridge (radio audio)'
                  : '— Local microphone'}
            </span>
          </Show>
        </div>

        <Show when={error()}>
          <span class="font-mono text-xs text-[#f85149]">{error()}</span>
        </Show>
      </div>

      <Show when={showGlobals()}>
        <div class="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-[#30363d] pt-3 text-xs text-[#8b949e]">
          <span class="font-semibold text-[#c9d1d9]">Audio ring buffer</span>
          <label class="flex items-center gap-1.5">
            keep last
            <select
              value={recStatus().durationSec}
              onChange={(e) => {
                audioRecorder.setDurationSec(Number(e.currentTarget.value))
                setRecStatus(audioRecorder.status())
              }}
              class="rounded border border-[#30363d] bg-[#0d1117] px-2 py-1 text-[#c9d1d9]"
            >
              <For each={REC_DURATION_CHOICES_SEC}>{(sec) => <option value={sec}>{recDurationLabel(sec)}</option>}</For>
            </select>
          </label>
          <span class="font-mono">
            buffered: input {recStatus().inputSec}s · TX out {recStatus().outputSec}s
          </span>
          <button
            onClick={() => {
              audioRecorder.clear()
              setRecStatus(audioRecorder.status())
            }}
            disabled={!recHasAudio()}
            class="rounded border border-[#30363d] bg-[#21262d] px-2.5 py-1 text-[#c9d1d9] transition-colors hover:bg-[#30363d] disabled:cursor-not-allowed disabled:opacity-40"
          >
            Clear
          </button>
          <span class="italic">Rec saves each stream as its own mono 16-bit WAV — capture runs whenever decoding is on.</span>
        </div>
      </Show>
    </div>
  )
}

// ── TX collapsed summary chips ───────────────────────────────────────────────

const TX_STATUS_COLOR: Record<string, string> = { idle: '#484f58', waiting: '#e3b341', encoding: '#58a6ff', playing: '#2ea043' }
const TX_STATUS_LABEL: Record<string, string> = { idle: 'IDLE', waiting: 'WAIT', encoding: 'ENC', playing: 'TX' }

// Miniature rAF-driven progress ring — pure SVG DOM mutations, no re-renders
function TxRingMini(props: { status: string; windowSec: number; playing: boolean }): JSX.Element {
  let svgEl: SVGSVGElement | undefined
  let rafId: number | null = null
  let prevSecVal = ''
  const r = 28,
    cx = 36,
    cy = 36
  const circ = 2 * Math.PI * r

  onMount(() => {
    const tick = () => {
      const svg = svgEl
      if (!svg) {
        rafId = requestAnimationFrame(tick)
        return
      }
      const totalMs = props.windowSec * 1000
      const now = new Date()
      const elapsed = (now.getSeconds() * 1000 + now.getMilliseconds()) % totalMs
      const progress = elapsed / totalMs
      const secVal = ((totalMs - elapsed) / 1000).toFixed(1)
      if (secVal === prevSecVal) {
        rafId = requestAnimationFrame(tick)
        return
      }
      prevSecVal = secVal
      const color = TX_STATUS_COLOR[props.status] ?? '#484f58'
      const filled = circ * progress
      svg.querySelector<SVGCircleElement>('.mring-arc')?.setAttribute('stroke', color)
      svg.querySelector<SVGCircleElement>('.mring-arc')?.setAttribute('stroke-dasharray', `${filled} ${circ - filled}`)
      rafId = requestAnimationFrame(tick)
    }
    rafId = requestAnimationFrame(tick)
    onCleanup(() => {
      if (rafId) cancelAnimationFrame(rafId)
    })
  })

  const initColor = TX_STATUS_COLOR[props.status] ?? '#484f58'
  return (
    <svg ref={svgEl} width={28} height={28} viewBox="0 0 72 72" class="shrink-0">
      <Show when={props.playing}>
        <circle cx={cx} cy={cy} r={r + 6} fill="none" stroke="#2ea043" stroke-width="3" opacity={0.35} class="animate-ping" style={{ 'animation-duration': '1s' }} />
      </Show>
      <circle cx={cx} cy={cy} r={r} fill="none" stroke="#21262d" stroke-width="7" />
      <circle class="mring-arc" cx={cx} cy={cy} r={r} fill="none" stroke={initColor} stroke-width="7" stroke-dasharray={`0 ${circ}`} stroke-dashoffset={circ * 0.25} />
    </svg>
  )
}

function TxSummaryChips(props: { s: TxStatus | null }): JSX.Element {
  return (
    <Show when={props.s}>
      <span class="tx-summary-chips ml-3 inline-flex items-center gap-2 align-middle" style={{ 'line-height': '1' }}>
        <TxRingMini status={props.s!.isRunning ? props.s!.status : 'idle'} windowSec={props.s!.windowSec} playing={props.s!.status === 'playing'} />
        <span class="font-mono text-[10px] font-bold" style={{ color: props.s!.isRunning ? (TX_STATUS_COLOR[props.s!.status] ?? '#484f58') : '#484f58' }}>
          {TX_STATUS_LABEL[props.s!.status] ?? props.s!.status.toUpperCase()}
        </span>
        <span
          class="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[10px]"
          style={{
            'border-color': props.s!.queueLen > 0 ? 'rgba(88,166,255,0.4)' : '#30363d',
            color: props.s!.queueLen > 0 ? '#58a6ff' : '#484f58',
            background: props.s!.queueLen > 0 ? 'rgba(88,166,255,0.08)' : 'transparent',
          }}
        >
          <span style={{ color: props.s!.queueLen > 0 ? '#8b949e' : '#30363d' }}>Queue</span>
          <span class="font-bold">{props.s!.queueLen}</span>
        </span>
        <span
          class="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[10px]"
          style={{
            'border-color': props.s!.pendingReplies > 0 ? 'rgba(227,179,65,0.4)' : '#30363d',
            color: props.s!.pendingReplies > 0 ? '#e3b341' : '#484f58',
            background: props.s!.pendingReplies > 0 ? 'rgba(227,179,65,0.08)' : 'transparent',
          }}
        >
          <span style={{ color: props.s!.pendingReplies > 0 ? '#8b949e' : '#30363d' }}>Replies</span>
          <span class="font-bold">{props.s!.pendingReplies}</span>
        </span>
        <Show when={props.s!.autoReply}>
          <span class="rounded border px-1.5 py-0.5 font-mono text-[10px]" style={{ color: '#58a6ff', 'border-color': 'rgba(88,166,255,0.3)', background: 'rgba(88,166,255,0.08)' }}>
            auto
          </span>
        </Show>
        <span class="inline-flex items-center gap-1">
          <span
            class="rounded px-1 py-0.5 font-mono text-[9px] font-bold"
            style={{ color: props.s!.autoCQ ? '#3fb950' : '#484f58', background: props.s!.autoCQ ? 'rgba(46,160,67,0.12)' : 'transparent' }}
            title={`Auto-CQ · every ${props.s!.autoCQIntervalMin} min`}
          >
            CQ {props.s!.autoCQIntervalMin}m
          </span>
          <span
            class="rounded px-1 py-0.5 font-mono text-[9px] font-bold"
            style={{ color: props.s!.autoPTT ? '#e3b341' : '#484f58', background: props.s!.autoPTT ? 'rgba(227,179,65,0.12)' : 'transparent' }}
            title="Auto-PTT"
          >
            PTT
          </span>
          <span
            class="rounded px-1 py-0.5 font-mono text-[9px] font-bold"
            style={{ color: props.s!.allowConsecutiveTx ? '#f85149' : '#484f58', background: props.s!.allowConsecutiveTx ? 'rgba(248,81,73,0.12)' : 'transparent' }}
            title="Consecutive TX"
          >
            TX×N
          </span>
        </span>
      </span>
    </Show>
  )
}

// ── SSTV TX collapsed summary chip ──────────────────────────────────────────
// Simpler than the FT ring (no fixed UTC window to animate against — SSTV
// transmits are one-shot, variable-length), just a pulsing dot + phase label
// + live percentage/remaining time, shown only while the panel is collapsed.

const SSTV_TX_STATUS_COLOR: Record<SSTVTxStatus['phase'], string> = { idle: '#484f58', encoding: '#58a6ff', playing: '#2ea043' }
const SSTV_TX_STATUS_LABEL: Record<SSTVTxStatus['phase'], string> = { idle: 'IDLE', encoding: 'ENC', playing: 'TX' }

function SSTVTxSummaryChip(props: { s: SSTVTxStatus | null }): JSX.Element {
  return (
    <Show when={props.s && props.s.phase !== 'idle'}>
      <span class="sstv-tx-summary-chip ml-3 inline-flex items-center gap-1.5 align-middle font-mono text-[10px] font-bold" style={{ 'line-height': '1' }}>
        <span
          class={`inline-block h-2 w-2 shrink-0 rounded-full ${props.s!.phase === 'playing' ? 'animate-pulse' : ''}`}
          style={{ background: SSTV_TX_STATUS_COLOR[props.s!.phase] }}
        />
        <span style={{ color: SSTV_TX_STATUS_COLOR[props.s!.phase] }}>{SSTV_TX_STATUS_LABEL[props.s!.phase]}</span>
        <Show when={props.s!.phase === 'playing'}>
          <span class="text-[#8b949e]">{props.s!.remainingSec}s left</span>
        </Show>
      </span>
    </Show>
  )
}

const RTTY_TX_STATUS_COLOR: Record<RTTYTxStatus['phase'], string> = { idle: '#484f58', encoding: '#58a6ff', playing: '#2ea043' }
const RTTY_TX_STATUS_LABEL: Record<RTTYTxStatus['phase'], string> = { idle: 'IDLE', encoding: 'ENC', playing: 'TX' }

function RTTYTxSummaryChip(props: { s: RTTYTxStatus | null }): JSX.Element {
  return (
    <Show when={props.s && props.s.phase !== 'idle'}>
      <span class="rtty-tx-summary-chip ml-3 inline-flex items-center gap-1.5 align-middle font-mono text-[10px] font-bold" style={{ 'line-height': '1' }}>
        <span
          class={`inline-block h-2 w-2 shrink-0 rounded-full ${props.s!.phase === 'playing' ? 'animate-pulse' : ''}`}
          style={{ background: RTTY_TX_STATUS_COLOR[props.s!.phase] }}
        />
        <span style={{ color: RTTY_TX_STATUS_COLOR[props.s!.phase] }}>
          {props.s!.live ? 'LIVE' : RTTY_TX_STATUS_LABEL[props.s!.phase]}
        </span>
      </span>
    </Show>
  )
}

// ── App ─────────────────────────────────────────────────────────────────────

function App(): JSX.Element {
  const [mode, setMode] = createSignal<DecoderMode>(loadMode())
  const [ftMode, setFTMode] = createSignal<FTMode>(loadFTMode())
  const [audioSourceOverride, setAudioSourceOverride] = createSignal<AudioSourceOverride>(loadAudioSourceOverride())
  const [ftContacts, setFtContacts] = createSignal<Map<string, Contact>>(new Map())
  const [ftMyCall, setFtMyCall] = createSignal('')
  const [ftMyGrid, setFtMyGrid] = createSignal('')
  const [txStatus, setTxStatus] = createSignal<TxStatus | null>(null)
  const txAudioHz = createMemo(() => txStatus()?.txAudioHz ?? 0)

  // ── Sticky CAT panel — collapses to its main bar once the body scrolls past
  // it, so the frequency/mode/PTT controls stay reachable while the decoder
  // content below scrolls. Re-expands once scrolled back near the top. ─────
  let scrollBodyEl: HTMLDivElement | undefined
  const [catCollapsed, setCatCollapsed] = createSignal(false)
  // Whether RadioCATPanel has one of its own sub-panels open (Settings,
  // Bridge status, PA bias, calibration) — real bug found on real
  // hardware: expanding Bridge status (tall — I/Q spectrum waterfall +
  // several rows of controls) and scrolling down to read the rest of it
  // crossed handleBodyScroll()'s own collapse threshold below, which hid
  // the sub-panel's content entirely (RadioCATPanel gates it on
  // !props.collapsed) and made the page jump straight past it. Suppress
  // auto-collapse while a sub-panel is open — the operator opened it on
  // purpose and is very likely mid-task with it, so collapsing out from
  // under them is always wrong in that state regardless of scroll
  // position.
  const [catSubpanelOpen, setCatSubpanelOpen] = createSignal(false)
  function handleBodyScroll() {
    if (!scrollBodyEl) return
    if (catSubpanelOpen()) {
      setCatCollapsed(false)
      return
    }
    const y = scrollBodyEl.scrollTop
    // Hysteresis, not a single threshold: collapsing shrinks the panel, and
    // the browser's scroll anchoring then pulls scrollTop back across the
    // same line → expand → collapse → visible flicker. Extra scroll events
    // from decoders appending content re-poke the loop. Collapse only once
    // clearly scrolled down, expand only near the top; in between, hold.
    // (Scroll anchoring itself is disabled on the container — see
    // [overflow-anchor:none] on the element.)
    if (y > 96) setCatCollapsed(true)
    else if (y < 24) setCatCollapsed(false)
  }

  // ── Radio CAT — lifted here so VFO frequency flows to all decoders ────────
  const cat = useRadioCAT()
  const vfoFrequency = createMemo(() => (cat.state().connected ? (cat.state().frequency ?? undefined) : undefined))

  // ── Bridge audio — lifted here (same reasoning as `cat` above) so a
  // decoder's audio source/sink can be "the bridge's live radio audio"
  // instead of only the local mic/speaker — see src/lib/audio/audioSource.ts.
  // One shared connection rather than each consumer (RadioCATPanel, FTDecoder,
  // FTTransmitPanel) opening its own /audio WebSocket.
  const audioBridge = useAudioBridge()
  // Lifted alongside audioBridge for the same reason, and passed to
  // RadioCATPanel's own input-mode selector/spectrum view — see
  // useIQBridge.ts's header comment. handleStart() below reads
  // iqBridge.state().inputMode to decide whether /audio is even meaningful
  // right now: while the bridge is in "iq" mode, /audio produces nothing
  // useful, so auto-connecting it there would silently look like a normal
  // (if empty) bridge audio connection instead of the "wrong mode" problem
  // it actually is.
  const iqBridge = useIQBridge()

  function handleAudioSourceOverrideChange(v: AudioSourceOverride) {
    setAudioSourceOverride(v)
    saveString(LS_AUDIO_SOURCE_OVERRIDE, v)
    // Forcing "Microphone" is the one override value that also touches the
    // bridge's actual connection (not just which source decoders read
    // from) — per the operator's own explicit choice, disconnect any open
    // bridge audio/I/Q socket rather than leaving it connected-but-unused.
    // The two bridge-specific override values deliberately do NOT trigger
    // any connect/disconnect/mode-switch here — see AudioSourceOverride's
    // own comment in audioSource.ts for why: the operator's forced choice
    // is authoritative, not another layer of automatic correction.
    if (v === 'microphone') {
      if (iqBridge.state().connected) iqBridge.disconnect()
      if (audioBridge.state().connected || audioBridge.state().playbackActive) audioBridge.disconnect()
    }
  }

  // See IQ_PASSBAND_DEFAULTS' own comment. Loaded once; applied to
  // iqBridge on mount (for whatever mode() already restored from its own
  // localStorage key) and again on every handleModeChange() below.
  const [passbandByMode, setPassbandByMode] = createSignal(loadPassbandByMode())
  // Tracks which mode's passband setting iqBridge ACTUALLY reflects right
  // now — see the persistence-back effect below for the real bug this
  // fixes: a naive version of that effect fired once immediately on
  // creation (SolidJS's createEffect runs synchronously at creation time,
  // before onMount below ever gets a chance to run) with whatever
  // useIQBridge()'s own hardcoded initial state was (centerHz:0), saw
  // that it differed from the just-loaded per-mode value (e.g. FT8's
  // {1500,3000}), and IMMEDIATELY overwrote the correct stored value with
  // the wrong transient one — confirmed directly against a real report:
  // localStorage showed bandwidthHz:3000 (the fix's OWN default did
  // apply) but centerHz:0 (clobbered right back by this exact race),
  // which put half the passband off-screen to the left of a 0-3000Hz
  // display range and looked like "barely changed." appliedForMode being
  // null until onMount's first real applyPassbandForMode() call is what
  // lets the persistence effect below tell "iqBridge's state is still
  // just its own generic default, not yet synced to this mode's real
  // setting" apart from "the operator genuinely just changed it."
  let appliedForMode: DecoderMode | null = null
  function applyPassbandForMode(m: DecoderMode) {
    const setting = passbandByMode()[m] ?? IQ_PASSBAND_DEFAULTS[m]
    iqBridge.setPassband(setting.centerHz, setting.bandwidthHz)
    appliedForMode = m
  }
  onMount(() => applyPassbandForMode(mode()))
  // Every decoder's own onPassbandChange calls iqBridge.setPassband()
  // directly (dragging the marker in SignalAnalysisPanel) rather than
  // through a prop threaded from here — reacting to iqBridge's own state
  // instead of adding a new prop to all 5 decoders captures a drag no
  // matter which one triggered it, with no per-decoder plumbing needed.
  createEffect(() => {
    const centerHz = iqBridge.state().passbandCenterHz
    const bandwidthHz = iqBridge.state().passbandBandwidthHz
    const m = mode()
    // Skip entirely until THIS mode's own setting has actually been
    // applied at least once — otherwise this fires against iqBridge's
    // bare construction-time default (see this field's own comment) and
    // clobbers the real stored value before onMount ever runs.
    if (appliedForMode !== m) return
    const current = passbandByMode()[m] ?? IQ_PASSBAND_DEFAULTS[m]
    if (current.centerHz === centerHz && current.bandwidthHz === bandwidthHz) return
    setPassbandByMode((all) => savePassbandForMode(all, m, { centerHz, bandwidthHz }))
  })
  // Reported by RadioCATPanel whenever its CAT transport/wsUrl changes —
  // undefined unless transport is 'websocket'. Lets handleStart() below
  // decide whether "Start Decoding" can auto-connect the bridge instead of
  // always prompting for a local mic.
  const [bridgeWsUrl, setBridgeWsUrl] = createSignal<string | undefined>(undefined)
  // Set by handleStart() below when the bridge's audio WebSocket fails to
  // connect during the "Start Decoding" auto-connect and it falls back to
  // the local microphone — otherwise that fallback was silent (no console
  // output, no UI indication), so an operator who thought they were
  // decoding the radio's own audio had no way to know they weren't.
  const [bridgeAudioFallbackWarning, setBridgeAudioFallbackWarning] = createSignal<string | null>(null)

  // ── Global audio — single shared AudioContext + AnalyserNode ─────────────
  const isRecording = createMemo(() => globalAudio.state().isRecording)
  const isSupported = createMemo(() => globalAudio.state().isSupported)
  const recordingError = createMemo(() => globalAudio.state().error)

  const rtty: { current: DecoderControls | null } = { current: null }
  const sstv: { current: DecoderControls | null } = { current: null }
  const cw: { current: DecoderControls | null } = { current: null }
  const ft: { current: DecoderControls | null } = { current: null }
  const mfsk: { current: DecoderControls | null } = { current: null }

  function handleForMode(m: DecoderMode) {
    return m === 'rtty' ? rtty : m === 'sstv' ? sstv : m === 'cw' ? cw : m === 'ft' ? ft : mfsk
  }

  // ── SSTV "Reply" — a captured image's Reply button opens the composer
  // panel (pre-filled) so the operator can send a QSO card back without
  // re-navigating. The composer consumes the request once, then clears it.
  const [replyRequest, setReplyRequest] = createSignal<CapturedImage | null>(null)
  const [sstvTxStatus, setSstvTxStatus] = createSignal<SSTVTxStatus | null>(null)
  const [rttyTxStatus, setRttyTxStatus] = createSignal<RTTYTxStatus | null>(null)
  const [rttyActiveConfig, setRttyActiveConfig] = createSignal<RTTYConfig | null>(null)
  let sstvComposerDetailsEl: HTMLDetailsElement | undefined
  function handleSSTVReply(img: CapturedImage) {
    setReplyRequest(img)
    if (sstvComposerDetailsEl) {
      sstvComposerDetailsEl.open = true
      sstvComposerDetailsEl.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  }

  const activeHandle = createMemo(() => handleForMode(mode()))

  // See handleStart()'s own comment on where this is set/cleared, and the
  // recovery effect below for why it exists.
  const [decodingFromBridgeMode, setDecodingFromBridgeMode] = createSignal<'iq' | 'audio' | null>(null)

  // ── Unified start / stop ─────────────────────────────────────────────────

  async function handleStart() {
    setBridgeAudioFallbackWarning(null)

    // A forced override (see audioSourceOverride's own comment) skips ALL
    // of the auto-detect query/connect/disconnect machinery below — the
    // operator's explicit choice is authoritative. 'microphone' also
    // doesn't need bridgeWsUrl()/refreshInfo() at all since it never
    // touches the bridge. The two forced bridge values deliberately read
    // whatever's ALREADY connected via resolveAudioSource() rather than
    // connecting/switching anything themselves — if nothing is connected
    // on the forced socket, that's the operator's own call to fix (open
    // the Bridge panel / flip its input mode), not something this
    // function should silently paper over.
    const override = audioSourceOverride()
    if (override !== 'auto') {
      const { kind, bridge } = resolveAudioSource(override, iqBridge, audioBridge)
      globalAudio.configureSource(kind, bridge)
      setDecodingFromBridgeMode(null)
      const node = await globalAudio.start()
      if (node) {
        await activeHandle().current?.start()
        trackEvent('decode_start', mode() === 'ft' ? { mode: mode(), ft_mode: ftMode() } : { mode: mode() })
      }
      return
    }

    // If the CAT connection is over the ESP32 bridge, decode from the
    // bridge's own live radio audio instead of always prompting for a
    // local mic — auto-opening the /audio connection here (same as
    // clicking "Listen to Radio" in the Bridge panel) rather than making
    // that a separate required step; connecting the bridge at all should
    // be enough for decoding to just work.
    const wsUrl = bridgeWsUrl()

    // Which physical path the bridge is currently sampling — "audio"
    // (already-demodulated) or "iq" (raw, demodulated client-side by
    // useIQBridge.ts; see that file's header comment on why this is a
    // superset, not a separate/incompatible mode). A quick refreshInfo()
    // here (one /status fetch) rather than trusting iqBridge's last-known
    // state, since the operator may not have opened the Bridge panel at
    // all this session — the RadioCATPanel-driven refresh isn't guaranteed
    // to have run yet.
    let bridgeInIQMode = false
    if (wsUrl) {
      await iqBridge.refreshInfo(wsUrl)
      bridgeInIQMode = iqBridge.state().inputMode === 'iq'
    }

    if (wsUrl && bridgeInIQMode) {
      // The bridge just reported I/Q mode — if audioBridge still has a
      // /audio socket open (e.g. this session started in audio mode and
      // the bridge switched since), drop it: audio_iq.c and audio_ws.c are
      // mutually exclusive on the firmware side, so a stale /audio
      // connection left open here would never receive anything either,
      // same class of "connected but silently dead" bug this whole
      // recovery path exists to fix.
      if (audioBridge.state().connected || audioBridge.state().playbackActive) audioBridge.disconnect()
      iqBridge.setCatMode(cat.state().mode)
      if (!iqBridge.state().connected) await iqBridge.connect(wsUrl)
      if (!iqBridge.state().connected) {
        setBridgeAudioFallbackWarning(
          `Could not connect to the bridge's I/Q stream (${iqBridge.state().error ?? 'unknown error'}) — falling back to the microphone.`
        )
      }
    } else if (wsUrl && !audioBridge.state().playbackActive) {
      // Mirror of the I/Q-side cleanup above — dropping a now-stale
      // iqBridge connection when the bridge has switched to audio mode.
      if (iqBridge.state().connected) iqBridge.disconnect()
      await audioBridge.connect(wsUrl)
      // connect() failing used to fall through to the microphone with no
      // visible sign anything had gone wrong — a bridge/network hiccup on
      // JUST the /audio socket (the CAT /cat connection can be perfectly
      // healthy at the same time, they're independent sockets) silently
      // turned into an unexplained mic permission prompt. Surface it.
      if (!audioBridge.state().playbackActive) {
        setBridgeAudioFallbackWarning(
          `Could not connect to the bridge's audio (${audioBridge.state().error ?? 'unknown error'}) — falling back to the microphone.`
        )
      }
    }
    const useIQ = wsUrl && bridgeInIQMode && iqBridge.state().connected
    const useAudio = wsUrl && !bridgeInIQMode && audioBridge.state().playbackActive
    globalAudio.configureSource(useIQ ? 'bridge' : useAudio ? 'bridge' : 'microphone', useIQ ? iqBridge : useAudio ? audioBridge : undefined)
    // Remembers which bridge (if any) THIS decode session actually locked
    // onto, so the mismatch-recovery effect below can tell "the bridge
    // switched mode out from under an active decode" apart from "the
    // operator hasn't started decoding, or is intentionally on the mic."
    setDecodingFromBridgeMode(useIQ ? 'iq' : useAudio ? 'audio' : null)

    const node = await globalAudio.start()
    if (node) {
      await activeHandle().current?.start()
      trackEvent('decode_start', mode() === 'ft' ? { mode: mode(), ft_mode: ftMode() } : { mode: mode() })
    }
  }
  function handleStop() {
    setDecodingFromBridgeMode(null)
    activeHandle().current?.stop()
    globalAudio.stop()
  }

  // ── Bridge-mode mismatch recovery ─────────────────────────────────────────
  // Real bug this fixes: input_mode_select lets the bridge's ADC mode
  // (audio-demodulated vs. raw I/Q) change out from under an active decode
  // session — via the operator's own toggle in the Bridge panel, the
  // bridge's own standalone control page, or a settings restore — and the
  // bridge REBOOTS to apply it (see http_control.c's input_mode_handler).
  // That reboot drops iqBridge's WebSocket; its reconnect logic (see
  // useIQBridge.ts) correctly reopens /iq-data and correctly refreshes
  // inputMode in state — but the firmware's /iq-data route accepts a
  // connection unconditionally even in audio mode (it just never has
  // anything to broadcast there — see audio_iq.c) and useIQBridge.ts had no
  // reason to know it should now be talking to /audio instead. Net effect
  // without this: the socket looks "connected," decoding was already
  // started, and nothing ever visibly breaks — it just silently stops
  // producing anything, indefinitely, until the operator notices and
  // manually stops/starts decoding again.
  //
  // This effect is the automatic version of that manual stop/start: while a
  // decode session is running from one bridge mode, watch for the LIVE
  // bridge state to disagree with what this session locked onto, and if so,
  // restart decode (handleStart() already re-derives the correct source
  // fresh — see its own comment) rather than continuing to feed a decoder
  // audio that will never arrive.
  createEffect(() => {
    const lockedMode = decodingFromBridgeMode()
    if (lockedMode === null) return
    const liveMode = iqBridge.state().inputMode
    if (lockedMode === liveMode) return
    console.info(`[bridge-mode] decode was using "${lockedMode}" but the bridge is now in "${liveMode}" mode — restarting decode against the correct source`)
    void handleStart()
  })

  // Real-hardware profiling of the ESP32 bridge found WiFi's dynamic
  // packet buffers and I2S's DMA descriptors draw from the same physical
  // memory pool — streaming /iq-data concurrently with TX measurably
  // degrades TX audio quality (see the bridge firmware's WiFi buffer-count
  // reduction, RadioCATPanel.tsx's "Suspend I/Q spectrum during TX"
  // checkbox). Bracket each keyed TX window by disconnecting iqBridge
  // (also fine RX-wise: half-duplex, nothing to receive while keyed) and
  // reconnecting once it ends. wasConnectedForTx tracks whether THIS
  // window actually suspended a connection, so windowEnd doesn't
  // reconnect when the operator wasn't using I/Q at all.
  let wasConnectedForTx = false
  function handleTxWindowStart() {
    if (!loadSuspendIQDuringTx()) return
    if (!iqBridge.state().connected) return
    wasConnectedForTx = true
    iqBridge.disconnect()
  }
  function handleTxWindowEnd() {
    if (!wasConnectedForTx) return
    wasConnectedForTx = false
    const wsUrl = bridgeWsUrl()
    if (wsUrl) void iqBridge.connect(wsUrl)
  }
  let clearSent: (() => void) | null = null
  function handleReset() {
    activeHandle().current?.reset()
    clearSent?.()
  }
  let setTxBaseFreq: ((v: number) => void) | null = null

  function handleFTModeChange(m: FTMode) {
    setFTMode(m)
    saveFTMode(m)
    trackEvent('ft_mode_change', { mode: m })
  }

  // Switching mode: stop previous decoder (but keep global audio), connect new decoder
  async function handleModeChange(newMode: DecoderMode) {
    if (newMode === mode()) return
    const prevHandle = handleForMode(mode())
    const wasRecording = isRecording()
    if (wasRecording) prevHandle.current?.stop()
    setMode(newMode)
    saveMode(newMode)
    applyPassbandForMode(newMode)
    trackEvent('decoder_mode_change', { mode: newMode })
    const nextHandle = handleForMode(newMode)
    if (wasRecording && globalAudio.analyser()) {
      await nextHandle.current?.start()
    }
  }

  const globalControls = createMemo<DecoderControls>(() => ({
    isRecording: isRecording(),
    isSupported: isSupported(),
    error: bridgeAudioFallbackWarning() ?? recordingError(),
    start: handleStart,
    stop: handleStop,
    reset: handleReset,
  }))

  // Reflects the SAME resolveAudioSource() precedence every decoder now
  // uses (see audioSource.ts) — auto-detects same as before when
  // audioSourceOverride() is 'auto', otherwise reports whatever the
  // operator forced, even if that forced bridge choice has nothing to
  // actually read right now (see AudioSourceOverride's own comment).
  const audioSourceDisplay = createMemo<AudioSourceDisplay | null>(() => {
    const { kind, bridge } = resolveAudioSource(audioSourceOverride(), iqBridge, audioBridge)
    if (kind === 'microphone') return 'microphone'
    return bridge === iqBridge ? 'bridge-iq' : 'bridge'
  })
  // Same precedence as audioSourceDisplay above — whichever bridge is
  // actually the one feeding decode is the one whose reconnect state
  // matters. Checked independently of audioSourceDisplay's own 'connected'/
  // 'playbackActive' condition, since BOTH flip to false the moment a
  // reconnect starts — reconnecting is what distinguishes "was working,
  // now retrying" from "never connected"/"stopped."
  const bridgeReconnecting = createMemo(() => iqBridge.state().reconnecting || audioBridge.state().reconnecting)

  const meta = createMemo(() => MODE_META[mode()])

  return (
    <main class="flex h-screen flex-col overflow-hidden">
      {/* Header */}
      <div class="shrink-0 px-4 pt-4 pb-3 sm:px-6 sm:pt-6 lg:px-8 lg:pt-8">
        <div class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h1 class="mb-1 text-2xl font-bold text-[#c9d1d9] sm:text-3xl lg:text-4xl">Radio Signal Decoder</h1>
            <p class="text-sm text-[#8b949e] sm:text-base">{meta().description}</p>
          </div>

          {/* Mode selector */}
          <div class="flex shrink-0 items-center gap-1 self-start rounded-lg border border-[#30363d] bg-[#0d1117] p-1 sm:self-auto">
            <For each={VALID_MODES}>
              {(m) => (
                <button
                  onClick={() => handleModeChange(m)}
                  class={`rounded-md px-4 py-1.5 text-sm font-semibold transition-colors ${mode() === m ? 'bg-[#238636] text-white' : 'text-[#8b949e] hover:text-[#c9d1d9]'}`}
                >
                  {MODE_META[m].label}
                </button>
              )}
            </For>
          </div>
        </div>
      </div>

      {/* Shared top bar — Start/Stop/Reset + FT sub-mode when active */}
      <div class="shrink-0 px-4 pb-2 sm:px-6 lg:px-8">
        <TopBar
          controls={globalControls()}
          mode={mode()}
          ftMode={ftMode()}
          onFTModeChange={handleFTModeChange}
          audioSource={audioSourceDisplay()}
          audioSourceOverride={audioSourceOverride()}
          onAudioSourceOverrideChange={handleAudioSourceOverrideChange}
          bridgeReconnecting={bridgeReconnecting()}
        />
      </div>

      {/* Scrollable body — CAT + TX panel + decoder content */}
      <div
        ref={scrollBodyEl}
        onScroll={handleBodyScroll}
        class="min-h-0 flex-1 overflow-y-auto px-4 pb-8 sm:px-6 lg:px-8 [overflow-anchor:none]"
      >
        {/* CAT radio control panel — sticky: stays visible while scrolling,
            collapsing to just its main bar so it doesn't eat too much space.
            NOT sticky while a sub-panel (Bridge status, Settings, etc.) is
            open — a sticky element's content that's taller than the
            viewport can never be scrolled into view (the PAGE scrolls, but
            a sticky element stays pinned at top with its overflow simply
            unreachable) — see catSubpanelOpen's own comment for the real
            bug this caused. Scrolling normally while a sub-panel is open
            lets its full content actually be reached. */}
        <div class={`${catSubpanelOpen() ? '' : 'sticky top-0 z-10'} bg-[#0d1117] pb-3`}>
          <RadioCATPanel
            cat={cat}
            audioBridge={audioBridge}
            iqBridge={iqBridge}
            collapsed={catCollapsed()}
            onWsUrlChange={setBridgeWsUrl}
            onSubpanelOpenChange={setCatSubpanelOpen}
          />
        </div>

        {/* FT Transmit panel — only shown when FT mode is active */}
        <Show when={mode() === 'ft'}>
          <div class="pb-3">
            {/* chips hidden via CSS when panel is open */}
            <style>{`details[open] .tx-summary-chips { display: none !important; }`}</style>
            <details class="rounded-lg border border-[#30363d] bg-[#161b22]">
              <summary class="flex cursor-pointer items-center rounded-lg px-4 py-3 text-sm font-semibold transition-colors select-none hover:bg-[#21262d] sm:px-5">
                Transmit
                <TxSummaryChips s={txStatus()} />
              </summary>
              <div class="px-4 pb-4 sm:px-5 sm:pb-5">
                <FTTransmitPanel
                  mode={ftMode()}
                  contacts={ftContacts()}
                  vfoFrequency={vfoFrequency()}
                  audioBridge={audioBridge}
                  iqBridge={iqBridge}
                  bridgeWsUrl={bridgeWsUrl()}
                  onMyCallChange={setFtMyCall}
                  onMyGridChange={setFtMyGrid}
                  onSetPTT={cat.state().connected ? cat.setPTT : undefined}
                  onTxWindowStart={handleTxWindowStart}
                  onTxWindowEnd={handleTxWindowEnd}
                  onStatusChange={setTxStatus}
                  onReset={(fn) => {
                    clearSent = fn
                  }}
                  onBaseFreqHandle={(fn) => {
                    setTxBaseFreq = fn
                  }}
                />
              </div>
            </details>
          </div>
        </Show>

        {/* SSTV QSO Card composer — only shown when SSTV mode is active */}
        <Show when={mode() === 'sstv'}>
          <div class="pb-3">
            {/* chip hidden via CSS when panel is open, same trick as the FT panel's tx-summary-chips */}
            <style>{`details[open] .sstv-tx-summary-chip { display: none !important; }`}</style>
            <details ref={sstvComposerDetailsEl} class="rounded-lg border border-[#30363d] bg-[#161b22]">
              <summary class="flex cursor-pointer items-center rounded-lg px-4 py-3 text-sm font-semibold transition-colors select-none hover:bg-[#21262d] sm:px-5">
                Compose &amp; Transmit QSO Card
                <SSTVTxSummaryChip s={sstvTxStatus()} />
              </summary>
              <div class="px-4 pb-4 sm:px-5 sm:pb-5">
                <SSTVComposer
                  replyRequest={replyRequest()}
                  onReplyConsumed={() => setReplyRequest(null)}
                  onSetPTT={cat.state().connected ? cat.setPTT : undefined}
                  onStatusChange={setSstvTxStatus}
                />
              </div>
            </details>
          </div>
        </Show>

        {/* RTTY transmit panel — only shown when RTTY mode is active */}
        <Show when={mode() === 'rtty' && rttyActiveConfig()}>
          <div class="pb-3">
            <style>{`details[open] .rtty-tx-summary-chip { display: none !important; }`}</style>
            <details class="rounded-lg border border-[#30363d] bg-[#161b22]">
              <summary class="flex cursor-pointer items-center rounded-lg px-4 py-3 text-sm font-semibold transition-colors select-none hover:bg-[#21262d] sm:px-5">
                Transmit
                <RTTYTxSummaryChip s={rttyTxStatus()} />
              </summary>
              <div class="px-4 pb-4 sm:px-5 sm:pb-5">
                <RTTYTransmitPanel
                  seedConfig={rttyActiveConfig()!}
                  vfoFrequency={vfoFrequency()}
                  onSetPTT={cat.state().connected ? cat.setPTT : undefined}
                  onStatusChange={setRttyTxStatus}
                />
              </div>
            </details>
          </div>
        </Show>

        {/* All decoders mounted persistently, toggled via CSS. audioBridge/
            iqBridge threaded into every decoder now (not just FT8) — each
            decoder's own processor picks iqBridge-connected first, then
            audioBridge-playbackActive, else microphone (see each
            component's audioSourceKind()/getBridge(), mirroring
            FTDecoder.tsx's original pattern). */}
        <div class={mode() === 'rtty' ? '' : 'hidden'}>
          <RTTYDecoder
            handle={rtty}
            onStateChange={() => {}}
            analyser={globalAudio.analyser()}
            vfoFrequency={vfoFrequency()}
            onActiveConfigChange={setRttyActiveConfig}
            audioBridge={audioBridge}
            iqBridge={iqBridge}
            audioSourceOverride={audioSourceOverride()}
          />
        </div>
        <div class={mode() === 'sstv' ? '' : 'hidden'}>
          <SSTVDecoder
            handle={sstv}
            onStateChange={() => {}}
            analyser={globalAudio.analyser()}
            vfoFrequency={vfoFrequency()}
            onReply={handleSSTVReply}
            audioBridge={audioBridge}
            iqBridge={iqBridge}
            audioSourceOverride={audioSourceOverride()}
          />
        </div>
        <div class={mode() === 'cw' ? '' : 'hidden'}>
          <CWDecoder
            handle={cw}
            onStateChange={() => {}}
            analyser={globalAudio.analyser()}
            vfoFrequency={vfoFrequency()}
            audioBridge={audioBridge}
            iqBridge={iqBridge}
            audioSourceOverride={audioSourceOverride()}
          />
        </div>
        <div class={mode() === 'mfsk' ? '' : 'hidden'}>
          <MFSKDecoder
            handle={mfsk}
            onStateChange={() => {}}
            analyser={globalAudio.analyser()}
            vfoFrequency={vfoFrequency()}
            audioBridge={audioBridge}
            iqBridge={iqBridge}
            audioSourceOverride={audioSourceOverride()}
          />
        </div>
        <div class={mode() === 'ft' ? '' : 'hidden'}>
          <FTDecoder
            handle={ft}
            ftMode={ftMode()}
            myCall={ftMyCall()}
            myGrid={ftMyGrid()}
            onStateChange={() => {}}
            onContactsChange={setFtContacts}
            analyser={globalAudio.analyser()}
            vfoFrequency={vfoFrequency()}
            txAudioHz={txAudioHz()}
            onTxAudioHzChange={(hz) => setTxBaseFreq?.(hz)}
            audioBridge={audioBridge}
            iqBridge={iqBridge}
            audioSourceOverride={audioSourceOverride()}
          />
        </div>
      </div>

      {/* Memory / resource debug bar — always visible at the bottom */}
      <MemDebugBar contacts={ftContacts()} />

      <PWAInstallPrompt />
      <UpdateAvailablePrompt />
    </main>
  )
}

export default App
