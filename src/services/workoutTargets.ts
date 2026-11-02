/**
 * Workout Targets — maps a training plan day to specific VDOT-derived
 * pace targets, HR zones, and interval structures.
 *
 * Takes a plan day's `note` field ("Easy", "Tempo", "Speed", "Long", etc.)
 * and the runner's current VDOT to produce a WorkoutTarget with precise
 * pace ranges and coaching guidance.
 */

import type { WorkoutTarget, WorkoutCategory } from '../types/workout';
import { calculateTrainingPaces, type TrainingPaces } from './paceCalculator';
import { raceTimeFromVdot } from './racePrediction';
import { persistence } from './db/persistence';
import { getWorkoutKind, type PlanDay, type PlanWorkoutKind } from '../data/plans';

const TARGETS_CACHE_KEY = 'apollo_workout_targets';
const METERS_PER_MILE = 1609.344;

/** The parts of a plan day the targets read (label for the plan's own structure, T-11 opt-in). */
export type TargetDay = Pick<PlanDay, 'label'> & Partial<Pick<PlanDay, 'mpFinish' | 'distanceMi' | 'tempoShape'>>;

// ── The plan's own session structure (v1.0.7, T-4 / T-10 / T-17) ────────────
//
// Today, the plan preview, compliance and the watch push all read these, so a
// session keeps its coach's reps, tempo intensity and marathon-pace miles
// everywhere (workoutParity.test.ts).

/** A rep set from the plan's description, e.g. "8 × 400 m intervals" or "6 × hill repeats". */
export interface PlanRepSet {
  repeats: number;
  /** Rep length in metres (null for hill repeats, which go by effort). */
  meters: number | null;
  /** Rep length as written by the plan, e.g. "400m", "1 km", "hill". */
  repLabel: string;
  hill: boolean;
}

/**
 * v1.0.7 (T-10): the plan's own reps from its workout description. Returns null
 * when the description doesn't say (e.g. "5 mi speed workout").
 */
export function parsePlanReps(label: string | undefined | null): PlanRepSet | null {
  const text = String(label ?? '');
  const hill = /(\d+)\s*[×x]\s*hill/i.exec(text);
  if (hill) {
    const repeats = Number(hill[1]);
    return repeats > 0 ? { repeats, meters: null, repLabel: 'hill', hill: true } : null;
  }
  const m = /(\d+)\s*[×x]\s*(\d+(?:\.\d+)?)\s*(km|mi|m)\b/i.exec(text);
  if (!m) return null;
  const repeats = Number(m[1]);
  const value = Number(m[2]);
  const unit = m[3].toLowerCase();
  if (!(repeats > 0) || !(value > 0)) return null;
  const meters = unit === 'km' ? value * 1000 : unit === 'mi' ? value * METERS_PER_MILE : value;
  const repLabel = unit === 'm' ? `${value}m` : `${value} ${unit}`;
  return { repeats, meters: Math.round(meters), repLabel, hill: false };
}

/** Hill repeats: ~90 s hard uphill, jog back down (about twice as long). */
const HILL_WORK_SEC = 90;
const HILL_REST_SEC = 180;

/** Structure of a speed session, shared by Today and the watch push. */
export interface SpeedStructure {
  /** The plan's reps (null → Apollo's default, sized to the planned distance). */
  planReps: PlanRepSet | null;
  repeats: number;
  /** Work rep in metres (null for hills). */
  repMeters: number | null;
  /** Work rep duration (s) at interval pace (hills: effort-based). */
  workSec: number;
  /** Recovery jog (s). */
  restSec: number;
}

/**
 * Recovery for one of the plan's reps: equal time for reps up to 1 km, half the
 * rep time for longer reps (min 60 s), rounded to 15 s.
 */
function repRestSec(meters: number, workSec: number): number {
  const ratio = meters <= 1000 ? 1 : 0.5;
  return Math.max(60, Math.round((workSec * ratio) / 15) * 15);
}

/**
 * v1.0.7 (T-10): the speed session for a plan day. The plan's own reps when its
 * description names them; otherwise Apollo's default (800 m repeats at interval
 * pace, equal-time jog, sized to the planned distance).
 */
