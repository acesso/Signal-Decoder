// 1-bit drawing for the bridge's status LCD (Nokia 5110, PCD8544, 84 x 48):
// a copy of firmware/esp32-cat-bridge/main/lcd_gfx.c, so the views the web app
// draws for the LCD (doc/plans/lcd-client-views/PLAN.md) look like the
// bridge's own. Same routines, same fonts and icons (gfxData.ts), same pixels:
// __tests__/gfx.test.ts compares a scene drawn here with the same scene drawn
// by the C.
//
// The frame is in the controller's layout: 6 banks of 84 column bytes, bit 0
// at the top. A client view sends body(): rows 8..47, the part under the
// bridge's title bar (row 8 is drawn over by the bar's bottom edge).

import { FONT5X7, ICONS, TINY, type Icon } from './gfxData'

export const LCD_W = 84
export const LCD_H = 48
export const LCD_FRAME_BYTES = (LCD_W * LCD_H) / 8
/** The bytes a client view sends: banks 1..5. */
export const LCD_BODY_BYTES = LCD_FRAME_BYTES - LCD_W
/** The first row a client view's own drawing shows on (under the title bar). */
export const LCD_BODY_TOP = 9

export const OFF = 0
export const ON = 1
export const XOR = 2
export type Color = typeof OFF | typeof ON | typeof XOR

export { ICONS, type Icon }

// Corner insets for radius 1..3, row by row from the corner: pixel-art
// rounding rather than a true circle, which looks lumpy at this size.
const CORNER = [[0], [1], [2, 1], [3, 1, 1]]

function cornerInset(j: number, h: number, r: number): number {
  if (r < 1) return 0
  if (j < r) return CORNER[r][j]
  if (h - 1 - j < r) return CORNER[r][h - 1 - j]
  return 0
}

function inRound(i: number, j: number, w: number, h: number, r: number): boolean {
  if (i < 0 || j < 0 || i >= w || j >= h) return false
  const inset = cornerInset(j, h, r)
  return i >= inset && i <= w - 1 - inset
}

const TINY_MAP = new Map(TINY.map(([ch, w, cols]) => [ch, { w, cols }]))
const TINY_SPACE = TINY_MAP.get(' ')!

function tinyGlyph(ch: string) {
  return TINY_MAP.get(ch.toUpperCase()) ?? TINY_SPACE
}

// Big: each 5 x 7 pixel as 2 x 2; '.' is a 2 x 2 dot in a 4 px cell.
function bigCell(ch: string): number {
  return ch === '.' ? 4 : ch === ' ' ? 6 : 12
}

// C's lroundf((w - 4) * frac) on floats, so bars end on the same column.
function barLength(w: number, frac: number): number {
  const f = Math.fround(Math.fround(w - 4) * Math.fround(frac < 0 ? 0 : frac > 1 ? 1 : frac))
  return Math.round(f)
}

export class Gfx {
  readonly frame = new Uint8Array(LCD_FRAME_BYTES)

  /** Rows 8..47: what a client view sends. */
  body(): Uint8Array {
    return this.frame.subarray(LCD_W)
  }

  clear(): void {
    this.frame.fill(0)
  }

  px(x: number, y: number, c: Color): void {
    if (x < 0 || x >= LCD_W || y < 0 || y >= LCD_H) return
    const i = (y >> 3) * LCD_W + x
    const m = 1 << (y & 7)
    if (c === ON) this.frame[i] |= m
    else if (c === OFF) this.frame[i] &= ~m
    else this.frame[i] ^= m
  }

  get(x: number, y: number): boolean {
    if (x < 0 || x >= LCD_W || y < 0 || y >= LCD_H) return false
    return (this.frame[(y >> 3) * LCD_W + x] & (1 << (y & 7))) !== 0
  }

