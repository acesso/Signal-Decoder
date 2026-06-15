import { useEffect, useRef, useState, useCallback } from 'react';
import {
  MFSKDecoder, MFSKChannel, MFSKSymbol, MFSKWord, MFSKDecoderOptions,
} from '@/lib/mfsk/decoder';

export type { MFSKSymbol, MFSKWord };

export interface MFSKProcessorState {
  isRecording:  boolean;
  isSupported:  boolean;
  error:        string | null;
  totalSymbols: number;
  clearId:      number; // increments every time the symbol buffer is wiped
}

const MAX_HISTORY = 2048;

export function useMFSKProcessor(
  channels:       MFSKChannel[],
  baudRate:       number,
  squelch:        number,
  decoderOptions: Partial<MFSKDecoderOptions> = {},
) {
  const [state, setState] = useState<MFSKProcessorState>({
    isRecording:  false,
    isSupported:  false,
    error:        null,
    totalSymbols: 0,
    clearId:      0,
  });
  const clearIdRef = useRef(0);

  const audioContextRef  = useRef<AudioContext | null>(null);
  const analyserRef      = useRef<AnalyserNode | null>(null);
  const streamRef        = useRef<MediaStream | null>(null);
  const decoderRef       = useRef<MFSKDecoder | null>(null);
  const processorNodeRef = useRef<ScriptProcessorNode | null>(null);
  const animFrameRef     = useRef<number | null>(null);
  const fftBufRef        = useRef<Uint8Array<ArrayBuffer> | null>(null);

  const symbolsRef = useRef<MFSKSymbol[]>([]);
  const wordsRef   = useRef<MFSKWord[]>([]);
  const channelsRef      = useRef(channels);
  const baudRateRef      = useRef(baudRate);
  const squelchRef       = useRef(squelch);
  const decoderOptsRef   = useRef(decoderOptions);
  const symCountRef      = useRef(0);

  // ── Param sync ────────────────────────────────────────────────────────────

  // Wipe accumulated symbols and notify the component via clearId bump.
  // Called whenever a parameter change makes old symbols invalid.
  const flushSymbols = () => {
    symbolsRef.current  = [];
    wordsRef.current    = [];
    symCountRef.current = 0;
    decoderRef.current?.reset();
    clearIdRef.current++;
    setState(prev => ({ ...prev, totalSymbols: 0, clearId: clearIdRef.current }));
  };

  useEffect(() => {
    channelsRef.current = channels;
    if (decoderRef.current) { decoderRef.current.updateChannels(channels); flushSymbols(); }
  }, [channels]);

  useEffect(() => {
    baudRateRef.current = baudRate;
    if (decoderRef.current) { decoderRef.current.updateBaudRate(baudRate); flushSymbols(); }
  }, [baudRate]);

  useEffect(() => {
    squelchRef.current = squelch;
    if (squelch === 0) decoderRef.current?.setSquelch(0);
  }, [squelch]);

  useEffect(() => {
    decoderOptsRef.current = decoderOptions;
    if (decoderRef.current) { decoderRef.current.updateOptions(decoderOptions); flushSymbols(); }
  }, [decoderOptions]);

  // ── Support check ─────────────────────────────────────────────────────────

  useEffect(() => {
    const ok = typeof window !== 'undefined'
      && 'AudioContext' in window
      && !!navigator.mediaDevices?.getUserMedia;
    setState(prev => ({ ...prev, isSupported: ok }));
  }, []);

  // ── Audio processing ──────────────────────────────────────────────────────

  const processAudioChunk = useCallback((input: Float32Array) => {
    if (!decoderRef.current) return;

    const sql     = squelchRef.current;
    const analyser = analyserRef.current;
    if (sql > 0 && analyser && channelsRef.current.length > 0) {
      const binCount = analyser.frequencyBinCount;
      if (!fftBufRef.current || fftBufRef.current.length !== binCount) {
        fftBufRef.current = new Uint8Array(binCount) as Uint8Array<ArrayBuffer>;
      }
      analyser.getByteFrequencyData(fftBufRef.current);
      const nq  = analyser.context.sampleRate / 2;
      const thr = sql / 100;

      const maxPow = channelsRef.current.reduce((mx, ch) => {
        const bin = Math.min(Math.round((ch.freq / nq) * binCount), binCount - 1);
        return Math.max(mx, (fftBufRef.current![bin] ?? 0) / 255);
      }, 0);

      decoderRef.current.setSquelch(maxPow < thr ? thr : 0);
    }

    decoderRef.current.processSamples(input);
  }, []);

  // ── Start / Stop ──────────────────────────────────────────────────────────

  const startRecording = async () => {
    try {
      if (!state.isSupported) throw new Error('Web Audio API not supported');

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      streamRef.current = stream;

      const audioContext = new AudioContext();
      audioContextRef.current = audioContext;

      const source   = audioContext.createMediaStreamSource(stream);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 4096;
      analyserRef.current = analyser;
      source.connect(analyser);

      symbolsRef.current = [];
      wordsRef.current   = [];
      symCountRef.current = 0;

      const decoder = new MFSKDecoder(
        audioContext.sampleRate,
        channelsRef.current,
        baudRateRef.current,
        decoderOptsRef.current,
      );

      decoder.onSymbol = (sym) => {
        symbolsRef.current = symbolsRef.current.length >= MAX_HISTORY
          ? [...symbolsRef.current.slice(1), sym]
          : [...symbolsRef.current, sym];
        symCountRef.current++;
        if (symCountRef.current % 8 === 0) {
          setState(prev => ({ ...prev, totalSymbols: symCountRef.current }));
        }
      };

      decoder.onWord = (word) => {
        wordsRef.current = wordsRef.current.length >= MAX_HISTORY
          ? [...wordsRef.current.slice(1), word]
          : [...wordsRef.current, word];
      };

      decoderRef.current = decoder;

      let usingProc = false;
      try {
        if (typeof audioContext.createScriptProcessor === 'function') {
          const proc = audioContext.createScriptProcessor(4096, 1, 1);
          processorNodeRef.current = proc;
          proc.onaudioprocess = (e) => processAudioChunk(e.inputBuffer.getChannelData(0));
          analyser.connect(proc);
          proc.connect(audioContext.destination);
          usingProc = true;
        }
      } catch { /* fallthrough */ }

      if (!usingProc) {
        const gain = audioContext.createGain();
        gain.gain.value = 0.001;
        analyser.connect(gain);
        gain.connect(audioContext.destination);
        const poll = () => {
          if (!analyserRef.current) return;
          const buf = new Float32Array(analyser.fftSize);
          analyser.getFloatTimeDomainData(buf);
          processAudioChunk(buf);
          animFrameRef.current = requestAnimationFrame(poll);
        };
        animFrameRef.current = requestAnimationFrame(poll);
      }

      setState(prev => ({ ...prev, isRecording: true, error: null, totalSymbols: 0 }));
    } catch (err) {
      setState(prev => ({
        ...prev,
        error: err instanceof Error ? err.message : 'Failed to access microphone',
        isRecording: false,
      }));
    }
  };

  const stopRecording = useCallback(() => {
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
    if (processorNodeRef.current) { processorNodeRef.current.disconnect(); processorNodeRef.current = null; }
    if (analyserRef.current)      { analyserRef.current.disconnect();      analyserRef.current      = null; }
    if (audioContextRef.current)  { audioContextRef.current.close();       audioContextRef.current  = null; }
    if (animFrameRef.current)     { cancelAnimationFrame(animFrameRef.current); animFrameRef.current = null; }
    decoderRef.current = null;
    setState(prev => ({ ...prev, isRecording: false }));
  }, []);

  const clearSymbols = useCallback(() => {
    symbolsRef.current  = [];
    wordsRef.current    = [];
    symCountRef.current = 0;
    decoderRef.current?.reset();
    clearIdRef.current++;
    setState(prev => ({ ...prev, totalSymbols: 0, clearId: clearIdRef.current }));
  }, []);

  const getAnalyser     = useCallback((): AnalyserNode | null => analyserRef.current,     []);
  const getSymbols      = useCallback((): MFSKSymbol[]         => symbolsRef.current,      []);
  const getWords        = useCallback((): MFSKWord[]            => wordsRef.current,        []);
  const getSymbolCount  = useCallback((): number               => symCountRef.current,     []);

  useEffect(() => () => { stopRecording(); }, [stopRecording]);

  return { state, startRecording, stopRecording, clearSymbols, getAnalyser, getSymbols, getWords, getSymbolCount };
}
