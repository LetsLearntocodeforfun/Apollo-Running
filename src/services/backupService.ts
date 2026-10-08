// Automated backup & data integrity — periodic backups, SHA-256 checksums, rotation.
//
// v1.0.6 (V1–V6, U2–U5):
// - Backups and exports contain only the athlete's data: no earlier backups,
//   credentials, caches or device state (dataManager.isExcludedFromExport).
// - A one-time migration compacts backups made by ≤ 1.0.5 (which embedded
//   every earlier backup and plaintext credentials).
// - Export → Import round-trips: checksums use canonical compact JSON, and
//   files from 1.0.5 (pretty-printed checksum) are still accepted.
// - Import validates each value instead of silently dropping values > 1 MB,
//   accepts .json.gz, and reports skipped keys (success:false).
// - Restore replaces the data exactly (keys absent from the snapshot are
//   removed after a safety backup) and never touches backups or credentials.
// - Automatic backups really run (initBackupSystem from main.tsx).

import { persistence, isApolloKey, CREDENTIAL_KEYS } from './db/persistence';
import { hasMigrationRun, markMigrationRun } from './db/migrations';
import { isStorageDegraded } from './db/storageHealthState';
import {
  exportAllData,
  isExcludedFromExport,
  isPreservedOnRestore,
  type BackupData,
} from './dataManager';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface BackupConfig {
  autoBackupEnabled: boolean;
  intervalHours: number;
  maxBackups: number;
  verifyOnStartup: boolean;
}

export interface BackupRecord {
  /** Unique backup ID (timestamp-based). */
  id: string;
  /** ISO timestamp of when the backup was created. */
  createdAt: string;
  /** SHA-256 hash of the backup JSON content. */
  checksum: string;
  /** Number of data keys in this backup. */
  keyCount: number;
  /** Size of the backup in bytes. */
  sizeBytes: number;
  /** Whether this backup was created automatically or manually. */
  trigger: 'auto' | 'manual' | 'startup';
  /** Whether integrity verification passed. */
  verified: boolean;
  /** Optional context, e.g. "Before restore" / "Before import" for safety backups. */
  note?: string;
}

export interface BackupHealth {
  /** Last successful backup timestamp. */
  lastBackupAt: string | null;
  /** Days since last backup. */
  daysSinceBackup: number;
  /** Number of stored backups. */
  backupCount: number;
  /** Whether the most recent backup passed integrity check. */
  lastCheckPassed: boolean;
  /** Overall health status. */
  status: 'healthy' | 'warning' | 'critical';
  /** Human-readable status message. */
  message: string;
}

/** Outcome of a restore (restoreFromBackupDetailed). */
export interface RestoreResult {
  success: boolean;
  /** Why it failed (shown to the user as is). */
  error?: string;
  /** Number of keys written from the snapshot. */
  restoredKeys: number;
  /** Keys deleted because the snapshot didn't have them. */
  removedKeys: string[];
  /** The backup taken right before restoring (undo point). */
  safetyBackupId?: string;
}

/** A key from an import file that was not imported, and why. */
export interface SkippedKey {
  key: string;
  reason: string;
}

