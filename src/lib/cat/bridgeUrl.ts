// The CAT bridge address, as the operator types it and as the app uses it.
//
// The field stores the bridge's address, ws(s)://host[:port]: a bare host or
// IP gets ws://, http(s):// becomes ws(s)://, and a trailing /cat (or /) is
// dropped, so it never shows up in the field. The CAT WebSocket is that
// address + /cat, added only when connecting (bridgeCatUrl()). An explicit
// other path is kept, for a bridge serving CAT elsewhere.
export function normalizeBridgeAddress(raw: string): string {
  let t = raw.trim()
  if (t === '') return ''
  if (t.startsWith('https://')) t = 'wss://' + t.slice('https://'.length)
  else if (t.startsWith('http://')) t = 'ws://' + t.slice('http://'.length)
  else if (!/^wss?:\/\//.test(t)) t = 'ws://' + t
  const m = /^(wss?:\/\/[^/?#]+)(\/[^?#]*)?(.*)$/.exec(t)
  if (!m) return t
  const path = !m[2] || m[2] === '/' || m[2] === '/cat' || m[2] === '/cat/' ? '' : m[2]
  return m[1] + path + m[3]
}

/** The CAT WebSocket URL for a bridge address (normalized first). */
export function bridgeCatUrl(address: string | undefined): string {
  const a = normalizeBridgeAddress(address ?? '')
  if (a === '') return ''
  return /^wss?:\/\/[^/?#]+$/.test(a) ? a + '/cat' : a
}
