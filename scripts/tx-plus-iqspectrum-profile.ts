// Reproduces a real, precisely-described symptom: starting the I/Q
// spectrum view (/iq-data) while TX is active visibly degrades the TX
// audio immediately, and stopping the spectrum view immediately clears
// it. This profiles /system-stats (per-task CPU%, heap, DMA) at a fast
// cadence across: TX-only -> TX+iq-data -> TX-only again, to see exactly
// what resource shifts the moment /iq-data opens.
//
// Usage: npx tsx scripts/tx-plus-iqspectrum-profile.ts [bridge-ip]
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
const APP_URL = 'http://localhost:3000/';
const PHASE_S = 25; // seconds per phase

async function main() {
  const browser = await firefox.launch({
    executablePath: findFirefox(),
    headless: true,
    firefoxUserPrefs: { 'media.navigator.streams.fake': true, 'media.navigator.permission.disabled': true },
  });

  const statsLog: any[] = [];
  let phaseLabel = 'startup';
  const pollInterval = setInterval(async () => {
    try {
      const s: any = await fetch(`http://${BRIDGE_IP}/system-stats`, { signal: AbortSignal.timeout(1500) }).then((r) => r.json());
      const httpd = s.tasks?.find((t: any) => t.name === 'httpd');
      const audioTask = s.tasks?.find((t: any) => t.name === 'audio_monitor');
      const catTask = s.tasks?.find((t: any) => t.name === 'cat_uart_rx');
      statsLog.push({
        t: Date.now(), phase: phaseLabel,
        heap_free: s.heap_free, heap_largest_free_block: s.heap_largest_free_block,
        dma_free: s.dma_free, dma_largest_free_block: s.dma_largest_free_block,
        httpd_cpu: httpd?.cpu_pct, audio_cpu: audioTask?.cpu_pct, cat_cpu: catTask?.cpu_pct,
      });
    } catch (e) {
      statsLog.push({ t: Date.now(), phase: phaseLabel, error: (e as Error).message });
    }
  }, 500);

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
      localStorage.setItem('ft_tx_gain', '0.5623413251903491'); // -5dB
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
    const startTxBtn = page.getByRole('button', { name: /^start tx$/i }).first();
    if (!(await startTxBtn.isDisabled())) await startTxBtn.click();

    console.log(`Phase 1: TX only, ${PHASE_S}s`);
    phaseLabel = 'tx-only-1';
    await page.waitForTimeout(PHASE_S * 1000);

    console.log(`Phase 2: TX + /iq-data spectrum connection, ${PHASE_S}s`);
    phaseLabel = 'tx-plus-iqdata';
    const spectrumWs = new WebSocket(`ws://${BRIDGE_IP}/iq-data`);
    spectrumWs.binaryType = 'arraybuffer';
    let spectrumFrames = 0;
    spectrumWs.onmessage = () => { spectrumFrames++; };
    await new Promise<void>((resolve) => { spectrumWs.onopen = () => resolve(); setTimeout(resolve, 2000); });
    await page.waitForTimeout(PHASE_S * 1000);
    console.log(`  spectrum frames received: ${spectrumFrames}`);

    console.log(`Phase 3: TX only again (spectrum stopped), ${PHASE_S}s`);
    spectrumWs.close();
    phaseLabel = 'tx-only-2';
    await page.waitForTimeout(PHASE_S * 1000);

    clearInterval(pollInterval);
    writeFileSync('/tmp/tx-plus-iqspectrum-stats.json', JSON.stringify(statsLog));
    console.log('\nstats saved to /tmp/tx-plus-iqspectrum-stats.json');

    // Quick summary per phase.
    for (const phase of ['tx-only-1', 'tx-plus-iqdata', 'tx-only-2']) {
      const rows = statsLog.filter((r) => r.phase === phase && !r.error);
      if (rows.length === 0) { console.log(`${phase}: no data`); continue; }
      const avg = (key: string) => rows.reduce((s, r) => s + (r[key] ?? 0), 0) / rows.length;
      const min = (key: string) => Math.min(...rows.map((r) => r[key] ?? Infinity));
      console.log(`${phase}: n=${rows.length} httpd_cpu avg=${avg('httpd_cpu').toFixed(1)}% audio_cpu avg=${avg('audio_cpu').toFixed(1)}% cat_cpu avg=${avg('cat_cpu').toFixed(1)}% heap_largest_free_block min=${min('heap_largest_free_block')} dma_largest_free_block min=${min('dma_largest_free_block')}`);
    }
  } finally {
    clearInterval(pollInterval);
    await browser.close();
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error('FATAL:', e); process.exit(1); });
