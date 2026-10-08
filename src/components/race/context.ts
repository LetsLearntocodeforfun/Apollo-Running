/**
 * Race Day hub state (v1.0.6): everything the My Race header and the tab
 * panels need, resolved from My Race, the active plan, the race database,
 * saved strategies and the athlete profile. Pure: reads only, never writes.
 */
import { getMyRace, type MyRace } from '../../services/myRace';
import { getRaceDate } from '../../services/journey';
import { getActivePlan } from '../../services/planProgress';
import { getMarathon, getRaceDistanceMi, getStrategyById } from '../../services/raceStrategy';
import { normalizeMarathonId } from '../../data/worldMajors';
import { daysBetween, isDateKey, todayKey } from '../../utils/localDate';
import { getMarathonGoal, scaleMarathonTime, type GoalSource } from './goal';
import type { RaceDayContext } from './types';
import type { RaceStrategy } from '../../types/raceStrategy';

export type RaceDayTab = 'strategy' | 'fuel' | 'race-week' | 'race-morning' | 'course';

export const RACE_DAY_TABS: { id: RaceDayTab; label: string }[] = [
  { id: 'strategy', label: 'Strategy' },
  { id: 'fuel', label: 'Fuel' },
  { id: 'race-week', label: 'Race Week' },
  { id: 'race-morning', label: 'Race Morning' },
  { id: 'course', label: 'Course' },
];

/** True for a known hub tab id. */
export function isRaceDayTab(id: string | null | undefined): id is RaceDayTab {
  return RACE_DAY_TABS.some((t) => t.id === id);
}

/**
 * Default tab by days to race: > 21 Strategy, 8–21 Fuel, 1–7 Race Week,
 * race day Race Morning. No date or a past race → Strategy.
 */
export function defaultTabForDays(daysToRace: number | null): RaceDayTab {
  if (daysToRace === null || daysToRace < 0) return 'strategy';
  if (daysToRace === 0) return 'race-morning';
  if (daysToRace <= 7) return 'race-week';
  if (daysToRace <= 21) return 'fuel';
  return 'strategy';
}

export interface RaceDayState {
  ctx: RaceDayContext;
  myRace: MyRace;
  /** True when a training plan is active (the plan owns the race date). */
  hasActivePlan: boolean;
  /** Where `ctx.raceDate` came from. */
  raceDateSource: 'plan' | 'my-race' | 'race' | null;
  /**
   * With an active plan: the selected race's calendar date when it differs
   * from the plan's race date (show a notice linking to the plan), else null.
   */
  raceDateMismatch: { planDate: string; raceDate: string } | null;
  /** Where `ctx.goalTimeSec` came from. */
  goalSource: 'strategy' | GoalSource | null;
  /** A saved race-day strategy that belongs to a different race (ignored). */
  mismatchedStrategy: RaceStrategy | null;
  /** My Race points at a race that no longer exists. */
  raceMissing: boolean;
}

/** Resolve the hub state for `today` (local date key). */
export function buildRaceDayState(today: string = todayKey()): RaceDayState {
  const myRace = getMyRace();
  const race = myRace.raceId ? getMarathon(myRace.raceId) ?? null : null;
  const hasActivePlan = getActivePlan() !== null;

  const journeyDate = getRaceDate(); // plan race date → My Race date → null
  const raceEditionDate = race && isDateKey(race.date) ? race.date : null;
  let raceDate: string | null = journeyDate;
  let raceDateSource: RaceDayState['raceDateSource'] = journeyDate ? (hasActivePlan ? 'plan' : 'my-race') : null;
  if (!raceDate && raceEditionDate) {
    raceDate = raceEditionDate;
    raceDateSource = 'race';
  }
  const raceDateMismatch = hasActivePlan && journeyDate && raceEditionDate && journeyDate !== raceEditionDate
    ? { planDate: journeyDate, raceDate: raceEditionDate }
    : null;

  let strategy = myRace.activeStrategyId ? getStrategyById(myRace.activeStrategyId) ?? null : null;
  let mismatchedStrategy: RaceStrategy | null = null;
  if (strategy && race && normalizeMarathonId(strategy.marathonId) !== normalizeMarathonId(race.id)) {
    mismatchedStrategy = strategy;
    strategy = null;
  }

  let goalTimeSec: number | null = null;
  let goalSource: RaceDayState['goalSource'] = null;
  if (strategy) {
    goalTimeSec = strategy.targetTimeSec;
    goalSource = 'strategy';
  } else {
    const goal = getMarathonGoal();
    if (goal.source !== 'default') {
      goalTimeSec = scaleMarathonTime(goal.sec, race ? getRaceDistanceMi(race) : 26.21875);
      goalSource = goal.source;
    }
  }

  const startTime = myRace.startTime ?? (race?.startTime && /^([01]\d|2[0-3]):[0-5]\d$/.test(race.startTime) ? race.startTime : null);
  const timeZone = myRace.timeZone ?? race?.timeZone ?? null;

  return {
    ctx: {
      race,
      raceDate,
      startTime,
      timeZone,
      wave: myRace.wave ?? null,
      goalTimeSec,
      strategy,
      today,
      daysToRace: raceDate ? daysBetween(today, raceDate) : null,
    },
    myRace,
    hasActivePlan,
    raceDateSource,
    raceDateMismatch,
    goalSource,
    mismatchedStrategy,
    raceMissing: !!myRace.raceId && !race,
  };
}
