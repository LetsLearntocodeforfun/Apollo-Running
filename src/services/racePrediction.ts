/**
 * Race Time Prediction Engine — uses VDOT tables, Riegel formula, and
 * training load analysis to predict marathon finish times.
 * Updates daily after Strava sync with fresh data.
 */

import { getAllSyncMeta, getActivePlan, getCompletedCount } from './planProgress';
import { getPlanById } from '../data/plans';
import { getHRHistory, getHRProfile } from './heartRate';
import { persistence } from './db/persistence';

const PREDICTION_KEY = 'apollo_race_prediction';

export interface RacePrediction {
  /** Predicted marathon finish time in seconds */
  marathonTimeSec: number;
  /** Formatted time string (e.g. "3:45:22") */
  marathonTimeFormatted: string;
  /** Confidence level 0-100 */
  confidence: number;
  /** VDOT score (Jack Daniels Running Formula) */
  vdot: number;
  /** Prediction method used */
  method: string;
  /** Predicted half-marathon time */
  halfMarathonTimeSec: number;
  halfMarathonFormatted: string;
  /** Predicted 10K time */
  tenKTimeSec: number;
  tenKFormatted: string;
  /** Predicted 5K time */
  fiveKTimeSec: number;
  fiveKFormatted: string;
  /** When this prediction was generated */
  updatedAt: string;
  /** Trend: 'improving' | 'stable' | 'declining' */
  trend: string;
  /** Previous marathon prediction for comparison */
  previousMarathonTimeSec?: number;
}

export interface TrainingAdherence {
  /** Overall adherence score 0-100 */
  score: number;
  /** Rating: 'excellent' | 'good' | 'fair' | 'poor' */
  rating: string;
  /** Completed days vs total scheduled */
  completedDays: number;
  totalScheduledDays: number;
  /** Distance adherence: actual vs planned (0-100) */
  distanceAdherence: number;
  /** Consistency: how regularly they run (0-100) */
  consistencyScore: number;
  /** Intensity distribution score (0-100): are easy/hard days balanced? */
  intensityBalance: number;
  /** Streak: consecutive days meeting plan */
  currentStreak: number;
  /** Weekly breakdown */
  weeklyScores: { week: number; score: number }[];
  updatedAt: string;
}

const ADHERENCE_KEY = 'apollo_adherence';

/** Riegel formula: T2 = T1 * (D2/D1)^1.06 */
function riegelPredict(knownDistMi: number, knownTimeSec: number, targetDistMi: number): number {
  if (knownDistMi <= 0 || knownTimeSec <= 0) return 0;
  return knownTimeSec * Math.pow(targetDistMi / knownDistMi, 1.06);
}

/** VDOT estimation from a race/workout performance */
function estimateVDOT(distanceMeters: number, timeSec: number): number {
  if (distanceMeters <= 0 || timeSec <= 0) return 0;
  const distKm = distanceMeters / 1000;
  const timeMin = timeSec / 60;
  const velocity = distKm / timeMin; // km/min

  // Simplified VDOT formula (Daniels & Gilbert approximation)
  const pctVO2 = 0.8 + 0.1894393 * Math.exp(-0.012778 * timeMin) +
    0.2989558 * Math.exp(-0.1932605 * timeMin);
  const vo2 = -4.60 + 0.182258 * velocity * 1000 + 0.000104 * Math.pow(velocity * 1000, 2);

  if (pctVO2 <= 0) return 0;
  return vo2 / pctVO2;
}

/** Get VDOT-predicted marathon time from VDOT score */
function vdotToMarathonSec(vdot: number): number {
  // Approximate inverse: empirical lookup approximation
  // Based on Daniels' tables, marathon time = f(VDOT)
  // VDOT 30 → ~5:30:00, VDOT 40 → ~4:05:00, VDOT 50 → ~3:20:00, VDOT 60 → ~2:50:00, VDOT 70 → ~2:28:00
  if (vdot <= 0) return 0;

  // Regression fit to Daniels' tables
  const a = 4.84e6;
  const b = -1.35;
  const seconds = a * Math.pow(vdot, b);
  return Math.round(Math.max(seconds, 7200)); // min 2 hours
}

