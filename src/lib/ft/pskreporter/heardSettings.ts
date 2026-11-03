/**
 * The "check whether my transmissions were heard" switch (doc/plans/tx-heard/PLAN.md):
 * one signal for the whole page, because the switch sits in the PSK Reporter
 * panel and the marks in the FT transmit panel's Sent Log. Saved with the
 * other PSK Reporter settings (settings.ts); on by default.
 */
import { createRoot, createSignal } from 'solid-js'
import { loadPskSettings, savePskSettings } from './settings'

const [heardChecks, setHeardChecksSignal] = createRoot(() => createSignal(loadPskSettings().heardChecks))

export { heardChecks }

export function setHeardChecks(on: boolean): void {
  setHeardChecksSignal(on)
  savePskSettings({ ...loadPskSettings(), heardChecks: on })
}
