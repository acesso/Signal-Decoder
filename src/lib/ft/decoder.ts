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
// Lazily created; one worker persists for the page lifetime.
let worker: Worker | null = null;
let nextId = 0;
const pending = new Map<number, (msgs: FTMessage[]) => void>();

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('./decoder.worker.ts', import.meta.url));
    worker.onmessage = (e: MessageEvent) => {
      const { id, messages } = e.data;
      pending.get(id)?.(messages);
      pending.delete(id);
    };
  }
  return worker;
}

export async function decodeFTAudio(
  samples: Float32Array,
  sampleRate: number,
  mode: FTMode,
): Promise<FTMessage[]> {
  if (!FT_SUPPORTED[mode]) return [];

  const id = nextId++;
  return new Promise(resolve => {
    pending.set(id, resolve);
    // Transfer the buffer — zero-copy, avoids serialisation overhead
    getWorker().postMessage({ id, samples, sampleRate, mode }, [samples.buffer]);
  });
}
