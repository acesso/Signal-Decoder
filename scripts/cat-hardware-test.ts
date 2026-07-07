/**
 * CAT hardware test bed — uSDX BLACK_BRICK 4.01a.
 *
 * Talks to the real, flashed radio over its CAT serial port and validates
 * that live behavior matches what src/lib/cat/__tests__/protocol.test.ts
 * assumes about the wire protocol. Run this after every firmware flash —
 * the unit tests only check JS-side parsing, not that the .hex actually
 * behaves as documented (see CLAUDE.md).
 *
 * Usage: npm run test:cat-hardware -- [/dev/ttyACM1] [baud] [--factory-reset]
 *
 * --factory-reset additionally exercises SR2; (factory reset). It WIPES all
 * stored settings — band memories and ref-freq calibration included — so it
 * is opt-in and should only be run when that's acceptable (e.g. right after
 * a fresh flash whose version bump already reset the settings).
 */

import { execFileSync } from 'node:child_process';
import { openSync, closeSync, readSync, writeSync, constants as fsConstants } from 'node:fs';

const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
const PORT = args[0] ?? '/dev/ttyACM1';
const BAUD = args[1] ?? '38400';
const RUN_FACTORY_RESET = process.argv.includes('--factory-reset');

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

// For pure GET queries only (idempotent, no radio-state side effects): the
// LCD/UART pin sharing on this board (see parseIntField comment) can
// occasionally drop a reply on the floor, not just corrupt trailing bytes.
// The real app rides this out by retrying on its next poll cycle
// (useRadioCAT.ts); mirror that here with one bounded resend instead of
// failing the check on a transient hardware glitch. Never use this for a SET
// command — resending one could double-apply it.
function sendGet(fd: number, cmd: string, prefix: string, waitMs = 400): string {
  const resp = send(fd, cmd, waitMs);
  if (resp.includes(prefix)) return resp;
  return send(fd, cmd, waitMs);
}

// For RESTORE SETs only: absolute-value SETs (ATn;, DRn;, ...) are idempotent,
// so re-sending after a noise-eaten echo is safe — and a restore MUST be
// confirmed, or the radio is left drifted (an unconfirmed AT7 restore once left
// the attenuator stuck at max, -73dB, making the radio seem dead/frozen).
function sendSetVerified(fd: number, cmd: string, prefix: string, expected: number): string {
  let resp = '';
  for (let i = 0; i < 3; i++) {
    resp = send(fd, cmd);
    if (parseIntField(resp, prefix) === expected) return resp;
  }
  return resp;
}

// ── Same parse helpers as useRadioCAT.ts / protocol.test.ts ──────────────────

// This board's LCD shares its data pins with the UART (see usdxBLACKBRICK.ino
// pre()/post(), "NOISE LEAK INTO RX!!!"): an LCD write can briefly disable the
// UART mid-transmission, leaving a stray noise byte trailing a reply. The real
// app (useRadioCAT.ts) tolerates this by timing out and resyncing; here we just
// ignore anything after the frame's own terminator instead of requiring EOL.
function parseIntField(resp: string, prefix: string): number | null {
  const m = resp.match(new RegExp(`${prefix}(-?\\d+);`));
  return m ? parseInt(m[1], 10) : null;
}

// Trailing fragments that aren't a real `XX<data>` frame are LCD/UART pin-share
// noise (see parseIntField comment), not a protocol frame — drop them.
// NOTE: prefixes are letter+letter-or-digit ("A2" is a real command prefix),
// not two letters — /^[A-Z]{2}/ silently dropped every A2 frame.
function splitFrames(raw: string): string[] {
  return raw.split(';').filter(f => /^[A-Z][A-Z0-9]/.test(f)).map(f => f + ';');
}

function framesByPrefix(frames: string[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const f of frames) m.set(f.substring(0, 2), f);
  return m;
}

