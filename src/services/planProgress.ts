/**
 * Persist which plan is active, start date, and day-by-day completion.
 *
 * v1.0.6:
 * - All plan-grid date math goes through `src/utils/localDate.ts` (calendar-day
 *   arithmetic on date keys), so DST transitions can never shift a plan day (V3).
 * - Race-date-first placement with Monday semantics (`placePlan` / `startPlan`, V4).
 * - Plan-instance scoping (`${planId}@${startDate}`): starting a new instance of a
 *   plan clears that plan's stale completions, sync meta and overlay (V18).
 */

import { persistence } from './db/persistence';
import { getPlanById } from '../data/plans';
import type { DayType, TrainingPlan } from '../data/plans';
import {
  addDays,
  dateKeyFromLocalIso,
  daysBetween,
  isDateKey,
  mondayOf,
  parseDateKey,
  toDateKey,
  todayKey,
  weekdayMon0,
} from '../utils/localDate';
import { emitPlanEvent, PLAN_OVERLAY_CHANGED_EVENT, PLAN_PROGRESS_CHANGED_EVENT } from './planEvents';

const ACTIVE_PLAN_KEY = 'apollo_active_plan';
const COMPLETED_DAYS_KEY = 'apollo_completed_days';
const WELCOME_COMPLETED_KEY = 'apollo_welcome_completed';
/** planId → instanceId that the stored completions / sync meta belong to. */
const INSTANCE_MARKS_KEY = 'apollo_plan_instance_marks';
/**
 * Storage key of the per-instance plan overlay (owned by `planOverlay.ts`; defined
 * here so the new-instance rule can clear it without an import cycle).
 */
export const PLAN_OVERLAY_STORAGE_KEY = 'apollo_plan_overlay';

const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

export interface ActivePlan {
  planId: string;
  /** YYYY-MM-DD. Day index 0 of week 0; a Monday for plans started with `startPlan`. */
  startDate: string;
  /** YYYY-MM-DD goal race date. Set by `startPlan`; derived from the plan when absent. */
  raceDate?: string;
  /** First week (0-based) the athlete actually trains — weeks before it were skipped. */
  joinedWeekIndex?: number;
  /** ISO timestamp the instance was started (absent on plans started by ≤ 1.0.5). */
  startedAt?: string;
}

/** A position in the plan grid (0-based week, day 0 = Monday … 6 = Sunday). */
export interface PlanDayRef {
  weekIndex: number;
  dayIndex: number;
}

