// Surfaces a new deploy to an already-open tab. The PWA service worker
// updates and takes control in the background on its own (registerType:
// 'autoUpdate' in vite.config.ts), but that alone never refreshes the DOM —
// without this, a tab left open across a deploy can sit on stale JS
// indefinitely. Prompts instead of force-reloading: an unannounced reload
// mid-decode/mid-QSO would drop live state the user didn't ask to lose.
import { createSignal, Show, type JSX } from 'solid-js'
import { registerSW } from 'virtual:pwa-register'

export default function UpdateAvailablePrompt(): JSX.Element {
  const [needsRefresh, setNeedsRefresh] = createSignal(false)

  const updateSW = registerSW({
    immediate: true,
    onNeedRefresh() { setNeedsRefresh(true) },
  })

  return (
    <Show when={needsRefresh()}>
      <div class="fixed bottom-4 right-4 z-50 flex items-center gap-3 rounded-lg border border-[#30363d] bg-[#161b22] px-4 py-3 shadow-lg font-mono text-sm">
        <span class="text-[#c9d1d9]">Update available</span>
        <button
          onClick={() => updateSW(true)}
          class="px-2 py-1 rounded bg-[#238636] hover:bg-[#2ea043] text-white text-xs font-semibold transition-colors"
        >
          Reload
        </button>
        <button
          onClick={() => setNeedsRefresh(false)}
          class="text-[#8b949e] hover:text-[#c9d1d9] text-xs"
          aria-label="Dismiss"
        >
          ✕
        </button>
      </div>
    </Show>
  )
}
