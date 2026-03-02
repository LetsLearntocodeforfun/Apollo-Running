/**
 * "What-If" Training Simulator — interactive tool that projects
 * how changes to training/behavior affect marathon finish time.
 *
 * Based on:
 * - Daniels' VDOT relationship between training volume and performance
 * - Research: ~2 sec/mile per pound body weight change (Hoogkamer et al., 2016)
 * - Detraining: ~3% fitness loss per week of missed training (Mujika & Padilla, 2000)
 * - Volume-performance relationship: ~1-2% improvement per 10% volume increase (up to limit)
 * - Long run benefit: ~0.5-1% improvement per additional 20+ mile run
 */

import { vdotToMarathonSec, estimateVDOT, formatTimeSec } from './racePrediction';
import { getSavedTrainingPaces } from './paceCalculator';

const MARATHON_MI = 26.2;
const MARATHON_METERS = 42195;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface WhatIfScenario {
  type: WhatIfType;
  label: string;
  description: string;
  /** Parameter value (e.g., percentage increase, days missed, pounds) */
  value: number;
}

export type WhatIfType =
  | 'increase_mileage'
  | 'decrease_mileage'
  | 'skip_days'
  | 'add_long_run'
  | 'marathon_pace_long_runs'
  | 'weight_change'
  | 'add_tempo_runs';

export interface WhatIfResult {
  scenario: WhatIfScenario;
  /** Current predicted marathon time (seconds) */
  baselineTimeSec: number;
  baselineTimeFormatted: string;
  /** Projected marathon time after scenario (seconds) */
  projectedTimeSec: number;
  projectedTimeFormatted: string;
  /** Delta in seconds (negative = faster) */
  deltaSec: number;
  deltaFormatted: string;
  /** Confidence in estimate (0-100) */
  confidence: number;
  /** Risk level of the scenario */
  risk: 'low' | 'moderate' | 'high';
  /** Explanation */
  explanation: string;
}

// ── Scenario Builders ─────────────────────────────────────────────────────────

/** Build common what-if scenarios for the UI */
export function getAvailableScenarios(): WhatIfScenario[] {
  return [
    { type: 'increase_mileage', label: 'Increase weekly mileage by 10%', description: 'Add 10% to current weekly volume', value: 10 },
    { type: 'increase_mileage', label: 'Increase weekly mileage by 20%', description: 'Add 20% to current weekly volume', value: 20 },
    { type: 'decrease_mileage', label: 'Decrease weekly mileage by 20%', description: 'Drop 20% from current volume', value: 20 },
    { type: 'skip_days', label: 'Skip the next 7 days', description: 'Miss one full week of training', value: 7 },
    { type: 'skip_days', label: 'Skip the next 14 days', description: 'Miss two full weeks of training', value: 14 },
    { type: 'add_long_run', label: 'Add 1 extra long run per month', description: 'One additional 20+ mile run monthly', value: 1 },
    { type: 'marathon_pace_long_runs', label: 'Run long runs at marathon pace', description: 'Convert easy long runs to MP long runs', value: 1 },
    { type: 'weight_change', label: 'Lose 5 pounds', description: 'Reduce body weight by 5 lbs', value: -5 },
    { type: 'weight_change', label: 'Gain 5 pounds', description: 'Increase body weight by 5 lbs', value: 5 },
    { type: 'add_tempo_runs', label: 'Add 1 extra tempo run per week', description: 'One additional threshold session weekly', value: 1 },
  ];
}

// ── Simulation Engine ─────────────────────────────────────────────────────────

/**
 * Simulate the effect of a what-if scenario on marathon performance.
 *
 * @param scenario The scenario to simulate
 * @param currentVdot Current VDOT (or estimated from recent race/training)
 * @param currentWeeklyMiles Current weekly mileage
 */
