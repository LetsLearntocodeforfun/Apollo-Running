/**
 * Sync robustness (v1.0.6, agent S — P3 / V8 / V14): stalled response bodies,
 * the 5-minute sync watchdog (and its clock backstop), cancelSync, skipping
 * sources that need reconnecting, source-scoped syncs, the degraded-storage
 * guard, the 30-day incremental overlap (late uploads), conservative
 * remote-deletion reconcile, raw-row "empty years", the store-cap stop and
 * post-sync follow-up work.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

vi.mock('@/services/intervals', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/intervals')>();
  return { ...actual, listIntervalsActivitiesDetailed: vi.fn(actual.listIntervalsActivitiesDetailed) };
});
vi.mock('@/services/effortService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/effortService')>();
  return { ...actual, scheduleEffortRebuild: vi.fn() };
});

import {
  cancelSync,
  connectIntervals,
  disconnectSource,
  getSourceSyncState,
  isSyncRunning,
  onActivitiesUpdated,
  syncActivities,
} from '@/services/activitySource';
import {
  listIntervalsActivitiesDetailed,
  mapIntervalsActivity,
  type IcuActivity,
  type IntervalsActivityList,
} from '@/services/intervals';
import { scheduleEffortRebuild } from '@/services/effortService';
import { setIntervalsCredentials, setStravaTokens } from '@/services/storage';
import {
  MAX_STORED_ACTIVITIES,
  getAllStoredActivities,
  storeActivities,
  writeActivityStore,
} from '@/services/analyticsService';
import { getNeedsReconnect, setNeedsReconnect } from '@/services/connectionHealth';
import { clearStorageDegraded, markStorageDegraded } from '@/services/storageHealth';
import { persistence } from '@/services/db/persistence';
import type { Activity } from '@/services/activity/types';

// ── Fake intervals.icu (same shape as activitySource.test.ts) ─────────────────

interface FakeReply { status?: number; body?: unknown }

function fakeResponse({ status = 200, body }: FakeReply): Response {
  const text = body === undefined ? '' : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => text,
    json: async () => JSON.parse(text),
  } as unknown as Response;
}

/** Headers arrive, then the body never does. */
function stalledBodyResponse(): Response {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: () => new Promise<string>(() => undefined),
    json: () => new Promise<unknown>(() => undefined),
  } as unknown as Response;
}

function mockFetch(handler: (url: URL) => FakeReply): URL[] {
  const calls: URL[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
    const url = new URL(String(input));
    calls.push(url);
    return fakeResponse(handler(url));
  }));
  return calls;
}

function localDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function daysAgo(n: number, hour = 7): Date {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(hour, 0, 0, 0);
  return d;
}

/** An intervals.icu activity that started `n` days ago at 07:00 local time. */
function icu(id: number, n: number, overrides: Partial<IcuActivity> = {}): IcuActivity {
  const start = daysAgo(n);
  return {
    id: `i${id}`,
    name: `Activity ${id}`,
    type: 'Run',
    start_date_local: `${localDate(start)}T07:00:00`,
    start_date: start.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    distance: 8000,
    moving_time: 2400,
    elapsed_time: 2450,
    source: 'GARMIN_CONNECT',
    ...overrides,
  };
}

/** Serves the activity list by local-date window, route maps and the athlete. */
function fakeIntervals(activities: IcuActivity[]): URL[] {
  return mockFetch((url) => {
    const path = url.pathname;
    if (path.endsWith('/activities')) {
      const oldest = url.searchParams.get('oldest') ?? '0000-00-00';
      const newest = url.searchParams.get('newest') ?? '9999-99-99';
      return {
        body: activities.filter((a) => {
          const day = String(a.start_date_local).slice(0, 10);
          return day >= oldest && day <= newest;
        }),
      };
    }
    if (path.endsWith('/map')) return { body: { latlngs: [[45.1, -122.1], [45.11, -122.12]] } };
    if (/\/athlete\/[^/]+$/.test(path)) return { body: { id: 'i42', firstname: 'Marc', lastname: 'C' } };
    return { status: 404 };
  });
}

function connect(): void {
  setIntervalsCredentials({ apiKey: 'key', athleteId: 'i42' });
}

/** `source_id`s of every stored record (hidden ones included), newest first. */
function storedIds(): string[] {
  return getAllStoredActivities().map((a) => a.source_id ?? String(a.id));
}

const listMock = vi.mocked(listIntervalsActivitiesDetailed);
const rebuildMock = vi.mocked(scheduleEffortRebuild);

