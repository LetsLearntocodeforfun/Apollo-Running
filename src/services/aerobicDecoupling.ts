/**
 * Aerobic Decoupling (`Pa:HR`) & Efficiency Factor (`EF`) Service.
 *
 * Quantifies aerobic durability and cardiac drift across continuous steady-state runs
 * using Joe Friel / TrainingPeaks definitions:
 *
 *   Efficiency Factor (EF) = speedMetersPerMin / avgHR   [m/min per bpm]
 *     (Higher EF = more efficient: covering more ground per heartbeat.)
 *
 *   Aerobic Decoupling (Pa:HR %) = ((EF_firstHalf - EF_secondHalf) / EF_firstHalf) * 100
 *     - Positive %: efficiency fell in the second half (HR drifted up and/or pace slowed).
 *     - Zero / slightly negative %: rock-solid aerobic coupling or controlled negative split.
 *
 * Friel Marathon Durability Thresholds (steady-state runs):
 *   - <= 3.5%  -> 'excellent' (rock-solid aerobic coupling)
 *   - <= 5.0%  -> 'good'      (coupled — aerobic base ready at this duration/intensity)
 *   - <= 8.0%  -> 'moderate'  (noticeable cardiac drift)
 *   - >  8.0%  -> 'high'      (significant cardiac drift — build easy aerobic volume / check heat & hydration)
 *
 * Fixes graduated from src/labs/aerobicDecoupling.ts:
 *   - A-02: Corrects inverted HR/pace sign so fading runners produce positive Pa:HR % ('high'), never 'excellent'.
 *   - A-18: Drops trailing partial splits (< 50% of median split distance when >= 4 full splits remain)
 *           and splits the halves at half the total moving time (Friel / TrainingPeaks), prorating
 *           the split that straddles the midpoint by time.
 *   - A-21: Explicitly labels EF in m/min/bpm and formats paces via unitPreferences (mi / km).
 *   - A-26: Gates steady-state validity via split speed CV (<= 12%), terrain symmetry, and duration.
 */

import { persistence } from './db/persistence';
import { getStoredActivities } from './analyticsService';
import { isRunActivity } from './activity/sports';
import type { Activity, ActivitySplit } from './activity/types';
import { formatPaceFromMinPerMi, getDistanceUnit, metersToMiles, type DistanceUnit } from './unitPreferences';
import { dateKeyFromLocalIso } from '../utils/localDate';

const DECOUPLING_HISTORY_KEY = 'apollo_aerobic_decoupling';
const MAX_HISTORY = 100;

const METERS_PER_MILE = 1609.344;
const MIN_VALID_HR = 90;
const MAX_VALID_HR = 240;

/** Maximum speed coefficient of variation (stdDev / mean) for a run to qualify as steady-state (A-26). */
export const STEADY_STATE_MAX_PACE_CV = 0.12;
/** Minimum duration (30 min) for an individual run to be considered steady-state. */
export const MIN_STEADY_DURATION_SEC = 30 * 60;
/** Minimum duration (40 min) for steady-run decoupling history tracking (A-26). */
export const STEADY_HISTORY_MIN_DURATION_SEC = 40 * 60;
/** Minimum duration (60 min) for steady long-run marathon coupling readiness. */
export const LONG_RUN_DECOUPLING_MIN_DURATION_SEC = 60 * 60;
/** Minimum full splits required for steady-state half comparison (A-18 / A-26). */
const MIN_STEADY_SPLITS = 4;

// ── Types ─────────────────────────────────────────────────────────────────────

export type DecouplingRating = 'excellent' | 'good' | 'moderate' | 'high';

export interface SplitHRPace {
  /** Split number (1-indexed; mile or km split index) */
  mile: number;
  /** Pace in seconds per mile (optional when distanceM and durationSec are provided) */
  paceSec: number;
  /** Average heart rate (bpm) for this split */
  avgHR: number;
  /** Optional split distance in meters (defaults to 1609.344 m when omitted) */
  distanceM?: number;
  /** Optional moving duration in seconds (derived from paceSec and distanceM when omitted) */
  durationSec?: number;
  /** Optional net elevation difference in meters (+ uphill, - downhill) for NGP grade adjustment */
  elevationDiffM?: number;
}

export interface CalculateDecouplingOptions {
  /** Minimum total run distance in miles before returning null (default: 8 for legacy split callers) */
  minDistanceMi?: number;
  /** Minimum valid HR splits before returning null (default: 6 for legacy split callers) */
  minSplits?: number;
  /** Exclude the opening split as a warmup when >= 5 splits exist (default: false) */
  excludeWarmupSplit?: boolean;
  /** Apply Minetti (2002) grade-adjusted speed when elevationDiffM is present (default: true) */
  useGradeAdjustment?: boolean;
}

