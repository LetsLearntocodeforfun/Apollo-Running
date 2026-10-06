/**
 * Unit tests for cross-training support: load estimates and per-sport
 * summaries (services/crossTraining.ts), plus cross-training in the
 * training-load (analyticsService) and PMC (pmcChart) models.
 */

import { describe, it, expect } from 'vitest';
import type { Activity } from '@/services/activity/types';
import {
  estimateActivityLoad,
  summarizeBySport,
  weeklySportVolume,
  weekStartOf,
  currentWeekRange,
  formatHoursMinutes,
  getCrossTrainingActivities,
} from '@/services/crossTraining';
import { calculateTrainingLoad, type TrainingLoadData } from '@/services/analyticsService';
import { activitiesToDailyLoads } from '@/services/pmcChart';

let nextId = 1;
function act(overrides: Partial<Activity>): Activity {
  return {
    id: nextId++,
    name: 'Session',
    type: 'Run',
    sport_type: overrides.type ?? 'Run',
    distance: 0,
    moving_time: 0,
    elapsed_time: 0,
    start_date: '2024-05-13T12:00:00Z',
    start_date_local: '2024-05-13T07:00:00Z',
    kudos_count: 0,
    ...overrides,
  };
}

function localDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const last = (data: TrainingLoadData[]) => data[data.length - 1];

describe('estimateActivityLoad', () => {
  it('prefers the load computed by the platform', () => {
    expect(estimateActivityLoad(act({ type: 'VirtualRide', moving_time: 3600, training_load: 88 }))).toBe(88);
  });

  it('uses heart rate when max HR is known (hrTSS)', () => {
    // One hour right at threshold HR (≈ 89% of max) scores 100
    expect(estimateActivityLoad(act({ type: 'Ride', moving_time: 3600, average_heartrate: 169.1 }), 190)).toBe(100);
  });

  it('falls back to a typical load per hour for the sport', () => {
    expect(estimateActivityLoad(act({ type: 'Ride', moving_time: 7200 }))).toBe(100);
    expect(estimateActivityLoad(act({ type: 'Walk', moving_time: 3600 }))).toBe(25);
    expect(estimateActivityLoad(act({ type: 'Ride' }))).toBe(0);
  });
});

describe('summarizeBySport', () => {
  it('groups volume by sport within a date range, largest first', () => {
    const list = [
      act({ type: 'Run', moving_time: 3000, distance: 10000, start_date_local: '2024-05-13T07:00:00Z' }),
      act({ type: 'VirtualRide', moving_time: 3600, distance: 30000, training_load: 60, start_date_local: '2024-05-14T18:00:00Z' }),
      act({ type: 'Ride', moving_time: 5400, distance: 45000, training_load: 70, start_date_local: '2024-05-15T09:00:00Z' }),
      act({ type: 'Swim', moving_time: 1800, distance: 1500, start_date_local: '2024-05-20T06:00:00Z' }),
    ];
    const summary = summarizeBySport(list, { from: '2024-05-13', to: '2024-05-19' });
    expect(summary.map((s) => s.category)).toEqual(['ride', 'run']);
    expect(summary[0]).toMatchObject({ label: 'Cycling', count: 2, movingTimeSec: 9000, distanceMeters: 75000, trainingLoad: 130 });
    expect(getCrossTrainingActivities(list)).toHaveLength(3);
  });
});

describe('weekly helpers', () => {
  it('uses Monday-based weeks', () => {
    expect(weekStartOf('2024-05-15')).toBe('2024-05-13'); // Wednesday
    expect(weekStartOf('2024-05-19')).toBe('2024-05-13'); // Sunday
    expect(weekStartOf('2024-05-13')).toBe('2024-05-13');
    expect(currentWeekRange(new Date(2024, 4, 15, 12))).toEqual({ from: '2024-05-13', to: '2024-05-19' });
  });

  it('buckets hours and load per sport, oldest week first', () => {
    const today = localDate(new Date());
    const weeks = weeklySportVolume([
      act({ type: 'VirtualRide', moving_time: 5400, training_load: 75, start_date_local: `${today}T18:00:00Z` }),
      act({ type: 'Run', moving_time: 1800, start_date_local: `${today}T07:00:00Z` }),
    ], 4);
    expect(weeks).toHaveLength(4);
    const current = weeks[3];
    expect(current.weekStart).toBe(weekStartOf(today));
    expect(current.hours.ride).toBe(1.5);
    expect(current.hours.run).toBe(0.5);
    expect(current.crossLoad).toBe(75);
    expect(current.runLoad).toBe(30);
    expect(weeks[0].hours.ride).toBe(0);
  });

  it('formats durations', () => {
    expect(formatHoursMinutes(3900)).toBe('1h 05m');
    expect(formatHoursMinutes(2700)).toBe('45m');
  });
});

describe('cross-training in load models', () => {
  const today = localDate(new Date());
  const run = act({ type: 'Run', distance: 8046.7, moving_time: 2880, start_date_local: `${today}T07:00:00Z` });
  const ride = act({ type: 'VirtualRide', distance: 30000, moving_time: 3600, training_load: 70, start_date_local: `${today}T18:00:00Z` });

  it('counts rides toward acute training load unless disabled', () => {
    const withCross = calculateTrainingLoad([run, ride], 28);
    const runsOnly = calculateTrainingLoad([run, ride], 28, { includeCrossTraining: false });
    expect(last(runsOnly)).toEqual(last(calculateTrainingLoad([run], 28)));
    expect(last(withCross).acute).toBeGreaterThan(last(runsOnly).acute);
  });

  it('keeps PMC loads run-only by default, with opt-in cross-training', () => {
    const runOnly = activitiesToDailyLoads([run]);
    expect(activitiesToDailyLoads([run, ride])).toEqual(runOnly);
    const combined = activitiesToDailyLoads([run, ride], { includeCrossTraining: true });
    expect(combined).toHaveLength(1);
    expect(combined[0].tss).toBeCloseTo(runOnly[0].tss + 70, 5);
    expect(combined[0].distanceMi).toBeCloseTo(runOnly[0].distanceMi, 5);
  });
});
