// The web app's copy of the LCD drawing (gfx.ts, gfxData.ts) against the
// firmware's own (firmware/esp32-cat-bridge/main/lcd_gfx.c):
// - fixtures/scene.txt drawn by gfx.ts must match fixtures/scene.bin, the same
//   scene drawn by lcd_gfx.c (scripts/lcd-gfx-reference; npm run lcd:reference
//   after changing lcd_gfx.c);
// - the fonts and icons in gfxData.ts must match the tables in lcd_gfx.c.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Gfx, ICONS, LCD_FRAME_BYTES, LCD_H, LCD_W, ON, type Color } from '../gfx'
import { FONT5X7, TINY } from '../gfxData'

const ROOT = join(__dirname, '..', '..', '..', '..')
const FIXTURES = join(__dirname, 'fixtures')
const C_SOURCE = readFileSync(join(ROOT, 'firmware/esp32-cat-bridge/main/lcd_gfx.c'), 'utf-8')

// The text after the first n space-separated fields (as main.c's rest()).
function rest(line: string, n: number): string {
  let p = 0
  for (let i = 0; i < n; i++) {
    while (line[p] === ' ') p++
    while (p < line.length && line[p] !== ' ') p++
  }
  if (line[p] === ' ') p++
  return line.slice(p)
}

function drawScene(text: string): Uint8Array[] {
  const g = new Gfx()
  const frames: Uint8Array[] = []
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue
    const f = line.split(' ').filter(Boolean)
    const op = f[0]
    const n = (i: number) => Number(f[i])
    const c = (i: number) => n(i) as Color
    switch (op) {
      case 'clear': g.clear(); break
      case 'invert': g.invert(); break
      case 'frame': frames.push(g.frame.slice()); break
      case 'px': g.px(n(1), n(2), c(3)); break
      case 'hline': g.hline(n(1), n(2), n(3), c(4)); break
      case 'vline': g.vline(n(1), n(2), n(3), c(4)); break
      case 'line': g.line(n(1), n(2), n(3), n(4), c(5)); break
      case 'fill': g.fill(n(1), n(2), n(3), n(4), c(5)); break
      case 'rect': g.rect(n(1), n(2), n(3), n(4), c(5)); break
      case 'round': g.roundRect(n(1), n(2), n(3), n(4), n(5), c(6)); break
      case 'fillround': g.fillRound(n(1), n(2), n(3), n(4), n(5), c(6)); break
      case 'dither': g.dither(n(1), n(2), n(3), n(4), n(5)); break
      case 'tiny': g.tiny(n(1), n(2), rest(line, 4), c(3)); break
      case 'small': g.small(n(1), n(2), rest(line, 4), c(3)); break
      case 'big': g.big(n(1), n(2), rest(line, 4), c(3)); break
      case 'tinyw': g.hline(n(1), n(1) + g.tinyWidth(rest(line, 3)) - 1, n(2), ON); break
      case 'smallw': g.hline(n(1), n(1) + g.smallWidth(rest(line, 3)) - 1, n(2), ON); break
      case 'bigw': g.hline(n(1), n(1) + g.bigWidth(rest(line, 3)) - 1, n(2), ON); break
      case 'icon': g.icon(n(1), n(2), ICONS[f[3] as keyof typeof ICONS], n(4), c(5)); break
      case 'iconk': g.iconScaled(n(1), n(2), ICONS[f[3] as keyof typeof ICONS], n(4), n(5)); break
      case 'pill': g.pill(n(1), n(2), rest(line, 4), n(3) !== 0); break
      case 'segbar': g.segBar(n(1), n(2), n(3), n(4), n(5)); break
      case 'bar': g.bar(n(1), n(2), n(3), n(4), n(5)); break
      case 'box': g.box(n(1), n(2), n(3), n(4)); break
      default: throw new Error(`bad scene line: ${line}`)
    }
  }
  return frames
}

// The differing pixels, as "x,y" (for a readable failure).
function diff(a: Uint8Array, b: Uint8Array): string[] {
  const out: string[] = []
  for (let y = 0; y < LCD_H; y++)
    for (let x = 0; x < LCD_W; x++) {
      const i = (y >> 3) * LCD_W + x, m = 1 << (y & 7)
      if ((a[i] & m) !== (b[i] & m)) out.push(`${x},${y}`)
    }
  return out
}

describe('LCD gfx copy', () => {
  test('draws the reference scene exactly as lcd_gfx.c does', () => {
    const scene = readFileSync(join(FIXTURES, 'scene.txt'), 'utf-8')
    const ref = readFileSync(join(FIXTURES, 'scene.bin'))
    const frames = drawScene(scene)
    expect(frames.length * LCD_FRAME_BYTES).toBe(ref.length)
    frames.forEach((f, k) => {
      const want = new Uint8Array(ref.buffer, ref.byteOffset + k * LCD_FRAME_BYTES, LCD_FRAME_BYTES)
      expect({ frame: k + 1, differing: diff(f, want) }).toEqual({ frame: k + 1, differing: [] })
    })
  })

  test('5 x 7 font matches lcd_gfx.c', () => {
    const block = C_SOURCE.slice(C_SOURCE.indexOf('FONT5X7[95][5] = {'))
    const glyphs = [...block.slice(0, block.indexOf('};')).matchAll(/\{(0x[0-9A-F]{2}(?:,0x[0-9A-F]{2}){4})\}/g)]
      .map((m) => m[1].split(',').map((h) => parseInt(h, 16)))
    expect(glyphs).toHaveLength(95)
    expect(FONT5X7.map((g) => [...g])).toEqual(glyphs)
  })

  test('tiny font matches lcd_gfx.c', () => {
    const block = C_SOURCE.slice(C_SOURCE.indexOf('static const tiny_glyph_t TINY[] = {'))
    const glyphs = [...block.slice(0, block.indexOf('};')).matchAll(/\{'(\\?.)',(\d),\{([^}]*)\}\}/g)].map((m) => {
      const cols = m[3].split(',').map((s) => s.trim()).filter(Boolean).map((s) => Number(s))
      while (cols.length && cols[cols.length - 1] === 0) cols.pop()
      return [m[1].replace(/^\\/, ''), Number(m[2]), cols]
    })
    expect(TINY.map(([ch, w, cols]) => [ch, w, [...cols]])).toEqual(glyphs)
  })

  test('icons match lcd_gfx.c', () => {
    const icons = [...C_SOURCE.matchAll(/ICON\(ICON_(\w+), (\d+), (\d+), (\d+),\s*((?:"[.#]+",?\s*)+)\);/g)].map((m) => [
      m[1], { w: Number(m[2]), h: Number(m[3]), frames: Number(m[4]), rows: [...m[5].matchAll(/"([.#]+)"/g)].map((r) => r[1]) },
    ])
    expect(icons.length).toBeGreaterThan(0)
    expect(Object.entries(ICONS).map(([k, v]) => [k, { ...v, rows: [...v.rows] }])).toEqual(icons)
  })

  test('body() is rows 8..47 of the frame', () => {
    const g = new Gfx()
    g.px(0, 8, ON)
    g.px(83, 47, ON)
    g.px(5, 7, ON) // the title bar's rows are not part of the body
    const body = g.body()
    expect(body).toHaveLength(LCD_FRAME_BYTES - LCD_W)
    expect(body[0]).toBe(1)
    expect(body[body.length - 1]).toBe(0x80)
    expect([...body].filter(Boolean)).toHaveLength(2)
  })
})
