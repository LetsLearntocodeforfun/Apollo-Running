/**
 * Performance Management Chart (PMC) Service
 *
 * Best-in-class CTL/ATL/TSB modeling for marathon training:
 *   - CTL (Chronic Training Load) — 42-day EWMA = "fitness"
 *   - ATL (Acute Training Load)   — 7-day EWMA = "fatigue"
 *   - TSB (Training Stress Balance) = CTL − ATL = "form"
 *
 * Builds on taperOptimizer's Banister model but adds:
 *   - Activity-to-TSS bridge from Strava/Garmin data
 *   - Interactive chart annotations (events, zones, projections)
 *   - Forward projection based on planned training
 *   - Zone classification and readiness scoring
 *
 * References:
 * - Banister, E.W. (1991) "Modeling Elite Athletic Performance"
 * - Coggan, A. "Training Peaks TSS Model"
 * - Allen, H. & Coggan, A. "Training and Racing with a Power Meter"
 */

import type { StravaActivity } from './strava';
import {
  calculateFitnessFatigue,
  estimateTSS,
  type DailyTrainingLoad,
  type FitnessFatigueSnapshot,
} from './taperOptimizer';
import { persistence } from './db/persistence';

// ── Types ─────────────────────────────────────────────────────────────────────

export type TSBZone = 'overreaching' | 'productive' | 'fresh' | 'peak' | 'transition' | 'detrained';

export interface PMCDataPoint {
  date: string;
  ctl: number;
  atl: number;
  tsb: number;
  zone: TSBZone;
  /** Daily training stress for this date */
  dailyTSS: number;
}

export interface PMCAnnotation {
  date: string;
  label: string;
  type: 'long_run' | 'race' | 'rest_week' | 'milestone' | 'peak_mileage';
}

export interface PMCProjection {
  date: string;
  ctl: number;
  atl: number;
  tsb: number;
  zone: TSBZone;
}

export interface PMCResult {
  /** Historical data points for the chart */
  dataPoints: PMCDataPoint[];
  /** Key event annotations */
  annotations: PMCAnnotation[];
  /** Forward projection (e.g., to race day) */
  projection: PMCProjection[];
  /** Current snapshot (latest data point) */
  current: {
    ctl: number;
    atl: number;
    tsb: number;
    zone: TSBZone;
    readinessScore: number;
    readinessLabel: string;
  } | null;
  /** Summary insights */
  insights: string[];
}

// ── Constants ─────────────────────────────────────────────────────────────────

const PMC_CACHE_KEY = 'apollo_pmc_cache';

// TSB zone boundaries
const TSB_OVERREACHING = -20;
const TSB_PRODUCTIVE_MAX = 0;
const TSB_FRESH_MAX = 15;
const TSB_PEAK_MAX = 25;
const TSB_DETRAINED = 30;

// ── Zone Classification ──────────────────────────────────────────────────────

/**
 * Classify a TSB value into a training zone.
 */
export function classifyTSBZone(tsb: number): TSBZone {
  if (tsb < TSB_OVERREACHING) return 'overreaching';
  if (tsb < TSB_PRODUCTIVE_MAX) return 'productive';
  if (tsb < TSB_FRESH_MAX) return 'fresh';
  if (tsb <= TSB_PEAK_MAX) return 'peak';
  if (tsb <= TSB_DETRAINED) return 'transition';
  return 'detrained';
}

/**
 * Get the display color for a TSB zone.
 */
export function getZoneColor(zone: TSBZone): string {
  const colors: Record<TSBZone, string> = {
    overreaching: '#EF5350',   // red
    productive: '#66BB6A',     // green
    fresh: '#4FC3F7',          // light blue
    peak: '#FFD700',           // gold
    transition: '#FFA726',     // orange
    detrained: '#78909C',      // grey
  };
  return colors[zone];
}

/**
 * Get a human-readable label for a TSB zone.
 */
