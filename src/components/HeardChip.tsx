// A Sent Log row's "heard" chip (doc/plans/tx-heard/PLAN.md): how many
// stations reported the row on PSK Reporter and from where, e.g.
// "📡 7 🇺🇸3 🇺🇾2 🇧🇷2 +1"; 🎯 instead of 📡 when the station the message
// was addressed to is among them. Hovering opens the full list: every
// country with its count, and its stations with SNR and distance.
// `recent`: nobody reported this row, but these stations reported me in the
// 20 minutes before it; PSK Reporter drops their repeats, so they most likely
// heard this one too. Drawn dimmed, and said so.
import { createSignal, For, Show, type JSX } from 'solid-js'
import { Portal } from 'solid-js/web'
import type { HeardSummary } from '$decoder-lib/ft/pskreporter/heard'

/** Flags on the chip itself; the rest are a "+N". */
const CHIP_COUNTRIES = 3

const fmtKm = (km: number | null) => (km === null ? '' : `${km.toLocaleString()} km`)
const fmtSnr = (snr: number | null) => (snr === null ? '' : `${snr > 0 ? '+' : ''}${snr} dB`)

export default function HeardChip(props: { summary: HeardSummary; callee?: string; recent?: boolean }): JSX.Element {
  const [at, setAt] = createSignal<{ x: number; y: number } | null>(null)
  const shown = () => props.summary.countries.slice(0, CHIP_COUNTRIES)
  const more = () => props.summary.countries.length - CHIP_COUNTRIES
  const open = (ev: MouseEvent) => {
    const r = (ev.currentTarget as HTMLElement).getBoundingClientRect()
    setAt({ x: Math.min(r.right, window.innerWidth - 8), y: r.bottom + 4 })
  }

  return (
    <span
      class={`shrink-0 inline-flex items-center gap-1 px-1 rounded text-[10px] cursor-default tabular-nums ${props.recent ? 'opacity-50 border border-dashed border-[#30363d] text-[#8b949e]' : 'bg-[#1f6feb1a] text-[#79c0ff]'}`}
      onMouseEnter={open}
      onMouseLeave={() => setAt(null)}
      aria-label={props.recent
        ? `Reported by ${props.summary.total} station${props.summary.total === 1 ? '' : 's'} on PSK Reporter in the 20 minutes before`
        : `Heard by ${props.summary.total} station${props.summary.total === 1 ? '' : 's'} on PSK Reporter`}
    >
      <span>{props.summary.calleeHeard ? '🎯' : '📡'}</span>
      <span class="font-semibold">{props.recent ? '~' : ''}{props.summary.total}</span>
      <For each={shown()}>{(c) => <span title={c.name}>{c.flag}{c.stations.length}</span>}</For>
      <Show when={more() > 0}><span class="text-[#8b949e]">+{more()}</span></Show>

      <Show when={at()}>
        {(p) => (
          <Portal>
            <div
              class="fixed z-50 w-72 max-h-80 overflow-y-auto rounded-md border border-[#30363d] bg-[#161b22] p-2 text-[11px] text-[#c9d1d9] shadow-lg"
              style={{ left: `${Math.max(8, p().x - 288)}px`, top: `${p().y}px` }}
            >
              <div class="mb-1 text-[#8b949e]">
                <Show when={props.recent} fallback={<>Heard by {props.summary.total} station{props.summary.total === 1 ? '' : 's'} (PSK Reporter)</>}>
                  Not reported itself. {props.summary.total} station{props.summary.total === 1 ? '' : 's'} reported you in the 20 minutes
                  before it; PSK Reporter keeps one report per station for about 20 minutes, so they most likely heard this one too.
                </Show>
                <Show when={props.summary.calleeHeard && props.callee}> · 🎯 {props.callee} heard you</Show>
              </div>
              <For each={props.summary.countries}>
                {(c) => (
                  <div class="mt-1">
                    <div class="font-semibold">{c.flag} {c.name} <span class="text-[#8b949e] font-normal">{c.stations.length}</span></div>
                    <For each={c.stations}>
                      {(s) => (
                        <div class="ml-5 flex gap-2 font-mono text-[10px]">
                          <span class="w-20 truncate">{s.call}</span>
                          <span class="w-12 text-[#8b949e]">{s.grid.slice(0, 6)}</span>
                          <span class="w-12 text-right">{fmtSnr(s.snr)}</span>
                          <span class="flex-1 text-right text-[#8b949e]">{fmtKm(s.km)}</span>
                        </div>
                      )}
                    </For>
                  </div>
                )}
              </For>
            </div>
          </Portal>
        )}
      </Show>
    </span>
  )
}
