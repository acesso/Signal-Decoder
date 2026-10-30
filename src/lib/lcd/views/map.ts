// The map view for the bridge's LCD: the app map's visible area redrawn as
// vectors (map tiles shrunk to 84 x 37 one-bit pixels are noise). Coastlines
// (coastlines.ts, loaded on first use), the stations heard, and mine.
//
//   ·  heard        ▫  partial QSO (handshake, no reports)
//   ■  QSO          ◯  the selected station (blinking)       +  my station

import { LCD_BODY_TOP, LCD_H, LCD_W, ON, type Gfx } from '../gfx'

export interface MapBounds {
  west: number
  south: number
  east: number
  north: number
}

export interface MapStation {
  lat: number
  lon: number
  worked: 'full' | 'partial' | 'none'
  selected?: boolean
}

export interface MapViewData {
  /** The app map's visible area, degrees (west/east may run past ±180 when zoomed out). */
  bounds: MapBounds
  stations: readonly MapStation[]
  /** My station, [lat, lon]. */
  me?: [number, number]
  /** COASTLINES from coastlines.ts, or null while it loads. */
  coast: readonly (readonly number[])[] | null
}

// The map's area: inside a rounded frame under the title bar.
const X0 = 1, Y0 = LCD_BODY_TOP + 1, AW = LCD_W - 2, AH = LCD_H - LCD_BODY_TOP - 2

const MAX_LAT = 85.05
const mercY = (lat: number) => {
  const p = (Math.max(-MAX_LAT, Math.min(MAX_LAT, lat)) * Math.PI) / 180
  return Math.log(Math.tan(Math.PI / 4 + p / 2)) * (180 / Math.PI)
}

/** Degrees -> LCD pixels for these bounds: the area fitted inside, centred, shape kept. */
export function projector(b: MapBounds): (lat: number, lon: number) => [number, number] {
  const top = mercY(b.north), bottom = mercY(b.south)
  const w = Math.max(1e-6, b.east - b.west), h = Math.max(1e-6, top - bottom)
  const k = Math.min(AW / w, AH / h)
  const ox = X0 + (AW - w * k) / 2, oy = Y0 + (AH - h * k) / 2
  return (lat, lon) => [Math.round(ox + (lon - b.west) * k), Math.round(oy + (top - mercY(lat)) * k)]
}

const inArea = (x: number, y: number) => x >= X0 && x < X0 + AW && y >= Y0 && y < Y0 + AH

// Coastlines are dotted (a 1-bit grey), so the stations, solid, stand out.
function line(g: Gfx, a: [number, number], b: [number, number]): void {
  if (Math.abs(a[0] - b[0]) > AW || Math.abs(a[1] - b[1]) > AH) return // across the antimeridian
  if (!inArea(...a) && !inArea(...b)) return
  // Bresenham, clipped to the area pixel by pixel.
  let [x0, y0] = a
  const [x1, y1] = b
  const dx = Math.abs(x1 - x0), sx = x0 < x1 ? 1 : -1, dy = -Math.abs(y1 - y0), sy = y0 < y1 ? 1 : -1
  let err = dx + dy
  for (;;) {
    if (inArea(x0, y0) && ((x0 + y0) & 1) === 0) g.px(x0, y0, ON)
    if (x0 === x1 && y0 === y1) return
    const e2 = 2 * err
    if (e2 >= dy) { err += dy; x0 += sx }
    if (e2 <= dx) { err += dx; y0 += sy }
  }
}

function dot(g: Gfx, x: number, y: number, pts: [number, number][]): void {
  for (const [dx, dy] of pts) if (inArea(x + dx, y + dy)) g.px(x + dx, y + dy, ON)
}

const SQUARE: [number, number][] = [[-1, -1], [0, -1], [1, -1], [-1, 0], [0, 0], [1, 0], [-1, 1], [0, 1], [1, 1]]
const HOLLOW: [number, number][] = SQUARE.filter(([x, y]) => x || y)
const CROSS: [number, number][] = [[0, -2], [0, -1], [-2, 0], [-1, 0], [0, 0], [1, 0], [2, 0], [0, 1], [0, 2]]
const RING: [number, number][] = [[-1, -3], [0, -3], [1, -3], [-2, -2], [2, -2], [-3, -1], [3, -1], [-3, 0], [3, 0], [-3, 1], [3, 1], [-2, 2], [2, 2], [-1, 3], [0, 3], [1, 3]]

/** Draws the map view under the title bar. */
export function drawMap(g: Gfx, tick: number, d: MapViewData): void {
  g.roundRect(0, LCD_BODY_TOP, LCD_W, LCD_H - LCD_BODY_TOP, 2, ON)
  const project = projector(d.bounds)
  // The world again either side when the view runs past ±180.
  const shifts = [-360, 0, 360].filter((s) => d.bounds.west <= 180 + s && d.bounds.east >= -180 + s)
  const at = (lat: number, lon: number, s: number) => project(lat, lon + s)
  for (const s of shifts) {
    for (const c of d.coast ?? []) {
      let prev = at(c[1] / 10, c[0] / 10, s)
      for (let i = 2; i < c.length; i += 2) {
        const p = at(c[i + 1] / 10, c[i] / 10, s)
        line(g, prev, p)
        prev = p
      }
    }
    for (const st of d.stations) {
      const [x, y] = at(st.lat, st.lon, s)
      if (st.worked === 'full') dot(g, x, y, SQUARE)
      else if (st.worked === 'partial') dot(g, x, y, HOLLOW)
      else dot(g, x, y, [[0, 0]])
      if (st.selected && tick % 4 < 2) dot(g, x, y, RING)
    }
    if (d.me) { const [x, y] = at(d.me[0], d.me[1], s); dot(g, x, y, CROSS) }
  }
}
