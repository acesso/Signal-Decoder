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
import PWAInstallPrompt from './components/PWAInstallPrompt'
import UpdateAvailablePrompt from './components/UpdateAvailablePrompt'
import { globalAudio } from './lib/audio/globalAudio'
import type { DecoderControls } from './lib/decoderControls'
import { type FTDecoderStats, type FTDecoderStatus, type FTMode, subscribeDecoderStats, subscribeDecoderStatus } from '$decoder-lib/ft/decoder'
import type { Contact } from '$decoder-lib/ft/parser'
import { audioRecorder, REC_DURATION_CHOICES_SEC } from '$decoder-lib/audio/ringRecorder'
import type { CapturedImage } from '$decoder-lib/sstv/audioProcessor'
import { trackEvent } from '$decoder-lib/analytics'

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

function TopBar(props: { controls: DecoderControls | null; mode: DecoderMode; ftMode: FTMode; onFTModeChange: (m: FTMode) => void }): JSX.Element {
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

        <Show when={error()}>
          <span class="ml-auto font-mono text-xs text-[#f85149]">{error()}</span>
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
  function handleBodyScroll() {
    if (!scrollBodyEl) return
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

  // ── Unified start / stop ─────────────────────────────────────────────────

  async function handleStart() {
    const node = await globalAudio.start()
    if (node) {
      await activeHandle().current?.start()
      trackEvent('decode_start', mode() === 'ft' ? { mode: mode(), ft_mode: ftMode() } : { mode: mode() })
    }
  }
  function handleStop() {
    activeHandle().current?.stop()
    globalAudio.stop()
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
    trackEvent('decoder_mode_change', { mode: newMode })
    const nextHandle = handleForMode(newMode)
    if (wasRecording && globalAudio.analyser()) {
      await nextHandle.current?.start()
    }
  }

  const globalControls = createMemo<DecoderControls>(() => ({
    isRecording: isRecording(),
    isSupported: isSupported(),
    error: recordingError(),
    start: handleStart,
    stop: handleStop,
    reset: handleReset,
  }))

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
        <TopBar controls={globalControls()} mode={mode()} ftMode={ftMode()} onFTModeChange={handleFTModeChange} />
      </div>

      {/* Scrollable body — CAT + TX panel + decoder content */}
      <div
        ref={scrollBodyEl}
        onScroll={handleBodyScroll}
        class="min-h-0 flex-1 overflow-y-auto px-4 pb-8 sm:px-6 lg:px-8 [overflow-anchor:none]"
      >
        {/* CAT radio control panel — sticky: stays visible while scrolling,
            collapsing to just its main bar so it doesn't eat too much space. */}
        <div class="sticky top-0 z-10 bg-[#0d1117] pb-3">
          <RadioCATPanel cat={cat} collapsed={catCollapsed()} />
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
                  onMyCallChange={setFtMyCall}
                  onMyGridChange={setFtMyGrid}
                  onSetPTT={cat.state().connected ? cat.setPTT : undefined}
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

        {/* All decoders mounted persistently, toggled via CSS */}
        <div class={mode() === 'rtty' ? '' : 'hidden'}>
          <RTTYDecoder
            handle={rtty}
            onStateChange={() => {}}
            analyser={globalAudio.analyser()}
            vfoFrequency={vfoFrequency()}
            onActiveConfigChange={setRttyActiveConfig}
          />
        </div>
        <div class={mode() === 'sstv' ? '' : 'hidden'}>
          <SSTVDecoder handle={sstv} onStateChange={() => {}} analyser={globalAudio.analyser()} vfoFrequency={vfoFrequency()} onReply={handleSSTVReply} />
        </div>
        <div class={mode() === 'cw' ? '' : 'hidden'}>
          <CWDecoder handle={cw} onStateChange={() => {}} analyser={globalAudio.analyser()} vfoFrequency={vfoFrequency()} />
        </div>
        <div class={mode() === 'mfsk' ? '' : 'hidden'}>
          <MFSKDecoder handle={mfsk} onStateChange={() => {}} analyser={globalAudio.analyser()} vfoFrequency={vfoFrequency()} />
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
