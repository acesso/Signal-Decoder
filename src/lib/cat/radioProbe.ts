// Probe: ask a radio who it is and what it answers, without connecting the
// app — over USB serial (Web Serial) or through a CAT bridge's WebSocket.
//
//   ID;  model code (Kenwood convention; the uSDX answers as a TS-480, 020)
//   FV;  firmware version
//   CL;  capability report: every read-only query the radio supports
//        (catCapabilities.ts). Older firmware answers "?;".
import { parseQueryList, LEGACY_POLL_CMDS, type QueryListReply } from './catCapabilities'

export interface RadioReport {
  /** Raw ID; answer, e.g. "020". null when unanswered. */
  id: string | null
  model: string | null
  firmware: string | null
  /** CL; answer: the listed queries, 'unsupported' (older firmware), or null. */
  queries: QueryListReply
}

const MODELS: Record<string, string> = {
  '019': 'Kenwood TS-2000',
  '020': 'Kenwood TS-480 (or a radio emulating it, e.g. uSDX)',
  '021': 'Kenwood TS-590S',
  '023': 'Kenwood TS-590SG',
}

/** What each read-only query reads, for showing a capability list. */
export const QUERY_LABELS: Record<string, string> = {
  FA: 'VFO frequency', FB: 'VFO B frequency', MD: 'Mode', IF: 'Status block', AG: 'AF gain', FW: 'Filter width',
  VO: 'Volume', AT: 'Attenuator', A2: 'Attenuator 2', NR: 'Noise reduction', SM: 'S-meter', DR: 'TX drive',
  BL: 'Backlight', AL: 'AGC', DG: 'Diagnostic mode', TU: 'Tune', TA: 'TX timeout', PM: 'PA bias (min)',
  PX: 'PA bias (max)', CL: 'Capability report', FV: 'Firmware version', ID: 'Model ID', TX: 'Transmit', RX: 'Receive',
  PS: 'Power status', AI: 'Auto information', SH: 'Filter high cut', SL: 'Filter low cut', RA: 'Attenuator', PA: 'Preamp',
}

/** Parses the replies collected for ID;, FV; and CL;. Exported for tests. */
export function reportFromFrames(frames: string[]): RadioReport {
  const id = frames.map((f) => /^ID(\d+);$/.exec(f)?.[1]).find(Boolean) ?? null
  const firmware = frames.map((f) => /^FV(.+);$/.exec(f)?.[1]).find(Boolean) ?? null
  let queries: QueryListReply = null
  for (const f of frames) {
    const q = parseQueryList(f)
    if (q !== null) { queries = q; break }
  }
  return { id, model: id ? MODELS[id] ?? `unknown model (ID${id})` : null, firmware, queries }
}

/** The queries the app will use for this radio: its own list, or the fixed
 *  list every older uSDX firmware answers. */
export function effectiveQueries(r: RadioReport): string[] {
  return Array.isArray(r.queries) ? r.queries : LEGACY_POLL_CMDS.map((c) => c.replace(/;$/, ''))
}

/** Splits a byte stream into ";"-terminated frames, keeping the remainder. */
function takeFrames(buf: string): { frames: string[]; rest: string } {
  const frames: string[] = []
  let start = 0
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === ';') { frames.push(buf.slice(start, i + 1).trim()); start = i + 1 }
  }
  return { frames, rest: buf.slice(start) }
}

const PROBE_CMDS = ['ID;', 'FV;', 'CL;']

/** Sends each query and gathers frames for up to `perCmdMs` after it. */
async function exchange(send: (s: string) => Promise<void>, frames: string[], perCmdMs: number): Promise<void> {
  for (const cmd of PROBE_CMDS) {
    await send(cmd)
    const want = cmd.slice(0, 2)
    const deadline = Date.now() + perCmdMs
    while (Date.now() < deadline && !frames.some((f) => f.startsWith(want) || f === '?;')) {
      await new Promise((r) => setTimeout(r, 25))
    }
  }
}

/** Probe through a CAT bridge: opens its CAT WebSocket, asks, closes. null
 *  when the socket doesn't open. A radio that doesn't answer (none connected
 *  to the bridge) gives a report with every field null. */
export async function probeRadioOverWebSocket(catUrl: string, perCmdMs = 700): Promise<RadioReport | null> {
  return new Promise((resolve) => {
    let sock: WebSocket
    try { sock = new WebSocket(catUrl) } catch { resolve(null); return }
    const frames: string[] = []
    let rest = ''
    const giveUp = setTimeout(() => { try { sock.close() } catch { /* closed */ } resolve(null) }, 4000)
    sock.binaryType = 'arraybuffer'
    sock.onmessage = (ev) => {
      const text = typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(ev.data as ArrayBuffer)
      const t = takeFrames(rest + text)
      frames.push(...t.frames)
      rest = t.rest
    }
    sock.onerror = () => { clearTimeout(giveUp); resolve(null) }
    sock.onopen = async () => {
      clearTimeout(giveUp)
      await exchange(async (s) => sock.send(s), frames, perCmdMs)
      sock.close()
      resolve(reportFromFrames(frames))
    }
  })
}

export interface SerialSettings { baudRate: number; dataBits: number; stopBits: number; parity: 'none' | 'even' | 'odd' }

/** Probe over USB serial: the caller picks the port (requestPort needs the
 *  click's user activation). Opens, asks, closes; the port stays granted, so
 *  Connect can reuse it. */
export async function probeRadioOverSerial(port: SerialPort, s: SerialSettings, perCmdMs = 700): Promise<RadioReport> {
  await port.open({ baudRate: s.baudRate, dataBits: s.dataBits as 7 | 8, stopBits: s.stopBits as 1 | 2, parity: s.parity, flowControl: 'none' })
  const frames: string[] = []
  const writer = port.writable!.getWriter()
  const reader = port.readable!.getReader()
  let rest = ''
  let reading = true
  const pump = (async () => {
    const dec = new TextDecoder()
    while (reading) {
      const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }))
      if (done) break
      if (value) {
        const t = takeFrames(rest + dec.decode(value))
        frames.push(...t.frames)
        rest = t.rest
      }
    }
  })()
  try {
    await exchange(async (cmd) => writer.write(new TextEncoder().encode(cmd)), frames, perCmdMs)
  } finally {
    reading = false
    await reader.cancel().catch(() => null)
    await pump
    reader.releaseLock()
    writer.releaseLock()
    await port.close().catch(() => null)
  }
  return reportFromFrames(frames)
}
