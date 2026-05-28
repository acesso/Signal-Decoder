import { useEffect, useRef, useState, useCallback } from 'react';
import { CWDecoder, CWStats } from '@/lib/cw/decoder';

export interface CWProcessorState {
  isRecording: boolean;
  isSupported: boolean;
  error: string | null;
  stats: CWStats | null;
  text: string;
}

// squelch: 0–100 (0 = open, 100 = completely closed)
// Internally maps to 0–0.05 on a square curve so the low end is sensitive
// and the high end only passes strong signals.
export function useCWProcessor(toneFreq: number, squelch: number) {
  const [state, setState] = useState<CWProcessorState>({
    isRecording: false,
    isSupported: false,
    error: null,
    stats: null,
    text: '',
  });

  const audioContextRef   = useRef<AudioContext | null>(null);
  const analyserRef       = useRef<AnalyserNode | null>(null);
  const streamRef         = useRef<MediaStream | null>(null);
  const decoderRef        = useRef<CWDecoder | null>(null);
  const processorNodeRef  = useRef<ScriptProcessorNode | null>(null);
  const animFrameRef      = useRef<number | null>(null);
  const toneFreqRef       = useRef(toneFreq);
  const squelchRef        = useRef(squelch);
  const textRef           = useRef('');

  // Keep toneFreq + squelch in sync and update live decoder
  useEffect(() => {
    toneFreqRef.current = toneFreq;
    decoderRef.current?.setToneFreq(toneFreq);
  }, [toneFreq]);

  useEffect(() => {
    squelchRef.current = squelch;
    const threshold = (squelch / 100) * (squelch / 100) * 0.05; // square curve → 0–0.05
    decoderRef.current?.setSquelch(threshold);
  }, [squelch]);

  useEffect(() => {
    const ok = typeof window !== 'undefined'
      && 'AudioContext' in window
      && typeof navigator !== 'undefined'
      && !!navigator.mediaDevices?.getUserMedia;
    setState(prev => ({ ...prev, isSupported: ok }));
  }, []);

  const processAudioChunk = useCallback((input: Float32Array, sampleRate: number) => {
    if (!decoderRef.current) return;
    const stats = decoderRef.current.processSamples(input);
    setState(prev => ({ ...prev, stats, text: textRef.current }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

      textRef.current  = '';
      decoderRef.current = new CWDecoder(sampleRate, toneFreqRef.current);
      decoderRef.current.setSquelch((squelchRef.current / 100) * (squelchRef.current / 100) * 0.05);
      decoderRef.current.onText = (chars) => {
        textRef.current += chars;
      };

      let usingProcessor = false;
      try {
        if (typeof audioContext.createScriptProcessor === 'function') {
          const proc = audioContext.createScriptProcessor(4096, 1, 1);
          processorNodeRef.current = proc;
          proc.onaudioprocess = (e) => {
            processAudioChunk(e.inputBuffer.getChannelData(0), sampleRate);
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
          processAudioChunk(buf, sampleRate);
          animFrameRef.current = requestAnimationFrame(poll);
        };
        animFrameRef.current = requestAnimationFrame(poll);
      }

      setState(prev => ({ ...prev, isRecording: true, error: null, text: '' }));
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
    setState(prev => ({ ...prev, isRecording: false }));
  }, []);

  const clearText = useCallback(() => {
    textRef.current = '';
    setState(prev => ({ ...prev, text: '' }));
  }, []);

  const resetDecoder = useCallback(() => {
    decoderRef.current?.reset();
    textRef.current = '';
    setState(prev => ({ ...prev, stats: null, text: '' }));
  }, []);

  const getAnalyser = useCallback((): AnalyserNode | null => analyserRef.current, []);

  useEffect(() => () => { stopRecording(); }, [stopRecording]);

  return { state, startRecording, stopRecording, clearText, resetDecoder, getAnalyser };
}