export function getZoneLabel(zone: TSBZone): string {
  const labels: Record<TSBZone, string> = {
    overreaching: 'Overreaching',
    productive: 'Productive Training',
    fresh: 'Fresh',
    peak: 'Peak Race Readiness',
    transition: 'Transition',
    detrained: 'Detrained',
  };
  return labels[zone];
}

// ── Activity to TSS Conversion ───────────────────────────────────────────────

/**
 * Classify workout type from a Strava activity.
 */
export function classifyWorkoutType(activity: StravaActivity): DailyTrainingLoad['type'] {
  const name = (activity.name ?? '').toLowerCase();
  const distance = activity.distance / 1609.34; // meters to miles

  // Check name for clues
  if (name.includes('race') || name.includes('marathon') || name.includes('5k') || name.includes('10k')) {
    return 'race';
  }
  if (name.includes('tempo') || name.includes('threshold')) return 'tempo';
  if (name.includes('interval') || name.includes('speed') || name.includes('repeat') || name.includes('fartlek')) {
    return 'interval';
  }
  if (name.includes('long run') || distance >= 13) return 'long_run';
  if (name.includes('recovery') || name.includes('shake') || distance < 3) return 'easy';

  // Classify by pace if HR not available
  if (activity.average_speed && activity.average_speed > 0) {
    const paceMinPerMi = 26.8224 / activity.average_speed; // m/s to min/mi
    if (paceMinPerMi < 7) return 'tempo';  // sub-7 pace suggests quality
    if (distance >= 10) return 'long_run';
  }

  return 'easy';
}

/**
 * Convert Strava activities to daily training loads for CTL/ATL/TSB calculation.
 */
export function activitiesToDailyLoads(activities: StravaActivity[]): DailyTrainingLoad[] {
  const runTypes = ['Run', 'VirtualRun', 'TrailRun'];
  const runs = activities.filter(
    (a) => runTypes.includes(a.type) || runTypes.includes(a.sport_type),
  );

  // Group by date (sum TSS for multi-run days)
  const dayMap = new Map<string, DailyTrainingLoad>();

  for (const a of runs) {
    const date = a.start_date_local.slice(0, 10);
    const distanceMi = a.distance / 1609.34;
    const durationMin = a.moving_time / 60;
    const type = classifyWorkoutType(a);
    const tss = estimateTSS(distanceMi, durationMin, type);

    const existing = dayMap.get(date);
    if (existing) {
      existing.tss += tss;
      existing.distanceMi += distanceMi;
      // Keep the "harder" type
      const typeRank = { rest: 0, easy: 1, long_run: 2, tempo: 3, interval: 4, race: 5 };
      if ((typeRank[type] ?? 0) > (typeRank[existing.type] ?? 0)) {
        existing.type = type;
      }
    } else {
      dayMap.set(date, { date, tss, distanceMi, type });
    }
  }

  return Array.from(dayMap.values()).sort((a, b) => a.date.localeCompare(b.date));
}

// ── Annotations ──────────────────────────────────────────────────────────────

/**
 * Generate event annotations from activity data for the PMC chart.
 */
export function generateAnnotations(loads: DailyTrainingLoad[]): PMCAnnotation[] {
  const annotations: PMCAnnotation[] = [];

  // Find long runs (≥ 16 mi)
  for (const load of loads) {
    if (load.distanceMi >= 16) {
      annotations.push({
        date: load.date,
        label: `${Math.round(load.distanceMi)} mi long run`,
        type: 'long_run',
      });
    }
    if (load.type === 'race') {
      annotations.push({
        date: load.date,
        label: `Race: ${Math.round(load.distanceMi)} mi`,
        type: 'race',
      });
    }
  }

  // Find peak mileage week
  if (loads.length >= 7) {
    let maxWeekMiles = 0;
    let peakDate = '';
    for (let i = 6; i < loads.length; i++) {
      const weekMiles = loads.slice(i - 6, i + 1).reduce((s, l) => s + l.distanceMi, 0);
      if (weekMiles > maxWeekMiles) {
        maxWeekMiles = weekMiles;
        peakDate = loads[i].date;
      }
    }
    if (peakDate) {
      annotations.push({
        date: peakDate,
        label: `Peak week: ${Math.round(maxWeekMiles)} mi`,
        type: 'peak_mileage',
      });
    }
  }

  return annotations;
}

