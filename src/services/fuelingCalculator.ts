/**
 * In-Race Fueling Calculator — precise carb/caffeine timing based on
 * pace, body weight, and expected duration.
 *
 * Based on:
 * - Jeukendrup (2014): maximal carb oxidation 60-90g/hr with dual-transport carbs
 * - Burke et al. (2011): practical sport nutrition guidelines
 * - Goldstein et al. (2010): caffeine as ergogenic aid — 3-6mg/kg, ~45min to peak
 * - Pfeiffer et al. (2012): GI distress incidence in marathon runners
 *
 * Carb recommendations:
 * - <2.5h race: 30-60g/hr
 * - 2.5-3.5h race: 60-80g/hr (dual-transport recommended)
 * - >3.5h race: 60-90g/hr (trained gut, dual-transport essential)
 */

import type {
  AthleteProfile,
  FuelingPlan,
  FuelingItem,
  CaffeineStrategy,
} from '../types/nutrition';

// ── Constants ─────────────────────────────────────────────────────────────────

const MARATHON_MI = 26.2;

/** Standard gel: 25g carbs */
const GEL_CARBS_G = 25;
/** Sports drink per serving (250ml): 15g carbs */
const DRINK_CARBS_PER_250ML = 15;
/** Caffeinated gel: 25g carbs + 100mg caffeine */
const CAFFEINE_GEL_MG = 100;

// ── Fueling Plan Builder ──────────────────────────────────────────────────────

export interface FuelingInput {
  athlete: AthleteProfile;
  paceSecPerMi: number;
  /** Runner's experience level affects carb tolerance */
  experience?: 'beginner' | 'intermediate' | 'advanced';
  /** Has the athlete trained their gut for higher carb intake? */
  gutTrained?: boolean;
  /** Preferred fueling products */
  preferredProducts?: ('gel' | 'chews' | 'drink' | 'real_food')[];
}

/**
 * Generate a complete in-race fueling plan.
 */
export function generateFuelingPlan(input: FuelingInput): FuelingPlan {
  const {
    athlete,
    paceSecPerMi,
    experience = 'intermediate',
    gutTrained = false,
    preferredProducts = ['gel'],
  } = input;

  const estimatedDurationMin = (MARATHON_MI * paceSecPerMi) / 60;
  const estimatedDurationHr = estimatedDurationMin / 60;

  // Determine target carb rate based on duration and experience
  const targetCarbRate = calculateTargetCarbRate(estimatedDurationHr, experience, gutTrained);

  // Total carbs needed
  const totalCarbsNeeded = Math.round(targetCarbRate * estimatedDurationHr);

  // Build fueling items
  const items = buildFuelingItems(
    paceSecPerMi, estimatedDurationMin, targetCarbRate, preferredProducts,
  );

  const totalCarbsPlanned = items.reduce((sum, item) => sum + item.carbsG, 0);
  const coveragePct = Math.round((totalCarbsPlanned / totalCarbsNeeded) * 100);

  // Caffeine strategy
  const caffeine = buildCaffeineStrategy(athlete, paceSecPerMi, estimatedDurationMin);

  // GI risk assessment
  const giRisk = assessGIRisk(targetCarbRate, experience, gutTrained);

  // Summary
  const summary = buildFuelingSummary(
    estimatedDurationMin, targetCarbRate, totalCarbsPlanned, totalCarbsNeeded,
    caffeine, giRisk,
  );

  return {
    estimatedDurationMin: Math.round(estimatedDurationMin),
    targetCarbRateGHr: targetCarbRate,
    totalCarbsPlannedG: totalCarbsPlanned,
    totalCarbsNeededG: totalCarbsNeeded,
    coveragePct,
    items,
    caffeine,
    giRisk,
    summary,
  };
}

function calculateTargetCarbRate(
  durationHr: number,
  experience: string,
  gutTrained: boolean,
): number {
  let baseRate: number;

  if (durationHr < 2.5) {
    baseRate = 45; // 30-60 range, use midpoint
  } else if (durationHr < 3.5) {
    baseRate = 60; // 60-80 range
  } else {
    baseRate = 70; // 60-90 range
  }

  // Adjust for experience
  if (experience === 'beginner') baseRate = Math.min(baseRate, 45);
  if (experience === 'advanced' && gutTrained) baseRate = Math.min(90, baseRate + 15);

  return baseRate;
}

function buildFuelingItems(
  paceSecPerMi: number,
  durationMin: number,
  targetCarbRateGHr: number,
  products: string[],
): FuelingItem[] {
  const items: FuelingItem[] = [];
  const product = products[0] ?? 'gel';
  const carbsPerItem = product === 'drink' ? DRINK_CARBS_PER_250ML : GEL_CARBS_G;

  // Calculate interval between fueling
  // grams needed per hour / grams per item = items per hour
  // 60 min / items per hour = minutes between items
  const itemsPerHour = targetCarbRateGHr / carbsPerItem;
  const intervalMin = Math.round(60 / itemsPerHour);

  // Start fueling at mile 4 (or ~30 min in) — stomach needs to settle
  const startMile = 4;
  const startTimeMin = (startMile * paceSecPerMi) / 60;

  let timeMin = startTimeMin;

  while (timeMin < durationMin - 15) { // stop ~15min before finish
    const currentMile = Math.round((timeMin / paceSecPerMi) * 60 * 10) / 10;
    if (currentMile > MARATHON_MI - 1) break; // don't fuel in last mile

    const itemName = getItemName(product, items.length);
    const notes = getItemNotes(product, currentMile, items.length);

    items.push({
      mile: Math.round(currentMile),
      raceTimeMin: Math.round(timeMin),
      item: itemName,
      carbsG: carbsPerItem,
      notes,
    });

    timeMin += intervalMin;
  }

  return items;
}

