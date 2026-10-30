import { LcdFeed, lcdFeedUrl, type LcdFeedState } from '../feed'
import { brightness, drawLevels, stretch } from '../levels'
import { Gfx, LCD_BODY_BYTES, LCD_BODY_TOP, LCD_H, LCD_W, ON } from '../gfx'

class FakeSocket {
  static OPEN = 1
  static all: FakeSocket[] = []
  readyState = 0
  binaryType = ''
  sent: (string | Uint8Array)[] = []
  onopen: (() => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onclose: (() => void) | null = null
  constructor(readonly url: string) { FakeSocket.all.push(this) }
  send(d: string | Uint8Array) { this.sent.push(d) }
  close() { this.readyState = 3; this.onclose?.() }
  open() { this.readyState = 1; this.onopen?.() }
  reply(m: object) { this.onmessage?.({ data: JSON.stringify(m) }) }
  texts() { return this.sent.filter((d): d is string => typeof d === 'string').map((d) => JSON.parse(d)) }
  frames() { return this.sent.filter((d): d is Uint8Array => typeof d !== 'string') }
}

const realWebSocket = globalThis.WebSocket

beforeEach(() => {
  jest.useFakeTimers()
  FakeSocket.all = []
  ;(globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeSocket
})

afterEach(() => {
  jest.useRealTimers()
  ;(globalThis as unknown as { WebSocket: unknown }).WebSocket = realWebSocket
})

function setup() {
  const states: LcdFeedState[] = []
  const feed = new LcdFeed('ws://bridge/display-ws', (s) => states.push(s))
  const ws = FakeSocket.all[0]
  return { feed, ws, states, last: () => states[states.length - 1] }
}

test('lcdFeedUrl swaps the path of the bridge address', () => {
  expect(lcdFeedUrl('ws://192.168.0.12/cat')).toBe('ws://192.168.0.12/display-ws')
  expect(lcdFeedUrl('wss://bridge.local:8443/cat?x=1')).toBe('wss://bridge.local:8443/display-ws')
  expect(lcdFeedUrl('http://bridge/cat')).toBeNull()
  expect(lcdFeedUrl('not a url')).toBeNull()
})

test('registers on open, sends the picture with its slot, only when it changes or is due', () => {
  const { feed, ws, last } = setup()
  let x = 0
  feed.add({ id: 'ft8-qso', title: 'FT8 QSO', fps: 5, focusOnTx: true, render: (g) => g.px(x, 20, ON) })
  expect(ws.sent).toHaveLength(0) // not open yet
  ws.open()
  expect(ws.texts()).toEqual([{ register: 'ft8-qso', title: 'FT8 QSO', focus_on_tx: true }])
  expect(last().sources['ft8-qso']).toBe('waiting')

  jest.advanceTimersByTime(400)
  expect(ws.frames()).toHaveLength(0) // no slot yet

  ws.reply({ slot: 2, id: 'ft8-qso' })
  expect(last().sources['ft8-qso']).toBe('live')
  jest.advanceTimersByTime(200)
  const [f] = ws.frames()
  expect(f).toHaveLength(1 + LCD_BODY_BYTES)
  expect(f[0]).toBe(2)
  expect(f[1 + LCD_W]).toBe(1 << 4) // (0, 20): bank 2 of the frame, bank 1 of the body, bit 4

  jest.advanceTimersByTime(1000)
  expect(ws.frames()).toHaveLength(1) // unchanged: not sent again
  x = 1
  jest.advanceTimersByTime(200)
  expect(ws.frames()).toHaveLength(2)
  jest.advanceTimersByTime(4000)
  expect(ws.frames()).toHaveLength(3) // unchanged, but the bridge needs one before its 10 s timeout
})

test('fps sets how often a source is drawn', () => {
  const { feed, ws } = setup()
  let draws = 0
  feed.add({ id: 'slow', title: 'SLOW', fps: 1, render: () => { draws++ } })
  ws.open()
  ws.reply({ slot: 0, id: 'slow' })
  jest.advanceTimersByTime(5000)
  expect(draws).toBe(5)
})

test('a full bridge, removal and reconnecting', () => {
  const { feed, ws, last } = setup()
  const remove = feed.add({ id: 'a', title: 'A', render: () => {} })
  feed.add({ id: 'b', title: 'B', render: () => {} })
  ws.open()
  ws.reply({ error: 'full', id: 'b' })
  expect(last().sources).toEqual({ a: 'waiting', b: 'full' })

  remove()
  expect(ws.texts().pop()).toEqual({ unregister: 'a' })
  expect(last().sources).toEqual({ b: 'full' })

  ws.close()
  expect(last().connected).toBe(false)
  jest.advanceTimersByTime(5000)
  const again = FakeSocket.all[1]
  expect(again.url).toBe('ws://bridge/display-ws')
  again.open()
  expect(again.texts()).toEqual([{ register: 'b', title: 'B', focus_on_tx: false }])
  expect(last().sources).toEqual({ b: 'waiting' })

  feed.close()
  jest.advanceTimersByTime(10000)
  expect(FakeSocket.all).toHaveLength(2) // closed for good
})

test('show() of an own view waits for its first picture', () => {
  const { feed, ws } = setup()
  feed.add({ id: 'new', title: 'NEW', fps: 5, render: () => {} })
  ws.open()
  feed.show('new')
  feed.show('radio')
  expect(ws.texts().filter((m) => m.show)).toEqual([{ show: 'radio' }]) // a built-in view: at once
  ws.reply({ slot: 3, id: 'new' })
  jest.advanceTimersByTime(200)
  expect(ws.sent.slice(-2).map((d) => (typeof d === 'string' ? JSON.parse(d) : 'frame'))).toEqual(['frame', { show: 'new' }])
})

test('an overlay is drawn and sent every tick with slot 255 until it ends', () => {
  const { feed, ws } = setup()
  ws.open()
  let draws = 0
  feed.overlay((g) => { draws++; g.px(1, 20, ON) }, 1000)
  jest.advanceTimersByTime(1000)
  const ovl = ws.frames().filter((f) => f[0] === 255)
  expect(ovl.length).toBeGreaterThanOrEqual(4)
  expect(ovl[0]).toHaveLength(1 + LCD_BODY_BYTES)
  expect(ovl[0][1 + LCD_W + 1]).toBe(1 << 4) // (1, 20)
  const n = draws
  jest.advanceTimersByTime(1000)
  expect(draws).toBe(n) // over
})

test('reports the view on the glass', () => {
  const { ws, last } = setup()
  ws.open()
  ws.reply({ showing: 'spectrum', client_views: [] })
  expect(last().showing).toBe('spectrum')
})

test('a source that throws says so on the glass, the others still draw', () => {
  const { feed, ws } = setup()
  feed.add({ id: 'bad', title: 'BAD', fps: 5, render: () => { throw new Error('boom') } })
  feed.add({ id: 'good', title: 'GOOD', fps: 5, render: (g) => g.px(1, 30, ON) })
  ws.open()
  ws.reply({ slot: 0, id: 'bad' })
  ws.reply({ slot: 1, id: 'good' })
  jest.advanceTimersByTime(200)
  const frames = ws.frames()
  expect(frames.map((f) => f[0])).toEqual([0, 1])
  expect(frames[0].subarray(1).some((b) => b !== 0)).toBe(true) // the message, not a blank picture
})

test('a view refused as full asks again when the bridge list changes', () => {
  const { feed, ws, last } = setup()
  feed.add({ id: 'a', title: 'A', render: () => {} })
  ws.open()
  ws.reply({ error: 'full', id: 'a' })
  expect(last().sources).toEqual({ a: 'full' })
  ws.sent = []
  ws.reply({ showing: 'radio', client_views: [] }) // another client's view went away
  expect(ws.texts()).toEqual([{ register: 'a', title: 'A', focus_on_tx: false }])
  ws.reply({ slot: 2, id: 'a' })
  expect(last().sources).toEqual({ a: 'live' })
})

test('re-adding a view before its first reply: only the reply to the last register counts', () => {
  const { feed, ws, last } = setup()
  ws.open()
  feed.add({ id: 'a', title: 'A', render: () => {} })
  feed.add({ id: 'a', title: 'A2', render: () => {} }) // renamed within the round trip
  ws.reply({ slot: 0, id: 'a' }) // answers the first register (freed by the unregister)
  expect(last().sources).toEqual({ a: 'waiting' })
  ws.reply({ slot: 3, id: 'a' })
  expect(last().sources).toEqual({ a: 'live' })
  jest.advanceTimersByTime(1000)
  expect(new Set(ws.frames().map((f) => f[0]))).toEqual(new Set([3]))
})

describe('drawLevels', () => {
  const area = (v: number) => new Float32Array(LCD_W * (LCD_H - LCD_BODY_TOP)).fill(v)
  const lit = (g: Gfx) => {
    let n = 0
    for (let y = 0; y < LCD_H; y++) for (let x = 0; x < LCD_W; x++) if (g.get(x, y)) n++
    return n
  }
  const total = LCD_W * (LCD_H - LCD_BODY_TOP)

  test('dither: pixel density follows brightness above the black point; nothing above the body', () => {
    const g = new Gfx()
    drawLevels(g, area(0.1))
    expect(lit(g)).toBe(0)
    g.clear()
    drawLevels(g, area(1))
    expect(lit(g)).toBe(total)
    g.clear()
    drawLevels(g, area(0.575)) // half way from 0.15 to 1
    expect(lit(g)).toBe(total / 2)
    for (let y = 0; y < LCD_BODY_TOP; y++) for (let x = 0; x < LCD_W; x++) expect(g.get(x, y)).toBe(false)
  })

  test('threshold and invert', () => {
    const g = new Gfx()
    drawLevels(g, area(0.5), { mode: 'threshold', level: 0.5 })
    expect(lit(g)).toBe(total)
    g.clear()
    drawLevels(g, area(0.5), { mode: 'threshold', level: 0.6 })
    expect(lit(g)).toBe(0)
    g.clear()
    drawLevels(g, area(0), { invert: true })
    expect(lit(g)).toBe(total)
  })
})

describe('canvas levels', () => {
  test('brightness is the strongest channel (a dark-blue colour map still shows)', () => {
    const px = new Uint8ClampedArray([40, 80, 255, 255, 10, 10, 10, 255])
    expect([...brightness(px)]).toEqual([1, 10 / 255].map((x) => Math.fround(x)))
  })

  test('stretch maps the noise floor to 0 and the peaks to 1', () => {
    const v = new Float32Array(100).map((_, i) => (i < 90 ? 0.2 : 0.3 + i / 1000)) // noise, a few strong pixels
    const s = stretch(v, 0.6, 0.99)
    expect(s[0]).toBe(0)
    expect(s[99]).toBe(1)
    expect(s[95]).toBeGreaterThan(0.9)
    expect([...stretch(new Float32Array(10).fill(0.4), 0.6, 0.99)]).toEqual(new Array(10).fill(0)) // flat
  })
})

test('drawLevels bold lights the pixel to the right too', () => {
  const v = new Float32Array(LCD_W * (LCD_H - LCD_BODY_TOP))
  v[5] = 1 // (5, LCD_BODY_TOP)
  const g = new Gfx()
  drawLevels(g, v, { mode: 'threshold', level: 0.5, bold: true })
  expect([g.get(4, LCD_BODY_TOP), g.get(5, LCD_BODY_TOP), g.get(6, LCD_BODY_TOP), g.get(7, LCD_BODY_TOP)]).toEqual([false, true, true, false])
})
