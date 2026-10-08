/**
 * backupIntegrity.test.ts — v1.0.6 regression tests for backups, export and
 * import (sync/platform review V1–V6, V4, U2–U5). Adapted from the reviewer's
 * repro tests: each of those now asserts the fixed behaviour.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { persistence } from '@/services/db/persistence';
import {
  createBackup,
  downloadCurrentData,
  downloadBackup,
  importFromFile,
  restoreFromBackup,
  restoreFromBackupDetailed,
  getBackupRecords,
  getBackupHealth,
  compactLegacyBackups,
  runAutoBackupIfDue,
  startAutoBackupScheduler,
  setBackupConfig,
  getLastBackupError,
  BACKUP_COMPACTION_MIGRATION_ID,
} from '@/services/backupService';
import { exportAllData, isExcludedFromExport } from '@/services/dataManager';
import { hasMigrationRun } from '@/services/db/migrations';
import { markStorageDegraded, clearStorageDegraded } from '@/services/storageHealth';
import { APP_VERSION } from '@/version';

const STORE_KEY = 'apollo_activities_store';
const SECRET_KEYS = ['strava_tokens', 'intervals_credentials', 'strava_credentials'];

let captured: Blob | null = null;

beforeEach(() => {
  captured = null;
  (URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = (b: Blob) => {
    captured = b;
    return 'blob:test';
  };
  (URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL = () => {};
  HTMLAnchorElement.prototype.click = function click() { /* no navigation in tests */ };
});

afterEach(() => {
  clearStorageDegraded();
  vi.useRealTimers();
});

function seedStore(count: number, extra = ''): string {
  const raw = JSON.stringify(Array.from({ length: count }, (_, i) => ({
    id: i + 1, name: `Run "${i}"`, type: 'Run', distance: 10000, start_date: '2026-01-01T07:00:00Z', note: extra,
  })));
  persistence.setItem(STORE_KEY, raw);
  return raw;
}

function seedSecrets(): void {
  persistence.setItem('strava_tokens', JSON.stringify({ access_token: 'AT', refresh_token: 'SECRET-REFRESH' }));
  persistence.setItem('intervals_credentials', JSON.stringify({ apiKey: 'SECRET-API-KEY', athleteId: 'i1' }));
}

function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

async function capturedText(): Promise<string> {
  expect(captured).not.toBeNull();
  return captured!.text();
}

/**
 * Wait until `done()` holds: polls on setImmediate with a real-time limit, so
 * slow CI runners get enough event-loop turns. Leaves fake timers alone
 * (vi.waitFor would advance the fake clock between checks).
 */
async function settleUntil(done: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!done()) {
    if (performance.now() > deadline) throw new Error(`Condition not met within ${timeoutMs} ms`);
    await new Promise((r) => setImmediate(r));
  }
}

describe('backups contain only the athlete data (V1, V4)', () => {
  it('5 consecutive backups are each about the size of the store (no nesting)', async () => {
    const raw = seedStore(200);
    persistence.setItem('apollo_settings', JSON.stringify({ theme: 'dark' }));
    const sizes: number[] = [];
    for (let i = 0; i < 5; i++) {
      const record = await createBackup('manual');
      expect(record).not.toBeNull();
      sizes.push(record!.sizeBytes);
    }
    for (const size of sizes) {
      expect(size).toBeGreaterThan(raw.length);
      expect(size).toBeLessThan(raw.length * 1.3);
    }
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThan(200);
    const payloadKeys = Object.keys(exportAllData().data).filter((k) => k.startsWith('apollo_backup_'));
    expect(payloadKeys).toEqual([]);
  });

  it('payloads and exports never contain credentials, backups, caches or device state', async () => {
    seedStore(3);
    seedSecrets();
    persistence.setItem('apollo_route_cache', JSON.stringify({ a: 1 }));
    persistence.setItem('apollo_last_integrity_check', new Date().toISOString());
    await createBackup('manual');
    const second = await createBackup('auto');
    const payload = persistence.getItem(`apollo_backup_data_${second!.id}`)!;
    expect(payload).not.toMatch(/SECRET-REFRESH|SECRET-API-KEY/);
    const data = JSON.parse(payload).data as Record<string, string>;
    for (const key of Object.keys(data)) expect(isExcludedFromExport(key)).toBe(false);
    expect(Object.keys(data)).not.toContain('apollo_route_cache');
    expect(Object.keys(data)).not.toContain('apollo_backup_registry');
    for (const k of SECRET_KEYS) expect(data[k]).toBeUndefined();

    await downloadCurrentData();
    const exported = await capturedText();
    expect(exported).not.toMatch(/SECRET-REFRESH|SECRET-API-KEY|apollo_backup_data_/);
  });

  it('records the real app version instead of the stale 1.0.2', () => {
    seedStore(1);
    const { metadata } = exportAllData({ purpose: 'backup' });
    expect(metadata.version).toBe(APP_VERSION);
    expect(metadata.version).not.toBe('1.0.2');
    expect(metadata.purpose).toBe('backup');
  });
});

