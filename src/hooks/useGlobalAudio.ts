'use client';

import { useRef, useState, useCallback, useEffect } from 'react';
import type React from 'react';
import { audioRecorder } from '@/lib/audio/ringRecorder';

export interface GlobalAudioState {
  isRecording: boolean;
  isSupported: boolean;
  error: string | null;
}

export function useGlobalAudio(): {
  state: GlobalAudioState;
  analyser: AnalyserNode | null;
  analyserRef: React.RefObject<AnalyserNode | null>;
  start: () => Promise<AnalyserNode | null>;
  stop: () => void;
} {
  const [state, setState] = useState<GlobalAudioState>({
    isRecording: false,
    isSupported: false,
    error: null,
  });

  // Keep analyser in both a ref (for stable identity in callbacks) and
  // state (so consumers re-render when it becomes available / null).
  const analyserRef  = useRef<AnalyserNode | null>(null);
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null);

  const streamRef      = useRef<MediaStream | null>(null);
  const audioCtxRef    = useRef<AudioContext | null>(null);
  const recTapRef      = useRef<ScriptProcessorNode | null>(null);

  // Support check on mount
  useEffect(() => {
    const ok =
      typeof window !== 'undefined' &&
      typeof (window as unknown as { AudioContext?: unknown }).AudioContext !== 'undefined' &&
      typeof navigator !== 'undefined' &&
      typeof navigator.mediaDevices?.getUserMedia === 'function';
    setState(prev => ({ ...prev, isSupported: ok }));
  }, []);

  const stop = useCallback(() => {
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;

    if (recTapRef.current) {
      recTapRef.current.onaudioprocess = null;
      recTapRef.current.disconnect();
      recTapRef.current = null;
    }

    if (analyserRef.current) {
      analyserRef.current.disconnect();
      analyserRef.current = null;
    }
    setAnalyser(null);

    audioCtxRef.current?.close();
    audioCtxRef.current = null;

    setState(prev => ({ ...prev, isRecording: false, error: null }));
  }, []);

  const start = useCallback(async (): Promise<AnalyserNode | null> => {
    try {
      // If already running, stop first
      if (audioCtxRef.current) stop();

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      streamRef.current = stream;

      const ctx = new AudioContext();
      audioCtxRef.current = ctx;

      const node = ctx.createAnalyser();
      node.fftSize = 4096;
      node.smoothingTimeConstant = 0.75;

      const source = ctx.createMediaStreamSource(stream);
      source.connect(node);

      // Keep the audio graph alive with a near-silent gain node
      const silencer = ctx.createGain();
      silencer.gain.value = 0.001;
      node.connect(silencer);
      silencer.connect(ctx.destination);

      // Ring-buffer tap: feeds the global retroactive recorder ("Rec" button).
      // Output stays silent — a ScriptProcessor's output buffer is zeroed each
      // callback and we never write to it; the destination link just keeps the
      // node pulled by the graph.
      const tap = ctx.createScriptProcessor(4096, 1, 1);
      tap.onaudioprocess = (e) => {
        audioRecorder.write('input', e.inputBuffer.getChannelData(0), ctx.sampleRate);
      };
      source.connect(tap);
      tap.connect(ctx.destination);
      recTapRef.current = tap;

      analyserRef.current = node;
      setAnalyser(node);

      setState(prev => ({ ...prev, isRecording: true, error: null }));
      return node;
    } catch (err) {
      setState(prev => ({
        ...prev,
        isRecording: false,
        error: err instanceof Error ? err.message : 'Microphone access failed',
      }));
      return null;
    }
  }, [stop]);

  // Cleanup on unmount
  useEffect(() => () => { stop(); }, [stop]);

  return { state, analyser, analyserRef, start, stop };
}
