/**
 * Smart Auto-Sync: matches Strava activities to training plan days,
 * auto-completes workouts, and generates intelligent feedback with
 * pace analysis, distance comparison, and weekly mileage tracking.
 */

import { getActivities, type StravaActivity } from './strava';
import { getStravaTokens } from './storage';
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
import { buildHRDataFromStrava, upsertActivityHR } from './heartRate';
import { calculateRacePrediction, calculateTrainingAdherence } from './racePrediction';
import { generateCurrentWeekReadiness } from './weeklyReadiness';
import { generateDailyRecap } from './dailyRecap';

/** Result of a single auto-sync match */
export interface SyncResult {
  weekIndex: number;
  dayIndex: number;
  plannedDay: PlanDay;
  activity: StravaActivity;
  actualDistanceMi: number;
  actualPaceMinPerMi: number;
  feedback: string;
  weeklyMileage: WeeklyMileage;
  isNew: boolean; // true if this was newly synced (not already completed)
}

export interface WeeklyMileage {
  weekIndex: number;
  plannedMi: number;
  actualMi: number;
  status: 'on_track' | 'ahead' | 'behind' | 'way_behind';
  message: string;
}

const METERS_TO_MILES = 0.000621371;

function metersToMiles(m: number): number {
  return m * METERS_TO_MILES;
}

function calcPaceMinPerMi(distanceMeters: number, movingTimeSec: number): number {
  if (!distanceMeters || !movingTimeSec) return 0;
  const miles = metersToMiles(distanceMeters);
  return (movingTimeSec / 60) / miles;
}

function formatPaceMinPerMi(paceMinPerMi: number): string {
  if (!paceMinPerMi) return '—';
  const totalSec = Math.round(paceMinPerMi * 60);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${sec.toString().padStart(2, '0')}/mi`;
}

/** Check if a Strava activity is a running type */
function isRunActivity(activity: StravaActivity): boolean {
  const runTypes = ['Run', 'VirtualRun', 'TrailRun'];
  return runTypes.includes(activity.type) || runTypes.includes(activity.sport_type);
}

/** Get the date string (YYYY-MM-DD) from a Strava activity */
function getActivityDateKey(activity: StravaActivity): string {
  return activity.start_date_local.slice(0, 10);
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
      message = `Week ${weekIndex + 1}: ${actualMi.toFixed(1)} / ${plannedMi.toFixed(1)} mi — You're ahead of schedule! Great hustle.`;
    } else {
      status = 'on_track';
      message = `Week ${weekIndex + 1}: ${actualMi.toFixed(1)} / ${plannedMi.toFixed(1)} mi — Right on pace with the plan!`;
    }
  } else if (ratio >= 0.75) {
    status = 'behind';
    message = `Week ${weekIndex + 1}: ${actualMi.toFixed(1)} / ${plannedMi.toFixed(1)} mi — A bit behind, but you can catch up.`;
  } else {
    status = 'way_behind';
    message = `Week ${weekIndex + 1}: ${actualMi.toFixed(1)} / ${plannedMi.toFixed(1)} mi — Falling behind this week. Consider an extra easy run.`;
  }

  return { weekIndex, plannedMi, actualMi, status, message };
}

