// Race Day Readiness Score — weekly training quality evaluation, 0-100 with trend analysis.
//
// v1.0.6 (V5, S5):
// - Scores read the effective plan (athlete + adaptive overlay applied).
// - A plan day is *due* once its date has passed or it is already done. Volume,
//   consistency and recovery only count due days, so the current (partial) week
//   is prorated to the days elapsed instead of being scored as missed.
// - The long run counts as missed only after its date; while it is still ahead
//   it is left out of the weighted total (`longRunPending`).
// - Intensity bands allow for warm-up/cool-down in whole-activity averages
//   (Daniels T ≈ 88–92 % HRmax counts as an appropriate tempo).
// - `computeReadinessScore` / `computeCurrentReadiness` are pure;
//   `generateReadinessScore` / `generateCurrentWeekReadiness` also save
//   (explicit, idempotent upserts).

import {
  getActivePlan,
  getActivePlanInstanceId,
  getAllSyncMeta,
  getDateKeyForDay,
  getWeekDayForDate,
  isDayCompleted,
} from './planProgress';
import type { ActivePlan } from './planProgress';
import { getEffectivePlan } from './planOverlay';
import { getRaceDate } from './journey';
import { getWorkoutKind, type PlanWorkoutKind } from '../data/plans';
import { getAllWeeklyMileage } from './autoSync';
import { getHRHistory, getHRProfile } from './heartRate';
import { getSavedPrediction } from './racePrediction';
import { persistence } from './db/persistence';
import { formatMiles } from './unitPreferences';
import { daysBetween, isDateKey, todayKey } from '../utils/localDate';

const READINESS_KEY = 'apollo_readiness_scores';

export interface ReadinessScore {
  /** Overall readiness 0-100 */
  score: number;
  /** Letter grade: A+, A, B+, B, C+, C, D */
  grade: string;
  /** Week number this score is for */
  weekNumber: number;
  /** Sub-scores */
  volumeScore: number;       // Did they hit the planned mileage?
  consistencyScore: number;  // Did they run on scheduled days?
  longRunScore: number;      // Did they complete the long run?
  intensityScore: number;    // Was effort appropriate for each workout type?
  recoveryScore: number;     // Are they taking rest days? HR trending down on easy days?
  /** What went well */
  strengths: string[];
  /** What could improve */
  improvements: string[];
  /** Specific suggestions for next week */
  nextWeekTips: string[];
  /** Trend compared to previous week */
  trend: 'improving' | 'stable' | 'declining';
  /** Race prediction at time of this score */
  predictedMarathon?: string;
  /** Days until race (if known) */
  daysUntilRace?: number;
  generatedAt: string;
  // ── v1.0.6 (optional; absent on scores saved by older versions) ──
  /** Plan instance (`${planId}@${startDate}`) the score belongs to. */
  planInstanceId?: string;
  /** True when the week wasn't over yet: the score covers only the days due so far. */
  partial?: boolean;
  /** Days of the week whose date had passed when scored (0–7). */
  elapsedDays?: number;
  /** Non-rest plan days that were due when scored. */
  dueWorkouts?: number;
  /** True when the week's long run is still ahead: it isn't counted yet (`longRunScore` is then 100). */
  longRunPending?: boolean;
}

/** Options for computing a readiness score. */
export interface ReadinessOptions {
  /** Local date key (YYYY-MM-DD) to score "as of" — days before it are due. Default: today. */
  today?: string;
}

/** Options for {@link computeCurrentReadiness}. */
export interface CurrentReadinessOptions extends ReadinessOptions {
  /** Score the current week only once at least this many of its workouts are due (default 1); otherwise the previous week. */
  minDueDays?: number;
}

