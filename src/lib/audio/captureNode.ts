// Main-thread helper for the shared capture-forwarder AudioWorklet
// (captureWorklet.ts). AudioWorkletProcessor.process() is called once per
// 128-sample render quantum (fixed by the Web Audio spec, not configurable)
// — this batches those into the same bufferSize each call site's old
// createScriptProcessor(bufferSize, ...) used, so no downstream code (ring
// buffers, decoder chunk logic) needs to change its assumptions.
export interface CaptureNode {
  node: AudioWorkletNode;
  disconnect(): void;
}

let workletModuleLoaded: Promise<void> | null = null;

function ensureWorkletModule(ctx: AudioContext): Promise<void> {
  // audioWorklet.addModule is idempotent per-context if the same URL is
  // added twice, but multiple concurrent callers on a fresh context would
  // otherwise race — cache the in-flight promise, not just a boolean, keyed
  // per call (contexts are short-lived/one-per-feature in this app, so a
  // single module-level cache is fine — see globalAudio.ts's own single-
  // shared-AudioContext pattern this mirrors).
  if (!workletModuleLoaded) {
    workletModuleLoaded = ctx.audioWorklet.addModule(
      new URL('./captureWorklet.ts', import.meta.url),
    );
  }
  return workletModuleLoaded;
}

/**
 * Creates an AudioWorkletNode that batches incoming audio into
 * `bufferSize`-length Float32Array chunks and invokes `onChunk` for each —
 * a drop-in replacement for the onaudioprocess callback of
 * `ctx.createScriptProcessor(bufferSize, 1, 1)`, but running capture on the
 * audio thread instead of the main thread.
 */
export async function createCaptureNode(
  ctx: AudioContext,
  bufferSize: number,
  onChunk: (samples: Float32Array) => void,
): Promise<CaptureNode> {
  await ensureWorkletModule(ctx);

  const node = new AudioWorkletNode(ctx, 'capture-forwarder', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    channelCount: 1,
  });

  let acc = new Float32Array(bufferSize);
  let accLen = 0;

  node.port.onmessage = (e: MessageEvent<Float32Array>) => {
    const quantum = e.data;
    let offset = 0;
    while (offset < quantum.length) {
      const space = bufferSize - accLen;
      const copyLen = Math.min(space, quantum.length - offset);
      acc.set(quantum.subarray(offset, offset + copyLen), accLen);
      accLen += copyLen;
      offset += copyLen;
      if (accLen === bufferSize) {
        onChunk(acc);
        acc = new Float32Array(bufferSize);
        accLen = 0;
      }
    }
  };

  return {
    node,
    disconnect() {
      node.port.onmessage = null;
      node.disconnect();
    },
  };
}
