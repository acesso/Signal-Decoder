/**
 * UI layout tests — verify that the global audio analysis panel is visible,
 * all decoder mode panels render their own content, and mode switching keeps
 * the start/stop button state consistent without requiring a re-click.
 *
 * These tests do NOT need real audio — they mock getUserMedia with silence.
 */

import { test, expect, Page } from 'playwright/test';

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Install a silent getUserMedia mock (no WAV file needed, just silence). */
async function mockSilentMic(page: Page) {
  await page.addInitScript(() => {
    // Always return a synthetic silent stream — avoids permission prompts in all browsers
    const makeSilentStream = () => {
      const ctx = new AudioContext();
      const osc = ctx.createOscillator();
      osc.frequency.value = 0;
      const dest = ctx.createMediaStreamDestination();
      osc.connect(dest);
      osc.start();
      return dest.stream;
    };

    // Ensure mediaDevices exists (Firefox headless may not expose it)
    if (!navigator.mediaDevices) {
      Object.defineProperty(navigator, 'mediaDevices', {
        value: {},
        writable: true,
        configurable: true,
      });
    }

    navigator.mediaDevices.getUserMedia = async () => makeSilentStream();
  });
}

// ── Tests ──────────────────────────────────────────────────────────────────────

test.describe('Audio Analysis Panel', () => {
  test('Audio Analysis panel is visible on page load (inside active decoder)', async ({ page }) => {
    await mockSilentMic(page);
    await page.goto('/');

    // RTTY is default — its Audio Analysis panel should be visible
    await expect(page.getByRole('heading', { name: 'Audio Analysis' }).first()).toBeVisible();
  });

  test('spectrum canvas is present inside the panel', async ({ page }) => {
    await mockSilentMic(page);
    await page.goto('/');

    const heading = page.getByRole('heading', { name: 'Audio Analysis' }).first();
    const panel = heading.locator('..').locator('..');
    await expect(panel.locator('canvas').first()).toBeVisible();
  });
});

test.describe('Decoder panels render per-mode content', () => {
  test('RTTY mode shows RTTY Output panel', async ({ page }) => {
    await mockSilentMic(page);
    await page.goto('/');

    // RTTY is the default mode
    await expect(page.getByRole('heading', { name: 'RTTY Output' })).toBeVisible();
  });

  test('SSTV mode shows Received Image panel', async ({ page }) => {
    await mockSilentMic(page);
    await page.goto('/');

    await page.getByRole('button', { name: 'SSTV' }).click();
    await expect(page.getByRole('heading', { name: 'Received Image' })).toBeVisible();
  });

  test('CW mode shows CW Output panel', async ({ page }) => {
    await mockSilentMic(page);
    await page.goto('/');

    await page.getByRole('button', { name: 'CW' }).click();
    await expect(page.getByRole('heading', { name: 'CW Output' })).toBeVisible();
  });

  test('FT8/4 mode shows Decoded Messages panel', async ({ page }) => {
    await mockSilentMic(page);
    await page.goto('/');

    await page.getByRole('button', { name: 'FT8/4' }).click();
    await expect(page.getByRole('heading', { name: 'Decoded Messages' })).toBeVisible();
  });

  test('MFSK mode shows Output and Decoder panels', async ({ page }) => {
    await mockSilentMic(page);
    await page.goto('/');

    await page.getByRole('button', { name: 'MFSK' }).click();
    await expect(page.getByRole('heading', { name: 'Output', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Decoder', exact: true })).toBeVisible();
  });

  test('switching mode hides previous content and shows new content', async ({ page }) => {
    await mockSilentMic(page);
    await page.goto('/');

    // Start on RTTY
    await expect(page.getByRole('heading', { name: 'RTTY Output' })).toBeVisible();

    // Switch to CW — RTTY output must disappear, CW must appear
    await page.getByRole('button', { name: 'CW' }).click();
    await expect(page.getByRole('heading', { name: 'CW Output' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'RTTY Output' })).not.toBeVisible();

    // Switch to MFSK
    await page.getByRole('button', { name: 'MFSK' }).click();
    await expect(page.getByRole('heading', { name: 'Output' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'CW Output' })).not.toBeVisible();
  });
});

test.describe('Start/Stop global state', () => {
  // Use the top bar specifically — it's the first Start/Stop/Reset in the DOM
  const topBar = (page: Page) => page.locator('main > div').nth(1); // second shrink-0 div = top bar

  test('exactly one Start Decoding button exists', async ({ page }) => {
    await mockSilentMic(page);
    await page.goto('/');

    await expect(page.getByRole('button', { name: 'Start Decoding' })).toHaveCount(1);
  });

  test('Start Decoding button is present and enabled on load', async ({ page }) => {
    await mockSilentMic(page);
    await page.goto('/');

    const startBtn = page.getByRole('button', { name: 'Start Decoding' });
    await expect(startBtn).toBeVisible();
    await expect(startBtn).toBeEnabled();
  });

  test('clicking Start shows Stop button', async ({ page }) => {
    await mockSilentMic(page);
    await page.goto('/');

    await page.getByRole('button', { name: 'Start Decoding' }).click();
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Start Decoding' })).not.toBeVisible();
  });

  test('Stop button returns to Start state', async ({ page }) => {
    await mockSilentMic(page);
    await page.goto('/');

    await page.getByRole('button', { name: 'Start Decoding' }).click();
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Start Decoding' })).toBeVisible();
  });

  test('switching mode while stopped keeps Start button visible', async ({ page }) => {
    await mockSilentMic(page);
    await page.goto('/');

    await page.getByRole('button', { name: 'CW' }).click();
    await expect(page.getByRole('button', { name: 'Start Decoding' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Start Decoding' })).toBeEnabled();
  });

  test('switching mode while recording keeps Stop button visible (no re-click needed)', async ({ page }) => {
    await mockSilentMic(page);
    await page.goto('/');

    // Start on RTTY
    await page.getByRole('button', { name: 'Start Decoding' }).click();
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();

    // Switch to CW — should still show Stop, not Start
    await page.getByRole('button', { name: 'CW' }).click();
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Start Decoding' })).not.toBeVisible();

    // Switch to MFSK — still Stop
    await page.getByRole('button', { name: 'MFSK' }).click();
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
  });

  test('exactly one Reset button exists', async ({ page }) => {
    await mockSilentMic(page);
    await page.goto('/');

    await expect(page.getByRole('button', { name: 'Reset' })).toHaveCount(1);
  });

  test('Reset button is present', async ({ page }) => {
    await mockSilentMic(page);
    await page.goto('/');

    await expect(page.getByRole('button', { name: 'Reset' })).toBeVisible();
  });
});

test.describe('Audio Analysis panel persists across mode switches', () => {
  test('Audio Analysis heading stays visible when switching modes', async ({ page }) => {
    await mockSilentMic(page);
    await page.goto('/');

    for (const mode of ['SSTV', 'CW', 'FT8/4', 'MFSK', 'RTTY']) {
      await page.getByRole('button', { name: mode }).click();
      // Each decoder has its own Audio Analysis panel — the active one should be visible
      await expect(page.getByRole('heading', { name: 'Audio Analysis' }).first()).toBeVisible();
    }
  });
});
