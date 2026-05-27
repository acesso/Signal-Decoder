import { useEffect, useRef, useState, useCallback } from 'react';
import { SSTVDecoder, DecoderStats } from '@/lib/sstv/decoder';
import { VISDetector } from '@/lib/sstv/vis-detector';
import { SSTV_MODES } from '@/lib/sstv/constants';

export type SSTVMode = keyof typeof SSTV_MODES;

export interface CapturedImage {
  id: string;
  mode: SSTVMode;
  width: number;
  height: number;
  data: Uint8ClampedArray;
  thumbnailUrl: string;
  captureTime: Date;
  duration: number; // seconds
}

export interface AudioProcessorState {
  isRecording: boolean;
  isSupported: boolean;
  error: string | null;
  stats: DecoderStats | null;
  // VIS / auto-detect
  isListeningForVIS: boolean;
  detectionStatus: string;
  activeMode: SSTVMode;
  capturedImages: CapturedImage[];
}

const SILENCE_THRESHOLD = 0.008;
const SILENCE_DURATION_MS = 2500;

function makeThumbnail(data: Uint8ClampedArray, width: number, height: number): string {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  const clamped = new Uint8ClampedArray(data.buffer as ArrayBuffer, data.byteOffset, data.byteLength);
  ctx.putImageData(new ImageData(clamped, width, height), 0, 0);
  return canvas.toDataURL('image/jpeg', 0.7);
}

