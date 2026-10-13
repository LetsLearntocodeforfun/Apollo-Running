// Adaptive training recommendations — analyzes sync data, plan progress, and readiness
// to generate coach-style plan adjustment suggestions.

import {
  getActivePlan,
  getAllSyncMeta,
  getDateKeyForDay,
  isDayCompleted,
  getWeekDayForDate,
  getLastSyncTime,
  makePlanInstanceId,
} from './planProgress';
import type { PlanDay } from '../data/plans';
import {
  applyAdaptiveChanges,
  getEffectivePlan,
  isOverlayChangeActive,
  undoChange,
  type AdaptiveWeekChange,
} from './planOverlay';
import { getAllWeeklyMileage } from './autoSync';
import { computeCurrentReadiness } from './weeklyReadiness';
import { getSavedAdherence, getSavedPrediction, MARATHON_M, type RacePrediction } from './racePrediction';
import { getCurrentTrainingPaces, type TrainingPaces } from './paceCalculator';
import { isActivitySourceConnected } from './activitySource';
import { persistence } from './db/persistence';
import { formatMiles, formatPaceFromMinPerMi } from './unitPreferences';
import { addDays, daysBetween, todayKey } from '../utils/localDate';
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
  AnalysisPaceBands,
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

function readJsonFromStorage<T>(key: string, fallback: T): T {
  try {
    const raw = persistence.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function logNonCritical(scope: string, err: unknown): void {
  if (import.meta.env.DEV) {
    console.warn(`[Apollo Adaptive] ${scope}:`, err);
  }
}

// ── Preferences ───────────────────────────────────────────────────────────────

/** Retrieve adaptive recommendation preferences. */
export function getAdaptivePreferences(): AdaptivePreferences {
  const saved = readJsonFromStorage<Partial<AdaptivePreferences>>(PREFERENCES_KEY, {});
  return { ...DEFAULT_PREFS, ...saved };
}

/** Persist adaptive recommendation preferences. */
export function setAdaptivePreferences(prefs: Partial<AdaptivePreferences>): void {
  const current = getAdaptivePreferences();
  persistence.setItem(PREFERENCES_KEY, JSON.stringify({ ...current, ...prefs }));
}

// ── Recommendations CRUD ──────────────────────────────────────────────────────

/** Get all stored recommendations. */
function getStoredRecommendations(): AdaptiveRecommendation[] {
  return readJsonFromStorage<AdaptiveRecommendation[]>(RECOMMENDATIONS_KEY, []);
}

/** Save recommendations array. */
function saveRecommendations(recs: AdaptiveRecommendation[]): void {
  persistence.setItem(RECOMMENDATIONS_KEY, JSON.stringify(recs));
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
  return readJsonFromStorage<PlanModification[]>(MODIFICATIONS_KEY, []);
}

/** Save modifications array. */
function saveModifications(mods: PlanModification[]): void {
  persistence.setItem(MODIFICATIONS_KEY, JSON.stringify(mods));
}

/** Instance id (`${planId}@${startDate}`) of the active plan, or null. */
function activeInstanceId(): string | null {
  const active = getActivePlan();
  return active ? makePlanInstanceId(active.planId, active.startDate) : null;
}

/**
 * Apply a plan modification — adjusts upcoming weeks in the training plan.
 * Stores a snapshot of the original data for display.
 *
 * v1.0.7 (T-2): the change is written through the plan overlay as one entry
 * for the active plan *instance*, using the effective (placed) plan's week
 * numbers. The shared built-in plan object is never mutated, so the change
 * survives a reload, doesn't leak into plan previews or other instances, lands
 * on the right week after a late join, and works for custom plans.
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
  if (typeof option.actionPayload !== 'object') return null;

  const instanceId = activeInstanceId();
  if (!instanceId) return null;
  // T-2: a recommendation made for another plan instance must not edit this one.
  if (rec.planInstanceId && rec.planInstanceId !== instanceId) return null;
  const plan = getEffectivePlan();
  if (!plan) return null;

  const modification: PlanModification = { ...(option.actionPayload as PlanModification) };
  modification.appliedAt = new Date().toISOString();
  modification.undone = false;
  modification.recommendationId = recommendationId;

  // Snapshot of the effective weeks before the change (display only; undo uses the overlay).
  const originalSnapshot: WeekSnapshot[] = [];
  const changes: AdaptiveWeekChange[] = [];
  for (const adj of modification.weekAdjustments ?? []) {
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
    changes.push({
      weekIndex: adj.weekIndex,
      mileageMultiplier: adj.mileageMultiplier,
      dayOverrides: adj.dayOverrides?.map((ov) => ({
        dayIndex: ov.dayIndex,
        day: { type: ov.type, label: ov.label, distanceMi: ov.distanceMi, note: ov.note } as PlanDay,
      })),
    });
  }

  const result = applyAdaptiveChanges(changes, modification.description || 'Adaptive coaching change');
  if (!result.ok || !result.logId) return null;

  modification.originalSnapshot = originalSnapshot;
  modification.planInstanceId = result.instanceId ?? instanceId;
  modification.overlayLogIds = [result.logId];
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
 *
 * v1.0.7 (T-2): removes the modification's overlay entries from the plan
 * instance it was applied to (never edits a shared plan object). Fails when a
 * later edit changed the same days. Records from before v1.0.7 (no overlay ids)
 * were in-memory only and are gone after a reload, so they are just marked undone.
 */
export function undoRecommendation(modificationId: string): boolean {
  return undoRecommendationWithReason(modificationId).ok;
}

/** Message shown when an adaptive change can't be undone because later edits touched the same days. */
export const UNDO_BLOCKED_MESSAGE = 'Can\u2019t undo: a later change edited the same days. Undo it from the Plan screen first.';

/**
 * Same as {@link undoRecommendation}, with a user-facing reason when the undo
 * is refused (v1.0.7, T-2).
 */
export function undoRecommendationWithReason(modificationId: string): { ok: boolean; error?: string } {
  const mods = getPlanModifications();
  const mod = mods.find((m) => m.id === modificationId);
  if (!mod) return { ok: false, error: 'That adjustment could not be found.' };
  if (mod.undone) return { ok: false, error: 'That adjustment was already undone.' };

  const ids = mod.overlayLogIds ?? [];
  for (const logId of [...ids].reverse()) {
    // Already undone elsewhere (e.g. the plan's own Undo): nothing left to remove.
    if (!isOverlayChangeActive(logId, mod.planInstanceId)) continue;
    const res = undoChange(logId, mod.planInstanceId);
    if (!res.ok) return { ok: false, error: UNDO_BLOCKED_MESSAGE };
  }

  mod.undone = true;
  saveModifications(mods);
  return { ok: true };
}

/**
 * Get the most recent non-undone modification of the active plan instance
 * (v1.0.7, T-2: another instance's changes can't be undone from here).
 */
export function getLastModification(): PlanModification | null {
  const instanceId = activeInstanceId();
  const mods = getPlanModifications().filter(
    (m) => !m.undone && (!m.planInstanceId || m.planInstanceId === instanceId),
  );
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
    const entries = readJsonFromStorage<RecommendationAnalytics[]>(ANALYTICS_KEY, []);
    entries.push({
      recommendationId: rec.id,
      scenario: rec.scenario,
      type: rec.type,
      action,
      selectedOptionKey,
      timestamp: new Date().toISOString(),
    });
    // Keep last 2000 entries (IndexedDB has ample capacity)
    if (entries.length > 2000) entries.splice(0, entries.length - 2000);
    persistence.setItem(ANALYTICS_KEY, JSON.stringify(entries));
  } catch (err) {
    logNonCritical('trackAnalytics failed', err);
  }
}

/** Retrieve analytics history. */
export function getAnalyticsHistory(): RecommendationAnalytics[] {
  return readJsonFromStorage<RecommendationAnalytics[]>(ANALYTICS_KEY, []);
}

// ── Rate-Limiting ─────────────────────────────────────────────────────────────

/** Check whether enough time has passed since the last analysis. */
function shouldRunAnalysis(): boolean {
  const prefs = getAdaptivePreferences();
  if (!prefs.enabled) return false;

  const last = persistence.getItem(LAST_ANALYSIS_KEY);
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

  // v1.0.6: the effective plan (athlete + adaptive overlay applied, read-only).
  const plan = getEffectivePlan();
  if (!plan) return null;

  const today = todayKey();
  const pos = getWeekDayForDate(activePlan.startDate, plan.totalWeeks, today);
  if (!pos) return null;

  const planId = activePlan.planId;
  const allMeta = getAllSyncMeta(planId);
  const allMileage = getAllWeeklyMileage(planId);
  // V5: readiness of the days due so far (the previous week until 3 workouts of this one are due).
  const readiness = computeCurrentReadiness({ today, minDueDays: 3 });
  const adherence = getSavedAdherence();
  const lastSync = getLastSyncTime();
  const dataSourceConnected = isActivitySourceConnected();

  // Build synced run data (cross-training days have no run pace to analyze)
  const syncedRuns: SyncedRunData[] = allMeta.filter((m) => !m.meta.crossTraining).map((m) => {
    const day = plan.weeks[m.weekIndex]?.days[m.dayIndex];
    return {
      weekIndex: m.weekIndex,
      dayIndex: m.dayIndex,
      actualDistanceMi: m.meta.actualDistanceMi,
      actualPaceMinPerMi: m.meta.actualPaceMinPerMi,
      plannedDistanceMi: day?.distanceMi ?? 0,
      plannedNote: day?.note ?? '',
      movingTimeSec: m.meta.movingTimeSec,
      // Syncs backfill the whole plan, so prefer the activity's own date.
      date: m.meta.activityDate ?? getDateKeyForDay(activePlan.startDate, m.weekIndex, m.dayIndex),
    };
  }).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  // Weekly mileage
  const weeklyMileage = allMileage.map((wm) => ({
    weekIndex: wm.weekIndex,
    plannedMi: wm.plannedMi,
    actualMi: wm.actualMi,
  }));

  // V5: only days that are due count — dated before today, or already done.
  // Weeks skipped when joining the plan late don't count either.
  const joined = activePlan.joinedWeekIndex;
  const firstWeek = typeof joined === 'number' && Number.isInteger(joined) && joined > 0 ? Math.min(joined, pos.weekIndex) : 0;
  const recentWeekStart = Math.max(firstWeek, pos.weekIndex - 1);
  let recentScheduled = 0;
  let recentCompleted = 0;
  let totalScheduled = 0;
  let totalCompleted = 0;
  for (let w = firstWeek; w <= pos.weekIndex; w++) {
    const week = plan.weeks[w];
    if (!week) continue;
    for (let d = 0; d < week.days.length; d++) {
      if (week.days[d].type === 'rest') continue;
      const done = isDayCompleted(planId, w, d);
      const past = daysBetween(getDateKeyForDay(activePlan.startDate, w, d), today) > 0;
      if (!past && !done) continue; // not due yet
      totalScheduled++;
      if (done) totalCompleted++;
      if (w >= recentWeekStart) {
        recentScheduled++;
        if (done) recentCompleted++;
      }
    }
  }

  // Days since last sync
  let daysSinceLastSync = 999;
  if (lastSync) {
    daysSinceLastSync = Math.floor(
      (Date.now() - new Date(lastSync).getTime()) / (1000 * 60 * 60 * 24),
    );
  }

  return {
    planId,
    startDate: activePlan.startDate,
    totalWeeks: plan.totalWeeks,
    currentWeekIndex: pos.weekIndex,
    currentDayIndex: pos.dayIndex,
    weeksRemaining: plan.totalWeeks - pos.weekIndex - 1,
    // Nothing due yet → nothing missed.
    recentCompletionRate: recentScheduled > 0 ? recentCompleted / recentScheduled : 1,
    overallCompletionRate: totalScheduled > 0 ? totalCompleted / totalScheduled : 1,
    weeklyMileage,
    syncedRuns,
    // v1.0.7 (L-7): the athlete's own VDOT pace bands (null without a VDOT source).
    paces: readPaceBands(),
    readinessScore: readiness?.score ?? 0,
    adherenceScore: adherence?.score ?? 0,
    daysSinceLastSync,
    dataSourceConnected,
    today,
    joinedWeekIndex: firstWeek,
    recentScheduledDays: recentScheduled,
    overallScheduledDays: totalScheduled,
  };
}

// ── Pace bands, plan-relative load and spikes (v1.0.7: L-5, L-7, L-8) ────────

/** L-7: easy runs count as too fast only when this much (min/mi) faster than the fast end of the easy band. */
const EASY_FAST_TOLERANCE_MIN = 10 / 60;
/** L-5: flag a week only when actual mileage exceeds the PLANNED mileage by more than this share... */
export const OVER_PLAN_THRESHOLD = 0.15;
/** ...and by at least this many miles (small weeks). */
const OVER_PLAN_MIN_MILES = 2;
/** L-5: a single run longer than this × the longest run of the previous 30 days is a spike (Frandsen 2025). */
export const RUN_SPIKE_RATIO = 1.1;
const METERS_PER_MILE = 1609.344;

/** v1.0.7 (L-7): VDOT pace bands in min/mi from training paces (sec/mi), or null. */
export function paceBandsFromTrainingPaces(p: TrainingPaces | null | undefined): AnalysisPaceBands | null {
  if (!p || !(p.vdot > 0) || !(p.easy?.min > 0) || !(p.easy?.max > 0) || !(p.marathon > 0)) return null;
  return {
    vdot: p.vdot,
    easyFastMinPerMi: p.easy.min / 60,
    easySlowMinPerMi: p.easy.max / 60,
    marathonMinPerMi: p.marathon / 60,
    thresholdMinPerMi: p.threshold / 60,
  };
}

function readPaceBands(): AnalysisPaceBands | null {
  try {
    return paceBandsFromTrainingPaces(getCurrentTrainingPaces());
  } catch {
    return null;
  }
}

/**
 * v1.0.7 (L-7): easy runs are too fast when they average faster than the fast
 * end of the athlete's own Daniels easy band (minus a small tolerance), not a
 * fixed 8:30/mi. Without a VDOT source nothing is flagged.
 */
export function isEasyPaceTooFast(avgEasyPace: number, bands?: AnalysisPaceBands | null): boolean {
  return !!bands && avgEasyPace > 0 && avgEasyPace < bands.easyFastMinPerMi - EASY_FAST_TOLERANCE_MIN;
}

/**
 * v1.0.7 (L-7): long runs are "ahead" when they average faster than the fast
 * end of the athlete's easy band (long runs are run at easy effort), not a fixed
 * 9:30/mi. Without a VDOT source nothing is flagged.
 */
export function isLongRunPaceAhead(avgLongPace: number, bands?: AnalysisPaceBands | null): boolean {
  return !!bands && avgLongPace > 0 && avgLongPace < bands.easyFastMinPerMi;
}

/** A plan week whose actual mileage is well above what the plan prescribed. */
export interface OverPlanWeek {
  weekIndex: number;
  plannedMi: number;
  actualMi: number;
  /** (actual − planned) ÷ planned. */
  overPct: number;
}

/**
 * v1.0.7 (L-5): the current or previous plan week when actual mileage exceeds
 * the planned mileage by more than {@link OVER_PLAN_THRESHOLD}. A week-over-week
 * jump the plan itself prescribes (e.g. after a cutback week) is never flagged.
 */
export function findOverPlanWeek(
  weekly: { weekIndex: number; plannedMi: number; actualMi: number }[],
  currentWeekIndex: number,
): OverPlanWeek | null {
  for (const wi of [currentWeekIndex, currentWeekIndex - 1]) {
    const w = weekly.find((x) => x.weekIndex === wi);
    if (!w || !(w.plannedMi > 0)) continue;
    const over = w.actualMi - w.plannedMi;
    const overPct = over / w.plannedMi;
    if (overPct > OVER_PLAN_THRESHOLD && over >= OVER_PLAN_MIN_MILES) {
      return { weekIndex: wi, plannedMi: w.plannedMi, actualMi: w.actualMi, overPct };
    }
  }
  return null;
}

/** A single run much longer than anything in the previous 30 days. */
export interface RunSpike {
  date: string;
  distanceMi: number;
  longestPrior30Mi: number;
  ratio: number;
  /** True when the run also went more than 10 % beyond its planned distance (or was unplanned). */
  beyondPlan: boolean;
}

/**
 * v1.0.7 (L-5): the largest single-run spike in the last 7 days, i.e. a run more than
 * {@link RUN_SPIKE_RATIO} × the longest run in the 30 days before it. Needs at
 * least one earlier run in that window.
 */
export function findRunSpike(runs: SyncedRunData[], today: string): RunSpike | null {
  const recentFrom = addDays(today, -7);
  let best: RunSpike | null = null;
  for (const r of runs) {
    if (!(r.actualDistanceMi > 0) || r.date <= recentFrom || r.date > today) continue;
    const windowFrom = addDays(r.date, -30);
    let longest = 0;
    for (const p of runs) {
      if (p.date >= windowFrom && p.date < r.date && p.actualDistanceMi > longest) longest = p.actualDistanceMi;
    }
    if (!(longest > 0)) continue;
    const ratio = r.actualDistanceMi / longest;
    if (ratio <= RUN_SPIKE_RATIO) continue;
    if (!best || ratio > best.ratio) {
      best = {
        date: r.date,
        distanceMi: r.actualDistanceMi,
        longestPrior30Mi: longest,
        ratio,
        beyondPlan: !(r.plannedDistanceMi > 0) || r.actualDistanceMi > r.plannedDistanceMi * 1.1,
      };
    }
  }
  return best;
}

/** A marathon goal-pace range (min/mi) and what it came from. */
export interface RacePaceRange {
  fastMinPerMi: number;
  slowMinPerMi: number;
  basis: 'prediction' | 'vdot';
}

/**
 * v1.0.7 (L-8): race-week pace advice as a RANGE from the predicted marathon
 * time (its likely range, else ±2 %), falling back to VDOT marathon pace ±2 %.
 * Never derived from average training pace. Null when neither exists.
 */
export function raceWeekPaceRange(
  bands: AnalysisPaceBands | null | undefined,
  prediction: Pick<RacePrediction, 'marathonTimeSec' | 'rangeLowSec' | 'rangeHighSec'> | null | undefined,
): RacePaceRange | null {
  const miles = MARATHON_M / METERS_PER_MILE;
  if (prediction && prediction.marathonTimeSec > 0) {
    const lo = prediction.rangeLowSec && prediction.rangeLowSec > 0 ? prediction.rangeLowSec : prediction.marathonTimeSec * 0.98;
    const hi = prediction.rangeHighSec && prediction.rangeHighSec > 0 ? prediction.rangeHighSec : prediction.marathonTimeSec * 1.02;
    return { fastMinPerMi: Math.min(lo, hi) / 60 / miles, slowMinPerMi: Math.max(lo, hi) / 60 / miles, basis: 'prediction' };
  }
  if (bands && bands.marathonMinPerMi > 0) {
    return { fastMinPerMi: bands.marathonMinPerMi * 0.98, slowMinPerMi: bands.marathonMinPerMi * 1.02, basis: 'vdot' };
  }
  return null;
}

/** Stats used internally (adds plan-relative load and spikes to {@link AnalysisStats}). */
type AdaptiveStats = AnalysisStats & {
  /** L-5: a week run well above its planned mileage. */
  overPlan: OverPlanWeek | null;
  /** L-5: a single-run spike in the last 7 days. */
  runSpike: RunSpike | null;
};

// ── Analysis Engine ───────────────────────────────────────────────────────────

/** Compute summary statistics from the input data. */
function computeStats(input: TrainingAnalysisInput): AdaptiveStats {
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

  // Consecutive days without rest — completed days only (V6: planned runs that
  // haven't happened yet are not training).
  let consecutiveDaysWithoutRest = 0;
  const activePlan = getActivePlan();
  const plan = activePlan ? getEffectivePlan() : null;
  if (plan && activePlan) {
    for (let d = input.currentWeekIndex * 7 + input.currentDayIndex; d >= 0; d--) {
      const wi = Math.floor(d / 7);
      const di = d % 7;
      const day = plan.weeks[wi]?.days[di];
      if (!day) break;
      if (day.type !== 'rest' && isDayCompleted(activePlan.planId, wi, di)) {
        consecutiveDaysWithoutRest++;
      } else if (d < input.currentWeekIndex * 7 + input.currentDayIndex) {
        break; // today may still be ahead; any earlier gap ends the streak
      }
    }
  }

  // Missed key workouts in last 2 weeks
  let missedKeyWorkoutsLast2Weeks = 0;
  if (plan && activePlan) {
    const today = input.today ?? todayKey();
    const startW = Math.max(input.joinedWeekIndex ?? 0, input.currentWeekIndex - 1);
    for (let w = startW; w <= input.currentWeekIndex; w++) {
      const week = plan.weeks[w];
      if (!week) continue;
      for (let d = 0; d < week.days.length; d++) {
        const day = week.days[d];
        const note = (day.note ?? '').toLowerCase();
        const isKey = note === 'long' || note === 'tempo' || note === 'speed';
        if (isKey && !isDayCompleted(activePlan.planId, w, d)) {
          // V5: only count it once its date has passed (today's workout isn't missed)
          if (daysBetween(getDateKeyForDay(activePlan.startDate, w, d), today) > 0) {
            missedKeyWorkoutsLast2Weeks++;
          }
        }
      }
    }
  }

  // Pacing analysis: easy days too fast? v1.0.7 (L-7): judged against the
  // athlete's own VDOT easy band instead of a fixed 8:30/mi.
  const easyDaysTooFast = isEasyPaceTooFast(avgEasyPace, input.paces);

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
    // L-5: plan-relative load and single-run spikes.
    overPlan: findOverPlanWeek(input.weeklyMileage, input.currentWeekIndex),
    runSpike: findRunSpike(input.syncedRuns, input.today ?? todayKey()),
  };
}

