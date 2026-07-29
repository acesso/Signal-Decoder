// Encodes and plays back a single composed SSTV image via Web Audio —
// one-shot (no window scheduling like FT8), reusing the same gain/output
// device/ring-buffer-tap/Auto-PTT patterns as useFTTransmit.ts.
import { createSignal } from 'solid-js';
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
}

const LS_OUTPUT = 'sstv_tx_output_device';
const LS_GAIN = 'sstv_tx_gain';
const LS_AUTOPTT = 'sstv_tx_auto_ptt';
const DEFAULT_GAIN = Math.pow(10, -12 / 20); // -12 dB — SSTV audio is played back at near-line level, not the deep attenuation FT8 uses for a shared TX chain

function loadOutputDevice(): string {
  return loadString(LS_OUTPUT, '', ['']);
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
export function createSSTVTransmit(getOnSetPTT?: () => ((tx: boolean) => Promise<void>) | undefined) {
  const [state, setState] = createSignal<SSTVTxState>({
    phase: 'idle',
    progress: 0,
    durationSec: 0,
    error: null,
    outputDeviceId: loadOutputDevice(),
    txGain: loadNumber(LS_GAIN, DEFAULT_GAIN),
    sinkIdSupported: typeof AudioContext !== 'undefined' && 'setSinkId' in AudioContext.prototype,
    autoPTT: loadBoolean(LS_AUTOPTT, false),
  });

  let audioCtx: AudioContext | null = null;
  let gainNode: GainNode | null = null;
  let txTap: CaptureNode | null = null;
  let outputDevice = loadOutputDevice();
  let gain = loadNumber(LS_GAIN, DEFAULT_GAIN);
  let autoPTTOn = loadBoolean(LS_AUTOPTT, false);
  let currentSource: AudioBufferSourceNode | null = null;
  let stopped = false;

  async function ensureAudioContext(): Promise<AudioContext> {
    if (!audioCtx || audioCtx.state === 'closed') {
      audioCtx = new AudioContext();
      gainNode = audioCtx.createGain();
      gainNode.gain.value = gain;
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
    setState((prev) => ({ ...prev, phase: 'idle' }));
  }

  function setAutoPTT(v: boolean) {
    autoPTTOn = v;
    saveBoolean(LS_AUTOPTT, v);
    setState((prev) => ({ ...prev, autoPTT: v }));
  }

  function setOutputDevice(deviceId: string) {
    outputDevice = deviceId;
    saveString(LS_OUTPUT, deviceId);
    setState((prev) => ({ ...prev, outputDeviceId: deviceId }));
  }

  function setTxGain(v: number) {
    gain = v;
    if (gainNode) gainNode.gain.value = v;
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
    destroy,
  };
}

export type SSTVTransmit = ReturnType<typeof createSSTVTransmit>;