export function useAudioProcessor(manualMode: SSTVMode = 'ROBOT36', autoDetect = false) {
  const [state, setState] = useState<AudioProcessorState>({
    isRecording: false,
    isSupported: false,
    error: null,
    stats: null,
    isListeningForVIS: false,
    detectionStatus: '',
    activeMode: manualMode,
    capturedImages: [],
  });

  const audioContextRef    = useRef<AudioContext | null>(null);
  const analyserRef        = useRef<AnalyserNode | null>(null);
  const streamRef          = useRef<MediaStream | null>(null);
  const decoderRef         = useRef<SSTVDecoder | null>(null);
  const visDetectorRef     = useRef<VISDetector | null>(null);
  const animationFrameRef  = useRef<number | null>(null);
  const processorNodeRef   = useRef<ScriptProcessorNode | null>(null);

  // Refs for values used inside audio callbacks (avoids stale closures)
  const autoDetectRef      = useRef(autoDetect);
  const activeModeRef      = useRef<SSTVMode>(manualMode);
  const isDecodingRef      = useRef(false);      // true while decoder is running
  const decodingStartRef   = useRef<number>(0);  // Date.now() when decode started
  const silenceMsRef       = useRef(0);          // accumulated silence ms
  const capturedImagesRef  = useRef<CapturedImage[]>([]);

  useEffect(() => { autoDetectRef.current = autoDetect; }, [autoDetect]);

  // Sync activeMode when manual mode changes and not in auto-detect
  useEffect(() => {
    if (!autoDetect) {
      activeModeRef.current = manualMode;
      setState(prev => ({ ...prev, activeMode: manualMode }));
    }
  }, [manualMode, autoDetect]);

  useEffect(() => {
    const hasAudioContext  = typeof window !== 'undefined' && 'AudioContext' in window;
    const hasMediaDevices  = typeof navigator !== 'undefined' &&
                             navigator.mediaDevices &&
                             typeof navigator.mediaDevices.getUserMedia === 'function';
    setState(prev => ({ ...prev, isSupported: hasAudioContext && hasMediaDevices }));
  }, []);

  // ── Audio callback (called from ScriptProcessor or RAF) ──────────────────────

  const processAudioChunk = useCallback((inputData: Float32Array, sampleRate: number) => {
    // RMS for silence detection
    let rmsSum = 0;
    for (let i = 0; i < inputData.length; i++) rmsSum += inputData[i] * inputData[i];
    const rms = Math.sqrt(rmsSum / inputData.length);
    const chunkMs = (inputData.length / sampleRate) * 1000;

    if (autoDetectRef.current && !isDecodingRef.current) {
      // ── Listening for VIS ──
      if (visDetectorRef.current) {
        const result = visDetectorRef.current.process(inputData);
        if (result.detected && result.modeName) {
          const detectedMode = result.modeName;
          activeModeRef.current = detectedMode;
          isDecodingRef.current = true;
          decodingStartRef.current = Date.now();
          silenceMsRef.current = 0;

          // Create decoder for detected mode
          decoderRef.current = new SSTVDecoder(sampleRate, detectedMode);
          decoderRef.current.start();

          setState(prev => ({
            ...prev,
            activeMode: detectedMode,
            isListeningForVIS: false,
            detectionStatus: `VIS detected: ${SSTV_MODES[detectedMode].name}`,
          }));
        }
      }
    } else if (isDecodingRef.current && decoderRef.current) {
      // ── Decoding image ──
      decoderRef.current.processSamples(inputData);

      // Silence detection
      if (rms < SILENCE_THRESHOLD) {
        silenceMsRef.current += chunkMs;
        if (silenceMsRef.current >= SILENCE_DURATION_MS) {
          // End of transmission — capture image
          captureCurrentImage(sampleRate);
        }
      } else {
        silenceMsRef.current = 0;
      }

      const stats = decoderRef.current.getStats();
      const snr   = calculateSNRFromAnalyser(analyserRef.current, audioContextRef.current);
      setState(prev => ({ ...prev, stats: { ...stats, snr } }));
    } else if (!autoDetectRef.current && decoderRef.current) {
      // ── Manual mode: always decoding ──
      decoderRef.current.processSamples(inputData);

      const stats = decoderRef.current.getStats();
      const snr   = calculateSNRFromAnalyser(analyserRef.current, audioContextRef.current);
      setState(prev => ({ ...prev, stats: { ...stats, snr } }));
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const captureCurrentImage = useCallback((sampleRate: number) => {
    if (!decoderRef.current) return;
    const { width, height } = decoderRef.current.getDimensions();
    const rawData    = decoderRef.current.getImageData();
    const dataCopy   = new Uint8ClampedArray(rawData.buffer.slice(rawData.byteOffset, rawData.byteOffset + rawData.byteLength));
    const thumbUrl   = makeThumbnail(dataCopy, width, height);
    const duration   = (Date.now() - decodingStartRef.current) / 1000;
    const mode       = activeModeRef.current;

    const img: CapturedImage = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      mode,
      width,
      height,
      data: dataCopy,
      thumbnailUrl: thumbUrl,
      captureTime: new Date(),
      duration,
    };

    capturedImagesRef.current = [img, ...capturedImagesRef.current];
    isDecodingRef.current = false;
    silenceMsRef.current  = 0;

    if (autoDetectRef.current) {
      // Reset VIS detector to listen for next transmission
      if (visDetectorRef.current) visDetectorRef.current.reset();
      setState(prev => ({
        ...prev,
        stats: null,
        isListeningForVIS: true,
        detectionStatus: 'Listening for VIS…',
        capturedImages: capturedImagesRef.current,
      }));
    } else {
      // In manual mode, restart decoder immediately
      decoderRef.current = new SSTVDecoder(sampleRate, activeModeRef.current);
      decoderRef.current.start();
      isDecodingRef.current = true;
      setState(prev => ({
        ...prev,
        stats: null,
        capturedImages: capturedImagesRef.current,
      }));
    }
  }, []);

  const startRecording = async () => {
    try {
      const hasAudioContext = typeof window !== 'undefined' && 'AudioContext' in window;
      const hasMediaDevices = typeof navigator !== 'undefined' &&
                              navigator.mediaDevices &&
                              typeof navigator.mediaDevices.getUserMedia === 'function';
      if (!hasAudioContext || !hasMediaDevices) {
        throw new Error('Web Audio API not supported in this browser');
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      streamRef.current = stream;

      const audioContext = new AudioContext();
      audioContextRef.current = audioContext;
      console.log(`AudioContext created: ${audioContext.sampleRate} Hz`);

      const source = audioContext.createMediaStreamSource(stream);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 2048;
      analyserRef.current = analyser;
      source.connect(analyser);

      const sampleRate = audioContext.sampleRate;

      if (autoDetectRef.current) {
        visDetectorRef.current = new VISDetector(sampleRate);
        isDecodingRef.current  = false;
        setState(prev => ({
          ...prev,
          isListeningForVIS: true,
          detectionStatus: 'Listening for VIS…',
          activeMode: activeModeRef.current,
        }));
      } else {
        decoderRef.current = new SSTVDecoder(sampleRate, activeModeRef.current);
        decoderRef.current.start();
        isDecodingRef.current = true;
      }

      let useScriptProcessor = false;
      try {
        if (typeof audioContext.createScriptProcessor === 'function') {
          const processor = audioContext.createScriptProcessor(4096, 1, 1);
          processorNodeRef.current = processor;
          processor.onaudioprocess = (event) => {
            processAudioChunk(event.inputBuffer.getChannelData(0), sampleRate);
          };
          analyser.connect(processor);
          processor.connect(audioContext.destination);
          useScriptProcessor = true;
          console.log('Using ScriptProcessorNode');
        }
      } catch { /* fall through */ }

      if (!useScriptProcessor) {
        const silentGain = audioContext.createGain();
        silentGain.gain.value = 0.001;
        analyser.connect(silentGain);
        silentGain.connect(audioContext.destination);

        const poll = () => {
          if (!analyserRef.current) return;
          const buf = new Float32Array(analyser.fftSize);
          analyser.getFloatTimeDomainData(buf);
          processAudioChunk(buf, sampleRate);
          animationFrameRef.current = requestAnimationFrame(poll);
        };
        console.log('Using RAF polling');
        animationFrameRef.current = requestAnimationFrame(poll);
      }

      setState(prev => ({ ...prev, isRecording: true, error: null }));
    } catch (err) {
      const error = err instanceof Error ? err.message : 'Failed to access microphone';
      setState(prev => ({ ...prev, error, isRecording: false }));
    }
  };

  const stopRecording = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    }
    if (processorNodeRef.current) { processorNodeRef.current.disconnect(); processorNodeRef.current = null; }
    if (analyserRef.current)      { analyserRef.current.disconnect();      analyserRef.current = null; }
    if (audioContextRef.current)  { audioContextRef.current.close();       audioContextRef.current = null; }
    if (animationFrameRef.current){ cancelAnimationFrame(animationFrameRef.current); animationFrameRef.current = null; }
    if (decoderRef.current)       { decoderRef.current.stop(); }
    if (visDetectorRef.current)   { visDetectorRef.current.reset(); }
    isDecodingRef.current = false;
    setState(prev => ({ ...prev, isRecording: false, isListeningForVIS: false, detectionStatus: '' }));
  };

  const resetDecoder = () => {
    if (decoderRef.current) {
      decoderRef.current.reset();
      if (state.isRecording && !autoDetectRef.current) decoderRef.current.start();
    }
    setState(prev => ({ ...prev, stats: null }));
  };

  const clearImages = () => {
    capturedImagesRef.current = [];
    setState(prev => ({ ...prev, capturedImages: [] }));
  };

  const getImageData = (): Uint8ClampedArray | null =>
    decoderRef.current ? decoderRef.current.getImageData() : null;

  const getDimensions = () => {
    if (decoderRef.current) return decoderRef.current.getDimensions();
    const cfg = SSTV_MODES[activeModeRef.current];
    return { width: cfg.width, height: cfg.height };
  };

  const getAnalyser = (): AnalyserNode | null => analyserRef.current;

  useEffect(() => () => { stopRecording(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return {
    state,
    startRecording,
    stopRecording,
    resetDecoder,
    clearImages,
    getImageData,
    getDimensions,
    getAnalyser,
  };
}

function calculateSNRFromAnalyser(
  analyser: AnalyserNode | null,
  audioContext: AudioContext | null,
): number | null {
  if (!analyser || !audioContext) return null;
  const bufLen   = analyser.frequencyBinCount;
  const data     = new Uint8Array(bufLen);
  analyser.getByteFrequencyData(data);
  const nyquist  = audioContext.sampleRate / 2;
  const freqToBin = (f: number) => Math.floor((f / nyquist) * bufLen);

  const sum = (lo: number, hi: number) => {
    let p = 0, n = 0;
    for (let i = freqToBin(lo); i <= freqToBin(hi); i++) { p += data[i] * data[i]; n++; }
    return n > 0 ? p / n : 1;
  };

  const sig  = sum(1200, 2300);
  const noise = (sum(300, 1000) + sum(2500, 4000)) / 2;
  return 10 * Math.log10(Math.max(sig, 1) / Math.max(noise, 1));
}