describe('legacy (≤ 1.0.5) backup compaction migration', () => {
  it('strips nested backups and credentials, recomputes the checksum and re-lists orphans', async () => {
    seedStore(5);
    // A 1.0.5-style payload: embeds an earlier backup, the registry and credentials.
    const nested = {
      metadata: { exportDate: '2026-01-01T00:00:00.000Z', appName: 'Apollo Running', version: '1.0.2', keyCount: 5 },
      data: {
        apollo_activities_store: persistence.getItem(STORE_KEY)!,
        apollo_backup_data_backup_1_old: '{"metadata":{},"data":{"x":"y"}}',
        apollo_backup_registry: '[]',
        strava_tokens: '{"refresh_token":"SECRET-REFRESH"}',
        apollo_settings: '{"theme":"dark"}',
      },
    };
    const legacyJson = JSON.stringify(nested);
    const id = 'backup_1767225600000_abcd';
    persistence.setItem(`apollo_backup_data_${id}`, legacyJson);
    persistence.setItem('apollo_backup_registry', JSON.stringify([{
      id, createdAt: '2026-01-01T00:00:00.000Z', checksum: sha256Hex(legacyJson), keyCount: 5,
      sizeBytes: legacyJson.length, trigger: 'auto', verified: true,
    }]));
    // An orphaned payload (registry overwritten by the 1.0.5 restore bug) and a corrupt one.
    const orphanId = 'backup_1767312000000_efgh';
    persistence.setItem(`apollo_backup_data_${orphanId}`, JSON.stringify({
      metadata: { exportDate: '2026-01-02T00:00:00.000Z', appName: 'Apollo Running', version: '1.0.5', keyCount: 1 },
      data: { apollo_settings: '{"theme":"light"}' },
    }));
    persistence.setItem('apollo_backup_data_backup_1767398400000_bad1', '{"metadata": {"trunc');

    const result = await compactLegacyBackups();
    expect(result).toEqual({ compacted: 1, deleted: 1, kept: 2 });
    expect(hasMigrationRun(BACKUP_COMPACTION_MIGRATION_ID)).toBe(true);

    const compacted = persistence.getItem(`apollo_backup_data_${id}`)!;
    expect(compacted).not.toMatch(/SECRET-REFRESH|apollo_backup_/);
    const parsed = JSON.parse(compacted);
    expect(Object.keys(parsed.data).sort()).toEqual(['apollo_activities_store', 'apollo_settings']);
    expect(parsed.metadata.keyCount).toBe(2);

    const records = getBackupRecords();
    expect(records.map((r) => r.id)).toEqual([id, orphanId]);
    expect(records[0].checksum).toBe(sha256Hex(compacted));
    expect(persistence.getItem('apollo_backup_data_backup_1767398400000_bad1')).toBeNull();

    // Restoring the compacted backup works (checksum valid) and doesn't bring credentials back.
    persistence.removeItem('strava_tokens');
    expect(await restoreFromBackup(id)).toBe(true);
    expect(persistence.getItem('strava_tokens')).toBeNull();

    // Runs once.
    const again = await compactLegacyBackups();
    expect(again.compacted).toBe(0);
  });
});