function detectAheadOfSchedule(
  input: TrainingAnalysisInput,
  aggrFactor: number,
): DetectedScenario | null {
  const triggers: string[] = [];
  let confidence = 0;

  const longRuns = input.syncedRuns.filter(
    (r) => r.plannedNote.toLowerCase() === 'long' && r.actualPaceMinPerMi > 0,
  );
  if (longRuns.length >= 4) {
    const recentLong = longRuns.slice(-4);
    const avgPace = recentLong.reduce((s, r) => s + r.actualPaceMinPerMi, 0) / recentLong.length;
    // v1.0.7 (L-7): faster than the athlete's own easy band, not a fixed 9:30/mi.
    if (isLongRunPaceAhead(avgPace, input.paces)) {
      triggers.push(
        `Last ${recentLong.length} long runs averaged ${formatPaceFromMinPerMi(avgPace)}, faster than your easy range (from ${formatPaceFromMinPerMi(input.paces!.easyFastMinPerMi)})`,
      );
      confidence += 30;
    }
  }

  if (input.readinessScore > 85 * aggrFactor && input.weeksRemaining >= 6) {
    triggers.push(`Readiness score ${input.readinessScore}% with ${input.weeksRemaining} weeks remaining`);
    confidence += 30;
  }

  if (input.adherenceScore > 85) {
    triggers.push(`Training adherence is ${input.adherenceScore}% — excellent consistency`);
    confidence += 20;
  }

  const overAchievers = input.syncedRuns.filter(
    (r) => r.plannedDistanceMi > 0 && r.actualDistanceMi > r.plannedDistanceMi * 1.1,
  );
  if (overAchievers.length >= 3) {
    triggers.push(`${overAchievers.length} runs exceeded plan distance by 10%+`);
    confidence += 20;
  }

  if (confidence < 40) return null;
  return { scenario: 'ahead_of_schedule', confidence: Math.min(confidence, 100), triggers };
}

