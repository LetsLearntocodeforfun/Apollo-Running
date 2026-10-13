/**
 * Shared Rollup chunking for the desktop (vite.config.ts) and browser
 * (vite.config.web.ts) builds.
 *
 * v1.0.7 (PX-05): the old object form `manualChunks: { 'vendor-charts': ['recharts'] }`
 * also swept recharts' own dependencies — including React — into
 * vendor-charts, so the entry chunk imported React from it and index.html
 * preloaded the whole 540 KB chart library on Today. Now React (and Rollup's
 * CommonJS helpers, which every CJS package shares) get their own chunk that
 * the entry needs anyway, and vendor-charts only holds modules that nothing
 * but the chart screens use. scripts/check-bundle.mjs guards this in CI.
 */

/** Packages only the charting library uses (recharts 3 and its dependencies). */
const CHART_PACKAGES = [
  'recharts',
  'victory-vendor',
  'd3-[a-z-]+',
  'internmap',
  '@reduxjs/toolkit',
  'react-redux',
  'redux',
  'redux-thunk',
  'immer',
  'reselect',
  'es-toolkit',
  'eventemitter3',
  'decimal\\.js-light',
  'tiny-invariant',
];

/** Packages the app shell itself needs on first paint. */
const REACT_PACKAGES = [
  'react',
  'react-dom',
  'scheduler',
  'react-router',
  'react-router-dom',
  '@remix-run/router',
  'use-sync-external-store',
  'react-is',
];

const packagePattern = (names: string[]) => new RegExp(`[\\\\/]node_modules[\\\\/](?:${names.join('|')})[\\\\/]`);

const CHART_RE = packagePattern(CHART_PACKAGES);
const REACT_RE = packagePattern(REACT_PACKAGES);

export function manualChunks(id: string): string | undefined {
  // Rollup's CommonJS interop helpers are imported by every CJS module; keep
  // them next to React so they never land in (and drag in) the chart chunk.
  if (id.includes('commonjsHelpers')) return 'vendor-react';
  if (REACT_RE.test(id)) return 'vendor-react';
  if (CHART_RE.test(id)) return 'vendor-charts';
  return undefined;
}
