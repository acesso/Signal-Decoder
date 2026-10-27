// What a bridge can do and how it's routed — GET /capabilities and GET/POST
// /routing (firmware/esp32-cat-bridge/main/io_routing.h). Older firmware has
// neither; both are then derived from GET /info features and GET /status, so
// the app treats every bridge the same way.

export type StreamKind = 'audio' | 'iq'

export interface BridgeChannel { id: string; label: string }

export interface BridgeInput {
  id: string
  chip: string
  jack: string
  kinds: StreamKind[]
  rateHz: number
  bits: number
  channels: BridgeChannel[]
}

export interface BridgeOutput {
  id: string
  chip: string
  jack: string
  rateHz: number
  channels: string[]
  /** 'slots' = scheduled transmissions uploaded to the bridge. */
  delivery: string[]
  slots: number
}

export interface BridgeDsp {
  /** The bridge decimates the I/Q passband itself (/iq-passband). */
  iqPassbandRatesHz: number[]
  /** The bridge computes the spectrum itself (/iq-spectrum). */
  iqSpectrum: boolean
  iqCorrections: string[]
  dcRemoval: boolean
  imbalanceCorrection: boolean
}

export interface BridgeCapabilities {
  board: string
  /** The bridge's hardware, e.g. "ESP32-S3-N16R8" (older firmware: derived from board). */
  model: string
  firmwareVersion: string
  pa: { sense: boolean; emergency: boolean }
  /** True when audio and I/Q can stream at the same time (separate ADCs). */
  concurrentInputs: boolean
  /** How the input kind changes on a single-codec bridge. */
  inputKindSwitch: 'live' | 'reboot'
  inputs: BridgeInput[]
  outputs: BridgeOutput[]
  dsp: BridgeDsp | null
  /** Derived from /info + /status (firmware before /capabilities). */
  legacy: boolean
}

export interface BridgeRouting {
  iq: { input: string | null; rateHz: number }
  audio: { input: string | null; channel: string; rateHz: number }
  tx: { output: string | null; channel: string }
  rebootRequired: boolean
}

/** A partial routing change, as POST /routing takes it. */
export interface RoutingPatch {
  iq?: { input?: string }
  audio?: { input?: string; channel?: string }
  tx?: { output?: string; channel?: string }
}

const MODELS: Record<string, string> = { s3: 'ESP32-S3-N16R8', a1s: 'ESP32-A1S (ES8388)' }
const modelFor = (board: string) => MODELS[board] ?? (board ? `${board} bridge` : 'unknown bridge')

const num = (v: unknown, d = 0) => (typeof v === 'number' ? v : d)
const str = (v: unknown, d = '') => (typeof v === 'string' ? v : d)
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])

async function getJson(url: string): Promise<Record<string, unknown> | null> {
  try {
    const r = await fetch(url)
    return r.ok ? ((await r.json()) as Record<string, unknown>) : null
  } catch {
    return null
  }
}

export function parseCapabilities(j: Record<string, unknown>): BridgeCapabilities {
  const pa = (j.pa ?? {}) as Record<string, unknown>
  const dsp = j.dsp as Record<string, unknown> | null | undefined
  const pb = (dsp?.iq_passband ?? null) as Record<string, unknown> | null
  return {
    board: str(j.board),
    model: str(j.model, modelFor(str(j.board))),
    firmwareVersion: str(j.firmware_version),
    pa: { sense: pa.sense === true, emergency: pa.emergency === true },
    concurrentInputs: j.concurrent_inputs === true,
    inputKindSwitch: j.input_kind_switch === 'reboot' ? 'reboot' : 'live',
    inputs: arr(j.inputs).map((x) => {
      const i = x as Record<string, unknown>
      return {
        id: str(i.id), chip: str(i.chip), jack: str(i.jack),
        kinds: arr(i.kinds).filter((k): k is StreamKind => k === 'audio' || k === 'iq'),
        rateHz: num(i.rate_hz), bits: num(i.bits),
        channels: arr(i.channels).map((c) => {
          const ch = c as Record<string, unknown>
          return typeof c === 'string' ? { id: c, label: c } : { id: str(ch.id), label: str(ch.label, str(ch.id)) }
        }),
      }
    }),
    outputs: arr(j.outputs).map((x) => {
      const o = x as Record<string, unknown>
      return {
        id: str(o.id), chip: str(o.chip), jack: str(o.jack), rateHz: num(o.rate_hz),
        channels: arr(o.channels).map((c) => str(c)), delivery: arr(o.delivery).map((d) => str(d)), slots: num(o.slots),
      }
    }),
    dsp: dsp
      ? {
          iqPassbandRatesHz: arr(pb?.rates_hz).map((r) => num(r)).filter((r) => r > 0),
          iqSpectrum: !!dsp.iq_spectrum,
          iqCorrections: arr(dsp.iq_corrections).map((c) => str(c)),
          dcRemoval: dsp.dc_removal === true,
          imbalanceCorrection: dsp.imbalance_correction === true,
        }
      : null,
    legacy: false,
  }
}

