/**
 * Plan fidelity (T2a, v1.0.6 — V8–V11, V20 classifier, V21): every built-in plan
 * and the custom builder are checked for run days, longest run, taper, race-week
 * limits, nothing after the race, and the note taxonomy.
 */
import { describe, it, expect } from 'vitest';
import {
  BUILT_IN_PLANS,
  PLAN_NOTE_TAXONOMY,
  createCustomPlanFromScratch,
  getPlanById,
  getWorkoutKind,
  suggestPlansForRunner,
  type CustomDayType,
  type PlanDay,
  type TrainingPlan,
} from '@/data/plans';
import { getRaceDayRef } from '@/services/planProgress';

const QUALITY = new Set(['tempo', 'speed', 'strength', 'marathon_pace']);
const isRunDay = (d: PlanDay) => d.type === 'run' || d.type === 'race' || d.type === 'marathon';
const trainingMiles = (days: PlanDay[]) => days.reduce((s, d) => s + (d.type === 'run' ? d.distanceMi ?? 0 : 0), 0);

interface Expected {
  weeks: number;
  /** Allowed run days per week [min, max]. */
  runDays: [number, number];
  /** Longest training run (miles). */
  longest: number;
  /** Peak weekly training miles [min, max]. */
  peak: [number, number];
}

const EXPECTED: Record<string, Expected> = {
  'hal-higdon-novice-1': { weeks: 18, runDays: [4, 4], longest: 20, peak: [38, 42] },
  'hal-higdon-novice-2': { weeks: 18, runDays: [4, 4], longest: 20, peak: [34, 38] },
  'hansons-beginner': { weeks: 18, runDays: [6, 6], longest: 16, peak: [54, 60] },
  'hal-higdon-intermediate-1': { weeks: 18, runDays: [4, 5], longest: 20, peak: [42, 50] },
  'hal-higdon-advanced-1': { weeks: 18, runDays: [5, 6], longest: 20, peak: [54, 62] },
  'pfitzinger-18-55': { weeks: 18, runDays: [5, 5], longest: 20, peak: [52, 58] },
  'nike-run-club-marathon': { weeks: 18, runDays: [5, 5], longest: 20, peak: [36, 44] },
  first: { weeks: 16, runDays: [3, 3], longest: 20, peak: [30, 38] },
};

/** Shared fidelity rules for any marathon plan. */
function checkCommonRules(plan: TrainingPlan): void {
  const last = plan.weeks.length - 1;
  // Race on the plan's final day, nothing after it.
  const race = getRaceDayRef(plan);
  expect(plan.weeks[race.weekIndex].days[race.dayIndex].type).toBe('marathon');
  expect(race).toEqual({ weekIndex: last, dayIndex: 6 });

  // Note taxonomy.
  for (const week of plan.weeks) {
    for (const day of week.days) {
      if (day.note !== undefined) expect(PLAN_NOTE_TAXONOMY as readonly string[]).toContain(day.note);
    }
    // At most one long run per week.
    expect(week.days.filter((d) => getWorkoutKind(d) === 'long').length).toBeLessThanOrEqual(1);
  }

  // Taper: each of the last two weeks ≤ 75 % of the peak training week.
  const volumes = plan.weeks.map((w) => trainingMiles(w.days));
  const peak = Math.max(...volumes);
  expect(volumes[last - 1]).toBeLessThanOrEqual(0.75 * peak + 1e-9);
  expect(volumes[last]).toBeLessThanOrEqual(0.75 * peak + 1e-9);

  // Race-week limits.
  const raceWeek = plan.weeks[last].days;
  const quality = raceWeek.filter((d) => QUALITY.has(getWorkoutKind(d)));
  for (const d of raceWeek) {
    if (d.type === 'run') expect(d.distanceMi ?? 0).toBeLessThanOrEqual(8);
    expect(getWorkoutKind(d)).not.toBe('long');
  }
  for (const d of quality) expect(d.distanceMi ?? 0).toBeLessThanOrEqual(6);
  expect(trainingMiles(quality)).toBeLessThanOrEqual(10);
  // No quality in the two days before the race.
  expect(QUALITY.has(getWorkoutKind(raceWeek[5]))).toBe(false);
  expect(QUALITY.has(getWorkoutKind(raceWeek[4]))).toBe(false);
}

