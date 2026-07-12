// Port of src/hooks/useFTTransmit.ts (Next.js app) — encodes and transmits
// FT8/FT4 messages via Web Audio (optionally through a CAT-controlled
// radio's PTT), with a TX queue, auto-CQ, and audio device/gain selection.
// Kept close to the original's imperative timing logic verbatim (the
// comments explaining UTC-window/consecutive-TX/auto-CQ-cadence logic are
// load-bearing, not stylistic).
import { createSignal } from 'solid-js'
import { FTMode, FT_WINDOW_SECONDS, FT_SUPPORTED } from '$decoder-lib/ft/decoder'
import { audioRecorder } from '$decoder-lib/audio/ringRecorder'

export interface TxQueueEntry {
  id: string;
  message: string;
  label: string;
  /** Pinned TX audio frequency for THIS entry (honors a station's QSY
   *  request per conversation) — overrides the panel's global Audio Hz,
   *  which stays untouched. */
  audioHz?: number;
  // Populated as soon as the entry is enqueued — loop never waits for encoding
  samples: Float32Array | null;
  encodeStatus: 'pending' | 'ready' | 'error';
  encodeError?: string;
}

export interface SentEntry {
  id: string;
  message: string;
  label: string;
  windowStart: Date;
  vfoHz: number;
  audioHz: number;
  error?: string;
}

export type TxStatus = 'idle' | 'waiting' | 'playing';

export interface FTTransmitState {
  status: TxStatus;
  queue: TxQueueEntry[];
  sent: SentEntry[];
  autoCQ: boolean;
  autoCQIntervalMin: number;
  autoPTT: boolean;
  allowConsecutiveTx: boolean;
  error: string | null;
  outputDeviceId: string;
  txGain: number;
  sinkIdSupported: boolean;
}

// ── localStorage persistence ──────────────────────────────────────────────────

const LS_CALL            = 'ft_mycall';
const LS_GRID            = 'ft_mygrid';
const LS_OUTPUT          = 'ft_output_device';
const LS_GAIN            = 'ft_tx_gain';
const LS_AUTOPTT         = 'ft_auto_ptt';
const LS_CONSECUTIVE_TX  = 'ft_consecutive_tx';
const LS_BASE_FREQ       = 'ft_base_freq';
const LS_AUTOCQ_INTERVAL = 'ft_autocq_interval_min';

export const DEFAULT_BASE_FREQ = 1850;
export function loadBaseFreq(): number {
  if (typeof window === 'undefined') return DEFAULT_BASE_FREQ;
  const stored = localStorage.getItem(LS_BASE_FREQ);
  return stored !== null ? parseInt(stored, 10) : DEFAULT_BASE_FREQ;
}
export function saveBaseFreq(v: number) {
  if (typeof window !== 'undefined') localStorage.setItem(LS_BASE_FREQ, String(v));
}

export function loadMyCall(): string {
  if (typeof window === 'undefined') return '';
  return localStorage.getItem(LS_CALL) ?? '';
}
export function saveMyCall(v: string) {
  if (typeof window !== 'undefined') localStorage.setItem(LS_CALL, v);
}
export function loadMyGrid(): string {
  if (typeof window === 'undefined') return '';
  return localStorage.getItem(LS_GRID) ?? '';
}
export function saveMyGrid(v: string) {
  if (typeof window !== 'undefined') localStorage.setItem(LS_GRID, v);
}
export function loadOutputDevice(): string {
  if (typeof window === 'undefined') return '';
  return localStorage.getItem(LS_OUTPUT) ?? '';
}
export function saveOutputDevice(v: string) {
  if (typeof window !== 'undefined') localStorage.setItem(LS_OUTPUT, v);
}
const DEFAULT_GAIN = Math.pow(10, -50 / 20); // -50 dB
export function loadTxGain(): number {
  if (typeof window === 'undefined') return DEFAULT_GAIN;
  const stored = localStorage.getItem(LS_GAIN);
  return stored !== null ? parseFloat(stored) : DEFAULT_GAIN;
}
export function saveTxGain(v: number) {
  if (typeof window !== 'undefined') localStorage.setItem(LS_GAIN, String(v));
}
export function loadAutoPTT(): boolean {
  if (typeof window === 'undefined') return false;
  return localStorage.getItem(LS_AUTOPTT) === 'true';
}
export function saveAutoPTT(v: boolean) {
  if (typeof window !== 'undefined') localStorage.setItem(LS_AUTOPTT, String(v));
}
export function loadAllowConsecutiveTx(): boolean {
  if (typeof window === 'undefined') return false;
  return localStorage.getItem(LS_CONSECUTIVE_TX) === 'true';
}
export function saveAllowConsecutiveTx(v: boolean) {
  if (typeof window !== 'undefined') localStorage.setItem(LS_CONSECUTIVE_TX, String(v));
}