  hline(x0: number, x1: number, y: number, c: Color): void {
    if (x0 > x1) [x0, x1] = [x1, x0]
    for (let x = x0; x <= x1; x++) this.px(x, y, c)
  }

  vline(x: number, y0: number, y1: number, c: Color): void {
    if (y0 > y1) [y0, y1] = [y1, y0]
    for (let y = y0; y <= y1; y++) this.px(x, y, c)
  }

  line(x0: number, y0: number, x1: number, y1: number, c: Color): void {
    const dx = Math.abs(x1 - x0), sx = x0 < x1 ? 1 : -1, dy = -Math.abs(y1 - y0), sy = y0 < y1 ? 1 : -1
    let err = dx + dy
    for (;;) {
      this.px(x0, y0, c)
      if (x0 === x1 && y0 === y1) return
      const e2 = 2 * err
      if (e2 >= dy) { err += dy; x0 += sx }
      if (e2 <= dx) { err += dx; y0 += sy }
    }
  }

  fill(x: number, y: number, w: number, h: number, c: Color): void {
    for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) this.px(i, j, c)
  }

  rect(x: number, y: number, w: number, h: number, c: Color): void {
    if (w <= 0 || h <= 0) return
    this.hline(x, x + w - 1, y, c)
    if (h > 1) this.hline(x, x + w - 1, y + h - 1, c)
    if (h > 2) {
      this.vline(x, y + 1, y + h - 2, c)
      if (w > 1) this.vline(x + w - 1, y + 1, y + h - 2, c)
    }
  }

  /** The outline: the shape's pixels with a 4-neighbour outside it. r 0..3. */
  roundRect(x: number, y: number, w: number, h: number, r: number, c: Color): void {
    if (r > 3) r = 3
    for (let j = 0; j < h; j++)
      for (let i = 0; i < w; i++)
        if (inRound(i, j, w, h, r) && (!inRound(i - 1, j, w, h, r) || !inRound(i + 1, j, w, h, r) ||
                                       !inRound(i, j - 1, w, h, r) || !inRound(i, j + 1, w, h, r)))
          this.px(x + i, y + j, c)
  }

  fillRound(x: number, y: number, w: number, h: number, r: number, c: Color): void {
    if (r > 3) r = 3
    for (let j = 0; j < h; j++) {
      const inset = cornerInset(j, h, r)
      this.hline(x + inset, x + w - 1 - inset, y + j, c)
    }
  }

  /** 50 % checkerboard (the "grey" of a 1-bit screen), phase 0 or 1. */
  dither(x: number, y: number, w: number, h: number, phase: number): void {
    for (let j = y; j < y + h; j++)
      for (let i = x; i < x + w; i++) this.px(i, j, (i + j + phase) & 1 ? ON : OFF)
  }

  invert(): void {
    for (let i = 0; i < LCD_FRAME_BYTES; i++) this.frame[i] ^= 0xff
  }

  // ── Fonts ──────────────────────────────────────────────────────────────

  /** 3 x 5 capitals, digits and a few signs; lower case draws as upper. Returns the width drawn. */
  tiny(x: number, y: number, s: string, c: Color): number {
    const x0 = x
    for (const ch of s) {
      const g = tinyGlyph(ch)
      for (let i = 0; i < g.w; i++)
        for (let j = 0; j < 5; j++) if ((g.cols[i] ?? 0) & (1 << j)) this.px(x + i, y + j, c)
      x += g.w + 1
    }
    return x > x0 ? x - x0 - 1 : 0
  }

  tinyWidth(s: string): number {
    let w = 0
    for (const ch of s) w += tinyGlyph(ch).w + 1
    return w ? w - 1 : 0
  }

  /** The classic 5 x 7 ASCII, 6 px a character. */
  small(x: number, y: number, s: string, c: Color): number {
    const x0 = x
    for (const ch of s) {
      let code = ch.charCodeAt(0)
      if (code < 0x20 || code > 0x7e) code = 0x3f
      const g = FONT5X7[code - 0x20]
      for (let i = 0; i < 5; i++)
        for (let j = 0; j < 8; j++) if (g[i] & (1 << j)) this.px(x + i, y + j, c)
      x += 6
    }
    return x > x0 ? x - x0 - 1 : 0
  }

  smallWidth(s: string): number {
    const n = [...s].length
    return n ? n * 6 - 1 : 0
  }

  /** The 5 x 7 digits doubled to 10 x 14; digits, '.', '-', ' '. */
  big(x: number, y: number, s: string, c: Color): number {
    const x0 = x
    for (const ch of s) {
      if (ch === '.') this.fill(x, y + 12, 2, 2, c)
      else if (ch !== ' ') {
        const code = ch.charCodeAt(0)
        const g = FONT5X7[code >= 0x20 && code <= 0x7e ? code - 0x20 : 0x3f - 0x20]
        for (let i = 0; i < 5; i++)
          for (let j = 0; j < 7; j++) if (g[i] & (1 << j)) this.fill(x + 2 * i, y + 2 * j, 2, 2, c)
      }
      x += bigCell(ch)
    }
    return x > x0 ? x - x0 - 2 : 0
  }

  bigWidth(s: string): number {
    let w = 0
    for (const ch of s) w += bigCell(ch)
    return w ? w - 2 : 0
  }

  // ── Icons ──────────────────────────────────────────────────────────────

  /** An icon's frame (taken modulo its frame count, so a tick animates it). */
  icon(x: number, y: number, icon: Icon, frame: number, c: Color): void {
    const base = (frame % icon.frames) * icon.h
    for (let j = 0; j < icon.h; j++) {
      const row = icon.rows[base + j]
      for (let i = 0; i < icon.w && i < row.length; i++) if (row[i] === '#') this.px(x + i, y + j, c)
    }
  }

  /** Each pixel as a k x k block, always ON. */
  iconScaled(x: number, y: number, icon: Icon, frame: number, k: number): void {
    const base = (frame % icon.frames) * icon.h
    for (let j = 0; j < icon.h; j++) {
      const row = icon.rows[base + j]
      for (let i = 0; i < icon.w && i < row.length; i++) if (row[i] === '#') this.fill(x + i * k, y + j * k, k, k, ON)
    }
  }

  // ── Pieces of the look ─────────────────────────────────────────────────

  /** Tiny text in a rounded block (filled) or outline, 7 high; returns its width. */
  pill(x: number, y: number, s: string, filled: boolean): number {
    const w = this.tinyWidth(s) + 6
    if (filled) { this.fillRound(x, y, w, 7, 2, ON); this.tiny(x + 3, y + 1, s, OFF) }
    else { this.roundRect(x, y, w, 7, 2, ON); this.tiny(x + 3, y + 1, s, ON) }
    return w
  }

  /** A rounded bar for 0..1, segmented (two lit columns, one dark). */
  segBar(x: number, y: number, w: number, h: number, frac: number): void {
    this.roundRect(x, y, w, h, 1, ON)
    const n = barLength(w, frac)
    for (let i = 0; i < n; i++) if (i % 3 !== 2) this.vline(x + 2 + i, y + 2, y + h - 3, ON)
  }

  /** A smooth bar for 0..1 in a rounded outline. */
  bar(x: number, y: number, w: number, h: number, frac: number): void {
    this.roundRect(x, y, w, h, 1, ON)
    const n = barLength(w, frac)
    if (n > 0) this.fill(x + 2, y + 2, n, h - 4, ON)
  }

  /** A cleared panel with a double rounded border (the bridge's overlays). */
  box(x: number, y: number, w: number, h: number): void {
    this.fillRound(x, y, w, h, 3, OFF)
    this.roundRect(x, y, w, h, 3, ON)
    this.roundRect(x + 2, y + 2, w - 4, h - 4, 2, ON)
  }
}
