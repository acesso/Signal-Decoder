// The Probe result in the CAT connection settings: what the bridge (if CAT
// runs over one) and the radio behind it reported, organized so an operator
// can see at a glance what this setup can do.
import { For, Show, type JSX } from 'solid-js'
import type { BridgeCapabilities, BridgeRouting } from '../lib/cat/bridgeCapabilities'
import { effectiveQueries, QUERY_LABELS, type RadioReport } from '../lib/cat/radioProbe'

export interface ProbeResult {
  /** What was probed, for the header line. */
  target: string
  bridge?: { capabilities: BridgeCapabilities; routing: BridgeRouting; features: string[]; catOk: boolean } | null
  /** null when the radio couldn't be asked at all (e.g. the CAT socket didn't open). */
  radio?: RadioReport | null
  error?: string
}

function Chip(props: { ok?: boolean; children: JSX.Element; title?: string }) {
  return (
    <span
      title={props.title}
      class={`rounded border px-1.5 py-0.5 text-[10px] font-mono ${
        props.ok === false ? 'border-[#f8514966] text-[#f85149]' : props.ok ? 'border-[#2ea04366] text-[#7ee787]' : 'border-[#30363d] text-[#c9d1d9]'
      }`}
    >
      {props.children}
    </span>
  )
}

function Section(props: { title: string; children: JSX.Element }) {
  return (
    <div class="flex flex-col gap-1">
      <span class="text-[9px] font-semibold uppercase tracking-widest text-[#8b949e]">{props.title}</span>
      {props.children}
    </div>
  )
}

const kindLabel = (k: string) => (k === 'iq' ? 'I/Q' : 'audio')