export function simulateWhatIf(
  scenario: WhatIfScenario,
  currentVdot: number,
  currentWeeklyMiles: number,
): WhatIfResult {
  const baselineTimeSec = vdotToMarathonSec(currentVdot);

  let projectedTimeSec: number;
  let confidence: number;
  let risk: WhatIfResult['risk'];
  let explanation: string;

  switch (scenario.type) {
    case 'increase_mileage': {
      const pctIncrease = scenario.value / 100;
      // Research: ~1-2% marathon improvement per 10% volume increase, with diminishing returns
      // Capped at ~5% improvement for safety
      const improvementPct = Math.min(5, pctIncrease * 15);
      projectedTimeSec = baselineTimeSec * (1 - improvementPct / 100);
      confidence = scenario.value <= 15 ? 70 : 55;
      risk = scenario.value > 20 ? 'high' : scenario.value > 10 ? 'moderate' : 'low';
      explanation = `Increasing weekly mileage by ${scenario.value}% (${currentWeeklyMiles.toFixed(0)} → ${(currentWeeklyMiles * (1 + pctIncrease)).toFixed(0)} mi/week) typically yields ~${improvementPct.toFixed(1)}% improvement. ${risk === 'high' ? 'Warning: increases above 20% raise injury risk significantly. Follow the 10% rule.' : ''}`;
      break;
    }

    case 'decrease_mileage': {
      const pctDecrease = scenario.value / 100;
      // Volume loss: ~1.5% performance decline per 10% volume reduction
      const declinePct = pctDecrease * 15;
      projectedTimeSec = baselineTimeSec * (1 + declinePct / 100);
      confidence = 65;
      risk = scenario.value > 30 ? 'high' : 'moderate';
      explanation = `Reducing weekly volume by ${scenario.value}% would cost approximately ${formatTimeSec(Math.round(baselineTimeSec * declinePct / 100))} on your marathon.`;
      break;
    }

    case 'skip_days': {
      const days = scenario.value;
      // Detraining: ~0.4% fitness loss per day missed (first 2 weeks)
      // Mujika & Padilla (2000): ~3% VO2max decline per week
      const weeksOff = days / 7;
      const fitnessLossPct = Math.min(15, weeksOff * 3);
      projectedTimeSec = baselineTimeSec * (1 + fitnessLossPct / 100);
      confidence = days <= 14 ? 65 : 50;
      risk = days > 14 ? 'high' : days > 7 ? 'moderate' : 'low';
      explanation = `Missing ${days} days results in ~${fitnessLossPct.toFixed(1)}% fitness decline. ${days <= 7 ? 'One week off is recoverable within 2-3 weeks of resumed training.' : 'Two+ weeks off requires 4-6 weeks to recover lost fitness.'}`;
      break;
    }

    case 'add_long_run': {
      // ~0.5-1% improvement per additional 20+ mile run
      const improvementPct = scenario.value * 0.75;
      projectedTimeSec = baselineTimeSec * (1 - improvementPct / 100);
      confidence = 60;
      risk = 'moderate';
      explanation = `Adding ${scenario.value} extra long run(s) per month improves marathon-specific endurance by ~${improvementPct.toFixed(1)}%. This builds the long-slow-distance base critical for the last 6 miles.`;
      break;
    }

    case 'marathon_pace_long_runs': {
      // MP long runs: ~1.5-3% improvement (race-specific fitness)
      const improvementPct = 2;
      projectedTimeSec = baselineTimeSec * (1 - improvementPct / 100);
      confidence = 55;
      risk = 'moderate';
      explanation = `Converting long runs to marathon pace improves race-specific fitness by ~${improvementPct}%. However, this increases injury and overtraining risk. Best used for 2-3 long runs in the training cycle, not every week.`;
      break;
    }

    case 'weight_change': {
      const lbs = scenario.value; // negative = loss, positive = gain
      // Research: ~2 seconds per mile per pound (Hoogkamer et al.)
      const secPerMile = lbs * 2;
      const totalDeltaSec = secPerMile * MARATHON_MI;
      projectedTimeSec = baselineTimeSec + totalDeltaSec;
      confidence = 70;
      risk = Math.abs(lbs) > 10 ? 'moderate' : 'low';
      explanation = lbs < 0
        ? `Losing ${Math.abs(lbs)} lbs saves ~${Math.abs(secPerMile)} sec/mile (${formatTimeSec(Math.abs(Math.round(totalDeltaSec)))} total). Ensure weight loss is gradual (0.5-1 lb/week) and doesn't compromise training quality.`
        : `Gaining ${lbs} lbs adds ~${secPerMile} sec/mile (${formatTimeSec(Math.round(totalDeltaSec))} total). If from muscle gain in strength training, actual impact may be smaller.`;
      break;
    }

    case 'add_tempo_runs': {
      // Tempo runs improve lactate threshold → ~1-2% marathon improvement
      const improvementPct = scenario.value * 1.5;
      projectedTimeSec = baselineTimeSec * (1 - improvementPct / 100);
      confidence = 60;
      risk = 'moderate';
      explanation = `Adding ${scenario.value} tempo run(s) per week improves lactate threshold by ~${improvementPct.toFixed(1)}%. This directly improves your ability to sustain marathon pace. Ensure adequate recovery between hard sessions.`;
      break;
    }

    default:
      projectedTimeSec = baselineTimeSec;
      confidence = 0;
      risk = 'low';
      explanation = 'Unknown scenario type.';
  }

  const deltaSec = projectedTimeSec - baselineTimeSec;
  const sign = deltaSec <= 0 ? '-' : '+';
  const deltaFormatted = `${sign}${formatTimeSec(Math.abs(Math.round(deltaSec)))}`;

  return {
    scenario,
    baselineTimeSec: Math.round(baselineTimeSec),
    baselineTimeFormatted: formatTimeSec(Math.round(baselineTimeSec)),
    projectedTimeSec: Math.round(projectedTimeSec),
    projectedTimeFormatted: formatTimeSec(Math.round(projectedTimeSec)),
    deltaSec: Math.round(deltaSec),
    deltaFormatted,
    confidence,
    risk,
    explanation,
  };
}

/**
 * Run all available scenarios against current fitness.
 */
export function simulateAllScenarios(
  currentVdot: number,
  currentWeeklyMiles: number,
): WhatIfResult[] {
  return getAvailableScenarios().map((s) =>
    simulateWhatIf(s, currentVdot, currentWeeklyMiles),
  );
}
