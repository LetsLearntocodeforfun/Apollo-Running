/**
 * Adaptive Training Recommendations Engine
 *
 * Analyzes Strava sync data, plan progress, and readiness scores to generate
 * intelligent, coach-style plan adjustment recommendations.
 *
 * Detects five scenarios:
 *   1. Ahead of schedule — suggest upgrading or faster goals
 *   2. Behind schedule — suggest reducing load or extending timeline
 *   3. Overtraining / fatigue — force rest, reduce mileage
 *   4. Inconsistent execution — pacing education, target adjustment
 *   5. Race week optimization — taper and race-day strategy
 *
 * All state is persisted in localStorage for offline-first operation.
 */

import {
  getActivePlan,
  getAllSyncMeta,
  getCompletedCount,
  isDayCompleted,
  getWeekDayForDate,
  getLastSyncTime,
} from './planProgress';
import { getPlanById } from '../data/plans';
import { getAllWeeklyMileage } from './autoSync';
import { getLatestReadinessScore } from './weeklyReadiness';
import { getSavedAdherence } from './racePrediction';
import { getStravaTokens } from './storage';
import type {
  AdaptiveRecommendation,
  AdaptivePreferences,
  PlanModification,
  WeekAdjustment,
  WeekSnapshot,
  RecommendationAnalytics,
  TrainingAnalysisInput,
  TrainingAnalysisResult,
  DetectedScenario,
  AnalysisStats,
  SyncedRunData,
  RecommendationOption,
  RecommendationPriority,
} from '../types/recommendations';

// ── Storage Keys ──────────────────────────────────────────────────────────────

const RECOMMENDATIONS_KEY = 'apollo_adaptive_recommendations';
const PREFERENCES_KEY = 'apollo_adaptive_prefs';
const MODIFICATIONS_KEY = 'apollo_plan_modifications';
const ANALYTICS_KEY = 'apollo_rec_analytics';
const LAST_ANALYSIS_KEY = 'apollo_last_analysis';

// ── Default Preferences ───────────────────────────────────────────────────────

const DEFAULT_PREFS: AdaptivePreferences = {
  enabled: true,
  frequency: 'daily',
  aggressiveness: 'balanced',
};

// ── Preferences ───────────────────────────────────────────────────────────────

