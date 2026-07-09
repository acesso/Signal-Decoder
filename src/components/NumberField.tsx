// Shared numeric text input that avoids a real Firefox bug: a `type="number"`
// input whose `value` is bound directly to a reactive signal gets its value
// (and focus) reset mid-edit — the instant the signal updates from the
// input's own `onInput` handler (e.g. after Backspace empties the field, or
// after any keystroke that changes the parsed number), Solid reactively
// reassigns the DOM `value` property, and Firefox drops focus to <body> when
// that happens while the element is still being typed into. This has hit
// several fields across this app (RTTY session config, MFSK frame/tone
// settings) as "my keystrokes get eaten" / "I can't type more than one digit".
//
// Fix: keep the DOM's own value as the source of truth while focused (an
// uncontrolled input), and only push the external/prop value in when the
// element does NOT have focus — so external updates (drag-to-set, preset
// load, another control changing the same value) still sync correctly, but
// the user's own typing is never fought mid-edit.
import { createEffect, type JSX } from 'solid-js'

interface Props {
  value: number
  onCommit: (n: number) => void
  min?: number
  max?: number
  step?: number
  class?: string
  /** Parse+clamp a candidate string; return null to reject (leave DOM as-is, no commit). Default: parseFloat + min/max clamp. */
  parse?: (raw: string) => number | null
  onBlurExtra?: () => void
  readOnly?: boolean
  disabled?: boolean
  title?: string
  onClick?: (e: MouseEvent) => void
}

function defaultParse(raw: string, min?: number, max?: number): number | null {
  const n = parseFloat(raw)
  if (!Number.isFinite(n)) return null
  let v = n
  if (min !== undefined) v = Math.max(min, v)
  if (max !== undefined) v = Math.min(max, v)
  return v
}

export default function NumberField(props: Props): JSX.Element {
  let el: HTMLInputElement | undefined

  createEffect(() => {
    const v = props.value
    if (el && document.activeElement !== el) el.value = String(v)
  })

  const clamp = (n: number) => {
    let v = n
    if (props.min !== undefined) v = Math.max(props.min, v)
    if (props.max !== undefined) v = Math.min(props.max, v)
    return v
  }

  const step = (dir: 1 | -1) => {
    if (props.disabled || props.readOnly || !props.step) return
    const next = clamp(props.value + dir * props.step)
    props.onCommit(next)
  }

  const input = (
    <input
      ref={el}
      type="text"
      inputmode="decimal"
      value={String(props.value)}
      readOnly={props.readOnly}
      disabled={props.disabled}
      title={props.title}
      onClick={props.onClick}
      onInput={(e) => {
        const parsed = (props.parse ?? ((raw: string) => defaultParse(raw, props.min, props.max)))(e.currentTarget.value)
        if (parsed !== null) props.onCommit(parsed)
      }}
      onBlur={() => {
        // Snap back to the authoritative value on blur — covers the case
        // where the field was left empty, mid-edit, or otherwise unparsed.
        if (el) el.value = String(props.value)
        props.onBlurExtra?.()
      }}
      class={props.step ? `${props.class ?? ''} pr-5` : props.class}
    />
  )

  // step is opt-in: only fields that pass it get the up/down spin buttons,
  // so existing call sites (e.g. RadioCATPanel) render exactly as before.
  if (!props.step) return input

  return (
    <div class="relative inline-flex">
      {input}
      <div class="absolute right-0.5 top-0 bottom-0 flex flex-col justify-center">
        <button
          type="button"
          tabIndex={-1}
          disabled={props.disabled || props.readOnly}
          onClick={() => step(1)}
          class="leading-none text-[8px] px-0.5 text-[#8b949e] hover:text-[#c9d1d9] disabled:opacity-30 disabled:cursor-not-allowed"
        >▲</button>
        <button
          type="button"
          tabIndex={-1}
          disabled={props.disabled || props.readOnly}
          onClick={() => step(-1)}
          class="leading-none text-[8px] px-0.5 text-[#8b949e] hover:text-[#c9d1d9] disabled:opacity-30 disabled:cursor-not-allowed"
        >▼</button>
      </div>
    </div>
  )
}
