/**
 * v1.0.7 follow-ups to plan fidelity (T-4 / T-11 / T-8):
 * - every built-in plan day keeps its workout kind; the only intended change is
 *   FIRST's long tempos, which are marathon-pace runs;
 * - labels never change the kind (the note decides), and label-based readers
 *   (periodization, titles) still read the new FIRST labels correctly;
 * - coach tempo shapes (Higdon progressive, Nike continuous) instead of cruise
 *   intervals, with Today = watch = compliance;
 * - mpFinish survives overlays and is derived for saved custom plans;
 * - custom easy days stay shorter than the long run.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  BUILT_IN_PLANS,
  CUSTOM_PLAN_ID,
  createCustomPlanFromScratch,
  getCustomPlan,
  getPlanById,
  getWorkoutKind,
  setCustomPlan,
  type PlanDay,
  type PlanWorkoutKind,
  type TrainingPlan,
} from '@/data/plans';
import { getWorkoutTarget, getWorkoutTargetForDay, noteForKind } from '@/services/workoutTargets';
import { targetForDay } from '@/components/today/todayModel';
import { buildPlanWorkouts } from '@/services/planCalendarSync';
import { calculateTrainingPaces, saveTrainingPaces } from '@/services/paceCalculator';
import { raceTimeFromVdot } from '@/services/racePrediction';
import { analyzeCompliance } from '@/services/complianceAnalysis';
import { analyzeWeek } from '@/services/periodization';
import { workoutTitle } from '@/components/plan/planDisplay';
import { persistence } from '@/services/db/persistence';
import { startPlan } from '@/services/planProgress';
import { applyAdaptiveChanges, getEffectivePlan } from '@/services/planOverlay';

const VDOT = 50;
const START = '2026-01-05';
const paces = calculateTrainingPaces(VDOT)!;

/** Kind from the note alone (what the plan author wrote), ignoring labels. */
function kindFromNote(day: PlanDay): PlanWorkoutKind {
  return getWorkoutKind({ ...day, label: '' });
}

/** FIRST weeks (1-based) whose Thursday tempo has ≥ 6 mi of work: marathon-pace "long tempos" (T-4). */
const FIRST_MP_TEMPO_WEEKS = [6, 8, 10, 11, 12, 13];

describe('plan day kinds are unchanged except where intended', () => {
  it.each(BUILT_IN_PLANS.map((p) => [p.id, p] as const))('%s: labels never change the kind; the note decides', (_id, plan) => {
    plan.weeks.forEach((w, wi) => w.days.forEach((d, di) => {
      expect(getWorkoutKind(d), `${plan.id} w${wi + 1}d${di + 1} "${d.label}"`).toBe(kindFromNote(d));
    }));
  });

  it('FIRST: Thursday tempos are tempo, except the long tempos at marathon pace', () => {
    const first = getPlanById('first')!;
    first.weeks.slice(0, 15).forEach((w, wi) => {
      const kind = getWorkoutKind(w.days[3]);
      expect(kind, `w${wi + 1} "${w.days[3].label}"`).toBe(FIRST_MP_TEMPO_WEEKS.includes(wi + 1) ? 'marathon_pace' : 'tempo');
    });
  });

  it('label readers: periodization still sees the real long run and quality work in FIRST weeks', () => {
    const first = getPlanById('first')!;
    for (const wn of FIRST_MP_TEMPO_WEEKS) {
      const week = first.weeks[wn - 1];
      const profile = analyzeWeek(week);
      const long = week.days.find((d) => d.note === 'Long')!.distanceMi!;
      expect(profile.longRunMiles).toBe(long);
      expect(profile.hasTempoOrSpeed).toBe(true);
      expect(profile.hasMarathonPace).toBe(true);
    }
  });

  it('titles of the new FIRST labels are unit-free', () => {
    const first = getPlanById('first')!;
    expect(workoutTitle(first.weeks[0].days[3])).toBe('Short tempo run');
    expect(workoutTitle(first.weeks[1].days[3])).toBe('Mid tempo run');
    expect(workoutTitle(first.weeks[11].days[3])).toBe('Tempo at marathon pace');
    for (const w of first.weeks) expect(workoutTitle(w.days[3])).not.toMatch(/\bmi\b/);
  });
});