export function getSpeedStructure(
  day: Pick<PlanDay, 'label'> | null | undefined,
  distanceMi: number | undefined,
  paces: Pick<TrainingPaces, 'interval'> | null,
): SpeedStructure {
  const reps = parsePlanReps(day?.label);
  const repPace = paces?.interval ?? 0;
  if (reps?.hill) {
    return { planReps: reps, repeats: reps.repeats, repMeters: null, workSec: HILL_WORK_SEC, restSec: HILL_REST_SEC };
  }
  if (reps && reps.meters) {
    // Without paces, assume ~6:30/mi for the rep duration.
    const workSec = (reps.meters / METERS_PER_MILE) * (repPace > 0 ? repPace : 390);
    return {
      planReps: reps,
      repeats: reps.repeats,
      repMeters: reps.meters,
      workSec,
      restSec: repRestSec(reps.meters, workSec),
    };
  }
  const totalMi = distanceMi ?? 5;
  const workMi = Math.max(totalMi - 2, 2);
  const repeats = Math.max(Math.round(workMi / 0.5), 3);
  const workSec = 0.5 * (repPace > 0 ? repPace : 390);
  return { planReps: null, repeats, repMeters: 800, workSec, restSec: workSec };
}

/** All-out 5K race pace (sec/mi) for a VDOT. */
function fiveKPace(vdot: number): number {
  const t = raceTimeFromVdot(vdot, 5000);
  return t > 0 ? Math.round(t / (5000 / METERS_PER_MILE)) : 0;
}

/**
 * FIRST (Run Less, Run Faster) tempo intensities, from 5K race pace: short
 * tempo ≈ 5K pace + 15 s/mi, mid tempo ≈ 5K pace + 30 s/mi. Long tempos are run
 * at marathon pace (plans.ts gives them note 'Marathon Pace').
 */
export const FIRST_TEMPO_OFFSET_SEC: Record<'short' | 'mid', number> = { short: 15, mid: 30 };

/** Longest continuous threshold block (min); longer tempos become cruise intervals. */
export const MAX_CONTINUOUS_THRESHOLD_MIN = 25;
/** Without paces, the continuous-threshold limit in miles. */
const MAX_CONTINUOUS_THRESHOLD_MI = 3.5;
/** Cruise intervals: 1-mile reps at threshold with a 1-minute jog, at most 6 reps. */
const CRUISE_MAX_REPS = 6;
const CRUISE_REST_SEC = 60;
/**
 * v1.0.9: a plan that names its own cruise intervals, e.g. Jack Daniels'
 * "4 × 1 mi cruise intervals (T pace)". Daniels prescribes these himself, so
 * they are the coach's shape, not Apollo's long-tempo conversion.
 */
const PLAN_CRUISE_RE = /(\d+)\s*[×x]\s*1\s*mi(?:le)?\s+cruise\s+intervals?\b/i;

/** Structure of a tempo session, shared by Today and the watch push. */
export interface TempoStructure {
  /**
   * `threshold`: continuous at T pace; `cruise`: 1-mile reps at T pace (named by
   * the plan, or a long tempo in a plan without a coach-specified shape);
   * `first_short` / `first_mid`: FIRST's short / mid tempo; `progressive`: Hal
   * Higdon's build-and-ease tempo; `continuous`: one continuous run, marathon
   * pace then at most ~25 min at T (Nike).
   */
  style: 'threshold' | 'cruise' | 'first_short' | 'first_mid' | 'progressive' | 'continuous';
  /** Work pace (sec/mi), null without paces (progressive: about 10K pace for the middle block). */
  paceSecPerMi: number | null;
  /** Miles at tempo effort (null → the whole run between the usual warm-up and cool-down). */
  workMi: number | null;
  repeats: number;
  /** Recovery jog between cruise reps (s); 0 for continuous tempos. */
  restSec: number;
  /** `cruise`: true when the plan itself names the reps (kept at any pace). */
  planReps?: boolean;
  /** `continuous`: miles at marathon pace before the threshold block. */
  mpMi?: number;
  /** `progressive`: minutes building up, near 10K pace, and easing back. */
  minutes?: { build: number; peak: number; ease: number };
}

/** All-out 10K race pace (sec/mi) for a VDOT. */
function tenKPace(vdot: number): number {
  const t = raceTimeFromVdot(vdot, 10000);
  return t > 0 ? Math.round(t / (10000 / METERS_PER_MILE)) : 0;
}

/**
 * v1.0.7 (T-4): the tempo session for a plan day. Uses the plan's own intensity
 * reference (FIRST's short / mid tempo from 5K pace) and caps continuous
 * threshold running at ~25 min: longer tempos become cruise intervals (Daniels)
 * instead of a long continuous run at T.
 * Coach-specified shapes (`day.tempoShape`) win over the cruise rule: Hal
 * Higdon's progressive tempo and Nike's continuous tempo keep their shape.
 */
