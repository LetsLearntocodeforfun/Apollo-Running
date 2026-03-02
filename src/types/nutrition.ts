/**
 * Nutrition types — shared across glycogen model, carb loading,
 * hydration calculator, and fueling calculator.
 */

/** Athlete physiology profile for nutrition calculations */
export interface AthleteProfile {
  /** Body weight in kg */
  weightKg: number;
  /** Estimated VO2max (from VDOT or direct) */
  vo2max?: number;
  /** Sex for metabolic adjustments */
  sex?: 'male' | 'female';
}

/** Glycogen depletion data for a single mile */
export interface GlycogenMileData {
  mile: number;
  /** Glycogen remaining in grams */
  glycogenRemainingG: number;
  /** Glycogen remaining as percentage of starting stores */
  glycogenRemainingPct: number;
  /** Calories burned this mile */
  calsBurnedThisMile: number;
  /** Carbs consumed this mile (from fueling plan) */
  carbsConsumedG: number;
  /** Cumulative carbs consumed */
  cumulativeCarbsG: number;
  /** Warning flag — glycogen dangerously low */
  bonkWarning: boolean;
}

/** Full glycogen depletion simulation result */
export interface GlycogenSimulation {
  /** Mile-by-mile glycogen data */
  miles: GlycogenMileData[];
  /** Starting glycogen stores (grams) */
  startingGlycogenG: number;
  /** Mile at which glycogen hits critical level (<10%) */
  depletionMile: number | null;
  /** Mile at which glycogen hits critical WITH fueling */
  depletionMileWithFueling: number | null;
  /** Total calories burned */
  totalCalsBurned: number;
  /** Summary message */
  summary: string;
}

/** Carb loading state for each pre-race day */
export type CarbLoadingIntensity = 'normal' | 'moderate' | 'high' | 'race_morning';

/** A single day in the carb loading protocol */
export interface CarbLoadingDay {
  /** Days before race (3, 2, 1, 0=race morning) */
  daysBefore: number;
  /** Intensity label */
  intensity: CarbLoadingIntensity;
  /** Target carbs in grams */
  targetCarbsG: number;
  /** Target carbs per kg body weight */
  carbsPerKg: number;
  /** Target calories */
  targetCalories: number;
  /** Suggested meals */
  meals: MealSuggestion[];
  /** Fiber guidance */
  fiberGuidance: string;
}

/** A single meal suggestion */
export interface MealSuggestion {
  name: string;
  timing: string;
  carbsG: number;
  description: string;
}

/** Full carb loading protocol */
export interface CarbLoadingProtocol {
  /** Athlete weight for calculations */
  weightKg: number;
  /** Race date */
  raceDate: string;
  /** Days of the protocol */
  days: CarbLoadingDay[];
  /** Race morning plan */
  raceMorning: CarbLoadingDay;
  /** Total carb target over protocol */
  totalCarbTargetG: number;
  /** Summary message */
  summary: string;
}

/** Sweat rate estimation result */
export interface SweatRateEstimate {
  /** Base sweat rate (ml/hr) */
  baseSweatRateMlHr: number;
  /** Adjusted for conditions (ml/hr) */
  adjustedSweatRateMlHr: number;
  /** Sodium loss (mg/hr) */
  sodiumLossMgHr: number;
  /** Fluid deficit per mile (ml) */
  fluidDeficitPerMileMl: number;
  /** Recommended intake (ml/hr) */
  recommendedIntakeMlHr: number;
  /** Recommended intake (oz/hr) */
  recommendedIntakeOzHr: number;
  /** Total fluid needed for race (ml) */
  totalFluidNeededMl: number;
  /** Dehydration risk level */
  dehydrationRisk: 'low' | 'moderate' | 'high' | 'extreme';
  /** Per-aid-station plan */
  aidStationPlan: AidStationHydration[];
  /** Summary message */
  summary: string;
}

/** Hydration recommendation per aid station */
export interface AidStationHydration {
  /** Distance in miles */
  distanceMi: number;
  /** Station name */
  name: string;
  /** Recommended fluid intake (oz) */
  fluidOz: number;
  /** Electrolyte recommendation */
  electrolyte: boolean;
  /** Notes */
  notes: string;
}

/** Race conditions for hydration/performance adjustments */
export interface RaceConditions {
  /** Temperature in Fahrenheit */
  tempF: number;
  /** Relative humidity (0-100) */
  humidityPct: number;
  /** Wind speed in mph */
  windMph?: number;
  /** Altitude in feet */
  altitudeFt?: number;
  /** Sun exposure level */
  sunExposure?: 'full_sun' | 'partial_shade' | 'overcast';
}

/** In-race fueling plan item */
export interface FuelingItem {
  /** Mile to consume */
  mile: number;
  /** Approximate time into race (minutes) */
  raceTimeMin: number;
  /** Product/item name */
  item: string;
  /** Carbs in grams */
  carbsG: number;
  /** Caffeine in mg (if applicable) */
  caffeineMg?: number;
  /** Notes/instructions */
  notes: string;
}

/** Complete in-race fueling plan */
export interface FuelingPlan {
  /** Total race duration estimate (minutes) */
  estimatedDurationMin: number;
  /** Target carb intake rate (g/hr) */
  targetCarbRateGHr: number;
  /** Total carbs planned (g) */
  totalCarbsPlannedG: number;
  /** Total carbs needed (g) */
  totalCarbsNeededG: number;
  /** Coverage percentage */
  coveragePct: number;
  /** Fueling items by mile */
  items: FuelingItem[];
  /** Caffeine strategy */
  caffeine: CaffeineStrategy;
  /** GI risk level */
  giRisk: 'low' | 'moderate' | 'high';
  /** Summary message */
  summary: string;
}

/** Caffeine timing strategy */
export interface CaffeineStrategy {
  /** Total caffeine planned (mg) */
  totalMg: number;
  /** Recommended mg/kg */
  recommendedMgPerKg: number;
  /** Timing items */
  items: { mile: number; mg: number; notes: string }[];
  /** Summary */
  summary: string;
}

/** Race equivalence adjustment result */
export interface RaceEquivalenceResult {
  /** Original time in seconds */
  originalTimeSec: number;
  /** Original conditions */
  originalConditions: string;
  /** Adjusted time in seconds */
  adjustedTimeSec: number;
  /** Adjusted time formatted */
  adjustedTimeFormatted: string;
  /** Delta seconds (positive = slower) */
  deltaSec: number;
  /** Individual adjustments applied */
  adjustments: EquivalenceAdjustment[];
  /** Summary */
  summary: string;
}

/** Individual condition adjustment */
export interface EquivalenceAdjustment {
  factor: string;
  description: string;
  pctChange: number;
  deltaSeconds: number;
}
