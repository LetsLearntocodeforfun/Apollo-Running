/**
 * Smart Auto-Sync: pulls activities from every connected source (intervals.icu,
 * Strava), matches each day of the active training plan to the athlete's actual
 * activity, auto-completes workouts, and generates intelligent feedback with
 * pace analysis, distance comparison, and weekly mileage tracking.
 *
 * Run days are matched by runs; cross-training days prefer rides, swims and
 * other cross-training (Zwift included), falling back to a run.
 *
 * v1.0.6 — flexible matching (Top-10 #8): each run fills the best unfilled
 * planned run within ±2 days in the same plan week (date proximity, distance
 * similarity, long ↔ longest), so a long run done a day late still counts and a
 * run on a rest day can make up a nearby missed workout. An activity fills at
 * most one plan day; extra runs still count toward weekly mileage. Matching
 * reads the *effective* plan (overlay applied) and uses DST-safe date keys.
 */

import type { Activity } from './activity/types';
import { isRunActivity as isRunActivityShared, getSportCategory, getSportLabel } from './activity/sports';
import {
  isActivitySourceConnected,
  syncActivities,
  getStoredActivities,
  type LiveActivitySource,
  type SyncProgress,
  type SyncSummary,
} from './activitySource';
import { getPlanById, getWorkoutKind, type TrainingPlan, type PlanDay } from '../data/plans';
import {
  getActivePlan,
  getDateKeyForDay,
  getWeekDayForDate,
  isDayCompleted,
  makePlanInstanceId,
  setDayCompleted,
  getSyncMeta,
  setSyncMeta,
  removeSyncMeta,
  setLastSyncTime,
  getAllSyncMeta,
  type SyncMeta,
} from './planProgress';
import { getEffectivePlan } from './planOverlay';
import { persistence } from './db/persistence';
import { addDays, dateKeyFromLocalIso, daysBetween, todayKey } from '../utils/localDate';
import { buildHRDataFromActivity, getHRProfile, upsertActivityHR } from './heartRate';
import { calculateRacePrediction, calculateTrainingAdherence } from './racePrediction';
import { generateCurrentWeekReadiness } from './weeklyReadiness';
import { generateDailyRecap } from './dailyRecap';
import { analyzeTrainingProgress, expireStaleRecommendations } from './adaptiveTraining';
import { processActivityEffort } from './effortService';
import { formatMiles, formatPaceFromMinPerMi, metersToMiles, calcPaceMinPerMi, formatDistanceShort } from './unitPreferences';
import { analyzeCompliance, saveComplianceResult } from './complianceAnalysis';
import { estimateActivityLoad, formatHoursMinutes } from './crossTraining';
import { syncPlanCalendarIfChanged } from './planCalendarSync';
import { syncWellness } from './wellness';

/** Result of a single auto-sync match */
export interface SyncResult {
  weekIndex: number;
  dayIndex: number;
  plannedDay: PlanDay;
  activity: Activity;
  actualDistanceMi: number;
  actualPaceMinPerMi: number;
  feedback: string;
  weeklyMileage: WeeklyMileage;
  isNew: boolean; // true if this was newly synced (not already completed)
  /** True when a cross-training activity (ride, swim…) fulfilled the plan day */
  isCrossTraining: boolean;
}

/** Outcome of a full sync pass: source import summary + plan-day matches. */
export interface AutoSyncReport {
  summary: SyncSummary | null;
  results: SyncResult[];
}

export interface WeeklyMileage {
  weekIndex: number;
  plannedMi: number;
  actualMi: number;
  status: 'on_track' | 'ahead' | 'behind' | 'way_behind';
  message: string;
}

/** Cross-training shorter than this doesn't count toward a plan day. */
const MIN_CROSS_TRAINING_SEC = 10 * 60;
/** Effort recognition only re-processes recent runs (older ones were handled before). */
const EFFORT_WINDOW_DAYS = 14;
/** A run may fill a planned workout up to this many days away (same plan week). */
export const MATCH_WINDOW_DAYS = 2;
/** Per-instance weekly run totals from ALL runs (matched or extra). */
const WEEK_ACTUALS_KEY = 'apollo_plan_week_actuals';

