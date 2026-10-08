/**
 * Plan overlay (v1.0.6, V7 foundation).
 *
 * The athlete's changes to the active plan — moves/swaps, skips, conversions,
 * week scaling and adaptive edits — are stored per plan *instance*
 * (`${planId}@${startDate}`) under `apollo_plan_overlay` and applied on top of a
 * deep clone of the base plan by {@link getEffectivePlan}. Built-in plan objects
 * are never mutated.
 *
 * The effective plan is also *placed*: the race lands on the active plan's race
 * date (race-week schedule shifted when the race weekday differs from the plan's
 * race day), nothing is scheduled after the race, and plans whose length changed
 * since the instance was started are padded/trimmed at the front so dates and
 * week indices stay stable.
 *
 * Every consumer of the active plan should read it through `getEffectivePlan()`.
 */

import type { PlanDay, PlanWeek, TrainingPlan } from '../data/plans';
import { CUSTOM_PLAN_ID, getPlanById } from '../data/plans';
import { persistence } from './db/persistence';
import {
  getActivePlan,
  getDateKeyForDay,
  getRaceDayRef,
  isDayCompleted,
  makePlanInstanceId,
  PLAN_OVERLAY_STORAGE_KEY,
  resolveActivePlanRaceDate,
} from './planProgress';
import type { ActivePlan } from './planProgress';
import { emitPlanEvent, onPlanEvent, PLAN_OVERLAY_CHANGED_EVENT } from './planEvents';
import { daysBetween } from '../utils/localDate';

export { PLAN_OVERLAY_CHANGED_EVENT };

/** A day in the (effective) plan grid: 0-based week, day 0 = Monday … 6 = Sunday. */
export interface DayRef {
  weekIndex: number;
  dayIndex: number;
}

export interface OverlayResult {
  ok: boolean;
  error?: string;
}

export type OverlayChangeKind = 'move' | 'skip' | 'restore' | 'convert' | 'week-scale' | 'adaptive';
export type OverlaySource = 'user' | 'adaptive';

export interface OverlayLogEntry {
  id: string;
  /** ISO timestamp. */
  at: string;
  kind: OverlayChangeKind;
  source: OverlaySource;
  summary: string;
}

interface UndoDayState {
  /** Whether an override existed before the change. */
  had: boolean;
  value?: PlanDay | null;
  partner?: string;
}

interface UndoRecord {
  logId: string;
  days: Record<string, UndoDayState>;
}

interface PlanOverlayRecord {
  instanceId: string;
  /** 'w:d' → replacement day (null = skipped). */
  dayOverrides: Record<string, PlanDay | null>;
  /** 'w:d' → 'w:d' of the day it was swapped with (both directions). */
  swapPartners: Record<string, string>;
  log: OverlayLogEntry[];
  undo: UndoRecord[];
}

type OverlayStore = Record<string, PlanOverlayRecord>;

const MAX_LOG = 200;
const ACTIVE_PLAN_KEY = 'apollo_active_plan';
const CUSTOM_PLAN_STORAGE_KEY = 'apollo_custom_marathon_plan';

const REST_DAY: PlanDay = { type: 'rest', label: 'Rest' };

// ── Helpers ─────────────────────────────────────────────────────────────────

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function refKey(ref: DayRef): string {
  return `${ref.weekIndex}:${ref.dayIndex}`;
}

function parseRefKey(k: string): DayRef {
  const [w, d] = k.split(':').map(Number);
  return { weekIndex: w, dayIndex: d };
}

function isValidRef(ref: DayRef | null | undefined): ref is DayRef {
  return !!ref && Number.isInteger(ref.weekIndex) && Number.isInteger(ref.dayIndex) && ref.dayIndex >= 0 && ref.dayIndex < 7 && ref.weekIndex >= 0;
}

function roundTenth(n: number): number {
  return Math.round(n * 10) / 10;
}

