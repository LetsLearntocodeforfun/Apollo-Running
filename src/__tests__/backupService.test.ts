/**
 * backupService.test.ts — Tests for the Automated Backup & Data Integrity Engine.
 *
 * Covers: backup creation with checksums, restore with verification, backup
 * registry management, auto-backup scheduling, health monitoring, pruning,
 * data integrity verification, and configuration.
 */

import { describe, it, expect } from 'vitest';
import {
  getBackupConfig,
  setBackupConfig,
  getBackupRecords,
  createBackup,
  restoreFromBackup,
  verifyLatestBackup,
  verifyDataIntegrity,
  isAutoBackupDue,
  getBackupHealth,
  importFromFile,
  formatBytes,
} from '@/services/backupService';
import { persistence } from '@/services/db/persistence';

// ── Helpers ───────────────────────────────────────────────────

/** Seed some Apollo data so the backup has content. */
function seedTestData(): void {
  persistence.setItem('apollo_activities', JSON.stringify([{ id: 1, name: 'Morning Run' }]));
  persistence.setItem('apollo_settings', JSON.stringify({ theme: 'dark' }));
  persistence.setItem('apollo_plan', JSON.stringify({ id: 'half', name: 'Half Marathon' }));
}

// ── Configuration ─────────────────────────────────────────────

describe('Backup Configuration', () => {
  it('returns default config when nothing is stored', () => {
    const config = getBackupConfig();
    expect(config.autoBackupEnabled).toBe(true);
    expect(config.intervalHours).toBe(24);
    expect(config.maxBackups).toBe(10);
    expect(config.verifyOnStartup).toBe(true);
  });

  it('persists configuration changes', () => {
    setBackupConfig({ intervalHours: 12, maxBackups: 5 });
    const config = getBackupConfig();
    expect(config.intervalHours).toBe(12);
    expect(config.maxBackups).toBe(5);
    // Defaults preserved
    expect(config.autoBackupEnabled).toBe(true);
  });

  it('does not clobber unspecified fields', () => {
    setBackupConfig({ autoBackupEnabled: false });
    setBackupConfig({ intervalHours: 6 });
    const config = getBackupConfig();
    expect(config.autoBackupEnabled).toBe(false);
    expect(config.intervalHours).toBe(6);
  });
});

// ── Backup Creation ───────────────────────────────────────────

describe('createBackup', () => {
  it('creates a backup and stores it in the registry', async () => {
    seedTestData();
    const record = await createBackup('manual');
    expect(record).not.toBeNull();
    expect(record!.trigger).toBe('manual');
    expect(record!.verified).toBe(true);
    expect(record!.checksum).toHaveLength(64); // SHA-256 hex
    expect(record!.keyCount).toBeGreaterThanOrEqual(1);
    expect(record!.sizeBytes).toBeGreaterThan(0);
    expect(record!.id).toMatch(/^backup_/);

    const records = getBackupRecords();
    expect(records.length).toBe(1);
    expect(records[0].id).toBe(record!.id);
  });

  it('creates multiple backups', async () => {
    seedTestData();
    await createBackup('manual');
    await createBackup('auto');
    const records = getBackupRecords();
    expect(records.length).toBe(2);
    expect(records[0].trigger).toBe('manual');
    expect(records[1].trigger).toBe('auto');
  });

  it('backup data can be read back', async () => {
    seedTestData();
    const record = await createBackup('manual');
    expect(record).not.toBeNull();
    const raw = persistence.getItem(`apollo_backup_data_${record!.id}`);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!);
    expect(parsed.metadata.appName).toBe('Apollo Running');
    expect(parsed.data).toBeDefined();
  });
});

// ── Restore ───────────────────────────────────────────────────

describe('restoreFromBackup', () => {
  it('restores data from a valid backup', async () => {
    seedTestData();
    const record = await createBackup('manual');
    expect(record).not.toBeNull();

    // Clear data
    persistence.removeItem('apollo_activities');
    persistence.removeItem('apollo_settings');
    expect(persistence.getItem('apollo_activities')).toBeNull();

    // Restore
    const result = await restoreFromBackup(record!.id);
    expect(result).toBe(true);
    expect(persistence.getItem('apollo_activities')).not.toBeNull();
  });

  it('returns false for non-existent backup', async () => {
    const result = await restoreFromBackup('nonexistent');
    expect(result).toBe(false);
  });
});

// ── Integrity Verification ────────────────────────────────────

