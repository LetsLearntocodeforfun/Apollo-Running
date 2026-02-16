import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import ErrorBoundary from './components/ErrorBoundary';
import LoadingScreen from './components/LoadingScreen';
import { persistence } from './services/db/persistence';
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

// Wait for IndexedDB hydration, then render the app
persistence.ready
  .catch(() => { /* IndexedDB failed — localStorage fallback is already loaded */ })
  .finally(() => {
    root.render(
      <React.StrictMode>
        <ErrorBoundary>
          <App />
        </ErrorBoundary>
      </React.StrictMode>
    );
  });
