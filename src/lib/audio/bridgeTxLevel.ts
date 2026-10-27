// The bridge's DAC output level (GET/POST /dac-level, the S3's "dac_level"
// feature) as the TX level for every mode while the TX output is the bridge.
//
// One DAC, one level: the TX panels' "TX Level" sliders read and set this
// instead of their own per-mode gain, and the modes send their audio at full
// scale. The level lives on the bridge (saved there), so its control page,
// this app and any other client all see the same value. With the TX output on
// the sound card, or a bridge without /dac-level, each mode keeps its own gain.
import { createRoot, createSignal } from 'solid-js'
import { txSink } from './txSink'

const DAC_LEVEL_MIN_DB = -60
const POST_DEBOUNCE_MS = 250

/** ws(s)://host[...] -> http(s)://host */
function httpBase(bridgeWsUrl: string): string | null {
  try {
    const u = new URL(bridgeWsUrl)
    if (u.protocol !== 'ws:' && u.protocol !== 'wss:') return null
    return `${u.protocol === 'wss:' ? 'https:' : 'http:'}//${u.host}`
  } catch {
    return null
  }
}

export const bridgeTxLevel = createRoot(() => {
  const [base, setBase] = createSignal<string | null>(null)
  const [supported, setSupported] = createSignal(false)
  const [db, setDbSig] = createSignal(0)
  let postTimer: ReturnType<typeof setTimeout> | null = null

  async function refresh() {
    const b = base()
    if (!b) { setSupported(false); return }
    try {
      const r = await fetch(`${b}/dac-level`)
      if (!r.ok) { setSupported(false); return }
      const j = (await r.json()) as { db?: unknown }
      if (typeof j.db !== 'number') { setSupported(false); return }
      setDbSig(j.db)
      setSupported(true)
    } catch {
      setSupported(false)
    }
  }

  return {
    /** True when the TX sliders drive the bridge's level (and modes send at full scale). */
    active: () => supported() && txSink.kind() === 'bridge',
    db,
    /** Points at a bridge (its CAT/bridge ws:// address), or none; reads its level. */
    attach(bridgeWsUrl: string | undefined) {
      const b = bridgeWsUrl ? httpBase(bridgeWsUrl) : null
      if (b === base()) return
      setBase(b)
      void refresh()
    },
    refresh,
    /** Sets the level (dB, -60..0); the slider follows at once, the POST is debounced. */
    set(v: number) {
      const clamped = Math.max(DAC_LEVEL_MIN_DB, Math.min(0, Math.round(v)))
      setDbSig(clamped)
      if (postTimer) clearTimeout(postTimer)
      postTimer = setTimeout(() => {
        postTimer = null
        const b = base()
        if (b) void fetch(`${b}/dac-level`, { method: 'POST', body: JSON.stringify({ db: clamped }) }).catch(() => {})
      }, POST_DEBOUNCE_MS)
    },
  }
})

/** The gain a mode should apply itself: unity while the bridge's level is the TX level. */
export function modeTxGain(ownGain: number): number {
  return bridgeTxLevel.active() ? 1 : ownGain
}