export function getTempoStructure(
  day: (Pick<PlanDay, 'label'> & Partial<Pick<PlanDay, 'tempoShape'>>) | null | undefined,
  distanceMi: number | undefined,
  paces: Pick<TrainingPaces, 'threshold' | 'vdot'> | null,
): TempoStructure {
  const label = String(day?.label ?? '');
  const first = /(\d+(?:\.\d+)?)\s*mi\s+(short|mid)\s+tempo/i.exec(label);
  if (first) {
    const level = first[2].toLowerCase() as 'short' | 'mid';
    const fiveK = paces ? fiveKPace(paces.vdot) : 0;
    return {
      style: level === 'short' ? 'first_short' : 'first_mid',
      paceSecPerMi: fiveK > 0 ? fiveK + FIRST_TEMPO_OFFSET_SEC[level] : null,
      workMi: Number(first[1]),
      repeats: 1,
      restSec: 0,
    };
  }
  const threshold = paces?.threshold ?? null;
  // v1.0.9: the plan names its own cruise intervals (Daniels' "4 × 1 mi cruise
  // intervals (T pace)"): keep its rep count at any pace, as speed sessions keep
  // the plan's own reps (T-10), so Today and the watch match the plan's label.
  const planCruise = PLAN_CRUISE_RE.exec(label);
  if (planCruise && Number(planCruise[1]) > 0) {
    const repeats = Number(planCruise[1]);
    return {
      style: 'cruise',
      paceSecPerMi: threshold,
      workMi: repeats,
      repeats,
      restSec: CRUISE_REST_SEC,
      planReps: true,
    };
  }
  if (day?.tempoShape === 'progressive') {
    // Hal Higdon: easy start, build to about 10K pace in the middle, ease back down.
    const fromLabel = /(\d+)\s*min\s+tempo/i.exec(label);
    const total = fromLabel ? Number(fromLabel[1]) : Math.max(20, Math.round(((distanceMi ?? 5) - 2) * 8));
    // Higdon's proportions: build ~40%, near 10K pace ~35% (at most 15 min), ease down the rest (~25%).
    const build = Math.round(total * 0.4);
    const peak = Math.min(15, Math.round(total * 0.35));
    const tenK = paces ? tenKPace(paces.vdot) : 0;
    return {
      style: 'progressive',
      paceSecPerMi: tenK > 0 ? tenK : null,
      workMi: null,
      repeats: 1,
      restSec: 0,
      minutes: { build, peak, ease: total - build - peak },
    };
  }
  if (day?.tempoShape === 'continuous' && distanceMi && distanceMi >= 4) {
    // Nike: one continuous tempo; at most ~25 min at T, the rest at marathon pace first.
    const workMi = distanceMi - 2;
    const maxT = threshold
      ? Math.floor(((MAX_CONTINUOUS_THRESHOLD_MIN * 60) / threshold) * 2) / 2
      : MAX_CONTINUOUS_THRESHOLD_MI;
    const tMi = Math.min(workMi, maxT);
    return {
      style: 'continuous',
      paceSecPerMi: threshold,
      workMi: tMi,
      repeats: 1,
      restSec: 0,
      mpMi: Math.round((workMi - tMi) * 10) / 10,
    };
  }
  if (!distanceMi || distanceMi < 6) {
    return { style: 'threshold', paceSecPerMi: threshold, workMi: null, repeats: 1, restSec: 0 };
  }
  const workMi = distanceMi - 2;
  const tooLong = threshold
    ? (workMi * threshold) / 60 > MAX_CONTINUOUS_THRESHOLD_MIN
    : workMi > MAX_CONTINUOUS_THRESHOLD_MI;
  if (!tooLong) return { style: 'threshold', paceSecPerMi: threshold, workMi, repeats: 1, restSec: 0 };
  const repeats = Math.max(2, Math.min(CRUISE_MAX_REPS, Math.floor(workMi)));
  return { style: 'cruise', paceSecPerMi: threshold, workMi: repeats, repeats, restSec: CRUISE_REST_SEC };
}

/**
 * v1.0.7 (T-17): miles at marathon pace when the plan's description names fewer
 * than the whole run, e.g. Hansons "8 mi tempo at marathon pace" (10 mi with
 * warm-up and cool-down) or "5 mi with 3 at marathon pace". Null when the whole
 * run is at marathon pace (Higdon pace runs) or the description doesn't say.
 */
export function parseMarathonPaceMiles(day: Pick<PlanDay, 'label' | 'distanceMi'> | null | undefined): number | null {
  const label = String(day?.label ?? '');
  const total = day?.distanceMi ?? 0;
  const m =
    /\bwith\s+(\d+(?:\.\d+)?)\s*(?:mi\s+)?at\s+marathon\s+pace/i.exec(label) ??
    /(\d+(?:\.\d+)?)\s*mi\s+(?:tempo\s+)?at\s+marathon\s+pace/i.exec(label);
  if (!m) return null;
  const mp = Number(m[1]);
  if (!(mp > 0) || !(total > mp)) return null;
  return mp;
}

