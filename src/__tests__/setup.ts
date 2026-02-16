/**
 * Vitest global test setup — mocks browser APIs and persistence layer
 * so service-layer unit tests can run in Node/jsdom without real storage.
 */

/// <reference types="vitest/globals" />
import { vi } from 'vitest';

// ── Mock the persistence layer ────────────────────────────────────────────────
// All services read/write through `persistence` from './db/persistence'.
// We replace it with a simple in-memory Map so tests are isolated and fast.

const memoryStore = new Map<string, string>();

vi.mock('@/services/db/persistence', () => ({
  persistence: {
    getItem: (key: string) => memoryStore.get(key) ?? null,
    setItem: (key: string, value: string) => { memoryStore.set(key, value); },
    removeItem: (key: string) => { memoryStore.delete(key); },
    keys: () => Array.from(memoryStore.keys()),
    get length() { return memoryStore.size; },
    clear: () => { memoryStore.clear(); },
    bulkSet: (entries: Record<string, string>) => {
      for (const [k, v] of Object.entries(entries)) memoryStore.set(k, v);
    },
    toRecord: () => Object.fromEntries(memoryStore),
    ready: Promise.resolve(),
    initialized: true,
  },
  CREDENTIAL_KEYS: new Set([
    'strava_tokens',
    'strava_credentials',
    'garmin_tokens',
    'garmin_credentials',
  ]),
  isApolloKey: (key: string) =>
    key.startsWith('apollo_') ||
    ['strava_tokens', 'strava_credentials', 'garmin_tokens', 'garmin_credentials'].includes(key),
}));

// ── Mock IndexedDB (Dexie) ────────────────────────────────────────────────────

vi.mock('@/services/db/apolloDB', () => ({
  db: {
    kvStore: {
      toArray: () => Promise.resolve([]),
      bulkPut: () => Promise.resolve(),
      put: () => Promise.resolve(),
      delete: () => Promise.resolve(),
      bulkDelete: () => Promise.resolve(),
    },
  },
}));

// ── Provide a clean persistence store per test ───────────────────────────────

beforeEach(() => {
  memoryStore.clear();
});
