import { Gfx, LCD_BODY_TOP, LCD_H, LCD_W } from '../../gfx'
import { drawMap, projector } from '../map'
import { COASTLINES } from '../coastlines'

const WORLD = { west: -180, south: -60, east: 180, north: 80 }

test('projector: west/east to the area edges, north up, shape kept and centred', () => {
  const p = projector(WORLD)
  const [xw] = p(0, -180), [xe] = p(0, 180)
  expect(xw).toBeLessThan(xe)
  expect(xe - xw).toBeLessThanOrEqual(LCD_W - 2)
  expect(p(60, 0)[1]).toBeLessThan(p(-30, 0)[1])
  const [cx] = p(0, 0)
  expect(Math.abs(cx - LCD_W / 2)).toBeLessThanOrEqual(1)
})

test('stations show as their marks; nothing on the title bar', () => {
  const g = new Gfx()
  const p = projector(WORLD)
  drawMap(g, 0, { bounds: WORLD, coast: null, stations: [{ lat: 40.7, lon: -74, worked: 'full' }, { lat: -34.6, lon: -58.4, worked: 'none' }], me: [-23.5, -46.6] })
  const [nx, ny] = p(40.7, -74)
  for (const [dx, dy] of [[-1, -1], [0, 0], [1, 1]]) expect(g.get(nx + dx, ny + dy)).toBe(true) // a filled square
  const [bx, by] = p(-34.6, -58.4)
  expect([g.get(bx, by), g.get(bx + 1, by)]).toEqual([true, false]) // a single pixel
  const [mx, my] = p(-23.5, -46.6)
  expect([g.get(mx, my - 2), g.get(mx + 2, my), g.get(mx + 1, my + 1)]).toEqual([true, true, false]) // a cross
  for (let y = 0; y < LCD_BODY_TOP; y++) for (let x = 0; x < LCD_W; x++) expect(g.get(x, y)).toBe(false)
})

test('coastlines draw inside the frame, also with the view past ±180', () => {
  for (const bounds of [WORLD, { west: 100, south: -50, east: 260, north: 60 }]) {
    const g = new Gfx()
    drawMap(g, 0, { bounds, coast: COASTLINES, stations: [] })
    let inner = 0
    for (let y = LCD_BODY_TOP + 1; y < LCD_H - 1; y++) for (let x = 1; x < LCD_W - 1; x++) if (g.get(x, y)) inner++
    expect(inner).toBeGreaterThan(150)
  }
})
