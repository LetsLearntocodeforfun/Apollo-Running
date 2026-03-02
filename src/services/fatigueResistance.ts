/**
 * Fatigue Resistance Index (FRI) — measures how well a runner maintains
 * pace in the back half of long runs. Direct predictor of marathon performance.
 *
 * Formula: FRI = (avg pace last 30% of run) / (avg pace first 70%) × 100
 *   - FRI = 100: perfect even pacing under fatigue
 *   - FRI < 100: negative split (strong fatigue resistance — speeding up)
 *   - FRI 100-105: slight fade (normal)
 *   - FRI > 105: significant fade (needs work)
 *   - FRI > 110: severe fade (training gap)
 *
 * Based on Santos-Concejero et al. (2014): pacing profiles of elite marathoners
 * and Haney & Mercer (2011): pacing strategy effect on performance
 */

import { persistence } from './db/persistence';

const FRI_KEY = 'apollo_fri_history';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface FRIResult {
  /** Activity identifier */
  activityId: string;
  /** Activity date */
  date: string;
  /** Total distance in miles */
  distanceMi: number;
  /** FRI value (100 = even pace, >100 = fading) */
  fri: number;
  /** Rating based on FRI value */
  rating: FRIRating;
  /** Average pace first 70% (sec/mi) */
  firstSegmentPaceSec: number;
  /** Average pace last 30% (sec/mi) */
  lastSegmentPaceSec: number;
  /** Fade per mile in the last segment (sec/mi/mi) */
  fadeRateSecPerMi: number;
  /** Coach message */
  message: string;
}

export type FRIRating = 'excellent' | 'good' | 'fair' | 'needs_work' | 'severe_fade';

export interface FRITrend {
  /** FRI results from long runs, chronological */
  results: FRIResult[];
  /** Average FRI across the period */
  averageFRI: number;
  /** FRI trend: improving (negative slope) or declining (positive slope) */
  trendDirection: 'improving' | 'stable' | 'declining';
  /** Improvement from first to last (negative = better) */
  deltaFRI: number;
  /** Coach summary */
  summary: string;
}

// ── FRI Calculation ───────────────────────────────────────────────────────────

/**
 * Calculate FRI from split data.
 *
 * @param splits Array of per-mile (or per-km) pace values in sec/unit
 * @param distanceMi Total run distance in miles
 * @param activityId Activity identifier
 * @param date Activity date (YYYY-MM-DD)
 * @returns FRI result, or null if run is too short (<16 miles)
 */
export function calculateFRI(
  splits: number[],
  distanceMi: number,
  activityId: string,
  date: string,
): FRIResult | null {
  // Only analyze long runs (16+ miles)
  if (distanceMi < 16 || splits.length < 10) return null;

  // Filter out anomalous splits (bathroom breaks, water stops)
  const filteredSplits = filterAnomalousSplits(splits);
  if (filteredSplits.length < 10) return null;

  const totalSplits = filteredSplits.length;
  const splitPoint = Math.floor(totalSplits * 0.7);

  // First 70% of splits
  const firstSegment = filteredSplits.slice(0, splitPoint);
  const firstAvg = average(firstSegment);

  // Last 30% of splits
  const lastSegment = filteredSplits.slice(splitPoint);
  const lastAvg = average(lastSegment);

  // FRI = (last segment avg / first segment avg) × 100
  const fri = Math.round((lastAvg / firstAvg) * 1000) / 10;

  // Fade rate: how much pace degrades per mile in the last segment
  const fadeRate = lastSegment.length >= 2
    ? calculateFadeRate(lastSegment)
    : 0;

  const rating = getFRIRating(fri);
  const message = buildFRIMessage(fri, rating, fadeRate, distanceMi);

  return {
    activityId,
    date,
    distanceMi,
    fri,
    rating,
    firstSegmentPaceSec: Math.round(firstAvg),
    lastSegmentPaceSec: Math.round(lastAvg),
    fadeRateSecPerMi: Math.round(fadeRate * 10) / 10,
    message,
  };
}

/**
 * Filter out splits that are > 40% slower than the median (water stops, etc)
 */
function filterAnomalousSplits(splits: number[]): number[] {
  const sorted = [...splits].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const threshold = median * 1.4;
  return splits.filter((s) => s <= threshold && s > 0);
}

function calculateFadeRate(splits: number[]): number {
  if (splits.length < 2) return 0;
  // Linear regression slope of splits vs position
  const n = splits.length;
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += splits[i];
    sumXY += i * splits[i];
    sumX2 += i * i;
  }
  return (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
}