export function isRunActivity(activity: Activity): boolean {
  return isRunActivityShared(activity);
}

/** Format pace as "M:SS/mi" (hardcoded unit — for internal feedback strings). */
export function formatPaceMinPerMi(paceMinPerMi: number): string {
  if (!paceMinPerMi) return '—';
  const totalSec = Math.round(paceMinPerMi * 60);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${sec.toString().padStart(2, '0')}/mi`;
}

/** Get the local date string (YYYY-MM-DD) of an activity (never via `new Date()`: the field has a fake Z). */
function getActivityDateKey(activity: Activity): string {
  return dateKeyFromLocalIso(activity.start_date_local) ?? String(activity.start_date_local ?? '').slice(0, 10);
}

// ── Weekly mileage ──────────────────────────────────────────────────────────

interface WeekActualsStore {
  instanceId: string;
  /** weekIndex → run miles from every run in that plan week. */
  weeks: Record<string, number>;
  updatedAt: string;
}

function readWeekActuals(): WeekActualsStore | null {
  try {
    const raw = persistence.getItem(WEEK_ACTUALS_KEY);
    const parsed = raw ? (JSON.parse(raw) as WeekActualsStore) : null;
    return parsed && typeof parsed.instanceId === 'string' && parsed.weeks && typeof parsed.weeks === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/** Calculate planned weekly mileage for a given week */
function getPlannedWeeklyMileage(plan: TrainingPlan, weekIndex: number): number {
  const week = plan.weeks[weekIndex];
  if (!week) return 0;
  return week.days.reduce((sum, day) => sum + (day.distanceMi ?? 0), 0);
}

/**
 * Actual weekly run mileage: every run in the plan week (including runs that
 * didn't fill a plan day) when the last sync recorded totals for this plan
 * instance; otherwise the sum of matched days.
 */
function getActualWeeklyMileage(planId: string, weekIndex: number): number {
  const active = getActivePlan();
  if (active && active.planId === planId) {
    const store = readWeekActuals();
    if (store && store.instanceId === makePlanInstanceId(active.planId, active.startDate)) {
      return store.weeks[String(weekIndex)] ?? 0;
    }
  }
  const allMeta = getAllSyncMeta(planId);
  return allMeta
    .filter((m) => m.weekIndex === weekIndex)
    .reduce((sum, m) => sum + m.meta.actualDistanceMi, 0);
}

/** Build weekly mileage analysis */
function buildWeeklyMileage(plan: TrainingPlan, planId: string, weekIndex: number): WeeklyMileage {
  const plannedMi = Math.round(getPlannedWeeklyMileage(plan, weekIndex) * 10) / 10;
  const actualMi = Math.round(getActualWeeklyMileage(planId, weekIndex) * 100) / 100;
  const ratio = plannedMi > 0 ? actualMi / plannedMi : 1;

  let status: WeeklyMileage['status'];
  let message: string;

  if (ratio >= 0.95) {
    if (ratio > 1.1) {
      status = 'ahead';
      message = `Week ${weekIndex + 1}: ${formatMiles(actualMi)} / ${formatMiles(plannedMi)} — You're ahead of schedule! Great hustle.`;
    } else {
      status = 'on_track';
      message = `Week ${weekIndex + 1}: ${formatMiles(actualMi)} / ${formatMiles(plannedMi)} — Right on pace with the plan!`;
    }
  } else if (ratio >= 0.75) {
    status = 'behind';
    message = `Week ${weekIndex + 1}: ${formatMiles(actualMi)} / ${formatMiles(plannedMi)} — A bit behind, but you can catch up.`;
  } else {
    status = 'way_behind';
    message = `Week ${weekIndex + 1}: ${formatMiles(actualMi)} / ${formatMiles(plannedMi)} — Falling behind this week. Consider an extra easy run.`;
  }

  return { weekIndex, plannedMi, actualMi, status, message };
}

