/**
 * GET /heard: who reported a callsign's transmissions, from PSK Reporter's
 * query API (https://pskreporter.info/pskdev.html), for the app's Sent Log
 * (doc/plans/tx-heard/PLAN.md).
 *
 * The query API answers XML without CORS headers, so a page cannot read it;
 * this route reads it for the page and answers small JSON. Pure functions
 * only: the Worker (index.ts) and the dev server (vite.config.ts) both use
 * them, each with its own fetch and cache.
 */

/** One reception report of the sender's signal. */
export interface HeardReport {
  /** Receiving station. */
  rx: string
  /** Its locator, as reported (4 to 10 characters), or ''. */
  grid: string
  /** Frequency it decoded on, Hz. */
  hz: number
  /** Start of the decoded window, Unix seconds. */
  t: number
  /** SNR, dB, or null when not reported. */
  snr: number | null
  /** PSK Reporter's DXCC name of the receiver ("United States"), or ''. */
  dxcc: string
  mode: string
}

export interface HeardResponse {
  /** When PSK Reporter was asked, Unix seconds. */
  at: number
  reports: HeardReport[]
}

/** How far back each query looks. The app follows a TX for 30 minutes. */
export const HEARD_LOOKBACK_S = 3600
/** One upstream query per callsign per this long, whoever asks. */
export const HEARD_CACHE_S = 300
/** After PSK Reporter refuses (429/503), nothing is asked for this long. */
export const HEARD_BACKOFF_S = 900

const CALLSIGN = /^[A-Z0-9]{1,4}\/?[A-Z0-9]{1,8}(\/[A-Z0-9]{1,4})?$/

/** The callsign in capitals when it looks like one, else null. */
export function cleanCallsign(raw: string | null): string | null {
  const c = (raw ?? '').trim().toUpperCase()
  return c.length >= 3 && c.length <= 16 && CALLSIGN.test(c) && /\d/.test(c) ? c : null
}

/** The upstream query for a callsign. appContact: the project's contact address, or ''. */
export function upstreamUrl(call: string, appContact: string): string {
  const q = new URLSearchParams({ senderCallsign: call, rronly: '1', flowStartSeconds: String(-HEARD_LOOKBACK_S) })
  if (appContact) q.set('appcontact', appContact)
  return `https://retrieve.pskreporter.info/query?${q}`
}

const ATTR = /(\w+)="([^"]*)"/g

const unescape = (s: string) =>
  s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')

/**
 * The receptionReport elements of a query answer, for the sender `call`.
 * A Worker has no DOMParser; the elements are flat, attribute-only tags, so
 * a tag-by-tag read is enough. Anything malformed is skipped, not fatal.
 */
export function parseReports(xml: string, call: string): HeardReport[] {
  const out: HeardReport[] = []
  for (const tag of xml.match(/<receptionReport\s[^>]*>/g) ?? []) {
    const a: Record<string, string> = {}
    for (const m of tag.matchAll(ATTR)) a[m[1]] = unescape(m[2])
    if ((a.senderCallsign ?? '').toUpperCase() !== call) continue
    const hz = Number(a.frequency), t = Number(a.flowStartSeconds)
    const rx = (a.receiverCallsign ?? '').toUpperCase()
    if (!rx || !Number.isFinite(hz) || !Number.isFinite(t)) continue
    const snr = a.sNR !== undefined && a.sNR !== '' && Number.isFinite(Number(a.sNR)) ? Number(a.sNR) : null
    out.push({ rx, grid: a.receiverLocator ?? '', hz, t, snr, dxcc: a.receiverDXCC ?? '', mode: (a.mode ?? '').toUpperCase() })
  }
  return out
}
