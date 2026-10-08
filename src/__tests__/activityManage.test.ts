/**
 * v1.0.6 (A3, B18): hide / unhide / delete with tombstones, duplicate
 * candidates (same source allowed) and hidden runs excluded from analytics.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { persistence } from '@/services/db/persistence';
import {
  storeActivities,
  getStoredActivities,
  getAllStoredActivities,
  calculateWeeklyMileage,
  detectPersonalRecords,
} from '@/services/analyticsService';
import {
  hideActivity,
  unhideActivity,
  deleteActivity,
  isActivityHidden,
  getHiddenActivities,
  getDuplicateCandidates,
  mergeDuplicate,
  keepBothDuplicates,
} from '@/services/activity/manage';
import { findDuplicateCandidates, mergeIntoStore } from '@/services/activity/dedupe';
import { createTombstoneSet, TOMBSTONES_KEY } from '@/services/activity/tombstones';
import type { Activity } from '@/services/activity/types';

function run(id: number, startIso: string, distance: number, moving: number, extra: Partial<Activity> = {}): Activity {
  return {
    id,
    name: `Run ${id}`,
    type: 'Run',
    sport_type: 'Run',
    distance,
    moving_time: moving,
    elapsed_time: moving,
    start_date: startIso,
    start_date_local: startIso,
    kudos_count: 0,
    source: 'intervals',
    source_id: `i${id}`,
    ...extra,
  };
}

beforeEach(() => {
  persistence.clear();
});

describe('hide / unhide', () => {
  it('hidden runs stay stored but are excluded from getStoredActivities, weekly mileage and PRs', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-07T12:00:00'));
    try {
      storeActivities([
        run(1, '2026-10-05T07:00:00Z', 10000, 2500),
        run(2, '2026-10-06T07:00:00Z', 10000, 2300), // faster 10K, will be hidden
      ]);
      expect(hideActivity(2).ok).toBe(true);
      expect(isActivityHidden(2)).toBe(true);
      expect(getStoredActivities().map((a) => a.id)).toEqual([1]);
      expect(getAllStoredActivities().map((a) => a.id)).toEqual([2, 1]);
      expect(getHiddenActivities().map((a) => a.id)).toEqual([2]);

      const all = getAllStoredActivities();
      const week = calculateWeeklyMileage(all, 2);
      const total = week.reduce((s, w) => s + w.miles, 0);
      expect(total).toBeCloseTo(6.2, 1); // only run 1
      const tenK = detectPersonalRecords(all).find((p) => p.label === '10K');
      expect(tenK?.activityId).toBe(1);

      expect(unhideActivity(2).ok).toBe(true);
      expect(isActivityHidden(2)).toBe(false);
      expect(getStoredActivities()).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a re-sync merges into the hidden record and keeps it hidden', () => {
    storeActivities([run(1, '2026-10-05T07:00:00Z', 10000, 2500)]);
    hideActivity(1);
    storeActivities([run(1, '2026-10-05T07:00:00Z', 10000, 2500, { name: 'Renamed upstream' })]);
    const rec = getAllStoredActivities()[0];
    expect(rec.hidden).toBe(true);
    expect(rec.name).toBe('Renamed upstream');
    expect(getStoredActivities()).toHaveLength(0);
  });
});

describe('delete with tombstones', () => {
  it('a deleted activity is not resurrected by a re-sync from the same source', () => {
    storeActivities([run(1, '2026-10-05T07:00:00Z', 10000, 2500)]);
    expect(deleteActivity(1).ok).toBe(true);
    expect(getAllStoredActivities()).toHaveLength(0);
    expect(JSON.parse(persistence.getItem(TOMBSTONES_KEY) ?? '[]')).toEqual(['intervals:i1']);

    const r = storeActivities([run(1, '2026-10-05T07:00:00Z', 10000, 2500)]);
    expect(r.added).toBe(0);
    expect(r.skippedDeleted).toBe(1);
    expect(getAllStoredActivities()).toHaveLength(0);
  });

  it('nor by a re-import of the same file or another source\'s copy', () => {
    const fileRun = run(5, '2026-10-01T06:00:00Z', 12000, 3600, { source: 'file', source_id: 'file:1759298400' });
    storeActivities([fileRun]);
    deleteActivity(5);
    // Same file again (fresh ID, same deterministic source_id).
    expect(storeActivities([{ ...fileRun, id: 99 }]).skippedDeleted).toBe(1);
    // The same workout from Strava (different source key, 30 s later): blocked by the fingerprint.
    const stravaCopy = run(77, '2026-10-01T06:00:30Z', 12050, 3590, { source: 'strava', source_id: '77' });
    expect(storeActivities([stravaCopy]).skippedDeleted).toBe(1);
    expect(getAllStoredActivities()).toHaveLength(0);
    // An unrelated run still syncs.
    expect(storeActivities([run(8, '2026-10-02T06:00:00Z', 5000, 1500)]).added).toBe(1);
  });

  it('fingerprints never block updates to a record that is still stored', () => {
    const tomb = createTombstoneSet(['intervals:i2'], [{ t: Date.parse('2026-10-01T06:00:00Z') / 1000, d: 10000 }]);
    const kept = run(1, '2026-10-01T06:00:10Z', 10010, 3000);
    const r = mergeIntoStore([kept], [{ ...kept, name: 'Updated' }], { tombstones: tomb });
    expect(r.updated).toBe(1);
    expect(r.skippedDeleted).toBe(0);
  });

  it('returns an error for unknown IDs', () => {
    expect(deleteActivity(123).ok).toBe(false);
    expect(hideActivity(123).ok).toBe(false);
  });
});

describe('duplicate candidates', () => {
  it('detects a Garmin virtual run and its Zwift copy from the same source', () => {
    const garmin = run(1, '2026-10-03T18:00:00Z', 8000, 2700, {
      type: 'VirtualRun', sport_type: 'VirtualRun', origin: 'GARMIN_CONNECT', average_heartrate: 150, trainer: true,
    });
    const zwift = run(2, '2026-10-03T18:01:10Z', 8150, 2690, {
      type: 'Run', sport_type: 'VirtualRun', origin: 'ZWIFT', trainer: true,
    });
    const ride = run(3, '2026-10-03T18:00:30Z', 8100, 2700, { type: 'Ride', sport_type: 'Ride' });
    const pairs = findDuplicateCandidates([garmin, zwift, ride]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].keep.id).toBe(1); // has HR
    expect(pairs[0].drop.id).toBe(2);
  });

  it('ignores pairs beyond 120 s or 3 % distance', () => {
    const a = run(1, '2026-10-03T18:00:00Z', 8000, 2700);
    expect(findDuplicateCandidates([a, run(2, '2026-10-03T18:02:30Z', 8000, 2700)])).toHaveLength(0);
    expect(findDuplicateCandidates([a, run(3, '2026-10-03T18:00:20Z', 8400, 2700)])).toHaveLength(0);
  });

  it('merge hides the lesser record; keep both is remembered', () => {
    // Two intervals.icu records of one workout (different provider IDs) both reach the store.
    storeActivities([
      run(1, '2026-10-03T18:00:00Z', 8000, 2700, { average_heartrate: 150 }),
      run(2, '2026-10-03T18:00:40Z', 8050, 2700),
      run(3, '2026-10-04T18:00:00Z', 5000, 1500),
      run(4, '2026-10-04T18:00:30Z', 5020, 1500),
    ]);
    const pairs = getDuplicateCandidates();
    expect(pairs).toHaveLength(2);
    const first = pairs.find((p) => p.keep.id === 1 || p.drop.id === 1)!;
    expect(mergeDuplicate(first.keep.id, first.drop.id).ok).toBe(true);
    const hidden = getAllStoredActivities().find((a) => a.id === first.drop.id)!;
    expect(hidden.hidden).toBe(true);
    expect(hidden.hidden_reason).toBe('duplicate');
    expect(hidden.duplicate_of).toBe(first.keep.id);

    keepBothDuplicates(3, 4);
    expect(getDuplicateCandidates()).toHaveLength(0);
  });
});
