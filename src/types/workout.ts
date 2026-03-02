/**
 * Workout target types for structured training.
 * Defines pace ranges, interval blocks, and per-workout targets
 * derived from VDOT-based pace calculations.
 */

/** Canonical workout categories mapped from plan day `note` field */
export type WorkoutCategory =
  | 'easy'
  | 'long'
  | 'tempo'
  | 'marathon_pace'
  | 'speed'
  | 'strength'
  | 'medium_long'
  | 'recovery'
  | 'race'
  | 'rest'
  | 'cross';

/** Pace range in seconds per mile */
export interface PaceRange {
  /** Fastest acceptable pace (lower bound, fewer sec/mi) */
  minSecPerMi: number;
  /** Slowest acceptable pace (upper bound, more sec/mi) */
  maxSecPerMi: number;
}

/** Structured interval block within a speed/tempo workout */
export interface IntervalBlock {
  /** Work interval duration in minutes */
  workDurationMin: number;
  /** Rest/recovery interval duration in minutes */
  restDurationMin: number;
  /** Target pace in seconds per mile during work intervals */
  targetPaceSecPerMi: number;
  /** Number of repeats */
  repeats: number;
  /** Optional description (e.g. "800m repeats") */
  description?: string;
}

/** Marathon-pace segment within a long run */
export interface MarathonPaceSegment {
  /** Mile to start the MP segment */
  startMile: number;
  /** Mile to end the MP segment */
  endMile: number;
  /** Marathon target pace in seconds per mile */
  paceSecPerMi: number;
}

/** Complete workout target for a single training day */
export interface WorkoutTarget {
  /** Workout category (mapped from plan day note) */
  category: WorkoutCategory;
  /** Target pace range for the primary run effort */
  targetPaceRange?: PaceRange;
  /** Target heart rate zone (1-5) */
  hrZone?: number;
  /** Structured intervals for speed/tempo workouts */
  intervals?: IntervalBlock[];
  /** Optional marathon-pace segment in long runs */
  marathonPaceSegment?: MarathonPaceSegment;
  /** Human-readable description of the workout target */
  description: string;
}

/** Post-run compliance result comparing actual to target */
export interface ComplianceResult {
  /** Overall compliance score (0-100) */
  score: number;
  /** Pace compliance: was the runner in the target range? */
  paceCompliance: {
    inRange: boolean;
    actualPaceSecPerMi: number;
    targetRange?: PaceRange;
    deviationSec: number;
    direction: 'too_fast' | 'too_slow' | 'on_target';
  };
  /** Distance compliance: did the runner cover the planned distance? */
  distanceCompliance: {
    score: number;
    actualMi: number;
    plannedMi: number;
    diffPct: number;
  };
  /** Coaching feedback about compliance */
  feedback: string;
  /** Specific coaching suggestion */
  coachingSuggestion?: string;
}
