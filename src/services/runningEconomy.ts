/**
 * Running Economy Tracker Service
 *
 * Tracks pace:HR ratio over time as the most direct non-lab measure of
 * aerobic efficiency. Filters to easy/recovery runs for apples-to-apples
 * comparison and detects trends, improvements, and early overtraining signals.
 *
 * Running Economy = Speed / Heart Rate (higher = more efficient)
 *
 * References:
 * - Daniels, J. "vVO2max and Running Economy"
 * - Morgan, D.W. et al. (1995) "Variation in the aerobic demand of running"
 * - Barnes & Kilding (2015) "Running economy: measurement, norms, and factors"
 */

import type { StravaActivity } from './strava';
import { getHRProfile } from './heartRate';
import { persistence } from './db/persistence';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface EconomyDataPoint {
  date: string;
  activityId: number;
  activityName: string;
  /** Speed in meters per minute */
  speedMPerMin: number;
  /** Average heart rate */
  avgHR: number;
  /** Economy index: (speed / HR) × 100 — higher is better */
  economyIndex: number;
  /** Pace in min/mi for display */
  paceMinPerMi: number;
  /** Distance in miles */
  distanceMi: number;
  /** Workout type classification */
  runType: 'easy' | 'long' | 'tempo' | 'all';
}

export interface EconomyTrend {
  /** Rolling average economy index over the window */
  rollingAvg: number;
  /** Rolling values for charting */
  points: { date: string; economy: number; rollingAvg: number }[];
  /** Start and end values for improvement calculation */
  startAvg: number;
  endAvg: number;
  /** Improvement percentage (positive = improvement) */
  improvementPct: number;
  /** Trend direction */
  trend: 'improving' | 'stable' | 'declining';
}

export interface EconomyResult {
  /** All qualifying data points */
  dataPoints: EconomyDataPoint[];
  /** 30-day rolling trend (easy runs only) */
  easyRunTrend: EconomyTrend | null;
  /** All-run trend for broader context */
  allRunTrend: EconomyTrend | null;
  /** Current economy index (latest 7-day average) */
  currentEconomy: number | null;
  /** Personal best economy index */
  personalBest: { value: number; date: string } | null;
  /** Comparison to personal best */
  pctFromPB: number | null;
  /** Consecutive weeks of decline (overtraining signal) */
  declineWeeks: number;
  /** Coaching insights */
  insights: string[];
}

// ── Constants ─────────────────────────────────────────────────────────────────

const ECONOMY_KEY = 'apollo_running_economy';

/** Minimum distance (mi) for a run to qualify */
const MIN_DISTANCE_MI = 2;

/** Maximum distance (mi) for "easy run" classification */
const MAX_EASY_DISTANCE_MI = 9;

/** Minimum HR to consider valid (rules out sensor glitches) */
const MIN_VALID_HR = 80;

/** Rolling average window in days */
const ROLLING_WINDOW_DAYS = 30;

// ── Core Calculations ─────────────────────────────────────────────────────────

/**
 * Calculate the economy index for a single activity.
 * Economy = (speed in m/min) / HR × 100
 * Higher values = more speed per heartbeat = more efficient.
 */
export function calculateEconomyIndex(
  distanceMeters: number,
  movingTimeSec: number,
  avgHR: number,
): number {
  if (movingTimeSec <= 0 || avgHR <= 0) return 0;
  const speedMPerMin = distanceMeters / (movingTimeSec / 60);
  return (speedMPerMin / avgHR) * 100;
}

/**
 * Classify a run as easy/long/tempo based on pace relative to HR zones.
 */
export function classifyRunType(
  distanceMi: number,
  _paceMinPerMi: number,
  avgHR: number,
): EconomyDataPoint['runType'] {
  const profile = getHRProfile();
  const hrPct = (avgHR / profile.maxHR) * 100;

  // Easy: < 75% maxHR and reasonable distance
  if (hrPct < 75 && distanceMi <= MAX_EASY_DISTANCE_MI) return 'easy';
  // Long: > 9 mi at easy-ish effort
  if (distanceMi > MAX_EASY_DISTANCE_MI && hrPct < 80) return 'long';
  // Tempo: higher HR%
  if (hrPct >= 75) return 'tempo';

  return 'easy';
}

// ── Activity to Economy Data ─────────────────────────────────────────────────

/**
 * Convert Strava activities to economy data points.
 * Filters to runs with valid HR data and minimum distance.
 */
