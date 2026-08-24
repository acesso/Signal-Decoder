// Verifies the fix for a real bug: selecting "ESP32 Bridge" as FT8's TX
// output, WITHOUT ever clicking "Listen to Radio" first, used to silently
// produce zero actual audio at the bridge (startMic() requires the /audio
// WebSocket to already be open; that failure was never surfaced or
// retried — see audioSource.ts's bridgeSink()). This script deliberately
// does NOT click "Start Decoding" or "Listen to Radio" — only connects CAT,
// then goes straight to selecting the bridge output and starting TX — to
// confirm bridgeSink() now auto-connects /audio itself.
//
// Usage: npx tsx scripts/ft8-tx-no-listen-repro.ts [bridge-ip] [duration-seconds]
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
const DURATION_S = Number(process.argv[3] || 75);
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

  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
    const consoleLines: string[] = [];
    page.on('console', (msg) => consoleLines.push(`[console.${msg.type()}] ${msg.text()}`));
    page.on('pageerror', (e) => consoleLines.push(`[pageerror] ${e.message}`));

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
    `);

    console.log(`Navigating to ${APP_URL} (FT8 mode, NOT clicking Start Decoding/Listen to Radio) ...`);
    await page.goto(APP_URL, { waitUntil: 'load', timeout: 20000 });
    await page.waitForTimeout(1500);

    await page.getByRole('button', { name: /^ft8\/4$/i }).first().click();
    console.log('Switched to FT8/4 mode');
    await page.waitForTimeout(1000);

    await page.getByRole('button', { name: /connect radio/i }).first().click();
    console.log('Clicked "Connect Radio" (CAT only — deliberately skipping Start Decoding/Listen to Radio)');
    await page.waitForTimeout(3000);

    const transmitSummary = page.locator('summary').filter({ hasText: 'Transmit' }).first();
    await transmitSummary.click();
    console.log('Expanded "Transmit" section');
    await page.waitForTimeout(500);

    const outputSelect = page.locator('select').filter({ hasText: /Local speaker|ESP32 Bridge/i }).first();
    await outputSelect.selectOption('bridge');
    console.log('Selected "ESP32 Bridge" as TX output sink (bridge audio was NEVER connected before this)');
    await page.waitForTimeout(500);

    // Start sniffing /audio-mic-sniff from Node directly, independent of
    // the page, so we have ground truth on whether real audio bytes
    // actually reach the bridge — not just whether the UI looks happy.
    let sniffFrames = 0;
    let sniffSamples = 0;
    let sniffNonZero = 0;
    const collected: number[] = [];
    const sniffWs = new WebSocket(`ws://${BRIDGE_IP}/audio-mic-sniff`);
    sniffWs.binaryType = 'arraybuffer';
    sniffWs.onmessage = (ev) => {
      if (!(ev.data instanceof ArrayBuffer)) return;
      sniffFrames++;
      const samples = new Int16Array(ev.data);
      sniffSamples += samples.length;
      for (let i = 0; i < samples.length; i++) {
        if (samples[i] !== 0) sniffNonZero++;
        collected.push(samples[i]);
      }
    };
    await new Promise<void>((resolve) => { sniffWs.onopen = () => resolve(); setTimeout(resolve, 3000); });
    console.log('Sniffer connected independently from Node');

    const startTxBtn = page.getByRole('button', { name: /^start tx$/i }).first();
    const disabled = await startTxBtn.isDisabled();
    console.log(`"Start TX" disabled=${disabled}`);
    if (!disabled) {
      await startTxBtn.click();
      console.log('Clicked "Start TX"');
    }

    console.log(`Watching for ${DURATION_S}s (Auto-CQ interval may need to elapse for a real TX cycle to fire)...`);
    await page.waitForTimeout(DURATION_S * 1000);

    sniffWs.close();
    await new Promise((r) => setTimeout(r, 500));

    console.log('\n=== SNIFF RESULT (ground truth from real bridge traffic) ===');
    console.log(`frames received: ${sniffFrames}`);
    console.log(`total samples: ${sniffSamples}`);
    console.log(`non-zero samples: ${sniffNonZero} (${sniffSamples > 0 ? ((sniffNonZero / sniffSamples) * 100).toFixed(2) : 0}%)`);

    if (collected.length > 4096) {
      // Spectral check — same fundamental-vs-broadband analysis used to
      // diagnose the resampler artifact in the first place. Sniffer
      // samples arrive at the bridge's codec rate (48000Hz here).
      const codecRate = 48000;
      function goertzelMag(samples: number[], freqHz: number, sampleRateHz: number): number {
        const w = (2 * Math.PI * freqHz) / sampleRateHz;
        const cw = 2 * Math.cos(w);
        let s0 = 0, s1 = 0, s2 = 0;
        for (let n = 0; n < samples.length; n++) { s0 = samples[n] + cw * s1 - s2; s2 = s1; s1 = s0; }
        const real = s1 - s2 * Math.cos(w);
        const imag = s2 * Math.sin(w);
        return Math.sqrt(real * real + imag * imag) / samples.length;
      }
      const window = collected.slice(-16384); // most recent samples, well past any startup settling
      // FT8's default base audio frequency in this app is 1500Hz (see
      // FTTransmitPanel.tsx's default baseFreq / "Audio Hz" field) —
      // probe near there plus its own tone-spacing range and a broad set
      // of unrelated frequencies for the noise floor.
      const candidates = [1500, 1650, 1800, 1950, 2100];
      let bestFund = 0, bestFreq = 1500;
      for (const f of candidates) {
        const m = goertzelMag(window, f, codecRate);
        if (m > bestFund) { bestFund = m; bestFreq = f; }
      }
      let broadbandSum = 0, broadbandCount = 0;
      for (let f = 100; f < codecRate / 2; f += 173) {
        if (Math.abs(f - bestFreq) < 150) continue;
        broadbandSum += goertzelMag(window, f, codecRate);
        broadbandCount++;
      }
      const broadbandAvg = broadbandSum / broadbandCount;
      console.log(`\nspectral check: strongest tone ~${bestFreq}Hz, magnitude ${bestFund.toFixed(1)}`);
      console.log(`broadband floor average: ${broadbandAvg.toFixed(2)}`);
      console.log(`fundamental/broadband ratio: ${(bestFund / broadbandAvg).toFixed(1)}x (higher = cleaner; the naive-linear bug measured ~1700x in synthetic testing, native/no-resample is orders of magnitude higher)`);
    }

    console.log('\n=== browser console (last 40) ===');
    for (const line of consoleLines.slice(-40)) console.log(' ', line);

    console.log('\n=== VERDICT ===');
    if (sniffFrames > 0 && sniffNonZero > 0) {
      console.log('FIX CONFIRMED: real non-zero audio reached the bridge even though "Listen to Radio" was never clicked.');
    } else if (sniffFrames > 0) {
      console.log('PARTIAL: frames arrived but all-zero — audio connected but TX itself may not be producing sound yet (could just be off-cycle timing).');
    } else {
      console.log('BUG STILL PRESENT: zero frames reached the bridge — auto-connect did not happen.');
    }

    await page.screenshot({ path: '/tmp/ft8-tx-no-listen-final.png', fullPage: true });
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
