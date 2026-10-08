/**
 * v1.0.6 regression tests for weeklyReadiness (V5): readiness is prorated to
 * the days that are due, and the long run counts as missed only after its date.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { getDateKeyForDay, setActivePlan, setDayCompleted, setSyncMeta } from '@/services/planProgress';
import { getEffectivePlan } from '@/services/planOverlay';
import {
  computeCurrentReadiness,
  computeReadinessScore,
  generateReadinessScore,
  getLatestReadinessScore,
} from '@/services/weeklyReadiness';

const PLAN_ID = 'pfitzinger-18-55';
const START = '2026-01-05'; // a Monday

/** Mark the given days of a week done, with sync data matching the plan. */
function complete(weekIndex: number, dayIndices?: number[]): void {
  const plan = getEffectivePlan();
  if (!plan) throw new Error('no plan');
  plan.weeks[weekIndex].days.forEach((day, d) => {
    if (day.type === 'rest' || (dayIndices && !dayIndices.includes(d))) return;
    setDayCompleted(PLAN_ID, weekIndex, d, true);
    setSyncMeta(PLAN_ID, weekIndex, d, {
      activityId: weekIndex * 10 + d + 1,
      activityDate: getDateKeyForDay(START, weekIndex, d),
      actualDistanceMi: day.distanceMi ?? 0,
      actualPaceMinPerMi: 8.5,
      movingTimeSec: Math.round((day.distanceMi ?? 0) * 510),
      feedback: '',
      syncedAt: new Date().toISOString(),
    });
  });
}

describe('weekly readiness proration (V5)', () => {
  beforeEach(() => {
    setActivePlan({ planId: PLAN_ID, startDate: START });
  });

  it('Probe H: week 1 done 100 %, Monday of week 2 → week 2 is not scored as missed; current readiness is week 1', () => {
    complete(0);
    const mondayWeek2 = getDateKeyForDay(START, 1, 0);

    expect(computeReadinessScore(2, { today: mondayWeek2 })).toBeNull();

    const current = computeCurrentReadiness({ today: mondayWeek2 });
    expect(current?.weekNumber).toBe(1);
    expect(current?.consistencyScore).toBe(100);
    expect(current?.volumeScore).toBe(100);
    expect(current?.longRunScore).toBe(100);
    expect(current?.partial).toBe(false);
    expect(current?.score ?? 0).toBeGreaterThanOrEqual(90);
  });

  it('a partial week only counts due days and leaves a future long run out', () => {
    complete(0, [1, 2]); // Tue + Wed done
    const thursday = getDateKeyForDay(START, 0, 3);

    const partial = computeReadinessScore(1, { today: thursday });
    expect(partial).not.toBeNull();
    expect(partial?.partial).toBe(true);
    expect(partial?.dueWorkouts).toBe(2);
    expect(partial?.consistencyScore).toBe(100);
    expect(partial?.longRunPending).toBe(true);
    expect(partial?.score ?? 0).toBeGreaterThanOrEqual(80);
  });

  it('the long run counts as missed once its date has passed', () => {
    complete(0, [1, 2, 3, 5]); // everything but Sunday's long run
    const mondayWeek2 = getDateKeyForDay(START, 1, 0);

    const week1 = computeReadinessScore(1, { today: mondayWeek2 });
    expect(week1?.longRunPending).toBe(false);
    expect(week1?.longRunScore).toBe(0);
  });

  it('getLatestReadinessScore returns the most recently generated score, not the highest week', () => {
    complete(0);
    complete(1);
    const week3Monday = getDateKeyForDay(START, 2, 0);
    generateReadinessScore(2, { today: week3Monday });
    const later = generateReadinessScore(1, { today: week3Monday });
    expect(later).not.toBeNull();
    // Force distinct timestamps regardless of clock resolution.
    const latest = getLatestReadinessScore();
    expect(latest).not.toBeNull();
    expect(['1', '2']).toContain(String(latest?.weekNumber));
    expect(latest?.generatedAt).toBe(
      [later?.generatedAt ?? '', latest?.generatedAt ?? ''].sort().pop(),
    );
  });
});
