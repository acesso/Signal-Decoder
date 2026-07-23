// guess_snr(): estimates a WSJT-X-like SNR from the m79 complex tone
// array — mirrors ft8.cc:2415-2458 exactly.
import type { Complex } from './dsp';

const COSTAS = [3, 1, 4, 0, 6, 5, 2] as const;

export function guessSnr(m79: Complex[][]): number {
  let noises = 0;
  let signals = 0;

  for (let i = 0; i < 7; i++) {
    signals += Math.hypot(...m79[i][COSTAS[i]]);
    signals += Math.hypot(...m79[36 + i][COSTAS[i]]);
    signals += Math.hypot(...m79[72 + i][COSTAS[i]]);
    noises += Math.hypot(...m79[i][(COSTAS[i] + 4) % 8]);
    noises += Math.hypot(...m79[36 + i][(COSTAS[i] + 4) % 8]);
    noises += Math.hypot(...m79[72 + i][(COSTAS[i] + 4) % 8]);
  }

  for (let i = 0; i < 79; i++) {
    if (i < 7 || (i >= 36 && i < 36 + 7) || (i >= 72 && i < 72 + 7)) continue;
    const v = new Array(8);
    for (let j = 0; j < 8; j++) v[j] = Math.hypot(...m79[i][j]);
    v.sort((a, b) => a - b);
    signals += v[7]; // strongest tone
    noises += (v[2] + v[3] + v[4]) / 3;
  }

  noises /= 79;
  signals /= 79;
  noises *= noises;
  signals *= signals;

  let raw = signals / noises;
  raw -= 1;
  if (raw < 0.1) raw = 0.1;
  raw /= 2500.0 / 2.7;
  let snr = 10 * Math.log10(raw);
  snr += 5;
  snr *= 1.4;
  return snr;
}
