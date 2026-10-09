/**
 * Workout parity (v1.0.7, T-1): for every day of every built-in plan (and a
 * custom plan with marathon-pace days), Today, the plan preview, compliance
 * scoring and the watch push must agree on the kind of session and its pace.
 *
 * Before v1.0.7, marathon-pace days were shown and scored at threshold pace
 * (HR zone 4) on Today while the watch push used marathon pace.
 */
import { describe, it, expect } from 'vitest';
import {
  BUILT_IN_PLANS,
  createCustomPlanFromScratch,
  getWorkoutKind,
  type PlanDay,
  type PlanWorkoutKind,
  type TrainingPlan,
} from '@/data/plans';
import { targetForDay } from '@/components/today/todayModel';
import {
  categoryForKind,
  getWorkoutTarget,
  getWorkoutTargetForDay,
  noteForKind,
} from '@/services/workoutTargets';
import { buildPlanWorkouts } from '@/services/planCalendarSync';
import { calculateTrainingPaces } from '@/services/paceCalculator';

const VDOT = 50;
const START = '2026-01-05'; // a Monday

/** Name prefix the watch push gives each kind (planCalendarSync buildSpec). */
const WATCH_NAME: Partial<Record<PlanWorkoutKind, RegExp>> = {
  easy: /^Easy Run/,
  recovery: /^Recovery Run/,
  long: /^Long Run/,
  medium_long: /^Medium-Long Run/,
  tempo: /^Tempo/,
  strength: /^Strength Run/,
  marathon_pace: /^Marathon Pace/,
  speed: /Intervals$/,
  cross: /^Cross-Training/,
  marathon: /^Marathon Day/,
};

const customWithMp = createCustomPlanFromScratch({
  name: 'Parity custom',
  totalWeeks: 12,
  runningDays: 5,
  currentWeeklyMiles: 25,
  peakWeeklyMiles: 40,
  dayAssignments: { 0: 'rest', 1: 'speed', 2: 'easy', 3: 'marathon_pace', 4: 'rest', 5: 'long', 6: 'easy' },
});

const PLANS: TrainingPlan[] = [...BUILT_IN_PLANS, customWithMp];

function pacedDays(plan: TrainingPlan): Array<{ day: PlanDay; week: number; index: number }> {
  const out: Array<{ day: PlanDay; week: number; index: number }> = [];
  plan.weeks.forEach((w, week) => w.days.forEach((day, index) => {
    if (day.type === 'run' || day.type === 'race' || day.type === 'marathon') out.push({ day, week, index });
  }));
  return out;
}

describe('workout parity: Today = plan preview = compliance = watch (T-1)', () => {
  const paces = calculateTrainingPaces(VDOT)!;

  it.each(PLANS.map((p) => [p.id, p] as const))('%s: every paced day agrees on kind and pace', (_id, plan) => {
    const workouts = buildPlanWorkouts(plan, START, { from: START, unit: 'mi', paces, vdot: VDOT });
    const byDate = new Map(workouts.map((w) => [w.external_id, w]));

    for (const { day, week, index } of pacedDays(plan)) {
      const kind = getWorkoutKind(day);
      const expected = categoryForKind(kind);

      // Today (and the plan preview, which uses the same helper)
      const today = targetForDay(day, VDOT);
      expect(today?.category, `${plan.id} w${week + 1}d${index + 1} "${day.label}" on Today`).toBe(expected);
      expect(getWorkoutTargetForDay(day, VDOT)?.category).toBe(expected);

      // Compliance scores against the canonical note for the kind
      const compliance = getWorkoutTarget(noteForKind(kind), VDOT, day.distanceMi);
      expect(compliance?.category, `${plan.id} w${week + 1}d${index + 1} compliance`).toBe(expected);
      expect(compliance?.targetPaceRange).toEqual(today?.targetPaceRange);

      // Watch push
      const id = `apollo:${plan.id}:${START}:w${week + 1}d${index + 1}`;
      const watch = byDate.get(id);
      expect(watch, `${id} pushed to the watch`).toBeDefined();
      const namePattern = WATCH_NAME[kind];
      if (namePattern) expect(watch!.name, `${id} watch name`).toMatch(namePattern);
    }
  });

  it('marathon-pace days target marathon pace in zone 3, never threshold', () => {
    let mpDays = 0;
    for (const plan of PLANS) {
      for (const { day } of pacedDays(plan)) {
        if (getWorkoutKind(day) !== 'marathon_pace') continue;
        mpDays++;
        const t = targetForDay(day, VDOT)!;
        expect(t.category).toBe('marathon_pace');
        expect(t.hrZone).toBe(3);
        const mid = (t.targetPaceRange!.minSecPerMi + t.targetPaceRange!.maxSecPerMi) / 2;
        expect(mid).toBe(paces.marathon);
        expect(t.targetPaceRange!.minSecPerMi).toBeGreaterThan(paces.threshold + 5);
      }
    }
    // Higdon pace days, Hansons Thursday tempo and the custom plan all have MP days.
    expect(mpDays).toBeGreaterThan(20);
  });

  it('legacy labels refine the note: "8 mi marathon pace" with note Tempo is marathon pace', () => {
    const legacy: PlanDay = { type: 'run', label: '8 mi marathon pace', distanceMi: 8, note: 'Tempo' };
    expect(getWorkoutTargetForDay(legacy, VDOT)?.category).toBe('marathon_pace');
    expect(targetForDay(legacy, VDOT)?.category).toBe('marathon_pace');
  });

  it('rest and cross days have no pace target', () => {
    expect(getWorkoutTargetForDay({ type: 'rest', label: 'Rest' }, VDOT)).toBeNull();
    expect(getWorkoutTargetForDay({ type: 'cross', label: 'Cross' }, VDOT)).toBeNull();
    expect(getWorkoutTargetForDay({ type: 'run', label: '5 mi easy', distanceMi: 5, note: 'Easy' }, 0)).toBeNull();
  });
});
