/**
 * FT8/FT4 UI performance testbed.
 *
 * Drives the app in headless Firefox (playwright-core), injecting synthetic
 * decode windows through the dev-only `window.__ftInjectWindow` hook (the real
 * streaming pipeline: placeholder → batched partials → final replace), and
 * measures main-thread blocking via heartbeat gaps — Firefox has no Long
 * Tasks API, so a self-rescheduling 25 ms timer records every gap >50 ms.
 *
 * Optionally (--cat) connects the mock CAT radio (src/lib/cat/mockSerial.ts)
 * so the full serial poll pipeline runs concurrently, and reports poll-cadence
 * degradation (max/avg gap between polls — stretching = main thread jam).
 *
 * Requires:
 *  - the dev server running (default http://localhost:3002)
 *  - a playwright Firefox build: `~/.cache/ms-playwright/firefox-*` or
 *    PLAYWRIGHT_FIREFOX_PATH pointing at the executable
 *
 * Optionally (--rec) exercises the audio ring-buffer Rec feature: Firefox is
 * launched with fake media streams (getUserMedia yields a synthetic tone),
 * decoding is started so the input tap fills the ring (forced to the 5-min
 * maximum), and the Rec button is clicked sparsely at random (~20% of
 * windows) — each click snapshots the ring and encodes it to WAV on the main
 * thread, the worst-case cost of the feature. Browser memory (RSS of the
 * playwright Firefox process tree, from /proc) is sampled every window.
 *
 * Usage:
 *   npm run test:perf -- [--msgs 50] [--cadence 12000] [--windows 40]
 *                        [--new-ratio 0.8] [--cat] [--rec]
 *                        [--url http://localhost:3002] [--out perf-results.jsonl]
 *
 * Load profile references:
 *   target:  --msgs 50  --cadence 12000 --windows 40   (validated perf goal)
 *   stress:  --msgs 100 --cadence 8000  --windows 45   (architecture limits)
 *   medium:  --msgs 18  --cadence 2500  --windows 120  (busy real band)
 */

