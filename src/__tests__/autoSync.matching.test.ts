/**
 * Flexible plan matching (T2a, v1.0.6, Top-10 #8): ±2 days within the plan
 * week, scored by date proximity, distance similarity and long ↔ longest.
 */
import { describe, it, expect } from 'vitest';
import type { Activity } from '@/services/activity/types';
import {
  matchActivitiesToPlan,
  syncPlanWithActivities,
  getWeeklyMileageSummary,
  getAllWeeklyMileage,
} from '@/services/autoSync';
import { getSyncMeta, isDayCompleted, setDayCompleted, startPlan } from '@/services/planProgress';
import { getEffectivePlan } from '@/services/planOverlay';
import { getPlanById, type TrainingPlan } from '@/data/plans';
import { addDays } from '@/utils/localDate';

const METERS_PER_MILE = 1609.344;
const START = '2025-12-15'; // Monday — Novice 1 placed for a 2026-04-19 race

let nextId = 1;
function act(date: string, miles: number, type = 'Run', movingSec?: number): Activity {
  const id = nextId++;
  return {
    id,
    name: `${type} ${id}`,
    type,
    sport_type: type,
    distance: miles * METERS_PER_MILE,
    moving_time: movingSec ?? Math.round(miles * 600),
    elapsed_time: movingSec ?? Math.round(miles * 620),
    start_date: `${date}T14:00:00Z`,
    start_date_local: `${date}T07:00:00Z`,
    kudos_count: 0,
  } as Activity;
}

/** Date of plan week w (0-based), day d (0 = Monday). */
const day = (w: number, d: number) => addDays(START, w * 7 + d);

function placedNovice1(): TrainingPlan {
  startPlan({ planId: 'hal-higdon-novice-1', raceDate: '2026-04-19' }, '2025-12-01');
  return getEffectivePlan()!;
}

describe('matchActivitiesToPlan (pure)', () => {
  it('a Sunday long run fills Saturday’s long slot', () => {
    const plan = placedNovice1();
    // Week 2 (index 1): Sat = long run, Sun = cross.
    const sat = plan.weeks[1].days[5];
    expect(sat.type).toBe('run');
    const sunday = act(day(1, 6), sat.distanceMi! + 0.2);
    const { matches } = matchActivitiesToPlan(plan, START, [sunday], day(2, 0));
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ weekIndex: 1, dayIndex: 5, activityDate: day(1, 6) });
  });

  it('a run on a rest day makes up a nearby missed workout', () => {
    const plan = placedNovice1();
    expect(plan.weeks[0].days[0].type).toBe('rest'); // Monday rest
    const monday = act(day(0, 0), plan.weeks[0].days[1].distanceMi!);
    const { matches } = matchActivitiesToPlan(plan, START, [monday], day(0, 3));
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ weekIndex: 0, dayIndex: 1 });
  });

  it('two runs on one day never double-count and both count toward weekly mileage', () => {
    const plan = placedNovice1();
    const a = act(day(0, 1), 3);
    const b = act(day(0, 1), 2);
    const thu = act(day(0, 3), 3);
    const { matches, weekRunMiles } = matchActivitiesToPlan(plan, START, [a, b, thu], day(0, 6));
    const ids = matches.map((m) => m.activity.id);
    expect(new Set(ids).size).toBe(ids.length);
    const slots = matches.map((m) => `${m.weekIndex}:${m.dayIndex}`);
    expect(new Set(slots).size).toBe(slots.length);
    expect(matches.find((m) => m.dayIndex === 1)?.activity.id).toBe(a.id);
    expect(matches.find((m) => m.dayIndex === 3)?.activity.id).toBe(thu.id);
    expect(weekRunMiles[0]).toBeCloseTo(8, 5);
  });

  it('a same-day run beats a neighbour that would fit the distance', () => {
    const plan = placedNovice1();
    const tue = act(day(0, 1), 3);
    const wed = act(day(0, 2), 3);
    const { matches } = matchActivitiesToPlan(plan, START, [tue, wed], day(0, 6));
    expect(matches.find((m) => m.activity.id === tue.id)?.dayIndex).toBe(1);
    expect(matches.find((m) => m.activity.id === wed.id)?.dayIndex).toBe(2);
  });

  it('never matches across plan weeks or more than 2 days away', () => {
    const plan = placedNovice1();
    // Monday of week 2 can't fill Saturday of week 1 (different week, 2 days away).
    const mon = act(day(1, 0), plan.weeks[0].days[5].distanceMi!);
    const { matches } = matchActivitiesToPlan(plan, START, [mon], day(1, 6));
    expect(matches.every((m) => m.weekIndex === 1)).toBe(true);
    // A Friday run can't fill Tuesday (3 days away).
    const fri = act(day(2, 4), plan.weeks[2].days[1].distanceMi!);
    const res = matchActivitiesToPlan(plan, START, [fri], day(2, 6));
    expect(res.matches.find((m) => m.dayIndex === 1)).toBeUndefined();
  });

  it('a short jog can’t stand in for a long run on another day', () => {
    const plan = placedNovice1();
    const longDay = plan.weeks[6].days[5]; // 12 mi
    expect(longDay.distanceMi).toBeGreaterThanOrEqual(10);
    const jog = act(day(6, 6), 2);
    const { matches } = matchActivitiesToPlan(plan, START, [jog], day(7, 0));
    expect(matches.find((m) => m.dayIndex === 5)).toBeUndefined();
  });

  it('rides fill cross days but never run days', () => {
    const plan = placedNovice1();
    const ride = act(day(0, 6), 15, 'Ride', 3600);
    const rideOnRunDay = act(day(0, 2), 15, 'Ride', 3600);
    const { matches } = matchActivitiesToPlan(plan, START, [ride, rideOnRunDay], day(1, 0));
    expect(matches.find((m) => m.activity.id === ride.id)).toMatchObject({ weekIndex: 0, dayIndex: 6 });
    expect(matches.find((m) => m.activity.id === rideOnRunDay.id && m.dayIndex !== 6)).toBeUndefined();
  });

  it('ignores activities before the plan start and after today', () => {
    const plan = placedNovice1();
    const before = act(addDays(START, -1), 3);
    const future = act(day(0, 4), 3);
    const { matches } = matchActivitiesToPlan(plan, START, [before, future], day(0, 3));
    expect(matches).toHaveLength(0);
  });
});

