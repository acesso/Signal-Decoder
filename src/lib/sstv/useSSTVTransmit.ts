// Encodes and transmits a single composed SSTV image — one-shot (no window
// scheduling like FT8), reusing the same gain/output device/ring-buffer-tap/
// Auto-PTT patterns as useFTTransmit.ts. The output is the shared TX output
// (txSink.ts): the local sound card, played live, or the bridge, where the
// image is uploaded to a TX slot and played from the device.
import { createEffect, createSignal } from 'solid-js';
import type { AudioSinkKind } from '../audio/audioSource';
import { createSlotStaging } from '../audio/slotStaging';
import { txSink } from '../audio/txSink';
import { modeTxGain } from '../audio/bridgeTxLevel';
import { SSTV_MODES, SAMPLE_RATE } from './constants';
import { audioRecorder } from '../audio/ringRecorder';
import { createCaptureNode, type CaptureNode } from '../audio/captureNode';
import { loadString, saveString, loadNumber, saveNumber, loadBoolean, saveBoolean } from '../storage';

export type TxPhase = 'idle' | 'encoding' | 'playing';

export interface SSTVTxState {
  phase: TxPhase;
  progress: number; // 0-1 during playback
  durationSec: number; // total playback length once encoding finishes, 0 before that
  error: string | null;
  outputDeviceId: string;
  txGain: number;
  sinkIdSupported: boolean;
  autoPTT: boolean;
  preKeyMs: number;
  /** Where the image goes: see txSink.ts. */
  audioSink: AudioSinkKind;
}

const LS_OUTPUT = 'sstv_tx_output_device';
const LS_GAIN = 'sstv_tx_gain';
const LS_AUTOPTT = 'sstv_tx_auto_ptt';
const LS_PREKEY = 'sstv_tx_prekey_ms';
const DEFAULT_GAIN = Math.pow(10, -12 / 20); // -12 dB — SSTV audio is played back at near-line level, not the deep attenuation FT8 uses for a shared TX chain
// Pre-key (warm-up) delay between PTT keying on and audio starting, same
// mechanism/rationale as useFTTransmit.ts's preKeyMs: an external PA/relay
// (or the rig's own PTT-to-TX switchover) can take tens-to-hundreds of ms to
// settle, and starting audio right at the PTT edge clips the VIS leader
// tone's first ms(s) — which is exactly what stops a receiver from ever
// catching the VIS header. Only meaningful with Auto-PTT actually wired up.
// Default 0 (off), matching FT's default — most setups (audio-only, VOX,
// solid-state PAs) don't need it.
const MAX_PREKEY_MS = 2000;

// Shared by every mode now (txSink.ts); LS_OUTPUT is only read there once, to migrate.
function loadOutputDevice(): string {
  return txSink.device();
}

let encWorker: Worker | null = null;
let encNextId = 0;
const encPending = new Map<number, (samples: Float32Array, error?: string) => void>();

function getEncodeWorker(): Worker {
  if (!encWorker) {
    encWorker = new Worker(new URL('./encoder.worker.ts', import.meta.url), { type: 'module' });
    encWorker.onmessage = (e: MessageEvent) => {
      const { id, samples, error } = e.data;
      encPending.get(id)?.(samples, error);
      encPending.delete(id);
    };
  }
  return encWorker;
}

function encodeAsync(img: Uint8ClampedArray, mode: keyof typeof SSTV_MODES, sampleRate: number): Promise<Float32Array> {
  return new Promise((resolve, reject) => {
    const id = encNextId++;
    encPending.set(id, (samples, error) => {
      if (error) reject(new Error(error));
      else resolve(samples);
    });
    // img.buffer is transferred to the worker — copy first since the caller's
    // canvas ImageData may still be referenced/read after this call.
    const owned = new Uint8ClampedArray(img);
    getEncodeWorker().postMessage({ id, img: owned, mode, sampleRate }, [owned.buffer]);
  });
}

/** `getOnSetPTT` mirrors createFTTransmit's pattern: a getter so the caller's
 *  own createEffect keeps it current (e.g. CAT connect/disconnect) without
 *  this factory needing its own dependency tracking on a plain arg. */
