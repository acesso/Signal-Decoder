/**
 * SSTV end-to-end encode/transmit -> decode accuracy testbed.
 *
 * Unlike encoder.test.ts (which round-trips the encoder's samples straight
 * through the decoder class in-process, no audio hardware involved), this
 * drives the REAL app in a real headless Firefox: it uploads a synthetic
 * test image into the Compose & Transmit panel, clicks Encode & Transmit,
 * and lets the SSTV decoder pick the resulting audio up via a genuine
 * getUserMedia capture — the actual Web Audio playback -> DAC -> ADC ->
 * capture path a user's browser exercises, not just the pure-JS math.
 *
 * Audio loopback: a dedicated PulseAudio null-sink (created and torn down by
 * this script) is used as BOTH the page's audio output and input. TX
 * (getUserMedia is not involved) is scoped cleanly via a PULSE_SINK env var
 * on the launched Firefox process. RX is trickier and follows the pattern
 * proven in scripts/rtty-vs-production.ts / ft8-pool-live-compare.ts:
 * Firefox's WebRTC/getUserMedia device selection does NOT respect
 * PULSE_SOURCE (confirmed by hand), and `pactl move-source-output` LOOKS
 * like it succeeds but WirePlumber's node.autoconnect policy silently
 * re-links the capture stream back to the physical mic microseconds later
 * (confirmed via `pw-link -l`) — so this operates on the PipeWire graph
 * directly with `pw-link`/`pw-dump` instead, and periodically re-verifies +
 * re-links since that autoconnect tug-of-war continues for the capture's
 * whole lifetime, not just at startup. This never touches the host's default
 * sink/source — the user's own speakers/mic are completely untouched, and
 * the dedicated sink is destroyed on exit (including on failure).
 *
 * Requires:
 *  - the dev server running on port 3002 (npm run dev:test) — port 3000 is
 *    the developer's own always-on server, never touch it.
 *  - a playwright Firefox build (~/.cache/ms-playwright/firefox-*)
 *  - PulseAudio/PipeWire-pulse: pactl, pw-dump, pw-link on PATH (Linux desktop only)
 *
 * Usage:
 *   npx tsx scripts/sstv-e2e-testbed.ts [--modes ROBOT36,SCOTTIE_S1] [--url http://localhost:3002]
 *                                        [--out sstv-e2e-results.jsonl] [--threshold 40]
 *
 * Exits non-zero if any mode's average per-channel pixel diff exceeds
 * --threshold (default 40 — same tolerance encoder.test.ts uses, since the
 * comparison here goes through an extra lossy JPEG thumbnail AND a real
 * D/A + A/D round trip, both real per-mode noise sources absent from the
 * pure-JS unit test).
 */

