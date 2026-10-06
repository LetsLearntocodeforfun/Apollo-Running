/**
 * Plan → intervals.icu calendar sync ("send your plan to your watch").
 *
 * Turns the active training plan into structured planned workouts and writes
 * them to the athlete's intervals.icu calendar with their personal API key —
 * no backend. intervals.icu uploads planned workouts to Garmin, COROS, Suunto
 * and Wahoo when the athlete ticks "Upload planned workouts" for that device
 * in intervals.icu → Settings → Connections, so the plan lands on the watch.
 *
 * Descriptions use intervals.icu's plain-text workout syntax with ABSOLUTE
 * pace targets in the athlete's unit, derived from their VDOT paces:
 *
 *   Speed. Run the reps hard but even; jog the recoveries.
 *
 *   Warmup
 *   - 1mi 9:19-8:57/mi Pace
 *
 *   Main set 5x
 *   - 800mtr 7:13-7:03/mi Pace
 *   - Recovery jog 3m30
 *
 *   Cooldown
 *   - 1mi 9:19-8:57/mi Pace
 *
 * Without known paces the same structure is sent as plain distance steps.
 *
 * Ownership: every event Apollo writes carries
 *   external_id = apollo:<planId>:<startDate>:w<week>d<day>   (1-based; d1 = Monday)
 * Pushes are bulk upserts keyed by that ID (idempotent, safe to retry). Apollo
 * deletes only events whose external_id it generated — never anything the
 * athlete or another app created — and never touches past events.
 *
 * Auto mode (syncPlanCalendarIfChanged) keeps the next AUTO_PUSH_WEEKS weeks
 * current: they are re-sent when they change (plan edits, new VDOT paces,
 * unit switch) and at least once a day. A new plan instance (plan switched or
 * start date changed) triggers a full push of the remaining plan.
 */

import { getPlanById, type PlanDay, type TrainingPlan } from '../data/plans';
import { getActivePlan, getDateForDay, formatDateKey } from './planProgress';
import { calculateTrainingPaces, getSavedTrainingPaces, type TrainingPaces } from './paceCalculator';
import { getSavedPrediction } from './racePrediction';
import { getWorkoutTarget } from './workoutTargets';
import { getDistanceUnit, type DistanceUnit } from './unitPreferences';
import { getIntervalsCredentials, type IntervalsCredentials } from './storage';
import { persistence } from './db/persistence';
import {
  upsertIntervalsEvents,
  deleteIntervalsEventsByExternalId,
  listIntervalsEvents,
  IntervalsAuthError,
  type IcuEventInput,
} from './intervals';

// ── Constants ─────────────────────────────────────────────────────────────────

const STATE_KEY = 'apollo_icu_plan_push';
const EXTERNAL_ID_PREFIX = 'apollo:';
const EXTERNAL_ID_RE = /^apollo:(.+):(\d{4}-\d{2}-\d{2}):w(\d+)d([1-7])$/;
const KM_PER_MILE = 1.609344;
const METERS_PER_MILE = 1609.344;

/** Auto mode keeps this many weeks ahead current on the intervals.icu calendar. */
export const AUTO_PUSH_WEEKS = 4;
/** Auto mode re-sends unchanged workouts after this long (repairs edits/deletions made in intervals.icu). */
const AUTO_REFRESH_MS = 24 * 60 * 60 * 1000;
/** Auto mode waits this long after a failed push before trying again. */
const AUTO_ERROR_BACKOFF_MS = 30 * 60 * 1000;
/** "Remove Apollo workouts" looks this far ahead for Apollo events on the calendar. */
const REMOVE_HORIZON_DAYS = 400;
/** Cross-training days are planned as one session of this length. */
const CROSS_TRAINING_MIN = 45;
/** Runs without a planned distance become a timed run of this length. */
const UNTIMED_RUN_MIN = 40;
/** Pace assumed for duration estimates when VDOT paces are unknown (9:30/mi). */
const DEFAULT_PACE_SEC_PER_MI = 570;
/** Recovery-jog pace assumed when sizing interval sessions without known paces (11:00/mi). */
const DEFAULT_JOG_SEC_PER_MI = 660;
/** Tag on every Apollo event so athletes can filter them in intervals.icu. */
const EVENT_TAGS = ['apollo'];

const NOT_CONNECTED_MESSAGE = 'intervals.icu is not connected. Connect it in Settings → Data sources to send your plan.';
const NO_PLAN_MESSAGE = 'No active training plan. Choose a plan on the Training page first.';

// ── Types ─────────────────────────────────────────────────────────────────────

