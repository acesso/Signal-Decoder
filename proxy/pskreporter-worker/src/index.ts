/**
 * Cloudflare Worker that relays PSK Reporter reception reports from the browser.
 *
 * PSK Reporter's documented ingest is UDP, and a Worker cannot send UDP — the
 * `connect()` API in `cloudflare:sockets` is TCP-only. It turns out the
 * collector also accepts the same IPFIX messages over TCP on the same ports
 * (RFC 7011 section 10.4), which is what makes this Worker viable at all.
 *
 * The browser builds the IPFIX bytes (src/lib/ft/pskreporter/ipfix.ts) and POSTs
 * them here. This Worker's job is to be a narrow door, not a generic proxy: the
 * destination is hard-coded, and a body that is not a well-formed PSK Reporter
 * message is rejected rather than forwarded, so this cannot be used as a
 * reflector.
 */
import { connect } from 'cloudflare:sockets'

const PSKREPORTER_HOST = 'report.pskreporter.info'
const PSKREPORTER_PORT = 4739
/**
 * The collector's test listener. It parses whatever it receives and publishes
 * the result at /cgi-bin/psk-analysis.pl instead of recording spots, so the
 * whole browser -> Worker -> collector path can be exercised without putting
 * invented spots on the live map. Reached with `POST /report?test=1`.
 */
const PSKREPORTER_TEST_PORT = 14739

/**
 * The analysis page keys on the requesting IP, and a relayed packet arrives
 * from Cloudflare's address rather than yours — so fetching it from a
 * workstation shows nothing. `GET /analysis` fetches it from here instead,
 * which is the only vantage point that can see what the collector made of a
 * packet this Worker sent. Purely diagnostic.
 */
// Note the host: report.pskreporter.info serves this CGI over plain HTTP only
// and answers 404 on HTTPS, so the apex domain is used instead.
const ANALYSIS_URL = 'https://pskreporter.info/cgi-bin/psk-analysis.pl'

/**
 * The only pages allowed to use this relay. The published app lives at
 * https://acesso.github.io/Signal-Decoder/; the localhost entries are the dev
 * server (3000) and the one reserved for automated runs (3002).
 *
 * Only the origin is matched, not the path, because the dev server serves the
 * app from the root while Pages serves it from a subdirectory.
 */
const ALLOWED_ORIGINS = new Set([
  'https://acesso.github.io',
  'http://localhost:3000',
  'http://localhost:3002',
])

/**
 * Both `Origin` and `Referer` are checked, and they do different jobs.
 *
 * `Origin` is the load-bearing one: browsers set it on every cross-origin POST
 * and refuse to let page scripts override it, so another website cannot point
 * its visitors at this relay. `Referer` is checked as a second gate, but it is
 * only advisory — a referrer policy can strip it entirely, so its absence
 * cannot be treated as failure, and a present-but-foreign value is the only
 * thing it can prove.
 *
 * Neither is authentication. Any HTTP client outside a browser sets both
 * freely. What actually stops this Worker being abused is that it forwards
 * only to one hard-coded host and only if the body parses as a PSK Reporter
 * message; see validatePacket below.
 */
function originAllowed(origin: string | null): boolean {
  return origin !== null && ALLOWED_ORIGINS.has(origin)
}

function refererAllowed(referer: string | null): boolean {
  if (referer === null) return true // stripped by referrer policy — Origin still had to pass
  try {
    return ALLOWED_ORIGINS.has(new URL(referer).origin)
  } catch {
    return false // unparseable Referer is not something a browser sends
  }
}

const IPFIX_VERSION = 0x000a
const MAX_PACKET_BYTES = 1400

const SET_TEMPLATE = 0x0002
const SET_OPTIONS_TEMPLATE = 0x0003
const SET_RECEIVER_DATA = 0x9992
const SET_SENDER_DATA = 0x9993

const ALLOWED_SET_IDS = new Set([SET_TEMPLATE, SET_OPTIONS_TEMPLATE, SET_RECEIVER_DATA, SET_SENDER_DATA])

interface Env {
  /** Cloudflare rate-limiting binding; see wrangler.toml. */
  PSK_RATE_LIMIT?: { limit(o: { key: string }): Promise<{ success: boolean }> }
}

interface Validation {
  ok: boolean
  reason?: string
  /** Receiver callsign, pulled out for rate-limit keying. */
  receiver?: string
}

/**
 * Walks the IPFIX set list. Accepts only PSK Reporter's four set ids, requires
 * the declared length to match the body exactly, and requires a receiver record
 * to be present — arbitrary bytes cannot survive this.
 */
