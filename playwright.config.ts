import { defineConfig } from '@playwright/test';

/**
 * v1.0.7 (PX-09): Electron smoke test. Run with `npm run test:e2e` (builds the
 * app first) or `npm run test:e2e:only` against an existing build. Kept out of
 * `vitest run` (vitest only collects src/**).
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]] : 'list',
  outputDir: 'test-results',
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