/** Retrieve adaptive recommendation preferences. */
export function getAdaptivePreferences(): AdaptivePreferences {
  try {
    const raw = localStorage.getItem(PREFERENCES_KEY);
    if (!raw) return { ...DEFAULT_PREFS };
    return { ...DEFAULT_PREFS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

/** Persist adaptive recommendation preferences. */
export function setAdaptivePreferences(prefs: Partial<AdaptivePreferences>): void {
  const current = getAdaptivePreferences();
  localStorage.setItem(PREFERENCES_KEY, JSON.stringify({ ...current, ...prefs }));
}

// ── Recommendations CRUD ──────────────────────────────────────────────────────

/** Get all stored recommendations. */
function getStoredRecommendations(): AdaptiveRecommendation[] {
  try {
    const raw = localStorage.getItem(RECOMMENDATIONS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

/** Save recommendations array to localStorage. */
function saveRecommendations(recs: AdaptiveRecommendation[]): void {
  localStorage.setItem(RECOMMENDATIONS_KEY, JSON.stringify(recs));
}

/** Get active (non-expired, non-dismissed) recommendations. */
export function getActiveRecommendations(): AdaptiveRecommendation[] {
  const all = getStoredRecommendations();
  const now = new Date().toISOString();
  return all.filter((r) => {
    if (r.status !== 'active') return false;
    if (r.expiresAt && r.expiresAt < now) return false;
    return true;
  });
}

/** Get all recommendations including historical. */
export function getAllRecommendations(): AdaptiveRecommendation[] {
  return getStoredRecommendations();
}

/** Mark a recommendation as dismissed. */
export function dismissRecommendation(id: string): void {
  const all = getStoredRecommendations();
  const rec = all.find((r) => r.id === id);
  if (rec) {
    rec.status = 'dismissed';
    saveRecommendations(all);
    trackAnalytics(rec, 'dismissed');
  }
}

/** Mark a recommendation as accepted with the chosen option. */
export function acceptRecommendation(id: string, optionKey: string): void {
  const all = getStoredRecommendations();
  const rec = all.find((r) => r.id === id);
  if (rec) {
    rec.status = 'accepted';
    rec.selectedOptionKey = optionKey;
    saveRecommendations(all);
    trackAnalytics(rec, 'accepted', optionKey);
  }
}

// ── Plan Modifications ────────────────────────────────────────────────────────

/** Get all plan modifications. */
export function getPlanModifications(): PlanModification[] {
  try {
    const raw = localStorage.getItem(MODIFICATIONS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

/** Save modifications array. */
function saveModifications(mods: PlanModification[]): void {
  localStorage.setItem(MODIFICATIONS_KEY, JSON.stringify(mods));
}

/**
 * Apply a plan modification — adjusts upcoming weeks in the training plan.
 * Stores a snapshot of the original data for undo capability.
 */
export function applyRecommendation(
  recommendationId: string,
  optionKey: string,
): PlanModification | null {
  const all = getStoredRecommendations();
  const rec = all.find((r) => r.id === recommendationId);
  if (!rec) return null;

  const option = rec.options.find((o) => o.key === optionKey);
  if (!option || option.actionType !== 'apply_modification' || !option.actionPayload) return null;

  const modification = option.actionPayload as PlanModification;
  modification.appliedAt = new Date().toISOString();
  modification.undone = false;
  modification.recommendationId = recommendationId;

  // Build original snapshot before applying
  const activePlan = getActivePlan();
  if (!activePlan) return null;
  const plan = getPlanById(activePlan.planId);
  if (!plan) return null;

  const originalSnapshot: WeekSnapshot[] = [];
  for (const adj of modification.weekAdjustments) {
    const week = plan.weeks[adj.weekIndex];
    if (!week) continue;
    originalSnapshot.push({
      weekIndex: adj.weekIndex,
      days: week.days.map((d, i) => ({
        dayIndex: i,
        type: d.type,
        label: d.label,
        distanceMi: d.distanceMi,
        note: d.note,
      })),
    });

    // Apply mileage multiplier
    if (adj.mileageMultiplier != null && adj.mileageMultiplier !== 1) {
      for (const day of week.days) {
        if (day.distanceMi != null && day.type === 'run') {
          day.distanceMi = Math.round(day.distanceMi * adj.mileageMultiplier * 10) / 10;
          day.label = `${day.distanceMi} mi ${day.note?.toLowerCase() ?? 'run'}`;
        }
      }
    }

    // Apply day-level overrides
    if (adj.dayOverrides) {
      for (const ov of adj.dayOverrides) {
        const targetDay = week.days[ov.dayIndex];
        if (!targetDay) continue;
        targetDay.type = ov.type;
        targetDay.label = ov.label;
        targetDay.distanceMi = ov.distanceMi;
        targetDay.note = ov.note;
      }
    }
  }

  modification.originalSnapshot = originalSnapshot;
  modification.id = `mod-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

  // Persist
  const mods = getPlanModifications();
  mods.push(modification);
  saveModifications(mods);

  // Mark recommendation accepted
  acceptRecommendation(recommendationId, optionKey);

  return modification;
}

/**
 * Undo a previously applied plan modification.
 * Restores the original week data from the stored snapshot.
 */
export function undoRecommendation(modificationId: string): boolean {
  const mods = getPlanModifications();
  const mod = mods.find((m) => m.id === modificationId);
  if (!mod || mod.undone) return false;

  const activePlan = getActivePlan();
  if (!activePlan) return false;
  const plan = getPlanById(activePlan.planId);
  if (!plan) return false;

  // Restore original data
  for (const snap of mod.originalSnapshot) {
    const week = plan.weeks[snap.weekIndex];
    if (!week) continue;
    for (const daySnap of snap.days) {
      const day = week.days[daySnap.dayIndex];
      if (!day) continue;
      day.type = daySnap.type;
      day.label = daySnap.label;
      day.distanceMi = daySnap.distanceMi;
      day.note = daySnap.note;
    }
  }

  mod.undone = true;
  saveModifications(mods);
  return true;
}

/** Get the most recent non-undone modification. */
export function getLastModification(): PlanModification | null {
  const mods = getPlanModifications().filter((m) => !m.undone);
  return mods.length > 0 ? mods[mods.length - 1] : null;
}

// ── Analytics ─────────────────────────────────────────────────────────────────

/** Track a recommendation outcome for future learning. */
function trackAnalytics(
  rec: AdaptiveRecommendation,
  action: 'accepted' | 'dismissed' | 'expired',
  selectedOptionKey?: string,
): void {
  try {
    const raw = localStorage.getItem(ANALYTICS_KEY);
    const entries: RecommendationAnalytics[] = raw ? JSON.parse(raw) : [];
    entries.push({
      recommendationId: rec.id,
      scenario: rec.scenario,
      type: rec.type,
      action,
      selectedOptionKey,
      timestamp: new Date().toISOString(),
    });
    // Keep last 200 entries
    if (entries.length > 200) entries.splice(0, entries.length - 200);
    localStorage.setItem(ANALYTICS_KEY, JSON.stringify(entries));
  } catch {
    // non-critical
  }
}

/** Retrieve analytics history. */
export function getAnalyticsHistory(): RecommendationAnalytics[] {
  try {
    const raw = localStorage.getItem(ANALYTICS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

// ── Rate-Limiting ─────────────────────────────────────────────────────────────

/** Check whether enough time has passed since the last analysis. */
function shouldRunAnalysis(): boolean {
  const prefs = getAdaptivePreferences();
  if (!prefs.enabled) return false;

  const last = localStorage.getItem(LAST_ANALYSIS_KEY);
  if (!last) return true;

  const lastDate = new Date(last);
  const now = new Date();
  const hoursSinceLast = (now.getTime() - lastDate.getTime()) / (1000 * 60 * 60);

  switch (prefs.frequency) {
    case 'daily':
      return hoursSinceLast >= 20; // ~once per day
    case 'weekly':
      return hoursSinceLast >= 144; // ~6 days
    case 'before_key_workouts':
      return hoursSinceLast >= 20; // same as daily, filtered at display time
    default:
      return hoursSinceLast >= 20;
  }
}

/** Enforce max 1 new recommendation per 3 days unless high priority. */
function shouldEmitRecommendation(priority: RecommendationPriority): boolean {
  if (priority === 'high') return true;
  const active = getActiveRecommendations();
  if (active.length === 0) return true;
  const newest = active.reduce((a, b) => (a.createdAt > b.createdAt ? a : b));
  const hoursSinceNewest = (Date.now() - new Date(newest.createdAt).getTime()) / (1000 * 60 * 60);
  return hoursSinceNewest >= 72; // 3 days
}

// ── Data Gathering ────────────────────────────────────────────────────────────

/** Gather all input data needed for the analysis engine. */
function gatherAnalysisInput(): TrainingAnalysisInput | null {
  const activePlan = getActivePlan();
  if (!activePlan) return null;

  const plan = getPlanById(activePlan.planId);
  if (!plan) return null;

  const today = new Date();
  const pos = getWeekDayForDate(activePlan.startDate, plan.totalWeeks, today);
  if (!pos) return null;

  const allMeta = getAllSyncMeta(plan.id);
  const allMileage = getAllWeeklyMileage(plan.id);
  const readiness = getLatestReadinessScore();
  const adherence = getSavedAdherence();
  const lastSync = getLastSyncTime();
  const stravaConnected = !!getStravaTokens();

  // Build synced run data
  const syncedRuns: SyncedRunData[] = allMeta.map((m) => {
    const day = plan.weeks[m.weekIndex]?.days[m.dayIndex];
    return {
      weekIndex: m.weekIndex,
      dayIndex: m.dayIndex,
      actualDistanceMi: m.meta.actualDistanceMi,
      actualPaceMinPerMi: m.meta.actualPaceMinPerMi,
      plannedDistanceMi: day?.distanceMi ?? 0,
      plannedNote: day?.note ?? '',
      movingTimeSec: m.meta.movingTimeSec,
      date: m.meta.syncedAt.slice(0, 10),
    };
  });

  // Weekly mileage
  const weeklyMileage = allMileage.map((wm) => ({
    weekIndex: wm.weekIndex,
    plannedMi: wm.plannedMi,
    actualMi: wm.actualMi,
  }));

  // Recent 2-week completion rate
  const recentWeekStart = Math.max(0, pos.weekIndex - 1);
  let recentScheduled = 0;
  let recentCompleted = 0;
  for (let w = recentWeekStart; w <= pos.weekIndex; w++) {
    const week = plan.weeks[w];
    if (!week) continue;
    for (let d = 0; d < week.days.length; d++) {
      if (week.days[d].type !== 'rest') {
        recentScheduled++;
        if (isDayCompleted(plan.id, w, d)) recentCompleted++;
      }
    }
  }

  // Overall completion
  const totalScheduled = plan.weeks.reduce(
    (sum, week) => sum + week.days.filter((d) => d.type !== 'rest').length,
    0,
  );
  const totalCompleted = getCompletedCount(plan.id);

  // Days since last sync
  let daysSinceLastSync = 999;
  if (lastSync) {
    daysSinceLastSync = Math.floor(
      (Date.now() - new Date(lastSync).getTime()) / (1000 * 60 * 60 * 24),
    );
  }

  return {
    planId: plan.id,
    startDate: activePlan.startDate,
    totalWeeks: plan.totalWeeks,
    currentWeekIndex: pos.weekIndex,
    currentDayIndex: pos.dayIndex,
    weeksRemaining: plan.totalWeeks - pos.weekIndex - 1,
    recentCompletionRate: recentScheduled > 0 ? recentCompleted / recentScheduled : 0,
    overallCompletionRate: totalScheduled > 0 ? totalCompleted / totalScheduled : 0,
    weeklyMileage,
    syncedRuns,
    readinessScore: readiness?.score ?? 0,
    adherenceScore: adherence?.score ?? 0,
    daysSinceLastSync,
    stravaConnected,
  };
}

// ── Analysis Engine ───────────────────────────────────────────────────────────

/** Compute summary statistics from the input data. */
function computeStats(input: TrainingAnalysisInput): AnalysisStats {
  const longRuns = input.syncedRuns.filter(
    (r) => r.plannedNote.toLowerCase() === 'long' && r.actualPaceMinPerMi > 0,
  );
  const recentLongRuns = longRuns.slice(-4);
  const avgLongRunPace =
    recentLongRuns.length > 0
      ? recentLongRuns.reduce((s, r) => s + r.actualPaceMinPerMi, 0) / recentLongRuns.length
      : 0;

  const easyRuns = input.syncedRuns.filter(
    (r) => r.plannedNote.toLowerCase() === 'easy' && r.actualPaceMinPerMi > 0,
  );
  const recentEasyRuns = easyRuns.slice(-4);
  const avgEasyPace =
    recentEasyRuns.length > 0
      ? recentEasyRuns.reduce((s, r) => s + r.actualPaceMinPerMi, 0) / recentEasyRuns.length
      : 0;

  // Weekly mileage change
  const currWeek = input.weeklyMileage.find((w) => w.weekIndex === input.currentWeekIndex);
  const prevWeek = input.weeklyMileage.find((w) => w.weekIndex === input.currentWeekIndex - 1);
  const weeklyMileageChangePct =
    prevWeek && prevWeek.actualMi > 0
      ? ((currWeek?.actualMi ?? 0) - prevWeek.actualMi) / prevWeek.actualMi
      : 0;

  // Consecutive days without rest
  let consecutiveDaysWithoutRest = 0;
  const activePlan = getActivePlan();
  const plan = activePlan ? getPlanById(activePlan.planId) : null;
  if (plan && activePlan) {
    for (let d = input.currentWeekIndex * 7 + input.currentDayIndex; d >= 0; d--) {
      const wi = Math.floor(d / 7);
      const di = d % 7;
      const day = plan.weeks[wi]?.days[di];
      if (!day) break;
      if (isDayCompleted(plan.id, wi, di) || (day.type === 'run' && d <= input.currentWeekIndex * 7 + input.currentDayIndex)) {
        if (day.type !== 'rest') {
          consecutiveDaysWithoutRest++;
        } else {
          break;
        }
      } else {
        break;
      }
    }
  }

  // Missed key workouts in last 2 weeks
  let missedKeyWorkoutsLast2Weeks = 0;
  if (plan && activePlan) {
    const startW = Math.max(0, input.currentWeekIndex - 1);
    for (let w = startW; w <= input.currentWeekIndex; w++) {
      const week = plan.weeks[w];
      if (!week) continue;
      for (let d = 0; d < week.days.length; d++) {
        const day = week.days[d];
        const note = (day.note ?? '').toLowerCase();
        const isKey = note === 'long' || note === 'tempo' || note === 'speed';
        if (isKey && !isDayCompleted(plan.id, w, d)) {
          // Only count if the day is in the past
          const dayDate = new Date(activePlan.startDate + 'T00:00:00');
          dayDate.setDate(dayDate.getDate() + w * 7 + d);
          if (dayDate < new Date()) {
            missedKeyWorkoutsLast2Weeks++;
          }
        }
      }
    }
  }

  // Pacing analysis: easy days too fast? (< 9:00/mi is fast for most easy runs)
  const easyDaysTooFast = avgEasyPace > 0 && avgEasyPace < 8.5;

  // Hard days too slow? Compare tempo/speed runs to easy pace
  const hardRuns = input.syncedRuns.filter(
    (r) => {
      const note = r.plannedNote.toLowerCase();
      return (note === 'tempo' || note === 'speed') && r.actualPaceMinPerMi > 0;
    },
  );
  const avgHardPace =
    hardRuns.length > 0
      ? hardRuns.reduce((s, r) => s + r.actualPaceMinPerMi, 0) / hardRuns.length
      : 0;
  const hardDaysTooSlow = avgEasyPace > 0 && avgHardPace > 0 && avgHardPace >= avgEasyPace * 0.95;

  return {
    avgLongRunPace,
    avgEasyPace,
    weeklyMileageChangePct,
    consecutiveDaysWithoutRest,
    missedKeyWorkoutsLast2Weeks,
    last2WeeksCompletionRate: input.recentCompletionRate,
    easyDaysTooFast,
    hardDaysTooSlow,
  };
}

/** Detect which training scenarios are present. */
function detectScenarios(
  input: TrainingAnalysisInput,
  stats: AnalysisStats,
): DetectedScenario[] {
  const scenarios: DetectedScenario[] = [];
  const prefs = getAdaptivePreferences();
  const aggrFactor = prefs.aggressiveness === 'aggressive' ? 0.8 : prefs.aggressiveness === 'conservative' ? 1.2 : 1.0;

  // ── SCENARIO 1: Ahead of Schedule ──
  {
    const triggers: string[] = [];
    let confidence = 0;

    // Long runs faster than target
    const longRuns = input.syncedRuns.filter((r) => r.plannedNote.toLowerCase() === 'long' && r.actualPaceMinPerMi > 0);
    if (longRuns.length >= 4) {
      const recentLong = longRuns.slice(-4);
      const avgPace = recentLong.reduce((s, r) => s + r.actualPaceMinPerMi, 0) / recentLong.length;
      // If running faster than ~10:00/mi average on long runs, they're doing well
      if (avgPace < 9.5) {
        triggers.push(`Last ${recentLong.length} long runs averaged ${formatPace(avgPace)} — faster than typical training pace`);
        confidence += 30;
      }
    }

    // High readiness with weeks remaining
    if (input.readinessScore > 85 * aggrFactor && input.weeksRemaining >= 6) {
      triggers.push(`Readiness score ${input.readinessScore}% with ${input.weeksRemaining} weeks remaining`);
      confidence += 30;
    }

    // High adherence
    if (input.adherenceScore > 85) {
      triggers.push(`Training adherence is ${input.adherenceScore}% — excellent consistency`);
      confidence += 20;
    }

    // Completing workouts with extra distance
    const overAchievers = input.syncedRuns.filter(
      (r) => r.plannedDistanceMi > 0 && r.actualDistanceMi > r.plannedDistanceMi * 1.1,
    );
    if (overAchievers.length >= 3) {
      triggers.push(`${overAchievers.length} runs exceeded plan distance by 10%+`);
      confidence += 20;
    }

    if (confidence >= 40) {
      scenarios.push({ scenario: 'ahead_of_schedule', confidence: Math.min(confidence, 100), triggers });
    }
  }

  // ── SCENARIO 2: Behind Schedule ──
  {
    const triggers: string[] = [];
    let confidence = 0;

    if (stats.missedKeyWorkoutsLast2Weeks >= 3) {
      triggers.push(`Missed ${stats.missedKeyWorkoutsLast2Weeks} key workouts in the last 2 weeks`);
      confidence += 35;
    }

    if (stats.last2WeeksCompletionRate < 0.70 * aggrFactor) {
      triggers.push(`Completion rate is ${Math.round(stats.last2WeeksCompletionRate * 100)}% over the last 2 weeks`);
      confidence += 30;
    }

    if (input.readinessScore > 0 && input.readinessScore < 60) {
      triggers.push(`Readiness score is ${input.readinessScore}% — below target`);
      confidence += 25;
    }

    if (input.overallCompletionRate < 0.65) {
      triggers.push(`Overall plan completion is ${Math.round(input.overallCompletionRate * 100)}%`);
      confidence += 15;
    }

    if (confidence >= 40) {
      scenarios.push({ scenario: 'behind_schedule', confidence: Math.min(confidence, 100), triggers });
    }
  }

  // ── SCENARIO 3: Overtraining / Fatigue ──
  {
    const triggers: string[] = [];
    let confidence = 0;

    if (stats.weeklyMileageChangePct > 0.25) {
      triggers.push(`Weekly mileage jumped ${Math.round(stats.weeklyMileageChangePct * 100)}% from previous week`);
      confidence += 35;
    }

    if (stats.consecutiveDaysWithoutRest >= 7) {
      triggers.push(`${stats.consecutiveDaysWithoutRest} consecutive days without a rest day`);
      confidence += 30;
    }

    // Same mileage but slower pace (fatigue indicator)
    const recentRuns = input.syncedRuns.slice(-6);
    const olderRuns = input.syncedRuns.slice(-12, -6);
    if (recentRuns.length >= 3 && olderRuns.length >= 3) {
      const recentAvgPace = recentRuns.reduce((s, r) => s + r.actualPaceMinPerMi, 0) / recentRuns.length;
      const olderAvgPace = olderRuns.reduce((s, r) => s + r.actualPaceMinPerMi, 0) / olderRuns.length;
      if (recentAvgPace > olderAvgPace * 1.05 && olderAvgPace > 0) {
        triggers.push(`Average pace slowed ${Math.round(((recentAvgPace - olderAvgPace) / olderAvgPace) * 100)}% — possible fatigue`);
        confidence += 25;
      }
    }

    if (confidence >= 35) {
      scenarios.push({ scenario: 'overtraining', confidence: Math.min(confidence, 100), triggers });
    }
  }

  // ── SCENARIO 4: Inconsistent Execution ──
  {
    const triggers: string[] = [];
    let confidence = 0;

    if (stats.easyDaysTooFast) {
      triggers.push(`Easy day pace (${formatPace(stats.avgEasyPace)}) is too fast — should be conversational effort`);
      confidence += 35;
    }

    if (stats.hardDaysTooSlow) {
      triggers.push('Hard workout paces are nearly the same as easy paces — not enough distinction');
      confidence += 30;
    }

    // Check if workouts are completed but off-target on distance
    const offTarget = input.syncedRuns.filter(
      (r) => r.plannedDistanceMi > 0 && Math.abs(r.actualDistanceMi - r.plannedDistanceMi) / r.plannedDistanceMi > 0.2,
    );
    if (offTarget.length >= 4) {
      triggers.push(`${offTarget.length} workouts were 20%+ off planned distance`);
      confidence += 25;
    }

    if (confidence >= 35) {
      scenarios.push({ scenario: 'inconsistent_execution', confidence: Math.min(confidence, 100), triggers });
    }
  }

  // ── SCENARIO 5: Race Week Optimization ──
  {
    const triggers: string[] = [];
    let confidence = 0;

    if (input.weeksRemaining <= 2 && input.weeksRemaining >= 0) {
      triggers.push(`Only ${input.weeksRemaining} week(s) to race day`);
      confidence += 50;

      if (input.readinessScore >= 75) {
        triggers.push(`Readiness score is strong at ${input.readinessScore}%`);
        confidence += 25;
      }

      if (input.syncedRuns.length >= 5) {
        triggers.push('Sufficient training data for race-day pacing strategy');
        confidence += 15;
      }
    }

    if (confidence >= 50) {
      scenarios.push({ scenario: 'race_week_optimization', confidence: Math.min(confidence, 100), triggers });
    }
  }

  return scenarios.sort((a, b) => b.confidence - a.confidence);
}

// ── Recommendation Generators ─────────────────────────────────────────────────

function generateId(): string {
  return `rec-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

function formatPace(paceMinPerMi: number): string {
  if (!paceMinPerMi) return '—';
  const totalSec = Math.round(paceMinPerMi * 60);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${sec.toString().padStart(2, '0')}/mi`;
}

function buildAheadRecommendation(
  input: TrainingAnalysisInput,
  scenario: DetectedScenario,
  stats: AnalysisStats,
): AdaptiveRecommendation {
  const longRunPaceStr = stats.avgLongRunPace > 0 ? formatPace(stats.avgLongRunPace) : 'a strong pace';

  const options: RecommendationOption[] = [
    {
      key: 'increase_mileage',
      label: 'Increase weekly mileage 10%',
      description: 'Bump up your upcoming weeks by 10% to push your fitness further.',
      impact: `Next 4 weeks get a 10% mileage boost`,
      actionType: 'apply_modification',
      actionPayload: buildMileageModification(input, 1.10, 4, 'Increased mileage 10% — you earned it!'),
    },
    {
      key: 'keep_crushing',
      label: 'Keep current plan',
      description: 'Stay the course — you\'re doing great. No changes needed.',
      impact: 'No changes to your plan',
      actionType: 'dismiss',
    },
  ];

  return {
    id: generateId(),
    scenario: 'ahead_of_schedule',
    type: 'upgrade',
    priority: 'medium',
    status: 'active',
    title: "You're Crushing It — Ready for More?",
    message: `Amazing work! Your recent long runs averaged ${longRunPaceStr} and your readiness score is ${input.readinessScore}%. You're tracking ahead of schedule with ${input.weeksRemaining} weeks to go. Want to level up?`,
    reasoning: scenario.triggers.join('. ') + '.',
    options,
    dismissible: true,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
  };
}

function buildBehindRecommendation(
  input: TrainingAnalysisInput,
  scenario: DetectedScenario,
  _stats: AnalysisStats,
): AdaptiveRecommendation {
  const options: RecommendationOption[] = [
    {
      key: 'reduce_20',
      label: 'Reduce mileage 20% for 2 weeks',
      description: 'Take the pressure off. We\'ll dial back your next 2 weeks to help you rebuild momentum.',
      impact: 'Next 2 weeks reduced by 20%',
      actionType: 'apply_modification',
      actionPayload: buildMileageModification(input, 0.80, 2, 'Reduced mileage 20% — rebuilding momentum.'),
    },
    {
      key: 'add_recovery',
      label: 'Add a recovery week',
      description: 'Insert an easy recovery week with reduced volume before resuming your plan.',
      impact: 'This week becomes a recovery week (50% mileage)',
      actionType: 'apply_modification',
      actionPayload: buildMileageModification(input, 0.50, 1, 'Recovery week added — rest and recharge.'),
    },
    {
      key: 'keep_going',
      label: 'I\'ll catch up on my own',
      description: 'No plan changes — you\'ll handle it.',
      impact: 'No changes to your plan',
      actionType: 'dismiss',
    },
  ];

  const missedCount = _stats.missedKeyWorkoutsLast2Weeks;
  return {
    id: generateId(),
    scenario: 'behind_schedule',
    type: 'reduce',
    priority: 'high',
    status: 'active',
    title: "Let's Get Back on Track",
    message: `I noticed you've missed ${missedCount} key workout${missedCount !== 1 ? 's' : ''} recently and your completion rate is ${Math.round(input.recentCompletionRate * 100)}%. Life happens! Let's adjust the plan so you can build back up safely without risking injury.`,
    reasoning: scenario.triggers.join('. ') + '.',
    options,
    dismissible: true,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString(),
  };
}

function buildOvertrainingRecommendation(
  input: TrainingAnalysisInput,
  scenario: DetectedScenario,
  stats: AnalysisStats,
): AdaptiveRecommendation {
  const jumpPct = Math.round(stats.weeklyMileageChangePct * 100);
  const options: RecommendationOption[] = [
    {
      key: 'force_rest',
      label: 'Take a recovery week (30% reduction)',
      description: 'Your body needs to absorb this training. We\'ll reduce next week by 30%.',
      impact: 'Next week\'s mileage reduced by 30%',
      actionType: 'apply_modification',
      actionPayload: buildMileageModification(input, 0.70, 1, 'Recovery week — your body will thank you.'),
    },
    {
      key: 'moderate_reduction',
      label: 'Moderate reduction (15%)',
      description: 'A lighter touch — reduce just enough to recover without losing momentum.',
      impact: 'Next week reduced by 15%',
      actionType: 'apply_modification',
      actionPayload: buildMileageModification(input, 0.85, 1, 'Slight reduction — finding the balance.'),
    },
  ];

  return {
    id: generateId(),
    scenario: 'overtraining',
    type: 'rest',
    priority: 'high',
    status: 'active',
    title: 'Slow Down — Your Body Needs a Break',
    message: jumpPct > 20
      ? `Warning: Your mileage jumped ${jumpPct}% this week. The general rule is no more than 10% increase per week. This increases injury risk significantly. Let's take an easy week — your race will thank you!`
      : `You've been running ${stats.consecutiveDaysWithoutRest}+ days straight without rest and your pace is slowing. These are classic signs of accumulated fatigue. A recovery week now will make you stronger for race day.`,
    reasoning: scenario.triggers.join('. ') + '.',
    options,
    dismissible: false,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
  };
}

function buildInconsistentRecommendation(
  _input: TrainingAnalysisInput,
  scenario: DetectedScenario,
  stats: AnalysisStats,
): AdaptiveRecommendation {
  const easyPaceStr = formatPace(stats.avgEasyPace);
  const options: RecommendationOption[] = [
    {
      key: 'learn_more',
      label: 'Got it — I\'ll pace smarter',
      description: 'Acknowledge this tip and focus on differentiating easy vs. hard efforts.',
      impact: 'No plan changes — just a mindset shift',
      actionType: 'dismiss',
    },
  ];

  let message: string;
  if (stats.easyDaysTooFast) {
    message = `Your easy day average pace is ${easyPaceStr} — that's faster than most runners should go on recovery days. Easy runs should feel conversational (typically 1:30-2:00/mi slower than your race pace). Running easy days too fast means you can't go hard enough on quality days, and you accumulate fatigue faster.`;
  } else {
    message = `Your hard workout paces are very close to your easy day pace. This "gray zone" training is less effective than proper polarization. Try running easy days slower and hard days faster — the contrast is what builds fitness.`;
  }

  return {
    id: generateId(),
    scenario: 'inconsistent_execution',
    type: 'adjust_pacing',
    priority: 'medium',
    status: 'active',
    title: 'Pacing Tip: Easy Days Easy, Hard Days Hard',
    message,
    reasoning: scenario.triggers.join('. ') + '.',
    options,
    dismissible: true,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString(),
  };
}

function buildRaceWeekRecommendation(
  input: TrainingAnalysisInput,
  scenario: DetectedScenario,
  _stats: AnalysisStats,
): AdaptiveRecommendation {
  // Estimate race pace from recent training
  const recentRuns = input.syncedRuns.filter((r) => r.actualPaceMinPerMi > 0).slice(-10);
  const avgPace = recentRuns.length > 0
    ? recentRuns.reduce((s, r) => s + r.actualPaceMinPerMi, 0) / recentRuns.length
    : 0;
  // Marathon race pace is typically 5-10% slower than average training pace
  const estRacePace = avgPace > 0 ? avgPace * 1.03 : 0;
  const racePaceStr = formatPace(estRacePace);

  const options: RecommendationOption[] = [
    {
      key: 'accept_taper',
      label: 'Trust the taper',
      description: 'Follow the taper plan — reduce mileage, maintain some intensity, and arrive fresh on race day.',
      impact: 'No changes needed — your plan already has taper built in',
      actionType: 'dismiss',
    },
  ];

  return {
    id: generateId(),
    scenario: 'race_week_optimization',
    type: 'taper',
    priority: 'high',
    status: 'active',
    title: `Race Week! ${input.weeksRemaining} Week${input.weeksRemaining !== 1 ? 's' : ''} to Go`,
    message: `The finish line is near! Your readiness score is ${input.readinessScore}% — ${input.readinessScore >= 80 ? "you're in great shape" : 'solid preparation'}. ` +
      (estRacePace > 0 ? `Based on your training, a target race pace around ${racePaceStr} would be sustainable. ` : '') +
      `Remember: the taper is sacred. Trust your training, don't try anything new on race day, and start conservative — you can always speed up in the second half.`,
    reasoning: scenario.triggers.join('. ') + '.',
    options,
    dismissible: true,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
  };
}

// ── Modification Builders ─────────────────────────────────────────────────────

/** Build a PlanModification that scales mileage for upcoming weeks. */
function buildMileageModification(
  input: TrainingAnalysisInput,
  multiplier: number,
  weeksToAdjust: number,
  description: string,
): PlanModification {
  const weekAdjustments: WeekAdjustment[] = [];
  for (let i = 0; i < weeksToAdjust; i++) {
    const targetWeek = input.currentWeekIndex + 1 + i;
    if (targetWeek >= input.totalWeeks) break;
    // Safety: never increase more than 10%
    const safeMult = multiplier > 1 ? Math.min(multiplier, 1.10) : multiplier;
    weekAdjustments.push({
      weekIndex: targetWeek,
      mileageMultiplier: safeMult,
    });
  }

  return {
    id: '', // filled at apply time
    description,
    modificationType: multiplier >= 1 ? 'mileage_increase' : 'mileage_reduction',
    weekAdjustments,
    appliedAt: '',
    undone: false,
    originalSnapshot: [],
  };
}

// ── Main Analysis Pipeline ────────────────────────────────────────────────────

/**
 * Run the full analysis pipeline:
 *   1. Gather input data
 *   2. Compute statistics
 *   3. Detect scenarios
 *   4. Generate recommendations
 *   5. Persist results
 *
 * Returns the analysis result, or null if analysis cannot run.
 */
export function analyzeTrainingProgress(force = false): TrainingAnalysisResult | null {
  if (!force && !shouldRunAnalysis()) return null;

  const input = gatherAnalysisInput();
  if (!input) return null;

  // Need at least some sync data to make meaningful recommendations
  if (input.syncedRuns.length < 3 && input.daysSinceLastSync > 7) return null;

  const stats = computeStats(input);
  const detectedScenarios = detectScenarios(input, stats);
  const recommendations: AdaptiveRecommendation[] = [];

  // Safety: never suggest changes in final 7 days before race
  const isFinalWeek = input.weeksRemaining <= 0;

  for (const scenario of detectedScenarios) {
    if (scenario.confidence < 40) continue;

    // Taper lock: only race week recommendations in final week
    if (isFinalWeek && scenario.scenario !== 'race_week_optimization') continue;

    let rec: AdaptiveRecommendation | null = null;

    switch (scenario.scenario) {
      case 'ahead_of_schedule':
        rec = buildAheadRecommendation(input, scenario, stats);
        break;
      case 'behind_schedule':
        rec = buildBehindRecommendation(input, scenario, stats);
        break;
      case 'overtraining':
        rec = buildOvertrainingRecommendation(input, scenario, stats);
        break;
      case 'inconsistent_execution':
        rec = buildInconsistentRecommendation(input, scenario, stats);
        break;
      case 'race_week_optimization':
        rec = buildRaceWeekRecommendation(input, scenario, stats);
        break;
    }

    if (rec && shouldEmitRecommendation(rec.priority)) {
      recommendations.push(rec);
    }
  }

  // De-duplicate: don't show same scenario type if already active
  const active = getActiveRecommendations();
  const activeScenarios = new Set(active.map((r) => r.scenario));
  const filtered = recommendations.filter((r) => !activeScenarios.has(r.scenario));

  // Cap at 3 active recommendations
  const toAdd = filtered.slice(0, 3 - active.length);
  if (toAdd.length > 0) {
    const all = getStoredRecommendations();
    all.push(...toAdd);
    // Keep last 50 total
    if (all.length > 50) all.splice(0, all.length - 50);
    saveRecommendations(all);
  }

  // Mark analysis time
  localStorage.setItem(LAST_ANALYSIS_KEY, new Date().toISOString());

  return {
    detectedScenarios,
    recommendations: toAdd,
    stats,
  };
}

/**
 * Quick re-analyze without rate limiting.
 * Useful after a sync or when the user navigates to the dashboard.
 */
export function generateRecommendations(): AdaptiveRecommendation[] {
  const result = analyzeTrainingProgress(true);
  return result?.recommendations ?? [];
}

/** Get the count of unaddressed (active) recommendations. */
export function getRecommendationBadgeCount(): number {
  return getActiveRecommendations().length;
}

/** Expire old recommendations that have passed their expiry date. */
export function expireStaleRecommendations(): void {
  const all = getStoredRecommendations();
  const now = new Date().toISOString();
  let changed = false;
  for (const rec of all) {
    if (rec.status === 'active' && rec.expiresAt && rec.expiresAt < now) {
      rec.status = 'expired';
      trackAnalytics(rec, 'expired');
      changed = true;
    }
  }
  if (changed) saveRecommendations(all);
}
