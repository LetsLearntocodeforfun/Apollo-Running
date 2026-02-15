/**
 * Type definitions for the Adaptive Training Recommendations system.
 * Covers recommendation structures, user preferences, plan modifications,
 * and analytics tracking.
 */

/** Scenario categories the analysis engine can detect */
export type RecommendationScenario =
  | 'ahead_of_schedule'
  | 'behind_schedule'
  | 'overtraining'
  | 'inconsistent_execution'
  | 'race_week_optimization';

/** Action types that a recommendation can suggest */
export type RecommendationType =
  | 'upgrade'
  | 'reduce'
  | 'rest'
  | 'adjust_pacing'
  | 'extend_timeline'
  | 'taper'
  | 'celebrate';

/** Priority levels for recommendations */
export type RecommendationPriority = 'high' | 'medium' | 'low';

/** Status of a recommendation from the user's perspective */
export type RecommendationStatus = 'active' | 'accepted' | 'dismissed' | 'expired';

/** A single actionable option within a recommendation */
export interface RecommendationOption {
  /** Unique key for this option */
  key: string;
  /** Short label, e.g. "Reduce mileage 20%" */
  label: string;
  /** Longer explanation of what this option does */
  description: string;
  /** Human-readable impact summary, e.g. "Week 8: 42 mi → 35 mi" */
  impact: string;
  /** Serializable action descriptor (we can't store functions in localStorage) */
  actionType: 'apply_modification' | 'dismiss' | 'navigate';
  /** Payload for the action — varies by actionType */
  actionPayload?: PlanModification | string;
}

/** A single adaptive training recommendation */
export interface AdaptiveRecommendation {
  /** Unique identifier */
  id: string;
  /** Which scenario triggered this */
  scenario: RecommendationScenario;
  /** What kind of adjustment is being suggested */
  type: RecommendationType;
  /** How urgent is this */
  priority: RecommendationPriority;
  /** Current status */
  status: RecommendationStatus;
  /** Coach-style title, e.g. "You're Crushing It — Level Up?" */
  title: string;
  /** Detailed coach-style message */
  message: string;
  /** The data-driven reasoning behind this recommendation */
  reasoning: string;
  /** Actionable options the user can choose from (1-3) */
  options: RecommendationOption[];
  /** Whether the user can dismiss without choosing an option */
  dismissible: boolean;
  /** When this recommendation was generated (ISO string) */
  createdAt: string;
  /** When this recommendation expires (ISO string), if applicable */
  expiresAt?: string;
  /** Which option the user selected, if any */
  selectedOptionKey?: string;
}

/** A modification applied to the training plan */
export interface PlanModification {
  /** Unique identifier */
  id: string;
  /** Which recommendation triggered this (if any) */
  recommendationId?: string;
  /** Human-readable description of the change */
  description: string;
  /** What type of change */
  modificationType: 'mileage_reduction' | 'mileage_increase' | 'add_rest_day' | 'swap_workout' | 'extend_plan' | 'pace_adjustment';
  /** Week-level adjustments: weekIndex → multiplier or replacement data */
  weekAdjustments: WeekAdjustment[];
  /** When this modification was applied (ISO string) */
  appliedAt: string;
  /** Whether this has been undone */
  undone: boolean;
  /** Snapshot of original plan data before modification (for undo) */
  originalSnapshot: WeekSnapshot[];
}

/** A single week-level adjustment */
export interface WeekAdjustment {
  weekIndex: number;
  /** Multiplier applied to weekly mileage (e.g. 0.8 = 20% reduction) */
  mileageMultiplier?: number;
  /** Specific day overrides: dayIndex → new PlanDay-like data */
  dayOverrides?: DayOverride[];
}

/** Override for a single day within a week */
export interface DayOverride {
  dayIndex: number;
  /** New day type */
  type: 'rest' | 'run' | 'cross' | 'race' | 'marathon';
  /** New label */
  label: string;
  /** New distance (miles) */
  distanceMi?: number;
  /** New note */
  note?: string;
}

