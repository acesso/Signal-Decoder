// Port of src/components/FTWasmPanel.tsx (Next.js app).
/**
 * WASM decoder monitor + runtime controls.
 *
 * Renders a compact status strip (engine, decode time, heap, budget usage)
 * that expands into tuning controls for the ft8mon FT8 engine. Params apply
 * live — the worker picks them up on the next decode window. The reload
 * button respawns the worker (fresh WASM instances) without a page reload.
 */

import { createSignal, createMemo, onCleanup, onMount, For, Show, type JSX } from 'solid-js'
import {
  DEFAULT_DECODER_PARAMS,
  MAX_SLICE_WIDTH_HZ,
  type FTDecoderActivity,
  type FTDecoderParams,
  type FTDecoderStats,
  type FTDecoderStatus,
  ensureDecoderReady,
  getDecoderParams,
  getDecoderPoolSize,
  reloadDecoder,
  setDecoderParams,
  setDecoderPoolSize,
  subscribeDecoderActivity,
  subscribeDecoderStats,
  subscribeDecoderStatus,
} from '$decoder-lib/ft/decoder'

const STORAGE_KEY = 'ft-decoder-params-v1'
const POOL_SIZE_KEY = 'ft-decoder-pool-size-v1'

function loadStoredParams(): Partial<FTDecoderParams> | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? (JSON.parse(raw) as Partial<FTDecoderParams>) : null
  } catch {
    return null
  }
}

interface SliderSpec {
  key: keyof FTDecoderParams
  label: string
  min: number
  max: number
  step: number
  hint: string
}

const SLIDERS: SliderSpec[] = [
  { key: 'osdDepth', label: 'OSD depth', min: 0, max: 6, step: 1, hint: '0 = off; higher rescues weaker signals, too high decodes garbage' },
  { key: 'budgetSec', label: 'CPU budget s', min: 1, max: 12, step: 0.5, hint: 'decode time-box per 15 s window — soft limit: fixed per-pass costs can overrun it by a few seconds (known issue)' },
  { key: 'npasses', label: 'Sub. passes', min: 1, max: 6, step: 1, hint: 'decode → subtract → re-scan iterations' },
  { key: 'ldpcIters', label: 'LDPC iters', min: 10, max: 60, step: 5, hint: 'belief-propagation iterations' },
  { key: 'osdLdpcThresh', label: 'OSD thresh', min: 40, max: 83, step: 1, hint: 'min correct parity bits before OSD is tried' },
  { key: 'minHz', label: 'Min Hz', min: 0, max: 1000, step: 50, hint: 'decode band lower bound' },
  {
    key: 'maxHz', label: 'Max Hz', min: 2000, max: 24000, step: 100,
    hint: `decode band upper bound — bands wider than ${MAX_SLICE_WIDTH_HZ}Hz auto-split into multiple ${MAX_SLICE_WIDTH_HZ}Hz decode slices (see "Parallel workers" below); each extra slice beyond your worker count queues on an existing worker instead of running concurrently, so a wide band costs real CPU/wall-clock time — the demodulator's own passband width (Width field on the spectrum marker) must be widened to match, or the extra Hz here just searches silence`,
  },
]