describe('export → import round trip (V2, V3, U5)', () => {
  it('a file from Export Data imports successfully', async () => {
    persistence.setItem('apollo_test_key', JSON.stringify({ hello: 'world' }));
    await downloadCurrentData();
    const text = await capturedText();
    persistence.removeItem('apollo_test_key');
    const result = await importFromFile(new File([text], 'apollo-export.json', { type: 'application/json' }));
    expect(result.success).toBe(true);
    expect(result.skippedKeys).toEqual([]);
    expect(result.needsReload).toBe(true);
    expect(result.message).not.toMatch(/Refresh the page/);
    expect(persistence.getItem('apollo_test_key')).toBe(JSON.stringify({ hello: 'world' }));
  });

  it('a downloaded in-app backup imports with its embedded checksum', async () => {
    persistence.setItem('apollo_settings', JSON.stringify({ theme: 'dark' }));
    const record = await createBackup('manual');
    expect(downloadBackup(record!.id)).toBe(true);
    const text = await capturedText();
    expect(JSON.parse(text).metadata.checksum).toBe(record!.checksum);
    const result = await importFromFile(new File([text], 'apollo-backup.json'));
    expect(result.success).toBe(true);
  });

  it('accepts a 1.0.5 export (checksum over pretty JSON) and ignores its credentials and nested backups', async () => {
    const backupData = {
      metadata: { exportDate: '2026-09-01T00:00:00.000Z', appName: 'Apollo Running', version: '1.0.2', keyCount: 4 },
      data: {
        apollo_plan: JSON.stringify({ id: 'half' }),
        apollo_backup_data_backup_1_x: '{"metadata":{},"data":{}}',
        intervals_credentials: '{"apiKey":"SECRET-API-KEY"}',
        apollo_distance_unit: 'km',
      },
    };
    const checksum = sha256Hex(JSON.stringify(backupData, null, 2));
    const file = new File([JSON.stringify({ ...backupData, metadata: { ...backupData.metadata, checksum } }, null, 2)], 'old.json');
    const result = await importFromFile(file);
    expect(result.success).toBe(true);
    expect(result.importedKeys.sort()).toEqual(['apollo_distance_unit', 'apollo_plan']);
    expect(result.ignoredKeys.sort()).toEqual(['apollo_backup_data_backup_1_x', 'intervals_credentials']);
    expect(persistence.getItem('intervals_credentials')).toBeNull();
    expect(persistence.getItem('apollo_backup_data_backup_1_x')).toBeNull();
  });

  it('rejects a tampered file', async () => {
    persistence.setItem('apollo_plan', JSON.stringify({ id: 'full' }));
    await downloadCurrentData();
    const tampered = (await capturedText()).replace('full', 'hack');
    persistence.removeItem('apollo_plan');
    const result = await importFromFile(new File([tampered], 'x.json'));
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/Checksum verification failed/);
    expect(persistence.getItem('apollo_plan')).toBeNull();
  });

  it('imports a > 1 MB activity store instead of silently dropping it', async () => {
    const big = JSON.stringify(Array.from({ length: 4000 }, (_, i) => ({
      id: i, name: 'Morning Run', type: 'Run', distance: 10000, polyline: 'x'.repeat(300),
    })));
    expect(big.length).toBeGreaterThan(1024 * 1024);
    const file = new File([JSON.stringify({
      metadata: { appName: 'Apollo Running', keyCount: 2 },
      data: { [STORE_KEY]: big, apollo_small: '1' },
    })], 'b.json');
    const result = await importFromFile(file);
    expect(result.success).toBe(true);
    expect(persistence.getItem(STORE_KEY)).toBe(big);
  });

  it('reports skipped keys and success:false when a value is invalid', async () => {
    const file = new File([JSON.stringify({
      metadata: { appName: 'Apollo Running', keyCount: 3 },
      data: {
        apollo_good: JSON.stringify({ ok: true }),
        apollo_broken: '{"truncated": ',
        [STORE_KEY]: JSON.stringify({ not: 'an array' }),
      },
    })], 'partial.json');
    const result = await importFromFile(file);
    expect(result.success).toBe(false);
    expect(result.importedKeys).toEqual(['apollo_good']);
    expect(result.skippedKeys.map((s) => s.key).sort()).toEqual(['apollo_activities_store', 'apollo_broken']);
    expect(result.message).toMatch(/couldn’t be imported/);
    expect(persistence.getItem('apollo_good')).not.toBeNull();
    expect(persistence.getItem('apollo_broken')).toBeNull();
  });

  it('imports a gzip-compressed export (.json.gz)', async () => {
    persistence.setItem('apollo_plan', JSON.stringify({ id: 'gz' }));
    await downloadCurrentData();
    const text = await capturedText();
    persistence.removeItem('apollo_plan');
    const gz = gzipSync(Buffer.from(text, 'utf8'));
    const result = await importFromFile(new File([new Uint8Array(gz)], 'apollo-export.json.gz'));
    expect(result.success).toBe(true);
    expect(persistence.getItem('apollo_plan')).toBe(JSON.stringify({ id: 'gz' }));
  });

  it('refuses to import while storage is degraded', async () => {
    markStorageDegraded('test');
    const file = new File([JSON.stringify({ metadata: { appName: 'Apollo Running', keyCount: 1 }, data: { apollo_x: '1' } })], 'x.json');
    const result = await importFromFile(file);
    expect(result.success).toBe(false);
    expect(persistence.getItem('apollo_x')).toBeNull();
  });
});