/** Generate smart feedback for a matched run */
function generateFeedback(
  plannedDay: PlanDay,
  _activity: StravaActivity,
  actualMi: number,
  paceMinPerMi: number,
  weeklyMileage: WeeklyMileage
): string {
  const plannedMi = plannedDay.distanceMi ?? 0;
  const distDiff = actualMi - plannedMi;
  const distPct = plannedMi > 0 ? (distDiff / plannedMi) * 100 : 0;
  const paceStr = formatPaceMinPerMi(paceMinPerMi);

  const lines: string[] = [];

  // Distance analysis
  if (plannedMi > 0) {
    if (Math.abs(distPct) <= 5) {
      lines.push(`Great job! ${actualMi.toFixed(1)} mi at ${paceStr} — nailed the ${plannedMi} mi target!`);
    } else if (distDiff > 0) {
      lines.push(`Nice work! ${actualMi.toFixed(1)} mi at ${paceStr} — ${distDiff.toFixed(1)} mi extra over the ${plannedMi} mi plan.`);
    } else {
      lines.push(`Solid effort! ${actualMi.toFixed(1)} mi at ${paceStr} — just ${Math.abs(distDiff).toFixed(1)} mi short of the ${plannedMi} mi goal.`);
    }
  } else {
    lines.push(`Logged ${actualMi.toFixed(1)} mi at ${paceStr}. Keep it up!`);
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

/** Main auto-sync: fetch recent Strava runs, match to plan days, auto-complete */
export async function runAutoSync(): Promise<SyncResult[]> {
  const tokens = getStravaTokens();
  if (!tokens) return [];

  const activePlan = getActivePlan();
  if (!activePlan) return [];

  const plan = getPlanById(activePlan.planId);
  if (!plan) return [];

  // Fetch last 14 days of activities to catch up on any missed syncs
  const twoWeeksAgo = Math.floor(Date.now() / 1000) - 14 * 24 * 60 * 60;
  let activities: StravaActivity[];
  try {
    activities = await getActivities({ per_page: 50, after: twoWeeksAgo });
  } catch {
    return [];
  }

  const runActivities = activities.filter(isRunActivity);
  const results: SyncResult[] = [];

  // Group runs by date (multiple runs on same day: pick the longest)
  const runsByDate = new Map<string, StravaActivity>();
  for (const act of runActivities) {
    const dateKey = getActivityDateKey(act);
    const existing = runsByDate.get(dateKey);
    if (!existing || act.distance > existing.distance) {
      runsByDate.set(dateKey, act);
    }
  }

  // Match each run to a plan day
  for (const [dateKey, activity] of runsByDate) {
    const actDate = new Date(dateKey + 'T00:00:00');
    const pos = getWeekDayForDate(activePlan.startDate, plan.totalWeeks, actDate);
    if (!pos) continue;

    const { weekIndex, dayIndex } = pos;
    const plannedDay = plan.weeks[weekIndex]?.days[dayIndex];
    if (!plannedDay) continue;

    // Only match to run/cross/race/marathon days (not rest)
    if (plannedDay.type === 'rest') continue;

    // Skip if already synced with this exact activity
    const existingMeta = getSyncMeta(plan.id, weekIndex, dayIndex);
    if (existingMeta?.stravaActivityId === activity.id) continue;

    const actualMi = metersToMiles(activity.distance);
    const paceMinPerMi = calcPaceMinPerMi(activity.distance, activity.moving_time);

    // Auto-complete the day
    const wasAlreadyCompleted = isDayCompleted(plan.id, weekIndex, dayIndex);
    if (!wasAlreadyCompleted) {
      setDayCompleted(plan.id, weekIndex, dayIndex, true);
    }

    // Save sync meta first (needed for weekly mileage calc)
    const meta: SyncMeta = {
      stravaActivityId: activity.id,
      actualDistanceMi: actualMi,
      actualPaceMinPerMi: paceMinPerMi,
      movingTimeSec: activity.moving_time,
      feedback: '', // will update below
      syncedAt: new Date().toISOString(),
    };
    setSyncMeta(plan.id, weekIndex, dayIndex, meta);

    // Build weekly mileage after saving meta
    const weeklyMileage = buildWeeklyMileage(plan, plan.id, weekIndex);
    const feedback = generateFeedback(plannedDay, activity, actualMi, paceMinPerMi, weeklyMileage);

    // Update meta with feedback
    meta.feedback = feedback;
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
    });
  }

  setLastSyncTime(new Date().toISOString());

  // ── Post-sync: capture HR data from all synced activities ──
  for (const [dateKey, activity] of runsByDate) {
    if (activity.average_heartrate && activity.average_heartrate > 0) {
      const hrData = buildHRDataFromStrava(
        activity.id,
        dateKey,
        activity.average_heartrate,
        activity.max_heartrate ?? 0,
        activity.moving_time,
        activity.average_cadence,
      );
      if (hrData) upsertActivityHR(hrData);
    }
  }

  // ── Post-sync: update race prediction, adherence, readiness, and daily recap ──
  try { calculateRacePrediction(); } catch { /* non-critical */ }
  try { calculateTrainingAdherence(); } catch { /* non-critical */ }
  try { generateCurrentWeekReadiness(); } catch { /* non-critical */ }
  try { generateDailyRecap(); } catch { /* non-critical */ }

  return results;
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
