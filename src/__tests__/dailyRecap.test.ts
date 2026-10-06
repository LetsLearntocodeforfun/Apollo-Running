/**
 * Daily recap tests.
 *
 * Regression coverage for the journal-aware coach message: the journal fields
 * used to be read before their `let` declarations (TDZ ReferenceError), so
 * `generateDailyRecap` threw for every planned day and no recap was ever stored.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { generateDailyRecap, getDailyRecap } from '@/services/dailyRecap';
import { setActivePlan, setSyncMeta, setDayCompleted, getDateForDay, formatDateKey } from '@/services/planProgress';
import { getPlanById } from '@/data/plans';
import { enableJournal, saveJournalEntry } from '@/services/trainingJournal';
import { persistence } from '@/services/db/persistence';

const PLAN_ID = 'hal-higdon-novice-1';
const START_DATE = '2026-01-05';

/** First run day with a planned distance in the plan. */
function firstRunDay() {
  const plan = getPlanById(PLAN_ID)!;
  for (let w = 0; w < plan.weeks.length; w++) {
    for (let d = 0; d < plan.weeks[w].days.length; d++) {
      const day = plan.weeks[w].days[d];
      if (day.type === 'run' && (day.distanceMi ?? 0) > 0) {
        return { w, d, day, date: formatDateKey(getDateForDay(START_DATE, w, d)) };
      }
    }
  }
  throw new Error('plan has no run day with a distance');
}

beforeEach(() => {
  persistence.clear();
  setActivePlan({ planId: PLAN_ID, startDate: START_DATE });
});

describe('generateDailyRecap', () => {
  it('returns null without an active plan', () => {
    setActivePlan(null);
    expect(generateDailyRecap(START_DATE)).toBeNull();
  });

  it('grades an unsynced, incomplete run day as missed and stores the recap', () => {
    const { date } = firstRunDay();
    const recap = generateDailyRecap(date);
    expect(recap).not.toBeNull();
    expect(recap!.grade).toBe('missed');
    expect(recap!.synced).toBe(false);
    expect(getDailyRecap(date)?.date).toBe(date);
  });

  it('builds a journal-aware coach message when the journal is enabled', () => {
    const { w, d, day, date } = firstRunDay();
    const planned = day.distanceMi!;
    setSyncMeta(PLAN_ID, w, d, {
      activityId: 1,
      activitySource: 'intervals',
      actualDistanceMi: planned,
      actualPaceMinPerMi: 10,
      movingTimeSec: Math.round(planned * 600),
      feedback: '',
      syncedAt: new Date().toISOString(),
    });
    setDayCompleted(PLAN_ID, w, d, true);
    enableJournal();
    saveJournalEntry(date, { mood: 2, energy: 2, sleepHours: 5, rpe: 6, notes: 'Heavy legs' });

    const recap = generateDailyRecap(date);
    expect(recap).not.toBeNull();
    expect(recap!.grade).toBe('strong');
    expect(recap!.metPlan).toBe(true);
    expect(recap!.journalMood).toBe(2);
    expect(recap!.journalEnergy).toBe(2);
    expect(recap!.journalSleepHours).toBe(5);
    expect(recap!.journalRPE).toBe(6);
    expect(recap!.journalNotes).toBe('Heavy legs');
    expect(recap!.coachMessage).toContain('still hit your targets');
    expect(recap!.coachMessage).toContain('Short sleep');
    expect(recap!.coachMessage).toContain('Tough mental day');
  });

  it('ignores journal data while the journal is disabled', () => {
    const { date } = firstRunDay();
    saveJournalEntry(date, { mood: 1, energy: 1, sleepHours: 4 });
    const recap = generateDailyRecap(date);
    expect(recap).not.toBeNull();
    expect(recap!.journalMood).toBeUndefined();
    expect(recap!.coachMessage).not.toContain('Short sleep');
  });

  it('uses sleep synced from the watch (intervals.icu wellness) when there is no journal entry', () => {
    const { w, d, day, date } = firstRunDay();
    const planned = day.distanceMi!;
    setSyncMeta(PLAN_ID, w, d, {
      activityId: 1,
      activitySource: 'intervals',
      actualDistanceMi: planned,
      actualPaceMinPerMi: 10,
      movingTimeSec: Math.round(planned * 600),
      feedback: '',
      syncedAt: new Date().toISOString(),
    });
    setDayCompleted(PLAN_ID, w, d, true);
    persistence.setItem('apollo_wellness', JSON.stringify({ [date]: { date, sleepSecs: 5 * 3600 } }));

    const recap = generateDailyRecap(date);
    expect(recap).not.toBeNull();
    expect(recap!.journalSleepHours).toBeUndefined(); // not a journal value
    expect(recap!.coachMessage).toContain('Short sleep');
  });
});
