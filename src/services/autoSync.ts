/**
 * Smart Auto-Sync: pulls activities from every connected source (intervals.icu,
 * Strava), matches each day of the active training plan to the athlete's actual
 * activity, auto-completes workouts, and generates intelligent feedback with
 * pace analysis, distance comparison, and weekly mileage tracking.
 *
 * Run days are matched by runs; cross-training days prefer rides, swims and
 * other cross-training (Zwift included), falling back to a run.
 */

import type { Activity } from './activity/types';
import { isRunActivity as isRunActivityShared, getSportCategory, getSportLabel } from './activity/sports';
import {
  isActivitySourceConnected,
  syncActivities,
  getStoredActivities,
  type SyncProgress,
  type SyncSummary,
} from './activitySource';
import { getPlanById, type TrainingPlan, type PlanDay } from '../data/plans';
import {
  getActivePlan,
  getWeekDayForDate,
  isDayCompleted,
  setDayCompleted,
  getSyncMeta,
  setSyncMeta,
  setLastSyncTime,
  getAllSyncMeta,
  type SyncMeta,
} from './planProgress';
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

/** Get the local date string (YYYY-MM-DD) of an activity */
function getActivityDateKey(activity: Activity): string {
  return activity.start_date_local.slice(0, 10);
}

/** Local calendar date as YYYY-MM-DD. */
function toLocalDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Calculate planned weekly mileage for a given week */
function getPlannedWeeklyMileage(plan: TrainingPlan, weekIndex: number): number {
  const week = plan.weeks[weekIndex];
  if (!week) return 0;
  return week.days.reduce((sum, day) => sum + (day.distanceMi ?? 0), 0);
}

/** Calculate actual weekly mileage from sync metadata */
function getActualWeeklyMileage(planId: string, weekIndex: number): number {
  const allMeta = getAllSyncMeta(planId);
  return allMeta
    .filter((m) => m.weekIndex === weekIndex)
    .reduce((sum, m) => sum + m.meta.actualDistanceMi, 0);
}