describe('coach tempo shapes (T-4 follow-up)', () => {
  const watchOf = (day: PlanDay) => buildPlanWorkouts(
    { id: 'p', name: 'p', author: 'a', description: '', totalWeeks: 1, weeks: [{ weekNumber: 1, days: [day] }] },
    START, { from: START, unit: 'mi', paces, vdot: VDOT },
  )[0];

  it('Higdon "45 min tempo": build, about 10K pace in the middle, ease back — not cruise reps', () => {
    const adv = getPlanById('hal-higdon-advanced-1')!;
    const day = adv.weeks[10].days[3];
    expect(day.label).toBe('45 min tempo');
    const t = targetForDay(day, VDOT)!;
    expect(t.description).toMatch(/^Hal Higdon tempo/);
    expect(t.intervals![0].description).toBe('1mi warmup → 18 min building → 15 min near 10K pace → 12 min easing back → 1mi cooldown');
    expect(t.intervals![0].repeats).toBe(1);
    // About 10K pace: faster than T, slower than 5K pace.
    expect(t.targetPaceRange!.maxSecPerMi).toBeLessThan(paces.threshold);
    const watch = watchOf(day);
    expect(watch.description).toContain('Build\n- 18m');
    expect(watch.description).toContain('Tempo\n- 15m');
    expect(watch.description).toContain('Ease back\n- 12m');
    expect(watch.description).not.toMatch(/Cruise/);
    // Compliance (with the plan day) uses the same target.
    expect(getWorkoutTarget(noteForKind(getWorkoutKind(day)), VDOT, day.distanceMi, day)).toEqual(t);
  });

  it('Nike 6 mi tempo stays continuous: ≤ ~25 min at T, the rest at marathon pace', () => {
    const nike = getPlanById('nike-run-club-marathon')!;
    const day = nike.weeks[6].days[3];
    expect(day.label).toBe('6 mi tempo');
    const t = targetForDay(day, VDOT)!;
    expect(t.category).toBe('tempo');
    expect(t.intervals![0].repeats).toBe(1);
    expect(t.intervals![0].workDurationMin).toBeLessThanOrEqual(25);
    expect(t.intervals![0].description).toMatch(/^1mi warmup → 0\.5mi at marathon pace → 3\.5mi at tempo → 1mi cooldown$/);
    const watch = watchOf(day);
    expect(watch.description).toContain('Marathon pace\n- 0.5mi');
    expect(watch.description).toContain('Tempo\n- 3.5mi');
    expect(watch.description).not.toMatch(/Cruise/);
    // A 5 mi Nike tempo (3 mi at T, ~20 min) is all threshold.
    const five = nike.weeks[0].days[3];
    expect(targetForDay(five, VDOT)!.intervals![0].description).toBe('1mi warmup → 3mi at tempo → 1mi cooldown');
  });

  describe('compliance: running exactly the prescribed structure is on target', () => {
    beforeEach(() => {
      persistence.clear();
      saveTrainingPaces(paces);
    });
    const easyMid = (paces.easy.min + paces.easy.max) / 2;
    const steady = (paces.marathon + paces.easy.min) / 2;
    const tenK = raceTimeFromVdot(VDOT, 10000) / (10000 / 1609.344);
    /** Whole-run average (min/mi) of segments run exactly at their target paces. */
    const avgMinPerMi = (segs: Array<{ mi?: number; sec?: number; pace: number }>) => {
      let sec = 0;
      let mi = 0;
      for (const s of segs) {
        const m = s.mi ?? (s.sec! / s.pace);
        sec += m * s.pace;
        mi += m;
      }
      return { pace: sec / mi / 60, mi };
    };

    it('Higdon 45 min tempo', () => {
      const day = getPlanById('hal-higdon-advanced-1')!.weeks[10].days[3];
      const run = avgMinPerMi([
        { mi: 1, pace: easyMid },
        { sec: 18 * 60, pace: steady },
        { sec: 15 * 60, pace: tenK },
        { sec: 12 * 60, pace: steady },
        { mi: 1, pace: easyMid },
      ]);
      const result = analyzeCompliance(noteForKind(getWorkoutKind(day)), run.pace, run.mi, day.distanceMi!, day)!;
      expect(result.paceCompliance.direction).toBe('on_target');
      expect(result.paceCompliance.inRange).toBe(true);
      // Before: scored against the 10K block alone, the same run was "too slow".
      expect(run.pace * 60).toBeGreaterThan(tenK + 30);
    });

    it('Nike 6 mi tempo', () => {
      const day = getPlanById('nike-run-club-marathon')!.weeks[6].days[3];
      const run = avgMinPerMi([
        { mi: 1, pace: easyMid },
        { mi: 0.5, pace: paces.marathon },
        { mi: 3.5, pace: paces.threshold },
        { mi: 1, pace: easyMid },
      ]);
      const result = analyzeCompliance(noteForKind(getWorkoutKind(day)), run.pace, 6, 6, day)!;
      expect(result.paceCompliance.direction).toBe('on_target');
    });

    it('custom cruise intervals', () => {
      const day: PlanDay = { type: 'run', label: '9 mi tempo', distanceMi: 9, note: 'Tempo' };
      const run = avgMinPerMi([
        { mi: 1.5, pace: easyMid },
        { mi: 6, pace: paces.threshold },
        { sec: 6 * 60, pace: paces.easy.max + 30 },
        { mi: 1.5, pace: easyMid },
      ]);
      expect(analyzeCompliance('Tempo', run.pace, 9, 9, day)!.paceCompliance.direction).toBe('on_target');
      // A run at easy pace throughout is still flagged.
      expect(analyzeCompliance('Tempo', easyMid / 60, 9, 9, day)!.paceCompliance.direction).toBe('too_slow');
    });
  });

  it('cruise intervals only for tempos without a coach shape (custom plans)', () => {
    for (const plan of BUILT_IN_PLANS) {
      for (const w of plan.weeks) for (const d of w.days) {
        expect(getWorkoutTargetForDay(d, VDOT)?.description ?? '', `${plan.id} "${d.label}"`).not.toMatch(/^Cruise intervals/);
      }
    }
    const custom: PlanDay = { type: 'run', label: '10 mi tempo', distanceMi: 10, note: 'Tempo' };
    expect(getWorkoutTargetForDay(custom, VDOT)!.description).toMatch(/^Cruise intervals/);
  });
});