describe('restore (V5)', () => {
  it('keeps the registry complete, leaves credentials alone and removes keys absent from the snapshot', async () => {
    persistence.setItem('apollo_x', '"v1"');
    await createBackup('manual');
    const second = await createBackup('manual');
    persistence.setItem('apollo_x', '"v2"');
    persistence.setItem('apollo_created_later', '"new"');
    seedSecrets();

    const result = await restoreFromBackupDetailed(second!.id);
    expect(result.success).toBe(true);
    expect(result.removedKeys).toContain('apollo_created_later');
    expect(persistence.getItem('apollo_x')).toBe('"v1"');
    expect(persistence.getItem('apollo_created_later')).toBeNull();
    expect(persistence.getItem('intervals_credentials')).toMatch(/SECRET-API-KEY/);

    const registryIds = getBackupRecords().map((r) => r.id);
    const storedIds = persistence.keys()
      .filter((k) => k.startsWith('apollo_backup_data_'))
      .map((k) => k.replace('apollo_backup_data_', ''));
    expect(registryIds.sort()).toEqual(storedIds.sort());
    expect(registryIds).toContain(second!.id);
    expect(getBackupRecords().some((r) => r.note === 'Before restore')).toBe(true);
  });

  it('a > 1 MB store survives backup → restore', async () => {
    const big = seedStore(6000, 'x'.repeat(150));
    expect(big.length).toBeGreaterThan(1024 * 1024);
    const record = await createBackup('manual');
    persistence.setItem(STORE_KEY, '[]');
    expect(await restoreFromBackup(record!.id)).toBe(true);
    expect(persistence.getItem(STORE_KEY)).toBe(big);
  });

  it('returns the real reason on failure (U4)', async () => {
    persistence.setItem('apollo_x', '"v1"');
    const record = await createBackup('manual');
    persistence.setItem(`apollo_backup_data_${record!.id}`, '{"metadata":{},"data":{}}');
    const result = await restoreFromBackupDetailed(record!.id);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/integrity check/);
    const missing = await restoreFromBackupDetailed('nope');
    expect(missing.error).toMatch(/missing/);
  });
});

describe('automatic backups (V6)', () => {
  it('runAutoBackupIfDue creates a backup when due and not when there is nothing to protect', async () => {
    setBackupConfig({ autoBackupEnabled: true, intervalHours: 24 });
    expect(await runAutoBackupIfDue()).toBeNull(); // no data yet
    persistence.setItem('apollo_plan', JSON.stringify({ id: 'half' }));
    const record = await runAutoBackupIfDue();
    expect(record?.trigger).toBe('auto');
    expect(await runAutoBackupIfDue()).toBeNull(); // not due again
  });

  it('the scheduler backs up when the interval elapses and prunes to maxBackups', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(new Date('2026-10-01T08:00:00Z'));
    setBackupConfig({ autoBackupEnabled: true, intervalHours: 1, maxBackups: 2 });
    persistence.setItem('apollo_plan', JSON.stringify({ id: 'half' }));
    const stop = startAutoBackupScheduler(60_000);
    try {
      for (let hour = 0; hour < 3; hour++) {
        const hourStart = Date.parse('2026-10-01T08:00:00Z') + (hour + 1) * 3_600_000;
        vi.setSystemTime(new Date(hourStart));
        await vi.advanceTimersByTimeAsync(60_000);
        // let this hour's async backup (crypto.subtle) settle
        await settleUntil(() => getBackupRecords().some((r) => Date.parse(r.createdAt) >= hourStart));
      }
    } finally {
      stop();
    }
    const records = getBackupRecords();
    expect(records.length).toBe(2);
    expect(records.every((r) => r.trigger === 'auto')).toBe(true);
  });

  it('health reflects a failed attempt with the real error', async () => {
    markStorageDegraded('IndexedDB failed');
    expect(await createBackup('manual')).toBeNull();
    expect(getLastBackupError()?.message).toMatch(/Storage is unavailable/);
    clearStorageDegraded();
    const health = getBackupHealth();
    expect(health.status).toBe('critical');
    expect(health.message).toMatch(/Storage is unavailable/);
  });
});
