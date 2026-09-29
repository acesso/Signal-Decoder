// Encodes and transmits RTTY text via Web Audio — reuses the same
// gain/output-device/ring-buffer-tap/Auto-PTT patterns as useSSTVTransmit.ts.
//
// Two modes:
//  - one-shot: encode the whole message, play it once (mirrors
//    useSSTVTransmit.ts's encodeAndTransmit exactly).
//  - live: characters are encoded and scheduled one at a time as they're
//    typed, back-to-back with no gap, so a fast typist produces one
//    continuous FSK stream instead of restarting mark/space phase (and
//    keying PTT) per character. A lookahead scheduler tracks the next
//    buffer's start time; each new character's buffer is queued right after
//    whatever's already scheduled.
import { createSignal } from 'solid-js';
import type { RTTYConfig } from './decoder';
import { encodeRTTYSamples, encodeBaudotChars, encodeAsciiChars } from './encoder';
import { audioRecorder } from '../audio/ringRecorder';
import { createCaptureNode, type CaptureNode } from '../audio/captureNode';
import type { AudioSinkKind } from '../audio/audioSource';
import { createSlotStaging, type SlotStaging } from '../audio/slotStaging';
import { loadPreKeyMs, loadPostKeyMs } from '../ft/useFTTransmit';
import { loadString, saveString, loadNumber, saveNumber, loadBoolean, saveBoolean } from '../storage';

export type TxPhase = 'idle' | 'encoding' | 'playing';

export interface RTTYTxState {
  phase: TxPhase;
  error: string | null;
  droppedChars: string[];
  outputDeviceId: string;
  txGain: number;
  sinkIdSupported: boolean;
  autoPTT: boolean;
  live: boolean;
  /** Where TX audio goes. 'bridge' stages into the ESP32's TX slots instead
   *  of playing locally — which is the only way to transmit RTTY at all when
   *  the radio is reached over I/Q, since local playback would otherwise go
   *  to the computer's speakers. Live keying is unavailable there (a slot is
   *  a complete buffer; see slotStaging.ts). */
  audioSink: AudioSinkKind;
}

const LS_OUTPUT = 'rtty_tx_output_device';
const LS_GAIN = 'rtty_tx_gain';
const LS_AUTOPTT = 'rtty_tx_auto_ptt';
const LS_AUDIO_SINK = 'rtty_tx_audio_sink';

function loadAudioSink(): AudioSinkKind {
  return loadString(LS_AUDIO_SINK, 'speaker', ['speaker', 'bridge']) as AudioSinkKind;
}
const DEFAULT_GAIN = Math.pow(10, -12 / 20); // -12 dB, matches SSTV's near-line-level default

function loadOutputDevice(): string {
  return loadString(LS_OUTPUT, '', ['']);
}

const ENC_RATE = 8000; // RTTY's whole passband fits comfortably under 4kHz — no need for FT8/SSTV's higher rates

let encWorker: Worker | null = null;
let encNextId = 0;
const encPending = new Map<number, (samples: Float32Array, dropped: string[], error?: string) => void>();

function getEncodeWorker(): Worker {
  if (!encWorker) {
    encWorker = new Worker(new URL('./encoder.worker.ts', import.meta.url), { type: 'module' });
    encWorker.onmessage = (e: MessageEvent) => {
      const { id, samples, dropped, error } = e.data;
      encPending.get(id)?.(samples, dropped ?? [], error);
      encPending.delete(id);
    };
  }
  return encWorker;
}

function encodeAsync(text: string, config: RTTYConfig, sampleRate: number): Promise<{ samples: Float32Array; dropped: string[] }> {
  return new Promise((resolve, reject) => {
    const id = encNextId++;
    encPending.set(id, (samples, dropped, error) => {
      if (error) reject(new Error(error));
      else resolve({ samples, dropped });
    });
    getEncodeWorker().postMessage({ id, text, config, sampleRate });
  });
}

