// Persistence layer — in-memory cache + IndexedDB (Dexie) + localStorage fallback.
// Writes go to: cache (sync) → IndexedDB + localStorage (coalesced, next microtask).
// If localStorage is cleared, IndexedDB restores the data.
//
// v1.0.6 write safety (S1, V7, V9, S6):
// - Writes are coalesced per key: rapid setItem calls on the same key in one
//   tick produce one IndexedDB put and one localStorage write, always of the
//   latest value. There is no read-back-and-re-put (which could land an older
//   value after a newer one, S1).
// - Values longer than LOCAL_MIRROR_MAX_CHARS are not mirrored to localStorage
//   (they can't fit); any stale localStorage copy is removed instead.
// - Every durable write records a per-key `updatedAt`; localStorage keeps the
//   same timestamps in `__apollo_ts`, so on hydrate the newer copy wins.
// - If IndexedDB fails to load on a profile that used it before, storage is
//   marked degraded (storageHealth): sync is blocked elsewhere and large or
//   protected values stay in memory only, so a partial copy can never replace
//   the complete one.

import { db as defaultDb, type ApolloDatabase, type KVEntry } from './apolloDB';
import { isStorageDegraded, markStorageDegraded } from './storageHealthState';

/** Credential keys that don't use the 'apollo_' prefix */
const CREDENTIAL_KEYS = new Set([
  'strava_tokens',
  'strava_credentials',
  'garmin_tokens',
  'garmin_credentials',
  'intervals_credentials',
]);

/** Check if a key belongs to Apollo Running */
function isApolloKey(key: string): boolean {
  return key.startsWith('apollo_') || CREDENTIAL_KEYS.has(key);
}

/**
 * Longest value (UTF-16 chars) mirrored to localStorage. Its quota is about
 * 5.2 M chars per origin, so bigger values live in IndexedDB only.
 */
export const LOCAL_MIRROR_MAX_CHARS = 4_000_000;

/** While storage is degraded, values longer than this are kept in memory only. */
export const DEGRADED_MAX_WRITE_CHARS = 256 * 1024;

/** Keys never written while degraded: the durable copy may be the only complete one. */
const PROTECTED_KEYS = new Set(['apollo_activities_store', 'apollo_wellness', 'apollo_route_cache']);
const PROTECTED_PREFIXES = ['apollo_backup_'];

/** localStorage bookkeeping keys (not Apollo data keys: never cached or exported). */
export const LS_TIMESTAMPS_KEY = '__apollo_ts';
export const LS_IDB_IN_USE_KEY = '__apollo_idb_in_use';

function isProtectedKey(key: string): boolean {
  return PROTECTED_KEYS.has(key) || PROTECTED_PREFIXES.some((p) => key.startsWith(p));
}

/** Minimal slice of the Dexie database the service needs (injectable for tests). */
export type PersistenceDatabase = Pick<ApolloDatabase, 'kvStore'>;

export class PersistenceService {
  private cache = new Map<string, string>();
  private _ready: Promise<void>;
  private _initialized = false;
  private _failedWrites = new Set<string>();
  private _blockedWrites = new Set<string>();
  /** Keys changed since the last flush. */
  private dirty = new Set<string>();
  private flushScheduled = false;
  private pendingWrites = new Set<Promise<unknown>>();
  /** localStorage timestamps (key → updatedAt ms) for the copies held there. */
  private localTimestamps: Record<string, number> = {};
  /** Keys written or removed before hydration finished (hydrate must not override them). */
  private touchedDuringHydrate = new Set<string>();

