/**
 * Goal-time defaults for the Race Day hub (v1.0.6).
 *
 * The single goal store is `athleteProfile.goalMarathonSec`. New strategies
 * default to it; when it is unset we use the race prediction's point estimate
 * (`getPredictedMarathonSec()`), then a sensible fallback. A saved strategy
 * keeps its own target time. Nothing here writes.
 */
import { getAthleteProfile } from '../../services/athleteProfile';
import { getPredictedMarathonSec } from '../../services/racePrediction';
import { MARATHON_MI } from '../../services/raceStrategy';

/** Fallback marathon goal when there is neither a profile goal nor a prediction. */
export const FALLBACK_MARATHON_GOAL_SEC = 4 * 3600;

export type GoalSource = 'profile' | 'prediction' | 'default';

export interface MarathonGoal {
  /** Marathon goal time in seconds. */
  sec: number;
  /** Where the value came from. */
  source: GoalSource;
}

/** Marathon goal: profile goal → predicted marathon time → 4:00:00. */
export function getMarathonGoal(): MarathonGoal {
  const profileGoal = getAthleteProfile().goalMarathonSec;
  if (typeof profileGoal === 'number' && profileGoal > 0) return { sec: profileGoal, source: 'profile' };
  let predicted: number | null = null;
  try {
    predicted = getPredictedMarathonSec();
  } catch {
    predicted = null;
  }
  if (typeof predicted === 'number' && Number.isFinite(predicted) && predicted > 0) {
    return { sec: Math.round(predicted), source: 'prediction' };
  }
  return { sec: FALLBACK_MARATHON_GOAL_SEC, source: 'default' };
}

/**
 * Scale a marathon time to another distance with Riegel's formula
 * (exponent 1.06). Returns the marathon time unchanged for ~26.2 mi.
 */
export function scaleMarathonTime(marathonSec: number, distanceMi: number): number {
  if (!Number.isFinite(distanceMi) || distanceMi <= 0) return Math.round(marathonSec);
  if (Math.abs(distanceMi - MARATHON_MI) < 0.1) return Math.round(marathonSec);
  return Math.round(marathonSec * Math.pow(distanceMi / MARATHON_MI, 1.06));
}

/** Default goal (s) for a new strategy on a race of `distanceMi` miles. */
export function getDefaultGoalSec(distanceMi: number): number {
  return scaleMarathonTime(getMarathonGoal().sec, distanceMi);
}
