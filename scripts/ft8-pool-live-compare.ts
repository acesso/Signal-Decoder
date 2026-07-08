/**
 * FT8 decode-pool live comparison.
 *
 * Routes a real WebSDR's audio (via a PipeWire null sink) into the app's
 * microphone input, decodes FT8 off actual off-air signals for a fixed
 * duration, and repeats with the decoder's parallel-worker pool forced to
 * size 1 (old single-worker behavior) vs a larger size — so the comparison
 * is driven by real signal conditions, not synthetic injected messages
 * (scripts/perf-testbed.ts's __ftInjectWindow hook bypasses the decoder
 * entirely and can't measure this).
 *
 * What it measures per pass (from src/lib/ft/decoder.ts's dev-only
 * window.__ftDecodePoolDebug bridge, populated inside decodeFTAudio itself
 * so it captures every real decode call from useFTProcessor's capture loop):
 *   - decode count and total/unique messages decoded
 *   - per-window decode wall-clock time (dispatchedAt → resolvedAt)
 *   - queueing backlog: how far behind the 15s window cadence decodes fall
 *   - unresolved hashed-callsign placeholders ("<...>") — a proxy for
 *     whether spreading windows across pool slots dilutes ft8mon's
 *     per-instance callsign hash table (see the pool comment in decoder.ts)
 *
 * Requires:
 *  - the dev server running on http://localhost:3002 (npm run dev:test)
 *  - a real (non-headless) display — DISPLAY or WAYLAND_DISPLAY set
 *  - pactl (PipeWire) on PATH
 *
 * Usage:
 *   npx tsx scripts/ft8-pool-live-compare.ts [--minutes 5] [--freq 7074]
 *     [--url http://localhost:3002] [--websdr http://websdr.ewi.utwente.nl:8901]
 *     [--pool-sizes 1,4]
 */

