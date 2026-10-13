#!/usr/bin/env node
/**
 * v1.0.7 (PX-05): bundle budget for the first screen.
 *
 * Reads dist/index.html after `npm run build:web` or `npm run build:electron`
 * and adds up the JavaScript the browser fetches before Today can render: the
 * entry script plus every <link rel="modulepreload">. Fails when
 *   - the chart chunk (vendor-charts / recharts) is preloaded — charts must
 *     load only with the screens that draw them; or
 *   - the preloaded JavaScript exceeds the budget.
 *
 * Usage: node scripts/check-bundle.mjs [distDir]
 * Budgets (KiB) can be overridden with BUNDLE_BUDGET_KB / BUNDLE_BUDGET_GZIP_KB.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { gzipSync } from 'node:zlib';

// v1.0.7 baseline: ~589 KiB raw / ~197 KiB gzip (entry + vendor-react).
// v1.0.6 preloaded ~955 KiB because React was bundled inside vendor-charts.
const BUDGET_KB = Number(process.env.BUNDLE_BUDGET_KB ?? 640);
const BUDGET_GZIP_KB = Number(process.env.BUNDLE_BUDGET_GZIP_KB ?? 215);
const FORBIDDEN = [/vendor-charts/i, /recharts/i];

const distDir = process.argv[2] ?? 'dist';
const indexPath = join(distDir, 'index.html');
if (!existsSync(indexPath)) {
  console.error(`::error::${indexPath} not found — build first (npm run build:web or build:electron).`);
  process.exit(1);
}
const html = readFileSync(indexPath, 'utf8');

/** Map an href/src from index.html (./assets/x.js, /base/assets/x.js) to a file in distDir. */
function toFile(ref) {
  const clean = ref.split(/[?#]/)[0];
  const idx = clean.lastIndexOf('/assets/');
  return idx >= 0 ? join(distDir, clean.slice(idx + 1)) : join(distDir, clean.replace(/^\.?\//, ''));
}

const refs = new Set();
for (const m of html.matchAll(/<script\b[^>]*\btype="module"[^>]*\bsrc="([^"]+)"/g)) refs.add(m[1]);
for (const m of html.matchAll(/<link\b[^>]*\brel="modulepreload"[^>]*\bhref="([^"]+)"/g)) refs.add(m[1]);
if (refs.size === 0) {
  console.error('::error::No entry script found in index.html');
  process.exit(1);
}

let raw = 0;
let gz = 0;
const problems = [];
console.log('JavaScript loaded before the first screen:');
for (const ref of refs) {
  const file = toFile(ref);
  if (!existsSync(file)) {
    problems.push(`${ref} is referenced by index.html but missing from ${distDir}`);
    continue;
  }
  const buf = readFileSync(file);
  const size = buf.length;
  const gzSize = gzipSync(buf, { level: 9 }).length;
  raw += size;
  gz += gzSize;
  console.log(
    `  ${basename(file).padEnd(40)} ${(size / 1024).toFixed(1).padStart(8)} KiB  (gzip ${(gzSize / 1024).toFixed(1)} KiB)`,
  );
  if (FORBIDDEN.some((re) => re.test(basename(file)))) {
    problems.push(`${basename(file)} is preloaded on the first screen — the chart library must load lazily`);
  }
}
console.log(`  ${'total'.padEnd(40)} ${(raw / 1024).toFixed(1).padStart(8)} KiB  (gzip ${(gz / 1024).toFixed(1)} KiB)`);
console.log(`  budget: ${BUDGET_KB} KiB raw, ${BUDGET_GZIP_KB} KiB gzip`);

if (raw / 1024 > BUDGET_KB)
  problems.push(`preloaded JS is ${(raw / 1024).toFixed(1)} KiB, over the ${BUDGET_KB} KiB budget`);
if (gz / 1024 > BUDGET_GZIP_KB)
  problems.push(`preloaded JS is ${(gz / 1024).toFixed(1)} KiB gzip, over the ${BUDGET_GZIP_KB} KiB budget`);

if (problems.length) {
  for (const p of problems) console.error(`::error::${p}`);
  process.exit(1);
}
console.log('Bundle budget OK.');
