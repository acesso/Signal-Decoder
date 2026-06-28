'use client';

import { useRef, useState, useCallback, useEffect } from 'react';

// Web Serial API ambient types (not yet in lib.dom.d.ts for all TS versions)
declare global {
  interface SerialPort {
    open(options: SerialOptions): Promise<void>;
    close(): Promise<void>;
    readonly readable: ReadableStream<Uint8Array> | null;
    readonly writable: WritableStream<Uint8Array> | null;
  }
  interface SerialOptions {
    baudRate: number;
    dataBits?: number;
    stopBits?: number;
    parity?: 'none' | 'even' | 'odd';
    flowControl?: 'none' | 'hardware';
  }
}

// ── Types ────────────────────────────────────────────────────────────────────

export type CATMode = 'USB' | 'LSB' | 'AM' | 'FM' | 'CW' | 'RTTY';

export interface CATConnectionConfig {
  baudRate: number;
  dataBits: number;
  stopBits: number;
  parity: 'none' | 'even' | 'odd';
  /** How long to wait for a reply to a single CAT command (ms) */
  timeoutMs: number;
  /** How often to poll the radio for freq/mode updates (ms) */
  pollIntervalMs: number;
  /** Enable CAT debug logging to the browser console */
  debug: boolean;
}

export interface RadioState {
  connected: boolean;
  frequency: number | null;
  mode: CATMode | null;
  ptt: boolean;
  error: string | null;
  /** false on SSR, true once mounted in a supporting browser */
  isSupported: boolean;
}

export interface RadioCATControls {
  state: RadioState;
  connect: (config: CATConnectionConfig) => Promise<void>;
  disconnect: () => void;
  setFrequency: (hz: number) => Promise<void>;
  setMode: (mode: CATMode) => Promise<void>;
  setPTT: (tx: boolean) => Promise<void>;
}

// ── Kenwood TS-series CAT protocol ───────────────────────────────────────────
// Query freq:  FA;   → FA00014225000;  (11-digit Hz, VFO A)
// Set freq:    FA00014225000;           (no echo)
// Query mode:  MD;   → MD2;            (1=LSB 2=USB 3=CW 4=FM 5=AM 6=RTTY)
// Set mode:    MD2;                     (no echo)
// PTT on:      TX;                      (no echo)
// PTT off:     RX;                      (no echo)

const KENWOOD_MODE_MAP: Record<string, CATMode> = {
  '1': 'LSB', '2': 'USB', '3': 'CW', '4': 'FM', '5': 'AM', '6': 'RTTY',
  '7': 'CW',  '9': 'RTTY',
};

const CAT_MODE_TO_KENWOOD: Record<CATMode, string> = {
  LSB: '1', USB: '2', CW: '3', FM: '4', AM: '5', RTTY: '6',
};

// ── Serial command queue ──────────────────────────────────────────────────────

interface QueueEntry {
  bytes: Uint8Array;
  /** 2-char response prefix expected; null = fire-and-forget */
  prefix: string | null;
  isPoll: boolean;
  resolve: (resp: string) => void;
  reject:  (err: Error)   => void;
  timer:   ReturnType<typeof setTimeout> | null;
}

// How long after a user set-command to suppress poll overwrites for that field.
const SET_GRACE_MS = 1500;

// ── Hook ─────────────────────────────────────────────────────────────────────

