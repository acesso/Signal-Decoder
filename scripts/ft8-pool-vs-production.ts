/**
 * FT8 decode comparison: local pool build vs. the deployed production build,
 * fed the SAME live WebSDR audio at the SAME time.
 *
 * Unlike scripts/ft8-pool-live-compare.ts (sequential passes — pool size 1
 * then pool size 4, one after another), this drives THREE tabs at once:
 *   1. the WebSDR (audio source)
 *   2. the local dev server (pool build, http://localhost:3002)
 *   3. the deployed production build (https://acesso.github.io/Signal-Decoder/)
 *
 * Both app tabs' mic capture is routed from the SAME null-sink monitor, so
 * they decode identical audio at identical band conditions — a true
 * apples-to-apples comparison instead of two runs that might land on
 * different signal activity.
 *
 * Requires:
 *  - the dev server running on http://localhost:3002 (npm run dev:test)
 *  - a real (non-headless) display — DISPLAY or WAYLAND_DISPLAY set
 *  - pactl (PipeWire) on PATH
 *  - internet access to reach the production URL and the WebSDR
 *
 * Usage:
 *   npx tsx scripts/ft8-pool-vs-production.ts [--minutes 5] [--freq 7074]
 *     [--local http://localhost:3002] [--prod https://acesso.github.io/Signal-Decoder/]
 *     [--websdr http://websdr.ewi.utwente.nl:8901]
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
const LOCAL_URL  = arg('local', 'http://localhost:3002');
const PROD_URL   = arg('prod', 'https://acesso.github.io/Signal-Decoder/');
const WEBSDR_URL = arg('websdr', 'http://websdr.ewi.utwente.nl:8901');
const SINK_NAME  = 'ft8prodcompare';
const OUT        = arg('out', 'ft8-pool-vs-production-results.json');
const FIREFOX_APP_NAME = 'Nightly'; // see ft8-pool-live-compare.ts for why

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

function sh(cmd: string): string {
  // pw-dump's JSON on a busy graph exceeds execSync's 1MB default maxBuffer
  // and crashes with ENOBUFS/SIGPIPE — confirmed the hard way.
  return execSync(cmd, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).trim();
}
function createSink(): number {
  return Number(sh(`pactl load-module module-null-sink sink_name=${SINK_NAME} sink_properties=device.description=${SINK_NAME}`));
}
function destroySink(moduleId: number) {
  try { execSync(`pactl unload-module ${moduleId}`); } catch { /* already gone */ }
}
function findStreamId(kind: 'sink-inputs', appNameSubstr: string): string | null {
  const out = sh(`pactl list ${kind}`);
  const blocks = out.split(/\n(?=Sink Input #)/);
  for (const block of blocks.reverse()) {
    if (!block.includes(appNameSubstr)) continue;
    const m = block.match(/^Sink Input #(\d+)/);
    if (m) return m[1];
  }
  return null;
}
function moveStream(kind: 'sink-input', id: string, target: string) {
  execSync(`pactl move-${kind} ${id} ${target}`);
}

// ── Capture-direction routing (pw-link, not pactl) ──────────────────────────
// `pactl move-source-output` looks like it succeeds but WirePlumber's
// node.autoconnect policy silently re-links the capture stream back to the
// physical mic microseconds later (confirmed via `pw-link -l`) — the fix is
// to operate on the PipeWire graph directly instead. See the sister script
// ft8-pool-live-compare.ts for the fuller writeup of this discovery.
interface PwObj { id: number; type: string; info?: { props?: Record<string, unknown>; ['input-port-id']?: number } }
function pwDump(): PwObj[] {
  return JSON.parse(sh('pw-dump'));
}

/**
 * Force-links a browser tab's mic-capture node to a sink's monitor ports.
 * `excludeNodeIds` skips nodes already claimed by an earlier call — needed
 * here because BOTH app tabs share the same PipeWire node.name ("Nightly"),
 * so the two calls in main() disambiguate by calling this once per tab in
 * creation order, excluding whichever node the previous call already used.
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

async function setupWebSDR(page: Page) {
  const url = `${WEBSDR_URL}/?tune=${FREQ_KHZ}`;
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForTimeout(2000);

  // "start audio" is a full-width overlay blocking the controls beneath it —
  // must be clicked FIRST or later clicks silently fail (see
  // ft8-pool-live-compare.ts for the discovery of this).
  const startBtn = page.getByRole('button', { name: 'start audio' }).first();
  await startBtn.waitFor({ timeout: 15000 });
  await startBtn.click();
  await page.waitForTimeout(1000);

  const usbBtn = page.getByRole('button', { name: 'USB', exact: false }).first();
  if (await usbBtn.isVisible().catch(() => false)) await usbBtn.click().catch(() => {});

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

async function setupAppTab(page: Page, url: string, label: string) {
  await page.goto(url, { waitUntil: 'load' });
  await page.getByRole('button', { name: 'FT8/4' }).click();
  await page.waitForTimeout(1000);
  await page.getByRole('button', { name: 'Start Decoding' }).click();
  console.log(`[${label}] decoding started`);
}

async function readCounters(page: Page): Promise<{ windows: number | null; total: number | null; last: number | null }> {
  // "Windows"/"Total"/"Last #" are label/value pairs rendered as sibling divs
  // inside the same bordered box — find each label, read the value next to it.
  const read = async (label: string) => {
    const text = await page.evaluate((lbl: string) => {
      const labels = Array.from(document.querySelectorAll('div')).filter(d => d.textContent === lbl);
      for (const l of labels) {
        const valueDiv = l.nextElementSibling;
        if (valueDiv) return valueDiv.textContent;
      }
      return null;
    }, label).catch(() => null);
    const n = Number(text);
    return Number.isFinite(n) ? n : null;
  };
  return {
    windows: await read('Windows'),
    total: await read('Total'),
    last: await read('Last #'),
  };
}

async function main() {
  if (spawnSync('pactl', ['--version']).status !== 0) {
    throw new Error('pactl not found — this script needs PipeWire/pactl on PATH');
  }
  if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    throw new Error('No DISPLAY/WAYLAND_DISPLAY — needs a real display');
  }

  const sinkModuleId = createSink();
  console.log(`created null sink '${SINK_NAME}' (module ${sinkModuleId})`);

  const browser: Browser = await firefox.launch({
    executablePath: findFirefox(),
    headless: false,
    firefoxUserPrefs: { 'media.navigator.permission.disabled': true },
  });

  try {
    const sdrPage = await browser.newPage();
    const localPage = await browser.newPage();
    const prodPage = await browser.newPage();
    for (const [p, name] of [[sdrPage, 'websdr'], [localPage, 'local'], [prodPage, 'prod']] as const) {
      p.on('crash', () => console.error(`!! ${name} page crashed`));
      p.on('pageerror', e => console.error(`[${name}] page error:`, e.message));
    }

    console.log('opening WebSDR...');
    await setupWebSDR(sdrPage);

    console.log('opening local (pool) build...');
    await setupAppTab(localPage, LOCAL_URL, 'local');
    console.log('opening production build...');
    await setupAppTab(prodPage, PROD_URL, 'prod');

    // Route: WebSDR output → sink (plain pactl — this direction works fine).
    // BOTH app tabs' mic capture ← that sink's monitor, via pw-link directly
    // (pactl move-source-output doesn't hold — see forceLinkCapture doc).
    let sdrStreamId: string | null = null;
    for (let i = 0; i < 20 && !sdrStreamId; i++) {
      await new Promise(r => setTimeout(r, 500));
      sdrStreamId ??= findStreamId('sink-inputs', FIREFOX_APP_NAME);
    }
    if (sdrStreamId) moveStream('sink-input', sdrStreamId, SINK_NAME);
    await new Promise(r => setTimeout(r, 1000)); // let both getUserMedia streams open first

    // prodPage was opened after localPage, so it has the higher object.serial
    // — claim it first (no exclusion), then claim local's node explicitly
    // excluding whichever node prod just took.
    const prodNodeId = forceLinkCapture(FIREFOX_APP_NAME, SINK_NAME);
    const localNodeId = forceLinkCapture(FIREFOX_APP_NAME, SINK_NAME, new Set([prodNodeId]));
    console.log(`routed: sdr sink-input=${sdrStreamId ?? '?'}  local capture node=${localNodeId}  prod capture node=${prodNodeId}`);

    console.log(`\ncapturing for ${MINUTES} minutes — DO NOT CLOSE THE BROWSER WINDOWS...\n`);
    const t0 = Date.now();
    // Sample counters periodically so we can see progress/timing, not just
    // the final tally.
    const samples: Array<{ atMs: number; local: Awaited<ReturnType<typeof readCounters>>; prod: Awaited<ReturnType<typeof readCounters>> }> = [];
    while (Date.now() - t0 < MINUTES * 60_000) {
      await new Promise(r => setTimeout(r, 30_000));
      const [local, prod] = await Promise.all([readCounters(localPage), readCounters(prodPage)]);
      const atMs = Date.now() - t0;
      samples.push({ atMs, local, prod });
      console.log(`t+${Math.round(atMs / 1000)}s  local: windows=${local.windows} total=${local.total} last=${local.last}  |  prod: windows=${prod.windows} total=${prod.total} last=${prod.last}`);
    }

    const finalLocal = await readCounters(localPage);
    const finalProd = await readCounters(prodPage);

    await sdrPage.close().catch(() => {});
    await localPage.close().catch(() => {});
    await prodPage.close().catch(() => {});

    writeFileSync(OUT, JSON.stringify({ samples, finalLocal, finalProd }, null, 2));

    console.log('\n=== RESULTS ===');
    console.log('local (pool build):      windows=%d total=%d last=%d', finalLocal.windows, finalLocal.total, finalLocal.last);
    console.log('production (deployed):   windows=%d total=%d last=%d', finalProd.windows, finalProd.total, finalProd.last);
    console.log(`\nfull results written to ${OUT}`);
  } finally {
    await browser.close().catch(() => {});
    destroySink(sinkModuleId);
    console.log(`removed null sink (module ${sinkModuleId})`);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
