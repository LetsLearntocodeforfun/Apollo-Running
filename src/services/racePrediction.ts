// Race time prediction — Daniels–Gilbert VDOT ↔ race time, where the VDOT comes
// from (races, best efforts, heart rate, goal), Riegel blending, and training
// adherence analysis.
//
// v1.0.6 (V1, V2, V13, V17, A-01): one engine. `estimateVDOT` is the
// Daniels–Gilbert (1979) equation and `raceTimeFromVdot` is its exact numerical
// inverse, so VDOT → time → VDOT round-trips. VDOT is never taken from easy
// training pace: it comes from real races, best efforts, a heart-rate estimate
// or (for paces only) the goal time — see `deriveVdot`.

import { getAllSyncMeta, getActivePlan, getDateKeyForDay, isDayCompleted } from './planProgress';
import { getEffectivePlan } from './planOverlay';
import type { TrainingPlan } from '../data/plans';
import { getHRProfile, type HRProfile } from './heartRate';
import { persistence } from './db/persistence';
import { getAthleteProfile, type AthleteProfile } from './athleteProfile';
import { getStoredActivities } from './analyticsService';
import { isRunActivity } from './activity/sports';
import type { Activity } from './activity/types';
import { formatMiles } from './unitPreferences';
import { addDays, dateKeyFromLocalIso, daysBetween, isDateKey, todayKey } from '../utils/localDate';

const PREDICTION_KEY = 'apollo_race_prediction';

/** Marathon distance in meters. */
export const MARATHON_M = 42195;
const HALF_MARATHON_M = 21097.5;
const METERS_PER_MILE = 1609.344;
/** Riegel (1981) fatigue exponent. */
export const RIEGEL_EXPONENT = 1.06;

