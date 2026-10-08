/**
 * v1.0.6 (A3) effort-recognition rebuild job: rebuilds over visible runs only,
 * records the algorithm version, is single-flight, and the scheduler debounces.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { persistence } from '@/services/db/persistence';
import { storeActivities } from '@/services/analyticsService';
import { hideActivity } from '@/services/activity/manage';
import {
  EFFORT_ALGO_VERSION,
  EFFORT_META_KEY,
  needsEffortRebuild,
  rebuildEffortRecognitions,
  scheduleEffortRebuild,
} from '@/services/effortService';
import type { Activity } from '@/services/activity/types';

function run(id: number, day: number): Activity {
  const iso = `2026-09-${String(day).padStart(2, '0')}T07:00:00Z`;
  return {
    id, name: `Run ${id}`, type: 'Run', sport_type: 'Run', distance: 8000, moving_time: 2700, elapsed_time: 2700,
    start_date: iso, start_date_local: iso, kudos_count: 0, source: 'intervals', source_id: `e${id}`,
  };
}

beforeEach(() => {
  persistence.clear();
  storeActivities([run(1, 1), run(2, 2), run(3, 3)]);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('effort recognition rebuild', () => {
  it('rebuilds over visible runs only and records the algorithm version', async () => {
    hideActivity(2);
    expect(needsEffortRebuild()).toBe(true);
    expect(await rebuildEffortRecognitions()).toEqual({ processed: 2 });
    expect(needsEffortRebuild()).toBe(false);
    expect(JSON.parse(persistence.getItem(EFFORT_META_KEY)!)).toMatchObject({ algoVersion: EFFORT_ALGO_VERSION, processed: 2 });
  });

  it('is single-flight: overlapping calls share one run (plus one queued pass)', async () => {
    const [a, b] = await Promise.all([rebuildEffortRecognitions(), rebuildEffortRecognitions()]);
    expect(a).toEqual({ processed: 3 });
    expect(b).toEqual({ processed: 3 });
  });

  it('scheduleEffortRebuild debounces bursts into one rebuild after 500 ms', async () => {
    vi.useFakeTimers();
    scheduleEffortRebuild();
    scheduleEffortRebuild();
    await vi.advanceTimersByTimeAsync(400);
    scheduleEffortRebuild();
    await vi.advanceTimersByTimeAsync(499);
    expect(needsEffortRebuild()).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(needsEffortRebuild()).toBe(false));
  });
});
