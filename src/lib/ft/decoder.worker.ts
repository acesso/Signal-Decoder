/**
 * FT8/FT4 decoder worker — backed by the native C ft8_lib compiled to WASM.
 *
 * The WASM module (public/wasm/ft8.wasm + ft8.js glue) is loaded at worker
 * startup via importScripts so the first decode request is not blocked.
 *
 * The callsign hash table lives inside the WASM module (ft8_init called once),
 * mirroring the old @e04/ft8ts HashCallBook lifetime across decode windows.
 */

import type { FTMode } from './decoder';

export interface WorkerRequest {
  id: number;
  samples: Float32Array;
  sampleRate: number;
  mode: FTMode;
}

export interface WorkerResponse {
  id: number;
  messages: Array<{ freq: number; dt: number; snr: number; msg: string; sync: number }>;
  error?: string;
}

// ── WASM public-asset URL helper ────────────────────────────────────────────
// Worker chunks are served from /_next/static/chunks/… (or /<basePath>/_next/…
// on GitHub Pages). Public assets live at origin root (+ optional basePath).
// We recover basePath by slicing off the /_next/… suffix from the worker URL.
function getPublicBase(): string {
  const { origin, pathname } = self.location;
  const nextIdx = pathname.indexOf('/_next/');
  return origin + (nextIdx > 0 ? pathname.slice(0, nextIdx) : '');
}

// ── Module types ─────────────────────────────────────────────────────────────
interface FT8Module {
  _ft8_init: () => void;
  _ft8_decode: (ptr: number, len: number, sr: number, isFT4: number) => number;
  _malloc: (size: number) => number;
  _free: (ptr: number) => void;
  HEAPF32: Float32Array;
  UTF8ToString: (ptr: number) => string;
}

// ── Module bootstrap ─────────────────────────────────────────────────────────
let moduleReady: Promise<FT8Module> | null = null;

function loadModule(): Promise<FT8Module> {
  if (moduleReady) return moduleReady;
  moduleReady = (async (): Promise<FT8Module> => {
    const base = getPublicBase();
    const wasmUrl = `${base}/wasm/ft8.wasm`;
    const jsUrl   = `${base}/wasm/ft8.js`;

    const wasmBinary: ArrayBuffer = await fetch(wasmUrl).then(r => {
      if (!r.ok) throw new Error(`WASM fetch ${r.status}: ${wasmUrl}`);
      return r.arrayBuffer();
    });

    (self as unknown as Record<string, (...a: string[]) => void>).importScripts(jsUrl);

    const createFT8Module = (self as unknown as Record<string, unknown>).createFT8Module as
      (opts: object) => Promise<FT8Module>;

    if (typeof createFT8Module !== 'function') {
      throw new Error('createFT8Module not found after importScripts');
    }

    const mod: FT8Module = await createFT8Module({
      wasmBinary,
      print:    () => {},
      printErr: () => {},
    });

    mod._ft8_init();
    return mod;
  })();

  // If load fails, clear the cached promise so the next request retries
  moduleReady.catch(() => { moduleReady = null; });

  return moduleReady;
}

// Pre-load the module so it is warm before the first 15-second window closes.
loadModule().catch(err => {
  console.error('[ft8 worker] WASM load failed:', err);
});

// ── Decode request handler ───────────────────────────────────────────────────
self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const { id, samples, sampleRate, mode } = e.data;
  try {
    const mod = await loadModule();

    const byteLen = samples.length * 4;
    const ptr = mod._malloc(byteLen);
    if (!ptr) throw new Error('WASM malloc returned null');

    try {
      mod.HEAPF32.set(samples, ptr >> 2);
      const isFT4   = mode === 'FT4' ? 1 : 0;
      const jsonPtr = mod._ft8_decode(ptr, samples.length, sampleRate, isFT4);
      const json    = mod.UTF8ToString(jsonPtr);
      const messages: WorkerResponse['messages'] = JSON.parse(json);
      self.postMessage({ id, messages } satisfies WorkerResponse);
    } finally {
      mod._free(ptr);
    }
  } catch (err) {
    self.postMessage({
      id,
      messages: [],
      error: err instanceof Error ? err.message : String(err),
    } satisfies WorkerResponse);
  }
};
