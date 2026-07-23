// WebGPU FT8 decode worker. The fine-sync bridge (downV7f/searchBoth/
// extract/cSoftDecode, see gpuDecodePipeline.ts) runs synchronously on
// whatever thread calls decodeGpu(), and does real CPU work per candidate
// (measured ~2.86s/20 candidates end-to-end) — calling it from the main
// thread freezes the page (audio capture stalls, UI stops updating) for the
// entire fine-sync loop. Same problem the existing WASM path already solved
// with decoder.worker.ts; this mirrors that approach for the GPU pipeline.
//
// One dedicated worker, not a pool (unlike decoder.worker.ts's multi-slot
// pool) — this is a dev-only correctness/live-testing path, not tuned for
// decode throughput yet. navigator.gpu is available in dedicated workers
// (WorkerNavigator mixin, same as Window) so webgpuDevice.ts's getDevice()
// works here unmodified.
import { decodeGpu, type GpuDecodeResult, type GpuDecodeTimings } from './gpuDecodePipeline';

export type GpuWorkerRequest = {
  type: 'decode';
  id: number;
  samples12k: Float32Array;
  maxCandidates: number;
};

export type GpuWorkerResponse =
  | { type: 'result'; id: number; results: GpuDecodeResult[]; timings: GpuDecodeTimings; error?: string };

async function runOne(req: GpuWorkerRequest) {
  const { id, samples12k, maxCandidates } = req;
  try {
    const { results, timings } = await decodeGpu(samples12k, { maxCandidates });
    self.postMessage({ type: 'result', id, results, timings } satisfies GpuWorkerResponse);
  } catch (err) {
    self.postMessage({
      type: 'result',
      id,
      results: [],
      timings: { coarseSearchMs: 0, wholeBufferFftMs: 0, fineSyncMs: 0, ldpcMs: 0, osdMs: 0, subtractMs: 0, totalMs: 0, passesRun: 0 },
      error: err instanceof Error ? err.message : String(err),
    } satisfies GpuWorkerResponse);
  }
}

// The cached GPU pipeline state (webgpuCoarseSearch.ts/webgpuLdpcDecode.ts's
// module-level singletons: readback buffers, bind groups) is NOT reentrant —
// two decodeGpu() calls in flight at once race on the same buffers'
// mapAsync/getMappedRange, surfacing as "Buffer mapping is already pending"
// (found live: capture windows arrive faster than a decode completes, so
// window N+1's message handler fired before window N's decode settled).
// self.onmessage being `async` does NOT queue overlapping invocations — each
// incoming message starts a new concurrent call — so an explicit FIFO queue
// is required to keep decodes strictly serialized.
let queue: Promise<void> = Promise.resolve();

self.onmessage = (e: MessageEvent<GpuWorkerRequest>) => {
  queue = queue.then(() => runOne(e.data));
};
