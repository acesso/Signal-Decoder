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
  /** union of engines that finished loading across every pool slot */
  engines: string[];
  /** increments every time the whole pool (and WASM) is respawned */
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

// ── Worker pool ───────────────────────────────────────────────────────────────
// One decode window used to mean one postMessage to a single shared worker —
// if window N's decode (budget up to ~12s) was still running when window N+1
// finished capturing (every 7.5s on FT4), N+1 queued behind it on that
// worker's single JS thread, backlogging decodes even though the machine had
// idle cores. Each pool slot is a fully independent Worker + WASM instance
// (no SharedArrayBuffer/pthreads — GitHub Pages can't serve the COOP/COEP
// headers those need), so up to POOL_SIZE windows now decode concurrently.
//
// Trade-off: ft8mon's callsign hash tables (unpack.cc) persist for the life
// of a WASM instance and help resolve hashed-callsign references (e.g. a
// station replying with just a hash of a call seen earlier) — spreading
// windows across N instances means each one only sees ~1/N of the traffic,
// diluting that cache. Windows are assigned round-robin by a stable counter
// (not "least busy") specifically so the same physical decode load pattern
// is reproducible across runs for comparison, and so a given slot's hash
// table fills predictably rather than depending on timing jitter.
//
// A misbehaving decode only tears down and respawns ITS OWN slot — the old
// single-worker code reset with rejectAll() on any timeout/error, needlessly
// discarding every other in-flight window along with it.

const DECODE_TIMEOUT_MS = 45_000; // FT8 window is 15s; ft8mon budget can reach ~15s

function defaultPoolSize(): number {
  if (typeof navigator === 'undefined') return 1;
  const cores = navigator.hardwareConcurrency || 4;
  // Leave a core for the main thread (UI, audio capture) and don't bother
  // pooling on genuinely single/dual-core machines.
  return Math.max(1, Math.min(4, cores - 1));
}

interface PoolSlot {
  worker: Worker;
  /** requests currently in flight on this slot — used only for stats/UI, not routing */
  inFlight: number;
}

let pool: PoolSlot[] = [];
let poolSize = defaultPoolSize();
let nextSlot = 0; // round-robin cursor
let nextId = 0;
let generation = 0;
const pending = new Map<number, {
  resolve: (msgs: FTMessage[]) => void;
  timer: ReturnType<typeof setTimeout>;
  onPartial?: (msg: FTMessage) => void;
  slot: number;
}>();

/** Set how many parallel decoder workers to run. Takes effect on next spawn
 *  (call reloadDecoder() to apply immediately). 1 = old single-worker behavior. */
export function setDecoderPoolSize(n: number): void {
  poolSize = Math.max(1, Math.min(8, Math.round(n)));
}

export function getDecoderPoolSize(): number {
  return poolSize;
}

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

/** Update decoder tuning; takes effect on the next decode window on every slot. */
export function setDecoderParams(patch: Partial<FTDecoderParams>): void {
  currentParams = { ...currentParams, ...patch };
  for (const slot of pool) slot.worker.postMessage({ type: 'params', params: currentParams });
}

/** Tear down the whole pool and its WASM instances; the next decode spawns fresh. */
export function reloadDecoder(): void {
  rejectAll('manual reload');
  spawnPool(); // terminates the old pool, loads WASM anew in every slot
}

/** Spawn the pool (and start WASM loads in every slot) without waiting for a decode. */
export function ensureDecoderReady(): void {
  ensurePool();
}

function rejectAll(reason: string) {
  for (const { resolve, timer } of pending.values()) {
    clearTimeout(timer);
    resolve([]); // resolve with empty rather than reject — callers just get no messages
  }
  pending.clear();
  notifyActivity();
  console.warn('[ft8 decoder] pool reset:', reason);
}

// Engines seen ready across all slots so far this generation (union — a
// decode can land on any slot, so the UI should show what's available
// anywhere in the pool, not just slot 0's status).
let readyEngines = new Set<string>();

