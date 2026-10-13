/**
 * dataSafetyBackups.test.ts — v1.0.7 backups (mocked persistence + in-memory
 * backups table from the global setup):
 * - PX-03: a backup is "verified" only after its payload committed and read back.
 * - PX-04: payloads live in the backups table (not in memory at launch);
 *   legacy payloads in the persistence layer are moved there; delete-all clears it.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { persistence } from '@/services/db/persistence';
import { db } from '@/services/db/apolloDB';
import { getBackupPayload, listBackupPayloadIds, migrateLegacyBackupPayloads } from '@/services/db/backupStore';
import {
  createBackup,
  getBackupRecords,
  getLastBackupError,
  initBackupSystem,
  restoreFromBackup,
} from '@/services/backupService';
import { deleteAllLocalData } from '@/services/dataManager';
import { clearStorageDegraded, markStorageDegraded } from '@/services/storageHealth';

afterEach(() => {
  vi.restoreAllMocks();
  clearStorageDegraded();
});

describe('PX-03: backups are verified only after the write commits', () => {
  it('a failed payload write leaves no registry entry and reports why', async () => {
    persistence.setItem('apollo_plan', '{"id":"half"}');
    vi.spyOn(db.backups, 'put').mockRejectedValueOnce(new Error('QuotaExceededError'));
    expect(await createBackup('manual')).toBeNull();
    expect(getBackupRecords()).toEqual([]);
    expect(getLastBackupError()?.message).toMatch(/could not be stored.*QuotaExceededError/);
  });

  it('a read-back that does not match is not marked verified (and the payload is dropped)', async () => {
    persistence.setItem('apollo_plan', '{"id":"half"}');
    vi.spyOn(db.backups, 'get').mockResolvedValueOnce({ id: 'x', json: '{"truncated', updatedAt: 0 });
    expect(await createBackup('manual')).toBeNull();
    expect(getBackupRecords()).toEqual([]);
    expect(await listBackupPayloadIds()).toEqual([]);
  });

  it('verified is set only after the payload is readable', async () => {
    persistence.setItem('apollo_plan', '{"id":"half"}');
    const order: string[] = [];
    // The setup mock's table (plain promises, not Dexie's PromiseExtended).
    const table = db.backups as unknown as {
      put: (row: unknown) => Promise<unknown>;
      get: (id: string) => Promise<unknown>;
    };
    const realPut = table.put.bind(table);
    vi.spyOn(table, 'put').mockImplementation(async (row) => {
      order.push('put');
      return realPut(row);
    });
    const realGet = table.get.bind(table);
    vi.spyOn(table, 'get').mockImplementation(async (id) => {
      order.push('get');
      return realGet(id);
    });
    const record = await createBackup('manual');
    expect(record?.verified).toBe(true);
    expect(order).toEqual(['put', 'get']);
  });
});

describe('PX-04: backups table', () => {
  it('stores payloads outside the persistence layer and restores from there', async () => {
    persistence.setItem('apollo_plan', '{"id":"half"}');
    const record = await createBackup('manual');
    expect(record).not.toBeNull();
    expect(persistence.keys().some((k) => k.startsWith('apollo_backup_data_'))).toBe(false);
    expect(await getBackupPayload(record!.id)).toMatch(/"apollo_plan"/);

    persistence.setItem('apollo_plan', '{"id":"full"}');
    expect(await restoreFromBackup(record!.id)).toBe(true);
    expect(persistence.getItem('apollo_plan')).toBe('{"id":"half"}');
  });

  it('moves legacy persistence payloads into the table and removes them from persistence', async () => {
    persistence.setItem('apollo_backup_data_backup_1_a', '{"metadata":{},"data":{}}');
    persistence.setItem('apollo_backup_data_backup_2_b', '{"metadata":{},"data":{"x":"1"}}');
    expect(await migrateLegacyBackupPayloads()).toBe(2);
    expect(persistence.keys().filter((k) => k.startsWith('apollo_backup_data_'))).toEqual([]);
    expect((await listBackupPayloadIds()).sort()).toEqual(['backup_1_a', 'backup_2_b']);
    expect(await getBackupPayload('backup_2_b')).toBe('{"metadata":{},"data":{"x":"1"}}');
    // Idempotent.
    expect(await migrateLegacyBackupPayloads()).toBe(0);
  });

  it('keeps the legacy copy when the move fails', async () => {
    persistence.setItem('apollo_backup_data_backup_1_a', '{"metadata":{},"data":{}}');
    vi.spyOn(db.backups, 'put').mockRejectedValueOnce(new Error('disk full'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await migrateLegacyBackupPayloads()).toBe(0);
    expect(persistence.getItem('apollo_backup_data_backup_1_a')).not.toBeNull();
  });

  it('does not move anything while storage is degraded', async () => {
    persistence.setItem('apollo_backup_data_backup_1_a', '{"metadata":{},"data":{}}');
    markStorageDegraded('test');
    expect(await migrateLegacyBackupPayloads()).toBe(0);
    expect(await listBackupPayloadIds()).toEqual([]);
  });

  it('initBackupSystem moves legacy payloads on every launch (even after the 1.0.6 compaction ran)', async () => {
    persistence.setItem('apollo_migrations', JSON.stringify({ 'backup-compaction-1.0.6': '2026-01-01T00:00:00Z' }));
    persistence.setItem('apollo_backup_data_backup_1_a', '{"metadata":{},"data":{}}');
    await initBackupSystem({ schedule: false });
    expect(persistence.getItem('apollo_backup_data_backup_1_a')).toBeNull();
    expect(await listBackupPayloadIds()).toContain('backup_1_a');
  });

  it('"Delete all my data" also deletes the backup payloads', async () => {
    persistence.setItem('apollo_plan', '{"id":"half"}');
    await createBackup('manual');
    expect((await listBackupPayloadIds()).length).toBe(1);
    await deleteAllLocalData();
    expect(await listBackupPayloadIds()).toEqual([]);
  });
});