describe('syncPlanWithActivities (match + save)', () => {
  it('completes matched days, records the activity date, and counts extra runs in weekly mileage', () => {
    const plan = placedNovice1();
    const planId = 'hal-higdon-novice-1';
    const sat = plan.weeks[1].days[5];
    const sunday = act(day(1, 6), sat.distanceMi!);
    const extra = act(day(1, 6), 2); // second run the same day: no slot, still mileage
    const results = syncPlanWithActivities([sunday, extra], day(2, 0));
    expect(results.some((r) => r.weekIndex === 1 && r.dayIndex === 5)).toBe(true);
    expect(isDayCompleted(planId, 1, 5)).toBe(true);
    expect(getSyncMeta(planId, 1, 5)).toMatchObject({ activityId: sunday.id, activityDate: day(1, 6), autoCompleted: true });
    const wm = getWeeklyMileageSummary(planId, 1)!;
    expect(wm.actualMi).toBeCloseTo(sat.distanceMi! + 2, 1);
    expect(getAllWeeklyMileage(planId)).toHaveLength(plan.weeks.length);
  });

  it('un-completes a day only when auto-sync completed it and its activity went away', () => {
    placedNovice1();
    const planId = 'hal-higdon-novice-1';
    const tue = act(day(0, 1), 3);
    const thu = act(day(0, 3), 3);
    syncPlanWithActivities([tue, thu], day(0, 6));
    expect(isDayCompleted(planId, 0, 1)).toBe(true);
    // Athlete ticked Wednesday by hand; Thursday was auto-completed.
    setDayCompleted(planId, 0, 2, true);
    // Thursday's activity is deleted/hidden.
    syncPlanWithActivities([tue], day(0, 6));
    expect(isDayCompleted(planId, 0, 1)).toBe(true);
    expect(isDayCompleted(planId, 0, 2)).toBe(true);
    expect(isDayCompleted(planId, 0, 3)).toBe(false);
    expect(getSyncMeta(planId, 0, 3)).toBeNull();
  });

  it('is idempotent: a second pass reports nothing new', () => {
    placedNovice1();
    const tue = act(day(0, 1), 3);
    expect(syncPlanWithActivities([tue], day(0, 6))).toHaveLength(1);
    expect(syncPlanWithActivities([tue], day(0, 6))).toHaveLength(0);
  });

  it('base plan objects are untouched', () => {
    const before = JSON.stringify(getPlanById('hal-higdon-novice-1'));
    placedNovice1();
    syncPlanWithActivities([act(day(0, 1), 3)], day(0, 6));
    expect(JSON.stringify(getPlanById('hal-higdon-novice-1'))).toBe(before);
  });
});