describe.each(BUILT_IN_PLANS.map((p) => [p.id, p] as [string, TrainingPlan]))('plan fidelity: %s', (id, plan) => {
  const exp = EXPECTED[id];

  it('has an expectation entry and the expected length', () => {
    expect(exp).toBeDefined();
    expect(plan.weeks).toHaveLength(exp.weeks);
    expect(plan.totalWeeks).toBe(exp.weeks);
  });

  it('keeps run days per week in range', () => {
    for (const week of plan.weeks) {
      const n = week.days.filter(isRunDay).length;
      expect(n, `week ${week.weekNumber}`).toBeGreaterThanOrEqual(exp.runDays[0]);
      expect(n, `week ${week.weekNumber}`).toBeLessThanOrEqual(exp.runDays[1]);
    }
  });

  it('has the expected longest run, noted Long, and peak volume', () => {
    const runs = plan.weeks.flatMap((w) => w.days).filter((d) => d.type === 'run');
    const longest = Math.max(...runs.map((d) => d.distanceMi ?? 0));
    expect(longest).toBe(exp.longest);
    for (const d of runs.filter((r) => r.distanceMi === longest)) expect(d.note).toBe('Long');
    const peak = Math.max(...plan.weeks.map((w) => trainingMiles(w.days)));
    expect(peak).toBeGreaterThanOrEqual(exp.peak[0]);
    expect(peak).toBeLessThanOrEqual(exp.peak[1]);
  });

  it('follows the common rules (race last, taxonomy, taper, race week)', () => {
    checkCommonRules(plan);
  });
});

describe('Higdon plans', () => {
  const higdon = BUILT_IN_PLANS.filter((p) => p.author === 'Hal Higdon');

  it('note every week’s long run as Long (V9)', () => {
    for (const plan of higdon) {
      plan.weeks.forEach((week, w) => {
        if (week.days.some((d) => d.type === 'race' || d.type === 'marathon')) return;
        const runs = week.days.filter((d) => d.type === 'run');
        const longest = Math.max(...runs.map((d) => d.distanceMi ?? 0));
        const longDay = runs.find((d) => d.distanceMi === longest && d.note === 'Long');
        expect(longDay, `${plan.id} week ${w + 1}`).toBeDefined();
      });
    }
  });

  it('have marathon-pace days (Novice 2 Wednesdays, Intermediate/Advanced Saturdays)', () => {
    const n2 = getPlanById('hal-higdon-novice-2')!;
    expect(getWorkoutKind(n2.weeks[0].days[2])).toBe('marathon_pace');
    expect(getWorkoutKind(n2.weeks[1].days[2])).toBe('easy');
    const i1 = getPlanById('hal-higdon-intermediate-1')!;
    expect(getWorkoutKind(i1.weeks[0].days[5])).toBe('marathon_pace');
    expect(i1.weeks[0].days[0].type).toBe('cross');
    const a1 = getPlanById('hal-higdon-advanced-1')!;
    expect(a1.weeks[14].days[3].label).toBe('8 × 800 m');
    expect(getWorkoutKind(a1.weeks[14].days[5])).toBe('marathon_pace');
  });

  it('describe the plans as "based on"', () => {
    for (const plan of BUILT_IN_PLANS) expect(plan.description).toMatch(/^Based on/);
  });
});

