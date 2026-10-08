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

/** One dated running of a race (v1.0.6). */
export interface RaceEdition {
  year: number;
  /** Race-local calendar date, YYYY-MM-DD. */
  date: string;
  /** Race-local start time (first wave / mass start), 24 h 'HH:mm'. */
  startTime: string;
  /** IANA time zone of the start, e.g. 'America/Chicago'. */
  timeZone: string;
  /** True when the date is derived from the race's usual rule, not announced. */
  estimated?: boolean;
}

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
  /** Start time. World Majors: 24 h 'HH:mm' (race-local); custom races may hold free text. */
  startTime?: string;
  timeLimitHours?: number;
  fieldSize?: number;
  courseDescription: string;
  /** Known editions, oldest first (World Majors). `date`/`year`/`startTime` mirror the next one. */
  editions?: RaceEdition[];
  /** IANA time zone of the race. */
  timeZone?: string;
  /** True when `date` comes from an estimated edition ("date to be confirmed"). */
  dateEstimated?: boolean;
  /** Start-area coordinates (rounded). */
  lat?: number;
  lon?: number;
}

/** ── Race Strategy ── */

export type PacingStrategy = 'negative-split' | 'even-split' | 'positive-split' | 'effort-based';

export interface MilePacePlan {
  /** Distance at the END of this segment, in miles (1, 2, … 26, 26.2). */
  mile: number;
  /** Pace for this segment in sec/mi (the final segment may be shorter than 1 mi). */
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
  /** Seconds after the gun (negative = before the start). v1.0.6+ plans only. */
  timeSec?: number;
  /** Carbohydrate in this item (g). v1.0.6+ plans only. */
  carbsG?: number;
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
  /** Planned second-half vs first-half difference in % (−1.5 = a 1.5 % negative split). v1.0.6+. */
  splitPct?: number;
  /** Race distance in miles. v1.0.6+; for older strategies use the last `milePaces` entry. */
  distanceMi?: number;
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