/**
 * Map from plan day `note` field to canonical WorkoutCategory.
 * The note values used by the built-in plans are `PLAN_NOTE_TAXONOMY`
 * (Easy, Long, Tempo, Speed, Strength, Medium Long, Marathon Pace, Recovery,
 * Race, Rest, Cross).
 *
 * v1.0.7 (T-1): "Marathon Pace" is its own category. Earlier versions mapped it
 * to tempo, so Today, the plan preview and compliance showed threshold pace
 * (HR zone 4) on marathon-pace days while the watch push used marathon pace.
 */
function noteToCategory(note: string): WorkoutCategory {
  const lc = note.toLowerCase().trim();
  if (lc === 'easy' || lc === 'recovery') return 'easy';
  if (lc === 'marathon pace' || lc === 'mp') return 'marathon_pace';
  if (lc === 'tempo' || lc === 'threshold') return 'tempo';
  if (lc === 'speed' || lc === 'intervals') return 'speed';
  if (lc === 'long') return 'long';
  if (lc === 'medium long' || lc === 'medium-long') return 'medium_long';
  if (lc === 'strength') return 'strength';
  if (lc === 'race' || lc === 'race day') return 'race';
  return 'easy'; // default to easy for unknown types
}

/** Target category for a canonical plan workout kind (see `getWorkoutKind`). */
export function categoryForKind(kind: PlanWorkoutKind): WorkoutCategory {
  switch (kind) {
    case 'long':
      return 'long';
    case 'medium_long':
      return 'medium_long';
    case 'tempo':
      return 'tempo';
    case 'marathon_pace':
      return 'marathon_pace';
    case 'strength':
      return 'strength';
    case 'speed':
      return 'speed';
    case 'race':
    case 'marathon':
      return 'race';
    case 'cross':
      return 'cross';
    case 'rest':
      return 'rest';
    case 'easy':
    case 'recovery':
    default:
      return 'easy';
  }
}

/** Canonical note (from `PLAN_NOTE_TAXONOMY`) for a plan workout kind. */
export function noteForKind(kind: PlanWorkoutKind): string {
  switch (kind) {
    case 'recovery':
      return 'Recovery';
    case 'long':
      return 'Long';
    case 'medium_long':
      return 'Medium Long';
    case 'tempo':
      return 'Tempo';
    case 'marathon_pace':
      return 'Marathon Pace';
    case 'strength':
      return 'Strength';
    case 'speed':
      return 'Speed';
    case 'race':
    case 'marathon':
      return 'Race';
    case 'cross':
      return 'Cross';
    case 'rest':
      return 'Rest';
    case 'easy':
    default:
      return 'Easy';
  }
}

/**
 * Workout target for a plan day, classified with `getWorkoutKind` — the same
 * classifier the watch push (planCalendarSync) uses — so Today, the plan
 * preview, compliance and the watch always agree on the kind of session.
 * Returns null for rest/cross days or without a VDOT.
 */
export function getWorkoutTargetForDay(day: PlanDay | null | undefined, vdot: number): WorkoutTarget | null {
  if (!day || !(vdot > 0)) return null;
  const kind = getWorkoutKind(day);
  if (kind === 'rest' || kind === 'cross') return null;
  const paces = calculateTrainingPaces(vdot);
  if (!paces) return null;
  return buildTarget(categoryForKind(kind), paces, day.distanceMi, day);
}

/**
 * Generate a workout target for a given plan day note and VDOT.
 *
 * @param note The plan day's `note` field (e.g. "Easy", "Tempo")
 * @param vdot The runner's current VDOT score
 * @param distanceMi Optional planned distance in miles (affects long run MP segments)
 * @param day Optional plan day (v1.0.7): its description keeps the plan's own reps,
 *   tempo intensity and marathon-pace miles; `mpFinish` allows an MP finish (T-11)
 * @returns WorkoutTarget with pace ranges, intervals, and coaching guidance
 */
export function getWorkoutTarget(
  note: string,
  vdot: number,
  distanceMi?: number,
  day?: TargetDay,
): WorkoutTarget | null {
  if (!note || vdot <= 0) return null;

  const paces = calculateTrainingPaces(vdot);
  if (!paces) return null;

  const category = noteToCategory(note);
  return buildTarget(category, paces, distanceMi, day);
}

/**
 * Build a complete WorkoutTarget from category and training paces.
 */