describe('verifyLatestBackup', () => {
  it('returns true for an untampered backup', async () => {
    seedTestData();
    await createBackup('manual');
    const result = await verifyLatestBackup();
    expect(result).toBe(true);
  });

  it('returns false when no backups exist', async () => {
    const result = await verifyLatestBackup();
    expect(result).toBe(false);
  });

  it('detects tampered backup data', async () => {
    seedTestData();
    const record = await createBackup('manual');
    expect(record).not.toBeNull();

    // Tamper with the stored backup data
    const key = `apollo_backup_data_${record!.id}`;
    persistence.setItem(key, '{"metadata":{},"data":{}}');

    const result = await verifyLatestBackup();
    expect(result).toBe(false);
  });
});

describe('verifyDataIntegrity', () => {
  it('returns empty array for valid data', () => {
    seedTestData();
    const corruptKeys = verifyDataIntegrity();
    expect(corruptKeys).toEqual([]);
  });

  it('detects corrupt JSON keys', () => {
    persistence.setItem('apollo_bad_key', 'not valid JSON {{{');
    const corruptKeys = verifyDataIntegrity();
    expect(corruptKeys).toContain('apollo_bad_key');
  });

  it('ignores non-JSON keys like distance unit', () => {
    persistence.setItem('apollo_distance_unit', 'mi');
    const corruptKeys = verifyDataIntegrity();
    expect(corruptKeys).not.toContain('apollo_distance_unit');
  });
});

// ── Auto-Backup Scheduling ────────────────────────────────────

describe('isAutoBackupDue', () => {
  it('returns true when no backups exist', () => {
    setBackupConfig({ autoBackupEnabled: true });
    expect(isAutoBackupDue()).toBe(true);
  });

  it('returns false when auto-backup is disabled', () => {
    setBackupConfig({ autoBackupEnabled: false });
    expect(isAutoBackupDue()).toBe(false);
  });

  it('returns false right after a backup', async () => {
    seedTestData();
    setBackupConfig({ autoBackupEnabled: true, intervalHours: 24 });
    await createBackup('auto');
    expect(isAutoBackupDue()).toBe(false);
  });
});

// ── Health Monitoring ─────────────────────────────────────────

describe('getBackupHealth', () => {
  it('returns critical when no backups exist and auto-backup enabled', () => {
    setBackupConfig({ autoBackupEnabled: true });
    const health = getBackupHealth();
    expect(health.status).toBe('critical');
    expect(health.backupCount).toBe(0);
    expect(health.lastBackupAt).toBeNull();
  });

  it('returns warning when no backups and auto-backup disabled', () => {
    setBackupConfig({ autoBackupEnabled: false });
    const health = getBackupHealth();
    expect(health.status).toBe('warning');
  });

  it('returns healthy right after a verified backup', async () => {
    seedTestData();
    await createBackup('manual');
    const health = getBackupHealth();
    expect(health.status).toBe('healthy');
    expect(health.backupCount).toBe(1);
    expect(health.lastCheckPassed).toBe(true);
    expect(health.daysSinceBackup).toBeLessThan(1);
  });
});

// ── Import ────────────────────────────────────────────────────

describe('importFromFile', () => {
  it('rejects non-JSON files', async () => {
    const file = new File(['not json'], 'bad.txt', { type: 'text/plain' });
    const result = await importFromFile(file);
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/Invalid JSON/i);
  });

  it('rejects files without Apollo metadata', async () => {
    const file = new File([JSON.stringify({ foo: 'bar' })], 'bad.json', { type: 'application/json' });
    const result = await importFromFile(file);
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/not an Apollo/i);
  });

  it('rejects files from a different app', async () => {
    const file = new File(
      [JSON.stringify({ metadata: { appName: 'Other App' }, data: {} })],
      'other.json',
      { type: 'application/json' },
    );
    const result = await importFromFile(file);
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/not from Apollo/i);
  });

  it('imports valid Apollo backup data', async () => {
    const exportData = {
      metadata: { appName: 'Apollo Running', keyCount: 1 },
      data: { apollo_test_import: JSON.stringify({ imported: true }) },
    };
    const file = new File([JSON.stringify(exportData)], 'backup.json', { type: 'application/json' });
    const result = await importFromFile(file);
    expect(result.success).toBe(true);
    expect(persistence.getItem('apollo_test_import')).not.toBeNull();
  });
});

// ── Helpers ───────────────────────────────────────────────────

describe('formatBytes', () => {
  it('formats bytes', () => {
    expect(formatBytes(500)).toBe('500 B');
  });

  it('formats kilobytes', () => {
    expect(formatBytes(2048)).toBe('2.0 KB');
  });

  it('formats megabytes', () => {
    expect(formatBytes(1048576)).toBe('1.0 MB');
  });
});
