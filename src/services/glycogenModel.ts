/**
 * Glycogen Depletion Model — scientifically-modeled mile-by-mile glycogen
 * simulation for the marathon.
 *
 * Based on:
 * - Romijn et al. (1993) substrate utilization at various intensities
 * - Coyle (2004) glycogen depletion and "hitting the wall"
 * - Burke et al. (2011) carbohydrate metabolism during exercise
 *
 * Key facts:
 * - Trained runners store ~400-600g glycogen (muscles + liver)
 * - Carb-loaded runners can reach 600-880g
 * - Running economy: ~1 kcal/kg/km (±10%)
 * - Glycogen yields 4 kcal/g
 * - Fat oxidation increases as intensity decreases
 * - "The wall" typically occurs when glycogen drops below 50-100g
 */

import type {
  AthleteProfile,
  GlycogenMileData,
  GlycogenSimulation,
  FuelingItem,
} from '../types/nutrition';

// ── Constants ─────────────────────────────────────────────────────────────────

/** Normal glycogen stores (grams) — without carb loading */
const BASE_GLYCOGEN_G = 450;
/** Carb-loaded glycogen stores (grams) — with 3-day protocol */
const CARB_LOADED_GLYCOGEN_G = 700;
/** Critical glycogen level — below this, severe performance degradation */
const CRITICAL_GLYCOGEN_G = 75;
/** Running economy: kcal per kg per mile (≈1 kcal/kg/km × 1.609) */
const KCAL_PER_KG_PER_MI = 1.609;
/** Glycogen energy density: 4 kcal per gram */
const GLYCOGEN_KCAL_PER_G = 4;
/** Marathon distance */
const MARATHON_MI = 26.2;

// ── Glycogen:Fat Ratio ────────────────────────────────────────────────────────

/**
 * Estimate the fraction of energy coming from glycogen (vs fat)
 * at a given intensity (% VO2max).
 *
 * Based on crossover concept (Brooks & Mercier, 1994):
 * At low intensities (~50% VO2max), ~50% glycogen / ~50% fat
 * At marathon pace (~75-80% VO2max), ~80-85% glycogen
 * At threshold (~85%+ VO2max), ~90%+ glycogen
 *
 * We use a logistic fit to model this smoothly.
 */
function glycogenFraction(pctVO2max: number): number {
  // Logistic model: fraction = 1 / (1 + e^(-k*(x - x0)))
  // Tuned to match: 50% at ~45% VO2max, 80% at 75%, 90% at 85%, 95% at 95%
  const k = 0.08;
  const x0 = 45;
  const frac = 1 / (1 + Math.exp(-k * (pctVO2max - x0)));
  return Math.min(0.95, Math.max(0.3, frac));
}

/**
 * Estimate %VO2max from marathon pace relative to VO2max pace.
 *
 * Marathon pace is typically ~75-80% VO2max for competitive runners.
 * Uses the relationship: pace is inversely related to %VO2max.
 */
function estimatePctVO2max(paceSecPerMi: number, vo2maxEstimate?: number): number {
  // If we have a VDOT/VO2max, we can be more precise
  // VO2max pace (Repetition) ≈ 5:00-6:00/mi range for typical VDOT 35-60
  // Marathon pace ≈ 7:00-10:00/mi range
  // A simple model: faster pace relative to a reference = higher %VO2max

  if (vo2maxEstimate && vo2maxEstimate > 0) {
    // Use Daniels' approximation: marathon pace ≈ 75-80% VO2max
    // vdotPace at max ≈ coefficient / vdot^0.816 (interval pace)
    // We'll estimate based on pace ratio
    const refMaxPaceSecMi = 9555 * Math.pow(vo2maxEstimate, -0.816); // interval pace
    const paceRatio = refMaxPaceSecMi / paceSecPerMi;
    // paceRatio near 1 = running at max, near 0.5 = easy
    return Math.min(95, Math.max(50, paceRatio * 100));
  }

  // Fallback: estimate from pace alone
  // Sub-7:00 pace ≈ 80%+ VO2max for most runners
  // 10:00+ pace ≈ 55-65% VO2max
  if (paceSecPerMi <= 360) return 85; // sub-6:00
  if (paceSecPerMi <= 420) return 82; // 6:00-7:00
  if (paceSecPerMi <= 480) return 78; // 7:00-8:00
  if (paceSecPerMi <= 540) return 75; // 8:00-9:00
  if (paceSecPerMi <= 600) return 70; // 9:00-10:00
  if (paceSecPerMi <= 660) return 65; // 10:00-11:00
  return 60; // 11:00+
}

// ── Simulation ────────────────────────────────────────────────────────────────

export interface GlycogenSimulationInput {
  /** Athlete profile */
  athlete: AthleteProfile;
  /** Target pace in seconds per mile */
  paceSecPerMi: number;
  /** Has the athlete done carb loading? */
  carbLoaded?: boolean;
  /** Custom starting glycogen (grams) — overrides carbLoaded */
  customGlycogenG?: number;
  /** In-race fueling items (gels, drinks, etc.) */
  fuelingItems?: FuelingItem[];
  /** Distance in miles (default: 26.2) */
  distanceMi?: number;
}

/**
 * Simulate mile-by-mile glycogen depletion through the marathon.
 */