function getItemName(product: string, _index: number): string {
  switch (product) {
    case 'gel': return 'Energy Gel';
    case 'chews': return 'Energy Chews';
    case 'drink': return 'Sports Drink (250ml)';
    case 'real_food': return 'Energy Bar/Banana';
    default: return 'Energy Gel';
  }
}

function getItemNotes(product: string, mile: number, index: number): string {
  const notes: string[] = [];

  if (index === 0) notes.push('First fuel — take with water');
  if (product === 'gel') notes.push('Chase with 4-6 oz water');
  if (mile >= 18 && mile <= 20) notes.push('Critical fueling zone — do NOT skip');
  if (mile >= 22) notes.push('Final fuel — small sips only');

  return notes.join('. ') || 'Take with water at aid station';
}

function buildCaffeineStrategy(
  athlete: AthleteProfile,
  paceSecPerMi: number,
  durationMin: number,
): CaffeineStrategy {
  const weightKg = athlete.weightKg;
  const recommendedMgPerKg = 3; // conservative end of 3-6mg/kg

  // Total caffeine: 3mg/kg, split into doses
  const totalMg = Math.round(recommendedMgPerKg * weightKg);
  const items: CaffeineStrategy['items'] = [];

  // First dose at mile 18 (peak effect by mile 20-22 when fatigue peaks)
  // Takes ~45 min to peak, so dose at mile 18 peaks around mile 22-23
  const firstDoseMile = 18;
  items.push({
    mile: firstDoseMile,
    mg: CAFFEINE_GEL_MG,
    notes: 'Caffeinated gel — peaks in 45min to combat late-race fatigue',
  });

  // Second dose potentially at mile 22 if duration allows
  const mileTimeMin = paceSecPerMi / 60;
  const timeAtMile22 = 22 * mileTimeMin;
  if (totalMg > CAFFEINE_GEL_MG && timeAtMile22 < durationMin - 20) {
    items.push({
      mile: 22,
      mg: Math.min(CAFFEINE_GEL_MG, totalMg - CAFFEINE_GEL_MG),
      notes: 'Second caffeine dose — final push boost',
    });
  }

  const actualTotal = items.reduce((s, i) => s + i.mg, 0);

  return {
    totalMg: actualTotal,
    recommendedMgPerKg,
    items,
    summary: `${actualTotal}mg caffeine planned (${(actualTotal / weightKg).toFixed(1)} mg/kg). Research shows 3-6mg/kg improves late-race performance by 2-4%.`,
  };
}

function assessGIRisk(
  carbRateGHr: number,
  experience: string,
  gutTrained: boolean,
): FuelingPlan['giRisk'] {
  if (carbRateGHr > 80 && !gutTrained) return 'high';
  if (carbRateGHr > 60 && experience === 'beginner') return 'high';
  if (carbRateGHr > 60 && !gutTrained) return 'moderate';
  if (carbRateGHr > 45 && experience === 'beginner') return 'moderate';
  return 'low';
}

function buildFuelingSummary(
  durationMin: number,
  carbRate: number,
  carbsPlanned: number,
  carbsNeeded: number,
  caffeine: CaffeineStrategy,
  giRisk: string,
): string {
  const parts: string[] = [];
  const durationHr = durationMin / 60;

  parts.push(`Estimated race time: ${Math.floor(durationHr)}h${Math.round((durationHr % 1) * 60)}min.`);
  parts.push(`Target: ${carbRate}g carbs/hr, total ${carbsPlanned}g planned of ${carbsNeeded}g needed.`);

  if (caffeine.items.length > 0) {
    parts.push(caffeine.summary);
  }

  if (giRisk === 'high') {
    parts.push('⚠️ High GI risk at this intake rate. Practice this fueling strategy in training before race day.');
  } else if (giRisk === 'moderate') {
    parts.push('Moderate GI risk — practice this intake rate on long runs first.');
  }

  if (carbsPlanned < carbsNeeded * 0.8) {
    parts.push('⚠️ Fueling plan covers only ' + Math.round((carbsPlanned / carbsNeeded) * 100) + '% of estimated needs. Consider adding more fuel stops.');
  }

  return parts.join(' ');
}

/**
 * Quick recommendation for gel timing.
 */
export function getGelSchedule(paceSecPerMi: number): { miles: number[]; intervalMin: number } {
  const durationMin = (MARATHON_MI * paceSecPerMi) / 60;
  const durationHr = durationMin / 60;

  let intervalMin: number;
  if (durationHr < 3) intervalMin = 30;
  else if (durationHr < 4) intervalMin = 25;
  else intervalMin = 20;

  const miles: number[] = [];
  let timeMin = (4 * paceSecPerMi) / 60; // start at mile 4
  while (timeMin < durationMin - 15) {
    miles.push(Math.round((timeMin * 60) / paceSecPerMi));
    timeMin += intervalMin;
  }

  return { miles, intervalMin };
}