function getReadinessStore(): Record<number, ReadinessScore> {
  try {
    const raw = persistence.getItem(READINESS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveReadinessStore(store: Record<number, ReadinessScore>): void {
  persistence.setItem(READINESS_KEY, JSON.stringify(store));
}

/** Scores saved by ≤ 1.0.5 carry no instance id and are kept. */
function belongsToInstance(s: ReadinessScore, instanceId: string | null): boolean {
  return !instanceId || !s.planInstanceId || s.planInstanceId === instanceId;
}

/** Saved score of a week of the active plan instance, or null. */
export function getReadinessScore(weekNumber: number): ReadinessScore | null {
  const s = getReadinessStore()[weekNumber];
  return s && belongsToInstance(s, getActivePlanInstanceId()) ? s : null;
}

/** Saved scores of the active plan instance, by week number. */
export function getAllReadinessScores(): ReadinessScore[] {
  const instanceId = getActivePlanInstanceId();
  return Object.values(getReadinessStore())
    .filter((s) => !!s && typeof s.score === 'number' && belongsToInstance(s, instanceId))
    .sort((a, b) => a.weekNumber - b.weekNumber);
}

/** The most recently generated saved score (by `generatedAt`, then week number). */
export function getLatestReadinessScore(): ReadinessScore | null {
  const all = getAllReadinessScores();
  if (all.length === 0) return null;
  return all.reduce((best, s) => {
    const a = s.generatedAt ?? '';
    const b = best.generatedAt ?? '';
    if (a !== b) return a > b ? s : best;
    return s.weekNumber > best.weekNumber ? s : best;
  });
}

export function letterGrade(score: number): string {
  if (score >= 95) return 'A+';
  if (score >= 88) return 'A';
  if (score >= 82) return 'B+';
  if (score >= 75) return 'B';
  if (score >= 68) return 'C+';
  if (score >= 60) return 'C';
  return 'D';
}

function joinedWeekIndex(active: ActivePlan): number {
  const j = active.joinedWeekIndex;
  return typeof j === 'number' && Number.isInteger(j) && j > 0 ? j : 0;
}

/**
 * Whether a whole-activity average HR (% of max) fits the workout kind. The
 * bands allow for warm-up and cool-down in session averages (S5).
 */
function isAppropriateEffort(kind: PlanWorkoutKind, pct: number): boolean {
  switch (kind) {
    case 'easy':
    case 'recovery':
      return pct <= 79;
    case 'long':
    case 'medium_long':
      return pct <= 85;
    case 'tempo':
      return pct >= 75 && pct <= 95;
    case 'marathon_pace':
      return pct >= 72 && pct <= 92;
    case 'speed':
    case 'strength':
      return pct >= 75;
    default:
      return true; // races, cross-training: no guidance — any effort is fine
  }
}

function volumeScoreFor(ratio: number): number {
  if (ratio >= 0.95) return 100;
  if (ratio >= 0.85) return 85;
  if (ratio >= 0.70) return 70;
  if (ratio >= 0.50) return 50;
  return 30;
}

/**
 * Readiness score for a plan week (1-based) as of `opts.today` — pure, nothing
 * is saved. Only due days count (see the module comment). Null when there is no
 * active plan, the week is outside the plan or was skipped when joining late,
 * or none of its workouts are due yet.
 */
export function computeReadinessScore(weekNumber: number, opts: ReadinessOptions = {}): ReadinessScore | null {
  const activePlan = getActivePlan();
  if (!activePlan) return null;

  const plan = getEffectivePlan();
  if (!plan) return null;

  const weekIndex = weekNumber - 1;
  if (!Number.isInteger(weekIndex) || weekIndex < 0 || weekIndex >= plan.totalWeeks) return null;
  if (weekIndex < joinedWeekIndex(activePlan)) return null;

  const week = plan.weeks[weekIndex];
  if (!week) return null;

  const today = opts.today && isDateKey(opts.today) ? opts.today : todayKey();
  const planId = activePlan.planId;
  const weekMeta = getAllSyncMeta(planId).filter((m) => m.weekIndex === weekIndex);
  const metaByDay = new Map(weekMeta.map((m) => [m.dayIndex, m.meta]));
  const past = week.days.map((_, d) => daysBetween(getDateKeyForDay(activePlan.startDate, weekIndex, d), today) > 0);
  const done = week.days.map((_, d) => metaByDay.has(d) || isDayCompleted(planId, weekIndex, d));
  const due = week.days.map((_, d) => past[d] || done[d]);
  const elapsedDays = past.filter(Boolean).length;

  // ─── 2. Consistency Score (due workouts only) ───
  let dueWorkouts = 0;
  let completedDue = 0;
  week.days.forEach((day, d) => {
    if (day.type === 'rest' || !due[d]) return;
    dueWorkouts++;
    if (done[d]) completedDue++;
  });
  // Nothing due yet (e.g. Monday of a week that starts with a rest day): nothing to score.
  if (dueWorkouts === 0) return null;
  const consistencyScore = Math.round((completedDue / dueWorkouts) * 100);

  // ─── 1. Volume Score (planned miles of the due days) ───
  const plannedToDate = week.days.reduce((sum, day, d) => sum + (due[d] ? day.distanceMi ?? 0 : 0), 0);
  const actualMi = getAllWeeklyMileage(planId)[weekIndex]?.actualMi ?? 0;
  const volumeScore = plannedToDate > 0 ? volumeScoreFor(actualMi / plannedToDate) : 100;

  // ─── 3. Long Run Score (missed only after its date) ───
  let longRunScore = 100;
  let longRunPending = false;
  const longIdx = week.days.findIndex((d) => getWorkoutKind(d) === 'long');
  const longRunDay = longIdx >= 0 ? week.days[longIdx] : undefined;
  if (longRunDay && longRunDay.distanceMi) {
    const longRunMeta = metaByDay.get(longIdx);
    if (longRunMeta) {
      const ratio = longRunMeta.actualDistanceMi / (longRunDay.distanceMi || 1);
      longRunScore = ratio >= 0.9 ? 100 : ratio >= 0.75 ? 80 : 50;
    } else if (done[longIdx]) {
      longRunScore = 100; // ticked by hand — no distance recorded
    } else if (past[longIdx]) {
      longRunScore = 0; // Missed long run
    } else {
      longRunPending = true; // still ahead this week
    }
  }

  // ─── 4. Intensity Score ───
  let intensityScore = 75; // default if no HR data
  const hrHistory = getHRHistory();
  if (hrHistory.length > 0) {
    const profile = getHRProfile();
    let appropriateEffort = 0;
    let total = 0;

    for (const hr of hrHistory) {
      if (!isDateKey(hr.date) || daysBetween(hr.date, today) < 0) continue;
      const pos = getWeekDayForDate(activePlan.startDate, plan.totalWeeks, hr.date);
      if (!pos || pos.weekIndex !== weekIndex) continue;
      const dayPlan = week.days[pos.dayIndex];
      if (!dayPlan) continue;

      const intensityPct = profile.maxHR > 0 ? (hr.averageHR / profile.maxHR) * 100 : 0;
      total++;
      if (isAppropriateEffort(getWorkoutKind(dayPlan), intensityPct)) appropriateEffort++;
    }

    intensityScore = total > 0 ? Math.round((appropriateEffort / total) * 100) : 75;
  }

  // ─── 5. Recovery Score (elapsed days only) ───
  let restDaysPlanned = 0;
  let restDaysTaken = 0;
  week.days.forEach((day, d) => {
    if (!past[d]) return;
    if (day.type === 'rest') restDaysPlanned++;
    if (!done[d]) restDaysTaken++;
  });
  const recoveryScore = restDaysPlanned > 0
    ? Math.min(Math.round((Math.min(restDaysTaken, restDaysPlanned) / restDaysPlanned) * 100), 100)
    : 80;

  // ─── Overall Score (weights renormalised while the long run is still ahead) ───
  const parts: Array<[number, number]> = [
    [volumeScore, 0.25],
    [consistencyScore, 0.25],
    ...(longRunPending ? [] : [[longRunScore, 0.20] as [number, number]]),
    [intensityScore, 0.15],
    [recoveryScore, 0.15],
  ];
  const weightSum = parts.reduce((s, [, w]) => s + w, 0);
  const score = Math.round(parts.reduce((s, [v, w]) => s + v * w, 0) / weightSum);

  // ─── Strengths & Improvements ───
  const strengths: string[] = [];
  const improvements: string[] = [];
  const nextWeekTips: string[] = [];

  if (volumeScore >= 90) strengths.push('Hit your planned mileage — volume is on point.');
  else if (volumeScore < 70) improvements.push('Fell short on total mileage this week. Try to schedule runs earlier in the day.');

  if (consistencyScore >= 90) strengths.push('Great consistency — showed up for nearly every workout.');
  else if (consistencyScore < 70) improvements.push('Missed several scheduled runs. Consistency is key to adaptation.');

  if (!longRunPending) {
    if (longRunScore >= 90) strengths.push('Nailed the long run — building that endurance engine.');
    else if (longRunScore < 50) improvements.push('The long run was missed or cut short. This is the most important weekly workout for marathon prep.');
  }

  if (intensityScore >= 85) strengths.push('Effort levels matched the workout types well.');
  else if (intensityScore < 60) improvements.push('Effort levels didn\'t match workout types. Keep easy days easy and hard days hard.');

  if (recoveryScore >= 80) strengths.push('Good recovery balance — rest days are fueling your progress.');
  else improvements.push('Consider taking your rest days more seriously to avoid burnout.');

  // Next week tips
  const nextWeek = plan.weeks[weekIndex + 1];
  if (nextWeek) {
    const nextLong = nextWeek.days.find((d) => getWorkoutKind(d) === 'long');
    if (nextLong?.distanceMi) {
      nextWeekTips.push(`Next week's long run: ${formatMiles(nextLong.distanceMi)}. Plan your route and hydration.`);
    }
    const nextTempo = nextWeek.days.find((d) => getWorkoutKind(d) === 'tempo');
    if (nextTempo) {
      nextWeekTips.push('Tempo run coming up — warm up for 10–15 minutes, then maintain comfortably hard effort.');
    }
    if (volumeScore < 80) {
      nextWeekTips.push('Focus on completing all scheduled runs next week to build back momentum.');
    }
    if (intensityScore < 70) {
      nextWeekTips.push('Try using heart rate to guide effort: stay in Zone 2 for easy runs.');
    }
  }

  if (nextWeekTips.length === 0) {
    nextWeekTips.push('Keep up the great work and trust the process!');
  }

  // Trend
  const prevScore = getReadinessScore(weekNumber - 1);
  let trend: ReadinessScore['trend'] = 'stable';
  if (prevScore) {
    if (score > prevScore.score + 5) trend = 'improving';
    else if (score < prevScore.score - 5) trend = 'declining';
  }

  // Days until race
  const raceDate = getRaceDate();
  const daysUntilRace = raceDate && isDateKey(raceDate) ? Math.max(0, daysBetween(today, raceDate)) : undefined;

  const prediction = getSavedPrediction();

  return {
    score,
    grade: letterGrade(score),
    weekNumber,
    volumeScore,
    consistencyScore,
    longRunScore,
    intensityScore,
    recoveryScore,
    strengths,
    improvements,
    nextWeekTips,
    trend,
    predictedMarathon: prediction?.marathonTimeFormatted,
    daysUntilRace,
    generatedAt: new Date().toISOString(),
    planInstanceId: getActivePlanInstanceId() ?? undefined,
    partial: elapsedDays < 7,
    elapsedDays,
    dueWorkouts,
    longRunPending,
  };
}

/**
 * Compute and save the readiness score for a week (explicit, idempotent
 * upsert). See {@link computeReadinessScore}; null (nothing saved) when the
 * week can't be scored yet.
 */
export function generateReadinessScore(weekNumber: number, opts: ReadinessOptions = {}): ReadinessScore | null {
  const readiness = computeReadinessScore(weekNumber, opts);
  if (!readiness) return null;
  const store = getReadinessStore();
  store[weekNumber] = readiness;
  saveReadinessStore(store);
  return readiness;
}

/**
 * Readiness "now", without saving: the current plan week prorated to the days
 * due so far — or, until at least `minDueDays` of its workouts are due (e.g. on
 * Monday), the previous week. Null when neither can be scored.
 */
export function computeCurrentReadiness(opts: CurrentReadinessOptions = {}): ReadinessScore | null {
  const activePlan = getActivePlan();
  const plan = activePlan ? getEffectivePlan() : null;
  if (!activePlan || !plan) return null;

  const today = opts.today && isDateKey(opts.today) ? opts.today : todayKey();
  const pos = getWeekDayForDate(activePlan.startDate, plan.totalWeeks, today);
  if (!pos) return null;

  const minDue = Math.max(1, Math.floor(opts.minDueDays ?? 1));
  const current = computeReadinessScore(pos.weekIndex + 1, { today });
  if (current && (current.dueWorkouts ?? 0) >= minDue) return current;
  const previous = pos.weekIndex > 0 ? computeReadinessScore(pos.weekIndex, { today }) : null;
  return previous ?? current;
}

/**
 * Generate readiness for the current week ({@link computeCurrentReadiness})
 * and save it. When nothing can be scored yet, returns the latest saved score.
 */
export function generateCurrentWeekReadiness(opts: CurrentReadinessOptions = {}): ReadinessScore | null {
  const readiness = computeCurrentReadiness(opts);
  if (!readiness) return getLatestReadinessScore();
  const store = getReadinessStore();
  store[readiness.weekNumber] = readiness;
  saveReadinessStore(store);
  return readiness;
}
