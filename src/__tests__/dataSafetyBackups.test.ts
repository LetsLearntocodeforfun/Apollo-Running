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
  syncSnapshotToDesktopFolder,
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

describe('v1.0.9: "Delete all my data" and the desktop synced backup folder', () => {
  type FolderApi = NonNullable<NonNullable<Window['electronAPI']>['backupFolder']>;
  const withFolderApi = (clearFolder: FolderApi['clearFolder']) => {
    const original = window.electronAPI;
    // A desktop build: the keychain store removes credentials, and the synced folder can be disconnected.
    const secureStorage = {
      set: vi.fn(async () => ({ success: true })),
      get: vi.fn(async () => null),
      remove: vi.fn(async () => ({ success: true })),
      isAvailable: vi.fn(async () => true),
    };
    (window as { electronAPI?: unknown }).electronAPI = {
      ...(original ?? {}),
      secureStorage,
      backupFolder: { clearFolder },
    };
    return () => {
      (window as { electronAPI?: unknown }).electronAPI = original;
    };
  };

  it('disconnects the folder (Apollo forgets it; the files in it are left alone)', async () => {
    const clearFolder = vi.fn(() => Promise.resolve({ folderPath: null } as unknown as DesktopBackupFolderState));
    const restore = withFolderApi(clearFolder);
    try {
      persistence.setItem('apollo_plan', '{"id":"half"}');
      await deleteAllLocalData();
      expect(clearFolder).toHaveBeenCalledTimes(1);
      expect(persistence.getItem('apollo_plan')).toBeNull();
    } finally {
      restore();
    }
  });

  it('still deletes everything if the folder cannot be disconnected', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const restore = withFolderApi(vi.fn(() => Promise.reject(new Error('main process unavailable'))));
    try {
      persistence.setItem('apollo_plan', '{"id":"half"}');
      await expect(deleteAllLocalData()).resolves.toBeUndefined();
      expect(persistence.getItem('apollo_plan')).toBeNull();
      expect(warn).toHaveBeenCalled();
    } finally {
      restore();
    }
  });
});

describe('v1.0.9: desktop synced-folder snapshots from the renderer', () => {
  const folderState = {
    folderPath: '/Users/ana/Backups/Apollo',
    maxFiles: 10,
    lastSyncedAt: null,
    lastFileName: null,
    lastError: null,
    folderReachable: true,
  } as DesktopBackupFolderState;
  const withFolder = () => {
    const writeSnapshot = vi.fn(async (_json: string, _max: number) => ({ ok: true, state: folderState }));
    const original = window.electronAPI;
    (window as { electronAPI?: unknown }).electronAPI = {
      ...(original ?? {}),
      backupFolder: { getState: vi.fn(async () => folderState), writeSnapshot },
    };
    return {
      writeSnapshot,
      restore: () => {
        (window as { electronAPI?: unknown }).electronAPI = original;
      },
    };
  };

  it('an empty profile is reported as "nothing to back up yet", not sent to the desktop app', async () => {
    persistence.clear();
    const { writeSnapshot, restore } = withFolder();
    try {
      const res = await syncSnapshotToDesktopFolder();
      expect(res).toMatchObject({ ok: false, empty: true });
      expect(res.error).toMatch(/no Apollo data to back up yet/);
      expect(writeSnapshot).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it('writes a checksummed snapshot of the Apollo data when there is some', async () => {
    persistence.setItem('apollo_plan', '{"id":"half"}');
    const { writeSnapshot, restore } = withFolder();
    try {
      const res = await syncSnapshotToDesktopFolder();
      expect(res.ok).toBe(true);
      expect(writeSnapshot).toHaveBeenCalledTimes(1);
      const payload = JSON.parse(writeSnapshot.mock.calls[0][0]) as {
        metadata: { keyCount: number; checksum?: string; purpose?: string };
        data: Record<string, string>;
      };
      expect(payload.metadata.keyCount).toBe(Object.keys(payload.data).length);
      expect(payload.metadata.keyCount).toBeGreaterThan(0);
      expect(payload.metadata.purpose).toBe('backup');
      expect(payload.metadata.checksum).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      restore();
    }
  });

  it('refuses while storage is degraded (an incomplete snapshot must never rotate good copies out)', async () => {
    persistence.setItem('apollo_plan', '{"id":"half"}');
    markStorageDegraded('test');
    const { writeSnapshot, restore } = withFolder();
    try {
      const res = await syncSnapshotToDesktopFolder();
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/Storage is unavailable/);
      expect(writeSnapshot).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it('automatic backups of an empty profile are not mirrored to the folder', async () => {
    persistence.clear();
    const { writeSnapshot, restore } = withFolder();
    try {
      await createBackup('manual');
      expect(writeSnapshot).not.toHaveBeenCalled();
      // Positive control: with data, the same backup is mirrored.
      persistence.setItem('apollo_plan', '{"id":"half"}');
      await createBackup('manual');
      await vi.waitFor(() => expect(writeSnapshot).toHaveBeenCalledTimes(1));
    } finally {
      restore();
    }
  });
});
