'use client';

import { useRef, useCallback, useReducer, useEffect } from 'react';
import { RTTYDecoder, RTTYConfig } from '@/lib/rtty/decoder';

export interface ProcessorState {
  isRecording: boolean;
  status: 'idle' | 'syncing' | 'receiving' | 'error';
  snr: number | null;
  signalStrength: number;
  errorMessage: string | null;
}

type Action =
  | { type: 'START' }
  | { type: 'STOP' }
  | { type: 'SET_SNR'; snr: number | null; strength: number }
  | { type: 'SET_STATUS'; status: ProcessorState['status'] }
  | { type: 'ERROR'; message: string };

function reducer(state: ProcessorState, action: Action): ProcessorState {
  switch (action.type) {
    case 'START':      return { ...state, isRecording: true, errorMessage: null, status: 'syncing' };
    case 'STOP':       return { ...state, isRecording: false, status: 'idle', snr: null, signalStrength: 0 };
    case 'SET_SNR':    return { ...state, snr: action.snr, signalStrength: action.strength };
    case 'SET_STATUS': return { ...state, status: action.status };
    case 'ERROR':      return { ...state, isRecording: false, status: 'error', errorMessage: action.message };
    default:           return state;
  }
}

const initialState: ProcessorState = {
  isRecording: false, status: 'idle', snr: null, signalStrength: 0, errorMessage: null,
};

