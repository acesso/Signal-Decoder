// An LCD view of what the user picked on the page (components/lcd/LcdFeed.tsx).
//
// A box marked data-lcd-view="<kind>[:<arg>]" has a view made for the LCD: the
// component that draws that kind registers it (registerLcdView), and the pick
// keeps the view's name, not the box, so it lives on when the page re-renders,
// re-sorts or scrolls the box away (a contact card in a virtual list). Such
// views read far better on 84 x 39 one-bit pixels than a shrunken screenshot.
//
// Any other picked box is drawn the best way available:
//   1. a canvas filling most of the element (the waterfall, a spectrum, an
//      SSTV picture): mirrored straight from the canvas, at the view's rate,
//      dithered (grey levels as pixel density);
//   2. anything else: the element rasterized (html-to-image, which redraws it
//      through an SVG foreignObject) about once a second, in the background,
//      the last picture shown meanwhile; cut at a threshold, which keeps text
//      crisper than a dither.
// Either way the picture keeps its shape: scaled to fit and centred.
// A plain box is found again by its selector when the page replaces it.

import { toCanvas } from 'html-to-image'
import { LCD_BODY_TOP, LCD_H, LCD_W, ON, type Gfx } from './gfx'
import type { LcdSource } from './feed'
import { brightness, drawLevels, stretch } from './levels'

const AREA_H = LCD_H - LCD_BODY_TOP
const RASTER_EVERY_MS = 1000

/** A kind of LCD view (one per component that draws it), drawn for its argument. */
export interface LcdViewKind {
  /** The title a new pick of it gets. */
  title(arg: string): string
  /** Draws it into the area under the title bar. */
  draw(g: Gfx, tick: number, arg: string): void
  /** A new pick of it is shown while the radio is keyed. */
  focusOnTx?: boolean
}

/** The attribute that marks a box with a view made for the LCD: "<kind>" or "<kind>:<arg>". */
export const LCD_VIEW_ATTR = 'data-lcd-view'

const kinds = new Map<string, LcdViewKind>()

/** Registers a kind of LCD view; returns a function that takes it back. */
export function registerLcdView(kind: string, def: LcdViewKind): () => void {
  kinds.set(kind, def)
  return () => { if (kinds.get(kind) === def) kinds.delete(kind) }
}

export interface LcdViewRef {
  /** "<kind>[:<arg>]", what a pick keeps. */
  view: string
  arg: string
  def: LcdViewKind
}

/** A view name to its registered kind, or undefined (unknown, or its component is not on the page). */
export function lcdViewNamed(view: string): LcdViewRef | undefined {
  const i = view.indexOf(':')
  const def = kinds.get(i < 0 ? view : view.slice(0, i))
  return def ? { view, arg: i < 0 ? '' : view.slice(i + 1), def } : undefined
}

/** The marked box the element is in (itself or its nearest marked ancestor) with a registered view. */
export function lcdViewFor(el: Element): (LcdViewRef & { el: Element }) | undefined {
  const box = el.closest(`[${LCD_VIEW_ATTR}]`)
  const ref = box ? lcdViewNamed(box.getAttribute(LCD_VIEW_ATTR) ?? '') : undefined
  return box && ref ? { ...ref, el: box } : undefined
}

/** Where a marked box shows on the page: itself, or, inside a collapsed
 *  <details>, that section's <summary> (the box is hidden there). */
export function lcdViewShownAt(box: Element): Element {
  const closed = box.closest('details:not([open])')
  const summary = closed?.querySelector(':scope > summary')
  return summary && !summary.contains(box) ? summary : box
}

/** Every marked box on the page with a registered view, with where it shows. */
export function lcdViewBoxes(): (LcdViewRef & { el: Element; shownAt: Element })[] {
  return [...document.querySelectorAll(`[${LCD_VIEW_ATTR}]`)].flatMap((el) => {
    const ref = lcdViewNamed(el.getAttribute(LCD_VIEW_ATTR) ?? '')
    return ref ? [{ ...ref, el, shownAt: lcdViewShownAt(el) }] : []
  })
}

/** The view an element stands for in the picker: inside a marked box, that
 *  box's; on the header of a collapsed section, the marked box hidden in it. */
export function lcdViewPicked(el: Element): (LcdViewRef & { el: Element; shownAt: Element }) | undefined {
  const own = lcdViewFor(el)
  if (own) return { ...own, shownAt: lcdViewShownAt(own.el) }
  const summary = el.closest('summary')
  const details = summary?.parentElement
  if (!summary || !details || details.tagName !== 'DETAILS' || (details as HTMLDetailsElement).open) return undefined
  return lcdViewBoxes().find((b) => b.shownAt === summary)
}

/** The canvas that fills most (60 %+) of the element, if any. */
export function dominantCanvas(el: Element): HTMLCanvasElement | null {
  if (el instanceof HTMLCanvasElement) return el
  const box = el.getBoundingClientRect()
  const area = box.width * box.height
  if (!area) return null
  let best: HTMLCanvasElement | null = null, bestArea = 0
  for (const c of el.querySelectorAll('canvas')) {
    const r = c.getBoundingClientRect()
    if (r.width * r.height > bestArea) { best = c; bestArea = r.width * r.height }
  }
  return bestArea >= 0.6 * area ? best : null
}

const cssEscape = (s: string) =>
  typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(s) : s.replace(/^\d|[^\w-]/g, (c) => `\\${c.charCodeAt(0).toString(16)} `)

