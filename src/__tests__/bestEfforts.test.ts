/**
 * v1.0.6 (A3, B1) best efforts: records come from the fastest effort INSIDE a
 * run (splits, interpolated), the whole-activity fallback only counts within
 * 2 % of the distance, and treadmill / virtual runs never set records.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { persistence } from '@/services/db/persistence';
import { detectPersonalRecords } from '@/services/analyticsService';
import {
  bestEffortsFromSamples,
  bestEffortsFromSplits,
  detectPersonalRecordsFromEfforts,
  getActivityBestEfforts,
} from '@/services/bestEfforts';
import type { Activity, ActivitySplit } from '@/services/activity/types';

function run(id: number, day: number, distance: number, elapsed: number, extra: Partial<Activity> = {}): Activity {
  const iso = `2026-09-${String(day).padStart(2, '0')}T07:00:00Z`;
  return {
    id,
    name: `Run ${id}`,
    type: 'Run',
    sport_type: 'Run',
    distance,
    moving_time: elapsed,
    elapsed_time: elapsed,
    start_date: iso,
    start_date_local: iso,
    kudos_count: 0,
    source: 'intervals',
    source_id: `b${id}`,
    ...extra,
  };
}

function splits(parts: [number, number][]): ActivitySplit[] {
  return parts.map(([distance, sec], i) => ({
    distance, elapsed_time: sec, moving_time: sec, average_speed: distance / sec, elevation_difference: 0, split: i + 1,
  }));
}

beforeEach(() => persistence.clear());

describe('best efforts (B1)', () => {
  it('a 41:40 10K beats a faster-paced 10.9 km run that has no 10K split data', () => {
    const tenK = run(1, 1, 10000, 2500); // 41:40
    const longer = run(2, 2, 10900, 2600); // faster pace, but 9 % long and no splits
    const prs = detectPersonalRecords([tenK, longer]);
    const pr = prs.find((p) => p.label === '10K')!;
    expect(pr.activityId).toBe(1);
    expect(pr.numericValue).toBe(2500);
    expect(pr.value).toBe('41:40');
    // The old bucket logic credited the 10.9 km run's full 43:20 as a "10K".
    expect(getActivityBestEfforts(longer).some((e) => e.key === '10k')).toBe(false);
  });

  it('finds the 10K inside a half marathon', () => {
    // km 1–5 at 5:00, km 6–15 at 4:10, km 16–21 at 5:00, then the last 97.5 m.
    const parts: [number, number][] = [];
    for (let k = 1; k <= 21; k++) parts.push([1000, k >= 6 && k <= 15 ? 250 : 300]);
    parts.push([97.5, 30]);
    const half = run(3, 3, 21097.5, 5 * 300 + 10 * 250 + 6 * 300 + 30, { splits_metric: splits(parts) });
    const race10k = run(4, 4, 10000, 2550);
    const prs = detectPersonalRecordsFromEfforts([half, race10k]);
    const tenK = prs.find((p) => p.key === '10k')!;
    expect(tenK.activity.id).toBe(3);
    expect(tenK.elapsedSec).toBeCloseTo(2500, 6);
    expect(getActivityBestEfforts(half).find((e) => e.key === '10k')!.startM).toBeCloseTo(5000, 6);
    expect(prs.find((p) => p.key === 'hm')!.elapsedSec).toBeCloseTo(half.elapsed_time, 6);
  });

  it('treadmill and virtual runs never set records', () => {
    const outdoor = run(5, 5, 5000, 1200);
    const treadmill = run(6, 6, 5000, 900, { trainer: true });
    const virtual = run(7, 7, 5000, 950, { type: 'VirtualRun', sport_type: 'VirtualRun' });
    const pr = detectPersonalRecords([outdoor, treadmill, virtual]).find((p) => p.label === '5K')!;
    expect(pr.activityId).toBe(5);
    expect(detectPersonalRecordsFromEfforts([outdoor, treadmill], { includeIndoor: true })
      .find((p) => p.key === '5k')!.activity.id).toBe(6);
  });

  it('interpolates the partial last split', () => {
    // Five 5:00 km, then a fast last 100 m in 20 s: the best 5K ends at the finish and starts 100 m in.
    const efforts = bestEffortsFromSplits(splits([[1000, 300], [1000, 300], [1000, 300], [1000, 300], [1000, 300], [100, 20]]));
    const fiveK = efforts.find((e) => e.key === '5k')!;
    expect(fiveK.elapsedSec).toBeCloseTo(1490, 6); // 1520 − 30 s for the first 100 m
    expect(fiveK.startM).toBeCloseTo(100, 6);
    expect(efforts.find((e) => e.key === '1k')!.elapsedSec).toBeCloseTo(290, 6); // 900 m at 5:00/km (270 s) + 20 s
  });

  it('uses the whole activity only within 2 % of the distance, scaled to exactly that distance', () => {
    const slightlyLong = getActivityBestEfforts(run(8, 8, 5050, 1515)).find((e) => e.key === '5k')!;
    expect(slightlyLong.source).toBe('activity');
    expect(slightlyLong.elapsedSec).toBeCloseTo(1500, 6);
    expect(getActivityBestEfforts(run(9, 9, 5150, 1545)).some((e) => e.key === '5k')).toBe(false);
  });

  it('finds the fastest window in distance/time samples', () => {
    // 3 m/s for 2000 s, then 4 m/s for 500 s: the best 1K takes 250 s.
    const samples: { timeSec: number; distanceM: number }[] = [];
    for (let s = 0; s <= 2500; s += 5) samples.push({ timeSec: s, distanceM: s <= 2000 ? s * 3 : 6000 + (s - 2000) * 4 });
    const oneK = bestEffortsFromSamples(samples).find((e) => e.key === '1k')!;
    expect(oneK.source).toBe('stream');
    expect(oneK.elapsedSec).toBeCloseTo(250, 6);
  });
});