import { firefox } from 'playwright-core';
import { writeFileSync, appendFileSync, readdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// ── args ─────────────────────────────────────────────────────────────────────
function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const MSGS      = Number(arg('msgs', '50'));
const CADENCE   = Number(arg('cadence', '12000'));
const WINDOWS   = Number(arg('windows', '40'));
const NEW_RATIO = Number(arg('new-ratio', '0.8'));
const URL       = arg('url', 'http://localhost:3002');
const OUT       = arg('out', 'perf-results.jsonl');
const WITH_CAT  = process.argv.includes('--cat');
const WITH_REC  = process.argv.includes('--rec');
const REC_CLICK_P = 0.2; // sparse random Rec clicks: ~1 in 5 windows

// ── firefox executable ───────────────────────────────────────────────────────
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

// ── browser memory (RSS) ─────────────────────────────────────────────────────
// Firefox exposes no in-page memory API, so sample the OS instead: sum VmRSS
// of every process whose cmdline points at the ms-playwright Firefox build.
// Read-only /proc walk — matches only OUR browser (the user's own Firefox
// runs from /usr/lib64/firefox, a different path).
function playwrightFirefoxRssMB(): number | null {
  try {
    let kb = 0;
    for (const pid of readdirSync('/proc').filter(d => /^\d+$/.test(d))) {
      try {
        const cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
        if (!cmd.includes('ms-playwright') || !cmd.includes('firefox')) continue;
        const m = readFileSync(`/proc/${pid}/status`, 'utf8').match(/^VmRSS:\s+(\d+) kB/m);
        if (m) kb += Number(m[1]);
      } catch { /* process exited mid-walk */ }
    }
    return kb > 0 ? Math.round(kb / 1024) : null;
  } catch { return null; }
}

// ── synthetic traffic ────────────────────────────────────────────────────────
let uid = 0;
const L = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const known: string[] = [];
const nextCall = () => {
  const n = uid++;
  return `W${1 + (n % 9)}${L[Math.floor(n / 9) % 26]}${L[Math.floor(n / 234) % 26]}${L[Math.floor(n / 6084) % 26]}`;
};
const grid = (n: number) => `${L[n % 18]}${L[(n * 7) % 18]}${n % 10}${(n * 3) % 10}`;

interface InjectedMsg { freq: number; dt: number; snr: number; msg: string; sync: number }

function windowMessages(count: number): InjectedMsg[] {
  const msgs: InjectedMsg[] = [];
  for (let k = 0; k < count; k++) {
    let text: string;
    if (known.length > 10 && k / count >= NEW_RATIO) {
      const a = known[(uid * 3 + k * 7) % known.length];
      const b = known[(uid * 7 + k * 13 + 11) % known.length];
      text = k % 3 === 0 ? `${a} ${b} RR73` : k % 3 === 1 ? `${a} ${b} R-0${k % 10}` : `${a} ${b} ${grid(k)}`;
    } else {
      const c = nextCall();
      known.push(c);
      text = `CQ ${c} ${grid(uid)}`;
    }
    msgs.push({
      freq: 200 + ((uid + k) * 61) % 2800,
      dt: -0.5 + (k % 20) / 20,
      snr: -20 + (k % 30),
      msg: text,
      sync: 60 + (k % 20),
    });
  }
  return msgs;
}

// ── main ─────────────────────────────────────────────────────────────────────
const log = (obj: object) => appendFileSync(OUT, JSON.stringify(obj) + '\n');

async function main() {
  writeFileSync(OUT, '');
  const browser = await firefox.launch({
    executablePath: findFirefox(),
    headless: true,
    // Fake media streams give getUserMedia a synthetic tone without a mic —
    // needed so the --rec input tap has real samples flowing through it.
    firefoxUserPrefs: WITH_REC ? {
      'media.navigator.streams.fake': true,
      'media.navigator.permission.disabled': true,
    } : {},
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1700, height: 950 } });
    page.on('pageerror', e => log({ ev: 'pageerror', err: e.message.slice(0, 200) }));
    page.on('crash', () => log({ ev: 'PAGE-CRASHED' }));
    // Rec downloads land in playwright's temp dir; log and discard them
    page.on('download', dl => {
      log({ ev: 'download', name: dl.suggestedFilename() });
      dl.delete().catch(() => {});
    });

    if (WITH_CAT) {
      // string form: tsx/esbuild injects a __name helper into serialized
      // functions that does not exist in the page — strings bypass it
      await page.addInitScript("window.__catUseMock = true;");
    }
    if (WITH_REC) {
      // Worst-case ring: 5 min at 48 kHz ≈ 57.6 MB Float32 per stream
      await page.addInitScript("try { localStorage.setItem('audioRecDurationSec', '300'); } catch {}");
    }

    // Port convention: 3000 belongs to the developer's own dev server —
    // testbeds always use 3002 (start one with: npm run dev:test).
    await page.goto(URL, { waitUntil: 'load' }).catch(err => {
      throw new Error(`Cannot reach ${URL} — start the testbed dev server with 'npm run dev:test' (never use port 3000; that's the developer's). ${err.message}`);
    });
    await page.getByRole('button', { name: 'FT8/4' }).click();
    await page.waitForTimeout(2500);

    if (WITH_CAT) {
      await page.getByRole('button', { name: /Connect Radio/ }).click();
      await page.waitForSelector('text=Disconnect', { timeout: 10000 });
      log({ ev: 'cat-connected' });
    }

    if (WITH_REC) {
      // Start real decoding: the global audio context opens on the fake tone
      // and the ring-buffer input tap begins filling. The real 15 s decode
      // loop also runs — extra realistic load on top of the injections.
      await page.getByRole('button', { name: 'Start Decoding' }).click();
      await page.waitForTimeout(1500);
      log({ ev: 'rec-armed', durationSec: 300 });
    }

    await page.evaluate(`(() => {
      window.__perf = { blocks: [], rafGaps: [] };
      let hbLast = performance.now();
      const beat = () => {
        const now = performance.now();
        const gap = now - hbLast - 25;
        if (gap > 50) window.__perf.blocks.push(Math.round(gap));
        hbLast = now;
        setTimeout(beat, 25);
      };
      setTimeout(beat, 25);
      let rafLast = performance.now();
      const raf = () => {
        const now = performance.now();
        if (now - rafLast > 100) window.__perf.rafGaps.push(Math.round(now - rafLast));
        rafLast = now;
        requestAnimationFrame(raf);
      };
      requestAnimationFrame(raf);
    })()`);

    const hasHook = await page.evaluate("typeof window.__ftInjectWindow === 'function'");
    log({ ev: 'start', hasHook, MSGS, CADENCE, WINDOWS, NEW_RATIO, WITH_CAT, WITH_REC });
    if (!hasHook) throw new Error('__ftInjectWindow missing — dev server running production build?');

    for (let win = 1; win <= WINDOWS; win++) {
      const msgs = windowMessages(MSGS);
      // payload baked into the expression: a string pageFunction with an arg
      // is evaluated as an expression (silent no-op), and function args get
      // esbuild's __name helper injected — this avoids both failure modes
      await page.evaluate(`window.__ftInjectWindow(${JSON.stringify(msgs)}, 50)`)
        .catch(e => log({ ev: 'inject-fail', win, err: String(e).slice(0, 120) }));

      // Sparse random Rec click mid-window: ring snapshot + WAV encode runs
      // on the main thread, so its cost shows up in the heartbeat blocks.
      let recClicked = false;
      if (WITH_REC && Math.random() < REC_CLICK_P) {
        await page.waitForTimeout(CADENCE / 2);
        const rec = page.getByRole('button', { name: 'Rec' });
        if (await rec.isEnabled().catch(() => false)) {
          await rec.click().catch(() => {});
          recClicked = true;
          log({ ev: 'rec-click', win });
        }
        await page.waitForTimeout(CADENCE / 2);
      } else {
        await page.waitForTimeout(CADENCE);
      }

      const footer = await page.locator('span:has-text("contacts")').first().locator('..').textContent().catch(() => '');
      const num = (re: RegExp) => { const r = footer?.match(re); return r ? Number(r[1]) : null; };
      const perf = await page.evaluate(`(() => {
        const out = { blocks: window.__perf.blocks, rafGaps: window.__perf.rafGaps, cat: window.__catMockStats ?? null };
        window.__perf.blocks = []; window.__perf.rafGaps = [];
        return out;
      })()`).catch(() => ({ blocks: [] as number[], rafGaps: [] as number[], cat: null })) as { blocks: number[]; rafGaps: number[]; cat: { polls: number; maxPollGapMs: number; avgPollGapMs: number } | null };

      const sample = {
        ev: 'sample', win,
        contacts: num(/contacts\s*(\d+)/), msgs: num(/msgs\s*(\d+)/), dom: num(/DOM\s*(\d+)/),
        blockCount: perf.blocks.length,
        blockTotal: perf.blocks.reduce((s, d) => s + d, 0),
        blockMax: perf.blocks.reduce((s, d) => Math.max(s, d), 0),
        rafMax: perf.rafGaps.reduce((s, d) => Math.max(s, d), 0),
        cat: perf.cat,
        rssMB: WITH_REC ? playwrightFirefoxRssMB() : null,
        recClicked,
      };
      log(sample);
      console.log(`win ${String(win).padStart(3)}: contacts ${sample.contacts} msgs ${sample.msgs} dom ${sample.dom} | ` +
        `blocks ${sample.blockCount} tot ${sample.blockTotal}ms max ${sample.blockMax}ms` +
        (sample.cat ? ` | CAT polls ${(sample.cat as { polls: number }).polls} maxGap ${(sample.cat as { maxPollGapMs: number }).maxPollGapMs}ms avgGap ${(sample.cat as { avgPollGapMs: number }).avgPollGapMs}ms` : '') +
        (sample.rssMB !== null ? ` | rss ${sample.rssMB}MB${recClicked ? ' [REC]' : ''}` : ''));
    }
    log({ ev: 'done' });
  } finally {
    await browser.close().catch(() => {});
  }
  console.log('PERF TESTBED COMPLETE →', OUT);
}

main().catch(err => { console.error(err); process.exit(1); });
