/**
 * FT8/FT4 decoder worker.
 *
 * Two WASM engines:
 *   ft8mon.wasm — ft8mon (AB1HL): LDPC + OSD + multi-pass subtraction. FT8 only.
 *   ft8.wasm    — ft8_lib (kgoba): lightweight BP-only decoder. Used for FT4,
 *                 and as FT8 fallback if ft8mon fails to load.
 *
 * Each engine loads lazily on first use, not both at worker startup — a pool
 * slot decoding FT4 only ever touches ft8_lib, so it has no reason to pay
 * ft8mon's load/init cost (and vice versa for a pure-FT8 run that never hits
 * the ft8mon-failed fallback). With N pool workers this used to mean N×2 WASM
 * instances resident regardless of which mode was active. Each loader is
 * still a cached singleton promise, so mode switches or the FT8→ft8_lib
 * fallback path only pay the load cost once per worker lifetime. Callsign
 * hash tables live inside each WASM instance and persist across decode
 * windows for as long as that engine stays loaded (matching the old
 * @e04/ft8ts HashCallBook lifetime).
 *
 * Decoder params (osd_depth, budget, ...) arrive via 'params' messages and are
 * applied to ft8mon immediately if already loaded, or on its next load.
 */

import type { FTMode, FTDecoderParams } from './decoder';

export type WorkerRequest =
  | {
      type: 'decode'; id: number; samples: Float32Array; sampleRate: number; mode: FTMode;
      /** Per-call Hz sub-band override for frequency-slice parallel decoding
       *  (FT8/ft8mon only) — when present, overrides params.minHz/maxHz for
       *  just this one call without mutating the persisted tuning params. */
      hzRange?: { min: number; max: number };
    }
  | { type: 'params'; params: FTDecoderParams }
  | { type: 'resample'; id: number; samples: Float32Array; sampleRate: number };

export interface WorkerStats {
  engine: 'ft8mon' | 'ft8_lib';
  decodeMs: number;       // time spent inside the WASM decode call
  heapBytes: number;      // reserved WASM linear memory of the engine used
  heapUsedBytes: number;  // live malloc'd bytes inside that heap (mallinfo)
  windowSamples: number;
}

export type WorkerResponse =
  | { type: 'result'; id: number; messages: Array<{ freq: number; dt: number; snr: number; msg: string; sync: number; pass?: number; osd?: number }>; stats: WorkerStats; error?: string }
  | { type: 'progress'; id: number; decoded: number; message: { freq: number; dt: number; snr: number; msg: string; sync: number; pass: number; osd?: number } }
  | { type: 'ready'; engines: string[] }
  | { type: 'resampled'; id: number; samples: Float32Array };

// ── WASM public-asset URL helper ────────────────────────────────────────────
// Worker chunks are served from a bundler-specific nested path (Next.js:
// /_next/static/chunks/…, optionally under a GitHub Pages basePath; Vite:
// /assets/…, under import.meta.env.BASE_URL). Public assets (this app's
// /wasm/*) live at the site's base path, not next to the worker chunk, so we
// need to recover that base independently of where the worker itself landed.
function getPublicBase(): string {
  const viteBase = (import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL;
  if (viteBase !== undefined) return self.location.origin + viteBase.replace(/\/$/, '');
  const { origin, pathname } = self.location;
  const nextIdx = pathname.indexOf('/_next/');
  return origin + (nextIdx > 0 ? pathname.slice(0, nextIdx) : '');
}

// ── Module types ─────────────────────────────────────────────────────────────
interface FT8LibModule {
  _ft8_init: () => void;
  _ft8_heap_used: () => number;
  _ft8_decode: (ptr: number, len: number, sr: number, isFT4: number) => number;
  _malloc: (size: number) => number;
  _free: (ptr: number) => void;
  HEAPF32: Float32Array;
  HEAPU8: Uint8Array;
  UTF8ToString: (ptr: number) => string;
}

interface FT8MonModule {
  _ftm_init: () => void;
  _ftm_heap_used: () => number;
  _ftm_decode: (ptr: number, len: number, sr: number, minHz: number, maxHz: number, budgetSec: number) => number;
  _malloc: (size: number) => number;
  _free: (ptr: number) => void;
  ccall: (name: string, ret: string, argTypes: string[], args: unknown[]) => number;
  HEAPF32: Float32Array;
  HEAPU8: Uint8Array;
  UTF8ToString: (ptr: number) => string;
}

// Emscripten's non-modularized JS glue is a classic (non-ESM) UMD-style
// script — `importScripts()` (the classic-worker way to load it) is
// disallowed inside a module worker (required here since decoder.worker.ts
// itself uses `import`). Fetch the glue as text and evaluate it via the
// indirect `(0, eval)` form instead, which runs in global scope (unlike a
// direct `eval(...)` call, which would run in this function's local scope
// and leave the `createFT8MonModule`/`createFT8Module` global unassigned).
const scriptCache = new Map<string, string>();
async function loadGlobalScript(url: string): Promise<void> {
  let src = scriptCache.get(url);
  if (src === undefined) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`script fetch ${res.status}: ${url}`);
    src = await res.text();
    scriptCache.set(url, src);
  }
  (0, eval)(src);
}