export function ProbeCard(props: { result: ProbeResult }) {
  const b = () => props.result.bridge
  const r = () => props.result.radio
  const feeds = (id: string, kind: string) => (kind === 'iq' ? b()?.routing.iq.input : b()?.routing.audio.input) === id
  const inUse = (id: string) => b()?.routing.iq.input === id || b()?.routing.audio.input === id
  const radioAnswered = () => !!r() && (r()!.id !== null || r()!.firmware !== null || r()!.queries !== null)
  return (
    <div class="flex flex-col gap-3 rounded-md border border-[#30363d] bg-[#0d1117] p-3">
      <Show when={b()}>
        <div class="flex flex-wrap items-baseline gap-x-6 gap-y-1 text-xs">
          <span class="text-[#8b949e]">Model: <span class="font-mono text-[#7ee787]">{b()!.capabilities.model}</span></span>
          <span class="text-[#8b949e]">Firmware: <span class="font-mono text-[#7ee787]">{b()!.capabilities.firmwareVersion || '?'}</span></span>
          <Show when={!b()!.catOk}>
            <span class="text-[#f85149]" title="The bridge answered over HTTP, but its CAT WebSocket (/cat) did not open — CAT would fail to connect.">CAT endpoint unreachable</span>
          </Show>
        </div>
      </Show>

      <Show when={props.result.error}>
        <p class="text-[10px] text-[#f85149]">{props.result.error}</p>
      </Show>

      <Show when={b()}>
        {(bridge) => (
          <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Section title="Inputs">
              <For each={bridge().capabilities.inputs}>
                {(i) => (
                  <div class="flex flex-wrap items-center gap-1 text-[10px]">
                    <span class={`font-mono ${inUse(i.id) ? 'text-[#7ee787]' : 'text-[#c9d1d9]'}`}>{i.chip}</span>
                    <span class="text-[#8b949e]">{i.rateHz / 1000} kHz · {i.jack}</span>
                    <For each={i.kinds}>
                      {(k) => <Chip ok={feeds(i.id, k) || undefined}>{kindLabel(k)}</Chip>}
                    </For>
                  </div>
                )}
              </For>
              <span class="text-[10px] text-[#8b949e]">
                Green: in use. {bridge().capabilities.concurrentInputs ? 'Inputs run at the same time.' : 'One kind at a time (switching reboots the bridge).'}
              </span>
            </Section>
            <Section title="Outputs (TX)">
              <For each={bridge().capabilities.outputs} fallback={<span class="text-[10px] text-[#8b949e]">none</span>}>
                {(o) => (
                  <div class="flex flex-wrap items-center gap-1 text-[10px]">
                    <span class={`font-mono ${bridge().routing.tx.output === o.id ? 'text-[#7ee787]' : 'text-[#c9d1d9]'}`}>{o.chip}</span>
                    <Show when={o.delivery.includes('slots')}>
                      <Chip>{o.slots} slots</Chip>
                    </Show>
                    <span class="text-[#8b949e]">channel</span>
                    <For each={o.channels}>
                      {(ch) => <Chip ok={bridge().routing.tx.channel === ch || undefined}>{ch}</Chip>}
                    </For>
                  </div>
                )}
              </For>
            </Section>
            <Section title="DSP on the bridge">
              <Show
                when={bridge().capabilities.dsp}
                fallback={<span class="text-[10px] text-[#8b949e]">None: the app computes the spectrum and demodulates raw I/Q.</span>}
              >
                {(dsp) => (
                  <div class="flex flex-wrap gap-1">
                    <Show when={dsp().iqSpectrum}><Chip ok>spectrum</Chip></Show>
                    <Chip ok>passband {dsp().iqPassbandRatesHz.map((x) => x / 1000).join('/')} kHz</Chip>
                    <Show when={dsp().dcRemoval}><Chip ok>DC removal</Chip></Show>
                    <Show when={dsp().iqCorrections.length > 1}><Chip ok>I/Q swap/negate</Chip></Show>
                  </div>
                )}
              </Show>
            </Section>
            <Section title="PA monitoring">
              <div class="flex flex-wrap gap-1">
                <Chip ok={bridge().capabilities.pa.sense}>sense</Chip>
                <Chip ok={bridge().capabilities.pa.emergency}>emergency cut-off</Chip>
              </div>
            </Section>
            <div class="sm:col-span-2">
              <Section title={`Bridge features (${bridge().features.length})`}>
                <div class="flex flex-wrap gap-1">
                  <For each={bridge().features}>{(f) => <Chip>{f}</Chip>}</For>
                </div>
              </Section>
            </div>
          </div>
        )}
      </Show>

      <Show when={r() !== undefined}>
        <Section title="Radio">
          <Show
            when={radioAnswered()}
            fallback={<span class="text-[10px] text-[#8b949e]">
              {r() === null ? 'Could not ask the radio.' : 'The radio did not answer ID; FV; or CL; — check it is on and connected (and the baud rate).'}
            </span>}
          >
            <div class="flex flex-col gap-1.5">
              <div class="flex flex-wrap items-center gap-1 text-[10px] text-[#c9d1d9]">
                <span>{r()!.model ?? 'model unknown'}</span>
                <Show when={r()!.firmware}><Chip ok>fw {r()!.firmware}</Chip></Show>
                <Chip ok={Array.isArray(r()!.queries)}>
                  {Array.isArray(r()!.queries) ? 'capability report' : r()!.queries === 'unsupported' ? 'no capability report (older firmware)' : 'no CL; answer'}
                </Chip>
              </div>
              <div class="flex flex-wrap gap-1">
                <For each={effectiveQueries(r()!)}>
                  {(q) => <Chip title={QUERY_LABELS[q] ?? q}>{q}{QUERY_LABELS[q] ? ` · ${QUERY_LABELS[q]}` : ''}</Chip>}
                </For>
              </div>
              <Show when={!Array.isArray(r()!.queries)}>
                <span class="text-[10px] text-[#8b949e]">Shown: the fixed set every older firmware answers.</span>
              </Show>
            </div>
          </Show>
        </Section>
      </Show>
    </div>
  )
}
