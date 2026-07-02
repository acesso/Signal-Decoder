/**
 * CAT hardware test bed — uSDX BLACK_BRICK 4.00e.
 *
 * Talks to the real, flashed radio over its CAT serial port and validates
 * that live behavior matches what src/lib/cat/__tests__/protocol.test.ts
 * assumes about the wire protocol. Run this after every firmware flash —
 * the unit tests only check JS-side parsing, not that the .hex actually
 * behaves as documented (see CLAUDE.md).
 *
 * Usage: npm run test:cat-hardware -- [/dev/ttyACM1] [baud]
 */

import { execFileSync } from 'node:child_process';
import { openSync, closeSync, readSync, writeSync, constants as fsConstants } from 'node:fs';

const PORT = process.argv[2] ?? '/dev/ttyACM1';
const BAUD = process.argv[3] ?? '38400';

function configurePort(path: string, baud: string): void {
  execFileSync('stty', ['-F', path, baud, 'raw', '-echo']);
}

function readAvailable(fd: number, timeoutMs: number): string {
  const deadline = Date.now() + timeoutMs;
  const chunks: Buffer[] = [];
  const buf = Buffer.alloc(256);
  while (Date.now() < deadline) {
    let n = 0;
    try {
      n = readSync(fd, buf, 0, buf.length, null);
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === 'EAGAIN') { n = 0; } else { throw e; }
    }
    if (n > 0) chunks.push(Buffer.from(buf.subarray(0, n)));
    else sleepMs(20);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function sleepMs(ms: number): void {
  const sab = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(sab, 0, 0, ms);
}

function send(fd: number, cmd: string, waitMs = 400): string {
  writeSync(fd, cmd);
  const resp = readAvailable(fd, waitMs);
  return resp;
}

// ── Same parse helpers as useRadioCAT.ts / protocol.test.ts ──────────────────

function parseIntField(resp: string, prefix: string): number | null {
  const m = resp.match(new RegExp(`^${prefix}(-?\\d+);$`));
  return m ? parseInt(m[1], 10) : null;
}

function splitFrames(raw: string): string[] {
  return raw.split(';').filter(Boolean).map(f => f + ';');
}

function framesByPrefix(frames: string[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const f of frames) m.set(f.substring(0, 2), f);
  return m;
}

// BL (backlight) is a real firmware command but intentionally NOT polled by
// the app — its CAT-driven hardware effect could not be confirmed reliable.
const BLACKBRICK_POLL_CMDS = ['FA;', 'MD;', 'AG0;', 'FW;', 'VO;', 'AT;', 'A2;', 'NR;', 'SM;', 'DR;'];

// ── Test bed ──────────────────────────────────────────────────────────────────

interface Check {
  name: string;
  pass: boolean;
  detail: string;
}

function main(): void {
  const checks: Check[] = [];
  const record = (name: string, pass: boolean, detail: string) => {
    checks.push({ name, pass, detail });
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}  ${detail}`);
  };

  configurePort(PORT, BAUD);
  // O_NONBLOCK is required — readSync on a blocking tty fd waits forever for
  // data instead of returning 0/EAGAIN, which would hang this script solid.
  const fd = openSync(PORT, fsConstants.O_RDWR | fsConstants.O_NONBLOCK);

  try {
    // Drain any boot-time noise before starting.
    readAvailable(fd, 300);

    // ── IF; sanity ──
    const ifResp = send(fd, 'IF;');
    const ifOk = /^IF\d{11}00000\+0000000000\d\d000000;$/.test(ifResp);
    record('IF; returns well-formed 38-char status frame', ifOk, JSON.stringify(ifResp));

    // ── Batched poll returns all 10 frames in order ──
    const pollResp = send(fd, BLACKBRICK_POLL_CMDS.join(''), 600);
    const frames = splitFrames(pollResp);
    const map = framesByPrefix(frames);
    const expectedPrefixes = BLACKBRICK_POLL_CMDS.map(c => c.substring(0, 2));
    const gotPrefixes = frames.map(f => f.substring(0, 2));
    record(
      'Batched poll returns all 10 frames in order',
      JSON.stringify(gotPrefixes) === JSON.stringify(expectedPrefixes),
      JSON.stringify(pollResp),
    );

    const freq = parseIntField(map.get('FA') ?? '', 'FA');
    record('FA frame parses to a positive frequency', typeof freq === 'number' && freq > 0, String(freq));

    const sMeterFromPoll = parseIntField(map.get('SM') ?? '', 'SM');
    record(
      'SM frame parses to a plausible dBm reading',
      typeof sMeterFromPoll === 'number' && sMeterFromPoll >= -140 && sMeterFromPoll <= 30,
      String(sMeterFromPoll),
    );

    const driveFromPoll = parseIntField(map.get('DR') ?? '', 'DR');
    record(
      'DR frame parses to a value in 0..8',
      typeof driveFromPoll === 'number' && driveFromPoll >= 0 && driveFromPoll <= 8,
      String(driveFromPoll),
    );

    // ── SET/GET round-trip on the analog attenuator (AT), restoring original ──
    const beforeResp = send(fd, 'AT;');
    const before = parseIntField(beforeResp, 'AT');
    record('AT; GET returns a value before round-trip', before !== null, JSON.stringify(beforeResp));

    if (before !== null) {
      const probe = before === 3 ? 5 : 3; // pick a value that differs from current
      const setResp = send(fd, `AT${probe};`);
      const setEchoed = parseIntField(setResp, 'AT');
      record('AT SET echoes the new value', setEchoed === probe, JSON.stringify(setResp));

      const confirmResp = send(fd, 'AT;');
      const confirmed = parseIntField(confirmResp, 'AT');
      record('AT GET reflects the newly set value', confirmed === probe, JSON.stringify(confirmResp));

      const restoreResp = send(fd, `AT${before};`);
      const restored = parseIntField(restoreResp, 'AT');
      record('AT restored to its original value', restored === before, JSON.stringify(restoreResp));
    }

    // ── S-meter must be LIVE, not frozen — regression check for the bug where
    // smeter()'s dbm calculation only ran while the LCD display mode (smode)
    // was active, and CAT mode forces that display off. Cross-validated by
    // driving a real hardware change (max analog attenuation, -73dB) and
    // confirming the SM; reading actually moves in response, then restoring. ──
    const smBeforeResp = send(fd, 'SM;');
    const smBefore = parseIntField(smBeforeResp, 'SM');
    record('SM; GET returns a reading before attenuator change', smBefore !== null, JSON.stringify(smBeforeResp));

    if (smBefore !== null && before !== null) {
      send(fd, 'AT7;'); // max analog attenuation (-73dB per att_label[])
      const smAfterResp = send(fd, 'SM;', 600);
      const smAfter = parseIntField(smAfterResp, 'SM');
      record(
        'SM; reading changes after a real hardware attenuation change (not frozen)',
        smAfter !== null && smAfter !== smBefore,
        `before=${smBefore} after=${smAfter}`,
      );
      const smRestoreResp = send(fd, `AT${before};`);
      record('AT restored after S-meter liveness check', parseIntField(smRestoreResp, 'AT') === before, JSON.stringify(smRestoreResp));
    }

    // ── SET/GET round-trip on TX drive/power (DR), restoring original ──
    const drBeforeResp = send(fd, 'DR;');
    const drBefore = parseIntField(drBeforeResp, 'DR');
    record('DR; GET returns a value before round-trip', drBefore !== null, JSON.stringify(drBeforeResp));

    if (drBefore !== null) {
      const probe = drBefore === 3 ? 5 : 3; // pick a value that differs from current
      const setResp = send(fd, `DR${probe};`);
      const setEchoed = parseIntField(setResp, 'DR');
      record('DR SET echoes the new value', setEchoed === probe, JSON.stringify(setResp));

      const confirmResp = send(fd, 'DR;');
      const confirmed = parseIntField(confirmResp, 'DR');
      record('DR GET reflects the newly set value', confirmed === probe, JSON.stringify(confirmResp));

      const restoreResp = send(fd, `DR${drBefore};`);
      const restored = parseIntField(restoreResp, 'DR');
      record('DR restored to its original value', restored === drBefore, JSON.stringify(restoreResp));
    }

    // ── Unknown command should not desync the parser (firmware replies "?;") ──
    const unknownResp = send(fd, 'ZZ;');
    record('Unknown command gets a reply (does not hang)', unknownResp.length > 0, JSON.stringify(unknownResp));
  } finally {
    closeSync(fd);
  }

  const failed = checks.filter(c => !c.pass);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  if (failed.length > 0) {
    console.error(`${failed.length} check(s) failed — do not sign off this firmware flash.`);
    process.exit(1);
  }
}

main();