/** Retrieve the currently active training plan, or null if none selected. */
export function getActivePlan(): ActivePlan | null {
  try {
    const raw = persistence.getItem(ACTIVE_PLAN_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ActivePlan | null;
    if (!parsed || typeof parsed.planId !== 'string' || typeof parsed.startDate !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Set or clear the active training plan (raw setter — no placement and no
 * instance clean-up). Prefer {@link startPlan} for starting a plan.
 */
export function setActivePlan(plan: ActivePlan | null): void {
  if (plan) persistence.setItem(ACTIVE_PLAN_KEY, JSON.stringify(plan));
  else persistence.removeItem(ACTIVE_PLAN_KEY);
  emitPlanEvent(PLAN_OVERLAY_CHANGED_EVENT, { reason: 'active-plan' });
}

/** Instance id of a plan start: `${planId}@${startDate}`. */
export function makePlanInstanceId(planId: string, startDate: string): string {
  return `${planId}@${startDate}`;
}

/** Instance id of the active plan (`${planId}@${startDate}`), or null when no plan is active. */
export function getActivePlanInstanceId(): string | null {
  const active = getActivePlan();
  return active ? makePlanInstanceId(active.planId, active.startDate) : null;
}

/** Completed set is stored as "planId:weekIndex:dayIndex" for the active plan. */
function getCompletedSet(): Set<string> {
  try {
    const raw = persistence.getItem(COMPLETED_DAYS_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set();
  }
}

function saveCompletedSet(set: Set<string>): void {
  persistence.setItem(COMPLETED_DAYS_KEY, JSON.stringify([...set]));
}

function key(planId: string, weekIndex: number, dayIndex: number): string {
  return `${planId}:${weekIndex}:${dayIndex}`;
}

/**
 * Normalise a stored start date to a valid date key. Values written by old
 * versions are plain keys; anything ISO-like is cut to its local date part.
 */
function normalizeStartKey(startDate: string): string {
  if (isDateKey(startDate)) return startDate;
  const fromIso = dateKeyFromLocalIso(startDate);
  if (fromIso) return fromIso;
  const parsed = new Date(startDate);
  return Number.isNaN(parsed.getTime()) ? todayKey() : toDateKey(parsed);
}

/** Check whether a specific day in the plan has been completed. */
export function isDayCompleted(planId: string, weekIndex: number, dayIndex: number): boolean {
  return getCompletedSet().has(key(planId, weekIndex, dayIndex));
}

/** Mark a specific day as completed or incomplete. */
export function setDayCompleted(planId: string, weekIndex: number, dayIndex: number, completed: boolean): void {
  const set = getCompletedSet();
  const k = key(planId, weekIndex, dayIndex);
  const had = set.has(k);
  if (completed) set.add(k);
  else set.delete(k);
  saveCompletedSet(set);
  if (had !== completed) emitPlanEvent(PLAN_PROGRESS_CHANGED_EVENT, { planId, weekIndex, dayIndex, completed });
}

/** Toggle completion status for a day and return the new state. */
export function toggleDayCompleted(planId: string, weekIndex: number, dayIndex: number): boolean {
  const next = !isDayCompleted(planId, weekIndex, dayIndex);
  setDayCompleted(planId, weekIndex, dayIndex, next);
  return next;
}

/** Count completed days for a plan (only keys matching planId). */
export function getCompletedCount(planId: string): number {
  const set = getCompletedSet();
  let n = 0;
  set.forEach((k) => {
    if (k.startsWith(planId + ':')) n++;
  });
  return n;
}

/** Why a plan day's completion can't be toggled by the athlete. */
export type DayToggleBlockReason = 'future' | 'rest';

/** Result of {@link canToggleDayCompletion}. */
export interface DayToggleCheck {
  allowed: boolean;
  reason?: DayToggleBlockReason;
  /** Short explanation for a tooltip / aria-description when blocked. */
  message?: string;
}

/**
 * Whether the athlete may tick (or untick) a plan day by hand (S4). Pure — call
 * it in the UI before `toggleDayCompleted`.
 * - Removing an existing completion is always allowed (it also cleans up ticks
 *   that older versions let through on future days).
 * - Days after `today` can't be ticked.
 * - Rest days (including skipped days) can't be ticked.
 *
 * Auto-sync isn't subject to this: flexible matching may complete a later day of
 * the same week when the workout was run early.
 */
export function canToggleDayCompletion(
  startDate: string,
  weekIndex: number,
  dayIndex: number,
  opts: { completed?: boolean; dayType?: DayType | null; today?: string } = {},
): DayToggleCheck {
  if (opts.completed) return { allowed: true };
  if (opts.dayType === 'rest') {
    return { allowed: false, reason: 'rest', message: 'Rest days don’t need to be marked done.' };
  }
  const today = opts.today && isDateKey(opts.today) ? opts.today : todayKey();
  const dateKey = getDateKeyForDay(startDate, weekIndex, dayIndex);
  if (daysBetween(today, dateKey) > 0) {
    return { allowed: false, reason: 'future', message: 'You can mark this workout done on or after its day.' };
  }
  return { allowed: true };
}

/** Local date key (YYYY-MM-DD) of a given week/day (0-based) from plan start. DST-safe. */
export function getDateKeyForDay(startDate: string, weekIndex: number, dayIndex: number): string {
  return addDays(normalizeStartKey(startDate), weekIndex * 7 + dayIndex);
}

/** Date (local midnight) for a given week/day (0-based) from plan start. DST-safe. */
export function getDateForDay(startDate: string, weekIndex: number, dayIndex: number): Date {
  return parseDateKey(getDateKeyForDay(startDate, weekIndex, dayIndex));
}

/**
 * Week and day index (0-based) for a given date (a Date in local time or a
 * YYYY-MM-DD key), or null if before start or after plan end. DST-safe: works on
 * calendar days, never on millisecond differences.
 */
export function getWeekDayForDate(
  startDate: string,
  totalWeeks: number,
  date: Date | string,
): { weekIndex: number; dayIndex: number } | null {
  const dateKey = typeof date === 'string' ? (dateKeyFromLocalIso(date) ?? null) : toDateKey(date);
  if (!dateKey) return null;
  const diffDays = daysBetween(normalizeStartKey(startDate), dateKey);
  if (diffDays < 0) return null;
  const totalDays = totalWeeks * 7;
  if (diffDays >= totalDays) return null;
  const weekIndex = Math.floor(diffDays / 7);
  const dayIndex = diffDays % 7;
  return { weekIndex, dayIndex };
}

/** Format a Date as a local YYYY-MM-DD string (no UTC drift). */
export function formatDateKey(date: Date): string {
  return toDateKey(date);
}

// ── Race day & placement (V4) ───────────────────────────────────────────────

/**
 * Grid position of the plan's goal race: the last `marathon` day; else the last
 * `race` day of the final week; else the final day of the plan.
 */
export function getRaceDayRef(plan: TrainingPlan): PlanDayRef {
  for (let w = plan.weeks.length - 1; w >= 0; w--) {
    const days = plan.weeks[w]?.days ?? [];
    for (let d = days.length - 1; d >= 0; d--) {
      if (days[d]?.type === 'marathon') return { weekIndex: w, dayIndex: d };
    }
  }
  const lastW = Math.max(0, plan.weeks.length - 1);
  const lastDays = plan.weeks[lastW]?.days ?? [];
  for (let d = lastDays.length - 1; d >= 0; d--) {
    if (lastDays[d]?.type === 'race') return { weekIndex: lastW, dayIndex: d };
  }
  return { weekIndex: lastW, dayIndex: 6 };
}

/** Monday on or before `dateKey` (plans use day index 0 = Monday). */
export function snapToMonday(dateKey: string): string {
  return mondayOf(normalizeStartKey(dateKey));
}

/** Result of placing a plan so its race day lands on the race date. */
export interface PlanPlacement {
  /** Monday of plan week 0 (may be in the past). */
  startDate: string;
  raceDate: string;
  /** Week the athlete joins at (0 when the full plan fits before race day). */
  joinWeekIndex: number;
  /** Plan weeks from the current week through race week (inclusive). */
  weeksAvailable: number;
  /** True when every plan week before the race is still ahead. */
  fits: boolean;
  /** Weekday of the race, Monday = 0 … Sunday = 6. */
  raceDayIndex: number;
  /** Human-readable notes for the UI (joining late, race weekday shift, past race). */
  notes: string[];
}

/**
 * Race-date-first placement. `startDate = mondayOf(raceDate) − 7·raceWeekIndex`;
 * if fewer weeks remain than the plan needs, the athlete joins at
 * `planWeeks − weeksAvailable`. A race on a different weekday than the plan's
 * race day is handled by `getEffectivePlan()` (the race-week schedule shifts).
 */
export function placePlan(plan: TrainingPlan, raceDate: string, today: string = todayKey()): PlanPlacement {
  const race = normalizeStartKey(raceDate);
  const ref = getRaceDayRef(plan);
  const raceMonday = mondayOf(race);
  const startDate = addDays(raceMonday, -7 * ref.weekIndex);
  const planWeeks = ref.weekIndex + 1;
  const weeksAvailable = Math.max(0, Math.floor(daysBetween(mondayOf(today), raceMonday) / 7) + 1);
  const fits = weeksAvailable >= planWeeks;
  const joinWeekIndex = fits ? 0 : Math.min(ref.weekIndex, planWeeks - weeksAvailable);
  const raceDayIndex = weekdayMon0(race);
  const notes: string[] = [];
  if (daysBetween(today, race) < 0) {
    notes.push('That race date is in the past.');
  } else if (!fits) {
    notes.push(
      `Only ${weeksAvailable} week${weeksAvailable === 1 ? '' : 's'} until race day — this plan is ${planWeeks} weeks, ` +
        `so you'll join at week ${joinWeekIndex + 1}.`,
    );
  }
  if (raceDayIndex !== ref.dayIndex) {
    notes.push(
      `Race day is a ${DAY_NAMES[raceDayIndex]} (the plan races on ${DAY_NAMES[ref.dayIndex]}); ` +
        'the race-week schedule shifts so the race lands on your race date.',
    );
  }
  return { startDate, raceDate: race, joinWeekIndex, weeksAvailable, fits, raceDayIndex, notes };
}

// ── Join fitness check (v1.0.7, T-3) ─────────────────────────────────────────

/** The runner's recent training, for the join check. Null fields are unknown. */
export interface RecentFitness {
  /** Average weekly running miles over the last 4 weeks. */
  weeklyMiles: number | null;
  /** Longest run of the last 30 days (mi). */
  longestRunMi: number | null;
}

/** A run for {@link summarizeRecentFitness}: local date key + miles. */
export interface RecentRun {
  date: string;
  miles: number;
}

/**
 * v1.0.7 (T-3): recent weekly volume (last 28 days ÷ 4) and the 30-day longest
 * run, from the runner's runs. Null when there are fewer than 3 runs in the last
 * 28 days (too little to judge).
 */
export function summarizeRecentFitness(runs: readonly RecentRun[], today: string = todayKey()): RecentFitness | null {
  const from28 = addDays(today, -28);
  const from30 = addDays(today, -30);
  let miles28 = 0;
  let count28 = 0;
  let longest = 0;
  for (const r of runs) {
    if (!isDateKey(r.date) || !(r.miles > 0) || r.date > today) continue;
    if (r.date >= from28) {
      miles28 += r.miles;
      count28++;
    }
    if (r.date >= from30) longest = Math.max(longest, r.miles);
  }
  if (count28 < 3) return null;
  return { weeklyMiles: Math.round((miles28 / 4) * 10) / 10, longestRunMi: Math.round(longest * 10) / 10 };
}

/** Outcome of {@link checkJoinFitness}. */
export interface JoinFitnessCheck {
  /** False when the plan's current week is an unsafe jump from recent training. */
  safe: boolean;
  joinWeekIndex: number;
  /** Training miles of the join week. */
  planWeekMiles: number;
  /** Longest run in the join week and the week after. */
  planLongRunMi: number;
  /** Plain-language reasons (empty when safe). */
  issues: string[];
  /**
   * Later race date (YYYY-MM-DD) at which this plan joins at a week that suits the
   * runner's recent training; null when no later join week would (pick another plan).
   */
  laterRaceDate: string | null;
  /** Ramp-in guidance: weekly miles and long-run caps for the first weeks, ~10% steps. */
  rampIn: { weeklyMiles: number[]; longRunMi: number[] } | null;
}

/** Safe weekly volume for a runner averaging `recent` mi/week: +20% or +5 mi, whichever is more. */
export function safeWeeklyMiles(recent: number): number {
  return Math.max(recent * 1.2, recent + 5);
}

/** Safe long run after a 30-day longest of `longest` mi: +10% or +1 mi, whichever is more. */
export function safeLongRunMiles(longest: number): number {
  return Math.max(longest * 1.1, longest + 1);
}

function weekTrainingMilesOf(plan: TrainingPlan, w: number): number {
  return (plan.weeks[w]?.days ?? []).reduce((s, d) => s + (d?.type === 'run' ? (d.distanceMi ?? 0) : 0), 0);
}

function weekLongestRunOf(plan: TrainingPlan, w: number): number {
  return Math.max(0, ...(plan.weeks[w]?.days ?? []).filter((d) => d?.type === 'run').map((d) => d.distanceMi ?? 0));
}

function joinWeekIssues(plan: TrainingPlan, w: number, fitness: RecentFitness): string[] {
  const issues: string[] = [];
  const weekMiles = Math.round(weekTrainingMilesOf(plan, w) * 10) / 10;
  const long = Math.max(weekLongestRunOf(plan, w), weekLongestRunOf(plan, w + 1));
  if (fitness.weeklyMiles != null && weekMiles > safeWeeklyMiles(fitness.weeklyMiles)) {
    issues.push(
      `Week ${w + 1} has ${weekMiles} mi of running; you've averaged about ${fitness.weeklyMiles} mi a week over the last 4 weeks.`,
    );
  }
  if (fitness.longestRunMi != null && long > safeLongRunMiles(fitness.longestRunMi)) {
    issues.push(`It includes a ${long} mi run; your longest run in the last 30 days is ${fitness.longestRunMi} mi.`);
  }
  return issues;
}

/**
 * v1.0.7 (T-3): compare the plan week the runner would join (`placement.joinWeekIndex`)
 * with their recent weekly volume and 30-day longest run. A jump of more than
 * ~20% (or 5 mi) in weekly volume, or a long run more than ~10% (or 1 mi) over the
 * recent longest, is flagged with three ways out: a later race (join at an
 * earlier, easier week), a ramp-in for the first weeks, or a shorter / gentler plan
 * ({@link saferPlansForRace}). Returns null without fitness data.
 */
export function checkJoinFitness(
  plan: TrainingPlan,
  placement: PlanPlacement,
  fitness: RecentFitness | null,
): JoinFitnessCheck | null {
  if (!fitness || (fitness.weeklyMiles == null && fitness.longestRunMi == null)) return null;
  const w = placement.joinWeekIndex;
  const issues = joinWeekIssues(plan, w, fitness);
  const planWeekMiles = Math.round(weekTrainingMilesOf(plan, w) * 10) / 10;
  const planLongRunMi = Math.max(weekLongestRunOf(plan, w), weekLongestRunOf(plan, w + 1));
  if (issues.length === 0) {
    return { safe: true, joinWeekIndex: w, planWeekMiles, planLongRunMi, issues, laterRaceDate: null, rampIn: null };
  }
  // Later race: the latest earlier join week that suits recent training.
  let laterRaceDate: string | null = null;
  for (let k = w - 1; k >= 0; k--) {
    if (joinWeekIssues(plan, k, fitness).length === 0) {
      laterRaceDate = addDays(placement.raceDate, 7 * (w - k));
      break;
    }
  }
  // Ramp-in: ~10% a week from recent training up to the join week.
  let rampIn: JoinFitnessCheck['rampIn'] = null;
  const recent = fitness.weeklyMiles;
  if (recent != null && recent > 0) {
    const weeks = Math.min(6, Math.max(1, Math.ceil(Math.log(planWeekMiles / recent) / Math.log(1.1)) - 1));
    const longest = fitness.longestRunMi ?? planLongRunMi;
    rampIn = {
      weeklyMiles: Array.from({ length: weeks }, (_, i) =>
        Math.round(Math.min(planWeekMiles, recent * Math.pow(1.1, i + 1))),
      ),
      longRunMi: Array.from(
        { length: weeks },
        (_, i) => Math.round(Math.min(planLongRunMi, safeLongRunMiles(longest) + i) * 2) / 2,
      ),
    };
  }
  return { safe: false, joinWeekIndex: w, planWeekMiles, planLongRunMi, issues, laterRaceDate, rampIn };
}

/**
 * v1.0.7 (T-3): plans (other than `excludeId`) that the runner can join safely for
 * this race date, gentlest join week first.
 */
export function saferPlansForRace(
  plans: readonly TrainingPlan[],
  raceDate: string,
  fitness: RecentFitness | null,
  excludeId: string | null = null,
  today: string = todayKey(),
): TrainingPlan[] {
  if (!fitness) return [];
  return plans
    .filter((p) => p.id !== excludeId)
    .map((p) => {
      const placement = placePlan(p, raceDate, today);
      return {
        p,
        check: checkJoinFitness(p, placement, fitness),
        miles: weekTrainingMilesOf(p, placement.joinWeekIndex),
      };
    })
    .filter((x) => x.check?.safe)
    .sort((a, b) => a.miles - b.miles)
    .map((x) => x.p);
}

/**
 * Plans whose length changed in v1.0.6. Active plans started by older versions
 * (no `startedAt`, no `raceDate`) keep the race date implied by the old length.
 */
const LEGACY_PLAN_WEEKS: Record<string, number> = { first: 18 };

/** True for an ActivePlan written by ≤ 1.0.5 (before placement metadata existed). */
export function isLegacyActivePlan(active: ActivePlan): boolean {
  return !active.startedAt && !active.raceDate;
}

/**
 * The race date of an active plan: `active.raceDate`, else derived from the
 * start date + the plan's race day (legacy length-changed plans keep their old
 * race date). Null when it can't be determined.
 */
export function resolveActivePlanRaceDate(active: ActivePlan, plan?: TrainingPlan | null): string | null {
  if (active.raceDate && isDateKey(active.raceDate)) return active.raceDate;
  const legacyWeeks = LEGACY_PLAN_WEEKS[active.planId];
  if (legacyWeeks && isLegacyActivePlan(active)) {
    return getDateKeyForDay(active.startDate, legacyWeeks - 1, 6);
  }
  const base = plan ?? getPlanById(active.planId);
  if (!base) return null;
  const ref = getRaceDayRef(base);
  return getDateKeyForDay(active.startDate, ref.weekIndex, ref.dayIndex);
}

// ── Plan instances (V18) ────────────────────────────────────────────────────

function readMarks(): Record<string, string> {
  try {
    const raw = persistence.getItem(INSTANCE_MARKS_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function writeMarks(marks: Record<string, string>): void {
  persistence.setItem(INSTANCE_MARKS_KEY, JSON.stringify(marks));
}

/** Instance the stored completions/sync meta of `planId` belong to (legacy: the active plan). */
function ownerInstanceOf(planId: string): string | null {
  const mark = readMarks()[planId];
  if (mark) return mark;
  const active = getActivePlan();
  if (active && active.planId === planId) return makePlanInstanceId(planId, active.startDate);
  return null;
}

function countPlanEntries(planId: string): { completions: number; syncMeta: number; overlay: boolean } {
  const completions = getCompletedCount(planId);
  const syncMeta = Object.keys(getSyncMetaMap()).filter((k) => k.startsWith(planId + ':')).length;
  let overlay = false;
  try {
    const raw = persistence.getItem(PLAN_OVERLAY_STORAGE_KEY);
    const store = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    overlay = Object.keys(store).some((id) => id.startsWith(planId + '@'));
  } catch {
    overlay = false;
  }
  return { completions, syncMeta, overlay };
}

/** Remove a plan's completions, sync meta and overlay entries (all instances). */
function clearPlanInstanceData(planId: string): void {
  const set = getCompletedSet();
  let changed = false;
  for (const k of [...set]) {
    if (k.startsWith(planId + ':')) {
      set.delete(k);
      changed = true;
    }
  }
  if (changed) saveCompletedSet(set);

  const map = getSyncMetaMap();
  let metaChanged = false;
  for (const k of Object.keys(map)) {
    if (k.startsWith(planId + ':')) {
      delete map[k];
      metaChanged = true;
    }
  }
  if (metaChanged) saveSyncMetaMap(map);

  try {
    const raw = persistence.getItem(PLAN_OVERLAY_STORAGE_KEY);
    if (raw) {
      const store = JSON.parse(raw) as Record<string, unknown>;
      let overlayChanged = false;
      for (const id of Object.keys(store)) {
        if (id.startsWith(planId + '@')) {
          delete store[id];
          overlayChanged = true;
        }
      }
      if (overlayChanged) persistence.setItem(PLAN_OVERLAY_STORAGE_KEY, JSON.stringify(store));
    }
  } catch {
    // corrupt overlay store — leave it for planOverlay to ignore
  }
}

export interface StartPlanInput {
  planId: string;
  /** Goal race date (YYYY-MM-DD). Takes precedence over `startDate`. */
  raceDate?: string;
  /** Explicit start date; snapped to the Monday on or before it. */
  startDate?: string;
}

/** What `startPlan` would do — for a confirmation dialog before data is cleared. */
export interface StartPlanPreview {
  active: ActivePlan;
  instanceId: string;
  placement: PlanPlacement | null;
  /** True when this differs from the instance the plan's stored progress belongs to. */
  isNewInstance: boolean;
  /** Entries that would be cleared (0/false when not a new instance). */
  clears: { completions: number; syncMeta: number; overlay: boolean };
}

/** Compute (without saving) the ActivePlan and clean-up `startPlan(input)` would produce. */
export function previewStartPlan(input: StartPlanInput, today: string = todayKey()): StartPlanPreview {
  const plan = getPlanById(input.planId);
  let startDate: string;
  let raceDate: string | undefined;
  let joinedWeekIndex = 0;
  let placement: PlanPlacement | null = null;

  if (input.raceDate && isDateKey(input.raceDate) && plan) {
    placement = placePlan(plan, input.raceDate, today);
    startDate = placement.startDate;
    raceDate = placement.raceDate;
    joinedWeekIndex = placement.joinWeekIndex;
  } else {
    if (input.startDate) startDate = snapToMonday(input.startDate);
    else startDate = weekdayMon0(today) === 0 ? today : addDays(mondayOf(today), 7);
    if (input.raceDate && isDateKey(input.raceDate)) raceDate = input.raceDate;
    else if (plan) {
      const ref = getRaceDayRef(plan);
      raceDate = getDateKeyForDay(startDate, ref.weekIndex, ref.dayIndex);
    }
    if (plan) {
      const ref = getRaceDayRef(plan);
      const elapsedWeeks = Math.floor(daysBetween(startDate, mondayOf(today)) / 7);
      joinedWeekIndex = Math.max(0, Math.min(ref.weekIndex, elapsedWeeks));
    }
  }

  const instanceId = makePlanInstanceId(input.planId, startDate);
  const current = getActivePlan();
  const sameAsActive = !!current && makePlanInstanceId(current.planId, current.startDate) === instanceId;
  const owner = ownerInstanceOf(input.planId);
  const isNewInstance = owner !== instanceId;
  const clears = isNewInstance ? countPlanEntries(input.planId) : { completions: 0, syncMeta: 0, overlay: false };

  const active: ActivePlan = {
    planId: input.planId,
    startDate,
    ...(raceDate ? { raceDate } : {}),
    ...(joinedWeekIndex > 0 ? { joinedWeekIndex } : {}),
    startedAt: sameAsActive && current?.startedAt ? current.startedAt : new Date().toISOString(),
  };
  return { active, instanceId, placement, isNewInstance, clears };
}

/**
 * Start (or re-place) a plan. With `raceDate` the plan is placed race-date-first
 * (see {@link placePlan}); with only `startDate` it is snapped to Monday and the
 * race date derived; with neither it starts next Monday (today if Monday).
 *
 * A new instance (different planId or startDate from the one the plan's stored
 * progress belongs to) clears that plan's completions, sync meta and overlay —
 * confirm with the user first (see {@link previewStartPlan}).
 */
export function startPlan(input: StartPlanInput, today: string = todayKey()): ActivePlan {
  const preview = previewStartPlan(input, today);
  if (preview.isNewInstance) clearPlanInstanceData(input.planId);
  const marks = readMarks();
  marks[input.planId] = preview.instanceId;
  writeMarks(marks);
  setActivePlan(preview.active);
  return preview.active;
}

/** First-boot welcome: has the user completed the "pick a plan?" flow (yes or no). */
export function getWelcomeCompleted(): boolean {
  return persistence.getItem(WELCOME_COMPLETED_KEY) === 'true';
}

export function setWelcomeCompleted(completed: boolean): void {
  if (completed) persistence.setItem(WELCOME_COMPLETED_KEY, 'true');
  else persistence.removeItem(WELCOME_COMPLETED_KEY);
}

/** ── Auto-Sync Metadata ── */

const SYNC_META_KEY = 'apollo_sync_meta';
const LAST_SYNC_KEY = 'apollo_last_sync';

/** Details recorded when a cross-training activity (ride, swim…) fulfils a plan day. */
export interface CrossTrainingMeta {
  /** Sport category, e.g. 'ride', 'swim', 'strength' (see activity/sports.ts). */
  category: string;
  /** Human label, e.g. "Virtual Ride". */
  label: string;
  distanceMeters: number;
  /** TSS-like training load (from the source platform or estimated). */
  trainingLoad?: number;
  averageWatts?: number;
  averageHR?: number;
}

export interface SyncMeta {
  /** ID of the matched activity in the local activity store. */
  activityId: number;
  /** @deprecated Legacy field written by versions ≤ 1.0.4 — read `activityId` instead. */
  stravaActivityId?: number;
  /** Source the matched activity was synced from ('strava' | 'intervals'). */
  activitySource?: string;
  /** Raw sport type of the matched activity, e.g. "Run", "VirtualRide". */
  activityType?: string;
  /** Local date (YYYY-MM-DD) the activity took place. */
  activityDate?: string;
  /** Present when the plan day was fulfilled by cross-training instead of a run. */
  crossTraining?: CrossTrainingMeta;
  /** True when auto-sync (not the athlete) marked the day complete — a re-match may undo it. */
  autoCompleted?: boolean;
  /** Running distance in miles (0 for cross-training so weekly run mileage stays accurate). */
  actualDistanceMi: number;
  actualPaceMinPerMi: number;
  movingTimeSec: number;
  feedback: string;
  syncedAt: string; // ISO timestamp
}

/** Upgrade records written by older versions (which only had `stravaActivityId`). */
function normalizeSyncMeta(meta: SyncMeta): SyncMeta {
  if (meta && typeof meta.activityId !== 'number' && typeof meta.stravaActivityId === 'number') {
    return { ...meta, activityId: meta.stravaActivityId, activitySource: meta.activitySource ?? 'strava' };
  }
  return meta;
}

function getSyncMetaMap(): Record<string, SyncMeta> {
  try {
    const raw = persistence.getItem(SYNC_META_KEY);
    const map: Record<string, SyncMeta> = raw ? JSON.parse(raw) : {};
    for (const k of Object.keys(map)) map[k] = normalizeSyncMeta(map[k]);
    return map;
  } catch {
    return {};
  }
}

function saveSyncMetaMap(map: Record<string, SyncMeta>): void {
  persistence.setItem(SYNC_META_KEY, JSON.stringify(map));
}

/** Retrieve sync metadata for a specific plan day. */
export function getSyncMeta(planId: string, weekIndex: number, dayIndex: number): SyncMeta | null {
  return getSyncMetaMap()[key(planId, weekIndex, dayIndex)] ?? null;
}

/** Store sync metadata (Strava activity match) for a plan day. */
export function setSyncMeta(planId: string, weekIndex: number, dayIndex: number, meta: SyncMeta): void {
  const map = getSyncMetaMap();
  map[key(planId, weekIndex, dayIndex)] = meta;
  saveSyncMetaMap(map);
}

/** Remove the sync metadata of one plan day (no-op when absent). */
export function removeSyncMeta(planId: string, weekIndex: number, dayIndex: number): void {
  const map = getSyncMetaMap();
  const k = key(planId, weekIndex, dayIndex);
  if (!(k in map)) return;
  delete map[k];
  saveSyncMetaMap(map);
}

/** Retrieve all sync metadata entries for a given plan. */
export function getAllSyncMeta(planId: string): { weekIndex: number; dayIndex: number; meta: SyncMeta }[] {
  const map = getSyncMetaMap();
  const results: { weekIndex: number; dayIndex: number; meta: SyncMeta }[] = [];
  for (const [k, v] of Object.entries(map)) {
    if (k.startsWith(planId + ':')) {
      const parts = k.split(':');
      results.push({ weekIndex: Number(parts[1]), dayIndex: Number(parts[2]), meta: v });
    }
  }
  return results;
}

/** Get the ISO timestamp of the last Strava auto-sync. */
export function getLastSyncTime(): string | null {
  return persistence.getItem(LAST_SYNC_KEY);
}

/** Record the timestamp of the most recent auto-sync. */
export function setLastSyncTime(iso: string): void {
  persistence.setItem(LAST_SYNC_KEY, iso);
}
