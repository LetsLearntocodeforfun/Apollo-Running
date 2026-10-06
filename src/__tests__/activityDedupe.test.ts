/**
 * Unit tests for cross-source de-duplication (activity/dedupe.ts) and the
 * merge-aware activity store (analyticsService.storeActivities).
 *
 * The same workout can arrive from Strava and from intervals.icu (which
 * relays Garmin/Zwift uploads); it must be stored once, keep a stable ID,
 * and prefer intervals.icu's richer fields.
 */

import { describe, it, expect, vi } from 'vitest';
import type { Activity } from '@/services/activity/types';
import { isSameActivity, mergeActivity, mergeIntoStore } from '@/services/activity/dedupe';
import { storeActivities, getStoredActivities, MAX_STORED_ACTIVITIES } from '@/services/analyticsService';

function act(overrides: Partial<Activity> = {}): Activity {
  return {
    id: 1,
    name: 'Morning Run',
    type: 'Run',
    sport_type: 'Run',
    distance: 10000,
    moving_time: 3000,
    elapsed_time: 3100,
    start_date: '2024-05-12T12:00:00Z',
    start_date_local: '2024-05-12T07:00:00Z',
    kudos_count: 0,
    ...overrides,
  };
}

const stravaRun = act({ id: 111, source: 'strava', source_id: '111', average_heartrate: 150 });
const icuRun = act({
  id: 100000000000123,
  source: 'intervals',
  source_id: 'i123',
  start_date: '2024-05-12T12:00:40Z',
  distance: 10080,
  name: 'Tempo Tuesday',
  training_load: 72,
  average_heartrate: undefined,
});

describe('isSameActivity', () => {
  it('matches the same workout from two sources', () => {
    expect(isSameActivity(stravaRun, icuRun)).toBe(true);
  });

  it('never merges two activities from the same source', () => {
    expect(isSameActivity(stravaRun, act({ id: 222, source: 'strava' }))).toBe(false);
  });

  it('treats legacy records (no source) as Strava', () => {
    const legacy = act({ id: 111 });
    expect(isSameActivity(legacy, act({ id: 333, source: 'strava' }))).toBe(false);
    expect(isSameActivity(legacy, icuRun)).toBe(true);
  });

  it('requires starts within 2 minutes', () => {
    expect(isSameActivity(stravaRun, { ...icuRun, start_date: '2024-05-12T12:03:00Z' })).toBe(false);
  });

  it('requires similar distance', () => {
    expect(isSameActivity(stravaRun, { ...icuRun, distance: 12000 })).toBe(false);
    // max(100 m, 3%) tolerance
    expect(isSameActivity(stravaRun, { ...icuRun, distance: 10290 })).toBe(true);
  });

  it('compares duration for distance-less sessions', () => {
    const a = act({ id: 1, type: 'WeightTraining', distance: 0, moving_time: 2700, source: 'strava' });
    const b = act({ id: 2, type: 'WeightTraining', distance: 0, moving_time: 2760, source: 'intervals' });
    const c = act({ id: 3, type: 'WeightTraining', distance: 0, moving_time: 4000, source: 'intervals' });
    expect(isSameActivity(a, b)).toBe(true);
    expect(isSameActivity(a, c)).toBe(false);
  });
});

describe('mergeActivity', () => {
  it('keeps the existing ID and lets intervals.icu fields win', () => {
    const merged = mergeActivity(stravaRun, icuRun);
    expect(merged.id).toBe(111);
    expect(merged.source).toBe('intervals');
    expect(merged.source_id).toBe('i123');
    expect(merged.name).toBe('Tempo Tuesday');
    expect(merged.training_load).toBe(72);
    // Missing incoming values never erase known ones
    expect(merged.average_heartrate).toBe(150);
  });

  it('only fills gaps when the incoming source has lower priority', () => {
    const merged = mergeActivity(icuRun, { ...stravaRun, name: 'Strava title', suffer_score: 40 });
    expect(merged.id).toBe(icuRun.id);
    expect(merged.name).toBe('Tempo Tuesday');
    expect(merged.source).toBe('intervals');
    expect(merged.suffer_score).toBe(40);
    expect(merged.average_heartrate).toBe(150);
  });

  it('never replaces a known route with an empty one', () => {
    const withRoute = { ...stravaRun, map: { id: 'a1', summary_polyline: '_p~iF~ps|U' } };
    const merged = mergeActivity(withRoute, { ...icuRun, map: { id: 'icu-i123', summary_polyline: '' } });
    expect(merged.map?.summary_polyline).toBe('_p~iF~ps|U');
  });

  it('lets a file copy fill gaps in a legacy Strava record without changing its identity', () => {
    const legacy = act({ id: 111, name: 'Strava title' }); // pre-migration record: no source
    const file = act({
      id: 300000000000000 + 1715515200, source: 'file', source_id: 'run.fit', origin: 'GARMIN',
      name: 'Imported run', average_cadence: 86, device_name: 'Garmin Forerunner 965',
    });
    const merged = mergeActivity(legacy, file);
    expect(merged.id).toBe(111);
    expect(merged.source).toBeUndefined(); // still a (legacy) Strava activity
    expect(merged.source_id).toBeUndefined();
    expect(merged.origin).toBeUndefined();
    expect(merged.name).toBe('Strava title');
    expect(merged.average_cadence).toBe(86); // gaps are filled
    expect(merged.device_name).toBe('Garmin Forerunner 965');

    // Re-importing the same file changes nothing.
    const first = mergeIntoStore([legacy], [file]);
    expect(first.updated).toBe(1);
    const again = mergeIntoStore(first.activities, [{ ...file, name: 'Renamed file' }]);
    expect(again.added).toBe(0);
    expect(again.updated).toBe(0);
    expect(again.activities[0].name).toBe('Strava title');
  });
});