export interface RacePrediction {
  /** Predicted marathon finish time in seconds (point estimate, inside the range) */
  marathonTimeSec: number;
  /** Formatted time string (e.g. "3:45:22") */
  marathonTimeFormatted: string;
  /** Confidence level 0-100 */
  confidence: number;
  /** VDOT score (Jack Daniels Running Formula) */
  vdot: number;
  /** Prediction method used ('daniels_riegel_blend' | 'daniels_vdot' | 'heart_rate_estimate') */
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
  // ── v1.0.6 (all optional for backward compatibility) ──
  /** Fast end of the likely marathon range (seconds). */
  rangeLowSec?: number;
  /** Slow end of the likely marathon range (seconds); wider for low weekly volume. */
  rangeHighSec?: number;
  /** Where the VDOT came from. Predictions are never based on 'goal' or 'none'. */
  vdotSource?: VdotSource;
  /** Human label of the source, e.g. "Recent race". */
  sourceLabel?: string;
  /** Qualitative confidence of the VDOT source. */
  confidenceLevel?: VdotConfidence;
  /** One-sentence explanation of how the prediction was made. */
  basis?: string;
  /** YYYY-MM-DD of the performance behind the VDOT (null for heart-rate estimates). */
  asOf?: string | null;
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

// ── Daniels–Gilbert core ──────────────────────────────────────────────────────

/** Oxygen cost (ml·kg⁻¹·min⁻¹) of running at `metersPerMin` (Daniels & Gilbert, 1979). */
export function vo2AtVelocity(metersPerMin: number): number {
  return -4.60 + 0.182258 * metersPerMin + 0.000104 * metersPerMin * metersPerMin;
}

/** Velocity (m/min) whose oxygen cost is `vo2` — the positive root of {@link vo2AtVelocity}. */
export function velocityAtVo2(vo2: number): number {
  if (!Number.isFinite(vo2)) return 0;
  const a = 0.000104;
  const b = 0.182258;
  const c = -4.60 - vo2;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return 0;
  return Math.max(0, (-b + Math.sqrt(disc)) / (2 * a));
}

/** Fraction of VO2max sustainable in an all-out effort lasting `timeMin` minutes (Daniels & Gilbert). */
export function fractionVo2maxForDuration(timeMin: number): number {
  return 0.8 + 0.1894393 * Math.exp(-0.012778 * timeMin) + 0.2989558 * Math.exp(-0.1932605 * timeMin);
}

/** Riegel formula: T2 = T1 * (D2/D1)^exponent (default 1.06) */
export function riegelPredict(
  knownDistMi: number,
  knownTimeSec: number,
  targetDistMi: number,
  exponent: number = RIEGEL_EXPONENT,
): number {
  if (knownDistMi <= 0 || knownTimeSec <= 0) return 0;
  return knownTimeSec * Math.pow(targetDistMi / knownDistMi, exponent);
}

/** VDOT estimation from an all-out race performance (Daniels–Gilbert). */
export function estimateVDOT(distanceMeters: number, timeSec: number): number {
  if (distanceMeters <= 0 || timeSec <= 0) return 0;
  const timeMin = timeSec / 60;
  const pctVO2 = fractionVo2maxForDuration(timeMin);
  const vo2 = vo2AtVelocity(distanceMeters / timeMin);
  if (pctVO2 <= 0) return 0;
  return vo2 / pctVO2;
}

/**
 * Race time (seconds, unrounded) for `meters` at a given VDOT — the exact
 * inverse of {@link estimateVDOT}, found by bisection (VDOT falls
 * monotonically as the finish time grows). Returns 0 for invalid input.
 * Anchors: VDOT 40 → 3:49:4x, 50 → 3:10:4x, 60 → 2:43:2x for the marathon.
 */
export function raceTimeFromVdot(vdot: number, meters: number): number {
  if (!Number.isFinite(vdot) || !Number.isFinite(meters) || vdot <= 0 || meters <= 0) return 0;
  let lo = meters / 10; // 10 m/s — faster than any human race pace
  let hi = meters / 0.5; // 0.5 m/s — a slow walk
  if (estimateVDOT(meters, hi) >= vdot) return hi;
  if (estimateVDOT(meters, lo) <= vdot) return lo;
  for (let i = 0; i < 200 && hi - lo > 1e-7; i++) {
    const mid = (lo + hi) / 2;
    if (estimateVDOT(meters, mid) > vdot) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * Daniels–Gilbert marathon time (whole seconds) for a VDOT:
 * `raceTimeFromVdot(vdot, 42195)`, never below 2:00:00. 0 for VDOT ≤ 0.
 */
export function vdotToMarathonSec(vdot: number): number {
  if (!(vdot > 0) || !Number.isFinite(vdot)) return 0;
  return Math.round(Math.max(raceTimeFromVdot(vdot, MARATHON_M), 7200));
}

export function formatTimeSec(totalSec: number): string {
  if (totalSec <= 0) return '—';
  const rounded = Math.round(totalSec);
  const h = Math.floor(rounded / 3600);
  const m = Math.floor((rounded % 3600) / 60);
  const s = rounded % 60;
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// ── VDOT sources (V2) ─────────────────────────────────────────────────────────

/** Where a VDOT came from, in priority order. */
export type VdotSource = 'recent_race' | 'race_activity' | 'best_effort' | 'hr_estimate' | 'goal' | 'none';
export type VdotConfidence = 'high' | 'medium' | 'low';

/** The race or effort behind a VDOT. */
export interface VdotPerformance {
  distanceM: number;
  timeSec: number;
  /** YYYY-MM-DD (local) */
  date: string;
  name?: string;
  activityId?: number;
}

export interface DerivedVdot {
  /** VDOT, or null when no usable source exists. */
  vdot: number | null;
  source: VdotSource;
  confidence: VdotConfidence;
  /** YYYY-MM-DD of the source performance (null for HR estimates, goals and 'none'). */
  asOf: string | null;
  /** Human-readable description of the source. */
  detail: string;
  /** Race / best-effort sources: the performance the VDOT was computed from. */
  performance?: VdotPerformance;
}

export interface DeriveVdotOptions {
  /** Today's local date key (defaults to the device date). */
  today?: string;
  /** Athlete profile (defaults to the stored profile). */
  profile?: AthleteProfile;
  /** Activities to search (defaults to the visible stored activities). */
  activities?: readonly Activity[];
  /** HR profile for the heart-rate estimate (defaults to the stored profile). */
  hrProfile?: HRProfile | null;
  /** Plan race days: date key → planned distance (m). Defaults to the active plan's race/marathon days. */
  planRaceDays?: ReadonlyMap<string, number>;
  /** Use the goal marathon time as the last resort (paces only). Default true. */
  allowGoal?: boolean;
}

const VDOT_SOURCE_LABELS: Record<VdotSource, string> = {
  recent_race: 'Recent race',
  race_activity: 'Detected race',
  best_effort: 'Best effort',
  hr_estimate: 'Heart-rate estimate',
  goal: 'Goal time',
  none: 'No data',
};

/** Human label for a VDOT source, e.g. "Recent race". */
export function getVdotSourceLabel(source: VdotSource): string {
  return VDOT_SOURCE_LABELS[source] ?? VDOT_SOURCE_LABELS.none;
}

/** Plausible VDOT range for any adult runner; values outside are data errors. */
const VDOT_MIN = 20;
const VDOT_MAX = 90;
/** Race evidence older than this is ignored. */
const RACE_MAX_AGE_DAYS = 365;
const BEST_EFFORT_MAX_AGE_DAYS = 180;
const BEST_EFFORT_MIN_M = 5000;
const HR_WINDOW_DAYS = 42;
const HR_MIN_RUNS = 3;

const STANDARD_RACE_DISTANCES_M = [5000, 8000, 10000, 12000, 15000, 16093.44, 21097.5, 25000, 30000, MARATHON_M];
/** Words that name a race (word-boundary matched). */
const RACE_NAME_RE = /\b(race|racing|marathon|half[- ]?marathon|halfmarathon|half|parkrun|park run|5k|8k|10k|12k|15k|25k|30k|10[- ]?mile|10[- ]?miler|turkey trot|championships?|grand prix|xc)\b/i;
/** Words that mark a training run even when a race word appears (e.g. "marathon pace"). */
const NOT_RACE_NAME_RE = /\b(pace|paced|pacer|pacing|tempo|easy|recovery|shake ?out|warm[- ]?up|cool[- ]?down|training|workout|long run|intervals?|repeats?|progression|fartlek|strides|simulation|sim|rehearsal|preview)\b/i;

function confidenceForAge(ageDays: number): VdotConfidence {
  if (ageDays <= 120) return 'high';
  if (ageDays <= 240) return 'medium';
  return 'low';
}

const CONFIDENCE_RANK: Record<VdotConfidence, number> = { high: 0, medium: 1, low: 2 };

function plausibleVdot(v: number): boolean {
  return Number.isFinite(v) && v >= VDOT_MIN && v <= VDOT_MAX;
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

/** Label for a race distance: "5K", "Half marathon", "Marathon", "12.3 km". */
export function raceDistanceLabel(meters: number): string {
  const near = (target: number) => Math.abs(meters - target) / target <= 0.03;
  if (near(MARATHON_M)) return 'Marathon';
  if (near(HALF_MARATHON_M)) return 'Half marathon';
  if (near(16093.44)) return '10 mile';
  for (const km of [5, 8, 10, 12, 15, 25, 30]) {
    if (near(km * 1000)) return `${km}K`;
  }
  return `${(meters / 1000).toFixed(1)} km`;
}

/** Chip-time estimate: elapsed time unless the watch obviously kept running after the finish. */
function raceTimeOf(a: Activity): number {
  const moving = a.moving_time || 0;
  const elapsed = a.elapsed_time || 0;
  if (elapsed > 0 && (moving <= 0 || elapsed <= moving * 1.1)) return elapsed;
  return moving;
}

function activityDateKey(a: Activity): string | null {
  return dateKeyFromLocalIso(a.start_date_local) ?? dateKeyFromLocalIso(a.start_date);
}

function nearStandardDistance(meters: number): boolean {
  return STANDARD_RACE_DISTANCES_M.some((d) => Math.abs(meters - d) / d <= 0.03);
}

/**
 * True when an activity was a real race (an all-out effort):
 *  - Strava `workout_type === 1` (race), or
 *  - a race word in the name (and no training word) AND a distance within 3 % of a standard race, or
 *  - a run on one of the plan's race days within 8 % of the planned race distance.
 */
export function isRaceActivity(a: Activity, planRaceDays?: ReadonlyMap<string, number>): boolean {
  if (!isRunActivity(a) || !(a.distance > 0)) return false;
  const workoutType = (a as Activity & { workout_type?: unknown }).workout_type;
  if (typeof workoutType === 'number' && workoutType === 1) return true;
  const name = typeof a.name === 'string' ? a.name : '';
  if (name && RACE_NAME_RE.test(name) && !NOT_RACE_NAME_RE.test(name) && nearStandardDistance(a.distance)) {
    return true;
  }
  const key = activityDateKey(a);
  const planned = key ? planRaceDays?.get(key) : undefined;
  return !!planned && Math.abs(a.distance - planned) / planned <= 0.08;
}

interface Candidate extends DerivedVdot {
  vdot: number;
  sourceRank: number;
}

function profileRaceCandidate(profile: AthleteProfile, today: string): Candidate | null {
  const rr = profile.recentRace;
  if (!rr || !isDateKey(rr.date)) return null;
  const age = daysBetween(rr.date, today);
  if (age < 0 || age > RACE_MAX_AGE_DAYS) return null;
  const vdot = estimateVDOT(rr.distanceM, rr.timeSec);
  if (!plausibleVdot(vdot)) return null;
  const label = rr.name ? `${rr.name} (${raceDistanceLabel(rr.distanceM)})` : raceDistanceLabel(rr.distanceM);
  return {
    vdot,
    source: 'recent_race',
    confidence: confidenceForAge(age),
    asOf: rr.date,
    detail: `${label} in ${formatTimeSec(rr.timeSec)} on ${rr.date} (from your profile)`,
    performance: { distanceM: rr.distanceM, timeSec: rr.timeSec, date: rr.date, name: rr.name },
    sourceRank: 0,
  };
}

function raceActivityCandidates(
  activities: readonly Activity[],
  today: string,
  planRaceDays: ReadonlyMap<string, number> | undefined,
): Candidate[] {
  const out: Candidate[] = [];
  for (const a of activities) {
    const date = activityDateKey(a);
    if (!date) continue;
    const age = daysBetween(date, today);
    if (age < 0 || age > RACE_MAX_AGE_DAYS) continue;
    if (!isRaceActivity(a, planRaceDays)) continue;
    const timeSec = raceTimeOf(a);
    if (!(timeSec > 0)) continue;
    const vdot = estimateVDOT(a.distance, timeSec);
    if (!plausibleVdot(vdot)) continue;
    const name = a.name?.trim() || raceDistanceLabel(a.distance);
    out.push({
      vdot,
      source: 'race_activity',
      confidence: confidenceForAge(age),
      asOf: date,
      detail: `${name} (${raceDistanceLabel(a.distance)}) in ${formatTimeSec(timeSec)} on ${date}`,
      performance: { distanceM: a.distance, timeSec, date, name: a.name, activityId: a.id },
      sourceRank: 1,
    });
  }
  return out;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
}

/**
 * Best efforts attached to an activity (optional `best_efforts` field: the typed
 * `BestEffort` `{ distanceM, elapsedSec }`, or the Strava shape
 * `{ distance, elapsed_time }`). Guarded: anything malformed is ignored.
 */
function readBestEfforts(a: Activity): { distanceM: number; timeSec: number; name?: string }[] {
  const raw: unknown = (a as { best_efforts?: unknown }).best_efforts;
  if (!Array.isArray(raw)) return [];
  const out: { distanceM: number; timeSec: number; name?: string }[] = [];
  for (const e of raw as unknown[]) {
    if (!e || typeof e !== 'object') continue;
    const r = e as Record<string, unknown>;
    const distanceM = num(r.distanceM) ?? num(r.distance) ?? num(r.distance_m);
    const timeSec = num(r.elapsedSec) ?? num(r.elapsed_time) ?? num(r.timeSec) ?? num(r.time_sec) ?? num(r.moving_time);
    if (distanceM == null || timeSec == null) continue;
    out.push({ distanceM, timeSec, name: typeof r.name === 'string' ? r.name : undefined });
  }
  return out;
}

function bestEffortCandidate(activities: readonly Activity[], today: string): Candidate | null {
  let best: Candidate | null = null;
  for (const a of activities) {
    if (!isRunActivity(a)) continue;
    const date = activityDateKey(a);
    if (!date) continue;
    const age = daysBetween(date, today);
    if (age < 0 || age > BEST_EFFORT_MAX_AGE_DAYS) continue;
    for (const e of readBestEfforts(a)) {
      if (e.distanceM < BEST_EFFORT_MIN_M) continue;
      const vdot = estimateVDOT(e.distanceM, e.timeSec);
      if (!plausibleVdot(vdot)) continue;
      if (best && vdot <= best.vdot) continue;
      best = {
        vdot,
        source: 'best_effort',
        confidence: age <= 120 ? 'medium' : 'low',
        asOf: date,
        detail: `Best ${raceDistanceLabel(e.distanceM)} effort ${formatTimeSec(e.timeSec)} on ${date}`,
        performance: { distanceM: e.distanceM, timeSec: e.timeSec, date, name: a.name, activityId: a.id },
        sourceRank: 2,
      };
    }
  }
  return best;
}

function median(values: number[]): number {
  const s = [...values].sort((x, y) => x - y);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Heart-rate estimate (Swain: %VO2R ≈ %HRR). For each steady run in the last
 * 6 weeks: VO2 at the run's speed (Daniels–Gilbert) / %HRR → VO2max. Robust
 * median over ≥ 3 runs, clamped to 25–85. Needs a measured or age-estimated
 * HR profile (not the bare default).
 */
function hrEstimateCandidate(
  activities: readonly Activity[],
  today: string,
  hrProfile: HRProfile | null,
  planRaceDays: ReadonlyMap<string, number> | undefined,
): Candidate | null {
  if (!hrProfile || hrProfile.source === 'default') return null;
  const { maxHR, restingHR } = hrProfile;
  if (!(maxHR > 0) || !(restingHR > 0) || maxHR - restingHR < 40) return null;
  const from = addDays(today, -HR_WINDOW_DAYS);
  const estimates: number[] = [];
  for (const a of activities) {
    if (!isRunActivity(a)) continue;
    const date = activityDateKey(a);
    if (!date || date < from || date > today) continue;
    const hr = a.average_heartrate;
    const moving = a.moving_time || 0;
    if (!hr || hr <= 0 || moving < 20 * 60 || !(a.distance >= 3000)) continue;
    if (isRaceActivity(a, planRaceDays)) continue;
    if ((a.total_elevation_gain ?? 0) / (a.distance / 1000) > 25) continue; // hilly: HR overstates effort
    const v = a.distance / (moving / 60);
    if (v < 100 || v > 400) continue;
    const hrr = (hr - restingHR) / (maxHR - restingHR);
    if (hrr < 0.5 || hrr > 0.92) continue;
    estimates.push(3.5 + (vo2AtVelocity(v) - 3.5) / hrr);
  }
  if (estimates.length < HR_MIN_RUNS) return null;
  const vdot = Math.min(85, Math.max(25, median(estimates)));
  return {
    vdot,
    source: 'hr_estimate',
    confidence: 'low',
    asOf: null,
    detail: `Heart-rate estimate from ${estimates.length} steady runs in the last 6 weeks`,
    sourceRank: 3,
  };
}

/** Race/marathon days of the active (effective) plan: date key → planned distance (m). */
function activePlanRaceDays(): Map<string, number> {
  const out = new Map<string, number>();
  try {
    const ctx = readActivePlan();
    if (!ctx) return out;
    ctx.plan.weeks.forEach((week, w) => {
      week.days.forEach((day, d) => {
        if ((day.type === 'race' || day.type === 'marathon') && day.distanceMi && day.distanceMi > 0) {
          out.set(getDateKeyForDay(ctx.startDate, w, d), day.distanceMi * METERS_PER_MILE);
        }
      });
    });
  } catch { /* no plan */ }
  return out;
}

function safeActivities(): Activity[] {
  try {
    return getStoredActivities();
  } catch {
    return [];
  }
}

function stripRank(c: Candidate): DerivedVdot {
  const { sourceRank: _rank, ...rest } = c;
  return { ...rest, vdot: round1(c.vdot) };
}

/**
 * The athlete's current VDOT and where it came from, in priority order:
 *  1. `recent_race` — the race entered in the athlete profile (high ≤ 120 days, then decaying; ignored > 365 days)
 *  2. `race_activity` — synced runs that were real races (see {@link isRaceActivity})
 *     (race evidence is ranked by age tier first, then profile before detected, then most recent)
 *  3. `best_effort` — best 5K+ segments from an optional `best_efforts` field (≤ 180 days),
 *     used only when at least as high as the heart-rate estimate (a best segment of an
 *     easy run is not an all-out effort)
 *  4. `hr_estimate` — heart-rate estimate from steady runs (confidence low)
 *  5. `goal` — the goal marathon time (paces only; confidence low)
 * Easy-run pace is never treated as an all-out effort, so easy runs can't lower a race-derived VDOT.
 */
export function deriveVdot(opts: DeriveVdotOptions = {}): DerivedVdot {
  const today = opts.today ?? todayKey();
  const profile = opts.profile ?? getAthleteProfile();
  const activities = opts.activities ?? safeActivities();
  const planRaceDays = opts.planRaceDays ?? activePlanRaceDays();

  const raceEvidence: Candidate[] = [];
  const fromProfile = profileRaceCandidate(profile, today);
  if (fromProfile) raceEvidence.push(fromProfile);
  raceEvidence.push(...raceActivityCandidates(activities, today, planRaceDays));
  if (raceEvidence.length > 0) {
    raceEvidence.sort((a, b) =>
      CONFIDENCE_RANK[a.confidence] - CONFIDENCE_RANK[b.confidence] ||
      a.sourceRank - b.sourceRank ||
      (b.asOf ?? '').localeCompare(a.asOf ?? '') ||
      b.vdot - a.vdot);
    return stripRank(raceEvidence[0]);
  }

  let hrProfile: HRProfile | null = null;
  try {
    hrProfile = opts.hrProfile !== undefined ? opts.hrProfile : getHRProfile();
  } catch { /* no HR profile */ }
  const hr = hrEstimateCandidate(activities, today, hrProfile, planRaceDays);

  const effort = bestEffortCandidate(activities, today);
  if (effort && (!hr || effort.vdot >= hr.vdot)) return stripRank(effort);
  if (hr) return stripRank(hr);

  if (opts.allowGoal !== false && profile.goalMarathonSec && profile.goalMarathonSec > 0) {
    const vdot = estimateVDOT(MARATHON_M, profile.goalMarathonSec);
    if (plausibleVdot(vdot)) {
      return {
        vdot: round1(vdot),
        source: 'goal',
        confidence: 'low',
        asOf: null,
        detail: `Goal marathon time ${formatTimeSec(profile.goalMarathonSec)}`,
      };
    }
  }

  return {
    vdot: null,
    source: 'none',
    confidence: 'low',
    asOf: null,
    detail: 'No recent race, best effort, heart-rate data or goal time yet',
  };
}

// ── Prediction (V1, V2, A-01) ─────────────────────────────────────────────────

/** Average weekly running miles over the last 6 weeks, or null with too little data. */
function recentWeeklyRunMiles(activities: readonly Activity[], today: string): number | null {
  const from = addDays(today, -42);
  let meters = 0;
  let runs = 0;
  for (const a of activities) {
    if (!isRunActivity(a)) continue;
    const date = activityDateKey(a);
    if (!date || date < from || date >= today) continue;
    meters += a.distance || 0;
    runs++;
  }
  if (runs < 4) return null;
  return meters / METERS_PER_MILE / 6;
}

const CONFIDENCE_SCORE: Record<VdotConfidence, number> = { high: 80, medium: 65, low: 45 };

/**
 * Compute the marathon prediction without saving it (pure apart from reading
 * stores). Daniels–Gilbert time from {@link deriveVdot} (never the goal time),
 * blended 50/50 with Riegel (1.06) only when the VDOT came from a real race.
 * The slow end of the range uses Riegel 1.07 (≥ 40 mi/week) or 1.08 (less or
 * unknown), after Vickers & Vertosick (2016). Returns null when no source exists.
 */
export function computeRacePrediction(opts: DeriveVdotOptions = {}): RacePrediction | null {
  const today = opts.today ?? todayKey();
  const activities = opts.activities ?? safeActivities();
  const derived = deriveVdot({ ...opts, today, activities, allowGoal: false });
  if (derived.vdot == null || derived.source === 'none' || derived.source === 'goal') return null;

  const vdot = derived.vdot;
  const tDg = raceTimeFromVdot(vdot, MARATHON_M);
  if (!(tDg > 0)) return null;

  const mpw = recentWeeklyRunMiles(activities, today);
  const lowVolume = mpw == null || mpw < 40;
  const perf = derived.performance;
  let point = tDg;
  let low: number;
  let high: number;
  let method: string;
  let basis: string;

  if ((derived.source === 'recent_race' || derived.source === 'race_activity') && perf) {
    const ratio = MARATHON_M / perf.distanceM;
    const riegel = perf.timeSec * Math.pow(ratio, RIEGEL_EXPONENT);
    const riegelSlow = perf.timeSec * Math.pow(ratio, lowVolume ? 1.08 : 1.07);
    point = (tDg + riegel) / 2;
    low = Math.min(tDg, riegel) * 0.985;
    high = Math.max(point * 1.02, riegelSlow);
    method = 'daniels_riegel_blend';
    basis = `Based on your ${raceDistanceLabel(perf.distanceM)} (${formatTimeSec(perf.timeSec)} on ${perf.date}, VDOT ${vdot}), ` +
      'blending Daniels–Gilbert with Riegel.';
  } else if (derived.source === 'best_effort' && perf) {
    low = tDg * 0.97;
    high = tDg * (lowVolume ? 1.08 : 1.06);
    method = 'daniels_vdot';
    basis = `Based on your best ${raceDistanceLabel(perf.distanceM)} effort (${formatTimeSec(perf.timeSec)} on ${perf.date}, VDOT ${vdot}). ` +
      'Training efforts are rarely all-out, so a race result will sharpen this.';
  } else {
    low = tDg * 0.94;
    high = tDg * 1.10;
    method = 'heart_rate_estimate';
    basis = `Estimated from your heart rate on steady runs over the last 6 weeks (VDOT ${vdot}). ` +
      'Add a recent race in your profile for a sharper prediction.';
  }

  // Older evidence is less certain.
  if (derived.confidence === 'medium') {
    low *= 0.99;
    high *= 1.01;
  } else if (derived.confidence === 'low' && derived.source !== 'hr_estimate') {
    low *= 0.98;
    high *= 1.02;
  }
  if (lowVolume) {
    basis += mpw == null
      ? ' The range is wider because your recent weekly volume is unknown.'
      : ` The range is wider for your weekly volume (~${formatMiles(mpw, 0)}/week).`;
  }

  const marathonTimeSec = Math.round(point);
  let confidence = derived.source === 'hr_estimate' ? 35 : CONFIDENCE_SCORE[derived.confidence];
  if (derived.source === 'best_effort') confidence = Math.min(confidence, 60);
  if (mpw != null) confidence += 5;
  confidence = Math.min(confidence, 90);

  const halfMarathonTimeSec = Math.round(raceTimeFromVdot(vdot, HALF_MARATHON_M));
  const tenKTimeSec = Math.round(raceTimeFromVdot(vdot, 10000));
  const fiveKTimeSec = Math.round(raceTimeFromVdot(vdot, 5000));

  const prev = getSavedPrediction();
  let trend = 'stable';
  let previousMarathonTimeSec = prev?.marathonTimeSec;
  if (prev && prev.marathonTimeSec > 0) {
    const diff = marathonTimeSec - prev.marathonTimeSec;
    if (Math.abs(diff) <= 1) {
      // Unchanged inputs: keep the last real change visible instead of resetting it.
      trend = prev.trend;
      previousMarathonTimeSec = prev.previousMarathonTimeSec;
    } else if (diff < -60) trend = 'improving'; // faster by > 1 min
    else if (diff > 60) trend = 'declining';
  }

  return {
    marathonTimeSec,
    marathonTimeFormatted: formatTimeSec(marathonTimeSec),
    confidence,
    vdot,
    method,
    halfMarathonTimeSec,
    halfMarathonFormatted: formatTimeSec(halfMarathonTimeSec),
    tenKTimeSec,
    tenKFormatted: formatTimeSec(tenKTimeSec),
    fiveKTimeSec,
    fiveKFormatted: formatTimeSec(fiveKTimeSec),
    updatedAt: new Date().toISOString(),
    trend,
    previousMarathonTimeSec,
    rangeLowSec: Math.round(Math.min(low, marathonTimeSec)),
    rangeHighSec: Math.round(Math.max(high, marathonTimeSec)),
    vdotSource: derived.source,
    sourceLabel: getVdotSourceLabel(derived.source),
    confidenceLevel: derived.confidence,
    basis,
    asOf: derived.asOf,
  };
}

/**
 * Calculate the race prediction and save it (explicit, idempotent upsert).
 * When there is no usable source the saved prediction is cleared and null is
 * returned — callers must handle null.
 */
export function calculateRacePrediction(): RacePrediction | null {
  const prediction = computeRacePrediction();
  if (prediction) savePrediction(prediction);
  else persistence.removeItem(PREDICTION_KEY);
  return prediction;
}

function savePrediction(pred: RacePrediction): void {
  persistence.setItem(PREDICTION_KEY, JSON.stringify(pred));
}

/**
 * The last saved prediction. Predictions saved by ≤ 1.0.5 (no `vdotSource`)
 * used the broken formula and training-run VDOTs, so they are ignored.
 */
export function getSavedPrediction(): RacePrediction | null {
  try {
    const raw = persistence.getItem(PREDICTION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as RacePrediction | null;
    if (!parsed || typeof parsed.marathonTimeSec !== 'number' || !parsed.vdotSource) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Predicted marathon time (seconds) for defaults such as race-strategy
 * targets: the saved prediction's point estimate, else a fresh (unsaved)
 * computation. Null when no VDOT source exists.
 */
export function getPredictedMarathonSec(): number | null {
  const saved = getSavedPrediction();
  if (saved && saved.marathonTimeSec > 0) return saved.marathonTimeSec;
  return computeRacePrediction()?.marathonTimeSec ?? null;
}

// ── Training adherence (V17, S4) ──────────────────────────────────────────────

interface ActivePlanContext {
  /** The effective plan (placed on the race date, athlete + adaptive overlay applied). Read-only. */
  plan: TrainingPlan;
  /** Plan id that completions and sync meta are keyed by. */
  planId: string;
  startDate: string;
  /** First plan day (0-based) the athlete trains — earlier weeks were skipped when joining late. */
  firstDay: number;
}

/** The active plan (effective — see planOverlay) and its start date. */
function readActivePlan(): ActivePlanContext | null {
  const active = getActivePlan();
  if (!active?.planId || !isDateKey(active.startDate)) return null;
  const plan = getEffectivePlan();
  if (!plan) return null;
  const joined = Number.isInteger(active.joinedWeekIndex) && (active.joinedWeekIndex ?? 0) > 0 ? active.joinedWeekIndex! : 0;
  return { plan, planId: active.planId, startDate: active.startDate, firstDay: joined * 7 };
}

const EASY_NOTES = new Set(['easy', 'long', 'recovery', 'medium long']);
const HARD_NOTES = new Set(['tempo', 'speed', 'strength', 'marathon pace']);

/** Calculate comprehensive training adherence score */
export function calculateTrainingAdherence(): TrainingAdherence | null {
  const ctx = readActivePlan();
  if (!ctx) return null;
  const { plan, planId, startDate, firstDay } = ctx;

  const allMeta = getAllSyncMeta(planId);

  // How many days are "in the past" (should have been completed). DST-safe.
  const today = todayKey();
  const daysSinceStart = daysBetween(startDate, today);
  const totalDays = plan.weeks.length * 7;
  const totalScheduledDays = Math.min(Math.max(daysSinceStart + 1, 0), totalDays);

  /** A plan day that counts: before today, or today once it's done (S4: future ticks never count). */
  const counts = (d: number, done: boolean) => d < daysSinceStart || (d === daysSinceStart && done);

  // Non-rest scheduled days up to today, and how many of those were completed.
  let scheduledRunDays = 0;
  let completedCount = 0;
  for (let d = firstDay; d < totalScheduledDays; d++) {
    const wi = Math.floor(d / 7);
    const di = d % 7;
    const day = plan.weeks[wi]?.days[di];
    if (!day || day.type === 'rest') continue;
    const done = isDayCompleted(planId, wi, di);
    if (!counts(d, done)) continue;
    scheduledRunDays++;
    if (done) completedCount++;
  }

  // 1. Completion rate
  const completionRate = scheduledRunDays > 0 ? Math.min(completedCount / scheduledRunDays, 1) : 0;

  // 2. Distance adherence: actual total vs planned total for synced days
  let totalPlannedMi = 0;
  let totalActualMi = 0;
  for (const m of allMeta) {
    totalActualMi += m.meta.actualDistanceMi;
    const day = plan.weeks[m.weekIndex]?.days[m.dayIndex];
    if (day?.distanceMi) totalPlannedMi += day.distanceMi;
  }
  const distanceAdherence = totalPlannedMi > 0 ? Math.min((totalActualMi / totalPlannedMi) * 100, 120) : 0;

  // 3. Consistency: longest gap between training days, using the activity
  //    dates (not the sync time, which is the same for a backfill — V17).
  const activityDates = Array.from(new Set(
    allMeta
      .map((m) => m.meta.activityDate ?? dateKeyFromLocalIso(m.meta.syncedAt))
      .filter((k): k is string => !!k && isDateKey(k) && k <= today),
  )).sort();
  let maxGapDays = 0;
  for (let i = 1; i < activityDates.length; i++) {
    maxGapDays = Math.max(maxGapDays, daysBetween(activityDates[i - 1], activityDates[i]));
  }
  if (activityDates.length > 0 && daysSinceStart < totalDays) {
    maxGapDays = Math.max(maxGapDays, daysBetween(activityDates[activityDates.length - 1], today));
  }
  const consistencyScore = maxGapDays <= 2 ? 100 : maxGapDays <= 4 ? 80 : maxGapDays <= 7 ? 60 : 40;

  // 4. Intensity balance (easy vs hard day distribution)
  let easyDays = 0;
  let hardDays = 0;
  for (const m of allMeta) {
    const note = plan.weeks[m.weekIndex]?.days[m.dayIndex]?.note?.toLowerCase();
    if (!note) continue;
    if (EASY_NOTES.has(note)) easyDays++;
    else if (HARD_NOTES.has(note)) hardDays++;
  }
  const totalCategorized = easyDays + hardDays;
  // Ideal ratio: ~80% easy, 20% hard
  const easyPct = totalCategorized > 0 ? easyDays / totalCategorized : 0;
  const intensityBalance = totalCategorized < 3 ? 50 : (easyPct >= 0.6 && easyPct <= 0.9 ? 100 : easyPct > 0.9 ? 80 : 60);

  // 5. Current streak: consecutive plan days met, walking back from today.
  //    Rest days count as met; today's workout doesn't break it before the day is over.
  let currentStreak = 0;
  if (totalScheduledDays > 0) {
    for (let d = Math.min(daysSinceStart, totalDays - 1); d >= firstDay; d--) {
      const wi = Math.floor(d / 7);
      const di = d % 7;
      const day = plan.weeks[wi]?.days[di];
      if (!day) break;
      if (day.type === 'rest' || isDayCompleted(planId, wi, di)) {
        currentStreak++;
        continue;
      }
      if (d === daysSinceStart) continue;
      break;
    }
  }

  // 6. Weekly scores (the current week is prorated to the days elapsed)
  const weeksToScore = Math.min(Math.ceil(totalScheduledDays / 7), plan.weeks.length);
  const weeklyScores: { week: number; score: number }[] = [];
  for (let w = Math.floor(firstDay / 7); w < weeksToScore; w++) {
    const weekDays = plan.weeks[w]?.days ?? [];
    let scheduledInWeek = 0;
    let completedInWeek = 0;
    for (let di = 0; di < weekDays.length; di++) {
      const d = w * 7 + di;
      if (d >= totalScheduledDays) break;
      if (weekDays[di].type === 'rest') continue;
      const done = isDayCompleted(planId, w, di);
      if (!counts(d, done)) continue;
      scheduledInWeek++;
      if (done) completedInWeek++;
    }
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
