/**
 * Hydration Calculator — personalized sweat rate estimation and
 * race-day hydration plan with aid station recommendations.
 *
 * Based on:
 * - Sawka et al. (2007) ACSM Position Stand on Exercise & Fluid Replacement
 * - Cheuvront & Kenefick (2014) Dehydration: physiology, assessment, performance effects
 * - Baker (2017) Sweating Rate and Sweat Sodium Concentration in Athletes
 *
 * Sweat rate varies 0.5-2.5 L/hr depending on:
 * - Body mass, intensity, temperature, humidity, acclimatization
 * - Optimal: replace 60-80% of sweat losses during running
 * - Keep weight loss < 2% body weight to avoid performance degradation
 */

import type {
  AthleteProfile,
  RaceConditions,
  SweatRateEstimate,
  AidStationHydration,
} from '../types/nutrition';
import type { AidStation } from '../types/raceStrategy';

// ── Constants ─────────────────────────────────────────────────────────────────

/** Base sweat rate coefficients */
const BASE_SWEAT_ML_HR = 800; // ml/hr at moderate intensity, 65°F
/** Temperature adjustment: +100ml/hr per 10°F above 55°F */
const TEMP_COEFF = 10; // ml/hr per °F above 55
/** Humidity adjustment: +50ml/hr per 10% above 40% */
const HUMIDITY_COEFF = 5; // ml/hr per % above 40
/** Intensity adjustment: higher pace = more sweat */
const INTENSITY_COEFF = 0.3; // multiplier for pace factor
/** Body mass adjustment: heavier = more sweat */
const MASS_REFERENCE_KG = 70;
/** Sodium concentration in sweat: mg per liter (average) */
const SODIUM_MG_PER_L_AVG = 450;
/** Maximum safe fluid intake rate (ml/hr) — hyponatremia risk above this */
const MAX_SAFE_INTAKE_ML_HR = 1000;
/** Optimal replacement ratio: 60-80% of sweat losses */
const REPLACEMENT_RATIO = 0.7;
/** ML to OZ conversion */
const ML_PER_OZ = 29.5735;

// ── Core Calculation ──────────────────────────────────────────────────────────

/**
 * Estimate sweat rate and build hydration plan.
 */
export function calculateSweatRate(
  athlete: AthleteProfile,
  conditions: RaceConditions,
  paceSecPerMi: number,
  estimatedDurationMin: number,
  aidStations?: AidStation[],
): SweatRateEstimate {
  // Base sweat rate adjusted for body mass
  const massMultiplier = athlete.weightKg / MASS_REFERENCE_KG;
  let sweatRate = BASE_SWEAT_ML_HR * massMultiplier;

  // Temperature adjustment
  const tempAbove55 = Math.max(0, conditions.tempF - 55);
  sweatRate += tempAbove55 * TEMP_COEFF;

  // Humidity adjustment
  const humAbove40 = Math.max(0, conditions.humidityPct - 40);
  sweatRate += humAbove40 * HUMIDITY_COEFF;

  // Intensity adjustment (faster pace = more sweat)
  // Reference: 8:00/mi pace = baseline, faster = more, slower = less
  const paceMinPerMi = paceSecPerMi / 60;
  const intensityFactor = 1 + (8 - paceMinPerMi) * INTENSITY_COEFF;
  sweatRate *= Math.max(0.7, Math.min(1.5, intensityFactor));

  // Sun exposure adjustment
  if (conditions.sunExposure === 'full_sun') sweatRate *= 1.1;
  else if (conditions.sunExposure === 'overcast') sweatRate *= 0.9;

  // Sex adjustment (females typically sweat ~15-20% less)
  if (athlete.sex === 'female') sweatRate *= 0.83;

  const baseSweatRate = BASE_SWEAT_ML_HR * massMultiplier;
  const adjustedSweatRate = Math.round(sweatRate);

  // Sodium loss
  const sodiumLoss = Math.round(SODIUM_MG_PER_L_AVG * (adjustedSweatRate / 1000));

  // Fluid deficit per mile
  const mileTimeMin = paceSecPerMi / 60;
  const fluidDeficitPerMile = Math.round((adjustedSweatRate / 60) * mileTimeMin);

  // Recommended intake (70% of sweat rate, capped at safe max)
  const recommendedIntake = Math.min(
    Math.round(adjustedSweatRate * REPLACEMENT_RATIO),
    MAX_SAFE_INTAKE_ML_HR,
  );

  // Total fluid needed
  const totalFluidNeeded = Math.round((recommendedIntake / 60) * estimatedDurationMin);

  // Dehydration risk
  const totalSweatLoss = (adjustedSweatRate / 60) * estimatedDurationMin;
  const weightLossPct = (totalSweatLoss / 1000) / athlete.weightKg * 100;
  let dehydrationRisk: SweatRateEstimate['dehydrationRisk'];
  if (weightLossPct < 2) dehydrationRisk = 'low';
  else if (weightLossPct < 3) dehydrationRisk = 'moderate';
  else if (weightLossPct < 4) dehydrationRisk = 'high';
  else dehydrationRisk = 'extreme';

  // Aid station plan
  const aidStationPlan = buildAidStationPlan(
    aidStations ?? generateDefaultAidStations(),
    recommendedIntake,
    paceSecPerMi,
    adjustedSweatRate,
  );

  // Summary
  const summary = buildHydrationSummary(
    adjustedSweatRate, conditions, recommendedIntake, dehydrationRisk, weightLossPct,
  );

  return {
    baseSweatRateMlHr: Math.round(baseSweatRate),
    adjustedSweatRateMlHr: adjustedSweatRate,
    sodiumLossMgHr: sodiumLoss,
    fluidDeficitPerMileMl: fluidDeficitPerMile,
    recommendedIntakeMlHr: recommendedIntake,
    recommendedIntakeOzHr: Math.round((recommendedIntake / ML_PER_OZ) * 10) / 10,
    totalFluidNeededMl: totalFluidNeeded,
    dehydrationRisk,
    aidStationPlan,
    summary,
  };
}

