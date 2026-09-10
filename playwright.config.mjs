import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  // One agent run has a 180-second limit, plus container startup and artifact capture.
  timeout: 240_000,
  workers: 1,
  retries: 0,
  reporter: 'list',
  use: {
    headless: true,
    viewport: { width: 1280, height: 800 },
    // tests/fixtures.mjs owns the browser inside Docker and captures failure artifacts.
  },
});