function buildTarget(
  category: WorkoutCategory,
  paces: TrainingPaces,
  distanceMi?: number,
  day?: TargetDay,
): WorkoutTarget {
  switch (category) {
    case 'easy':
      return buildEasyTarget(paces);
    case 'long':
      return buildLongRunTarget(paces, distanceMi, day);
    case 'medium_long':
      return buildMediumLongTarget(paces);
    case 'tempo':
      return buildTempoTarget(paces, distanceMi, day);
    case 'speed':
      return buildSpeedTarget(paces, distanceMi, day);
    case 'strength':
      return buildStrengthTarget(paces, distanceMi);
    case 'marathon_pace':
      return buildMarathonPaceTarget(paces, distanceMi, day);
    case 'race':
      return buildRaceTarget(paces);
    case 'rest':
      return { category: 'rest', description: 'Rest day — recovery is training too.' };
    case 'cross':
      return {
        category: 'cross',
        description: 'Cross-training: cycling, swimming, or other low-impact activity. Keep effort easy.',
      };
    default:
      return buildEasyTarget(paces);
  }
}

function buildEasyTarget(paces: TrainingPaces): WorkoutTarget {
  return {
    category: 'easy',
    targetPaceRange: { minSecPerMi: paces.easy.min, maxSecPerMi: paces.easy.max },
    hrZone: 2,
    description:
      `Easy run at a conversational pace. You should be able to hold a full conversation. ` +
      `If you're breathing too hard to talk, slow down.`,
  };
}

function buildLongRunTarget(paces: TrainingPaces, distanceMi?: number, day?: TargetDay): WorkoutTarget {
  // Long runs: easy pace, but the last few miles of very long runs (18+) can include MP segment
  const target: WorkoutTarget = {
    category: 'long',
    targetPaceRange: { minSecPerMi: paces.easy.min, maxSecPerMi: paces.easy.max },
    hrZone: 2,
    description:
      `Long run at easy pace. Build endurance without overexerting. ` +
      `Start conservatively — you can pick it up slightly in the final miles if feeling strong.`,
  };

  // For long runs 18+ miles, add optional marathon-pace segment in final 4-6 miles
  // v1.0.7 (T-11): only when the plan allows it (`mpFinish`, set by experienced
  // plans). Novice plans and callers without a plan day get a plain easy long run.
  if (day?.mpFinish && distanceMi && distanceMi >= 18) {
    const mpSegmentLength = distanceMi >= 20 ? 6 : 4;
    const mpStart = Math.round(distanceMi - mpSegmentLength);
    target.marathonPaceSegment = {
      startMile: mpStart,
      endMile: Math.round(distanceMi),
      paceSecPerMi: paces.marathon,
    };
    target.description +=
      ` Optional: run the last ${mpSegmentLength} miles at marathon pace ` +
      `to practice race-day pacing under fatigue.`;
  }

  return target;
}

function buildMediumLongTarget(paces: TrainingPaces): WorkoutTarget {
  // Medium-long runs (Pfitzinger): slightly faster than easy, but not tempo
  const mlMin = paces.easy.min - 10; // 10s faster than easy range bottom
  const mlMax = paces.easy.max - 5; // 5s faster than easy range top
  return {
    category: 'medium_long',
    targetPaceRange: { minSecPerMi: mlMin, maxSecPerMi: mlMax },
    hrZone: 2,
    description:
      `Medium-long run at a pace slightly faster than easy. ` +
      `This builds aerobic endurance without the recovery cost of a true long run.`,
  };
}

function fmtMi(n: number): string {
  return String(Math.round(n * 10) / 10);
}

/** Middle of the easy range (warm-up / cool-down). */
function easyMid(paces: TrainingPaces): number {
  return Math.round((paces.easy.min + paces.easy.max) / 2);
}

/** "Steady" effort between marathon pace and the fast end of easy (Higdon build / ease, as on the watch). */
function steadyPace(paces: TrainingPaces): number {
  return Math.round((paces.marathon + paces.easy.min) / 2);
}

/** Recovery-jog pace between reps (as on the watch). */
function jogPace(paces: TrainingPaces): number {
  return paces.easy.max + 30;
}

/** Tolerance (± sec/mi) on a structured session's expected whole-run average. */
const AVERAGE_TOLERANCE_SEC = 8;

/**
 * v1.0.7: expected whole-run average pace of a structured session — total time ÷
 * total distance over its segments (distance at a pace, or time at a pace), ±8 s/mi.
 */
