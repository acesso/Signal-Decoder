// Port of src/components/SessionCard.tsx (Next.js app). Solid props stay as
// a props object (not destructured) so field access remains reactive —
// destructuring would freeze values at first render, same footgun as
// forgetting a dependency array entry in React but silent here.
import { createEffect } from 'solid-js'
import { PASTEL_COLORS, type DecoderSession } from '$decoder-lib/rtty/sessions'
import type { RTTYConfig } from '$decoder-lib/rtty/decoder'
import { fmtAbsHz } from '$decoder-lib/formatFreq'
import NumberField from './NumberField'

const BAUD_RATES = [45, 45.45, 50, 65, 75, 100, 110, 150, 200, 300]
const inputCls =
  'bg-[#0d1117] border border-[#30363d] rounded px-1 py-0.5 text-[#c9d1d9] text-xs font-mono focus:outline-none focus:border-[#2ea043] transition-colors w-full'

interface Props {
  session: DecoderSession
  isActive: boolean
  canRemove: boolean
  vfoFrequency?: number
  onActivate: (id: string) => void
  onRemove: (id: string) => void
  onConfigChange: (id: string, patch: Partial<RTTYConfig>) => void
  onLabelChange: (id: string, label: string) => void
  onColorChange: (id: string, color: string) => void
}

export function SessionCard(props: Props) {
  const stopProp = (e: MouseEvent) => e.stopPropagation()

  let previewOuter: HTMLDivElement | undefined
  let previewInner: HTMLDivElement | undefined

  createEffect(() => {
    const preview = props.session.preview // reactive dependency
    const outer = previewOuter
    const inner = previewInner
    if (!outer || !inner) return
    void preview
    const overflow = inner.scrollHeight - outer.clientHeight
    inner.style.transform = overflow > 0 ? `translateY(-${overflow}px)` : ''
  })

  return (
    <div
      onClick={() => !props.isActive && props.onActivate(props.session.id)}
      style={{ 'border-color': `${props.session.color}60` }}
      class={`min-w-0 overflow-hidden rounded-lg border p-3 transition-all ${
        props.isActive ? 'cursor-default bg-[#161b22]' : 'cursor-pointer bg-[#0d1117] hover:brightness-110'
      }`}
    >
      {/* Header row */}
      <div class="mb-2 flex items-center justify-between gap-2">
        <div class="flex min-w-0 items-center gap-2">
          {props.isActive && (
            <span class="shrink-0 text-[10px] font-mono tracking-wide uppercase" style={{ color: props.session.color }}>
              ● active
            </span>
          )}
          <input
            value={props.session.label}
            onInput={(e) => {
              stopProp(e as unknown as MouseEvent)
              props.onLabelChange(props.session.id, e.currentTarget.value)
            }}
            onClick={stopProp}
            class="min-w-0 flex-1 truncate border-b border-transparent bg-transparent font-mono text-sm text-[#c9d1d9] focus:border-[#30363d] focus:outline-none"
          />
        </div>
        <div class="flex shrink-0 items-center gap-1.5">
          {!props.isActive && (
            <button
              onClick={(e) => {
                stopProp(e)
                props.onActivate(props.session.id)
              }}
              class="rounded border border-[#30363d] px-2 py-0.5 text-xs text-[#8b949e] transition-colors hover:border-[#2ea043]/40 hover:text-[#2ea043]"
            >
              Promote
            </button>
          )}
          {props.canRemove && (
            <button
              onClick={(e) => {
                stopProp(e)
                props.onRemove(props.session.id)
              }}
              class="rounded border border-[#30363d] px-2 py-0.5 text-xs text-[#8b949e] transition-colors hover:border-[#f85149]/40 hover:text-[#f85149]"
            >
              ✕
            </button>
          )}
        </div>
      </div>

      {/* 2x2 config grid */}
      <div class="mb-2 grid grid-cols-2 gap-x-2 gap-y-2" onClick={stopProp}>
        <label class="flex flex-col gap-0.5">
          <span class="text-[10px] text-[#8b949e]">Carrier Shift (Hz)</span>
          <NumberField
            value={props.session.config.carrierShift}
            min={1}
            onCommit={(n) => props.onConfigChange(props.session.id, { carrierShift: n })}
            onClick={stopProp}
            class={inputCls}
          />
        </label>

        <label class="flex flex-col gap-0.5">
          <span class="text-[10px] text-[#8b949e]">Center Freq (Hz)</span>
          {props.vfoFrequency ? (
            <span class={`${inputCls} block`}>{fmtAbsHz(props.vfoFrequency + props.session.config.centerFreq)}</span>
          ) : (
            <NumberField
              value={props.session.config.centerFreq}
              min={0}
              max={1500}
              onCommit={(n) => props.onConfigChange(props.session.id, { centerFreq: n })}
              onClick={stopProp}
              class={inputCls}
            />
          )}
        </label>

        <label class="flex flex-col gap-0.5">
          <span class="text-[10px] text-[#8b949e]">Baud Rate</span>
          <select
            value={props.session.config.baudRate}
            onChange={(e) => {
              stopProp(e as unknown as MouseEvent)
              props.onConfigChange(props.session.id, { baudRate: parseFloat(e.currentTarget.value) })
            }}
            onClick={stopProp}
            class={inputCls}
          >
            {BAUD_RATES.map((b) => (
              <option value={b}>{b}</option>
            ))}
          </select>
        </label>

        <div class="flex flex-col gap-0.5" onClick={stopProp}>
          <span class="text-[10px] text-[#8b949e]">Sideband</span>
          <button
            onClick={(e) => {
              stopProp(e)
              props.onConfigChange(props.session.id, { reverseShift: !props.session.config.reverseShift })
            }}
            class={`rounded border px-2 py-0.5 text-xs transition-colors ${
              props.session.config.reverseShift
                ? 'border-[#f0883e]/50 bg-[#f0883e]/10 text-[#f0883e]'
                : 'border-[#30363d] bg-[#0d1117] text-[#8b949e] hover:border-[#58a6ff]/40 hover:text-[#58a6ff]'
            }`}
          >
            {props.session.config.reverseShift ? 'LSB' : 'USB'}
          </button>
        </div>
      </div>

      {/* Color palette */}
      <div class="mb-2 flex flex-wrap gap-1" onClick={stopProp}>
        {PASTEL_COLORS.map((c) => (
          <button
            onClick={(e) => {
              stopProp(e)
              props.onColorChange(props.session.id, c)
            }}
            title={c}
            style={{
              'background-color': c,
              outline: c === props.session.color ? `2px solid ${c}` : 'none',
              'outline-offset': '2px',
              transform: c === props.session.color ? 'scale(1.25)' : 'scale(1)',
            }}
            class="h-4 w-4 rounded-full transition-all"
          />
        ))}
      </div>

      {/* Preview — overflow:hidden + translateY trick to always show the bottom */}
      <div
        ref={previewOuter}
        class={`overflow-hidden rounded px-2 py-1.5 font-mono text-xs ${props.isActive ? 'bg-[#0d1117]' : 'bg-[#0a0a0a]'}`}
        style={{ height: '3rem' }}
      >
        <div ref={previewInner}>
          {props.session.preview ? (
            <span class="break-all whitespace-pre-wrap" style={{ color: props.session.color }}>
              {props.session.preview}
            </span>
          ) : (
            <span class="text-[#30363d]">No output yet…</span>
          )}
        </div>
      </div>
    </div>
  )
}