export function createRTTYTransmit(
  getOnSetPTT?: () => ((tx: boolean) => Promise<void>) | undefined,
  // The bridge's CAT WebSocket URL, read live rather than captured — the CAT
  // panel usually resolves it well after this hook is created.
  getBridgeWsUrl: () => string | undefined = () => undefined,
) {
  const [state, setState] = createSignal<RTTYTxState>({
    phase: 'idle',
    error: null,
    droppedChars: [],
    outputDeviceId: loadOutputDevice(),
    txGain: loadNumber(LS_GAIN, DEFAULT_GAIN),
    sinkIdSupported: typeof AudioContext !== 'undefined' && 'setSinkId' in AudioContext.prototype,
    autoPTT: loadBoolean(LS_AUTOPTT, false),
    live: false,
    audioSink: loadAudioSink(),
  });

  let audioCtx: AudioContext | null = null;
  let gainNode: GainNode | null = null;
  let txTap: CaptureNode | null = null;
  let outputDevice = loadOutputDevice();
  let gain = loadNumber(LS_GAIN, DEFAULT_GAIN);
  let autoPTTOn = loadBoolean(LS_AUTOPTT, false);
  let currentSource: AudioBufferSourceNode | null = null;
  let stopped = false;

  // ── Bridge staging ────────────────────────────────────────────────────────
  // Encode -> upload -> hold. The operator then transmits a staged slot by an
  // explicit second action, which is the whole point for contest/remote use
  // (see slotStaging.ts). Encoding runs on the same worker the local path
  // uses, at the same rate, so a staged message is byte-identical to what the
  // speaker sink would have played, modulo the wire resample.
  const staging: SlotStaging<{ text: string; config: RTTYConfig }> = createSlotStaging({
    getWsUrl: getBridgeWsUrl,
    mode: 'RTTY',
    getGain: () => gain,
    encode: async ({ text, config }) => {
      const { samples, dropped } = await encodeAsync(text, config, ENC_RATE);
      if (dropped.length) setState(prev => ({ ...prev, droppedChars: dropped }));
      return { samples, sampleRateHz: ENC_RATE };
    },
  });

  // ── Live-mode scheduling state ────────────────────────────────────────────
  let liveOn = false;
  let livePttOn = false;
  let liveNextStartTime = 0;
  let liveScheduledSources: AudioBufferSourceNode[] = [];
  let liveIdleTimer: ReturnType<typeof setTimeout> | null = null;

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

  // ── One-shot ──────────────────────────────────────────────────────────────

  async function encodeAndTransmit(text: string, config: RTTYConfig): Promise<void> {
    // Under the bridge sink this would play to the computer's SPEAKERS —
    // exactly the failure staging exists to prevent (in I/Q the radio is
    // never on the local output). Stage instead of transmitting locally,
    // rather than quietly sending audio somewhere the radio cannot hear.
    if (state().audioSink === 'bridge') {
      await stageToBridge(text, config);
      return;
    }
    stopped = false;
    setState((prev) => ({ ...prev, phase: 'encoding', error: null, droppedChars: [] }));
    let pttOn = false;
    try {
      const { samples, dropped } = await encodeAsync(text, config, ENC_RATE);
      if (stopped) return;
      setState((prev) => ({ ...prev, droppedChars: dropped }));

      const ctx = await ensureAudioContext();
      const owned = new Float32Array(samples.length);
      owned.set(samples);
      const buf = ctx.createBuffer(1, owned.length, ENC_RATE);
      buf.copyToChannel(owned, 0);

      setState((prev) => ({ ...prev, phase: 'playing' }));

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
        src.onended = () => { currentSource = null; resolve(); };
        src.start(ctx.currentTime);
      });

      setState((prev) => ({ ...prev, phase: 'idle' }));
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
      try { currentSource.stop(); } catch { /* already stopped */ }
      currentSource = null;
    }
    // A staged send plays from the DEVICE's own RAM, so clearing local state
    // is only half a stop — without this the ESP32 transmits to the end of
    // the buffer while the browser has already dropped PTT.
    if (state().audioSink === 'bridge') void staging.stopPlayback();
    stopLive();
    setState((prev) => ({ ...prev, phase: 'idle' }));
  }

  // ── Live (streaming) ──────────────────────────────────────────────────────
  // Idle gap after which live mode drops PTT/keying rather than holding the
  // key down indefinitely between words while the user pauses typing.
  const LIVE_IDLE_UNKEY_MS = 4000;

  async function startLive(): Promise<void> {
    if (liveOn) return;
    // Live keying cannot work through slots — a slot is a complete buffer
    // uploaded before playback begins. Starting it under the bridge sink
    // would key PTT and play to the local speakers instead of the radio.
    if (state().audioSink === 'bridge') {
      setState(prev => ({ ...prev, error: 'Live keying is unavailable over the bridge — switch output to Local speaker' }));
      return;
    }
    liveOn = true;
    stopped = false;
    const ctx = await ensureAudioContext();
    liveNextStartTime = ctx.currentTime;
    setState((prev) => ({ ...prev, phase: 'playing', error: null, live: true }));

    const onSetPTT = getOnSetPTT?.();
    if (autoPTTOn && onSetPTT && !livePttOn) {
      try {
        await Promise.race([
          onSetPTT(true),
          new Promise<void>((_, reject) => setTimeout(() => reject(new Error('PTT timeout')), 500)),
        ]);
        livePttOn = true;
      } catch { /* CAT not connected or timed out */ }
    }
  }

  // Encodes and schedules one character's worth of audio to play immediately
  // after whatever's already queued — the phase-continuity that matters is
  // WITHIN encodeRTTYSamples' own tone() calls, not across this boundary, so
  // a small startup click between characters is possible but framing (start/
  // stop bits) is preserved exactly as one continuous bitstream would be.
  async function sendLiveChar(ch: string, config: RTTYConfig): Promise<void> {
    if (!liveOn || !audioCtx) return;
    const { codes, dropped } = config.bitsPerChar === 5 ? encodeBaudotChars(ch) : encodeAsciiChars(ch);
    if (dropped.length) setState((prev) => ({ ...prev, droppedChars: [...prev.droppedChars, ...dropped] }));
    if (codes.length === 0) return;

    const samples = encodeRTTYSamples(codes, config, ENC_RATE, 0, 0);
    const owned = new Float32Array(samples.length);
    owned.set(samples);
    const ctx = audioCtx;
    const buf = ctx.createBuffer(1, owned.length, ENC_RATE);
    buf.copyToChannel(owned, 0);

    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(gainNode ?? ctx.destination);
    if (txTap) src.connect(txTap.node);

    const startAt = Math.max(liveNextStartTime, ctx.currentTime);
    src.start(startAt);
    liveNextStartTime = startAt + buf.duration;
    liveScheduledSources.push(src);
    src.onended = () => {
      liveScheduledSources = liveScheduledSources.filter((s) => s !== src);
    };

    if (liveIdleTimer) clearTimeout(liveIdleTimer);
    liveIdleTimer = setTimeout(() => { void unkeyLiveIfIdle(); }, LIVE_IDLE_UNKEY_MS);
  }

  async function unkeyLiveIfIdle(): Promise<void> {
    if (!livePttOn) return;
    livePttOn = false;
    const onSetPTTOff = getOnSetPTT?.();
    try {
      await Promise.race([
        onSetPTTOff?.(false) ?? Promise.resolve(),
        new Promise<void>((_, reject) => setTimeout(() => reject(new Error('PTT timeout')), 500)),
      ]);
    } catch { /* CAT not connected or timed out */ }
  }

  function stopLive() {
    if (!liveOn) return;
    liveOn = false;
    if (liveIdleTimer) { clearTimeout(liveIdleTimer); liveIdleTimer = null; }
    for (const s of liveScheduledSources) { try { s.stop(); } catch { /* already stopped */ } }
    liveScheduledSources = [];
    void unkeyLiveIfIdle();
    setState((prev) => ({ ...prev, phase: 'idle', live: false }));
  }

  function setLive(v: boolean) {
    setState((prev) => ({ ...prev, live: v }));
    if (!v) stopLive();
  }

  // ── Bridge staging (public) ───────────────────────────────────────────────

  /** Encode `text` and hold it in a bridge slot. Nothing goes on the air.
   *
   *  Staging during a transmission is legitimate — queueing up the next
   *  message while the current one plays is much of why a slot pool exists —
   *  so this must not drive the shared `phase`, which describes what is on
   *  the air. Per-slot progress lives in bridgeSlots()'s own phase instead. */
  async function stageToBridge(text: string, config: RTTYConfig): Promise<boolean> {
    const trimmed = text.trim();
    if (!trimmed) return false;
    setState(prev => ({ ...prev, error: null, droppedChars: [] }));
    // The slot's own label is only 32 bytes and `message` 48, so the device
    // copy is a human label, not the payload — the audio is the payload.
    const res = await staging.stage({ text: trimmed, config }, trimmed, trimmed);
    if (!res.ok) setState(prev => ({ ...prev, error: res.error ?? 'Staging failed' }));
    return res.ok;
  }

  /** Transmit an already-staged slot, keying PTT around it exactly as FT8's
   *  TX loop does: key, hold preKeyMs for an external PA/relay to switch,
   *  play, hold postKeyMs, unkey. The hold values are FT's own persisted
   *  settings rather than a second RTTY-specific pair, so an operator
   *  configures their amplifier's timing once (see the design doc).
   *
   *  Deliberately NOT gated on the local AudioContext — bridge playback
   *  happens on the device, so nothing here needs Web Audio at all. */
  async function sendStagedSlot(slot: number): Promise<boolean> {
    if (state().phase !== 'idle') return false;
    stopped = false;
    setState(prev => ({ ...prev, phase: 'playing', error: null }));

    const onSetPTT = getOnSetPTT?.();
    let pttOn = false;
    if (autoPTTOn && onSetPTT) {
      try {
        await Promise.race([
          onSetPTT(true),
          new Promise<void>((_, reject) => setTimeout(() => reject(new Error('PTT timeout')), 500)),
        ]);
        pttOn = true;
      } catch { /* CAT not connected or timed out */ }
    }

    try {
      const preKeyMs = loadPreKeyMs();
      if (preKeyMs > 0 && pttOn) await new Promise(r => setTimeout(r, preKeyMs));
      if (stopped) return false;

      const ok = await staging.send(slot, () => !stopped);
      if (!ok) setState(prev => ({ ...prev, error: staging.error() ?? 'Bridge playback failed' }));

      const postKeyMs = loadPostKeyMs();
      if (postKeyMs > 0 && pttOn) await new Promise(r => setTimeout(r, postKeyMs));
      return ok;
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
      setState(prev => ({ ...prev, phase: 'idle' }));
    }
  }

  function setAudioSink(kind: AudioSinkKind) {
    saveString(LS_AUDIO_SINK, kind);
    setState(prev => ({ ...prev, audioSink: kind }));
    // Live keying cannot work through slots (see slotStaging.ts), so leaving
    // it engaged while switching to the bridge would silently key a sink that
    // can never carry it.
    if (kind === 'bridge') stopLive();
  }

  // ── Settings ──────────────────────────────────────────────────────────────

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
    startLive,
    sendLiveChar,
    stopLive,
    setLive,
    stop,
    setOutputDevice,
    setTxGain,
    setAutoPTT,
    setAudioSink,
    // Bridge staging
    stageToBridge,
    sendStagedSlot,
    bridgeSlots: staging.slots,
    clearBridgeSlot: staging.clear,
    refreshBridgeSlots: staging.refresh,
    destroy,
  };
}

export type RTTYTransmit = ReturnType<typeof createRTTYTransmit>;
