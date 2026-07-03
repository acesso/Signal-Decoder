import { FloatRing, AudioRingRecorder } from '../ringRecorder';
import { wavPcm16Bytes } from '../wav';

const ramp = (n: number, from = 0) => Float32Array.from({ length: n }, (_, i) => from + i);

describe('FloatRing', () => {
  it('holds writes below capacity in order', () => {
    const r = new FloatRing(10);
    r.write(ramp(3));        // 0 1 2
    r.write(ramp(4, 10));    // 10 11 12 13
    expect(r.length).toBe(7);
    expect(Array.from(r.snapshot())).toEqual([0, 1, 2, 10, 11, 12, 13]);
  });

  it('wraps and keeps only the most recent capacity samples, oldest first', () => {
    const r = new FloatRing(5);
    for (let i = 0; i < 4; i++) r.write(ramp(2, i * 10)); // 0,1,10,11,20,21,30,31
    expect(r.length).toBe(5);
    expect(Array.from(r.snapshot())).toEqual([11, 20, 21, 30, 31]);
  });

  it('handles a single write larger than capacity by keeping the tail', () => {
    const r = new FloatRing(4);
    r.write(ramp(10)); // keeps 6 7 8 9
    expect(r.length).toBe(4);
    expect(Array.from(r.snapshot())).toEqual([6, 7, 8, 9]);
  });

  it('handles a write that exactly reaches the wrap point', () => {
    const r = new FloatRing(6);
    r.write(ramp(6));
    expect(Array.from(r.snapshot())).toEqual([0, 1, 2, 3, 4, 5]);
    r.write(ramp(2, 100));
    expect(Array.from(r.snapshot())).toEqual([2, 3, 4, 5, 100, 101]);
  });

  it('clear empties the ring', () => {
    const r = new FloatRing(4);
    r.write(ramp(3));
    r.clear();
    expect(r.length).toBe(0);
    expect(r.snapshot().length).toBe(0);
  });
});

describe('AudioRingRecorder', () => {
  it('sizes rings from duration × sample rate and reports seconds buffered', () => {
    const rec = new AudioRingRecorder();
    rec.setDurationSec(30);
    rec.write('input', new Float32Array(48000 * 3), 48000);
    expect(rec.secondsBuffered('input')).toBe(3);
    expect(rec.secondsBuffered('output')).toBe(0);
    expect(rec.hasAudio()).toBe(true);
    expect(rec.status()).toEqual({ inputSec: 3, outputSec: 0, durationSec: 30 });
  });

  it('caps each channel at the configured duration independently', () => {
    const rec = new AudioRingRecorder();
    rec.setDurationSec(30);
    for (let i = 0; i < 40; i++) rec.write('input', new Float32Array(1000), 1000);
    rec.write('output', new Float32Array(5000), 1000);
    expect(rec.secondsBuffered('input')).toBe(30);
    expect(rec.secondsBuffered('output')).toBe(5);
  });

  it('re-sizing the duration keeps the most recent audio that still fits', () => {
    const rec = new AudioRingRecorder();
    rec.setDurationSec(60);
    rec.write('input', ramp(50 * 100), 100); // 50 s at 100 Hz
    rec.setDurationSec(30);
    expect(rec.secondsBuffered('input')).toBe(30);
    const snap = rec.toWav('input');
    expect(snap).not.toBeNull();
    // duration persisted
    expect(new AudioRingRecorder().getDurationSec()).toBe(30);
  });

  it('reallocates the ring when the sample rate changes', () => {
    const rec = new AudioRingRecorder();
    rec.setDurationSec(30);
    rec.write('input', new Float32Array(48000), 48000);
    rec.write('input', new Float32Array(44100 * 2), 44100);
    expect(rec.secondsBuffered('input')).toBe(2); // old 48 kHz second dropped
  });

  it('toWav returns null for an empty channel and a WAV blob otherwise', () => {
    const rec = new AudioRingRecorder();
    rec.setDurationSec(30);
    expect(rec.toWav('output')).toBeNull();
    rec.write('output', new Float32Array(1200), 12000);
    const blob = rec.toWav('output')!;
    expect(blob.type).toBe('audio/wav');
    expect(blob.size).toBe(44 + 1200 * 2);
  });
});

describe('wavPcm16Bytes', () => {
  it('writes a correct RIFF header and clamped little-endian samples', () => {
    const view = new DataView(wavPcm16Bytes(Float32Array.from([0, 0.5, -0.5, 2, -2]), 48000));
    const ascii = (off: number, len: number) =>
      String.fromCharCode(...Array.from({ length: len }, (_, i) => view.getUint8(off + i)));

    expect(ascii(0, 4)).toBe('RIFF');
    expect(ascii(8, 4)).toBe('WAVE');
    expect(view.getUint16(20, true)).toBe(1);      // PCM
    expect(view.getUint16(22, true)).toBe(1);      // mono
    expect(view.getUint32(24, true)).toBe(48000);  // sample rate
    expect(view.getUint16(34, true)).toBe(16);     // bit depth
    expect(view.getUint32(40, true)).toBe(10);     // data bytes: 5 samples × 2

    expect(view.getInt16(44, true)).toBe(0);
    expect(view.getInt16(46, true)).toBe(Math.trunc(0.5 * 0x7fff));
    expect(view.getInt16(48, true)).toBe(-0.5 * 0x8000);
    expect(view.getInt16(50, true)).toBe(0x7fff);  // clamped +
    expect(view.getInt16(52, true)).toBe(-0x8000); // clamped −
  });
});