/** Generate smart feedback for a matched run */
function generateFeedback(
  plannedDay: PlanDay,
  _activity: Activity,
  actualMi: number,
  paceMinPerMi: number,
  weeklyMileage: WeeklyMileage
): string {
  const plannedMi = plannedDay.distanceMi ?? 0;
  const distDiff = actualMi - plannedMi;
  const distPct = plannedMi > 0 ? (distDiff / plannedMi) * 100 : 0;
  const paceStr = formatPaceFromMinPerMi(paceMinPerMi);

  const lines: string[] = [];

  // Distance analysis
  if (plannedMi > 0) {
    if (Math.abs(distPct) <= 5) {
      lines.push(`Great job! ${formatMiles(actualMi)} at ${paceStr} — nailed the ${formatMiles(plannedMi)} target!`);
    } else if (distDiff > 0) {
      lines.push(`Nice work! ${formatMiles(actualMi)} at ${paceStr} — ${formatMiles(distDiff)} extra over the ${formatMiles(plannedMi)} plan.`);
    } else {
      lines.push(`Solid effort! ${formatMiles(actualMi)} at ${paceStr} — just ${formatMiles(Math.abs(distDiff))} short of the ${formatMiles(plannedMi)} goal.`);
    }
  } else {
    lines.push(`Logged ${formatMiles(actualMi)} at ${paceStr}. Keep it up!`);
  }

  // Pace analysis based on workout type
  if (plannedDay.note && paceMinPerMi > 0) {
    const kind = getWorkoutKind(plannedDay);
    if (kind === 'easy' && paceMinPerMi < 8.5) {
      lines.push('Your easy pace looks quick — remember, easy days should feel comfortable.');
    } else if (kind === 'tempo') {
      lines.push(`Tempo pace: ${paceStr}. Keep tempo runs at a comfortably hard effort.`);
    } else if (kind === 'speed') {
      lines.push(`Speed session at ${paceStr} avg. Strong interval work!`);
    } else if (kind === 'long') {
      lines.push(`Long run pace: ${paceStr}. Long runs build your endurance foundation.`);
    }
  }

  // Weekly mileage
  lines.push(weeklyMileage.message);

  return lines.join(' ');
}

/** Feedback for a cross-training day fulfilled by a ride, swim, strength session, etc. */
function generateCrossTrainingFeedback(activity: Activity, load: number): string {
  const duration = formatHoursMinutes(activity.moving_time || activity.elapsed_time || 0);
  const dist = activity.distance > 0 ? ` · ${formatDistanceShort(activity.distance)}` : '';
  const watts = activity.average_watts ? ` · ${Math.round(activity.average_watts)} W avg` : '';
  const lines = [`Cross-training logged: ${getSportLabel(activity)} for ${duration}${dist}${watts}.`];
  lines.push(load > 90
    ? 'That was a big session — keep cross-training mostly aerobic so your legs stay fresh for key runs.'
    : 'Nice low-impact aerobic work that builds fitness without the pounding.');
  return lines.join(' ');
}

// ── Flexible matching (pure) ────────────────────────────────────────────────

/** One plan day filled by one activity. */
export interface PlanSlotMatch {
  weekIndex: number;
  dayIndex: number;
  activity: Activity;
  /** Local date of the activity (may differ from the plan day by up to ±2 days). */
  activityDate: string;
}

export interface PlanMatchResult {
  matches: PlanSlotMatch[];
  /** Runs that didn't fill a plan day (still counted in weekly mileage). */
  extras: Activity[];
  /** weekIndex → miles from every run in that plan week. */
  weekRunMiles: Record<number, number>;
}

interface Candidate {
  activity: Activity;
  date: string;
  weekIndex: number;
  isRun: boolean;
  mi: number;
  longestOfWeek: boolean;
}

interface Slot {
  weekIndex: number;
  dayIndex: number;
  date: string;
  day: PlanDay;
  kind: 'run' | 'cross';
  plannedMi: number;
  isLong: boolean;
  isRace: boolean;
}

const DATE_SCORE = [1, 0.6, 0.3];

