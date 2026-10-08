// Analytics engine: weekly mileage, pace trends, training load, PRs, HR efficiency.

import { persistence } from './db/persistence';
import type { StravaActivity } from './strava';
import { mergeIntoStore } from './activity/dedupe';
import { isRunActivity } from './activity/sports';
import { estimateActivityLoad } from './crossTraining';
import { detectPersonalRecordsFromEfforts } from './bestEfforts';
import {
  metersToMiles,
  calcPaceMinPerMi,
  formatPaceFromMinPerMi,
  formatMiles,
  formatElevation,
  formatDistanceShort,
} from './unitPreferences';
import {
  addDays,
  daysBetween,
  eachDay,
  isDateKey,
  mondayOf,
  parseDateKey,
  todayKey,
} from '../utils/localDate';

const ANALYTICS_CACHE_KEY = 'apollo_analytics_cache';
const ACTIVITIES_STORE_KEY = 'apollo_activities_store';

// ─── Types ───────────────────────────────────────────────────

export interface WeeklyMileagePoint {
  weekLabel: string;   // e.g. "Jan 6"
  weekStart: string;   // YYYY-MM-DD (Monday)
  /** Run distance in meters — convert with unitPreferences for display. */
  distanceM: number;
  /** Same distance in miles (legacy field; prefer `distanceM`). */
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
  /** `insufficient`: fewer than MIN_CHRONIC_HISTORY_DAYS of history, so the ratio isn't meaningful yet. */
  status: 'optimal' | 'caution' | 'danger' | 'detraining' | 'insufficient';
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

export type WeekCompareKind = 'distance' | 'duration' | 'count' | 'elevation';

export interface WeekCompare {
  label: string;
  kind: WeekCompareKind;
  /** Base units: meters (distance, elevation), seconds (duration) or a count. Format with `formatWeekCompareValue`. */
  current: number;
  previous: number;
  delta: number;      // percentage
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

/** Most activities kept on the device (IndexedDB has ample capacity). */
export const MAX_STORED_ACTIVITIES = 5000;

let storeCache: { raw: string; activities: StravaActivity[]; visible: StravaActivity[] } | null = null;
/** Bumped whenever the parsed store changes (writes, hydration, hide/delete). */
let storeVersion = 0;

/** Outcome of `storeActivities`. */
export interface StoreActivitiesResult {
  added: number;
  updated: number;
  /**
   * Activities that no longer fit under MAX_STORED_ACTIVITIES and were
   * removed from the device by this write (possibly some of those just added).
   * Races and PR-holding runs are never removed; other sports go first.
   */
  dropped: number;
  /** Of `dropped`: runs. */
  droppedRuns: number;
  /** Of `dropped`: rides, swims, strength and other sports. */
  droppedOther: number;
  /** Incoming records skipped because the athlete deleted them on this device. */
  skippedDeleted: number;
}

function setStoreCache(raw: string, activities: StravaActivity[]): void {
  storeCache = { raw, activities, visible: activities.filter((a) => !a.hidden) };
  storeVersion++;
}

/** Monotonic counter that changes whenever the stored activities change (memoization key). */
export function getActivityStoreVersion(): number {
  // Reading refreshes the cache when another code path (e.g. hydration) changed the raw value.
  getAllStoredActivities();
  return storeVersion;
}

/** Name/workout flags that mark a run as a race (never trimmed). */
const RACE_NAME_RE = /\b(race|marathon|half|parkrun|5k|10k|15k|10 ?mi(le)?)\b/i;

function isProtectedFromTrim(a: StravaActivity, prHolders: ReadonlySet<number>): boolean {
  if (prHolders.has(a.id)) return true;
  if (!isRunActivity(a)) return false;
  const workoutType = (a as unknown as { workout_type?: number }).workout_type;
  return workoutType === 1 || RACE_NAME_RE.test(a.name ?? '');
}

/**
 * Pick which records to remove so `list` fits under `cap` (B16):
 * non-run sports first (oldest first), then runs that are neither races nor
 * PR holders (oldest first). Returns the IDs to drop.
 */
export function selectActivitiesToTrim(list: StravaActivity[], cap: number = MAX_STORED_ACTIVITIES): Set<number> {
  const excess = list.length - cap;
  const drop = new Set<number>();
  if (excess <= 0) return drop;
  const prHolders = new Set(detectPersonalRecords(list.filter((a) => !a.hidden)).map((r) => r.activityId));
  const oldestFirst = [...list].sort((a, b) => a.start_date_local.localeCompare(b.start_date_local));
  const tiers: StravaActivity[][] = [
    oldestFirst.filter((a) => !isRunActivity(a) && !prHolders.has(a.id)),
    oldestFirst.filter((a) => isRunActivity(a) && !isProtectedFromTrim(a, prHolders)),
  ];
  for (const tier of tiers) {
    for (const a of tier) {
      if (drop.size >= excess) return drop;
      drop.add(a.id);
    }
  }
  return drop;
}

/**
 * Store activities from any source. Records are merged by ID and the same
 * workout synced from two sources (Strava + intervals.icu) is kept once.
 * Records the athlete deleted (tombstones) are skipped. Returns how many
 * activities were added and updated, and how many were trimmed to stay within
 * MAX_STORED_ACTIVITIES.
 */
export function storeActivities(activities: StravaActivity[]): StoreActivitiesResult {
  const empty: StoreActivitiesResult = { added: 0, updated: 0, dropped: 0, droppedRuns: 0, droppedOther: 0, skippedDeleted: 0 };
  if (activities.length === 0) return empty;
  const { activities: merged, added, updated, skippedDeleted } = mergeIntoStore(getAllStoredActivities(), activities);
  if (added === 0 && updated === 0) return { ...empty, skippedDeleted };
  const dropIds = selectActivitiesToTrim(merged);
  const trimmed = dropIds.size > 0 ? merged.filter((a) => !dropIds.has(a.id)) : merged;
  let droppedRuns = 0;
  for (const a of merged) if (dropIds.has(a.id) && isRunActivity(a)) droppedRuns++;
  const dropped = dropIds.size;
  if (dropped > 0) {
    console.warn(
      `[Apollo] Activity store is full (${MAX_STORED_ACTIVITIES}): removed ${dropped} older ${dropped === 1 ? 'activity' : 'activities'} `
      + `(${dropped - droppedRuns} non-run, ${droppedRuns} runs). Races and PR runs were kept.`,
    );
  }
  writeActivityStore(trimmed);
  return { added, updated, dropped, droppedRuns, droppedOther: dropped - droppedRuns, skippedDeleted };
}

/**
 * Replace the whole store (newest first). Low-level: used by `storeActivities`
 * and by activity management (hide / unhide / delete in activity/manage.ts).
 */
export function writeActivityStore(list: StravaActivity[]): void {
  const raw = JSON.stringify(list);
  persistence.setItem(ACTIVITIES_STORE_KEY, raw);
  setStoreCache(raw, list);
}

/** Every stored activity, INCLUDING hidden ones, newest first (Activities › Hidden, store writes). */
export function getAllStoredActivities(): StravaActivity[] {
  try {
    const raw = persistence.getItem(ACTIVITIES_STORE_KEY);
    if (!raw) {
      if (storeCache) {
        storeCache = null;
        storeVersion++;
      }
      return [];
    }
    if (!storeCache || storeCache.raw !== raw) {
      const parsed = JSON.parse(raw);
      setStoreCache(raw, Array.isArray(parsed) ? parsed : []);
    }
    // Callers may sort/splice the array, so hand out a copy.
    return storeCache!.activities.slice();
  } catch {
    return [];
  }
}

/**
 * Retrieve stored activities (every sport), newest first. Records the athlete
 * hid are omitted, so analytics, PRs, load and plan matching ignore them.
 */
export function getStoredActivities(): StravaActivity[] {
  getAllStoredActivities();
  return storeCache ? storeCache.visible.slice() : [];
}

/** Filter to running activities only (hidden records excluded). */
function filterRuns(activities: StravaActivity[]): StravaActivity[] {
  return activities.filter((a) => isRunActivity(a) && !a.hidden);
}

/** Local calendar date (YYYY-MM-DD) of an activity — `start_date_local` carries a fake "Z", never parse it as a Date. */
function activityDateKey(a: StravaActivity): string {
  return (a.start_date_local ?? '').slice(0, 10);
}

function weekLabel(dateKey: string): string {
  return parseDateKey(dateKey).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function daysAgo(n: number, today: string = todayKey()): string {
  return addDays(today, -n);
}

/**
 * Monday keys of the last `weeks` calendar weeks, oldest first, ending with the
 * current week — so every bucket but the current one is a full Monday–Sunday week (B7).
 */
function recentWeekStarts(weeks: number, today: string = todayKey()): string[] {
  const n = Math.max(1, Math.floor(weeks));
  const thisMonday = mondayOf(today);
  const starts: string[] = [];
  for (let i = n - 1; i >= 0; i--) starts.push(addDays(thisMonday, -7 * i));
  return starts;
}

/** Paces outside (0, 20) min/mi are GPS glitches or walks logged as runs. */
const MAX_SANE_PACE_MIN_PER_MI = 20;

function hasSanePace(a: StravaActivity): boolean {
  const p = calcPaceMinPerMi(a.distance, a.moving_time);
  return p > 0 && p < MAX_SANE_PACE_MIN_PER_MI;
}

/** Distance-weighted pace (Σ time / Σ distance) in min/mi; 0 when there is no distance (B5). */
function weightedPaceMinPerMi(runs: StravaActivity[]): number {
  let meters = 0;
  let seconds = 0;
  for (const a of runs) {
    meters += a.distance || 0;
    seconds += a.moving_time || 0;
  }
  return meters > 0 ? calcPaceMinPerMi(meters, seconds) : 0;
}

/** Treadmill / trainer / virtual runs: speed and HR aren't comparable with outdoor runs. */
function isIndoorRun(a: StravaActivity): boolean {
  const t = a as unknown as { trainer?: boolean; sport_type?: string; type?: string };
  return t.trainer === true || t.sport_type === 'VirtualRun' || t.type === 'VirtualRun';
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
  const today = todayKey();
  const starts = recentWeekStarts(weeks, today);
  const first = starts[0];
  const buckets = new Map<string, { meters: number; seconds: number; count: number }>();
  for (const ws of starts) buckets.set(ws, { meters: 0, seconds: 0, count: 0 });

  for (const a of filterRuns(activities)) {
    const key = activityDateKey(a);
    if (!isDateKey(key) || key < first || key > today) continue;
    const bucket = buckets.get(mondayOf(key));
    if (!bucket) continue;
    bucket.meters += a.distance || 0;
    bucket.seconds += a.moving_time || 0;
    bucket.count += 1;
  }

  return starts.map((ws) => {
    const b = buckets.get(ws)!;
    return {
      weekLabel: weekLabel(ws),
      weekStart: ws,
      distanceM: Math.round(b.meters),
      miles: Math.round(metersToMiles(b.meters) * 10) / 10,
      hours: Math.round((b.seconds / 3600) * 10) / 10,
      runCount: b.count,
    };
  });
}

// ─── Pace Progression ────────────────────────────────────────

export function calculatePaceProgression(activities: StravaActivity[], weeks: number = 12): PaceProgressionPoint[] {
  const today = todayKey();
  const starts = recentWeekStarts(weeks, today);
  const first = starts[0];

  const weekMap = new Map<string, StravaActivity[]>();
  for (const a of filterRuns(activities)) {
    const key = activityDateKey(a);
    if (!isDateKey(key) || key < first || key > today) continue;
    // The outlier filter applies to every series, not just the average.
    if (!hasSanePace(a)) continue;
    const ws = mondayOf(key);
    const arr = weekMap.get(ws);
    if (arr) arr.push(a);
    else weekMap.set(ws, [a]);
  }

  const round2 = (v: number) => Math.round(v * 100) / 100;
  const result: PaceProgressionPoint[] = [];
  for (const ws of starts) {
    const weekRuns = weekMap.get(ws);
    if (!weekRuns || weekRuns.length === 0) continue;

    const avgPace = weightedPaceMinPerMi(weekRuns);
    const fastestPace = Math.min(...weekRuns.map((a) => calcPaceMinPerMi(a.distance, a.moving_time)));

    // Categorize runs by distance
    const easyRuns = weekRuns.filter((a) => metersToMiles(a.distance) < 6 && metersToMiles(a.distance) >= 2);
    const longRuns = weekRuns.filter((a) => metersToMiles(a.distance) >= 10);

    result.push({
      weekLabel: weekLabel(ws),
      weekStart: ws,
      avgPace: round2(avgPace),
      easyPace: easyRuns.length > 0 ? round2(weightedPaceMinPerMi(easyRuns)) : null,
      longRunPace: longRuns.length > 0 ? round2(weightedPaceMinPerMi(longRuns)) : null,
      fastestPace: round2(fastestPace),
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

/**
 * Cross-training sessions have no run pace, so convert their TSS-like load
 * into run-load units: an easy hour of running scores ~8–11 here and ~60–70
 * TSS, hence the divisor.
 */
const TSS_PER_RUN_LOAD_UNIT = 7;

function crossTrainingLoad(a: StravaActivity): number {
  return estimateActivityLoad(a) / TSS_PER_RUN_LOAD_UNIT;
}

export interface TrainingLoadOptions {
  /** Count rides, swims, strength etc. toward load (default true). */
  includeCrossTraining?: boolean;
}

export function calculateTrainingLoad(
  activities: StravaActivity[],
  days: number = 56,
  options: TrainingLoadOptions = {},
): TrainingLoadData[] {
  const includeCross = options.includeCrossTraining ?? true;
  const today = todayKey();
  const cutoff = daysAgo(days, today);
  // Pre-fill 27 days before the cutoff so the first points' 28-day chronic windows are complete (B2).
  const windowStart = addDays(cutoff, -27);

  const dailyLoad = new Map<string, number>();
  let firstKey: string | null = null;
  for (const a of activities) {
    if (a.hidden || !(includeCross || isRunActivity(a))) continue;
    const key = activityDateKey(a);
    if (!isDateKey(key) || key > today) continue;
    if (firstKey === null || key < firstKey) firstKey = key;
    if (key < windowStart) continue;
    const load = isRunActivity(a) ? activityLoad(a) : crossTrainingLoad(a);
    dailyLoad.set(key, (dailyLoad.get(key) ?? 0) + load);
  }

  // Rolling 7- and 28-day sums over calendar keys (DST-safe)
  const daysList = eachDay(windowStart, today);
  const loads = daysList.map((d) => dailyLoad.get(d) ?? 0);
  const result: TrainingLoadData[] = [];
  let acute = 0;
  let chronic = 0;
  for (let i = 0; i < daysList.length; i++) {
    acute += loads[i];
    chronic += loads[i];
    if (i >= 7) acute -= loads[i - 7];
    if (i >= 28) chronic -= loads[i - 28];
    const date = daysList[i];
    if (date < cutoff) continue;

    // Normalize to daily averages
    const acuteAvg = acute / 7;
    const chronicAvg = chronic / 28;
    const ratio = chronicAvg > 0 ? acuteAvg / chronicAvg : 1;
    const historyDays = firstKey ? daysBetween(firstKey, date) + 1 : 0;

    let status: TrainingLoadData['status'];
    if (historyDays < MIN_CHRONIC_HISTORY_DAYS) status = 'insufficient';
    else if (ratio < 0.8) status = 'detraining';
    else if (ratio <= 1.3) status = 'optimal';
    else if (ratio <= 1.5) status = 'caution';
    else status = 'danger';

    result.push({
      date,
      acute: Math.round(acuteAvg * 10) / 10,
      chronic: Math.round(chronicAvg * 10) / 10,
      ratio: Math.round(ratio * 100) / 100,
      status,
    });
  }

  // Return weekly samples to keep data manageable
  return result.filter((_, i) => i % 7 === 0 || i === result.length - 1);
}

/** Days of history the 28-day chronic window needs before the acute:chronic ratio means anything. */
export const MIN_CHRONIC_HISTORY_DAYS = 21;

// ─── Personal Records ────────────────────────────────────────

export function detectPersonalRecords(activities: StravaActivity[]): PersonalRecord[] {
  const runs = filterRuns(activities)
    .sort((a, b) => a.start_date_local.localeCompare(b.start_date_local));

  const records: PersonalRecord[] = [];

  // Best time at each distance: the fastest effort INSIDE a run (splits, interpolated), not a whole
  // run's time bucketed to the nearest distance (B1). Treadmill / virtual runs never set records.
  for (const pr of detectPersonalRecordsFromEfforts(runs)) {
    const timeSec = Math.round(pr.elapsedSec);
    const h = Math.floor(timeSec / 3600);
    const m = Math.floor((timeSec % 3600) / 60);
    const s = timeSec % 60;
    const timeStr = h > 0
      ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
      : `${m}:${String(s).padStart(2, '0')}`;

    records.push({
      category: 'distance_pr',
      label: pr.label,
      value: timeStr,
      numericValue: timeSec,
      date: pr.activity.start_date_local.slice(0, 10),
      activityId: pr.activity.id,
      activityName: pr.activity.name,
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
  const qualifyingRuns = runs.filter(a => a.distance >= 1600 && !isIndoorRun(a));
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
  const today = todayKey();
  const cutoff = daysAgo(days, today);

  const dayMap = new Map<string, { miles: number; count: number }>();
  for (const a of filterRuns(activities)) {
    const dateKey = activityDateKey(a);
    if (!isDateKey(dateKey) || dateKey < cutoff || dateKey > today) continue;
    const existing = dayMap.get(dateKey) || { miles: 0, count: 0 };
    existing.miles += metersToMiles(a.distance);
    existing.count += 1;
    dayMap.set(dateKey, existing);
  }

  // Fill all days (calendar keys — DST-safe)
  return eachDay(cutoff, today).map((ds) => {
    const data = dayMap.get(ds);
    return {
      date: ds,
      miles: data ? Math.round(data.miles * 10) / 10 : 0,
      runCount: data?.count ?? 0,
    };
  });
}

/**
 * Longest and current run streaks (days) plus runs per week. `consistency`
 * ends today: a day without a run *yet* doesn't break the current streak, so it
 * counts back from yesterday until today's run is logged (B8).
 */
export function calculateStreaks(consistency: ConsistencyDay[]): { longest: number; current: number; runsPerWeek: number } {
  let longest = 0;
  let streak = 0;
  let totalRuns = 0;
  for (const day of consistency) {
    totalRuns += day.runCount;
    if (day.runCount > 0) {
      streak++;
      if (streak > longest) longest = streak;
    } else {
      streak = 0;
    }
  }

  let i = consistency.length - 1;
  if (i >= 0 && consistency[i].runCount === 0) i--; // today: rest so far
  let current = 0;
  for (; i >= 0 && consistency[i].runCount > 0; i--) current++;

  const weeks = consistency.length / 7;
  return {
    longest,
    current,
    runsPerWeek: weeks > 0 ? Math.round((totalRuns / weeks) * 10) / 10 : 0,
  };
}

// ─── HR Efficiency ───────────────────────────────────────────

export function calculateHREfficiency(activities: StravaActivity[], days: number = 90): HREfficiencyPoint[] {
  const runs = filterRuns(activities);
  const cutoff = daysAgo(days);

  return runs
    .filter(a => {
      if (activityDateKey(a) < cutoff) return false;
      if (!a.average_heartrate || a.average_heartrate <= 0) return false;
      if (a.distance < 1600) return false;
      // Treadmill/virtual speed isn't comparable with outdoor pace (S6)
      if (isIndoorRun(a) || !hasSanePace(a)) return false;
      return true;
    })
    .map(a => {
      const pace = calcPaceMinPerMi(a.distance, a.moving_time);
      const hr = a.average_heartrate!;
      return {
        date: activityDateKey(a),
        pace: Math.round(pace * 100) / 100,
        avgHR: Math.round(hr),
        efficiency: Math.round((pace / hr) * 10000) / 100,
        activityName: a.name,
      };
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}

// ─── Week-over-Week Comparison ───────────────────────────────

/**
 * This week (Monday → today) vs last week, compared on local calendar keys —
 * `start_date_local` is wall-clock time with a fake "Z", so it is never parsed
 * as a Date (B3). Values are base units; format with `formatWeekCompareValue`.
 */
export function weekOverWeek(activities: StravaActivity[]): WeekCompare[] {
  const today = todayKey();
  const thisMonday = mondayOf(today);
  const lastMonday = addDays(thisMonday, -7);

  const thisWeek: StravaActivity[] = [];
  const lastWeek: StravaActivity[] = [];
  for (const a of filterRuns(activities)) {
    const key = activityDateKey(a);
    if (!isDateKey(key)) continue;
    if (key >= thisMonday && key <= today) thisWeek.push(a);
    else if (key >= lastMonday && key < thisMonday) lastWeek.push(a);
  }

  const sum = (list: StravaActivity[], pick: (a: StravaActivity) => number | undefined) =>
    list.reduce((s, a) => s + (pick(a) || 0), 0);
  const pct = (curr: number, prev: number) => prev > 0 ? Math.round(((curr - prev) / prev) * 100) : 0;

  const thisM = sum(thisWeek, (a) => a.distance);
  const lastM = sum(lastWeek, (a) => a.distance);
  const thisT = sum(thisWeek, (a) => a.moving_time);
  const lastT = sum(lastWeek, (a) => a.moving_time);
  const thisE = sum(thisWeek, (a) => a.total_elevation_gain);
  const lastE = sum(lastWeek, (a) => a.total_elevation_gain);

  return [
    { label: 'Distance', kind: 'distance', current: thisM, previous: lastM, delta: pct(thisM, lastM) },
    { label: 'Time', kind: 'duration', current: thisT, previous: lastT, delta: pct(thisT, lastT) },
    { label: 'Runs', kind: 'count', current: thisWeek.length, previous: lastWeek.length, delta: pct(thisWeek.length, lastWeek.length) },
    { label: 'Elevation', kind: 'elevation', current: thisE, previous: lastE, delta: pct(thisE, lastE) },
  ];
}

/** Display text for a week-over-week value in the athlete's units (e.g. "10.0 km", "1h 05m", "4", "120 m"). */
export function formatWeekCompareValue(kind: WeekCompareKind, value: number): string {
  switch (kind) {
    case 'distance': return formatDistanceShort(value);
    case 'duration': {
      const totalMin = Math.round(value / 60);
      const h = Math.floor(totalMin / 60);
      const m = totalMin % 60;
      return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m} min`;
    }
    case 'elevation': return formatElevation(value);
    default: return String(Math.round(value));
  }
}

// ─── Full Snapshot ───────────────────────────────────────────

/** Compute a complete analytics snapshot. Pure — nothing is written to storage. */
export function generateAnalyticsSnapshot(activities: StravaActivity[]): AnalyticsSnapshot {
  return {
    generatedAt: new Date().toISOString(),
    weeklyMileage: calculateWeeklyMileage(activities),
    paceProgression: calculatePaceProgression(activities),
    trainingLoad: calculateTrainingLoad(activities),
    personalRecords: detectPersonalRecords(activities),
    consistency: calculateConsistency(activities),
    hrEfficiency: calculateHREfficiency(activities),
  };
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

export { filterRuns };
