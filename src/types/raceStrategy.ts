// Type definitions for the Race Strategy feature.

/** ── Course Geography ── */

export interface ElevationPoint {
  distanceMi: number;
  elevationFt: number;
  landmark?: string;
}

export interface AidStation {
  distanceMi: number;
  name: string;
  /** e.g. water, electrolyte, gel, banana */
  offerings: string[];
}

export interface CourseSplit {
  number: number;
  endMi: number;
  /** Positive = uphill */
  elevationChangeFt: number;
  terrain: string;
  landmarks: string[];
}

export interface CourseProfile {
  totalGainFt: number;
  totalLossFt: number;
  /** Negative = net downhill */
  netChangeFt: number;
  highPointFt: number;
  lowPointFt: number;
  elevationPoints: ElevationPoint[];
  /** 1-10 (1 = flat/fast, 10 = extremely hilly) */
  difficulty: number;
  bqFriendly: boolean;
  prFriendly: boolean;
}

/** ── Marathon Definition ── */

export type MarathonCategory = 'world-major' | 'major' | 'regional' | 'local' | 'custom';

export interface MarathonRace {
  id: string;
  name: string;
  city: string;
  country: string;
  category: MarathonCategory;
  /** YYYY-MM-DD */
  date: string;
  /** 1-12 */
  typicalMonth: number;
  distanceMi: number;
  courseType: 'loop' | 'point-to-point' | 'out-and-back' | 'multi-loop';
  /** °F range at race time */
  typicalTempF: { low: number; high: number };
  /** 0-100 */
  typicalHumidity: number;
  course: CourseProfile;
  splits: CourseSplit[];
  aidStations: AidStation[];
  website: string;
  tips: string[];
  qualifyingInfo?: string;
  isWorldMajor: boolean;
  year: number;
  startTime?: string;
  timeLimitHours?: number;
  fieldSize?: number;
  courseDescription: string;
}

/** ── Race Strategy ── */

export type PacingStrategy = 'negative-split' | 'even-split' | 'positive-split' | 'effort-based';

export interface MilePacePlan {
  mile: number;
  targetPaceSec: number;
  /** e.g. "8:30" */
  targetPaceFormatted: string;
  cumulativeTimeSec: number;
  cumulativeTimeFormatted: string;
  elevationChangeFt: number;
  notes: string;
}

export interface NutritionPlan {
  mile: number;
  item: string;
  notes: string;
}

export interface RaceStrategy {
  id: string;
  name: string;
  marathonId: string;
  marathonName: string;
  targetTimeSec: number;
  targetTimeFormatted: string;
  pacingStrategy: PacingStrategy;
  milePaces: MilePacePlan[];
  nutritionPlan: NutritionPlan[];
  firstHalfSec: number;
  secondHalfSec: number;
  avgPaceSec: number;
  createdAt: string;
  updatedAt: string;
  notes: string;
}

/** ── User Preferences ── */

export interface RaceStrategyPreferences {
  enabled: boolean;
  selectedMarathonId?: string;
  activeStrategyId?: string;
  enabledAt?: string;
}
