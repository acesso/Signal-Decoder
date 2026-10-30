// Pictures to one bit for the LCD (elementSource.ts reads a canvas or a
// rasterized element into the 84 x 39 area under the bridge's title bar):
// an ordered dither or a threshold. Bright becomes a dark (lit) pixel, as
// signals on the LCD's light glass.
//
// Brightness is a pixel's strongest channel, not its luminance: colour maps
// like the waterfall's dark blues carry the signal in blue, which luminance
// all but ignores. Each picture is then stretched from its noise floor to its
// peaks (stretch), so weak and strong bands both show.

import { LCD_BODY_TOP, LCD_H, LCD_W, ON, type Gfx } from './gfx'

export interface LevelsOptions {
  /** 'dither' (default) keeps grey levels as pixel density; 'threshold' keeps edges. */
  mode?: 'dither' | 'threshold'
  /** Brightness 0..1 where pixels start to light (threshold), or the dither's black point. Default 0.15. */
  level?: number
  /** Dark canvas content as lit pixels instead of bright. */
  invert?: boolean
  /** Each lit pixel also lights the one to its right: bolder strokes (text that comes out thin). */
  bold?: boolean
}

const AREA_H = LCD_H - LCD_BODY_TOP

// 4 x 4 Bayer matrix, as thresholds in 0..1.
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16)

/** Brightness 0..1 of each pixel of an RGBA image: its strongest channel. */
export function brightness(rgba: Uint8ClampedArray): Float32Array {
  const out = new Float32Array(rgba.length / 4)
  for (let i = 0; i < out.length; i++) out[i] = Math.max(rgba[4 * i], rgba[4 * i + 1], rgba[4 * i + 2]) / 255
  return out
}

/** Maps the lo share of the pixels (and below) to 0 and the hi share (and above) to 1. */
export function stretch(v: Float32Array, lo: number, hi: number): Float32Array {
  const sorted = v.slice().sort()
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))]
  const a = at(lo), span = at(hi) - a
  if (span <= 1e-6) return new Float32Array(v.length) // flat: nothing stands out
  return v.map((x) => Math.min(1, Math.max(0, (x - a) / span)))
}

/** Draws a LCD_W x AREA_H brightness image into the area under the title bar. */
export function drawLevels(g: Gfx, lum: Float32Array, opts: LevelsOptions = {}): void {
  const level = opts.level ?? 0.15
  for (let y = 0; y < AREA_H; y++)
    for (let x = 0; x < LCD_W; x++) {
      let v = lum[y * LCD_W + x]
      if (opts.invert) v = 1 - v
      const on = opts.mode === 'threshold'
        ? v >= level
        : (v - level) / (1 - level) > BAYER[(y & 3) * 4 + (x & 3)]
      if (on) {
        g.px(x, LCD_BODY_TOP + y, ON)
        if (opts.bold) g.px(x + 1, LCD_BODY_TOP + y, ON)
      }
    }
}
