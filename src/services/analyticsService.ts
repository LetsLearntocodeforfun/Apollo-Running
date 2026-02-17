/**
 * analyticsService.ts — Comprehensive analytics engine for Apollo Running.
 * Calculates weekly mileage trends, pace progression, training load,
 * personal records, HR efficiency, consistency, and race predictions.
 * All data derived from Strava activities stored locally.
 */

import { persistence } from './db/persistence';
import type { StravaActivity } from './strava';
import {
  metersToMiles,
  formatPaceFromMinPerMi,
  formatDuration,
  formatMiles,
  formatElevation,
  unitLabel,
} from './unitPreferences';

const ANALYTICS_CACHE_KEY = 'apollo_analytics_cache';
const ACTIVITIES_STORE_KEY = 'apollo_activities_store';

// ─── Types ───────────────────────────────────────────────────

export interface WeeklyMileagePoint {
  weekLabel: string;   // e.g. "Jan 6"
  weekStart: string;   // YYYY-MM-DD
  miles: number;
  hours: number;
  runCount: number;
  targetMiles?: number;
}

export interface PaceProgressionPoint {
  weekLabel: string;
  weekStart: string;
  avgPace: number;       // min/mi
  easyPace: number | null;
  longRunPace: number | null;
  fastestPace: number;
}

export interface TrainingLoadData {
  date: string;
  acute: number;      // 7-day load
  chronic: number;    // 28-day load
  ratio: number;      // acute/chronic
  status: 'optimal' | 'caution' | 'danger' | 'detraining';
}

export interface PersonalRecord {
  category: string;
  label: string;
  value: string;
  numericValue: number;
  date: string;
  activityId: number;
  activityName: string;
}

export interface ConsistencyDay {
  date: string;
  miles: number;
  runCount: number;
}

export interface HREfficiencyPoint {
  date: string;
  pace: number;       // min/mi
  avgHR: number;
  efficiency: number; // pace/HR ratio (lower = better)
  activityName: string;
}

export interface SummaryStats {
  totalMiles: number;
  totalTime: number;        // seconds
  totalElevation: number;   // meters
  avgPace: number;          // min/mi
  avgHR: number | null;
  runCount: number;
  longestRun: number;       // miles
  fastestPace: number;      // min/mi
  totalCalories: number;
  // Comparisons to previous period
  milesDelta: number | null;     // percentage change
  timeDelta: number | null;
  paceDelta: number | null;      // absolute min/mi change (negative = faster)
}

export interface WeekCompare {
  label: string;
  current: number;
  previous: number;
  delta: number;      // percentage
  unit: string;
}

export interface AnalyticsSnapshot {
  generatedAt: string;
  weeklyMileage: WeeklyMileagePoint[];
  paceProgression: PaceProgressionPoint[];
  trainingLoad: TrainingLoadData[];
  personalRecords: PersonalRecord[];
  consistency: ConsistencyDay[];
  hrEfficiency: HREfficiencyPoint[];
}

// ─── Activity Storage ────────────────────────────────────────

/** Store activities for analytics (deduplicated by ID) */
export function storeActivities(activities: StravaActivity[]): void {
  const existing = getStoredActivities();
  const map = new Map(existing.map(a => [a.id, a]));
  for (const a of activities) {
    map.set(a.id, a);
  }
  const all = Array.from(map.values())
    .sort((a, b) => b.start_date_local.localeCompare(a.start_date_local));
  // Keep max 5000 (IndexedDB has ample capacity)
  const trimmed = all.slice(0, 5000);
  persistence.setItem(ACTIVITIES_STORE_KEY, JSON.stringify(trimmed));
}

