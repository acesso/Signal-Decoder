export type FTMode = 'FT8' | 'FT4' | 'FT2';

export interface FTMessage {
  freq: number;
  dt: number;
  snr: number;
  msg: string;
  sync: number;
}

export interface FTDecodeResult {
  windowStart: Date;
  mode: FTMode;
  messages: FTMessage[];
  decodeMs: number;
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

const DECODE_TIMEOUT_MS = 30_000; // FT8 window is 15s; give WASM 2x that

let worker: Worker | null = null;
let nextId = 0;
const pending = new Map<number, { resolve: (msgs: FTMessage[]) => void; timer: ReturnType<typeof setTimeout> }>();

function rejectAll(reason: string) {
  for (const { resolve, timer } of pending.values()) {
    clearTimeout(timer);
    resolve([]); // resolve with empty rather than reject — callers just get no messages
  }
  pending.clear();
  console.warn('[ft8 decoder] worker reset:', reason);
}

function spawnWorker(): Worker {
  if (worker) {
    worker.onmessage = null;
    worker.onerror   = null;
    try { worker.terminate(); } catch { /* ignore */ }
  }
  worker = new Worker(new URL('./decoder.worker.ts', import.meta.url));

  worker.onmessage = (e: MessageEvent) => {
    const { id, messages } = e.data as { id: number; messages: FTMessage[]; error?: string };
    const entry = pending.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    entry.resolve(messages ?? []);
    pending.delete(id);
  };

  worker.onerror = (err) => {
    rejectAll(`worker error: ${err.message}`);
    worker = null; // next call will spawn a fresh one
  };

  return worker;
}

function getWorker(): Worker {
  return worker ?? spawnWorker();
}

export async function decodeFTAudio(
  samples: Float32Array,
  sampleRate: number,
  mode: FTMode,
): Promise<FTMessage[]> {
  if (!FT_SUPPORTED[mode]) return [];

  const id = nextId++;
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      if (!pending.has(id)) return;
      pending.delete(id);
      resolve([]);
      console.warn(`[ft8 decoder] request ${id} timed out — respawning worker`);
      rejectAll('timeout');
      worker = null; // force respawn on next request
    }, DECODE_TIMEOUT_MS);

    pending.set(id, { resolve, timer });
    // Transfer the buffer — zero-copy, avoids serialisation overhead
    getWorker().postMessage({ id, samples, sampleRate, mode }, [samples.buffer]);
  });
}
