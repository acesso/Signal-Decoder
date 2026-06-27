'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { FTMode, FT_WINDOW_SECONDS, FT_SUPPORTED } from '@/lib/ft/decoder';

export interface TxQueueEntry {
  id: string;
  message: string;
  label: string;
  // Populated as soon as the entry is enqueued — loop never waits for encoding
  samples: Float32Array | null;
  encodeStatus: 'pending' | 'ready' | 'error';
  encodeError?: string;
}

export interface SentEntry {
  id: string;
  message: string;
  label: string;
  windowStart: Date;
  vfoHz: number;
  audioHz: number;
  error?: string;
}

export type TxStatus = 'idle' | 'waiting' | 'playing';

export interface FTTransmitState {
  status: TxStatus;
  queue: TxQueueEntry[];
  sent: SentEntry[];
  autoCQ: boolean;
  autoPTT: boolean;
  allowConsecutiveTx: boolean;
  error: string | null;
  outputDeviceId: string;
  txGain: number;
  sinkIdSupported: boolean;
}

// ── localStorage persistence ──────────────────────────────────────────────────

const LS_CALL            = 'ft_mycall';
const LS_GRID            = 'ft_mygrid';
const LS_OUTPUT          = 'ft_output_device';
const LS_GAIN            = 'ft_tx_gain';
const LS_AUTOPTT         = 'ft_auto_ptt';
const LS_CONSECUTIVE_TX  = 'ft_consecutive_tx';

export function loadMyCall(): string {
  if (typeof window === 'undefined') return '';
  return localStorage.getItem(LS_CALL) ?? '';
}
export function saveMyCall(v: string) {
  if (typeof window !== 'undefined') localStorage.setItem(LS_CALL, v);
}
export function loadMyGrid(): string {
  if (typeof window === 'undefined') return '';
  return localStorage.getItem(LS_GRID) ?? '';
}
export function saveMyGrid(v: string) {
  if (typeof window !== 'undefined') localStorage.setItem(LS_GRID, v);
}
export function loadOutputDevice(): string {
  if (typeof window === 'undefined') return '';
  return localStorage.getItem(LS_OUTPUT) ?? '';
}
export function saveOutputDevice(v: string) {
  if (typeof window !== 'undefined') localStorage.setItem(LS_OUTPUT, v);
}
const DEFAULT_GAIN = Math.pow(10, -15 / 20); // -15 dB
export function loadTxGain(): number {
  if (typeof window === 'undefined') return DEFAULT_GAIN;
  const stored = localStorage.getItem(LS_GAIN);
  return stored !== null ? parseFloat(stored) : DEFAULT_GAIN;
}
export function saveTxGain(v: number) {
  if (typeof window !== 'undefined') localStorage.setItem(LS_GAIN, String(v));
}
export function loadAutoPTT(): boolean {
  if (typeof window === 'undefined') return false;
  return localStorage.getItem(LS_AUTOPTT) === 'true';
}
export function saveAutoPTT(v: boolean) {
  if (typeof window !== 'undefined') localStorage.setItem(LS_AUTOPTT, String(v));
}
export function loadAllowConsecutiveTx(): boolean {
  if (typeof window === 'undefined') return false;
  return localStorage.getItem(LS_CONSECUTIVE_TX) === 'true';
}
export function saveAllowConsecutiveTx(v: boolean) {
  if (typeof window !== 'undefined') localStorage.setItem(LS_CONSECUTIVE_TX, String(v));
}

// ── Timing helpers ────────────────────────────────────────────────────────────

function msUntilNextWindow(windowSec: number): number {
  const totalMs = windowSec * 1000;
  const now     = new Date();
  const elapsed = (now.getSeconds() * 1000 + now.getMilliseconds()) % totalMs;
  // If we're within the last 50ms of a window treat it as 0 (boundary now)
  const remaining = totalMs - elapsed;
  return remaining <= 50 ? 0 : remaining;
}

// ── Encoder worker ────────────────────────────────────────────────────────────

let encWorker: Worker | null = null;
let encNextId = 0;
const encPending = new Map<number, (samples: Float32Array, error?: string) => void>();

