/**
 * Workout Targets — maps a training plan day to specific VDOT-derived
 * pace targets, HR zones, and interval structures.
 *
 * Takes a plan day's `note` field ("Easy", "Tempo", "Speed", "Long", etc.)
 * and the runner's current VDOT to produce a WorkoutTarget with precise
 * pace ranges and coaching guidance.
 */

import type { WorkoutTarget, WorkoutCategory } from '../types/workout';
import { calculateTrainingPaces, type TrainingPaces } from './paceCalculator';
import { persistence } from './db/persistence';

const TARGETS_CACHE_KEY = 'apollo_workout_targets';

/**
 * Map from plan day `note` field to canonical WorkoutCategory.
 * The note field values found across all built-in plans:
 *   Easy, Tempo, Speed, Long, Medium Long, Strength, Race, Race day
 */
function noteToCategory(note: string): WorkoutCategory {
  const lc = note.toLowerCase().trim();
  if (lc === 'easy' || lc === 'recovery') return 'easy';
  if (lc === 'tempo' || lc === 'marathon pace') return 'tempo';
  if (lc === 'speed' || lc === 'intervals') return 'speed';
  if (lc === 'long') return 'long';
  if (lc === 'medium long') return 'medium_long';
  if (lc === 'strength') return 'strength';
  if (lc === 'race' || lc === 'race day') return 'race';
  return 'easy'; // default to easy for unknown types
}

/**
 * Generate a workout target for a given plan day note and VDOT.
 *
 * @param note The plan day's `note` field (e.g. "Easy", "Tempo")
 * @param vdot The runner's current VDOT score
 * @param distanceMi Optional planned distance in miles (affects long run MP segments)
 * @returns WorkoutTarget with pace ranges, intervals, and coaching guidance
 */
export function getWorkoutTarget(note: string, vdot: number, distanceMi?: number): WorkoutTarget | null {
  if (!note || vdot <= 0) return null;

  const paces = calculateTrainingPaces(vdot);
  if (!paces) return null;

  const category = noteToCategory(note);
  return buildTarget(category, paces, distanceMi);
}

/**
 * Build a complete WorkoutTarget from category and training paces.
 */
function buildTarget(category: WorkoutCategory, paces: TrainingPaces, distanceMi?: number): WorkoutTarget {
  switch (category) {
    case 'easy':
      return buildEasyTarget(paces);
    case 'long':
      return buildLongRunTarget(paces, distanceMi);
    case 'medium_long':
      return buildMediumLongTarget(paces);
    case 'tempo':
      return buildTempoTarget(paces, distanceMi);
    case 'speed':
      return buildSpeedTarget(paces, distanceMi);
    case 'strength':
      return buildStrengthTarget(paces, distanceMi);
    case 'marathon_pace':
      return buildMarathonPaceTarget(paces);
    case 'race':
      return buildRaceTarget(paces);
    case 'rest':
      return { category: 'rest', description: 'Rest day — recovery is training too.' };
    case 'cross':
      return { category: 'cross', description: 'Cross-training: cycling, swimming, or other low-impact activity. Keep effort easy.' };
    default:
      return buildEasyTarget(paces);
  }
}

function buildEasyTarget(paces: TrainingPaces): WorkoutTarget {
  return {
    category: 'easy',
    targetPaceRange: { minSecPerMi: paces.easy.min, maxSecPerMi: paces.easy.max },
    hrZone: 2,
    description: `Easy run at a conversational pace. You should be able to hold a full conversation. ` +
      `If you're breathing too hard to talk, slow down.`,
  };
}

function buildLongRunTarget(paces: TrainingPaces, distanceMi?: number): WorkoutTarget {
  // Long runs: easy pace, but the last few miles of very long runs (18+) can include MP segment
  const target: WorkoutTarget = {
    category: 'long',
    targetPaceRange: { minSecPerMi: paces.easy.min, maxSecPerMi: paces.easy.max },
    hrZone: 2,
    description: `Long run at easy pace. Build endurance without overexerting. ` +
      `Start conservatively — you can pick it up slightly in the final miles if feeling strong.`,
  };

  // For long runs 18+ miles, add optional marathon-pace segment in final 4-6 miles
  if (distanceMi && distanceMi >= 18) {
    const mpSegmentLength = distanceMi >= 20 ? 6 : 4;
    const mpStart = Math.round(distanceMi - mpSegmentLength);
    target.marathonPaceSegment = {
      startMile: mpStart,
      endMile: Math.round(distanceMi),
      paceSecPerMi: paces.marathon,
    };
    target.description += ` Optional: run the last ${mpSegmentLength} miles at marathon pace ` +
      `to practice race-day pacing under fatigue.`;
  }

  return target;
}

function buildMediumLongTarget(paces: TrainingPaces): WorkoutTarget {
  // Medium-long runs (Pfitzinger): slightly faster than easy, but not tempo
  const mlMin = paces.easy.min - 10; // 10s faster than easy range bottom
  const mlMax = paces.easy.max - 5;  // 5s faster than easy range top
  return {
    category: 'medium_long',
    targetPaceRange: { minSecPerMi: mlMin, maxSecPerMi: mlMax },
    hrZone: 2,
    description: `Medium-long run at a pace slightly faster than easy. ` +
      `This builds aerobic endurance without the recovery cost of a true long run.`,
  };
}