function averageRange(segments: Array<{ mi?: number; sec?: number; pace: number }>) {
  let sec = 0;
  let mi = 0;
  for (const s of segments) {
    if (!(s.pace > 0)) continue;
    if (s.mi && s.mi > 0) {
      sec += s.mi * s.pace;
      mi += s.mi;
    } else if (s.sec && s.sec > 0) {
      sec += s.sec;
      mi += s.sec / s.pace;
    }
  }
  const avg = mi > 0 ? Math.round(sec / mi) : 0;
  return { minSecPerMi: avg - AVERAGE_TOLERANCE_SEC, maxSecPerMi: avg + AVERAGE_TOLERANCE_SEC };
}

function buildTempoTarget(paces: TrainingPaces, distanceMi?: number, day?: TargetDay): WorkoutTarget {
  // Tempo runs: threshold pace ±5 sec/mi tolerance
  const tolerance = 5;
  const target: WorkoutTarget = {
    category: 'tempo',
    targetPaceRange: {
      minSecPerMi: paces.threshold - tolerance,
      maxSecPerMi: paces.threshold + tolerance,
    },
    hrZone: 4,
    description:
      `Tempo run at threshold pace — comfortably hard. ` +
      `You should be able to speak in short phrases but not hold a conversation. ` +
      `This pace teaches your body to clear lactate efficiently.`,
  };

  // v1.0.7 (T-4): the plan's own intensity reference (FIRST short / mid tempo).
  const tempo = getTempoStructure(day, distanceMi, paces);
  if ((tempo.style === 'first_short' || tempo.style === 'first_mid') && tempo.paceSecPerMi && tempo.workMi) {
    const pace = tempo.paceSecPerMi;
    const level = tempo.style === 'first_short' ? 'short' : 'mid';
    target.targetPaceRange = { minSecPerMi: pace - tolerance, maxSecPerMi: pace + tolerance };
    target.description =
      `FIRST ${level} tempo — about 5K race pace + ${FIRST_TEMPO_OFFSET_SEC[level]} s/mi. ` +
      `Hard but controlled and even from start to finish, with easy running before and after.`;
    const bookend = Math.max(0, ((distanceMi ?? tempo.workMi) - tempo.workMi) / 2);
    target.intervals = [
      {
        workDurationMin: Math.round((tempo.workMi * pace) / 60),
        restDurationMin: 0,
        targetPaceSecPerMi: pace,
        repeats: 1,
        description: `${fmtMi(bookend)}mi warmup → ${fmtMi(tempo.workMi)}mi ${level} tempo → ${fmtMi(bookend)}mi cooldown`,
      },
    ];
    return target;
  }

  // v1.0.7 (T-4): Hal Higdon's tempo: build up, about 10K pace in the middle, ease back.
  if (tempo.style === 'progressive' && tempo.minutes) {
    const { build, peak, ease } = tempo.minutes;
    const pace = tempo.paceSecPerMi ?? paces.threshold;
    target.targetPaceRange = { minSecPerMi: pace - tolerance, maxSecPerMi: pace + tolerance };
    target.description =
      `Hal Higdon tempo — start easy, build to about 10K race pace in the middle, then ease back down. ` +
      `Only the middle ${peak} minutes are at full tempo effort.`;
    target.intervals = [
      {
        workDurationMin: peak,
        restDurationMin: 0,
        targetPaceSecPerMi: pace,
        repeats: 1,
        description: `1mi warmup → ${build} min building → ${peak} min near 10K pace → ${ease} min easing back → 1mi cooldown`,
      },
    ];
    const steady = steadyPace(paces);
    target.expectedAveragePace = averageRange([
      { mi: 1, pace: easyMid(paces) },
      { sec: build * 60, pace: steady },
      { sec: peak * 60, pace },
      { sec: ease * 60, pace: steady },
      { mi: 1, pace: easyMid(paces) },
    ]);
    return target;
  }
  // v1.0.7 (T-4): Nike's continuous tempo: marathon pace first, then at most ~25 min at T.
  if (tempo.style === 'continuous' && tempo.workMi && distanceMi) {
    const mpMi = tempo.mpMi ?? 0;
    target.intervals = [
      {
        workDurationMin: Math.round((tempo.workMi * paces.threshold) / 60),
        restDurationMin: 0,
        targetPaceSecPerMi: paces.threshold,
        repeats: 1,
        description:
          mpMi > 0
            ? `1mi warmup → ${fmtMi(mpMi)}mi at marathon pace → ${fmtMi(tempo.workMi)}mi at tempo → 1mi cooldown`
            : `1mi warmup → ${fmtMi(tempo.workMi)}mi at tempo → 1mi cooldown`,
      },
    ];
    target.expectedAveragePace = averageRange([
      { mi: 1, pace: easyMid(paces) },
      { mi: mpMi, pace: paces.marathon },
      { mi: tempo.workMi, pace: paces.threshold },
      { mi: 1, pace: easyMid(paces) },
    ]);
    return target;
  }

  // v1.0.7 (T-4): a long tempo in a plan without a coach shape becomes cruise
  // intervals (1-mile reps at T with 1-minute jogs, at most 6), not ~an hour of
  // continuous threshold running. v1.0.9: a plan that names its own cruise
  // intervals (Daniels) keeps its rep count, whatever the distance.
  if (tempo.style === 'cruise') {
    const warmupMi = 1;
    const cooldownMi = 1;
    const totalMi = distanceMi ?? tempo.repeats + warmupMi + cooldownMi;
    const extraEasy = Math.max(0, totalMi - warmupMi - cooldownMi - tempo.repeats) / 2;
    target.description =
      `Cruise intervals at threshold pace — comfortably hard, with short jogs between reps. ` +
      (tempo.planReps
        ? `Keep every rep at the same controlled effort.`
        : `Splitting a long tempo into 1-mile reps keeps the threshold work at the right effort.`);
    target.intervals = [
      {
        workDurationMin: Math.round((paces.threshold / 60) * 10) / 10,
        restDurationMin: tempo.restSec / 60,
        targetPaceSecPerMi: paces.threshold,
        repeats: tempo.repeats,
        description:
          `${fmtMi(warmupMi + extraEasy)}mi warmup → ${tempo.repeats}×1mi at tempo (1min jog) → ` +
          `${fmtMi(cooldownMi + extraEasy)}mi cooldown`,
      },
    ];
    target.expectedAveragePace = averageRange([
      { mi: warmupMi + extraEasy, pace: easyMid(paces) },
      { mi: tempo.repeats, pace: paces.threshold },
      { sec: tempo.repeats * tempo.restSec, pace: jogPace(paces) },
      { mi: cooldownMi + extraEasy, pace: easyMid(paces) },
    ]);
    return target;
  }

  // For longer tempo runs (6+ mi), structure as tempo intervals with warmup/cooldown
  if (distanceMi && distanceMi >= 6) {
    const warmupMi = 1;
    const cooldownMi = 1;
    const tempoMi = distanceMi - warmupMi - cooldownMi;
    const tempoMin = Math.round((tempoMi * paces.threshold) / 60);
    target.intervals = [
      {
        workDurationMin: tempoMin,
        restDurationMin: 0,
        targetPaceSecPerMi: paces.threshold,
        repeats: 1,
        description: `${warmupMi}mi warmup → ${tempoMi}mi at tempo → ${cooldownMi}mi cooldown`,
      },
    ];
  }

  return target;
}

