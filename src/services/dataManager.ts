/**
 * Data management service for exporting, importing, and clearing Apollo Running data.
 * Uses the persistence service (IndexedDB + localStorage) for all storage operations.
 */

import { persistence, isApolloKey, CREDENTIAL_KEYS } from './db/persistence';
import { clearBackupPayloads } from './db/backupStore';
import { clearAllCredentials } from './storage';
import { APP_VERSION } from '../version';

/** Why data is being exported (recorded in the metadata; the content is the same). */
export type ExportPurpose = 'backup' | 'export';

export interface BackupMetadata {
  exportDate: string;
  appName: string;
  version: string;
  keyCount: number;
  /** v1.0.6+: 'backup' (in-app backup) or 'export' (downloaded file). */
  purpose?: ExportPurpose;
}

export interface BackupData {
  metadata: BackupMetadata;
  data: Record<string, string>;
}

/** Prefix of the in-app backup keys (registry, config and payloads). */
export const BACKUP_KEY_PREFIX = 'apollo_backup_';

/** v1.0.7 (PX-14): prefix of quarantined (damaged) copies — see db/quarantine.ts. */
export const QUARANTINE_KEY_PREFIX = 'apollo_quarantine_';

/**
 * Device/session state that is neither exported nor removed by a restore:
 * it describes this device (or this session), not the athlete's data.
 */
const DEVICE_STATE_KEYS = new Set([
  'apollo_last_integrity_check',
  'apollo_needs_reconnect',
  'apollo_storage_persist_requested',
]);

/**
 * True for keys never written to an export or backup (V1, V4):
 * - credentials (API keys, OAuth tokens, client secrets),
 * - in-app backups themselves (`apollo_backup_*`), which made every backup
 *   embed all earlier ones,
 * - derived caches (`*_cache`, rebuilt on demand),
 * - device state (integrity-check time, needs-reconnect, persist request),
 * - v1.0.7 (PX-14): quarantined damaged copies (`apollo_quarantine_*`).
 */
export function isExcludedFromExport(key: string): boolean {
  return (
    CREDENTIAL_KEYS.has(key) ||
    key.startsWith(BACKUP_KEY_PREFIX) ||
    key.startsWith(QUARANTINE_KEY_PREFIX) ||
    key.endsWith('_cache') ||
    DEVICE_STATE_KEYS.has(key)
  );
}

/**
 * True for keys a restore must keep even when the snapshot doesn't have them:
 * the backups themselves, device state and credentials. Every other Apollo
 * key missing from the snapshot is deleted so the restored state is exact.
 * v1.0.7 (PX-14): quarantined copies are kept too.
 */
export function isPreservedOnRestore(key: string): boolean {
  return (
    CREDENTIAL_KEYS.has(key) ||
    key.startsWith(BACKUP_KEY_PREFIX) ||
    key.startsWith(QUARANTINE_KEY_PREFIX) ||
    DEVICE_STATE_KEYS.has(key) ||
    !isApolloKey(key)
  );
}

/**
 * Export the athlete's Apollo data from the persistence layer: every
 * `apollo_` key except those excluded by `isExcludedFromExport` (no
 * credentials, no nested backups, no caches).
 *
 * @returns An object containing metadata and the exported data
 */
export function exportAllData(opts: { purpose?: ExportPurpose } = {}): BackupData {
  const all = persistence.toRecord();
  const data: Record<string, string> = {};
  for (const key of Object.keys(all).sort()) {
    if (isApolloKey(key) && !isExcludedFromExport(key)) data[key] = all[key];
  }

  const metadata: BackupMetadata = {
    exportDate: new Date().toISOString(),
    appName: 'Apollo Running',
    version: APP_VERSION,
    keyCount: Object.keys(data).length,
    purpose: opts.purpose ?? 'export',
  };

  return { metadata, data };
}

/**
 * Import and restore data from a backup file.
 * Validates the structure before importing.
 * Only allows keys that match the apollo_ prefix or known credential keys,
 * preventing arbitrary key injection from tampered backup files.
 *
 * @param backup - The backup data object to import
 * @returns true if import was successful, false otherwise
 */
