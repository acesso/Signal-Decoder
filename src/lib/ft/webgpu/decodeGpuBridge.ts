// Adapts gpuDecodePipeline.ts's decodeGpu() output into this app's
// FTMessage shape, and handles the 12kHz resample + WebGPU-availability
// check needed to call it from live-captured audio at the mic's native
// sample rate. This is the ONLY module the live app (processor.ts) talks
// to — keeps the GPU decode pipeline itself decoupled from the app's own
// FTMessage/FTDecodeResult types.
//
// The actual decodeGpu() call runs inside gpuDecode.worker.ts, not on this
// thread — its fine-sync bridge does real synchronous CPU work per
// candidate (~2.86s/20 candidates measured) and would freeze the page for
// the entire decode if run inline (found via live testing: capture/UI froze
// every window). One dedicated worker, spun up lazily on first use and
// reused for the session — see gpuDecode.worker.ts's module doc for why a
// single worker rather than decoder.worker.ts's pool.
import type { FTMessage } from '../decoder';
import { resampleTo12k } from '../resample';
import { unpack } from './unpack';
import { isWebGpuAvailable } from './webgpuDevice';
import type { GpuWorkerRequest, GpuWorkerResponse } from './gpuDecode.worker';

let cachedAvailable: boolean | null = null;

/** Cached WebGPU-availability check — same pattern as simdTier.ts's
 *  cached WASM-SIMD-tier probe, since navigator.gpu/requestAdapter don't
 *  change mid-session. */
export async function isGpuDecodeAvailable(): Promise<boolean> {
  if (cachedAvailable === null) cachedAvailable = await isWebGpuAvailable();
  return cachedAvailable;
}

let worker: Worker | null = null;
let nextId = 0;
const pending = new Map<number, { resolve: (r: GpuWorkerResponse) => void }>();
// The worker serializes decodes (see gpuDecode.worker.ts) — if a window's
// decode takes longer than one FT8 window period, later windows queue up
// behind it rather than racing (which used to corrupt the GPU pipeline's
// cached buffers). inFlight/queued let us see that backlog forming instead
// of it being silently invisible until results arrive suspiciously late.
let inFlight = 0;

function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('./gpuDecode.worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (e: MessageEvent<GpuWorkerResponse>) => {
    const entry = pending.get(e.data.id);
    if (!entry) return;
    pending.delete(e.data.id);
    entry.resolve(e.data);
  };
  return worker;
}

/** Runs the GPU decode pipeline (off-main-thread) on one captured window
 *  (raw samples at the mic's native rate) and returns FTMessage[], matching
 *  decodeFTAudio's own contract closely enough to drop in as a replacement
 *  — EXCEPT this has no onPartial streaming callback (the whole pipeline
 *  runs as one batch; a real integration wanting streaming partials would
 *  need decodeGpu() to yield candidate-by-candidate, which it currently
 *  doesn't — see gpuDecodePipeline.ts's module doc for the full scope this
 *  prototype deliberately covers). No fallback on error — this is a dev-only
 *  testing path, so a GPU decode failure surfaces as a rejected promise. */
export async function decodeFTAudioGpu(
  captured: Float32Array,
  sampleRate: number,
  maxCandidates = 150,
): Promise<FTMessage[]> {
  // resampleTo12k is a no-op passthrough when sampleRate is already 12kHz —
  // it then returns `captured` itself, not a fresh buffer. Transferring that
  // would detach the caller's buffer out from under it, so copy before
  // transfer rather than relying on resampleTo12k always allocating.
  const resampled = resampleTo12k(captured, sampleRate);
  const samples12k = resampled === captured ? resampled.slice() : resampled;
  const id = nextId++;
  const req: GpuWorkerRequest = { type: 'decode', id, samples12k, maxCandidates };

  const resPromise = new Promise<GpuWorkerResponse>((resolve) => {
    pending.set(id, { resolve });
  });
  inFlight++;
  if (inFlight > 1) {
    console.warn(`[gpu decode] window queued behind ${inFlight - 1} still-running decode(s) — GPU pipeline can't keep up with real-time capture at this maxCandidates`);
  }
  // Transfer the resampled buffer — this thread has no further use for it,
  // and a structured-clone copy of a ~180k-sample Float32Array per window
  // is pure waste when a transfer is free.
  getWorker().postMessage(req, [samples12k.buffer]);

  const dispatchT0 = performance.now();
  const res = await resPromise;
  inFlight--;
  const t = res.timings;
  console.debug(
    `[gpu decode] total=${t.totalMs.toFixed(0)}ms (coarse=${t.coarseSearchMs.toFixed(0)} wholeFft=${t.wholeBufferFftMs.toFixed(0)} fineSync=${t.fineSyncMs.toFixed(0)} ldpc=${t.ldpcMs.toFixed(0)} osd=${t.osdMs.toFixed(0)} subtract=${t.subtractMs.toFixed(0)}), passes=${t.passesRun}, queue wait=${(performance.now() - dispatchT0 - t.totalMs).toFixed(0)}ms`,
  );
  if (res.error) throw new Error(res.error);

  return res.results.map(r => {
    const a77 = Array.from(r.plain).slice(0, 77);
    const msg = unpack(a77);
    return {
      freq: r.freqHz,
      dt: r.dtSec,
      snr: r.snr,
      msg,
      sync: 0, // ft8mon's `sync` field is a raw Costas-correlation score with
               // no direct GPU-kernel equivalent computed yet — 0 rather
               // than a fabricated number; not used for anything but display.
      pass: r.pass,
      osd: r.osd === -1 ? undefined : r.osd, // matches FTMessage's own -1/undefined=clean-LDPC convention
    };
  });
}
