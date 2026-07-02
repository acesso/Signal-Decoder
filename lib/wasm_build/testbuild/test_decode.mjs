// Smoke test: decode ft8_lib's known test WAVs with the ft8mon WASM module
// and compare decode counts against the expected .txt files.
// Usage: node test_decode.mjs [osd_depth]
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const wavDir = join(here, '../../ft8_lib/test/wav');
const osdDepth = process.argv[2] ?? '2';

const createFT8MonModule = (await import(join(here, 'ft8mon-node.js'))).default;
const mod = await createFT8MonModule({ print: () => {}, printErr: () => {} });
mod._ftm_init();
mod.ccall('ftm_set', 'number', ['string', 'string'], ['osd_depth', osdDepth]);

const createFT8LibModule = (await import(join(here, 'ft8lib-node.js'))).default;
const lib = await createFT8LibModule({ print: () => {}, printErr: () => {} });
lib._ft8_init();

function decodeWith(m, decodeFn, samples, rate) {
  const ptr = m._malloc(samples.length * 4);
  m.HEAPF32.set(samples, ptr >> 2);
  const t0 = performance.now();
  const jsonPtr = decodeFn(ptr, samples.length, rate);
  const ms = performance.now() - t0;
  m._free(ptr);
  return { results: JSON.parse(m.UTF8ToString(jsonPtr)), ms };
}
const norm = s => s.replace(/\s+/g, ' ').trim();

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

let totExp = 0, totGot = 0, totMatch = 0, totOldGot = 0, totOldMatch = 0;
for (const f of readdirSync(wavDir).filter(f => f.endsWith('.wav')).sort()) {
  if (!existsSync(join(wavDir, f.replace('.wav', '.txt')))) continue;
  const { samples, rate } = readWav(join(wavDir, f));
  const expected = readFileSync(join(wavDir, f.replace('.wav', '.txt')), 'utf8')
    .split('\n').map(l => l.trim()).filter(Boolean)
    .map(l => l.replace(/^\d+\s+-?\d+\s+[-\d.]+\s+\d+\s+~\s+/, '')
               .split(/\s{2,}/)[0] // drop trailing country annotation
               .trim());

  const mon = decodeWith(mod, (p, n, r) => mod._ftm_decode(p, n, r, 150, 3100, 8), samples, rate);
  const old = decodeWith(lib, (p, n, r) => lib._ft8_decode(p, n, r, 0), samples, rate);

  const expSet    = new Set(expected.map(norm));
  const monMsgs   = new Set(mon.results.map(r => norm(r.msg)));
  const oldMsgs   = new Set(old.results.map(r => norm(r.msg)));
  const monMatch  = [...expSet].filter(e => monMsgs.has(e)).length;
  const oldMatch  = [...expSet].filter(e => oldMsgs.has(e)).length;
  totExp += expSet.size; totGot += mon.results.length; totMatch += monMatch;
  totOldGot += old.results.length; totOldMatch += oldMatch;
  console.log(`${f}: expected ${expSet.size} | ft8mon ${monMatch} matched (${mon.results.length} dec, ${mon.ms.toFixed(0)}ms) | ft8_lib ${oldMatch} matched (${old.results.length} dec, ${old.ms.toFixed(0)}ms)`);
}
console.log(`\nTOTAL expected ${totExp}`);
console.log(`  ft8mon  (osd_depth=${osdDepth}): matched ${totMatch}, decoded ${totGot}`);
console.log(`  ft8_lib (current prod):     matched ${totOldMatch}, decoded ${totOldGot}`);