function formatTimeSec(totalSec: number): string {
  if (totalSec <= 0) return '—';
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = Math.round(totalSec % 60);
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/** Calculate race predictions based on recent training data */
export function calculateRacePrediction(): RacePrediction | null {
  const activePlan = getActivePlan();
  if (!activePlan) return null;

  const plan = getPlanById(activePlan.planId);
  if (!plan) return null;

  const allMeta = getAllSyncMeta(plan.id);
  if (allMeta.length < 3) return null; // Need at least 3 synced runs

  // Get the best performances for prediction (longest runs, fastest paces)
  const performances = allMeta
    .map((m) => ({
      distanceMi: m.meta.actualDistanceMi,
      paceMinPerMi: m.meta.actualPaceMinPerMi,
      timeSec: m.meta.movingTimeSec,
      distanceMeters: m.meta.actualDistanceMi / 0.000621371,
    }))
    .filter((p) => p.distanceMi > 0 && p.timeSec > 0)
    .sort((a, b) => b.distanceMi - a.distanceMi);

  if (performances.length === 0) return null;

  // Method 1: VDOT from best long run (>= 8 miles)
  const longRuns = performances.filter((p) => p.distanceMi >= 8);
  let vdot = 0;
  let method = 'pace_extrapolation';

  if (longRuns.length > 0) {
    // Use the best (highest VDOT) long run
    const vdots = longRuns.map((r) => estimateVDOT(r.distanceMeters, r.timeSec));
    vdot = Math.max(...vdots.filter((v) => v > 0));
    method = 'vdot_long_run';
  }

  // Method 2: Riegel from recent efforts
  const recentBest = performances[0]; // longest run
  const riegelMarathon = riegelPredict(recentBest.distanceMi, recentBest.timeSec, 26.2);

  // Method 3: Average pace extrapolation
  const recentRuns = performances.slice(0, 10);
  const avgPace = recentRuns.reduce((s, r) => s + r.paceMinPerMi, 0) / recentRuns.length;
  const paceMarathon = avgPace * 26.2 * 60; // naive pace * distance

  // Blend predictions with confidence weighting
  let marathonTimeSec: number;
  let confidence: number;

  if (vdot > 0) {
    const vdotMarathon = vdotToMarathonSec(vdot);
    // Weighted blend: 50% VDOT, 30% Riegel, 20% pace
    marathonTimeSec = Math.round(
      vdotMarathon * 0.5 +
      riegelMarathon * 0.3 +
      paceMarathon * 0.2
    );
    confidence = Math.min(85, 40 + allMeta.length * 3 + longRuns.length * 5);
    method = 'blended_vdot_riegel';
  } else if (riegelMarathon > 0) {
    marathonTimeSec = Math.round(riegelMarathon * 0.6 + paceMarathon * 0.4);
    confidence = Math.min(65, 25 + allMeta.length * 3);
    method = 'riegel_pace_blend';
  } else {
    marathonTimeSec = Math.round(paceMarathon * 1.05); // Add 5% fatigue factor
    confidence = Math.min(40, 15 + allMeta.length * 2);
    method = 'pace_extrapolation';
  }

  // Adjust confidence based on training volume
  const weeksCompleted = new Set(allMeta.map((m) => m.weekIndex)).size;
  if (weeksCompleted >= 12) confidence = Math.min(confidence + 10, 95);
  else if (weeksCompleted >= 8) confidence = Math.min(confidence + 5, 90);

  // HR-based adjustment if available
  const hrHistory = getHRHistory();
  if (hrHistory.length >= 5) {
    const profile = getHRProfile();
    const recentHR = hrHistory.slice(-10);
    const avgHR = recentHR.reduce((s, h) => s + h.averageHR, 0) / recentHR.length;
    const hrReserve = profile.maxHR - profile.restingHR;
    const intensityPct = hrReserve > 0 ? ((avgHR - profile.restingHR) / hrReserve) * 100 : 0;

    // If training at relatively low HR with decent pace, runner is more efficient
    if (intensityPct < 70 && avgPace < 10) {
      marathonTimeSec = Math.round(marathonTimeSec * 0.98); // 2% bonus
      confidence = Math.min(confidence + 5, 95);
    }
  }

  // Derive other race times
  if (vdot <= 0) {
    vdot = estimateVDOT(recentBest.distanceMeters, recentBest.timeSec);
  }

  const halfMarathonTimeSec = Math.round(riegelPredict(26.2, marathonTimeSec, 13.1));
  const tenKTimeSec = Math.round(riegelPredict(26.2, marathonTimeSec, 6.2));
  const fiveKTimeSec = Math.round(riegelPredict(26.2, marathonTimeSec, 3.1));

  // Check trend
  const prev = getSavedPrediction();
  let trend = 'stable';
  if (prev && prev.marathonTimeSec > 0) {
    const diff = marathonTimeSec - prev.marathonTimeSec;
    if (diff < -60) trend = 'improving'; // faster by > 1 min
    else if (diff > 60) trend = 'declining';
  }

  const prediction: RacePrediction = {
    marathonTimeSec,
    marathonTimeFormatted: formatTimeSec(marathonTimeSec),
    confidence,
    vdot: Math.round(vdot * 10) / 10,
    method,
    halfMarathonTimeSec,
    halfMarathonFormatted: formatTimeSec(halfMarathonTimeSec),
    tenKTimeSec,
    tenKFormatted: formatTimeSec(tenKTimeSec),
    fiveKTimeSec,
    fiveKFormatted: formatTimeSec(fiveKTimeSec),
    updatedAt: new Date().toISOString(),
    trend,
    previousMarathonTimeSec: prev?.marathonTimeSec,
  };

  savePrediction(prediction);
  return prediction;
}

function savePrediction(pred: RacePrediction): void {
  persistence.setItem(PREDICTION_KEY, JSON.stringify(pred));
}

export function getSavedPrediction(): RacePrediction | null {
  try {
    const raw = persistence.getItem(PREDICTION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/** Calculate comprehensive training adherence score */
export function calculateTrainingAdherence(): TrainingAdherence | null {
  const activePlan = getActivePlan();
  if (!activePlan) return null;

  const plan = getPlanById(activePlan.planId);
  if (!plan) return null;

  const allMeta = getAllSyncMeta(plan.id);
  const completedCount = getCompletedCount(plan.id);

  // How many days are "in the past" (should have been completed)
  const startDate = new Date(activePlan.startDate + 'T00:00:00');
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const daysSinceStart = Math.floor((today.getTime() - startDate.getTime()) / (24 * 60 * 60 * 1000));
  const totalScheduledDays = Math.min(Math.max(daysSinceStart + 1, 0), plan.totalWeeks * 7);

  // Count non-rest scheduled days up to today
  let scheduledRunDays = 0;
  for (let d = 0; d < totalScheduledDays; d++) {
    const wi = Math.floor(d / 7);
    const di = d % 7;
    const day = plan.weeks[wi]?.days[di];
    if (day && day.type !== 'rest') scheduledRunDays++;
  }

  // 1. Completion rate
  const completionRate = scheduledRunDays > 0 ? Math.min(completedCount / scheduledRunDays, 1) : 0;

  // 2. Distance adherence: actual total vs planned total for completed weeks
  let totalPlannedMi = 0;
  let totalActualMi = 0;
  for (const m of allMeta) {
    totalActualMi += m.meta.actualDistanceMi;
    const day = plan.weeks[m.weekIndex]?.days[m.dayIndex];
    if (day?.distanceMi) totalPlannedMi += day.distanceMi;
  }
  const distanceAdherence = totalPlannedMi > 0 ? Math.min((totalActualMi / totalPlannedMi) * 100, 120) : 0;

  // 3. Consistency: check for gaps > 3 days in training
  const syncDates = allMeta
    .map((m) => m.meta.syncedAt)
    .filter(Boolean)
    .sort();
  let maxGapDays = 0;
  for (let i = 1; i < syncDates.length; i++) {
    const gap = (new Date(syncDates[i]).getTime() - new Date(syncDates[i - 1]).getTime()) / (24 * 60 * 60 * 1000);
    if (gap > maxGapDays) maxGapDays = gap;
  }
  const consistencyScore = maxGapDays <= 2 ? 100 : maxGapDays <= 4 ? 80 : maxGapDays <= 7 ? 60 : 40;

  // 4. Intensity balance (easy vs hard day distribution)
  let easyDays = 0;
  let hardDays = 0;
  for (const m of allMeta) {
    const day = plan.weeks[m.weekIndex]?.days[m.dayIndex];
    if (day?.note) {
      const note = day.note.toLowerCase();
      if (note === 'easy' || note === 'long') easyDays++;
      else if (note === 'tempo' || note === 'speed' || note === 'strength') hardDays++;
    }
  }
  const totalCategorized = easyDays + hardDays;
  // Ideal ratio: ~80% easy, 20% hard
  const easyPct = totalCategorized > 0 ? easyDays / totalCategorized : 0;
  const intensityBalance = totalCategorized < 3 ? 50 : (easyPct >= 0.6 && easyPct <= 0.9 ? 100 : easyPct > 0.9 ? 80 : 60);

  // 5. Current streak
  let currentStreak = 0;
  if (totalScheduledDays > 0) {
    for (let d = Math.min(daysSinceStart, plan.totalWeeks * 7 - 1); d >= 0; d--) {
      const wi = Math.floor(d / 7);
      const di = d % 7;
      const day = plan.weeks[wi]?.days[di];
      if (day?.type === 'rest') {
        currentStreak++;
        continue;
      }
      const completed = completedCount > 0; // simplified
      if (completed) currentStreak++;
      else break;
    }
  }

  // 6. Weekly scores
  const weeksToScore = Math.min(Math.ceil(totalScheduledDays / 7), plan.totalWeeks);
  const weeklyScores: { week: number; score: number }[] = [];
  for (let w = 0; w < weeksToScore; w++) {
    const weekMeta = allMeta.filter((m) => m.weekIndex === w);
    const weekDays = plan.weeks[w]?.days ?? [];
    const scheduledInWeek = weekDays.filter((d) => d.type !== 'rest').length;
    const completedInWeek = weekMeta.length;
    const weekScore = scheduledInWeek > 0 ? Math.round((completedInWeek / scheduledInWeek) * 100) : 100;
    weeklyScores.push({ week: w + 1, score: Math.min(weekScore, 100) });
  }

  // Overall score: weighted blend
  const score = Math.round(
    completionRate * 100 * 0.35 +
    Math.min(distanceAdherence, 100) * 0.25 +
    consistencyScore * 0.20 +
    intensityBalance * 0.20
  );

  let rating: TrainingAdherence['rating'];
  if (score >= 85) rating = 'excellent';
  else if (score >= 70) rating = 'good';
  else if (score >= 50) rating = 'fair';
  else rating = 'poor';

  const adherence: TrainingAdherence = {
    score,
    rating,
    completedDays: completedCount,
    totalScheduledDays: scheduledRunDays,
    distanceAdherence: Math.round(Math.min(distanceAdherence, 100)),
    consistencyScore,
    intensityBalance,
    currentStreak,
    weeklyScores,
    updatedAt: new Date().toISOString(),
  };

  saveAdherence(adherence);
  return adherence;
}

function saveAdherence(adherence: TrainingAdherence): void {
  persistence.setItem(ADHERENCE_KEY, JSON.stringify(adherence));
}

export function getSavedAdherence(): TrainingAdherence | null {
  try {
    const raw = persistence.getItem(ADHERENCE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
