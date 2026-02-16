/**
 * Persistence Layer — unified storage abstraction for Apollo Running.
 *
 * Architecture:
 *   1. In-memory cache for instant synchronous reads (React demands this)
 *   2. IndexedDB (via Dexie) as the durable backing store
 *   3. localStorage as a sync fallback and migration source
 *
 * How it works:
 *   - On construction, cache is populated from localStorage (synchronous, instant)
 *   - In background, IndexedDB is loaded; any keys missing from cache are restored
 *   - If IndexedDB is empty (first run), localStorage data is migrated into it
 *   - All writes go to: cache → IndexedDB (async) → localStorage (sync fallback)
 *   - If localStorage is cleared (browser cache clear), IndexedDB restores the data
 *
 * Benefits over raw localStorage:
 *   - ~100s MB capacity vs 5-10 MB
 *   - Self-healing: clears to localStorage are recovered from IndexedDB
 *   - Foundation for structured tables, offline sync, and larger datasets
 *   - All existing service code continues to work with synchronous reads
 */

import { db } from './apolloDB';

/** Credential keys that don't use the 'apollo_' prefix */
const CREDENTIAL_KEYS = new Set([
  'strava_tokens',
  'strava_credentials',
  'garmin_tokens',
  'garmin_credentials',
]);

/** Check if a key belongs to Apollo Running */
function isApolloKey(key: string): boolean {
  return key.startsWith('apollo_') || CREDENTIAL_KEYS.has(key);
}

class PersistenceService {
  private cache = new Map<string, string>();
  private _ready: Promise<void>;
  private _initialized = false;

  constructor() {
    // Phase 1: instant bootstrap from localStorage (synchronous)
    this.bootstrapFromLocalStorage();
    // Phase 2: hydrate from IndexedDB (async, restores lost data)
    this._ready = this.hydrateFromIndexedDB();
  }

  // ── Initialization ──────────────────────────────────────────────────────────

  /** Synchronously populate the cache from localStorage */
  private bootstrapFromLocalStorage(): void {
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key || !isApolloKey(key)) continue;
        const value = localStorage.getItem(key);
        if (value !== null) this.cache.set(key, value);
      }
    } catch {
      // localStorage unavailable (private browsing, SSR, etc.)
    }
  }

  /**
   * Load all IndexedDB entries and restore anything localStorage lost.
   * If IndexedDB is empty (first run with new storage), seed it from localStorage.
   */
  private async hydrateFromIndexedDB(): Promise<void> {
    try {
      const entries = await db.kvStore.toArray();
      let restoredCount = 0;

      for (const entry of entries) {
        if (!this.cache.has(entry.key)) {
          // IndexedDB has data that localStorage lost — restore it
          this.cache.set(entry.key, entry.value);
          try { localStorage.setItem(entry.key, entry.value); } catch { /* quota */ }
          restoredCount++;
        }
      }

      // First run with IndexedDB: migrate existing localStorage data into it
      if (entries.length === 0 && this.cache.size > 0) {
        const toInsert = Array.from(this.cache.entries()).map(([key, value]) => ({
          key,
          value,
          updatedAt: Date.now(),
        }));
        await db.kvStore.bulkPut(toInsert);
      }

      if (restoredCount > 0) {
        console.info(`[Apollo] Restored ${restoredCount} entries from IndexedDB`);
      }
    } catch (err) {
      console.warn('[Apollo] IndexedDB unavailable, using localStorage only:', err);
    }
    this._initialized = true;
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /** Promise that resolves when IndexedDB hydration is complete */
  get ready(): Promise<void> {
    return this._ready;
  }

  /** Whether IndexedDB hydration has completed */
  get initialized(): boolean {
    return this._initialized;
  }

  /** Synchronous read from the in-memory cache */
  getItem(key: string): string | null {
    return this.cache.get(key) ?? null;
  }

  /** Write to cache + IndexedDB + localStorage */
  setItem(key: string, value: string): void {
    this.cache.set(key, value);
    // Async durable write (fire-and-forget)
    db.kvStore.put({ key, value, updatedAt: Date.now() }).catch(() => {});
    // Sync fallback write
    try { localStorage.setItem(key, value); } catch { /* quota exceeded */ }
  }

  /** Remove from all storage layers */
  removeItem(key: string): void {
    this.cache.delete(key);
    db.kvStore.delete(key).catch(() => {});
    try { localStorage.removeItem(key); } catch {}
  }

  /** Get all Apollo keys currently stored */
  keys(): string[] {
    return Array.from(this.cache.keys());
  }

  /** Number of Apollo keys stored */
  get length(): number {
    return this.cache.size;
  }

  /** Clear all Apollo data from every storage layer */
  clear(): void {
    const allKeys = Array.from(this.cache.keys());
    this.cache.clear();
    db.kvStore.bulkDelete(allKeys).catch(() => {});
    for (const k of allKeys) {
      try { localStorage.removeItem(k); } catch {}
    }
  }

  /** Bulk import: set multiple keys at once (used by data import) */
  bulkSet(entries: Record<string, string>): void {
    const dbEntries = Object.entries(entries).map(([key, value]) => {
      this.cache.set(key, value);
      try { localStorage.setItem(key, value); } catch {}
      return { key, value, updatedAt: Date.now() };
    });
    db.kvStore.bulkPut(dbEntries).catch(() => {});
  }

  /** Export all cached data as a plain Record */
  toRecord(): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [key, value] of this.cache) {
      result[key] = value;
    }
    return result;
  }
}

/** Singleton persistence service — initialized on module import */
export const persistence = new PersistenceService();

export { CREDENTIAL_KEYS, isApolloKey };
