/**
 * Live end-to-end test of the frequency-calibration chain (XF command) using
 * a real off-air reference carrier and the machine's audio input.
 *
 * What it does (RECEIVE-ONLY, radio never transmits):
 *   1. Saves current FA/MD/XF.
 *   2. Tunes USB to (reference − 1000 Hz) so the carrier is a ~1 kHz tone.
 *   3. Measures the tone from the sound card (Goertzel scan, sub-Hz).
 *   4. Bumps XF by +500 Hz (+20 ppm) → the tone must drop by ref×20ppm
 *      (≈100 Hz at 5 MHz). This proves an XF SET actually retunes the RX.
 *   5. Restores XF and re-measures (tone must come back).
 *   6. Restores FA/MD and verifies the readback.
 *
 * Usage: npm run test:calibration-live -- [/dev/ttyACM1] [refHz=5000000] [audioSource]
 *
 * NOTE: close the web app's CAT connection first — two readers on the same
 * tty steal each other's replies. The script aborts if replies look unreliable.
 */

import { execFileSync } from 'node:child_process';
import { openSync, closeSync, readSync, writeSync, constants as fsConstants } from 'node:fs';

const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
const PORT = args[0] ?? '/dev/ttyACM1';
const REF_HZ = args[1] ? parseInt(args[1], 10) : 5_000_000;
const AUDIO_SOURCE = args[2] ?? 'alsa_input.pci-0000_00_1f.3.analog-stereo';

const TONE_HZ = 1000;
const XF_BUMP = 500; // +20 ppm at 25 MHz
const SAMPLE_RATE = 48_000;
const CAPTURE_SECONDS = 4;

// ── Serial helpers (same style as cat-hardware-test.ts) ───────────────────────

function sleepMs(ms: number): void {
  const sab = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(sab, 0, 0, ms);
}