export function parseRouting(j: Record<string, unknown>): BridgeRouting {
  const iq = (j.iq ?? {}) as Record<string, unknown>
  const audio = (j.audio ?? {}) as Record<string, unknown>
  const tx = (j.tx ?? {}) as Record<string, unknown>
  return {
    iq: { input: typeof iq.input === 'string' ? iq.input : null, rateHz: num(iq.rate_hz) },
    audio: { input: typeof audio.input === 'string' ? audio.input : null, channel: str(audio.channel, 'left'), rateHz: num(audio.rate_hz) },
    tx: { output: typeof tx.output === 'string' ? tx.output : null, channel: str(tx.channel, 'both') },
    rebootRequired: j.reboot_required === true,
  }
}

/** Older firmware: one codec input that carries audio or I/Q (input_mode). */
function legacyCapabilities(info: Record<string, unknown>, status: Record<string, unknown> | null): BridgeCapabilities {
  const features = arr(info.features).map((f) => str(f))
  const has = (f: string) => features.includes(f)
  const dspBridge = has('iq_spectrum') && has('iq_passband')
  const rate = num(status?.sample_rate_hz, 48000)
  return {
    board: str(info.board, 'unknown'),
    model: modelFor(str(info.board)),
    firmwareVersion: str(info.firmware_version),
    pa: { sense: has('pa_watchdog'), emergency: has('pa_watchdog') },
    concurrentInputs: false,
    inputKindSwitch: has('input_mode_select') ? 'reboot' : 'live',
    inputs: [{
      id: 'codec', chip: 'codec', jack: 'line in',
      kinds: dspBridge ? ['iq'] : has('input_mode_select') ? ['audio', 'iq'] : ['audio'],
      rateHz: rate, bits: 16, channels: [{ id: 'left', label: 'left' }, { id: 'right', label: 'right' }],
    }],
    outputs: has('tx_buffer_playback')
      ? [{ id: 'codec', chip: 'codec', jack: 'line out', rateHz: rate, channels: ['left', 'right', 'both'], delivery: ['slots', 'stream'], slots: 4 }]
      : [],
    dsp: dspBridge ? { iqPassbandRatesHz: [6000, 12000, 24000], iqSpectrum: true, iqCorrections: ['none', 'swap', 'negateI', 'negateQ'], dcRemoval: true, imbalanceCorrection: false } : null,
    legacy: true,
  }
}

function legacyRouting(status: Record<string, unknown> | null, caps: BridgeCapabilities): BridgeRouting {
  const iqMode = caps.dsp !== null || status?.input_mode === 'iq'
  const rate = num(status?.sample_rate_hz, 48000)
  return {
    iq: { input: iqMode ? 'codec' : null, rateHz: rate },
    audio: { input: iqMode ? null : 'codec', channel: status?.rx_slot_right === true ? 'right' : 'left', rateHz: rate },
    tx: { output: caps.outputs[0]?.id ?? null, channel: str(status?.tx_slot, 'both') },
    rebootRequired: false,
  }
}

/** Reads both, falling back to /info + /status on older firmware. null when
 *  the bridge isn't reachable at all. */
export async function fetchBridgeDescription(base: string): Promise<{ capabilities: BridgeCapabilities; routing: BridgeRouting } | null> {
  const caps = await getJson(`${base}/capabilities`)
  if (caps) {
    const routing = await getJson(`${base}/routing`)
    const c = parseCapabilities(caps)
    return { capabilities: c, routing: routing ? parseRouting(routing) : legacyRouting(null, c) }
  }
  const info = await getJson(`${base}/info`)
  if (!info) return null
  const status = await getJson(`${base}/status`)
  const c = legacyCapabilities(info, status)
  return { capabilities: c, routing: legacyRouting(status, c) }
}

/** Applies a routing change; resolves with the new routing, or throws with
 *  the bridge's own error text. */
export async function postRouting(base: string, patch: RoutingPatch): Promise<BridgeRouting> {
  const r = await fetch(`${base}/routing`, { method: 'POST', body: JSON.stringify(patch) })
  const text = await r.text()
  if (!r.ok) throw new Error(text || `HTTP ${r.status}`)
  return parseRouting(JSON.parse(text) as Record<string, unknown>)
}

/** Inputs that can feed a stream of `kind`. */
export function inputsFor(caps: BridgeCapabilities | null, kind: StreamKind): BridgeInput[] {
  return caps ? caps.inputs.filter((i) => i.kinds.includes(kind)) : []
}