// ── Module bootstrap ─────────────────────────────────────────────────────────
async function instantiate<T>(jsFile: string, wasmFile: string, factoryName: string): Promise<T> {
  const base = getPublicBase();
  const wasmBinary: ArrayBuffer = await fetch(`${base}/wasm/${wasmFile}`).then(r => {
    if (!r.ok) throw new Error(`WASM fetch ${r.status}: ${wasmFile}`);
    return r.arrayBuffer();
  });

  await loadGlobalScript(`${base}/wasm/${jsFile}`);

  const factory = (self as unknown as Record<string, unknown>)[factoryName] as
    (opts: object) => Promise<T>;
  if (typeof factory !== 'function') {
    throw new Error(`${factoryName} not found after loading ${jsFile}`);
  }

  return factory({ wasmBinary, print: () => {}, printErr: () => {} });
}

let ft8monReady: Promise<FT8MonModule> | null = null;
let ft8libReady: Promise<FT8LibModule> | null = null;

// Latest params — applied to ft8mon on load and on every 'params' message.
let params: FTDecoderParams = {
  osdDepth: 2, ldpcIters: 25, npasses: 3, osdLdpcThresh: 70,
  minHz: 150, maxHz: 3100, budgetSec: 5,
};

function applyParams(mod: FT8MonModule) {
  const map: Array<[string, number]> = [
    ['osd_depth',       params.osdDepth],
    ['ldpc_iters',      params.ldpcIters],
    ['npasses_one',     params.npasses],
    ['npasses_two',     params.npasses],
    ['osd_ldpc_thresh', params.osdLdpcThresh],
  ];
  for (const [key, val] of map) {
    mod.ccall('ftm_set', 'number', ['string', 'string'], [key, String(val)]);
  }
}

// Each loader announces its own engine as 'ready' the moment IT finishes
// loading (not both at once) — the main thread's "loading…" indicator should
// clear as soon as the engine actually needed for the current mode is up,
// not wait on an engine that mode will never touch.
function loadFt8Mon(): Promise<FT8MonModule> {
  if (ft8monReady) return ft8monReady;
  ft8monReady = (async () => {
    const mod = await instantiate<FT8MonModule>('ft8mon.js', 'ft8mon.wasm', 'createFT8MonModule');
    mod._ftm_init();
    applyParams(mod);
    self.postMessage({ type: 'ready', engines: ['ft8mon'] } satisfies WorkerResponse);
    return mod;
  })();
  ft8monReady.catch(err => {
    ft8monReady = null; // retry on next request
    console.error('[ft8 worker] ft8mon load failed:', err);
  });
  return ft8monReady;
}

function loadFt8Lib(): Promise<FT8LibModule> {
  if (ft8libReady) return ft8libReady;
  ft8libReady = (async () => {
    const mod = await instantiate<FT8LibModule>('ft8.js', 'ft8.wasm', 'createFT8Module');
    mod._ft8_init();
    self.postMessage({ type: 'ready', engines: ['ft8_lib'] } satisfies WorkerResponse);
    return mod;
  })();
  ft8libReady.catch(err => {
    ft8libReady = null;
    console.error('[ft8 worker] ft8_lib load failed:', err);
  });
  return ft8libReady;
}

// ── Decode helpers ───────────────────────────────────────────────────────────
type Messages = Extract<WorkerResponse, { type: 'result' }>['messages'];

function decodeWithFt8Mon(
  mod: FT8MonModule, samples: Float32Array, sampleRate: number, id: number,
  hzRange?: { min: number; max: number },
): Messages {
  const ptr = mod._malloc(samples.length * 4);
  if (!ptr) throw new Error('WASM malloc returned null');
  // The WASM calls self.__ftmProgress synchronously per decoded message;
  // postMessage still delivers while the decode call is blocking this thread.
  (self as unknown as Record<string, unknown>).__ftmProgress =
    (decoded: number, freq: number, dt: number, snr: number, sync: number, pass: number, msg: string, osd: number) => {
      self.postMessage({
        type: 'progress', id, decoded,
        message: { freq, dt, snr, msg, sync, pass, osd },
      } satisfies WorkerResponse);
    };
  try {
    mod.HEAPF32.set(samples, ptr >> 2);
    const minHz = hzRange?.min ?? params.minHz;
    const maxHz = hzRange?.max ?? params.maxHz;
    const jsonPtr = mod._ftm_decode(ptr, samples.length, sampleRate,
                                    minHz, maxHz, params.budgetSec);
    return JSON.parse(mod.UTF8ToString(jsonPtr));
  } finally {
    delete (self as unknown as Record<string, unknown>).__ftmProgress;
    mod._free(ptr);
  }
}

