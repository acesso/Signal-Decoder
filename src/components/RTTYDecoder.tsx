// Port of src/components/RTTYDecoder.tsx (Next.js app) — implements
// DecoderControls via a caller-owned mutable handle (props.handle.current),
// filled in via onMount, instead of forwardRef+useImperativeHandle.
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show, type JSX } from 'solid-js'
import type { RTTYConfig } from '$decoder-lib/rtty/decoder'
import { loadNumberArray, saveNumberArray } from '$decoder-lib/storage'
import { createMultiRTTYProcessor } from '../lib/rtty/multiProcessor'
import type { AudioSourceKind } from '../lib/audio/audioSource'
import { createSessionsStore } from '../lib/rtty/sessionsStore'
import type { DecoderControls, DecoderProps } from '../lib/decoderControls'
import SignalAnalysisPanel from './SignalAnalysisPanel'
import { SessionCard } from './SessionCard'

const DISPLAY_MAX_HZ = 1500
const DEFAULT_PANEL_WEIGHTS = [1, 1, 1]
const LS_PANEL_WEIGHTS = 'rtty_panel_weights'

const DEFAULT_CONFIG: RTTYConfig = {
  centerFreq: 500,
  carrierShift: 450,
  baudRate: 50,
  bitsPerChar: 5,
  parity: 'none',
  stopBits: 1.5,
  reverseShift: false,
}

interface RTTYDecoderProps extends DecoderProps {
  /** Reports the active session's config on every change, so a sibling TX
   *  panel (mounted outside this component, same pattern as
   *  FTTransmitPanel's onBaseFreqHandle) can seed its own settings from it. */
  onActiveConfigChange?: (config: RTTYConfig) => void
}

