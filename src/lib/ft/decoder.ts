export type FTMode = 'FT8' | 'FT4' | 'FT2';

export interface FTMessage {
  freq: number;
  dt: number;
  snr: number;
  msg: string;
  sync: number;
  /** subtraction pass that produced this decode (ft8mon engine only) */
  pass?: number;
  /**
   * Decode method (ft8mon engine only): -1/undefined = clean LDPC decode;
   * >=0 = OSD "best guess" fallback at this search depth — prone to false
   * positives on marginal signals. FT4/ft8_lib never sets it: that engine
   * only emits zero-error CRC-verified decodes.
   */
  osd?: number;
}

/** True when a decode came from the OSD fallback rather than clean LDPC. */
export function isLowConfidence(m: FTMessage): boolean {
  return (m.osd ?? -1) >= 0;
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
  /** Messages decoded so far on THIS request (one WASM call — one slice
   *  when frequency-slicing is active). Summed across all pending requests
   *  for the live "decoded so far" counter — see decodedSoFar() below. */
  decoded: number;
}>();

// Separate from `pending` (decode requests) since resample requests have a
// different response shape and no slice/progress/stats bookkeeping at all —
// just "give me the resampled buffer back".
const pendingResample = new Map<number, { resolve: (samples: Float32Array) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }>();

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
// Recorded once per LOGICAL window (by decodeFTAudio, after any frequency-
// slice fan-out is merged) — never per-slice, or the average would look like
// ~1/poolSize of the true messages-per-window.
const recentDecodes: Array<{ msgs: number; lastMsgS: number }> = [];
let currentLastMsgS = 0;

function pushRecentDecode(msgCount: number) {
  recentDecodes.push({ msgs: msgCount, lastMsgS: currentLastMsgS });
  if (recentDecodes.length > 10) recentDecodes.shift();
  currentLastMsgS = 0; // reset once per logical window, not per slice
}

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

// Sum of "decoded so far" across every pending request — with frequency-slice
// fan-out, one logical window is N concurrent requests (one per slice), each
// only ever seeing its own slice's count. A single scalar overwritten by
// whichever slice's progress message arrives last would show ~1/N of the
// true live count, so this sums every in-flight slice's contribution instead.
function totalDecodedSoFar(): number {
  let total = 0;
  for (const entry of pending.values()) total += entry.decoded;
  return total;
}

function notifyActivity() {
  if (pending.size === 0) oldestDecodeStart = null;
  const activity: FTDecoderActivity = { inFlight: pending.size, startedAt: oldestDecodeStart, decodedSoFar: totalDecodedSoFar() };
  for (const cb of activityListeners) cb(activity);
}

