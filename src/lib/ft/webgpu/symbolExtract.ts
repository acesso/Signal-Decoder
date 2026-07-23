// Symbol extraction: 200sps baseband samples -> 79x8 complex tone-bin
// array (c79), mirroring extract() (ft8.cc:1287-1309) exactly.
import { realFft, type Complex } from './dsp';

/** extract(): mini 32-point FFT per symbol time (79 symbols), keeping bins
 *  4..11 (the 8 FT8 tone bins, centered on bin 4 = 25Hz at 200sps/32
 *  samples-per-symbol). `hz` is expected to already be ~25 (post-shift200),
 *  `off` is the symbol-0 start sample in samples200. */
export function extract(samples200: Float64Array, off: number): Complex[][] {
  const m79: Complex[][] = new Array(79);
  for (let si = 0; si < 79; si++) {
    const bins = realFft(samples200, off + si * 32, 32);
    const row: Complex[] = new Array(8);
    for (let bi = 0; bi < 8; bi++) {
      row[bi] = bi + 4 < bins.length ? bins[4 + bi] : [0, 0];
    }
    m79[si] = row;
  }
  return m79;
}