export default function RTTYDecoder(props: RTTYDecoderProps): JSX.Element {
  const sessions = createSessionsStore(DEFAULT_CONFIG)
  const initialSession = sessions.initialSession
  const [squelch, setSquelch] = createSignal(0)
  // Same iqBridge-first/audioBridge/microphone precedence as
  // FTDecoder.tsx's audioSourceKind()/getBridge() — see that file's comment.
  const audioSourceKind = (): AudioSourceKind =>
    props.iqBridge?.state().connected ? 'bridge' : props.audioBridge?.state().playbackActive ? 'bridge' : 'microphone'
  const getBridge = () => (props.iqBridge?.state().connected ? props.iqBridge : props.audioBridge)
  const processor = createMultiRTTYProcessor(
    (sessionId, chars) => {
      sessions.dispatch({ type: 'APPEND_TEXT', id: sessionId, chars })
    },
    squelch,
    audioSourceKind,
    getBridge,
  )

  const activeSession = createMemo(
    () => sessions.state().sessions.find((s) => s.id === sessions.state().activeSessionId) ?? sessions.state().sessions[0],
  )
  const activeConfig = createMemo(() => activeSession().config)

  let containerEl: HTMLDivElement | undefined
  const [panelWeights, setPanelWeights] = createSignal(loadNumberArray(LS_PANEL_WEIGHTS, DEFAULT_PANEL_WEIGHTS))
  let dragState: { handle: number; startX: number; startWeights: number[] } | null = null

  createEffect(() => saveNumberArray(LS_PANEL_WEIGHTS, panelWeights()))

  function startDrag(e: MouseEvent, handle: number) {
    e.preventDefault()
    dragState = { handle, startX: e.clientX, startWeights: [...panelWeights()] }
  }

  onMount(() => {
    const onMove = (e: MouseEvent) => {
      const drag = dragState
      if (!drag || !containerEl) return
      const containerWidth = containerEl.offsetWidth
      const dx = e.clientX - drag.startX
      const total = drag.startWeights.reduce((a, b) => a + b, 0)
      const dw = (dx / containerWidth) * total
      const w = [...drag.startWeights]
      w[drag.handle] = Math.max(0.15, w[drag.handle] + dw)
      w[drag.handle + 1] = Math.max(0.15, w[drag.handle + 1] - dw)
      setPanelWeights(w)
    }
    const onUp = () => {
      dragState = null
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    onCleanup(() => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    })
  })

  onMount(() => {
    processor.addSession(initialSession.id, initialSession.config)
    processor.setActiveSession(initialSession.id)
  })
  onCleanup(() => processor.destroy())

  const [addPanelOpen, setAddPanelOpen] = createSignal(false)
  const [addShift, setAddShift] = createSignal(450)
  const [addBaud, setAddBaud] = createSignal(50)
  let addPanelEl: HTMLDivElement | undefined

  createEffect(() => {
    if (!addPanelOpen()) return
    const handler = (e: MouseEvent) => {
      if (!addPanelEl?.contains(e.target as Node)) setAddPanelOpen(false)
    }
    document.addEventListener('mousedown', handler)
    onCleanup(() => document.removeEventListener('mousedown', handler))
  })

  function addNewSession() {
    sessions.dispatch({
      type: 'ADD_SESSION',
      config: { ...activeConfig(), carrierShift: addShift(), baudRate: addBaud() },
    })
    setAddPanelOpen(false)
  }

  let prevSessionCount = sessions.state().sessions.length
  createEffect(() => {
    const list = sessions.state().sessions
    if (list.length > prevSessionCount) {
      const newest = list[list.length - 1]
      processor.addSession(newest.id, newest.config)
    }
    prevSessionCount = list.length
  })

  function removeSession(id: string) {
    sessions.dispatch({ type: 'REMOVE_SESSION', id })
    processor.removeSession(id)
  }

  function promoteSession(id: string) {
    sessions.dispatch({ type: 'ACTIVATE', id })
    processor.setActiveSession(id)
  }

  function updateSessionConfig(id: string, patch: Partial<RTTYConfig>) {
    sessions.dispatch({ type: 'UPDATE_CONFIG', id, patch })
    const current = sessions.state().sessions.find((s) => s.id === id)?.config
    if (current) processor.updateSessionConfig(id, { ...current, ...patch })
  }

  function updateSessionColor(id: string, color: string) {
    sessions.dispatch({ type: 'UPDATE_COLOR', id, color })
  }

  const activeSessionId = createMemo(() => activeSession().id)
  createEffect(() => {
    processor.setActiveSession(activeSessionId())
  })
  createEffect(() => {
    // activeSessionId/activeConfig are memos so APPEND_TEXT (which replaces
    // the session object on every decoded chunk, but not its .id or .config)
    // doesn't re-trigger this. Reading sessions.state().activeSessionId
    // directly here instead would: every dispatch reruns the effect, which
    // calls the live decoder's updateConfig() — which resets its bit-sync
    // FSM — permanently garbling the active session's decode.
    processor.updateSessionConfig(activeSessionId(), activeConfig())
  })
  createEffect(() => {
    props.onActiveConfigChange?.(activeConfig())
  })

  const markFreq = createMemo(() =>
    Math.round(
      activeConfig().reverseShift
        ? activeConfig().centerFreq + activeConfig().carrierShift / 2
        : activeConfig().centerFreq - activeConfig().carrierShift / 2,
    ),
  )
  const spaceFreq = createMemo(() =>
    Math.round(
      activeConfig().reverseShift
        ? activeConfig().centerFreq - activeConfig().carrierShift / 2
        : activeConfig().centerFreq + activeConfig().carrierShift / 2,
    ),
  )
  const halfBW = createMemo(() => activeConfig().baudRate / 2)
  const spectrumMarkers = createMemo(() => [
    // Red, not blue — a blue marker disappears into the waterfall's dark-blue
    // quiet floor.
    { freq: markFreq(), color: '#f85149', label: 'M', bandwidthHz: halfBW() * 2 },
    { freq: spaceFreq(), color: '#f0883e', label: 'S', bandwidthHz: halfBW() * 2 },
  ])

  let textareaEl: HTMLTextAreaElement | undefined
  createEffect(() => {
    const text = activeSession().fullText
    const t = textareaEl
    if (t) {
      void text
      t.scrollTop = t.scrollHeight
    }
  })

  async function handleStart() {
    await processor.startRecording()
  }
  function handleStop() {
    processor.stopRecording()
  }
  function handleReset() {
    processor.resetSession(sessions.state().activeSessionId)
    sessions.dispatch({ type: 'CLEAR_TEXT', id: sessions.state().activeSessionId })
  }

  function isSupported() {
    return typeof window !== 'undefined' && !!(window.AudioContext ?? (window as unknown as Record<string, unknown>).webkitAudioContext)
  }

  onMount(() => {
    if (props.handle) {
      props.handle.current = {
        get isRecording() {
          return processor.state().isRecording
        },
        get isSupported() {
          return isSupported()
        },
        get error() {
          return processor.state().errorMessage
        },
        start: handleStart,
        stop: handleStop,
        reset: handleReset,
      }
    }
  })

  createEffect(() => {
    const controls: DecoderControls = {
      isRecording: processor.state().isRecording,
      isSupported: isSupported(),
      error: processor.state().errorMessage,
      start: handleStart,
      stop: handleStop,
      reset: handleReset,
    }
    props.onStateChange?.(controls)
  })

  return (
    <div class="space-y-4 sm:space-y-6">
      <div ref={containerEl} class="flex flex-col gap-4 lg:flex-row lg:items-stretch lg:gap-0">
        {/* RTTY Output terminal */}
        <div class="flex min-w-0 flex-col rounded-lg border border-[#30363d] bg-[#161b22] p-3 sm:p-4" style={{ flex: panelWeights()[0] }}>
          <div class="mb-2 flex items-center justify-between sm:mb-3">
            <h2 class="text-lg font-semibold sm:text-xl">
              RTTY Output
              {sessions.state().sessions.length > 1 && (
                <span class="ml-2 text-xs font-normal text-[#8b949e]">— {activeSession().label}</span>
              )}
            </h2>
            <div class="flex items-center gap-3">
              <span class="font-mono text-xs text-[#8b949e]">{activeSession().fullText.length} chars</span>
              <button
                onClick={() => sessions.dispatch({ type: 'CLEAR_TEXT', id: sessions.state().activeSessionId })}
                disabled={!activeSession().fullText}
                class="rounded border border-[#30363d] px-2 py-0.5 text-xs text-[#8b949e] transition-colors hover:border-[#f85149]/40 hover:text-[#f85149] disabled:cursor-not-allowed disabled:opacity-30"
              >
                Clear
              </button>
            </div>
          </div>
          <textarea
            ref={textareaEl}
            readOnly
            value={activeSession().fullText}
            placeholder="Decoded RTTY text will appear here..."
            style={{ color: activeSession().color }}
            class="min-h-[300px] w-full flex-1 resize-none rounded border border-[#30363d] bg-[#0d1117] p-3 font-mono text-sm leading-snug placeholder:text-[#30363d] focus:outline-none"
          />
        </div>

        {/* Drag handle 0<->1 */}
        <div
          class="group hidden w-3 shrink-0 cursor-col-resize items-center justify-center self-stretch lg:flex"
          onMouseDown={(e) => startDrag(e, 0)}
        >
          <div class="h-full w-px bg-[#30363d] transition-colors group-hover:bg-[#2ea043]/50" />
        </div>

        {/* Audio Analysis — 2nd column. In I/Q mode (see audioSourceKind()
            above), shows the bridge's own wideband I/Q spectrum with a
            draggable passband marker that retunes useIQBridge.ts's
            SSBDemodulator — same "don't mix the two marker concepts"
            reasoning as FTDecoder.tsx's identical branch; the mark/space
            tone markers below are only meaningful against already-
            demodulated audio. */}
        <Show
          when={props.iqBridge?.state().connected}
          fallback={
            <SignalAnalysisPanel
              analyser={props.analyser ?? null}
              isRecording={processor.state().isRecording}
              defaultMaxHz={DISPLAY_MAX_HZ}
              storageKeyPrefix="rtty"
              markers={spectrumMarkers()}
              onMarkerDrag={(idx, newHz) => {
                const half = activeConfig().carrierShift / 2
                const newCenter =
                  idx === 0
                    ? activeConfig().reverseShift
                      ? newHz - half
                      : newHz + half
                    : activeConfig().reverseShift
                      ? newHz + half
                      : newHz - half
                updateSessionConfig(sessions.state().activeSessionId, { centerFreq: Math.round(newCenter) })
              }}
              squelch={squelch()}
              onSquelchChange={setSquelch}
              vfoFrequency={props.vfoFrequency}
              class="min-w-0"
              style={{ flex: panelWeights()[1] }}
            />
          }
        >
          <SignalAnalysisPanel
            analyser={props.analyser ?? null}
            iqSource={{
              computer: props.iqBridge!.spectrum,
              sampleRateHz: () => props.iqBridge!.state().sampleRateHz,
              active: () => props.iqBridge!.state().connected,
            }}
            isRecording={processor.state().isRecording}
            vfoFrequency={props.vfoFrequency}
            storageKeyPrefix="rtty_iq"
            defaultMaxHz={props.iqBridge!.state().sampleRateHz / 2}
            passband={{ centerHz: props.iqBridge!.state().passbandCenterHz, bandwidthHz: props.iqBridge!.state().passbandBandwidthHz }}
            onPassbandChange={(p) => props.iqBridge!.setPassband(p.centerHz, p.bandwidthHz)}
            markerFieldLabel="Passband"
            class="min-w-0"
            style={{ flex: panelWeights()[1] }}
          />
        </Show>

        {/* Drag handle 1<->2 */}
        <div
          class="group hidden w-3 shrink-0 cursor-col-resize items-center justify-center self-stretch lg:flex"
          onMouseDown={(e) => startDrag(e, 1)}
        >
          <div class="h-full w-px bg-[#30363d] transition-colors group-hover:bg-[#2ea043]/50" />
        </div>

        {/* Decoder Sessions — 3rd column */}
        <div class="min-w-0 rounded-lg border border-[#30363d] bg-[#161b22] p-3 sm:p-4" style={{ flex: panelWeights()[2] }}>
          <div class="mb-3 flex items-center justify-between">
            <h2 class="text-lg font-semibold sm:text-xl">Decoder Sessions</h2>
            <div ref={addPanelEl} class="relative">
              <button
                onClick={() => setAddPanelOpen((v) => !v)}
                class="flex items-center gap-1 rounded-md border border-[#238636]/40 bg-[#238636]/10 px-2.5 py-1 font-mono text-xs text-[#2ea043] transition-colors hover:border-[#238636]/60 hover:bg-[#238636]/20"
              >
                <svg xmlns="http://www.w3.org/2000/svg" class="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor">
                  <path
                    fill-rule="evenodd"
                    d="M10 3a1 1 0 011 1v5h5a1 1 0 110 2h-5v5a1 1 0 11-2 0v-5H4a1 1 0 110-2h5V4a1 1 0 011-1z"
                    clip-rule="evenodd"
                  />
                </svg>
                Add
              </button>
              {addPanelOpen() && (
                <div class="absolute top-full right-0 z-10 mt-1 w-48 rounded-lg border border-[#30363d] bg-[#161b22] p-3 shadow-lg">
                  <div class="mb-2">
                    <div class="mb-1.5 text-[10px] text-[#8b949e]">Carrier Shift</div>
                    <div class="flex gap-1">
                      {[170, 200, 450].map((s) => (
                        <button
                          onClick={() => setAddShift(s)}
                          class={`flex-1 rounded border py-0.5 text-xs transition-colors ${
                            addShift() === s
                              ? 'border-[#2ea043]/60 bg-[#2ea043]/10 text-[#2ea043]'
                              : 'border-[#30363d] text-[#8b949e] hover:border-[#8b949e]/50'
                          }`}
                        >
                          {s}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div class="mb-3">
                    <div class="mb-1.5 text-[10px] text-[#8b949e]">Baud Rate</div>
                    <div class="flex gap-1">
                      {[45, 45.45, 50].map((b) => (
                        <button
                          onClick={() => setAddBaud(b)}
                          class={`flex-1 rounded border py-0.5 text-xs transition-colors ${
                            addBaud() === b
                              ? 'border-[#2ea043]/60 bg-[#2ea043]/10 text-[#2ea043]'
                              : 'border-[#30363d] text-[#8b949e] hover:border-[#8b949e]/50'
                          }`}
                        >
                          {b}
                        </button>
                      ))}
                    </div>
                  </div>
                  <button
                    onClick={addNewSession}
                    class="w-full rounded border border-[#238636]/50 bg-[#238636]/20 py-1 text-xs text-[#2ea043] transition-colors hover:bg-[#238636]/30"
                  >
                    Create Session
                  </button>
                </div>
              )}
            </div>
          </div>
          <div class="grid grid-cols-2 gap-2">
            {/* Keyed by id (stable across edits) rather than by the session
                object itself — the reducer returns a new object for whichever
                session was just patched, so keying by object reference (as a
                plain .map() or a naive <For each={sessions}> effectively
                does) would unmount/remount that card on every keystroke,
                dropping focus out of whatever input the user was typing in. */}
            <For each={sessions.state().sessions.map((s) => s.id)}>
              {(id) => {
                const session = createMemo(() => sessions.state().sessions.find((s) => s.id === id)!)
                return (
                  <SessionCard
                    session={session()}
                    isActive={id === sessions.state().activeSessionId}
                    canRemove={sessions.state().sessions.length > 1}
                    vfoFrequency={props.vfoFrequency}
                    onActivate={promoteSession}
                    onRemove={removeSession}
                    onConfigChange={updateSessionConfig}
                    onLabelChange={(sid, label) => sessions.dispatch({ type: 'UPDATE_LABEL', id: sid, label })}
                    onColorChange={updateSessionColor}
                  />
                )
              }}
            </For>
          </div>
        </div>
      </div>

      {/* How to Use */}
      <details class="rounded-lg border border-[#30363d] bg-[#161b22]">
        <summary class="cursor-pointer rounded-lg p-4 text-lg font-semibold transition-colors select-none hover:bg-[#21262d] sm:p-6 sm:text-xl">
          How to Use
        </summary>
        <div class="px-4 pb-4 sm:px-6 sm:pb-6">
          <ol class="list-inside list-decimal space-y-2 text-sm text-[#c9d1d9] sm:text-base">
            <li>Click "Start Decoding" to begin capturing audio from your microphone</li>
            <li>Tune your radio to an RTTY signal (typically 45 or 50 baud, 170 or 450 Hz shift)</li>
            <li>
              On the Spectrum panel, click and drag to position the <span class="font-mono text-[#58a6ff]">M</span> (mark)
              and <span class="font-mono text-[#f0883e]">S</span> (space) markers over the two signal peaks
            </li>
            <li>Adjust Carrier Shift and Baud Rate in the configuration panel to match the transmission</li>
            <li>
              Use <strong>Add Decoder</strong> to run multiple decoders simultaneously with different settings — promote
              the best one to take over the main output
            </li>
            <li>Decoded text will appear in the terminal output area as characters are received</li>
            <li>Click "Copy Text" to copy the decoded output to clipboard</li>
          </ol>
          <p class="mt-4 text-xs text-[#8b949e] sm:text-sm">
            Tip: On the spectrogram, an RTTY signal appears as two persistent vertical lines — align the M/S markers with
            those lines using the spectrum panel.
          </p>
        </div>
      </details>

      {/* Privacy */}
      <details class="rounded-lg border border-[#30363d] bg-[#161b22]">
        <summary class="cursor-pointer rounded-lg p-4 text-lg font-semibold transition-colors select-none hover:bg-[#21262d] sm:p-6 sm:text-xl">
          Privacy
        </summary>
        <div class="space-y-3 px-4 pb-4 text-sm text-[#c9d1d9] sm:px-6 sm:pb-6 sm:text-base">
          <p>This application runs entirely in your browser. No audio data or decoded text is ever transmitted to any server.</p>
          <p>The microphone permission is only used to capture and process the audio signal in real-time for RTTY decoding using the Web Audio API.</p>
          <p class="text-xs text-[#8b949e] sm:text-sm">
            Your privacy is fully protected — we don't collect, store, or transmit any of your data.
          </p>
        </div>
      </details>
    </div>
  )
}
