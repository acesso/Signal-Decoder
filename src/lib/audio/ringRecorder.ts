// Global audio ring-buffer recorder.
//
// Two independent rings — 'input' (mic/line-in, tapped in useGlobalAudio) and
// 'output' (TX audio, tapped in useFTTransmit's playback graph) — continuously
// hold the most recent N seconds while audio is flowing. Pressing Rec saves
// whatever the rings currently hold as separate mono 16-bit PCM WAV files, so
// capture is retroactive: hear something interesting, then save it.
//
// Module-level singleton: taps live in different hooks and the UI lives in the
// top bar, so prop-threading would cross the whole component tree for no gain.

import { encodeWavPcm16 } from './wav';

export type RecChannel = 'input' | 'output';

export const REC_DURATION_CHOICES_SEC = [30, 60, 120, 300];
const DEFAULT_DURATION_SEC = 60;
const LS_DURATION = 'audioRecDurationSec';

export class FloatRing {
  private buf: Float32Array;
  private pos = 0;      // next write index
  private filled = 0;   // valid samples stored (≤ capacity)

  constructor(capacity: number) {
    this.buf = new Float32Array(Math.max(1, capacity));
  }

  get capacity(): number { return this.buf.length; }
  get length(): number { return this.filled; }

  write(samples: Float32Array): void {
    const cap = this.buf.length;
    if (samples.length >= cap) {
      this.buf.set(samples.subarray(samples.length - cap));
      this.pos = 0;
      this.filled = cap;
      return;
    }
    const tail = Math.min(samples.length, cap - this.pos);
    this.buf.set(samples.subarray(0, tail), this.pos);
    if (tail < samples.length) this.buf.set(samples.subarray(tail), 0);
    this.pos    = (this.pos + samples.length) % cap;
    this.filled = Math.min(cap, this.filled + samples.length);
  }

  // Oldest-first copy of everything currently held.
  snapshot(): Float32Array {
    const out = new Float32Array(this.filled);
    if (this.filled < this.buf.length) {
      out.set(this.buf.subarray(0, this.filled));
    } else {
      out.set(this.buf.subarray(this.pos));
      out.set(this.buf.subarray(0, this.pos), this.buf.length - this.pos);
    }
    return out;
  }

  clear(): void {
    this.pos = 0;
    this.filled = 0;
  }
}

interface ChannelState {
  ring: FloatRing | null;
  sampleRate: number;
}

export interface RecorderStatus {
  inputSec: number;
  outputSec: number;
  durationSec: number;
}

function loadDuration(): number {
  if (typeof window === 'undefined') return DEFAULT_DURATION_SEC;
  const v = Number(localStorage.getItem(LS_DURATION));
  return REC_DURATION_CHOICES_SEC.includes(v) ? v : DEFAULT_DURATION_SEC;
}

export class AudioRingRecorder {
  private durationSec = loadDuration();
  private channels: Record<RecChannel, ChannelState> = {
    input:  { ring: null, sampleRate: 0 },
    output: { ring: null, sampleRate: 0 },
  };

  getDurationSec(): number { return this.durationSec; }

  setDurationSec(sec: number): void {
    if (sec === this.durationSec || sec <= 0) return;
    this.durationSec = sec;
    if (typeof window !== 'undefined') localStorage.setItem(LS_DURATION, String(sec));
    // Re-size existing rings, keeping the most recent audio that still fits.
    for (const ch of Object.values(this.channels)) {
      if (!ch.ring) continue;
      const held = ch.ring.snapshot();
      ch.ring = new FloatRing(Math.ceil(sec * ch.sampleRate));
      ch.ring.write(held);
    }
  }

  // Called from audio callbacks — must only copy, never allocate per call
  // (the ring is reallocated only when the sample rate changes).
  write(channel: RecChannel, samples: Float32Array, sampleRate: number): void {
    const ch = this.channels[channel];
    if (!ch.ring || ch.sampleRate !== sampleRate) {
      ch.ring = new FloatRing(Math.ceil(this.durationSec * sampleRate));
      ch.sampleRate = sampleRate;
    }
    ch.ring.write(samples);
  }

  secondsBuffered(channel: RecChannel): number {
    const ch = this.channels[channel];
    return ch.ring && ch.sampleRate > 0 ? Math.floor(ch.ring.length / ch.sampleRate) : 0;
  }

  status(): RecorderStatus {
    return {
      inputSec:    this.secondsBuffered('input'),
      outputSec:   this.secondsBuffered('output'),
      durationSec: this.durationSec,
    };
  }

  hasAudio(): boolean {
    return (this.channels.input.ring?.length ?? 0) > 0
        || (this.channels.output.ring?.length ?? 0) > 0;
  }

  clear(): void {
    this.channels.input.ring?.clear();
    this.channels.output.ring?.clear();
  }

  // Returns the WAV blob (null if the channel holds nothing) — separated from
  // the download side effect so tests can cover it.
  toWav(channel: RecChannel): Blob | null {
    const ch = this.channels[channel];
    if (!ch.ring || ch.ring.length === 0) return null;
    return encodeWavPcm16(ch.ring.snapshot(), ch.sampleRate);
  }

  save(channel: RecChannel): boolean {
    const blob = this.toWav(channel);
    if (!blob) return false;
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const url   = URL.createObjectURL(blob);
    const a     = document.createElement('a');
    a.href      = url;
    a.download  = `audio-${channel}-${stamp}.wav`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    return true;
  }

  // Saves every channel that holds audio; returns the channels saved.
  saveAll(): RecChannel[] {
    return (['input', 'output'] as RecChannel[]).filter(c => this.save(c));
  }
}

export const audioRecorder = new AudioRingRecorder();