function readAvailable(fd: number, timeoutMs: number): string {
  const deadline = Date.now() + timeoutMs;
  const chunks: Buffer[] = [];
  const buf = Buffer.alloc(256);
  while (Date.now() < deadline) {
    let n = 0;
    try { n = readSync(fd, buf, 0, buf.length, null); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'EAGAIN') n = 0; else throw e; }
    if (n > 0) chunks.push(Buffer.from(buf.subarray(0, n)));
    else sleepMs(20);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function send(fd: number, cmd: string, waitMs = 400): string {
  writeSync(fd, cmd);
  return readAvailable(fd, waitMs);
}

/** Tolerant field extraction — takes the LAST match anywhere in the window,
 *  so a stray poll frame from another reader doesn't break parsing. */
function lastField(resp: string, prefix: string): number | null {
  const m = [...resp.matchAll(new RegExp(`${prefix}(-?\\d+);`, 'g'))];
  return m.length ? parseInt(m[m.length - 1][1], 10) : null;
}

// ── Audio measurement ─────────────────────────────────────────────────────────

function captureSamples(seconds: number): Float32Array {
  // pw-record → stdout WAV; cut off by timeout(1), which makes the process
  // exit non-zero — the captured audio is still in stdout, so harvest it
  // from the thrown error object.
  let raw: Buffer;
  try {
    raw = execFileSync('timeout', [
      String(seconds + 0.5), 'pw-record',
      '--target', AUDIO_SOURCE,
      '--rate', String(SAMPLE_RATE), '--channels', '1', '--format', 's16',
      '-',
    ], { maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (e) {
    const out = (e as { stdout?: Buffer }).stdout;
    if (!out || out.length < 1024) throw e;
    raw = out;
  }
  // pw-record to stdout emits raw PCM (no WAV header); if a header is present
  // anyway (RIFF), skip to the data chunk.
  let pcmStart = 0;
  if (raw.length >= 4 && raw.toString('ascii', 0, 4) === 'RIFF') {
    const dataIdx = raw.indexOf('data');
    if (dataIdx < 0) throw new Error('RIFF header without data chunk — capture too short?');
    pcmStart = dataIdx + 8;
  }
  const n = Math.floor((raw.length - pcmStart) / 2);
  if (n < SAMPLE_RATE) throw new Error(`captured only ${n} samples — audio source not delivering`);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = raw.readInt16LE(pcmStart + i * 2) / 32768;
  return out;
}

/** Basic capture health stats, printed so a bad source/level is obvious. */
function audioStats(x: Float32Array): string {
  let peak = 0, sum2 = 0, clipped = 0;
  for (let i = 0; i < x.length; i++) {
    const a = Math.abs(x[i]);
    if (a > peak) peak = a;
    if (a > 0.999) clipped++;
    sum2 += x[i] * x[i];
  }
  const rms = Math.sqrt(sum2 / x.length);
  return `rms=${rms.toFixed(3)} peak=${peak.toFixed(3)} clipped=${(100 * clipped / x.length).toFixed(1)}%`;
}

/** Goertzel power at one frequency. */
function goertzelPower(x: Float32Array, hz: number): number {
  const w = 2 * Math.PI * hz / SAMPLE_RATE;
  const c = 2 * Math.cos(w);
  let s0 = 0, s1 = 0, s2 = 0;
  for (let i = 0; i < x.length; i++) { s0 = x[i] + c * s1 - s2; s2 = s1; s1 = s0; }
  return s1 * s1 + s2 * s2 - c * s1 * s2;
}

/** Coarse scan 500–1500 Hz @1 Hz, then fine ±2 Hz @0.05 Hz. Returns Hz + SNR dB. */
function measureTone(x: Float32Array): { hz: number; snrDb: number } {
  let bestHz = 0, bestP = -1;
  const powers: number[] = [];
  for (let f = 500; f <= 1500; f += 1) {
    const p = goertzelPower(x, f);
    powers.push(p);
    if (p > bestP) { bestP = p; bestHz = f; }
  }
  let fineHz = bestHz, fineP = bestP;
  for (let f = bestHz - 2; f <= bestHz + 2; f += 0.05) {
    const p = goertzelPower(x, f);
    if (p > fineP) { fineP = p; fineHz = f; }
  }
  const median = powers.sort((a, b) => a - b)[Math.floor(powers.length / 2)] || 1e-12;
  return { hz: fineHz, snrDb: 10 * Math.log10(fineP / median) };
}

// ── Test ──────────────────────────────────────────────────────────────────────

function main(): void {
  const checks: { name: string; pass: boolean; detail: string }[] = [];
  const record = (name: string, pass: boolean, detail: string) => {
    checks.push({ name, pass, detail });
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}  ${detail}`);
  };

  execFileSync('stty', ['-F', PORT, '38400', 'raw', '-echo']);
  const fd = openSync(PORT, fsConstants.O_RDWR | fsConstants.O_NONBLOCK);

  try {
    readAvailable(fd, 300); // drain

    // Reply-reliability probe: if another process (the web app) holds the port,
    // replies get stolen and this test cannot be trusted.
    let good = 0;
    for (let i = 0; i < 3; i++) if (lastField(send(fd, 'XF;'), 'XF') !== null) good++;
    if (good < 3) {
      console.error(`Replies unreliable (${good}/3) — DISCONNECT the web app's CAT connection and re-run.`);
      process.exit(2);
    }

    // Save state
    const fa0 = lastField(send(fd, 'FA;'), 'FA');
    const md0 = send(fd, 'MD;').match(/MD(\d);/)?.[1] ?? null;
    const xf0 = lastField(send(fd, 'XF;'), 'XF');
    record('read initial FA/MD/XF', fa0 !== null && md0 !== null && xf0 !== null, `fa=${fa0} md=${md0} xf=${xf0}`);
    if (fa0 === null || md0 === null || xf0 === null) return;

    // Tune to the reference
    send(fd, 'MD2;');
    send(fd, `FA${String(REF_HZ - TONE_HZ).padStart(11, '0')};`);
    sleepMs(500); // let the retune + AGC settle

    const t0 = measureTone(captureSamples(CAPTURE_SECONDS));
    record('reference tone audible near 1 kHz', Math.abs(t0.hz - TONE_HZ) < 200 && t0.snrDb > 10,
      `tone=${t0.hz.toFixed(2)} Hz snr=${t0.snrDb.toFixed(0)} dB`);

    if (Math.abs(t0.hz - TONE_HZ) < 200 && t0.snrDb > 10) {
      // Bump XF: fxtal +20 ppm → LO +20 ppm → tone DOWN by REF×20ppm
      const expectedShift = -(XF_BUMP / xf0) * (REF_HZ - TONE_HZ);
      send(fd, `XF${xf0 + XF_BUMP};`);
      sleepMs(500);
      const t1 = measureTone(captureSamples(CAPTURE_SECONDS));
      const shift = t1.hz - t0.hz;
      record(
        `XF +${XF_BUMP} Hz moves the RX tone by ≈${expectedShift.toFixed(1)} Hz (THE core check)`,
        Math.abs(shift - expectedShift) < 10 && t1.snrDb > 10,
        `tone=${t1.hz.toFixed(2)} Hz shift=${shift.toFixed(2)} Hz snr=${t1.snrDb.toFixed(0)} dB`,
      );

      // Restore XF → tone must come back
      send(fd, `XF${xf0};`);
      sleepMs(500);
      const t2 = measureTone(captureSamples(CAPTURE_SECONDS));
      record('tone returns after XF restore', Math.abs(t2.hz - t0.hz) < 5 && t2.snrDb > 10,
        `tone=${t2.hz.toFixed(2)} Hz (was ${t0.hz.toFixed(2)})`);
    } else {
      send(fd, `XF${xf0};`); // belt and braces
    }

    // Restore tuning and verify readback (exercises the wizard's restore path)
    send(fd, `FA${String(fa0).padStart(11, '0')};`);
    send(fd, `MD${md0};`);
    sleepMs(300);
    const faBack = lastField(send(fd, 'FA;'), 'FA');
    record('FA restored and reads back', faBack === fa0, `fa=${faBack}`);
  } finally {
    closeSync(fd);
  }

  const failed = checks.filter(c => !c.pass);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

main();