/** Retrieve all stored activities */
export function getStoredActivities(): StravaActivity[] {
  try {
    const raw = persistence.getItem(ACTIVITIES_STORE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

/** Filter to running activities only */
function filterRuns(activities: StravaActivity[]): StravaActivity[] {
  const runTypes = ['Run', 'VirtualRun', 'TrailRun'];
  return activities.filter(a =>
    runTypes.includes(a.type) || runTypes.includes(a.sport_type)
  );
}

// ─── Utility ─────────────────────────────────────────────────

/** Calculate pace in min/mi from raw distance/time (internal analytics — always in miles). */
function calcPaceMinPerMi(distMeters: number, timeSec: number): number {
  if (!distMeters || !timeSec) return 0;
  return (timeSec / 60) / metersToMiles(distMeters);
}

/** Format pace as "M:SS" (no unit suffix — used in PRs and internal display). */
function formatPaceShort(paceMinPerMi: number): string {
  if (!paceMinPerMi || paceMinPerMi > 30) return '—';
  const totalSec = Math.round(paceMinPerMi * 60);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${sec.toString().padStart(2, '0')}`;
}

function getWeekStart(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00');
  const day = d.getDay();
  const diff = day === 0 ? 6 : day - 1; // Monday start
  d.setDate(d.getDate() - diff);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

function weekLabel(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

// ─── Summary Stats ───────────────────────────────────────────

/** Calculate summary stats for a period of activities */
export function calculateSummaryStats(
  activities: StravaActivity[],
  previousActivities?: StravaActivity[]
): SummaryStats {
  const runs = filterRuns(activities);
  const totalMiles = runs.reduce((s, a) => s + metersToMiles(a.distance), 0);
  const totalTime = runs.reduce((s, a) => s + a.moving_time, 0);
  const totalElevation = runs.reduce((s, a) => s + (a.total_elevation_gain ?? 0), 0);
  const avgPace = runs.length > 0 ? calcPaceMinPerMi(
    runs.reduce((s, a) => s + a.distance, 0),
    runs.reduce((s, a) => s + a.moving_time, 0)
  ) : 0;
  const hrRuns = runs.filter(a => a.average_heartrate && a.average_heartrate > 0);
  const avgHR = hrRuns.length > 0
    ? Math.round(hrRuns.reduce((s, a) => s + (a.average_heartrate ?? 0), 0) / hrRuns.length)
    : null;
  const longestRun = runs.length > 0 ? Math.max(...runs.map(a => metersToMiles(a.distance))) : 0;
  const fastestPace = runs.length > 0 ? Math.min(...runs.map(a => calcPaceMinPerMi(a.distance, a.moving_time)).filter(p => p > 0)) : 0;
  const totalCalories = runs.reduce((s, a) => {
    const cal = (a as unknown as { calories?: number }).calories;
    return s + (cal ?? 0);
  }, 0);

  let milesDelta: number | null = null;
  let timeDelta: number | null = null;
  let paceDelta: number | null = null;

  if (previousActivities) {
    const prevRuns = filterRuns(previousActivities);
    const prevMiles = prevRuns.reduce((s, a) => s + metersToMiles(a.distance), 0);
    const prevTime = prevRuns.reduce((s, a) => s + a.moving_time, 0);
    const prevPace = prevRuns.length > 0 ? calcPaceMinPerMi(
      prevRuns.reduce((s, a) => s + a.distance, 0),
      prevRuns.reduce((s, a) => s + a.moving_time, 0)
    ) : 0;
    milesDelta = prevMiles > 0 ? ((totalMiles - prevMiles) / prevMiles) * 100 : null;
    timeDelta = prevTime > 0 ? ((totalTime - prevTime) / prevTime) * 100 : null;
    paceDelta = prevPace > 0 && avgPace > 0 ? avgPace - prevPace : null;
  }

  return {
    totalMiles, totalTime, totalElevation, avgPace, avgHR,
    runCount: runs.length, longestRun, fastestPace, totalCalories,
    milesDelta, timeDelta, paceDelta,
  };
}

// ─── Weekly Mileage ──────────────────────────────────────────

export function calculateWeeklyMileage(activities: StravaActivity[], weeks: number = 12): WeeklyMileagePoint[] {
  const runs = filterRuns(activities);
  const cutoff = daysAgo(weeks * 7);
  const filtered = runs.filter(a => a.start_date_local.slice(0, 10) >= cutoff);

  const weekMap = new Map<string, { miles: number; hours: number; count: number }>();

  for (const a of filtered) {
    const ws = getWeekStart(a.start_date_local.slice(0, 10));
    const existing = weekMap.get(ws) || { miles: 0, hours: 0, count: 0 };
    existing.miles += metersToMiles(a.distance);
    existing.hours += a.moving_time / 3600;
    existing.count += 1;
    weekMap.set(ws, existing);
  }

  // Fill in missing weeks
  const result: WeeklyMileagePoint[] = [];
  const startDate = new Date(cutoff + 'T00:00:00');
  const now = new Date();

  const current = new Date(startDate);
  // Align to Monday
  const day = current.getDay();
  const diff = day === 0 ? 6 : day - 1;
  current.setDate(current.getDate() - diff);

  while (current <= now) {
    const ws = `${current.getFullYear()}-${String(current.getMonth() + 1).padStart(2, '0')}-${String(current.getDate()).padStart(2, '0')}`;
    const data = weekMap.get(ws);
    result.push({
      weekLabel: weekLabel(ws),
      weekStart: ws,
      miles: data ? Math.round(data.miles * 10) / 10 : 0,
      hours: data ? Math.round(data.hours * 10) / 10 : 0,
      runCount: data?.count ?? 0,
    });
    current.setDate(current.getDate() + 7);
  }

  return result;
}

// ─── Pace Progression ────────────────────────────────────────

export function calculatePaceProgression(activities: StravaActivity[], weeks: number = 12): PaceProgressionPoint[] {
  const runs = filterRuns(activities);
  const cutoff = daysAgo(weeks * 7);
  const filtered = runs.filter(a => a.start_date_local.slice(0, 10) >= cutoff);

  const weekMap = new Map<string, StravaActivity[]>();
  for (const a of filtered) {
    const ws = getWeekStart(a.start_date_local.slice(0, 10));
    const arr = weekMap.get(ws) || [];
    arr.push(a);
    weekMap.set(ws, arr);
  }

  const result: PaceProgressionPoint[] = [];

  for (const [ws, weekRuns] of Array.from(weekMap.entries()).sort((a, b) => a[0].localeCompare(b[0]))) {
    const paces = weekRuns.map(a => calcPaceMinPerMi(a.distance, a.moving_time)).filter(p => p > 0 && p < 20);
    if (paces.length === 0) continue;

    const avgPace = paces.reduce((s, p) => s + p, 0) / paces.length;
    const fastestPace = Math.min(...paces);

    // Categorize runs by distance
    const easyRuns = weekRuns.filter(a => metersToMiles(a.distance) < 6 && metersToMiles(a.distance) >= 2);
    const longRuns = weekRuns.filter(a => metersToMiles(a.distance) >= 10);

    const easyPace = easyRuns.length > 0
      ? easyRuns.map(a => calcPaceMinPerMi(a.distance, a.moving_time)).reduce((s, p) => s + p, 0) / easyRuns.length
      : null;
    const longRunPace = longRuns.length > 0
      ? longRuns.map(a => calcPaceMinPerMi(a.distance, a.moving_time)).reduce((s, p) => s + p, 0) / longRuns.length
      : null;

    result.push({
      weekLabel: weekLabel(ws),
      weekStart: ws,
      avgPace: Math.round(avgPace * 100) / 100,
      easyPace: easyPace ? Math.round(easyPace * 100) / 100 : null,
      longRunPace: longRunPace ? Math.round(longRunPace * 100) / 100 : null,
      fastestPace: Math.round(fastestPace * 100) / 100,
    });
  }

  return result;
}

// ─── Training Load ───────────────────────────────────────────

/** Training load score for a single activity (distance * intensity proxy) */
function activityLoad(a: StravaActivity): number {
  const miles = metersToMiles(a.distance);
  const pace = calcPaceMinPerMi(a.distance, a.moving_time);
  // Faster pace = higher intensity multiplier
  const intensityMultiplier = pace > 0 ? Math.max(0.5, 12 / pace) : 1;
  return miles * intensityMultiplier;
}

export function calculateTrainingLoad(activities: StravaActivity[], days: number = 56): TrainingLoadData[] {
  const runs = filterRuns(activities);
  const cutoff = daysAgo(days);
  const filtered = runs.filter(a => a.start_date_local.slice(0, 10) >= cutoff)
    .sort((a, b) => a.start_date_local.localeCompare(b.start_date_local));

  // Build daily load map
  const dailyLoad = new Map<string, number>();
  for (const a of filtered) {
    const dateKey = a.start_date_local.slice(0, 10);
    dailyLoad.set(dateKey, (dailyLoad.get(dateKey) ?? 0) + activityLoad(a));
  }

  const result: TrainingLoadData[] = [];
  const start = new Date(cutoff + 'T00:00:00');
  const end = new Date();

  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

    // Acute: last 7 days
    let acute = 0;
    for (let i = 0; i < 7; i++) {
      const dd = new Date(d);
      dd.setDate(dd.getDate() - i);
      const ds = `${dd.getFullYear()}-${String(dd.getMonth() + 1).padStart(2, '0')}-${String(dd.getDate()).padStart(2, '0')}`;
      acute += dailyLoad.get(ds) ?? 0;
    }

    // Chronic: last 28 days
    let chronic = 0;
    for (let i = 0; i < 28; i++) {
      const dd = new Date(d);
      dd.setDate(dd.getDate() - i);
      const ds = `${dd.getFullYear()}-${String(dd.getMonth() + 1).padStart(2, '0')}-${String(dd.getDate()).padStart(2, '0')}`;
      chronic += dailyLoad.get(ds) ?? 0;
    }

    // Normalize to daily averages
    const acuteAvg = acute / 7;
    const chronicAvg = chronic / 28;
    const ratio = chronicAvg > 0 ? acuteAvg / chronicAvg : 1;

    let status: TrainingLoadData['status'];
    if (ratio < 0.8) status = 'detraining';
    else if (ratio <= 1.3) status = 'optimal';
    else if (ratio <= 1.5) status = 'caution';
    else status = 'danger';

    result.push({
      date: dateStr,
      acute: Math.round(acuteAvg * 10) / 10,
      chronic: Math.round(chronicAvg * 10) / 10,
      ratio: Math.round(ratio * 100) / 100,
      status,
    });
  }

  // Return weekly samples to keep data manageable
  return result.filter((_, i) => i % 7 === 0 || i === result.length - 1);
}

// ─── Personal Records ────────────────────────────────────────

/** Common distance thresholds in meters */
const PR_DISTANCES: { label: string; meters: number; tolerance: number }[] = [
  { label: '1 Mile', meters: 1609.34, tolerance: 200 },
  { label: '5K', meters: 5000, tolerance: 300 },
  { label: '10K', meters: 10000, tolerance: 500 },
  { label: '15K', meters: 15000, tolerance: 500 },
  { label: 'Half Marathon', meters: 21097.5, tolerance: 800 },
  { label: '20 Miles', meters: 32186.9, tolerance: 1000 },
  { label: 'Marathon', meters: 42195, tolerance: 1500 },
];

export function detectPersonalRecords(activities: StravaActivity[]): PersonalRecord[] {
  const runs = filterRuns(activities)
    .sort((a, b) => a.start_date_local.localeCompare(b.start_date_local));

  const records: PersonalRecord[] = [];

  // Best time at each distance
  for (const dist of PR_DISTANCES) {
    const matching = runs.filter(a =>
      a.distance >= dist.meters - dist.tolerance &&
      a.distance <= dist.meters + dist.tolerance * 2
    );
    if (matching.length === 0) continue;

    const best = matching.reduce((prev, curr) => {
      const prevPace = calcPaceMinPerMi(prev.distance, prev.moving_time);
      const currPace = calcPaceMinPerMi(curr.distance, curr.moving_time);
      return currPace < prevPace ? curr : prev;
    });

    const timeSec = best.moving_time;
    const h = Math.floor(timeSec / 3600);
    const m = Math.floor((timeSec % 3600) / 60);
    const s = timeSec % 60;
    const timeStr = h > 0
      ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
      : `${m}:${String(s).padStart(2, '0')}`;

    records.push({
      category: 'distance_pr',
      label: dist.label,
      value: timeStr,
      numericValue: timeSec,
      date: best.start_date_local.slice(0, 10),
      activityId: best.id,
      activityName: best.name,
    });
  }

  // Longest run
  if (runs.length > 0) {
    const longest = runs.reduce((prev, curr) => curr.distance > prev.distance ? curr : prev);
    records.push({
      category: 'longest_run',
      label: 'Longest Run',
      value: formatMiles(metersToMiles(longest.distance)),
      numericValue: metersToMiles(longest.distance),
      date: longest.start_date_local.slice(0, 10),
      activityId: longest.id,
      activityName: longest.name,
    });
  }

  // Biggest elevation gain
  const withElevation = runs.filter(a => a.total_elevation_gain && a.total_elevation_gain > 0);
  if (withElevation.length > 0) {
    const biggest = withElevation.reduce((prev, curr) =>
      (curr.total_elevation_gain ?? 0) > (prev.total_elevation_gain ?? 0) ? curr : prev
    );
    records.push({
      category: 'elevation',
      label: 'Most Elevation Gain',
      value: formatElevation(biggest.total_elevation_gain!),
      numericValue: biggest.total_elevation_gain!,
      date: biggest.start_date_local.slice(0, 10),
      activityId: biggest.id,
      activityName: biggest.name,
    });
  }

  // Fastest pace (any run > 1 mile)
  const qualifyingRuns = runs.filter(a => a.distance >= 1600);
  if (qualifyingRuns.length > 0) {
    const fastest = qualifyingRuns.reduce((prev, curr) => {
      const pp = calcPaceMinPerMi(prev.distance, prev.moving_time);
      const cp = calcPaceMinPerMi(curr.distance, curr.moving_time);
      return cp < pp ? curr : prev;
    });
    records.push({
      category: 'fastest_pace',
      label: 'Fastest Pace',
      value: formatPaceFromMinPerMi(calcPaceMinPerMi(fastest.distance, fastest.moving_time)),
      numericValue: calcPaceMinPerMi(fastest.distance, fastest.moving_time),
      date: fastest.start_date_local.slice(0, 10),
      activityId: fastest.id,
      activityName: fastest.name,
    });
  }

  return records;
}

// ─── Consistency Calendar ────────────────────────────────────

export function calculateConsistency(activities: StravaActivity[], days: number = 90): ConsistencyDay[] {
  const runs = filterRuns(activities);
  const cutoff = daysAgo(days);

  const dayMap = new Map<string, { miles: number; count: number }>();
  for (const a of runs) {
    const dateKey = a.start_date_local.slice(0, 10);
    if (dateKey < cutoff) continue;
    const existing = dayMap.get(dateKey) || { miles: 0, count: 0 };
    existing.miles += metersToMiles(a.distance);
    existing.count += 1;
    dayMap.set(dateKey, existing);
  }

  // Fill all days
  const result: ConsistencyDay[] = [];
  const start = new Date(cutoff + 'T00:00:00');
  const end = new Date();
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const ds = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const data = dayMap.get(ds);
    result.push({
      date: ds,
      miles: data ? Math.round(data.miles * 10) / 10 : 0,
      runCount: data?.count ?? 0,
    });
  }

  return result;
}

/** Calculate longest streak and current streak */
export function calculateStreaks(consistency: ConsistencyDay[]): { longest: number; current: number; runsPerWeek: number } {
  let longest = 0;
  let current = 0;
  let streak = 0;
  const totalRunDays = consistency.filter(d => d.runCount > 0).length;
  const weeks = consistency.length / 7;

  for (const day of consistency) {
    if (day.runCount > 0) {
      streak++;
      if (streak > longest) longest = streak;
    } else {
      streak = 0;
    }
  }
  current = streak;

  return {
    longest,
    current,
    runsPerWeek: weeks > 0 ? Math.round((totalRunDays / weeks) * 10) / 10 : 0,
  };
}

// ─── HR Efficiency ───────────────────────────────────────────

export function calculateHREfficiency(activities: StravaActivity[], days: number = 90): HREfficiencyPoint[] {
  const runs = filterRuns(activities);
  const cutoff = daysAgo(days);

  return runs
    .filter(a => {
      if (a.start_date_local.slice(0, 10) < cutoff) return false;
      if (!a.average_heartrate || a.average_heartrate <= 0) return false;
      if (a.distance < 1600) return false;
      return true;
    })
    .map(a => {
      const pace = calcPaceMinPerMi(a.distance, a.moving_time);
      const hr = a.average_heartrate!;
      return {
        date: a.start_date_local.slice(0, 10),
        pace: Math.round(pace * 100) / 100,
        avgHR: Math.round(hr),
        efficiency: Math.round((pace / hr) * 10000) / 100,
        activityName: a.name,
      };
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}

// ─── Week-over-Week Comparison ───────────────────────────────

export function weekOverWeek(activities: StravaActivity[]): WeekCompare[] {
  const now = new Date();
  const thisWeekStart = new Date(now);
  const day = thisWeekStart.getDay();
  const diff = day === 0 ? 6 : day - 1;
  thisWeekStart.setDate(thisWeekStart.getDate() - diff);
  thisWeekStart.setHours(0, 0, 0, 0);

  const lastWeekStart = new Date(thisWeekStart);
  lastWeekStart.setDate(lastWeekStart.getDate() - 7);

  const thisWeekEnd = new Date(now);
  const lastWeekEnd = new Date(thisWeekStart);

  const runs = filterRuns(activities);

  const thisWeek = runs.filter(a => {
    const d = new Date(a.start_date_local);
    return d >= thisWeekStart && d <= thisWeekEnd;
  });
  const lastWeek = runs.filter(a => {
    const d = new Date(a.start_date_local);
    return d >= lastWeekStart && d < lastWeekEnd;
  });

  const thisMiles = thisWeek.reduce((s, a) => s + metersToMiles(a.distance), 0);
  const lastMiles = lastWeek.reduce((s, a) => s + metersToMiles(a.distance), 0);

  const thisTime = thisWeek.reduce((s, a) => s + a.moving_time, 0);
  const lastTime = lastWeek.reduce((s, a) => s + a.moving_time, 0);

  const thisElev = thisWeek.reduce((s, a) => s + (a.total_elevation_gain ?? 0), 0);
  const lastElev = lastWeek.reduce((s, a) => s + (a.total_elevation_gain ?? 0), 0);

  const pct = (curr: number, prev: number) => prev > 0 ? Math.round(((curr - prev) / prev) * 100) : 0;

  return [
    { label: 'Distance', current: Math.round(thisMiles * 10) / 10, previous: Math.round(lastMiles * 10) / 10, delta: pct(thisMiles, lastMiles), unit: unitLabel() },
    { label: 'Time', current: Math.round(thisTime / 60), previous: Math.round(lastTime / 60), delta: pct(thisTime, lastTime), unit: 'min' },
    { label: 'Runs', current: thisWeek.length, previous: lastWeek.length, delta: pct(thisWeek.length, lastWeek.length), unit: '' },
    { label: 'Elevation', current: Math.round(thisElev * 3.28084), previous: Math.round(lastElev * 3.28084), delta: pct(thisElev, lastElev), unit: 'ft' },
  ];
}

// ─── Full Snapshot ───────────────────────────────────────────

/** Generate and cache a complete analytics snapshot */
export function generateAnalyticsSnapshot(activities: StravaActivity[]): AnalyticsSnapshot {
  const snapshot: AnalyticsSnapshot = {
    generatedAt: new Date().toISOString(),
    weeklyMileage: calculateWeeklyMileage(activities),
    paceProgression: calculatePaceProgression(activities),
    trainingLoad: calculateTrainingLoad(activities),
    personalRecords: detectPersonalRecords(activities),
    consistency: calculateConsistency(activities),
    hrEfficiency: calculateHREfficiency(activities),
  };

  try {
    persistence.setItem(ANALYTICS_CACHE_KEY, JSON.stringify(snapshot));
  } catch { /* storage full — non-critical */ }

  return snapshot;
}

/** Load cached snapshot */
export function getCachedSnapshot(): AnalyticsSnapshot | null {
  try {
    const raw = persistence.getItem(ANALYTICS_CACHE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

// ─── Exported formatters ─────────────────────────────────────

export { formatPaceShort, formatDuration, metersToMiles, filterRuns };
