// Port of src/components/VirtualList.tsx (Next.js app).
//
// Dependency-free windowed list. Renders only the rows intersecting the
// scrollport (+ overscan), absolutely positioned inside a spacer sized to
// the full list height, so DOM size stays constant no matter how many items
// exist. Row heights come from a callback (prefix-summed once per
// items/heightsVersion change), which keeps mixed-height rows cheap —
// message rows vs window separators, collapsed vs expanded contact cards.
//
// Bump `heightsVersion` whenever itemHeight would return new values for the
// same items (e.g. a card expanded) — heights are intentionally not
// re-measured per render.
import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, type JSX } from 'solid-js'

interface Props<T> {
  items: T[]
  itemKey: (item: T, index: number) => string
  /** must be fast — called once per item per (items, heightsVersion) change */
  itemHeight: (item: T, index: number) => number
  renderItem: (item: T, index: number) => JSX.Element
  overscan?: number
  /** classes for the scroll container (must produce a bounded, scrollable box) */
  class?: string
  heightsVersion?: number
  /** when >= 0, smooth-scrolls that index into view (re-triggers on change) */
  scrollToIndex?: number
  empty?: JSX.Element
  /**
   * For lists where new items are PREPENDED (newest-first feeds): when the
   * user has scrolled away from the top, keep whatever content they're
   * reading pinned in place as new rows land above it, instead of silently
   * shifting everything down by the height of what just arrived. Anchors on
   * the first key shared between the old and new item lists. Does nothing
   * while scrolled to (or within a few px of) the top, so watching new items
   * arrive live still works as expected.
   */
  preserveScrollOnPrepend?: boolean
}

export default function VirtualList<T>(props: Props<T>): JSX.Element {
  let scrollEl: HTMLDivElement | undefined
  let viewportTop = 0
  let viewportHeight = 0
  let rafId: number | null = null

  // Reactive "tick" so the visible-range recompute below re-runs on scroll —
  // plain mutable vars (viewportTop/Height) aren't tracked by Solid, so we
  // pair them with a signal that IS tracked, bumped only when they change.
  const overscan = () => props.overscan ?? 6

  const offsets = createMemo(() => {
    const items = props.items
    void props.heightsVersion // tracked dependency — bump to force recompute
    const off = new Float64Array(items.length + 1)
    for (let i = 0; i < items.length; i++) off[i + 1] = off[i] + props.itemHeight(items[i], i)
    return off
  })
  const totalHeight = createMemo(() => {
    const items = props.items
    const off = offsets()
    return items.length ? off[items.length] : 0
  })

  let prev: { items: T[]; offsets: Float64Array; keys: Map<string, number> } | null = null

  // Scroll-preservation on prepend — runs whenever items/offsets change,
  // BEFORE the visible-range recompute below reads the (possibly just
  // adjusted) scrollTop, mirroring the original's useLayoutEffect ordering.
  createEffect(
    on(
      () => [props.items, offsets()] as const,
      ([items, offs]) => {
        const el = scrollEl
        if (props.preserveScrollOnPrepend && el && prev && prev.items.length > 0 && items.length > 0) {
          if (el.scrollTop > 4) {
            for (let i = 0; i < items.length; i++) {
              const key = props.itemKey(items[i], i)
              const prevIndex = prev.keys.get(key)
              if (prevIndex !== undefined) {
                const shift = offs[i] - prev.offsets[prevIndex]
                if (shift !== 0) el.scrollTop += shift
                break
              }
            }
          }
        }
        prev = { items, offsets: offs, keys: new Map(items.map((it, i) => [props.itemKey(it, i), i])) }
        // Re-derive the visible range now that scrollTop may have changed.
        if (el) {
          viewportTop = el.scrollTop
          viewportHeight = el.clientHeight
          triggerRecompute()
        }
      },
    ),
  )

  // Visible-range recompute is driven by a signal bumped on scroll/resize —
  // recomputing the binary search inside a memo that only depends on a
  // "tick" counter (not on viewportTop directly) avoids re-running it for
  // every intermediate value during a drag; the tick coalesces via rAF.
  const [tick, setTick] = createSignal(0)
  function triggerRecompute() {
    setTick((t) => t + 1)
  }

  onMount(() => {
    const el = scrollEl
    if (!el) return
    const update = () => {
      rafId = null
      const next = { top: el.scrollTop, height: el.clientHeight }
      if (viewportTop !== next.top || viewportHeight !== next.height) {
        viewportTop = next.top
        viewportHeight = next.height
        triggerRecompute()
      }
    }
    const onScroll = () => {
      if (rafId === null) rafId = requestAnimationFrame(update)
    }
    update()
    el.addEventListener('scroll', onScroll, { passive: true })
    const ro = new ResizeObserver(onScroll)
    ro.observe(el)
    onCleanup(() => {
      el.removeEventListener('scroll', onScroll)
      ro.disconnect()
      if (rafId !== null) cancelAnimationFrame(rafId)
    })
  })

  createEffect(
    on(
      () => props.scrollToIndex,
      (scrollToIndex) => {
        if (scrollToIndex === undefined || scrollToIndex < 0 || scrollToIndex >= props.items.length || !scrollEl) return
        const el = scrollEl
        const offs = offsets()
        const top = offs[scrollToIndex]
        const bottom = offs[scrollToIndex + 1]
        if (top < el.scrollTop || bottom > el.scrollTop + el.clientHeight) {
          el.scrollTo({ top: Math.max(0, top - 8), behavior: 'smooth' })
        }
      },
      { defer: true },
    ),
  )

  const visibleRange = createMemo(() => {
    void tick()
    const items = props.items
    const offs = offsets()
    let lo = 0,
      hi = items.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (offs[mid + 1] <= viewportTop) lo = mid + 1
      else hi = mid
    }
    const start = Math.max(0, lo - overscan())
    let end = lo
    const viewBottom = viewportTop + viewportHeight
    while (end < items.length && offs[end] < viewBottom) end++
    end = Math.min(items.length, end + overscan())
    return { start, end }
  })

  const visibleItems = createMemo(() => {
    const { start, end } = visibleRange()
    const items = props.items
    const offs = offsets()
    const out: { item: T; index: number; top: number; height: number; key: string }[] = []
    for (let i = start; i < end; i++) {
      out.push({ item: items[i], index: i, top: offs[i], height: offs[i + 1] - offs[i], key: props.itemKey(items[i], i) })
    }
    return out
  })

  return (
    <div ref={scrollEl} class={props.class ?? ''}>
      {props.items.length === 0 ? (
        (props.empty ?? null)
      ) : (
        <div style={{ height: `${totalHeight()}px`, position: 'relative' }}>
          <For each={visibleItems()}>
            {(v) => (
              <div style={{ position: 'absolute', top: `${v.top}px`, left: 0, right: 0, height: `${v.height}px` }}>
                {props.renderItem(v.item, v.index)}
              </div>
            )}
          </For>
        </div>
      )}
    </div>
  )
}