function attachSlot(slotIndex: number): PoolSlot {
  const w = new Worker(new URL('./decoder.worker.ts', import.meta.url));
  const slot: PoolSlot = { worker: w, inFlight: 0 };

  w.onmessage = (e: MessageEvent) => {
    const data = e.data as
      | { type: 'result'; id: number; messages: FTMessage[]; stats: Omit<FTDecoderStats, 'at' | 'avgMsgs' | 'suggestedBudgetSec'>; error?: string }
      | { type: 'progress'; id: number; decoded: number; message: FTMessage }
      | { type: 'ready'; engines: string[] };

    if (data.type === 'ready') {
      for (const eng of data.engines) readyEngines.add(eng);
      lastStatus = { engines: [...readyEngines], generation };
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
    slot.inFlight = Math.max(0, slot.inFlight - 1);
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

  w.onerror = (err) => respawnSlot(slotIndex, `error: ${err.message}`);

  w.postMessage({ type: 'params', params: currentParams });
  return slot;
}

// Scoped to one slot only — reject just the requests routed there and
// replace that slot's worker. The old single-worker code nuked every
// in-flight decode on any error or timeout, which meant one bad window
// could cost you several others that had nothing to do with it.
function respawnSlot(slotIndex: number, reason: string) {
  console.warn(`[ft8 decoder] slot ${slotIndex} ${reason} — respawning`);
  for (const [id, entry] of pending) {
    if (entry.slot !== slotIndex) continue;
    clearTimeout(entry.timer);
    entry.resolve([]);
    pending.delete(id);
  }
  notifyActivity();
  const fresh = attachSlot(slotIndex);
  if (pool[slotIndex]) pool[slotIndex] = fresh;
}

function spawnPool(): PoolSlot[] {
  for (const slot of pool) {
    slot.worker.onmessage = null;
    slot.worker.onerror   = null;
    try { slot.worker.terminate(); } catch { /* ignore */ }
  }
  generation += 1;
  readyEngines = new Set();
  lastStatus = { engines: [], generation };
  for (const cb of statusListeners) cb(lastStatus);

  pool = Array.from({ length: poolSize }, (_, i) => attachSlot(i));
  return pool;
}

function ensurePool(): PoolSlot[] {
  return pool.length > 0 ? pool : spawnPool();
}

// Dev-only rolling log of real decode calls, keyed by (id, slot, timing) —
// lets an external driver (Playwright perf comparison) read exactly when
// each window was dispatched/finished and on which slot, without needing
// React state or a mounted component. Tree-shaken out of production builds
// (same guard as __ftInjectWindow); populated from inside decodeFTAudio
// itself so it captures every real call, not just ones routed through a
// separate debug entry point.
interface DecodeLogEntry {
  id: number;
  slot: number;
  dispatchedAt: number;
  resolvedAt: number;
  msgCount: number;
}
const decodeLog: DecodeLogEntry[] = [];
const DEV_TELEMETRY = process.env.NODE_ENV === 'development' && typeof window !== 'undefined';
if (DEV_TELEMETRY) {
  (window as unknown as Record<string, unknown>).__ftDecodePoolDebug = {
    setPoolSize: setDecoderPoolSize,
    getPoolSize: getDecoderPoolSize,
    reload: reloadDecoder,
    getLog: () => decodeLog.slice(),
    clearLog: () => { decodeLog.length = 0; },
  };
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
  const slots = ensurePool();
  // Round-robin by a stable counter, not "least busy" — see the comment
  // above the pool declaration for why (reproducible hash-table locality
  // per slot across comparable runs).
  const slotIndex = nextSlot % slots.length;
  nextSlot++;
  const slot = slots[slotIndex];
  const dispatchedAt = DEV_TELEMETRY ? performance.now() : 0;

  return new Promise(resolve => {
    const wrappedResolve = (messages: FTMessage[]) => {
      if (DEV_TELEMETRY) {
        decodeLog.push({ id, slot: slotIndex, dispatchedAt, resolvedAt: performance.now(), msgCount: messages.length });
      }
      resolve(messages);
    };

    const timer = setTimeout(() => {
      if (!pending.has(id)) return;
      pending.delete(id);
      wrappedResolve([]);
      notifyActivity();
      respawnSlot(slotIndex, `request ${id} timed out`);
    }, DECODE_TIMEOUT_MS);

    pending.set(id, { resolve: wrappedResolve, timer, onPartial, slot: slotIndex });
    if (oldestDecodeStart === null) oldestDecodeStart = Date.now();
    slot.inFlight++;
    // Transfer the buffer — zero-copy, avoids serialisation overhead
    slot.worker.postMessage({ type: 'decode', id, samples, sampleRate, mode }, [samples.buffer]);
    notifyActivity();
  });
}
