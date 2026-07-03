// WAV encode worker for the ring-buffer recorder.
//
// The encode itself is cheap (~90 ms for a full 5-min ring), but doing it on
// the main thread means a ~90 MB allocation burst (snapshot + WAV bytes +
// blob) on a heap already carrying a full contact table and the WASM decoder
// — measured GC amplification pushed Rec-click freezes to 500-700 ms under
// the golden load. Here both the burst and its GC land on the worker's heap;
// buffers cross thread boundaries as zero-copy transferables.

import { wavPcm16Bytes } from './wav';

self.onmessage = (e: MessageEvent<{ samples: Float32Array; sampleRate: number }>) => {
  const { samples, sampleRate } = e.data;
  const bytes = wavPcm16Bytes(samples, sampleRate);
  (self as unknown as Worker).postMessage(bytes, [bytes]);
};
