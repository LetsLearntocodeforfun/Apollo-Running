/**
 * Plan engine (T2a, v1.0.6): DST-safe plan grid, race-date-first placement,
 * plan overlay and journey state. Written to pass in any TZ (LA, London, Sydney).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  getActivePlan,
  getActivePlanInstanceId,
  getDateForDay,
  getDateKeyForDay,
  getRaceDayRef,
  getWeekDayForDate,
  isDayCompleted,
  placePlan,
  previewStartPlan,
  setActivePlan,
  setDayCompleted,
  setSyncMeta,
  getSyncMeta,
  snapToMonday,
  startPlan,
  formatDateKey,
  canToggleDayCompletion,
} from '@/services/planProgress';
import {
  getEffectivePlan,
  getEffectiveDay,
  moveWorkout,
  skipWorkout,
  convertWorkout,
  restoreDay,
  scaleWeek,
  applyDayOverride,
  undoLastChange,
  getOverlayLog,
  isDayModified,
  onPlanOverlayChanged,
} from '@/services/planOverlay';
import { getJourneyState, getRaceDate } from '@/services/journey';
import { getPlanById } from '@/data/plans';
import { addDays, parseDateKey } from '@/utils/localDate';

const NOVICE1 = 'hal-higdon-novice-1';

describe('DST-safe plan grid (V3)', () => {
  const START = '2025-12-22';

  it('maps Sat 2026-03-14 (after US spring-forward) to week 11 day 5', () => {
    expect(getWeekDayForDate(START, 18, parseDateKey('2026-03-14'))).toEqual({ weekIndex: 11, dayIndex: 5 });
    expect(getWeekDayForDate(START, 18, '2026-03-14')).toEqual({ weekIndex: 11, dayIndex: 5 });
  });

  it('maps race Sun 2026-04-26 to week 17 day 6 and Mon 2026-04-27 outside the plan', () => {
    expect(getWeekDayForDate(START, 18, parseDateKey('2026-04-26'))).toEqual({ weekIndex: 17, dayIndex: 6 });
    expect(getWeekDayForDate(START, 18, parseDateKey('2026-04-27'))).toBeNull();
    expect(getWeekDayForDate(START, 18, parseDateKey('2025-12-21'))).toBeNull();
  });

  it('works for Date objects at any time of day', () => {
    const lateEvening = new Date(2026, 2, 29, 23, 30); // after EU spring-forward
    expect(getWeekDayForDate(START, 18, lateEvening)).toEqual({ weekIndex: 13, dayIndex: 6 });
    const earlyMorning = new Date(2026, 3, 5, 0, 5); // AU DST end
    expect(getWeekDayForDate(START, 18, earlyMorning)).toEqual({ weekIndex: 14, dayIndex: 6 });
  });

  it('round-trips every day of an 18-week plan crossing DST', () => {
    for (let w = 0; w < 18; w++) {
      for (let d = 0; d < 7; d++) {
        const key = getDateKeyForDay(START, w, d);
        expect(key).toBe(addDays(START, w * 7 + d));
        expect(getWeekDayForDate(START, 18, key)).toEqual({ weekIndex: w, dayIndex: d });
        expect(getWeekDayForDate(START, 18, getDateForDay(START, w, d))).toEqual({ weekIndex: w, dayIndex: d });
        expect(formatDateKey(getDateForDay(START, w, d))).toBe(key);
      }
    }
  });
});

describe('race-date-first placement (V4)', () => {
  const plan = getPlanById(NOVICE1)!;

  it('finds the race day of built-in plans', () => {
    expect(getRaceDayRef(plan)).toEqual({ weekIndex: 17, dayIndex: 6 });
  });

  it('snaps to the Monday on or before', () => {
    expect(snapToMonday('2026-10-07')).toBe('2026-10-05');
    expect(snapToMonday('2026-10-05')).toBe('2026-10-05');
    expect(snapToMonday('2026-10-11')).toBe('2026-10-05');
  });

  it('race Sun 2026-04-19 + 18-week plan starts Mon 2025-12-15', () => {
    const p = placePlan(plan, '2026-04-19', '2025-12-01');
    expect(p.startDate).toBe('2025-12-15');
    expect(p.fits).toBe(true);
    expect(p.joinWeekIndex).toBe(0);
    expect(p.raceDayIndex).toBe(6);
    expect(p.notes).toEqual([]);
  });

  it('a race 10 weeks away on an 18-week plan joins at week index 8', () => {
    const p = placePlan(plan, '2026-04-26', '2026-02-16');
    expect(p.weeksAvailable).toBe(10);
    expect(p.fits).toBe(false);
    expect(p.joinWeekIndex).toBe(8);
    expect(p.startDate).toBe('2025-12-22');
    expect(p.notes.length).toBeGreaterThan(0);
  });

  it('a Saturday race moves the race workout to Saturday with nothing after it', () => {
    const active = startPlan({ planId: NOVICE1, raceDate: '2026-04-18' }, '2025-12-01');
    expect(active.startDate).toBe('2025-12-15');
    expect(active.raceDate).toBe('2026-04-18');
    const eff = getEffectivePlan()!;
    expect(eff.weeks).toHaveLength(18);
    expect(eff.weeks[17].days[5].type).toBe('marathon');
    expect(eff.weeks[17].days[6].type).toBe('rest');
    expect(getDateKeyForDay(active.startDate, 17, 5)).toBe('2026-04-18');
    expect(getRaceDate()).toBe('2026-04-18');
  });

  it('a Monday race (Boston) keeps the taper days just before the race', () => {
    startPlan({ planId: NOVICE1, raceDate: '2026-04-20' }, '2025-12-01');
    const eff = getEffectivePlan()!;
    const raceRef = getRaceDayRef(eff);
    expect(raceRef).toEqual({ weekIndex: 17, dayIndex: 0 });
    for (let d = 1; d < 7; d++) expect(eff.weeks[17].days[d].type).toBe('rest');
    // The base plan's race-week Saturday (the day before its race) is now the day before Boston.
    const base = getPlanById(NOVICE1)!;
    expect(eff.weeks[16].days[6]).toEqual(base.weeks[17].days[5]);
  });

  it('startPlan with only a start date snaps it to Monday and derives the race date', () => {
    const active = startPlan({ planId: NOVICE1, startDate: '2026-10-07' }, '2026-10-07');
    expect(active.startDate).toBe('2026-10-05');
    expect(active.raceDate).toBe(addDays('2026-10-05', 17 * 7 + 6));
    expect(getActivePlanInstanceId()).toBe(`${NOVICE1}@2026-10-05`);
  });
});

describe('plan instances (V18)', () => {
  const meta = { activityId: 1, actualDistanceMi: 3, actualPaceMinPerMi: 9, movingTimeSec: 1600, feedback: '', syncedAt: '2026-01-01T00:00:00Z' };

  it('a new instance clears that plan’s completions, sync meta and overlay', () => {
    startPlan({ planId: NOVICE1, raceDate: '2026-04-19' }, '2025-12-01');
    setDayCompleted(NOVICE1, 0, 1, true);
    setSyncMeta(NOVICE1, 0, 1, meta);
    expect(moveWorkout({ weekIndex: 1, dayIndex: 1 }, { weekIndex: 1, dayIndex: 2 }).ok).toBe(true);

    const preview = previewStartPlan({ planId: NOVICE1, raceDate: '2026-04-26' }, '2025-12-01');
    expect(preview.isNewInstance).toBe(true);
    expect(preview.clears).toEqual({ completions: 1, syncMeta: 1, overlay: true });

    startPlan({ planId: NOVICE1, raceDate: '2026-04-26' }, '2025-12-01');
    expect(isDayCompleted(NOVICE1, 0, 1)).toBe(false);
    expect(getSyncMeta(NOVICE1, 0, 1)).toBeNull();
    expect(getOverlayLog()).toEqual([]);
    expect(isDayModified({ weekIndex: 1, dayIndex: 1 })).toBe(false);
  });

  it('re-starting the same instance keeps progress; A → B → A restores A', () => {
    startPlan({ planId: NOVICE1, raceDate: '2026-04-19' }, '2025-12-01');
    setDayCompleted(NOVICE1, 0, 1, true);
    startPlan({ planId: 'pfitzinger-18-55', raceDate: '2026-05-03' }, '2025-12-01');
    startPlan({ planId: NOVICE1, raceDate: '2026-04-19' }, '2025-12-01');
    expect(isDayCompleted(NOVICE1, 0, 1)).toBe(true);
  });

  it('legacy data of the active plan belongs to its current instance', () => {
    setActivePlan({ planId: NOVICE1, startDate: '2025-12-15' });
    setDayCompleted(NOVICE1, 0, 1, true);
    expect(previewStartPlan({ planId: NOVICE1, startDate: '2025-12-15' }, '2025-12-20').isNewInstance).toBe(false);
    startPlan({ planId: NOVICE1, startDate: '2025-12-15' }, '2025-12-20');
    expect(isDayCompleted(NOVICE1, 0, 1)).toBe(true);
  });

  it('legacy FIRST users keep their 18-week race date after FIRST became 16 weeks', () => {
    setActivePlan({ planId: 'first', startDate: '2025-12-15' });
    const eff = getEffectivePlan()!;
    expect(eff.weeks.length).toBe(18);
    expect(getRaceDate()).toBe(addDays('2025-12-15', 17 * 7 + 6));
    expect(eff.weeks[17].days[6].type).toBe('marathon');
  });
});

describe('plan overlay (V7)', () => {
  beforeEach(() => {
    startPlan({ planId: NOVICE1, raceDate: '2026-04-19' }, '2025-12-01');
  });

  it('moveWorkout swaps two days and nothing is lost', () => {
    const before = getEffectivePlan()!;
    const sat = before.weeks[2].days[5];
    const sun = before.weeks[2].days[6];
    expect(moveWorkout({ weekIndex: 2, dayIndex: 5 }, { weekIndex: 2, dayIndex: 6 })).toEqual({ ok: true });
    const after = getEffectivePlan()!;
    expect(after.weeks[2].days[6]).toEqual(sat);
    expect(after.weeks[2].days[5]).toEqual(sun);
    expect(isDayModified({ weekIndex: 2, dayIndex: 5 })).toBe(true);
    expect(getOverlayLog()).toHaveLength(1);
    // Base plan untouched.
    expect(getPlanById(NOVICE1)!.weeks[2].days[5]).toEqual(sat);
  });

  it('rejects the race day, days after it, completed days and out-of-range refs', () => {
    expect(moveWorkout({ weekIndex: 17, dayIndex: 6 }, { weekIndex: 17, dayIndex: 5 }).ok).toBe(false);
    expect(moveWorkout({ weekIndex: 18, dayIndex: 0 }, { weekIndex: 17, dayIndex: 5 }).ok).toBe(false);
    expect(moveWorkout({ weekIndex: 0, dayIndex: 7 }, { weekIndex: 0, dayIndex: 1 }).ok).toBe(false);
    setDayCompleted(NOVICE1, 0, 1, true);
    expect(moveWorkout({ weekIndex: 0, dayIndex: 1 }, { weekIndex: 0, dayIndex: 2 }).ok).toBe(false);
    expect(skipWorkout({ weekIndex: 17, dayIndex: 6 }).ok).toBe(false);
  });

  it('skip / convert / restore / scale / override / undo round trip', () => {
    const base = getEffectivePlan()!;
    expect(skipWorkout({ weekIndex: 3, dayIndex: 1 }).ok).toBe(true);
    expect(getEffectiveDay({ weekIndex: 3, dayIndex: 1 })).toMatchObject({ type: 'rest', skipped: true });
    expect(convertWorkout({ weekIndex: 3, dayIndex: 2 }, 'rest').ok).toBe(true);
    expect(getEffectiveDay({ weekIndex: 3, dayIndex: 2 })?.type).toBe('rest');
    expect(restoreDay({ weekIndex: 3, dayIndex: 1 }).ok).toBe(true);
    expect(getEffectiveDay({ weekIndex: 3, dayIndex: 1 })).toEqual(base.weeks[3].days[1]);
    expect(scaleWeek(4, 0.5).ok).toBe(true);
    expect(getEffectiveDay({ weekIndex: 4, dayIndex: 5 })?.distanceMi).toBe(5);
    expect(applyDayOverride({ weekIndex: 5, dayIndex: 1 }, { type: 'run', label: '2 mi easy', distanceMi: 2, note: 'Easy' }, 'adaptive', 'Lighter day').ok).toBe(true);
    expect(getOverlayLog().map((e) => e.kind)).toEqual(['skip', 'convert', 'restore', 'week-scale', 'adaptive']);
    // Undo everything, newest first.
    for (let i = 0; i < 5; i++) expect(undoLastChange().ok).toBe(true);
    expect(undoLastChange().ok).toBe(false);
    expect(getEffectivePlan()).toEqual(base);
  });

  it('restoring one side of a swap restores both days', () => {
    const base = getEffectivePlan()!;
    moveWorkout({ weekIndex: 2, dayIndex: 5 }, { weekIndex: 2, dayIndex: 1 });
    expect(restoreDay({ weekIndex: 2, dayIndex: 1 }).ok).toBe(true);
    expect(getEffectivePlan()).toEqual(base);
  });

  it('survives a reload (fresh module instances)', async () => {
    moveWorkout({ weekIndex: 2, dayIndex: 5 }, { weekIndex: 2, dayIndex: 6 });
    const expected = getEffectivePlan();
    vi.resetModules();
    const reloaded = await import('@/services/planOverlay');
    expect(reloaded.getEffectivePlan()).toEqual(expected);
    expect(reloaded.getOverlayLog()).toHaveLength(1);
  });

  it('undo is scoped to the active instance', () => {
    moveWorkout({ weekIndex: 2, dayIndex: 5 }, { weekIndex: 2, dayIndex: 6 });
    startPlan({ planId: 'pfitzinger-18-55', raceDate: '2026-05-03' }, '2025-12-01');
    expect(undoLastChange().ok).toBe(false);
    startPlan({ planId: NOVICE1, raceDate: '2026-04-19' }, '2025-12-01');
    expect(getOverlayLog()).toHaveLength(1);
    expect(undoLastChange().ok).toBe(true);
    expect(getOverlayLog()).toHaveLength(0);
  });

  it('notifies listeners', () => {
    const cb = vi.fn();
    const off = onPlanOverlayChanged(cb);
    skipWorkout({ weekIndex: 3, dayIndex: 1 });
    off();
    skipWorkout({ weekIndex: 3, dayIndex: 2 });
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('returns a stable object until something changes', () => {
    const a = getEffectivePlan();
    expect(getEffectivePlan()).toBe(a);
    skipWorkout({ weekIndex: 3, dayIndex: 1 });
    expect(getEffectivePlan()).not.toBe(a);
  });
});

describe('journey (getRaceDate / getJourneyState)', () => {
  it('no plan and no race → no-plan', () => {
    expect(getActivePlan()).toBeNull();
    expect(getRaceDate()).toBeNull();
    expect(getJourneyState('2026-01-01').phase).toBe('no-plan');
  });

  it('walks the phases of a placed plan', () => {
    startPlan({ planId: NOVICE1, raceDate: '2026-04-19' }, '2025-12-01');
    expect(getJourneyState('2025-12-10').phase).toBe('pre-plan');
    const training = getJourneyState('2026-01-07');
    expect(training).toMatchObject({ phase: 'training', planId: NOVICE1, weekIndex: 3, dayIndex: 2, totalWeeks: 18, raceDate: '2026-04-19' });
    expect(training.trainingPhase).not.toBeNull();
    expect(getJourneyState('2026-03-29').phase).toBe('taper'); // 21 days out
    expect(getJourneyState('2026-04-12').phase).toBe('race-week'); // 7 days out
    expect(getJourneyState('2026-04-18').daysToRace).toBe(1);
    const raceDay = getJourneyState('2026-04-19');
    expect(raceDay.phase).toBe('race-day');
    expect(raceDay.trainingPhase).toBe('race');
    expect(getJourneyState('2026-05-03').phase).toBe('post-race');
    expect(getJourneyState('2026-05-04').phase).toBe('off-season');
  });
});

describe('canToggleDayCompletion (S4)', () => {
  const START = '2026-03-02'; // Monday
  it('blocks ticking a future day but allows today and past days', () => {
    expect(canToggleDayCompletion(START, 0, 3, { today: '2026-03-04', dayType: 'run' })).toMatchObject({
      allowed: false,
      reason: 'future',
    });
    expect(canToggleDayCompletion(START, 0, 2, { today: '2026-03-04', dayType: 'run' }).allowed).toBe(true);
    expect(canToggleDayCompletion(START, 0, 1, { today: '2026-03-04', dayType: 'run' }).allowed).toBe(true);
  });

  it('always allows removing an existing completion, even on a future day', () => {
    expect(canToggleDayCompletion(START, 3, 0, { today: '2026-03-04', completed: true }).allowed).toBe(true);
  });

  it('blocks ticking rest days', () => {
    expect(canToggleDayCompletion(START, 0, 0, { today: '2026-03-04', dayType: 'rest' })).toMatchObject({
      allowed: false,
      reason: 'rest',
    });
  });

  it('is DST-safe across spring-forward', () => {
    // 2026-03-08 is US spring-forward; week 1 day 0 = 2026-03-09.
    expect(canToggleDayCompletion(START, 1, 0, { today: '2026-03-09' }).allowed).toBe(true);
    expect(canToggleDayCompletion(START, 1, 1, { today: '2026-03-09' }).allowed).toBe(false);
  });
});