/** One plan day as an intervals.icu planned workout. */
export interface PlannedWorkout {
  /** Stable per plan instance: apollo:<planId>:<startDate>:w<week>d<day> (1-based; d1 = Monday). */
  external_id: string;
  /** Local date (YYYY-MM-DD). */
  date: string;
  category: 'WORKOUT';
  /** 'Run' for runs, races and marathon day; 'Workout' for cross-training. */
  type: 'Run' | 'Workout';
  name: string;
  /** One-line coaching note followed by steps in intervals.icu workout syntax. */
  description: string;
  /** Estimated moving time (s). */
  moving_time: number;
  /** 'PACE' for runs, so devices use the pace targets. */
  target?: 'PACE';
}

export interface BuildPlanWorkoutsOptions {
  /** First local date to include (YYYY-MM-DD). Default: today. */
  from?: string;
  /** Number of weeks (7-day spans starting at `from`) to include. Default: the rest of the plan. */
  weeks?: number;
  /** Distance unit for names, steps and pace targets. */
  unit: DistanceUnit;
  /** VDOT training paces. Null (and no `vdot`) → plain distance steps without targets. */
  paces: TrainingPaces | null;
  /** VDOT score; derives paces when `paces` is null and sizes interval sessions. */
  vdot: number | null;
}

/** Outcome of a push to intervals.icu. */
export interface PushResult {
  /** Workouts created or updated. */
  upserted: number;
  /** Outdated Apollo workouts deleted. */
  deleted: number;
  /** First local date (YYYY-MM-DD) covered by the push. */
  from: string;
  /** Last local date (YYYY-MM-DD) covered by the push. */
  to: string;
}

/** Persisted push state (persistence key `apollo_icu_plan_push`). */
export interface PlanPushState {
  /** Keep the intervals.icu calendar updated automatically. */
  enabled: boolean;
  /** Last successful push (ISO). */
  lastPushAt: string | null;
  /** Hash of the auto-mode window at the last push; null makes the next auto check push. */
  lastHash: string | null;
  /** Plan instance of the last push: "<planId>:<startDate>". */
  planKey: string | null;
  /** external_ids Apollo wrote that are dated today or later (candidates for clean-up). */
  pushedIds: string[];
  /** Message of the last failed push/removal; cleared by the next success. */
  lastError: string | null;
  /** When the last failure happened (ISO). */
  lastErrorAt: string | null;
  /** Outcome of the last successful push. */
  lastResult: PushResult | null;
}

export interface PushOptions {
  /** Only send this many weeks from today (default: the rest of the plan). */
  weeks?: number;
  /** Progress messages for the UI. */
  onProgress?: (message: string) => void;
}

type WorkoutKind =
  | 'easy' | 'recovery' | 'long' | 'medium_long' | 'tempo' | 'marathon_pace'
  | 'strength' | 'speed' | 'race' | 'marathon' | 'cross';

/** Absolute pace target in sec/mi (`fast` = lower bound, `slow` = upper bound). */
interface PaceTarget {
  fast: number;
  slow: number;
}

interface Step {
  /** Distance in `unit` (distance steps). */
  distance?: number;
  unit?: DistanceUnit | 'mtr';
  /** Duration in seconds (time steps). */
  seconds?: number;
  pace?: PaceTarget;
  /** Cue shown on the watch: short and letters only (no digits or target keywords). */
  prompt?: string;
}

interface Section {
  header?: string;
  /** Repeat the steps this many times (rendered as "<header> Nx"). */
  repeats?: number;
  steps: Step[];
}

interface WorkoutSpec {
  name: string;
  note: string;
  sections: Section[];
}

interface BuildContext {
  unit: DistanceUnit;
  paces: TrainingPaces | null;
  vdot: number | null;
}

interface PlanContext {
  plan: TrainingPlan;
  startDate: string;
  planKey: string;
}