function pairScore(c: Candidate, s: Slot): number | null {
  const diff = Math.abs(daysBetween(c.date, s.date));
  if (diff > MATCH_WINDOW_DAYS) return null;
  const dateScore = DATE_SCORE[diff] ?? 0;
  if (s.kind === 'cross') {
    // Cross days: cross-training first; a run on the day itself still counts.
    if (c.isRun) return diff === 0 ? 1 : null;
    return 3 * dateScore + 1;
  }
  if (!c.isRun) return null; // rides never fill run days
  if (s.isRace && diff > 0) return null; // races happen on race day
  const sim = s.plannedMi > 0 ? Math.max(0, 1 - Math.abs(c.mi - s.plannedMi) / s.plannedMi) : 0.5;
  if (diff > 0 && s.plannedMi > 0 && sim < 0.3) return null; // too different to stand in for another day
  let score = 3 * dateScore + 2 * sim;
  if (s.isLong && c.longestOfWeek) score += 1.5;
  else if (s.isLong && diff > 0) score -= 0.5;
  if (s.isRace) score += 1;
  return score;
}

/**
 * Pure flexible matcher. Considers activities from the plan start through
 * `today` (and the plan's last day) and every run/race/cross day of `plan`.
 * Each run fills the best unfilled planned run within ±{@link MATCH_WINDOW_DAYS}
 * days in the same plan week; each activity fills at most one day and each day
 * takes at most one activity (greedy by score: date proximity, distance
 * similarity, long run ↔ longest run of the week).
 */
export function matchActivitiesToPlan(
  plan: TrainingPlan,
  startDate: string,
  activities: Activity[],
  today: string = todayKey(),
): PlanMatchResult {
  const totalWeeks = plan.weeks.length;
  const planEnd = getDateKeyForDay(startDate, totalWeeks - 1, 6);
  const lastDay = today < planEnd ? today : planEnd;
  const planStart = getDateKeyForDay(startDate, 0, 0);

  const candidates: Candidate[] = [];
  const weekRunMiles: Record<number, number> = {};
  for (const activity of activities) {
    const date = getActivityDateKey(activity);
    if (!date || date < planStart || date > lastDay) continue;
    const pos = getWeekDayForDate(startDate, totalWeeks, date);
    if (!pos) continue;
    const isRun = isRunActivityShared(activity);
    if (!isRun && (activity.moving_time || activity.elapsed_time || 0) < MIN_CROSS_TRAINING_SEC) continue;
    const mi = isRun ? metersToMiles(activity.distance || 0) : 0;
    if (isRun) weekRunMiles[pos.weekIndex] = (weekRunMiles[pos.weekIndex] ?? 0) + mi;
    candidates.push({ activity, date, weekIndex: pos.weekIndex, isRun, mi, longestOfWeek: false });
  }
  // Longest run of each plan week.
  const longest = new Map<number, Candidate>();
  for (const c of candidates) {
    if (!c.isRun) continue;
    const best = longest.get(c.weekIndex);
    if (!best || c.mi > best.mi) longest.set(c.weekIndex, c);
  }
  for (const c of longest.values()) c.longestOfWeek = true;

  const slots: Slot[] = [];
  plan.weeks.forEach((week, weekIndex) => {
    let longestPlanned = 0;
    for (const d of week.days) if (d && (d.type === 'run') && (d.distanceMi ?? 0) > longestPlanned) longestPlanned = d.distanceMi ?? 0;
    week.days.slice(0, 7).forEach((day, dayIndex) => {
      if (!day || day.type === 'rest') return;
      const kind = day.type === 'cross' ? 'cross' : 'run';
      const plannedMi = day.distanceMi ?? 0;
      slots.push({
        weekIndex,
        dayIndex,
        date: getDateKeyForDay(startDate, weekIndex, dayIndex),
        day,
        kind,
        plannedMi,
        isLong: kind === 'run' && day.type === 'run' && (getWorkoutKind(day) === 'long' || (plannedMi > 0 && plannedMi === longestPlanned && plannedMi >= 10)),
        isRace: day.type === 'race' || day.type === 'marathon',
      });
    });
  });

  const pairs: { c: Candidate; s: Slot; score: number; diff: number }[] = [];
  for (const c of candidates) {
    for (const s of slots) {
      if (s.weekIndex !== c.weekIndex) continue;
      const score = pairScore(c, s);
      if (score !== null) pairs.push({ c, s, score, diff: Math.abs(daysBetween(c.date, s.date)) });
    }
  }
  pairs.sort((a, b) => b.score - a.score || a.diff - b.diff || a.s.date.localeCompare(b.s.date) || b.c.mi - a.c.mi);

  const usedActivities = new Set<Candidate>();
  const filled = new Set<Slot>();
  const matches: PlanSlotMatch[] = [];
  for (const p of pairs) {
    if (usedActivities.has(p.c) || filled.has(p.s)) continue;
    usedActivities.add(p.c);
    filled.add(p.s);
    matches.push({ weekIndex: p.s.weekIndex, dayIndex: p.s.dayIndex, activity: p.c.activity, activityDate: p.c.date });
  }
  matches.sort((a, b) => a.weekIndex - b.weekIndex || a.dayIndex - b.dayIndex);
  const extras = candidates.filter((c) => c.isRun && !usedActivities.has(c)).map((c) => c.activity);
  return { matches, extras, weekRunMiles };
}