function detectBehindSchedule(
  input: TrainingAnalysisInput,
  stats: AnalysisStats,
  aggrFactor: number,
): DetectedScenario | null {
  const triggers: string[] = [];
  let confidence = 0;

  if (stats.missedKeyWorkoutsLast2Weeks >= 3) {
    triggers.push(`Missed ${stats.missedKeyWorkoutsLast2Weeks} key workouts in the last 2 weeks`);
    confidence += 35;
  }

  if (stats.last2WeeksCompletionRate < 0.70 * aggrFactor) {
    triggers.push(
      `Completion rate is ${Math.round(stats.last2WeeksCompletionRate * 100)}% over the last 2 weeks`,
    );
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

  if (confidence < 40) return null;
  return { scenario: 'behind_schedule', confidence: Math.min(confidence, 100), triggers };
}

function detectOvertraining(input: TrainingAnalysisInput, stats: AdaptiveStats): DetectedScenario | null {
  const triggers: string[] = [];
  let confidence = 0;

  // v1.0.7 (L-5): compare actual mileage with what the PLAN prescribed, not with
  // last week. A jump the plan itself schedules (e.g. after a cutback) is fine.
  if (stats.overPlan) {
    const o = stats.overPlan;
    triggers.push(
      `Week ${o.weekIndex + 1}: ${formatMiles(o.actualMi)} run vs ${formatMiles(o.plannedMi)} planned (+${Math.round(o.overPct * 100)}%)`,
    );
    confidence += 35;
  }

  // L-5: single-run spike (> 110 % of the longest run in the previous 30 days).
  // On its own it only triggers when the run also went beyond its planned distance.
  if (stats.runSpike) {
    const s = stats.runSpike;
    triggers.push(
      `A ${formatMiles(s.distanceMi)} run on ${s.date} was ${Math.round((s.ratio - 1) * 100)}% longer than your longest run in the previous 30 days (${formatMiles(s.longestPrior30Mi)})`,
    );
    confidence += s.beyondPlan ? 35 : 20;
  }

  if (stats.consecutiveDaysWithoutRest >= 7) {
    triggers.push(`${stats.consecutiveDaysWithoutRest} consecutive days without a rest day`);
    confidence += 30;
  }

  const recentRuns = input.syncedRuns.slice(-6);
  const olderRuns = input.syncedRuns.slice(-12, -6);
  if (recentRuns.length >= 3 && olderRuns.length >= 3) {
    const recentAvgPace = recentRuns.reduce((s, r) => s + r.actualPaceMinPerMi, 0) / recentRuns.length;
    const olderAvgPace = olderRuns.reduce((s, r) => s + r.actualPaceMinPerMi, 0) / olderRuns.length;
    if (recentAvgPace > olderAvgPace * 1.05 && olderAvgPace > 0) {
      triggers.push(
        `Average pace slowed ${Math.round(((recentAvgPace - olderAvgPace) / olderAvgPace) * 100)}% — possible fatigue`,
      );
      confidence += 25;
    }
  }

  if (confidence < 35) return null;
  return { scenario: 'overtraining', confidence: Math.min(confidence, 100), triggers };
}

function detectInconsistentExecution(
  input: TrainingAnalysisInput,
  stats: AnalysisStats,
): DetectedScenario | null {
  const triggers: string[] = [];
  let confidence = 0;

  if (stats.easyDaysTooFast) {
    triggers.push(
      `Easy day pace (${formatPaceFromMinPerMi(stats.avgEasyPace)}) is too fast — should be conversational effort`,
    );
    confidence += 35;
  }

  if (stats.hardDaysTooSlow) {
    triggers.push('Hard workout paces are nearly the same as easy paces — not enough distinction');
    confidence += 30;
  }

  const offTarget = input.syncedRuns.filter(
    (r) =>
      r.plannedDistanceMi > 0 &&
      Math.abs(r.actualDistanceMi - r.plannedDistanceMi) / r.plannedDistanceMi > 0.2,
  );
  if (offTarget.length >= 4) {
    triggers.push(`${offTarget.length} workouts were 20%+ off planned distance`);
    confidence += 25;
  }

  if (confidence < 35) return null;
  return { scenario: 'inconsistent_execution', confidence: Math.min(confidence, 100), triggers };
}

function detectRaceWeekOptimization(input: TrainingAnalysisInput): DetectedScenario | null {
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

  if (confidence < 50) return null;
  return { scenario: 'race_week_optimization', confidence: Math.min(confidence, 100), triggers };
}

/** Detect which training scenarios are present. */
function detectScenarios(
  input: TrainingAnalysisInput,
  stats: AdaptiveStats,
): DetectedScenario[] {
  const scenarios: DetectedScenario[] = [];
  const prefs = getAdaptivePreferences();
  const aggrFactor =
    prefs.aggressiveness === 'aggressive' ? 0.8 : prefs.aggressiveness === 'conservative' ? 1.2 : 1.0;

  const ahead = detectAheadOfSchedule(input, aggrFactor);
  if (ahead) scenarios.push(ahead);

  const behind = detectBehindSchedule(input, stats, aggrFactor);
  if (behind) scenarios.push(behind);

  const overtraining = detectOvertraining(input, stats);
  if (overtraining) scenarios.push(overtraining);

  const inconsistent = detectInconsistentExecution(input, stats);
  if (inconsistent) scenarios.push(inconsistent);

  const raceWeek = detectRaceWeekOptimization(input);
  if (raceWeek) scenarios.push(raceWeek);

  return scenarios.sort((a, b) => b.confidence - a.confidence);
}

// ── Recommendation Generators ─────────────────────────────────────────────────

function generateId(): string {
  return `rec-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

function buildAheadRecommendation(
  input: TrainingAnalysisInput,
  scenario: DetectedScenario,
  stats: AnalysisStats,
): AdaptiveRecommendation | null {
  const longRunPaceStr = stats.avgLongRunPace > 0 ? formatPaceFromMinPerMi(stats.avgLongRunPace) : 'a strong pace';

  // v1.0.7 (L-6): never offer more mileage inside the taper (last 3 weeks before race week).
  const modification = buildMileageModification(input, 1.10, 4, 'Increased mileage 10% — you earned it!');
  const weeksBoosted = modification.weekAdjustments.length;
  if (weeksBoosted === 0) return null;

  const options: RecommendationOption[] = [
    {
      key: 'increase_mileage',
      label: 'Increase weekly mileage 10%',
      description: 'Bump up your upcoming weeks by 10% to push your fitness further. Your taper stays untouched.',
      impact: `Next ${weeksBoosted} week${weeksBoosted === 1 ? '' : 's'} get a 10% mileage boost`,
      actionType: 'apply_modification',
      actionPayload: modification,
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
      impact: 'Next week becomes a recovery week (50% mileage)',
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
  stats: AdaptiveStats,
): AdaptiveRecommendation {
  // v1.0.7 (L-5): the message names what actually fired (over plan / single-run spike).
  let message: string;
  if (stats.overPlan) {
    const o = stats.overPlan;
    message = `You've run ${formatMiles(o.actualMi)} in week ${o.weekIndex + 1}, ${Math.round(o.overPct * 100)}% more than the ${formatMiles(o.plannedMi)} your plan prescribes. Going well beyond the plan is what raises injury risk, so let's absorb it with a lighter week.`;
  } else if (stats.runSpike) {
    const s = stats.runSpike;
    message = `Your ${formatMiles(s.distanceMi)} run was ${Math.round((s.ratio - 1) * 100)}% longer than anything in the previous 30 days (${formatMiles(s.longestPrior30Mi)}). Single runs more than 10% longer than your recent longest are linked to running injuries, so keep the next few days easy.`;
  } else {
    message = `You've been running ${stats.consecutiveDaysWithoutRest}+ days straight without rest and your pace is slowing. These are classic signs of accumulated fatigue. A recovery week now will make you stronger for race day.`;
  }
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
    message,
    reasoning: scenario.triggers.join('. ') + '.',
    options,
    dismissible: true,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
  };
}

