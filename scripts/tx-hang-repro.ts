// Real-Firefox repro for a reported bug: the ESP32 bridge hangs a few
// seconds after TX audio is sent from the web app (regular decode TX or
// the Bridge panel's "Send Mic to Radio" button). Drives the ACTUAL app UI
// in a real (headless) Firefox — not a synthetic Node WebSocket script —
// against the real bridge, and polls /status concurrently to catch the
// exact moment the device stops responding.
//
// Usage: npx tsx scripts/tx-hang-repro.ts [bridge-ip] [duration-seconds]
import { firefox } from 'playwright-core';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

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

const BRIDGE_IP = process.argv[2] || '192.168.0.8';
const DURATION_S = Number(process.argv[3] || 45);
const APP_URL = 'http://localhost:3000/';

async function main() {
  const browser = await firefox.launch({
    executablePath: findFirefox(),
    headless: true,
    firefoxUserPrefs: {
      'media.navigator.streams.fake': true,
      'media.navigator.permission.disabled': true,
    },
  });

  const consoleLines: string[] = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    page.on('console', (msg) => consoleLines.push(`[console.${msg.type()}] ${msg.text()}`));
    page.on('pageerror', (e) => consoleLines.push(`[pageerror] ${e.message}`));
    page.on('crash', () => consoleLines.push('[PAGE-CRASHED]'));

    // Seed the CAT connection config in localStorage BEFORE navigation, so
    // the app boots straight into "connected to the real bridge over
    // websocket" without needing to click through the transport UI.
    const wsUrl = `ws://${BRIDGE_IP}/cat`;
    await page.addInitScript(`
      localStorage.setItem('signal-decoder:cat-connection-config', JSON.stringify({
        presetIdx: 0, transport: 'websocket', wsUrl: ${JSON.stringify(wsUrl)},
        baudRate: 38400, dataBits: 8, stopBits: 1, parity: 'none',
        timeoutMs: 200, pollIntervalMs: 500, debug: false,
      }));
    `);

    console.log(`Navigating to ${APP_URL} ...`);
    await page.goto(APP_URL, { waitUntil: 'load', timeout: 20000 });
    await page.waitForTimeout(1500);

    // Connect the CAT WebSocket — find and click the "Connect" button in
    // the Radio CAT panel. Falls back to reporting the DOM if not found,
    // rather than guessing at a selector that might not match.
    const connectBtn = page.getByRole('button', { name: /connect radio/i }).first();
    if (await connectBtn.count() > 0) {
      await connectBtn.click();
      console.log('Clicked "Connect Radio"');
    } else {
      console.log('WARNING: no "Connect Radio" button found — CAT may already be auto-connecting, or the selector needs adjusting');
    }
    await page.waitForTimeout(3000);
    const disconnectVisible = await page.getByRole('button', { name: /^disconnect$/i }).count() > 0;
    console.log(`CAT connection state: ${disconnectVisible ? 'connected (Disconnect button visible)' : 'NOT connected'}`);

    // Open the Bridge status panel (needed to reveal "Send Mic to Radio")
    // — this is an icon-only button with no visible text, matched by its
    // title attribute instead of a role/name query.
    const bridgeStatusBtn = page.locator('button[title*="ESP32 CAT bridge status"]').first();
    if (await bridgeStatusBtn.count() > 0) {
      await bridgeStatusBtn.click();
      console.log('Opened Bridge status panel');
      await page.waitForTimeout(1000);
    } else {
      console.log('WARNING: no "Bridge status" button found');
    }

    // Start polling /status concurrently, from Node (not the page), so we
    // have an independent, ground-truth timeline of when the device stops
    // responding — not dependent on the page's own state.
    let lastGoodUptime = -1;
    let hangDetectedAt: number | null = null;
    const statusLog: string[] = [];
    const pollStart = Date.now();
    const pollInterval = setInterval(async () => {
      const t = ((Date.now() - pollStart) / 1000).toFixed(1);
      try {
        const res = await fetch(`http://${BRIDGE_IP}/status`, { signal: AbortSignal.timeout(1500) });
        const j = await res.json();
        statusLog.push(`t=${t}s OK uptime_s=${j.uptime_s} ws_clients=${j.ws_clients}`);
        lastGoodUptime = j.uptime_s;
      } catch (e) {
        statusLog.push(`t=${t}s UNREACHABLE (${(e as Error).message})`);
        if (hangDetectedAt === null) hangDetectedAt = Date.now() - pollStart;
      }
    }, 1000);

    // "Send Mic to Radio" is disabled until the /audio WebSocket itself is
    // connected (audio.state().connected) — click "Listen to Radio" first,
    // same as an operator would.
    const listenBtn = page.getByRole('button', { name: /listen to radio/i }).first();
    if (await listenBtn.count() > 0) {
      await listenBtn.click();
      console.log('Clicked "Listen to Radio"');
      await page.waitForTimeout(2000);
    } else {
      console.log('WARNING: no "Listen to Radio" button found');
    }

    // Click "Send Mic to Radio" — this is the actual reported trigger.
    const sendMicBtn = page.getByRole('button', { name: /send mic to radio/i }).first();
    if (await sendMicBtn.count() > 0) {
      try {
        await sendMicBtn.click({ timeout: 8000 });
        console.log('Clicked "Send Mic to Radio"');
      } catch (e) {
        console.log('ERROR: could not click "Send Mic to Radio" —', (e as Error).message.split('\n')[0]);
      }
    } else {
      console.log('ERROR: "Send Mic to Radio" button not found — dumping visible button labels');
      const buttons = await page.getByRole('button').allTextContents();
      console.log('Visible buttons:', buttons.filter((b) => b.trim()));
    }

    console.log(`Watching for ${DURATION_S}s...`);
    await page.waitForTimeout(DURATION_S * 1000);

    clearInterval(pollInterval);

    console.log('\n=== /status poll timeline ===');
    for (const line of statusLog) console.log(' ', line);

    console.log('\n=== browser console/errors ===');
    for (const line of consoleLines.slice(-60)) console.log(' ', line);

    console.log(`\n=== VERDICT ===`);
    if (hangDetectedAt !== null) {
      console.log(`HANG REPRODUCED: device became unreachable at t=${(hangDetectedAt / 1000).toFixed(1)}s, last good uptime_s=${lastGoodUptime}`);
    } else {
      console.log('No hang observed — device stayed reachable throughout.');
    }

    await page.screenshot({ path: '/tmp/tx-hang-repro-final.png', fullPage: true });
    console.log('Screenshot saved to /tmp/tx-hang-repro-final.png');
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
