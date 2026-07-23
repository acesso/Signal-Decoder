// SIMD tier benchmark: decodes ft8_lib's reference WAVs through baseline,
// simd128, and relaxed-simd ft8mon builds, comparing wall-clock decode time
// AND decode-set equality (SIMD should only change speed, never results —
// FFTW's generic-simd128 codelets and Clang's auto-vectorizer are both
// numerically-equivalent transforms, not approximations).
// Usage: node simd_benchmark.mjs [osd_depth] [repeats]
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const wavDir = join(here, '../../ft8_lib/test/wav');
const osdDepth = process.argv[2] ?? '2';
const repeats = Number(process.argv[3] ?? '3');

const TIERS = ['baseline', 'simd128', 'relaxed-simd'];

function readWav(path) {
  const buf = readFileSync(path);
  if (buf.toString('ascii', 0, 4) !== 'RIFF') throw new Error('not RIFF');
  let off = 12, fmt = null, data = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') fmt = { rate: buf.readUInt32LE(off + 12), bits: buf.readUInt16LE(off + 22), ch: buf.readUInt16LE(off + 10) };
    if (id === 'data') data = buf.subarray(off + 8, off + 8 + size);
    off += 8 + size + (size & 1);
  }
  if (!fmt || !data) throw new Error('missing fmt/data');
  const n = data.length / 2;
  const samples = new Float32Array(n);
  for (let i = 0; i < n; i++) samples[i] = data.readInt16LE(i * 2) / 32768;
  return { samples, rate: fmt.rate };
}

// ft8mon's outer multi-pass loop runs until wall-clock hits budget_sec
// regardless of how much useful work remains (confirmed in ft8.cc: deadline_/
// final_deadline_ gate the per-candidate loop, but the decoder is designed to
// keep searching harder within its budget, not exit early once "done") — so
// timing at a GENEROUS budget (e.g. 8s, matching the app's own default)
// always reports ~identical wall-clock across SIMD tiers by construction; it
// measures "did we hit the deadline," not "how fast is the underlying work."
// A tight budget instead asks the real question: for the SAME wall-clock
// allowance, does a faster build get through more of the search (more
// candidates evaluated, as-good-or-better decode count)?
const BUDGET_SEC = Number(process.argv[4] ?? '1');

function decodeWith(m, samples, rate) {
  const ptr = m._malloc(samples.length * 4);
  m.HEAPF32.set(samples, ptr >> 2);
  const t0 = performance.now();
  const jsonPtr = m._ftm_decode(ptr, samples.length, rate, 150, 3100, BUDGET_SEC);
  const ms = performance.now() - t0;
  m._free(ptr);
  return { results: JSON.parse(m.UTF8ToString(jsonPtr)), ms };
}

const norm = s => s.replace(/\s+/g, ' ').trim();

const wavFiles = readdirSync(wavDir).filter(f => f.endsWith('.wav')).sort();

const mods = {};
for (const tier of TIERS) {
  const createFT8MonModule = (await import(join(here, `ft8mon-node-${tier}.cjs`))).default;
  const mod = await createFT8MonModule({ print: () => {}, printErr: () => {} });
  mod._ftm_init();
  mod.ccall('ftm_set', 'number', ['string', 'string'], ['osd_depth', osdDepth]);
  mods[tier] = mod;
}

console.log(`Benchmarking ${TIERS.join(', ')} across ${wavFiles.length} files, osd_depth=${osdDepth}, ${repeats} repeat(s) each\n`);

const totalMs = Object.fromEntries(TIERS.map(t => [t, 0]));
const totalDecoded = Object.fromEntries(TIERS.map(t => [t, 0]));
let mismatches = 0;

for (const f of wavFiles) {
  const { samples, rate } = readWav(join(wavDir, f));
  const perTier = {};
  for (const tier of TIERS) {
    let best = Infinity;
    let results = null;
    for (let r = 0; r < repeats; r++) {
      const out = decodeWith(mods[tier], samples, rate);
      best = Math.min(best, out.ms);
      results = out.results; // deterministic — any repeat's result set is fine to compare
    }
    perTier[tier] = { ms: best, msgs: new Set(results.map(r => norm(r.msg))) };
    totalMs[tier] += best;
    totalDecoded[tier] += results.length;
  }

  const baselineMsgs = perTier.baseline.msgs;
  let rowMismatch = false;
  for (const tier of TIERS.slice(1)) {
    const a = [...baselineMsgs].sort().join('|');
    const b = [...perTier[tier].msgs].sort().join('|');
    if (a !== b) { rowMismatch = true; mismatches++; }
  }

  const timing = TIERS.map(t => `${t}=${perTier[t].ms.toFixed(0)}ms`).join(' ');
  console.log(`${f}: ${timing}${rowMismatch ? '  !! DECODE SET MISMATCH !!' : ''}`);
}

console.log('\n=== TOTALS (best-of-' + repeats + ' wall-clock ms, summed across all files) ===');
for (const tier of TIERS) {
  const speedup = totalMs.baseline / totalMs[tier];
  console.log(`  ${tier.padEnd(14)} ${totalMs[tier].toFixed(0).padStart(7)}ms   decoded=${totalDecoded[tier]}   ${tier === 'baseline' ? '' : `(${speedup.toFixed(2)}x vs baseline)`}`);
}
console.log(`\ndecode-set mismatches vs baseline: ${mismatches}${mismatches === 0 ? ' (correctness preserved)' : ' !! INVESTIGATE !!'}`);
