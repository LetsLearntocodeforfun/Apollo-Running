/**
 * Storage health (v1.0.6) — is local storage trustworthy right now, how much
 * space does Apollo use, and (web) asking the browser not to evict our data.
 *
 * "Degraded" means IndexedDB failed to load on a profile that used it before.
 * Data that only lives there (the activity store once it outgrows
 * localStorage) may be missing from memory, so syncing or saving large data
 * in this session could overwrite the complete copy. While degraded:
 *   - activity sync is blocked (activitySource),
 *   - persistence keeps large/protected values in memory only (not saved),
 *   - the UI should show a blocking "Storage unavailable" banner.
 * Restarting the app usually clears it.
 */

import { persistence } from './db/persistence';
import {
  getStorageHealthState,
  subscribeStorageHealth,
  type StorageHealth,
} from './db/storageHealthState';

export type { StorageHealth } from './db/storageHealthState';
export {
  STORAGE_HEALTH_CHANGED_EVENT,
  isStorageDegraded,
  markStorageDegraded,
  clearStorageDegraded,
} from './db/storageHealthState';

/** Remembers that persistent storage was already requested (device state, not exported). */
export const PERSIST_REQUESTED_KEY = 'apollo_storage_persist_requested';

/** Current storage health. */
export function getStorageHealth(): StorageHealth {
  return getStorageHealthState();
}

/** Subscribe to storage health changes. Returns an unsubscribe function. */
export function onStorageHealthChanged(cb: (health: StorageHealth) => void): () => void {
  return subscribeStorageHealth(cb);
}

/** Size of one stored key, in UTF-16 characters (≈ 2 bytes each). */
export interface StorageKeyUsage {
  key: string;
  chars: number;
}

export interface StorageUsageEstimate {
  /** Bytes used by this origin (all storage types), or null when the browser can't tell. */
  usageBytes: number | null;
  /** Bytes this origin may use, or null when unknown. */
  quotaBytes: number | null;
  /** Apollo keys, largest first. */
  keys: StorageKeyUsage[];
}

/**
 * Estimate storage usage: origin totals from `navigator.storage.estimate()`
 * plus per-key sizes from the persistence cache. Never rejects.
 */
export async function estimateStorageUsage(): Promise<StorageUsageEstimate> {
  const keys: StorageKeyUsage[] = persistence
    .keys()
    .map((key) => ({ key, chars: persistence.getItem(key)?.length ?? 0 }))
    .sort((a, b) => b.chars - a.chars || a.key.localeCompare(b.key));

  let usageBytes: number | null = null;
  let quotaBytes: number | null = null;
  try {
    const storage = typeof navigator !== 'undefined' ? navigator.storage : undefined;
    if (storage && typeof storage.estimate === 'function') {
      const estimate = await storage.estimate();
      usageBytes = typeof estimate.usage === 'number' ? estimate.usage : null;
      quotaBytes = typeof estimate.quota === 'number' ? estimate.quota : null;
    }
  } catch {
    // Not supported / denied — leave totals unknown.
  }
  return { usageBytes, quotaBytes, keys };
}

/** Whether the browser already granted persistent storage (null = unknown/unsupported). */
export async function isStoragePersisted(): Promise<boolean | null> {
  try {
    const storage = typeof navigator !== 'undefined' ? navigator.storage : undefined;
    if (storage && typeof storage.persisted === 'function') return await storage.persisted();
  } catch { /* unsupported */ }
  return null;
}

/**
 * Ask the browser to keep Apollo's data even under storage pressure
 * (`navigator.storage.persist()`). Resolves to whether storage is persistent;
 * false when unsupported or refused. Never rejects.
 */
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    const storage = typeof navigator !== 'undefined' ? navigator.storage : undefined;
    if (!storage || typeof storage.persist !== 'function') return false;
    if (typeof storage.persisted === 'function' && await storage.persisted()) return true;
    return await storage.persist();
  } catch {
    return false;
  }
}

/**
 * Web only: request persistent storage once per device, after the first
 * successful sync or import (browsers are more likely to grant it once the
 * site holds real data). No-op on desktop, where data lives in the app profile.
 */
export async function requestPersistentStorageOnce(): Promise<boolean> {
  if (typeof window !== 'undefined' && window.electronAPI) return false;
  if (persistence.getItem(PERSIST_REQUESTED_KEY)) return false;
  persistence.setItem(PERSIST_REQUESTED_KEY, new Date().toISOString());
  return requestPersistentStorage();
}
