// App-wide "debug mode" switch — off by default, toggled from the gear
// panel's globals row (App.tsx, next to the audio ring buffer settings).
//
// A module-level signal rather than a prop threaded through the component
// tree: the things it reveals are diagnostics scattered across unrelated
// components (each plot's FPS counter today), and none of them are worth a
// new prop on every intervening panel. Persisted so a session spent
// diagnosing something doesn't have to re-enable it on every reload.
import { createSignal } from 'solid-js'
import { loadBoolean, saveBoolean } from './storage'

const LS_DEBUG_MODE = 'debug_mode'

const [debugMode, setDebugModeSignal] = createSignal(loadBoolean(LS_DEBUG_MODE, false))

export { debugMode }

export function setDebugMode(v: boolean): void {
  setDebugModeSignal(v)
  saveBoolean(LS_DEBUG_MODE, v)
}