import { firefox, type Browser, type Page } from 'playwright-core';
import { execSync, spawnSync } from 'node:child_process';
import { readdirSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const MINUTES    = Number(arg('minutes', '5'));
const FREQ_KHZ   = arg('freq', '7074');
const APP_URL    = arg('url', 'http://localhost:3002');
const WEBSDR_URL = arg('websdr', 'http://websdr.ewi.utwente.nl:8901');
const POOL_SIZES = arg('pool-sizes', '1,4').split(',').map(Number);
const SINK_NAME  = 'ft8perftest';
// playwright-core's bundled Firefox build reports this as its PipeWire
// application.name (not "Firefox") — verified with `pactl list sink-inputs`.
const FIREFOX_APP_NAME = 'Nightly';
const OUT        = arg('out', 'ft8-pool-compare-results.json');

function findFirefox(): string {
  if (process.env.PLAYWRIGHT_FIREFOX_PATH) return process.env.PLAYWRIGHT_FIREFOX_PATH;
  const cache = join(homedir(), '.cache', 'ms-playwright');
  if (existsSync(cache)) {
    const builds = readdirSync(cache).filter(d => d.startsWith('firefox-')).sort().reverse();
    for (const b of builds) {
      const exe = join(cache, b, 'firefox', 'firefox');
      if (existsSync(exe)) return exe;
    }
  }
  throw new Error('No playwright Firefox found — set PLAYWRIGHT_FIREFOX_PATH');
}

// ── PipeWire routing ─────────────────────────────────────────────────────────

function sh(cmd: string): string {
  // pw-dump's JSON on a busy graph exceeds execSync's 1MB default maxBuffer
  // and crashes with ENOBUFS/SIGPIPE — confirmed the hard way.
  return execSync(cmd, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).trim();
}

function createSink(): number {
  const out = sh(`pactl load-module module-null-sink sink_name=${SINK_NAME} sink_properties=device.description=${SINK_NAME}`);
  return Number(out);
}

function destroySink(moduleId: number) {
  try { execSync(`pactl unload-module ${moduleId}`); } catch { /* already gone */ }
}

// Finds the newest sink-input whose application name matches, for routing
// the WebSDR tab's playback without disturbing other running apps. This
// direction works fine via plain pactl (confirmed: the sink-input actually
// stays moved, unlike source-outputs — see forceLinkCapture below for why
// the capture direction needs a different approach entirely).
function findStreamId(kind: 'sink-inputs', appNameSubstr: string): string | null {
  const out = sh(`pactl list ${kind}`);
  const blocks = out.split(/\n(?=Sink Input #)/);
  for (const block of blocks.reverse()) { // newest last in output — reverse to prefer most recent
    if (block.includes(appNameSubstr)) {
      const m = block.match(/^Sink Input #(\d+)/);
      if (m) return m[1];
    }
  }
  return null;
}

function moveStream(kind: 'sink-input', id: string, target: string) {
  execSync(`pactl move-${kind} ${id} ${target}`);
}

// ── Capture-direction routing (pw-link, not pactl) ──────────────────────────
// `pactl move-source-output` LOOKS like it succeeds (no error, and even
// shows the new target briefly) but WirePlumber's node.autoconnect policy
// silently re-links the stream back to the physical mic microseconds later —
// confirmed via `pw-link -l` showing the capture port still fed by
// `alsa_input.*:capture_*` after a "successful" pactl move. The fix is to
// operate on the PipeWire graph directly: find the tab's capture node via
// pw-dump, disconnect whatever currently feeds its input ports, and link
// the target sink's monitor ports straight in. This is NOT something
// WirePlumber undoes afterward (unlike the pactl-level move).
interface PwObj { id: number; type: string; info?: { props?: Record<string, unknown>; ['input-port-id']?: number } }

function pwDump(): PwObj[] {
  return JSON.parse(sh('pw-dump'));
}

/**
 * Force-links a browser tab's mic-capture node to a sink's monitor ports.
 * `excludeNodeIds` lets a caller skip nodes it has already claimed, for the
 * case where multiple tabs share the same PipeWire node.name (e.g. two
 * Firefox/"Nightly" tabs both capturing audio) — the newest remaining match
 * (by object.serial, which increases monotonically with node creation) is
 * picked, so calling this once per tab in creation order disambiguates them.
 */
function forceLinkCapture(appNodeName: string, sinkName: string, excludeNodeIds: Set<number> = new Set()): number {
  const dump = pwDump();
  const nodes = dump.filter(o => o.type === 'PipeWire:Interface:Node');
  const ports = dump.filter(o => o.type === 'PipeWire:Interface:Port');
  const links = dump.filter(o => o.type === 'PipeWire:Interface:Link');

  const candidates = nodes
    .filter(n => n.info?.props?.['node.name'] === appNodeName && n.info?.props?.['media.class'] === 'Stream/Input/Audio')
    .filter(n => !excludeNodeIds.has(n.id))
    .sort((a, b) => Number(b.info?.props?.['object.serial'] ?? 0) - Number(a.info?.props?.['object.serial'] ?? 0));
  const captureNode = candidates[0];
  if (!captureNode) throw new Error(`no capture node found for ${appNodeName} (excluding ${[...excludeNodeIds]})`);

  const capturePorts = ports.filter(p => p.info?.props?.['node.id'] === captureNode.id && p.info?.props?.['port.direction'] === 'in');
  const sinkNode = nodes.find(n => n.info?.props?.['node.name'] === sinkName);
  if (!sinkNode) throw new Error(`sink node ${sinkName} not found`);
  const monitorPorts = ports.filter(p =>
    p.info?.props?.['node.id'] === sinkNode.id &&
    p.info?.props?.['port.direction'] === 'out' &&
    String(p.info?.props?.['port.name'] ?? '').startsWith('monitor_'));

  for (const inPort of capturePorts) {
    for (const l of links.filter(l => l.info?.['input-port-id'] === inPort.id)) {
      execSync(`pw-link -d ${l.id}`);
    }
    const channel = inPort.info?.props?.['audio.channel'];
    const outPort = monitorPorts.find(p => p.info?.props?.['audio.channel'] === channel);
    if (outPort) execSync(`pw-link ${outPort.id} ${inPort.id}`);
  }
  return captureNode.id;
}

// ── main ─────────────────────────────────────────────────────────────────────

async function setupWebSDR(page: Page) {
  // On this WebSDR (websdr.ewi.utwente.nl), ?tune=<khz> alone already selects
  // USB and centers the passband — confirmed by inspecting the loaded page
  // (the USB button renders pre-highlighted, filter starts at 2.40 kHz).
  const url = `${WEBSDR_URL}/?tune=${FREQ_KHZ}`;
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForTimeout(2000);

  // The "start audio" prompt is a full-width overlay box (#audiostartbutton)
  // sitting on top of the controls beneath it — it intercepts pointer events
  // for anything under it until dismissed, so it must be clicked FIRST or
  // every later click (USB, wider, ...) silently fails/times out.
  const startBtn = page.getByRole('button', { name: 'start audio' }).first();
  await startBtn.waitFor({ timeout: 15000 });
  await startBtn.click();
  await page.waitForTimeout(1000);

  // Click USB anyway, best-effort, in case a different WebSDR instance is
  // swapped in via --websdr and doesn't set mode from the URL.
  const usbBtn = page.getByRole('button', { name: 'USB', exact: false }).first();
  if (await usbBtn.isVisible().catch(() => false)) await usbBtn.click().catch(() => {});

  // Widen the filter to cover the full ~2.7 kHz FT8 sub-band — click "wider"
  // a few times and read the label back rather than assuming one click's step.
  const widerBtn = page.getByRole('button', { name: 'wider' }).first();
  for (let i = 0; i < 4; i++) {
    const label = await page.locator('text=/Filter:\\s*[\\d.]+\\s*kHz/').first().textContent().catch(() => '');
    const khz = Number(label?.match(/([\d.]+)\s*kHz/)?.[1] ?? '0');
    if (khz >= 2700) break;
    await widerBtn.click().catch(() => {});
    await page.waitForTimeout(200);
  }
  await page.waitForTimeout(1000);
}

async function setupAppTab(page: Page, poolSize: number) {
  await page.goto(APP_URL, { waitUntil: 'load' });
  await page.getByRole('button', { name: 'FT8/4' }).click();
  await page.waitForTimeout(1000);
  const hasHook = await page.evaluate('typeof window.__ftDecodePoolDebug !== "undefined"');
  if (!hasHook) throw new Error('__ftDecodePoolDebug missing — dev server running a production build?');
  await page.evaluate(`window.__ftDecodePoolDebug.setPoolSize(${poolSize})`);
  await page.evaluate('window.__ftDecodePoolDebug.reload()'); // pool size only applies on respawn
  await page.evaluate('window.__ftDecodePoolDebug.clearLog()');
  await page.waitForTimeout(1000); // let WASM reload before decoding starts
  await page.getByRole('button', { name: 'Start Decoding' }).click();
}

interface PassResult {
  poolSize: number;
  durationMs: number;
  decodeLog: Array<{ id: number; slot: number; dispatchedAt: number; resolvedAt: number; msgCount: number }>;
  finalMessageTexts: string[];
}

async function runPass(browser: Browser, poolSize: number): Promise<PassResult> {
  console.log(`\n=== pool size ${poolSize}: starting ${MINUTES}-minute capture — DO NOT CLOSE THE BROWSER WINDOWS ===`);
  const sdrPage = await browser.newPage();
  const appPage = await browser.newPage();
  sdrPage.on('crash', () => console.error('!! WebSDR page crashed'));
  appPage.on('crash', () => console.error('!! app page crashed'));
  sdrPage.on('close', () => console.warn('WebSDR page closed (script-initiated close is expected only at end of pass)'));
  appPage.on('close', () => console.warn('app page closed (script-initiated close is expected only at end of pass)'));
  appPage.on('pageerror', e => console.error('app page error:', e.message));

  await setupWebSDR(sdrPage);
  await setupAppTab(appPage, poolSize);

  // Route: WebSDR tab's output → our null sink (plain pactl — this direction
  // genuinely works). App tab's mic capture ← that sink's monitor, via
  // pw-link directly (see forceLinkCapture doc comment for why pactl alone
  // doesn't hold for this direction). The sink-input only exists once the
  // WebSDR is actually playing, so poll briefly rather than fixed-delaying.
  let sdrStreamId: string | null = null;
  for (let i = 0; i < 20 && !sdrStreamId; i++) {
    await new Promise(r => setTimeout(r, 500));
    // playwright-core's Firefox build identifies itself as "Nightly" in
    // PipeWire's application.name, not "Firefox" — confirmed via `pactl list`.
    sdrStreamId ??= findStreamId('sink-inputs', FIREFOX_APP_NAME);
  }
  if (sdrStreamId) moveStream('sink-input', sdrStreamId, SINK_NAME);
  await new Promise(r => setTimeout(r, 1000)); // let the app's getUserMedia stream open before relinking it
  forceLinkCapture(FIREFOX_APP_NAME, SINK_NAME);
  console.log(`routed: sdr sink-input=${sdrStreamId ?? '?'} app capture forced onto ${SINK_NAME}.monitor`);

  const t0 = Date.now();
  await new Promise(r => setTimeout(r, MINUTES * 60_000));
  const durationMs = Date.now() - t0;

  const decodeLog = await appPage.evaluate('window.__ftDecodePoolDebug.getLog()') as PassResult['decodeLog'];
  const finalMessageTexts = await appPage.evaluate(`
    Array.from(document.querySelectorAll('[class*="truncate"]')).map(el => el.textContent).filter(Boolean)
  `) as string[];

  await sdrPage.close().catch(() => {});
  await appPage.close().catch(() => {});

  return { poolSize, durationMs, decodeLog, finalMessageTexts };
}

function summarize(pass: PassResult) {
  const { decodeLog } = pass;
  const decodeMs = decodeLog.map(e => e.resolvedAt - e.dispatchedAt);
  const totalMsgs = decodeLog.reduce((s, e) => s + e.msgCount, 0);
  const unresolvedHashes = pass.finalMessageTexts.filter(t => t.includes('<...>')).length;
  // Backlog proxy: for FT8 a new window is captured every 15s — if a
  // decode's own wall-clock time exceeds that, the NEXT window's dispatch
  // was necessarily delayed behind it on a single-worker setup.
  const overCadence = decodeMs.filter(ms => ms > 15_000).length;
  return {
    poolSize: pass.poolSize,
    windows: decodeLog.length,
    totalMessagesDecoded: totalMsgs,
    avgDecodeMs: decodeMs.length ? Math.round(decodeMs.reduce((a, b) => a + b, 0) / decodeMs.length) : 0,
    maxDecodeMs: decodeMs.length ? Math.round(Math.max(...decodeMs)) : 0,
    windowsOverCadence: overCadence,
    unresolvedHashedCallsigns: unresolvedHashes,
    slotUsage: decodeLog.reduce<Record<number, number>>((acc, e) => { acc[e.slot] = (acc[e.slot] ?? 0) + 1; return acc; }, {}),
  };
}

async function main() {
  if (spawnSync('pactl', ['--version']).status !== 0) {
    throw new Error('pactl not found — this script needs PipeWire/pactl on PATH');
  }
  if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    throw new Error('No DISPLAY/WAYLAND_DISPLAY — this test needs a real display (headless has no vsync/GPU and skews decode timing)');
  }

  const sinkModuleId = createSink();
  console.log(`created null sink '${SINK_NAME}' (module ${sinkModuleId})`);

  const browser = await firefox.launch({
    executablePath: findFirefox(),
    headless: false,
    // Auto-grant getUserMedia so the app tab's mic capture starts without a
    // permission dialog blocking the script — the mic stream itself is real
    // (routed from the WebSDR via PipeWire), not Firefox's fake-stream mode.
    firefoxUserPrefs: { 'media.navigator.permission.disabled': true },
  });
  const results: PassResult[] = [];
  try {
    for (const poolSize of POOL_SIZES) {
      results.push(await runPass(browser, poolSize));
    }
  } finally {
    await browser.close().catch(() => {});
    destroySink(sinkModuleId);
    console.log(`removed null sink (module ${sinkModuleId})`);
  }

  const summaries = results.map(summarize);
  writeFileSync(OUT, JSON.stringify({ summaries, raw: results }, null, 2));

  console.log('\n=== RESULTS ===');
  for (const s of summaries) {
    console.log(`\npool size ${s.poolSize}:`);
    console.log(`  windows decoded:            ${s.windows}`);
    console.log(`  total messages:             ${s.totalMessagesDecoded}`);
    console.log(`  avg decode time:            ${s.avgDecodeMs}ms`);
    console.log(`  max decode time:            ${s.maxDecodeMs}ms`);
    console.log(`  windows over 15s cadence:   ${s.windowsOverCadence}  (backlog risk on single-worker)`);
    console.log(`  unresolved hashed calls:    ${s.unresolvedHashedCallsigns}  (hash-table dilution proxy)`);
    console.log(`  slot usage:                 ${JSON.stringify(s.slotUsage)}`);
  }
  console.log(`\nfull results written to ${OUT}`);
}

main().catch(err => { console.error(err); process.exit(1); });
