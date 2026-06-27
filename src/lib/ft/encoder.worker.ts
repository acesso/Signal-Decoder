import { encodeFT8, encodeFT4 } from '@e04/ft8ts';
import type { FTMode } from './decoder';

export interface EncodeRequest {
  id: number;
  msg: string;
  mode: FTMode;
  sampleRate: number;
  baseFrequency: number;
}

export interface EncodeResponse {
  id: number;
  samples: Float32Array;
  error?: string;
}

self.onmessage = (e: MessageEvent<EncodeRequest>) => {
  const { id, msg, mode, sampleRate, baseFrequency } = e.data;
  try {
    const options = { sampleRate, baseFrequency };
    const samples = mode === 'FT8'
      ? encodeFT8(msg, options)
      : encodeFT4(msg, options);

    const response: EncodeResponse = { id, samples };
    self.postMessage(response, { transfer: [samples.buffer] });
  } catch (err) {
    const response: EncodeResponse = {
      id,
      samples: new Float32Array(0),
      error: err instanceof Error ? err.message : String(err),
    };
    self.postMessage(response);
  }
};
