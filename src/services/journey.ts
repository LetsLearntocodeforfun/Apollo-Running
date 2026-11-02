/**
 * Journey state (v1.0.6): where the athlete is between plan start and race day.
 *
 * `getRaceDate()` is the single race-date reader for the app:
 *   ActivePlan.raceDate → derived from the plan's start date + race day →
 *   `getMyRace().date` → null.
 *
 * v1.0.9: a plan without a race day (base, recovery and maintenance blocks) has
 * no race date of its own, so the chain falls through to My Race, and the plan
 * adds no taper, race week, race day or post-race phase of its own.
 */

import { getActivePlan, getPlanRaceDayRef, getWeekDayForDate, resolveActivePlanRaceDate } from './planProgress';
import { getEffectivePlan } from './planOverlay';
import { detectPhases } from './periodization';
import type { PhaseName } from './periodization';
import { getMyRace } from './myRace';
import { daysBetween, isDateKey, todayKey } from '../utils/localDate';

export type JourneyPhase =
  'no-plan' | 'pre-plan' | 'training' | 'taper' | 'race-week' | 'race-day' | 'post-race' | 'off-season';

export interface JourneyState {
  phase: JourneyPhase;
  planId: string | null;
  planName: string | null;
  raceDate: string | null;
  /** Calendar days from today to race day (0 on race day, negative afterwards). */
  daysToRace: number | null;
  /** Today's position in the effective plan (null outside the plan). */
  weekIndex: number | null;
  dayIndex: number | null;
  totalWeeks: number | null;
  /** Periodization phase of today's plan week. */
  trainingPhase: PhaseName | null;
}

/** Days before the race at which the journey switches to 'taper' at the latest. */
const TAPER_DAYS = 21;
const POST_RACE_DAYS = 14;

/**
 * The goal race date (YYYY-MM-DD) or null. See the module doc for the fallback chain.
 * v1.0.9: with a plan without a race day active, this is the My Race date (or null).
 */
export function getRaceDate(): string | null {
  const active = getActivePlan();
  if (active) {
    const fromPlan = resolveActivePlanRaceDate(active);
    if (fromPlan) return fromPlan;
  }
  const myRaceDate = getMyRace().date;
  return isDateKey(myRaceDate) ? myRaceDate : null;
}

function phaseFromDaysOnly(daysToRace: number | null): JourneyPhase {
  if (daysToRace === null) return 'no-plan';
  if (daysToRace === 0) return 'race-day';
  if (daysToRace >= 1 && daysToRace <= 7) return 'race-week';
  if (daysToRace <= -1 && daysToRace >= -POST_RACE_DAYS) return 'post-race';
  return 'no-plan';
}

/**
 * v1.0.9: phase while a plan without a race day (a base, recovery or maintenance
 * block) is active. The block brings no taper, race week, race day or post-race
 * of its own; only the athlete's own race (My Race, via `daysToRace`) does. While
 * the block runs, race week and race day still show, but the weeks after a race
 * stay 'training' so the block's workouts (often the recovery itself) stay in view.
 * Before the block: 'pre-plan'; after it: 'off-season'.
 */
function blockPhase(daysToRace: number | null, inBlock: boolean, beforeBlock: boolean): JourneyPhase {
  const racePhase = phaseFromDaysOnly(daysToRace);
  if (inBlock) return racePhase === 'race-day' || racePhase === 'race-week' ? racePhase : 'training';
  if (racePhase !== 'no-plan') return racePhase;
  return beforeBlock ? 'pre-plan' : 'off-season';
}

/** Journey state for `today` (defaults to the local date). Pure: never writes. */
export function getJourneyState(today: string = todayKey()): JourneyState {
  const active = getActivePlan();
  const plan = active ? getEffectivePlan() : null;
  const raceDate = getRaceDate();
  const daysToRace = raceDate ? daysBetween(today, raceDate) : null;

  if (!active || !plan) {
    return {
      phase: phaseFromDaysOnly(daysToRace),
      planId: null,
      planName: null,
      raceDate,
      daysToRace,
      weekIndex: null,
      dayIndex: null,
      totalWeeks: null,
      trainingPhase: null,
    };
  }

  const pos = getWeekDayForDate(active.startDate, plan.weeks.length, today);
  let trainingPhase: PhaseName | null = null;
  if (pos) {
    const phases = detectPhases(plan);
    trainingPhase = phases.find((p) => pos.weekIndex >= p.startWeek && pos.weekIndex <= p.endWeek)?.name ?? null;
  }

  let phase: JourneyPhase;
  if (!getPlanRaceDayRef(plan)) {
    // v1.0.9: a block without a race day (see blockPhase). Phase detection gives such a
    // block one base phase, so it has no taper or race week of its own either.
    phase = blockPhase(daysToRace, pos !== null, daysBetween(today, active.startDate) > 0);
  } else if (daysToRace !== null && daysToRace === 0) phase = 'race-day';
  else if (daysToRace !== null && daysToRace >= 1 && daysToRace <= 7) phase = 'race-week';
  else if (daysToRace !== null && daysToRace < 0) phase = daysToRace >= -POST_RACE_DAYS ? 'post-race' : 'off-season';
  else if (daysBetween(today, active.startDate) > 0) phase = 'pre-plan';
  else if ((daysToRace !== null && daysToRace <= TAPER_DAYS) || trainingPhase === 'taper') phase = 'taper';
  else phase = 'training';

  return {
    phase,
    planId: active.planId,
    planName: plan.name,
    raceDate,
    daysToRace,
    weekIndex: pos?.weekIndex ?? null,
    dayIndex: pos?.dayIndex ?? null,
    totalWeeks: plan.weeks.length,
    trainingPhase,
  };
}
