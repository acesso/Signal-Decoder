// ft8_lib SIMD tier benchmark. Unlike ft8mon, ft8_decode() has no budget
// parameter — it's a fixed amount of work (single-pass BP decode over the
// oversampled waterfall), so wall-clock time here is a clean signal, not
// gated by an artificial deadline like the ft8mon benchmark is.
// Usage: node simd_benchmark_ft8lib.mjs [repeats]
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const wavDir = join(here, '../../ft8_lib/test/wav');
const repeats = Number(process.argv[2] ?? '5');

const TIERS = ['baseline', 'simd128', 'relaxed-simd'];
const FILE_SUFFIX = { baseline: '', simd128: '-simd128', 'relaxed-simd': '-relaxed-simd' };

function readWav(path) {
  const buf = readFileSync(path);
  let off = 12, fmt = null, data = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') fmt = { rate: buf.readUInt32LE(off + 12) };
    if (id === 'data') data = buf.subarray(off + 8, off + 8 + size);
    off += 8 + size + (size & 1);
  }
  const n = data.length / 2;
  const samples = new Float32Array(n);
  for (let i = 0; i < n; i++) samples[i] = data.readInt16LE(i * 2) / 32768;
  return { samples, rate: fmt.rate };
}

function decodeWith(m, samples, rate) {
  const ptr = m._malloc(samples.length * 4);
  m.HEAPF32.set(samples, ptr >> 2);
  const t0 = performance.now();
  const jsonPtr = m._ft8_decode(ptr, samples.length, rate, 0);
  const ms = performance.now() - t0;
  m._free(ptr);
  return { results: JSON.parse(m.UTF8ToString(jsonPtr)), ms };
}

const norm = s => s.replace(/\s+/g, ' ').trim();
const wavFiles = readdirSync(wavDir).filter(f => f.endsWith('.wav')).sort();

const mods = {};
for (const tier of TIERS) {
  const create = (await import(join(here, `ft8lib-node${FILE_SUFFIX[tier]}.cjs`))).default;
  const m = await create({ print: () => {}, printErr: () => {} });
  m._ft8_init();
  mods[tier] = m;
}

console.log(`Benchmarking ft8_lib ${TIERS.join(', ')} across ${wavFiles.length} files, ${repeats} repeat(s) each\n`);

const totalMs = Object.fromEntries(TIERS.map(t => [t, 0]));
let mismatches = 0;

for (const f of wavFiles) {
  const { samples, rate } = readWav(join(wavDir, f));
  const perTier = {};
  for (const tier of TIERS) {
    let best = Infinity, results = null;
    for (let r = 0; r < repeats; r++) {
      const out = decodeWith(mods[tier], samples, rate);
      best = Math.min(best, out.ms);
      results = out.results;
    }
    perTier[tier] = { ms: best, msgs: new Set(results.map(r => norm(r.msg))) };
    totalMs[tier] += best;
  }
  let rowMismatch = false;
  for (const tier of TIERS.slice(1)) {
    const a = [...perTier.baseline.msgs].sort().join('|');
    const b = [...perTier[tier].msgs].sort().join('|');
    if (a !== b) { rowMismatch = true; mismatches++; }
  }
  const timing = TIERS.map(t => `${t}=${perTier[t].ms.toFixed(2)}ms`).join(' ');
  console.log(`${f}: ${timing}${rowMismatch ? '  !! MISMATCH !!' : ''}`);
}

console.log('\n=== TOTALS (best-of-' + repeats + ' wall-clock ms, summed) ===');
for (const tier of TIERS) {
  const speedup = totalMs.baseline / totalMs[tier];
  console.log(`  ${tier.padEnd(14)} ${totalMs[tier].toFixed(1).padStart(8)}ms   ${tier === 'baseline' ? '' : `(${speedup.toFixed(2)}x vs baseline)`}`);
}
console.log(`\ndecode-set mismatches vs baseline: ${mismatches}`);
