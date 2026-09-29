/**
 * PSK Reporter spotting controls and status.
 *
 * Callsign and grid are shown but not editable here: they are the transmit
 * panel's `ft_mycall` / `ft_mygrid`, persisted in localStorage, and a second
 * set of inputs for the same two values would only invite them to disagree.
 */
import { createMemo, Show, type JSX } from 'solid-js'
import type { FTMode } from '$decoder-lib/ft/decoder'
import {
  MIN_INTERVAL_MINUTES,
  MAX_INTERVAL_MINUTES,
  type SendCadence,
} from '$decoder-lib/ft/pskreporter/spotQueue'
import type { PskReporter, ReporterBlocked } from '$decoder-lib/ft/pskreporter/usePskReporter'

interface Props {
  reporter: PskReporter
  myCall: string
  myGrid: string
  mode: FTMode
}

/** What the operator needs to do, or what the app is waiting on. */
const BLOCKED_TEXT: Record<Exclude<ReporterBlocked, null>, string> = {
  disabled: 'Off',
  'no-proxy': 'No relay configured in this build',
  'no-callsign': 'Set your callsign in the Transmit panel',
  'no-grid': 'Set your grid in the Transmit panel',
  'no-frequency': 'Waiting for a radio frequency',
}

function timeAgo(at: number | null): string {
  if (at === null) return 'never'
  const secs = Math.max(0, Math.round((Date.now() - at) / 1000))
  if (secs < 60) return `${secs}s ago`
  return `${Math.round(secs / 60)}m ago`
}

/** PSK Reporter's map knows FT8 and FT4; anything else falls back to FT8. */
function mapMode(mode: FTMode): string {
  return mode === 'FT4' ? 'FT4' : 'FT8'
}

/**
 * Knob travel is written in pixels rather than spacing utilities: the track is
 * 36px wide and the knob 16px, so the two resting positions are 2 and 18, and
 * naming them directly keeps the knob inside the track whatever the spacing
 * scale does.
 */
function Toggle(props: { checked: boolean; disabled?: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.checked}
      disabled={props.disabled}
      onClick={() => props.onChange(!props.checked)}
      class={`relative inline-block h-5 w-9 shrink-0 rounded-full align-middle transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
        props.checked ? 'bg-[#2ea043]' : 'bg-[#30363d]'
      }`}
    >
      <span
        class={`absolute top-[2px] h-4 w-4 rounded-full bg-white transition-all ${
          props.checked ? 'left-[18px]' : 'left-[2px]'
        }`}
      />
    </button>
  )
}