export function subscribeDecoderActivity(cb: ActivityListener): () => void {
  activityListeners.add(cb);
  cb({ inFlight: pending.size, startedAt: oldestDecodeStart, decodedSoFar: totalDecodedSoFar() });
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
      | { type: 'ready'; engines: string[] }
      | { type: 'resampled'; id: number; samples: Float32Array };

    if (data.type === 'ready') {
      for (const eng of data.engines) readyEngines.add(eng);
      lastStatus = { engines: [...readyEngines], generation };
      for (const cb of statusListeners) cb(lastStatus);
      return;
    }

    if (data.type === 'resampled') {
      const req = pendingResample.get(data.id);
      if (req) {
        clearTimeout(req.timer);
        pendingResample.delete(data.id);
        req.resolve(data.samples);
      }
      return;
    }

    if (data.type === 'progress') {
      const req = pending.get(data.id);
      if (req) req.decoded = data.decoded; // this request's own slice count only
      if (oldestDecodeStart !== null) {
        currentLastMsgS = (Date.now() - oldestDecodeStart) / 1000;
      }
      req?.onPartial?.(data.message);
      notifyActivity(); // recomputes the summed decodedSoFar across all pending requests
      return;
    }

    const entry = pending.get(data.id);
    slot.inFlight = Math.max(0, slot.inFlight - 1);
    if (data.stats) {
      // NOTE: recentDecodes/tuningStats bookkeeping intentionally does NOT
      // happen here. With frequency-slice fan-out (multiple slots decoding
      // sub-bands of the SAME window), this fires once per SLICE, not once
      // per logical window — pushing per-slice message counts would make the
      // rolling "avg messages/window" look like ~1/N of reality. That
      // bookkeeping instead happens once per logical window in
      // decodeFTAudio, after slice results are merged.
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
  /** Full per-slice decode output (dev-only) — lets external drivers inspect
   *  actual message text/freq/dt for dedup verification, not just counts. */
  messages: FTMessage[];
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

// Dispatches ONE decode request to a specific slot and resolves with its
// messages. Shared by both the plain single-slot path (FT4/FT2, or FT8 with
// poolSize 1) and each fan-out branch of the frequency-slice path below.
function dispatchToSlot(
  slotIndex: number,
  slots: PoolSlot[],
  samples: Float32Array,
  sampleRate: number,
  mode: FTMode,
  onPartial: ((msg: FTMessage) => void) | undefined,
  hzRange: { min: number; max: number } | undefined,
  transferBuffer: boolean,
): Promise<FTMessage[]> {
  const id = nextId++;
  const slot = slots[slotIndex];
  const dispatchedAt = DEV_TELEMETRY ? performance.now() : 0;

  return new Promise(resolve => {
    const wrappedResolve = (messages: FTMessage[]) => {
      if (DEV_TELEMETRY) {
        decodeLog.push({ id, slot: slotIndex, dispatchedAt, resolvedAt: performance.now(), msgCount: messages.length, messages });
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

    pending.set(id, { resolve: wrappedResolve, timer, onPartial, slot: slotIndex, decoded: 0 });
    if (oldestDecodeStart === null) oldestDecodeStart = Date.now();
    slot.inFlight++;
    slot.worker.postMessage(
      { type: 'decode', id, samples, sampleRate, mode, hzRange },
      transferBuffer ? [samples.buffer] : [],
    );
    notifyActivity();
  });
}

// Slices [minHz, maxHz] into `n` sub-bands with a fixed overlap margin at
// each INTERNAL boundary only (not the outer edges) — a signal whose tone
// lands right at a cut would otherwise be missed by both neighbors' internal
// windowing. Margin is generous relative to FT8's ~50Hz tone spacing.
const SLICE_OVERLAP_HZ = 100;

function sliceHzRange(minHz: number, maxHz: number, n: number): Array<{ min: number; max: number }> {
  const width = (maxHz - minHz) / n;
  return Array.from({ length: n }, (_, i) => ({
    min: i === 0 ? minHz : minHz + i * width - SLICE_OVERLAP_HZ,
    max: i === n - 1 ? maxHz : minHz + (i + 1) * width + SLICE_OVERLAP_HZ,
  }));
}

// ft8mon's fixed internal decode rate (see ft8mon_wasm.cc's DECODE_RATE) —
// every _ftm_decode() call resamples its input to this rate before decoding.
const FT8MON_DECODE_RATE = 12000;

// Resamples ONCE, in a worker, before frequency-slice fan-out sends the same
// resampled audio to every slice — otherwise N slices would each redundantly
// resample the identical full-length window inside their own WASM call.
// This used to run synchronously on the MAIN thread: a plain linear-
// interpolation loop over a full 15s/48kHz window (~720k samples) is cheap
// on paper (a few ms) but landed squarely in visible-stutter territory on
// real hardware — confirmed by the user seeing a UI hitch at the start of
// every decode after this was added. Dispatching it to a worker (same
// pattern as decode itself) keeps that work off the thread that has to keep
// rendering, at the cost of one extra postMessage round-trip per window.
function resampleOnWorker(samples: Float32Array, sampleRate: number): Promise<Float32Array> {
  if (sampleRate === FT8MON_DECODE_RATE) return Promise.resolve(samples);
  const slots = ensurePool();
  const slot = slots[0]; // any slot works — this is a stateless, engine-independent request
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingResample.delete(id);
      // The buffer was TRANSFERRED to the worker on postMessage below — it's
      // detached on this side regardless of whether the worker ever replies,
      // so there is no original buffer left to fall back to on timeout.
      reject(new Error('resample timed out'));
    }, DECODE_TIMEOUT_MS);
    pendingResample.set(id, { resolve, reject, timer });
    slot.worker.postMessage({ type: 'resample', id, samples, sampleRate }, [samples.buffer]);
  });
}

// A signal sitting in a slice's overlap zone gets searched independently by
// two neighboring workers. When it's clean, both find the identical message
// text and the exact-text dedup below is enough. When it's weak/marginal,
// OSD (the "best guess" fallback LDPC uses for signals with too many raw bit
// errors — see osd_ldpc_thresh in ft8.cc) can have each worker's independent
// search converge on a DIFFERENT plausible-but-wrong decode of the same
// underlying noise: same rough frequency and timing, different text. Exact-
// text dedup can't catch that, so anything surviving it is also clustered by
// (freq, dt) proximity — two decodes this close together are almost
// certainly the same physical signal, not two coincidentally-adjacent real
// ones (FT8's own tone spacing and timing precision make that vanishingly
// unlikely within these tolerances).
const DEDUP_FREQ_HZ = 10; // ~1.5x FT8 tone spacing (6.25 Hz)
const DEDUP_DT_SEC  = 0.1;