// BL (backlight) is polled again since the 2026-07-04 firmware fix (BACKLIGHT_PIN
// moved to the correct pin, PD3). PM/PX (PA bias) are deliberately NOT polled —
// the app fetches them on demand when its PA settings panel opens.
const BLACKBRICK_POLL_CMDS = ['FA;', 'MD;', 'AG0;', 'FW;', 'VO;', 'AT;', 'A2;', 'NR;', 'SM;', 'DR;', 'BL;', 'AL;', 'TT;'];

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
    const ifResp = sendGet(fd, 'IF;', 'IF');
    const ifOk = /IF\d{11}00000\+0000000000\d\d000000;/.test(ifResp);
    record('IF; returns well-formed 38-char status frame', ifOk, JSON.stringify(ifResp));

    // ── Batched poll returns all frames in order. This board's LCD/UART pin
    // sharing (see parseIntField comment) can occasionally drop a sub-command's
    // reply entirely, not just corrupt trailing bytes — the real app tolerates
    // this by timing out the whole batch and retrying on its next poll cycle
    // (useRadioCAT.ts), so mirror that here with one bounded retry rather than
    // failing on a transient hardware glitch. The poll is a pure GET batch, so
    // resending it has no side effects. ──
    const expectedPrefixes = BLACKBRICK_POLL_CMDS.map(c => c.substring(0, 2));
    let pollResp = send(fd, BLACKBRICK_POLL_CMDS.join(''), 600);
    let frames = splitFrames(pollResp);
    let gotPrefixes = frames.map(f => f.substring(0, 2));
    if (JSON.stringify(gotPrefixes) !== JSON.stringify(expectedPrefixes)) {
      pollResp = send(fd, BLACKBRICK_POLL_CMDS.join(''), 600);
      frames = splitFrames(pollResp);
      gotPrefixes = frames.map(f => f.substring(0, 2));
    }
    const map = framesByPrefix(frames);
    record(
      `Batched poll returns all ${BLACKBRICK_POLL_CMDS.length} frames in order`,
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
    const beforeResp = sendGet(fd, 'AT;', 'AT');
    const before = parseIntField(beforeResp, 'AT');
    record('AT; GET returns a value before round-trip', before !== null, JSON.stringify(beforeResp));

    if (before !== null) {
      const probe = before === 3 ? 5 : 3; // pick a value that differs from current
      const setResp = send(fd, `AT${probe};`);
      const setEchoed = parseIntField(setResp, 'AT');
      record('AT SET echoes the new value', setEchoed === probe, JSON.stringify(setResp));

      const confirmResp = sendGet(fd, 'AT;', 'AT');
      const confirmed = parseIntField(confirmResp, 'AT');
      record('AT GET reflects the newly set value', confirmed === probe, JSON.stringify(confirmResp));

      const restoreResp = sendSetVerified(fd, `AT${before};`, 'AT', before);
      const restored = parseIntField(restoreResp, 'AT');
      record('AT restored to its original value', restored === before, JSON.stringify(restoreResp));
    }

    // ── S-meter must be LIVE, not frozen — regression check for the bug where
    // smeter()'s dbm calculation only ran while the LCD display mode (smode)
    // was active, and CAT mode forces that display off. Cross-validated by
    // driving a real hardware change (max analog attenuation, -73dB) and
    // confirming the SM; reading actually moves in response, then restoring. ──
    const smBeforeResp = sendGet(fd, 'SM;', 'SM');
    const smBefore = parseIntField(smBeforeResp, 'SM');
    record('SM; GET returns a reading before attenuator change', smBefore !== null, JSON.stringify(smBeforeResp));

    if (smBefore !== null && before !== null) {
      sendSetVerified(fd, 'AT7;', 'AT', 7); // max analog attenuation (-73dB per att_label[])
      const smAfterResp = sendGet(fd, 'SM;', 'SM-', 600); // retry: the throttled LCD redraw fires exactly when dBm changes and can eat this reply
      const smAfter = parseIntField(smAfterResp, 'SM');
      record(
        'SM; reading changes after a real hardware attenuation change (not frozen)',
        smAfter !== null && smAfter !== smBefore,
        `before=${smBefore} after=${smAfter}`,
      );
      const smRestoreResp = sendSetVerified(fd, `AT${before};`, 'AT', before);
      record('AT restored after S-meter liveness check', parseIntField(smRestoreResp, 'AT') === before, JSON.stringify(smRestoreResp));
    }

    // ── SET/GET round-trip on TX drive/power (DR), restoring original ──
    const drBeforeResp = sendGet(fd, 'DR;', 'DR');
    const drBefore = parseIntField(drBeforeResp, 'DR');
    record('DR; GET returns a value before round-trip', drBefore !== null, JSON.stringify(drBeforeResp));

    if (drBefore !== null) {
      const probe = drBefore === 3 ? 5 : 3; // pick a value that differs from current
      const setResp = send(fd, `DR${probe};`);
      const setEchoed = parseIntField(setResp, 'DR');
      record('DR SET echoes the new value', setEchoed === probe, JSON.stringify(setResp));

      const confirmResp = sendGet(fd, 'DR;', 'DR');
      const confirmed = parseIntField(confirmResp, 'DR');
      record('DR GET reflects the newly set value', confirmed === probe, JSON.stringify(confirmResp));

      const restoreResp = sendSetVerified(fd, `DR${drBefore};`, 'DR', drBefore);
      const restored = parseIntField(restoreResp, 'DR');
      record('DR restored to its original value', restored === drBefore, JSON.stringify(restoreResp));
    }

    // ── SET/GET round-trip on the backlight (BL), restoring original.
    // Regression check for the PD3 pin fix — the wire round-trip always worked,
    // this validates the protocol; the physical LED needs eyes on the radio. ──
    const blBeforeResp = sendGet(fd, 'BL;', 'BL');
    const blBefore = parseIntField(blBeforeResp, 'BL');
    record('BL; GET returns 0/1', blBefore === 0 || blBefore === 1, JSON.stringify(blBeforeResp));

    if (blBefore !== null) {
      const blProbe = blBefore === 1 ? 0 : 1;
      const blSetResp = send(fd, `BL${blProbe};`);
      record('BL SET echoes the new value', parseIntField(blSetResp, 'BL') === blProbe, JSON.stringify(blSetResp));
      const blRestoreResp = sendSetVerified(fd, `BL${blBefore};`, 'BL', blBefore);
      record('BL restored to its original value', parseIntField(blRestoreResp, 'BL') === blBefore, JSON.stringify(blRestoreResp));
    }

    // ── Mode changes over CAT (MD, Kenwood digits 1=LSB 2=USB 3=CW 4=FM 5=AM).
    // Since the 2026-07-06 build AM/FM/CW are selectable for RX (listening) while
    // TX is blocked outside LSB/USB *in the firmware* — TX blocking is deliberately
    // NOT exercised here (never key the PA in a test; validate manually with a
    // dummy load). An out-of-range digit must clamp to LSB (MD1). ──
    const mdBeforeResp = sendGet(fd, 'MD;', 'MD');
    const mdBefore = parseIntField(mdBeforeResp, 'MD');
    record('MD; GET returns a Kenwood mode digit', mdBefore !== null && mdBefore >= 1 && mdBefore <= 5, JSON.stringify(mdBeforeResp));

    if (mdBefore !== null) {
      send(fd, 'MD5;');                 // AM — RX-only mode, must be selectable
      sleepMs(150);                     // clamping happens in the main loop, give it a beat
      const mdAm = sendGet(fd, 'MD;', 'MD');
      record('MD5 (AM) is selectable for RX', parseIntField(mdAm, 'MD') === 5, JSON.stringify(mdAm));

      send(fd, 'MD4;');                 // FM — RX-only mode, must be selectable
      sleepMs(150);
      const mdFm = sendGet(fd, 'MD;', 'MD');
      record('MD4 (FM) is selectable for RX', parseIntField(mdFm, 'MD') === 4, JSON.stringify(mdFm));

      send(fd, 'MD9;');                 // out of range — must clamp to LSB
      sleepMs(150);
      const mdClamped = sendGet(fd, 'MD;', 'MD');
      record('MD9 (out of range) clamps to LSB (MD1)', parseIntField(mdClamped, 'MD') === 1, JSON.stringify(mdClamped));

      send(fd, `MD${mdBefore};`);
      sleepMs(150);
      let mdRestored = sendGet(fd, 'MD;', 'MD');
      if (parseIntField(mdRestored, 'MD') !== mdBefore) { send(fd, `MD${mdBefore};`); sleepMs(150); mdRestored = sendGet(fd, 'MD;', 'MD'); }
      record('MD restored to its original value', parseIntField(mdRestored, 'MD') === mdBefore, JSON.stringify(mdRestored));
    }

    // ── SET/GET round-trip on the AGC level (AL, 1..14), restoring original.
    // Also checks the reject-echo path (AL0 is out of range → old value). ──
    const alBeforeResp = sendGet(fd, 'AL;', 'AL');
    const alBefore = parseIntField(alBeforeResp, 'AL');
    record('AL; GET returns a value in 1..14', alBefore !== null && alBefore >= 1 && alBefore <= 14, JSON.stringify(alBeforeResp));

    if (alBefore !== null) {
      const alProbe = alBefore === 4 ? 6 : 4;
      const alSetResp = send(fd, `AL${alProbe};`);
      record('AL SET echoes the new value', parseIntField(alSetResp, 'AL') === alProbe, JSON.stringify(alSetResp));
      const alRestoreResp = sendSetVerified(fd, `AL${alBefore};`, 'AL', alBefore);
      record('AL restored to its original value', parseIntField(alRestoreResp, 'AL') === alBefore, JSON.stringify(alRestoreResp));
      const alRejectResp = send(fd, 'AL0;');
      record('AL SET of 0 is rejected (echo returns old value)', parseIntField(alRejectResp, 'AL') === alBefore, JSON.stringify(alRejectResp));
    }

    // ── SET/GET round-trip on the TX time-out timer (TT, 0..255 s), restoring
    // original. The guard itself (force-unkey) is NOT exercised — that would
    // require keying TX, which automated tests never do. ──
    const ttBeforeResp = sendGet(fd, 'TT;', 'TT');
    const ttBefore = parseIntField(ttBeforeResp, 'TT');
    record('TT; GET returns a value in 0..255', ttBefore !== null && ttBefore >= 0 && ttBefore <= 255, JSON.stringify(ttBeforeResp));

    if (ttBefore !== null) {
      const ttProbe = ttBefore === 60 ? 120 : 60;
      const ttSetResp = send(fd, `TT${ttProbe};`);
      record('TT SET echoes the new value', parseIntField(ttSetResp, 'TT') === ttProbe, JSON.stringify(ttSetResp));
      const ttRestoreResp = sendSetVerified(fd, `TT${ttBefore};`, 'TT', ttBefore);
      record('TT restored to its original value', parseIntField(ttRestoreResp, 'TT') === ttBefore, JSON.stringify(ttRestoreResp));
      const ttRejectResp = send(fd, 'TT999;');
      record('TT SET beyond 255 is rejected (echo returns old value)', parseIntField(ttRejectResp, 'TT') === ttBefore, JSON.stringify(ttRejectResp));
    }

    // ── AG0 SET beyond 1 must be rejected since the single-algorithm AGC change ──
    const agBeforeResp = sendGet(fd, 'AG0;', 'AG0');
    const agBefore = parseIntField(agBeforeResp, 'AG0');
    record('AG0; GET returns 0/1', agBefore === 0 || agBefore === 1, JSON.stringify(agBeforeResp));
    if (agBefore !== null) {
      const agRejectResp = send(fd, 'AG02;');
      record('AG0 SET of 2 is rejected (echo returns old value)', parseIntField(agRejectResp, 'AG0') === agBefore, JSON.stringify(agRejectResp));
    }

    // ── SET/GET round-trips on the PA bias endpoints (PM/PX), restoring
    // originals. Safe in RX: the rebuilt PWM LUT is only consumed during TX. ──
    const pmBeforeResp = sendGet(fd, 'PM;', 'PM');
    const pmBefore = parseIntField(pmBeforeResp, 'PM');
    record('PM; GET returns a value', pmBefore !== null, JSON.stringify(pmBeforeResp));

    const pxBeforeResp = sendGet(fd, 'PX;', 'PX');
    const pxBefore = parseIntField(pxBeforeResp, 'PX');
    record('PX; GET returns a value', pxBefore !== null, JSON.stringify(pxBeforeResp));

    if (pmBefore !== null && pxBefore !== null) {
      const pmProbe = pmBefore + 1 < pxBefore ? pmBefore + 1 : pmBefore - 1; // stay in [0, max-1]
      const pmSetResp = send(fd, `PM${pmProbe};`);
      record('PM SET echoes the new value', parseIntField(pmSetResp, 'PM') === pmProbe, JSON.stringify(pmSetResp));
      const pmRestoreResp = sendSetVerified(fd, `PM${pmBefore};`, 'PM', pmBefore);
      record('PM restored to its original value', parseIntField(pmRestoreResp, 'PM') === pmBefore, JSON.stringify(pmRestoreResp));

      const pxProbe = pxBefore > pmBefore + 1 ? pxBefore - 1 : pxBefore + 1; // stay in [min+1, 255]
      const pxSetResp = send(fd, `PX${pxProbe};`);
      record('PX SET echoes the new value', parseIntField(pxSetResp, 'PX') === pxProbe, JSON.stringify(pxSetResp));
      const pxRestoreResp = sendSetVerified(fd, `PX${pxBefore};`, 'PX', pxBefore);
      record('PX restored to its original value', parseIntField(pxRestoreResp, 'PX') === pxBefore, JSON.stringify(pxRestoreResp));

      // Out-of-range SET must be rejected: the echo returns the unchanged value.
      const pxRejectResp = send(fd, 'PX999;');
      record('PX SET beyond 255 is rejected (echo returns old value)', parseIntField(pxRejectResp, 'PX') === pxBefore, JSON.stringify(pxRejectResp));
      const pmRejectResp = send(fd, `PM${pxBefore};`);
      record('PM SET at/above PX is rejected (echo returns old value)', parseIntField(pmRejectResp, 'PM') === pmBefore, JSON.stringify(pmRejectResp));
    }

    // ── SET/GET round-trip on the reference oscillator (XF, calibration),
    // restoring the original. ±5 Hz is far below any usable calibration, so
    // the probe never meaningfully detunes the radio even if restore failed. ──
    const xfBeforeResp = sendGet(fd, 'XF;', 'XF');
    const xfBefore = parseIntField(xfBeforeResp, 'XF');
    record('XF; GET returns a plausible ref frequency', xfBefore !== null && xfBefore > 14_000_000 && xfBefore < 28_000_000, JSON.stringify(xfBeforeResp));

    if (xfBefore !== null) {
      const xfProbe = xfBefore + 5;
      const xfSetResp = send(fd, `XF${xfProbe};`);
      record('XF SET echoes the new value', parseIntField(xfSetResp, 'XF') === xfProbe, JSON.stringify(xfSetResp));
      const xfRestoreResp = sendSetVerified(fd, `XF${xfBefore};`, 'XF', xfBefore);
      record('XF restored to its original value', parseIntField(xfRestoreResp, 'XF') === xfBefore, JSON.stringify(xfRestoreResp));
      // Out-of-range must be rejected (echo returns unchanged value)
      const xfRejectResp = send(fd, 'XF999;');
      record('XF SET below 14 MHz is rejected (echo returns old value)', parseIntField(xfRejectResp, 'XF') === xfBefore, JSON.stringify(xfRejectResp));
    }

    // ── FV; firmware version (read-only) ──
    const fvResp = sendGet(fd, 'FV;', 'FV');
    record('FV; returns a firmware version string', /FV\d\.\d\d[a-z]?;/.test(fvResp), JSON.stringify(fvResp));

    // ── FD; factory-defaults frame — one 11-value CSV frame. NOTE: SR2;
    // (factory reset) is deliberately NOT exercised here — it wipes band
    // memories and calibration on every run. Test it manually from the UI. ──
    const fdResp = sendGet(fd, 'FD;', 'FD');
    record('FD; returns an 11-value factory-defaults frame', /FD-?\d+(,-?\d+){10};/.test(fdResp), JSON.stringify(fdResp));

    // ── Unknown command should not desync the parser (firmware replies "?;") ──
    const unknownResp = send(fd, 'ZZ;');
    record('Unknown command gets a reply (does not hang)', unknownResp.length > 0, JSON.stringify(unknownResp));

    // ── SR soft-restart — deliberately the LAST check: the radio watchdog-
    // reboots and is off the wire for a few seconds afterwards. Resending SR;
    // if the ack is dropped (see sendGet comment) is safe: the radio either
    // hasn't rebooted yet (a second trigger is harmless) or is already
    // resetting (the second SR; is simply ignored while it comes back up). ──
    const srResp = sendGet(fd, 'SR;', 'SR1;');
    record('SR; acks with SR1; before rebooting', srResp.includes('SR1;'), JSON.stringify(srResp));

    if (srResp.includes('SR1;')) {
      const bootNoise = readAvailable(fd, 6000); // ride out the reboot; collects the boot IF; frame
      const faResp = send(fd, 'FA;', 600);
      record(
        'Radio responsive again after SR restart',
        /FA\d{11};/.test(faResp),
        `boot=${JSON.stringify(bootNoise)} fa=${JSON.stringify(faResp)}`,
      );
    }

    // ── SR2; factory reset — OPT-IN ONLY (--factory-reset): wipes band
    // memories and calibration, so it is never part of the routine run. ──
    if (RUN_FACTORY_RESET) {
      const fdBefore = send(fd, 'FD;', 600);
      const dm = fdBefore.match(/FD(-?\d+(?:,-?\d+){10});/);
      const d = dm ? dm[1].split(',').map(Number) : null;
      record('FD; readable before factory reset', d !== null, JSON.stringify(fdBefore));

      const sr2Resp = send(fd, 'SR2;');
      record('SR2; acks before factory-reset reboot', sr2Resp.includes('SR2;'), JSON.stringify(sr2Resp));

      if (d !== null && sr2Resp.includes('SR2;')) {
        readAvailable(fd, 8000); // reboot + the "Reset settings.." pause takes longer than a plain restart
        const after = send(fd, 'VO;PM;PX;MD;', 800);
        const map2 = framesByPrefix(splitFrames(after));
        const vo = parseIntField(map2.get('VO') ?? '', 'VO');
        const pm = parseIntField(map2.get('PM') ?? '', 'PM');
        const px = parseIntField(map2.get('PX') ?? '', 'PX');
        const md = map2.get('MD') ?? '';
        record(
          'Live values equal the FD; defaults after factory reset',
          vo === d[0] && pm === d[8] && px === d[9] && md === `MD${d[10]};`,
          `after=${JSON.stringify(after)} expected vol=${d[0]} pm=${d[8]} px=${d[9]} md=${d[10]}`,
        );
      }
    }
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
