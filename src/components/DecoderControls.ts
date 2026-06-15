import type { AudioMarker } from '@/components/AudioAnalysisPanel';

export type { AudioMarker };

export interface DecoderControls {
  isRecording: boolean;
  isSupported: boolean;
  error: string | null;
  start: () => Promise<void>;
  stop: () => void;
  reset: () => void;
}

export interface AudioPanelInfo {
  markers?: AudioMarker[];
  squelch?: number;
  onSquelchChange?: (v: number) => void;
  signalLevel?: number;
}

export interface DecoderProps {
  onStateChange?: (controls: DecoderControls) => void;
  analyser?: AnalyserNode | null;
}