// ── Small helpers ─────────────────────────────────────────────────────────────

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function unique(items: string[]): string[] {
  return [...new Set(items)];
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function todayKey(): string {
  return formatDateKey(new Date());
}

function addDaysKey(dateKey: string, days: number): string {
  return formatDateKey(getDateForDay(dateKey, 0, days));
}

function normalizeWeeks(weeks: number | undefined): number | null {
  if (weeks === undefined || !Number.isFinite(weeks)) return null;
  return Math.max(0, Math.floor(weeks));
}

/** Stable ID for a plan day: apollo:<planId>:<startDate>:w<week>d<day> (1-based; d1 = Monday). */
export function planExternalId(planId: string, startDate: string, weekIndex: number, dayIndex: number): string {
  return `${EXTERNAL_ID_PREFIX}${planId}:${startDate}:w${weekIndex + 1}d${dayIndex + 1}`;
}

function isApolloExternalId(id: string | null | undefined): id is string {
  return typeof id === 'string' && id.startsWith(EXTERNAL_ID_PREFIX);
}

/** Local date encoded in an Apollo external_id, or null if it isn't one. */
function externalIdDate(id: string): string | null {
  const m = EXTERNAL_ID_RE.exec(id);
  if (!m) return null;
  return formatDateKey(getDateForDay(m[2], Number(m[3]) - 1, Number(m[4]) - 1));
}

function isUpcoming(id: string, today: string): boolean {
  const date = externalIdDate(id);
  return date !== null && date >= today;
}

// ── Formatting (intervals.icu workout syntax) ────────────────────────────────

function fmtNumber(n: number): string {
  return String(round1(n));
}

function fmtClock(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** intervals.icu durations: "45s", "3m", "3m30", "1h", "1h15m". */
function fmtDuration(sec: number): string {
  const s = Math.max(1, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h > 0) return `${h}h${m ? `${m}m` : ''}`;
  if (m === 0) return `${r}s`;
  return r ? `${m}m${String(r).padStart(2, '0')}` : `${m}m`;
}

/** Pace target in the athlete's unit, slow-fast as intervals.icu expects: "9:19-8:57/mi". */
function fmtPaceTarget(pace: PaceTarget, unit: DistanceUnit): string {
  const perUnit = (secPerMi: number) => Math.round(unit === 'km' ? secPerMi / KM_PER_MILE : secPerMi);
  const slow = perUnit(pace.slow);
  const fast = perUnit(pace.fast);
  return slow === fast ? `${fmtClock(slow)}/${unit}` : `${fmtClock(slow)}-${fmtClock(fast)}/${unit}`;
}

function renderStep(step: Step, unit: DistanceUnit): string {
  const parts = ['-'];
  if (step.prompt) parts.push(step.prompt);
  if (step.distance !== undefined && step.unit) parts.push(`${fmtNumber(step.distance)}${step.unit}`);
  else if (step.seconds !== undefined) parts.push(fmtDuration(step.seconds));
  if (step.pace) parts.push(fmtPaceTarget(step.pace, unit), 'Pace');
  return parts.join(' ');
}

function renderSection(section: Section, unit: DistanceUnit): string {
  const lines: string[] = [];
  if (section.repeats && section.repeats > 1) lines.push(`${section.header ?? 'Main set'} ${section.repeats}x`);
  else if (section.header) lines.push(section.header);
  for (const step of section.steps) lines.push(renderStep(step, unit));
  return lines.join('\n');
}

function stepMiles(step: Step): number {
  if (step.distance === undefined) return 0;
  if (step.unit === 'km') return step.distance / KM_PER_MILE;
  if (step.unit === 'mtr') return step.distance / METERS_PER_MILE;
  return step.distance;
}

/** Moving-time estimate (s, whole minutes): distance steps at their target pace. */
function estimateSeconds(sections: Section[]): number {
  let total = 0;
  for (const section of sections) {
    let sec = 0;
    for (const step of section.steps) {
      if (step.seconds !== undefined) sec += step.seconds;
      else sec += stepMiles(step) * (step.pace ? (step.pace.fast + step.pace.slow) / 2 : DEFAULT_PACE_SEC_PER_MI);
    }
    total += sec * Math.max(1, section.repeats ?? 1);
  }
  return Math.max(60, Math.round(total / 60) * 60);
}

// ── Workout builder ───────────────────────────────────────────────────────────

/** Canonical workout kind of a plan day (labels refine the coarse `note`). */
function classifyDay(day: PlanDay): WorkoutKind {
  if (day.type === 'cross') return 'cross';
  if (day.type === 'marathon') return 'marathon';
  if (day.type === 'race') return 'race';
  const note = (day.note ?? '').trim().toLowerCase();
  const label = String(day.label || '').toLowerCase();
  // e.g. Pfitzinger's "8 mi marathon pace" (note "Tempo") or the builder's "6 mi MP".
  if (note === 'marathon pace' || /\bmarathon pace\b|\bmp\b/.test(label)) return 'marathon_pace';
  if (note === 'race' || note === 'race day') return 'race';
  if (note === 'tempo' || note === 'threshold') return 'tempo';
  if (note === 'speed' || note === 'intervals') return 'speed';
  if (note === 'strength') return 'strength';
  if (note === 'medium long') return 'medium_long';
  if (note === 'long') return 'long';
  if (note === 'recovery' || /\brecovery\b/.test(label)) return 'recovery';
  return 'easy';
}

function around(secPerMi: number, tolerance: number): PaceTarget {
  return { fast: secPerMi - tolerance, slow: secPerMi + tolerance };
}

/** Race pace for a distance: Riegel-scaled (exponent 1.06) from marathon pace. */
function racePace(paces: TrainingPaces, distanceMi: number): number {
  if (distanceMi >= 26) return paces.marathon;
  return Math.round(paces.marathon * Math.pow(distanceMi / 26.2, 0.06));
}

/** Plan distance (mi) in the athlete's unit, rounded to 0.1. */
function toUnit(mi: number, unit: DistanceUnit): number {
  return round1(unit === 'km' ? mi * KM_PER_MILE : mi);
}

/** Warm-up / cool-down length (athlete's unit) for quality sessions, when distance allows. */
function bookend(totalU: number): number {
  return totalU >= 4 ? 1 : totalU >= 2.5 ? 0.5 : 0;
}

function longRunNote(plannedMi: number, ctx: BuildContext): string {
  const base = 'Long run. Easy effort; practice your race-day fueling.';
  if (!ctx.paces || !ctx.vdot) return base;
  const segment = getWorkoutTarget('Long', ctx.vdot, plannedMi)?.marathonPaceSegment;
  if (!segment || segment.endMile <= segment.startMile) return base;
  const lengthMi = segment.endMile - segment.startMile;
  const length = ctx.unit === 'km' ? `${Math.round(lengthMi * KM_PER_MILE)} km` : `${fmtNumber(lengthMi)} mi`;
  const mp = fmtPaceTarget({ fast: ctx.paces.marathon, slow: ctx.paces.marathon }, ctx.unit);
  return `${base} Optional: last ${length} at marathon pace (${mp}).`;
}

/**
 * Speed session: warm-up, "Main set Nx" of rep + recovery jog, cool-down.
 * Reps and the work:rest ratio follow Apollo's speed target (800 m repeats,
 * equal-time jog recoveries; 400 m when the session is short); the number of
 * reps is sized so the whole session roughly matches the planned distance.
 */
function speedSpec(plannedMi: number, ctx: BuildContext, easy: PaceTarget | undefined): WorkoutSpec {
  const { unit, paces } = ctx;
  const e = bookend(toUnit(plannedMi, unit));
  const unitMeters = unit === 'km' ? 1000 : METERS_PER_MILE;
  const availableM = Math.max(0, plannedMi * METERS_PER_MILE - 2 * e * unitMeters);
  const repMeters = availableM >= 4000 ? 800 : 400;
  const block = ctx.vdot ? getWorkoutTarget('Speed', ctx.vdot, plannedMi)?.intervals?.[0] : undefined;
  const restRatio = block && block.workDurationMin > 0 ? block.restDurationMin / block.workDurationMin : 1;
  const repPace = paces?.interval ?? block?.targetPaceSecPerMi;
  const restSec = repPace
    ? Math.max(30, Math.round(((repMeters / METERS_PER_MILE) * repPace * restRatio) / 15) * 15)
    : repMeters === 800 ? 150 : 90;
  const jogPace = paces ? paces.easy.max + 30 : DEFAULT_JOG_SEC_PER_MI;
  const perRepM = repMeters + (restSec / jogPace) * METERS_PER_MILE;
  const reps = clamp(Math.round(availableM / perRepM), 3, 12);

  const sections: Section[] = [];
  if (e > 0) sections.push({ header: 'Warmup', steps: [{ distance: e, unit, pace: easy }] });
  sections.push({
    header: 'Main set',
    repeats: reps,
    steps: [
      { distance: repMeters, unit: 'mtr', pace: repPace ? around(repPace, 5) : undefined },
      { seconds: restSec, prompt: 'Recovery jog' },
    ],
  });
  if (e > 0) sections.push({ header: 'Cooldown', steps: [{ distance: e, unit, pace: easy }] });
  return { name: `${reps} × ${repMeters}m Intervals`, note: 'Speed. Run the reps hard but even; jog the recoveries.', sections };
}

function buildSpec(day: PlanDay, kind: WorkoutKind, ctx: BuildContext): WorkoutSpec {
  const { unit, paces } = ctx;
  if (kind === 'cross') {
    return {
      name: `Cross-Training · ${CROSS_TRAINING_MIN} min`,
      note: 'Cross-training. Bike, swim, elliptical or strength work at an easy effort.',
      sections: [{ steps: [{ seconds: CROSS_TRAINING_MIN * 60, prompt: 'Easy cross-training' }] }],
    };
  }

  const easy = paces ? { fast: paces.easy.min, slow: paces.easy.max } : undefined;
  const plannedMi = day.distanceMi && day.distanceMi > 0 ? day.distanceMi
    : kind === 'marathon' ? 26.2 : kind === 'race' ? 13.1 : kind === 'speed' ? 5 : 0;
  if (kind === 'speed') return speedSpec(plannedMi, ctx, easy);

  const totalU = toUnit(plannedMi, unit);
  const withDistance = (title: string) => (plannedMi > 0 ? `${title} · ${fmtNumber(totalU)} ${unit}` : title);
  const step = (distance: number, pace?: PaceTarget): Step => ({ distance: round1(distance), unit, pace });
  const single = (pace?: PaceTarget): Section[] => [{
    steps: [plannedMi > 0 ? step(totalU, pace) : { seconds: UNTIMED_RUN_MIN * 60, pace }],
  }];
  /** Easy warm-up, main block, easy cool-down (tempo, strength, marathon pace). */
  const sandwich = (header: string, pace: PaceTarget | undefined, warmup: number, cooldown: number): Section[] => {
    if (plannedMi <= 0) return single(pace);
    if (warmup + cooldown === 0) return [{ header, steps: [step(totalU, pace)] }];
    return [
      { header: 'Warmup', steps: [step(warmup, easy)] },
      { header, steps: [step(totalU - warmup - cooldown, pace)] },
      { header: 'Cooldown', steps: [step(cooldown, easy)] },
    ];
  };
  const e = bookend(totalU);

  switch (kind) {
    case 'recovery':
      return { name: withDistance('Recovery Run'), note: 'Recovery run. Keep it truly easy.', sections: single(easy) };
    case 'long':
      return { name: withDistance('Long Run'), note: longRunNote(plannedMi, ctx), sections: single(easy) };
    case 'medium_long':
      return {
        name: withDistance('Medium-Long Run'),
        note: 'Medium-long run. Steady, a touch quicker than easy.',
        sections: single(paces ? { fast: paces.easy.min - 10, slow: paces.easy.max - 5 } : undefined),
      };
    case 'tempo':
      return {
        name: withDistance('Tempo'),
        note: 'Tempo. Comfortably hard: short phrases only.',
        sections: sandwich('Tempo', paces ? around(paces.threshold, 5) : undefined, e, e),
      };
    case 'strength':
      return {
        name: withDistance('Strength Run'),
        note: 'Strength. Between marathon and tempo effort; hold your form.',
        sections: sandwich('Strength', paces ? around(Math.round((paces.threshold + paces.marathon) / 2), 8) : undefined, e, e),
      };
    case 'marathon_pace':
      return {
        name: withDistance('Marathon Pace'),
        note: 'Marathon pace. Controlled and sustainable: rehearse race day.',
        sections: sandwich('Marathon pace', paces ? around(paces.marathon, 5) : undefined, totalU >= 6 ? 2 : e, e),
      };
    case 'race': {
      const label = String(day.label || '').trim();
      const name = !label || /^race$/i.test(label) ? withDistance('Race') : /\brace\b/i.test(label) ? label : `${label} Race`;
      return {
        name,
        note: 'Race day. Trust your training: start controlled, finish strong.',
        sections: single(paces ? around(racePace(paces, plannedMi), 5) : undefined),
      };
    }
    case 'marathon':
      return {
        name: 'Marathon Day 🏅',
        note: 'Marathon day! Start controlled, fuel early, finish strong.',
        sections: single(paces ? around(racePace(paces, plannedMi), 5) : undefined),
      };
    default:
      return { name: withDistance('Easy Run'), note: 'Easy run. Relaxed, conversational effort.', sections: single(easy) };
  }
}

/**
 * Planned workouts for every non-rest day of a plan instance from `opts.from`
 * (default today) through the end of the plan, or `opts.weeks` weeks. Pure:
 * reads nothing from storage. Pace targets are absolute ranges in
 * `opts.unit`; without paces/VDOT the steps are plain distances.
 */
export function buildPlanWorkouts(plan: TrainingPlan, startDate: string, opts: BuildPlanWorkoutsOptions): PlannedWorkout[] {
  const from = opts.from ?? todayKey();
  const weeks = normalizeWeeks(opts.weeks);
  if (weeks === 0) return [];
  const until = weeks !== null ? addDaysKey(from, weeks * 7 - 1) : null;
  const vdot = opts.vdot && opts.vdot > 0 ? opts.vdot : opts.paces?.vdot ?? null;
  const paces = opts.paces ?? (vdot ? calculateTrainingPaces(vdot) : null);
  const ctx: BuildContext = { unit: opts.unit, paces, vdot };

  const out: PlannedWorkout[] = [];
  plan.weeks.forEach((week, weekIndex) => {
    (week.days ?? []).slice(0, 7).forEach((day, dayIndex) => {
      if (!day || day.type === 'rest') return;
      const date = formatDateKey(getDateForDay(startDate, weekIndex, dayIndex));
      if (date < from || (until !== null && date > until)) return;
      const kind = classifyDay(day);
      const spec = buildSpec(day, kind, ctx);
      const workout: PlannedWorkout = {
        external_id: planExternalId(plan.id, startDate, weekIndex, dayIndex),
        date,
        category: 'WORKOUT',
        type: kind === 'cross' ? 'Workout' : 'Run',
        name: spec.name,
        description: [spec.note, ...spec.sections.map((s) => renderSection(s, ctx.unit))].join('\n\n'),
        moving_time: estimateSeconds(spec.sections),
      };
      if (kind !== 'cross') workout.target = 'PACE';
      out.push(workout);
    });
  });
  return out;
}

/** The intervals.icu event Apollo sends for a planned workout. */
export function toIcuEvent(workout: PlannedWorkout): IcuEventInput {
  const event: IcuEventInput = {
    category: workout.category,
    start_date_local: `${workout.date}T00:00:00`,
    type: workout.type,
    name: workout.name,
    description: workout.description,
    moving_time: workout.moving_time,
    external_id: workout.external_id,
    tags: EVENT_TAGS,
  };
  if (workout.target) event.target = workout.target;
  return event;
}

/** Stable fingerprint of exactly what would be sent (FNV-1a over the event JSON). */
function hashWorkouts(workouts: PlannedWorkout[]): string {
  const json = JSON.stringify(workouts.map(toIcuEvent));
  let h = 0x811c9dc5;
  for (let i = 0; i < json.length; i++) {
    h ^= json.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `${workouts.length}-${(h >>> 0).toString(16).padStart(8, '0')}`;
}

// ── State ─────────────────────────────────────────────────────────────────────

const stateListeners = new Set<(state: PlanPushState) => void>();

function emptyState(): PlanPushState {
  return {
    enabled: false, lastPushAt: null, lastHash: null, planKey: null,
    pushedIds: [], lastError: null, lastErrorAt: null, lastResult: null,
  };
}

function optString(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null;
}

function toPushResult(v: unknown): PushResult | null {
  if (!v || typeof v !== 'object') return null;
  const r = v as Partial<Record<keyof PushResult, unknown>>;
  if (typeof r.upserted !== 'number' || typeof r.deleted !== 'number') return null;
  if (typeof r.from !== 'string' || typeof r.to !== 'string') return null;
  return { upserted: r.upserted, deleted: r.deleted, from: r.from, to: r.to };
}

function readState(): PlanPushState {
  try {
    const raw = persistence.getItem(STATE_KEY);
    const p = raw ? (JSON.parse(raw) as Partial<Record<keyof PlanPushState, unknown>> | null) : null;
    if (!p || typeof p !== 'object') return emptyState();
    return {
      enabled: p.enabled === true,
      lastPushAt: optString(p.lastPushAt),
      lastHash: optString(p.lastHash),
      planKey: optString(p.planKey),
      pushedIds: Array.isArray(p.pushedIds) ? p.pushedIds.filter((id): id is string => typeof id === 'string') : [],
      lastError: optString(p.lastError),
      lastErrorAt: optString(p.lastErrorAt),
      lastResult: toPushResult(p.lastResult),
    };
  } catch {
    return emptyState();
  }
}

function updateState(patch: Partial<PlanPushState>): PlanPushState {
  const next = { ...readState(), ...patch };
  persistence.setItem(STATE_KEY, JSON.stringify(next));
  for (const listener of stateListeners) {
    try { listener({ ...next }); } catch { /* listener errors must not break a push */ }
  }
  return next;
}

/** Current push state (auto-update flag, last push, last error…). */
export function getPlanPushState(): PlanPushState {
  return readState();
}

/** Turn "keep my intervals.icu calendar updated automatically" on or off. */
export function setPlanAutoPush(enabled: boolean): void {
  updateState({ enabled });
}

/** Subscribe to push-state changes (manual and automatic pushes). Returns an unsubscribe function. */
export function onPlanPushStateChange(listener: (state: PlanPushState) => void): () => void {
  stateListeners.add(listener);
  return () => {
    stateListeners.delete(listener);
  };
}

// ── Inputs ────────────────────────────────────────────────────────────────────

function isTrainingPaces(p: TrainingPaces | null | undefined): p is TrainingPaces {
  return !!p && typeof p.vdot === 'number' && !!p.easy
    && typeof p.easy.min === 'number' && typeof p.easy.max === 'number'
    && [p.marathon, p.threshold, p.interval].every((v) => typeof v === 'number' && v > 0);
}

/**
 * The athlete's VDOT paces: race-prediction VDOT first, then saved paces —
 * the same order as getOrComputeTrainingPaces, without its cache write
 * (auto mode checks often).
 */
function resolveTrainingPaces(): TrainingPaces | null {
  const vdot = getSavedPrediction()?.vdot;
  if (typeof vdot === 'number' && vdot > 0) {
    const paces = calculateTrainingPaces(vdot);
    if (paces) return paces;
  }
  const saved = getSavedTrainingPaces();
  return isTrainingPaces(saved) ? saved : null;
}

/** True when pushed workouts will carry pace targets (Apollo knows the athlete's VDOT). */
export function hasPlanTargetPaces(): boolean {
  return resolveTrainingPaces() !== null;
}

function resolveActivePlan(): PlanContext | null {
  const active = getActivePlan();
  if (!active?.planId || !active.startDate) return null;
  const plan = getPlanById(active.planId);
  if (!plan || !Array.isArray(plan.weeks)) return null;
  return { plan, startDate: active.startDate, planKey: `${plan.id}:${active.startDate}` };
}

function currentBuildOptions(from: string): BuildPlanWorkoutsOptions {
  const paces = resolveTrainingPaces();
  return { from, unit: getDistanceUnit(), paces, vdot: paces?.vdot ?? null };
}

// ── Push / remove / auto ──────────────────────────────────────────────────────

let queue: Promise<unknown> = Promise.resolve();
let running = 0;

/** Run calendar writes one at a time so pushes and removals never interleave. */
function exclusive<T>(task: () => Promise<T>): Promise<T> {
  running++;
  const run = queue.then(task, task);
  queue = run.then(() => undefined, () => undefined);
  return run.finally(() => {
    running--;
  });
}

/** True while a push or removal is in progress. */
export function isPlanPushRunning(): boolean {
  return running > 0;
}

function coveredRange(ctx: PlanContext, today: string, windowEnd: string | null): { from: string; to: string } {
  const planEnd = addDaysKey(ctx.startDate, ctx.plan.weeks.length * 7 - 1);
  const from = ctx.startDate > today ? ctx.startDate : today;
  let to = windowEnd !== null && windowEnd < planEnd ? windowEnd : planEnd;
  if (to < from) to = from;
  return { from, to };
}

async function runPush(ctx: PlanContext, creds: IntervalsCredentials, opts: PushOptions): Promise<PushResult> {
  const report = (message: string) => {
    try { opts.onProgress?.(message); } catch { /* UI errors must not break the push */ }
  };
  const today = todayKey();
  const all = buildPlanWorkouts(ctx.plan, ctx.startDate, currentBuildOptions(today));
  const weeks = normalizeWeeks(opts.weeks);
  const windowEnd = weeks !== null ? addDaysKey(today, weeks * 7 - 1) : null;
  const toSend = windowEnd !== null ? all.filter((w) => w.date <= windowEnd) : all;
  // Stale = Apollo workouts from today on that the remaining plan no longer has
  // (plan switched, start date moved, day became rest). Past events stay.
  const wanted = new Set(all.map((w) => w.external_id));
  const known = readState().pushedIds.filter((id) => isUpcoming(id, today));
  const stale = known.filter((id) => !wanted.has(id));
  const sentIds = toSend.map((w) => w.external_id);

  try {
    if (toSend.length > 0) {
      report(`Sending ${plural(toSend.length, 'workout')} to intervals.icu…`);
      await upsertIntervalsEvents(toSend.map(toIcuEvent), creds);
    }
    let deleted = 0;
    if (stale.length > 0) {
      report(`Removing ${plural(stale.length, 'outdated workout')}…`);
      deleted = await deleteIntervalsEventsByExternalId(stale, creds);
    }
    const result: PushResult = { upserted: toSend.length, deleted, ...coveredRange(ctx, today, windowEnd) };
    const autoEnd = addDaysKey(today, AUTO_PUSH_WEEKS * 7 - 1);
    updateState({
      lastPushAt: new Date().toISOString(),
      // Only a push that covered the whole auto window may vouch for it.
      lastHash: weeks === null || weeks >= AUTO_PUSH_WEEKS ? hashWorkouts(all.filter((w) => w.date <= autoEnd)) : null,
      planKey: ctx.planKey,
      pushedIds: unique([...known.filter((id) => wanted.has(id)), ...sentIds]),
      lastError: null,
      lastErrorAt: null,
      lastResult: result,
    });
    return result;
  } catch (err) {
    updateState({
      // Remember every ID that may now exist on the calendar so a later push can clean up.
      pushedIds: unique([...known, ...sentIds]),
      lastError: errorMessage(err),
      lastErrorAt: new Date().toISOString(),
    });
    throw err;
  }
}

/**
 * Send the active plan to the athlete's intervals.icu calendar: upserts every
 * workout from today to the end of the plan (or `opts.weeks` weeks) and
 * deletes Apollo workouts dated today or later that the plan no longer has.
 * Throws when intervals.icu isn't connected, no plan is active, or the API
 * fails (IntervalsAuthError for a rejected key); failures are also stored in
 * `lastError`.
 */
export async function pushPlanToIntervals(opts: PushOptions = {}): Promise<PushResult> {
  return exclusive(async () => {
    const creds = getIntervalsCredentials();
    if (!creds) throw new Error(NOT_CONNECTED_MESSAGE);
    const ctx = resolveActivePlan();
    if (!ctx) throw new Error(NO_PLAN_MESSAGE);
    return runPush(ctx, creds, opts);
  });
}

/**
 * Delete every Apollo-created workout dated today or later from the athlete's
 * intervals.icu calendar — the ones this device pushed plus any Apollo
 * workouts found on the calendar (e.g. pushed from another device). Turns
 * auto-update off so they aren't re-added. Returns the number deleted.
 */
export async function removePlanFromIntervals(): Promise<number> {
  return exclusive(async () => {
    const creds = getIntervalsCredentials();
    if (!creds) throw new Error(NOT_CONNECTED_MESSAGE);
    const state = updateState({ enabled: false });
    const today = todayKey();
    const ids = new Set(state.pushedIds.filter((id) => isUpcoming(id, today)));
    try {
      try {
        const events = await listIntervalsEvents(
          { oldest: today, newest: addDaysKey(today, REMOVE_HORIZON_DAYS), category: 'WORKOUT' },
          creds,
        );
        for (const event of events) {
          const date = (event.start_date_local ?? '').slice(0, 10);
          if (isApolloExternalId(event.external_id) && date >= today) ids.add(event.external_id);
        }
      } catch (err) {
        // Listing only adds workouts this device doesn't know about; the known IDs still go.
        if (err instanceof IntervalsAuthError) throw err;
      }
      const deleted = await deleteIntervalsEventsByExternalId([...ids], creds);
      updateState({
        pushedIds: [], planKey: null, lastHash: null, lastPushAt: null,
        lastResult: null, lastError: null, lastErrorAt: null,
      });
      return deleted;
    } catch (err) {
      updateState({ lastError: errorMessage(err), lastErrorAt: new Date().toISOString() });
      throw err;
    }
  });
}

/**
 * Auto mode, safe to call often (after every activity sync, on launch, after
 * plan changes). No-op unless auto-update is on, intervals.icu is connected
 * and a plan is active. Pushes the next AUTO_PUSH_WEEKS weeks when they
 * differ from the last push or the last push is older than a day; a new plan
 * instance gets a full push. Backs off for 30 minutes after a failure. Never
 * throws — failures are stored in `lastError`. Returns the push result, or
 * null when nothing was sent.
 */
export async function syncPlanCalendarIfChanged(): Promise<PushResult | null> {
  try {
    const state = readState();
    if (!state.enabled || running > 0 || !getIntervalsCredentials()) return null;
    const ctx = resolveActivePlan();
    if (!ctx) return null;
    const now = Date.now();
    if (state.lastErrorAt && now - Date.parse(state.lastErrorAt) < AUTO_ERROR_BACKOFF_MS) return null;
    const samePlan = state.planKey === ctx.planKey;
    if (samePlan && state.lastHash && state.lastPushAt && now - Date.parse(state.lastPushAt) < AUTO_REFRESH_MS) {
      const upcoming = buildPlanWorkouts(ctx.plan, ctx.startDate, { ...currentBuildOptions(todayKey()), weeks: AUTO_PUSH_WEEKS });
      if (hashWorkouts(upcoming) === state.lastHash) return null;
    }
    return await pushPlanToIntervals(samePlan ? { weeks: AUTO_PUSH_WEEKS } : {});
  } catch (err) {
    try {
      updateState({ lastError: errorMessage(err), lastErrorAt: new Date().toISOString() });
    } catch { /* storage unavailable — nothing more to record */ }
    return null;
  }
}
