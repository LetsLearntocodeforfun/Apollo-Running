import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import ErrorBoundary from './components/ErrorBoundary';
import LoadingScreen from './components/LoadingScreen';
import { persistence } from './services/db/persistence';
import { secureStorageReady } from './services/storage';
import { isStorageDegraded } from './services/storageHealth';
import { needsEffortRebuild, scheduleEffortRebuild } from './services/effortService';
import MultiTabNotice from './components/MultiTabNotice';
import { isWeb } from './utils/platform';
import { TabCoordinator } from './utils/tabCoordinator';
import '@fontsource-variable/inter';
import '@fontsource-variable/montserrat';
import './index.css';
import './styles/ui.css';

// v1.0.7 (PX-02): the app uses a HashRouter, but OAuth providers (the web
// Strava flow) and old bookmarks arrive on a real path such as
// /auth/strava/callback?code=…. Move that path and query into the hash before
// React starts, so the router sees #/auth/strava/callback?code=… . The page is
// served from import.meta.env.BASE_URL (e.g. /Apollo-Running/ on GitHub Pages).
function redirectPathToHashRoute(): void {
  if (window.electronAPI || window.location.protocol === 'file:') return;
  const base = import.meta.env.BASE_URL.startsWith('/') ? import.meta.env.BASE_URL : '/';
  const { pathname, search, hash } = window.location;
  if (!pathname.startsWith(base)) return;
  const route = pathname.slice(base.length).replace(/^\/+/, '');
  if (!route || route === 'index.html' || (hash && hash !== '#')) return;
  window.history.replaceState(null, '', `${base}#/${route}${search}`);
}
redirectPathToHashRoute();

// v1.0.7 (PX-35): in the browser, warn when Apollo is open in more than one tab
// (the desktop app has a single-instance lock instead). Own root, so it shows
// during onboarding and loading too.
if (isWeb()) {
  const coordinator = new TabCoordinator();
  const host = document.createElement('div');
  host.id = 'apollo-tab-notice';
  document.body.appendChild(host);
  ReactDOM.createRoot(host).render(<MultiTabNotice coordinator={coordinator} />);
  void coordinator.start().catch(() => { /* single-tab behaviour */ });
}

/**
 * Boot sequence:
 * 1. Persistence service bootstraps from localStorage (instant, synchronous)
 * 2. IndexedDB hydration runs in background (restores data if localStorage was cleared)
 * 3. Once ready, render the full app
 * 4. Recompute effort recognitions once if they predate the current algorithm
 * 5. Then start automatic backups (one-time compaction of old backups, a
 *    backup if one is due, and the scheduler that keeps them running)
 *
 * The IndexedDB hydration typically takes <50ms, so the loading screen is brief.
 * If IndexedDB fails on a profile that used it, storage is marked degraded
 * (storageHealth): the app still renders, but sync and large writes pause.
 */
const root = ReactDOM.createRoot(document.getElementById('root')!);

// Show loading screen while persistence initializes
root.render(
  <React.StrictMode>
    <LoadingScreen message="Loading your data…" />
  </React.StrictMode>
);

// v1.0.7 (PX-12): don't lose the last changes when Apollo closes. On desktop the
// main process waits for this flush before closing the window; in browsers we
// flush whenever the page is hidden or unloaded (best effort).
window.electronAPI?.lifecycle?.onBeforeClose(() => persistence.flush());
window.addEventListener('pagehide', () => { void persistence.flush(); });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') void persistence.flush();
});

// Wait for IndexedDB hydration and (desktop) the encrypted credential store,
// so connection checks are accurate on first render, then render the app.
Promise.all([
  persistence.ready.catch(() => { /* IndexedDB failed — localStorage fallback is already loaded */ }),
  secureStorageReady,
])
  .finally(() => {
    root.render(
      <React.StrictMode>
        <ErrorBoundary>
          <App />
        </ErrorBoundary>
      </React.StrictMode>
    );
    // Recompute effort recognitions once when they were built by an older
    // algorithm (EFFORT_ALGO_VERSION, e.g. after upgrading from 1.0.5) — even
    // with automatic sync off. Debounced and never throws. Not while storage is
    // degraded: the store may be incomplete and writes may not persist.
    if (!isStorageDegraded() && needsEffortRebuild()) scheduleEffortRebuild();
    // After first render so backups never delay startup (and stay out of the
    // first-paint bundle). initBackupSystem never rejects.
    window.setTimeout(() => {
      import('./services/backupService')
        .then(({ initBackupSystem }) => initBackupSystem())
        .catch((err) => console.warn('[Apollo] Backup system failed to start:', err));
    }, 2000);
  });
