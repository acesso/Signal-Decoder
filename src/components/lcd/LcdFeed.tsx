// The web app's views on the bridge's status LCD (doc/plans/lcd-client-views/PLAN.md).
//
// <LcdFeedProvider> holds the one /display-ws feed (src/lib/lcd/feed.ts) while
// the app's CAT is connected through a bridge that supports client views, and the boxes the
// user picked for it. <LcdMenu> (in the header, shown only with such a
// bridge) lists them and starts the picker: like a browser's screenshot
// tool, the box under the mouse is outlined, the arrow keys widen or narrow
// it, a click puts it on the LCD (lib/lcd/elementSource.ts draws it). Boxes
// with a view made for the LCD (data-lcd-view) are outlined with a ★ badge
// all the while, and the outline snaps to them. Picks are remembered (by
// view name, or by selector) and come back when the page reloads.

import { createContext, createEffect, createMemo, createSignal, For, Index, onCleanup, onMount, Show, useContext, type Accessor, type JSX } from 'solid-js'
import { Portal } from 'solid-js/web'
import { bridgeHttpUrl } from '$decoder-lib/audio/bridgeSlots'
import { LcdFeed, lcdFeedUrl, type LcdFeedState } from '$decoder-lib/lcd/feed'
import { elementSource, lcdViewBoxes, lcdViewPicked, selectorFor, titleFor, type ElementLcdSource, type LcdViewRef } from '$decoder-lib/lcd/elementSource'

export interface LcdPick {
  id: string
  title: string
  /** A view made for the LCD, "<kind>[:<arg>]" (elementSource.ts)... */
  view?: string
  /** ...or a plain box, by selector. */
  selector?: string
  /** -5..5, see elementSource; 0 when missing. */
  contrast?: number
  /** Shown while the radio is keyed. */
  focusOnTx?: boolean
}

interface LcdContextValue {
  feed: Accessor<LcdFeed | null>
  state: Accessor<LcdFeedState | null>
  picks: Accessor<LcdPick[]>
  setPicks: (p: LcdPick[]) => void
}

const LcdContext = createContext<LcdContextValue>()

const INFO_RETRY_MS = 15000
const PICKS_KEY = 'lcd-picks'
/** The bridge's client view slots. */
export const LCD_MAX_PICKS = 4

function loadPicks(): LcdPick[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(PICKS_KEY) ?? '[]')
    if (Array.isArray(v) && v.every((p) => p && typeof p.id === 'string' && typeof p.title === 'string' &&
                                           (typeof p.selector === 'string' || typeof p.view === 'string') &&
                                           (p.contrast === undefined || typeof p.contrast === 'number') &&
                                           (p.focusOnTx === undefined || typeof p.focusOnTx === 'boolean')))
      return v.slice(0, LCD_MAX_PICKS)
  } catch { /* malformed: start empty */ }
  return []
}

export function LcdFeedProvider(props: { bridgeWsUrl: string | undefined; children: JSX.Element }) {
  const [feed, setFeed] = createSignal<LcdFeed | null>(null)
  const [state, setState] = createSignal<LcdFeedState | null>(null)
  const [picks, setPicksSignal] = createSignal<LcdPick[]>(loadPicks())
  const setPicks = (p: LcdPick[]) => { setPicksSignal(p); localStorage.setItem(PICKS_KEY, JSON.stringify(p)) }

  // The URL comes from CAT state, which changes on every S-meter or frequency
  // report: only a different URL may rebuild the feed.
  const bridgeWsUrl = createMemo(() => props.bridgeWsUrl)
  createEffect(() => {
    const ws = bridgeWsUrl()
    const info = ws ? bridgeHttpUrl(ws, '/info') : null
    const url = ws ? lcdFeedUrl(ws) : null
    let cancelled = false
    let current: LcdFeed | null = null
    let retry: ReturnType<typeof setTimeout> | undefined
    onCleanup(() => {
      cancelled = true
      clearTimeout(retry)
      current?.close()
      setFeed(null)
      setState(null)
    })
    if (!info || !url) return
    // Only a bridge with the feature gets the socket; an unreachable one is asked again later.
    const check = () => {
      fetch(info)
        .then((r) => (r.ok ? r.json() : null))
        .then((j: { features?: string[] } | null) => {
          if (cancelled) return
          if (!j) { retry = setTimeout(check, INFO_RETRY_MS); return }
          if (!j.features?.includes('display_client_views')) return
          current = new LcdFeed(url, setState)
          setFeed(current)
        })
        .catch(() => { if (!cancelled) retry = setTimeout(check, INFO_RETRY_MS) })
    }
    check()
  })

  // Each pick is a view on the feed for as long as both exist. A contrast
  // change goes to the running source; a new title, box or focus re-registers it.
  createEffect(() => {
    const f = feed()
    if (!f) return
    const live = new Map<string, { pick: LcdPick; source: ElementLcdSource; remove: () => void }>()
    createEffect(() => {
      const now = picks()
      for (const [id, v] of live)
        if (!now.some((p) => p.id === id)) { v.remove(); live.delete(id) }
      for (const p of now) {
        const v = live.get(p.id)
        if (v && v.pick.title === p.title && v.pick.selector === p.selector && v.pick.view === p.view && !!v.pick.focusOnTx === !!p.focusOnTx) {
          v.source.setContrast(p.contrast ?? 0)
          v.pick = p
          continue
        }
        v?.remove()
        const source = elementSource({ id: p.id, title: p.title, view: p.view, selector: p.selector, fps: 2, contrast: p.contrast, focusOnTx: p.focusOnTx })
        live.set(p.id, { pick: p, source, remove: f.add(source) })
      }
    })
    onCleanup(() => { for (const v of live.values()) v.remove() })
  })

  return <LcdContext.Provider value={{ feed, state, picks, setPicks }}>{props.children}</LcdContext.Provider>
}

