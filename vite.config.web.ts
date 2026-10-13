import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { manualChunks } from './vite.chunks';

/**
 * Browser build and the plain browser dev server (`npm run dev`). No Electron
 * plugins. Used for:
 *   - the free web version on GitHub Pages (.github/workflows/pages.yml), built
 *     with APOLLO_BASE=/<repo>/ because Pages serves the site from a sub-path;
 *   - Azure Static Web Apps (manual), served from the domain root.
 *
 * The Content-Security-Policy is also emitted as a <meta> tag (production
 * only) because GitHub Pages can't send custom headers. Azure additionally
 * sends the same policy (plus frame-ancestors, which a <meta> tag can't carry)
 * from staticwebapp.config.json.
 */

/** Public path the site is served from. Must start and end with "/". */
function resolveBase(): string {
  const raw = process.env.APOLLO_BASE?.trim();
  if (!raw) return '/';
  const withLeading = raw.startsWith('/') ? raw : `/${raw}`;
  return withLeading.endsWith('/') ? withLeading : `${withLeading}/`;
}

const WEB_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' https://intervals.icu https://www.strava.com",
  "frame-src 'self' blob: data:",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

function webCsp(): Plugin {
  return {
    name: 'apollo-web-csp',
    apply: 'build',
    transformIndexHtml(html) {
      return html.replace(
        '<head>',
        `<head>\n    <meta http-equiv="Content-Security-Policy" content="${WEB_CSP}" />\n    <meta name="referrer" content="strict-origin-when-cross-origin" />`,
      );
    },
  };
}

export default defineConfig({
  base: resolveBase(),
  plugins: [react(), webCsp()],
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        // Charts load only with the screens that use them (PX-05).
        manualChunks,
      },
    },
  },
});