// Animated elapsed-vs-budget bar shown while a decode is in flight.
// rAF drives DOM mutations directly — no Solid re-render per frame.
// Bar color doubles as the average marker: blue while this window's live
// decode count is below the rolling average, green once it reaches it.
function DecodeProgress(props: { startedAt: number; budgetSec: number; decoded: number; avgMsgs: number | null }): JSX.Element {
  let barEl: HTMLDivElement | undefined
  let lblEl: HTMLSpanElement | undefined
  const reachedAvg = createMemo(() => props.avgMsgs !== null && props.decoded >= props.avgMsgs)

  onMount(() => {
    let raf: number
    const tick = () => {
      const elapsed = (Date.now() - props.startedAt) / 1000
      const pct = Math.min(100, (elapsed / props.budgetSec) * 100)
      if (barEl) {
        barEl.style.width = `${pct}%`
        barEl.style.background = reachedAvg() // hit the rolling average
          ? '#2ea043'
          : pct >= 100 // over budget, still below average
            ? '#e3b341'
            : '#1f6feb'
      }
      if (lblEl) lblEl.textContent = `${elapsed.toFixed(1)}s`
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    onCleanup(() => cancelAnimationFrame(raf))
  })

  const avgTitle = createMemo(() =>
    props.avgMsgs === null
      ? 'decode in progress — elapsed vs CPU budget'
      : `decode in progress — bar turns green when the live count reaches the rolling average (${props.avgMsgs.toFixed(1)} msgs/window)`,
  )

  return (
    <span class="flex items-center gap-1.5 min-w-0" title={avgTitle()}>
      <span class="text-[#e3b341] animate-pulse text-[10px] shrink-0">DEC</span>
      <span class="relative w-16 h-1 rounded bg-[#21262d] overflow-hidden shrink-0">
        <div ref={barEl} class="absolute inset-y-0 left-0 rounded" style={{ width: '0', background: '#1f6feb' }} />
      </span>
      <span ref={lblEl} class="font-mono text-[#8b949e] text-[10px] shrink-0" />
      <Show when={props.decoded > 0}>
        <span
          class={`font-mono text-[10px] shrink-0 ${reachedAvg() ? 'text-[#2ea043]' : 'text-[#8b949e]'}`}
          title="messages decoded so far in this window"
        >
          {props.decoded} msg{props.decoded === 1 ? '' : 's'}
        </span>
      </Show>
    </span>
  )
}

export default function FTWasmPanel(props: { ftMode: string }): JSX.Element {
  const [stats, setStats] = createSignal<FTDecoderStats | null>(null)
  const [status, setStatus] = createSignal<FTDecoderStatus>({ engines: [], generation: 0 })
  const [activity, setActivity] = createSignal<FTDecoderActivity>({ inFlight: 0, startedAt: null, decodedSoFar: 0 })
  const [open, setOpen] = createSignal(false)
  const [params, setParams] = createSignal<FTDecoderParams>(DEFAULT_DECODER_PARAMS)
  const [poolSize, setPoolSize] = createSignal(getDecoderPoolSize())

  onMount(() => {
    const stored = loadStoredParams()
    if (stored) {
      setDecoderParams(stored)
    }
    setParams(getDecoderParams())
    // Pool size must be restored before the first ensureDecoderReady() spawns
    // it, or the stored preference wouldn't take effect until a reload.
    const storedPool = parseInt(localStorage.getItem(POOL_SIZE_KEY) ?? '', 10)
    if (Number.isFinite(storedPool)) {
      setDecoderPoolSize(storedPool)
      setPoolSize(getDecoderPoolSize())
    }

    ensureDecoderReady() // spawn the worker pool + load WASM before the first decode
    const unsubStats = subscribeDecoderStats(setStats)
    const unsubStatus = subscribeDecoderStatus(setStatus)
    const unsubActivity = subscribeDecoderActivity(setActivity)
    onCleanup(() => {
      unsubStats()
      unsubStatus()
      unsubActivity()
    })
  })

  const updatePoolSize = (n: number) => {
    setDecoderPoolSize(n)
    setPoolSize(getDecoderPoolSize())
    try {
      localStorage.setItem(POOL_SIZE_KEY, String(getDecoderPoolSize()))
    } catch {
      /* ignore */
    }
    reloadDecoder() // new size only takes effect once the pool respawns
  }

  const update = (key: keyof FTDecoderParams, value: number) => {
    setDecoderParams({ [key]: value })
    const next = getDecoderParams()
    setParams(next)
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    } catch {
      /* ignore */
    }
  }

  const resetDefaults = () => {
    setDecoderParams(DEFAULT_DECODER_PARAMS)
    setParams(getDecoderParams())
    try {
      localStorage.removeItem(STORAGE_KEY)
    } catch {
      /* ignore */
    }
  }

  const decodeS = createMemo(() => (stats() ? (stats()!.decodeMs / 1000).toFixed(1) : '—'))
  const engine = createMemo(() => stats()?.engine ?? (status().engines[0] ?? '—'))
  const budgetPct = createMemo(() => {
    const s = stats()
    return s && s.engine === 'ft8mon' ? Math.min(100, Math.round((s.decodeMs / 1000 / params().budgetSec) * 100)) : null
  })
  const loading = createMemo(() => status().engines.length === 0)
  const requiredSlices = createMemo(() => Math.max(1, Math.ceil((params().maxHz - params().minHz) / MAX_SLICE_WIDTH_HZ)))

  return (
    <div class="bg-[#0d1117] border border-[#21262d] rounded-md text-xs">
      {/* status strip */}
      <div class="flex items-center gap-2 px-2 py-1.5 flex-wrap">
        <span class="text-[#484f58] uppercase text-[9px] tracking-wider shrink-0">WASM</span>

        <span class={`font-mono font-semibold ${loading() ? 'text-[#e3b341]' : 'text-[#c9d1d9]'}`}>{loading() ? 'loading…' : engine()}</span>

        <span class="text-[#484f58]">·</span>
        <Show
          when={activity().inFlight > 0 && activity().startedAt !== null}
          fallback={
            <span class="font-mono text-[#8b949e]" title="last decode time inside WASM">
              {decodeS()}s
              <Show when={budgetPct() !== null}>
                <span class="text-[#484f58]"> /{params().budgetSec}s ({budgetPct()}%)</span>
              </Show>
            </span>
          }
        >
          <DecodeProgress
            startedAt={activity().startedAt!}
            budgetSec={params().budgetSec}
            decoded={activity().decodedSoFar}
            avgMsgs={stats()?.avgMsgs ?? null}
          />
        </Show>

        <Show when={status().generation > 1}>
          <span class="font-mono text-[#484f58]" title="worker respawn count">
            gen {status().generation}
          </span>
        </Show>

        <div class="ml-auto flex items-center gap-1 shrink-0">
          <button
            onClick={() => setOpen((o) => !o)}
            class={`px-1.5 py-0.5 rounded border text-[10px] transition-colors ${
              open()
                ? 'bg-[#1f6feb]/20 border-[#1f6feb]/50 text-[#58a6ff]'
                : 'bg-transparent border-[#30363d] text-[#8b949e] hover:text-[#c9d1d9] hover:border-[#484f58]'
            }`}
            title="decoder tuning"
          >
            Tune
          </button>
          <button
            onClick={() => reloadDecoder()}
            class="px-1.5 py-0.5 rounded border border-[#30363d] text-[10px] text-[#8b949e] hover:text-[#c9d1d9] hover:border-[#484f58] transition-colors"
            title="terminate worker and reload WASM modules (no page reload)"
          >
            ⟳ WASM
          </button>
        </div>
      </div>

      {/* tuning controls */}
      <Show when={open()}>
        <div class="border-t border-[#21262d] px-2 py-2">
          <Show when={props.ftMode !== 'FT8'}>
            <div class="mb-2 text-[10px] text-[#e3b341]">Tuning applies to the ft8mon engine (FT8 mode). {props.ftMode} decodes on ft8_lib.</div>
          </Show>
          <div class="grid grid-cols-1 gap-y-1.5">
            <For each={SLIDERS}>
              {({ key, label, min, max, step, hint }) => {
                const suggested = createMemo(() => (key === 'budgetSec' ? stats()?.suggestedBudgetSec ?? null : null))
                return (
                  <label class="flex items-center gap-2 min-w-0" title={hint}>
                    <span class="text-[#8b949e] w-24 shrink-0 text-[10px]">{label}</span>
                    <span class="relative flex-1 flex items-center">
                      <input
                        type="range"
                        min={min}
                        max={max}
                        step={step}
                        value={params()[key]}
                        onInput={(e) => update(key, Number(e.currentTarget.value))}
                        class="w-full h-1 accent-[#1f6feb] cursor-pointer"
                      />
                      <Show when={suggested() !== null}>
                        {/* marker: latest message in recent windows arrived by here (+margin) */}
                        <span
                          class="absolute top-1/2 -translate-y-1/2 w-0.5 h-3 bg-[#2ea043] rounded pointer-events-none"
                          style={{ left: `${((suggested()! - min) / (max - min)) * 100}%` }}
                          title={`suggested ${suggested()}s — last message in recent windows arrived by here`}
                        />
                      </Show>
                    </span>
                    <span class="font-mono text-[#c9d1d9] w-10 text-right shrink-0">{params()[key]}</span>
                    <Show when={suggested() !== null && suggested() !== params()[key]}>
                      <button
                        onClick={(e) => {
                          e.preventDefault()
                          update('budgetSec', suggested()!)
                        }}
                        class="font-mono text-[10px] text-[#2ea043] hover:underline shrink-0"
                        title="apply suggested budget (max observed last-message time + 0.5s, last 10 windows)"
                      >
                        →{suggested()}s
                      </button>
                    </Show>
                  </label>
                )
              }}
            </For>
          </div>
          <Show when={props.ftMode === 'FT8'}>
            <div
              class="mt-1.5 text-[10px]"
              classList={{ 'text-[#e3b341]': requiredSlices() > poolSize(), 'text-[#484f58]': requiredSlices() <= poolSize() }}
              title={`(maxHz - minHz) / ${MAX_SLICE_WIDTH_HZ}Hz, rounded up — the number of ${MAX_SLICE_WIDTH_HZ}Hz decode slices this band needs each window, regardless of worker count.`}
            >
              {params().maxHz - params().minHz}Hz band needs {requiredSlices()} decode slice{requiredSlices() === 1 ? '' : 's'}/window
              <Show when={requiredSlices() > poolSize()}>
                {' '}— only {poolSize()} worker{poolSize() === 1 ? '' : 's'} available, {requiredSlices() - poolSize()} slice{requiredSlices() - poolSize() === 1 ? '' : 's'} will queue (slower per window); raise "Parallel workers" below to run them concurrently
              </Show>
            </div>
          </Show>
          <div class="mt-2 pt-2 border-t border-[#21262d] flex items-center justify-between gap-2">
            <label
              class="flex items-center gap-2 min-w-0"
              title="Independent decoder workers running in parallel. FT8: each window's frequency band is split into this many slices, decoded concurrently (matches WSJT-X Improved/JTDX's approach — ft8mon has no interference-subtraction loop to parallelize otherwise). FT4 falls back to one window per worker, since ft8_lib's single-pass decoder has no per-slice work to split. Changing this reloads WASM."
            >
              <span class="text-[#8b949e] text-[10px] whitespace-nowrap">Parallel workers</span>
              <input
                type="range"
                min={1}
                max={8}
                step={1}
                value={poolSize()}
                onInput={(e) => updatePoolSize(Number(e.currentTarget.value))}
                class="w-20 h-1 accent-[#1f6feb] cursor-pointer"
              />
              <span class="font-mono text-[#c9d1d9] w-4 text-right shrink-0">{poolSize()}</span>
            </label>
            <button
              onClick={resetDefaults}
              class="px-1.5 py-0.5 rounded border border-[#30363d] text-[10px] text-[#8b949e] hover:text-[#c9d1d9] hover:border-[#484f58] transition-colors shrink-0"
            >
              Reset defaults
            </button>
          </div>
        </div>
      </Show>
    </div>
  )
}
