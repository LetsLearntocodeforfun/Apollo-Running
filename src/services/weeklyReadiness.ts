/**
 * Race Day Readiness Score — weekly recap engine that evaluates training quality,
 * generates actionable suggestions, and builds toward race-day confidence.
 * Score is 0-100, updated weekly, with trend analysis.
 */

import { getActivePlan, getAllSyncMeta, getWeekDayForDate } from './planProgress';
import { getPlanById } from '../data/plans';
import { getAllWeeklyMileage } from './autoSync';
import { getHRHistory, getHRProfile } from './heartRate';
import { getSavedPrediction } from './racePrediction';
import { persistence } from './db/persistence';

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

export function getReadinessScore(weekNumber: number): ReadinessScore | null {
  return getReadinessStore()[weekNumber] ?? null;
}

export function getAllReadinessScores(): ReadinessScore[] {
  const store = getReadinessStore();
  return Object.values(store).sort((a, b) => a.weekNumber - b.weekNumber);
}

export function getLatestReadinessScore(): ReadinessScore | null {
  const all = getAllReadinessScores();
  return all.length > 0 ? all[all.length - 1] : null;
}

function letterGrade(score: number): string {
  if (score >= 95) return 'A+';
  if (score >= 88) return 'A';
  if (score >= 82) return 'B+';
  if (score >= 75) return 'B';
  if (score >= 68) return 'C+';
  if (score >= 60) return 'C';
  return 'D';
}