export function activitiesToEconomyPoints(activities: StravaActivity[]): EconomyDataPoint[] {
  const runTypes = ['Run', 'VirtualRun', 'TrailRun'];

  return activities
    .filter((a) => {
      if (!runTypes.includes(a.type) && !runTypes.includes(a.sport_type)) return false;
      if (!a.average_heartrate || a.average_heartrate < MIN_VALID_HR) return false;
      const distanceMi = a.distance / 1609.34;
      if (distanceMi < MIN_DISTANCE_MI) return false;
      if (a.moving_time <= 0) return false;
      return true;
    })
    .map((a) => {
      const distanceMi = a.distance / 1609.34;
      const paceMinPerMi = a.moving_time / 60 / distanceMi;
      const speedMPerMin = a.distance / (a.moving_time / 60);
      const economyIndex = calculateEconomyIndex(a.distance, a.moving_time, a.average_heartrate!);
      const runType = classifyRunType(distanceMi, paceMinPerMi, a.average_heartrate!);

      return {
        date: a.start_date_local.slice(0, 10),
        activityId: a.id,
        activityName: a.name,
        speedMPerMin,
        avgHR: a.average_heartrate!,
        economyIndex: Math.round(economyIndex * 100) / 100,
        paceMinPerMi: Math.round(paceMinPerMi * 100) / 100,
        distanceMi: Math.round(distanceMi * 10) / 10,
        runType,
      };
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}

// ── Trend Calculation ────────────────────────────────────────────────────────

/**
 * Calculate a rolling economy trend from data points.
 */
export function calculateEconomyTrend(
  points: EconomyDataPoint[],
  windowDays: number = ROLLING_WINDOW_DAYS,
): EconomyTrend | null {
  if (points.length < 3) return null;

  const sorted = [...points].sort((a, b) => a.date.localeCompare(b.date));

  // Calculate rolling average
  const trendPoints: EconomyTrend['points'] = [];

  for (let i = 0; i < sorted.length; i++) {
    const cutoffDate = new Date(sorted[i].date);
    cutoffDate.setDate(cutoffDate.getDate() - windowDays);
    const cutoffStr = cutoffDate.toISOString().slice(0, 10);

    const windowPoints = sorted.filter(
      (p, j) => j <= i && p.date >= cutoffStr,
    );

    const rollingAvg = windowPoints.reduce((s, p) => s + p.economyIndex, 0) / windowPoints.length;

    trendPoints.push({
      date: sorted[i].date,
      economy: sorted[i].economyIndex,
      rollingAvg: Math.round(rollingAvg * 100) / 100,
    });
  }

  // Calculate improvement
  const firstThird = trendPoints.slice(0, Math.max(1, Math.floor(trendPoints.length / 3)));
  const lastThird = trendPoints.slice(-Math.max(1, Math.floor(trendPoints.length / 3)));

  const startAvg = firstThird.reduce((s, p) => s + p.rollingAvg, 0) / firstThird.length;
  const endAvg = lastThird.reduce((s, p) => s + p.rollingAvg, 0) / lastThird.length;
  const improvementPct = startAvg > 0 ? ((endAvg - startAvg) / startAvg) * 100 : 0;

  let trend: EconomyTrend['trend'];
  if (improvementPct > 2) trend = 'improving';
  else if (improvementPct < -2) trend = 'declining';
  else trend = 'stable';

  return {
    rollingAvg: Math.round(endAvg * 100) / 100,
    points: trendPoints,
    startAvg: Math.round(startAvg * 100) / 100,
    endAvg: Math.round(endAvg * 100) / 100,
    improvementPct: Math.round(improvementPct * 10) / 10,
    trend,
  };
}

// ── Decline Detection ────────────────────────────────────────────────────────

/**
 * Detect consecutive weeks of economy decline (early overtraining signal).
 */
export function detectDeclineWeeks(points: EconomyDataPoint[]): number {
  if (points.length < 7) return 0;

  // Group by ISO week
  const weekMap = new Map<string, number[]>();
  for (const p of points) {
    const d = new Date(p.date);
    const yearWeek = getISOWeek(d);
    const arr = weekMap.get(yearWeek) ?? [];
    arr.push(p.economyIndex);
    weekMap.set(yearWeek, arr);
  }

  const weekAvgs = Array.from(weekMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, vals]) => vals.reduce((s, v) => s + v, 0) / vals.length);

  // Count consecutive trailing weeks of decline
  let declineCount = 0;
  for (let i = weekAvgs.length - 1; i > 0; i--) {
    if (weekAvgs[i] < weekAvgs[i - 1]) {
      declineCount++;
    } else {
      break;
    }
  }

  return declineCount;
}

