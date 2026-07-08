// Incremental port of src/app/page.tsx's shell — grows a mode at a time as
// each decoder is ported (RTTY, CW so far). All-mode wiring (FT contacts/map/
// TX state, CAT VFO) lands once every decoder exists.
import { createSignal, Show, type JSX } from 'solid-js'
import { globalAudio } from './lib/audio/globalAudio'
import RTTYDecoder from './components/RTTYDecoder'
import CWDecoder from './components/CWDecoder'
import type { DecoderControls } from './lib/decoderControls'

type DecoderMode = 'rtty' | 'cw'

function App(): JSX.Element {
  const [mode, setMode] = createSignal<DecoderMode>('rtty')

  const rtty: { current: DecoderControls | null } = { current: null }
  const cw: { current: DecoderControls | null } = { current: null }

  const [isRecording, setIsRecording] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)

  function activeHandle() {
    return mode() === 'rtty' ? rtty : cw
  }

  async function handleStart() {
    const node = await globalAudio.start()
    if (node) await activeHandle().current?.start()
  }
  function handleStop() {
    activeHandle().current?.stop()
    globalAudio.stop()
  }
  function handleReset() {
    activeHandle().current?.reset()
  }

  async function handleModeChange(newMode: DecoderMode) {
    if (newMode === mode()) return
    const wasRecording = isRecording()
    if (wasRecording) activeHandle().current?.stop()
    setMode(newMode)
    if (wasRecording) await activeHandle().current?.start()
  }

  return (
    <main class="flex h-screen flex-col overflow-hidden">
      <div class="px-4 pt-4 pb-3 sm:px-6 sm:pt-6 lg:px-8 lg:pt-8">
        <div class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h1 class="mb-1 text-2xl font-bold text-[#c9d1d9] sm:text-3xl lg:text-4xl">
              Radio Signal Decoder <span class="text-base font-normal text-[#8b949e]">(SolidJS prototype)</span>
            </h1>
            <p class="text-sm text-[#8b949e] sm:text-base">
              {mode() === 'rtty' ? 'Real-time Radioteletype signal decoder from microphone' : 'Continuous Wave (Morse code) decoder'}
            </p>
          </div>
          <div class="flex shrink-0 items-center gap-1 self-start rounded-lg border border-[#30363d] bg-[#0d1117] p-1 sm:self-auto">
            {(['rtty', 'cw'] as DecoderMode[]).map((m) => (
              <button
                onClick={() => handleModeChange(m)}
                class={`rounded-md px-4 py-1.5 text-sm font-semibold transition-colors ${
                  mode() === m ? 'bg-[#238636] text-white' : 'text-[#8b949e] hover:text-[#c9d1d9]'
                }`}
              >
                {m.toUpperCase()}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div class="px-4 pb-2 sm:px-6 lg:px-8">
        <div class="flex items-center gap-3 rounded-lg border border-[#30363d] bg-[#161b22] px-4 py-3">
          <Show
            when={!isRecording()}
            fallback={
              <button
                onClick={handleStop}
                class="flex items-center gap-2 rounded-md bg-[#da3633] px-5 py-2 text-sm font-semibold text-white transition-colors hover:bg-[#f85149]"
              >
                Stop
              </button>
            }
          >
            <button
              onClick={handleStart}
              disabled={!globalAudio.state().isSupported}
              class="flex items-center gap-2 rounded-md bg-[#238636] px-5 py-2 text-sm font-semibold text-white transition-colors hover:bg-[#2ea043] disabled:cursor-not-allowed disabled:opacity-50"
            >
              Start Decoding
            </button>
          </Show>
          <button
            onClick={handleReset}
            class="flex items-center gap-1.5 rounded-md border border-[#30363d] bg-[#21262d] px-4 py-2 text-sm font-semibold text-[#c9d1d9] transition-colors hover:bg-[#30363d]"
          >
            Reset
          </button>
          {error() && <span class="ml-auto font-mono text-xs text-[#f85149]">{error()}</span>}
        </div>
      </div>

      <div class="min-h-0 flex-1 overflow-y-auto px-4 pb-8 sm:px-6 lg:px-8">
        <div class={mode() === 'rtty' ? '' : 'hidden'}>
          <RTTYDecoder
            handle={rtty}
            analyser={globalAudio.analyser()}
            onStateChange={(s) => {
              if (mode() === 'rtty') {
                setIsRecording(s.isRecording)
                setError(s.error)
              }
            }}
          />
        </div>
        <div class={mode() === 'cw' ? '' : 'hidden'}>
          <CWDecoder
            handle={cw}
            analyser={globalAudio.analyser()}
            onStateChange={(s) => {
              if (mode() === 'cw') {
                setIsRecording(s.isRecording)
                setError(s.error)
              }
            }}
          />
        </div>
      </div>
    </main>
  )
}

export default App