/** Snapshot of a week's data before modification (for undo) */
export interface WeekSnapshot {
  weekIndex: number;
  /** Serialized array of PlanDay objects */
  days: DayOverride[];
}

/** User preferences for the adaptive recommendations system */
export interface AdaptivePreferences {
  /** Master toggle */
  enabled: boolean;
  /** How often to show recommendations */
  frequency: 'daily' | 'weekly' | 'before_key_workouts';
  /** How aggressive the recommendations should be */
  aggressiveness: 'conservative' | 'balanced' | 'aggressive';
}

/** Analytics entry for tracking recommendation outcomes */
export interface RecommendationAnalytics {
  recommendationId: string;
  scenario: RecommendationScenario;
  type: RecommendationType;
  /** What the user did */
  action: 'accepted' | 'dismissed' | 'expired';
  /** Which option was selected (if accepted) */
  selectedOptionKey?: string;
  /** Timestamp */
  timestamp: string;
}

/** Input data structure for the analysis engine */
export interface TrainingAnalysisInput {
  /** Plan ID */
  planId: string;
  /** Plan start date (YYYY-MM-DD) */
  startDate: string;
  /** Total weeks in the plan */
  totalWeeks: number;
  /** Current week index (0-based) */
  currentWeekIndex: number;
  /** Current day index within the week (0-based) */
  currentDayIndex: number;
  /** Weeks remaining until race */
  weeksRemaining: number;
  /** Completion rate over last 2 weeks (0-1) */
  recentCompletionRate: number;
  /** Overall completion rate (0-1) */
  overallCompletionRate: number;
  /** Weekly mileage data: [weekIndex] → { planned, actual } */
  weeklyMileage: { weekIndex: number; plannedMi: number; actualMi: number }[];
  /** Synced run data for pace analysis */
  syncedRuns: SyncedRunData[];
  /** Race readiness score (0-100) */
  readinessScore: number;
  /** Training adherence score (0-100) */
  adherenceScore: number;
  /** Days since last sync */
  daysSinceLastSync: number;
  /** Whether Strava is connected */
  stravaConnected: boolean;
}

/** Simplified synced run data for analysis */
export interface SyncedRunData {
  weekIndex: number;
  dayIndex: number;
  actualDistanceMi: number;
  actualPaceMinPerMi: number;
  plannedDistanceMi: number;
  plannedNote: string;
  movingTimeSec: number;
  date: string;
}

/** Result of the analysis engine */
export interface TrainingAnalysisResult {
  /** All detected scenarios */
  detectedScenarios: DetectedScenario[];
  /** Generated recommendations (sorted by priority) */
  recommendations: AdaptiveRecommendation[];
  /** Summary stats used in analysis */
  stats: AnalysisStats;
}

/** A detected scenario with its confidence and trigger data */
export interface DetectedScenario {
  scenario: RecommendationScenario;
  /** Confidence 0-100 that this scenario is occurring */
  confidence: number;
  /** Which specific triggers fired */
  triggers: string[];
}

/** Summary statistics from the analysis */
export interface AnalysisStats {
  /** Average pace over last 4 long runs (min/mi) */
  avgLongRunPace: number;
  /** Average pace over last 4 easy runs (min/mi) */
  avgEasyPace: number;
  /** Mileage change % from prev week to current */
  weeklyMileageChangePct: number;
  /** Consecutive days without rest */
  consecutiveDaysWithoutRest: number;
  /** Number of missed key workouts in last 2 weeks */
  missedKeyWorkoutsLast2Weeks: number;
  /** Completion rate over last 2 weeks */
  last2WeeksCompletionRate: number;
  /** Whether runner is running easy days too fast */
  easyDaysTooFast: boolean;
  /** Whether runner is running hard days too slow */
  hardDaysTooSlow: boolean;
}
