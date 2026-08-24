// Real-Firefox repro for a reported bug: the ESP32 bridge hangs a few
// seconds after TX audio is sent via the REGULAR FT8 transmit path (not
// the Bridge panel's manual "Send Mic to Radio" button — see
// tx-hang-repro.ts for that one). Drives the actual FT8 mode's "Start TX"
// button with the output sink set to "ESP32 Bridge", against the real
// bridge, while polling /status concurrently.
//
// Usage: npx tsx scripts/ft8-tx-hang-repro.ts [bridge-ip] [duration-seconds]
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
const DURATION_S = Number(process.argv[3] || 60);
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
    const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
    page.on('console', (msg) => consoleLines.push(`[console.${msg.type()}] ${msg.text()}`));
    page.on('pageerror', (e) => consoleLines.push(`[pageerror] ${e.message}`));
    page.on('crash', () => consoleLines.push('[PAGE-CRASHED]'));

    const wsUrl = `ws://${BRIDGE_IP}/cat`;
    await page.addInitScript(`
      localStorage.setItem('signal-decoder:cat-connection-config', JSON.stringify({
        presetIdx: 0, transport: 'websocket', wsUrl: ${JSON.stringify(wsUrl)},
        baudRate: 38400, dataBits: 8, stopBits: 1, parity: 'none',
        timeoutMs: 200, pollIntervalMs: 500, debug: false,
      }));
      localStorage.setItem('ft_mycall', 'PU7FTW');
      localStorage.setItem('ft_mygrid', '');
      // Explicitly OFF — this test must never key the radio's real PTT
      // (safety-critical standing rule), regardless of whether a radio is
      // physically connected right now. Only the bridge's /audio mic-send
      // WebSocket traffic is under test here, not RF transmission.
      localStorage.setItem('ft_auto_ptt', 'false');
    `);

    console.log(`Navigating to ${APP_URL} (FT8 mode) ...`);
    await page.goto(APP_URL, { waitUntil: 'load', timeout: 20000 });
    await page.waitForTimeout(1500);

    // Switch to FT8/4 mode.
    const ftBtn = page.getByRole('button', { name: /^ft8\/4$/i }).first();
    await ftBtn.click();
    console.log('Switched to FT8/4 mode');
    await page.waitForTimeout(1000);

    // Connect CAT.
    const connectBtn = page.getByRole('button', { name: /connect radio/i }).first();
    if (await connectBtn.count() > 0) {
      await connectBtn.click();
      console.log('Clicked "Connect Radio"');
    }
    await page.waitForTimeout(3000);
    const disconnectVisible = await page.getByRole('button', { name: /^disconnect$/i }).count() > 0;
    console.log(`CAT connection state: ${disconnectVisible ? 'connected' : 'NOT connected'}`);

    // Start Decoding — this is what lifts globalAudio (and, per App.tsx's
    // handleStart(), auto-connects the bridge's own /audio if reachable and
    // not in I/Q mode) — needed before TX's audio graph/sink selector is
    // meaningfully wired up.
    const startDecodingBtn = page.getByRole('button', { name: /start decoding/i }).first();
    if (await startDecodingBtn.count() > 0) {
      await startDecodingBtn.click();
      console.log('Clicked "Start Decoding"');
      await page.waitForTimeout(2000);
    }

    // "Transmit" is a native <details>/<summary> accordion — click the
    // <summary> element to expand it and reveal the sink selector/Start TX
    // button (getByText with exact match fails here since the summary also
    // contains TxSummaryChips sibling text).
    const transmitSummary = page.locator('summary').filter({ hasText: 'Transmit' }).first();
    if (await transmitSummary.count() > 0) {
      await transmitSummary.click();
      console.log('Expanded "Transmit" section');
      await page.waitForTimeout(500);
    } else {
      console.log('WARNING: "Transmit" <summary> not found');
    }

    await page.screenshot({ path: '/tmp/ft8-before-sink-select.png', fullPage: true });

    // Select "ESP32 Bridge (radio mic-in)" as the TX output sink.
    const outputSelect = page.locator('select').filter({ hasText: /Local speaker|ESP32 Bridge/i }).first();
    if (await outputSelect.count() > 0) {
      await outputSelect.scrollIntoViewIfNeeded();
      try {
        await outputSelect.selectOption('bridge', { timeout: 8000 });
        console.log('Selected "ESP32 Bridge" as TX output sink');
      } catch (e) {
        console.log('WARNING: could not select TX output sink —', (e as Error).message.split('\n')[0]);
      }
    } else {
      console.log('WARNING: TX output sink selector not found');
    }
    await page.waitForTimeout(1000);

    // Start polling /status concurrently.
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

    // Start TX — with Auto-CQ, this should begin transmitting CQ calls
    // repeatedly, driving real /audio traffic to the bridge over the full
    // test window (FT8's ~15s cadence means several TX cycles in 60s).
    const startTxBtn = page.getByRole('button', { name: /^start tx$/i }).first();
    if (await startTxBtn.count() > 0) {
      const disabled = await startTxBtn.isDisabled();
      console.log(`"Start TX" button found, disabled=${disabled}`);
      if (!disabled) {
        await startTxBtn.click();
        console.log('Clicked "Start TX"');
      } else {
        console.log('ERROR: "Start TX" is disabled — canOperate() likely false (bad callsign/grid?)');
      }
    } else {
      console.log('ERROR: "Start TX" button not found');
    }

    console.log(`Watching for ${DURATION_S}s...`);
    await page.waitForTimeout(DURATION_S * 1000);

    clearInterval(pollInterval);

    console.log('\n=== /status poll timeline ===');
    for (const line of statusLog) console.log(' ', line);

    console.log('\n=== browser console/errors (last 80) ===');
    for (const line of consoleLines.slice(-80)) console.log(' ', line);

    console.log(`\n=== VERDICT ===`);
    if (hangDetectedAt !== null) {
      console.log(`HANG REPRODUCED: device became unreachable at t=${(hangDetectedAt / 1000).toFixed(1)}s, last good uptime_s=${lastGoodUptime}`);
    } else {
      console.log('No hang observed — device stayed reachable throughout.');
    }

    await page.screenshot({ path: '/tmp/ft8-tx-hang-repro-final.png', fullPage: true });
    console.log('Screenshot saved to /tmp/ft8-tx-hang-repro-final.png');
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