function average(arr: number[]): number {
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function getFRIRating(fri: number): FRIRating {
  if (fri <= 100) return 'excellent';
  if (fri <= 103) return 'good';
  if (fri <= 106) return 'fair';
  if (fri <= 110) return 'needs_work';
  return 'severe_fade';
}

function buildFRIMessage(fri: number, rating: FRIRating, fadeRate: number, distMi: number): string {
  const parts: string[] = [];

  switch (rating) {
    case 'excellent':
      parts.push(`FRI ${fri} — outstanding fatigue resistance! You maintained or improved pace through ${distMi.toFixed(0)} miles.`);
      break;
    case 'good':
      parts.push(`FRI ${fri} — solid pacing. Minimal fade in the final miles. Race-ready endurance.`);
      break;
    case 'fair':
      parts.push(`FRI ${fri} — some pace drop in the last 30%. Normal for training but room to improve for race day.`);
      break;
    case 'needs_work':
      parts.push(`FRI ${fri} — noticeable fade. Consider adding more marathon-pace segments to your long runs.`);
      if (fadeRate > 3) parts.push(`You slowed ~${fadeRate.toFixed(0)} sec/mi per mile in the final miles.`);
      break;
    case 'severe_fade':
      parts.push(`FRI ${fri} — significant fade pattern. This suggests your marathon endurance needs development.`);
      parts.push('Recommendations: (1) Build aerobic base with more easy volume, (2) Add MP segments in long runs, (3) Practice fueling during long runs.');
      break;
  }

  return parts.join(' ');
}

// ── History & Trends ──────────────────────────────────────────────────────────

function getFRIStore(): FRIResult[] {
  try {
    const raw = persistence.getItem(FRI_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveFRIStore(results: FRIResult[]): void {
  // Keep last 50 FRI results
  const trimmed = results.slice(-50);
  persistence.setItem(FRI_KEY, JSON.stringify(trimmed));
}

/** Save an FRI result to history */
export function saveFRIResult(result: FRIResult): void {
  const store = getFRIStore();
  const existing = store.findIndex((r) => r.activityId === result.activityId);
  if (existing >= 0) {
    store[existing] = result;
  } else {
    store.push(result);
  }
  saveFRIStore(store);
}

/** Get all FRI history */
export function getFRIHistory(): FRIResult[] {
  return getFRIStore().sort((a, b) => a.date.localeCompare(b.date));
}

/** Get FRI trend over recent long runs */
export function getFRITrend(count: number = 10): FRITrend {
  const results = getFRIHistory().slice(-count);

  if (results.length === 0) {
    return {
      results: [],
      averageFRI: 0,
      trendDirection: 'stable',
      deltaFRI: 0,
      summary: 'No long runs analyzed yet. Complete a 16+ mile run to start tracking your fatigue resistance.',
    };
  }

  const avgFRI = Math.round((results.reduce((s, r) => s + r.fri, 0) / results.length) * 10) / 10;

  // Trend: compare first half average to second half average
  const mid = Math.floor(results.length / 2);
  const firstHalfAvg = results.length >= 4
    ? results.slice(0, mid).reduce((s, r) => s + r.fri, 0) / mid
    : results[0].fri;
  const secondHalfAvg = results.length >= 4
    ? results.slice(mid).reduce((s, r) => s + r.fri, 0) / (results.length - mid)
    : results[results.length - 1].fri;

  const delta = Math.round((secondHalfAvg - firstHalfAvg) * 10) / 10;
  let trendDirection: FRITrend['trendDirection'];
  if (delta < -1) trendDirection = 'improving';
  else if (delta > 1) trendDirection = 'declining';
  else trendDirection = 'stable';

  const firstFRI = results[0].fri;
  const lastFRI = results[results.length - 1].fri;
  const deltaFRI = Math.round((lastFRI - firstFRI) * 10) / 10;

  let summary: string;
  if (trendDirection === 'improving') {
    summary = `Your FRI improved from ${firstFRI} to ${lastFRI} over the last ${results.length} long runs — you're building excellent fatigue resistance for race day.`;
  } else if (trendDirection === 'declining') {
    summary = `Your FRI has worsened from ${firstFRI} to ${lastFRI}. Consider more easy volume and fueling practice on long runs.`;
  } else {
    summary = `Your FRI is stable at ${avgFRI} over ${results.length} long runs. ${avgFRI <= 103 ? 'Strong endurance base.' : 'Room for improvement — add MP segments to long runs.'}`;
  }

  return { results, averageFRI: avgFRI, trendDirection, deltaFRI, summary };
}
