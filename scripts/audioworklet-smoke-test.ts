/**
 * AudioWorklet capture-forwarder smoke test.
 *
 * Functional (not visual) check that the shared capture-forwarder
 * AudioWorklet (src/lib/audio/captureWorklet.ts, wired via
 * src/lib/audio/captureNode.ts) actually loads and forwards real sample
 * chunks end-to-end in a real browser engine — jsdom has no Web Audio
 * implementation, so this can't be a Jest test.
 *
 * Rather than driving the full FT8 TX UI (which needs a valid callsign/grid
 * before its Start button even enables), this loads the app page — so
 * createCaptureNode's relative worklet module URL resolves exactly as it
 * does in the real app, including Vite's dev-server module transform — then
 * calls createCaptureNode directly with a synthetic oscillator source via
 * page.evaluate, and checks real non-zero sample chunks arrive.
 *
 * Requires: the dev server running on the given --url (npm run dev:test).
 *
 * Usage: npx tsx scripts/audioworklet-smoke-test.ts [--url http://localhost:3002]
 */
import { firefox } from 'playwright-core';
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const APP_URL = arg('url', 'http://localhost:3002');

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

async function main() {
  const browser = await firefox.launch({
    executablePath: findFirefox(),
    headless: true,
  });

  const pageErrors: string[] = [];
  try {
    const page = await browser.newPage();
    page.on('pageerror', e => pageErrors.push(e.message));

    await page.goto(APP_URL, { waitUntil: 'load' });

    // Dynamic import of the real module (same path Vite serves in dev),
    // feed it a synthetic 1kHz oscillator instead of a mic, and confirm
    // createCaptureNode's onChunk callback actually fires with non-silent,
    // correctly-sized Float32Array chunks.
    const result = await page.evaluate(async () => {
      const mod = await import('/src/lib/audio/captureNode.ts');
      const ctx = new AudioContext();
      const osc = ctx.createOscillator();
      osc.frequency.value = 1000;

      const chunks: Float32Array[] = [];
      const capture = await mod.createCaptureNode(ctx, 4096, (samples) => {
        chunks.push(samples.slice());
      });

      osc.connect(capture.node);
      osc.start();
      await new Promise(r => setTimeout(r, 1000));
      osc.stop();
      capture.disconnect();
      await ctx.close();

      const nonEmpty = chunks.filter(c => c.length === 4096);
      const hasSignal = nonEmpty.some(c => c.some(s => Math.abs(s) > 0.01));
      return {
        chunkCount: chunks.length,
        allCorrectSize: chunks.every(c => c.length === 4096),
        hasSignal,
      };
    }).catch(e => ({ error: e.message }));

    await page.waitForTimeout(200);

    console.log('Result:', JSON.stringify(result, null, 2));

    if ('error' in result) {
      console.error('FAIL — evaluate threw:', result.error);
      process.exitCode = 1;
    } else if (result.chunkCount === 0) {
      console.error('FAIL — worklet produced zero chunks in 1s of synthetic audio');
      process.exitCode = 1;
    } else if (!result.allCorrectSize) {
      console.error('FAIL — some chunks were not the expected 4096-sample size');
      process.exitCode = 1;
    } else if (!result.hasSignal) {
      console.error('FAIL — chunks arrived but contained no signal above noise floor (silence forwarded instead of the oscillator)');
      process.exitCode = 1;
    } else if (pageErrors.length > 0) {
      console.error('FAIL — page errors occurred:', pageErrors);
      process.exitCode = 1;
    } else {
      console.log(`PASS — ${result.chunkCount} chunks of 4096 samples, real signal present, no page errors`);
    }
  } finally {
    await browser.close();
  }
}

main().catch(err => { console.error(err); process.exit(1); });
