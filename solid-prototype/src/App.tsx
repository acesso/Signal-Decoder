// Minimal port of src/app/page.tsx's shell, scoped to RTTY only for now —
// proves the full stack (shared lib, audio, RTTYDecoder's start/stop/reset
// contract) end-to-end before porting the other 4 decoder modes.
import { createSignal, type JSX } from 'solid-js'
import { globalAudio } from './lib/audio/globalAudio'
import RTTYDecoder from './components/RTTYDecoder'
import type { DecoderControls } from './lib/decoderControls'

function App(): JSX.Element {
  const rtty: { current: DecoderControls | null } = { current: null }

  const [isRecording, setIsRecording] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)

  async function handleStart() {
    const node = await globalAudio.start()
    if (node) await rtty.current?.start()
  }
  function handleStop() {
    rtty.current?.stop()
    globalAudio.stop()
  }
  function handleReset() {
    rtty.current?.reset()
  }

  return (
    <main class="flex h-screen flex-col overflow-hidden">
      <div class="px-4 pt-4 pb-3 sm:px-6 sm:pt-6 lg:px-8 lg:pt-8">
        <h1 class="mb-1 text-2xl font-bold text-[#c9d1d9] sm:text-3xl lg:text-4xl">
          Radio Signal Decoder <span class="text-base font-normal text-[#8b949e]">(SolidJS prototype — RTTY only)</span>
        </h1>
        <p class="text-sm text-[#8b949e] sm:text-base">Real-time Radioteletype signal decoder from microphone</p>
      </div>

      <div class="px-4 pb-2 sm:px-6 lg:px-8">
        <div class="flex items-center gap-3 rounded-lg border border-[#30363d] bg-[#161b22] px-4 py-3">
          {!isRecording() ? (
            <button
              onClick={handleStart}
              disabled={!globalAudio.state().isSupported}
              class="flex items-center gap-2 rounded-md bg-[#238636] px-5 py-2 text-sm font-semibold text-white transition-colors hover:bg-[#2ea043] disabled:cursor-not-allowed disabled:opacity-50"
            >
              Start Decoding
            </button>
          ) : (
            <button
              onClick={handleStop}
              class="flex items-center gap-2 rounded-md bg-[#da3633] px-5 py-2 text-sm font-semibold text-white transition-colors hover:bg-[#f85149]"
            >
              Stop
            </button>
          )}
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
        <RTTYDecoder
          handle={rtty}
          analyser={globalAudio.analyser()}
          onStateChange={(s) => {
            setIsRecording(s.isRecording)
            setError(s.error)
          }}
        />
      </div>
    </main>
  )
}

export default App