export function createSSTVTransmit(
  getOnSetPTT?: () => ((tx: boolean) => Promise<void>) | undefined,
  getBridgeWsUrl: () => string | undefined = () => undefined,
) {
  const [state, setState] = createSignal<SSTVTxState>({
    phase: 'idle',
    progress: 0,
    durationSec: 0,
    error: null,
    outputDeviceId: loadOutputDevice(),
    txGain: loadNumber(LS_GAIN, DEFAULT_GAIN),
    sinkIdSupported: typeof AudioContext !== 'undefined' && 'setSinkId' in AudioContext.prototype,
    autoPTT: loadBoolean(LS_AUTOPTT, false),
    preKeyMs: loadNumber(LS_PREKEY, 0),
    audioSink: txSink.kind(),
  });

  let audioCtx: AudioContext | null = null;
  let gainNode: GainNode | null = null;
  let txTap: CaptureNode | null = null;
  let outputDevice = loadOutputDevice();
  let gain = loadNumber(LS_GAIN, DEFAULT_GAIN);
  let autoPTTOn = loadBoolean(LS_AUTOPTT, false);
  let preKeyMs = loadNumber(LS_PREKEY, 0);
  let currentSource: AudioBufferSourceNode | null = null;
  let stopped = false;

  // Bridge output: the encoded image goes into a free TX slot and plays from
  // the device; the slot is freed again afterwards, since a QSO card is a
  // one-off rather than a message to keep staged.
  const staging = createSlotStaging<{ img: Uint8ClampedArray; mode: keyof typeof SSTV_MODES }>({
    getWsUrl: getBridgeWsUrl,
    mode: 'SSTV',
    getGain: () => modeTxGain(gain),
    encode: async ({ img, mode }) => ({ samples: await encodeAsync(img, mode, SAMPLE_RATE), sampleRateHz: SAMPLE_RATE }),
  });

  createEffect(() => {
    const kind = txSink.kind();
    setState((prev) => (prev.audioSink === kind ? prev : { ...prev, audioSink: kind }));
  });
  createEffect(() => {
    const d = txSink.device();
    outputDevice = d;
    setState((prev) => (prev.outputDeviceId === d ? prev : { ...prev, outputDeviceId: d }));
  });

  async function keyPTT(on: boolean): Promise<boolean> {
    const onSetPTT = getOnSetPTT?.();
    if (!autoPTTOn || !onSetPTT) return false;
    try {
      await Promise.race([
        onSetPTT(on),
        new Promise<void>((_, reject) => setTimeout(() => reject(new Error('PTT timeout')), 500)),
      ]);
      return true;
    } catch {
      return false; // CAT not connected or timed out
    }
  }

  async function transmitViaBridge(img: Uint8ClampedArray, mode: keyof typeof SSTV_MODES): Promise<void> {
    stopped = false;
    setState((prev) => ({ ...prev, phase: 'encoding', progress: 0, durationSec: 0, error: null }));
    const staged = await staging.stage({ img, mode }, `SSTV ${mode}`, `QSO card ${mode}`);
    if (!staged.ok || staged.slot === undefined) {
      setState((prev) => ({ ...prev, phase: 'idle', error: staged.error ?? 'Upload to the bridge failed' }));
      return;
    }
    const slot = staged.slot;
    const durationSec = staging.slots()[slot]?.durationSec ?? 0;
    if (stopped) { await staging.clear(slot); setState((prev) => ({ ...prev, phase: 'idle' })); return; }
    let pttOn = false;
    try {
      pttOn = await keyPTT(true);
      if (preKeyMs > 0 && autoPTTOn && getOnSetPTT?.()) await new Promise<void>((r) => setTimeout(r, preKeyMs));
      if (stopped) return;
      setState((prev) => ({ ...prev, phase: 'playing', progress: 0, durationSec }));
      const startedAt = performance.now();
      const timer = setInterval(() => {
        if (durationSec > 0) setState((prev) => ({ ...prev, progress: Math.min(1, (performance.now() - startedAt) / 1000 / durationSec) }));
      }, 250);
      const ok = await staging.send(slot, () => !stopped);
      clearInterval(timer);
      setState((prev) => ({
        ...prev, phase: 'idle', progress: stopped ? prev.progress : 1,
        error: ok || stopped ? null : (staging.error() ?? 'Bridge playback failed'),
      }));
    } finally {
      if (pttOn) await keyPTT(false);
      await staging.clear(slot);
    }
  }

  async function ensureAudioContext(): Promise<AudioContext> {
    if (!audioCtx || audioCtx.state === 'closed') {
      audioCtx = new AudioContext();
      gainNode = audioCtx.createGain();
      gainNode.gain.value = modeTxGain(gain);
      gainNode.connect(audioCtx.destination);
      const ctx = audioCtx;
      txTap = await createCaptureNode(ctx, 4096, (samples) => {
        audioRecorder.write('output', samples, ctx.sampleRate);
      });
    }
    if (outputDevice && 'setSinkId' in audioCtx) {
      try {
        // @ts-expect-error — setSinkId not yet in TS lib
        await audioCtx.setSinkId(outputDevice);
      } catch { /* device unplugged */ }
    }
    if (audioCtx.state === 'suspended') await audioCtx.resume();
    return audioCtx;
  }

  async function encodeAndTransmit(img: Uint8ClampedArray, mode: keyof typeof SSTV_MODES): Promise<void> {
    if (txSink.kind() === 'bridge') return transmitViaBridge(img, mode);
    stopped = false;
    setState((prev) => ({ ...prev, phase: 'encoding', progress: 0, durationSec: 0, error: null }));
    let pttOn = false;
    try {
      const samples = await encodeAsync(img, mode, SAMPLE_RATE);
      if (stopped) return;

      const ctx = await ensureAudioContext();
      const owned = new Float32Array(samples.length);
      owned.set(samples);
      const buf = ctx.createBuffer(1, owned.length, SAMPLE_RATE);
      buf.copyToChannel(owned, 0);

      setState((prev) => ({ ...prev, phase: 'playing', progress: 0, durationSec: buf.duration }));

      // Auto-PTT on — race with a timeout so a non-responsive CAT never blocks TX
      const onSetPTT = getOnSetPTT?.();
      if (autoPTTOn && onSetPTT) {
        try {
          await Promise.race([
            onSetPTT(true),
            new Promise<void>((_, reject) => setTimeout(() => reject(new Error('PTT timeout')), 500)),
          ]);
          pttOn = true;
        } catch { /* CAT not connected or timed out */ }
      }

      // Pre-key (warm-up) hold: give an external PA/relay (or the rig's own
      // PTT-to-TX switchover) time to settle before the VIS leader tone
      // starts, same mechanism as useFTTransmit.ts. Gated on autoPTTOn &&
      // onSetPTT (not pttOn) to match FT's convention — the delay is about
      // giving the hardware time regardless of whether the CAT call itself
      // reported success.
      if (preKeyMs > 0 && autoPTTOn && onSetPTT) {
        await new Promise<void>((r) => setTimeout(r, preKeyMs));
      }
      if (stopped) return;

      await new Promise<void>((resolve) => {
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.connect(gainNode ?? ctx.destination);
        if (txTap) src.connect(txTap.node);
        currentSource = src;

        const startedAt = ctx.currentTime;
        const durationSec = buf.duration;
        let rafId: number | null = null;
        const tick = () => {
          const elapsed = ctx.currentTime - startedAt;
          setState((prev) => ({ ...prev, progress: Math.min(1, elapsed / durationSec) }));
          if (elapsed < durationSec && !stopped) rafId = requestAnimationFrame(tick);
        };
        rafId = requestAnimationFrame(tick);

        src.onended = () => {
          if (rafId) cancelAnimationFrame(rafId);
          currentSource = null;
          resolve();
        };
        src.start(ctx.currentTime);
      });

      setState((prev) => ({ ...prev, phase: 'idle', progress: stopped ? prev.progress : 1 }));
    } catch (err) {
      setState((prev) => ({ ...prev, phase: 'idle', error: err instanceof Error ? err.message : 'Encode/playback failed' }));
    } finally {
      if (pttOn) {
        const onSetPTTOff = getOnSetPTT?.();
        try {
          await Promise.race([
            onSetPTTOff?.(false) ?? Promise.resolve(),
            new Promise<void>((_, reject) => setTimeout(() => reject(new Error('PTT timeout')), 500)),
          ]);
        } catch { /* CAT not connected or timed out */ }
      }
    }
  }

  function stop() {
    stopped = true;
    if (currentSource) {
      try {
        currentSource.stop();
      } catch { /* already stopped */ }
      currentSource = null;
    }
    // A bridge transmission plays from the device's own RAM: stop it there too.
    if (txSink.kind() === 'bridge') void staging.stopPlayback();
    setState((prev) => ({ ...prev, phase: 'idle' }));
  }

  function setAutoPTT(v: boolean) {
    autoPTTOn = v;
    saveBoolean(LS_AUTOPTT, v);
    setState((prev) => ({ ...prev, autoPTT: v }));
  }

  function setPreKeyMs(v: number) {
    const clamped = Math.max(0, Math.min(MAX_PREKEY_MS, Math.round(v)));
    preKeyMs = clamped;
    saveNumber(LS_PREKEY, clamped);
    setState((prev) => ({ ...prev, preKeyMs: clamped }));
  }

  function setOutputDevice(deviceId: string) {
    txSink.setDevice(deviceId);
  }

  function setAudioSink(kind: AudioSinkKind) {
    txSink.setKind(kind);
    setState((prev) => ({ ...prev, audioSink: kind }));
  }

  // While the bridge's DAC level is the TX level (bridgeTxLevel.ts), this mode
  // sends at full scale; follow it when the TX output or the bridge changes.
  createEffect(() => {
    const g = modeTxGain(gain);
    if (gainNode) gainNode.gain.value = g;
  });

  function setTxGain(v: number) {
    gain = v;
    if (gainNode) gainNode.gain.value = modeTxGain(v);
    saveNumber(LS_GAIN, v);
    setState((prev) => ({ ...prev, txGain: v }));
  }

  function destroy() {
    stop();
    if (txTap) {
      txTap.disconnect();
      txTap = null;
    }
    audioCtx?.close().catch(() => null);
    audioCtx = null;
  }

  return {
    state,
    encodeAndTransmit,
    stop,
    setOutputDevice,
    setTxGain,
    setAutoPTT,
    setPreKeyMs,
    setAudioSink,
    destroy,
  };
}

export type SSTVTransmit = ReturnType<typeof createSSTVTransmit>;
