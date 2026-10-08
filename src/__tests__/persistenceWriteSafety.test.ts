/**
 * persistenceWriteSafety.test.ts — the REAL persistence layer against
 * fake-indexeddb (the global test setup mocks it, so this file unmocks it).
 * Covers sync/platform review S1, V7, V9 and S6.
 */

import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  PersistenceService,
  LOCAL_MIRROR_MAX_CHARS,
  LS_TIMESTAMPS_KEY,
  LS_IDB_IN_USE_KEY,
  type PersistenceDatabase,
} from '@/services/db/persistence';
import { db } from '@/services/db/apolloDB';
import { getStorageHealth, clearStorageDegraded, markStorageDegraded } from '@/services/storageHealth';

vi.unmock('@/services/db/persistence');
vi.unmock('@/services/db/apolloDB');

const STORE = 'apollo_activities_store';

async function freshService(): Promise<PersistenceService> {
  const svc = new PersistenceService(db);
  await svc.ready;
  return svc;
}

beforeEach(async () => {
  clearStorageDegraded();
  localStorage.clear();
  await db.kvStore.clear();
});

afterEach(() => {
  clearStorageDegraded();
});

describe('coalesced writes (S1, V9)', () => {
  it("setItem('a') then setItem('b') leaves IndexedDB = 'b' (same tick)", async () => {
    const svc = await freshService();
    svc.setItem('apollo_k', 'a');
    svc.setItem('apollo_k', 'b');
    expect(svc.getItem('apollo_k')).toBe('b');
    await svc.flush();
    expect((await db.kvStore.get('apollo_k'))?.value).toBe('b');
    expect(localStorage.getItem('apollo_k')).toBe('b');
  });

  it("back-to-back writes across ticks never land the older value last", async () => {
    const svc = await freshService();
    svc.setItem('apollo_k', 'a');
    await Promise.resolve(); // flush microtask for 'a' runs, its put is in flight
    svc.setItem('apollo_k', 'b');
    await svc.flush();
    await new Promise((r) => setTimeout(r, 20));
    expect((await db.kvStore.get('apollo_k'))?.value).toBe('b');
  });

  it('many rapid writes to one key produce a single IndexedDB write', async () => {
    const svc = await freshService();
    const spy = vi.spyOn(db.kvStore, 'bulkPut');
    for (let i = 0; i < 50; i++) svc.setItem('apollo_route_cache', `v${i}`);
    await svc.flush();
    expect(spy).toHaveBeenCalledTimes(1);
    expect((await db.kvStore.get('apollo_route_cache'))?.value).toBe('v49');
    spy.mockRestore();
  });
});

describe('localStorage mirror (V9, S6)', () => {
  it('skips values over the cap and removes a stale localStorage copy', async () => {
    const svc = await freshService();
    localStorage.setItem(STORE, '[{"id":1}]'); // stale small copy
    const big = 'x'.repeat(LOCAL_MIRROR_MAX_CHARS + 1);
    svc.setItem(STORE, big);
    await svc.flush();
    expect(localStorage.getItem(STORE)).toBeNull();
    expect((await db.kvStore.get(STORE))?.value.length).toBe(big.length);
  });

  it('does not copy an IndexedDB-only large value into localStorage on hydrate', async () => {
    const big = 'y'.repeat(LOCAL_MIRROR_MAX_CHARS + 1);
    await db.kvStore.put({ key: STORE, value: big, updatedAt: 1000 });
    const setSpy = vi.spyOn(Storage.prototype, 'setItem');
    const svc = await freshService();
    expect(svc.getItem(STORE)?.length).toBe(big.length);
    expect(setSpy.mock.calls.some(([k]) => k === STORE)).toBe(false);
    setSpy.mockRestore();
  });
});