beforeEach(() => {
  listMock.mockClear();
  rebuildMock.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// ── Hung requests, watchdog, cancel ───────────────────────────────────────────

describe('hung requests', () => {
  it('times out a response body that never arrives, and the next sync starts fresh', async () => {
    vi.useFakeTimers();
    connect();
    const requests: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
      requests.push(String(input));
      return stalledBodyResponse();
    }));

    const stalled = syncActivities();
    // 3 attempts × 30 s timeout + 1 s + 2 s back-off.
    await vi.advanceTimersByTimeAsync(100_000);
    const summary = await stalled;
    expect(requests).toHaveLength(3);
    expect(summary.errors).toEqual([
      { source: 'intervals', message: expect.stringMatching(/did not respond in time/) },
    ]);
    expect(isSyncRunning()).toBe(false);

    fakeIntervals([icu(1, 1)]);
    const next = syncActivities();
    expect(next).not.toBe(stalled);
    const done = await next;
    expect(done.errors).toEqual([]);
    expect(done.added).toBe(1);
  });
});

describe('sync watchdog', () => {
  it('stops a sync stuck for 5 minutes, records the timeout and lets the next sync run', async () => {
    vi.useFakeTimers();
    connect();
    fakeIntervals([icu(1, 1)]);
    // A request that never settles and ignores its abort signal.
    listMock.mockImplementationOnce(() => new Promise<IntervalsActivityList>(() => undefined));

    const stuck = syncActivities();
    await vi.advanceTimersByTimeAsync(0);
    expect(isSyncRunning()).toBe(true);
    expect(syncActivities()).toBe(stuck); // callers share the running sync meanwhile

    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    const summary = await stuck;
    expect(summary.cancelled).toBe(true);
    expect(summary.errors).toEqual([
      { source: 'intervals', message: expect.stringMatching(/longer than 5 minutes/) },
    ]);
    expect(isSyncRunning()).toBe(false);
    expect(getSourceSyncState('intervals').lastError).toMatch(/longer than 5 minutes/);

    const next = await syncActivities();
    expect(next).not.toBe(summary);
    expect(next.errors).toEqual([]);
    expect(next.added).toBe(1);
  });

  it('replaces a sync older than 5 minutes even when the watchdog timer fired late', async () => {
    vi.useFakeTimers();
    connect();
    fakeIntervals([icu(1, 1)]);
    listMock.mockImplementationOnce(() => new Promise<IntervalsActivityList>(() => undefined));

    const stuck = syncActivities();
    await vi.advanceTimersByTimeAsync(0);
    // The laptop slept: the clock moved on, but no timer has fired yet.
    vi.setSystemTime(Date.now() + 6 * 60 * 1000);
    const fresh = syncActivities();
    expect(fresh).not.toBe(stuck);
    expect((await stuck).cancelled).toBe(true);
    const summary = await fresh;
    expect(summary.errors).toEqual([]);
    expect(summary.added).toBe(1);
  });
});

