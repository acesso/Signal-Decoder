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
}

const LS_OUTPUT = 'rtty_tx_output_device';
const LS_GAIN = 'rtty_tx_gain';
const LS_AUTOPTT = 'rtty_tx_auto_ptt';
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

export function createRTTYTransmit(getOnSetPTT?: () => ((tx: boolean) => Promise<void>) | undefined) {
  const [state, setState] = createSignal<RTTYTxState>({
    phase: 'idle',
    error: null,
    droppedChars: [],
    outputDeviceId: loadOutputDevice(),
    txGain: loadNumber(LS_GAIN, DEFAULT_GAIN),
    sinkIdSupported: typeof AudioContext !== 'undefined' && 'setSinkId' in AudioContext.prototype,
    autoPTT: loadBoolean(LS_AUTOPTT, false),
    live: false,
  });

  let audioCtx: AudioContext | null = null;
  let gainNode: GainNode | null = null;
  let txTap: CaptureNode | null = null;
  let outputDevice = loadOutputDevice();
  let gain = loadNumber(LS_GAIN, DEFAULT_GAIN);
  let autoPTTOn = loadBoolean(LS_AUTOPTT, false);
  let currentSource: AudioBufferSourceNode | null = null;
  let stopped = false;

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
    stopLive();
    setState((prev) => ({ ...prev, phase: 'idle' }));
  }

  // ── Live (streaming) ──────────────────────────────────────────────────────
  // Idle gap after which live mode drops PTT/keying rather than holding the
  // key down indefinitely between words while the user pauses typing.
  const LIVE_IDLE_UNKEY_MS = 4000;

  async function startLive(): Promise<void> {
    if (liveOn) return;
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
    destroy,
  };
}

export type RTTYTransmit = ReturnType<typeof createRTTYTransmit>;
