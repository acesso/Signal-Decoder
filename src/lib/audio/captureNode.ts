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

// AudioWorklet module registration is PER-AudioContext — addModule() on one
// context does not register the processor on another. This app runs several
// independent AudioContexts concurrently (one per decoder mode, plus one for
// TX — see globalAudio.ts, cw/processor.ts, ft/processor.ts,
// ft/useFTTransmit.ts, mfsk/processor.ts, rtty/multiProcessor.ts,
// sstv/audioProcessor.ts), so the cache must be keyed per-context, not a
// single shared module-level promise — a shared cache meant every context
// after the first one skipped its own addModule() call and then failed to
// construct its AudioWorkletNode with "Unknown AudioWorklet name
// 'capture-forwarder'".
const workletModuleLoaded = new WeakMap<AudioContext, Promise<void>>();

function ensureWorkletModule(ctx: AudioContext): Promise<void> {
  let loaded = workletModuleLoaded.get(ctx);
  if (!loaded) {
    loaded = ctx.audioWorklet.addModule(
      // Plain .js, not .ts — Vite has no built-in transpile support for
      // AudioWorklet's addModule(new URL(...)) the way it does for
      // new Worker(new URL(...)); a .ts file here gets inlined untranspiled
      // in production builds and fails to parse in the browser. See
      // captureWorklet.js's header comment for the full explanation.
      new URL('./captureWorklet.js', import.meta.url),
    );
    workletModuleLoaded.set(ctx, loaded);
  }
  return loaded;
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

/**
 * Stereo capture node for soundcard I/Q: emits interleaved I,Q,I,Q…
 * Float32 buffers (left channel = I, right = Q), batched to `pairSize`
 * PAIRS per callback.
 *
 * Separate from createCaptureNode above rather than a channel-count option
 * on it: that one forwards a single channel and is used by every mono
 * decoder, and quietly changing its shape to sometimes-interleaved would
 * put a format question into call sites that have no I/Q concept at all.
 */
export async function createIQCaptureNode(
  ctx: AudioContext,
  pairSize: number,
  onChunk: (interleaved: Float32Array) => void,
): Promise<CaptureNode> {
  await ensureWorkletModule(ctx);

  const node = new AudioWorkletNode(ctx, 'iq-capture-forwarder', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    channelCount: 2,
    // 'explicit' so a mono device is up-mixed to two channels rather than
    // silently giving the processor one channel to duplicate — and so a
    // >2-channel device is down-mixed instead of having channels 2+ decide
    // the node's layout.
    channelCountMode: 'explicit',
    channelInterpretation: 'discrete',
  });

  const bufferLen = pairSize * 2;
  let acc = new Float32Array(bufferLen);
  let accLen = 0;

  node.port.onmessage = (e: MessageEvent<Float32Array>) => {
    const quantum = e.data;
    let offset = 0;
    while (offset < quantum.length) {
      const space = bufferLen - accLen;
      const copyLen = Math.min(space, quantum.length - offset);
      acc.set(quantum.subarray(offset, offset + copyLen), accLen);
      accLen += copyLen;
      offset += copyLen;
      if (accLen === bufferLen) {
        onChunk(acc);
        acc = new Float32Array(bufferLen);
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
