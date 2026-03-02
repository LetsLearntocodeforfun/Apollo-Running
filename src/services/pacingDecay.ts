/**
 * Pacing Decay Curve — model YOUR personal pacing decay from long run data.
 *
 * Fits a linear decay function to actual pace data:
 *   pace(mile) = base_pace × (1 + decay_rate × mile_offset)
 *
 * Where mile_offset starts after a "stable phase" (first 5-8 miles).
 * This personal model replaces generic negative/even/positive split strategies.
 *
 * Used to:
 * 1. Generate personalized race strategy pacing
 * 2. Compare your decay to ideal decay curves for your target time
 * 3. Track how your decay improves over training
 */

import { persistence } from './db/persistence';

const DECAY_KEY = 'apollo_pacing_decay';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PacingDecayModel {
  /** Base pace in the stable phase (sec/mi) */
  basePaceSec: number;
  /** Decay rate: fraction of pace increase per mile after stable phase */
  decayRatePerMi: number;
  /** Mile at which decay begins (typically 12-16) */
  decayStartMile: number;
  /** R² of the fit (0-1, higher = better fit) */
  rSquared: number;
  /** Number of long runs used in the model */
  sampleSize: number;
  /** Date range of data */
  dateRange: { from: string; to: string };
  /** Updated timestamp */
  updatedAt: string;
}

export interface DecayComparison {
  /** Your personal decay rate */
  yourDecayPct: number;
  /** Ideal decay rate for your target time */
  idealDecayPct: number;
  /** Difference (positive = you fade more than ideal) */
  gapPct: number;
  /** Assessment message */
  message: string;
}

export interface PredictedPace {
  mile: number;
  paceSec: number;
  paceFormatted: string;
}

// ── Decay Model Fitting ───────────────────────────────────────────────────────

/**
 * Fit a pacing decay model from multiple long run split arrays.
 *
 * @param longRuns Array of { date, splits[] } where splits are sec/mi per mile
 * @param minDistance Minimum run distance in miles to include (default 16)
 * @returns Fitted decay model, or null if insufficient data
 */
export function fitDecayModel(
  longRuns: { date: string; splits: number[] }[],
  minDistance: number = 16,
): PacingDecayModel | null {
  // Filter to qualified long runs
  const qualified = longRuns.filter((r) => r.splits.length >= minDistance);
  if (qualified.length < 3) return null; // Need at least 3 long runs

  // Normalize runs: for each run, compute the relative pace at each mile
  // relative to its own stable phase (miles 3-8 average)
  const allDecayPoints: { mileOffset: number; relPace: number }[] = [];

  for (const run of qualified) {
    const splits = filterAnomalous(run.splits);
    if (splits.length < minDistance) continue;

    // Stable phase: miles 3-8 (indices 2-7)
    const stableStart = 2;
    const stableEnd = Math.min(7, Math.floor(splits.length * 0.4));
    const stablePhase = splits.slice(stableStart, stableEnd + 1);
    const basePace = stablePhase.reduce((s, v) => s + v, 0) / stablePhase.length;

    // Decay phase: from stableEnd onwards
    for (let i = stableEnd + 1; i < splits.length; i++) {
      const mileOffset = i - stableEnd;
      const relPace = splits[i] / basePace;
      allDecayPoints.push({ mileOffset, relPace });
    }
  }

  if (allDecayPoints.length < 10) return null;

  // Linear regression: relPace = 1 + decayRate × mileOffset
  // i.e., y = 1 + slope × x where y = relPace, x = mileOffset
  const n = allDecayPoints.length;
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0;
  for (const pt of allDecayPoints) {
    sumX += pt.mileOffset;
    sumY += pt.relPace;
    sumXY += pt.mileOffset * pt.relPace;
    sumX2 += pt.mileOffset * pt.mileOffset;
    sumY2 += pt.relPace * pt.relPace;
  }

  const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
  const intercept = (sumY - slope * sumX) / n;

  // R² calculation
  const meanY = sumY / n;
  const ssTot = sumY2 - n * meanY * meanY;
  const ssRes = allDecayPoints.reduce((s, pt) => {
    const predicted = intercept + slope * pt.mileOffset;
    return s + (pt.relPace - predicted) ** 2;
  }, 0);
  const rSquared = Math.max(0, 1 - ssRes / ssTot);

  // Compute overall base pace from the stable phases
  let totalBasePace = 0;
  let basePaceCount = 0;
  for (const run of qualified) {
    const splits = filterAnomalous(run.splits);
    if (splits.length < minDistance) continue;
    const stableEnd = Math.min(7, Math.floor(splits.length * 0.4));
    const stablePhase = splits.slice(2, stableEnd + 1);
    totalBasePace += stablePhase.reduce((s, v) => s + v, 0) / stablePhase.length;
    basePaceCount++;
  }

  const dates = qualified.map((r) => r.date).sort();

  return {
    basePaceSec: Math.round(totalBasePace / basePaceCount),
    decayRatePerMi: Math.round(slope * 10000) / 10000, // e.g., 0.008 = 0.8%/mi
    decayStartMile: 8, // default stable phase end
    rSquared: Math.round(rSquared * 1000) / 1000,
    sampleSize: qualified.length,
    dateRange: { from: dates[0], to: dates[dates.length - 1] },
    updatedAt: new Date().toISOString(),
  };
}

