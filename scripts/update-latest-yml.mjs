#!/usr/bin/env node
/**
 * v1.0.7: refresh auto-update metadata after the Windows installer was signed.
 *
 * Signing (SignPath, see .github/workflows/release-electron.yml) changes the
 * installer's bytes, so the sha512/size that electron-builder wrote into
 * latest.yml — and the .blockmap used for differential updates — no longer
 * match. electron-updater would then reject every update. This script
 * regenerates the blockmap with electron-builder's own app-builder tool and
 * writes the new sha512/size into latest.yml.
 *
 * Usage: node scripts/update-latest-yml.mjs <releaseDir> [latest.yml]
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
// Both ship with electron-builder (app-builder-lib depends on them).
const requireFromBuilder = createRequire(require.resolve('app-builder-lib/package.json'));
const yaml = requireFromBuilder('js-yaml');
const { appBuilderPath } = requireFromBuilder('app-builder-bin');

const releaseDir = process.argv[2] ?? 'release';
const ymlPath = join(releaseDir, process.argv[3] ?? 'latest.yml');
if (!existsSync(ymlPath)) {
  console.error(`::error::${ymlPath} not found`);
  process.exit(1);
}

const info = yaml.load(readFileSync(ymlPath, 'utf8'));
if (!info || !Array.isArray(info.files) || info.files.length === 0) {
  console.error(`::error::${ymlPath} has no files[] entries`);
  process.exit(1);
}

/** Regenerate <file>.blockmap and return the file's { sha512, size }. */
function refresh(fileName) {
  const file = join(releaseDir, fileName);
  if (!existsSync(file)) throw new Error(`${file} listed in ${ymlPath} but missing`);
  try {
    const out = execFileSync(appBuilderPath, ['blockmap', '--input', file, '--output', `${file}.blockmap`], {
      encoding: 'utf8',
    });
    const { sha512, size } = JSON.parse(out);
    if (!sha512 || !size) throw new Error(`app-builder returned no hash: ${out}`);
    return { sha512, size };
  } catch (err) {
    // Without a matching blockmap electron-updater simply downloads the whole
    // installer, so a stale one must not be published.
    console.warn(`::warning::Could not regenerate ${fileName}.blockmap (${err.message}); removing it — updates will download the full installer.`);
    rmSync(`${file}.blockmap`, { force: true });
    const buf = readFileSync(file);
    return { sha512: createHash('sha512').update(buf).digest('base64'), size: statSync(file).size };
  }
}

for (const entry of info.files) {
  const { sha512, size } = refresh(entry.url);
  console.log(`${entry.url}: size ${entry.size} → ${size}`);
  entry.sha512 = sha512;
  entry.size = size;
  if (info.path === entry.url) info.sha512 = sha512;
}

writeFileSync(ymlPath, yaml.dump(info, { lineWidth: 8000 }));
console.log(`Updated ${ymlPath}`);
