/**
 * RTTY decode comparison: local SolidJS build vs. the deployed production
 * (Next.js) build, fed the SAME live WebSDR audio at the SAME time.
 *
 * Adapted from scripts/ft8-pool-vs-production.ts (see that file for the full
 * writeup of the PipeWire routing discoveries this reuses verbatim) — swaps
 * the FT8/4 mode + Windows/Total/Last# counters for RTTY mode + Center Freq
 * tuning + RTTY Output char-count/text, since this is chasing a suspected
 * decode-quality regression from the Next.js→SolidJS migration, not a pool
 * size comparison.
 *
 * Drives THREE tabs at once:
 *   1. the WebSDR (audio source)
 *   2. the local dev server (SolidJS port, http://localhost:3000 by default —
 *      matches this repo's convention of the user's own dev server on 3000)
 *   3. the deployed production build (https://acesso.github.io/Signal-Decoder/,
 *      the pre-migration Next.js app)
 *
 * Both app tabs' mic capture is routed from the SAME null-sink monitor, so
 * they decode identical audio at identical band conditions — a true
 * apples-to-apples comparison instead of two runs that might land on
 * different signal activity.
 *
 * Requires:
 *  - the local dev server already running (this script does NOT start one)
 *  - a real (non-headless) display — DISPLAY or WAYLAND_DISPLAY set
 *  - pactl + pw-dump + pw-link (PipeWire) on PATH
 *  - internet access to reach the production URL and the WebSDR
 *
 * Usage:
 *   npx tsx scripts/rtty-vs-production.ts [--minutes 5] [--freq 10100] [--center 800]
 *     [--local http://localhost:3000] [--prod https://acesso.github.io/Signal-Decoder/]
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
const FREQ_KHZ   = arg('freq', '10100');
const CENTER_HZ  = Number(arg('center', '800'));
const LOCAL_URL  = arg('local', 'http://localhost:3000');
const PROD_URL   = arg('prod', 'https://acesso.github.io/Signal-Decoder/');
const WEBSDR_URL = arg('websdr', 'http://websdr.ewi.utwente.nl:8901');
const SINK_NAME  = 'rttyprodcompare';
const OUT        = arg('out', 'rtty-vs-production-results.json');
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
interface PwObj { id: number; type: string; info?: { props?: Record<string, unknown>; ['input-port-id']?: number; ['output-port-id']?: number } }
function pwDump(): PwObj[] {
  return JSON.parse(sh('pw-dump'));
}

/**
 * Force-links a browser tab's mic-capture node to a sink's monitor ports.
 *
 * Empirically verified (via a raw PipeWire node dump — see the diagnostic
 * left in main() below) that each app tab opens exactly ONE
 * Stream/Input/Audio "Nightly" node despite App.tsx's handleStart() calling
 * BOTH globalAudio.start() and the active decoder's own start(): whichever
 * of those two getUserMedia() calls runs second reuses the browser's
 * already-granted MediaStream/device rather than opening a second distinct
 * OS-level capture — so there is exactly one real capture node per tab, not
 * two. `excludeNodeIds` skips nodes already claimed by an earlier call —
 * needed here because BOTH app tabs share the same PipeWire node.name
 * ("Nightly"), so the two calls in main() disambiguate by calling this once
 * per tab in creation order, excluding whichever node the previous call
 * already used.
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

/**
 * Checks whether a capture node's input ports are CURRENTLY linked from the
 * given sink's monitor ports (true) or have been silently relinked to
 * something else — e.g. WirePlumber's autoconnect policy reasserting the
 * physical mic — since the last forceLinkCapture call (false). Used to
 * verify the routing actually holds for the full capture duration instead
 * of assuming the one-shot link from setup survives unattended.
 */
