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
 * v1.0.6:
 *   - Day iteration uses local date keys (DST-safe, V14) and the series is
 *     padded with rest days up to today (V16).
 *   - Load precedence: source `training_load` → HR-based (hrTSS) → heuristic (S6).
 *   - Word-boundary workout classification ("trace" is not a race, "15k" is not a 5K).
 *   - Peak week is a rolling 7-calendar-day window (V20).
 *   - The projection can follow planned daily load (plan → race day).
 *
 * Zone wording vs intervals.icu: Apollo calls TSB < −20 "overreaching" and
 * +15…+25 the race window; intervals.icu calls −10…−30 "optimal" and < −30
 * "high risk". Same numbers, different emphasis (see TSB_ZONE_NOTE).
 *
 * References:
 * - Banister, E.W. (1991) "Modeling Elite Athletic Performance"
 * - Coggan, A. "Training Peaks TSS Model"
 * - Allen, H. & Coggan, A. "Training and Racing with a Power Meter"
 */

import type { StravaActivity } from './strava';
import { isRunActivity } from './activity/sports';
import { estimateActivityLoad } from './crossTraining';
import {
  calculateFitnessFatigue,
  estimateTSS,
  type DailyTrainingLoad,
  type FitnessFatigueSnapshot,
} from './taperOptimizer';
import { persistence } from './db/persistence';
import { addDays, daysBetween, todayKey, dateKeyFromLocalIso, isDateKey } from '../utils/localDate';
import { formatMiles } from './unitPreferences';

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
  /** Daily TSS assumed for this projected day. */
  dailyTSS?: number;
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
  /** Calendar days of history behind the current values (0 when empty). */
  historyDays?: number;
  /** What drove the projection: the plan, the recent average, or nothing. */
  projectionSource?: 'plan' | 'recent-average' | 'none';
}

/** Planned (or assumed) training stress for one future day. */
export interface PlannedDailyLoad {
  date: string;
  tss: number;
}

/** Options for {@link buildPMC}. All optional. */
export interface PMCOptions {
  /** Local date key treated as today (default: the real today). History is padded with rest days up to it. */
  today?: string;
  /** Count rides, swims, strength etc. using their source-reported or estimated load (default false). */
  includeCrossTraining?: boolean;
  /** Max HR for the HR-based load fallback. Omit or null to skip HR-based load. */
  maxHR?: number | null;
  /** Planned TSS per future day. When given, the projection follows it instead of the recent average. */
  plannedLoads?: PlannedDailyLoad[];
}

// ── Constants ─────────────────────────────────────────────────────────────────

const PMC_CACHE_KEY = 'apollo_pmc_cache';

// TSB zone boundaries
const TSB_OVERREACHING = -20;
const TSB_PRODUCTIVE_MAX = 0;
const TSB_FRESH_MAX = 15;
const TSB_PEAK_MAX = 25;
const TSB_DETRAINED = 30;

/** Race-day TSB window (+15…+25). */
export const RACE_WINDOW_TSB: readonly [number, number] = [TSB_FRESH_MAX, TSB_PEAK_MAX];

/** One-line note shown next to the chart legend. */
export const TSB_ZONE_NOTE =
  'Zones differ from intervals.icu: Apollo flags overreaching below −20 (intervals.icu: high risk below −30, optimal −10 to −30) and treats +15 to +25 as the race window.';

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

const RACE_RE = /\b(race|parkrun|half[- ]?marathon|marathon(?!\s*pace)|(5|10)\s?k)\b/i;
const NOT_A_RACE_RE = /\b(easy|recovery|shake ?out|warm ?up|cool ?down|training|workout|pace run)\b/i;
const TEMPO_RE = /\b(tempo|threshold|lt|cruise)\b/i;
const INTERVAL_RE = /\b(intervals?|speed|repeats?|reps?|fartlek|track|vo2(max)?)\b|\b\d+\s?x\s?\d+/i;
const LONG_RE = /\blong( run)?\b/i;
const EASY_RE = /\b(recovery|shake ?out|easy|jog)\b/i;

/** Optional athlete context for pace-based classification. */
export interface WorkoutClassifyContext {
  /** The athlete's typical (median) run pace in min/mi. Enables a relative tempo rule. */
  typicalPaceMinPerMi?: number;
}