/**
 * Match the active plan (effective plan: overlay applied) to the athlete's
 * activities and save the outcome: completions, sync meta, compliance and
 * per-week run totals. Days whose auto-matched activity went away (deleted,
 * hidden or now filling a better-fitting day) lose their sync meta and, when
 * auto-sync had completed them, their completion.
 */
export function syncPlanWithActivities(activities: Activity[], today: string = todayKey()): SyncResult[] {
  const activePlan = getActivePlan();
  if (!activePlan) return [];
  const plan = getEffectivePlan();
  if (!plan) return [];
  const planId = activePlan.planId;
  const { matches, weekRunMiles } = matchActivitiesToPlan(plan, activePlan.startDate, activities, today);

  // Weekly totals first so feedback reflects every run of the week.
  const weeks: Record<string, number> = {};
  for (const [w, mi] of Object.entries(weekRunMiles)) weeks[w] = Math.round(mi * 100) / 100;
  persistence.setItem(WEEK_ACTUALS_KEY, JSON.stringify({
    instanceId: makePlanInstanceId(activePlan.planId, activePlan.startDate),
    weeks,
    updatedAt: new Date().toISOString(),
  } satisfies WeekActualsStore));

  // Drop stale auto-matches.
  const matchedKey = new Set(matches.map((m) => `${m.weekIndex}:${m.dayIndex}:${m.activity.id}`));
  for (const { weekIndex, dayIndex, meta } of getAllSyncMeta(planId)) {
    if (matchedKey.has(`${weekIndex}:${dayIndex}:${meta.activityId}`)) continue;
    const date = getDateKeyForDay(activePlan.startDate, weekIndex, dayIndex);
    if (date > addDays(today, MATCH_WINDOW_DAYS)) continue;
    const refilled = matches.some((m) => m.weekIndex === weekIndex && m.dayIndex === dayIndex);
    if (refilled) continue; // overwritten below
    removeSyncMeta(planId, weekIndex, dayIndex);
    if (meta.autoCompleted) setDayCompleted(planId, weekIndex, dayIndex, false);
  }

  const results: SyncResult[] = [];
  const maxHR = getHRProfile().maxHR;

  for (const match of matches) {
    const { weekIndex, dayIndex, activity, activityDate } = match;
    const plannedDay = plan.weeks[weekIndex]?.days[dayIndex];
    if (!plannedDay) continue;
    const isCross = !isRunActivityShared(activity);

    // Skip if already synced with this exact activity
    const existingMeta = getSyncMeta(planId, weekIndex, dayIndex);
    if (existingMeta?.activityId === activity.id) continue;

    // Auto-complete the day
    const wasAlreadyCompleted = isDayCompleted(planId, weekIndex, dayIndex);
    if (!wasAlreadyCompleted) {
      setDayCompleted(planId, weekIndex, dayIndex, true);
    }
    const autoCompleted = existingMeta ? !!existingMeta.autoCompleted || !wasAlreadyCompleted : !wasAlreadyCompleted;

    const baseMeta = {
      activityId: activity.id,
      activitySource: activity.source ?? 'strava',
      activityType: activity.sport_type || activity.type,
      activityDate,
      movingTimeSec: activity.moving_time,
      syncedAt: new Date().toISOString(),
      autoCompleted,
    };

    if (isCross) {
      const load = estimateActivityLoad(activity, maxHR);
      const meta: SyncMeta = {
        ...baseMeta,
        actualDistanceMi: 0, // cross-training never counts toward running mileage
        actualPaceMinPerMi: 0,
        crossTraining: {
          category: getSportCategory(activity),
          label: getSportLabel(activity),
          distanceMeters: activity.distance || 0,
          trainingLoad: load > 0 ? load : undefined,
          averageWatts: activity.average_watts,
          averageHR: activity.average_heartrate,
        },
        feedback: generateCrossTrainingFeedback(activity, load),
      };
      setSyncMeta(planId, weekIndex, dayIndex, meta);
      results.push({
        weekIndex,
        dayIndex,
        plannedDay,
        activity,
        actualDistanceMi: 0,
        actualPaceMinPerMi: 0,
        feedback: meta.feedback,
        weeklyMileage: buildWeeklyMileage(plan, planId, weekIndex),
        isNew: !wasAlreadyCompleted,
        isCrossTraining: true,
      });
      continue;
    }

    const actualMi = metersToMiles(activity.distance);
    const paceMinPerMi = calcPaceMinPerMi(activity.distance, activity.moving_time);

    // Save sync meta first (needed for weekly mileage calc)
    const meta: SyncMeta = {
      ...baseMeta,
      actualDistanceMi: actualMi,
      actualPaceMinPerMi: paceMinPerMi,
      feedback: '', // will update below
    };
    setSyncMeta(planId, weekIndex, dayIndex, meta);

    // Build weekly mileage after saving meta
    const weeklyMileage = buildWeeklyMileage(plan, planId, weekIndex);
    const feedback = generateFeedback(plannedDay, activity, actualMi, paceMinPerMi, weeklyMileage);

    // Run compliance analysis against VDOT-derived targets
    let complianceFeedback = '';
    if (plannedDay.note) {
      try {
        const compliance = analyzeCompliance(
          plannedDay.note,
          paceMinPerMi,
          actualMi,
          plannedDay.distanceMi ?? 0,
        );
        if (compliance) {
          saveComplianceResult(weekIndex, dayIndex, compliance);
          complianceFeedback = compliance.feedback;
          if (compliance.coachingSuggestion) {
            complianceFeedback += ' ' + compliance.coachingSuggestion;
          }
        }
      } catch { /* non-critical */ }
    }

    // Update meta with feedback (original + compliance)
    meta.feedback = complianceFeedback
      ? feedback + ' ' + complianceFeedback
      : feedback;
    setSyncMeta(planId, weekIndex, dayIndex, meta);

    results.push({
      weekIndex,
      dayIndex,
      plannedDay,
      activity,
      actualDistanceMi: actualMi,
      actualPaceMinPerMi: paceMinPerMi,
      feedback,
      weeklyMileage,
      isNew: !wasAlreadyCompleted,
      isCrossTraining: false,
    });
  }

  return results;
}