describe('Hansons Beginner (V8)', () => {
  const plan = getPlanById('hansons-beginner')!;

  it('rests every Wednesday and runs the other six days', () => {
    for (const week of plan.weeks) {
      expect(week.days[2].type).toBe('rest');
      expect(week.days.filter(isRunDay)).toHaveLength(6);
    }
  });

  it('does speed in weeks 6–10, strength in weeks 11–17, Thursday tempo at MP', () => {
    for (let w = 5; w <= 9; w++) expect(getWorkoutKind(plan.weeks[w].days[1])).toBe('speed');
    for (let w = 10; w <= 16; w++) expect(getWorkoutKind(plan.weeks[w].days[1])).toBe('strength');
    for (let w = 5; w <= 16; w++) expect(getWorkoutKind(plan.weeks[w].days[3])).toBe('marathon_pace');
    for (let w = 0; w <= 4; w++) expect(QUALITY.has(getWorkoutKind(plan.weeks[w].days[1]))).toBe(false);
  });

  it('caps the long run at 16 mi and tapers for ~10 days (no long tempo in race week)', () => {
    const longs = plan.weeks.flatMap((w) => w.days).filter((d) => getWorkoutKind(d) === 'long');
    expect(Math.max(...longs.map((d) => d.distanceMi ?? 0))).toBe(16);
    // The last session > 6 mi is ≥ 10 days before the race.
    let lastHard = -1;
    plan.weeks.forEach((week, w) =>
      week.days.forEach((d, i) => {
        if (QUALITY.has(getWorkoutKind(d)) && (d.distanceMi ?? 0) > 6) lastHard = w * 7 + i;
      }),
    );
    const raceIdx = 17 * 7 + 6;
    expect(raceIdx - lastHard).toBeGreaterThanOrEqual(10);
    const raceWeekTempo = plan.weeks[17].days.filter((d) => QUALITY.has(getWorkoutKind(d)));
    expect(raceWeekTempo.every((d) => (d.distanceMi ?? 0) < 10)).toBe(true);
  });
});

describe('FIRST (V9)', () => {
  it('is 16 weeks with the interval session short in race week', () => {
    const plan = getPlanById('first')!;
    expect(plan.totalWeeks).toBe(16);
    expect(plan.weeks[15].days[1].distanceMi).toBeLessThanOrEqual(4);
    expect(plan.weeks[15].days[6].type).toBe('marathon');
  });
});

describe('getWorkoutKind (V20)', () => {
  it('never treats "tempo" as marathon pace', () => {
    expect(getWorkoutKind({ type: 'run', label: '6 mi tempo', distanceMi: 6, note: 'Tempo' })).toBe('tempo');
    expect(getWorkoutKind({ type: 'run', label: '8 mi marathon pace', distanceMi: 8, note: 'Tempo' })).toBe('marathon_pace');
    expect(getWorkoutKind({ type: 'race', label: 'Half Marathon', distanceMi: 13.1, note: 'Race' })).toBe('race');
  });
});

// ── Custom builder (V10 / V11) ───────────────────────────────────────────────

const makeAssignments = (map: Partial<Record<number, CustomDayType>>): Record<number, CustomDayType> => {
  const result: Record<number, CustomDayType> = {};
  for (let d = 0; d < 7; d++) result[d] = map[d] ?? 'rest';
  return result;
};