export function importAllData(backup: unknown): boolean {
  // Validate the backup structure
  if (!backup || typeof backup !== 'object') {
    return false;
  }

  const backupData = backup as Partial<BackupData>;

  // Check for required metadata
  if (!backupData.metadata || !backupData.data) {
    return false;
  }

  // Validate this backup is from Apollo Running
  if (backupData.metadata.appName !== 'Apollo Running') {
    return false;
  }

  if (typeof backupData.data !== 'object' || backupData.data === null) {
    return false;
  }

  // Validate key count matches metadata (tamper detection)
  const dataKeys = Object.keys(backupData.data);
  if (backupData.metadata.keyCount !== dataKeys.length) {
    return false;
  }

  // Import only allowed keys — reject credentials, backups, quarantine, caches,
  // device-state flags, oversized keys, and prototype-polluting keys.
  try {
    const allowed: Record<string, string> = {};
    for (const [key, value] of Object.entries(backupData.data)) {
      if (typeof value !== 'string') continue;
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
      if (key.length > 128 || CREDENTIAL_KEYS.has(key) || isExcludedFromExport(key)) continue;
      if (isApolloKey(key)) {
        allowed[key] = value;
      }
    }
    if (Object.keys(allowed).length === 0) return false;
    persistence.bulkSet(allowed);
    return true;
  } catch (e) {
    console.error('[Apollo] Failed to import data:', e);
    return false;
  }
}

/**
 * Clear all Apollo-related data from all storage layers.
 * Removes all keys starting with 'apollo_' plus credential keys.
 */
export function clearAllData(): void {
  persistence.clear();
  // v1.0.7 (PX-04): backup payloads live in their own table.
  void clearBackupPayloads().catch((err: unknown) => console.error('[Apollo] Failed to clear backups:', err));
}

/**
 * "Delete all my data" (U6): remove every Apollo key and credential from this
 * device — the in-memory cache, IndexedDB (including keys that never loaded),
 * localStorage, and on desktop the encrypted credential store. Backups stored
 * in the app are deleted too. Downloaded export files are not touched.
 * v1.0.9: on desktop the synced backup folder is disconnected (Apollo forgets
 * the folder and stops writing to it); snapshots already in that folder are the
 * user's own files and are left in place.
 *
 * Callers should confirm first (ConfirmDialog) and reload the app afterwards
 * (`window.location.reload()`) so no module keeps stale in-memory state.
 * Rejects if IndexedDB or the desktop credential store could not be cleared.
 */
export async function deleteAllLocalData(): Promise<void> {
  const failedCredentials = await clearAllCredentials();
  await persistence.clearAll();
  // v1.0.7 (PX-04): backup payloads live in their own IndexedDB table.
  await clearBackupPayloads();
  // Sweep anything written to localStorage outside the persistence layer.
  try {
    const doomed: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && (isApolloKey(key) || key.startsWith('__apollo_'))) doomed.push(key);
    }
    for (const key of doomed) localStorage.removeItem(key);
  } catch {
    /* localStorage unavailable */
  }
  // v1.0.9: forget the synced backup folder (best effort; its files stay where they are).
  try {
    const folder = typeof window !== 'undefined' ? window.electronAPI?.backupFolder : undefined;
    if (folder && typeof folder.clearFolder === 'function') await folder.clearFolder();
  } catch (err) {
    console.warn('[Apollo] Could not disconnect the synced backup folder:', err);
  }
  if (failedCredentials.length > 0) {
    throw new Error(
      `Some saved credentials could not be removed from the desktop keychain store (${failedCredentials.join(', ')}). Try again, or disconnect the services in Settings.`,
    );
  }
}

/**
 * Trigger a browser download of a JSON file.
 *
 * @param data - The data object to download
 * @param filename - The filename for the download
 */
export function downloadJson(data: unknown, filename: string): void {
  const json = JSON.stringify(data, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);

  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);

  // Clean up the object URL
  URL.revokeObjectURL(url);
}

/**
 * Generate a filename for the backup with current date and time.
 * Format: apollo-backup-YYYY-MM-DD-HHMMSS.json
 */
export function generateBackupFilename(): string {
  const date = new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');

  return `apollo-backup-${year}-${month}-${day}-${hours}${minutes}${seconds}.json`;
}