function buildInconsistentRecommendation(
  input: TrainingAnalysisInput,
  scenario: DetectedScenario,
  stats: AnalysisStats,
): AdaptiveRecommendation {
  const easyPaceStr = formatPaceFromMinPerMi(stats.avgEasyPace);
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
    // v1.0.7 (L-7): compare with the athlete's own easy range.
    const band = input.paces
      ? ` Your easy range from your current fitness (VDOT ${Math.round(input.paces.vdot)}) is ${formatPaceFromMinPerMi(input.paces.easyFastMinPerMi)}–${formatPaceFromMinPerMi(input.paces.easySlowMinPerMi)}.`
      : '';
    message = `Your easy day average pace is ${easyPaceStr}, faster than your easy range.${band} Easy runs should feel conversational. Running easy days too fast means you can't go hard enough on quality days, and you accumulate fatigue faster.`;
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
  // v1.0.7 (L-8): race pace from the predicted marathon time (or VDOT marathon
  // pace) as a range, never average training pace × 1.03.
  let prediction: RacePrediction | null = null;
  try { prediction = getSavedPrediction(); } catch { prediction = null; }
  const range = raceWeekPaceRange(input.paces, prediction);
  const paceAdvice = range
    ? `Based on your ${range.basis === 'prediction' ? 'predicted marathon time' : 'current fitness (VDOT)'}, goal pace is around ${formatPaceFromMinPerMi(range.fastMinPerMi)}–${formatPaceFromMinPerMi(range.slowMinPerMi)}. Start at the slower end. `
    : '';

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
      paceAdvice +
      `Remember: the taper is sacred. Trust your training, don't try anything new on race day, and start conservative — you can always speed up in the second half.`,
    reasoning: scenario.triggers.join('. ') + '.',
    options,
    dismissible: true,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
  };
}

