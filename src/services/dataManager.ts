/**
 * Data management service for exporting, importing, and clearing Apollo Running data.
 * Uses the persistence service (IndexedDB + localStorage) for all storage operations.
 */

import { persistence, isApolloKey } from './db/persistence';

export interface BackupMetadata {
  exportDate: string;
  appName: string;
  version: string;
  keyCount: number;
}

export interface BackupData {
  metadata: BackupMetadata;
  data: Record<string, string>;
}

/**
 * Export all Apollo-related data from the persistence layer.
 * Includes all keys starting with 'apollo_' plus credential keys.
 *
 * @returns An object containing metadata and all exported data
 */
export function exportAllData(): BackupData {
  const data = persistence.toRecord();

  const metadata: BackupMetadata = {
    exportDate: new Date().toISOString(),
    appName: 'Apollo Running',
    version: '1.0',
    keyCount: Object.keys(data).length,
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

  // Import only allowed keys — reject anything outside the safe set
  try {
    const allowed: Record<string, string> = {};
    Object.entries(backupData.data).forEach(([key, value]) => {
      if (typeof value !== 'string') return;
      if (isApolloKey(key)) {
        allowed[key] = value;
      }
    });
    if (Object.keys(allowed).length === 0) return false;
    persistence.bulkSet(allowed);
    return true;
  } catch (e) {
    console.error('Failed to import data:', e);
    return false;
  }
}

/**
 * Clear all Apollo-related data from all storage layers.
 * Removes all keys starting with 'apollo_' plus credential keys.
 */
export function clearAllData(): void {
  persistence.clear();
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
