/**
 * Explicit My Race actions for the Race Day hub (v1.0.6). Each function is
 * called from a user action (never on render) and writes through
 * `setMyRace`, which notifies listeners.
 */
import { getMyRace, setMyRace, type MyRace } from '../../services/myRace';
import { getActivePlan } from '../../services/planProgress';
import { getStrategyById } from '../../services/raceStrategy';
import { normalizeMarathonId } from '../../data/worldMajors';
import { isDateKey } from '../../utils/localDate';
import type { MarathonRace } from '../../types/raceStrategy';

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Make `race` the athlete's My Race. Copies the race's start time and time
 * zone. Writes `date` only when no training plan is active (the plan owns
 * the race date and is never re-anchored from the hub). Clears the race-day
 * strategy when it belongs to another race. Returns the saved record.
 */
export function chooseMyRace(race: MarathonRace): MyRace {
  const current = getMyRace();
  const patch: Partial<MyRace> = {
    raceId: race.id,
    startTime: race.startTime && HHMM.test(race.startTime) ? race.startTime : undefined,
    timeZone: race.timeZone || undefined,
  };
  if (getActivePlan() === null) patch.date = isDateKey(race.date) ? race.date : undefined;
  if (current.raceId !== race.id) patch.wave = undefined;
  const active = current.activeStrategyId ? getStrategyById(current.activeStrategyId) : undefined;
  if (current.activeStrategyId && (!active || normalizeMarathonId(active.marathonId) !== normalizeMarathonId(race.id))) {
    patch.activeStrategyId = undefined;
  }
  return setMyRace(patch);
}

/**
 * Set the My Race date (YYYY-MM-DD) — only allowed when no plan is active.
 * Returns false (and writes nothing) when a plan owns the date or the key is invalid.
 */
export function setMyRaceDate(date: string): boolean {
  if (getActivePlan() !== null || !isDateKey(date)) return false;
  setMyRace({ date });
  return true;
}
