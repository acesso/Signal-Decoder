// Port of src/components/CWDecoder.tsx (Next.js app).
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show, type JSX } from 'solid-js'
import type { DecoderProps, DecoderControls } from '../lib/decoderControls'
import { fmtAbsHz } from '$decoder-lib/formatFreq'
import SignalAnalysisPanel from './SignalAnalysisPanel'
import NumberField from './NumberField'
import { createCWProcessor, type TextToken } from '../lib/cw/processor'
import { resolveAudioSource, type AudioSourceKind } from '../lib/audio/audioSource'
import { loadNumberArray, saveNumberArray } from '$decoder-lib/storage'

const DEFAULT_PANEL_WEIGHTS = [1, 1, 0.75]
const LS_PANEL_WEIGHTS = 'cw_panel_weights'

const CH_COLORS = {
  0: { primary: '#79c0ff', dot: '#79c0ff', dash: '#2ea043', recv: '#e3b341', text: '#c9d1d9', flash: '#f0f6fc' },
  1: { primary: '#ffa657', dot: '#ffa657', dash: '#d2a8ff', recv: '#ff7b72', text: '#ffa657', flash: '#ffa657' },
} as const

function Toggle(props: { checked: boolean; onChange: () => void }) {
  return (
    <button
      role="switch"
      aria-checked={props.checked}
      onClick={props.onChange}
      class={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors focus:outline-none ${
        props.checked ? 'border-[#2ea043] bg-[#238636]' : 'border-[#30363d] bg-[#21262d]'
      }`}
    >
      <span
        class={`inline-block h-4 w-4 transform rounded-full bg-white shadow-sm transition-transform ${
          props.checked ? 'translate-x-4' : 'translate-x-0.5'
        }`}
      />
    </button>
  )
}

interface MorseElementEntry {
  id: number
  type: 'dot' | 'dash'
}
interface RecentCharEntry {
  id: number
  char: string
  symbol: string
}

function MorseVisualizer(props: {
  elements: MorseElementEntry[]
  flashChar: RecentCharEntry | null
  recentChars: RecentCharEntry[]
  isReceiving: boolean
  channel?: 0 | 1
  label?: string
}) {
  const c = () => CH_COLORS[props.channel ?? 0]

  return (
    <div>
      <style>{`
        @keyframes cwElementPop {
          0%   { transform: scale(0) translateY(6px); opacity: 0; }
          55%  { transform: scale(1.25) translateY(-3px); opacity: 1; }
          100% { transform: scale(1) translateY(0); opacity: 1; }
        }
        @keyframes cwMarkPulse {
          0%, 100% { opacity: 0.25; transform: scale(0.75); }
          50%       { opacity: 1;    transform: scale(1.05); }
        }
        @keyframes cwCharReveal {
          0%   { transform: scale(0.2) translateY(10px); opacity: 0; filter: blur(6px); }
          25%  { transform: scale(1.2) translateY(-5px); opacity: 1; filter: blur(0); }
          55%  { transform: scale(1)   translateY(0);    opacity: 1; filter: blur(0); }
          80%  { transform: scale(1)   translateY(0);    opacity: 1; filter: blur(0); }
          100% { transform: scale(1.1) translateY(-6px); opacity: 0; filter: blur(3px); }
        }
        @keyframes cwRecentPop {
          0%   { transform: translateY(8px) scale(0.7); opacity: 0; }
          100% { transform: translateY(0)   scale(1);   opacity: 1; }
        }
      `}</style>

      <div class="mb-1.5 flex items-center justify-between">
        {props.label ? (
          <h3 class="text-xs font-semibold" style={{ color: c().primary }}>
            {props.label}
          </h3>
        ) : (
          <h3 class="text-sm font-medium text-[#8b949e]">Morse Display</h3>
        )}
        <span class="font-mono text-[10px] text-[#484f58]">
          {props.isReceiving ? '⏺ receiving' : props.elements.length > 0 ? 'building…' : 'monitoring'}
        </span>
      </div>

      <div class="space-y-2.5 rounded-lg border border-[#30363d] bg-[#0d1117] px-3 py-2.5">
        <div class="flex min-h-[24px] flex-wrap items-center justify-center gap-2.5">
          <For each={props.elements}>
            {(el) =>
              el.type === 'dot' ? (
                <div
                  class="h-4 w-4 shrink-0 rounded-full"
                  style={{
                    background: c().dot,
                    'box-shadow': `0 0 8px 2px ${c().dot}80`,
                    animation: 'cwElementPop 0.2s cubic-bezier(0.34,1.56,0.64,1) forwards',
                  }}
                />
              ) : (
                <div
                  class="h-4 w-10 shrink-0 rounded-full"
                  style={{
                    background: c().dash,
                    'box-shadow': `0 0 8px 2px ${c().dash}80`,
                    animation: 'cwElementPop 0.2s cubic-bezier(0.34,1.56,0.64,1) forwards',
                  }}
                />
              )
            }
          </For>
          <Show when={props.isReceiving}>
            <div
              class="h-4 w-4 shrink-0 rounded-full"
              style={{
                background: c().recv,
                'box-shadow': `0 0 10px 3px ${c().recv}80`,
                animation: 'cwMarkPulse 0.5s ease-in-out infinite',
              }}
            />
          </Show>
          <Show when={props.elements.length === 0 && !props.isReceiving}>
            <span class="text-xs font-mono tracking-[0.4em] text-[#30363d] select-none">· · ·</span>
          </Show>
        </div>

        <div class="flex items-center justify-center" style={{ 'min-height': '48px' }}>
          {props.flashChar ? (
            <span
              class={`leading-none font-mono font-bold select-none ${
                props.flashChar.char.startsWith('<') ? 'text-xl' : props.flashChar.char === '?' ? 'text-3xl' : 'text-4xl'
              }`}
              style={{
                color: props.flashChar.char === '?' ? '#da3633' : c().flash,
                'text-shadow':
                  props.flashChar.char === '?' ? '0 0 16px rgba(218,54,51,0.8)' : `0 0 18px ${c().flash}88, 0 0 36px ${c().primary}44`,
                animation: 'cwCharReveal 1.8s ease-in-out forwards',
              }}
            >
              {props.flashChar.char}
            </span>
          ) : (
            <div class="h-px w-6 bg-[#21262d]" />
          )}
        </div>

        <Show when={props.recentChars.length > 0}>
          <div class="flex flex-wrap items-end justify-center gap-x-2.5 gap-y-1 border-t border-[#21262d] pt-2">
            <For each={props.recentChars}>
              {(rc, i) => (
                <div
                  class="flex flex-col items-center gap-px"
                  style={{
                    opacity: ((i() + 1) / props.recentChars.length) * 0.85 + 0.15,
                    animation: i() === props.recentChars.length - 1 ? 'cwRecentPop 0.25s cubic-bezier(0.34,1.56,0.64,1) forwards' : 'none',
                  }}
                >
                  <span
                    class={`leading-none font-mono font-semibold ${
                      rc.char.startsWith('<') ? 'text-sm' : rc.char === '?' ? 'text-base' : 'text-lg'
                    }`}
                    style={{ color: rc.char === '?' ? '#da3633' : c().text }}
                  >
                    {rc.char}
                  </span>
                  <span class="font-mono text-[8px] tracking-wide text-[#484f58]">{rc.symbol}</span>
                </div>
              )}
            </For>
          </div>
        </Show>
      </div>
    </div>
  )
}

export default function CWDecoder(props: DecoderProps): JSX.Element {
  const [toneFreq, setToneFreq] = createSignal(700)
  const [toneFreq2, setToneFreq2] = createSignal(800)
  const [squelch, setSquelch] = createSignal(20)
  const [adaptiveDitLength, setAdaptiveDitLength] = createSignal(false)
  const [manualWpm, setManualWpm] = createSignal(20)
  const [dualMode, setDualMode] = createSignal(false)
  const [filterBandwidth, setFilterBandwidth] = createSignal(90)

  const filterQ = createMemo(() => Math.max(1, toneFreq() / filterBandwidth()))

  const [morseElements, setMorseElements] = createSignal<MorseElementEntry[]>([])
  const [flashChar, setFlashChar] = createSignal<RecentCharEntry | null>(null)
  const [recentChars, setRecentChars] = createSignal<RecentCharEntry[]>([])
  const [morseElements2, setMorseElements2] = createSignal<MorseElementEntry[]>([])
  const [flashChar2, setFlashChar2] = createSignal<RecentCharEntry | null>(null)
  const [recentChars2, setRecentChars2] = createSignal<RecentCharEntry[]>([])

  let visCounter = 0
  let flashTimeout: ReturnType<typeof setTimeout> | null = null
  let flashTimeout2: ReturnType<typeof setTimeout> | null = null

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

  let prevSym1 = ''
  let prevSym2 = ''

  // See resolveAudioSource()'s own comment in audioSource.ts for the full
  // precedence (auto vs. the operator's forced override).
  const audioSourceKind = (): AudioSourceKind =>
    resolveAudioSource(props.audioSourceOverride ?? 'auto', props.iqBridge, props.audioBridge).kind
  const getBridge = () => resolveAudioSource(props.audioSourceOverride ?? 'auto', props.iqBridge, props.audioBridge).bridge
  const processor = createCWProcessor(
    {
      toneFreq,
      squelch,
      adaptiveDitLength,
      dualMode,
      toneFreq2,
      wpm: manualWpm,
      filterQ,
    },
    audioSourceKind,
    getBridge,
  )

  createEffect(() => {
    // Depend on every param so this re-syncs whenever any of them change,
    // same effect as the original's per-param useEffects collapsed into one.
    void toneFreq()
    void squelch()
    void adaptiveDitLength()
    void dualMode()
    void toneFreq2()
    void manualWpm()
    void filterQ()
    processor.syncParams()
  })

  createEffect(() => {
    const sym = processor.state().stats?.partialSymbol ?? ''
    const prev = prevSym1
    if (sym === prev) return

    if (sym.length > prev.length && sym.startsWith(prev)) {
      const newEls = sym
        .slice(prev.length)
        .split('')
        .map((ch) => ({ id: visCounter++, type: (ch === '.' ? 'dot' : 'dash') as 'dot' | 'dash' }))
      setMorseElements((els) => [...els, ...newEls])
    } else {
      const newEls = sym.split('').map((ch) => ({ id: visCounter++, type: (ch === '.' ? 'dot' : 'dash') as 'dot' | 'dash' }))
      setMorseElements(newEls)
    }
    prevSym1 = sym
  })

  createEffect(() => {
    const sym = processor.state().stats2?.partialSymbol ?? ''
    const prev = prevSym2
    if (sym === prev) return

    if (sym.length > prev.length && sym.startsWith(prev)) {
      const newEls = sym
        .slice(prev.length)
        .split('')
        .map((ch) => ({ id: visCounter++, type: (ch === '.' ? 'dot' : 'dash') as 'dot' | 'dash' }))
      setMorseElements2((els) => [...els, ...newEls])
    } else {
      const newEls = sym.split('').map((ch) => ({ id: visCounter++, type: (ch === '.' ? 'dot' : 'dash') as 'dot' | 'dash' }))
      setMorseElements2(newEls)
    }
    prevSym2 = sym
  })

  onMount(() => {
    processor.setOnChar((char, symbol) => {
      if (char === ' ') return
      const id = visCounter++
      if (flashTimeout) clearTimeout(flashTimeout)
      const entry: RecentCharEntry = { id, char, symbol }
      setFlashChar(entry)
      setRecentChars((prev) => [...prev.slice(-9), entry])
      flashTimeout = setTimeout(() => setFlashChar(null), 1800)
    })
    processor.setOnChar2((char, symbol) => {
      if (char === ' ') return
      const id = visCounter++
      if (flashTimeout2) clearTimeout(flashTimeout2)
      const entry: RecentCharEntry = { id, char, symbol }
      setFlashChar2(entry)
      setRecentChars2((prev) => [...prev.slice(-9), entry])
      flashTimeout2 = setTimeout(() => setFlashChar2(null), 1800)
    })
    onCleanup(() => {
      processor.setOnChar(null)
      processor.setOnChar2(null)
    })
  })

  createEffect(() => {
    if (!processor.state().isRecording) {
      setMorseElements([])
      setFlashChar(null)
      setMorseElements2([])
      setFlashChar2(null)
      prevSym1 = ''
      prevSym2 = ''
      if (flashTimeout) {
        clearTimeout(flashTimeout)
        flashTimeout = null
      }
      if (flashTimeout2) {
        clearTimeout(flashTimeout2)
        flashTimeout2 = null
      }
    }
  })

  let textDivEl: HTMLDivElement | undefined
  createEffect(() => {
    void processor.state().tokens
    const el = textDivEl
    if (el) el.scrollTop = el.scrollHeight
  })

  function handleReset() {
    processor.resetDecoder()
    prevSym1 = ''
    prevSym2 = ''
    setMorseElements([])
    setFlashChar(null)
    setRecentChars([])
    setMorseElements2([])
    setFlashChar2(null)
    setRecentChars2([])
    if (flashTimeout) {
      clearTimeout(flashTimeout)
      flashTimeout = null
    }
    if (flashTimeout2) {
      clearTimeout(flashTimeout2)
      flashTimeout2 = null
    }
  }

  function handleCopyText() {
    const text = processor
      .state()
      .tokens.map((t) => t.text)
      .join('')
    if (!text) return
    navigator.clipboard.writeText(text).catch(() => {})
  }

  const snrColor = createMemo(() => {
    const snr = processor.state().stats?.snrDb
    if (snr == null) return 'text-[#8b949e]'
    if (snr < 6) return 'text-[#da3633]'
    if (snr < 15) return 'text-[#e3b341]'
    return 'text-[#2ea043]'
  })

  const hasText = createMemo(() => processor.state().tokens.length > 0)
  const charCount = createMemo(
    () =>
      processor
        .state()
        .tokens.map((t) => t.text)
        .join('')
        .replace(/ /g, '').length,
  )

  const coalescedTokens = createMemo<TextToken[]>(() => {
    const result: TextToken[] = []
    for (const tok of processor.state().tokens) {
      const last = result[result.length - 1]
      if (last && last.channel === tok.channel) {
        result[result.length - 1] = { text: last.text + tok.text, channel: tok.channel }
      } else {
        result.push({ text: tok.text, channel: tok.channel })
      }
    }
    return result
  })

  function isSupported() {
    return processor.state().isSupported
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
          return processor.state().error
        },
        start: processor.startRecording,
        stop: processor.stopRecording,
        reset: handleReset,
      }
    }
  })

  createEffect(() => {
    const controls: DecoderControls = {
      isRecording: processor.state().isRecording,
      isSupported: isSupported(),
      error: processor.state().error,
      start: processor.startRecording,
      stop: processor.stopRecording,
      reset: handleReset,
    }
    props.onStateChange?.(controls)
  })

  return (
    <div class="space-y-4 sm:space-y-6">
      <div ref={containerEl} class="flex flex-col gap-4 lg:flex-row lg:items-stretch lg:gap-0">
        {/* Panel 1 — CW Output */}
        <div class="flex min-w-0 flex-col rounded-lg border border-[#30363d] bg-[#161b22] p-3 sm:p-4" style={{ flex: panelWeights()[0] }}>
          <div class="mb-2 flex items-center justify-between sm:mb-3">
            <h2 class="text-lg font-semibold sm:text-xl">CW Output</h2>
            <div class="flex items-center gap-3">
              <div class={`flex items-center gap-2 font-mono text-xs transition-opacity ${dualMode() ? 'opacity-100' : 'pointer-events-none opacity-0'}`}>
                <span class="flex items-center gap-1">
                  <span class="inline-block h-2 w-2 rounded-full bg-[#79c0ff]" />
                  Ch A
                </span>
                <span class="flex items-center gap-1">
                  <span class="inline-block h-2 w-2 rounded-full bg-[#ffa657]" />
                  Ch B
                </span>
              </div>
              <span class="font-mono text-xs text-[#8b949e]">{charCount()} chars</span>
              <button
                onClick={handleCopyText}
                disabled={!hasText()}
                class="rounded border border-[#30363d] px-2 py-0.5 text-xs text-[#8b949e] transition-colors hover:border-[#79c0ff]/40 hover:text-[#79c0ff] disabled:cursor-not-allowed disabled:opacity-30"
              >
                Copy
              </button>
              <button
                onClick={processor.clearText}
                disabled={!hasText()}
                class="rounded border border-[#30363d] px-2 py-0.5 text-xs text-[#8b949e] transition-colors hover:border-[#f85149]/40 hover:text-[#f85149] disabled:cursor-not-allowed disabled:opacity-30"
              >
                Clear
              </button>
            </div>
          </div>

          <div
            ref={textDivEl}
            class="min-h-[200px] w-full flex-1 overflow-y-auto rounded border border-[#30363d] bg-[#0d1117] p-3 font-mono text-sm leading-snug break-words whitespace-pre-wrap focus:outline-none"
            tabIndex={0}
            aria-label="Decoded CW text"
            aria-live="polite"
          >
            {coalescedTokens().length === 0 ? (
              <span class="text-[#30363d]">Decoded CW text will appear here{dualMode() ? ' — Ch A blue · Ch B orange' : '…'}</span>
            ) : (
              <For each={coalescedTokens()}>{(tok) => <span style={{ color: CH_COLORS[tok.channel].text }}>{tok.text}</span>}</For>
            )}
          </div>

          <div
            class={`mt-3 grid gap-3 transition-opacity sm:mt-4 ${dualMode() ? 'grid-cols-2' : 'grid-cols-1'} ${!processor.state().isRecording ? 'opacity-30' : ''}`}
          >
            <MorseVisualizer
              elements={morseElements()}
              flashChar={flashChar()}
              recentChars={recentChars()}
              isReceiving={processor.state().stats?.toneDetected ?? false}
              channel={0}
              label={dualMode() ? 'Channel A' : undefined}
            />
            <div class={`transition-opacity ${dualMode() ? 'opacity-100' : 'pointer-events-none h-0 overflow-hidden opacity-0'}`}>
              <MorseVisualizer
                elements={morseElements2()}
                flashChar={flashChar2()}
                recentChars={recentChars2()}
                isReceiving={processor.state().stats2?.toneDetected ?? false}
                channel={1}
                label="Channel B"
              />
            </div>
          </div>
        </div>

        {/* Drag handle 0<->1 */}
        <div
          class="group hidden w-3 shrink-0 cursor-col-resize items-center justify-center self-stretch lg:flex"
          onMouseDown={(e) => startDrag(e, 0)}
        >
          <div class="h-full w-px bg-[#30363d] transition-colors group-hover:bg-[#2ea043]/50" />
        </div>

        {/* Panel 2 — Audio Analysis. In I/Q mode (see audioSourceKind()
            above), shows the bridge's own wideband I/Q spectrum with a
            draggable passband marker that retunes useIQBridge.ts's
            SSBDemodulator — same "don't mix the two marker concepts"
            reasoning as FTDecoder.tsx's identical branch; the tone
            marker(s) below are only meaningful against already-demodulated
            audio. */}
        <Show
          when={props.iqBridge?.state().connected}
          fallback={
            <SignalAnalysisPanel
              analyser={props.analyser ?? null}
              isRecording={processor.state().isRecording}
              storageKeyPrefix="cw"
              markers={[
                { freq: toneFreq(), color: '#f85149', label: 'T', bandwidthHz: filterBandwidth() },
                ...(dualMode() ? [{ freq: toneFreq2(), color: '#ffa657', label: 'T2', bandwidthHz: filterBandwidth() }] : []),
              ]}
              onMarkerDrag={(idx, newHz) => {
                const f = Math.max(50, newHz)
                if (idx === 0) setToneFreq(f)
                else setToneFreq2(f)
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
              signalDbfs: () => props.iqBridge!.state().iqSignalDbfs,
            }}
            isRecording={processor.state().isRecording}
            vfoFrequency={props.vfoFrequency}
            storageKeyPrefix="cw_iq"
            defaultMaxHz={props.iqBridge!.state().sampleRateHz / 2}
            passband={{ centerHz: props.iqBridge!.state().passbandCenterHz, bandwidthHz: props.iqBridge!.state().passbandBandwidthHz }}
            onPassbandChange={(p) => props.iqBridge!.setPassband(p.centerHz, p.bandwidthHz)}
            markerFieldLabel="Passband"
            /* Tone marker(s) — only meaningful against already-demodulated
               audio, same as the fallback branch above. Passing them here
               too (not previously done) lets them reappear once the
               operator picks "Decoded audio" in the Signal source selector
               (only shown when analyser+iqSource are both given, as here);
               effectiveMarkers/handleMarkerDrag in SignalAnalysisPanel
               already only surface these on the processed tap. */
            markers={[
              { freq: toneFreq(), color: '#f85149', label: 'T', bandwidthHz: filterBandwidth() },
              ...(dualMode() ? [{ freq: toneFreq2(), color: '#ffa657', label: 'T2', bandwidthHz: filterBandwidth() }] : []),
            ]}
            onMarkerDrag={(idx, newHz) => {
              const f = Math.max(50, newHz)
              if (idx === 0) setToneFreq(f)
              else setToneFreq2(f)
            }}
            squelch={squelch()}
            onSquelchChange={setSquelch}
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

        {/* Panel 3 — Decoder Options */}
        <div
          class="flex min-w-0 flex-col gap-3 rounded-lg border border-[#30363d] bg-[#161b22] p-3 sm:p-4"
          style={{ flex: panelWeights()[2] }}
        >
          <h2 class="text-lg font-semibold sm:text-xl">Decoder Options</h2>

          <Show when={processor.state().error}>
            <div class="rounded-md border border-[#f85149]/30 bg-[#da3633]/10 p-3 text-xs text-[#f85149]">{processor.state().error}</div>
          </Show>

          <div class="flex items-center gap-2.5">
            <Toggle checked={dualMode()} onChange={() => setDualMode((v) => !v)} />
            <span class="cursor-default text-sm text-[#c9d1d9] select-none">A/B Mode</span>
          </div>

          <div class="flex flex-wrap items-center gap-2.5">
            <Toggle
              checked={adaptiveDitLength()}
              onChange={() => {
                if (adaptiveDitLength() && processor.state().stats?.adaptiveWpm) setManualWpm(processor.state().stats!.adaptiveWpm!)
                setAdaptiveDitLength((v) => !v)
              }}
            />
            <span class="cursor-default text-sm text-[#c9d1d9] select-none">Adaptive WPM</span>
            {adaptiveDitLength() ? (
              <div class="flex items-center gap-1.5">
                <span class="min-w-[2.5ch] font-mono text-sm text-[#2ea043] tabular-nums">{processor.state().stats?.adaptiveWpm ?? '—'}</span>
                <span class="text-xs text-[#484f58]">WPM</span>
              </div>
            ) : (
              <div class="flex flex-wrap items-center gap-2">
                <NumberField
                  value={manualWpm()}
                  min={3}
                  max={70}
                  onCommit={setManualWpm}
                  class="w-14 rounded border border-[#30363d] bg-[#0d1117] px-2 py-0.5 font-mono text-sm text-[#c9d1d9] transition-colors focus:border-[#79c0ff] focus:outline-none"
                />
                <span class="text-xs text-[#8b949e]">WPM</span>
                <Show when={processor.state().stats?.adaptiveWpm != null}>
                  <span class="text-xs text-[#484f58]">
                    (suggest{' '}
                    <button class="font-mono text-[#2ea043] hover:underline" onClick={() => setManualWpm(processor.state().stats!.adaptiveWpm!)}>
                      {processor.state().stats?.adaptiveWpm}
                    </button>
                    )
                  </span>
                </Show>
              </div>
            )}
          </div>

          <div class="space-y-1">
            <div class="text-xs text-[#8b949e]">Center Ch A</div>
            <div class="flex items-center gap-2">
              {props.vfoFrequency ? (
                <span class="block w-24 rounded border border-[#30363d] bg-[#0d1117] px-2 py-0.5 font-mono text-sm text-[#79c0ff]">
                  {fmtAbsHz(props.vfoFrequency + toneFreq())}
                </span>
              ) : (
                <NumberField
                  value={toneFreq()}
                  parse={(raw) => {
                    const v = parseInt(raw)
                    return Number.isFinite(v) && v >= 50 ? v : null
                  }}
                  onCommit={setToneFreq}
                  class="w-20 rounded border border-[#30363d] bg-[#0d1117] px-2 py-0.5 font-mono text-sm text-[#79c0ff] transition-colors focus:border-[#79c0ff] focus:outline-none"
                />
              )}
              <span class="text-xs text-[#8b949e]">Hz</span>
            </div>
          </div>

          <div class={`space-y-1 transition-opacity ${dualMode() ? 'opacity-100' : 'opacity-30'}`}>
            <div class="text-xs text-[#8b949e]">Center Ch B</div>
            <div class="flex items-center gap-2">
              {props.vfoFrequency ? (
                <span class="block w-24 rounded border border-[#30363d] bg-[#0d1117] px-2 py-0.5 font-mono text-sm text-[#ffa657]">
                  {fmtAbsHz(props.vfoFrequency + toneFreq2())}
                </span>
              ) : (
                <NumberField
                  value={toneFreq2()}
                  parse={(raw) => {
                    const v = parseInt(raw)
                    return Number.isFinite(v) && v >= 50 ? v : null
                  }}
                  disabled={!dualMode()}
                  onCommit={setToneFreq2}
                  class="w-20 rounded border border-[#30363d] bg-[#0d1117] px-2 py-0.5 font-mono text-sm text-[#ffa657] transition-colors focus:border-[#ffa657] focus:outline-none disabled:cursor-not-allowed"
                />
              )}
              <span class="text-xs text-[#8b949e]">Hz</span>
            </div>
          </div>

          <div class="space-y-1">
            <div class="text-xs text-[#8b949e]">Bandwidth</div>
            <div class="flex items-center gap-2">
              <NumberField
                value={filterBandwidth()}
                min={30}
                max={500}
                onCommit={setFilterBandwidth}
                class="w-20 rounded border border-[#30363d] bg-[#0d1117] px-2 py-0.5 font-mono text-sm text-[#c9d1d9] transition-colors focus:border-[#2ea043] focus:outline-none"
              />
              <span class="text-xs text-[#8b949e]">Hz</span>
            </div>
          </div>

          <div class={`mt-auto grid grid-cols-2 gap-2 text-sm transition-opacity ${!processor.state().isRecording ? 'opacity-40' : ''}`}>
            <div class="rounded-lg border border-[#30363d] bg-[#0d1117] p-2.5">
              <div class="mb-0.5 text-[10px] text-[#8b949e]">Speed A</div>
              <div class="font-mono text-xs font-semibold text-[#79c0ff]">
                {processor.state().stats?.wpm ?? '—'} <span class="font-normal text-[#8b949e]">WPM</span>
              </div>
            </div>
            <div class={`rounded-lg border border-[#30363d] bg-[#0d1117] p-2.5 transition-opacity ${dualMode() ? 'opacity-100' : 'opacity-40'}`}>
              <div class="mb-0.5 text-[10px] text-[#8b949e]">Speed B</div>
              <div class="font-mono text-xs font-semibold text-[#ffa657]">
                {processor.state().stats2?.wpm ?? '—'} <span class="font-normal text-[#8b949e]">WPM</span>
              </div>
            </div>
            <div class="rounded-lg border border-[#30363d] bg-[#0d1117] p-2.5">
              <div class="mb-0.5 text-[10px] text-[#8b949e]">Ch A State</div>
              <div class="font-mono text-xs font-semibold">
                {processor.state().stats?.squelched ? (
                  <span class="text-[#e3b341]">Squelched</span>
                ) : processor.state().stats?.toneDetected ? (
                  <span class="flex items-center gap-1 text-[#79c0ff]">
                    <span class="inline-block h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-[#79c0ff]" />
                    Mark
                  </span>
                ) : (
                  <span class="text-[#8b949e]">Space</span>
                )}
              </div>
            </div>
            <div class={`rounded-lg border border-[#30363d] bg-[#0d1117] p-2.5 transition-opacity ${dualMode() ? 'opacity-100' : 'opacity-40'}`}>
              <div class="mb-0.5 text-[10px] text-[#8b949e]">Ch B State</div>
              <div class="font-mono text-xs font-semibold">
                {processor.state().stats2?.squelched ? (
                  <span class="text-[#e3b341]">Squelched</span>
                ) : processor.state().stats2?.toneDetected ? (
                  <span class="flex items-center gap-1 text-[#ffa657]">
                    <span class="inline-block h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-[#ffa657]" />
                    Mark
                  </span>
                ) : (
                  <span class="text-[#8b949e]">Space</span>
                )}
              </div>
            </div>
            <div class="rounded-lg border border-[#30363d] bg-[#0d1117] p-2.5">
              <div class="mb-0.5 text-[10px] text-[#8b949e]">Chars</div>
              <div class="font-mono text-xs font-semibold">{charCount()}</div>
            </div>
            <div class="rounded-lg border border-[#30363d] bg-[#0d1117] p-2.5">
              <div class="mb-0.5 text-[10px] text-[#8b949e]">SNR (Ch A)</div>
              <div class={`font-mono text-xs font-semibold ${snrColor()}`}>
                {processor.state().stats?.snrDb != null ? `${processor.state().stats!.snrDb!.toFixed(1)} dB` : '-- dB'}
              </div>
            </div>
          </div>

          <button
            onClick={handleReset}
            class="self-start rounded border border-[#30363d] px-3 py-1.5 text-xs text-[#8b949e] transition-colors hover:border-[#e3b341]/40 hover:text-[#e3b341]"
          >
            Reset Decoder
          </button>
        </div>
      </div>

      {/* How to Use */}
      <details class="rounded-lg border border-[#30363d] bg-[#161b22]">
        <summary class="cursor-pointer rounded-lg p-4 text-lg font-semibold transition-colors select-none hover:bg-[#21262d] sm:p-6 sm:text-xl">
          How to Use
        </summary>
        <div class="px-4 pb-4 sm:px-6 sm:pb-6">
          <ol class="list-inside list-decimal space-y-2 text-sm text-[#c9d1d9] sm:text-base">
            <li>
              Click <strong>Start Decoding</strong> and allow microphone access
            </li>
            <li>Tune your radio to a CW (Morse code) signal</li>
            <li>
              Set the <strong>Center Ch A</strong> frequency to match the CW tone (typically 600-800 Hz)
            </li>
            <li>
              Use <strong>Bandwidth</strong> to widen or narrow the bandpass filter — narrow (50-80 Hz) for clean signals,
              wider (150-300 Hz) for noisy ones
            </li>
            <li>
              Enable <strong>A/B Mode</strong> to decode two simultaneous CW stations — set each center frequency separately
            </li>
            <li>
              In A/B mode, <span class="text-[#79c0ff]">Ch A text is blue</span> and{' '}
              <span class="text-[#ffa657]">Ch B text is orange</span> in the output panel
            </li>
          </ol>
        </div>
      </details>

      {/* Privacy */}
      <details class="rounded-lg border border-[#30363d] bg-[#161b22]">
        <summary class="cursor-pointer rounded-lg p-4 text-lg font-semibold transition-colors select-none hover:bg-[#21262d] sm:p-6 sm:text-xl">
          Privacy
        </summary>
        <div class="space-y-3 px-4 pb-4 text-sm text-[#c9d1d9] sm:px-6 sm:pb-6 sm:text-base">
          <p>This application runs entirely in your browser. No audio data or decoded text is ever transmitted to any server.</p>
          <p>The microphone permission is only used to capture and process the audio signal in real-time for CW decoding using the Web Audio API.</p>
          <p class="text-xs text-[#8b949e] sm:text-sm">Your privacy is fully protected — we don't collect, store, or transmit any of your data.</p>
        </div>
      </details>
    </div>
  )
}