describe('mpFinish survives overlays and saved custom plans (T-11 follow-up)', () => {
  beforeEach(() => persistence.clear());

  it('saved custom plans without the flag get it on read when the peak week is ≥ 40 mi', () => {
    const built = createCustomPlanFromScratch({ name: 'Old', totalWeeks: 18, runningDays: 5, currentWeeklyMiles: 35, peakWeeklyMiles: 55 });
    // Simulate a plan saved before v1.0.7: strip every flag.
    const legacy: TrainingPlan = { ...built, weeks: built.weeks.map((w) => ({ ...w, days: w.days.map(({ mpFinish: _m, ...d }) => d) })) };
    setCustomPlan(legacy);
    const read = getCustomPlan()!;
    const longs = read.weeks.flatMap((w) => w.days).filter((d) => d.note === 'Long');
    expect(longs.length).toBeGreaterThan(0);
    expect(longs.every((d) => d.mpFinish === true)).toBe(true);
    // Low-volume plans stay without it.
    setCustomPlan(createCustomPlanFromScratch({ name: 'Low', totalWeeks: 16, runningDays: 4, currentWeeklyMiles: 15, peakWeeklyMiles: 30 }));
    expect(getCustomPlan()!.weeks.flatMap((w) => w.days).some((d) => d.mpFinish)).toBe(false);
  });

  it('adaptive overlays keep mpFinish on the long runs they scale or replace', () => {
    const today = new Date();
    const key = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    startPlan({ planId: 'pfitzinger-18-55', startDate: key });
    const plan = getEffectivePlan()!;
    const wi = 9; // 20 mi long run week
    const longIdx = plan.weeks[wi].days.findIndex((d) => d.note === 'Long');
    expect(plan.weeks[wi].days[longIdx].mpFinish).toBe(true);
    const res = applyAdaptiveChanges([
      { weekIndex: wi, mileageMultiplier: 0.9 },
      { weekIndex: wi + 2, dayOverrides: [{ dayIndex: longIdx, day: { type: 'run', label: '18 mi long run', distanceMi: 18, note: 'Long' } }] },
    ], 'test');
    expect(res.ok).toBe(true);
    const after = getEffectivePlan()!;
    expect(after.weeks[wi].days[longIdx].mpFinish).toBe(true);
    expect(after.weeks[wi + 2].days[longIdx].mpFinish).toBe(true);
  });
});

describe('custom easy days stay shorter than the long run (T-8 follow-up)', () => {
  it.each([
    { totalWeeks: 16, runningDays: 3, currentWeeklyMiles: 20, peakWeeklyMiles: 40 },
    { totalWeeks: 12, runningDays: 3, currentWeeklyMiles: 15, peakWeeklyMiles: 25 },
    { totalWeeks: 18, runningDays: 4, currentWeeklyMiles: 8, peakWeeklyMiles: 20 },
  ])('%o', (input) => {
    const plan = createCustomPlanFromScratch({ name: 'Easy cap', ...input });
    plan.weeks.slice(0, -1).forEach((w, wi) => {
      const long = w.days.find((d) => d.note === 'Long')!.distanceMi!;
      for (const d of w.days.filter((x) => x.note === 'Easy')) {
        expect(d.distanceMi!, `week ${wi + 1}`).toBeLessThan(long);
      }
    });
    expect(plan.id).toBe(CUSTOM_PLAN_ID);
  });
});
