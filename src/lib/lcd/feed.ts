// The web app's views on the bridge's status LCD (doc/plans/lcd-client-views/PLAN.md):
// one /display-ws socket to the bridge, the views ("sources") registered on
// it, and a render loop that draws each source with gfx.ts and sends its
// picture when it changed.
//
// Protocol (firmware/esp32-cat-bridge/main/status_display.h):
//   -> {"register":"<id>","title":"<title>","focus_on_tx":bool}   <- {"slot":N,"id":"<id>"} | {"error":"full","id":"<id>"}
//   -> BINARY [slot][420 bytes]        -> {"unregister":"<id>"}    -> {"show":"<view>"}
//   -> BINARY [255][420 bytes]: an overlay over whatever is on the glass (overlay())
//   <- BINARY the frame on the glass   <- {"showing":"<view>","client_views":[{id,title}]}
// The bridge drops a view after 10 s without a picture, so an unchanged
// picture is still sent every KEEPALIVE_MS.

import { Gfx, LCD_BODY_BYTES, LCD_BODY_TOP, LCD_W, ON } from './gfx'

/** The bridge's overlay panel (status_display.h): an overlay's pixels count only inside it. */
export const OVERLAY_X = 1
export const OVERLAY_Y = 10
export const OVERLAY_W = 82
export const OVERLAY_H = 37

export interface LcdSource {
  /** 1..23 of a-z 0-9 - _; the same id from another tab or page takes the view over. */
  id: string
  /** Shown in the bridge's title bar, in the tiny font (capitals, digits, - . : / + %). */
  title: string
  /** Pictures a second, 1..5 (the glass redraws at 5). Default 2. */
  fps?: number
  /** Ask the bridge to show this view while the radio is keyed. */
  focusOnTx?: boolean
  /** Draws the view. Rows 0..8 are the bridge's title bar: start at LCD_BODY_TOP. */
  render(g: Gfx, tick: number): void
}

export type LcdSourceState = 'waiting' | 'live' | 'full'

export interface LcdFeedState {
  connected: boolean
  /** The view on the glass: a built-in name, a client view's id, or "overlay". */
  showing: string | null
  sources: Record<string, LcdSourceState>
}

const TICK_MS = 200
/** The slot byte of an overlay frame (status_display.h). */
const OVERLAY_SLOT = 0xff
const KEEPALIVE_MS = 4000
const RETRY_MS = 5000

interface Entry {
  source: LcdSource
  slot: number | null
  full: boolean
  last: Uint8Array | null
  sentAt: number
  /** show() came before the bridge had a picture: ask again after the first one. */
  showPending: boolean
  /** Register requests for this id not answered yet: only the reply to the last one counts. */
  awaiting: number
}

export class LcdFeed {
  private ws: WebSocket | null = null
  private readonly entries = new Map<string, Entry>()
  private readonly g = new Gfx()
  private tick = 0
  private timer: ReturnType<typeof setInterval> | null = null
  private retry: ReturnType<typeof setTimeout> | null = null
  private closed = false
  private showing: string | null = null
  private ovl: { render: (g: Gfx, tick: number) => void; until: number } | null = null

  /** url: ws://<bridge>/display-ws. onState: called whenever the state changes. */
  constructor(private readonly url: string, private readonly onState: (s: LcdFeedState) => void = () => {}) {
    this.connect()
    this.timer = setInterval(() => this.step(), TICK_MS)
  }

  /** Adds a view; returns a function that removes it. */
  add(source: LcdSource): () => void {
    const old = this.entries.get(source.id)
    if (old) this.remove(source.id)
    const e: Entry = { source, slot: null, full: false, last: null, sentAt: 0, showPending: false, awaiting: old?.awaiting ?? 0 }
    this.entries.set(source.id, e)
    this.register(e)
    this.publish()
    return () => this.remove(source.id)
  }

  /** Asks the bridge to show a view now (a built-in name or a client view's id).
   *  One of this feed's own views is shown once the bridge has its first picture. */
  show(view: string): void {
    const e = this.entries.get(view)
    if (e && !e.last) { e.showPending = true; return }
    this.send(JSON.stringify({ show: view }))
  }

  /**
   * Lays a picture over whatever view is on the glass for durationMs, like
   * the bridge's own upload overlay: render draws it (into the OVERLAY_* panel), redrawn
   * and sent every tick so it can animate. A new overlay replaces the old.
   */
  overlay(render: (g: Gfx, tick: number) => void, durationMs: number): void {
    this.ovl = { render, until: Date.now() + durationMs }
  }

