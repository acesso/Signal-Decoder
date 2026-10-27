// One TX output for every transmit mode (FT8/FT4, RTTY, SSTV) — see
// firmware/esp32-cat-bridge/main/doc/IO_ROUTING_PLAN.md.
//
//   'speaker'  the local sound card, played live (the output device below,
//              via AudioContext.setSinkId where the browser supports it)
//   'bridge'   the bridge's TX output, scheduled: each transmission is
//              uploaded to a bridge slot and played from there (bridgeSlots.ts)
//
// It used to be chosen per mode (ft_audio_sink_kind, rtty_tx_audio_sink, and
// three output-device keys); the first of those found seeds the shared value
// once, so nobody's existing choice is lost.
import { createRoot, createSignal } from 'solid-js'
import type { AudioSinkKind } from './audioSource'

const LS_KIND = 'tx_sink_kind'
const LS_DEVICE = 'tx_output_device'
const LEGACY_KIND_KEYS = ['ft_audio_sink_kind', 'rtty_tx_audio_sink']
const LEGACY_DEVICE_KEYS = ['ft_output_device', 'rtty_tx_output_device', 'sstv_tx_output_device']

function read(key: string): string | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage.getItem(key) } catch { return null }
}
function write(key: string, v: string) {
  try { if (typeof localStorage !== 'undefined') localStorage.setItem(key, v) } catch { /* storage unavailable */ }
}
const isKind = (v: string | null): v is AudioSinkKind => v === 'speaker' || v === 'bridge'

function initialKind(): AudioSinkKind | null {
  const own = read(LS_KIND)
  if (isKind(own)) return own
  for (const k of LEGACY_KIND_KEYS) {
    const v = read(k)
    if (isKind(v)) { write(LS_KIND, v); return v }
  }
  return null
}

function initialDevice(): string {
  const own = read(LS_DEVICE)
  if (own !== null) return own
  for (const k of LEGACY_DEVICE_KEYS) {
    const v = read(k)
    if (v) { write(LS_DEVICE, v); return v }
  }
  return ''
}

export const txSink = createRoot(() => {
  const stored = initialKind()
  const [kind, setKindSig] = createSignal<AudioSinkKind>(stored ?? 'speaker')
  // False until someone picks explicitly: lets FT still auto-pick the bridge
  // the first time one connects, without overriding a deliberate choice.
  const [explicit, setExplicit] = createSignal(stored !== null)
  const [device, setDeviceSig] = createSignal(initialDevice())
  return {
    kind,
    device,
    hasExplicitKind: explicit,
    setKind(v: AudioSinkKind) {
      write(LS_KIND, v)
      setExplicit(true)
      setKindSig(v)
    },
    /** For automatic picks (not saved as the operator's choice). */
    setKindAuto(v: AudioSinkKind) {
      setKindSig(v)
    },
    setDevice(v: string) {
      write(LS_DEVICE, v)
      setDeviceSig(v)
    },
  }
})