export interface DecouplingResult {
  activityId: number;
  date: string;
  distanceMi: number;
  /** Total analyzed moving duration in seconds */
  durationSec: number;
  /** Duration-weighted average HR (bpm) in first half */
  hrFirstHalf: number;
  /** Duration-weighted average HR (bpm) in second half */
  hrSecondHalf: number;
  /** Duration-weighted average pace (sec/mi) in first half */
  paceFirstHalf: number;
  /** Duration-weighted average pace (sec/mi) in second half */
  paceSecondHalf: number;
  /** First-half Efficiency Factor in m/min per bpm (higher = more efficient) */
  efFirstHalf: number;
  /** Second-half Efficiency Factor in m/min per bpm (higher = more efficient) */
  efSecondHalf: number;
  /** Overall Efficiency Factor across the run in m/min per bpm */
  efOverall: number;
  /** Explicit unit label for Efficiency Factor (A-21) */
  efUnit: 'm/min/bpm';
  /**
   * Aerobic decoupling Pa:HR % = ((efFirstHalf - efSecondHalf) / efFirstHalf) * 100.
   * Positive = cardiac drift / fading efficiency; <= 5% = coupled.
   */
  decouplingPct: number;
  /** Rating based on Friel thresholds */
  rating: DecouplingRating;
  /** True when steady-state and Pa:HR <= 5.0% (and >= -15%) */
  isCoupled: boolean;
  /** True when pace variability, terrain, and duration represent a steady aerobic run (A-26) */
  isSteadyState: boolean;
  /** Human-readable explanation when isSteadyState is false */
  nonSteadyReason?: string;
  /** Duration-weighted coefficient of variation (stdDev / mean) of split speeds */
  paceCV: number;
  /** True when a trailing partial split (< 50% of median split distance) was excluded (A-18) */
  droppedTrailingPartial: boolean;
  /** Number of valid full splits analyzed */
  splitsUsed: number;
}

export interface ActivityDecouplingSummary extends DecouplingResult {
  activityName: string;
  distanceMeters: number;
  movingTimeSec: number;
  avgHR: number;
  elevationGainM: number;
  splitSource: 'metric' | 'standard';
}

export interface DecouplingTrend {
  /** Trend direction for Pa:HR decoupling (lower drift over time = 'improving') */
  trend: 'improving' | 'stable' | 'declining';
  /** Average decoupling (%) from first half of history */
  earlyAvg: number;
  /** Average decoupling (%) from second half of history */
  recentAvg: number;
  /** Change in percentage points (negative = improving / less cardiac drift) */
  changePct: number;
  /** Human-readable summary */
  message: string;
}

export type EfficiencyFactorTrendDirection = 'rising' | 'stable' | 'declining' | 'insufficient';

export interface AerobicDurabilityOverview {
  /** Steady-state runs >= 40 min with valid HR splits, newest first */
  steadyRuns: ActivityDecouplingSummary[];
  /** Steady long runs >= 60 min with valid HR splits, newest first */
  longRuns: ActivityDecouplingSummary[];
  /** Mean Pa:HR (%) across recent steady long runs (>= 60 min), or null if none */
  avgLongRunDecouplingPct: number | null;
  /** Mean Pa:HR (%) across recent steady runs (>= 40 min), or null if none */
  avgSteadyDecouplingPct: number | null;
  /** True when avgLongRunDecouplingPct <= 5.0%, null when no steady long runs exist */
  longRunCoupled: boolean | null;
  /** Most recent steady run's overall Efficiency Factor (m/min/bpm), or null */
  latestEF: number | null;
  /** Mean EF across the earlier half of steady runs */
  earlyMeanEF: number | null;
  /** Mean EF across the recent half of steady runs */
  recentMeanEF: number | null;
  /** Relative EF change (%) from early half to recent half (positive = faster pace at same HR) */
  efChangePct: number | null;
  /** EF trend direction */
  efTrend: EfficiencyFactorTrendDirection;
}

interface NormalizedSplit {
  distanceM: number;
  durationSec: number;
  avgHR: number;
  paceSecPerMi: number;
  rawSpeedMPerMin: number;
  effectiveSpeedMPerMin: number;
  elevationDiffM: number;
}

// ── Grade Adjustment & Math Helpers ───────────────────────────────────────────

/**
 * Minetti et al. (2002) metabolic energy cost ratio Cr(g) / Cr(0) for running on gradient `g`.
 * Returns 1.0 on flat terrain (g = 0). Clamped to [-30%, +30%] grade to guard against GPS spikes.
 */
