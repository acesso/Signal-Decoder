// Port of src/components/SettingsPanel.tsx (Next.js app).
// The original used MUI's <Fab> + <SettingsIcon> (Material-UI, React-only,
// used nowhere else in the app) for the floating action button — replaced
// here with a plain Tailwind-styled <button> + inline SVG gear icon.
import { createSignal, For, Show, type JSX } from 'solid-js'

export type SSTVMode =
  | 'ROBOT36'
  | 'ROBOT72'
  | 'SCOTTIE_S1'
  | 'SCOTTIE_S2'
  | 'MARTIN_M1'
  | 'MARTIN_M2'
  | 'SCOTTIE_DX'
  | 'WRAASE_SC2_180'
  | 'PD50'
  | 'PD90'
  | 'PD120'
  | 'PD160'
  | 'PD180'
  | 'PD240'
  | 'PD290'

interface SettingsPanelProps {
  currentMode: SSTVMode
  onModeChange: (mode: SSTVMode) => void
  disabled?: boolean
}

const MODES: { id: SSTVMode; name: string; description: string }[] = [
  {
    id: 'ROBOT36',
    name: 'Robot 36',
    description: '320×240 • Fast mode (150ms/line) • Interlaced YUV',
  },
  {
    id: 'ROBOT72',
    name: 'Robot 72',
    description: '320×240 • Better color (300ms/line) • Sequential YUV',
  },
  {
    id: 'SCOTTIE_S1',
    name: 'Scottie S1',
    description: '320×256 • HF classic (428ms/line) • RGB sequential',
  },
  {
    id: 'SCOTTIE_S2',
    name: 'Scottie S2',
    description: '320×256 • Faster HF (278ms/line) • RGB sequential',
  },
  {
    id: 'MARTIN_M1',
    name: 'Martin M1',
    description: '320×256 • Most popular HF mode (446ms/line) • RGB sequential',
  },
  {
    id: 'MARTIN_M2',
    name: 'Martin M2',
    description: '320×256 • Popular fast HF (181ms/line) • RGB sequential',
  },
  {
    id: 'SCOTTIE_DX',
    name: 'Scottie DX',
    description: '320×256 • High quality (1049ms/line) • RGB sequential',
  },
  {
    id: 'WRAASE_SC2_180',
    name: 'Wraase SC2-180',
    description: '320×256 • HF quality (712ms/line) • RGB sequential',
  },
  {
    id: 'PD50',
    name: 'PD 50',
    description: '320×240 • Quick mode (388ms/line) • Dual-luminance',
  },
  {
    id: 'PD90',
    name: 'PD 90',
    description: '320×240 • Balanced (703ms/line) • Dual-luminance',
  },
  {
    id: 'PD120',
    name: 'PD 120',
    description: '640×496 • High resolution (508ms/line) • Dual-luminance',
  },
  {
    id: 'PD160',
    name: 'PD 160',
    description: '512×400 • Balanced mode (804ms/line) • Dual-luminance',
  },
  {
    id: 'PD180',
    name: 'PD 180',
    description: '640×496 • Highest quality (752ms/line) • Dual-luminance',
  },
  {
    id: 'PD240',
    name: 'PD 240',
    description: '640×496 • Very high quality (995ms/line) • Dual-luminance',
  },
  {
    id: 'PD290',
    name: 'PD 290',
    description: '640×496 • Ultra quality (1200ms/line) • Dual-luminance',
  },
]