/** HR capture, effort recognition and plan-level analysis after new data arrives. */
function runPostSyncAnalysis(activities: Activity[], hasPlan: boolean): void {
  const cutoff = addDays(todayKey(), -EFFORT_WINDOW_DAYS);
  const recentRuns = activities.filter((a) => isRunActivityShared(a) && getActivityDateKey(a) >= cutoff);

  for (const activity of recentRuns) {
    // Capture HR data from recent runs
    if (activity.average_heartrate && activity.average_heartrate > 0) {
      try {
        const hrData = buildHRDataFromActivity(
          activity.id,
          getActivityDateKey(activity),
          activity.average_heartrate,
          activity.max_heartrate ?? 0,
          activity.moving_time,
          activity.average_cadence,
          activity.source ?? 'strava',
        );
        if (hrData) upsertActivityHR(hrData);
      } catch { /* non-critical */ }
    }
    // Process route effort recognitions
    try { processActivityEffort(activity); } catch { /* non-critical */ }
  }

  if (!hasPlan) return;
  // Update race prediction, adherence, readiness, daily recap, and adaptive recommendations
  try { calculateRacePrediction(); } catch { /* non-critical */ }
  try { calculateTrainingAdherence(); } catch { /* non-critical */ }
  try { generateCurrentWeekReadiness(); } catch { /* non-critical */ }
  try { generateDailyRecap(); } catch { /* non-critical */ }
  try { expireStaleRecommendations(); analyzeTrainingProgress(); } catch { /* non-critical */ }
}

