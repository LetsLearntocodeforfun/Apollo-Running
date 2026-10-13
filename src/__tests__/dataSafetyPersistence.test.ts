/**
 * dataSafetyPersistence.test.ts — v1.0.7 data safety against the REAL
 * persistence layer and Dexie schema (fake-indexeddb):
 * - PX-03: failed writes are tracked, reported to subscribers and recovered by retry.
 * - PX-04: the version 1 → 2 upgrade moves backup payloads out of kvStore.
 */

import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Dexie from 'dexie';
import { PersistenceService, type PersistenceDatabase } from '@/services/db/persistence';
import { ApolloDatabase, type KVEntry } from '@/services/db/apolloDB';
import { clearStorageDegraded, markStorageDegraded } from '@/services/storageHealth';

vi.unmock('@/services/db/persistence');
vi.unmock('@/services/db/apolloDB');

/** In-memory kvStore whose writes can be made to fail. */
function flakyDb() {
  const rows = new Map<string, KVEntry>();
  const state = { failing: false };
  const fail = () => Promise.reject(new Error('QuotaExceededError'));
  const kvStore = {
    toArray: () => Promise.resolve([...rows.values()]),
    bulkPut: (entries: KVEntry[]) => {
      if (state.failing) return fail();
      for (const e of entries) rows.set(e.key, e);
      return Promise.resolve();
    },
    put: (e: KVEntry) => {
      if (state.failing) return fail();
      rows.set(e.key, e);
      return Promise.resolve(e.key);
    },
    delete: (key: string) => { rows.delete(key); return Promise.resolve(); },
    clear: () => { rows.clear(); return Promise.resolve(); },
  };
  return { db: { kvStore } as unknown as PersistenceDatabase, rows, state };
}

beforeEach(() => {
  clearStorageDegraded();
  localStorage.clear();
});

afterEach(() => {
  clearStorageDegraded();
});

describe('PX-03: write health', () => {
  it('reports a failed write, keeps the value and recovers on retry', async () => {
    const { db, rows, state } = flakyDb();
    const svc = new PersistenceService(db);
    await svc.ready;
    const listener = vi.fn();
    svc.onWriteHealthChange(listener);

    state.failing = true;
    svc.setItem('apollo_plan', '{"id":"half"}');
    await svc.flush();
    expect(listener).toHaveBeenCalled();
    expect(svc.getWriteHealth()).toEqual({ ok: false, failedKeys: ['apollo_plan'] });
    expect(svc.getItem('apollo_plan')).toBe('{"id":"half"}'); // kept in memory
    expect(rows.has('apollo_plan')).toBe(false);

    // Still failing: retry recovers nothing.
    expect(await svc.retryFailedWrites()).toBe(0);
    expect(svc.getWriteHealth().ok).toBe(false);

    listener.mockClear();
    state.failing = false;
    expect(await svc.retryFailedWrites()).toBe(1);
    expect(svc.getWriteHealth()).toEqual({ ok: true, failedKeys: [] });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(rows.get('apollo_plan')?.value).toBe('{"id":"half"}');
  });

  it('a later successful flush also saves keys that failed earlier', async () => {
    const { db, rows, state } = flakyDb();
    const svc = new PersistenceService(db);
    await svc.ready;
    state.failing = true;
    svc.setItem('apollo_a', '"1"');
    await svc.flush();
    expect(svc.failedWrites.has('apollo_a')).toBe(true);

    state.failing = false;
    svc.setItem('apollo_b', '"2"');
    await svc.flush();
    expect(svc.getWriteHealth().ok).toBe(true);
    expect(rows.get('apollo_a')?.value).toBe('"1"');
  });

  it('removing a key that failed to save clears its unsaved state', async () => {
    const { db, state } = flakyDb();
    const svc = new PersistenceService(db);
    await svc.ready;
    state.failing = true;
    svc.setItem('apollo_tmp', '"x"');
    await svc.flush();
    const listener = vi.fn();
    svc.onWriteHealthChange(listener);
    svc.removeItem('apollo_tmp');
    expect(svc.getWriteHealth().ok).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('unsubscribe stops notifications; a throwing listener does not break writes', async () => {
    const { db, state } = flakyDb();
    const svc = new PersistenceService(db);
    await svc.ready;
    const listener = vi.fn();
    const unsubscribe = svc.onWriteHealthChange(listener);
    svc.onWriteHealthChange(() => { throw new Error('bad listener'); });
    unsubscribe();
    state.failing = true;
    svc.setItem('apollo_k', '"v"');
    await svc.flush();
    expect(listener).not.toHaveBeenCalled();
    expect(svc.getWriteHealth().ok).toBe(false);
  });

  it('retry does not write protected keys while storage is degraded', async () => {
    const { db, rows, state } = flakyDb();
    const svc = new PersistenceService(db);
    await svc.ready;
    state.failing = true;
    svc.setItem('apollo_activities_store', '[]');
    await svc.flush();
    state.failing = false;
    markStorageDegraded('test');
    expect(await svc.retryFailedWrites()).toBe(0);
    expect(rows.has('apollo_activities_store')).toBe(false);
    expect(svc.getWriteHealth().ok).toBe(false);
  });
});

describe('PX-04: Dexie version 2 moves backups to their own table', () => {
  const NAME = 'ApolloUpgradeTest';

  afterEach(async () => {
    await Dexie.delete(NAME);
  });

  it('moves apollo_backup_data_* rows from kvStore into backups and keeps everything else', async () => {
    const v1 = new Dexie(NAME);
    v1.version(1).stores({ kvStore: 'key' });
    await v1.table('kvStore').bulkPut([
      { key: 'apollo_backup_data_backup_1_a', value: '{"metadata":{},"data":{"a":"1"}}', updatedAt: 1 },
      { key: 'apollo_backup_data_backup_2_b', value: '{"metadata":{},"data":{"b":"2"}}', updatedAt: 2 },
      { key: 'apollo_backup_registry', value: '[]', updatedAt: 3 },
      { key: 'apollo_activities_store', value: '[]', updatedAt: 4 },
    ]);
    v1.close();

    const upgraded = new ApolloDatabase(NAME);
    await upgraded.open();
    expect(upgraded.verno).toBe(2);
    expect((await upgraded.kvStore.toCollection().primaryKeys()).sort())
      .toEqual(['apollo_activities_store', 'apollo_backup_registry']);
    const backups = await upgraded.backups.toArray();
    expect(backups.map((b) => b.id).sort()).toEqual(['backup_1_a', 'backup_2_b']);
    expect((await upgraded.backups.get('backup_2_b'))?.json).toBe('{"metadata":{},"data":{"b":"2"}}');
    upgraded.close();
  });

  it('a fresh database opens at version 2 with an empty backups table', async () => {
    const fresh = new ApolloDatabase(NAME);
    await fresh.open();
    expect(fresh.verno).toBe(2);
    expect(await fresh.backups.count()).toBe(0);
    fresh.close();
  });
});
