import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import ErrorBoundary from './components/ErrorBoundary';
import LoadingScreen from './components/LoadingScreen';
import { persistence } from './services/db/persistence';
import { secureStorageReady } from './services/storage';
import './index.css';

/**
 * Boot sequence:
 * 1. Persistence service bootstraps from localStorage (instant, synchronous)
 * 2. IndexedDB hydration runs in background (restores data if localStorage was cleared)
 * 3. Once ready, render the full app
 *
 * The IndexedDB hydration typically takes <50ms, so the loading screen is brief.
 * If IndexedDB fails, the app still works with localStorage-only fallback.
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
  });