  close(): void {
    this.closed = true
    if (this.timer) clearInterval(this.timer)
    if (this.retry) clearTimeout(this.retry)
    this.ws?.close()
    this.ws = null
  }

  private remove(id: string): void {
    if (!this.entries.delete(id)) return
    this.send(JSON.stringify({ unregister: id }))
    this.publish()
  }

  private connect(): void {
    if (this.closed) return
    const ws = new WebSocket(this.url)
    ws.binaryType = 'arraybuffer'
    this.ws = ws
    ws.onopen = () => {
      for (const e of this.entries.values()) {
        e.slot = null
        e.full = false
        e.last = null
        e.awaiting = 0
        this.register(e)
      }
      this.publish()
    }
    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string') return // the frame on the glass; not used here
      let m: { slot?: number; id?: string; error?: string; showing?: string; client_views?: unknown[] }
      try { m = JSON.parse(ev.data) } catch { return }
      const e = m.id !== undefined ? this.entries.get(m.id) : undefined
      const reply = e && (typeof m.slot === 'number' || m.error === 'full')
      if (reply && e.awaiting > 0) e.awaiting--
      if (reply && e.awaiting === 0) {
        if (typeof m.slot === 'number') { e.slot = m.slot; e.full = false; e.last = null }
        else { e.slot = null; e.full = true }
      }
      if (m.showing !== undefined) this.showing = m.showing
      // The bridge's list changed: a slot may have come free for a view it refused.
      if (Array.isArray(m.client_views)) {
        for (const f of this.entries.values()) if (f.full && f.awaiting === 0) this.register(f)
      }
      this.publish()
    }
    ws.onclose = () => {
      if (this.ws === ws) this.ws = null
      for (const e of this.entries.values()) e.slot = null
      this.publish()
      if (!this.closed) this.retry = setTimeout(() => this.connect(), RETRY_MS)
    }
  }

  private register(e: Entry): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return
    e.awaiting++
    const s = e.source
    this.send(JSON.stringify({ register: s.id, title: s.title, focus_on_tx: !!s.focusOnTx }))
  }

  private send(data: string | Uint8Array<ArrayBuffer>): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(data)
  }

  private step(): void {
    this.tick++
    if (this.ws?.readyState !== WebSocket.OPEN) return
    const now = Date.now()
    if (this.ovl && now >= this.ovl.until) this.ovl = null
    if (this.ovl) {
      this.g.clear()
      try {
        this.ovl.render(this.g, this.tick)
        const msg = new Uint8Array(1 + LCD_BODY_BYTES)
        msg[0] = OVERLAY_SLOT
        msg.set(this.g.body(), 1)
        this.send(msg)
      } catch { this.ovl = null }
    }
    for (const e of this.entries.values()) {
      if (e.slot === null) continue
      const fps = Math.min(5, Math.max(1, e.source.fps ?? 2))
      if (this.tick % Math.round(5 / fps) !== 0) continue
      this.g.clear()
      try { e.source.render(this.g, this.tick) } catch {
        // A box that cannot be read (a cross-origin canvas, say): say so on the glass.
        this.g.clear()
        const t = 'CANNOT DRAW THIS BOX'
        this.g.tiny((LCD_W - this.g.tinyWidth(t)) >> 1, LCD_BODY_TOP + 16, t, ON)
      }
      const body = this.g.body()
      if (e.last && now - e.sentAt < KEEPALIVE_MS && body.every((b, i) => b === e.last![i])) continue
      const msg = new Uint8Array(1 + LCD_BODY_BYTES)
      msg[0] = e.slot
      msg.set(body, 1)
      this.send(msg)
      e.last = body.slice()
      e.sentAt = now
      if (e.showPending) { e.showPending = false; this.send(JSON.stringify({ show: e.source.id })) }
    }
  }

  private publish(): void {
    const sources: Record<string, LcdSourceState> = {}
    for (const [id, e] of this.entries) sources[id] = e.full ? 'full' : e.slot !== null ? 'live' : 'waiting'
    this.onState({ connected: this.ws?.readyState === WebSocket.OPEN, showing: this.showing, sources })
  }
}

/** ws://<host>/cat (the app's bridge address) -> ws://<host>/display-ws. */
export function lcdFeedUrl(bridgeWsUrl: string): string | null {
  try {
    const u = new URL(bridgeWsUrl)
    if (u.protocol !== 'ws:' && u.protocol !== 'wss:') return null
    u.pathname = '/display-ws'
    u.search = ''
    return u.toString()
  } catch {
    return null
  }
}
