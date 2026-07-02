export type FTMode = 'FT8' | 'FT4' | 'FT2';

export interface FTMessage {
  freq: number;
  dt: number;
  snr: number;
  msg: string;
  sync: number;
  /** subtraction pass that produced this decode (ft8mon engine only) */
  pass?: number;
}

export interface FTDecodeResult {
  windowStart: Date;
  mode: FTMode;
  messages: FTMessage[];
  decodeMs: number;
  /** true while this window's decode is still running (messages stream in live) */
  decoding?: boolean;
}

/** Runtime-tunable ft8mon decoder parameters (FT8 mode). */
export interface FTDecoderParams {
  /** OSD search depth, 0 = OSD off, max 6 (garbage risk grows with depth) */
  osdDepth: number;
  /** LDPC belief-propagation iterations */
  ldpcIters: number;
  /** spectral-subtraction passes */
  npasses: number;
  /** min correct LDPC parity bits before OSD is attempted (0–83) */
  osdLdpcThresh: number;
  /** decode band lower bound (Hz) */
  minHz: number;
  /** decode band upper bound (Hz) */
  maxHz: number;
  /** CPU time budget per window (seconds) */
  budgetSec: number;
}

export const DEFAULT_DECODER_PARAMS: FTDecoderParams = {
  osdDepth: 2,
  ldpcIters: 25,
  npasses: 3,
  osdLdpcThresh: 70,
  minHz: 150,
  maxHz: 3100,
  budgetSec: 5,
};

/** Per-decode engine/resource stats reported by the worker. */
export interface FTDecoderStats {
  engine: 'ft8mon' | 'ft8_lib';
  decodeMs: number;
  /** reserved WASM linear memory (grows on demand, never shrinks) */
  heapBytes: number;
  /** live malloc'd bytes inside the heap — the number that actually moves */
  heapUsedBytes: number;
  windowSamples: number;
  at: number; // Date.now() when the result arrived
  /** rolling mean messages per ft8mon decode (last 10 windows), null until data */
  avgMsgs: number | null;
  /**
   * Suggested CPU budget (s): the latest message in recent windows arrived by
   * this time minus margin — budget beyond it found nothing. Null until enough data.
   */
  suggestedBudgetSec: number | null;
}

export interface FTDecoderStatus {
  /** engines that finished loading in the current worker */
  engines: string[];
  /** increments every time the worker (and WASM) is respawned */
  generation: number;
}

/** Live decode-in-flight state, for progress UI. */
export interface FTDecoderActivity {
  /** number of decode requests currently in the worker */
  inFlight: number;
  /** Date.now() when the oldest in-flight decode was posted, or null */
  startedAt: number | null;
  /** messages decoded so far in the current in-flight decode (live) */
  decodedSoFar: number;
}

export const FT_WINDOW_SECONDS: Record<FTMode, number> = {
  FT8: 15,
  FT4: 7.5,
  FT2: 3.75,
};

export const FT_SUPPORTED: Record<FTMode, boolean> = {
  FT8: true,
  FT4: true,
  FT2: false,
};

// ── Worker-backed decoder ─────────────────────────────────────────────────────
// Lazily created. If the worker crashes or a request times out the worker is
// replaced automatically so subsequent decode windows recover without a reload.

const DECODE_TIMEOUT_MS = 45_000; // FT8 window is 15s; ft8mon budget can reach ~15s

let worker: Worker | null = null;
let nextId = 0;
let generation = 0;
const pending = new Map<number, {
  resolve: (msgs: FTMessage[]) => void;
  timer: ReturnType<typeof setTimeout>;
  onPartial?: (msg: FTMessage) => void;
}>();

// ── rolling tuning stats (ft8mon decodes only) ───────────────────────────────
// lastMsgS: seconds into the decode when its final message appeared — the
// budget beyond that point found nothing, which is what the suggestion uses.
const recentDecodes: Array<{ msgs: number; lastMsgS: number }> = [];
let currentLastMsgS = 0;

function tuningStats(): { avgMsgs: number | null; suggestedBudgetSec: number | null } {
  if (recentDecodes.length === 0) return { avgMsgs: null, suggestedBudgetSec: null };
  const avgMsgs = recentDecodes.reduce((s, d) => s + d.msgs, 0) / recentDecodes.length;
  const withMsgs = recentDecodes.filter(d => d.msgs > 0);
  let suggestedBudgetSec: number | null = null;
  if (withMsgs.length >= 3) {
    const worstLast = Math.max(...withMsgs.map(d => d.lastMsgS));
    // half-second headroom, snapped to the slider's 0.5 s step
    suggestedBudgetSec = Math.min(12, Math.max(1, Math.ceil((worstLast + 0.5) * 2) / 2));
  }
  return { avgMsgs, suggestedBudgetSec };
}

let currentParams: FTDecoderParams = { ...DEFAULT_DECODER_PARAMS };

// ── stats / status subscriptions (UI monitoring panel) ────────────────────────
type StatsListener  = (stats: FTDecoderStats) => void;
type StatusListener = (status: FTDecoderStatus) => void;
const statsListeners  = new Set<StatsListener>();
const statusListeners = new Set<StatusListener>();
let lastStats: FTDecoderStats | null = null;
let lastStatus: FTDecoderStatus = { engines: [], generation: 0 };

export function subscribeDecoderStats(cb: StatsListener): () => void {
  statsListeners.add(cb);
  if (lastStats) cb(lastStats);
  return () => { statsListeners.delete(cb); };
}

