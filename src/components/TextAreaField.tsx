// Multi-line sibling of TextField — same uncontrolled-while-focused pattern
// (see TextField.tsx for the Firefox focus-loss bug this avoids), but a
// <textarea> so Enter inserts a real newline instead of doing nothing/
// submitting, letting the operator control line breaks manually.
import { createEffect, type JSX } from 'solid-js'

interface Props {
  value: string
  onCommit: (v: string) => void
  placeholder?: string
  class?: string
  title?: string
  rows?: number
}

export default function TextAreaField(props: Props): JSX.Element {
  let el: HTMLTextAreaElement | undefined

  createEffect(() => {
    const v = props.value
    if (el && document.activeElement !== el) el.value = v
  })

  return (
    <textarea
      ref={el}
      value={props.value}
      placeholder={props.placeholder}
      title={props.title}
      rows={props.rows ?? 3}
      class={props.class}
      onInput={(e) => props.onCommit(e.currentTarget.value)}
      onBlur={() => {
        if (el) el.value = props.value
      }}
    />
  )
}