/** A CSS selector that finds the element again: a path from the nearest ancestor with an id. */
export function selectorFor(el: Element): string {
  const parts: string[] = []
  for (let e: Element | null = el; e && e !== document.documentElement; e = e.parentElement) {
    if (e.id) { parts.unshift(`#${cssEscape(e.id)}`); break }
    const parent: Element | null = e.parentElement
    const tag = e.tagName.toLowerCase()
    const same = parent ? [...parent.children].filter((c) => c.tagName === e!.tagName) : []
    parts.unshift(same.length > 1 ? `${tag}:nth-of-type(${same.indexOf(e) + 1})` : tag)
  }
  return parts.join(' > ')
}

/** A title for a picked element: its own or the nearest preceding heading, else its tag. */
export function titleFor(el: Element): string {
  const HEADING = 'h1,h2,h3,h4,summary,legend'
  // A heading's own words, not those of chips or badges nested in it.
  const words = (h: Element | null | undefined) => {
    if (!h) return undefined
    const own = [...h.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent).join(' ').trim()
    return own || h.textContent?.trim()
  }
  const heading = (e: Element | null) => words(e?.matches(HEADING) ? e : e?.querySelector(HEADING))
  let t = heading(el)
  for (let e: Element | null = el; !t && e; e = e.parentElement) {
    for (let s = e.previousElementSibling; !t && s; s = s.previousElementSibling)
      if (s.matches(HEADING)) t = words(s) // a heading just before it, not one inside another panel
  }
  return (t || el.tagName.toLowerCase()).replace(/\s+/g, ' ').toUpperCase().slice(0, 15)
}

/** Where a w x h picture goes in the LCD_W x AREA_H area: as large as fits, centred. */
export function fitRect(w: number, h: number): [number, number, number, number] {
  const k = Math.min(LCD_W / w, AREA_H / h)
  const dw = Math.max(1, Math.round(w * k)), dh = Math.max(1, Math.round(h * k))
  return [Math.floor((LCD_W - dw) / 2), Math.floor((AREA_H - dh) / 2), dw, dh]
}

export interface ElementSourceOptions {
  id: string
  title: string
  /** A view made for the LCD, "<kind>[:<arg>]" (registerLcdView)... */
  view?: string
  /** ...or the picked box, found by this selector. */
  selector?: string
  fps?: number
  focusOnTx?: boolean
  /** -5..5: more lit pixels (darker) above 0, fewer (lighter) below; from 3 up a rasterized box's
   *  strokes are drawn bold. Not used by views made for the LCD. */
  contrast?: number
}

export interface ElementLcdSource extends LcdSource {
  /** Changes the contrast of the running view (no re-registration with the bridge). */
  setContrast(contrast: number): void
}

const CONTRAST_STEP = 0.07

/** The level for a picture mode's default, moved by the contrast setting. */
export function contrastLevel(base: number, contrast: number): number {
  return Math.min(0.95, Math.max(0.02, base - CONTRAST_STEP * contrast))
}

export function elementSource(opts: ElementSourceOptions, find: (selector: string) => Element | null = (s) => document.querySelector(s)): ElementLcdSource {
  let contrast = opts.contrast ?? 0
  let el: Element | null = null
  let small: HTMLCanvasElement | null = null
  let ctx: CanvasRenderingContext2D | null = null
  let raster: Float32Array | null = null
  let rasterAt = 0
  let busy = false

  const scratch = () => {
    if (!small) {
      small = document.createElement('canvas')
      small.width = LCD_W
      small.height = AREA_H
      ctx = small.getContext('2d', { willReadFrequently: true })
    }
    return ctx
  }

  // Draws a picture into the scratch canvas, scaled to fit and centred (its
  // shape kept), and reads it back as stretched brightness.
  const levels = (src: HTMLCanvasElement): Float32Array | null => {
    const c = scratch()
    if (!c) return null
    const [x, y, w, h] = fitRect(src.width, src.height)
    c.clearRect(0, 0, LCD_W, AREA_H)
    c.imageSmoothingEnabled = true
    c.imageSmoothingQuality = 'high'
    c.drawImage(src, x, y, w, h)
    return stretch(brightness(c.getImageData(0, 0, LCD_W, AREA_H).data), 0.6, 0.995)
  }

  const rasterize = (target: Element) => {
    busy = true
    rasterAt = Date.now()
    toCanvas(target as HTMLElement, { pixelRatio: 1, cacheBust: false, skipFonts: true })
      .then((c) => { raster = levels(c) })
      .catch(() => { /* a cross-origin image or the like: keep the last picture */ })
      .finally(() => { busy = false })
  }

  return {
    id: opts.id,
    title: opts.title,
    fps: opts.fps,
    focusOnTx: opts.focusOnTx,
    setContrast(c) { contrast = c },
    render(g, tick) {
      if (opts.view !== undefined) {
        const ref = lcdViewNamed(opts.view)
        if (ref) ref.def.draw(g, tick, ref.arg)
        else { // its component is not on the page (another mode, say)
          const t = 'NOT ON THE PAGE NOW'
          g.tiny((LCD_W - g.tinyWidth(t)) >> 1, LCD_BODY_TOP + 16, t, ON)
        }
        return
      }
      if (!el || !el.isConnected) { el = opts.selector ? find(opts.selector) : null; raster = null }
      if (!el) return
      const canvas = dominantCanvas(el)
      if (canvas) {
        if (!canvas.width || !canvas.height) return
        const v = levels(canvas)
        if (v) drawLevels(g, v, { level: contrastLevel(0.15, contrast) })
        return
      }
      if (!busy && Date.now() - rasterAt >= RASTER_EVERY_MS) rasterize(el)
      // Text: crisp edges, no dither. A rasterized box is nearly all fully dark or
      // fully bright, so darker than the default means bolder strokes.
      if (raster) drawLevels(g, raster, { mode: 'threshold', level: contrastLevel(0.45, Math.min(contrast, 2)), bold: contrast >= 3 })
    },
  }
}
