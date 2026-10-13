/**
 * v1.0.7 (PX-04): backup payload storage — the Dexie `backups` table.
 *
 * Payloads are read only when needed (restore, verify, download), never at
 * launch. Every write is awaited, so callers know it has committed. The
 * backup registry (small metadata) stays in the persistence layer.
 */

import { db, LEGACY_BACKUP_DATA_PREFIX } from './apolloDB';
import { persistence } from './persistence';
import { isStorageDegraded } from './storageHealthState';

export { LEGACY_BACKUP_DATA_PREFIX };

/** Write a backup payload and wait until IndexedDB has committed it. */
export async function putBackupPayload(id: string, json: string): Promise<void> {
  await db.backups.put({ id, json, updatedAt: Date.now() });
}

/** Read one backup payload (null when it isn't stored). */
export async function getBackupPayload(id: string): Promise<string | null> {
  const row = await db.backups.get(id);
  return row?.json ?? null;
}

/** Delete one backup payload. */
export async function deleteBackupPayload(id: string): Promise<void> {
  await db.backups.delete(id);
}

/** IDs of every stored payload (keys only; payloads are not loaded). */
export async function listBackupPayloadIds(): Promise<string[]> {
  return (await db.backups.toCollection().primaryKeys()).map(String);
}

/** Delete every stored payload ("Delete all my data"). */
export async function clearBackupPayloads(): Promise<void> {
  await db.backups.clear();
}

/**
 * Move backup payloads still held by the persistence layer (≤ 1.0.6
 * `apollo_backup_data_<id>` keys, e.g. localStorage copies the Dexie upgrade
 * can't see) into the backups table. Each key is removed only after its copy
 * has committed and read back identical. Skipped while storage is degraded.
 * Idempotent; returns how many payloads moved.
 */
export async function migrateLegacyBackupPayloads(): Promise<number> {
  if (isStorageDegraded()) return 0;
  let moved = 0;
  const legacyKeys = persistence.keys().filter((k) => k.startsWith(LEGACY_BACKUP_DATA_PREFIX));
  for (const key of legacyKeys) {
    const json = persistence.getItem(key);
    if (json === null) continue;
    const id = key.slice(LEGACY_BACKUP_DATA_PREFIX.length);
    try {
      await putBackupPayload(id, json);
      if ((await getBackupPayload(id)) !== json) continue; // keep the legacy copy
      persistence.removeItem(key);
      moved++;
    } catch (err) {
      console.warn(`[Apollo Backup] Couldn\u2019t move backup ${id} to the backups table:`, err);
    }
  }
  if (moved > 0) console.info(`[Apollo Backup] Moved ${moved} backup(s) to the backups table`);
  return moved;
}
