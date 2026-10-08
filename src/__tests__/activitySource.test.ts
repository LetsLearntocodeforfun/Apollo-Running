/**
 * Unit tests for the activity source facade + sync engine
 * (services/activitySource.ts) using a stubbed intervals.icu API.
 *
 * Covers: connecting with an API key, first-sync full-history import,
 * incremental syncs, route enrichment, error reporting, and de-duplication
 * against legacy Strava history already on the device.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  connectIntervals,
  disconnectSource,
  normalizeIntervalsAthleteId,
  syncActivities,
  getActivities,
  getSourceSyncState,
  isActivitySourceConnected,
  getActiveSourceName,
  getActivityExternalUrl,
  onActivitiesUpdated,
  isActivitySyncFresh,
  PAGE_SYNC_FRESH_MS,
} from '@/services/activitySource';
import { getIntervalsCredentials, setIntervalsCredentials, setStravaTokens } from '@/services/storage';
import { getStoredActivities, storeActivities } from '@/services/analyticsService';
import type { IcuActivity } from '@/services/intervals';

// ── Fake intervals.icu ────────────────────────────────────────────────────────

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

/** Serves the activity list by date window, maps (404 for `noGps` IDs) and the athlete. */
function fakeIntervals(activities: IcuActivity[], noGps: string[] = []): URL[] {
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
    if (path.endsWith('/map')) {
      const id = path.split('/').slice(-2)[0];
      return noGps.includes(id) ? { status: 404 } : { body: { latlngs: [[45.1, -122.1], [45.11, -122.12]] } };
    }
    if (/\/athlete\/[^/]+$/.test(path)) return { body: { id: 'i42', firstname: 'Marc', lastname: 'C' } };
    return { status: 404 };
  });
}

