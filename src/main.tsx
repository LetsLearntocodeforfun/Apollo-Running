import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import ErrorBoundary from './components/ErrorBoundary';
import LoadingScreen from './components/LoadingScreen';
import { persistence } from './services/db/persistence';
import { secureStorageReady } from './services/storage';
import { isStorageDegraded } from './services/storageHealth';
import { needsEffortRebuild, scheduleEffortRebuild } from './services/effortService';
import '@fontsource-variable/inter';
import '@fontsource-variable/montserrat';
import './index.css';
import './styles/ui.css';

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