/**
 * Classify workout type from an activity name, distance and pace.
 * Name keywords use word boundaries ("trace" is not a race, "15k" is not a 5K).
 * With `ctx.typicalPaceMinPerMi` the pace rule is relative to the athlete
 * (≥ 10 % faster than typical = tempo) instead of the absolute sub-7:00/mi rule.
 */
export function classifyWorkoutType(
  activity: StravaActivity,
  ctx: WorkoutClassifyContext = {},
): DailyTrainingLoad['type'] {
  const name = activity.name ?? '';
  const distance = activity.distance / 1609.34; // meters to miles

  // Check name for clues
  const workoutType = (activity as unknown as { workout_type?: number }).workout_type;
  if (workoutType === 1 || (RACE_RE.test(name) && !NOT_A_RACE_RE.test(name))) {
    return 'race';
  }
  if (TEMPO_RE.test(name)) return 'tempo';
  if (INTERVAL_RE.test(name)) return 'interval';
  if (LONG_RE.test(name) || distance >= 13) return 'long_run';
  if (EASY_RE.test(name) || distance < 3) return 'easy';

  // Classify by pace if HR not available
  if (activity.average_speed && activity.average_speed > 0) {
    const paceMinPerMi = 26.8224 / activity.average_speed; // m/s to min/mi
    const typical = ctx.typicalPaceMinPerMi;
    if (typical && typical > 0) {
      if (paceMinPerMi < typical * 0.9) return 'tempo';
    } else if (paceMinPerMi < 7) {
      return 'tempo';  // sub-7 pace suggests quality (no athlete context)
    }
    if (distance >= 10) return 'long_run';
  }

  return 'easy';
}

/** hrTSS ≈ hours × IF² × 100, with threshold HR ≈ 89 % of max HR (IF capped at 1.15). */
function hrTSS(movingTimeSec: number, avgHR: number, maxHR: number): number {
  const hours = movingTimeSec / 3600;
  const intensity = Math.min(1.15, avgHR / (maxHR * 0.89));
  return Math.round(hours * intensity * intensity * 100);
}

/**
 * Training stress for one activity. Precedence (S6):
 *  1. `training_load` reported by the source (intervals.icu, FIT files)
 *  2. HR-based load (needs average HR and a known max HR)
 *  3. Heuristic from distance, duration and workout type (runs) or the
 *     sport's per-hour estimate (cross-training)
 */
export function activityTSS(
  a: StravaActivity,
  maxHR?: number | null,
  ctx: WorkoutClassifyContext = {},
): number {
  if (typeof a.training_load === 'number' && a.training_load > 0) return a.training_load;
  if (!isRunActivity(a)) return estimateActivityLoad(a, maxHR ?? undefined);
  const moving = a.moving_time || a.elapsed_time || 0;
  if (maxHR && maxHR > 0 && a.average_heartrate && a.average_heartrate > 0 && moving > 0) {
    return hrTSS(moving, a.average_heartrate, maxHR);
  }
  return estimateTSS(a.distance / 1609.34, moving / 60, classifyWorkoutType(a, ctx));
}

/** Median pace (min/mi) of runs of at least 2 miles, or undefined. */
function typicalRunPace(runs: StravaActivity[]): number | undefined {
  const paces = runs
    .filter((a) => a.distance >= 3218 && a.moving_time > 0)
    .map((a) => (a.moving_time / 60) / (a.distance / 1609.34))
    .filter((p) => p > 3 && p < 20)
    .sort((x, y) => x - y);
  if (paces.length < 5) return undefined;
  return paces[Math.floor(paces.length / 2)];
}

/**
 * Convert activities to daily training loads for CTL/ATL/TSB calculation.
 * Runs only by default; pass `includeCrossTraining` to add rides, swims,
 * strength etc. using their source-reported (or estimated) training load.
 * Hidden activities are ignored.
 */
