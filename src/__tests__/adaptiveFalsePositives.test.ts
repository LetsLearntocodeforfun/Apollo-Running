/**
 * v1.0.6 regression tests for adaptiveTraining (V5): a perfect week followed
 * by Monday must not produce a "behind schedule" card.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getDateKeyForDay, setActivePlan, setDayCompleted, setSyncMeta } from '@/services/planProgress';
import { getEffectivePlan } from '@/services/planOverlay';
import { analyzeTrainingProgress } from '@/services/adaptiveTraining';
import { parseDateKey } from '@/utils/localDate';

const PLAN_ID = 'pfitzinger-18-55';
const START = '2026-01-05'; // a Monday

function completeWeek(weekIndex: number): void {
  const plan = getEffectivePlan();
  if (!plan) throw new Error('no plan');
  plan.weeks[weekIndex].days.forEach((day, d) => {
    if (day.type === 'rest') return;
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

function setToday(dateKey: string, hour = 9): void {
  const d = parseDateKey(dateKey);
  d.setHours(hour, 0, 0, 0);
  vi.setSystemTime(d);
}

describe('adaptive coaching false positives (V5)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    setToday(START);
    setActivePlan({ planId: PLAN_ID, startDate: START });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('Probe H: Pfitzinger 18/55, week 1 done 100 %, Monday of week 2 → no behind_schedule', () => {
    completeWeek(0);
    setToday(getDateKeyForDay(START, 1, 0)); // Monday of week 2

    const result = analyzeTrainingProgress(true);
    expect(result).not.toBeNull();
    expect(result?.detectedScenarios.map((s) => s.scenario)).not.toContain('behind_schedule');
    expect(result?.recommendations.map((r) => r.scenario)).not.toContain('behind_schedule');
  });

  it('today\'s key workout is not counted as missed (Saturday morning, week 1 on track)', () => {
    const plan = getEffectivePlan();
    if (!plan) throw new Error('no plan');
    // Tue–Thu done; today is Saturday (marathon-pace day), long run tomorrow.
    [1, 2, 3].forEach((d) => setDayCompleted(PLAN_ID, 0, d, true));
    setToday(getDateKeyForDay(START, 0, 5));

    const result = analyzeTrainingProgress(true);
    expect(result?.stats.missedKeyWorkoutsLast2Weeks ?? 0).toBe(0);
    expect(result?.detectedScenarios.map((s) => s.scenario) ?? []).not.toContain('behind_schedule');
  });
});