export function useRadioCAT(): RadioCATControls {
  const [state, setState] = useState<RadioState>({
    connected: false, frequency: null, mode: null,
    ptt: false, error: null, isSupported: false,
  });

  useEffect(() => {
    setState(prev => ({
      ...prev,
      isSupported: typeof navigator !== 'undefined' && 'serial' in navigator,
    }));
  }, []);

  const portRef      = useRef<SerialPort | null>(null);
  const writerRef    = useRef<WritableStreamDefaultWriter<Uint8Array> | null>(null);
  const readerRef    = useRef<ReadableStreamDefaultReader<Uint8Array> | null>(null);
  const rxBufRef     = useRef<string>('');
  const pollTimerRef    = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollRunningRef  = useRef(false);
  const timeoutMsRef     = useRef<number>(50);
  const pollIntervalMsRef = useRef<number>(100);
  const debugRef     = useRef<boolean>(false);
  const encoder      = useRef(new TextEncoder()).current;

  const queueRef    = useRef<QueueEntry[]>([]);
  const inflightRef = useRef<QueueEntry | null>(null);

  const lastSetRef = useRef<{ frequency: number; mode: number }>({
    frequency: 0, mode: 0,
  });

  const log = useCallback((level: 'debug' | 'info' | 'warn' | 'error', ...args: unknown[]) => {
    if (!debugRef.current && level === 'debug') return;
    console[level]('[CAT]', ...args);
  }, []);

  // ── Queue machinery ───────────────────────────────────────────────────────

  const drainQueue = useCallback(() => {
    // If no writer, reject all queued commands immediately rather than letting them hang
    if (!writerRef.current) {
      const err = new Error('CAT not connected');
      while (queueRef.current.length > 0) queueRef.current.shift()!.reject(err);
      return;
    }
    if (inflightRef.current || queueRef.current.length === 0) return;
    const entry = queueRef.current.shift()!;
    inflightRef.current = entry;

    const cmdStr = new TextDecoder().decode(entry.bytes).trim();
    const qLen = queueRef.current.length; // already shifted, so this is remaining

    if (entry.prefix === null) {
      log('debug', 'write ←', cmdStr, `[q:${qLen}]`);
      writerRef.current.write(entry.bytes).then(() => {
        entry.resolve('');
        inflightRef.current = null;
        drainQueue();
      }).catch(err => {
        log('warn', 'write error:', err);
        entry.reject(err instanceof Error ? err : new Error(String(err)));
        inflightRef.current = null;
        drainQueue();
      });
      return;
    }

    log('debug', 'query ←', cmdStr, `(timeout ${timeoutMsRef.current}ms) [q:${qLen}]`);

    entry.timer = setTimeout(() => {
      // Flush any partial rx data — a timeout means the radio's response was
      // lost or garbled; stale bytes in the buffer would corrupt the next reply.
      if (rxBufRef.current.length > 0) {
        log('debug', 'timeout: flushing rx buffer:', JSON.stringify(rxBufRef.current));
        rxBufRef.current = '';
      }
      log('debug', 'timeout for', cmdStr);
      inflightRef.current = null;
      entry.resolve('__timeout__');
      drainQueue();
    }, timeoutMsRef.current);

    writerRef.current.write(entry.bytes).catch(err => {
      if (entry.timer) clearTimeout(entry.timer);
      log('warn', 'write error during query:', err);
      inflightRef.current = null;
      entry.reject(err instanceof Error ? err : new Error(String(err)));
      drainQueue();
    });
  }, [log]);

  const handleResponse = useCallback((msg: string) => {
    const inf = inflightRef.current;
    if (!inf || inf.prefix === null) {
      log('debug', 'unsolicited →', msg.trim());
      return;
    }
    if (msg.substring(0, 2) !== inf.prefix) {
      log('debug', 'unexpected →', msg.trim(), '(waiting for', inf.prefix + ')');
      return;
    }
    log('debug', 'response →', msg.trim(), `[q:${queueRef.current.length}]`);
    if (inf.timer) clearTimeout(inf.timer);
    inflightRef.current = null;
    inf.resolve(msg);
    drainQueue();
  }, [log, drainQueue]);

  const dropQueuedPolls = useCallback(() => {
    const dropped = queueRef.current.filter(e => e.isPoll);
    if (dropped.length) log('debug', 'dropping', dropped.length, 'queued poll(s)');
    queueRef.current = queueRef.current.filter(e => !e.isPoll);
    for (const e of dropped) e.resolve('__dropped__');
  }, [log]);

  const query = useCallback((cmd: string, isPoll = false): Promise<string> => {
    // Deduplicate: if an identical command is already queued, skip it
    if (queueRef.current.some(e => e.isPoll === isPoll && new TextDecoder().decode(e.bytes) === cmd)) {
      return Promise.resolve('__dedup__');
    }
    return new Promise<string>((resolve, reject) => {
      queueRef.current.push({
        bytes:  encoder.encode(cmd),
        prefix: cmd.substring(0, 2),
        isPoll, resolve, reject, timer: null,
      });
      drainQueue();
    });
  }, [encoder, drainQueue]);

  const write = useCallback((cmd: string): Promise<void> => {
    dropQueuedPolls();
    return new Promise<void>((resolve, reject) => {
      queueRef.current.push({
        bytes:  encoder.encode(cmd),
        prefix: null, isPoll: false,
        resolve: () => resolve(), reject, timer: null,
      });
      drainQueue();
    });
  }, [encoder, drainQueue, dropQueuedPolls]);

  // ── Serial read loop ─────────────────────────────────────────────────────

  const startReadLoop = useCallback((reader: ReadableStreamDefaultReader<Uint8Array>) => {
    const dec = new TextDecoder();
    (async () => {
      log('debug', 'read loop started');
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) { log('debug', 'read loop: stream done'); break; }
          rxBufRef.current += dec.decode(value, { stream: true });
          // Guard against unbounded growth from a radio sending malformed data
          // with no ';' terminator — a Kenwood response is at most ~20 bytes.
          if (rxBufRef.current.length > 256) {
            log('warn', 'rx buffer overflow, flushing:', JSON.stringify(rxBufRef.current));
            rxBufRef.current = '';
          }
          let i: number;
          while ((i = rxBufRef.current.indexOf(';')) !== -1) {
            const msg = rxBufRef.current.slice(0, i + 1);
            rxBufRef.current = rxBufRef.current.slice(i + 1);
            handleResponse(msg);
          }
        }
      } catch (e) {
        log('debug', 'read loop ended:', e);
      }
    })();
  }, [log, handleResponse]);

  // ── Parse helpers ────────────────────────────────────────────────────────

  const parseFrequency = (resp: string): number | null => {
    const m = resp.match(/^FA(\d+);$/);
    if (!m) return null;
    const hz = parseInt(m[1], 10);
    return hz > 0 ? hz : null;
  };

  const parseMode = (resp: string): CATMode | null => {
    const m = resp.match(/^MD([0-9A-Fa-f]);$/);
    return m ? (KENWOOD_MODE_MAP[m[1].toUpperCase()] ?? null) : null;
  };

  // ── Poll loop — self-scheduling setTimeout so the next poll only fires
  // after the current one fully completes. This prevents poll buildup when
  // the radio is slow or the USB-serial stack stalls. ─────────────────────

  const schedulePoll = useCallback(() => {
    if (pollTimerRef.current !== null) return; // already scheduled
    pollTimerRef.current = setTimeout(async () => {
      pollTimerRef.current = null;
      if (!writerRef.current || pollRunningRef.current) {
        // Port gone or previous poll still running — reschedule and skip
        schedulePoll();
        return;
      }
      pollRunningRef.current = true;
      try {
        if (queueRef.current.some(e => !e.isPoll)) {
          // A user command (PTT/freq/mode) is pending — skip this poll cycle
          return;
        }
        const safeQuery = async (cmd: string): Promise<string> => {
          try { return await query(cmd, true); } catch { return ''; }
        };
        const now = Date.now();
        const fr  = await safeQuery('FA;');
        const mr  = await safeQuery('MD;');
        const freq = parseFrequency(fr);
        const mode = parseMode(mr);
        log('debug', 'poll — freq:', freq, 'mode:', mode, `[q:${queueRef.current.length}]`);
        if (freq !== null || mode !== null) {
          setState(prev => {
            const ls = lastSetRef.current;
            return {
              ...prev,
              frequency: freq !== null && (now - ls.frequency > SET_GRACE_MS) ? freq : prev.frequency,
              mode:      mode !== null && (now - ls.mode      > SET_GRACE_MS) ? mode : prev.mode,
            };
          });
        }
      } finally {
        pollRunningRef.current = false;
        // Only reschedule if still connected
        if (writerRef.current) schedulePoll();
      }
    }, pollIntervalMsRef.current);
  }, [log, query]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Public API ───────────────────────────────────────────────────────────

  const disconnect = useCallback(() => {
    log('info', 'disconnecting');
    if (pollTimerRef.current) { clearTimeout(pollTimerRef.current); pollTimerRef.current = null; }
    pollRunningRef.current = false;
    if (inflightRef.current) {
      if (inflightRef.current.timer) clearTimeout(inflightRef.current.timer);
      inflightRef.current.resolve('__disconnected__');
      inflightRef.current = null;
    }
    for (const e of queueRef.current) e.resolve('__disconnected__');
    queueRef.current = [];
    try { readerRef.current?.cancel(); } catch { /* ignore */ }
    try { writerRef.current?.close();  } catch { /* ignore */ }
    try { portRef.current?.close();    } catch { /* ignore */ }
    readerRef.current = null;
    writerRef.current = null;
    portRef.current   = null;
    rxBufRef.current  = '';
    setState(prev => ({ ...prev, connected: false, frequency: null, mode: null, ptt: false, error: null }));
  }, [log]);

  const connect = useCallback(async (config: CATConnectionConfig) => {
    debugRef.current = config.debug;
    if (!('serial' in navigator)) {
      setState(prev => ({ ...prev, error: 'Web Serial API not supported in this browser' }));
      return;
    }
    log('info', `connecting — ${config.baudRate} ${config.dataBits}${config.parity === 'none' ? 'N' : config.parity[0].toUpperCase()}${config.stopBits} timeout:${config.timeoutMs}ms debug:${config.debug}`);
    try {
      const serial = (navigator as Navigator & { serial: { requestPort(): Promise<SerialPort> } }).serial;
      const port = await serial.requestPort();
      await port.open({
        baudRate: config.baudRate, dataBits: config.dataBits,
        stopBits: config.stopBits, parity: config.parity, flowControl: 'none',
      });
      if (!port.writable || !port.readable) throw new Error('Port streams unavailable');
      timeoutMsRef.current     = config.timeoutMs;
      pollIntervalMsRef.current = config.pollIntervalMs;
      portRef.current   = port;
      writerRef.current = port.writable.getWriter();
      const reader      = port.readable.getReader();
      readerRef.current = reader;
      startReadLoop(reader);
      setState(prev => ({ ...prev, connected: true, error: null }));
      log('info', 'polling every', config.pollIntervalMs + 'ms');
      schedulePoll();
    } catch (err) {
      log('info', 'connection failed:', err);
      setState(prev => ({
        ...prev, connected: false,
        error: err instanceof Error ? err.message : 'Connection failed',
      }));
    }
  }, [log, startReadLoop, schedulePoll]);

  const setFrequency = useCallback(async (hz: number) => {
    lastSetRef.current.frequency = Date.now();
    log('info', 'setFrequency →', hz, 'Hz');
    setState(prev => ({ ...prev, frequency: hz }));
    await write(`FA${hz.toString().padStart(11, '0')};`);
  }, [log, write]);

  const setMode = useCallback(async (mode: CATMode) => {
    lastSetRef.current.mode = Date.now();
    log('info', 'setMode →', mode);
    setState(prev => ({ ...prev, mode }));
    await write(`MD${CAT_MODE_TO_KENWOOD[mode]};`);
  }, [log, write]);

  const setPTT = useCallback(async (tx: boolean) => {
    log('info', 'setPTT →', tx ? 'TX' : 'RX');
    setState(prev => ({ ...prev, ptt: tx }));
    await write(tx ? 'TX;' : 'RX;');
  }, [log, write]);

  useEffect(() => () => { disconnect(); }, [disconnect]);

  return { state, connect, disconnect, setFrequency, setMode, setPTT };
}