function getISOWeek(d: Date): string {
  const year = d.getFullYear();
  const jan1 = new Date(year, 0, 1);
  const dayOfYear = Math.floor((d.getTime() - jan1.getTime()) / 86400000) + 1;
  const weekNum = Math.ceil(dayOfYear / 7);
  return `${year}-W${String(weekNum).padStart(2, '0')}`;
}

// ── Insights Generator ───────────────────────────────────────────────────────

function generateInsights(result: Omit<EconomyResult, 'insights'>): string[] {
  const insights: string[] = [];

  if (result.easyRunTrend) {
    const trend = result.easyRunTrend;
    if (trend.trend === 'improving') {
      insights.push(`Your running economy improved ${trend.improvementPct.toFixed(1)}% — you're producing more speed for less cardiac effort.`);
    } else if (trend.trend === 'declining') {
      insights.push(`Your running economy declined ${Math.abs(trend.improvementPct).toFixed(1)}% recently. Consider more recovery or reducing training intensity.`);
    } else {
      insights.push('Your running economy is stable. Consistent training is maintaining your aerobic efficiency.');
    }
  }

  if (result.pctFromPB !== null && result.pctFromPB > 0) {
    if (result.pctFromPB <= 3) {
      insights.push(`You're within ${result.pctFromPB.toFixed(1)}% of your peak economy — excellent form.`);
    } else if (result.pctFromPB <= 8) {
      insights.push(`You're ${result.pctFromPB.toFixed(1)}% below your peak economy. Steady easy-paced volume should close this gap.`);
    } else {
      insights.push(`You're ${result.pctFromPB.toFixed(1)}% below your peak economy. This may reflect a base-building phase or return from a break.`);
    }
  }

  if (result.declineWeeks >= 2) {
    insights.push(`⚠ Economy has declined for ${result.declineWeeks} consecutive weeks — an early overtraining signal. Prioritize recovery and easy running.`);
  }

  if (result.dataPoints.length < 10) {
    insights.push('More HR data is needed for reliable economy trends. Keep running with your HR monitor!');
  }

  return insights;
}

// ── Main Builder ─────────────────────────────────────────────────────────────

/**
 * Build a complete running economy analysis from Strava activities.
 */
export function analyzeRunningEconomy(activities: StravaActivity[]): EconomyResult {
  const dataPoints = activitiesToEconomyPoints(activities);
  const easyRuns = dataPoints.filter((p) => p.runType === 'easy');

  // Trends
  const easyRunTrend = calculateEconomyTrend(easyRuns);
  const allRunTrend = calculateEconomyTrend(dataPoints);

  // Current economy (last 7 days)
  const now = new Date();
  const sevenDaysAgo = new Date(now);
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  const recentStr = sevenDaysAgo.toISOString().slice(0, 10);
  const recentPoints = easyRuns.filter((p) => p.date >= recentStr);
  const currentEconomy = recentPoints.length > 0
    ? Math.round((recentPoints.reduce((s, p) => s + p.economyIndex, 0) / recentPoints.length) * 100) / 100
    : null;

  // Personal best
  let personalBest: EconomyResult['personalBest'] = null;
  if (easyRuns.length > 0) {
    const best = easyRuns.reduce((prev, curr) => curr.economyIndex > prev.economyIndex ? curr : prev);
    personalBest = { value: best.economyIndex, date: best.date };
  }

  // Comparison to PB
  const pctFromPB = currentEconomy && personalBest && personalBest.value > 0
    ? Math.round(((personalBest.value - currentEconomy) / personalBest.value) * 1000) / 10
    : null;

  // Decline detection
  const declineWeeks = detectDeclineWeeks(easyRuns);

  const partial = {
    dataPoints,
    easyRunTrend,
    allRunTrend,
    currentEconomy,
    personalBest,
    pctFromPB,
    declineWeeks,
  };

  return {
    ...partial,
    insights: generateInsights(partial),
  };
}

// ── Persistence ───────────────────────────────────────────────────────────────

export function cacheEconomy(result: EconomyResult): void {
  persistence.setItem(ECONOMY_KEY, JSON.stringify({
    ...result,
    cachedAt: new Date().toISOString(),
  }));
}

export function getCachedEconomy(): EconomyResult | null {
  try {
    const raw = persistence.getItem(ECONOMY_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
