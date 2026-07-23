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

    let failed = false;
    if ('error' in result) {
      console.error('FAIL — evaluate threw:', result.error);
      failed = true;
    } else if (result.chunkCount === 0) {
      console.error('FAIL — worklet produced zero chunks in 1s of synthetic audio');
      failed = true;
    } else if (!result.allCorrectSize) {
      console.error('FAIL — some chunks were not the expected 4096-sample size');
      failed = true;
    } else if (!result.hasSignal) {
      console.error('FAIL — chunks arrived but contained no signal above noise floor (silence forwarded instead of the oscillator)');
      failed = true;
    } else if (pageErrors.length > 0) {
      console.error('FAIL — page errors occurred:', pageErrors);
      failed = true;
    } else {
      console.log(`PASS — ${result.chunkCount} chunks of 4096 samples, real signal present, no page errors`);
    }

    // Regression check: this app runs several independent AudioContexts
    // concurrently (one per decoder mode, plus one for TX — see
    // globalAudio.ts, cw/processor.ts, ft/processor.ts,
    // ft/useFTTransmit.ts, mfsk/processor.ts, rtty/multiProcessor.ts,
    // sstv/audioProcessor.ts), so createCaptureNode's worklet-module cache
    // MUST be keyed per-AudioContext — a shared/global cache means every
    // context after the first skips its own addModule() call and then
    // fails to construct its AudioWorkletNode ("Unknown AudioWorklet name
    // 'capture-forwarder'"), which is exactly what happened in practice
    // (FT8 Start Decoding = 2nd context of the session; switching decoder
    // modes = a new context each time). The single-context test above
    // can't catch this — it must open several contexts, matching real use.
    const multiCtxResult = await page.evaluate(async () => {
      const mod = await import('/src/lib/audio/captureNode.ts');
      const outcomes: Array<{ i: number; ok: boolean; error?: string }> = [];
      for (let i = 0; i < 4; i++) {
        try {
          const ctx = new AudioContext();
          const capture = await mod.createCaptureNode(ctx, 4096, () => {});
          capture.disconnect();
          await ctx.close();
          outcomes.push({ i, ok: true });
        } catch (e) {
          outcomes.push({ i, ok: false, error: e instanceof Error ? e.message : String(e) });
        }
      }
      return outcomes;
    }).catch(e => [{ i: -1, ok: false, error: `evaluate threw: ${e.message}` }]);

    console.log('Multi-context result:', JSON.stringify(multiCtxResult, null, 2));
    const multiCtxFailures = multiCtxResult.filter(r => !r.ok);
    if (multiCtxFailures.length > 0) {
      console.error(`FAIL — ${multiCtxFailures.length}/${multiCtxResult.length} sequential AudioContexts failed to create a capture node`);
      failed = true;
    } else {
      console.log(`PASS — all ${multiCtxResult.length} sequential AudioContexts created capture nodes successfully`);
    }

    process.exitCode = failed ? 1 : 0;
  } finally {
    await browser.close();
  }
}

main().catch(err => { console.error(err); process.exit(1); });
