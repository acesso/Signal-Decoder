'use client';

import { useRef, useCallback, useReducer, useEffect } from 'react';
import { RTTYDecoder, RTTYConfig } from '@/lib/rtty/decoder';

export interface RTTYProcessorState {
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
  | { type: 'SET_STATUS'; status: RTTYProcessorState['status'] }
  | { type: 'ERROR'; message: string };

function reducer(state: RTTYProcessorState, action: Action): RTTYProcessorState {
  switch (action.type) {
    case 'START':    return { ...state, isRecording: true, errorMessage: null, status: 'syncing' };
    case 'STOP':     return { ...state, isRecording: false, status: 'idle', snr: null, signalStrength: 0 };
    case 'SET_SNR':  return { ...state, snr: action.snr, signalStrength: action.strength };
    case 'SET_STATUS': return { ...state, status: action.status };
    case 'ERROR':    return { ...state, isRecording: false, status: 'error', errorMessage: action.message };
    default:         return state;
  }
}

const initialState: RTTYProcessorState = {
  isRecording: false,
  status: 'idle',
  snr: null,
  signalStrength: 0,
  errorMessage: null,
};

export function useRTTYProcessor(
  config: RTTYConfig,
  onChar: (char: string) => void,
) {
  const [state, dispatch] = useReducer(reducer, initialState);

  // Stable ref for onChar so effect deps don't retrigger
  const onCharRef = useRef(onChar);
  useEffect(() => { onCharRef.current = onChar; }, [onChar]);

  // Audio infrastructure refs
  const audioContextRef   = useRef<AudioContext | null>(null);
  const streamRef         = useRef<MediaStream | null>(null);
  const sourceRef         = useRef<MediaStreamAudioSourceNode | null>(null);
  const processorRef      = useRef<ScriptProcessorNode | null>(null);
  const analyserRef       = useRef<AnalyserNode | null>(null);
  const decoderRef        = useRef<RTTYDecoder | null>(null);
  const configRef         = useRef<RTTYConfig>(config);
  const snrIntervalRef    = useRef<ReturnType<typeof setInterval> | null>(null);

  // Keep configRef up-to-date and reconfigure live decoder
  useEffect(() => {
    configRef.current = config;
    decoderRef.current?.updateConfig(config);
  }, [config]);

  const getAnalyser = useCallback((): AnalyserNode | null => analyserRef.current, []);

  // SNR estimation using mark/space band energy vs noise bands
  const computeSNR = useCallback(() => {
    const analyser = analyserRef.current;
    if (!analyser) return;

    const buf = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(buf);

    const nyquist = audioContextRef.current!.sampleRate / 2;
    const hzPerBin = nyquist / analyser.frequencyBinCount;

    const cfg = configRef.current;
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
      bandEnergy(markF  - bw, markF  + bw),
      bandEnergy(spaceF - bw, spaceF + bw),
    );

    // Noise in flanking bands
    const noiseE = (
      bandEnergy(Math.max(0, spaceF - bw * 5), Math.max(0, spaceF - bw * 2)) +
      bandEnergy(markF  + bw * 2, markF  + bw * 5)
    ) / 2;

    const strength = signalE / 255;
    const snr = noiseE > 1 ? 20 * Math.log10(signalE / noiseE) : null;

    dispatch({ type: 'SET_SNR', snr, strength });

    if (strength > 0.15) {
      dispatch({ type: 'SET_STATUS', status: 'receiving' });
    } else {
      dispatch({ type: 'SET_STATUS', status: 'syncing' });
    }
  }, []);

  const startRecording = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
      streamRef.current = stream;

      const ctx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
      audioContextRef.current = ctx;

      const sampleRate = ctx.sampleRate;

      decoderRef.current = new RTTYDecoder(sampleRate, configRef.current);

      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.75;
      analyserRef.current = analyser;

      const source = ctx.createMediaStreamSource(stream);
      sourceRef.current = source;

      const bufferSize = 4096;
      const processor = ctx.createScriptProcessor(bufferSize, 1, 1);
      processorRef.current = processor;

      processor.onaudioprocess = (e) => {
        const input = e.inputBuffer.getChannelData(0);
        const text = decoderRef.current?.processSamples(input) ?? '';
        if (text) onCharRef.current(text);
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

    processorRef.current  = null;
    sourceRef.current     = null;
    analyserRef.current   = null;
    streamRef.current     = null;
    audioContextRef.current = null;
    decoderRef.current    = null;

    dispatch({ type: 'STOP' });
  }, []);

  const resetDecoder = useCallback(() => {
    decoderRef.current?.reset();
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (state.isRecording) stopRecording();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { state, startRecording, stopRecording, resetDecoder, getAnalyser };
}
