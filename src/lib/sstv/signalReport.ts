// Automatic RSV signal report (Readability 1-5, Strength 1-9, Video/picture
// quality 1-5) for a captured SSTV image — the SSTV-specific extension of the
// ham radio RS(T) report, where V replaces CW's Tone digit (meaningless for
// SSTV) with a rating of the decoded PICTURE's quality specifically. R and S
// are estimated from the decode's own SNR/completeness (nothing else about
// the signal is known at capture time); V is estimated directly from the
// decoded pixels themselves, since picture quality and RF signal quality
// aren't the same thing — a strong, fully-decoded signal can still show a
// noisy/speckled image (e.g. from slant, sync jitter, or interference that
// corrupts pixel values without stalling the decode outright).
export interface SignalReport {
  readability: number; // 1-5
  strength: number; // 1-9
  video: number; // 1-5
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

/** Cheap picture-quality proxy: samples a coarse grid of the decoded image
 *  and scores two noise signals against their local neighborhoods —
 *  high-frequency pixel speckle (salt-and-pepper-style noise within a row)
 *  and row-to-row jitter (horizontal streaking/slant artifacts SSTV noise
 *  commonly produces). Both are cheap single-pass neighbor-difference
 *  measures, not a full frequency-domain analysis, since this only needs to
 *  rank "clean photo" vs "corrupted noise" well enough for a 1-5 bucket.
 */
function estimateVideoQuality(data: Uint8ClampedArray, width: number, height: number): number {
  if (width < 3 || height < 3) return 3; // too small to meaningfully sample

  // Downsample to a fixed-size grid so cost stays constant regardless of the
  // SSTV mode's native resolution (320x240 up to 640x496).
  const gridW = Math.min(64, width);
  const gridH = Math.min(64, height);
  const stepX = Math.max(1, Math.floor(width / gridW));
  const stepY = Math.max(1, Math.floor(height / gridH));

  const luma = (x: number, y: number): number => {
    const i = (y * width + x) * 4;
    // Cheap perceptual weighting, not full BT.601 — good enough for a noise proxy.
    return 0.3 * data[i] + 0.59 * data[i + 1] + 0.11 * data[i + 2];
  };

  let pixelNoiseSum = 0;
  let rowJitterSum = 0;
  let n = 0;

  for (let gy = 1; gy < gridH - 1; gy++) {
    const y = gy * stepY;
    for (let gx = 1; gx < gridW - 1; gx++) {
      const x = gx * stepX;
      const center = luma(x, y);

      // Salt-and-pepper-style speckle: how far this sample deviates from the
      // average of its left/right/up/down neighbors (a simple discrete
      // Laplacian) — a clean photo has smoothly-varying luma, noise doesn't.
      const neighborAvg = (luma(x - stepX, y) + luma(x + stepX, y) + luma(x, y - stepY) + luma(x, y + stepY)) / 4;
      pixelNoiseSum += Math.abs(center - neighborAvg);

      // Row-to-row jitter: SSTV-specific artifact where sync/slant issues
      // shift or corrupt whole rows relative to their neighbors, distinct
      // from generic pixel speckle.
      rowJitterSum += Math.abs(luma(x, y) - luma(x, y - stepY));
      n++;
    }
  }

  const avgPixelNoise = pixelNoiseSum / n; // typically ~0-40 for real photos, spikes higher with speckle
  const avgRowJitter = rowJitterSum / n;
  const noiseScore = avgPixelNoise * 0.6 + avgRowJitter * 0.4;

  // Empirically-reasonable thresholds for 0-255 luma: a clean decoded photo
  // usually lands under ~10, heavy corruption pushes well past ~35.
  if (noiseScore < 8) return 5;
  if (noiseScore < 15) return 4;
  if (noiseScore < 25) return 3;
  if (noiseScore < 35) return 2;
  return 1;
}

/** @param snr SNR in dB from the decoder's AnalyserNode-based estimate, or null if unavailable.
 *  @param completeness fraction of the image's lines that decoded (0-1).
 *  @param imageData decoded RGBA pixel buffer, used to estimate V (picture quality) directly. */
export function estimateSignalReport(snr: number | null, completeness: number, imageData: Uint8ClampedArray, width: number, height: number): SignalReport {
  // Strength: SNR-driven. ~0dB or below reads as barely-there (S1); ~27dB+
  // (a clean, strong decode) reads as full-scale (S9).
  const s = snr === null ? 5 : clamp(Math.round(1 + (snr / 27) * 8), 1, 9);

  // Readability: primarily how much of the image actually decoded — a
  // signal strong enough to fully decode is readable regardless of some
  // noise, while a signal that stalled partway through wasn't. SNR nudges
  // borderline cases (e.g. a fully-decoded-but-noisy image loses a point).
  let r: number;
  if (completeness >= 0.98) r = snr !== null && snr < 8 ? 4 : 5;
  else if (completeness >= 0.85) r = 4;
  else if (completeness >= 0.6) r = 3;
  else if (completeness >= 0.3) r = 2;
  else r = 1;

  const v = estimateVideoQuality(imageData, width, height);

  return { readability: r, strength: s, video: v };
}

export function formatSignalReport(report: SignalReport): string {
  return `${report.readability}${report.strength}${report.video}`;
}
