import { useEffect, useRef, useState, useCallback } from 'react';
import { CWDecoder, CWStats } from '@/lib/cw/decoder';

export interface TextToken {
  text:    string;
  channel: 0 | 1;
}

export interface CWProcessorState {
  isRecording: boolean;
  isSupported: boolean;
  error:       string | null;
  stats:       CWStats | null;
  stats2:      CWStats | null;
  tokens:      TextToken[];
}

// Squelch is applied per-buffer in processAudioChunk via FFT, not via a fixed amplitude
// threshold — this ensures the visual squelch line on the canvas directly gates the decoder.

// squelch: 0–100 (0 = open, 100 = completely closed)
// Internally maps to 0–0.05 on a square curve so the low end is sensitive
// and the high end only passes strong signals.
export function useCWProcessor(
  toneFreq:          number,
  squelch:           number,
  adaptiveDitLength: boolean,
  dualMode:          boolean,
  toneFreq2:         number,
  wpm:               number,
  filterQ:           number,
) {
  const [state, setState] = useState<CWProcessorState>({
    isRecording: false,
    isSupported: false,
    error:       null,
    stats:       null,
    stats2:      null,
    tokens:      [],
  });

  const audioContextRef  = useRef<AudioContext | null>(null);
  const analyserRef      = useRef<AnalyserNode | null>(null);
  const streamRef        = useRef<MediaStream | null>(null);
  const decoderRef       = useRef<CWDecoder | null>(null);
  const decoderRef2      = useRef<CWDecoder | null>(null);
  const processorNodeRef = useRef<ScriptProcessorNode | null>(null);
  const animFrameRef     = useRef<number | null>(null);

  const toneFreqRef      = useRef(toneFreq);
  const squelchRef       = useRef(squelch);
  const fftBufRef        = useRef<Uint8Array<ArrayBuffer> | null>(null); // pre-allocated FFT scratch buffer
  const adaptiveDitRef   = useRef(adaptiveDitLength);
  const dualModeRef      = useRef(dualMode);
  const toneFreq2Ref     = useRef(toneFreq2);
  const wpmRef           = useRef(wpm);
  const filterQRef       = useRef(filterQ);
  const tokensRef        = useRef<TextToken[]>([]);

  // Visualizer callbacks — set by the component, called from audio processing
  const onElementRef  = useRef<((type: 'dot' | 'dash') => void) | null>(null);
  const onCharRef     = useRef<((char: string, symbol: string) => void) | null>(null);
  const onElementRef2 = useRef<((type: 'dot' | 'dash') => void) | null>(null);
  const onCharRef2    = useRef<((char: string, symbol: string) => void) | null>(null);

  // ── Sync params to live decoders ───────────────────────────────────────────

  useEffect(() => {
    toneFreqRef.current = toneFreq;
    decoderRef.current?.setToneFreq(toneFreq);
  }, [toneFreq]);

  useEffect(() => {
    squelchRef.current = squelch;
    if (squelch === 0) {
      // Squelch disabled — ensure decoders are fully open
      decoderRef.current?.setSquelch(0);
      decoderRef2.current?.setSquelch(0);
    }
    // squelch > 0 is applied per-buffer in processAudioChunk via FFT
  }, [squelch]);

  useEffect(() => {
    adaptiveDitRef.current = adaptiveDitLength;
    decoderRef.current?.setAdaptiveDitLength(adaptiveDitLength);
    decoderRef2.current?.setAdaptiveDitLength(adaptiveDitLength);
  }, [adaptiveDitLength]);

  // wpm effect runs AFTER adaptiveDitLength so adaptiveDitRef is already updated.
  // Only push the manual WPM to the decoder when adaptive tracking is off.
  useEffect(() => {
    wpmRef.current = wpm;
    if (!adaptiveDitRef.current) {
      decoderRef.current?.setWpm(wpm);
      decoderRef2.current?.setWpm(wpm);
    }
  }, [wpm]);

  useEffect(() => {
    filterQRef.current = filterQ;
    decoderRef.current?.setFilterQ(filterQ);
    decoderRef2.current?.setFilterQ(filterQ);
  }, [filterQ]);

  useEffect(() => {
    toneFreq2Ref.current = toneFreq2;
    decoderRef2.current?.setToneFreq(toneFreq2);
  }, [toneFreq2]);

  // Manage the second decoder dynamically when dualMode toggles during recording
  useEffect(() => {
    dualModeRef.current = dualMode;
    if (dualMode && !decoderRef2.current && audioContextRef.current) {
      const sampleRate = audioContextRef.current.sampleRate;
      const d2 = new CWDecoder(sampleRate, toneFreq2Ref.current, wpmRef.current, filterQRef.current);
      d2.setAdaptiveDitLength(adaptiveDitRef.current);
      d2.onText         = (chars) => { tokensRef.current = [...tokensRef.current, { text: chars, channel: 1 }]; };
      d2.onElement      = (type)       => onElementRef2.current?.(type);
      d2.onCharDecoded  = (char, sym)  => onCharRef2.current?.(char, sym);
      decoderRef2.current = d2;
    } else if (!dualMode) {
      decoderRef2.current = null;
    }
  }, [dualMode]);

  // ── Support check ──────────────────────────────────────────────────────────

  useEffect(() => {
    const ok = typeof window !== 'undefined'
      && 'AudioContext' in window
      && typeof navigator !== 'undefined'
      && !!navigator.mediaDevices?.getUserMedia;
    setState(prev => ({ ...prev, isSupported: ok }));
  }, []);

  // ── Audio processing ───────────────────────────────────────────────────────

  const processAudioChunk = useCallback((input: Float32Array) => {
    if (!decoderRef.current) return;

    // Apply squelch from the FFT — same data the spectrum canvas draws, so the
    // visual squelch line directly corresponds to what the decoder will gate.
    const sql      = squelchRef.current;
    const analyser = analyserRef.current;
    if (sql > 0 && analyser) {
      const binCount = analyser.frequencyBinCount;
      if (!fftBufRef.current || fftBufRef.current.length !== binCount) {
        fftBufRef.current = new Uint8Array(binCount) as Uint8Array<ArrayBuffer>;
      }
      analyser.getByteFrequencyData(fftBufRef.current);
      const nq  = analyser.context.sampleRate / 2;
      const thr = sql / 100; // visual fraction: same scale as canvas (0–1)

      const bin1 = Math.min(Math.round(toneFreqRef.current / nq * binCount), binCount - 1);
      decoderRef.current.setSquelch(fftBufRef.current[bin1] / 255 < thr ? Infinity : 0);

      if (decoderRef2.current) {
        const bin2 = Math.min(Math.round(toneFreq2Ref.current / nq * binCount), binCount - 1);
        decoderRef2.current.setSquelch(fftBufRef.current[bin2] / 255 < thr ? Infinity : 0);
      }
    }

    const stats  = decoderRef.current.processSamples(input);
    const stats2 = decoderRef2.current?.processSamples(input) ?? null;
    setState(prev => ({ ...prev, stats, stats2, tokens: tokensRef.current }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Start / stop ───────────────────────────────────────────────────────────

  const startRecording = async () => {
    try {
      if (!state.isSupported) throw new Error('Web Audio API not supported');

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      streamRef.current = stream;

      const audioContext = new AudioContext();
      audioContextRef.current = audioContext;

      const source  = audioContext.createMediaStreamSource(stream);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 2048;
      analyserRef.current = analyser;
      source.connect(analyser);

      const sampleRate = audioContext.sampleRate;
      tokensRef.current = [];

      // Primary decoder — squelch starts open; processAudioChunk applies it per-buffer via FFT
      const d1 = new CWDecoder(sampleRate, toneFreqRef.current, wpmRef.current, filterQRef.current);
      d1.setAdaptiveDitLength(adaptiveDitRef.current);
      d1.onText        = (chars) => { tokensRef.current = [...tokensRef.current, { text: chars, channel: 0 }]; };
      d1.onElement     = (type)      => onElementRef.current?.(type);
      d1.onCharDecoded = (char, sym) => onCharRef.current?.(char, sym);
      decoderRef.current = d1;

      // Secondary decoder (only when dualMode is on at start time)
      if (dualModeRef.current) {
        const d2 = new CWDecoder(sampleRate, toneFreq2Ref.current, wpmRef.current, filterQRef.current);
        d2.setAdaptiveDitLength(adaptiveDitRef.current);
        d2.onText        = (chars) => { tokensRef.current = [...tokensRef.current, { text: chars, channel: 1 }]; };
        d2.onElement     = (type)      => onElementRef2.current?.(type);
        d2.onCharDecoded = (char, sym) => onCharRef2.current?.(char, sym);
        decoderRef2.current = d2;
      }

      let usingProcessor = false;
      try {
        if (typeof audioContext.createScriptProcessor === 'function') {
          const proc = audioContext.createScriptProcessor(4096, 1, 1);
          processorNodeRef.current = proc;
          proc.onaudioprocess = (e) => {
            processAudioChunk(e.inputBuffer.getChannelData(0));
          };
          analyser.connect(proc);
          proc.connect(audioContext.destination);
          usingProcessor = true;
        }
      } catch { /* fall through to RAF */ }

      if (!usingProcessor) {
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

      setState(prev => ({ ...prev, isRecording: true, error: null, tokens: [] }));
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
    if (analyserRef.current)      { analyserRef.current.disconnect();      analyserRef.current = null; }
    if (audioContextRef.current)  { audioContextRef.current.close();       audioContextRef.current = null; }
    if (animFrameRef.current)     { cancelAnimationFrame(animFrameRef.current); animFrameRef.current = null; }
    decoderRef.current  = null;
    decoderRef2.current = null;
    setState(prev => ({ ...prev, isRecording: false }));
  }, []);

  const clearText = useCallback(() => {
    tokensRef.current = [];
    setState(prev => ({ ...prev, tokens: [] }));
  }, []);

  const resetDecoder = useCallback(() => {
    decoderRef.current?.reset();
    decoderRef2.current?.reset();
    tokensRef.current = [];
    setState(prev => ({ ...prev, stats: null, stats2: null, tokens: [] }));
  }, []);

  const getAnalyser = useCallback((): AnalyserNode | null => analyserRef.current, []);

  useEffect(() => () => { stopRecording(); }, [stopRecording]);

  return {
    state,
    startRecording, stopRecording, clearText, resetDecoder, getAnalyser,
    onElementRef, onCharRef,
    onElementRef2, onCharRef2,
  };
}
