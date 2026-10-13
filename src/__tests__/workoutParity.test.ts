/**
 * Workout parity (v1.0.7, T-1): for every day of every built-in plan (and a
 * custom plan with marathon-pace days), Today, the plan preview, compliance
 * scoring and the watch push must agree on the kind of session and its pace.
 *
 * Before v1.0.7, marathon-pace days were shown and scored at threshold pace
 * (HR zone 4) on Today while the watch push used marathon pace.
 */
import { describe, it, expect, beforeEach } from 'vitest';
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
  parsePlanReps,
} from '@/services/workoutTargets';
import { buildPlanWorkouts } from '@/services/planCalendarSync';
import { calculateTrainingPaces, saveTrainingPaces } from '@/services/paceCalculator';
import { analyzeCompliance } from '@/services/complianceAnalysis';
import { persistence } from '@/services/db/persistence';

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
  plan.weeks.forEach((w, week) =>
    w.days.forEach((day, index) => {
      if (day.type === 'run' || day.type === 'race' || day.type === 'marathon') out.push({ day, week, index });
    }),
  );
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

      // Compliance scores against the canonical note for the kind, with the plan day
      // (autoSync passes it, v1.0.7 T-4 / T-10)
      const compliance = getWorkoutTarget(noteForKind(kind), VDOT, day.distanceMi, day);
      expect(compliance?.category, `${plan.id} w${week + 1}d${index + 1} compliance`).toBe(expected);
      expect(compliance?.targetPaceRange).toEqual(today?.targetPaceRange);
      expect(compliance?.intervals).toEqual(today?.intervals);

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

/** "m:ss-m:ss/mi" as the watch renders a target range (slow-fast). */
function watchRange(minSecPerMi: number, maxSecPerMi: number): string {
  const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
  return `${clock(maxSecPerMi)}-${clock(minSecPerMi)}/mi`;
}

describe("workout parity keeps each coach's structure (v1.0.7 T-4 / T-10 / T-17)", () => {
  const paces = calculateTrainingPaces(VDOT)!;
  const first = BUILT_IN_PLANS.find((p) => p.id === 'first')!;
  const hansons = BUILT_IN_PLANS.find((p) => p.id === 'hansons-beginner')!;
  const watchFor = (plan: TrainingPlan, week: number, index: number) =>
    buildPlanWorkouts(plan, START, { from: START, unit: 'mi', paces, vdot: VDOT }).find(
      (w) => w.external_id === `apollo:${plan.id}:${START}:w${week + 1}d${index + 1}`,
    )!;

  beforeEach(() => {
    persistence.clear();
    saveTrainingPaces(paces);
  });

  it('FIRST short tempo: Today, the watch and compliance all use the FIRST short-tempo pace (T-4)', () => {
    const day = first.weeks[0].days[3];
    expect(day.label).toMatch(/short tempo/);
    const today = targetForDay(day, VDOT)!;
    expect(today.description).toMatch(/^FIRST short tempo/);
    // Faster than Daniels T (5K pace + 15 s/mi), not the generic threshold range.
    expect(today.targetPaceRange!.maxSecPerMi).toBeLessThan(paces.threshold);

    // Watch: the short-tempo block carries the same range.
    const watch = watchFor(first, 0, 3);
    expect(watch.description).toContain(
      `Short tempo\n- 3mi ${watchRange(today.targetPaceRange!.minSecPerMi, today.targetPaceRange!.maxSecPerMi)} Pace`,
    );

    // Compliance (the real analyzeCompliance path autoSync uses): on target at the FIRST pace…
    const mid = (today.targetPaceRange!.minSecPerMi + today.targetPaceRange!.maxSecPerMi) / 2;
    const kindNote = noteForKind(getWorkoutKind(day));
    const scored = analyzeCompliance(kindNote, mid / 60, 5, 5, day)!;
    expect(scored.paceCompliance.inRange).toBe(true);
    expect(scored.paceCompliance.targetRange).toEqual(today.targetPaceRange);
    // …whereas without the plan day the same run would be flagged too fast for threshold.
    expect(analyzeCompliance(kindNote, mid / 60, 5, 5)!.paceCompliance.direction).toBe('too_fast');
  });

  it('FIRST long tempos are marathon-pace runs everywhere (T-4)', () => {
    const w = first.weeks.findIndex((wk) => (wk.days[3].distanceMi ?? 0) >= 8);
    const day = first.weeks[w].days[3];
    expect(targetForDay(day, VDOT)!.category).toBe('marathon_pace');
    expect(watchFor(first, w, 3).name).toMatch(/^Marathon Pace/);
  });

  it('FIRST and Hansons speed days keep their own reps on Today and the watch (T-10)', () => {
    for (const [plan, week] of [
      [first, 2],
      [hansons, 5],
    ] as const) {
      const day = plan.weeks[week].days[1];
      const reps = parsePlanReps(day.label)!;
      expect(targetForDay(day, VDOT)!.intervals![0].repeats).toBe(reps.repeats);
      expect(watchFor(plan, week, 1).description).toContain(`Main set ${reps.repeats}x\n- ${reps.meters}mtr`);
    }
  });

  it('Hansons Thursday tempo keeps all its marathon-pace miles on the watch (T-17)', () => {
    const day = hansons.weeks[12].days[3]; // "8 mi tempo at marathon pace", 10 mi
    expect(day.label).toBe('8 mi tempo at marathon pace');
    const today = targetForDay(day, VDOT)!;
    expect(today.intervals![0].description).toBe('1mi warmup → 8mi at marathon pace → 1mi cooldown');
    const mp = watchRange(paces.marathon - 5, paces.marathon + 5);
    expect(watchFor(hansons, 12, 3).description).toContain(`Marathon pace\n- 8mi ${mp} Pace`);
  });
});