describe('custom builder fidelity', () => {
  const inputs = [
    { name: '20→40, 4 days', totalWeeks: 18, runningDays: 4, currentWeeklyMiles: 20, peakWeeklyMiles: 40 },
    { name: '30→55, 5 days', totalWeeks: 16, runningDays: 5, currentWeeklyMiles: 30, peakWeeklyMiles: 55 },
    { name: '15→25, 3 days', totalWeeks: 12, runningDays: 3, currentWeeklyMiles: 15, peakWeeklyMiles: 25 },
    { name: '45→70, 6 days', totalWeeks: 20, runningDays: 6, currentWeeklyMiles: 45, peakWeeklyMiles: 70 },
    { name: '10 weeks', totalWeeks: 10, runningDays: 4, currentWeeklyMiles: 25, peakWeeklyMiles: 40 },
  ];

  it.each(inputs.map((i) => [i.name, i] as const))('%s: long runs reach 16–20 mi 3 weeks out, then a 3-week taper', (_n, input) => {
    const plan = createCustomPlanFromScratch(input);
    const T = plan.weeks.length;
    const targetLong = Math.min(20, Math.max(16, Math.round(0.4 * Math.max(input.peakWeeklyMiles, input.currentWeeklyMiles + 4) * 2) / 2));
    const longOf = (w: number) => plan.weeks[w].days.find((d) => getWorkoutKind(d) === 'long')?.distanceMi ?? 0;
    // Review probe [E]: 20→40 mpw used to top out at 12.4 mi.
    expect(Math.max(...plan.weeks.map((_, w) => longOf(w)))).toBe(targetLong);
    expect(longOf(T - 4)).toBe(targetLong);
    expect(longOf(T - 3)).toBeLessThan(targetLong * 0.9);
    expect(longOf(T - 2)).toBeLessThan(targetLong * 0.9);
    // Cutback weeks: some build week's long run is shorter than the week before.
    if (T >= 12) expect(plan.weeks.some((_, w) => w > 0 && w < T - 4 && longOf(w) < longOf(w - 1))).toBe(true);
    // Taper ≈ 80 / 60 / 40 % of peak training volume.
    const vols = plan.weeks.map((w) => trainingMiles(w.days));
    const peak = Math.max(...vols);
    expect(vols[T - 3] / peak).toBeGreaterThan(0.65);
    expect(vols[T - 3] / peak).toBeLessThanOrEqual(0.9);
    expect(vols[T - 2] / peak).toBeLessThanOrEqual(0.7);
    expect(vols[T - 1] / peak).toBeLessThanOrEqual(0.5);
    checkCommonRules(plan);
    // Exactly one long day in every non-race week.
    for (let w = 0; w < T - 1; w++) {
      expect(plan.weeks[w].days.filter((d) => getWorkoutKind(d) === 'long')).toHaveLength(1);
    }
  });

  it('enforces a single long day when two are assigned (V11 probe)', () => {
    const plan = createCustomPlanFromScratch({
      name: 'Two longs',
      totalWeeks: 16,
      runningDays: 4,
      currentWeeklyMiles: 25,
      peakWeeklyMiles: 45,
      dayAssignments: makeAssignments({ 1: 'easy', 3: 'tempo', 5: 'long', 6: 'long' }),
    });
    for (let w = 0; w < 15; w++) {
      expect(plan.weeks[w].days.filter((d) => getWorkoutKind(d) === 'long')).toHaveLength(1);
      expect(plan.weeks[w].days[6].note).toBe('Long');
      expect(plan.weeks[w].days[5].note).toBe('Medium Long');
    }
    const raceWeek = plan.weeks[15].days;
    expect(raceWeek.filter((d) => d.type === 'marathon')).toHaveLength(1);
    expect(raceWeek[6].type).toBe('marathon');
  });

  it('puts the race on the final day even with a Saturday long run — nothing after it (V11 probe)', () => {
    const plan = createCustomPlanFromScratch({
      name: 'Saturday long',
      totalWeeks: 16,
      runningDays: 4,
      currentWeeklyMiles: 25,
      peakWeeklyMiles: 45,
      dayAssignments: makeAssignments({ 1: 'easy', 2: 'tempo', 4: 'easy', 5: 'long' }),
    });
    const raceWeek = plan.weeks[15].days;
    expect(raceWeek[6].type).toBe('marathon');
    expect(raceWeek[5].label).toMatch(/shakeout \+ strides/);
    expect(raceWeek[5].distanceMi).toBeLessThanOrEqual(3);
    expect(raceWeek.filter((d) => d.type === 'run').every((d) => (d.distanceMi ?? 0) >= 2)).toBe(true);
    expect(raceWeek.some((d) => /1 mi tempo/.test(d.label))).toBe(false);
  });
});

// ── suggestPlansForRunner (V21) ──────────────────────────────────────────────

describe('suggestPlansForRunner entry fit (V21)', () => {
  it('scores entry against weeks 1–3, not the peak', () => {
    const recs = suggestPlansForRunner(15, 4);
    expect(recs[0].planId).toBe('hal-higdon-novice-1');
    expect(recs[0].reason).toMatch(/weeks 1–3/);
  });

  it('does not put a novice plan first for a 45 mpw, 6-day runner', () => {
    const recs = suggestPlansForRunner(45, 6);
    expect(recs[0].planId).not.toMatch(/novice/);
  });

  it('prefers plans that start near current volume', () => {
    const top = suggestPlansForRunner(32, 5)[0];
    const plan = getPlanById(top.planId)!;
    const entry = plan.weeks.slice(0, 3).reduce((s, w) => s + trainingMiles(w.days), 0) / 3;
    expect(Math.abs(entry - 32)).toBeLessThanOrEqual(12);
  });
});
