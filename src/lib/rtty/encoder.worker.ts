// Worker wrapper around encodeRTTYText — keeps the main thread responsive
// during synthesis, same shape as ft/encoder.worker.ts and sstv/encoder.worker.ts.
import { encodeRTTYText } from './encoder';
import type { RTTYConfig } from './decoder';

export interface EncodeRequest {
  id: number;
  text: string;
  config: RTTYConfig;
  sampleRate: number;
}

self.onmessage = (e: MessageEvent<EncodeRequest>) => {
  const { id, text, config, sampleRate } = e.data;
  try {
    const { samples, dropped } = encodeRTTYText(text, config, sampleRate);
    (self as unknown as Worker).postMessage({ id, samples, dropped }, [samples.buffer]);
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, error: err instanceof Error ? err.message : String(err) });
  }
};