function buildAidStationPlan(
  stations: AidStation[],
  recommendedMlHr: number,
  paceSecPerMi: number,
  _sweatRate: number,
): AidStationHydration[] {
  if (stations.length === 0) return [];

  // Calculate time between stations to determine how much to drink at each
  const stationMiles = stations.map((s) => s.distanceMi).sort((a, b) => a - b);

  return stations.map((station, idx) => {
    // Time since last station (or start)
    const prevMile = idx === 0 ? 0 : stationMiles[idx - 1];
    const gapMi = station.distanceMi - prevMile;
    const gapMin = (gapMi * paceSecPerMi) / 60;
    const fluidMl = (recommendedMlHr / 60) * gapMin;
    const fluidOz = Math.round((fluidMl / ML_PER_OZ) * 10) / 10;

    // Every other station should include electrolytes
    const electrolyte = idx % 2 === 0 || station.distanceMi > 15;

    let notes = `Target ${fluidOz} oz`;
    if (electrolyte) notes += ' + electrolytes';
    if (station.distanceMi > 20) notes += ' (critical — maintain intake)';

    return {
      distanceMi: station.distanceMi,
      name: station.name,
      fluidOz,
      electrolyte,
      notes,
    };
  });
}

function generateDefaultAidStations(): AidStation[] {
  // Typical marathon aid stations every ~2 miles
  const stations: AidStation[] = [];
  for (let mi = 2; mi <= 25; mi += 2) {
    stations.push({
      distanceMi: mi,
      name: `Mile ${mi}`,
      offerings: ['water', 'sports_drink'],
    });
  }
  return stations;
}

function buildHydrationSummary(
  sweatRate: number,
  conditions: RaceConditions,
  recommended: number,
  risk: string,
  weightLossPct: number,
): string {
  const parts: string[] = [];
  parts.push(`At your pace in ${conditions.tempF}°F/${conditions.humidityPct}% humidity, estimated sweat rate is ~${(sweatRate / 1000).toFixed(1)} L/hr.`);
  parts.push(`Target ${Math.round(recommended / ML_PER_OZ)} oz/hr (${recommended} ml/hr) to stay within ${weightLossPct.toFixed(1)}% body weight loss.`);

  if (risk === 'high' || risk === 'extreme') {
    parts.push('⚠️ High dehydration risk — aggressive hydration strategy needed. Start drinking early and at every aid station.');
  } else if (risk === 'moderate') {
    parts.push('Moderate dehydration risk — consistent hydration at each aid station is important.');
  }

  return parts.join(' ');
}

/**
 * Quick dehydration risk assessment for race conditions.
 */
export function assessDehydrationRisk(
  athlete: AthleteProfile,
  conditions: RaceConditions,
  paceSecPerMi: number,
): { risk: string; message: string } {
  const durationMin = (26.2 * paceSecPerMi) / 60;
  const result = calculateSweatRate(athlete, conditions, paceSecPerMi, durationMin);
  return {
    risk: result.dehydrationRisk,
    message: result.summary,
  };
}