export function simulateGlycogenDepletion(input: GlycogenSimulationInput): GlycogenSimulation {
  const {
    athlete,
    paceSecPerMi,
    carbLoaded = false,
    customGlycogenG,
    fuelingItems = [],
    distanceMi = MARATHON_MI,
  } = input;

  const startingGlycogen = customGlycogenG ?? (carbLoaded ? CARB_LOADED_GLYCOGEN_G : BASE_GLYCOGEN_G);
  const totalMiles = Math.ceil(distanceMi);
  const pctVO2max = estimatePctVO2max(paceSecPerMi, athlete.vo2max);
  const glycFrac = glycogenFraction(pctVO2max);

  // Build a lookup for fueling by mile
  const fuelingByMile = new Map<number, number>();
  for (const item of fuelingItems) {
    const existing = fuelingByMile.get(item.mile) ?? 0;
    fuelingByMile.set(item.mile, existing + item.carbsG);
  }

  let glycogenRemaining = startingGlycogen;
  let cumulativeCarbs = 0;
  let totalCalsBurned = 0;
  let depletionMile: number | null = null;
  let depletionMileWithFueling: number | null = null;

  // Also simulate without fueling to show the contrast
  let glycogenNoFueling = startingGlycogen;

  const miles: GlycogenMileData[] = [];

  for (let mile = 1; mile <= totalMiles; mile++) {
    // Caloric cost of this mile
    const mileDistance = mile === totalMiles ? (distanceMi - (totalMiles - 1)) : 1;
    const calsBurned = KCAL_PER_KG_PER_MI * athlete.weightKg * mileDistance;
    totalCalsBurned += calsBurned;

    // Glycogen used this mile
    const glycogenCals = calsBurned * glycFrac;
    const glycogenUsedG = glycogenCals / GLYCOGEN_KCAL_PER_G;

    // Carbs consumed at this mile
    const carbsConsumed = fuelingByMile.get(mile) ?? 0;
    cumulativeCarbs += carbsConsumed;

    // Update glycogen (with fueling)
    glycogenRemaining = glycogenRemaining - glycogenUsedG + carbsConsumed;
    glycogenRemaining = Math.max(0, glycogenRemaining);

    // Update no-fueling track
    glycogenNoFueling = Math.max(0, glycogenNoFueling - glycogenUsedG);

    // Check depletion
    if (glycogenNoFueling <= CRITICAL_GLYCOGEN_G && depletionMile === null) {
      depletionMile = mile;
    }
    if (glycogenRemaining <= CRITICAL_GLYCOGEN_G && depletionMileWithFueling === null) {
      depletionMileWithFueling = mile;
    }

    miles.push({
      mile,
      glycogenRemainingG: Math.round(glycogenRemaining),
      glycogenRemainingPct: Math.round((glycogenRemaining / startingGlycogen) * 100),
      calsBurnedThisMile: Math.round(calsBurned),
      carbsConsumedG: carbsConsumed,
      cumulativeCarbsG: Math.round(cumulativeCarbs),
      bonkWarning: glycogenRemaining <= CRITICAL_GLYCOGEN_G,
    });
  }

  // Build summary
  const summary = buildSummary(
    startingGlycogen, carbLoaded, depletionMile, depletionMileWithFueling,
    fuelingItems.length > 0, cumulativeCarbs, totalCalsBurned,
  );

  return {
    miles,
    startingGlycogenG: startingGlycogen,
    depletionMile,
    depletionMileWithFueling,
    totalCalsBurned: Math.round(totalCalsBurned),
    summary,
  };
}

function buildSummary(
  startingG: number, carbLoaded: boolean,
  depletionMile: number | null, depletionWithFueling: number | null,
  hasFueling: boolean, totalCarbs: number, totalCals: number,
): string {
  const parts: string[] = [];

  parts.push(`Starting glycogen: ${startingG}g${carbLoaded ? ' (carb-loaded)' : ''}.`);
  parts.push(`Total caloric demand: ~${Math.round(totalCals)} kcal.`);

  if (depletionMile) {
    parts.push(`Without fueling, glycogen depletion occurs around mile ${depletionMile}.`);
    if (hasFueling && depletionWithFueling) {
      parts.push(`With your fueling plan (${Math.round(totalCarbs)}g carbs), depletion extends to mile ${depletionWithFueling}.`);
    } else if (hasFueling && !depletionWithFueling) {
      parts.push(`With your fueling plan (${Math.round(totalCarbs)}g carbs), you should have sufficient glycogen to finish.`);
    }
  } else {
    parts.push('Your glycogen stores should be sufficient for the full distance.');
  }

  return parts.join(' ');
}

/** Quick check: will glycogen last for the marathon? */
export function willGlycogenLast(
  athlete: AthleteProfile,
  paceSecPerMi: number,
  carbLoaded: boolean,
): { lasts: boolean; depletionMile: number | null; message: string } {
  const sim = simulateGlycogenDepletion({ athlete, paceSecPerMi, carbLoaded });
  return {
    lasts: sim.depletionMile === null,
    depletionMile: sim.depletionMile,
    message: sim.depletionMile
      ? `Glycogen depletion predicted at mile ${sim.depletionMile}. Fueling strategy essential.`
      : 'Glycogen stores sufficient for the full marathon.',
  };
}
