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
}
