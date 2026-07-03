// Minimal WAV writer — mono 16-bit PCM, the most portable flavor.

const IS_LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

export function wavPcm16Bytes(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const n      = samples.length;
  const buffer = new ArrayBuffer(44 + n * 2);
  const view   = new DataView(buffer);

  const writeAscii = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };

  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + n * 2, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true);            // fmt chunk size
  view.setUint16(20, 1, true);             // PCM
  view.setUint16(22, 1, true);             // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true);             // block align
  view.setUint16(34, 16, true);            // bits per sample
  writeAscii(36, 'data');
  view.setUint32(40, n * 2, true);

  // Direct Int16Array writes are ~10-20x faster than per-sample DataView
  // calls — at the 5-minute ring maximum (14.4M samples) that is the
  // difference between a sub-50ms and a ~800ms main-thread freeze per save.
  // Int16Array is platform-endian, so fall back to DataView on big-endian
  // hosts (WAV data must be little-endian).
  if (IS_LITTLE_ENDIAN) {
    const pcm = new Int16Array(buffer, 44, n);
    for (let i = 0; i < n; i++) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
  } else {
    for (let i = 0; i < n; i++) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
  }

  return buffer;
}

export function encodeWavPcm16(samples: Float32Array, sampleRate: number): Blob {
  return new Blob([wavPcm16Bytes(samples, sampleRate)], { type: 'audio/wav' });
}
