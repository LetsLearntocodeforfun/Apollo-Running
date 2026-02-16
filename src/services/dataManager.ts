/**
 * Data management service for exporting, importing, and clearing Apollo Running data.
 * All user training data, credentials, and preferences are stored in localStorage.
 */

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
 * Known localStorage keys used by Apollo Running.
 * These are the credential keys that don't use the apollo_ prefix.
 */
const CREDENTIAL_KEYS = [
  'strava_tokens',
  'strava_credentials',
  'garmin_tokens',
  'garmin_credentials',
];

/**
 * Export all Apollo-related data from localStorage.
 * Includes all keys starting with 'apollo_' plus credential keys.
 * 
 * @returns An object containing metadata and all exported data
 */
export function exportAllData(): BackupData {
  const data: Record<string, string> = {};
  
  // Iterate through all localStorage keys
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key) continue;
    
    // Include keys that start with 'apollo_' or are credential keys
    if (key.startsWith('apollo_') || CREDENTIAL_KEYS.includes(key)) {
      const value = localStorage.getItem(key);
      if (value !== null) {
        data[key] = value;
      }
    }
  }
  
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
  
  if (typeof backupData.data !== 'object' || backupData.data === null) {
    return false;
  }
  
  // Import all data
  try {
    Object.entries(backupData.data).forEach(([key, value]) => {
      if (typeof value === 'string') {
        localStorage.setItem(key, value);
      }
    });
    return true;
  } catch (e) {
    console.error('Failed to import data:', e);
    return false;
  }
}

/**
 * Clear all Apollo-related data from localStorage.
 * Removes all keys starting with 'apollo_' plus credential keys.
 */
export function clearAllData(): void {
  const keysToRemove: string[] = [];
  
  // Collect all keys to remove
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key) continue;
    
    if (key.startsWith('apollo_') || CREDENTIAL_KEYS.includes(key)) {
      keysToRemove.push(key);
    }
  }
  
  // Remove all collected keys
  keysToRemove.forEach(key => localStorage.removeItem(key));
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
