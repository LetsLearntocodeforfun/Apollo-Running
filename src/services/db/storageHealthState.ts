/**
 * Leaf module (no imports) holding the "storage degraded" flag, so both the
 * persistence layer and the public storageHealth service can use it without
 * an import cycle. Consumers should use `src/services/storageHealth.ts`.
 */

/** Whether local storage can be trusted right now. */
export interface StorageHealth {
  /**
   * True when IndexedDB failed to load on a profile that has used it before:
   * data that only lives there (e.g. a large activity store) may be missing
   * from memory, so syncing or saving large data could overwrite it.
   */
  degraded: boolean;
  /** Human-readable explanation, when degraded. */
  reason?: string;
}

/** Window event dispatched whenever the storage health changes. */
export const STORAGE_HEALTH_CHANGED_EVENT = 'apollo:storage-health-changed';

let health: StorageHealth = { degraded: false };
const listeners = new Set<(health: StorageHealth) => void>();

function emit(): void {
  const snapshot = { ...health };
  for (const listener of listeners) {
    try { listener(snapshot); } catch { /* listener errors must not break storage */ }
  }
  try {
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      window.dispatchEvent(new CustomEvent(STORAGE_HEALTH_CHANGED_EVENT, { detail: snapshot }));
    }
  } catch { /* no DOM (tests / SSR) */ }
}

/** Current storage health (a copy). */
export function getStorageHealthState(): StorageHealth {
  return { ...health };
}

/** True while storage is degraded (sync and large writes are blocked). */
export function isStorageDegraded(): boolean {
  return health.degraded;
}

/** Mark storage as degraded (called by persistence when IndexedDB fails to load). */
export function markStorageDegraded(reason: string): void {
  if (health.degraded && health.reason === reason) return;
  health = { degraded: true, reason };
  emit();
}

/** Clear the degraded flag (e.g. after a successful reload of IndexedDB, or in tests). */
export function clearStorageDegraded(): void {
  if (!health.degraded) return;
  health = { degraded: false };
  emit();
}

/** Subscribe to storage health changes. Returns an unsubscribe function. */
export function subscribeStorageHealth(listener: (health: StorageHealth) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