function isCaptureLinkedToSink(nodeId: number, sinkName: string): boolean {
  const dump = pwDump();
  const nodes = dump.filter(o => o.type === 'PipeWire:Interface:Node');
  const ports = dump.filter(o => o.type === 'PipeWire:Interface:Port');
  const links = dump.filter(o => o.type === 'PipeWire:Interface:Link');

  const sinkNode = nodes.find(n => n.info?.props?.['node.name'] === sinkName);
  if (!sinkNode) return false;
  const monitorPortIds = new Set(
    ports.filter(p => p.info?.props?.['node.id'] === sinkNode.id
      && p.info?.props?.['port.direction'] === 'out'
      && String(p.info?.props?.['port.name'] ?? '').startsWith('monitor_')).map(p => p.id),
  );
  const capturePortIds = new Set(
    ports.filter(p => p.info?.props?.['node.id'] === nodeId && p.info?.props?.['port.direction'] === 'in').map(p => p.id),
  );
  const feedingLinks = links.filter(l => capturePortIds.has(l.info?.['input-port-id'] as number));
  if (feedingLinks.length === 0) return false;
  return feedingLinks.every(l => monitorPortIds.has(l.info?.['output-port-id'] as number));
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

  // RTTY needs far less passband than FT8's 2.7kHz sub-band — mark/space
  // tones at a 450Hz shift centered near 800Hz span roughly 300-1300Hz, so
  // ~1.5kHz comfortably covers both tones plus guard band either side.
  const widerBtn = page.getByRole('button', { name: 'wider' }).first();
  for (let i = 0; i < 4; i++) {
    const label = await page.locator('text=/Filter:\\s*[\\d.]+\\s*kHz/').first().textContent().catch(() => '');
    const khz = Number(label?.match(/([\d.]+)\s*kHz/)?.[1] ?? '0');
    if (khz >= 1500) break;
    await widerBtn.click().catch(() => {});
    await page.waitForTimeout(200);
  }
  await page.waitForTimeout(1000);
}

async function setupAppTab(page: Page, url: string, label: string) {
  await page.goto(url, { waitUntil: 'load' });
  // RTTY is the default mode on load in both apps — no mode click needed,
  // but click it explicitly anyway in case a prior localStorage session
  // (persisted mode) left either app on a different tab.
  await page.getByRole('button', { name: 'RTTY', exact: true }).click().catch(() => {});
  await page.waitForTimeout(500);

  // Center Freq input — inside the active session's config card ("Decoder
  // Sessions" panel), labeled "Center Freq (Hz)". Clear and retype so this
  // works whether the field currently shows 500 (default) or a leftover
  // value from a previous run. Uses real keyboard events (not .fill()) so
  // it exercises the exact same commit path a human typing would.
  const centerInput = page.locator('label:has-text("Center Freq") input, label:has-text("Center Freq") input[type="text"]').first();
  await centerInput.click({ clickCount: 3 });
  await centerInput.press('Backspace');
  await centerInput.type(String(CENTER_HZ), { delay: 40 });
  await centerInput.evaluate((el: HTMLInputElement) => el.blur());
  await page.waitForTimeout(200);
  const confirmedCenter = await centerInput.inputValue().catch(() => '?');
  console.log(`[${label}] Center Freq set to ${confirmedCenter} Hz (requested ${CENTER_HZ})`);

  const startBtn = page.getByRole('button', { name: 'Start Decoding' });
  const btnCount = await startBtn.count();
  const btnEnabled = btnCount > 0 ? await startBtn.first().isEnabled().catch(() => false) : false;
  console.log(`[${label}] Start Decoding button: count=${btnCount} enabled=${btnEnabled}`);
  await startBtn.first().click();
  // Give getUserMedia's permission grant + AudioContext setup time to
  // actually complete — the click returns immediately, well before the
  // async mic-open promise resolves.
  await page.waitForTimeout(2000);
  const stopVisible = await page.getByRole('button', { name: 'Stop' }).first().isVisible().catch(() => false);
  const errorText = await page.locator('text=/not supported|permission|failed|error/i').first().textContent().catch(() => null);
  console.log(`[${label}] decoding started — Stop button visible=${stopVisible}${errorText ? `  ERROR TEXT: "${errorText}"` : ''}`);
}