  constructor(private readonly database: PersistenceDatabase = defaultDb) {
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
      const rawTs = localStorage.getItem(LS_TIMESTAMPS_KEY);
      const parsed: unknown = rawTs ? JSON.parse(rawTs) : null;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
          if (typeof v === 'number' && Number.isFinite(v)) this.localTimestamps[k] = v;
        }
      }
    } catch {
      // localStorage unavailable (private browsing, SSR, etc.) or corrupt timestamps
    }
  }

  /**
   * Load all IndexedDB entries and reconcile them with the localStorage copies:
   * restore keys localStorage lost, let the newer copy win when both exist
   * (per-key updatedAt), and seed IndexedDB with keys it doesn't have yet.
   */
  private async hydrateFromIndexedDB(): Promise<void> {
    let usedBefore = false;
    try { usedBefore = localStorage.getItem(LS_IDB_IN_USE_KEY) === '1'; } catch { /* ignore */ }
    try {
      const entries = await this.database.kvStore.toArray();
      let restoredCount = 0;
      const inIdb = new Set<string>();

      for (const entry of entries) {
        inIdb.add(entry.key);
        if (this.touchedDuringHydrate.has(entry.key)) continue; // a newer write/remove wins
        const cached = this.cache.get(entry.key);
        if (cached === undefined) {
          // IndexedDB has data that localStorage lost (or never held) — restore it
          this.cache.set(entry.key, entry.value);
          this.mirrorLocal(entry.key, entry.value, entry.updatedAt);
          restoredCount++;
        } else if (cached !== entry.value) {
          const localTs = this.localTimestamps[entry.key];
          if (localTs !== undefined && entry.updatedAt > localTs) {
            // The localStorage copy is stale (e.g. written while IndexedDB failed): use the newer one.
            this.cache.set(entry.key, entry.value);
            this.mirrorLocal(entry.key, entry.value, entry.updatedAt);
            restoredCount++;
          } else if (localTs !== undefined && localTs > entry.updatedAt) {
            this.dirty.add(entry.key); // localStorage is newer: heal IndexedDB
          }
          // No timestamp (data written by ≤ 1.0.5): keep the localStorage copy, as before.
        }
      }

      // Seed IndexedDB with anything only localStorage has (first run, or IndexedDB lost it).
      for (const key of this.cache.keys()) {
        if (!inIdb.has(key)) this.dirty.add(key);
      }
      this.saveLocalTimestamps();
      if (this.dirty.size > 0) this.scheduleFlush();
      try { localStorage.setItem(LS_IDB_IN_USE_KEY, '1'); } catch { /* ignore */ }

      if (restoredCount > 0) {
        console.info(`[Apollo] Restored ${restoredCount} entries from IndexedDB`);
      }
    } catch (err) {
      if (usedBefore) {
        console.error('[Apollo] IndexedDB failed to load — storage degraded:', err);
        markStorageDegraded(
          'Apollo couldn\u2019t open its database, so some of your data may not be loaded. '
          + 'Syncing and saving large data are paused to protect it. Restart Apollo; if this keeps happening, '
          + 'free up disk space and make sure only one Apollo window is open.',
        );
      } else {
        console.warn('[Apollo] IndexedDB unavailable, using localStorage only:', err);
      }
    }
    this.touchedDuringHydrate.clear();
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

  /** Keys that failed to write to IndexedDB (for health monitoring). */
  get failedWrites(): ReadonlySet<string> {
    return this._failedWrites;
  }

  /** Keys kept in memory only because storage is degraded. */
  get blockedWrites(): ReadonlySet<string> {
    return this._blockedWrites;
  }

  /** Retry any writes that previously failed. Call after connectivity/quota issues resolve. */
  async retryFailedWrites(): Promise<number> {
    let recovered = 0;
    for (const key of this._failedWrites) {
      const value = this.cache.get(key);
      if (value === undefined) {
        this._failedWrites.delete(key);
        continue;
      }
      try {
        await this.database.kvStore.put({ key, value, updatedAt: Date.now() });
        this._failedWrites.delete(key);
        recovered++;
      } catch {
        // Still failing — leave in the set
      }
    }
    if (recovered > 0) {
      console.info(`[Apollo] Recovered ${recovered} previously failed write(s)`);
    }
    return recovered;
  }

  /** Synchronous read from the in-memory cache */
  getItem(key: string): string | null {
    return this.cache.get(key) ?? null;
  }

  /**
   * Write to the cache now; IndexedDB and localStorage follow on the next
   * microtask (coalesced per key, always the latest value).
   */
  setItem(key: string, value: string): void {
    this.cache.set(key, value);
    if (!this._initialized) this.touchedDuringHydrate.add(key);
    this.dirty.add(key);
    this.scheduleFlush();
  }

  /** Remove from all storage layers */
  removeItem(key: string): void {
    this.cache.delete(key);
    this.dirty.delete(key);
    this._blockedWrites.delete(key);
    if (!this._initialized) this.touchedDuringHydrate.add(key);
    this.track(this.database.kvStore.delete(key).catch(() => {}));
    try { localStorage.removeItem(key); } catch { /* ignore */ }
    if (key in this.localTimestamps) {
      delete this.localTimestamps[key];
      this.saveLocalTimestamps();
    }
  }

  /** Get all Apollo keys currently stored */
  keys(): string[] {
    return Array.from(this.cache.keys());
  }

  /** Number of Apollo keys stored */
  get length(): number {
    return this.cache.size;
  }

  /** Clear all Apollo data from every storage layer (fire-and-forget; see clearAll). */
  clear(): void {
    void this.clearAll();
  }

  /**
   * Clear all Apollo data from every layer and wait for IndexedDB: the cache,
   * every IndexedDB entry (including keys that never loaded) and every Apollo
   * key or bookkeeping entry in localStorage.
   */
  async clearAll(): Promise<void> {
    this.cache.clear();
    this.dirty.clear();
    this._blockedWrites.clear();
    this._failedWrites.clear();
    this.localTimestamps = {};
    try {
      const doomed: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && (isApolloKey(key) || key === LS_TIMESTAMPS_KEY || key === LS_IDB_IN_USE_KEY)) doomed.push(key);
      }
      for (const key of doomed) localStorage.removeItem(key);
    } catch { /* localStorage unavailable */ }
    await Promise.allSettled([...this.pendingWrites]);
    await this.database.kvStore.clear();
  }

  /** Bulk import: set multiple keys at once (used by data import / restore) */
  bulkSet(entries: Record<string, string>): void {
    for (const [key, value] of Object.entries(entries)) {
      this.cache.set(key, value);
      if (!this._initialized) this.touchedDuringHydrate.add(key);
      this.dirty.add(key);
    }
    this.scheduleFlush();
  }

  /**
   * Write pending changes now and wait until IndexedDB has committed them
   * (or failed). Use before reloading the page or reading IndexedDB directly.
   */
  async flush(): Promise<void> {
    if (this.dirty.size > 0) this.flushNow();
    await Promise.allSettled([...this.pendingWrites]);
  }

  /** Export all cached data as a plain Record */
  toRecord(): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [key, value] of this.cache) {
      result[key] = value;
    }
    return result;
  }

  // ── Internals ───────────────────────────────────────────────────────────────

  private scheduleFlush(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    queueMicrotask(() => {
      if (this.flushScheduled) this.flushNow();
    });
  }

  /** Write every dirty key's latest value to IndexedDB and localStorage. */
  private flushNow(): void {
    this.flushScheduled = false;
    if (this.dirty.size === 0) return;
    const keys = Array.from(this.dirty);
    this.dirty.clear();
    const updatedAt = Date.now();
    const degraded = isStorageDegraded();
    const entries: KVEntry[] = [];

    for (const key of keys) {
      const value = this.cache.get(key);
      if (value === undefined) continue; // removed since — removeItem handled the layers
      if (degraded && (isProtectedKey(key) || value.length > DEGRADED_MAX_WRITE_CHARS)) {
        this._blockedWrites.add(key);
        continue;
      }
      this._blockedWrites.delete(key);
      entries.push({ key, value, updatedAt });
      this.mirrorLocal(key, value, updatedAt);
    }
    this.saveLocalTimestamps();
    if (entries.length === 0) return;

    const write = this.database.kvStore.bulkPut(entries).then(
      () => {
        for (const e of entries) this._failedWrites.delete(e.key);
      },
      (err: unknown) => {
        console.error('[Apollo] IndexedDB write failed:', err);
        for (const e of entries) this._failedWrites.add(e.key);
      },
    );
    this.track(write);
  }

  private track(promise: Promise<unknown>): void {
    this.pendingWrites.add(promise);
    void promise.finally(() => this.pendingWrites.delete(promise));
  }

  /**
   * Mirror a value to localStorage with its timestamp. Values too large for
   * localStorage, or that no longer fit (quota exceeded), are removed instead:
   * an outdated copy there would otherwise shadow the newer IndexedDB one.
   */
  private mirrorLocal(key: string, value: string, updatedAt: number): void {
    try {
      if (value.length > LOCAL_MIRROR_MAX_CHARS) throw new Error('too large for localStorage');
      localStorage.setItem(key, value);
      this.localTimestamps[key] = updatedAt;
    } catch {
      try { localStorage.removeItem(key); } catch { /* localStorage unavailable */ }
      delete this.localTimestamps[key];
    }
  }

  private saveLocalTimestamps(): void {
    try {
      localStorage.setItem(LS_TIMESTAMPS_KEY, JSON.stringify(this.localTimestamps));
    } catch { /* quota or unavailable: hydrate then falls back to "localStorage wins" */ }
  }
}

/** Singleton persistence service — initialized on module import */
export const persistence = new PersistenceService();

export { CREDENTIAL_KEYS, isApolloKey };