describe('cancelSync', () => {
  it('stops the running sync at once and writes nothing afterwards', async () => {
    connect();
    fakeIntervals([icu(1, 1)]);
    let release: (list: IntervalsActivityList) => void = () => undefined;
    listMock.mockImplementationOnce(() => new Promise<IntervalsActivityList>((resolve) => {
      release = resolve;
    }));

    const running = syncActivities();
    await vi.waitFor(() => expect(listMock).toHaveBeenCalledTimes(1));
    expect(cancelSync()).toBe(true);
    expect(isSyncRunning()).toBe(false);

    const summary = await running;
    expect(summary.cancelled).toBe(true);
    expect(summary.errors).toEqual([{ source: 'intervals', message: 'Sync was cancelled.' }]);
    // A cancel is not a source failure: no error shown, no back-off.
    expect(getSourceSyncState('intervals').lastError).toBeNull();

    // The request completing late must not write anything.
    release({ activities: [mapIntervalsActivity(icu(1, 1))!], rawCount: 1, rawIds: ['i1'] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(getAllStoredActivities()).toHaveLength(0);
    expect(getSourceSyncState('intervals').lastFullSyncAt).toBeNull();
    expect(cancelSync()).toBe(false);
  });
});

// ── Credentials, scope, storage health ────────────────────────────────────────

describe('needs-reconnect', () => {
  it('flags a rejected key, skips the source on later syncs, and a forced retry clears it', async () => {
    connect();
    const calls = mockFetch(() => ({ status: 401 }));
    const first = await syncActivities();
    expect(first.errors[0].message).toMatch(/rejected the API key/);
    expect(getNeedsReconnect('intervals')?.reason).toBe(first.errors[0].message);

    calls.length = 0;
    const skipped = await syncActivities();
    expect(calls).toHaveLength(0); // no request with a key known to be rejected
    expect(skipped.sources).toEqual(['intervals']);
    expect(skipped.errors).toEqual([{ source: 'intervals', message: first.errors[0].message }]);

    fakeIntervals([icu(1, 1)]);
    const forced = await syncActivities({ force: true });
    expect(forced.errors).toEqual([]);
    expect(forced.added).toBe(1);
    expect(getNeedsReconnect('intervals')).toBeNull();
  });

  it('is cleared by connecting again and by disconnecting', async () => {
    setNeedsReconnect('intervals', 'rejected');
    fakeIntervals([]);
    await connectIntervals('new-key');
    expect(getNeedsReconnect('intervals')).toBeNull();

    setNeedsReconnect('intervals', 'rejected');
    disconnectSource('intervals');
    expect(getNeedsReconnect('intervals')).toBeNull();
  });
});

describe('source-scoped sync', () => {
  it('syncs only the requested sources', async () => {
    connect();
    setStravaTokens({
      access_token: 'a', refresh_token: 'r', expires_at: Math.floor(Date.now() / 1000) + 3600,
      athlete: { id: 7, firstname: 'S', lastname: 'T' },
    });
    const calls = fakeIntervals([icu(1, 1)]);

    const summary = await syncActivities({ sources: ['intervals'] });
    expect(summary.sources).toEqual(['intervals']);
    expect(summary.errors).toEqual([]);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((u) => u.hostname === 'intervals.icu')).toBe(true);
    expect(getSourceSyncState('strava').lastSyncAt).toBeNull();
  });
});

describe('degraded storage', () => {
  it('pauses sync while saved data could not be loaded', async () => {
    connect();
    const calls = fakeIntervals([icu(1, 1)]);
    markStorageDegraded('IndexedDB failed to open');
    try {
      const summary = await syncActivities();
      expect(summary.errors).toEqual([{ source: 'intervals', message: expect.stringMatching(/Sync is paused/) }]);
      expect(calls).toHaveLength(0);
      expect(getAllStoredActivities()).toHaveLength(0);
    } finally {
      clearStorageDegraded();
    }
  });
});

// ── What lands in the store ───────────────────────────────────────────────────

describe('incremental window', () => {
  it('picks up an activity that reached intervals.icu 20 days late', async () => {
    connect();
    fakeIntervals([icu(1, 1)]);
    await syncActivities();

    fakeIntervals([icu(1, 1), icu(9, 21)]); // 20 days older than the newest activity
    const summary = await syncActivities();
    expect(summary.full).toBe(false);
    expect(summary.added).toBe(1);
    expect(storedIds()).toContain('i9');
  });

  it('counts what a source stored before it failed', async () => {
    connect();
    const cutoff = localDate(daysAgo(500));
    mockFetch((url) => {
      if (!url.pathname.endsWith('/activities')) return { status: 404 };
      // The first (newest) year works; the next one fails.
      if ((url.searchParams.get('oldest') ?? '') < cutoff) return { status: 404 };
      return { body: [icu(1, 1)] };
    });
    const updates: number[] = [];
    const unsubscribe = onActivitiesUpdated((s) => updates.push(s.added));
    const summary = await syncActivities();
    unsubscribe();
    expect(summary.errors).toHaveLength(1);
    expect(summary.added).toBe(1);
    expect(updates).toEqual([1]);
    expect(storedIds()).toEqual(['i1']);
    expect(getSourceSyncState('intervals').lastFullSyncAt).toBeNull(); // retried in full next time
  });
});

describe('remote deletion reconcile (intervals.icu)', () => {
  it('removes an activity deleted on intervals.icu, keeping edge-day, legacy and flagged records', async () => {
    connect();
    const legacyRun = icu(6, 8);
    // Record cached by an earlier Apollo version from Strava; intervals.icu data merges into it.
    storeActivities([{
      id: 987654, name: 'Strava run', type: 'Run', sport_type: 'Run',
      distance: 8030, moving_time: 2410, elapsed_time: 2460,
      start_date: legacyRun.start_date!, start_date_local: `${legacyRun.start_date_local}Z`, kudos_count: 3,
    }]);
    fakeIntervals([icu(1, 1), icu(2, 5), icu(3, 10), icu(4, 15), icu(5, 31), legacyRun]);
    await syncActivities();
    expect(getAllStoredActivities()).toHaveLength(6);

    // The athlete hid the window-edge activity in Apollo.
    writeActivityStore(getAllStoredActivities().map((a) => (a.source_id === 'i5' ? { ...a, hidden: true } : a)));

    // i3 was deleted on intervals.icu. i5 (on the window's first day) and i6
    // (merged into the legacy record) aren't listed either but must survive.
    fakeIntervals([icu(1, 1), icu(2, 5), icu(4, 15)]);
    const removed: number[] = [];
    const unsubscribe = onActivitiesUpdated((s) => removed.push(s.removed ?? 0));
    const summary = await syncActivities();
    unsubscribe();

    expect(summary.removed).toBe(1);
    expect(removed).toEqual([1]);
    expect(storedIds()).not.toContain('i3');
    expect(storedIds()).toEqual(expect.arrayContaining(['i1', 'i2', 'i4', 'i5', 'i6']));
    expect(getAllStoredActivities()).toHaveLength(5);
    expect(getAllStoredActivities().find((a) => a.source_id === 'i5')?.hidden).toBe(true);
    expect(getAllStoredActivities().find((a) => a.source_id === 'i6')?.id).toBe(987654);
  });

  it('keeps everything when the reply is missing too many activities', async () => {
    connect();
    const remote = Array.from({ length: 8 }, (_, i) => icu(i + 1, i + 1));
    fakeIntervals(remote);
    await syncActivities();

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      fakeIntervals(remote.slice(0, 2)); // 6 of 8 missing: looks like an incomplete reply
      const summary = await syncActivities();
      expect(summary.removed).toBe(0);
      expect(getAllStoredActivities()).toHaveLength(8);
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/looks incomplete/));
    } finally {
      warn.mockRestore();
    }
  });

  it('never removes anything on an empty reply', async () => {
    connect();
    fakeIntervals([icu(1, 1), icu(2, 2)]);
    await syncActivities();

    fakeIntervals([]);
    const summary = await syncActivities();
    expect(summary.removed).toBe(0);
    expect(getAllStoredActivities()).toHaveLength(2);
  });
});