// Higher correct_bits (LDPC parity bits verified, out of 83 — see `sync` in
// FTMessage) is a much stronger "trust this decode" signal than SNR, which
// only measures audio power and says nothing about decode correctness.
function isBetterDecode(a: FTMessage, b: FTMessage): boolean {
  // A clean LDPC decode always beats an OSD "best guess" of the same signal,
  // regardless of the post-decode correct_bits count (which stays high even
  // for wrong OSD output).
  if (isLowConfidence(a) !== isLowConfidence(b)) return !isLowConfidence(a);
  if (a.sync !== b.sync) return a.sync > b.sync;
  return a.snr > b.snr;
}

// Merges results from N frequency-slice sub-decodes of the SAME window.
function mergeSliceResults(all: FTMessage[][]): FTMessage[] {
  // Pass 1: exact-text dedup (mirrors ft8mon's own internal cross-pass dedup
  // in ft8mon_wasm.cc's `seen` set) — the common case when a boundary signal
  // decodes identically on both sides.
  const byMsg = new Map<string, FTMessage>();
  for (const messages of all) {
    for (const m of messages) {
      const existing = byMsg.get(m.msg);
      if (!existing || isBetterDecode(m, existing)) byMsg.set(m.msg, m);
    }
  }

  // Pass 2: cluster the survivors by (freq, dt) proximity — catches the same
  // physical signal decoded to DIFFERENT text by neighboring slices' OSD.
  const candidates = [...byMsg.values()];
  const kept: FTMessage[] = [];
  for (const m of candidates) {
    const clusterIdx = kept.findIndex(k =>
      Math.abs(k.freq - m.freq) <= DEDUP_FREQ_HZ && Math.abs(k.dt - m.dt) <= DEDUP_DT_SEC);
    if (clusterIdx === -1) {
      kept.push(m);
    } else if (isBetterDecode(m, kept[clusterIdx])) {
      kept[clusterIdx] = m;
    }
  }
  return kept;
}

export async function decodeFTAudio(
  samples: Float32Array,
  sampleRate: number,
  mode: FTMode,
  /** called per message as the decoder finds it (ft8mon/FT8 only), before the final list resolves */
  onPartial?: (msg: FTMessage) => void,
): Promise<FTMessage[]> {
  if (!FT_SUPPORTED[mode]) return [];

  const slots = ensurePool();

  // Frequency-slice parallel decode: FT8/ft8mon only. ft8_lib (FT4's engine)
  // is single-pass with no interference-subtraction loop to parallelize —
  // splitting it would add complexity for zero benefit (confirmed against
  // ft8_lib's source: no thread/candidate-independent structure to exploit).
  if (mode === 'FT8' && slots.length > 1) {
    const ranges = sliceHzRange(currentParams.minHz, currentParams.maxHz, slots.length);
    // Dedup live partials across slices the same way the final merge does —
    // a message decoded by two overlapping slices should only stream once.
    const seenPartials = new Set<string>();
    const onSlicePartial = onPartial && ((msg: FTMessage) => {
      if (seenPartials.has(msg.msg)) return;
      seenPartials.add(msg.msg);
      onPartial(msg);
    });
    // Resample once here instead of once per slice — every slice would
    // otherwise redundantly resample the identical full-length audio inside
    // its own WASM call. Smaller buffer too: mic rate is typically 48kHz,
    // so this also shrinks what gets copied to each slot below. Runs in a
    // worker (see resampleOnWorker) — a synchronous main-thread version of
    // this used to visibly stutter the UI.
    let resampled: Float32Array;
    try {
      resampled = await resampleOnWorker(samples, sampleRate);
    } catch {
      return []; // resample failed/timed out — treat this window as a lost decode, same as any other failure
    }

    // Each slice needs its OWN copy of the samples (all slices scan the same
    // full-length window; only the Hz range differs — see the ftm_decode
    // comment on why the whole window is needed, not a time-trimmed slice).
    // Only the LAST dispatch can transfer (zero-copy); the rest must copy,
    // since transferring detaches the buffer after the first postMessage.
    const perSlice = ranges.map((hzRange, i) =>
      dispatchToSlot(
        i, slots,
        i === ranges.length - 1 ? resampled : resampled.slice(),
        FT8MON_DECODE_RATE, mode, onSlicePartial, hzRange,
        i === ranges.length - 1,
      ));
    const results = await Promise.all(perSlice);
    const merged = mergeSliceResults(results);
    pushRecentDecode(merged.length);
    return merged;
  }

  // Round-robin by a stable counter, not "least busy" — see the comment
  // above the pool declaration for why (reproducible hash-table locality
  // per slot across comparable runs).
  const slotIndex = nextSlot % slots.length;
  nextSlot++;
  const messages = await dispatchToSlot(slotIndex, slots, samples, sampleRate, mode, onPartial, undefined, true);
  if (mode === 'FT8') pushRecentDecode(messages.length);
  return messages;
}