export default function PskReporterPanel(props: Props): JSX.Element {
  const status = () => props.reporter.status()
  const call = createMemo(() => props.myCall.trim().toUpperCase())

  const live = () => status().blocked === null
  // 'no-frequency' means it is configured and simply waiting on the radio,
  // which is a different situation from being unconfigured or switched off.
  const waiting = () => status().blocked === 'no-frequency'

  const dotClass = () => (live() ? 'bg-[#2ea043]' : waiting() ? 'bg-[#e3b341]' : 'bg-[#484f58]')

  const summary = () => {
    const b = status().blocked
    if (b !== null) return BLOCKED_TEXT[b]
    const sent = status().totalSpotsSent
    return sent > 0 ? `${sent} spot${sent === 1 ? '' : 's'} reported` : 'Reporting'
  }

  const cadenceLabel = () =>
    props.reporter.cadenceMode() === 'window'
      ? 'each window'
      : `every ${props.reporter.intervalMinutes()} min`

  function setMode(mode: SendCadence['mode']) {
    props.reporter.setCadenceMode(mode)
  }

  const labelClass = 'text-[10px] font-semibold tracking-wide text-[#8b949e]'

  return (
    <details class="rounded-lg border border-[#30363d] bg-[#161b22]">
      <summary class="flex cursor-pointer items-center gap-2 rounded-lg p-4 text-base font-semibold transition-colors select-none hover:bg-[#21262d] sm:p-5 sm:text-lg">
        <span class={`h-2 w-2 shrink-0 rounded-full ${dotClass()}`} />
        PSK Reporter
        <span class="text-xs font-normal text-[#8b949e]">{summary()}</span>
      </summary>

      <div class="space-y-3 px-4 pb-4 sm:px-5 sm:pb-5">
        <Show when={!props.reporter.available}>
          <p class="rounded-md border border-[#30363d] bg-[#0d1117] p-3 text-xs text-[#8b949e]">
            This build points at no relay, so reporting is unavailable. PSK Reporter only accepts
            reports over a socket a browser cannot open, so uploads go through a small proxy — see
            <span class="font-mono"> proxy/pskreporter-worker/</span>.
          </p>
        </Show>

        <div class="flex flex-wrap items-center gap-x-6 gap-y-3 text-sm">
          <label class="flex cursor-pointer items-center gap-2 text-[#c9d1d9]">
            <Toggle
              checked={props.reporter.enabled()}
              disabled={!props.reporter.available}
              onChange={(v) => props.reporter.setEnabled(v)}
            />
            <span>Report my decodes</span>
          </label>

          {/* Read-only: these belong to the Transmit panel. */}
          <span class="text-[#8b949e]">
            as <span class="font-mono text-[#c9d1d9]">{call() || '—'}</span>
            {' / '}
            <span class="font-mono text-[#c9d1d9]">{props.myGrid.trim().toUpperCase() || '—'}</span>
            <span class="ml-2 text-xs text-[#484f58]">set in the Transmit panel</span>
          </span>

          <label class="flex items-center gap-2">
            <span class={labelClass}>Antenna</span>
            <input
              value={props.reporter.antenna()}
              onInput={(e) => props.reporter.setAntenna(e.currentTarget.value)}
              placeholder="Inverted V dipole @ 40m"
              maxLength={40}
              class="w-52 rounded border border-[#30363d] bg-[#0d1117] px-2 py-1 text-sm text-[#c9d1d9] focus:border-[#388bfd] focus:outline-none"
            />
          </label>
        </div>

        <div class="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm text-[#c9d1d9]">
          <span class={labelClass}>Upload every</span>
          <label class="flex cursor-pointer items-center gap-2">
            <input
              type="radio"
              name="psk-cadence"
              checked={props.reporter.cadenceMode() === 'window'}
              onChange={() => setMode('window')}
              class="h-3.5 w-3.5 accent-[#2ea043]"
            />
            decode window
          </label>
          <label class="flex cursor-pointer items-center gap-2">
            <input
              type="radio"
              name="psk-cadence"
              checked={props.reporter.cadenceMode() === 'interval'}
              onChange={() => setMode('interval')}
              class="h-3.5 w-3.5 accent-[#2ea043]"
            />
            <input
              type="number"
              min={MIN_INTERVAL_MINUTES}
              max={MAX_INTERVAL_MINUTES}
              value={props.reporter.intervalMinutes()}
              disabled={props.reporter.cadenceMode() !== 'interval'}
              onChange={(e) => props.reporter.setIntervalMinutes(Number(e.currentTarget.value))}
              class="w-14 rounded border border-[#30363d] bg-[#0d1117] px-2 py-1 text-center font-mono text-sm text-[#c9d1d9] focus:border-[#388bfd] focus:outline-none disabled:opacity-40"
            />
            minutes
          </label>
        </div>

        <div class="grid grid-cols-2 gap-x-6 gap-y-1 rounded-md border border-[#30363d] bg-[#0d1117] p-3 text-xs sm:grid-cols-5">
          <div>
            <div class="text-[#8b949e]">State</div>
            <div class="text-[#c9d1d9]">{summary()}</div>
          </div>
          <div>
            <div class="text-[#8b949e]">Cadence</div>
            <div class="text-[#c9d1d9]">{cadenceLabel()}</div>
          </div>
          <div>
            <div class="text-[#8b949e]">Queued</div>
            <div class="font-mono text-[#c9d1d9]">{status().pending}</div>
          </div>
          <div>
            <div class="text-[#8b949e]">Last upload</div>
            <div class="text-[#c9d1d9]">{timeAgo(status().lastSentAt)}</div>
          </div>
          <div>
            <div class="text-[#8b949e]">Spots sent</div>
            <div class="font-mono text-[#c9d1d9]">{status().totalSpotsSent}</div>
          </div>
        </div>

        <Show when={status().lastError}>
          <p class="rounded-md border border-[#f85149]/40 bg-[#0d1117] p-3 text-xs text-[#f85149]">
            Last upload failed: {status().lastError}. Queued spots are retried.
          </p>
        </Show>

        <Show when={call()}>
          <a
            href={`https://pskreporter.info/pskmap#preset&callsign=${encodeURIComponent(call())}&txrx=rx&mode=${mapMode(props.mode)}&distunit=km`}
            target="_blank"
            rel="noreferrer"
            class="inline-block text-xs text-[#388bfd] hover:underline"
          >
            View what {call()} has reported →
          </a>
        </Show>
      </div>
    </details>
  )
}