function filterAnomalous(splits: number[]): number[] {
  const sorted = [...splits].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const threshold = median * 1.35;
  return splits.map((s) => (s > threshold || s <= 0) ? median : s);
}

// ── Predictions ───────────────────────────────────────────────────────────────

/**
 * Predict mile-by-mile pacing using your personal decay model.
 */
export function predictRacePacing(
  model: PacingDecayModel,
  targetPaceSecMi: number,
  totalMiles: number = 26,
): PredictedPace[] {
  const paces: PredictedPace[] = [];

  for (let mile = 1; mile <= totalMiles; mile++) {
    let paceSec: number;
    if (mile <= model.decayStartMile) {
      // Stable phase — run at target pace
      paceSec = targetPaceSecMi;
    } else {
      // Decay phase — pace increases based on your personal model
      const mileOffset = mile - model.decayStartMile;
      paceSec = targetPaceSecMi * (1 + model.decayRatePerMi * mileOffset);
    }

    const totalSec = Math.round(paceSec);
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;

    paces.push({
      mile,
      paceSec: totalSec,
      paceFormatted: `${min}:${sec.toString().padStart(2, '0')}/mi`,
    });
  }

  return paces;
}

/**
 * Compare your decay to the ideal for a target marathon time.
 *
 * Elite runners: ~0.2-0.5%/mi decay
 * Sub-3:00: ~0.3-0.6%/mi
 * 3:00-3:30: ~0.5-0.8%/mi
 * 3:30-4:00: ~0.6-1.0%/mi
 * 4:00+: ~0.8-1.5%/mi
 */
export function compareDecayToIdeal(
  model: PacingDecayModel,
  targetTimeSec: number,
): DecayComparison {
  const targetHours = targetTimeSec / 3600;
  let idealDecay: number;

  if (targetHours < 2.75) idealDecay = 0.004; // 0.4%/mi
  else if (targetHours < 3.0) idealDecay = 0.005;
  else if (targetHours < 3.5) idealDecay = 0.007;
  else if (targetHours < 4.0) idealDecay = 0.009;
  else idealDecay = 0.012;

  const yourPct = model.decayRatePerMi * 100;
  const idealPct = idealDecay * 100;
  const gap = yourPct - idealPct;

  let message: string;
  if (gap <= 0) {
    message = `Your pacing decay (${yourPct.toFixed(1)}%/mi) is better than the ideal for your target (${idealPct.toFixed(1)}%/mi). Strong fatigue resistance!`;
  } else if (gap < 0.3) {
    message = `Your pacing decay (${yourPct.toFixed(1)}%/mi) is close to ideal (${idealPct.toFixed(1)}%/mi). Minor improvements through more marathon-pace training would close the gap.`;
  } else {
    message = `Your pacing decay (${yourPct.toFixed(1)}%/mi) is ${gap.toFixed(1)}% above ideal (${idealPct.toFixed(1)}%/mi). Focus on MP long runs and fueling practice to reduce late-race fade.`;
  }

  return { yourDecayPct: yourPct, idealDecayPct: idealPct, gapPct: gap, message };
}

// ── Persistence ───────────────────────────────────────────────────────────────

export function saveDecayModel(model: PacingDecayModel): void {
  persistence.setItem(DECAY_KEY, JSON.stringify(model));
}

export function getSavedDecayModel(): PacingDecayModel | null {
  try {
    const raw = persistence.getItem(DECAY_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