function connect(): void {
  setIntervalsCredentials({ apiKey: 'key', athleteId: 'i42' });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── Connecting ────────────────────────────────────────────────────────────────

describe('normalizeIntervalsAthleteId', () => {
  it('accepts blank, plain, prefixed and URL forms', () => {
    expect(normalizeIntervalsAthleteId('')).toBe('0');
    expect(normalizeIntervalsAthleteId(undefined)).toBe('0');
    expect(normalizeIntervalsAthleteId(' I123 ')).toBe('i123');
    expect(normalizeIntervalsAthleteId('123')).toBe('123');
    expect(normalizeIntervalsAthleteId('https://intervals.icu/athlete/i555/calendar')).toBe('i555');
  });
});

describe('connectIntervals', () => {
  it('verifies the key, then saves it with the resolved athlete', async () => {
    const calls = fakeIntervals([]);
    const athlete = await connectIntervals('  my-key  ');
    expect(calls[0].pathname).toBe('/api/v1/athlete/0');
    expect(athlete.firstname).toBe('Marc');
    const creds = getIntervalsCredentials()!;
    expect(creds.apiKey).toBe('my-key');
    expect(creds.athleteId).toBe('i42');
    expect(creds.athleteName).toBe('Marc C');
    expect(isActivitySourceConnected()).toBe(true);
    expect(getActiveSourceName()).toBe('intervals.icu');
  });

  it('does not save a rejected key', async () => {
    mockFetch(() => ({ status: 401 }));
    await expect(connectIntervals('bad')).rejects.toThrow(/rejected/);
    expect(getIntervalsCredentials()).toBeNull();
  });

  it('requires a key', async () => {
    await expect(connectIntervals('   ')).rejects.toThrow(/API key/);
  });

  it('disconnect keeps synced history', () => {
    connect();
    storeActivities([{ id: 1, name: 'x', type: 'Run', sport_type: 'Run', distance: 1, moving_time: 1, elapsed_time: 1,
      start_date: '2024-01-01T00:00:00Z', start_date_local: '2024-01-01T00:00:00Z', kudos_count: 0 }]);
    disconnectSource('intervals');
    expect(isActivitySourceConnected()).toBe(false);
    expect(getStoredActivities()).toHaveLength(1);
  });
});

describe('getActivityExternalUrl', () => {
  it('links to the platform the activity came from', () => {
    expect(getActivityExternalUrl({ id: 1, source: 'intervals', source_id: 'i9' })).toBe('https://intervals.icu/activities/i9');
    expect(getActivityExternalUrl({ id: 77 })).toBe('https://www.strava.com/activities/77');
  });
});

// ── Sync engine ───────────────────────────────────────────────────────────────

describe('syncActivities (intervals.icu)', () => {
  it('imports the full history on first sync, then syncs incrementally', async () => {
    connect();
    const calls = fakeIntervals([
      icu(1, 1),
      icu(2, 2, { type: 'VirtualRide', distance: 30000, moving_time: 3600, trainer: true, source: 'ZWIFT' }),
      icu(3, 3),
      icu(4, 10, { trainer: true }), // treadmill run
      icu(5, 400),                   // more than a year ago
    ], ['i3']);
    const updates: number[] = [];
    const unsubscribe = onActivitiesUpdated((s) => updates.push(s.added));

    const first = await syncActivities();
    unsubscribe();

    // Year windows walk back until 3 consecutive empty years: 2 with data + 3 empty.
    const listCalls = calls.filter((u) => u.pathname.endsWith('/activities'));
    expect(listCalls).toHaveLength(5);
    // Route maps fetched for recent outdoor runs only (not the ride, treadmill or old run).
    const mapCalls = calls.filter((u) => u.pathname.endsWith('/map')).map((u) => u.pathname.split('/')[4]);
    expect(mapCalls.sort()).toEqual(['i1', 'i3']);

    expect(first.full).toBe(true);
    expect(first.errors).toEqual([]);
    expect(first.fetched).toBe(5);
    expect(first.added).toBe(5);
    expect(first.updated).toBe(2);
    expect(updates).toEqual([5]);

    const stored = getStoredActivities();
    expect(stored.map((a) => a.source_id)).toEqual(['i1', 'i2', 'i3', 'i4', 'i5']);
    expect(stored[0].map?.summary_polyline).toBeTruthy();
    expect(stored[2].map?.summary_polyline).toBe(''); // checked: no GPS
    expect(stored[1].type).toBe('VirtualRide');

    const state = getSourceSyncState('intervals');
    expect(state.lastFullSyncAt).not.toBeNull();
    expect(state.newestActivityAt).toBe(icu(1, 1).start_date);
    expect(state.totalFetched).toBe(5);

    // Second sync: one request covering newest activity − 30 days → tomorrow
    // (v1.0.6: was 7 days, which missed activities uploaded more than a week late).
    calls.length = 0;
    const second = await syncActivities();
    expect(second.full).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0].searchParams.get('oldest')).toBe(localDate(daysAgo(31)));
    expect(calls[0].searchParams.get('newest')).toBe(localDate(daysAgo(-1)));
    expect(second.added).toBe(0);
    expect(second.updated).toBe(0);
    expect(getStoredActivities()).toHaveLength(5);
  });

  it('merges into legacy Strava history and stays de-duplicated on later syncs', async () => {
    connect();
    const run = icu(7, 2);
    // Record cached by earlier Apollo versions: Strava ID, no source field.
    storeActivities([{
      id: 987654, name: 'Strava run', type: 'Run', sport_type: 'Run',
      distance: 8030, moving_time: 2410, elapsed_time: 2460,
      start_date: run.start_date!, start_date_local: `${run.start_date_local}Z`, kudos_count: 3,
      map: { id: 'a987654', summary_polyline: '_p~iF~ps|U' },
    }]);
    fakeIntervals([run]);

    const first = await syncActivities();
    expect(first.added).toBe(0);
    expect(first.updated).toBe(1);
    let stored = getStoredActivities();
    expect(stored).toHaveLength(1);
    expect(stored[0].id).toBe(987654);          // plan-day links keep working
    expect(stored[0].source).toBe('intervals');
    expect(stored[0].map?.summary_polyline).toBe('_p~iF~ps|U');

    const second = await syncActivities();
    expect(second.added).toBe(0);
    stored = getStoredActivities();
    expect(stored).toHaveLength(1);
  });

  it('reports a rejected key without throwing from sync, and backs off', async () => {
    connect();
    mockFetch(() => ({ status: 401 }));

    await expect(getActivities()).rejects.toThrow(/rejected the API key/);
    const state = getSourceSyncState('intervals');
    expect(state.lastError).toMatch(/rejected/);
    expect(state.lastFullSyncAt).toBeNull();

    // Within the back-off window, pages read the local store without retrying.
    await expect(getActivities()).resolves.toEqual([]);

    const summary = await syncActivities();
    expect(summary.errors).toHaveLength(1);
    expect(summary.errors[0].source).toBe('intervals');
  });

  it('shares one in-flight sync between callers', async () => {
    connect();
    fakeIntervals([icu(1, 1)]);
    const [a, b] = await Promise.all([syncActivities(), syncActivities()]);
    expect(a).toBe(b);
  });

  it('queues a follow-up sync for a source connected while a sync is running', async () => {
    connect();
    fakeIntervals([icu(1, 1)]);
    const first = syncActivities();
    // e.g. Strava OAuth completing during the launch sync
    setStravaTokens({
      access_token: 'a', refresh_token: 'r', expires_at: Math.floor(Date.now() / 1000) + 3600,
      athlete: { id: 7, firstname: 'S', lastname: 'T' },
    });
    const second = syncActivities();
    expect(second).not.toBe(first);
    const [a, b] = await Promise.all([first, second]);
    expect(a.sources).toEqual(['intervals']);
    expect(b.sources).toContain('strava');
  });

  it('serves pages from the local store when the last sync is fresh', async () => {
    connect();
    fakeIntervals([icu(1, 1), icu(2, 2)]);
    await syncActivities();

    const calls = fakeIntervals([]);
    const page = await getActivities({ page: 1, per_page: 1 });
    expect(page).toHaveLength(1);
    expect(page[0].source_id).toBe('i1');
    expect(calls).toHaveLength(0);
  });

  it('reports whether the last successful sync is fresh enough for a page visit', async () => {
    expect(isActivitySyncFresh()).toBe(false); // never synced
    connect();
    fakeIntervals([icu(1, 1)]);
    await syncActivities();
    expect(isActivitySyncFresh()).toBe(true);
    expect(isActivitySyncFresh(0)).toBe(false);
    expect(PAGE_SYNC_FRESH_MS).toBe(10 * 60 * 1000);
  });
});
