import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  // Each of the two agent stages has its own 180-second limit.
  timeout: 390_000,
  workers: 1,
  retries: 0,
  reporter: 'list',
  use: {
    browserName: 'chromium',
    headless: true,
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    actionTimeout: 5_000,
    navigationTimeout: 30_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
