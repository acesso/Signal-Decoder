import { defineConfig, devices } from 'playwright/test';

export default defineConfig({
  testDir: './src/e2e',

  /* Each test can take up to 4 minutes — full 194s WBCQ recording needs ~202s + margin */
  timeout: 240_000,

  /* Give expect() calls generous time too (audio buffering can take seconds) */
  expect: { timeout: 60_000 },

  /* Run tests sequentially — they all share the same dev server port */
  fullyParallel: false,
  workers: 1,

  /* Don't retry flaky tests by default */
  retries: 0,

  reporter: 'list',

  use: {
    headless: true,
    /* Use the playwright-managed chromium, not an installed channel */
    baseURL: 'http://localhost:3000',
    /* Give the browser plenty of time to navigate and settle */
    navigationTimeout: 30_000,
    actionTimeout:     20_000,
  },

  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        channel: undefined, // use playwright's own chromium build
      },
    },
  ],

  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:3000',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
