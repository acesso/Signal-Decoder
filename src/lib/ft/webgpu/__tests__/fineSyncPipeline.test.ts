import { downV7f, shift200 } from '../fineSync';
import { extract } from '../symbolExtract';
import { cSoftDecode } from '../softDecode';
import { guessSnr } from '../guessSnr';
import { ldpcDecode } from '../ldpcDecode';
import { checkCrc } from '../crc';
import { LDPC_CHECKS } from '../ldpcMatrix';
import type { Complex } from '../dsp';
import fixture from './fixtures/fineSyncPipeline.json';

// Real intermediate values captured from ft8mon's own WASM decoder
// (temporary fprintf(stderr) instrumentation around one()/one_iter1(), since
// removed) on a real reference WAV, with min_hz=0/max_hz=5800 specifically
// chosen to keep ft8mon's internal rate_ at 12000 (its default) — ft8mon
// dynamically REDUCES rate_ below 12000 for narrower search bands (see
// reduce_rate()/ft8.cc:711-793), which would otherwise change blocksize()
// away from the 1920 this GPU prototype's coarse-search kernel assumes.
// This fixture is deliberately captured under the matching (rate_=12000,
// blocksize=1920) condition the GPU path needs to interoperate with.
//
// The full-window spectrogram (192002 floats, one per (time, freq) bin) is
// far too large for a committed fixture, so only a padded window around
// the actual candidate's frequency (where downV7f's fbandpass keeps
// non-zero content) is stored; the test reconstructs a full
// zero-padded array of the original bin count before calling downV7f, so
// its own internal indexing (bins1[i] = bins[i+down]) sees the same shape
// ft8mon operated on.
function reconstructFullBins(): Complex[] {
  const { nbins, binsOffset, binsTrimmed } = fixture.downv7;
  const full: Complex[] = new Array(nbins).fill(0).map(() => [0, 0] as Complex);
  for (let i = 0; i < binsTrimmed.length / 2; i++) {
    full[binsOffset + i] = [binsTrimmed[i * 2], binsTrimmed[i * 2 + 1]];
  }
  return full;
}

describe('fine-sync/soft-decode pipeline vs real ft8mon intermediate values', () => {
  test('downV7f matches ft8mon exactly (rate_=12000, blocksize=1920)', () => {
    const bins = reconstructFullBins();
    const { len, hz } = fixture.downv7;
    const got = downV7f(bins, len, hz);

    const expected = fixture.downv7.samples200;
    expect(got.length).toBe(expected.length);
    let maxErr = 0;
    for (let i = 0; i < expected.length; i++) maxErr = Math.max(maxErr, Math.abs(got[i] - expected[i]));
    expect(maxErr).toBeLessThan(1e-6);
  });

  test('shift200 + extract() matches ft8mon m79 (relative error, since magnitudes are large)', () => {
    const { samples200x, bestOff, bestHz, m79: m79Flat } = fixture.pipeline;
    const shifted = shift200(new Float64Array(samples200x), 0, samples200x.length, bestHz);
    const got = extract(shifted, bestOff);

    let maxRelErr = 0;
    for (let i = 0; i < 79; i++) {
      for (let j = 0; j < 8; j++) {
        const expRe = m79Flat[(i * 8 + j) * 2];
        const expIm = m79Flat[(i * 8 + j) * 2 + 1];
        const mag = Math.hypot(expRe, expIm) || 1;
        const err = Math.hypot(got[i][j][0] - expRe, got[i][j][1] - expIm) / mag;
        maxRelErr = Math.max(maxRelErr, err);
      }
    }
    // Direct-DFT vs FFTW summation-order float noise, not an algorithmic
    // difference — see the investigation this fixture was captured for
    // (verified at ~1e-11 relative error in practice).
    expect(maxRelErr).toBeLessThan(1e-8);
  });

  test('cSoftDecode(ft8mon m79) matches ft8mon ll174 exactly', () => {
    const { m79: m79Flat, ll174: expectedLl174 } = fixture.pipeline;
    const m79: Complex[][] = [];
    for (let i = 0; i < 79; i++) {
      const row: Complex[] = [];
      for (let j = 0; j < 8; j++) row.push([m79Flat[(i * 8 + j) * 2], m79Flat[(i * 8 + j) * 2 + 1]]);
      m79.push(row);
    }

    const got = cSoftDecode(m79);
    let maxErr = 0;
    for (let i = 0; i < 174; i++) maxErr = Math.max(maxErr, Math.abs(got[i] - expectedLl174[i]));
    expect(maxErr).toBeLessThan(1e-5);
  });

  test('end-to-end: our own extract() -> cSoftDecode still matches ft8mon ll174', () => {
    const { samples200x, bestOff, bestHz, ll174: expectedLl174 } = fixture.pipeline;
    const shifted = shift200(new Float64Array(samples200x), 0, samples200x.length, bestHz);
    const m79 = extract(shifted, bestOff);
    const got = cSoftDecode(m79);

    let maxErr = 0;
    for (let i = 0; i < 174; i++) maxErr = Math.max(maxErr, Math.abs(got[i] - expectedLl174[i]));
    expect(maxErr).toBeLessThan(1e-5);
  });

  test('full chain (downV7f -> shift200 -> extract -> cSoftDecode -> ldpcDecode -> checkCrc) reproduces a real clean-LDPC ft8mon decode', () => {
    // This fixture's file (191111_110145.wav) decoded cleanly (osd=-1, no
    // OSD fallback needed) to "GJ0KYZ RK9AX  MO05" — confirms the whole
    // GPU-kernel-compatible pipeline (everything except the LDPC decode
    // itself, which is the already-verified WGSL kernel's exact TS
    // reference) reproduces a genuine successful real-world decode
    // end-to-end, not just intermediate-value matches.
    const bins = reconstructFullBins();
    const { len, hz, off } = fixture.downv7;
    const samples200 = downV7f(bins, len, hz);
    const off200 = Math.round((off / 12000) * 200.0);

    const shifted = shift200(samples200, 0, samples200.length, fixture.pipeline.bestHz);
    const m79 = extract(shifted, fixture.pipeline.bestOff);
    const ll174 = cSoftDecode(m79);

    const result = ldpcDecode(ll174, 25);
    expect(result.ok).toBe(LDPC_CHECKS); // 83 = full syndrome success
    expect(checkCrc(result.plain)).toBe(true);
  });

  test('guessSnr matches ft8mon SNR exactly', () => {
    const { m79: m79Flat, snr: expectedSnr } = fixture.pipeline;
    const m79: Complex[][] = [];
    for (let i = 0; i < 79; i++) {
      const row: Complex[] = [];
      for (let j = 0; j < 8; j++) row.push([m79Flat[(i * 8 + j) * 2], m79Flat[(i * 8 + j) * 2 + 1]]);
      m79.push(row);
    }
    const got = guessSnr(m79);
    expect(got).toBeCloseTo(expectedSnr, 6);
  });
});