function getEncodeWorker(): Worker {
  if (!encWorker) {
    encWorker = new Worker(new URL('../lib/ft/encoder.worker.ts', import.meta.url));
    encWorker.onmessage = (e: MessageEvent) => {
      const { id, samples, error } = e.data;
      encPending.get(id)?.(samples, error);
      encPending.delete(id);
    };
  }
  return encWorker;
}

function encodeAsync(
  msg: string,
  mode: FTMode,
  sampleRate: number,
  baseFrequency: number,
): Promise<Float32Array> {
  return new Promise((resolve, reject) => {
    const id = encNextId++;
    encPending.set(id, (samples, error) => {
      if (error) reject(new Error(error));
      else resolve(samples);
    });
    getEncodeWorker().postMessage({ id, msg, mode, sampleRate, baseFrequency });
  });
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useFTTransmit(
  mode: FTMode,
  baseFrequency = 1000,
  vfoFrequency = 0,
  onSetPTT?: (tx: boolean) => Promise<void>,
) {
  const [state, setState] = useState<FTTransmitState>({
    status: 'idle',
    queue: [],
    sent: [],
    autoCQ: false,
    autoPTT: loadAutoPTT(),
    allowConsecutiveTx: loadAllowConsecutiveTx(),
    error: null,
    outputDeviceId: loadOutputDevice(),
    txGain: loadTxGain(),
    sinkIdSupported: false,
  });

  const isRunningRef          = useRef(false);
  const modeRef               = useRef(mode);
  const baseFreqRef           = useRef(baseFrequency);
  const vfoFreqRef            = useRef(vfoFrequency);
  const outputDeviceRef       = useRef(state.outputDeviceId);
  const autoCQRef             = useRef(false);
  const autoPTTRef            = useRef(loadAutoPTT());
  const allowConsecutiveTxRef = useRef(loadAllowConsecutiveTx());
  const lastTxWindowRef       = useRef<number>(-1); // epoch ms of last window we transmitted in
  const onSetPTTRef           = useRef(onSetPTT);
  const gainRef               = useRef(loadTxGain());
  const gainNodeRef           = useRef<GainNode | null>(null);
  const queueRef              = useRef<TxQueueEntry[]>([]);
  const timersRef             = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  const audioCtxRef           = useRef<AudioContext | null>(null);

  useEffect(() => { vfoFreqRef.current = vfoFrequency; }, [vfoFrequency]);
  useEffect(() => { onSetPTTRef.current = onSetPTT; }, [onSetPTT]);

  useEffect(() => {
    const supported = typeof AudioContext !== 'undefined' &&
      'setSinkId' in AudioContext.prototype;
    setState(prev => ({ ...prev, sinkIdSupported: supported }));
  }, []);

  const syncQueueRef  = useCallback((q: TxQueueEntry[]) => { queueRef.current = q; }, []);
  const syncAutoCQRef = useCallback((v: boolean) => { autoCQRef.current = v; }, []);
  const syncOutputRef = useCallback((v: string) => { outputDeviceRef.current = v; }, []);

  const clearTimers = () => {
    for (const t of timersRef.current) clearTimeout(t);
    timersRef.current.clear();
  };

  const sleep = (ms: number): Promise<void> =>
    new Promise(resolve => {
      const t = setTimeout(() => { timersRef.current.delete(t); resolve(); }, ms);
      timersRef.current.add(t);
    });

  // ── Encode on enqueue ─────────────────────────────────────────────────────
  // Start encoding the moment a message is added. By the time the window
  // arrives (~seconds away), samples are already ready in the entry.

  const startEncode = useCallback((entry: TxQueueEntry) => {
    const ENC_RATE = 12000;
    encodeAsync(entry.message, modeRef.current, ENC_RATE, baseFreqRef.current)
      .then(samples => {
        setState(prev => {
          const q = prev.queue.map(e =>
            e.id === entry.id ? { ...e, samples, encodeStatus: 'ready' as const } : e
          );
          syncQueueRef(q);
          return { ...prev, queue: q };
        });
      })
      .catch(err => {
        const encodeError = err instanceof Error ? err.message : String(err);
        setState(prev => {
          const q = prev.queue.map(e =>
            e.id === entry.id ? { ...e, encodeStatus: 'error' as const, encodeError } : e
          );
          syncQueueRef(q);
          return { ...prev, queue: q };
        });
      });
  }, [syncQueueRef]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Auto-CQ sample cache ──────────────────────────────────────────────────
  // The CQ message is encoded eagerly and cached outside the queue so the loop
  // can play it immediately without injecting a queue entry (which would add
  // a full window of latency and cause duplicate-key issues in React).

  const autoCQSamplesRef  = useRef<Float32Array | null>(null);
  const autoCQMsgCached   = useRef<string>('');   // message text that was last encoded
  const autoCQModeCached  = useRef<string>('');   // mode that was encoded for
  const autoCQFreqCached  = useRef<number>(0);    // baseFreq that was encoded for

  const rebuildAutoCQCache = useCallback((msg: string) => {
    if (!msg) { autoCQSamplesRef.current = null; autoCQMsgCached.current = ''; return; }
    autoCQSamplesRef.current = null; // invalidate while encoding
    autoCQMsgCached.current  = msg;
    autoCQModeCached.current = modeRef.current;
    autoCQFreqCached.current = baseFreqRef.current;
    encodeAsync(msg, modeRef.current, 12000, baseFreqRef.current)
      .then(samples => {
        // Only store if message/mode/freq haven't changed since we started
        if (
          autoCQMsgCached.current  === msg &&
          autoCQModeCached.current === modeRef.current &&
          autoCQFreqCached.current === baseFreqRef.current
        ) {
          autoCQSamplesRef.current = samples;
        }
      })
      .catch(() => { autoCQSamplesRef.current = null; });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Audio context ─────────────────────────────────────────────────────────

  async function getAudioContext(): Promise<AudioContext> {
    const ctx = audioCtxRef.current!;
    const deviceId = outputDeviceRef.current;
    if (deviceId && 'setSinkId' in ctx) {
      try {
        // @ts-expect-error — setSinkId not yet in TS lib
        await ctx.setSinkId(deviceId);
      } catch { /* device unplugged */ }
    }
    if (ctx.state === 'suspended') await ctx.resume();
    return ctx;
  }

  // ── Transmit loop ─────────────────────────────────────────────────────────

  const runLoop = useCallback(async () => {
    // Sleep to the next UTC window boundary. Always skip at least one full
    // window on startup to avoid transmitting mid-window.
    const sleepToNextBoundary = (windowSec: number, skipExtra = false): Promise<void> => {
      const windowMs  = windowSec * 1000;
      const nowMs     = Date.now();
      const elapsed   = nowMs % windowMs;
      const remaining = windowMs - elapsed;
      // If we're within 50ms of a boundary, skip to the one after
      const wait = (remaining <= 50 || skipExtra) ? remaining + windowMs : remaining;
      return sleep(wait);
    };

    await sleepToNextBoundary(FT_WINDOW_SECONDS[modeRef.current], true);

    while (isRunningRef.current) {
      const windowSec = FT_WINDOW_SECONDS[modeRef.current];
      const windowMs  = windowSec * 1000;

      // We are now at a window boundary. Decide what this window does.
      setState(prev => ({ ...prev, status: 'waiting' }));

      // Consecutive-TX guard: if we transmitted in the immediately preceding window,
      // this window is a forced listen window.
      const nowMs              = Date.now();
      const currentWindowStart = nowMs - (nowMs % windowMs);
      const prevWindowStart    = currentWindowStart - windowMs;
      const skipForListen      = !allowConsecutiveTxRef.current &&
        (lastTxWindowRef.current === prevWindowStart || lastTxWindowRef.current === currentWindowStart);

      if (skipForListen) {
        await sleepToNextBoundary(windowSec);
        if (!isRunningRef.current) break;
        continue;
      }

      // Decide what to transmit this window.
      // Queued entries take priority; auto-CQ fills in when the queue is empty.
      const queuedEntry = queueRef.current[0] ?? null;
      const useAutoCQ   = !queuedEntry && autoCQRef.current && !!autoCQSamplesRef.current;

      if (!queuedEntry && !useAutoCQ) {
        await sleepToNextBoundary(windowSec);
        if (!isRunningRef.current) break;
        continue;
      }

      // ── Resolve samples ───────────────────────────────────────────────────
      let samples: Float32Array | null = null;
      let txMessage = '';
      let txLabel   = '';
      let txId      = '';

      if (useAutoCQ) {
        samples   = autoCQSamplesRef.current;
        txMessage = autoCQMsgCached.current;
        txLabel   = 'CQ (auto)';
        txId      = ''; // filled in below from windowStart
      } else {
        // Re-read from ref — entry may have been dequeued or its samples updated
        const live = queueRef.current.find(e => e.id === queuedEntry!.id) ?? queuedEntry!;

        if (live.encodeStatus === 'error') {
          const sent: SentEntry = {
            id: live.id, message: live.message, label: live.label,
            windowStart: new Date(),
            vfoHz: vfoFreqRef.current, audioHz: baseFreqRef.current,
            error: live.encodeError,
          };
          setState(prev => ({
            ...prev,
            queue: prev.queue.filter(q => q.id !== live.id),
            sent: [sent, ...prev.sent].slice(0, 100),
            error: live.encodeError ?? 'Encode error',
          }));
          queueRef.current = queueRef.current.filter(q => q.id !== live.id);
          continue;
        }

        // If still encoding, wait briefly (rare — encode starts on enqueue)
        if (live.encodeStatus === 'pending' || !live.samples) {
          await sleep(200);
          if (!isRunningRef.current) break;
        }

        const finalEntry = queueRef.current.find(e => e.id === live.id) ?? live;
        if (!finalEntry.samples) continue;

        samples   = finalEntry.samples;
        txMessage = finalEntry.message;
        txLabel   = finalEntry.label;
        txId      = finalEntry.id;
      }

      if (!samples) continue;

      const windowStart    = new Date();
      const windowStartMs  = windowStart.getTime();
      const txWindowBucket = windowStartMs - (windowStartMs % windowMs);
      lastTxWindowRef.current = txWindowBucket;
      // For auto-CQ, generate a unique sent-log id from the window timestamp
      if (useAutoCQ) txId = `autocq-${txWindowBucket}`;
      setState(prev => ({ ...prev, status: 'playing', error: null }));

      // Auto-PTT on — race with a 500ms timeout so a non-responsive CAT never blocks TX
      if (autoPTTRef.current && onSetPTTRef.current) {
        try {
          await Promise.race([
            onSetPTTRef.current(true),
            new Promise<void>((_, reject) => setTimeout(() => reject(new Error('PTT timeout')), 500)),
          ]);
        } catch { /* CAT not connected or timed out */ }
      }

      try {
        const ctx = await getAudioContext();
        const owned = new Float32Array(samples.length);
        owned.set(samples);
        const buf = ctx.createBuffer(1, owned.length, 12000);
        buf.copyToChannel(owned, 0);

        await new Promise<void>(resolve => {
          const src = ctx.createBufferSource();
          src.buffer = buf;
          src.connect(gainNodeRef.current ?? ctx.destination);
          src.onended = () => resolve();
          src.start(ctx.currentTime);
        });
      } catch (err) {
        setState(prev => ({
          ...prev,
          error: err instanceof Error ? err.message : 'Audio playback failed',
        }));
      }

      // Auto-PTT off
      if (autoPTTRef.current && onSetPTTRef.current) {
        try {
          await Promise.race([
            onSetPTTRef.current(false),
            new Promise<void>((_, reject) => setTimeout(() => reject(new Error('PTT timeout')), 500)),
          ]);
        } catch { /* CAT not connected or timed out */ }
      }

      const sent: SentEntry = {
        id: txId, message: txMessage, label: txLabel, windowStart,
        vfoHz: vfoFreqRef.current, audioHz: baseFreqRef.current,
      };
      setState(prev => ({
        ...prev, status: 'waiting',
        // Auto-CQ entries never enter the queue, so only filter for real entries
        queue: useAutoCQ ? prev.queue : prev.queue.filter(q => q.id !== txId),
        sent: [sent, ...prev.sent].slice(0, 100),
      }));
      if (!useAutoCQ) {
        queueRef.current = queueRef.current.filter(q => q.id !== txId);
      }
    }
    setState(prev => ({ ...prev, status: 'idle' }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startEncode]);

  const autoCQMessageRef = useRef<string>('');

  // Invalidate cache when mode or baseFreq changes so the cached waveform stays current
  useEffect(() => { modeRef.current = mode; if (autoCQMessageRef.current) rebuildAutoCQCache(autoCQMessageRef.current); }, [mode, rebuildAutoCQCache]);
  useEffect(() => { baseFreqRef.current = baseFrequency; if (autoCQMessageRef.current) rebuildAutoCQCache(autoCQMessageRef.current); }, [baseFrequency, rebuildAutoCQCache]);

  // ── Public API ────────────────────────────────────────────────────────────

  const start = useCallback(async () => {
    if (isRunningRef.current) return;
    if (!FT_SUPPORTED[modeRef.current]) return;
    if (!audioCtxRef.current || audioCtxRef.current.state === 'closed') {
      audioCtxRef.current = new AudioContext();
      gainNodeRef.current = audioCtxRef.current.createGain();
      gainNodeRef.current.gain.value = gainRef.current;
      gainNodeRef.current.connect(audioCtxRef.current.destination);
    }
    if (audioCtxRef.current.state === 'suspended') {
      await audioCtxRef.current.resume();
    }
    isRunningRef.current = true;
    runLoop();
  }, [runLoop]);

  const stop = useCallback(() => {
    isRunningRef.current = false;
    clearTimers();
    audioCtxRef.current?.close().catch(() => null);
    audioCtxRef.current = null;
    if (autoPTTRef.current) {
      onSetPTTRef.current?.(false).catch(() => null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const enqueue = useCallback((entry: Omit<TxQueueEntry, 'samples' | 'encodeStatus'>) => {
    const full: TxQueueEntry = { ...entry, samples: null, encodeStatus: 'pending' };
    startEncode(full);
    setState(prev => {
      const q = [...prev.queue, full];
      syncQueueRef(q);
      return { ...prev, queue: q };
    });
  }, [startEncode, syncQueueRef]);

  const dequeue = useCallback((id: string) => {
    setState(prev => {
      const q = prev.queue.filter(e => e.id !== id);
      syncQueueRef(q);
      return { ...prev, queue: q };
    });
  }, [syncQueueRef]);

  const moveUp = useCallback((id: string) => {
    setState(prev => {
      const idx = prev.queue.findIndex(e => e.id === id);
      if (idx <= 0) return prev;
      const q = [...prev.queue];
      [q[idx - 1], q[idx]] = [q[idx], q[idx - 1]];
      syncQueueRef(q);
      return { ...prev, queue: q };
    });
  }, [syncQueueRef]);

  const setAutoCQ = useCallback((v: boolean) => {
    autoCQRef.current = v;
    syncAutoCQRef(v);
    setState(prev => ({ ...prev, autoCQ: v }));
  }, [syncAutoCQRef]);

  const setAutoCQMessage = useCallback((msg: string) => {
    autoCQMessageRef.current = msg;
    rebuildAutoCQCache(msg);
  }, [rebuildAutoCQCache]);

  const setOutputDevice = useCallback((deviceId: string) => {
    outputDeviceRef.current = deviceId;
    syncOutputRef(deviceId);
    saveOutputDevice(deviceId);
    setState(prev => ({ ...prev, outputDeviceId: deviceId }));
  }, [syncOutputRef]);

  const setTxGain = useCallback((v: number) => {
    gainRef.current = v;
    if (gainNodeRef.current) gainNodeRef.current.gain.value = v;
    saveTxGain(v);
    setState(prev => ({ ...prev, txGain: v }));
  }, []);

  const setAutoPTT = useCallback((v: boolean) => {
    autoPTTRef.current = v;
    saveAutoPTT(v);
    setState(prev => ({ ...prev, autoPTT: v }));
  }, []);

  const setAllowConsecutiveTx = useCallback((v: boolean) => {
    allowConsecutiveTxRef.current = v;
    saveAllowConsecutiveTx(v);
    setState(prev => ({ ...prev, allowConsecutiveTx: v }));
  }, []);

  useEffect(() => () => { stop(); }, [stop]);

  return {
    state,
    start,
    stop,
    enqueue,
    dequeue,
    moveUp,
    setAutoCQ,
    setAutoCQMessage,
    setOutputDevice,
    setTxGain,
    setAutoPTT,
    setAllowConsecutiveTx,
    isRunning: isRunningRef,
  };
}
