// Port of src/components/DecoderControls.ts (Next.js app) — shared control
// contract every decoder mode implements. In React this flowed through
// forwardRef/useImperativeHandle; here each decoder fills in a caller-owned
// mutable `handle` object (same pattern as GLSpectrogramHandle).
export interface DecoderControls {
  isRecording: boolean
  isSupported: boolean
  error: string | null
  start: () => Promise<void>
  stop: () => void
  reset: () => void
}

export interface DecoderProps {
  onStateChange?: (controls: DecoderControls) => void
  analyser?: AnalyserNode | null
  vfoFrequency?: number
  handle?: { current: DecoderControls | null }
  /** ESP32 bridge sources — same audio/IQ precedence FTDecoder.tsx
   *  pioneered (iqBridge-connected first, then audioBridge-playbackActive,
   *  else microphone): all decoders were designed against a plain audio
   *  signal (AnalyserNode + capture stream), so bringing in the I/Q bridge
   *  means demodulating client-side (useIQBridge.ts's SSBDemodulator) and
   *  feeding the SAME shape downstream — no decoder-specific DSP change,
   *  just where the samples come from. Optional/undefined for any decoder
   *  not yet wired to accept them. */
  audioBridge?: import('./cat/useAudioBridge').AudioBridge
  iqBridge?: import('./cat/useIQBridge').IQBridge
}