function buildSpeedTarget(paces: TrainingPaces, distanceMi?: number, day?: TargetDay): WorkoutTarget {
  // Speed workouts: interval pace, structured as repeats
  const intervalTolerance = 5;
  const target: WorkoutTarget = {
    category: 'speed',
    targetPaceRange: {
      minSecPerMi: paces.interval - intervalTolerance,
      maxSecPerMi: paces.interval + intervalTolerance,
    },
    hrZone: 5,
    description:
      `Speed session with interval repeats. Push hard during work intervals, ` +
      `jog easy during rest. This builds VO2max and running economy.`,
  };

  // v1.0.7 (T-10): keep the plan's own reps (e.g. FIRST "3 × 1600 m", Hansons "12 × 400 m").
  const speed = getSpeedStructure(day, distanceMi, paces);
  if (speed.planReps) {
    const reps = speed.planReps;
    const workMin = Math.round((speed.workSec / 60) * 10) / 10;
    const restMin = Math.round((speed.restSec / 60) * 10) / 10;
    if (reps.hill) {
      target.description =
        `Hill repeats — run each ~90 s uphill hard but controlled (by effort, not pace), ` +
        `then jog back down. This builds strength and running economy.`;
    }
    const main = reps.hill
      ? `${reps.repeats}× hill repeats (~${workMin}min hard uphill, jog down)`
      : `${reps.repeats}×${reps.repLabel} at interval pace (${restMin}min jog rest)`;
    target.intervals = [
      {
        workDurationMin: workMin,
        restDurationMin: restMin,
        targetPaceSecPerMi: paces.interval,
        repeats: reps.repeats,
        description: `warmup → ${main} → cooldown`,
      },
    ];
    return target;
  }

  // Standard speed workout structure based on distance
  const totalMi = distanceMi ?? 5;
  const warmupMi = 1;
  const cooldownMi = 1;
  const workMi = Math.max(totalMi - warmupMi - cooldownMi, 2);

  // Default to 800m repeats (0.5mi) with equal rest
  const repeatDistMi = 0.5;
  const repeats = Math.max(Math.round(workMi / repeatDistMi), 3);
  const workMin = Math.round(((repeatDistMi * paces.interval) / 60) * 10) / 10;
  const restMin = workMin; // equal work:rest ratio

  target.intervals = [
    {
      workDurationMin: workMin,
      restDurationMin: restMin,
      targetPaceSecPerMi: paces.interval,
      repeats,
      description: `${warmupMi}mi warmup → ${repeats}×800m at interval pace (${restMin}min jog rest) → ${cooldownMi}mi cooldown`,
    },
  ];

  return target;
}