const planRefreshListeners = new Set<(results: SyncResult[]) => void>();

/**
 * Subscribe to plan refreshes — fired after every sync, file import and
 * offline re-match, once plan days, predictions, readiness and recaps are
 * up to date — so open pages can re-read plan state. Returns an unsubscribe
 * function.
 */
export function onPlanRefreshed(listener: (results: SyncResult[]) => void): () => void {
  planRefreshListeners.add(listener);
  return () => {
    planRefreshListeners.delete(listener);
  };
}

/**
 * Match the active plan against activities already on this device and refresh
 * plan-level analysis (HR, efforts, predictions, readiness, recaps). Works
 * offline — used after file imports and as the last step of every sync.
 */
export function refreshPlanFromStoredActivities(): SyncResult[] {
  const activities = getStoredActivities();
  let results: SyncResult[] = [];
  try {
    results = syncPlanWithActivities(activities);
  } catch (err) {
    console.warn('[Apollo] Plan matching failed:', err);
  }

  setLastSyncTime(new Date().toISOString());
  runPostSyncAnalysis(activities, !!getActivePlan());
  for (const listener of planRefreshListeners) {
    try { listener(results); } catch { /* listener errors must not break sync */ }
  }
  // Paces may have changed (new race prediction): keep the watch calendar current.
  // No-op unless auto-update is on; cheap when nothing changed; never throws.
  void syncPlanCalendarIfChanged();
  return results;
}

/** Options for {@link runSync}. */
export interface RunSyncOptions {
  /** Re-import the complete history. */
  full?: boolean;
  /** Only sync these sources (source-scoped re-import). */
  sources?: LiveActivitySource[];
  /** Manual retry that includes sources flagged as needing reconnect. */
  force?: boolean;
  onProgress?: (p: SyncProgress) => void;
}

/**
 * Full sync pass: pull new activities from every connected source into the
 * local store (full history on first run), then match the active training plan.
 * Never throws for network problems — inspect `report.summary.errors`.
 */
export async function runSync(opts: RunSyncOptions = {}): Promise<AutoSyncReport> {
  if (!isActivitySourceConnected()) return { summary: null, results: [] };

  let summary: SyncSummary | null = null;
  try {
    // Built as a variable so options newer than this activitySource version pass through untouched.
    const syncOpts = {
      full: opts.full,
      onProgress: opts.onProgress,
      ...(opts.sources ? { sources: opts.sources } : {}),
      ...(opts.force ? { force: true } : {}),
    };
    summary = await syncActivities(syncOpts);
  } catch (err) {
    console.warn('[Apollo] Activity sync failed:', err);
  }

  // Sleep, HRV and resting HR from intervals.icu (no-op when it isn't connected
  // or wellness sync is off). Runs before the plan refresh so the HR profile it
  // updates is current for the analysis.
  try {
    await syncWellness({ full: opts.full });
  } catch (err) {
    console.warn('[Apollo] Wellness sync failed:', err);
  }

  return { summary, results: refreshPlanFromStoredActivities() };
}

/** Main auto-sync (kept for compatibility): sync all sources, return plan-day matches. */
export async function runAutoSync(opts: { full?: boolean } = {}): Promise<SyncResult[]> {
  return (await runSync(opts)).results;
}

/** The plan to summarise: the effective plan for the active plan id, else the base plan. */
function planFor(planId: string): TrainingPlan | null {
  const active = getActivePlan();
  if (active && active.planId === planId) return getEffectivePlan();
  return getPlanById(planId) ?? null;
}

/** Get current weekly mileage summary for a given week */
export function getWeeklyMileageSummary(planId: string, weekIndex: number): WeeklyMileage | null {
  const plan = planFor(planId);
  if (!plan) return null;
  return buildWeeklyMileage(plan, planId, weekIndex);
}

/** Get all weekly mileage summaries for the entire plan */
export function getAllWeeklyMileage(planId: string): WeeklyMileage[] {
  const plan = planFor(planId);
  if (!plan) return [];
  return plan.weeks.map((_, i) => buildWeeklyMileage(plan, planId, i));
}