// ── Modification Builders ─────────────────────────────────────────────────────

/**
 * v1.0.7 (L-6): weeks before race week that are protected from any mileage
 * increase. Tapers cut volume over the final ~2–3 weeks (Bosquet 2007), so
 * coaching must never add mileage there.
 */
export const NO_INCREASE_WEEKS_BEFORE_RACE = 3;

/** Last plan week (0-based) that a mileage increase may touch, or -1 if none. */
export function lastIncreasableWeek(totalWeeks: number): number {
  // The race week is totalWeeks - 1; protect it and the NO_INCREASE_WEEKS_BEFORE_RACE weeks before it.
  return totalWeeks - 1 - NO_INCREASE_WEEKS_BEFORE_RACE - 1;
}

/** Build a PlanModification that scales mileage for upcoming weeks. */
function buildMileageModification(
  input: TrainingAnalysisInput,
  multiplier: number,
  weeksToAdjust: number,
  description: string,
): PlanModification {
  const weekAdjustments: WeekAdjustment[] = [];
  const increaseLimit = lastIncreasableWeek(input.totalWeeks);
  for (let i = 0; i < weeksToAdjust; i++) {
    const targetWeek = input.currentWeekIndex + 1 + i;
    if (targetWeek >= input.totalWeeks) break;
    // L-6: increases never reach into the taper or race week.
    if (multiplier > 1 && targetWeek > increaseLimit) break;
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
      // T-2: key the recommendation to the plan instance it was made for.
      rec.planInstanceId = makePlanInstanceId(input.planId, input.startDate);
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
    // Keep last 500 total (IndexedDB has ample capacity)
    if (all.length > 500) all.splice(0, all.length - 500);
    saveRecommendations(all);
  }

  // Mark analysis time
  persistence.setItem(LAST_ANALYSIS_KEY, new Date().toISOString());

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