describe('hydrate: the newer copy wins (V7)', () => {
  it('a stale (older) localStorage copy no longer shadows the full IndexedDB copy', async () => {
    await db.kvStore.put({ key: STORE, value: '[1,2,3,4,5]', updatedAt: 2000 });
    localStorage.setItem(STORE, '[1]');
    localStorage.setItem(LS_TIMESTAMPS_KEY, JSON.stringify({ [STORE]: 1000 }));
    const svc = await freshService();
    expect(svc.getItem(STORE)).toBe('[1,2,3,4,5]');
    expect(localStorage.getItem(STORE)).toBe('[1,2,3,4,5]');
  });

  it('a newer localStorage copy wins and heals IndexedDB', async () => {
    await db.kvStore.put({ key: 'apollo_prefs', value: 'old', updatedAt: 2000 });
    localStorage.setItem('apollo_prefs', 'new');
    localStorage.setItem(LS_TIMESTAMPS_KEY, JSON.stringify({ apollo_prefs: 3000 }));
    const svc = await freshService();
    expect(svc.getItem('apollo_prefs')).toBe('new');
    await svc.flush();
    expect((await db.kvStore.get('apollo_prefs'))?.value).toBe('new');
  });

  it('without timestamps (≤ 1.0.5 data) localStorage still wins, as before', async () => {
    await db.kvStore.put({ key: 'apollo_prefs', value: 'idb', updatedAt: 2000 });
    localStorage.setItem('apollo_prefs', 'ls');
    const svc = await freshService();
    expect(svc.getItem('apollo_prefs')).toBe('ls');
  });

  it('restores keys localStorage lost and seeds IndexedDB with localStorage-only keys', async () => {
    await db.kvStore.put({ key: 'apollo_only_idb', value: '1', updatedAt: 1 });
    localStorage.setItem('apollo_only_ls', '2');
    const svc = await freshService();
    expect(svc.getItem('apollo_only_idb')).toBe('1');
    await svc.flush();
    expect((await db.kvStore.get('apollo_only_ls'))?.value).toBe('2');
    expect(localStorage.getItem(LS_IDB_IN_USE_KEY)).toBe('1');
  });
});

function failingDb(): PersistenceDatabase {
  const reject = () => Promise.reject(new Error('IDB broken'));
  return {
    kvStore: {
      toArray: reject,
      bulkPut: vi.fn(reject),
      put: reject,
      get: reject,
      delete: reject,
      bulkDelete: reject,
      clear: reject,
    },
  } as unknown as PersistenceDatabase;
}

describe('degraded mode (V7)', () => {
  it('a failing hydrate on a profile that used IndexedDB marks storage degraded', async () => {
    localStorage.setItem(LS_IDB_IN_USE_KEY, '1');
    const svc = new PersistenceService(failingDb());
    await svc.ready;
    expect(getStorageHealth().degraded).toBe(true);
    expect(getStorageHealth().reason).toMatch(/couldn.t open its database/);
  });

  it('a profile that never had IndexedDB (localStorage-only) is not degraded', async () => {
    const svc = new PersistenceService(failingDb());
    await svc.ready;
    expect(getStorageHealth().degraded).toBe(false);
  });

  it('while degraded, protected and large values stay in memory only', async () => {
    const dbStub = failingDb();
    const svc = new PersistenceService(dbStub);
    await svc.ready;
    markStorageDegraded('test');
    svc.setItem(STORE, '[{"id":1}]'); // a truncated store must not shadow the full one
    svc.setItem('apollo_small_pref', '"km"');
    await svc.flush();
    expect(svc.getItem(STORE)).toBe('[{"id":1}]');
    expect(localStorage.getItem(STORE)).toBeNull();
    expect(svc.blockedWrites.has(STORE)).toBe(true);
    expect(localStorage.getItem('apollo_small_pref')).toBe('"km"');
  });
});

describe('clearAll', () => {
  it('removes every layer including IndexedDB-only keys', async () => {
    await db.kvStore.put({ key: 'apollo_ghost', value: 'g', updatedAt: 1 });
    const svc = await freshService();
    svc.setItem('apollo_a', '1');
    await svc.clearAll();
    expect(svc.keys()).toEqual([]);
    expect(await db.kvStore.count()).toBe(0);
    expect(localStorage.getItem('apollo_a')).toBeNull();
    expect(localStorage.getItem(LS_TIMESTAMPS_KEY)).toBeNull();
  });
});