/** Build weekly mileage analysis */
function buildWeeklyMileage(plan: TrainingPlan, planId: string, weekIndex: number): WeeklyMileage {
  const plannedMi = getPlannedWeeklyMileage(plan, weekIndex);
  const actualMi = getActualWeeklyMileage(planId, weekIndex);
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
    const noteLC = plannedDay.note.toLowerCase();
    if (noteLC === 'easy' && paceMinPerMi < 8.5) {
      lines.push('Your easy pace looks quick — remember, easy days should feel comfortable.');
    } else if (noteLC === 'tempo' && paceMinPerMi > 0) {
      lines.push(`Tempo pace: ${paceStr}. Keep tempo runs at a comfortably hard effort.`);
    } else if (noteLC === 'speed' && paceMinPerMi > 0) {
      lines.push(`Speed session at ${paceStr} avg. Strong interval work!`);
    } else if (noteLC === 'long') {
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

/**
 * Match every day of the active plan (plan start → today) to the athlete's
 * activities. Run days take the longest run of the day. Cross-training days
 * take a run if there was one (so weekly mileage stays accurate), otherwise
 * the longest cross-training session (ride, Zwift, swim, strength…).
 */
function matchPlanToActivities(activities: Activity[]): SyncResult[] {
  const activePlan = getActivePlan();
  if (!activePlan) return [];
  const plan = getPlanById(activePlan.planId);
  if (!plan) return [];

  const today = toLocalDate(new Date());
  const runsByDate = new Map<string, Activity>();
  const crossByDate = new Map<string, Activity>();
  for (const act of activities) {
    const dateKey = getActivityDateKey(act);
    if (dateKey < activePlan.startDate || dateKey > today) continue;
    if (isRunActivityShared(act)) {
      const existing = runsByDate.get(dateKey);
      if (!existing || act.distance > existing.distance) runsByDate.set(dateKey, act);
    } else if ((act.moving_time || act.elapsed_time || 0) >= MIN_CROSS_TRAINING_SEC) {
      const existing = crossByDate.get(dateKey);
      if (!existing || (act.moving_time || 0) > (existing.moving_time || 0)) crossByDate.set(dateKey, act);
    }
  }

  const results: SyncResult[] = [];
  const dateKeys = Array.from(new Set([...runsByDate.keys(), ...crossByDate.keys()])).sort();
  const maxHR = getHRProfile().maxHR;

  for (const dateKey of dateKeys) {
    const pos = getWeekDayForDate(activePlan.startDate, plan.totalWeeks, new Date(dateKey + 'T00:00:00'));
    if (!pos) continue;

    const { weekIndex, dayIndex } = pos;
    const plannedDay = plan.weeks[weekIndex]?.days[dayIndex];
    if (!plannedDay) continue;

    // Only match to run/cross/race/marathon days (not rest)
    if (plannedDay.type === 'rest') continue;

    const run = runsByDate.get(dateKey);
    const activity = run ?? (plannedDay.type === 'cross' ? crossByDate.get(dateKey) : undefined);
    if (!activity) continue;
    const isCross = !isRunActivityShared(activity);

    // Skip if already synced with this exact activity
    const existingMeta = getSyncMeta(plan.id, weekIndex, dayIndex);
    if (existingMeta?.activityId === activity.id) continue;

    // Auto-complete the day
    const wasAlreadyCompleted = isDayCompleted(plan.id, weekIndex, dayIndex);
    if (!wasAlreadyCompleted) {
      setDayCompleted(plan.id, weekIndex, dayIndex, true);
    }

    const baseMeta = {
      activityId: activity.id,
      activitySource: activity.source ?? 'strava',
      activityType: activity.sport_type || activity.type,
      activityDate: dateKey,
      movingTimeSec: activity.moving_time,
      syncedAt: new Date().toISOString(),
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
      setSyncMeta(plan.id, weekIndex, dayIndex, meta);
      results.push({
        weekIndex,
        dayIndex,
        plannedDay,
        activity,
        actualDistanceMi: 0,
        actualPaceMinPerMi: 0,
        feedback: meta.feedback,
        weeklyMileage: buildWeeklyMileage(plan, plan.id, weekIndex),
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
    setSyncMeta(plan.id, weekIndex, dayIndex, meta);

    // Build weekly mileage after saving meta
    const weeklyMileage = buildWeeklyMileage(plan, plan.id, weekIndex);
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
    setSyncMeta(plan.id, weekIndex, dayIndex, meta);

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
  const cutoff = toLocalDate(new Date(Date.now() - EFFORT_WINDOW_DAYS * 24 * 60 * 60 * 1000));
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
    results = matchPlanToActivities(activities);
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

/**
 * Full sync pass: pull new activities from every connected source into the
 * local store (full history on first run), then match the active training plan.
 * Never throws for network problems — inspect `report.summary.errors`.
 */
export async function runSync(
  opts: { full?: boolean; onProgress?: (p: SyncProgress) => void } = {},
): Promise<AutoSyncReport> {
  if (!isActivitySourceConnected()) return { summary: null, results: [] };

  let summary: SyncSummary | null = null;
  try {
    summary = await syncActivities({ full: opts.full, onProgress: opts.onProgress });
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

/** Get current weekly mileage summary for a given week */
export function getWeeklyMileageSummary(planId: string, weekIndex: number): WeeklyMileage | null {
  const plan = getPlanById(planId);
  if (!plan) return null;
  return buildWeeklyMileage(plan, planId, weekIndex);
}

/** Get all weekly mileage summaries for the entire plan */
export function getAllWeeklyMileage(planId: string): WeeklyMileage[] {
  const plan = getPlanById(planId);
  if (!plan) return [];
  return plan.weeks.map((_, i) => buildWeeklyMileage(plan, planId, i));
}
