/**
 * Cross-training support: rides (incl. Zwift), swims, strength, walks, etc.
 *
 * Running analytics (pace, PRs, race prediction) stay run-only. This module
 * adds the cross-training view: volume per sport, and a TSS-like load estimate
 * so rides and other sessions count toward fatigue / training-load models.
 */

import type { Activity } from './activity/types';
import {
  getSportCategory,
  getSportCategoryLabel,
  getSportCategoryIcon,
  isRunActivity,
  SPORT_CATEGORIES,
  type SportCategory,
} from './activity/sports';

/** Typical TSS per hour at easy/moderate effort, used when no HR or power data exists. */
const TSS_PER_HOUR: Record<SportCategory, number> = {
  run: 60,
  ride: 50,
  swim: 55,
  walk: 25,
  strength: 40,
  other: 40,
};

/**
 * TSS-like training load for any activity:
 *  1. load computed by the source platform (intervals.icu uses power, HR or pace)
 *  2. HR-based estimate (hrTSS ≈ hours × IF² × 100, threshold HR ≈ 89% of max HR)
 *  3. duration × typical load for the sport
 */
export function estimateActivityLoad(a: Activity, maxHR?: number): number {
  if (typeof a.training_load === 'number' && a.training_load > 0) return a.training_load;
  const hours = (a.moving_time || a.elapsed_time || 0) / 3600;
  if (hours <= 0) return 0;
  if (a.average_heartrate && a.average_heartrate > 0 && maxHR && maxHR > 0) {
    const intensity = Math.min(1.15, a.average_heartrate / (maxHR * 0.89));
    return Math.round(hours * intensity * intensity * 100);
  }
  return Math.round(hours * TSS_PER_HOUR[getSportCategory(a)]);
}

/** Non-running activities. */
export function getCrossTrainingActivities(activities: Activity[]): Activity[] {
  return activities.filter((a) => !isRunActivity(a));
}

export interface SportSummary {
  category: SportCategory;
  label: string;
  icon: string;
  count: number;
  movingTimeSec: number;
  distanceMeters: number;
  elevationGain: number;
  trainingLoad: number;
}

function localDay(a: Activity): string {
  return (a.start_date_local || a.start_date || '').slice(0, 10);
}

/**
 * Volume per sport category, sorted by time spent (largest first).
 * `from`/`to` are inclusive local dates (YYYY-MM-DD).
 */
export function summarizeBySport(
  activities: Activity[],
  opts: { from?: string; to?: string; maxHR?: number } = {},
): SportSummary[] {
  const map = new Map<SportCategory, SportSummary>();
  for (const a of activities) {
    const day = localDay(a);
    if (opts.from && day < opts.from) continue;
    if (opts.to && day > opts.to) continue;
    const category = getSportCategory(a);
    const s = map.get(category) ?? {
      category,
      label: getSportCategoryLabel(category),
      icon: getSportCategoryIcon(category),
      count: 0,
      movingTimeSec: 0,
      distanceMeters: 0,
      elevationGain: 0,
      trainingLoad: 0,
    };
    s.count += 1;
    s.movingTimeSec += a.moving_time || 0;
    s.distanceMeters += a.distance || 0;
    s.elevationGain += a.total_elevation_gain ?? 0;
    s.trainingLoad += estimateActivityLoad(a, opts.maxHR);
    map.set(category, s);
  }
  return Array.from(map.values()).sort((x, y) => y.movingTimeSec - x.movingTimeSec);
}

export interface WeeklySportVolume {
  weekStart: string; // YYYY-MM-DD (Monday)
  weekLabel: string; // e.g. "Jan 6"
  /** Hours per sport category. */
  hours: Record<SportCategory, number>;
  runLoad: number;
  crossLoad: number;
}

function toLocalDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Monday-based week start for a local date string. */
export function weekStartOf(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00');
  const day = d.getDay();
  d.setDate(d.getDate() - (day === 0 ? 6 : day - 1));
  return toLocalDate(d);
}

/** Inclusive local date range for the current Monday-based week. */
export function currentWeekRange(now: Date = new Date()): { from: string; to: string } {
  const from = weekStartOf(toLocalDate(now));
  const end = new Date(from + 'T00:00:00');
  end.setDate(end.getDate() + 6);
  return { from, to: toLocalDate(end) };
}

/** Hours per sport and run vs cross-training load for the last `weeks` weeks (oldest first). */
export function weeklySportVolume(activities: Activity[], weeks: number = 12, maxHR?: number): WeeklySportVolume[] {
  const emptyHours = (): Record<SportCategory, number> =>
    Object.fromEntries(SPORT_CATEGORIES.map((c) => [c, 0])) as Record<SportCategory, number>;

  const thisWeek = weekStartOf(toLocalDate(new Date()));
  const first = new Date(thisWeek + 'T00:00:00');
  first.setDate(first.getDate() - (weeks - 1) * 7);

  const result: WeeklySportVolume[] = [];
  const index = new Map<string, WeeklySportVolume>();
  for (let i = 0; i < weeks; i++) {
    const d = new Date(first);
    d.setDate(first.getDate() + i * 7);
    const ws = toLocalDate(d);
    const entry: WeeklySportVolume = {
      weekStart: ws,
      weekLabel: d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
      hours: emptyHours(),
      runLoad: 0,
      crossLoad: 0,
    };
    result.push(entry);
    index.set(ws, entry);
  }

  for (const a of activities) {
    const day = localDay(a);
    if (!day) continue;
    const entry = index.get(weekStartOf(day));
    if (!entry) continue;
    const category = getSportCategory(a);
    entry.hours[category] = Math.round((entry.hours[category] + (a.moving_time || 0) / 3600) * 100) / 100;
    const load = estimateActivityLoad(a, maxHR);
    if (category === 'run') entry.runLoad += load;
    else entry.crossLoad += load;
  }
  return result;
}

/** "1h 05m" / "45m" style duration for cross-training summaries. */
export function formatHoursMinutes(totalSec: number): string {
  const mins = Math.round(totalSec / 60);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
}