export function subscribeDecoderStatus(cb: StatusListener): () => void {
  statusListeners.add(cb);
  cb(lastStatus);
  return () => { statusListeners.delete(cb); };
}

// ── decode-activity subscription (in-flight progress UI) ─────────────────────
type ActivityListener = (activity: FTDecoderActivity) => void;
const activityListeners = new Set<ActivityListener>();
let oldestDecodeStart: number | null = null;
let decodedSoFar = 0;

function notifyActivity() {
  if (pending.size === 0) { oldestDecodeStart = null; decodedSoFar = 0; }
  const activity: FTDecoderActivity = { inFlight: pending.size, startedAt: oldestDecodeStart, decodedSoFar };
  for (const cb of activityListeners) cb(activity);
}

export function subscribeDecoderActivity(cb: ActivityListener): () => void {
  activityListeners.add(cb);
  cb({ inFlight: pending.size, startedAt: oldestDecodeStart, decodedSoFar });
  return () => { activityListeners.delete(cb); };
}

export function getDecoderParams(): FTDecoderParams {
  return { ...currentParams };
}

/** Update decoder tuning; takes effect on the next decode window. */
export function setDecoderParams(patch: Partial<FTDecoderParams>): void {
  currentParams = { ...currentParams, ...patch };
  worker?.postMessage({ type: 'params', params: currentParams });
}

/** Tear down the worker and its WASM instances; the next decode spawns fresh. */
export function reloadDecoder(): void {
  rejectAll('manual reload');
  spawnWorker(); // terminates the old worker, loads WASM anew
}

/** Spawn the worker (and start WASM loads) without waiting for a decode. */
export function ensureDecoderReady(): void {
  getWorker();
}

function rejectAll(reason: string) {
  for (const { resolve, timer } of pending.values()) {
    clearTimeout(timer);
    resolve([]); // resolve with empty rather than reject — callers just get no messages
  }
  pending.clear();
  notifyActivity();
  console.warn('[ft8 decoder] worker reset:', reason);
}

function spawnWorker(): Worker {
  if (worker) {
    worker.onmessage = null;
    worker.onerror   = null;
    try { worker.terminate(); } catch { /* ignore */ }
  }
  generation += 1;
  lastStatus = { engines: [], generation };
  for (const cb of statusListeners) cb(lastStatus);

  worker = new Worker(new URL('./decoder.worker.ts', import.meta.url));

  worker.onmessage = (e: MessageEvent) => {
    const data = e.data as
      | { type: 'result'; id: number; messages: FTMessage[]; stats: Omit<FTDecoderStats, 'at' | 'avgMsgs' | 'suggestedBudgetSec'>; error?: string }
      | { type: 'progress'; id: number; decoded: number; message: FTMessage }
      | { type: 'ready'; engines: string[] };

    if (data.type === 'ready') {
      lastStatus = { engines: data.engines, generation };
      for (const cb of statusListeners) cb(lastStatus);
      return;
    }

    if (data.type === 'progress') {
      decodedSoFar = data.decoded;
      if (oldestDecodeStart !== null) {
        currentLastMsgS = (Date.now() - oldestDecodeStart) / 1000;
      }
      pending.get(data.id)?.onPartial?.(data.message);
      const activity: FTDecoderActivity = { inFlight: pending.size, startedAt: oldestDecodeStart, decodedSoFar };
      for (const cb of activityListeners) cb(activity);
      return;
    }

    const entry = pending.get(data.id);
    if (data.stats) {
      if (data.stats.engine === 'ft8mon' && !data.error) {
        recentDecodes.push({ msgs: data.messages?.length ?? 0, lastMsgS: currentLastMsgS });
        if (recentDecodes.length > 10) recentDecodes.shift();
      }
      currentLastMsgS = 0;
      lastStats = { ...data.stats, at: Date.now(), ...tuningStats() };
      for (const cb of statsListeners) cb(lastStats);
    }
    if (!entry) return;
    clearTimeout(entry.timer);
    entry.resolve(data.messages ?? []);
    pending.delete(data.id);
    notifyActivity();
  };

  worker.onerror = (err) => {
    rejectAll(`worker error: ${err.message}`);
    worker = null; // next call will spawn a fresh one
  };

  // Push current tuning to the fresh worker before any decode arrives.
  worker.postMessage({ type: 'params', params: currentParams });

  return worker;
}

function getWorker(): Worker {
  return worker ?? spawnWorker();
}

export async function decodeFTAudio(
  samples: Float32Array,
  sampleRate: number,
  mode: FTMode,
  /** called per message as the decoder finds it (ft8mon/FT8 only), before the final list resolves */
  onPartial?: (msg: FTMessage) => void,
): Promise<FTMessage[]> {
  if (!FT_SUPPORTED[mode]) return [];

  const id = nextId++;
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      if (!pending.has(id)) return;
      pending.delete(id);
      resolve([]);
      notifyActivity();
      console.warn(`[ft8 decoder] request ${id} timed out — respawning worker`);
      rejectAll('timeout');
      worker = null; // force respawn on next request
    }, DECODE_TIMEOUT_MS);

    pending.set(id, { resolve, timer, onPartial });
    if (oldestDecodeStart === null) oldestDecodeStart = Date.now();
    // Transfer the buffer — zero-copy, avoids serialisation overhead
    getWorker().postMessage({ type: 'decode', id, samples, sampleRate, mode }, [samples.buffer]);
    notifyActivity();
  });
}
