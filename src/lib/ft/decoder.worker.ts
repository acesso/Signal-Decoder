import { decodeFT8, decodeFT4, HashCallBook } from '@e04/ft8ts';
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

// Single shared book — persists for the lifetime of the worker
const book = new HashCallBook();

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const { id, samples, sampleRate, mode } = e.data;
  try {
    const options = { sampleRate, hashCallBook: book };
    const raw = mode === 'FT8'
      ? decodeFT8(samples, options)
      : decodeFT4(samples, options);

    const messages = raw.map(r => ({
      freq: r.freq, dt: r.dt, snr: r.snr, msg: r.msg, sync: r.sync,
    }));

    const response: WorkerResponse = { id, messages };
    self.postMessage(response);
  } catch (err) {
    const response: WorkerResponse = {
      id,
      messages: [],
      error: err instanceof Error ? err.message : String(err),
    };
    self.postMessage(response);
  }
};
