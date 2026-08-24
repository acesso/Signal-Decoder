// Single-mode, tightly time-bounded TX capture — no mode switching, no
// long waits. Sets a REALISTIC (0dB, not the -50dB UI default meant for
// safe first-use on a laptop speaker) TX gain so the fundamental tone
// isn't artificially quiet relative to the noise floor, then captures raw
// sniffer samples for direct offline analysis.
//
// Usage: npx tsx scripts/tx-single-capture.ts [bridge-ip] [label] [watch-seconds]
import { firefox } from 'playwright-core';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

function findFirefox(): string {
  if (process.env.PLAYWRIGHT_FIREFOX_PATH) return process.env.PLAYWRIGHT_FIREFOX_PATH;
  const cache = join(homedir(), '.cache', 'ms-playwright');
  const builds = readdirSync(cache).filter((d) => d.startsWith('firefox-')).sort().reverse();
  for (const b of builds) {
    const exe = join(cache, b, 'firefox', 'firefox');
    if (existsSync(exe)) return exe;
  }
  throw new Error('No playwright Firefox found');
}

const BRIDGE_IP = process.argv[2] || '192.168.0.8';
const LABEL = process.argv[3] || 'capture';
const WATCH_S = Number(process.argv[4] || 70);
const APP_URL = 'http://localhost:3000/';

async function main() {
  const browser = await firefox.launch({
    executablePath: findFirefox(),
    headless: true,
    firefoxUserPrefs: { 'media.navigator.streams.fake': true, 'media.navigator.permission.disabled': true },
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
    const wsUrl = `ws://${BRIDGE_IP}/cat`;
    await page.addInitScript(`
      localStorage.setItem('signal-decoder:cat-connection-config', JSON.stringify({
        presetIdx: 0, transport: 'websocket', wsUrl: ${JSON.stringify(wsUrl)},
        baudRate: 38400, dataBits: 8, stopBits: 1, parity: 'none',
        timeoutMs: 200, pollIntervalMs: 500, debug: false,
      }));
      localStorage.setItem('ft_mycall', 'PU7FTW');
      localStorage.setItem('ft_mygrid', '');
      localStorage.setItem('ft_auto_ptt', 'false');
      localStorage.setItem('ft_autocq', 'true');
      localStorage.setItem('ft_autocq_interval_min', '1');
      localStorage.setItem('ft_tx_gain', '0.5623413251903491'); // -5dB — user-specified: 0dB clips, -50dB (the safe-speaker default) is too quiet to measure noise floor meaningfully
    `);
    await page.goto(APP_URL, { waitUntil: 'load', timeout: 15000 });
    await page.waitForTimeout(1200);
    await page.getByRole('button', { name: /^ft8\/4$/i }).first().click();
    await page.waitForTimeout(800);
    await page.getByRole('button', { name: /connect radio/i }).first().click();
    await page.waitForTimeout(2500);
    await page.locator('summary').filter({ hasText: 'Transmit' }).first().click();
    await page.waitForTimeout(400);
    await page.locator('select').filter({ hasText: /Local speaker|ESP32 Bridge/i }).first().selectOption('bridge');
    await page.waitForTimeout(400);

    const collected: number[] = [];
    const sniffWs = new WebSocket(`ws://${BRIDGE_IP}/audio-mic-sniff`);
    sniffWs.binaryType = 'arraybuffer';
    sniffWs.onmessage = (ev) => {
      if (!(ev.data instanceof ArrayBuffer)) return;
      const s = new Int16Array(ev.data);
      for (let i = 0; i < s.length; i++) collected.push(s[i]);
    };
    await new Promise<void>((resolve) => { sniffWs.onopen = () => resolve(); setTimeout(resolve, 2500); });

    const startTxBtn = page.getByRole('button', { name: /^start tx$/i }).first();
    if (!(await startTxBtn.isDisabled())) await startTxBtn.click();

    console.log(`[${LABEL}] watching for ${WATCH_S}s...`);
    await page.waitForTimeout(WATCH_S * 1000);
    sniffWs.close();
    await new Promise((r) => setTimeout(r, 400));

    const status: any = await fetch(`http://${BRIDGE_IP}/status`, { signal: AbortSignal.timeout(3000) }).then((r) => r.json());
    console.log(`[${LABEL}] collected ${collected.length} samples, codec rate ${status.sample_rate_hz}, input_mode ${status.input_mode}`);
    writeFileSync(`/tmp/tx-capture-${LABEL}.json`, JSON.stringify({ codecRate: status.sample_rate_hz, inputMode: status.input_mode, samples: collected }));
    console.log(`[${LABEL}] saved to /tmp/tx-capture-${LABEL}.json`);
  } finally {
    await browser.close();
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error('FATAL:', e); process.exit(1); });