/** The feed to the bridge's LCD while there is one (null otherwise): for overlays. */
export function useLcdFeed(): Accessor<LcdFeed | null> {
  return useContext(LcdContext)?.feed ?? (() => null)
}

// ── The picker ─────────────────────────────────────────────────────────────

// What a pick is: a view made for the LCD, or a plain box.
type Picked = { view: LcdViewRef } | { el: Element }

function LcdPicker(props: { onPick: (p: Picked) => void; onCancel: () => void }) {
  const [target, setTarget] = createSignal<Element | null>(null)
  const [rect, setRect] = createSignal<DOMRect | null>(null)
  // The boxes with a view made for the LCD, outlined all the while.
  const [marks, setMarks] = createSignal<{ rect: DOMRect; title: string }[]>([])
  let narrower: Element[] = [] // the boxes ArrowUp left, for ArrowDown
  let raw: Element | null = null // the element under the pointer
  let base: Element | null = null // where ↑/↓ start: raw, or the marked box it is in

  const aim = (el: Element | null) => {
    setTarget(el)
    setRect(el ? el.getBoundingClientRect() : null)
  }
  const under = (x: number, y: number) => {
    const el = document.elementFromPoint(x, y)
    return el && el !== document.documentElement && el !== document.body ? el : null
  }
  const refreshMarks = () => {
    const vh = window.innerHeight, vw = window.innerWidth
    setMarks(lcdViewBoxes().flatMap((m) => {
      const r = m.shownAt.getBoundingClientRect()
      return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < vh && r.left < vw ? [{ rect: r, title: m.def.title(m.arg) }] : []
    }))
  }

  const block = (e: Event) => { e.preventDefault(); e.stopPropagation() }
  // Inside a marked box the outline snaps to it; ↓ goes to the plain element
  // under the pointer instead. A widened outline stays while the pointer stays
  // over the same element (a click comes with a little movement).
  const onMove = (e: MouseEvent) => {
    const el = under(e.clientX, e.clientY)
    if (el === raw) return
    raw = el
    base = (el && lcdViewPicked(el)?.shownAt) ?? el
    narrower = []
    aim(base)
  }
  const onClick = (e: MouseEvent) => {
    block(e)
    pick()
  }
  const onKey = (e: KeyboardEvent) => {
    const el = target()
    if (e.key === 'Escape') { block(e); props.onCancel() }
    else if (e.key === 'Enter' && el) { block(e); pick() }
    else if (e.key === 'ArrowUp' && el?.parentElement && el.parentElement !== document.body) { block(e); narrower.push(el); aim(el.parentElement) }
    else if (e.key === 'ArrowDown') { block(e); aim(narrower.pop() ?? (el === base && raw !== base ? raw : base ?? el)) }
  }
  const onScroll = () => { const el = target(); if (el) setRect(el.getBoundingClientRect()); refreshMarks() }

  onMount(() => {
    const opts = { capture: true }
    window.addEventListener('mousemove', onMove, opts)
    window.addEventListener('click', onClick, opts)
    for (const t of ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'dblclick', 'contextmenu'] as const) window.addEventListener(t, block, opts)
    window.addEventListener('keydown', onKey, opts)
    window.addEventListener('scroll', onScroll, opts)
    refreshMarks()
    const every = setInterval(refreshMarks, 500) // the page keeps changing under us (new contacts)
    onCleanup(() => {
      clearInterval(every)
      window.removeEventListener('mousemove', onMove, opts)
      window.removeEventListener('click', onClick, opts)
      for (const t of ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'dblclick', 'contextmenu'] as const) window.removeEventListener(t, block, opts)
      window.removeEventListener('keydown', onKey, opts)
      window.removeEventListener('scroll', onScroll, opts)
    })
  })

  // The target stands for a view when it is exactly where a marked box shows.
  const made = () => { const el = target(); const v = el ? lcdViewPicked(el) : undefined; return v && v.shownAt === el ? v : undefined }
  const pick = () => { const el = target(); if (!el) return; const v = made(); props.onPick(v ? { view: v } : { el }) }

  return (
    <Portal>
      <div class="pointer-events-none fixed inset-0 z-[10000] cursor-crosshair">
        <For each={marks()}>
          {(m) => (
            <>
              <div
                class="absolute rounded-sm border border-dashed border-[#d29922]/80"
                style={{ left: `${m.rect.left}px`, top: `${m.rect.top}px`, width: `${m.rect.width}px`, height: `${m.rect.height}px` }}
              />
              <div
                class="absolute whitespace-nowrap rounded-bl rounded-tr-sm bg-[#9e6a03] px-1 font-mono text-[9px] leading-4 text-white"
                style={{ left: `${m.rect.right}px`, top: `${m.rect.top}px`, transform: 'translateX(-100%)' }}
              >
                ★ LCD view
              </div>
            </>
          )}
        </For>
        <div class="absolute top-3 left-1/2 -translate-x-1/2 rounded-md border border-[#30363d] bg-[#161b22]/95 px-3 py-1.5 text-xs text-[#c9d1d9] shadow-lg">
          Pick a box for the LCD: click it · <kbd>↑</kbd> wider · <kbd>↓</kbd> narrower · <kbd>Esc</kbd> cancel
          <span class="ml-2 text-[#d29922]">★ boxes have a view made for the LCD</span>
        </div>
        <Show when={rect()}>
          {(r) => (
            <>
              <div
                class={`absolute rounded-sm border-2 ${made() ? 'border-[#d29922] bg-[#d29922]/15' : 'border-[#3fb950] bg-[#3fb950]/10'}`}
                style={{ left: `${r().left}px`, top: `${r().top}px`, width: `${r().width}px`, height: `${r().height}px` }}
              />
              <div
                class={`absolute rounded px-1.5 py-px font-mono text-[10px] text-white ${made() ? 'bg-[#9e6a03]' : 'bg-[#238636]'}`}
                style={{ left: `${r().left}px`, top: `${Math.max(0, r().top - 18)}px` }}
              >
                {made() ? `★ ${made()!.def.title(made()!.arg)} · LCD view` : `${titleFor(target()!)} · ${Math.round(r().width)}×${Math.round(r().height)}`}
              </div>
            </>
          )}
        </Show>
      </div>
    </Portal>
  )
}