// ── Forward Projection ───────────────────────────────────────────────────────

const CTL_DAYS = 42;
const ATL_DAYS = 7;
const CTL_DECAY = 1 - Math.exp(-1 / CTL_DAYS);
const ATL_DECAY = 1 - Math.exp(-1 / ATL_DAYS);

/**
 * Project CTL/ATL/TSB forward from a current snapshot.
 *
 * @param current - Latest fitness/fatigue snapshot
 * @param avgDailyTSS - Expected average daily TSS going forward
 * @param days - Number of days to project
 */
export function projectForward(
  current: FitnessFatigueSnapshot,
  avgDailyTSS: number,
  days: number,
): PMCProjection[] {
  const projections: PMCProjection[] = [];
  let ctl = current.ctl;
  let atl = current.atl;

  const startDate = new Date(current.date);

  for (let d = 1; d <= days; d++) {
    const date = new Date(startDate);
    date.setDate(date.getDate() + d);
    const dateStr = date.toISOString().slice(0, 10);

    ctl = ctl + CTL_DECAY * (avgDailyTSS - ctl);
    atl = atl + ATL_DECAY * (avgDailyTSS - atl);
    const tsb = ctl - atl;

    projections.push({
      date: dateStr,
      ctl: Math.round(ctl * 10) / 10,
      atl: Math.round(atl * 10) / 10,
      tsb: Math.round(tsb * 10) / 10,
      zone: classifyTSBZone(tsb),
    });
  }

  return projections;
}

// ── Readiness Score ──────────────────────────────────────────────────────────

/**
 * Convert TSB to a 0-100 readiness score for UI display.
 * Peak readiness at TSB 15-25, falls off outside that range.
 */
export function tsbToReadinessScore(tsb: number, ctl: number): number {
  // Base readiness from TSB
  let score: number;

  if (tsb >= 15 && tsb <= 25) {
    // Peak zone: 85-100
    score = 85 + ((tsb - 15) / 10) * 15;
  } else if (tsb >= 0 && tsb < 15) {
    // Fresh zone: 60-85
    score = 60 + (tsb / 15) * 25;
  } else if (tsb >= -20 && tsb < 0) {
    // Productive/mild fatigue: 30-60
    score = 30 + ((tsb + 20) / 20) * 30;
  } else if (tsb < -20) {
    // Overreaching: 0-30
    score = Math.max(0, 30 + (tsb + 20) * 1.5);
  } else {
    // Detrained (TSB > 25): decreasing score
    score = Math.max(40, 100 - (tsb - 25) * 3);
  }

  // CTL modifier: higher fitness = better readiness at the same TSB
  const ctlBonus = Math.min(10, ctl / 10);
  score = Math.min(100, score + ctlBonus);

  return Math.round(Math.max(0, Math.min(100, score)));
}

function readinessLabel(score: number): string {
  if (score >= 85) return 'Peak Race Readiness';
  if (score >= 70) return 'Fresh & Ready';
  if (score >= 50) return 'Productively Fatigued';
  if (score >= 30) return 'Accumulating Fatigue';
  return 'Overreached — Prioritize Recovery';
}

// ── Insights Generator ───────────────────────────────────────────────────────