describe('full history import', () => {
  it('keeps walking back past years that only hold Strava-origin rows', async () => {
    connect();
    const stravaOrigin = (id: number, n: number) => icu(id, n, { source: 'STRAVA' });
    fakeIntervals([icu(1, 1), stravaOrigin(2, 400), stravaOrigin(3, 800), stravaOrigin(4, 1200), icu(5, 1600)]);
    const summary = await syncActivities();
    expect(summary.errors).toEqual([]);
    // Before v1.0.6 three "empty" years (no usable rows) ended the import before i5.
    expect(storedIds()).toEqual(['i1', 'i5']);
  });

  it('stops walking back once the store is full, and says so', async () => {
    connect();
    const base = Date.UTC(2010, 0, 1, 8);
    const filler: Activity[] = Array.from({ length: MAX_STORED_ACTIVITIES }, (_, i) => {
      const iso = new Date(base + i * 3_600_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
      return {
        id: i + 1, name: `Ride ${i + 1}`, type: 'Ride', sport_type: 'Ride',
        distance: 20000, moving_time: 3600, elapsed_time: 3600,
        start_date: iso, start_date_local: iso, kudos_count: 0,
      };
    });
    writeActivityStore(filler);
    const calls = fakeIntervals([icu(1, 1), icu(2, 400)]);

    const summary = await syncActivities();
    expect(calls.filter((u) => u.pathname.endsWith('/activities'))).toHaveLength(1);
    expect(summary.storeFull).toBe(true);
    expect(storedIds()).toContain('i1');
    expect(storedIds()).not.toContain('i2');
    expect(getAllStoredActivities()).toHaveLength(MAX_STORED_ACTIVITIES);
  });
});

describe('after a sync', () => {
  it('schedules an effort rebuild and requests persistent storage only when something changed', async () => {
    connect();
    fakeIntervals([icu(1, 1)]);
    await syncActivities();
    expect(rebuildMock).toHaveBeenCalledTimes(1);
    expect(persistence.getItem('apollo_storage_persist_requested')).toBeTruthy();

    rebuildMock.mockClear();
    const again = await syncActivities();
    expect(again.added + again.updated + (again.removed ?? 0)).toBe(0);
    expect(rebuildMock).not.toHaveBeenCalled();
  });
});
