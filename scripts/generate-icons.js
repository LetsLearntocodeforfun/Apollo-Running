/**
 * Generate all icon sizes from logo-1024.png
 * Usage: node scripts/generate-icons.js
 * Requires: npm install sharp
 */

import sharp from 'sharp';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SOURCE = path.join(__dirname, '..', 'public', 'assets', 'logo-1024.png');
const OUTPUT_DIR = path.join(__dirname, '..', 'public', 'assets');

const SIZES = [
  { name: 'logo-512.png', size: 512 },
  { name: 'logo-256.png', size: 256 },
  { name: 'logo-192.png', size: 192 },
  { name: 'logo-128.png', size: 128 },
  { name: 'logo-64.png', size: 64 },
  { name: 'logo-40.png', size: 40 },
  { name: 'logo-32.png', size: 32 },
  { name: 'logo-16.png', size: 16 },
];

const FAVICON_SIZES = [16, 32, 48];

async function generateIcons() {
  // Ensure output directory exists
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  console.log('Generating icon sizes from logo-1024.png...\n');

  // Generate PNG icons
  for (const { name, size } of SIZES) {
    const outputPath = path.join(OUTPUT_DIR, name);
    await sharp(SOURCE)
      .resize(size, size, {
        kernel: sharp.kernel.lanczos3,
        fit: 'contain',
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .png({ quality: 100, compressionLevel: 9 })
      .toFile(outputPath);
    console.log(`  ✓ ${name} (${size}x${size})`);
  }

  // Generate favicon.ico (multi-resolution PNG fallback as .ico)
  // For true .ico we generate the smallest size as favicon
  const faviconPath = path.join(__dirname, '..', 'public', 'favicon.png');
  await sharp(SOURCE)
    .resize(32, 32, {
      kernel: sharp.kernel.lanczos3,
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png({ quality: 100 })
    .toFile(faviconPath);
  console.log(`  ✓ favicon.png (32x32)`);

  // Generate individual favicon sizes
  for (const size of FAVICON_SIZES) {
    const faviconSizePath = path.join(OUTPUT_DIR, `favicon-${size}.png`);
    await sharp(SOURCE)
      .resize(size, size, {
        kernel: sharp.kernel.lanczos3,
        fit: 'contain',
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .png({ quality: 100 })
      .toFile(faviconSizePath);
    console.log(`  ✓ favicon-${size}.png (${size}x${size})`);
  }

  // Generate Apple touch icon
  const appleTouchPath = path.join(__dirname, '..', 'public', 'apple-touch-icon.png');
  await sharp(SOURCE)
    .resize(180, 180, {
      kernel: sharp.kernel.lanczos3,
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png({ quality: 100 })
    .toFile(appleTouchPath);
  console.log(`  ✓ apple-touch-icon.png (180x180)`);

  console.log('\nAll icons generated successfully!');
}

generateIcons().catch((err) => {
  console.error('Error generating icons:', err);
  process.exit(1);
});