function buildTempoTarget(paces: TrainingPaces, distanceMi?: number): WorkoutTarget {
  // Tempo runs: threshold pace ±5 sec/mi tolerance
  const tolerance = 5;
  const target: WorkoutTarget = {
    category: 'tempo',
    targetPaceRange: {
      minSecPerMi: paces.threshold - tolerance,
      maxSecPerMi: paces.threshold + tolerance,
    },
    hrZone: 4,
    description: `Tempo run at threshold pace — comfortably hard. ` +
      `You should be able to speak in short phrases but not hold a conversation. ` +
      `This pace teaches your body to clear lactate efficiently.`,
  };

  // For longer tempo runs (6+ mi), structure as tempo intervals with warmup/cooldown
  if (distanceMi && distanceMi >= 6) {
    const warmupMi = 1;
    const cooldownMi = 1;
    const tempoMi = distanceMi - warmupMi - cooldownMi;
    const tempoMin = Math.round((tempoMi * paces.threshold) / 60);
    target.intervals = [{
      workDurationMin: tempoMin,
      restDurationMin: 0,
      targetPaceSecPerMi: paces.threshold,
      repeats: 1,
      description: `${warmupMi}mi warmup → ${tempoMi}mi at tempo → ${cooldownMi}mi cooldown`,
    }];
  }

  return target;
}

function buildSpeedTarget(paces: TrainingPaces, distanceMi?: number): WorkoutTarget {
  // Speed workouts: interval pace, structured as repeats
  const intervalTolerance = 5;
  const target: WorkoutTarget = {
    category: 'speed',
    targetPaceRange: {
      minSecPerMi: paces.interval - intervalTolerance,
      maxSecPerMi: paces.interval + intervalTolerance,
    },
    hrZone: 5,
    description: `Speed session with interval repeats. Push hard during work intervals, ` +
      `jog easy during rest. This builds VO2max and running economy.`,
  };

  // Standard speed workout structure based on distance
  const totalMi = distanceMi ?? 5;
  const warmupMi = 1;
  const cooldownMi = 1;
  const workMi = Math.max(totalMi - warmupMi - cooldownMi, 2);

  // Default to 800m repeats (0.5mi) with equal rest
  const repeatDistMi = 0.5;
  const repeats = Math.max(Math.round(workMi / repeatDistMi), 3);
  const workMin = Math.round((repeatDistMi * paces.interval) / 60 * 10) / 10;
  const restMin = workMin; // equal work:rest ratio

  target.intervals = [{
    workDurationMin: workMin,
    restDurationMin: restMin,
    targetPaceSecPerMi: paces.interval,
    repeats,
    description: `${warmupMi}mi warmup → ${repeats}×800m at interval pace (${restMin}min jog rest) → ${cooldownMi}mi cooldown`,
  }];

  return target;
}

function buildStrengthTarget(paces: TrainingPaces, _distanceMi?: number): WorkoutTarget {
  // Strength workouts (Hansons): between tempo and easy, focus on muscular endurance
  const strengthPace = Math.round((paces.threshold + paces.marathon) / 2);
  const tolerance = 8;
  return {
    category: 'strength',
    targetPaceRange: {
      minSecPerMi: strengthPace - tolerance,
      maxSecPerMi: strengthPace + tolerance,
    },
    hrZone: 3,
    description: `Strength run — builds muscular endurance at a moderate-hard effort. ` +
      `Pace falls between marathon pace and threshold. Focus on maintaining form when tired.`,
  };
}

function buildMarathonPaceTarget(paces: TrainingPaces): WorkoutTarget {
  const tolerance = 5;
  return {
    category: 'marathon_pace',
    targetPaceRange: {
      minSecPerMi: paces.marathon - tolerance,
      maxSecPerMi: paces.marathon + tolerance,
    },
    hrZone: 3,
    description: `Marathon-pace run — practice your target race pace. ` +
      `This should feel controlled and sustainable. If it feels hard, your target may be too aggressive.`,
  };
}

function buildRaceTarget(paces: TrainingPaces): WorkoutTarget {
  return {
    category: 'race',
    targetPaceRange: {
      minSecPerMi: paces.marathon - 5,
      maxSecPerMi: paces.marathon + 5,
    },
    description: `Race day! Execute your race strategy. Trust your training.`,
  };
}

/**
 * Get workout targets for an entire plan week.
 * Returns a map of dayIndex -> WorkoutTarget for all run days.
 */
export function getWeekTargets(
  weekDays: { note?: string; distanceMi?: number; type: string }[],
  vdot: number,
): Map<number, WorkoutTarget> {
  const targets = new Map<number, WorkoutTarget>();
  if (vdot <= 0) return targets;

  for (let i = 0; i < weekDays.length; i++) {
    const day = weekDays[i];
    if (day.type === 'rest' || !day.note) continue;
    const target = getWorkoutTarget(day.note, vdot, day.distanceMi);
    if (target) targets.set(i, target);
  }

  return targets;
}

/** Cache the latest workout targets mapping by week */
export function cacheWeekTargets(weekIndex: number, targets: Map<number, WorkoutTarget>): void {
  try {
    const existing = getCachedTargets();
    existing[weekIndex] = Object.fromEntries(targets);
    persistence.setItem(TARGETS_CACHE_KEY, JSON.stringify(existing));
  } catch { /* non-critical */ }
}

/** Get cached workout targets */
export function getCachedTargets(): Record<number, Record<number, WorkoutTarget>> {
  try {
    const raw = persistence.getItem(TARGETS_CACHE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

/** Get a single cached target for a specific week/day */
export function getCachedTarget(weekIndex: number, dayIndex: number): WorkoutTarget | null {
  const cache = getCachedTargets();
  return cache[weekIndex]?.[dayIndex] ?? null;
}