import { firefox } from 'playwright-core';
import { execSync, spawnSync } from 'node:child_process';
import { writeFileSync, appendFileSync, readdirSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';

// ── args ─────────────────────────────────────────────────────────────────────
function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const URL = arg('url', 'http://localhost:3002');
const OUT = arg('out', 'sstv-e2e-results.jsonl');
const THRESHOLD = Number(arg('threshold', '40'));
const ALL_MODES = [
  'ROBOT36', 'ROBOT72',
  'SCOTTIE_S1', 'SCOTTIE_S2', 'SCOTTIE_DX',
  'MARTIN_M1', 'MARTIN_M2', 'WRAASE_SC2_180',
  'PD50', 'PD90', 'PD120', 'PD160', 'PD180', 'PD240', 'PD290',
];
const MODES = arg('modes', ALL_MODES.join(',')).split(',').map((m) => m.trim()).filter(Boolean);

const MODE_DIMENSIONS: Record<string, { width: number; height: number; scanTime: number }> = {
  ROBOT36: { width: 320, height: 240, scanTime: 150 },
  ROBOT72: { width: 320, height: 240, scanTime: 300 },
  SCOTTIE_S1: { width: 320, height: 256, scanTime: 428.22 },
  SCOTTIE_S2: { width: 320, height: 256, scanTime: 277.692 },
  SCOTTIE_DX: { width: 320, height: 256, scanTime: 1049.3 },
  MARTIN_M1: { width: 320, height: 256, scanTime: 445.874 },
  MARTIN_M2: { width: 320, height: 256, scanTime: 226.226 },
  WRAASE_SC2_180: { width: 320, height: 256, scanTime: 712.0225 },
  PD50: { width: 320, height: 240, scanTime: 388.16 },
  PD90: { width: 320, height: 240, scanTime: 703.04 },
  PD120: { width: 640, height: 496, scanTime: 508.48 },
  PD160: { width: 512, height: 400, scanTime: 804.416 },
  PD180: { width: 640, height: 496, scanTime: 751.68 },
  PD240: { width: 640, height: 496, scanTime: 994.88 },
  PD290: { width: 640, height: 496, scanTime: 1199.68 },
};

function estimateSeconds(mode: string): number {
  const m = MODE_DIMENSIONS[mode];
  const isPD = mode.startsWith('PD');
  const lines = isPD ? m.height / 2 : m.height;
  return 0.3 + 0.01 + 0.3 + 0.03 + 8 * 0.03 + 0.03 + (m.scanTime * lines) / 1000;
}

// ── firefox executable ───────────────────────────────────────────────────────
function findFirefox(): string {
  if (process.env.PLAYWRIGHT_FIREFOX_PATH) return process.env.PLAYWRIGHT_FIREFOX_PATH;
  const cache = join(homedir(), '.cache', 'ms-playwright');
  if (existsSync(cache)) {
    const builds = readdirSync(cache).filter((d) => d.startsWith('firefox-')).sort().reverse();
    for (const b of builds) {
      const exe = join(cache, b, 'firefox', 'firefox');
      if (existsSync(exe)) return exe;
    }
  }
  throw new Error('No playwright Firefox found — set PLAYWRIGHT_FIREFOX_PATH');
}

// ── scoped null-sink lifecycle ───────────────────────────────────────────────
// Dedicated sink, never touches the host's default sink/source. Cleaned up
// in a finally block even on failure/Ctrl-C-during-run (best-effort trap).
const SINK_NAME = `sstv_e2e_${process.pid}`;
let sinkModuleId: string | null = null;

function createTestSink(): void {
  const out = execSync(`pactl load-module module-null-sink sink_name=${SINK_NAME} sink_properties=device.description=SSTV_E2E_Test`, {
    encoding: 'utf8',
  }).trim();
  sinkModuleId = out;
}
function destroyTestSink(): void {
  if (!sinkModuleId) return;
  try {
    execSync(`pactl unload-module ${sinkModuleId}`);
  } catch { /* already gone */ }
  sinkModuleId = null;
}
process.on('SIGINT', () => {
  destroyTestSink();
  process.exit(130);
});

// ── Capture-direction routing (pw-link, not pactl) ──────────────────────────
// Ported verbatim from scripts/rtty-vs-production.ts, which discovered (via a
// raw PipeWire node dump) that `pactl move-source-output` looks like it
// succeeds but WirePlumber's node.autoconnect policy silently re-links the
// capture stream back to the physical mic microseconds later — the fix is to
// operate on the PipeWire graph directly instead.
const FIREFOX_APP_NAME = 'Nightly'; // playwright's headless Firefox build's PipeWire node.name

function pwSh(cmd: string): string {
  // pw-dump's JSON on a busy graph can exceed execSync's 1MB default buffer.
  return execSync(cmd, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).trim();
}
interface PwObj { id: number; type: string; info?: { props?: Record<string, unknown>; ['input-port-id']?: number; ['output-port-id']?: number } }
function pwDump(): PwObj[] {
  return JSON.parse(pwSh('pw-dump'));
}

/** Force-links the app tab's mic-capture PipeWire node to the sink's monitor
 *  ports, tearing down whatever it's currently linked from first. See the
 *  header comment / scripts/rtty-vs-production.ts for why this can't just be
 *  `pactl move-source-output`. */
function forceLinkCapture(appNodeName: string, sinkName: string): number {
  const dump = pwDump();
  const nodes = dump.filter((o) => o.type === 'PipeWire:Interface:Node');
  const ports = dump.filter((o) => o.type === 'PipeWire:Interface:Port');
  const links = dump.filter((o) => o.type === 'PipeWire:Interface:Link');

  const candidates = nodes
    .filter((n) => n.info?.props?.['node.name'] === appNodeName && n.info?.props?.['media.class'] === 'Stream/Input/Audio')
    .sort((a, b) => Number(b.info?.props?.['object.serial'] ?? 0) - Number(a.info?.props?.['object.serial'] ?? 0));
  const captureNode = candidates[0];
  if (!captureNode) throw new Error(`no capture node found for ${appNodeName}`);

  const capturePorts = ports.filter((p) => p.info?.props?.['node.id'] === captureNode.id && p.info?.props?.['port.direction'] === 'in');
  const sinkNode = nodes.find((n) => n.info?.props?.['node.name'] === sinkName);
  if (!sinkNode) throw new Error(`sink node ${sinkName} not found`);
  const monitorPorts = ports.filter(
    (p) => p.info?.props?.['node.id'] === sinkNode.id && p.info?.props?.['port.direction'] === 'out' && String(p.info?.props?.['port.name'] ?? '').startsWith('monitor_'),
  );

  for (const inPort of capturePorts) {
    for (const l of links.filter((l) => l.info?.['input-port-id'] === inPort.id)) {
      try {
        execSync(`pw-link -d ${l.id}`);
      } catch {
        // Benign race: the link can already be gone by the time we act on
        // this dump snapshot (WirePlumber tore it down/rebuilt it between
        // pwDump() and here) — the linking step below still needs to run.
      }
    }
    const channel = inPort.info?.props?.['audio.channel'];
    const outPort = monitorPorts.find((p) => p.info?.props?.['audio.channel'] === channel);
    if (outPort) execSync(`pw-link ${outPort.id} ${inPort.id}`);
  }
  return captureNode.id;
}

/** Checks whether the capture node's input ports are CURRENTLY linked from
 *  the sink's monitor (true), or have been silently relinked to something
 *  else — e.g. WirePlumber reasserting the physical mic — since the last
 *  forceLinkCapture call (false). */
function isCaptureLinkedToSink(nodeId: number, sinkName: string): boolean {
  const dump = pwDump();
  const nodes = dump.filter((o) => o.type === 'PipeWire:Interface:Node');
  const ports = dump.filter((o) => o.type === 'PipeWire:Interface:Port');
  const links = dump.filter((o) => o.type === 'PipeWire:Interface:Link');

  const sinkNode = nodes.find((n) => n.info?.props?.['node.name'] === sinkName);
  if (!sinkNode) return false;
  const monitorPortIds = new Set(
    ports.filter((p) => p.info?.props?.['node.id'] === sinkNode.id && p.info?.props?.['port.direction'] === 'out' && String(p.info?.props?.['port.name'] ?? '').startsWith('monitor_')).map((p) => p.id),
  );
  const capturePortIds = new Set(ports.filter((p) => p.info?.props?.['node.id'] === nodeId && p.info?.props?.['port.direction'] === 'in').map((p) => p.id));
  const feedingLinks = links.filter((l) => capturePortIds.has(l.info?.['input-port-id'] as number));
  if (feedingLinks.length === 0) return false;
  return feedingLinks.every((l) => monitorPortIds.has(l.info?.['output-port-id'] as number));
}


// ── deterministic test image (drawn client-side, saved to a temp PNG file) ──
// A smooth multi-channel gradient + a few solid color blocks: exercises every
// channel independently (unlike a photo, wrong channel order or an inverted
// signal is immediately visible as a systematic per-channel error) while
// staying free of high-frequency detail that would be lossy-thumbnail noise
// on top of the thing actually being tested.
async function makeTestImagePng(page: Awaited<ReturnType<typeof import('playwright-core').firefox.launch>>['newPage'] extends (...args: any[]) => Promise<infer P> ? P : never, width: number, height: number): Promise<string> {
  const dataUrl: string = await page.evaluate(
    `(() => {
      const canvas = document.createElement('canvas');
      canvas.width = ${width};
      canvas.height = ${height};
      const ctx = canvas.getContext('2d');
      const w = ${width}, h = ${height};
      const imgData = ctx.createImageData(w, h);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4;
          imgData.data[i]     = Math.round((x / (w - 1)) * 255);       // R: left(0) -> right(255)
          imgData.data[i + 1] = Math.round((y / (h - 1)) * 255);       // G: top(0) -> bottom(255)
          imgData.data[i + 2] = Math.round((1 - x / (w - 1)) * 255);   // B: right(0) -> left(255)
          imgData.data[i + 3] = 255;
        }
      }
      ctx.putImageData(imgData, 0, 0);
      // A few flat blocks in the corners for an easy-to-eyeball sanity check.
      ctx.fillStyle = 'red';    ctx.fillRect(0, 0, w * 0.1, h * 0.1);
      ctx.fillStyle = 'lime';   ctx.fillRect(w * 0.9, 0, w * 0.1, h * 0.1);
      ctx.fillStyle = 'blue';   ctx.fillRect(0, h * 0.9, w * 0.1, h * 0.1);
      ctx.fillStyle = 'white';  ctx.fillRect(w * 0.9, h * 0.9, w * 0.1, h * 0.1);
      return canvas.toDataURL('image/png');
    })()`,
  );
  return dataUrl;
}

function dataUrlToFile(dataUrl: string, path: string): void {
  const base64 = dataUrl.split(',')[1];
  writeFileSync(path, Buffer.from(base64, 'base64'));
}

// ── main ─────────────────────────────────────────────────────────────────────
const log = (obj: object) => appendFileSync(OUT, JSON.stringify(obj) + '\n');

async function main() {
  for (const bin of ['pactl', 'pw-dump', 'pw-link']) {
    if (spawnSync(bin, ['--version']).status !== 0) {
      throw new Error(`${bin} not found — this testbed needs PulseAudio/PipeWire-pulse on PATH (Linux desktop only)`);
    }
  }

  writeFileSync(OUT, '');
  console.log(`Creating scoped test sink '${SINK_NAME}'...`);
  createTestSink();

  const tmpDir = mkdtempSync(join(tmpdir(), 'sstv-e2e-'));
  const results: Array<{ mode: string; avgDiff: number; maxDiff: number; linesDecoded: number; totalLines: number; pass: boolean; error?: string }> = [];

  const browser = await firefox.launch({
    executablePath: findFirefox(),
    headless: true,
    env: {
      ...process.env,
      PULSE_SINK: SINK_NAME, // playback routing DOES respect this env var
      // (no PULSE_SOURCE here — Firefox ignores it for getUserMedia; the
      // capture stream is moved onto our sink's monitor after the fact, below)
    },
    firefoxUserPrefs: {
      'media.navigator.permission.disabled': true,
      'media.navigator.streams.fake': false, // real loopback audio, not a synthetic tone
    },
  });

  let watchdogRunning = true;
  let visWindowActive = false;
  let captureWatchdog: Promise<void> = Promise.resolve();

  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    page.on('pageerror', (e) => log({ ev: 'pageerror', err: e.message.slice(0, 300) }));
    page.on('console', (msg) => {
      if (msg.type() === 'error') log({ ev: 'console-error', text: msg.text().slice(0, 300) });
    });
    // A silent tab crash (OOM, GPU process death — plausible under headless)
    // would surface to callers as exactly the "execution context was
    // destroyed, most likely because of a navigation" errors seen chasing
    // this testbed's audio routing — logging it explicitly turns a confusing
    // downstream symptom into a clear root cause if it happens again.
    page.on('crash', () => log({ ev: 'PAGE-CRASHED' }));

    await page.goto(URL, { waitUntil: 'load' }).catch((err) => {
      throw new Error(`Cannot reach ${URL} — start the testbed dev server with 'npm run dev:test' (never port 3000). ${err.message}`);
    });

    await page.getByRole('button', { name: 'SSTV' }).click();
    await page.waitForTimeout(500);

    // Start the decoder listening BEFORE any transmission — mirrors real use
    // (operator has the app open and decoding while a signal comes in).
    await page.getByRole('button', { name: 'Start Decoding' }).click();
    await page.waitForTimeout(1000);
    const stopVisible = await page.getByRole('button', { name: 'Stop' }).first().isVisible().catch(() => false);
    log({ ev: 'decoder-started', stopVisible });

    // Force-link the capture to our sink's monitor via pw-link (pactl's
    // move-source-output doesn't hold — see the header comment), then keep a
    // watchdog running for the rest of the script's lifetime that re-links
    // whenever WirePlumber's autoconnect policy tears it back to the
    // physical mic. Runs concurrently with everything below (fire-and-forget
    // with a stop flag), not awaited up front, since the tug-of-war
    // continues for as long as the capture stays open — a one-shot
    // link-then-move-on isn't enough.
    captureWatchdog = (async () => {
      let nodeId: number | null = null;
      for (let attempt = 0; attempt < 5 && nodeId === null; attempt++) {
        try {
          nodeId = forceLinkCapture(FIREFOX_APP_NAME, SINK_NAME);
          log({ ev: 'force-linked-capture', nodeId });
        } catch (err) {
          log({ ev: 'force-link-capture-failed', attempt, error: err instanceof Error ? err.message : String(err) });
          await new Promise((r) => setTimeout(r, 400));
        }
      }
      if (nodeId === null) return;
      // 5s recheck cadence (rtty-vs-production.ts uses 30s across a
      // multi-minute capture; SSTV transmissions run 30s-20min, so 5s is a
      // proportionally tighter but still not hammering interval). Polling
      // much faster than this was observed to make the relink "fight" look
      // constant rather than occasional — plausibly because issuing
      // pw-link -d/pw-link every ~500ms adds its own churn to the graph on
      // top of whatever WirePlumber is doing independently.
      while (watchdogRunning) {
        // VIS detection needs an unbroken ~0.9s window right at the start of
        // each transmission — much stricter than RTTY's tolerance for a
        // dropped link over a multi-minute capture — so the mode loop below
        // flips visWindowActive just before clicking Encode & Transmit and
        // this watchdog checks far more often while it's set.
        await new Promise((r) => setTimeout(r, visWindowActive ? 250 : 5000));
        if (!watchdogRunning) break;
        try {
          if (!isCaptureLinkedToSink(nodeId, SINK_NAME)) {
            log({ ev: 'capture-link-broken-relinking', nodeId, visWindowActive });
            nodeId = forceLinkCapture(FIREFOX_APP_NAME, SINK_NAME);
          }
        } catch { /* pw-dump hiccup — retry next tick */ }
      }
    })();

    // Open the composer panel (collapsed <details> by default). The app
    // mounts all 5 decoder modes' settings persistently (toggled via CSS,
    // not unmounted), so there are ~19 <select>/<input> elements on the page
    // at any time — every composer locator below is scoped to this <details>
    // container to avoid accidentally hitting another mode's controls.
    const composerPanel = page.locator('details', { has: page.locator('summary', { hasText: 'Compose & Transmit QSO Card' }) });
    await composerPanel.locator('summary').click();
    await page.waitForTimeout(300);

    for (const mode of MODES) {
      const dims = MODE_DIMENSIONS[mode];
      if (!dims) {
        log({ ev: 'unknown-mode', mode });
        continue;
      }
      console.log(`\n=== ${mode} (${dims.width}x${dims.height}, ~${estimateSeconds(mode).toFixed(0)}s) ===`);

      try {
        // 1. Generate & upload the deterministic test image.
        const dataUrl = await makeTestImagePng(page, dims.width, dims.height);
        const imgPath = join(tmpDir, `${mode}.png`);
        dataUrlToFile(dataUrl, imgPath);

        const fileInput = composerPanel.locator('input[type="file"][accept="image/*"]');
        await fileInput.setInputFiles(imgPath);
        await page.waitForTimeout(300);

        // 2. Select the mode — <option value={m}> uses the raw mode key
        // (e.g. "ROBOT36"), so selecting by value is exact regardless of the
        // visible label's resolution/duration suffix. The composer has only
        // one <select> (Encode Mode) unless a text layer's font-family
        // dropdown is also showing, so scope + first() to be safe either way.
        await composerPanel.locator('select').first().selectOption(mode);
        await page.waitForTimeout(200);

        // 3. Encode & Transmit. Force a fresh link right before clicking:
        // VIS detection needs an unbroken ~0.9s window right at the start of
        // playback (leader/break/leader/VIS bits), which is much stricter
        // than RTTY's tolerance for the odd dropped link over a multi-minute
        // capture — so the capture link must be known-good at the exact
        // moment audio starts, not just "eventually corrected."
        visWindowActive = true;
        try {
          forceLinkCapture(FIREFOX_APP_NAME, SINK_NAME);
        } catch { /* watchdog will keep trying regardless */ }
        const galleryCountBefore = await page.locator(`img[alt="${mode}"]`).count();
        await composerPanel.getByRole('button', { name: 'Encode & Transmit' }).click();
        console.log('  transmitting...');

        // 4. Wait for playback + decode to finish: poll until a NEW gallery
        // thumbnail for this mode appears, bounded by a generous multiple of
        // the expected transmit duration (decode lags playback slightly).
        // visWindowActive (read by the watchdog above) stays set for the
        // first few seconds so a dropped link during the critical VIS window
        // gets caught and fixed within ~250ms instead of up to 5s.
        const timeoutMs = Math.ceil(estimateSeconds(mode) * 1000 * 1.5) + 15000;
        const deadline = Date.now() + timeoutMs;
        const visWindowDeadline = Date.now() + 4000;
        let newCount = galleryCountBefore;
        let pollN = 0;
        while (Date.now() < deadline) {
          if (visWindowActive && Date.now() >= visWindowDeadline) visWindowActive = false;
          newCount = await page.locator(`img[alt="${mode}"]`).count();
          if (newCount > galleryCountBefore) break;
          if (pollN % 10 === 0) {
            const decoderState = await page.evaluate(`(() => {
              const t = document.body.innerText;
              return { listening: t.includes('LISTENING'), decoding: t.includes('DECODING_IMAGE'), line: (t.match(/(\\d+) \\/ (\\d+)/) || [])[0] };
            })()`);
            log({ ev: 'poll', mode, pollN, ...decoderState });
          }
          pollN++;
          if (Date.now() < visWindowDeadline) {
            await page.waitForTimeout(200);
          } else {
            await page.waitForTimeout(1000);
          }
        }
        if (newCount <= galleryCountBefore) {
          throw new Error(`No decoded image appeared within ${(timeoutMs / 1000).toFixed(0)}s`);
        }

        // 5. Compare the newest gallery thumbnail against the known source
        // image, pixel-for-pixel (both resized to the mode's native
        // resolution — the thumbnail already IS that resolution).
        const diff = await page.evaluate(
          `(async () => {
            const srcDataUrl = ${JSON.stringify(dataUrl)};
            const imgs = document.querySelectorAll('img[alt="${mode}"]');
            const decodedEl = imgs[0]; // newest capture is prepended, so index 0
            const srcEl = new Image();
            await new Promise((res, rej) => { srcEl.onload = res; srcEl.onerror = rej; srcEl.src = srcDataUrl; });

            const w = ${dims.width}, h = ${dims.height};
            const srcCanvas = document.createElement('canvas');
            srcCanvas.width = w; srcCanvas.height = h;
            srcCanvas.getContext('2d').drawImage(srcEl, 0, 0, w, h);
            const srcData = srcCanvas.getContext('2d').getImageData(0, 0, w, h).data;

            const decCanvas = document.createElement('canvas');
            decCanvas.width = w; decCanvas.height = h;
            decCanvas.getContext('2d').drawImage(decodedEl, 0, 0, w, h);
            const decData = decCanvas.getContext('2d').getImageData(0, 0, w, h).data;

            let total = 0, n = 0, max = 0;
            for (let i = 0; i < srcData.length; i += 4) {
              for (let c = 0; c < 3; c++) {
                const d = Math.abs(srcData[i + c] - decData[i + c]);
                total += d; n++;
                if (d > max) max = d;
              }
            }
            return { avgDiff: total / n, maxDiff: max };
          })()`,
        );

        const pass = diff.avgDiff <= THRESHOLD;
        results.push({ mode, avgDiff: diff.avgDiff, maxDiff: diff.maxDiff, linesDecoded: dims.height, totalLines: dims.height, pass });
        log({ ev: 'mode-result', mode, ...diff, pass });
        console.log(`  avgDiff=${diff.avgDiff.toFixed(2)} maxDiff=${diff.maxDiff} -> ${pass ? 'PASS' : 'FAIL'}`);

        // Reset decoder state between modes so the next mode's capture isn't
        // confused by a stale in-progress decode.
        await page.getByRole('button', { name: 'Reset' }).click().catch(() => {});
        await page.waitForTimeout(500);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        results.push({ mode, avgDiff: -1, maxDiff: -1, linesDecoded: 0, totalLines: dims.height, pass: false, error: message });
        log({ ev: 'mode-error', mode, error: message });
        console.log(`  ERROR: ${message}`);
      } finally {
        visWindowActive = false;
      }
    }
  } finally {
    watchdogRunning = false;
    await captureWatchdog.catch(() => {});
    await browser.close();
    rmSync(tmpDir, { recursive: true, force: true });
    destroyTestSink();
  }

  console.log('\n=== Summary ===');
  let failCount = 0;
  for (const r of results) {
    const status = r.pass ? 'PASS' : 'FAIL';
    if (!r.pass) failCount++;
    console.log(`${status}  ${r.mode.padEnd(16)} avgDiff=${r.avgDiff >= 0 ? r.avgDiff.toFixed(2) : 'n/a'}${r.error ? `  (${r.error})` : ''}`);
  }
  console.log(`\n${results.length - failCount}/${results.length} modes passed (threshold: avgDiff <= ${THRESHOLD})`);
  log({ ev: 'summary', total: results.length, passed: results.length - failCount, failed: failCount });

  if (failCount > 0) process.exit(1);
}

main().catch((err) => {
  console.error('FATAL:', err);
  destroyTestSink();
  process.exit(1);
});