export function useMultiRTTYProcessor(
  onText: (sessionId: string, chars: string) => void,
) {
  const [state, dispatch] = useReducer(reducer, initialState);

  const onTextRef = useRef(onText);
  useEffect(() => { onTextRef.current = onText; }, [onText]);

  const audioContextRef = useRef<AudioContext | null>(null);
  const streamRef       = useRef<MediaStream | null>(null);
  const sourceRef       = useRef<MediaStreamAudioSourceNode | null>(null);
  const processorRef    = useRef<ScriptProcessorNode | null>(null);
  const analyserRef     = useRef<AnalyserNode | null>(null);
  const snrIntervalRef  = useRef<ReturnType<typeof setInterval> | null>(null);

  // id → decoder (live instances, created/destroyed as sessions come and go)
  const decodersRef = useRef<Map<string, RTTYDecoder>>(new Map());
  // id → config (source of truth for recreating decoders on restart)
  const configsRef  = useRef<Map<string, RTTYConfig>>(new Map());
  // which session's config to use for SNR
  const activeIdRef = useRef<string>('');

  const getAnalyser = useCallback(() => analyserRef.current, []);

  // ── Session management ────────────────────────────────────────────────────

  const addSession = useCallback((id: string, config: RTTYConfig) => {
    configsRef.current.set(id, { ...config });
    if (audioContextRef.current) {
      decodersRef.current.set(id, new RTTYDecoder(audioContextRef.current.sampleRate, config));
    }
  }, []);

  const removeSession = useCallback((id: string) => {
    configsRef.current.delete(id);
    decodersRef.current.delete(id);
  }, []);

  const updateSessionConfig = useCallback((id: string, config: RTTYConfig) => {
    configsRef.current.set(id, { ...config });
    decodersRef.current.get(id)?.updateConfig(config);
  }, []);

  const resetSession = useCallback((id: string) => {
    decodersRef.current.get(id)?.reset();
  }, []);

  const setActiveSession = useCallback((id: string) => {
    activeIdRef.current = id;
  }, []);

  // ── SNR ──────────────────────────────────────────────────────────────────

  const computeSNR = useCallback(() => {
    const analyser = analyserRef.current;
    if (!analyser) return;

    const buf = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(buf);

    const nyquist  = audioContextRef.current!.sampleRate / 2;
    const hzPerBin = nyquist / analyser.frequencyBinCount;

    const cfg = configsRef.current.get(activeIdRef.current);
    if (!cfg) return;

    const halfShift = cfg.carrierShift / 2;
    const markF  = cfg.reverseShift ? cfg.centerFreq + halfShift : cfg.centerFreq - halfShift;
    const spaceF = cfg.reverseShift ? cfg.centerFreq - halfShift : cfg.centerFreq + halfShift;
    const bw = cfg.baudRate;

    const bandEnergy = (lo: number, hi: number): number => {
      const b0 = Math.max(0, Math.round(lo / hzPerBin));
      const b1 = Math.min(buf.length - 1, Math.round(hi / hzPerBin));
      if (b1 <= b0) return 0;
      let sum = 0;
      for (let k = b0; k <= b1; k++) sum += buf[k];
      return sum / (b1 - b0 + 1);
    };

    const signalE = Math.max(
      bandEnergy(markF - bw, markF + bw),
      bandEnergy(spaceF - bw, spaceF + bw),
    );
    const noiseE = (
      bandEnergy(Math.max(0, spaceF - bw * 5), Math.max(0, spaceF - bw * 2)) +
      bandEnergy(markF + bw * 2, markF + bw * 5)
    ) / 2;

    const strength = signalE / 255;
    const snr = noiseE > 1 ? 20 * Math.log10(signalE / noiseE) : null;

    dispatch({ type: 'SET_SNR', snr, strength });
    dispatch({ type: 'SET_STATUS', status: strength > 0.15 ? 'receiving' : 'syncing' });
  }, []);

  // ── Recording ─────────────────────────────────────────────────────────────

  const startRecording = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      streamRef.current = stream;

      const ctx = new (window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
      audioContextRef.current = ctx;
      const sampleRate = ctx.sampleRate;

      // Recreate all decoders with the real sample rate
      decodersRef.current.clear();
      configsRef.current.forEach((config, id) => {
        decodersRef.current.set(id, new RTTYDecoder(sampleRate, config));
      });

      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.75;
      analyserRef.current = analyser;

      const source = ctx.createMediaStreamSource(stream);
      sourceRef.current = source;

      const processor = ctx.createScriptProcessor(4096, 1, 1);
      processorRef.current = processor;

      // Fan out audio to every active decoder
      processor.onaudioprocess = (e) => {
        const input = e.inputBuffer.getChannelData(0);
        decodersRef.current.forEach((decoder, id) => {
          const text = decoder.processSamples(input);
          if (text) onTextRef.current(id, text);
        });
      };

      source.connect(analyser);
      source.connect(processor);
      processor.connect(ctx.destination);

      snrIntervalRef.current = setInterval(computeSNR, 200);
      dispatch({ type: 'START' });
    } catch (err) {
      dispatch({ type: 'ERROR', message: err instanceof Error ? err.message : 'Microphone access failed' });
    }
  }, [computeSNR]);

  const stopRecording = useCallback(() => {
    if (snrIntervalRef.current) { clearInterval(snrIntervalRef.current); snrIntervalRef.current = null; }
    processorRef.current?.disconnect();
    sourceRef.current?.disconnect();
    analyserRef.current?.disconnect();
    streamRef.current?.getTracks().forEach(t => t.stop());
    audioContextRef.current?.close();

    processorRef.current   = null;
    sourceRef.current      = null;
    analyserRef.current    = null;
    streamRef.current      = null;
    audioContextRef.current = null;

    decodersRef.current.forEach(d => d.reset());
    dispatch({ type: 'STOP' });
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (snrIntervalRef.current) clearInterval(snrIntervalRef.current);
      processorRef.current?.disconnect();
      sourceRef.current?.disconnect();
      analyserRef.current?.disconnect();
      streamRef.current?.getTracks().forEach(t => t.stop());
      audioContextRef.current?.close();
    };
  }, []);

  return {
    state,
    startRecording,
    stopRecording,
    addSession,
    removeSession,
    updateSessionConfig,
    resetSession,
    setActiveSession,
    getAnalyser,
  };
}