describe('mergeIntoStore', () => {
  it('adds new activities, merges duplicates and sorts newest first', () => {
    const older = act({ id: 5, source: 'strava', start_date: '2024-05-01T12:00:00Z', start_date_local: '2024-05-01T07:00:00Z' });
    const r = mergeIntoStore([older, stravaRun], [icuRun, act({
      id: 100000000000999, source: 'intervals', source_id: 'i999', type: 'VirtualRide', distance: 30000,
      start_date: '2024-05-13T23:00:00Z', start_date_local: '2024-05-13T18:00:00Z',
    })]);
    expect(r.added).toBe(1);
    expect(r.updated).toBe(1);
    expect(r.activities.map((a) => a.id)).toEqual([100000000000999, 111, 5]);
  });

  it('reports no changes when re-ingesting identical data', () => {
    const first = mergeIntoStore([], [icuRun]);
    const again = mergeIntoStore(first.activities, [icuRun]);
    expect(again.added).toBe(0);
    expect(again.updated).toBe(0);
  });

  it('counts two copies of a new workout in one batch as one added, not updated', () => {
    // e.g. the FIT and the GPX of the same run dropped together
    const fit = act({ id: 300000000000001, source: 'file', source_id: 'run.fit', average_cadence: 86 });
    const gpx = act({ id: 300000000000002, source: 'file', source_id: 'run.gpx', average_heartrate: 151 });
    const r = mergeIntoStore([], [fit, gpx]);
    expect(r.added).toBe(1);
    expect(r.updated).toBe(0);
    expect(r.activities).toHaveLength(1);
    expect(r.activities[0].average_cadence).toBe(86);
    expect(r.activities[0].average_heartrate).toBe(151); // still merged

    // A copy of something stored before this call is still an update.
    const later = mergeIntoStore(r.activities, [{ ...icuRun, id: 100000000000777, source_id: 'i777' }]);
    expect(later.added).toBe(0);
    expect(later.updated).toBe(1);
  });
});

describe('storeActivities', () => {
  it('stores each workout once across sources and returns counts', () => {
    expect(storeActivities([stravaRun])).toEqual({ added: 1, updated: 0, dropped: 0 });
    expect(storeActivities([icuRun])).toEqual({ added: 0, updated: 1, dropped: 0 });
    expect(storeActivities([icuRun])).toEqual({ added: 0, updated: 0, dropped: 0 });

    const stored = getStoredActivities();
    expect(stored).toHaveLength(1);
    expect(stored[0].id).toBe(111);
    expect(stored[0].source).toBe('intervals');
  });

  it('returns defensive copies of the cached list', () => {
    storeActivities([stravaRun]);
    const a = getStoredActivities();
    a.pop();
    expect(getStoredActivities()).toHaveLength(1);
  });

  it(`keeps the newest ${MAX_STORED_ACTIVITIES} activities and reports how many older ones it dropped`, () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const day = 86400 * 1000;
    const base = Date.UTC(2015, 0, 1, 12);
    const run = (i: number): Activity => {
      const iso = new Date(base + i * day).toISOString();
      return act({ id: 1000 + i, source: 'intervals', source_id: `i${i}`, start_date: iso, start_date_local: iso });
    };
    const first = Array.from({ length: MAX_STORED_ACTIVITIES - 1 }, (_, i) => run(i + 2));
    expect(storeActivities(first)).toEqual({ added: MAX_STORED_ACTIVITIES - 1, updated: 0, dropped: 0 });
    expect(warn).not.toHaveBeenCalled();

    // One newer and two older than everything stored: the two oldest go.
    const r = storeActivities([run(MAX_STORED_ACTIVITIES + 5), run(0), run(1)]);
    expect(r).toEqual({ added: 3, updated: 0, dropped: 2 });
    const stored = getStoredActivities();
    expect(stored).toHaveLength(MAX_STORED_ACTIVITIES);
    expect(stored[0].id).toBe(1000 + MAX_STORED_ACTIVITIES + 5);
    expect(stored[stored.length - 1].id).toBe(1002);
    expect(stored.some((a) => a.id === 1000 || a.id === 1001)).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('removed 2 older activities');
    warn.mockRestore();
  });
});
