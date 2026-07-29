// Shared text input that avoids the same Firefox focus-loss bug documented
// in NumberField.tsx: binding `value` directly to a reactive signal causes
// Solid to reassign the DOM value on every keystroke's own onInput-triggered
// update, and Firefox drops focus/selection to <body> when that happens
// mid-edit. Fix: keep the DOM's own value as source of truth while focused
// (uncontrolled), only push the external/prop value in when unfocused.
import { createEffect, type JSX } from 'solid-js'

interface Props {
  value: string
  onCommit: (v: string) => void
  placeholder?: string
  class?: string
  title?: string
  onKeyDown?: (e: KeyboardEvent & { currentTarget: HTMLInputElement; target: Element }) => void
}

export default function TextField(props: Props): JSX.Element {
  let el: HTMLInputElement | undefined

  createEffect(() => {
    const v = props.value
    if (el && document.activeElement !== el) el.value = v
  })

  return (
    <input
      ref={el}
      type="text"
      value={props.value}
      placeholder={props.placeholder}
      title={props.title}
      class={props.class}
      onInput={(e) => props.onCommit(e.currentTarget.value)}
      onKeyDown={props.onKeyDown}
      onBlur={() => {
        if (el) el.value = props.value
      }}
    />
  )
}
