// Worker wrapper around encodeSSTV — keeps the main thread responsive while
// synthesizing (PD290 at 44.1kHz is ~1.2M samples of per-pixel sine synthesis).
import { encodeSSTV } from './encoder';
import type { SSTV_MODES } from './constants';

export interface EncodeRequest {
  id: number;
  img: Uint8ClampedArray;
  mode: keyof typeof SSTV_MODES;
  sampleRate: number;
}

self.onmessage = (e: MessageEvent<EncodeRequest>) => {
  const { id, img, mode, sampleRate } = e.data;
  try {
    const samples = encodeSSTV(img, mode, sampleRate);
    (self as unknown as Worker).postMessage({ id, samples }, [samples.buffer]);
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, error: err instanceof Error ? err.message : String(err) });
  }
};