export default function SettingsPanel(props: SettingsPanelProps): JSX.Element {
  const [isOpen, setIsOpen] = createSignal(false)

  return (
    <>
      {/* Floating action button — bottom right (was MUI <Fab> + <SettingsIcon>) */}
      <button
        aria-label="settings"
        onClick={() => setIsOpen(true)}
        disabled={props.disabled ?? false}
        class="fixed bottom-6 right-6 z-40 flex h-14 w-14 items-center justify-center rounded-full bg-[#238636] text-white shadow-lg transition-colors hover:bg-[#2ea043] disabled:cursor-not-allowed disabled:bg-[#161b22] disabled:opacity-50"
      >
        <svg xmlns="http://www.w3.org/2000/svg" class="h-6 w-6" viewBox="0 0 20 20" fill="currentColor">
          <path
            fill-rule="evenodd"
            d="M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.532 1.532 0 01-2.286.948c-1.372-.836-2.942.734-2.106 2.106.54.886.061 2.042-.947 2.287-1.561.379-1.561 2.6 0 2.978a1.532 1.532 0 01.947 2.287c-.836 1.372.734 2.942 2.106 2.106a1.532 1.532 0 012.287.947c.379 1.561 2.6 1.561 2.978 0a1.533 1.533 0 012.287-.947c1.372.836 2.942-.734 2.106-2.106a1.533 1.533 0 01.947-2.287c1.561-.379 1.561-2.6 0-2.978a1.532 1.532 0 01-.947-2.287c.836-1.372-.734-2.942-2.106-2.106a1.532 1.532 0 01-2.287-.947zM10 13a3 3 0 100-6 3 3 0 000 6z"
            clip-rule="evenodd"
          />
        </svg>
      </button>

      {/* Modal overlay */}
      <Show when={isOpen()}>
        <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={() => setIsOpen(false)}>
          {/* Modal content */}
          <div
            class="w-full max-w-lg rounded-lg border border-[#30363d] bg-[#161b22] shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div class="flex items-center justify-between border-b border-[#30363d] p-4 sm:p-6">
              <h2 class="text-xl font-semibold text-[#c9d1d9] sm:text-2xl">Settings</h2>
              <button onClick={() => setIsOpen(false)} class="text-[#8b949e] transition-colors hover:text-[#c9d1d9]" aria-label="Close">
                <svg xmlns="http://www.w3.org/2000/svg" class="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width={2}>
                  <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Body - scrollable */}
            <div class="max-h-[60vh] space-y-4 overflow-y-auto p-4 sm:p-6">
              <div>
                <h3 class="mb-3 text-sm font-semibold tracking-wide text-[#8b949e] uppercase">SSTV Mode</h3>
                <div class="space-y-2">
                  <For each={MODES}>
                    {(mode) => (
                      <button
                        onClick={() => {
                          props.onModeChange(mode.id)
                          setIsOpen(false)
                        }}
                        class={`w-full rounded-lg border-2 p-4 text-left transition-all ${
                          props.currentMode === mode.id
                            ? 'border-[#238636] bg-[#238636]/10'
                            : 'border-[#30363d] bg-[#0d1117] hover:border-[#8b949e]'
                        }`}
                      >
                        <div class="flex items-start justify-between">
                          <div>
                            <div class="mb-1 font-semibold text-[#c9d1d9]">{mode.name}</div>
                            <div class="text-sm text-[#8b949e]">{mode.description}</div>
                          </div>
                          <Show when={props.currentMode === mode.id}>
                            <svg
                              xmlns="http://www.w3.org/2000/svg"
                              class="mt-0.5 h-5 w-5 flex-shrink-0 text-[#238636]"
                              viewBox="0 0 20 20"
                              fill="currentColor"
                            >
                              <path
                                fill-rule="evenodd"
                                d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
                                clip-rule="evenodd"
                              />
                            </svg>
                          </Show>
                        </div>
                      </button>
                    )}
                  </For>
                </div>
              </div>

              {/* Info box */}
              <div class="rounded-lg border border-[#30363d] bg-[#0d1117] p-4">
                <div class="flex gap-3">
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    class="mt-0.5 h-5 w-5 flex-shrink-0 text-[#58a6ff]"
                    viewBox="0 0 20 20"
                    fill="currentColor"
                  >
                    <path
                      fill-rule="evenodd"
                      d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z"
                      clip-rule="evenodd"
                    />
                  </svg>
                  <div class="text-sm text-[#8b949e]">
                    <p>
                      <strong class="text-[#c9d1d9]">Note:</strong> Changing modes will reset the current decoding session. Make sure to
                      save your image before switching.
                    </p>
                  </div>
                </div>
              </div>
            </div>

            {/* Footer */}
            <div class="flex justify-end border-t border-[#30363d] p-4 sm:p-6">
              <button
                onClick={() => setIsOpen(false)}
                class="rounded-md bg-[#238636] px-4 py-2 font-semibold text-white transition-colors hover:bg-[#2ea043]"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      </Show>
    </>
  )
}