function decodeWithFt8Lib(mod: FT8LibModule, samples: Float32Array, sampleRate: number, isFT4: boolean): Messages {
  const ptr = mod._malloc(samples.length * 4);
  if (!ptr) throw new Error('WASM malloc returned null');
  try {
    mod.HEAPF32.set(samples, ptr >> 2);
    const jsonPtr = mod._ft8_decode(ptr, samples.length, sampleRate, isFT4 ? 1 : 0);
    return JSON.parse(mod.UTF8ToString(jsonPtr));
  } finally {
    mod._free(ptr);
  }
}

// ── Resample (moved off the main thread) ────────────────────────────────────
// ft8mon's fixed internal decode rate (see ft8mon_wasm.cc's DECODE_RATE).
// Mirrors resample_to_12k() in ft8mon_wasm.cc exactly (same linear-
// interpolation formula, same edge clamping). Run once, in a worker, before
// frequency-slice fan-out dispatches the same resampled audio to every
// slice — a naive main-thread loop over a full 15s/48kHz window (~720k
// samples) is expensive enough to visibly stutter the UI; doing the
// identical work here keeps that off the thread that has to keep rendering.
const FT8MON_DECODE_RATE = 12000;

function resampleTo12k(samples: Float32Array, sampleRate: number): Float32Array {
  if (sampleRate === FT8MON_DECODE_RATE) return samples;
  const inLen = samples.length;
  const nOut = Math.floor((inLen * FT8MON_DECODE_RATE) / sampleRate);
  const out = new Float32Array(nOut);
  const step = sampleRate / FT8MON_DECODE_RATE;
  for (let i = 0; i < nOut; i++) {
    const pos  = i * step;
    const idx  = Math.floor(pos);
    const frac = pos - idx;
    const s0   = samples[idx];
    const s1   = idx + 1 < inLen ? samples[idx + 1] : s0;
    out[i] = s0 + frac * (s1 - s0);
  }
  return out;
}

// ── Message handler ──────────────────────────────────────────────────────────
self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const req = e.data;

  if (req.type === 'params') {
    params = req.params;
    // Apply to the live ft8mon instance if it is (or becomes) loaded.
    ft8monReady?.then(applyParams).catch(() => {});
    return;
  }

  if (req.type === 'resample') {
    const resampled = resampleTo12k(req.samples, req.sampleRate);
    // The project's tsconfig uses lib "dom" (not "webworker"), so `self`
    // types as Window here and its postMessage overloads don't include the
    // (message, transfer[]) worker-side signature the other call sites in
    // this file happen not to need — cast to the DedicatedWorkerGlobalScope
    // shape actually in effect at runtime inside a Worker.
    (self as unknown as { postMessage(message: unknown, transfer: Transferable[]): void }).postMessage(
      { type: 'resampled', id: req.id, samples: resampled } satisfies WorkerResponse,
      [resampled.buffer],
    );
    return;
  }

  const { id, samples, sampleRate, mode, hzRange } = req;
  try {
    let engine: WorkerStats['engine'];
    let messages: Messages;
    let heapBytes: number;
    let heapUsedBytes: number;
    const t0 = performance.now();

    if (mode === 'FT8') {
      try {
        const mod = await loadFt8Mon();
        messages      = decodeWithFt8Mon(mod, samples, sampleRate, id, hzRange);
        heapBytes     = mod.HEAPU8.length;
        heapUsedBytes = mod._ftm_heap_used();
        engine        = 'ft8mon';
      } catch (monErr) {
        // ft8mon unavailable (load or decode failure) — fall back to ft8_lib
        console.warn('[ft8 worker] ft8mon failed, falling back to ft8_lib:', monErr);
        const mod = await loadFt8Lib();
        messages      = decodeWithFt8Lib(mod, samples, sampleRate, false);
        heapBytes     = mod.HEAPU8.length;
        heapUsedBytes = mod._ft8_heap_used();
        engine        = 'ft8_lib';
      }
    } else {
      const mod = await loadFt8Lib();
      messages      = decodeWithFt8Lib(mod, samples, sampleRate, mode === 'FT4');
      heapBytes     = mod.HEAPU8.length;
      heapUsedBytes = mod._ft8_heap_used();
      engine        = 'ft8_lib';
    }

    const stats: WorkerStats = {
      engine,
      decodeMs: performance.now() - t0,
      heapBytes,
      heapUsedBytes,
      windowSamples: samples.length,
    };
    self.postMessage({ type: 'result', id, messages, stats } satisfies WorkerResponse);
  } catch (err) {
    self.postMessage({
      type: 'result',
      id,
      messages: [],
      stats: { engine: 'ft8_lib', decodeMs: 0, heapBytes: 0, heapUsedBytes: 0, windowSamples: samples.length },
      error: err instanceof Error ? err.message : String(err),
    } satisfies WorkerResponse);
  }
};