async function readCounters(page: Page): Promise<{ chars: number | null; text: string | null }> {
  const charsLabel = await page.locator('text=/\\d+ chars/').first().textContent().catch(() => null);
  const chars = charsLabel ? Number(charsLabel.match(/(\d+)/)?.[1]) : null;
  // RTTY Output is a <textarea> in the SolidJS app — its live content lives
  // in the .value PROPERTY, not .textContent (which only reflects the
  // initial static markup, always empty here since it's set via JS). The
  // Next.js app may render a plain read-only <div>/<pre> instead, so check
  // both a .value-bearing form element AND falling back to textContent.
  const text = await page.evaluate(() => {
    const header = Array.from(document.querySelectorAll('h2, h3')).find(h => h.textContent?.includes('RTTY Output'));
    const container = header?.closest('div')?.parentElement;
    const box = container?.querySelector('textarea, div.overflow-y-auto, pre') as (HTMLTextAreaElement | HTMLElement) | null;
    if (!box) return null;
    if ('value' in box) return (box as HTMLTextAreaElement).value;
    return box.textContent;
  }).catch(() => null);
  return { chars: Number.isFinite(chars) ? chars : null, text };
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

    console.log('opening local (SolidJS) build...');
    await setupAppTab(localPage, LOCAL_URL, 'local');
    console.log('opening production (Next.js) build...');
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

    // Raw diagnostic: list every "Nightly" audio node BEFORE clustering, so
    // a wrong cluster count is diagnosable instead of just failing blind.
    {
      const dump = pwDump();
      const nightlyNodes = dump.filter(o => o.type === 'PipeWire:Interface:Node' && o.info?.props?.['node.name'] === FIREFOX_APP_NAME);
      console.log(`  raw Nightly nodes (${nightlyNodes.length}):`);
      for (const n of nightlyNodes) {
        console.log(`    id=${n.id} serial=${n.info?.props?.['object.serial']} class=${n.info?.props?.['media.class']} media.name=${n.info?.props?.['media.name']}`);
      }
    }

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
    const samples: Array<{
      atMs: number;
      local: Awaited<ReturnType<typeof readCounters>>;
      prod: Awaited<ReturnType<typeof readCounters>>;
      localLinked: boolean;
      prodLinked: boolean;
    }> = [];
    while (Date.now() - t0 < MINUTES * 60_000) {
      await new Promise(r => setTimeout(r, 30_000));

      // WirePlumber's autoconnect policy can silently relink a capture node
      // back to the physical mic at any point, not just immediately after
      // getUserMedia() opens — verify the link every tick and re-assert it
      // if broken, rather than trusting the one-shot setup-time link to
      // survive unattended for the full capture duration.
      const localLinked = isCaptureLinkedToSink(localNodeId, SINK_NAME);
      const prodLinked = isCaptureLinkedToSink(prodNodeId, SINK_NAME);
      if (!localLinked) { console.warn(`  !! local capture link was broken — relinking`); forceLinkCapture(FIREFOX_APP_NAME, SINK_NAME, new Set([prodNodeId])); }
      if (!prodLinked) { console.warn(`  !! prod capture link was broken — relinking`); forceLinkCapture(FIREFOX_APP_NAME, SINK_NAME, new Set([localNodeId])); }

      const [local, prod] = await Promise.all([readCounters(localPage), readCounters(prodPage)]);
      const atMs = Date.now() - t0;
      samples.push({ atMs, local, prod, localLinked, prodLinked });
      console.log(`t+${Math.round(atMs / 1000)}s  local: chars=${local.chars} linked=${localLinked}  |  prod: chars=${prod.chars} linked=${prodLinked}`);
    }

    const finalLocal = await readCounters(localPage);
    const finalProd = await readCounters(prodPage);

    // Pull both builds' wall-clock-timestamped raw-audio capture rings
    // (added identically to both, see multiProcessor.ts / useMultiRTTYProcessor.ts)
    // for offline sample-for-sample alignment — the only way to tell "the
    // decoder got different audio" apart from "same audio, decoded worse."
    const localCapture = await localPage.evaluate('window.__rttyCapture ?? []') as Array<{ t: number; s: number[] }>;
    const prodCapture = await prodPage.evaluate('window.__rttyCapture ?? []') as Array<{ t: number; s: number[] }>;
    writeFileSync('/tmp/rtty-capture-local.json', JSON.stringify(localCapture));
    writeFileSync('/tmp/rtty-capture-prod.json', JSON.stringify(prodCapture));
    console.log(`captures: local=${localCapture.length} buffers, prod=${prodCapture.length} buffers — written to /tmp/rtty-capture-{local,prod}.json`);

    await sdrPage.close().catch(() => {});
    await localPage.close().catch(() => {});
    await prodPage.close().catch(() => {});

    writeFileSync(OUT, JSON.stringify({ centerHz: CENTER_HZ, freqKhz: FREQ_KHZ, samples, finalLocal, finalProd }, null, 2));

    console.log('\n=== RESULTS ===');
    console.log(`local (SolidJS, ${LOCAL_URL}):`);
    console.log(`  chars=${finalLocal.chars}`);
    console.log(`  text: ${JSON.stringify(finalLocal.text)}`);
    console.log(`production (Next.js, ${PROD_URL}):`);
    console.log(`  chars=${finalProd.chars}`);
    console.log(`  text: ${JSON.stringify(finalProd.text)}`);
    console.log(`\nfull results written to ${OUT}`);
  } finally {
    await browser.close().catch(() => {});
    destroySink(sinkModuleId);
    console.log(`removed null sink (module ${sinkModuleId})`);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
