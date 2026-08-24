// Smoke test for the I/Q-mode normalization work: confirms a given
// non-FT8 decoder can actually start recording while the bridge is in
// I/Q mode, and that the I/Q passband marker view renders instead of that
// decoder's own tone markers — proving the audioSourceKind()/getBridge()
// wiring each processor got (multiProcessor.ts, cw/processor.ts,
// sstv/audioProcessor.ts, mfsk/processor.ts) actually works end-to-end
// against real hardware, not just typechecks.
//
// Usage: npx tsx scripts/rtty-iq-mode-smoke.ts [bridge-ip] [mode]
// mode: rtty (default) | cw | sstv | mfsk
import { firefox } from 'playwright-core';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

function findFirefox(): string {
  const cache = join(homedir(), '.cache', 'ms-playwright');
  const builds = readdirSync(cache).filter((d) => d.startsWith('firefox-')).sort().reverse();
  for (const b of builds) {
    const exe = join(cache, b, 'firefox', 'firefox');
    if (existsSync(exe)) return exe;
  }
  throw new Error('No playwright Firefox found');
}

const BRIDGE_IP = process.argv[2] || '192.168.0.8';
const MODE = (process.argv[3] || 'rtty').toLowerCase();
const MODE_BUTTON: Record<string, RegExp> = {
  rtty: /^rtty$/i,
  cw: /^cw$/i,
  sstv: /^sstv$/i,
  mfsk: /^mfsk$/i,
};
const APP_URL = 'http://localhost:3002/';

async function main() {
  const modeButtonRe = MODE_BUTTON[MODE];
  if (!modeButtonRe) throw new Error(`unknown mode "${MODE}" — expected one of ${Object.keys(MODE_BUTTON).join(', ')}`);

  const browser = await firefox.launch({
    executablePath: findFirefox(),
    headless: true,
    firefoxUserPrefs: { 'media.navigator.streams.fake': true, 'media.navigator.permission.disabled': true },
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
    page.on('console', (msg) => { if (msg.type() === 'error') console.log('[console error]', msg.text()); });
    page.on('pageerror', (err) => console.log('[pageerror]', err.message));

    const wsUrl = `ws://${BRIDGE_IP}/cat`;
    await page.addInitScript(`
      localStorage.setItem('signal-decoder:cat-connection-config', JSON.stringify({
        presetIdx: 0, transport: 'websocket', wsUrl: ${JSON.stringify(wsUrl)},
        baudRate: 38400, dataBits: 8, stopBits: 1, parity: 'none',
        timeoutMs: 200, pollIntervalMs: 500, debug: false,
      }));
    `);
    await page.goto(APP_URL, { waitUntil: 'load', timeout: 15000 });
    await page.waitForTimeout(1200);

    await page.getByRole('button', { name: modeButtonRe }).first().click();
    await page.waitForTimeout(500);

    // Connect CAT (this is what makes App.tsx's handleStart() see a wsUrl).
    await page.getByRole('button', { name: /connect radio/i }).first().click();
    await page.waitForTimeout(2500);

    const status = await fetch(`http://${BRIDGE_IP}/status`, { signal: AbortSignal.timeout(3000) }).then((r) => r.json());
    console.log(`bridge input_mode: ${status.input_mode}, testing mode: ${MODE}`);
    if (status.input_mode !== 'iq') {
      console.log('SKIP: bridge is not in I/Q mode, cannot verify the I/Q decode path against real hardware');
      return;
    }

    // Start decoding via the single global Start/Stop button (App.tsx's
    // globalControls dispatch to whichever decoder is active) — this is
    // what should now route through iqBridge via each decoder's own
    // audioSourceKind()/getBridge() -> its processor's acquireBridgeSource().
    // Note the button reads "Start Decoding" -> "Stop" (not "Stop
    // Decoding") once recording — see App.tsx's inline TopBar markup.
    const startBtn = page.getByRole('button', { name: /start decoding/i }).first();
    await startBtn.click();
    await page.waitForTimeout(3000);

    const isRecording = await page.getByRole('button', { name: /^stop$/i }).first().isVisible().catch(() => false);
    console.log('isRecording (Stop button present):', isRecording);

    // Confirm the I/Q passband marker field is showing (proves the iqSource
    // branch rendered, not this decoder's own tone-marker fallback).
    const hasPassbandLabel = await page.evaluate(() => document.body.textContent?.includes('Passband') ?? false);
    console.log('Passband marker field present:', hasPassbandLabel);

    await page.waitForTimeout(1000);
    const stopBtn = page.getByRole('button', { name: /^stop$/i }).first();
    if (await stopBtn.isVisible().catch(() => false)) await stopBtn.click();

    if (!isRecording) throw new Error(`FAIL: ${MODE} did not start recording against the I/Q bridge`);
    if (!hasPassbandLabel) throw new Error(`FAIL: I/Q passband marker view did not render for ${MODE}`);
    console.log('PASS');
  } finally {
    await browser.close();
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error('FATAL:', e); process.exit(1); });