/** Outcome of importFromFile. */
export interface ImportResult {
  /** False when the file was rejected or any data key couldn't be imported. */
  success: boolean;
  /** Human-readable summary (platform-neutral). */
  message: string;
  /** Keys written to this device. */
  importedKeys: string[];
  /** Data keys that were NOT imported (invalid values) — makes success false. */
  skippedKeys: SkippedKey[];
  /** Keys deliberately ignored: credentials, old backups, caches, device state. */
  ignoredKeys: string[];
  /** True when data changed: the app should reload (window.location.reload()) to show it. */
  needsReload: boolean;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const CONFIG_KEY = 'apollo_backup_config';
const BACKUP_REGISTRY_KEY = 'apollo_backup_registry';
const BACKUP_DATA_PREFIX = 'apollo_backup_data_';
const LAST_INTEGRITY_CHECK_KEY = 'apollo_last_integrity_check';
/** Last automatic/manual backup failure `{ message, at }` (device state, never exported). */
const LAST_ERROR_KEY = 'apollo_backup_last_error';

/** Window event dispatched whenever backups are created, restored, pruned or compacted. */
export const BACKUPS_CHANGED_EVENT = 'apollo:backups-changed';

/** `apollo_migrations` id of the one-time compaction of ≤ 1.0.5 backups. */
export const BACKUP_COMPACTION_MIGRATION_ID = 'backup-compaction-1.0.6';

const DEFAULT_CONFIG: BackupConfig = {
  autoBackupEnabled: true,
  intervalHours: 24,
  maxBackups: 10,
  verifyOnStartup: true,
};

/** Largest import file accepted (compressed size for .json.gz). */
export const MAX_IMPORT_FILE_BYTES = 256 * 1024 * 1024; // 256 MB
/** How often the running app checks whether an automatic backup is due. */
const AUTO_BACKUP_CHECK_MS = 30 * 60 * 1000;

/** Keys stored as plain (non-JSON) strings by some modules: short scalars only. */
const MAX_PLAIN_VALUE_CHARS = 1024;

// ── SHA-256 Hashing ───────────────────────────────────────────────────────────

/**
 * Compute SHA-256 hash of a string using the SubtleCrypto API.
 * Available in all modern browsers and Electron.
 */
async function sha256(content: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(content);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

function utf8Length(s: string): number {
  return new Blob([s]).size;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function emitBackupsChanged(): void {
  try {
    if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(BACKUPS_CHANGED_EVENT));
  } catch { /* no DOM */ }
}

// ── Configuration ─────────────────────────────────────────────────────────────

/** Get the current backup configuration. */
export function getBackupConfig(): BackupConfig {
  try {
    const raw = persistence.getItem(CONFIG_KEY);
    if (!raw) return { ...DEFAULT_CONFIG };
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

/** Update the backup configuration. */
export function setBackupConfig(config: Partial<BackupConfig>): void {
  const current = getBackupConfig();
  persistence.setItem(CONFIG_KEY, JSON.stringify({ ...current, ...config }));
}

// ── Backup Registry ───────────────────────────────────────────────────────────

/** Get all backup records. */
function getBackupRegistry(): BackupRecord[] {
  try {
    const raw = persistence.getItem(BACKUP_REGISTRY_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed as BackupRecord[] : [];
  } catch {
    return [];
  }
}

/** Save the backup registry. */
function saveBackupRegistry(records: BackupRecord[]): void {
  persistence.setItem(BACKUP_REGISTRY_KEY, JSON.stringify(records));
}

/** Get all backup records (public). */
export function getBackupRecords(): BackupRecord[] {
  return getBackupRegistry();
}

// ── Last error (U4/U2: show real messages) ────────────────────────────────────

/** Why the most recent backup attempt failed, or null if it succeeded. */
export function getLastBackupError(): { message: string; at: string } | null {
  try {
    const raw = persistence.getItem(LAST_ERROR_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === 'object' && typeof (parsed as { message?: unknown }).message === 'string') {
      return parsed as { message: string; at: string };
    }
  } catch { /* ignore */ }
  return null;
}

function setLastBackupError(message: string | null): void {
  if (message === null) {
    if (persistence.getItem(LAST_ERROR_KEY) !== null) persistence.removeItem(LAST_ERROR_KEY);
    return;
  }
  persistence.setItem(LAST_ERROR_KEY, JSON.stringify({ message, at: new Date().toISOString() }));
}

// ── Core Backup Operations ────────────────────────────────────────────────────

/**
 * Create a backup of the athlete's data with an integrity checksum. Contains
 * no earlier backups, credentials or caches, so each backup is about the size
 * of the data itself. Returns the record, or null on failure
 * (`getLastBackupError()` says why).
 */
export async function createBackup(
  trigger: BackupRecord['trigger'] = 'manual',
  opts: { note?: string } = {},
): Promise<BackupRecord | null> {
  try {
    if (isStorageDegraded()) {
      throw new Error('Storage is unavailable right now, so the backup could not be saved. Restart Apollo and try again.');
    }
    const backupData = exportAllData({ purpose: 'backup' });
    const jsonStr = JSON.stringify(backupData);
    const checksum = await sha256(jsonStr);

    const id = `backup_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const record: BackupRecord = {
      id,
      createdAt: new Date().toISOString(),
      checksum,
      keyCount: backupData.metadata.keyCount,
      sizeBytes: utf8Length(jsonStr),
      trigger,
      verified: true,
      ...(opts.note ? { note: opts.note } : {}),
    };

    // Store backup data in a separate KV entry
    const storageKey = `${BACKUP_DATA_PREFIX}${id}`;
    persistence.setItem(storageKey, jsonStr);
    if (persistence.getItem(storageKey) !== jsonStr) {
      throw new Error('The backup could not be stored on this device.');
    }

    const registry = getBackupRegistry();
    registry.push(record);
    saveBackupRegistry(registry);
    await pruneOldBackups();
    setLastBackupError(null);
    emitBackupsChanged();

    console.info(`[Apollo Backup] Created backup ${id} (${record.keyCount} keys, ${formatBytes(record.sizeBytes)}, checksum: ${checksum.slice(0, 12)}…)`);
    return record;
  } catch (err) {
    const message = errorMessage(err);
    console.error('[Apollo Backup] Failed to create backup:', err);
    try { setLastBackupError(message); } catch { /* ignore */ }
    return null;
  }
}

function isBackupShape(value: unknown): value is BackupData {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<BackupData>;
  return !!v.metadata && typeof v.metadata === 'object' && !!v.data && typeof v.data === 'object' && !Array.isArray(v.data);
}

/** Snapshot keys a restore may write: Apollo data only (no backups, credentials, caches, device state). */
function restorableEntries(data: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(data)) {
    if (typeof value !== 'string') continue;
    if (!isApolloKey(key) || isExcludedFromExport(key)) continue;
    out[key] = value;
  }
  return out;
}

/**
 * Restore the athlete's data from a stored backup, exactly as it was:
 * verifies the checksum, takes a safety backup, writes the snapshot's keys and
 * removes Apollo keys the snapshot doesn't have. Backups, credentials and
 * device state are never touched, so the backup list stays complete.
 */
export async function restoreFromBackupDetailed(backupId: string): Promise<RestoreResult> {
  const fail = (error: string): RestoreResult => ({ success: false, error, restoredKeys: 0, removedKeys: [] });
  try {
    if (isStorageDegraded()) return fail('Storage is unavailable right now, so nothing was restored. Restart Apollo and try again.');
    const storageKey = `${BACKUP_DATA_PREFIX}${backupId}`;
    const jsonStr = persistence.getItem(storageKey);
    if (!jsonStr) return fail('This backup\u2019s data is missing from the device.');

    const record = getBackupRegistry().find((r) => r.id === backupId);
    if (record) {
      const checksum = await sha256(jsonStr);
      if (checksum !== record.checksum) {
        return fail('This backup failed its integrity check (checksum mismatch), so it was not restored. It may be corrupted.');
      }
    }

    let backupData: unknown;
    try {
      backupData = JSON.parse(jsonStr);
    } catch {
      return fail('This backup is damaged (not valid JSON), so it was not restored.');
    }
    if (!isBackupShape(backupData)) return fail('This backup is not a valid Apollo backup.');
    if (backupData.metadata.appName !== 'Apollo Running') return fail('This backup is not from Apollo Running.');

    const snapshot = restorableEntries(backupData.data as Record<string, unknown>);

    // Safety backup first, so the restore can be undone.
    const safety = await createBackup('manual', { note: 'Before restore' });
    if (!safety) {
      return fail(`Couldn\u2019t create a safety backup first, so nothing was changed. ${getLastBackupError()?.message ?? ''}`.trim());
    }

    const removedKeys = persistence
      .keys()
      .filter((key) => !isPreservedOnRestore(key) && !(key in snapshot));
    persistence.bulkSet(snapshot);
    for (const key of removedKeys) persistence.removeItem(key);
    emitBackupsChanged();

    console.info(`[Apollo Backup] Restored from backup ${backupId} (${Object.keys(snapshot).length} keys, removed ${removedKeys.length})`);
    return { success: true, restoredKeys: Object.keys(snapshot).length, removedKeys, safetyBackupId: safety.id };
  } catch (err) {
    console.error('[Apollo Backup] Restore failed:', err);
    return fail(`Restore failed: ${errorMessage(err)}`);
  }
}

/**
 * Restore data from a specific backup. Returns true on success. Use
 * `restoreFromBackupDetailed` to show the reason when it fails.
 */
export async function restoreFromBackup(backupId: string): Promise<boolean> {
  return (await restoreFromBackupDetailed(backupId)).success;
}

/**
 * Verify the integrity of the most recent backup.
 * Returns true if the checksum matches.
 */
export async function verifyLatestBackup(): Promise<boolean> {
  const registry = getBackupRegistry();
  if (registry.length === 0) return false;

  const latest = registry[registry.length - 1];
  const storageKey = `${BACKUP_DATA_PREFIX}${latest.id}`;
  const jsonStr = persistence.getItem(storageKey);
  const passed = !!jsonStr && (await sha256(jsonStr)) === latest.checksum;

  // Update record
  latest.verified = passed;
  saveBackupRegistry(registry);

  persistence.setItem(LAST_INTEGRITY_CHECK_KEY, new Date().toISOString());

  return passed;
}

/**
 * Verify the integrity of ALL stored data by checking each major data key.
 * Returns a list of keys that failed validation (empty JSON parse).
 */
export function verifyDataIntegrity(): string[] {
  const corruptKeys: string[] = [];
  const keys = persistence.keys();

  for (const key of keys) {
    // Skip non-JSON keys
    if (key === 'apollo_distance_unit' || key === 'apollo_welcome_completed') continue;
    if (key.startsWith(BACKUP_DATA_PREFIX)) continue; // Don't check backup data during integrity scan

    const raw = persistence.getItem(key);
    if (!raw) continue;

    // Check if JSON keys actually parse
    try {
      JSON.parse(raw);
    } catch {
      corruptKeys.push(key);
    }
  }

  return corruptKeys;
}

// ── Legacy compaction (V1/V4 one-time migration) ──────────────────────────────

function createdAtFromId(id: string): string {
  const ms = Number(/^backup_(\d+)_/.exec(id)?.[1]);
  return new Date(Number.isFinite(ms) && ms > 0 ? ms : Date.now()).toISOString();
}

/** Result of compactLegacyBackups. */
export interface CompactionResult {
  /** Backups rewritten without nested backups/credentials/caches. */
  compacted: number;
  /** Corrupt or unreadable backups deleted. */
  deleted: number;
  /** Backups kept (after pruning). */
  kept: number;
}

/**
 * One-time 1.0.6 migration: rewrite every stored backup without nested
 * backups, credentials, caches and device state, recompute its checksum, and
 * rebuild the registry from the payloads actually stored (backups orphaned by
 * the 1.0.5 restore bug are listed again). Payloads that can't be parsed, or
 * whose checksum doesn't match, are deleted. Then prunes to `maxBackups`.
 * Runs once (flag in `apollo_migrations`) unless `force` is set.
 */
export async function compactLegacyBackups(opts: { force?: boolean } = {}): Promise<CompactionResult> {
  const none: CompactionResult = { compacted: 0, deleted: 0, kept: getBackupRegistry().length };
  if (!opts.force && hasMigrationRun(BACKUP_COMPACTION_MIGRATION_ID)) return none;
  if (isStorageDegraded()) return none; // try again on a healthy launch

  const byId = new Map(getBackupRegistry().map((r) => [r.id, r]));
  const payloadIds = persistence
    .keys()
    .filter((k) => k.startsWith(BACKUP_DATA_PREFIX))
    .map((k) => k.slice(BACKUP_DATA_PREFIX.length));

  const next: BackupRecord[] = [];
  let compacted = 0;
  let deleted = 0;
  for (const id of payloadIds) {
    const key = `${BACKUP_DATA_PREFIX}${id}`;
    const raw = persistence.getItem(key);
    const existing = byId.get(id);
    let parsed: unknown = null;
    try {
      parsed = raw ? JSON.parse(raw) : null;
      if (raw && existing && (await sha256(raw)) !== existing.checksum) parsed = null; // corrupt
    } catch {
      parsed = null; // unreadable (corrupt, or too large to parse)
    }
    if (!raw || !isBackupShape(parsed)) {
      persistence.removeItem(key);
      deleted++;
      continue;
    }

    const data = restorableEntries(parsed.data as Record<string, unknown>);
    const stripped = Object.keys(parsed.data).length - Object.keys(data).length;
    let record: BackupRecord;
    if (stripped === 0 && existing) {
      record = existing;
    } else {
      const compact: BackupData = {
        metadata: { ...parsed.metadata, keyCount: Object.keys(data).length },
        data,
      };
      const json = JSON.stringify(compact);
      persistence.setItem(key, json);
      record = {
        id,
        createdAt: existing?.createdAt
          ?? (typeof parsed.metadata.exportDate === 'string' ? parsed.metadata.exportDate : createdAtFromId(id)),
        checksum: await sha256(json),
        keyCount: Object.keys(data).length,
        sizeBytes: utf8Length(json),
        trigger: existing?.trigger ?? 'manual',
        verified: true,
        ...(existing?.note ? { note: existing.note } : {}),
      };
      if (stripped > 0) compacted++;
    }
    next.push(record);
  }

  next.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  saveBackupRegistry(next);
  await pruneOldBackups();
  markMigrationRun(BACKUP_COMPACTION_MIGRATION_ID);
  emitBackupsChanged();
  const kept = getBackupRegistry().length;
  if (compacted || deleted) {
    console.info(`[Apollo Backup] Compacted ${compacted} legacy backup(s), deleted ${deleted} unreadable one(s), keeping ${kept}`);
  }
  return { compacted, deleted, kept };
}

// ── Auto-Backup ───────────────────────────────────────────────────────────────

/** Check whether it's time for an automatic backup. */
export function isAutoBackupDue(): boolean {
  const config = getBackupConfig();
  if (!config.autoBackupEnabled) return false;

  const registry = getBackupRegistry();
  if (registry.length === 0) return true; // Never backed up

  const latest = registry[registry.length - 1];
  const hoursSinceLastBackup =
    (Date.now() - new Date(latest.createdAt).getTime()) / (1000 * 60 * 60);

  return hoursSinceLastBackup >= config.intervalHours;
}

let autoBackupInFlight: Promise<BackupRecord | null> | null = null;

/**
 * Run the automatic backup if it's due (and there is data to protect and
 * storage is healthy). Concurrent calls share one run.
 * Called at startup, on an interval and when the window becomes visible.
 */
export async function runAutoBackupIfDue(): Promise<BackupRecord | null> {
  if (autoBackupInFlight) return autoBackupInFlight;
  if (!isAutoBackupDue() || isStorageDegraded()) return null;
  if (exportAllData({ purpose: 'backup' }).metadata.keyCount === 0) return null; // nothing to protect yet
  autoBackupInFlight = createBackup('auto').finally(() => {
    autoBackupInFlight = null;
  });
  return autoBackupInFlight;
}

let stopScheduler: (() => void) | null = null;

/**
 * Keep automatic backups running while the app is open: check every 30 min
 * and whenever the window becomes visible again (timers pause during sleep).
 * Idempotent; returns a function that stops the scheduler.
 */
export function startAutoBackupScheduler(intervalMs: number = AUTO_BACKUP_CHECK_MS): () => void {
  if (stopScheduler) return stopScheduler;
  const tick = () => { void runAutoBackupIfDue(); };
  const timer = setInterval(tick, intervalMs);
  const onVisible = () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'visible') tick();
  };
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible);
  stopScheduler = () => {
    clearInterval(timer);
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible);
    stopScheduler = null;
  };
  return stopScheduler;
}

/**
 * Startup routine (main.tsx, after persistence is ready): compact legacy
 * backups once, verify integrity, back up if due, verify the latest backup,
 * then keep the auto-backup scheduler running. Never rejects.
 */
export async function initBackupSystem(opts: { schedule?: boolean } = {}): Promise<void> {
  try {
    await compactLegacyBackups();
  } catch (err) {
    console.warn('[Apollo Backup] Legacy backup compaction failed:', err);
  }

  const config = getBackupConfig();
  if (config.verifyOnStartup) {
    const corruptKeys = verifyDataIntegrity();
    if (corruptKeys.length > 0) {
      console.warn(`[Apollo Backup] Found ${corruptKeys.length} corrupt data key(s):`, corruptKeys);
      // If we have a verified backup, we could auto-restore, but for safety
      // we just log and let the user decide
    }
  }

  try {
    const record = await runAutoBackupIfDue();
    if (record) console.info('[Apollo Backup] Startup auto-backup created');
    if (getBackupRegistry().length > 0) await verifyLatestBackup();
  } catch (err) {
    console.warn('[Apollo Backup] Startup backup check failed:', err);
  }

  if (opts.schedule !== false) startAutoBackupScheduler();
}

// ── Pruning ───────────────────────────────────────────────────────────────────

/** Remove old backups beyond the configured maximum. */
async function pruneOldBackups(): Promise<void> {
  const config = getBackupConfig();
  const registry = getBackupRegistry();

  if (registry.length <= config.maxBackups) return;

  // Sort by creation date (oldest first)
  registry.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  // Remove oldest until we're at the limit
  const toRemove = registry.splice(0, registry.length - config.maxBackups);
  for (const record of toRemove) {
    persistence.removeItem(`${BACKUP_DATA_PREFIX}${record.id}`);
  }

  saveBackupRegistry(registry);
  console.info(`[Apollo Backup] Pruned ${toRemove.length} old backup(s), keeping ${registry.length}`);
}

// ── Health Monitoring ─────────────────────────────────────────────────────────

/** Get the current backup health status (honest copy; refresh after each action). */
export function getBackupHealth(): BackupHealth {
  const registry = getBackupRegistry();
  const config = getBackupConfig();
  const lastError = getLastBackupError();

  if (registry.length === 0) {
    let status: BackupHealth['status'] = 'warning';
    let message: string;
    if (lastError) {
      status = 'critical';
      message = `The last backup attempt failed: ${lastError.message}`;
    } else if (config.autoBackupEnabled) {
      message = 'No backups yet. Apollo backs up your data automatically every '
        + `${config.intervalHours} hours while it is open, once there is data to protect. You can also create one now.`;
    } else {
      message = 'No backups. Automatic backups are off — turn them on or create a backup now.';
    }
    return {
      lastBackupAt: null,
      daysSinceBackup: Infinity,
      backupCount: 0,
      lastCheckPassed: false,
      status,
      message,
    };
  }

  const latest = registry[registry.length - 1];
  const daysSinceBackup =
    (Date.now() - new Date(latest.createdAt).getTime()) / (1000 * 60 * 60 * 24);

  let status: BackupHealth['status'] = 'healthy';
  let message: string;

  if (!latest.verified) {
    status = 'critical';
    message = 'The latest backup failed its integrity check. Create a new backup now.';
  } else if (lastError && lastError.at > latest.createdAt) {
    status = 'warning';
    message = `The last backup attempt failed: ${lastError.message}`;
  } else if (daysSinceBackup > 7) {
    status = 'critical';
    message = `Last backup was ${Math.floor(daysSinceBackup)} days ago. Your recent data isn't protected.`;
  } else if (daysSinceBackup > 3) {
    status = 'warning';
    message = `Last backup was ${Math.floor(daysSinceBackup)} days ago.`;
  } else {
    message = `Last backup: ${new Date(latest.createdAt).toLocaleDateString()} (${latest.keyCount} items, ${formatBytes(latest.sizeBytes)}), integrity verified. Backups are stored on this device; download an export to keep a copy elsewhere.`;
  }

  return {
    lastBackupAt: latest.createdAt,
    daysSinceBackup: Math.round(daysSinceBackup * 10) / 10,
    backupCount: registry.length,
    lastCheckPassed: latest.verified,
    status,
    message,
  };
}

// ── Download / File Export ─────────────────────────────────────────────────────

function triggerDownload(content: string, filename: string): void {
  const blob = new Blob([content], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function dateStamp(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/**
 * Export a specific backup as a downloadable JSON file.
 * The file embeds the backup's checksum, so Import verifies it.
 */
export function downloadBackup(backupId: string): boolean {
  const storageKey = `${BACKUP_DATA_PREFIX}${backupId}`;
  const jsonStr = persistence.getItem(storageKey);
  if (!jsonStr) return false;

  const registry = getBackupRegistry();
  const record = registry.find((r) => r.id === backupId);

  let content = jsonStr;
  try {
    const parsed: unknown = JSON.parse(jsonStr);
    if (record && isBackupShape(parsed)) {
      // The checksum was computed over this exact compact JSON; Import strips it again.
      content = JSON.stringify({ ...parsed, metadata: { ...parsed.metadata, checksum: record.checksum } }, null, 2);
    }
  } catch { /* download as stored */ }

  triggerDownload(content, `apollo-backup-${dateStamp(new Date(record?.createdAt ?? Date.now()))}.json`);
  return true;
}

/**
 * Download the current live data as a backup file (without storing in registry).
 * The checksum covers the canonical compact JSON of `{ metadata, data }`.
 */
export async function downloadCurrentData(): Promise<void> {
  const backupData = exportAllData({ purpose: 'export' });
  const checksum = await sha256(JSON.stringify(backupData));

  // Embed checksum in the export for verification on import (appended last,
  // so removing it restores the exact JSON that was hashed).
  const exportWithChecksum = {
    ...backupData,
    metadata: {
      ...backupData.metadata,
      checksum,
    },
  };

  triggerDownload(JSON.stringify(exportWithChecksum, null, 2), `apollo-export-${dateStamp(new Date())}.json`);
}

// ── Import ────────────────────────────────────────────────────────────────────

/** Known value shapes, checked on import (others only need to be well-formed). */
const KNOWN_SHAPES: Record<string, (value: unknown) => boolean> = {
  apollo_activities_store: (v) => Array.isArray(v)
    && v.every((a) => !!a && typeof a === 'object' && typeof (a as { id?: unknown }).id === 'number'),
  apollo_app_prefs: (v) => !!v && typeof v === 'object' && !Array.isArray(v),
  apollo_athlete_profile: (v) => !!v && typeof v === 'object' && !Array.isArray(v),
};

/**
 * Validate one imported value: JSON-looking values must parse (and match the
 * known shape for that key); a few modules store short plain strings
 * (timestamps, units), which are accepted up to 1,024 characters.
 * Returns the reason it's invalid, or null when it's fine. No size cap.
 */
function validateImportValue(key: string, value: unknown): string | null {
  if (typeof value !== 'string') return 'not a text value';
  const trimmed = value.trimStart();
  const looksJson = trimmed.startsWith('{') || trimmed.startsWith('[') || trimmed.startsWith('"');
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    if (looksJson || value.length > MAX_PLAIN_VALUE_CHARS || KNOWN_SHAPES[key]) return 'damaged (not valid JSON)';
    return null; // short plain string (timestamp, unit…)
  }
  const shape = KNOWN_SHAPES[key];
  if (shape && !shape(parsed)) return 'unexpected format';
  return null;
}

function isGzip(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

async function gunzipToText(bytes: Uint8Array): Promise<string> {
  const ds = new DecompressionStream('gzip');
  const writer = ds.writable.getWriter();
  void writer.write(bytes as unknown as BufferSource).then(() => writer.close()).catch(() => { /* surfaced by the reader */ });
  const reader = ds.readable.getReader();
  const decoder = new TextDecoder();
  const parts: string[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(decoder.decode(value as Uint8Array, { stream: true }));
  }
  parts.push(decoder.decode());
  return parts.join('');
}

/** Read an import file as text, transparently un-gzipping .json.gz files. */
async function readImportText(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (isGzip(bytes)) {
    if (typeof DecompressionStream === 'undefined') {
      throw new Error('This app version can\u2019t open compressed (.gz) backups here. Unzip the file and import the .json file.');
    }
    try {
      return await gunzipToText(bytes);
    } catch {
      throw new Error('The compressed file is damaged and could not be opened.');
    }
  }
  return new TextDecoder().decode(bytes);
}

/** Checksums written by Apollo: canonical compact JSON (1.0.6+) or pretty JSON (≤ 1.0.5). */
async function checksumMatches(expected: string, original: { metadata: Record<string, unknown>; data: unknown }): Promise<boolean> {
  if ((await sha256(JSON.stringify(original))) === expected) return true;
  return (await sha256(JSON.stringify(original, null, 2))) === expected;
}

function rejectImport(message: string): ImportResult {
  return { success: false, message, importedKeys: [], skippedKeys: [], ignoredKeys: [], needsReload: false };
}

/**
 * Import data from an exported file (.json, or .json.gz), verifying the
 * embedded checksum if present (compact or 1.0.5 pretty). Each value is
 * validated; invalid ones are listed in `skippedKeys` and make the result
 * `success: false` (valid ones are still imported). Credentials, old backups,
 * caches and device state in the file are ignored. A safety backup is taken
 * first. Existing keys not in the file are kept (merge).
 */
export async function importFromFile(file: File): Promise<ImportResult> {
  try {
    if (file.size > MAX_IMPORT_FILE_BYTES) {
      return rejectImport(`Import file is too large (${formatBytes(file.size)}). Maximum supported size is ${formatBytes(MAX_IMPORT_FILE_BYTES)}.`);
    }
    if (isStorageDegraded()) {
      return rejectImport('Storage is unavailable right now, so nothing was imported. Restart Apollo and try again.');
    }

    let text: string;
    try {
      text = await readImportText(file);
    } catch (err) {
      return rejectImport(errorMessage(err));
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return rejectImport('Invalid JSON file.');
    }

    const data = parsed as Record<string, unknown>;
    if (!data || typeof data !== 'object' || !data.metadata || !data.data || typeof data.metadata !== 'object' || typeof data.data !== 'object') {
      return rejectImport('Not an Apollo backup file.');
    }

    const metadata = data.metadata as Record<string, unknown>;
    if (metadata.appName !== 'Apollo Running') {
      return rejectImport('This file is not from Apollo Running.');
    }

    if (typeof metadata.keyCount !== 'number' || !Number.isFinite(metadata.keyCount) || metadata.keyCount < 0) {
      return rejectImport('Backup metadata is invalid (keyCount missing or malformed).');
    }

    const importData = data.data as Record<string, unknown>;
    const sourceEntries = Object.entries(importData);
    if (metadata.keyCount !== sourceEntries.length) {
      return rejectImport('Backup metadata key count does not match payload. File may be corrupted or tampered.');
    }

    // Verify checksum if embedded
    if (metadata.checksum !== undefined) {
      if (typeof metadata.checksum !== 'string') {
        return rejectImport('Checksum verification failed — the file may have been modified or corrupted.');
      }
      const originalMetadata = { ...metadata };
      delete originalMetadata.checksum;
      if (!(await checksumMatches(metadata.checksum, { metadata: originalMetadata, data: data.data }))) {
        return rejectImport('Checksum verification failed — the file may have been modified or corrupted.');
      }
    }

    // Validate and select keys
    const allowed: Record<string, string> = {};
    const skippedKeys: SkippedKey[] = [];
    const ignoredKeys: string[] = [];
    for (const [key, value] of sourceEntries) {
      // Never import credentials (they could be attacker-controlled), old
      // backups (1.0.5 exports embedded them), caches or device state.
      if (isCredentialKey(key) || !key.startsWith('apollo_') || key.length > 128 || isExcludedFromExport(key)) {
        ignoredKeys.push(key);
        continue;
      }
      const problem = validateImportValue(key, value);
      if (problem) {
        skippedKeys.push({ key, reason: problem });
        continue;
      }
      allowed[key] = value as string;
    }

    const importedKeys = Object.keys(allowed);
    if (importedKeys.length === 0) {
      return {
        ...rejectImport(skippedKeys.length
          ? `Nothing was imported: ${describeSkipped(skippedKeys)}.`
          : 'No valid Apollo data found in the file.'),
        skippedKeys,
        ignoredKeys,
      };
    }

    // Create a safety backup before importing
    const safety = await createBackup('manual', { note: 'Before import' });
    if (!safety) {
      return rejectImport(`Couldn\u2019t create a safety backup first, so nothing was imported. ${getLastBackupError()?.message ?? ''}`.trim());
    }

    persistence.bulkSet(allowed);

    const count = `${importedKeys.length} ${importedKeys.length === 1 ? 'item' : 'items'}`;
    const message = skippedKeys.length
      ? `Imported ${count}, but ${skippedKeys.length} couldn\u2019t be imported: ${describeSkipped(skippedKeys)}. A safety backup of your previous data was created.`
      : `Imported ${count}. A safety backup of your previous data was created.`;
    return { success: skippedKeys.length === 0, message, importedKeys, skippedKeys, ignoredKeys, needsReload: true };
  } catch (err) {
    return rejectImport(`Import failed: ${errorMessage(err)}`);
  }
}

function describeSkipped(skipped: SkippedKey[]): string {
  const shown = skipped.slice(0, 5).map((s) => `${s.key} (${s.reason})`).join(', ');
  return skipped.length > 5 ? `${shown} and ${skipped.length - 5} more` : shown;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function isCredentialKey(key: string): boolean {
  return CREDENTIAL_KEYS.has(key);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export { formatBytes };