export function activitiesToDailyLoads(
  activities: StravaActivity[],
  options: { includeCrossTraining?: boolean; maxHR?: number | null } = {},
): DailyTrainingLoad[] {
  const visible = activities.filter((a) => !a.hidden);
  const runs = visible.filter(isRunActivity);
  const ctx: WorkoutClassifyContext = { typicalPaceMinPerMi: typicalRunPace(runs) };

  // Group by date (sum TSS for multi-run days)
  const dayMap = new Map<string, DailyTrainingLoad>();

  for (const a of runs) {
    const date = dateKeyFromLocalIso(a.start_date_local);
    if (!date) continue;
    const distanceMi = a.distance / 1609.34;
    const type = classifyWorkoutType(a, ctx);
    const tss = activityTSS(a, options.maxHR, ctx);

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

  if (options.includeCrossTraining) {
    for (const a of visible) {
      if (isRunActivity(a)) continue;
      const tss = activityTSS(a, options.maxHR);
      if (tss <= 0) continue;
      const date = dateKeyFromLocalIso(a.start_date_local);
      if (!date) continue;
      const existing = dayMap.get(date);
      if (existing) existing.tss += tss;
      else dayMap.set(date, { date, tss, distanceMi: 0, type: 'easy' });
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
        label: `${formatMiles(load.distanceMi, 0)} long run`,
        type: 'long_run',
      });
    }
    if (load.type === 'race') {
      annotations.push({
        date: load.date,
        label: `Race: ${formatMiles(load.distanceMi, 1)}`,
        type: 'race',
      });
    }
  }

  // Find the peak week: the most distance in any rolling 7-calendar-day window (V20).
  const sorted = loads.filter((l) => isDateKey(l.date)).sort((a, b) => a.date.localeCompare(b.date));
  if (sorted.length > 0) {
    let maxWeekMiles = 0;
    let peakDate = '';
    let windowMiles = 0;
    let lo = 0;
    for (let hi = 0; hi < sorted.length; hi++) {
      windowMiles += sorted[hi].distanceMi;
      while (daysBetween(sorted[lo].date, sorted[hi].date) > 6) {
        windowMiles -= sorted[lo].distanceMi;
        lo++;
      }
      if (windowMiles > maxWeekMiles + 1e-9) {
        maxWeekMiles = windowMiles;
        peakDate = sorted[hi].date;
      }
    }
    if (peakDate && maxWeekMiles > 0 && daysBetween(sorted[0].date, sorted[sorted.length - 1].date) >= 6) {
      annotations.push({
        date: peakDate,
        label: `Peak week: ${formatMiles(maxWeekMiles, 0)}`,
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
 * @param planned - Optional planned TSS per date; days not listed use `avgDailyTSS`
 */
export function projectForward(
  current: FitnessFatigueSnapshot,
  avgDailyTSS: number,
  days: number,
  planned?: ReadonlyMap<string, number>,
): PMCProjection[] {
  const projections: PMCProjection[] = [];
  let ctl = current.ctl;
  let atl = current.atl;
  if (!isDateKey(current.date)) return projections;

  for (let d = 1; d <= days; d++) {
    const dateStr = addDays(current.date, d);
    const tssToday = planned?.get(dateStr) ?? avgDailyTSS;

    ctl = ctl + CTL_DECAY * (tssToday - ctl);
    atl = atl + ATL_DECAY * (tssToday - atl);
    const tsb = ctl - atl;

    projections.push({
      date: dateStr,
      ctl: Math.round(ctl * 10) / 10,
      atl: Math.round(atl * 10) / 10,
      tsb: Math.round(tsb * 10) / 10,
      zone: classifyTSBZone(tsb),
      dailyTSS: Math.round(tssToday),
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

/** Text label for a readiness score. */
export function readinessLabel(score: number): string {
  if (score >= 85) return 'Peak Race Readiness';
  if (score >= 70) return 'Fresh & Ready';
  if (score >= 50) return 'Productively Fatigued';
  if (score >= 30) return 'Accumulating Fatigue';
  return 'Overreached — Prioritize Recovery';
}

// ── Planned load ─────────────────────────────────────────────────────────────

/** Minimal plan shape needed for a projection (matches data/plans TrainingPlan). */
export interface PlanLike {
  weeks: { days: { type: string; distanceMi?: number; note?: string; label?: string }[] }[];
}

/** Relative TSS per planned mile by workout kind (easy = 1). */
function plannedKindFactor(day: { type: string; note?: string; label?: string }): number {
  const text = `${day.note ?? ''} ${day.label ?? ''}`;
  if (day.type === 'marathon' || day.type === 'race') return 1.5;
  if (/\b(speed|interval|vo2|repeats?|track)\b|\d+\s?x\s?\d+/i.test(text)) return 1.35;
  if (/\b(tempo|threshold|lt)\b/i.test(text)) return 1.25;
  if (/\b(mp|marathon pace|pace)\b/i.test(text)) return 1.15;
  if (/\blong\b/i.test(text)) return 1.05;
  return 1;
}

/**
 * Planned TSS per future day: planned miles × the athlete's TSS per mile
 * (from the last 42 days of history) × a workout-kind factor. Cross days get
 * a flat 30 TSS; rest days 0. Only dates in (`fromKey`, `toKey`] are returned.
 */
export function plannedDailyLoadsFromPlan(
  plan: PlanLike,
  startDate: string,
  fromKey: string,
  toKey: string,
  tssPerMile: number,
): PlannedDailyLoad[] {
  if (!isDateKey(startDate) || !isDateKey(fromKey) || !isDateKey(toKey)) return [];
  const out: PlannedDailyLoad[] = [];
  plan.weeks.forEach((week, w) => {
    week.days.forEach((day, d) => {
      const date = addDays(startDate, w * 7 + d);
      if (date <= fromKey || date > toKey) return;
      let tss = 0;
      if (day.type === 'cross') tss = 30;
      else if (day.type !== 'rest') tss = (day.distanceMi ?? 0) * tssPerMile * plannedKindFactor(day);
      out.push({ date, tss: Math.round(tss) });
    });
  });
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * The athlete's TSS per run mile over the 42 days before `today`
 * (falls back to 6, a typical easy-run value).
 */
export function recentTssPerMile(loads: DailyTrainingLoad[], today: string = todayKey()): number {
  const from = addDays(today, -42);
  let tss = 0;
  let miles = 0;
  for (const l of loads) {
    if (l.date <= from || l.date > today || l.distanceMi <= 0) continue;
    tss += l.tss;
    miles += l.distanceMi;
  }
  return miles >= 10 ? tss / miles : 6;
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
 * Build a complete PMC result from activities.
 *
 * @param activities - Activities (runs only unless `options.includeCrossTraining`)
 * @param projectionDays - Days to project forward from today (e.g., until race day)
 * @param options - Today, cross-training, max HR and planned load (see {@link PMCOptions})
 */
export function buildPMC(
  activities: StravaActivity[],
  projectionDays: number = 0,
  options: PMCOptions = {},
): PMCResult {
  const today = options.today && isDateKey(options.today) ? options.today : todayKey();
  const dailyLoads = activitiesToDailyLoads(activities, {
    includeCrossTraining: options.includeCrossTraining,
    maxHR: options.maxHR,
  }).filter((l) => l.date <= today);

  // Pad with a zero-load day for today so "current" never goes stale (V16).
  const padded = dailyLoads.length > 0 && dailyLoads[dailyLoads.length - 1].date < today
    ? [...dailyLoads, { date: today, tss: 0, distanceMi: 0, type: 'rest' as const }]
    : dailyLoads;
  const snapshots = calculateFitnessFatigue(padded);

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
  let projectionSource: PMCResult['projectionSource'] = 'none';
  if (projectionDays > 0 && lastSnapshot) {
    // Recent average daily TSS (last 14 calendar days) for days without a plan entry (S7 fallback).
    const from = addDays(today, -14);
    const recentTotal = dailyLoads.filter((l) => l.date > from).reduce((s, l) => s + l.tss, 0);
    const avgDailyTSS = recentTotal / 14;
    const planned = options.plannedLoads && options.plannedLoads.length > 0
      ? new Map(options.plannedLoads.map((p) => [p.date, p.tss] as const))
      : undefined;
    projection = projectForward(lastSnapshot, avgDailyTSS, projectionDays, planned);
    projectionSource = planned ? 'plan' : 'recent-average';
  }

  // Insights
  const insights = generateInsights(dataPoints, current);
  const historyDays = dailyLoads.length > 0 ? daysBetween(dailyLoads[0].date, today) + 1 : 0;

  return { dataPoints, annotations, projection, current, insights, historyDays, projectionSource };
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