/** Generate readiness score for a specific week */
export function generateReadinessScore(weekNumber: number): ReadinessScore | null {
  const activePlan = getActivePlan();
  if (!activePlan) return null;

  const plan = getPlanById(activePlan.planId);
  if (!plan) return null;

  const weekIndex = weekNumber - 1;
  if (weekIndex < 0 || weekIndex >= plan.totalWeeks) return null;

  const week = plan.weeks[weekIndex];
  if (!week) return null;

  const allMeta = getAllSyncMeta(plan.id);
  const weekMeta = allMeta.filter((m) => m.weekIndex === weekIndex);
  const allMileage = getAllWeeklyMileage(plan.id);
  const weeklyMileage = allMileage[weekIndex];

  // ─── 1. Volume Score ───
  let volumeScore = 0;
  if (weeklyMileage) {
    const ratio = weeklyMileage.plannedMi > 0
      ? weeklyMileage.actualMi / weeklyMileage.plannedMi
      : 1;
    if (ratio >= 0.95) volumeScore = 100;
    else if (ratio >= 0.85) volumeScore = 85;
    else if (ratio >= 0.70) volumeScore = 70;
    else if (ratio >= 0.50) volumeScore = 50;
    else volumeScore = 30;
  }

  // ─── 2. Consistency Score ───
  const scheduledDays = week.days.filter((d) => d.type !== 'rest').length;
  const completedDays = weekMeta.length;
  const consistencyScore = scheduledDays > 0
    ? Math.round((completedDays / scheduledDays) * 100)
    : 100;

  // ─── 3. Long Run Score ───
  let longRunScore = 100;
  const longRunDay = week.days.find((d) => d.note?.toLowerCase() === 'long');
  if (longRunDay && longRunDay.distanceMi) {
    const longRunMeta = weekMeta.find((m) => {
      const dayAtIndex = week.days[m.dayIndex];
      return dayAtIndex?.note?.toLowerCase() === 'long';
    });
    if (longRunMeta) {
      const ratio = longRunMeta.meta.actualDistanceMi / (longRunDay.distanceMi || 1);
      longRunScore = ratio >= 0.9 ? 100 : ratio >= 0.75 ? 80 : 50;
    } else {
      longRunScore = 0; // Missed long run
    }
  }

  // ─── 4. Intensity Score ───
  let intensityScore = 75; // default if no HR data
  const hrHistory = getHRHistory();
  const weekHR = hrHistory.filter((h) => {
    const hDate = new Date(h.date + 'T00:00:00');
    const pos = getWeekDayForDate(activePlan.startDate, plan.totalWeeks, hDate);
    return pos && pos.weekIndex === weekIndex;
  });

  if (weekHR.length > 0) {
    const profile = getHRProfile();
    let appropriateEffort = 0;
    let total = 0;

    for (const hr of weekHR) {
      const pos = getWeekDayForDate(activePlan.startDate, plan.totalWeeks, new Date(hr.date + 'T00:00:00'));
      if (!pos) continue;
      const dayPlan = week.days[pos.dayIndex];
      if (!dayPlan) continue;

      const intensityPct = profile.maxHR > 0 ? (hr.averageHR / profile.maxHR) * 100 : 0;
      const noteLC = (dayPlan.note ?? '').toLowerCase();

      total++;
      if (noteLC === 'easy' && intensityPct <= 75) appropriateEffort++;
      else if (noteLC === 'tempo' && intensityPct >= 75 && intensityPct <= 88) appropriateEffort++;
      else if (noteLC === 'speed' && intensityPct >= 80) appropriateEffort++;
      else if (noteLC === 'long' && intensityPct <= 80) appropriateEffort++;
      else if (!noteLC) appropriateEffort++; // no guidance = any effort is fine
    }

    intensityScore = total > 0 ? Math.round((appropriateEffort / total) * 100) : 75;
  }

  // ─── 5. Recovery Score ───
  const restDaysPlanned = week.days.filter((d) => d.type === 'rest').length;
  const restDaysTaken = week.days.length - completedDays;
  const recoveryScore = restDaysPlanned > 0
    ? Math.min(Math.round((Math.min(restDaysTaken, restDaysPlanned) / restDaysPlanned) * 100), 100)
    : 80;

  // ─── Overall Score ───
  const score = Math.round(
    volumeScore * 0.25 +
    consistencyScore * 0.25 +
    longRunScore * 0.20 +
    intensityScore * 0.15 +
    recoveryScore * 0.15
  );

  // ─── Strengths & Improvements ───
  const strengths: string[] = [];
  const improvements: string[] = [];
  const nextWeekTips: string[] = [];

  if (volumeScore >= 90) strengths.push('Hit your planned mileage — volume is on point.');
  else if (volumeScore < 70) improvements.push('Fell short on total mileage this week. Try to schedule runs earlier in the day.');

  if (consistencyScore >= 90) strengths.push('Great consistency — showed up for nearly every workout.');
  else if (consistencyScore < 70) improvements.push('Missed several scheduled runs. Consistency is key to adaptation.');

  if (longRunScore >= 90) strengths.push('Nailed the long run — building that endurance engine.');
  else if (longRunScore < 50) improvements.push('The long run was missed or cut short. This is the most important weekly workout for marathon prep.');

  if (intensityScore >= 85) strengths.push('Effort levels matched the workout types well.');
  else if (intensityScore < 60) improvements.push('Effort levels didn\'t match workout types. Keep easy days easy and hard days hard.');

  if (recoveryScore >= 80) strengths.push('Good recovery balance — rest days are fueling your progress.');
  else improvements.push('Consider taking your rest days more seriously to avoid burnout.');

  // Next week tips
  const nextWeek = plan.weeks[weekIndex + 1];
  if (nextWeek) {
    const nextLong = nextWeek.days.find((d) => d.note?.toLowerCase() === 'long');
    if (nextLong?.distanceMi) {
      nextWeekTips.push(`Next week's long run: ${nextLong.distanceMi} mi. Plan your route and hydration.`);
    }
    const nextTempo = nextWeek.days.find((d) => d.note?.toLowerCase() === 'tempo');
    if (nextTempo) {
      nextWeekTips.push('Tempo run coming up — warm up for 1 mile, then maintain comfortably hard effort.');
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
  let daysUntilRace: number | undefined;
  const raceWeek = plan.totalWeeks - 1;
  const raceDay = plan.weeks[raceWeek]?.days.findIndex((d) => d.type === 'marathon');
  if (raceDay >= 0) {
    const startDate = new Date(activePlan.startDate + 'T00:00:00');
    const raceDateObj = new Date(startDate);
    raceDateObj.setDate(raceDateObj.getDate() + raceWeek * 7 + raceDay);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    daysUntilRace = Math.max(0, Math.round((raceDateObj.getTime() - today.getTime()) / (24 * 60 * 60 * 1000)));
  }

  const prediction = getSavedPrediction();

  const readiness: ReadinessScore = {
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
  };

  const store = getReadinessStore();
  store[weekNumber] = readiness;
  saveReadinessStore(store);

  return readiness;
}

/** Generate readiness for the current week */
export function generateCurrentWeekReadiness(): ReadinessScore | null {
  const activePlan = getActivePlan();
  if (!activePlan) return null;

  const plan = getPlanById(activePlan.planId);
  if (!plan) return null;

  const today = new Date();
  const pos = getWeekDayForDate(activePlan.startDate, plan.totalWeeks, today);
  if (!pos) return null;

  return generateReadinessScore(pos.weekIndex + 1);
}