function buildStrengthTarget(paces: TrainingPaces, _distanceMi?: number): WorkoutTarget {
  // Strength workouts (Hansons): between tempo and easy, focus on muscular endurance
  const strengthPace = Math.round((paces.threshold + paces.marathon) / 2);
  const tolerance = 8;
  return {
    category: 'strength',
    targetPaceRange: {
      minSecPerMi: strengthPace - tolerance,
      maxSecPerMi: strengthPace + tolerance,
    },
    hrZone: 3,
    description:
      `Strength run — builds muscular endurance at a moderate-hard effort. ` +
      `Pace falls between marathon pace and threshold. Focus on maintaining form when tired.`,
  };
}

function buildMarathonPaceTarget(paces: TrainingPaces, distanceMi?: number, day?: TargetDay): WorkoutTarget {
  const tolerance = 5;
  const target: WorkoutTarget = {
    category: 'marathon_pace',
    targetPaceRange: {
      minSecPerMi: paces.marathon - tolerance,
      maxSecPerMi: paces.marathon + tolerance,
    },
    hrZone: 3,
    description:
      `Marathon-pace run — practice your target race pace. ` +
      `This should feel controlled and sustainable. If it feels hard, your target may be too aggressive.`,
  };
  // v1.0.7 (T-17): keep the plan's marathon-pace miles (e.g. Hansons 1 + 8 at MP + 1).
  const total = distanceMi ?? day?.distanceMi;
  const mpMi = day ? parseMarathonPaceMiles({ label: day.label, distanceMi: total }) : null;
  if (mpMi && total) {
    const bookend = (total - mpMi) / 2;
    target.intervals = [
      {
        workDurationMin: Math.round((mpMi * paces.marathon) / 60),
        restDurationMin: 0,
        targetPaceSecPerMi: paces.marathon,
        repeats: 1,
        description: `${fmtMi(bookend)}mi warmup → ${fmtMi(mpMi)}mi at marathon pace → ${fmtMi(bookend)}mi cooldown`,
      },
    ];
  }
  return target;
}

function buildRaceTarget(paces: TrainingPaces): WorkoutTarget {
  return {
    category: 'race',
    targetPaceRange: {
      minSecPerMi: paces.marathon - 5,
      maxSecPerMi: paces.marathon + 5,
    },
    description: `Race day! Execute your race strategy. Trust your training.`,
  };
}

/**
 * Get workout targets for an entire plan week.
 * Returns a map of dayIndex -> WorkoutTarget for all run days.
 */
export function getWeekTargets(
  weekDays: {
    note?: string;
    distanceMi?: number;
    type: string;
    label?: string;
    mpFinish?: boolean;
    tempoShape?: PlanDay['tempoShape'];
  }[],
  vdot: number,
): Map<number, WorkoutTarget> {
  const targets = new Map<number, WorkoutTarget>();
  if (vdot <= 0) return targets;

  for (let i = 0; i < weekDays.length; i++) {
    const day = weekDays[i];
    if (day.type === 'rest' || !day.note) continue;
    const target = getWorkoutTarget(day.note, vdot, day.distanceMi, {
      label: day.label ?? '',
      mpFinish: day.mpFinish,
      tempoShape: day.tempoShape,
    });
    if (target) targets.set(i, target);
  }

  return targets;
}

/** Cache the latest workout targets mapping by week */
export function cacheWeekTargets(weekIndex: number, targets: Map<number, WorkoutTarget>): void {
  try {
    const existing = getCachedTargets();
    existing[weekIndex] = Object.fromEntries(targets);
    persistence.setItem(TARGETS_CACHE_KEY, JSON.stringify(existing));
  } catch {
    /* non-critical */
  }
}

/** Get cached workout targets */
export function getCachedTargets(): Record<number, Record<number, WorkoutTarget>> {
  try {
    const raw = persistence.getItem(TARGETS_CACHE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

/** Get a single cached target for a specific week/day */
export function getCachedTarget(weekIndex: number, dayIndex: number): WorkoutTarget | null {
  const cache = getCachedTargets();
  return cache[weekIndex]?.[dayIndex] ?? null;
}
