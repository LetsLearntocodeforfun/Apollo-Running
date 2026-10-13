/**
 * v1.0.7 (PX-09): Electron smoke test.
 *
 * Launches the built desktop app (dist/ + dist-electron/, from
 * `npm run build:electron`) in a throw-away profile and checks that:
 *   - the main window opens and the renderer is locked down (no Node APIs,
 *     only the preload bridge);
 *   - first launch shows onboarding;
 *   - with onboarding done, the main navigation renders and every screen opens
 *     (Plan / Progress also load the lazily-split chart chunk);
 *   - nothing is logged to the console as an error and no page error is thrown.
 *
 * APOLLO_LOAD_DIST=1 makes the unpackaged app load dist/index.html instead of
 * the Vite dev server (electron/main.ts). Packaged installers can't be driven
 * by Playwright because their Node-inspector fuse is off (PX-34).
 */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');

let app: ElectronApplication;
let page: Page;
let userDataDir: string;
const consoleErrors: string[] = [];

test.beforeAll(async () => {
  userDataDir = mkdtempSync(path.join(tmpdir(), 'apollo-e2e-'));
  app = await electron.launch({
    args: [ROOT, `--user-data-dir=${userDataDir}`],
    cwd: ROOT,
    env: { ...process.env, APOLLO_LOAD_DIST: '1', NODE_ENV: 'production' },
  });
  page = await app.firstWindow();
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(`console.error: ${msg.text()}`);
  });
  page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));
  await page.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  await app?.close();
  rmSync(userDataDir, { recursive: true, force: true });
});

test('main window loads the built app', async () => {
  await expect(page).toHaveTitle(/Apollo/);
  expect(page.url()).toMatch(/^file:.*\/dist\/index\.html/);

  const isVisible = await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    return !!win && win.isVisible();
  });
  expect(isVisible).toBe(true);
});

test('renderer is sandboxed and only sees the preload bridge', async () => {
  const globals = await page.evaluate(() => ({
    require: typeof (window as unknown as { require?: unknown }).require,
    process: typeof (window as unknown as { process?: unknown }).process,
    electronAPI: typeof window.electronAPI,
  }));
  expect(globals).toEqual({ require: 'undefined', process: 'undefined', electronAPI: 'object' });
});

test('first launch shows onboarding', async () => {
  await expect(page.locator('#root')).not.toBeEmpty();
  await expect(page.getByRole('navigation', { name: 'Main' })).toHaveCount(0);
});

test('main navigation renders and every screen opens', async () => {
  // Skip onboarding the same way finishing it does, then reload.
  await page.evaluate(() => window.localStorage.setItem('apollo_welcome_completed', 'true'));
  await page.reload();

  const nav = page.getByRole('navigation', { name: 'Main' });
  await expect(nav).toBeVisible();

  const screens: Array<[RegExp, RegExp]> = [
    [/^Plan/, /#\/plan$/],
    [/^Activities/, /#\/activities$/],
    [/^Progress/, /#\/progress/],
    [/^Race Day/, /#\/race$/],
    [/^Settings/, /#\/settings/],
    [/^Today/, /#\/$/],
  ];
  for (const [name, url] of screens) {
    await nav.getByRole('link', { name }).click();
    await expect(page).toHaveURL(url);
    // The screen's (lazy) chunk has loaded and rendered into the page frame.
    await expect(page.locator('main .page-loading')).toHaveCount(0);
    await expect(page.locator('main .page-frame')).not.toBeEmpty();
    await expect(page.getByText(/couldn.t be shown/)).toHaveCount(0);
  }
});

test('no console errors', async () => {
  expect(consoleErrors).toEqual([]);
});