// Minimum gap between unattended auto-CQ transmissions. Left unchecked, the
// TX loop would send a CQ in every eligible window (as often as every ~15s
// for FT8) — far too aggressive for a beacon nobody is watching. Default 5
// minutes is a reasonable, still-discoverable cadence; 1..60 min range.
export const DEFAULT_AUTOCQ_INTERVAL_MIN = 5;
export function loadAutoCQIntervalMin(): number {
  if (typeof window === 'undefined') return DEFAULT_AUTOCQ_INTERVAL_MIN;
  const stored = localStorage.getItem(LS_AUTOCQ_INTERVAL);
  const n = stored !== null ? parseInt(stored, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_AUTOCQ_INTERVAL_MIN;
}
export function saveAutoCQIntervalMin(v: number) {
  if (typeof window !== 'undefined') localStorage.setItem(LS_AUTOCQ_INTERVAL, String(v));
}

// Restoring auto-CQ=on cannot transmit by itself: the TX engine still starts
// stopped and must be armed manually each session.
const LS_AUTOCQ = 'ft_autocq';
export function loadAutoCQ(): boolean {
  if (typeof window === 'undefined') return false;
  return localStorage.getItem(LS_AUTOCQ) === 'true';
}
export function saveAutoCQ(v: boolean) {
  if (typeof window !== 'undefined') localStorage.setItem(LS_AUTOCQ, String(v));
}

const LS_AUTOREPLY = 'ft_auto_reply';
export function loadAutoReply(): boolean {
  if (typeof window === 'undefined') return false;
  return localStorage.getItem(LS_AUTOREPLY) === 'true';
}
export function saveAutoReply(v: boolean) {
  if (typeof window !== 'undefined') localStorage.setItem(LS_AUTOREPLY, String(v));
}

// ── Encoder worker ────────────────────────────────────────────────────────────

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

function encodeAsync(
  msg: string,
  mode: FTMode,
  sampleRate: number,
  baseFrequency: number,
): Promise<Float32Array> {
  return new Promise((resolve, reject) => {
    const id = encNextId++;
    encPending.set(id, (samples, error) => {
      if (error) reject(new Error(error));
      else resolve(samples);
    });
    getEncodeWorker().postMessage({ id, msg, mode, sampleRate, baseFrequency });
  });
}

// ── Factory ───────────────────────────────────────────────────────────────────
// React's useFTTransmit(mode, baseFrequency, vfoFrequency, onSetPTT) took its
// params positionally and re-synced them via per-param useEffects in the
// calling component. Solid has no automatic dependency tracking on plain
// function args, so this factory instead reads live values through getter
// functions supplied once at creation — the caller's own createEffect(s)
// naturally keep them current without any extra sync plumbing.
export function createFTTransmit(
  getMode: () => FTMode,
  getBaseFrequency: () => number,
  getVfoFrequency: () => number,
  getOnSetPTT: () => ((tx: boolean) => Promise<void>) | undefined,
) {
  const [state, setState] = createSignal<FTTransmitState>({
    status: 'idle',
    queue: [],
    sent: [],
    autoCQ: loadAutoCQ(),
    autoCQIntervalMin: loadAutoCQIntervalMin(),
    autoPTT: loadAutoPTT(),
    allowConsecutiveTx: loadAllowConsecutiveTx(),
    error: null,
    outputDeviceId: loadOutputDevice(),
    txGain: loadTxGain(),
    sinkIdSupported: typeof AudioContext !== 'undefined' && 'setSinkId' in AudioContext.prototype,
  });

  let isRunning          = false;
  let outputDevice       = loadOutputDevice();
  let autoCQOn           = loadAutoCQ();
  let autoCQIntervalMin  = loadAutoCQIntervalMin();
  let lastAutoCQAtMs     = 0; // epoch ms of the last auto-CQ transmission, 0 = none sent yet this session
  let autoPTTOn          = loadAutoPTT();
  let allowConsecutiveTx = loadAllowConsecutiveTx();
  let lastTxWindow       = -1; // epoch ms of last window we transmitted in
  let gain               = loadTxGain();
  let gainNode: GainNode | null = null;
  let txTap: ScriptProcessorNode | null = null;
  let queue: TxQueueEntry[] = [];
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let audioCtx: AudioContext | null = null;

  function clearTimers() {
    for (const t of timers) clearTimeout(t);
    timers.clear();
  }

  function sleep(ms: number): Promise<void> {
    return new Promise(resolve => {
      const t = setTimeout(() => { timers.delete(t); resolve(); }, ms);
      timers.add(t);
    });
  }

  // ── Encode on enqueue ─────────────────────────────────────────────────────
  // Start encoding the moment a message is added. By the time the window
  // arrives (~seconds away), samples are already ready in the entry.

  function startEncode(entry: TxQueueEntry) {
    const ENC_RATE = 12000;
    encodeAsync(entry.message, getMode(), ENC_RATE, entry.audioHz ?? getBaseFrequency())
      .then(samples => {
        setState(prev => {
          const q = prev.queue.map(e =>
            e.id === entry.id ? { ...e, samples, encodeStatus: 'ready' as const } : e
          );
          queue = q;
          return { ...prev, queue: q };
        });
      })
      .catch(err => {
        const encodeError = err instanceof Error ? err.message : String(err);
        setState(prev => {
          const q = prev.queue.map(e =>
            e.id === entry.id ? { ...e, encodeStatus: 'error' as const, encodeError } : e
          );
          queue = q;
          return { ...prev, queue: q };
        });
      });
  }

  // ── Auto-CQ sample cache ──────────────────────────────────────────────────
  // The CQ message is encoded eagerly and cached outside the queue so the loop
  // can play it immediately without injecting a queue entry (which would add
  // a full window of latency and cause duplicate-key issues in the UI).

  let autoCQSamples: Float32Array | null = null;
  let autoCQMsgCached  = '';   // message text that was last encoded
  let autoCQModeCached = '';   // mode that was encoded for
  let autoCQFreqCached = 0;    // baseFreq that was encoded for
  let autoCQMessage    = '';

  function rebuildAutoCQCache(msg: string) {
    if (!msg) { autoCQSamples = null; autoCQMsgCached = ''; return; }
    autoCQSamples = null; // invalidate while encoding
    autoCQMsgCached  = msg;
    autoCQModeCached = getMode();
    autoCQFreqCached = getBaseFrequency();
    encodeAsync(msg, getMode(), 12000, getBaseFrequency())
      .then(samples => {
        // Only store if message/mode/freq haven't changed since we started
        if (
          autoCQMsgCached  === msg &&
          autoCQModeCached === getMode() &&
          autoCQFreqCached === getBaseFrequency()
        ) {
          autoCQSamples = samples;
        }
      })
      .catch(() => { autoCQSamples = null; });
  }

  // ── Audio context ─────────────────────────────────────────────────────────

  async function getAudioContext(): Promise<AudioContext> {
    const ctx = audioCtx!;
    const deviceId = outputDevice;
    if (deviceId && 'setSinkId' in ctx) {
      try {
        // @ts-expect-error — setSinkId not yet in TS lib
        await ctx.setSinkId(deviceId);
      } catch { /* device unplugged */ }
    }
    if (ctx.state === 'suspended') await ctx.resume();
    return ctx;
  }

  // ── Sent log helpers ──────────────────────────────────────────────────────
  // Collapse a repeat of the most-recent message (same text, no error) into
  // one row — prevents the log from filling with repeated auto-CQ rows — but
  // REPLACE it so windowStart reflects the latest transmission: auto-reply
  // decides whose turn it is by comparing this timestamp against the peer's
  // last message, and a stale one would misread a retry as already answered.
  // Cap at 50 entries total.

  function dedupeAndCapSent(entry: SentEntry, prev: SentEntry[]): SentEntry[] {
    if (!entry.error && prev.length > 0 && prev[0].message === entry.message) {
      return [entry, ...prev.slice(1)]; // refresh the row in place
    }
    return [entry, ...prev].slice(0, 50);
  }

  // ── Transmit loop ─────────────────────────────────────────────────────────

  async function runLoop() {
    // Sleep to the next UTC window boundary. Always skip at least one full
    // window on startup to avoid transmitting mid-window.
    const sleepToNextBoundary = (windowSec: number, skipExtra = false): Promise<void> => {
      const windowMs  = windowSec * 1000;
      const nowMs     = Date.now();
      const elapsed   = nowMs % windowMs;
      const remaining = windowMs - elapsed;
      // If we're within 50ms of a boundary, skip to the one after
      const wait = (remaining <= 50 || skipExtra) ? remaining + windowMs : remaining;
      return sleep(wait);
    };

    await sleepToNextBoundary(FT_WINDOW_SECONDS[getMode()], true);

    while (isRunning) {
      const windowSec = FT_WINDOW_SECONDS[getMode()];
      const windowMs  = windowSec * 1000;

      // We are now at a window boundary. Decide what this window does.
      setState(prev => ({ ...prev, status: 'waiting' }));

      // Consecutive-TX guard: if we transmitted in the immediately preceding window,
      // this window is a forced listen window.
      const nowMs              = Date.now();
      const currentWindowStart = nowMs - (nowMs % windowMs);
      const prevWindowStart    = currentWindowStart - windowMs;
      const skipForListen      = !allowConsecutiveTx &&
        (lastTxWindow === prevWindowStart || lastTxWindow === currentWindowStart);

      if (skipForListen) {
        await sleepToNextBoundary(windowSec);
        if (!isRunning) break;
        continue;
      }

      // Decide what to transmit this window.
      // Queued entries take priority; auto-CQ fills in when the queue is empty
      // AND at most once per configured interval — otherwise an unattended
      // beacon would key up in every eligible window (every ~15s on FT8).
      const queuedEntry     = queue[0] ?? null;
      const autoCQDueMs     = lastAutoCQAtMs + autoCQIntervalMin * 60_000;
      const autoCQDue       = nowMs >= autoCQDueMs;
      const useAutoCQ       = !queuedEntry && autoCQOn && !!autoCQSamples && autoCQDue;

      if (!queuedEntry && !useAutoCQ) {
        await sleepToNextBoundary(windowSec);
        if (!isRunning) break;
        continue;
      }

      // ── Resolve samples ───────────────────────────────────────────────────
      let samples: Float32Array | null = null;
      let txMessage = '';
      let txLabel   = '';
      let txId      = '';
      let txAudioHz = getBaseFrequency();

      if (useAutoCQ) {
        samples   = autoCQSamples;
        txMessage = autoCQMsgCached;
        txLabel   = 'CQ (auto)';
        txId      = ''; // filled in below from windowStart
      } else {
        // Re-read from queue — entry may have been dequeued or its samples updated
        const live = queue.find(e => e.id === queuedEntry!.id) ?? queuedEntry!;

        if (live.encodeStatus === 'error') {
          const sent: SentEntry = {
            id: live.id, message: live.message, label: live.label,
            windowStart: new Date(),
            vfoHz: getVfoFrequency(), audioHz: live.audioHz ?? getBaseFrequency(),
            error: live.encodeError,
          };
          setState(prev => ({
            ...prev,
            queue: prev.queue.filter(q => q.id !== live.id),
            sent: dedupeAndCapSent(sent, prev.sent),
            error: live.encodeError ?? 'Encode error',
          }));
          queue = queue.filter(q => q.id !== live.id);
          continue;
        }

        // If still encoding, wait briefly (rare — encode starts on enqueue)
        if (live.encodeStatus === 'pending' || !live.samples) {
          await sleep(200);
          if (!isRunning) break;
        }

        const finalEntry = queue.find(e => e.id === live.id) ?? live;
        if (!finalEntry.samples) continue;

        samples   = finalEntry.samples;
        txMessage = finalEntry.message;
        txLabel   = finalEntry.label;
        txId      = finalEntry.id;
        txAudioHz = finalEntry.audioHz ?? getBaseFrequency();
      }

      if (!samples) continue;

      const windowStart    = new Date();
      const windowStartMs  = windowStart.getTime();
      const txWindowBucket = windowStartMs - (windowStartMs % windowMs);
      lastTxWindow = txWindowBucket;
      // For auto-CQ, generate a unique sent-log id from exact playback time
      if (useAutoCQ) { txId = `autocq-${windowStartMs}`; lastAutoCQAtMs = windowStartMs; }
      setState(prev => ({ ...prev, status: 'playing', error: null }));

      // Auto-PTT on — race with a 500ms timeout so a non-responsive CAT never blocks TX
      const onSetPTT = getOnSetPTT();
      if (autoPTTOn && onSetPTT) {
        try {
          await Promise.race([
            onSetPTT(true),
            new Promise<void>((_, reject) => setTimeout(() => reject(new Error('PTT timeout')), 500)),
          ]);
        } catch { /* CAT not connected or timed out */ }
      }

      try {
        const ctx = await getAudioContext();
        const owned = new Float32Array(samples.length);
        owned.set(samples);
        const buf = ctx.createBuffer(1, owned.length, 12000);
        buf.copyToChannel(owned, 0);

        await new Promise<void>(resolve => {
          const src = ctx.createBufferSource();
          src.buffer = buf;
          src.connect(gainNode ?? ctx.destination);
          if (txTap) src.connect(txTap);
          src.onended = () => resolve();
          src.start(ctx.currentTime);
        });
      } catch (err) {
        setState(prev => ({
          ...prev,
          error: err instanceof Error ? err.message : 'Audio playback failed',
        }));
      }

      // Auto-PTT off
      const onSetPTTOff = getOnSetPTT();
      if (autoPTTOn && onSetPTTOff) {
        try {
          await Promise.race([
            onSetPTTOff(false),
            new Promise<void>((_, reject) => setTimeout(() => reject(new Error('PTT timeout')), 500)),
          ]);
        } catch { /* CAT not connected or timed out */ }
      }

      const sent: SentEntry = {
        id: txId, message: txMessage, label: txLabel, windowStart,
        vfoHz: getVfoFrequency(), audioHz: txAudioHz,
      };
      setState(prev => ({
        ...prev, status: 'waiting',
        // Auto-CQ entries never enter the queue, so only filter for real entries
        queue: useAutoCQ ? prev.queue : prev.queue.filter(q => q.id !== txId),
        sent: dedupeAndCapSent(sent, prev.sent),
      }));
      if (!useAutoCQ) {
        queue = queue.filter(q => q.id !== txId);
      }
    }
    setState(prev => ({ ...prev, status: 'idle' }));
  }

  // Invalidate the auto-CQ cache when mode or baseFreq changes so the cached
  // waveform stays current. The original synced this via per-param
  // useEffects on the hook's `mode`/`baseFrequency` args; here the calling
  // component drives it explicitly (see syncParams()) since this factory has
  // no dependency tracking of its own on the getter functions.
  let lastSyncedMode = getMode();
  let lastSyncedFreq = getBaseFrequency();
  function syncParams() {
    const mode = getMode();
    const freq = getBaseFrequency();
    const modeChanged = mode !== lastSyncedMode;
    const freqChanged = freq !== lastSyncedFreq;
    if (modeChanged || freqChanged) {
      lastSyncedMode = mode;
      lastSyncedFreq = freq;
      if (autoCQMessage) rebuildAutoCQCache(autoCQMessage);
      // Queued entries were encoded with the params captured at enqueue time —
      // a later Audio Hz (or mode) change must re-encode them, or they'd still
      // transmit on the old frequency. Entries with a pinned per-conversation
      // audioHz don't follow the global Audio Hz, so a freq-only change leaves
      // them alone; a mode change invalidates everything. Mark stale entries
      // pending first so the TX loop can't send old samples mid-re-encode;
      // the encode worker is FIFO, so a re-encode's result always lands after
      // any in-flight first encode for the same entry.
      const stale = queue.filter(e => modeChanged || e.audioHz === undefined);
      if (stale.length > 0) {
        const staleIds = new Set(stale.map(e => e.id));
        setState(prev => {
          const q = prev.queue.map(e =>
            staleIds.has(e.id) ? { ...e, samples: null, encodeStatus: 'pending' as const } : e
          );
          queue = q;
          return { ...prev, queue: q };
        });
        for (const e of queue) if (staleIds.has(e.id)) startEncode(e);
      }
    }
  }

  // ── Public API ────────────────────────────────────────────────────────────

  async function start() {
    if (isRunning) return;
    if (!FT_SUPPORTED[getMode()]) return;
    if (!audioCtx || audioCtx.state === 'closed') {
      audioCtx = new AudioContext();
      gainNode = audioCtx.createGain();
      gainNode.gain.value = gain;
      gainNode.connect(audioCtx.destination);

      // Ring-buffer tap for the global "Rec" feature. Each playback source
      // also connects to this node (pre-gain, so the recording level doesn't
      // depend on the TX gain setting); its own output stays silent — the
      // zeroed output buffer is never written, the destination link only
      // keeps the node pulled so it records real-time silence between
      // transmissions and the ring reflects the true output timeline.
      const ctx = audioCtx;
      const tap = ctx.createScriptProcessor(4096, 1, 1);
      tap.onaudioprocess = (e) => {
        audioRecorder.write('output', e.inputBuffer.getChannelData(0), ctx.sampleRate);
      };
      tap.connect(ctx.destination);
      txTap = tap;
    }
    if (audioCtx.state === 'suspended') {
      await audioCtx.resume();
    }
    isRunning = true;
    runLoop();
  }

  function stop() {
    isRunning = false;
    clearTimers();
    if (txTap) {
      txTap.onaudioprocess = null;
      txTap.disconnect();
      txTap = null;
    }
    audioCtx?.close().catch(() => null);
    audioCtx = null;
    if (autoPTTOn) {
      getOnSetPTT()?.(false).catch(() => null);
    }
  }

  function enqueue(entry: Omit<TxQueueEntry, 'samples' | 'encodeStatus'>) {
    const full: TxQueueEntry = { ...entry, samples: null, encodeStatus: 'pending' };
    startEncode(full);
    setState(prev => {
      const q = [...prev.queue, full];
      queue = q;
      return { ...prev, queue: q };
    });
  }

  // Prepend to queue — for auto-reply so it plays before other queued entries
  function enqueueFirst(entry: Omit<TxQueueEntry, 'samples' | 'encodeStatus'>) {
    const full: TxQueueEntry = { ...entry, samples: null, encodeStatus: 'pending' };
    startEncode(full);
    setState(prev => {
      const q = [full, ...prev.queue];
      queue = q;
      return { ...prev, queue: q };
    });
  }

  function dequeue(id: string) {
    setState(prev => {
      const q = prev.queue.filter(e => e.id !== id);
      queue = q;
      return { ...prev, queue: q };
    });
  }

  function moveUp(id: string) {
    setState(prev => {
      const idx = prev.queue.findIndex(e => e.id === id);
      if (idx <= 0) return prev;
      const q = [...prev.queue];
      [q[idx - 1], q[idx]] = [q[idx], q[idx - 1]];
      queue = q;
      return { ...prev, queue: q };
    });
  }

  function setAutoCQ(v: boolean) {
    autoCQOn = v;
    saveAutoCQ(v);
    // Reset the cooldown on enable so the first CQ fires on the next eligible
    // window instead of waiting out a stale interval from a previous session.
    if (v) lastAutoCQAtMs = 0;
    setState(prev => ({ ...prev, autoCQ: v }));
  }

  function setAutoCQIntervalMin(v: number) {
    const clamped = Math.max(1, Math.min(60, Math.round(v)));
    autoCQIntervalMin = clamped;
    saveAutoCQIntervalMin(clamped);
    setState(prev => ({ ...prev, autoCQIntervalMin: clamped }));
  }

  function setAutoCQMessage(msg: string) {
    autoCQMessage = msg;
    rebuildAutoCQCache(msg);
  }

  function setOutputDevice(deviceId: string) {
    outputDevice = deviceId;
    saveOutputDevice(deviceId);
    setState(prev => ({ ...prev, outputDeviceId: deviceId }));
  }

  function setTxGain(v: number) {
    gain = v;
    if (gainNode) gainNode.gain.value = v;
    saveTxGain(v);
    setState(prev => ({ ...prev, txGain: v }));
  }

  function setAutoPTT(v: boolean) {
    autoPTTOn = v;
    saveAutoPTT(v);
    setState(prev => ({ ...prev, autoPTT: v }));
  }

  function setAllowConsecutiveTx(v: boolean) {
    allowConsecutiveTx = v;
    saveAllowConsecutiveTx(v);
    setState(prev => ({ ...prev, allowConsecutiveTx: v }));
  }

  function clearSent() {
    setState(prev => ({ ...prev, sent: [] }));
  }

  function destroy() {
    stop();
  }

  return {
    state,
    start,
    stop,
    enqueue,
    enqueueFirst,
    dequeue,
    moveUp,
    setAutoCQ,
    setAutoCQIntervalMin,
    setAutoCQMessage,
    setOutputDevice,
    setTxGain,
    setAutoPTT,
    setAllowConsecutiveTx,
    clearSent,
    syncParams,
    destroy,
    get isRunning() { return isRunning; },
  };
}

export type FTTransmit = ReturnType<typeof createFTTransmit>;