// ── The header menu ────────────────────────────────────────────────────────

const STATUS_DOT: Record<string, string> = {
  live: 'bg-[#3fb950]',
  waiting: 'bg-[#d29922]',
  full: 'bg-[#f85149]',
}

/** The "LCD" button and its menu: the boxes on the LCD, and the picker. */
export function LcdMenu() {
  const ctx = useContext(LcdContext)
  if (!ctx) return null
  const [open, setOpen] = createSignal(false)
  const [picking, setPicking] = createSignal(false)
  let root: HTMLDivElement | undefined

  const onDocClick = (e: MouseEvent) => { if (open() && root && !root.contains(e.target as Node)) setOpen(false) }
  onMount(() => document.addEventListener('click', onDocClick))
  onCleanup(() => document.removeEventListener('click', onDocClick))

  const add = (picked: Picked) => {
    setPicking(false)
    const made = 'view' in picked ? picked.view : undefined
    const pick: Omit<LcdPick, 'id'> = made
      ? { view: made.view, title: made.def.title(made.arg).toUpperCase().slice(0, 15), focusOnTx: made.def.focusOnTx }
      : { selector: selectorFor((picked as { el: Element }).el), title: titleFor((picked as { el: Element }).el) }
    const existing = ctx.picks().find((p) => (made ? p.view === pick.view : p.selector === pick.selector))
    if (existing) { ctx.feed()?.show(existing.id); return }
    const id = `pick-${Date.now().toString(36)}`
    ctx.setPicks([...ctx.picks(), { id, ...pick }])
    queueMicrotask(() => ctx.feed()?.show(id)) // after the effect has added it; the feed waits for its first picture
  }
  const [tuning, setTuning] = createSignal<string | null>(null)
  const setContrast = (id: string, contrast: number) =>
    ctx.setPicks(ctx.picks().map((q) => (q.id === id ? { ...q, contrast } : q)))
  const rename = (p: LcdPick) => {
    const t = window.prompt('Title on the LCD (capitals, digits, - . : / + %)', p.title)
    if (t === null) return
    ctx.setPicks(ctx.picks().map((q) => (q.id === p.id ? { ...q, title: t.toUpperCase().slice(0, 15) || q.title } : q)))
  }

  // Shown only while the feed is up: a bridge with an LCD, connected.
  return (
    <Show when={ctx.feed() && ctx.state()?.connected}>
      <div ref={root} class="relative self-start sm:self-auto">
        <button
          type="button"
          class={`rounded-md border px-3 py-1.5 text-sm font-semibold transition-colors ${open() ? 'border-[#8b949e] text-[#c9d1d9]' : 'border-[#30363d] text-[#8b949e] hover:text-[#c9d1d9]'}`}
          title="Put parts of this page on the bridge's LCD"
          onClick={() => setOpen(!open())}
        >
          LCD{ctx.picks().length ? ` · ${ctx.picks().length}` : ''}
        </button>
        <Show when={open()}>
          <div class="absolute right-0 z-50 mt-1 w-72 rounded-lg border border-[#30363d] bg-[#161b22] p-2 text-sm shadow-xl">
            <Index each={ctx.picks()} fallback={<p class="px-1 py-1 text-xs text-[#8b949e]">Nothing on the LCD from this page yet.</p>}>
              {(p) => (
                <>
                <div class="flex items-center gap-2 rounded px-1 py-1 hover:bg-[#21262d]">
                  <span class={`h-2 w-2 shrink-0 rounded-full ${STATUS_DOT[ctx.state()?.sources[p().id] ?? 'waiting'] ?? STATUS_DOT.waiting}`}
                    title={ctx.state()?.sources[p().id] === 'full' ? 'The bridge has no free view slot' : ctx.state()?.sources[p().id] === 'live' ? 'On the LCD' : 'Waiting for the bridge'} />
                  <button type="button" class="min-w-0 flex-1 truncate text-left font-mono text-xs text-[#c9d1d9]" title="Show it on the LCD now" onClick={() => ctx.feed()?.show(p().id)}>{p().title}</button>
                  <button type="button" class={`text-xs hover:text-[#c9d1d9] ${tuning() === p().id ? 'text-[#c9d1d9]' : 'text-[#8b949e]'}`} title="Contrast" onClick={() => setTuning(tuning() === p().id ? null : p().id)}>
                    <svg viewBox="0 0 12 12" class="h-3 w-3" aria-hidden="true"><circle cx="6" cy="6" r="5" fill="none" stroke="currentColor" stroke-width="1.5" /><path d="M6 1a5 5 0 0 1 0 10z" fill="currentColor" /></svg>
                  </button>
                  <button type="button"
                    class={`rounded px-1 text-[9px] font-bold leading-3 ${p().focusOnTx ? 'bg-[#da3633]/25 text-[#f85149]' : 'text-[#484f58] hover:text-[#8b949e]'}`}
                    title={p().focusOnTx ? 'Shown on the LCD while transmitting. Click to stop.' : 'Show it on the LCD while transmitting'}
                    onClick={() => ctx.setPicks(ctx.picks().map((q) => (q.id === p().id ? { ...q, focusOnTx: !q.focusOnTx } : q)))}>TX</button>
                  <button type="button" class="text-xs text-[#8b949e] hover:text-[#c9d1d9]" title="Rename" onClick={() => rename(p())}>✎</button>
                  <button type="button" class="text-xs text-[#8b949e] hover:text-[#f85149]" title="Take it off the LCD" onClick={() => ctx.setPicks(ctx.picks().filter((q) => q.id !== p().id))}>✕</button>
                </div>
                <Show when={tuning() === p().id}>
                  <label class="flex items-center gap-2 px-1 pb-1 text-[10px] text-[#8b949e]" title="Fewer or more lit pixels on the LCD, for a box that comes out too bright or too dark">
                    lighter
                    <input
                      type="range" min="-5" max="5" step="1" value={p().contrast ?? 0}
                      class="min-w-0 flex-1 accent-[#238636]"
                      onInput={(e) => setContrast(p().id, Number(e.currentTarget.value))}
                    />
                    darker
                  </label>
                </Show>
                </>
              )}
            </Index>
            <button
              type="button"
              disabled={ctx.picks().length >= LCD_MAX_PICKS}
              class="mt-1 w-full rounded-md bg-[#238636] px-3 py-1.5 text-sm font-semibold text-white transition-colors hover:bg-[#2ea043] disabled:cursor-not-allowed disabled:opacity-50"
              title={ctx.picks().length >= LCD_MAX_PICKS ? `The bridge takes ${LCD_MAX_PICKS} views from clients` : 'Then click any box on the page'}
              onClick={(e) => { e.stopPropagation(); setOpen(false); setPicking(true) }}
            >
              Pick a box…
            </button>
          </div>
        </Show>
        <Show when={picking()}>
          <LcdPicker onPick={add} onCancel={() => setPicking(false)} />
        </Show>
      </div>
    </Show>
  )
}