export function gradeCostMultiplier(grade: number): number {
  if (!Number.isFinite(grade) || Math.abs(grade) < 1e-4) return 1;
  const g = Math.max(-0.3, Math.min(0.3, grade));
  const cr = 155.4 * g ** 5 - 30.4 * g ** 4 - 43.3 * g ** 3 + 46.3 * g ** 2 + 19.5 * g + 3.6;
  return Math.max(0.45, Math.min(2.8, cr / 3.6));
}

/**
 * Rate Friel Pa:HR aerobic decoupling percentage:
 *   <= 3.5% (down to -5%) -> 'excellent'
 *   <= 5.0% (or progressive negative split < -5%) -> 'good'
 *   <= 8.0% -> 'moderate'
 *   >  8.0% -> 'high'
 */
export function rateDecoupling(pct: number): DecouplingRating {
  if (pct >= -5 && pct <= 3.5) return 'excellent';
  if (pct <= 5.0) return 'good';
  if (pct <= 8.0) return 'moderate';
  return 'high';
}

/** Format an Efficiency Factor value cleanly with optional `m/min/bpm` unit (A-21). */
export function formatEfficiencyFactor(ef: number | null | undefined, includeUnit = true): string {
  if (typeof ef !== 'number' || !Number.isFinite(ef) || ef <= 0) return '—';
  return includeUnit ? `${ef.toFixed(2)} m/min/bpm` : ef.toFixed(2);
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function avg(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

function round2(n: number): number {
  const r = Math.round(n * 100) / 100;
  return r === 0 ? 0 : r;
}

function round3(n: number): number {
  const r = Math.round(n * 1000) / 1000;
  return r === 0 ? 0 : r;
}

function weightedCoefficientOfVariation(items: { weight: number; value: number }[]): number {
  const totalWeight = items.reduce((s, x) => s + x.weight, 0);
  if (totalWeight <= 0 || items.length < 2) return 0;
  const mean = items.reduce((s, x) => s + x.weight * x.value, 0) / totalWeight;
  if (mean <= 0) return 0;
  const variance = items.reduce((s, x) => s + x.weight * (x.value - mean) ** 2, 0) / totalWeight;
  return Math.sqrt(Math.max(0, variance)) / mean;
}

// ── Core Calculation ──────────────────────────────────────────────────────────

/**
 * Calculate aerobic decoupling (`Pa:HR %`) and Efficiency Factor (`EF`) from run splits.
 *
 * - Drops a trailing partial split whose distance is < 50% of median split distance
 *   when >= 4 full splits remain (A-18).
 * - Splits first half vs second half at half the total moving time, prorating the split that
 *   straddles the midpoint by time (A-18; Friel / TrainingPeaks).
 * - Computes EF = speed (m/min) / HR (bpm) and Pa:HR = ((EF1 - EF2) / EF1) * 100 (A-02).
 * - Evaluates steady-state validity via speed CV <= 12%, terrain symmetry, and duration (A-26).
 */
export function calculateDecoupling(
  splits: SplitHRPace[],
  distanceMi: number,
  activityId: number,
  date: string,
  options?: CalculateDecouplingOptions,
): DecouplingResult | null {
  if (!Array.isArray(splits) || splits.length === 0) return null;
  if (!Number.isFinite(distanceMi) || distanceMi <= 0) return null;

  const minDistanceMi = options?.minDistanceMi ?? 8;
  const minSplits = options?.minSplits ?? 6;
  const useGradeAdjustment = options?.useGradeAdjustment ?? true;

  if (distanceMi < minDistanceMi) return null;

  // 1. Normalize split geometry & speeds, discarding NaN / non-positive entries.
  const normalized: NormalizedSplit[] = [];
  for (const s of splits) {
    if (!s || typeof s !== 'object') continue;
    const distanceM = s.distanceM !== undefined ? s.distanceM : METERS_PER_MILE;
    if (!Number.isFinite(distanceM) || distanceM <= 0) continue;

    let durationSec: number;
    if (s.durationSec !== undefined) {
      durationSec = s.durationSec;
    } else if (Number.isFinite(s.paceSec) && s.paceSec > 0) {
      durationSec = s.paceSec * (distanceM / METERS_PER_MILE);
    } else {
      continue;
    }
    if (!Number.isFinite(durationSec) || durationSec <= 0) continue;

    const rawSpeedMPerMin = (distanceM / durationSec) * 60;
    // Reject implausible speeds (< 20 m/min ~80:00/mi or > 600 m/min ~2:40/mi)
    if (!Number.isFinite(rawSpeedMPerMin) || rawSpeedMPerMin < 20 || rawSpeedMPerMin > 600) continue;

    const paceSecPerMi = (METERS_PER_MILE / distanceM) * durationSec;
    const elevationDiffM = s.elevationDiffM !== undefined && Number.isFinite(s.elevationDiffM) ? s.elevationDiffM : 0;
    const gradeMultiplier = useGradeAdjustment && distanceM >= 50 ? gradeCostMultiplier(elevationDiffM / distanceM) : 1;

    normalized.push({
      distanceM,
      durationSec,
      avgHR: s.avgHR,
      paceSecPerMi,
      rawSpeedMPerMin,
      effectiveSpeedMPerMin: rawSpeedMPerMin * gradeMultiplier,
      elevationDiffM,
    });
  }

  if (normalized.length < 2) return null;

  // 2. Drop trailing partial split (< 50% of median split distance) when >= 4 full splits remain (A-18).
  const working = [...normalized];
  let droppedTrailingPartial = false;
  const medianDistM = median(working.map((s) => s.distanceM));
  if (
    medianDistM > 0 &&
    working.length > MIN_STEADY_SPLITS &&
    working[working.length - 1].distanceM < 0.5 * medianDistM
  ) {
    working.pop();
    droppedTrailingPartial = true;
  }

  if (options?.excludeWarmupSplit && working.length > MIN_STEADY_SPLITS) {
    working.shift();
  }

  // 3. Filter splits with missing or implausible heart-rate readings (< 90 or > 240 bpm).
  const hrValid = working.filter((s) => Number.isFinite(s.avgHR) && s.avgHR >= MIN_VALID_HR && s.avgHR <= MAX_VALID_HR);
  if (hrValid.length < minSplits || hrValid.length < 2) return null;

  // 4. Filter isolated stop/walk-break outliers (> 30% slower than median pace),
  //    WITHOUT stripping recovery intervals from alternating interval workouts (A-26).
  const medPace = median(hrValid.map((s) => s.paceSecPerMi));
  const maxSteadyPace = medPace * 1.3;
  const slowCount = hrValid.filter((s) => s.paceSecPerMi > maxSteadyPace).length;
  const maxIsolatedStops = Math.max(1, Math.floor(hrValid.length * 0.15));

  let validSplits: NormalizedSplit[];
  if (slowCount > 0 && slowCount <= maxIsolatedStops) {
    validSplits = hrValid.filter((s) => s.paceSecPerMi <= maxSteadyPace);
  } else {
    validSplits = hrValid;
  }

  if (validSplits.length < minSplits || validSplits.length < 2) return null;

  // 5. Split at half the total moving time (Friel / TrainingPeaks), weighting HR and speed by
  //    duration (A-18). The split that straddles the midpoint is prorated by time; its distance
  //    and elevation follow the same fraction, since each split's speed is its average.
  const totalDistanceM = validSplits.reduce((sum, s) => sum + s.distanceM, 0);
  const totalDurationSec = validSplits.reduce((sum, s) => sum + s.durationSec, 0);
  if (
    !Number.isFinite(totalDistanceM) ||
    totalDistanceM <= 0 ||
    !Number.isFinite(totalDurationSec) ||
    totalDurationSec <= 0
  ) {
    return null;
  }
  const halfDurationSec = totalDurationSec / 2;

  let dur1Sec = 0;
  let dur2Sec = 0;
  let hr1Weighted = 0;
  let hr2Weighted = 0;
  let rawSpeed1Weighted = 0;
  let rawSpeed2Weighted = 0;
  let effSpeed1Weighted = 0;
  let effSpeed2Weighted = 0;
  let dist1M = 0;
  let dist2M = 0;
  let elev1M = 0;
  let elev2M = 0;

  let cursorSec = 0;
  for (const s of validSplits) {
    const startSec = cursorSec;
    const endSec = cursorSec + s.durationSec;
    cursorSec = endSec;

    const w1 = Math.max(0, Math.min(endSec, halfDurationSec) - startSec);
    const w2 = Math.max(0, endSec - Math.max(startSec, halfDurationSec));
    const frac1 = w1 / s.durationSec;
    const frac2 = w2 / s.durationSec;

    dur1Sec += w1;
    dur2Sec += w2;
    hr1Weighted += w1 * s.avgHR;
    hr2Weighted += w2 * s.avgHR;
    rawSpeed1Weighted += w1 * s.rawSpeedMPerMin;
    rawSpeed2Weighted += w2 * s.rawSpeedMPerMin;
    effSpeed1Weighted += w1 * s.effectiveSpeedMPerMin;
    effSpeed2Weighted += w2 * s.effectiveSpeedMPerMin;
    dist1M += frac1 * s.distanceM;
    dist2M += frac2 * s.distanceM;
    elev1M += frac1 * s.elevationDiffM;
    elev2M += frac2 * s.elevationDiffM;
  }

  if (dur1Sec <= 0 || dur2Sec <= 0) return null;

  const hrFirstHalfRaw = hr1Weighted / dur1Sec;
  const hrSecondHalfRaw = hr2Weighted / dur2Sec;
  const rawSpeed1 = rawSpeed1Weighted / dur1Sec;
  const rawSpeed2 = rawSpeed2Weighted / dur2Sec;
  const effSpeed1 = effSpeed1Weighted / dur1Sec;
  const effSpeed2 = effSpeed2Weighted / dur2Sec;

  if (
    hrFirstHalfRaw <= 0 ||
    hrSecondHalfRaw <= 0 ||
    rawSpeed1 <= 0 ||
    rawSpeed2 <= 0 ||
    effSpeed1 <= 0 ||
    effSpeed2 <= 0
  ) {
    return null;
  }

  // 6. Joe Friel Efficiency Factor (m/min per bpm) & Aerobic Decoupling Pa:HR % (A-02).
  const efFirstHalfRaw = effSpeed1 / hrFirstHalfRaw;
  const efSecondHalfRaw = effSpeed2 / hrSecondHalfRaw;
  const overallEffSpeed = (effSpeed1Weighted + effSpeed2Weighted) / totalDurationSec;
  const overallHr = (hr1Weighted + hr2Weighted) / totalDurationSec;
  const efOverallRaw = overallEffSpeed / overallHr;

  const rawDecouplingPct = ((efFirstHalfRaw - efSecondHalfRaw) / efFirstHalfRaw) * 100;
  if (!Number.isFinite(rawDecouplingPct)) return null;
  const decouplingPct = round2(rawDecouplingPct);

  // 7. Steady-State Gating (A-26).
  const paceCV = round3(
    weightedCoefficientOfVariation(validSplits.map((s) => ({ weight: s.durationSec, value: s.effectiveSpeedMPerMin }))),
  );
  const netGrade1 = dist1M > 100 ? elev1M / dist1M : 0;
  const netGrade2 = dist2M > 100 ? elev2M / dist2M : 0;
  const gradeSwing = Math.abs(netGrade2 - netGrade1);

  let isSteadyState = true;
  let nonSteadyReason: string | undefined;

  if (validSplits.length < MIN_STEADY_SPLITS || totalDurationSec < MIN_STEADY_DURATION_SEC) {
    isSteadyState = false;
    nonSteadyReason =
      'Run shorter than 30 minutes or fewer than 4 full splits — Pa:HR requires sustained continuous running';
  } else if (paceCV > STEADY_STATE_MAX_PACE_CV) {
    isSteadyState = false;
    nonSteadyReason = `Varied-pace / interval session (speed CV ${(paceCV * 100).toFixed(0)}%) — Pa:HR only measures aerobic durability on steady runs`;
  } else if (gradeSwing > 0.06) {
    isSteadyState = false;
    nonSteadyReason = 'Extreme elevation asymmetry between halves — terrain profile dominates heart-rate drift';
  } else if (decouplingPct < -15) {
    isSteadyState = false;
    nonSteadyReason = 'Strong progression / warmup buildup (Pa:HR < -15%) — not a constant-effort steady run';
  }

  const rating = rateDecoupling(decouplingPct);
  const isCoupled = isSteadyState && decouplingPct <= 5.0 && decouplingPct >= -15.0;

  const paceFirstHalfSec = (METERS_PER_MILE * 60) / rawSpeed1;
  const paceSecondHalfSec = (METERS_PER_MILE * 60) / rawSpeed2;

  return {
    activityId,
    date,
    distanceMi: round2(distanceMi),
    durationSec: Math.round(totalDurationSec),
    hrFirstHalf: Math.round(hrFirstHalfRaw),
    hrSecondHalf: Math.round(hrSecondHalfRaw),
    paceFirstHalf: Math.round(paceFirstHalfSec),
    paceSecondHalf: Math.round(paceSecondHalfSec),
    efFirstHalf: round3(efFirstHalfRaw),
    efSecondHalf: round3(efSecondHalfRaw),
    efOverall: round3(efOverallRaw),
    efUnit: 'm/min/bpm',
    decouplingPct,
    rating,
    isCoupled,
    isSteadyState,
    ...(nonSteadyReason ? { nonSteadyReason } : {}),
    paceCV,
    droppedTrailingPartial,
    splitsUsed: validSplits.length,
  };
}

// ── Stored Activity Extraction & Durability History ───────────────────────────

function countValidHRSplits(splits: ActivitySplit[] | undefined): number {
  if (!Array.isArray(splits)) return 0;
  return splits.filter(
    (s) =>
      s &&
      Number.isFinite(s.distance) &&
      s.distance > 0 &&
      Number.isFinite(s.average_heartrate) &&
      (s.average_heartrate ?? 0) >= MIN_VALID_HR,
  ).length;
}

function toSplitHRPaceList(splits: ActivitySplit[]): SplitHRPace[] {
  return splits.map((s, idx) => {
    const durationSec = s.moving_time > 0 ? s.moving_time : s.elapsed_time;
    const distanceM = s.distance;
    const paceSec = distanceM > 0 && durationSec > 0 ? (durationSec / distanceM) * METERS_PER_MILE : 0;
    return {
      mile: Number.isFinite(s.split) && s.split > 0 ? s.split : idx + 1,
      paceSec,
      avgHR: s.average_heartrate ?? 0,
      distanceM,
      durationSec,
      elevationDiffM: Number.isFinite(s.elevation_difference) ? s.elevation_difference : 0,
    };
  });
}

/**
 * Analyze a stored `Activity` for aerobic decoupling (`Pa:HR %`) and Efficiency Factor (`EF`).
 *
 * Prefers `splits_metric` (1 km splits) for finer midpoint resolution and falls back to
 * `splits_standard` (1 mi splits). Applies Minetti grade adjustment when split elevation
 * differences are available so rolling courses don't create false decoupling.
 */
export function analyzeActivityDecoupling(activity: Activity): ActivityDecouplingSummary | null {
  if (!activity || activity.hidden || !isRunActivity(activity)) return null;
  if (!Number.isFinite(activity.distance) || activity.distance <= 0) return null;

  const metricValidCount = countValidHRSplits(activity.splits_metric);
  const standardValidCount = countValidHRSplits(activity.splits_standard);

  let rawSplits: ActivitySplit[] | undefined;
  let splitSource: 'metric' | 'standard' = 'metric';

  if (metricValidCount >= 2 && activity.splits_metric) {
    rawSplits = activity.splits_metric;
    splitSource = 'metric';
  } else if (standardValidCount >= 2 && activity.splits_standard) {
    rawSplits = activity.splits_standard;
    splitSource = 'standard';
  } else {
    return null;
  }

  const date =
    dateKeyFromLocalIso(activity.start_date_local) ??
    dateKeyFromLocalIso(activity.start_date) ??
    activity.start_date.slice(0, 10);
  const distanceMi = metersToMiles(activity.distance);
  const movingTimeSec =
    Number.isFinite(activity.moving_time) && activity.moving_time > 0 ? activity.moving_time : activity.elapsed_time;

  const splitInputs = toSplitHRPaceList(rawSplits);
  const base = calculateDecoupling(splitInputs, distanceMi, activity.id, date, {
    minDistanceMi: 0.5,
    minSplits: 2,
    useGradeAdjustment: true,
  });

  if (!base) return null;

  let { isSteadyState, nonSteadyReason, isCoupled } = base;

  // Enforce overall activity duration and check structured interval laps (e.g. 400m repeats inside 1km auto-splits).
  const effectiveMovingSec = Number.isFinite(movingTimeSec) && movingTimeSec > 0 ? movingTimeSec : base.durationSec;
  if (isSteadyState && effectiveMovingSec < MIN_STEADY_DURATION_SEC) {
    isSteadyState = false;
    isCoupled = false;
    nonSteadyReason = 'Run shorter than 30 minutes — Pa:HR requires sustained continuous aerobic running';
  } else if (isSteadyState && Array.isArray(activity.laps) && activity.laps.length >= 4) {
    const validLaps = activity.laps.filter(
      (l) => l && Number.isFinite(l.distance) && l.distance >= 100 && (l.moving_time > 10 || l.elapsed_time > 10),
    );
    if (validLaps.length >= 4) {
      const lapCV = weightedCoefficientOfVariation(
        validLaps.map((l) => {
          const dur = l.moving_time > 0 ? l.moving_time : l.elapsed_time;
          return { weight: dur, value: (l.distance / dur) * 60 };
        }),
      );
      if (lapCV > 0.15) {
        isSteadyState = false;
        isCoupled = false;
        nonSteadyReason = `Structured interval laps detected (lap speed CV ${(lapCV * 100).toFixed(0)}%) — Pa:HR only measures aerobic durability on steady runs`;
      }
    }
  }

  const avgHR = Math.round(
    Number.isFinite(activity.average_heartrate) && (activity.average_heartrate ?? 0) > 0
      ? (activity.average_heartrate as number)
      : (base.hrFirstHalf + base.hrSecondHalf) / 2,
  );

  return {
    ...base,
    isSteadyState,
    isCoupled,
    ...(nonSteadyReason ? { nonSteadyReason } : {}),
    activityName: activity.name || 'Run',
    distanceMeters: activity.distance,
    movingTimeSec: Math.round(effectiveMovingSec),
    avgHR,
    elevationGainM:
      Number.isFinite(activity.total_elevation_gain) && (activity.total_elevation_gain ?? 0) > 0
        ? Math.round(activity.total_elevation_gain as number)
        : 0,
    splitSource,
  };
}

/**
 * Filter activities to continuous steady-state runs (>= 40 min by default) with valid HR splits,
 * sorted newest-first (A-26).
 */
export function getSteadyRunDecouplingHistory(
  activities?: Activity[],
  minDurationSec: number = STEADY_HISTORY_MIN_DURATION_SEC,
): ActivityDecouplingSummary[] {
  const source = activities ?? getStoredActivities();
  const out: ActivityDecouplingSummary[] = [];

  for (const act of source) {
    if (!act || act.hidden || !isRunActivity(act)) continue;
    const dur = act.moving_time > 0 ? act.moving_time : act.elapsed_time;
    if (!Number.isFinite(dur) || dur < minDurationSec) continue;

    const analyzed = analyzeActivityDecoupling(act);
    if (analyzed && analyzed.isSteadyState && analyzed.movingTimeSec >= minDurationSec) {
      out.push(analyzed);
    }
  }

  out.sort((a, b) => b.date.localeCompare(a.date) || b.activityId - a.activityId);
  return out;
}

/**
 * Compute aggregate Aerobic Durability (`Pa:HR` & `EF`) metrics for the Progress page:
 * - Mean `Pa:HR` on recent steady long runs (>= 60 min) and <= 5% Coupled readiness
 * - Efficiency Factor (`EF`, m/min/bpm) trend across steady aerobic runs
 * - Full steady-run list (>= 40 min)
 */
export function buildAerobicDurabilityOverview(activities?: Activity[]): AerobicDurabilityOverview {
  const steadyRuns = getSteadyRunDecouplingHistory(activities, STEADY_HISTORY_MIN_DURATION_SEC);
  const longRuns = steadyRuns.filter((r) => r.movingTimeSec >= LONG_RUN_DECOUPLING_MIN_DURATION_SEC);

  const recentLongSlice = longRuns.slice(0, 8);
  const avgLongRunDecouplingPct =
    recentLongSlice.length > 0 ? round2(avg(recentLongSlice.map((r) => r.decouplingPct))) : null;
  const longRunCoupled = avgLongRunDecouplingPct !== null ? avgLongRunDecouplingPct <= 5.0 : null;

  const recentSteadySlice = steadyRuns.slice(0, 12);
  const avgSteadyDecouplingPct =
    recentSteadySlice.length > 0 ? round2(avg(recentSteadySlice.map((r) => r.decouplingPct))) : null;

  const latestEF = steadyRuns.length > 0 ? steadyRuns[0].efOverall : null;

  let earlyMeanEF: number | null = null;
  let recentMeanEF: number | null = null;
  let efChangePct: number | null = null;
  let efTrend: EfficiencyFactorTrendDirection = 'insufficient';

  if (recentSteadySlice.length >= 2) {
    const chronological = [...recentSteadySlice].reverse();
    const mid = Math.floor(chronological.length / 2);
    const early = avg(chronological.slice(0, mid).map((r) => r.efOverall));
    const recent = avg(chronological.slice(mid).map((r) => r.efOverall));
    if (early > 0) {
      earlyMeanEF = round3(early);
      recentMeanEF = round3(recent);
      efChangePct = round2(((recent - early) / early) * 100);
      if (efChangePct >= 1.5) efTrend = 'rising';
      else if (efChangePct <= -1.5) efTrend = 'declining';
      else efTrend = 'stable';
    }
  }

  return {
    steadyRuns,
    longRuns,
    avgLongRunDecouplingPct,
    avgSteadyDecouplingPct,
    longRunCoupled,
    latestEF,
    earlyMeanEF,
    recentMeanEF,
    efChangePct,
    efTrend,
  };
}

// ── Persistence ───────────────────────────────────────────────────────────────

export function saveDecouplingResult(result: DecouplingResult): void {
  const history = getDecouplingHistory();
  const idx = history.findIndex((h) => h.activityId === result.activityId);
  if (idx >= 0) {
    history[idx] = result;
  } else {
    history.push(result);
  }
  if (history.length > MAX_HISTORY) {
    history.splice(0, history.length - MAX_HISTORY);
  }
  persistence.setItem(DECOUPLING_HISTORY_KEY, JSON.stringify(history));
}

export function getDecouplingHistory(): DecouplingResult[] {
  try {
    const raw = persistence.getItem(DECOUPLING_HISTORY_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is DecouplingResult =>
        !!item &&
        typeof item === 'object' &&
        typeof (item as DecouplingResult).activityId === 'number' &&
        typeof (item as DecouplingResult).decouplingPct === 'number' &&
        Number.isFinite((item as DecouplingResult).decouplingPct),
    );
  } catch {
    return [];
  }
}

// ── Trend Analysis ────────────────────────────────────────────────────────────

/**
 * Analyze decoupling trend over persisted steady-run history.
 * Compares the early half of steady entries to the recent half.
 */
export function getDecouplingTrend(minEntries: number = 4): DecouplingTrend | null {
  const history = getDecouplingHistory()
    .filter((h) => h.isSteadyState !== false)
    .sort((a, b) => a.date.localeCompare(b.date));

  if (history.length < minEntries) return null;

  const mid = Math.floor(history.length / 2);
  const earlyAvg = avg(history.slice(0, mid).map((h) => h.decouplingPct));
  const recentAvg = avg(history.slice(mid).map((h) => h.decouplingPct));
  const changePct = round2(recentAvg - earlyAvg);

  let trend: DecouplingTrend['trend'];
  if (changePct < -1.5) trend = 'improving';
  else if (changePct > 1.5) trend = 'declining';
  else trend = 'stable';

  const message = buildTrendMessage(trend, earlyAvg, recentAvg, history.length);

  return {
    trend,
    earlyAvg: round2(earlyAvg),
    recentAvg: round2(recentAvg),
    changePct,
    message,
  };
}

function buildTrendMessage(
  trend: DecouplingTrend['trend'],
  earlyAvg: number,
  recentAvg: number,
  count: number,
): string {
  const earlyStr = earlyAvg.toFixed(1);
  const recentStr = recentAvg.toFixed(1);

  switch (trend) {
    case 'improving':
      return `Your aerobic decoupling (Pa:HR) dropped from ${earlyStr}% to ${recentStr}% over ${count} steady runs — your aerobic durability is improving.`;
    case 'declining':
      return `Your aerobic decoupling (Pa:HR) rose from ${earlyStr}% to ${recentStr}%. Easy aerobic volume, cooling, and hydration help bring drift back down.`;
    case 'stable':
      return `Your aerobic decoupling (Pa:HR) held steady around ${recentStr}% over ${count} steady runs.${recentAvg <= 5 ? ' Well-coupled aerobic base.' : recentAvg <= 8 ? ' Steady foundation.' : ' More easy mileage will help bring drift under 5%.'}`;
  }
}

// ── Coaching Integration ──────────────────────────────────────────────────────

/**
 * Get a unit-aware coaching message for a decoupling result (A-21 / A-26).
 * Formats paces using the user's preferred distance unit (`mi` or `km`) and labels EF in `m/min/bpm`.
 */
export function getDecouplingCoachingMessage(result: DecouplingResult, unit?: DistanceUnit): string {
  if (!result.isSteadyState) {
    return (
      result.nonSteadyReason ??
      'Varied-pace session — Pa:HR only measures aerobic durability on continuous steady runs.'
    );
  }

  const u = unit ?? getDistanceUnit();
  const pctSign = result.decouplingPct > 0 ? '+' : '';
  const pctStr = `${pctSign}${result.decouplingPct.toFixed(1)}%`;
  const hrDelta = result.hrSecondHalf - result.hrFirstHalf;
  const hrStr = hrDelta >= 0 ? `rose ${hrDelta} bpm` : `dropped ${Math.abs(hrDelta)} bpm`;
  const pace1 = formatPaceFromMinPerMi(result.paceFirstHalf / 60, u);
  const pace2 = formatPaceFromMinPerMi(result.paceSecondHalf / 60, u);
  const efInfo =
    result.efFirstHalf > 0 && result.efSecondHalf > 0
      ? ` (EF ${result.efFirstHalf.toFixed(2)} → ${result.efSecondHalf.toFixed(2)} m/min/bpm, pace ${pace1} → ${pace2})`
      : '';

  switch (result.rating) {
    case 'excellent':
      return `Aerobic decoupling (Pa:HR): ${pctStr}${efInfo} — excellent coupling. Heart rate ${hrStr} across the second half.`;
    case 'good':
      return `Aerobic decoupling (Pa:HR): ${pctStr}${efInfo} — well coupled (≤ 5%). Heart rate ${hrStr}, showing steady aerobic durability.`;
    case 'moderate':
      return `Aerobic decoupling (Pa:HR): ${pctStr}${efInfo} — moderate drift. Heart rate ${hrStr} in the second half; consistent easy long runs help bring drift under 5%.`;
    case 'high':
      return `Aerobic decoupling (Pa:HR): ${pctStr}${efInfo} — high cardiac drift. Heart rate ${hrStr}. Building your aerobic base with easy mileage — and checking heat and hydration — will reduce drift.`;
  }
}
