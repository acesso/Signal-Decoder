// Compares TX audio cleanliness (fundamental/broadband spectral ratio) in
// "audio" vs "iq" bridge input mode, using the SAME real FT8-TX-to-sniffer
// path in both — investigating a real-hardware report that the
// resampler-artifact "green haze" happens more in audio mode than I/Q mode,
// even though the TX code path (downsampleBandlimited/upsample_bandlimited)
// doesn't itself branch on input mode.
//
// Usage: npx tsx scripts/tx-audio-vs-iq-compare.ts [bridge-ip]
import { firefox } from 'playwright-core';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
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
const APP_URL = 'http://localhost:3000/';
const TX_WATCH_S = 90;

function goertzelMag(samples: number[], freqHz: number, sampleRateHz: number): number {
  const w = (2 * Math.PI * freqHz) / sampleRateHz;
  const cw = 2 * Math.cos(w);
  let s0 = 0, s1 = 0, s2 = 0;
  for (let n = 0; n < samples.length; n++) { s0 = samples[n] + cw * s1 - s2; s2 = s1; s1 = s0; }
  const real = s1 - s2 * Math.cos(w);
  const imag = s2 * Math.sin(w);
  return Math.sqrt(real * real + imag * imag) / samples.length;
}

async function fetchStatus() {
  const res = await fetch(`http://${BRIDGE_IP}/status`, { signal: AbortSignal.timeout(2000) });
  return res.json();
}

async function setInputMode(mode: 'audio' | 'iq') {
  const res = await fetch(`http://${BRIDGE_IP}/input-mode`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode }),
  });
  return res.ok;
}

async function waitForReachable(maxWaitS: number, expectMode: string) {
  const end = Date.now() + maxWaitS * 1000;
  while (Date.now() < end) {
    try {
      const s: any = await fetchStatus();
      if (s && s.input_mode === expectMode && s.uptime_s < 30) return s;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  return null;
}

async function ensureMode(mode: 'audio' | 'iq') {
  const before: any = await fetchStatus();
  if (before.input_mode === mode) {
    console.log(`already in ${mode} mode, sample_rate_hz=${before.sample_rate_hz}`);
    return;
  }
  const ok = await setInputMode(mode);
  if (!ok) throw new Error(`mode switch to ${mode} was rejected`);
  const status = await waitForReachable(45, mode);
  if (!status) throw new Error(`bridge did not come back in ${mode} mode after reboot`);
  console.log(`bridge switched to ${mode} mode, sample_rate_hz=${status.sample_rate_hz}`);
  await new Promise((r) => setTimeout(r, 1000));
}

async function runTxCapture(label: string) {
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

    await page.goto(APP_URL, { waitUntil: 'load', timeout: 20000 });
    await page.waitForTimeout(1500);
    await page.getByRole('button', { name: /^ft8\/4$/i }).first().click();
    await page.waitForTimeout(1000);
    await page.getByRole('button', { name: /connect radio/i }).first().click();
    await page.waitForTimeout(3000);
    const transmitSummary = page.locator('summary').filter({ hasText: 'Transmit' }).first();
    await transmitSummary.click();
    await page.waitForTimeout(500);
    const outputSelect = page.locator('select').filter({ hasText: /Local speaker|ESP32 Bridge/i }).first();
    await outputSelect.selectOption('bridge');
    await page.waitForTimeout(500);

    const collected: number[] = [];
    const sniffWs = new WebSocket(`ws://${BRIDGE_IP}/audio-mic-sniff`);
    sniffWs.binaryType = 'arraybuffer';
    sniffWs.onmessage = (ev) => {
      if (!(ev.data instanceof ArrayBuffer)) return;
      const samples = new Int16Array(ev.data);
      for (let i = 0; i < samples.length; i++) collected.push(samples[i]);
    };
    await new Promise<void>((resolve) => { sniffWs.onopen = () => resolve(); setTimeout(resolve, 3000); });

    const startTxBtn = page.getByRole('button', { name: /^start tx$/i }).first();
    if (!(await startTxBtn.isDisabled())) await startTxBtn.click();

    console.log(`[${label}] watching TX for ${TX_WATCH_S}s...`);
    await page.waitForTimeout(TX_WATCH_S * 1000);

    sniffWs.close();
    await new Promise((r) => setTimeout(r, 500));

    const status: any = await fetchStatus();
    const codecRate = status.sample_rate_hz;
    console.log(`[${label}] collected ${collected.length} samples at codec rate ${codecRate}Hz`);

    writeFileSync(`/tmp/tx-capture-${label}.json`, JSON.stringify({ codecRate, samples: collected }));
    console.log(`[${label}] raw samples saved to /tmp/tx-capture-${label}.json`);

    if (collected.length < 8192) {
      console.log(`[${label}] NOT ENOUGH DATA — TX may not have fired within the window`);
      return { label, ok: false };
    }

    // Slide a window across the WHOLE capture (not just the tail) and
    // report min/max/avg ratio — the artifact may be intermittent rather
    // than constant, and a single tail-window snapshot could miss that.
    const windowSize = 8192;
    const stepSize = 4096;
    const candidates = [1500, 1650, 1800, 1950, 2100];
    const ratios: number[] = [];
    let overallMaxFund = 0;
    const fundHistogram: number[] = [];
    for (let off = 0; off + windowSize <= collected.length; off += stepSize) {
      const win = collected.slice(off, off + windowSize);
      let bestFund = 0, bestFreq = 1500;
      for (const f of candidates) {
        const m = goertzelMag(win, f, codecRate);
        if (m > bestFund) { bestFund = m; bestFreq = f; }
      }
      fundHistogram.push(bestFund);
      if (bestFund > overallMaxFund) overallMaxFund = bestFund;
      if (bestFund < 10) continue; // skip windows with no real TX tone present (between TX cycles) — lowered from 50, see below
      let bbSum = 0, bbCount = 0;
      for (let f = 100; f < codecRate / 2; f += 173) {
        if (Math.abs(f - bestFreq) < 150) continue;
        bbSum += goertzelMag(win, f, codecRate);
        bbCount++;
      }
      ratios.push(bestFund / (bbSum / bbCount));
    }

    console.log(`[${label}] max fundamental magnitude seen across all windows: ${overallMaxFund.toFixed(2)}`);
    fundHistogram.sort((a, b) => b - a);
    console.log(`[${label}] top 10 fundamental magnitudes: ${fundHistogram.slice(0, 10).map((v) => v.toFixed(1)).join(', ')}`);

    if (ratios.length === 0) {
      console.log(`[${label}] no windows with a clear TX tone found (threshold 10) — TX may genuinely not have fired, or real level is even lower`);
      return { label, ok: false, overallMaxFund };
    }

    const min = Math.min(...ratios);
    const max = Math.max(...ratios);
    const avg = ratios.reduce((s, r) => s + r, 0) / ratios.length;
    console.log(`[${label}] fundamental/broadband ratio across ${ratios.length} active-TX windows: min=${min.toFixed(1)}x max=${max.toFixed(1)}x avg=${avg.toFixed(1)}x`);
    return { label, ok: true, min, max, avg, windowCount: ratios.length };
  } finally {
    await browser.close();
  }
}

async function main() {
  console.log('=== Mode: audio ===');
  await ensureMode('audio');
  const audioResult = await runTxCapture('audio');

  console.log('\n=== Mode: iq ===');
  await ensureMode('iq');
  const iqResult = await runTxCapture('iq');

  console.log('\n=== COMPARISON ===');
  console.log('audio:', JSON.stringify(audioResult));
  console.log('iq:', JSON.stringify(iqResult));
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