function readStore(): OverlayStore {
  try {
    const raw = persistence.getItem(PLAN_OVERLAY_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? (parsed as OverlayStore) : {};
  } catch {
    return {};
  }
}

function writeStore(store: OverlayStore): void {
  persistence.setItem(PLAN_OVERLAY_STORAGE_KEY, JSON.stringify(store));
}

function emptyRecord(instanceId: string): PlanOverlayRecord {
  return { instanceId, dayOverrides: {}, swapPartners: {}, log: [], undo: [] };
}

function normalizeRecord(rec: PlanOverlayRecord | undefined, instanceId: string): PlanOverlayRecord {
  if (!rec || typeof rec !== 'object') return emptyRecord(instanceId);
  return {
    instanceId,
    dayOverrides: rec.dayOverrides && typeof rec.dayOverrides === 'object' ? rec.dayOverrides : {},
    swapPartners: rec.swapPartners && typeof rec.swapPartners === 'object' ? rec.swapPartners : {},
    log: Array.isArray(rec.log) ? rec.log : [],
    undo: Array.isArray(rec.undo) ? rec.undo : [],
  };
}

let idCounter = 0;
function newLogId(): string {
  idCounter = (idCounter + 1) % 1_000_000;
  return `${Date.now().toString(36)}-${idCounter.toString(36)}`;
}

/** Replace a leading "N mi" in a label with the new distance. */
function relabelDistance(label: string, mi: number): string {
  return /^\d+(\.\d+)?\s*mi\b/.test(label) ? label.replace(/^\d+(\.\d+)?/, String(mi)) : label;
}

// ── Placement (race date / length changes) ─────────────────────────────────

function flatten(weeks: PlanWeek[]): PlanDay[] {
  const out: PlanDay[] = [];
  for (const w of weeks) for (let d = 0; d < 7; d++) out.push(w.days[d] ?? REST_DAY);
  return out;
}

function unflatten(seq: PlanDay[], weekCount: number): PlanWeek[] {
  const weeks: PlanWeek[] = [];
  for (let w = 0; w < weekCount; w++) {
    weeks.push({ weekNumber: w + 1, days: seq.slice(w * 7, w * 7 + 7).map((d) => d ?? REST_DAY) });
  }
  return weeks;
}

/**
 * Deep clone of `base`, placed for `active`: race on the race date, nothing after
 * it, and the grid padded (copies of week 1) or trimmed at the front when the
 * plan's race week no longer matches the instance's race week.
 */
function buildPlacedPlan(active: ActivePlan, base: TrainingPlan): TrainingPlan {
  const plan = clone(base);
  // Built-in and stored plans should always have 7 days/week; be defensive.
  plan.weeks = plan.weeks.map((w, i) => ({ weekNumber: i + 1, days: Array.from({ length: 7 }, (_, d) => w.days?.[d] ?? REST_DAY) }));
  if (plan.weeks.length === 0) return plan;

  const ref = getRaceDayRef(plan);
  const raceDate = resolveActivePlanRaceDate(active, base);
  const startKey = getDateKeyForDay(active.startDate, 0, 0);
  const diff = raceDate ? daysBetween(startKey, raceDate) : -1;

  let raceWeek = ref.weekIndex;
  let raceDay = ref.dayIndex;
  if (diff >= 0) {
    const targetWeek = Math.floor(diff / 7);
    const targetDay = diff % 7;
    const weekOffset = targetWeek - ref.weekIndex;
    if (weekOffset > 0) {
      const pad = Array.from({ length: weekOffset }, () => clone(plan.weeks[0]));
      plan.weeks = [...pad, ...plan.weeks];
    } else if (weekOffset < 0) {
      plan.weeks = plan.weeks.slice(-weekOffset);
    }
    raceWeek = targetWeek;
    // Shift the race-week schedule so the race lands on the race weekday.
    const seq = flatten(plan.weeks);
    const from = raceWeek * 7 + ref.dayIndex;
    const to = raceWeek * 7 + targetDay;
    if (from !== to) {
      const out = seq.slice();
      const windowStart = Math.max(0, from - 6);
      const windowDays = seq.slice(windowStart, from + 1);
      const placeStart = to - (windowDays.length - 1);
      if (to > from) {
        // Days vacated in front of the shifted window become rest.
        for (let pos = windowStart; pos < placeStart; pos++) out[pos] = { ...REST_DAY };
      }
      windowDays.forEach((day, i) => {
        const pos = placeStart + i;
        if (pos >= 0 && pos < out.length) out[pos] = day;
      });
      for (let pos = to + 1; pos < out.length; pos++) out[pos] = { ...REST_DAY };
      plan.weeks = unflatten(out, plan.weeks.length);
    }
    raceDay = targetDay;
  }

  // Nothing after the race: drop later weeks, rest the rest of race week.
  plan.weeks = plan.weeks.slice(0, raceWeek + 1);
  const raceWeekDays = plan.weeks[raceWeek]?.days;
  if (raceWeekDays) {
    for (let d = raceDay + 1; d < 7; d++) {
      const day = raceWeekDays[d];
      if (day && day.type !== 'rest') raceWeekDays[d] = { ...REST_DAY };
    }
  }
  plan.weeks = plan.weeks.map((w, i) => ({ ...w, weekNumber: i + 1 }));
  plan.totalWeeks = plan.weeks.length;
  if (typeof plan.halfMarathonWeek === 'number') {
    const shifted = plan.halfMarathonWeek + (raceWeek - ref.weekIndex);
    plan.halfMarathonWeek = shifted >= 0 && shifted < plan.weeks.length ? shifted : undefined;
  }
  return plan;
}

function skippedDay(original: PlanDay): PlanDay {
  return {
    type: 'rest',
    label: original.type === 'rest' ? original.label : `Skipped: ${original.label}`,
    note: 'Rest',
    skipped: true,
    originalLabel: original.label,
  };
}

function applyOverlay(plan: TrainingPlan, rec: PlanOverlayRecord): TrainingPlan {
  for (const [k, day] of Object.entries(rec.dayOverrides)) {
    const ref = parseRefKey(k);
    const week = plan.weeks[ref.weekIndex];
    if (!week || ref.dayIndex < 0 || ref.dayIndex > 6) continue;
    const current = week.days[ref.dayIndex];
    // Never let a stale override replace the race itself.
    if (current?.type === 'marathon') continue;
    week.days[ref.dayIndex] = day === null ? skippedDay(current ?? REST_DAY) : clone(day);
  }
  return plan;
}

// ── Effective plan (cached by raw inputs; treat the result as read-only) ─────

let cache: { sig: string; plan: TrainingPlan | null } | null = null;

function signature(active: ActivePlan | null): string {
  const activeRaw = persistence.getItem(ACTIVE_PLAN_KEY) ?? '';
  const overlayRaw = persistence.getItem(PLAN_OVERLAY_STORAGE_KEY) ?? '';
  const customRaw = active?.planId === CUSTOM_PLAN_ID ? persistence.getItem(CUSTOM_PLAN_STORAGE_KEY) ?? '' : '';
  return `${activeRaw}\u0000${overlayRaw}\u0000${customRaw}`;
}

/**
 * Effective plan for a specific active-plan record (not cached): placed base plan
 * plus that instance's overlay. Null when the plan id can't be resolved.
 */
export function getEffectivePlanFor(active: ActivePlan): TrainingPlan | null {
  const base = getPlanById(active.planId);
  if (!base) return null;
  const placed = buildPlacedPlan(active, base);
  const rec = readStore()[makePlanInstanceId(active.planId, active.startDate)];
  return rec ? applyOverlay(placed, normalizeRecord(rec, makePlanInstanceId(active.planId, active.startDate))) : placed;
}

/**
 * The active plan with the athlete's overlay applied (deep clone of the base
 * plan — built-ins are never mutated). The object is cached until the active
 * plan, overlay or custom plan changes: treat it as read-only and change the plan
 * through this module's functions. Null when no plan is active.
 */
export function getEffectivePlan(): TrainingPlan | null {
  const active = getActivePlan();
  const sig = signature(active);
  if (cache && cache.sig === sig) return cache.plan;
  const plan = active ? getEffectivePlanFor(active) : null;
  cache = { sig, plan };
  return plan;
}

/** Effective day at `ref`, or null when out of range / no active plan. */
export function getEffectiveDay(ref: DayRef): PlanDay | null {
  if (!isValidRef(ref)) return null;
  const plan = getEffectivePlan();
  return plan?.weeks[ref.weekIndex]?.days[ref.dayIndex] ?? null;
}

/** Race day of the effective plan (on the race date), or null when no plan is active. */
export function getEffectiveRaceDayRef(): DayRef | null {
  const plan = getEffectivePlan();
  return plan ? getRaceDayRef(plan) : null;
}

// ── Mutations ───────────────────────────────────────────────────────────────

interface Ctx {
  active: ActivePlan;
  instanceId: string;
  plan: TrainingPlan;
  race: DayRef;
  store: OverlayStore;
  rec: PlanOverlayRecord;
}

function context(): Ctx | { error: string } {
  const active = getActivePlan();
  if (!active) return { error: 'No active plan.' };
  const plan = getEffectivePlanFor(active);
  if (!plan) return { error: 'The active plan could not be found.' };
  const instanceId = makePlanInstanceId(active.planId, active.startDate);
  const store = readStore();
  const rec = normalizeRecord(store[instanceId], instanceId);
  return { active, instanceId, plan, race: getRaceDayRef(plan), store, rec };
}

function linear(ref: DayRef): number {
  return ref.weekIndex * 7 + ref.dayIndex;
}

/** Why `ref` can't be changed, or null when it can. */
function editError(ctx: Ctx, ref: DayRef): string | null {
  if (!isValidRef(ref) || ref.weekIndex >= ctx.plan.weeks.length) return 'That day is outside the plan.';
  if (linear(ref) === linear(ctx.race)) return 'Race day can’t be changed.';
  if (linear(ref) > linear(ctx.race)) return 'Nothing can be scheduled after race day.';
  if (isDayCompleted(ctx.active.planId, ref.weekIndex, ref.dayIndex)) return 'Completed days can’t be changed.';
  return null;
}

function snapshot(rec: PlanOverlayRecord, keys: string[]): Record<string, UndoDayState> {
  const out: Record<string, UndoDayState> = {};
  for (const k of keys) {
    if (out[k]) continue;
    const had = Object.prototype.hasOwnProperty.call(rec.dayOverrides, k);
    out[k] = { had, ...(had ? { value: clone(rec.dayOverrides[k]) } : {}), ...(rec.swapPartners[k] ? { partner: rec.swapPartners[k] } : {}) };
  }
  return out;
}

function commit(ctx: Ctx, kind: OverlayChangeKind, source: OverlaySource, summary: string, before: Record<string, UndoDayState>): OverlayResult {
  const entry: OverlayLogEntry = { id: newLogId(), at: new Date().toISOString(), kind, source, summary };
  ctx.rec.log.push(entry);
  ctx.rec.undo.push({ logId: entry.id, days: before });
  if (ctx.rec.log.length > MAX_LOG) ctx.rec.log.splice(0, ctx.rec.log.length - MAX_LOG);
  if (ctx.rec.undo.length > MAX_LOG) ctx.rec.undo.splice(0, ctx.rec.undo.length - MAX_LOG);
  ctx.store[ctx.instanceId] = ctx.rec;
  writeStore(ctx.store);
  emitPlanEvent(PLAN_OVERLAY_CHANGED_EVENT, { reason: kind });
  return { ok: true };
}

function dayAt(ctx: Ctx, ref: DayRef): PlanDay {
  return ctx.plan.weeks[ref.weekIndex].days[ref.dayIndex];
}

function describe(day: PlanDay): string {
  return day.label || day.type;
}

/**
 * Swap the workouts of two days (nothing is lost). Rejects the race day, days
 * after it, completed days and out-of-range refs.
 */
export function moveWorkout(from: DayRef, to: DayRef): OverlayResult {
  const ctx = context();
  if ('error' in ctx) return { ok: false, error: ctx.error };
  const err = editError(ctx, from) ?? editError(ctx, to);
  if (err) return { ok: false, error: err };
  if (linear(from) === linear(to)) return { ok: false, error: 'Pick a different day.' };
  const a = dayAt(ctx, from);
  const b = dayAt(ctx, to);
  const ka = refKey(from);
  const kb = refKey(to);
  const before = snapshot(ctx.rec, [ka, kb]);
  ctx.rec.dayOverrides[ka] = clone(b);
  ctx.rec.dayOverrides[kb] = clone(a);
  ctx.rec.swapPartners[ka] = kb;
  ctx.rec.swapPartners[kb] = ka;
  return commit(ctx, 'move', 'user', `Moved ${describe(a)} to week ${to.weekIndex + 1} day ${to.dayIndex + 1} (swapped with ${describe(b)})`, before);
}

/** Skip a planned workout (the day becomes a rest day flagged `skipped`). */
export function skipWorkout(ref: DayRef): OverlayResult {
  const ctx = context();
  if ('error' in ctx) return { ok: false, error: ctx.error };
  const err = editError(ctx, ref);
  if (err) return { ok: false, error: err };
  const day = dayAt(ctx, ref);
  if (day.type === 'rest') return { ok: false, error: 'There is no workout to skip.' };
  const k = refKey(ref);
  const before = snapshot(ctx.rec, [k]);
  ctx.rec.dayOverrides[k] = null;
  return commit(ctx, 'skip', 'user', `Skipped ${describe(day)}`, before);
}

/** Convert a run to an easy run (same distance) or any workout to rest. */
export function convertWorkout(ref: DayRef, to: 'easy' | 'rest'): OverlayResult {
  const ctx = context();
  if ('error' in ctx) return { ok: false, error: ctx.error };
  const err = editError(ctx, ref);
  if (err) return { ok: false, error: err };
  const day = dayAt(ctx, ref);
  let next: PlanDay;
  if (to === 'rest') {
    if (day.type === 'rest') return { ok: false, error: 'That day is already a rest day.' };
    next = { type: 'rest', label: 'Rest', note: 'Rest', originalLabel: day.label };
  } else {
    if (day.type !== 'run' || !(day.distanceMi && day.distanceMi > 0)) return { ok: false, error: 'Only runs can be converted to easy runs.' };
    next = { type: 'run', label: `${day.distanceMi} mi easy`, distanceMi: day.distanceMi, note: 'Easy', originalLabel: day.label };
  }
  const k = refKey(ref);
  const before = snapshot(ctx.rec, [k]);
  ctx.rec.dayOverrides[k] = next;
  return commit(ctx, 'convert', 'user', `Converted ${describe(day)} to ${to === 'rest' ? 'rest' : 'an easy run'}`, before);
}

/** Restore a day to the plan (a swapped day restores its partner too). */
export function restoreDay(ref: DayRef): OverlayResult {
  const ctx = context();
  if ('error' in ctx) return { ok: false, error: ctx.error };
  if (!isValidRef(ref) || ref.weekIndex >= ctx.plan.weeks.length) return { ok: false, error: 'That day is outside the plan.' };
  const k = refKey(ref);
  const partner = ctx.rec.swapPartners[k];
  const keys = partner ? [k, partner] : [k];
  if (!keys.some((x) => Object.prototype.hasOwnProperty.call(ctx.rec.dayOverrides, x))) {
    return { ok: false, error: 'That day has no changes.' };
  }
  for (const x of keys) {
    const r = parseRefKey(x);
    if (isDayCompleted(ctx.active.planId, r.weekIndex, r.dayIndex)) return { ok: false, error: 'Completed days can’t be changed.' };
  }
  const before = snapshot(ctx.rec, keys);
  for (const x of keys) {
    delete ctx.rec.dayOverrides[x];
    delete ctx.rec.swapPartners[x];
  }
  return commit(ctx, 'restore', 'user', `Restored week ${ref.weekIndex + 1} day ${ref.dayIndex + 1}${partner ? ' (and the day it was swapped with)' : ''}`, before);
}

/**
 * Scale the remaining (not completed) runs of a week by `factor` (0.3–1.5) —
 * applied to the current effective distances, so repeated calls compound. Race
 * days, rest and cross days are untouched.
 */
export function scaleWeek(weekIndex: number, factor: number, source: OverlaySource = 'user', summary?: string): OverlayResult {
  const ctx = context();
  if ('error' in ctx) return { ok: false, error: ctx.error };
  if (!Number.isInteger(weekIndex) || weekIndex < 0 || weekIndex >= ctx.plan.weeks.length) return { ok: false, error: 'That week is outside the plan.' };
  if (!Number.isFinite(factor) || factor < 0.3 || factor > 1.5) return { ok: false, error: 'Scale factor must be between 0.3 and 1.5.' };
  const targets: DayRef[] = [];
  for (let d = 0; d < 7; d++) {
    const ref = { weekIndex, dayIndex: d };
    const day = dayAt(ctx, ref);
    if (day.type !== 'run' || !(day.distanceMi && day.distanceMi > 0)) continue;
    if (editError(ctx, ref)) continue;
    targets.push(ref);
  }
  if (targets.length === 0) return { ok: false, error: 'No remaining runs to scale in that week.' };
  const before = snapshot(ctx.rec, targets.map(refKey));
  for (const ref of targets) {
    const day = dayAt(ctx, ref);
    const mi = Math.max(1, roundTenth((day.distanceMi ?? 0) * factor));
    ctx.rec.dayOverrides[refKey(ref)] = { ...clone(day), distanceMi: mi, label: relabelDistance(day.label, mi) };
  }
  const pct = Math.round((factor - 1) * 100);
  return commit(ctx, source === 'adaptive' ? 'adaptive' : 'week-scale', source, summary ?? `Week ${weekIndex + 1} runs ${pct >= 0 ? '+' : ''}${pct}%`, before);
}

/**
 * Generic day replacement (used by the adaptive engine). `day = null` skips the
 * day. Same guards as the other edits.
 */
export function applyDayOverride(ref: DayRef, day: PlanDay | null, source: OverlaySource, summary: string): OverlayResult {
  const ctx = context();
  if ('error' in ctx) return { ok: false, error: ctx.error };
  const err = editError(ctx, ref);
  if (err) return { ok: false, error: err };
  if (day && (day.type === 'marathon' || day.type === 'race')) return { ok: false, error: 'Races can’t be added through an override.' };
  const k = refKey(ref);
  const before = snapshot(ctx.rec, [k]);
  ctx.rec.dayOverrides[k] = day ? clone(day) : null;
  return commit(ctx, source === 'adaptive' ? 'adaptive' : 'convert', source, summary, before);
}

/** Undo the most recent change of the active instance. */
export function undoLastChange(): OverlayResult {
  const ctx = context();
  if ('error' in ctx) return { ok: false, error: ctx.error };
  const last = ctx.rec.undo.pop();
  if (!last) return { ok: false, error: 'Nothing to undo.' };
  for (const [k, state] of Object.entries(last.days)) {
    if (state.had) ctx.rec.dayOverrides[k] = state.value ?? null;
    else delete ctx.rec.dayOverrides[k];
    if (state.partner) ctx.rec.swapPartners[k] = state.partner;
    else delete ctx.rec.swapPartners[k];
  }
  ctx.rec.log = ctx.rec.log.filter((e) => e.id !== last.logId);
  ctx.store[ctx.instanceId] = ctx.rec;
  writeStore(ctx.store);
  emitPlanEvent(PLAN_OVERLAY_CHANGED_EVENT, { reason: 'undo' });
  return { ok: true };
}

/** Change log of the active instance, oldest first (undone changes are removed). */
export function getOverlayLog(): OverlayLogEntry[] {
  const active = getActivePlan();
  if (!active) return [];
  const id = makePlanInstanceId(active.planId, active.startDate);
  return clone(normalizeRecord(readStore()[id], id).log);
}

/** True when the overlay changes this day of the active instance. */
export function isDayModified(ref: DayRef): boolean {
  if (!isValidRef(ref)) return false;
  const active = getActivePlan();
  if (!active) return false;
  const id = makePlanInstanceId(active.planId, active.startDate);
  const rec = readStore()[id];
  return !!rec && !!rec.dayOverrides && Object.prototype.hasOwnProperty.call(rec.dayOverrides, refKey(ref));
}

/** Subscribe to effective-plan changes (overlay edits, plan start/clear). Returns an unsubscribe. */
export function onPlanOverlayChanged(cb: () => void): () => void {
  return onPlanEvent(PLAN_OVERLAY_CHANGED_EVENT, cb);
}