function validatePacket(bytes: Uint8Array): Validation {
  if (bytes.length < 20) return { ok: false, reason: 'too short' }
  if (bytes.length > MAX_PACKET_BYTES) return { ok: false, reason: 'too long' }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (view.getUint16(0) !== IPFIX_VERSION) return { ok: false, reason: 'not IPFIX v10' }
  if (view.getUint16(2) !== bytes.length) return { ok: false, reason: 'header length mismatch' }

  let receiver: string | undefined
  let at = 16

  while (at < bytes.length) {
    if (at + 4 > bytes.length) return { ok: false, reason: 'truncated set header' }

    const setId = view.getUint16(at)
    const setLength = view.getUint16(at + 2)

    if (!ALLOWED_SET_IDS.has(setId)) return { ok: false, reason: `unexpected set id ${setId}` }
    if (setLength < 4 || at + setLength > bytes.length) return { ok: false, reason: 'bad set length' }

    if (setId === SET_RECEIVER_DATA && receiver === undefined) {
      // First field of the receiver record is the variable-length callsign.
      const lengthByte = bytes[at + 4]
      if (lengthByte > 0 && at + 5 + lengthByte <= at + setLength) {
        receiver = new TextDecoder().decode(bytes.subarray(at + 5, at + 5 + lengthByte))
      }
    }

    at += setLength
  }

  if (at !== bytes.length) return { ok: false, reason: 'trailing bytes' }
  if (receiver === undefined) return { ok: false, reason: 'no receiver record' }
  if (!/^[A-Z0-9/]{3,16}$/i.test(receiver)) return { ok: false, reason: 'bad receiver callsign' }

  return { ok: true, receiver }
}

function corsHeaders(origin: string | null): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': origin ?? '',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  }
}

/** Opens a TCP socket to the collector and writes the message. There is no reply to read. */
async function forward(packet: Uint8Array, port: number): Promise<void> {
  const socket = connect({ hostname: PSKREPORTER_HOST, port })
  const writer = socket.writable.getWriter()
  try {
    await writer.write(packet)
    await writer.close()
  } finally {
    await socket.close().catch(() => {})
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    const origin = request.headers.get('Origin')

    /**
     * Confirms Cloudflare's egress can reach the collector at all. This is the
     * one thing that cannot be tested from a workstation, because Cloudflare's
     * network is not yours.
     */
    if (url.pathname === '/health') {
      try {
        const socket = connect({ hostname: PSKREPORTER_HOST, port: PSKREPORTER_PORT })
        await socket.opened
        await socket.close()
        return new Response(`reachable: tcp ${PSKREPORTER_HOST}:${PSKREPORTER_PORT}\n`)
      } catch (err) {
        return new Response(`unreachable: ${(err as Error).message}\n`, { status: 502 })
      }
    }

    /**
     * Diagnostic: what the collector parsed out of packets sent from this
     * Worker's address. Only meaningful right after a `?test=1` report.
     */
    if (url.pathname === '/analysis') {
      const res = await fetch(ANALYSIS_URL, { headers: { 'user-agent': 'signal-decoder-relay' } })
      return new Response(await res.text(), {
        status: res.status,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      })
    }

    if (request.method === 'OPTIONS') {
      // Preflight carries no Referer, so Origin is the whole check here.
      if (!originAllowed(origin)) return new Response(null, { status: 403 })
      return new Response(null, { status: 204, headers: corsHeaders(origin) })
    }

    if (url.pathname !== '/report' || request.method !== 'POST') {
      return new Response('not found\n', { status: 404 })
    }

    if (!originAllowed(origin)) {
      return new Response('forbidden origin\n', { status: 403 })
    }
    if (!refererAllowed(request.headers.get('Referer'))) {
      return new Response('forbidden referer\n', { status: 403 })
    }

    const cors = corsHeaders(origin)
    const packet = new Uint8Array(await request.arrayBuffer())

    const check = validatePacket(packet)
    if (!check.ok) {
      return new Response(`rejected: ${check.reason}\n`, { status: 400, headers: cors })
    }

    if (env.PSK_RATE_LIMIT) {
      const { success } = await env.PSK_RATE_LIMIT.limit({ key: check.receiver!.toUpperCase() })
      if (!success) return new Response('rate limited\n', { status: 429, headers: cors })
    }

    // ?test=1 diverts to the analysis listener so a test packet never reaches
    // the live map. The app never sets it.
    const port = url.searchParams.get('test') === '1' ? PSKREPORTER_TEST_PORT : PSKREPORTER_PORT
    try {
      await forward(packet, port)
    } catch (err) {
      return new Response(`upstream failed: ${(err as Error).message}\n`, { status: 502, headers: cors })
    }

    return new Response(null, { status: 204, headers: cors })
  },
}
