// The "Follow TX level" switch (txLevelAuto.ts followStep): one signal for
// the page, because the switch sits in the FT transmit panel and the radio
// reports reach the radio panel, which applies the steps. Off by default.
import { createRoot, createSignal } from 'solid-js'

const LS_KEY = 'tx_level_follow'

const load = () => { try { return localStorage.getItem(LS_KEY) === '1' } catch { return false } }

const [txLevelFollow, setSignal] = createRoot(() => createSignal(load()))

export { txLevelFollow }

export function setTxLevelFollow(on: boolean): void {
  setSignal(on)
  try { localStorage.setItem(LS_KEY, on ? '1' : '0') } catch { /* this tab keeps it */ }
}
