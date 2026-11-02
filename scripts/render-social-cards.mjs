/**
 * Renders Apollo's link-preview images from .github/social/card.html:
 *
 *   public/og-image.png                1200x630  Open Graph / Twitter card (web version)
 *   .github/social/social-preview.png  1280x640  GitHub repository social preview
 *                                                (upload by hand: Settings → General → Social preview)
 *
 * Usage: node scripts/render-social-cards.mjs
 * Needs a Chromium for Playwright: `npx playwright install chromium`, or point
 * CHROME_PATH at an installed Chrome (e.g. on macOS
 * "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome").
 */
/* global document -- only used inside page.evaluate() callbacks, which run in the browser */
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { chromium } from '@playwright/test';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const card = pathToFileURL(join(root, '.github', 'social', 'card.html')).href;
const targets = [
  { file: join(root, 'public', 'og-image.png'), width: 1200, height: 630 },
  { file: join(root, '.github', 'social', 'social-preview.png'), width: 1280, height: 640 },
];

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || undefined,
  args: ['--allow-file-access-from-files'],
});
try {
  for (const t of targets) {
    const context = await browser.newContext({ viewport: { width: t.width, height: t.height }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    await page.goto(card);
    await page.evaluate(() => document.fonts.ready);
    await page.waitForFunction(() => [...document.images].every((img) => img.complete && img.naturalWidth > 0));
    const fonts = await page.evaluate(() => [...document.fonts].filter((f) => f.status === 'loaded').length);
    if (fonts < 2) throw new Error('The Montserrat/Inter fonts did not load — run npm ci first.');
    await page.screenshot({ path: t.file });
    console.log(`Saved ${t.file} (${t.width}x${t.height})`);
    await context.close();
  }
} finally {
  await browser.close();
}