function generateInsights(
  dataPoints: PMCDataPoint[],
  current: PMCResult['current'],
): string[] {
  const insights: string[] = [];
  if (!current || dataPoints.length < 14) return insights;

  // Fitness trend (last 14 days)
  const recent = dataPoints.slice(-14);
  const ctlStart = recent[0].ctl;
  const ctlEnd = recent[recent.length - 1].ctl;
  const ctlChange = ctlEnd - ctlStart;

  if (ctlChange > 3) {
    insights.push(`Your fitness (CTL) increased ${ctlChange.toFixed(0)} points in the last 2 weeks — solid training load.`);
  } else if (ctlChange < -3) {
    insights.push(`Your fitness (CTL) decreased ${Math.abs(ctlChange).toFixed(0)} points recently. This is expected during a taper or recovery week.`);
  }

  // Current zone advice
  switch (current.zone) {
    case 'overreaching':
      insights.push('You\'re in the overreaching zone. Consider an easy day or rest day to prevent overtraining.');
      break;
    case 'productive':
      insights.push('You\'re in the productive training zone — fatigue is present but manageable. Keep it up.');
      break;
    case 'peak':
      insights.push('You\'re in the peak readiness zone (TSB +15 to +25). This is the ideal window for racing.');
      break;
    case 'detrained':
      insights.push('Extended rest has moved you into the detrained zone. Gradually rebuild volume.');
      break;
  }

  // Days in current zone
  const currentZone = current.zone;
  let daysInZone = 0;
  for (let i = dataPoints.length - 1; i >= 0; i--) {
    if (dataPoints[i].zone === currentZone) daysInZone++;
    else break;
  }
  if (daysInZone >= 7) {
    insights.push(`You've been in the ${getZoneLabel(currentZone)} zone for ${daysInZone} days.`);
  }

  return insights;
}

// ── Main PMC Builder ─────────────────────────────────────────────────────────

/**
 * Build a complete PMC result from Strava activities.
 *
 * @param activities - Strava activities (will be filtered to runs only)
 * @param projectionDays - Days to project forward (e.g., until race day)
 */
export function buildPMC(
  activities: StravaActivity[],
  projectionDays: number = 0,
): PMCResult {
  const dailyLoads = activitiesToDailyLoads(activities);
  const snapshots = calculateFitnessFatigue(dailyLoads);

  // Build daily TSS lookup for data points
  const tssMap = new Map<string, number>();
  for (const load of dailyLoads) {
    tssMap.set(load.date, (tssMap.get(load.date) ?? 0) + load.tss);
  }

  // Convert snapshots to PMC data points
  const dataPoints: PMCDataPoint[] = snapshots.map((s) => ({
    date: s.date,
    ctl: s.ctl,
    atl: s.atl,
    tsb: s.tsb,
    zone: classifyTSBZone(s.tsb),
    dailyTSS: tssMap.get(s.date) ?? 0,
  }));

  // Annotations
  const annotations = generateAnnotations(dailyLoads);

  // Current state
  const lastSnapshot = snapshots.length > 0 ? snapshots[snapshots.length - 1] : null;
  const current = lastSnapshot
    ? (() => {
        const zone = classifyTSBZone(lastSnapshot.tsb);
        const score = tsbToReadinessScore(lastSnapshot.tsb, lastSnapshot.ctl);
        return {
          ctl: lastSnapshot.ctl,
          atl: lastSnapshot.atl,
          tsb: lastSnapshot.tsb,
          zone,
          readinessScore: score,
          readinessLabel: readinessLabel(score),
        };
      })()
    : null;

  // Forward projection
  let projection: PMCProjection[] = [];
  if (projectionDays > 0 && lastSnapshot) {
    // Use recent average daily TSS (last 14 days) for projection
    const recentLoads = dailyLoads.slice(-14);
    const avgDailyTSS = recentLoads.length > 0
      ? recentLoads.reduce((s, l) => s + l.tss, 0) / 14
      : 0;
    projection = projectForward(lastSnapshot, avgDailyTSS, projectionDays);
  }

  // Insights
  const insights = generateInsights(dataPoints, current);

  return { dataPoints, annotations, projection, current, insights };
}

// ── Persistence ───────────────────────────────────────────────────────────────

export function cachePMC(result: PMCResult): void {
  persistence.setItem(PMC_CACHE_KEY, JSON.stringify({
    ...result,
    cachedAt: new Date().toISOString(),
  }));
}

export function getCachedPMC(): PMCResult | null {
  try {
    const raw = persistence.getItem(PMC_CACHE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
