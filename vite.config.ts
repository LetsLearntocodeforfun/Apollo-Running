import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import electron from 'vite-plugin-electron';
import renderer from 'vite-plugin-electron-renderer';
import path from 'path';

/**
 * Desktop (Electron) build — the single source of truth for `npm run build:electron`
 * and `npm run dev:electron`. The browser build lives in vite.config.web.ts.
 *
 * Output layout (must match package.json "main" and electron/main.ts):
 *   dist/index.html, dist/assets/*      ← renderer (base './' for file://)
 *   dist-electron/main.js               ← main process
 *   dist-electron/preload.js            ← preload (loaded via path.join(__dirname, 'preload.js'))
 */

/**
 * Content-Security-Policy for the packaged desktop renderer (production only;
 * Vite's dev server needs inline scripts for HMR). The renderer only ever talks
 * to intervals.icu and Strava — token exchange and update checks run in the
 * main process and are not affected.
 */
const ELECTRON_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' https://intervals.icu https://www.strava.com",
  "frame-src 'self' blob: data:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

function electronCsp(): Plugin {
  return {
    name: 'apollo-electron-csp',
    apply: 'build',
    transformIndexHtml(html) {
      return html.replace(
        '<head>',
        `<head>\n    <meta http-equiv="Content-Security-Policy" content="${ELECTRON_CSP}" />`,
      );
    },
  };
}

export default defineConfig({
  plugins: [
    react(),
    electron([
      { entry: 'electron/main.ts' },
      {
        entry: 'electron/preload.ts',
        onstart(options) {
          // Reload the renderer instead of restarting Electron when preload changes.
          options.reload();
        },
      },
    ]),
    renderer(),
    electronCsp(),
  ],
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        // Charts are only needed by a few lazily-loaded screens.
        manualChunks: { 'vendor-charts': ['recharts'] },
      },
    },
  },
});
