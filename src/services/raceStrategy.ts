// Race strategy service — mile-by-mile pacing plans, nutrition strategies, custom marathon imports.
//
// v1.0.6:
// - `buildRaceStrategy` is PURE (preview); `saveStrategy` is the explicit upsert (RS-5).
// - Halves are taken at distance / 2 by interpolating cumulative time (RS-1).
// - Negative/positive splits use a magnitude parameter, default ±1.5 % (RS-4),
//   and the halves hit that target exactly; even split = equal halves.
// - Grade is computed over the real segment length, incl. the partial last one (RS-6).
// - Goals are validated against the distance (RS-11); custom races validate
//   their date and keep https websites only (RS-7, L9).
// - Legacy '*-marathon-2026' ids are normalised on read (RS-8 migration).

import { persistence } from './db/persistence';
import { getMarathonById, getWorldMajors, normalizeMarathonId } from '../data/worldMajors';
import { formatTimeSec } from './racePrediction';
import { isDateKey } from '../utils/localDate';
import { planRaceFueling } from './fuelingCalculator';
import { getCarbToleranceGPerHour } from './athleteProfile';
import type {
  MarathonRace,
  RaceStrategy,
  MilePacePlan,
  NutritionPlan,
  PacingStrategy,
  RaceStrategyPreferences,
  ElevationPoint,
  CourseSplit,
  AidStation,
} from '../types/raceStrategy';

// ── Storage Keys ──

const PREFS_KEY = 'apollo_race_strategy_prefs';
const STRATEGIES_KEY = 'apollo_race_strategies';
const CUSTOM_MARATHONS_KEY = 'apollo_custom_marathons';

let strategyCounter = 0;

// ── Preferences ──

export function getRaceStrategyPrefs(): RaceStrategyPreferences {
  try {
    const raw = persistence.getItem(PREFS_KEY);
    const prefs: RaceStrategyPreferences = raw ? JSON.parse(raw) : { enabled: false };
    if (prefs.selectedMarathonId) prefs.selectedMarathonId = normalizeMarathonId(prefs.selectedMarathonId);
    return prefs;
  } catch {
    return { enabled: false };
  }
}

export function setRaceStrategyPrefs(prefs: RaceStrategyPreferences): void {
  persistence.setItem(PREFS_KEY, JSON.stringify(prefs));
}

// v1.0.6 (RS-14): the opt-in gate (isRaceStrategyEnabled / enableRaceStrategy /
// disableRaceStrategy) is gone — the Race Day hub is always on. A stored
// `enabled` flag in old prefs is ignored.

// ── Custom Marathons (Import) ──

function getCustomMarathons(): MarathonRace[] {
  try {
    const raw = persistence.getItem(CUSTOM_MARATHONS_KEY);
    const list: MarathonRace[] = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.map((m) => ({ ...m, website: safeWebsite(m.website) })) : [];
  } catch {
    return [];
  }
}

function saveCustomMarathons(marathons: MarathonRace[]): void {
  persistence.setItem(CUSTOM_MARATHONS_KEY, JSON.stringify(marathons));
}

/** World Majors (dated to their next edition) followed by custom races. */
export function getAllMarathons(): MarathonRace[] {
  return [...getWorldMajors(), ...getCustomMarathons()];
}

/** A World Major (stable or legacy id) or a custom race. */
export function getMarathon(id: string): MarathonRace | undefined {
  return getMarathonById(id) ?? getCustomMarathons().find((m) => m.id === id);
}

/** Race distance in miles, falling back to the marathon when unknown. */
export function getRaceDistanceMi(race: Pick<MarathonRace, 'distanceMi'> | null | undefined): number {
  const d = race?.distanceMi;
  return typeof d === 'number' && Number.isFinite(d) && d > 0 ? d : 26.2;
}

/**
 * Keep a website only when it is a well-formed https:// URL (L9). Anything
 * else (http:, javascript:, data:, junk) becomes ''.
 */
export function safeWebsite(url: unknown): string {
  if (typeof url !== 'string' || !url.trim()) return '';
  try {
    const u = new URL(url.trim());
    return u.protocol === 'https:' ? u.toString() : '';
  } catch {
    return '';
  }
}

export interface CustomMarathonInput {
  name: string;
  city: string;
  country: string;
  date: string;
  courseType: MarathonRace['courseType'];
  distanceMi?: number;
  website?: string;
  /** Elevation gain in feet (optional — used for difficulty estimate) */
  elevationGainFt?: number;
  /** Elevation loss in feet (optional) */
  elevationLossFt?: number;
  /** Course difficulty 1-10 */
  difficulty?: number;
  /** Typical temperature range */
  typicalTempF?: { low: number; high: number };
  notes?: string;
  /** Race-local start time, 24 h 'HH:mm' (optional). */
  startTime?: string;
  /** IANA time zone of the race (optional). */
  timeZone?: string;
}

/** Validation message for a custom race, or null when it's valid (RS-7). */
export function validateCustomMarathonInput(input: CustomMarathonInput): string | null {
  if (!input.name?.trim()) return 'Enter a race name.';
  if (!isDateKey(input.date)) return 'Enter a valid race date (YYYY-MM-DD).';
  const d = input.distanceMi ?? 26.2;
  if (!Number.isFinite(d) || d < 1 || d > 200) return 'Distance must be between 1 and 200 miles.';
  if (input.website?.trim() && !safeWebsite(input.website)) return 'Website must start with https://';
  return null;
}

/**
 * Save a custom race. Throws a RangeError with a user-facing message when
 * the input is invalid (see {@link validateCustomMarathonInput}).
 */
export function importCustomMarathon(input: CustomMarathonInput): MarathonRace {
  const problem = validateCustomMarathonInput(input);
  if (problem) throw new RangeError(problem);

  const distanceMi = input.distanceMi ?? 26.2;
  const slug = input.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'race';
  const id = `custom-${slug}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const gain = input.elevationGainFt ?? 200;
  const loss = input.elevationLossFt ?? gain;
  const difficulty = input.difficulty ?? Math.min(10, Math.max(1, Math.round(gain / 150)));
  const [year, month] = input.date.split('-').map(Number);

  const marathon: MarathonRace = {
    id,
    name: input.name.trim(),
    city: input.city.trim(),
    country: input.country.trim(),
    category: 'custom',
    date: input.date,
    typicalMonth: month,
    distanceMi,
    courseType: input.courseType,
    typicalTempF: input.typicalTempF ?? { low: 50, high: 65 },
    typicalHumidity: 55,
    website: safeWebsite(input.website),
    isWorldMajor: false,
    year,
    courseDescription: input.notes ?? `Custom race: ${input.name} in ${input.city}, ${input.country}. Elevation profile: flat (no course file).`,
    tips: [],
    ...(input.startTime && /^([01]\d|2[0-3]):[0-5]\d$/.test(input.startTime) ? { startTime: input.startTime } : {}),
    ...(input.timeZone ? { timeZone: input.timeZone } : {}),
    course: {
      totalGainFt: gain,
      totalLossFt: loss,
      netChangeFt: gain - loss,
      highPointFt: gain,
      lowPointFt: 0,
      difficulty,
      bqFriendly: difficulty <= 3,
      prFriendly: difficulty <= 3,
      elevationPoints: buildFlatElevationProfile(distanceMi),
    },
    splits: buildDefaultSplits(Math.floor(distanceMi)),
    aidStations: buildDefaultAidStations(distanceMi),
  };

  const customs = getCustomMarathons();
  customs.push(marathon);
  saveCustomMarathons(customs);

  return marathon;
}

export function removeCustomMarathon(id: string): void {
  const customs = getCustomMarathons().filter((m) => m.id !== id);
  saveCustomMarathons(customs);
  // Also remove strategies for this marathon
  const strategies = getSavedStrategies().filter((s) => s.marathonId !== id);
  saveStrategies(strategies);
}

// ── Strategy CRUD ──

/** Saved strategies with legacy race ids normalised (migration on read). */
function getSavedStrategies(): RaceStrategy[] {
  try {
    const raw = persistence.getItem(STRATEGIES_KEY);
    const list: RaceStrategy[] = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(list)) return [];
    return list.map((s) => {
      const id = normalizeMarathonId(s.marathonId);
      return id === s.marathonId ? s : { ...s, marathonId: id };
    });
  } catch {
    return [];
  }
}

function saveStrategies(strategies: RaceStrategy[]): void {
  persistence.setItem(STRATEGIES_KEY, JSON.stringify(strategies));
}

export function getStrategiesForMarathon(marathonId: string): RaceStrategy[] {
  const id = normalizeMarathonId(marathonId);
  return getSavedStrategies().filter((s) => s.marathonId === id);
}

export function getStrategyById(id: string): RaceStrategy | undefined {
  return getSavedStrategies().find((s) => s.id === id);
}

/** Explicit, idempotent upsert by id (RS-5). */
export function saveStrategy(strategy: RaceStrategy): void {
  const strategies = getSavedStrategies();
  const normalized = { ...strategy, marathonId: normalizeMarathonId(strategy.marathonId), updatedAt: new Date().toISOString() };
  const idx = strategies.findIndex((s) => s.id === strategy.id);
  if (idx >= 0) strategies[idx] = normalized;
  else strategies.push(normalized);
  saveStrategies(strategies);
}

export function deleteStrategy(id: string): void {
  saveStrategies(getSavedStrategies().filter((s) => s.id !== id));
}

export function getAllStrategies(): RaceStrategy[] {
  return getSavedStrategies();
}

/**
 * Idempotent write-back of normalised race ids for saved strategies and
 * prefs. Reads already normalise, so calling this is optional; returns the
 * number of records rewritten.
 */
export function migrateStrategyRaceIds(): number {
  let changed = 0;
  try {
    const raw = persistence.getItem(STRATEGIES_KEY);
    const list: RaceStrategy[] = raw ? JSON.parse(raw) : [];
    if (Array.isArray(list)) {
      const next = list.map((s) => {
        const id = normalizeMarathonId(s.marathonId);
        if (id !== s.marathonId) changed++;
        return { ...s, marathonId: id };
      });
      if (changed > 0) saveStrategies(next);
    }
    const prefsRaw = persistence.getItem(PREFS_KEY);
    if (prefsRaw) {
      const prefs = JSON.parse(prefsRaw) as RaceStrategyPreferences;
      if (prefs.selectedMarathonId && normalizeMarathonId(prefs.selectedMarathonId) !== prefs.selectedMarathonId) {
        setRaceStrategyPrefs({ ...prefs, selectedMarathonId: normalizeMarathonId(prefs.selectedMarathonId) });
        changed++;
      }
    }
  } catch { /* ignore corrupt data */ }
  return changed;
}

// ── Goal validation (RS-11) ──

/** Approximate world-record time (s) for a distance: 2:00:35 marathon, Riegel exponent 1.06. */
export function worldRecordTimeSec(distanceMi: number): number {
  return 7235 * Math.pow(distanceMi / MARATHON_MI, 1.06);
}

/** Slowest goal we accept: 30 min per mile. */
const MAX_PACE_SEC_PER_MI = 30 * 60;

/**
 * Validation message for a goal time on a distance, or null when valid.
 * Rejects goals faster than world-record pace or slower than 30 min/mi.
 */
export function validateGoalTime(distanceMi: number, targetTimeSec: number): string | null {
  if (!Number.isFinite(distanceMi) || distanceMi <= 0) return 'This race has no valid distance.';
  if (!Number.isFinite(targetTimeSec) || targetTimeSec <= 0) return 'Enter a goal time.';
  const wr = worldRecordTimeSec(distanceMi);
  if (targetTimeSec < wr) {
    return `That's faster than the world record for this distance (about ${formatDurationSec(wr)}). Enter a slower goal.`;
  }
  if (targetTimeSec > distanceMi * MAX_PACE_SEC_PER_MI) {
    return `That's slower than 30 minutes per mile (${formatDurationSec(distanceMi * MAX_PACE_SEC_PER_MI)}). Enter a faster goal.`;
  }
  return null;
}

// ── Strategy Builder ──

/** Default split magnitude for negative/positive splits, in % (RS-4). */
export const DEFAULT_SPLIT_MAGNITUDE_PCT = 1.5;
const MAX_SPLIT_MAGNITUDE_PCT = 5;

/**
 * Planned second-half vs first-half difference (%) for a pacing style:
 * negative → −magnitude, positive → +magnitude, even → 0, effort-based → null
 * (halves follow the course; no half target).
 */
export function plannedSplitPct(pacing: PacingStrategy, magnitudePct: number = DEFAULT_SPLIT_MAGNITUDE_PCT): number | null {
  const m = Math.min(MAX_SPLIT_MAGNITUDE_PCT, Math.max(0, Number.isFinite(magnitudePct) ? magnitudePct : DEFAULT_SPLIT_MAGNITUDE_PCT));
  switch (pacing) {
    case 'negative-split': return -m;
    case 'positive-split': return m;
    case 'even-split': return 0;
    default: return null;
  }
}

/**
 * Grade-adjusted pace factor. Uphill slows you down, downhill speeds you up
 * (but with diminishing returns and quad cost on steep descents).
 *
 * @param gradePct  average grade of the segment in % (rise / run × 100)
 * @returns multiplier (>1 = slower, <1 = faster)
 */
function gradeAdjustmentFactor(gradePct: number): number {
  if (gradePct > 0) {
    // Uphill: ~12-15 sec/mi per 1% grade
    return 1 + gradePct * 0.033;
  } else {
    // Downhill: benefit with diminishing returns, steep descent is harder on quads
    const absGrade = Math.abs(gradePct);
    if (absGrade <= 3) return 1 - absGrade * 0.018;
    // Steep downhill over 3% — starts getting worse
    return 1 - 3 * 0.018 + (absGrade - 3) * 0.01;
  }
}

export interface BuildStrategyOptions {
  /** Negative/positive split magnitude in % (default 1.5, clamped 0–5). */
  splitMagnitudePct?: number;
  /** Carbohydrate target for the nutrition plan (g/h). Default 60. */
  carbsPerHourG?: number;
  /** Carbs per gel (g). Default 25. */
  gelCarbsG?: number;
}

/** Segment end distances (mi): 1, 2, … floor(D), then D if fractional. */
function segmentEnds(distanceMi: number): number[] {
  const ends: number[] = [];
  const whole = Math.floor(distanceMi + 1e-9);
  for (let i = 1; i <= whole; i++) ends.push(i);
  if (distanceMi - whole > 1e-6) ends.push(distanceMi);
  return ends;
}

/** Within-race pace shape (multiplier) at progress p ∈ [0, 1]. */
function paceShape(pacing: PacingStrategy, splitPct: number | null, p: number): number {
  if (pacing === 'effort-based') return 1 + p * 0.03; // mild fatigue: 1.0 → 1.03
  if (splitPct === null || splitPct === 0) return 1;
  // A linear ramp of total size 2·s gives raw halves ≈ the target ratio, so
  // the two half-scalings below stay close and the pace is continuous.
  return 1 + (2 * splitPct / 100) * (p - 0.5);
}

/**
 * Build a full mile-by-mile pacing plan based on target time, course profile,
 * and pacing strategy. PURE: nothing is saved — call {@link saveStrategy}.
 * Returns null for an unknown race or an invalid goal ({@link validateGoalTime}).
 */
export function buildRaceStrategy(
  marathonId: string,
  targetTimeSec: number,
  pacingStrategy: PacingStrategy,
  name?: string,
  options: BuildStrategyOptions = {}
): RaceStrategy | null {
  const marathon = getMarathon(marathonId);
  if (!marathon) return null;
  const totalMiles = getRaceDistanceMi(marathon);
  if (validateGoalTime(totalMiles, targetTimeSec) !== null) return null;

  const T = targetTimeSec;
  const avgPaceSec = T / totalMiles;
  const ends = segmentEnds(totalMiles);
  const lengths = ends.map((e, i) => e - (i === 0 ? 0 : ends[i - 1]));
  const elevChanges = getSegmentElevationChanges(marathon, ends);
  const splitPct = plannedSplitPct(pacingStrategy, options.splitMagnitudePct);

  // Raw (unnormalised) paces: grade over the REAL segment length (RS-6) × shape.
  const raw = ends.map((end, i) => {
    const gradePct = lengths[i] > 0 ? (elevChanges[i] / (5280 * lengths[i])) * 100 : 0;
    const mid = end - lengths[i] / 2;
    return avgPaceSec * gradeAdjustmentFactor(gradePct) * paceShape(pacingStrategy, splitPct, mid / totalMiles);
  });

  const paces = normalizePaces(raw, ends, lengths, T, totalMiles / 2, splitPct);

  // Build mile-by-mile plan from UNROUNDED cumulative time.
  const milePaces: MilePacePlan[] = [];
  const cumulative: number[] = [];
  let cumulativeTime = 0;
  for (let i = 0; i < paces.length; i++) {
    const isLastMile = i === paces.length - 1;
    cumulativeTime += paces[i] * lengths[i];
    cumulative.push(cumulativeTime);
    const split = marathon.splits[i];
    const notes = buildMileNotes(elevChanges[i] / Math.max(lengths[i], 0.05), split, i === 0, isLastMile);
    milePaces.push({
      mile: Math.round(ends[i] * 1000) / 1000,
      targetPaceSec: Math.round(paces[i]),
      targetPaceFormatted: formatPace(Math.round(paces[i])),
      cumulativeTimeSec: Math.round(cumulativeTime),
      cumulativeTimeFormatted: formatTimeSec(Math.round(cumulativeTime)),
      elevationChangeFt: Math.round(elevChanges[i]),
      notes,
    });
  }

  // Halves at distance / 2 (RS-1): exact target when one was set, else interpolated.
  const half = totalMiles / 2;
  const firstHalfExact = splitPct !== null
    ? T / (2 + splitPct / 100)
    : interpolateCumulative(ends, cumulative, half);
  const firstHalfSec = Math.round(firstHalfExact);
  const secondHalfSec = Math.round(T) - firstHalfSec;

  const nutritionPlan = buildNutritionPlan(marathon, milePaces, Math.round(T), options);
  const nowIso = new Date().toISOString();
  const stableId = normalizeMarathonId(marathon.id);

  return {
    id: `strategy-${stableId}-${Date.now()}-${++strategyCounter}`,
    name: name?.trim() || `${marathon.name} — ${formatTimeSec(T)} Plan`,
    marathonId: stableId,
    marathonName: marathon.name,
    targetTimeSec: Math.round(T),
    targetTimeFormatted: formatTimeSec(Math.round(T)),
    pacingStrategy,
    milePaces,
    nutritionPlan,
    firstHalfSec,
    secondHalfSec,
    splitPct: firstHalfSec > 0 ? Math.round(((secondHalfSec - firstHalfSec) / firstHalfSec) * 1000) / 10 : 0,
    distanceMi: totalMiles,
    avgPaceSec: Math.round(avgPaceSec),
    createdAt: nowIso,
    updatedAt: nowIso,
    notes: '',
  };
}

/** Linear interpolation of cumulative time at distance `d` (unrounded inputs). */
function interpolateCumulative(ends: number[], cumulative: number[], d: number): number {
  let prevEnd = 0;
  let prevCum = 0;
  for (let i = 0; i < ends.length; i++) {
    if (d <= ends[i]) {
      const len = ends[i] - prevEnd;
      return len > 0 ? prevCum + ((d - prevEnd) / len) * (cumulative[i] - prevCum) : cumulative[i];
    }
    prevEnd = ends[i];
    prevCum = cumulative[i];
  }
  return prevCum;
}

/**
 * Scale raw paces so the total equals `T`. With a split target `splitPct`,
 * the first half (to `half` miles) takes exactly T / (2 + s) and the second
 * the rest; the segment containing halfway keeps the first-half scaling so a
 * linear interpolation of cumulative time hits the target at `half`.
 */
function normalizePaces(
  raw: number[],
  ends: number[],
  lengths: number[],
  T: number,
  half: number,
  splitPct: number | null
): number[] {
  const plain = () => {
    const rawTotal = raw.reduce((sum, p, i) => sum + p * lengths[i], 0);
    const k = rawTotal > 0 ? T / rawTotal : 1;
    return raw.map((p) => p * k);
  };
  if (splitPct === null) return plain();

  const h = ends.findIndex((e) => half <= e + 1e-9);
  if (h < 0 || h >= ends.length - 1) return plain();
  const prevEnd = h === 0 ? 0 : ends[h - 1];
  const s = splitPct / 100;
  const T1 = T / (2 + s);
  const T2 = T - T1;

  let R1 = raw[h] * (half - prevEnd);
  for (let i = 0; i < h; i++) R1 += raw[i] * lengths[i];
  let R2 = 0;
  for (let i = h + 1; i < raw.length; i++) R2 += raw[i] * lengths[i];
  if (R1 <= 0 || R2 <= 0) return plain();

  const k1 = T1 / R1;
  const remainder = k1 * raw[h] * (ends[h] - half);
  const k2 = (T2 - remainder) / R2;
  if (!(k2 > 0)) return plain();
  return raw.map((p, i) => p * (i <= h ? k1 : k2));
}

/** Elevation change (ft) over each segment, from the course profile. */
function getSegmentElevationChanges(marathon: MarathonRace, ends: number[]): number[] {
  const points = marathon.course.elevationPoints;
  if (points.length < 2) return ends.map(() => 0);
  return ends.map((end, i) => {
    const start = i === 0 ? 0 : ends[i - 1];
    return interpolateElevation(points, end) - interpolateElevation(points, start);
  });
}

/** Linear interpolation of elevation at a given distance */
function interpolateElevation(points: ElevationPoint[], distanceMi: number): number {
  if (points.length === 0) return 0;
  if (distanceMi <= points[0].distanceMi) return points[0].elevationFt;
  if (distanceMi >= points[points.length - 1].distanceMi) return points[points.length - 1].elevationFt;

  for (let i = 1; i < points.length; i++) {
    if (distanceMi <= points[i].distanceMi) {
      const prev = points[i - 1];
      const curr = points[i];
      const ratio = (distanceMi - prev.distanceMi) / (curr.distanceMi - prev.distanceMi);
      return prev.elevationFt + ratio * (curr.elevationFt - prev.elevationFt);
    }
  }
  return points[points.length - 1].elevationFt;
}

/** Course elevation (ft) at `distanceMi`, linearly interpolated from the race's profile. */
export function courseElevationFtAt(race: Pick<MarathonRace, 'course'>, distanceMi: number): number {
  return interpolateElevation(race.course?.elevationPoints ?? [], distanceMi);
}

/**
 * Build contextual notes for a mile based on elevation and landmarks.
 * @param elevChangeFtPerMi elevation change normalised to one mile
 */
function buildMileNotes(elevChangeFtPerMi: number, split: CourseSplit | undefined, isFirst: boolean, isLast: boolean): string {
  const parts: string[] = [];

  if (isFirst) parts.push('Start controlled — don\'t go out too fast');
  if (isLast) parts.push('Give everything you have left');

  if (elevChangeFtPerMi > 60) parts.push('Steep uphill — ease back on pace, keep effort steady');
  else if (elevChangeFtPerMi > 30) parts.push('Uphill — shorten stride, maintain effort');
  else if (elevChangeFtPerMi < -60) parts.push('Steep downhill — protect your quads');
  else if (elevChangeFtPerMi < -30) parts.push('Downhill — don\'t overstride, controlled descent');

  if (split?.landmarks?.length) {
    parts.push(split.landmarks.join(', '));
  }

  return parts.join(' · ');
}

// ── Nutrition (RS-3) ──

/**
 * Time-based gel plan from the single fueling generator
 * ({@link planRaceFueling}: one cadence = 60 × gel carbs ÷ g/h target, which
 * defaults to the athlete's carb tolerance). Gels are mapped to distance with
 * the plan's own cumulative times; none in the final 15 minutes.
 */
function buildNutritionPlan(
  marathon: MarathonRace,
  milePaces: MilePacePlan[],
  finishSec: number,
  options: BuildStrategyOptions
): NutritionPlan[] {
  const fuel = planRaceFueling({
    finishSec,
    distanceMi: getRaceDistanceMi(marathon),
    carbsPerHourG: options.carbsPerHourG ?? getCarbToleranceGPerHour(),
    ...(options.gelCarbsG && options.gelCarbsG > 0 ? { gelCarbsG: options.gelCarbsG } : {}),
    distanceAtTimeSec: (t) => distanceAtTime(milePaces, t),
    aidStations: marathon.aidStations,
  });
  let gelNo = 0;
  return fuel.items.map((item) => ({
    mile: Math.round(item.distanceMi * 10) / 10,
    item: item.kind === 'pre-race'
      ? `Pre-race gel (${item.carbsG} g carbs) + a few sips of water`
      : `Energy gel ${++gelNo} (${item.carbsG} g carbs)`,
    notes: item.kind === 'pre-race'
      ? '15 min before the start'
      : item.note ? `${item.note} — take water with it` : 'Carry your own; take water with it if available',
    timeSec: item.timeSec,
    carbsG: item.carbsG,
  }));
}


// ── Helpers ──

function formatPace(totalSec: number): string {
  const rounded = Math.round(totalSec);
  const m = Math.floor(rounded / 60);
  const s = rounded % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function buildFlatElevationProfile(distanceMi: number): ElevationPoint[] {
  const points: ElevationPoint[] = [];
  for (let d = 0; d <= distanceMi; d += 2) {
    points.push({ distanceMi: d, elevationFt: 100 });
  }
  if (points.length === 0 || points[points.length - 1].distanceMi < distanceMi) {
    points.push({ distanceMi: distanceMi, elevationFt: 100 });
  }
  return points;
}

function buildDefaultSplits(totalMiles: number): CourseSplit[] {
  const splits: CourseSplit[] = [];
  for (let i = 1; i <= totalMiles; i++) {
    splits.push({
      number: i,
      endMi: i,
      elevationChangeFt: 0,
      terrain: 'Flat',
      landmarks: [],
    });
  }
  return splits;
}

function buildDefaultAidStations(distanceMi: number): AidStation[] {
  const stations: AidStation[] = [];
  for (let d = 2.5; d < distanceMi; d += 2.5) {
    stations.push({
      distanceMi: Math.round(d * 10) / 10,
      name: `Station ${stations.length + 1}`,
      offerings: ['water', 'sports drink'],
    });
  }
  return stations;
}

// ── Shared plan helpers (v1.0.6) ──
// Every race-day consumer (race card, timeline, fuel, halves) must use these
// instead of summing `targetPaceSec`: the final entry (e.g. mile 26.2) is a
// PACE for a partial segment, so segment time = cumulative difference.

export const KM_PER_MI = 1.609344;
export const MARATHON_MI = 26.21875;
export const HALF_MARATHON_MI = 13.109375;

/** Race distance in miles for a strategy (stored field, else the last split's end). */
export function getStrategyDistanceMi(strategy: Pick<RaceStrategy, 'milePaces' | 'distanceMi'>): number {
  if (typeof strategy.distanceMi === 'number' && strategy.distanceMi > 0) return strategy.distanceMi;
  const last = strategy.milePaces[strategy.milePaces.length - 1];
  return last ? last.mile : 0;
}

/** Length of segment `i` in miles (the last one may be partial, e.g. 0.2). */
export function segmentDistanceMi(milePaces: MilePacePlan[], i: number): number {
  if (i < 0 || i >= milePaces.length) return 0;
  const prevEnd = i === 0 ? 0 : milePaces[i - 1].mile;
  return Math.max(0, milePaces[i].mile - prevEnd);
}

/** Time for segment `i` in seconds, from cumulative differences. */
export function segmentTimeSec(milePaces: MilePacePlan[], i: number): number {
  if (i < 0 || i >= milePaces.length) return 0;
  const prevCum = i === 0 ? 0 : milePaces[i - 1].cumulativeTimeSec;
  return milePaces[i].cumulativeTimeSec - prevCum;
}

/**
 * Planned elapsed time (s) at `distanceMi`, linearly interpolated inside the
 * segment that contains it. Clamped to [0, finish].
 */
export function timeAtDistance(milePaces: MilePacePlan[], distanceMi: number): number {
  if (milePaces.length === 0 || !Number.isFinite(distanceMi) || distanceMi <= 0) return 0;
  let prevEnd = 0;
  let prevCum = 0;
  for (const seg of milePaces) {
    if (distanceMi <= seg.mile) {
      const len = seg.mile - prevEnd;
      if (len <= 0) return seg.cumulativeTimeSec;
      return prevCum + ((distanceMi - prevEnd) / len) * (seg.cumulativeTimeSec - prevCum);
    }
    prevEnd = seg.mile;
    prevCum = seg.cumulativeTimeSec;
  }
  return prevCum;
}

/** Inverse of {@link timeAtDistance}: planned distance (mi) after `timeSec`. */
export function distanceAtTime(milePaces: MilePacePlan[], timeSec: number): number {
  if (milePaces.length === 0 || !Number.isFinite(timeSec) || timeSec <= 0) return 0;
  let prevEnd = 0;
  let prevCum = 0;
  for (const seg of milePaces) {
    if (timeSec <= seg.cumulativeTimeSec) {
      const dt = seg.cumulativeTimeSec - prevCum;
      if (dt <= 0) return seg.mile;
      return prevEnd + ((timeSec - prevCum) / dt) * (seg.mile - prevEnd);
    }
    prevEnd = seg.mile;
    prevCum = seg.cumulativeTimeSec;
  }
  return prevEnd;
}

/**
 * Duration as "h:mm:ss" (≥ 1 h) or "m:ss". Rounds the TOTAL first, so it can
 * never print ":60". `signed` prefixes "+" / "−" ("0:00" for zero).
 */
export function formatDurationSec(sec: number, opts: { signed?: boolean } = {}): string {
  if (!Number.isFinite(sec)) return '—';
  const total = Math.round(Math.abs(sec));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const body = h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
  if (!opts.signed) return sec < 0 && total > 0 ? `−${body}` : body;
  if (total === 0) return body;
  return `${sec > 0 ? '+' : '−'}${body}`;
}

/** Pace in seconds per `unit` from seconds per mile. */
export function paceSecForUnit(secPerMi: number, unit: 'mi' | 'km'): number {
  return unit === 'km' ? secPerMi / KM_PER_MI : secPerMi;
}

/** "m:ss" pace (no suffix) in the given unit, rounding the total first. */
export function formatPaceForUnit(secPerMi: number, unit: 'mi' | 'km'): string {
  if (!Number.isFinite(secPerMi) || secPerMi <= 0) return '—';
  return formatDurationSec(paceSecForUnit(secPerMi, unit));
}

/** One row of a per-mile or per-km split table. */
export interface UnitSplit {
  /** 1-based row number. */
  index: number;
  /** Distance at the end of the row, in the row's unit (e.g. 42.16 for the last km row). */
  endDistance: number;
  /** Row length in the row's unit (the last row may be partial). */
  length: number;
  /** End distance in miles (for interpolation and course lookups). */
  endMi: number;
  /** Time for this row (s). */
  splitSec: number;
  /** Elapsed time at the end of the row (s). */
  cumulativeSec: number;
  /** Pace for this row, seconds per unit. */
  paceSecPerUnit: number;
}

/**
 * Split table in miles or kilometres. Km rows interpolate the plan's
 * cumulative times, so they agree exactly with the mile plan and the finish.
 */
export function buildUnitSplits(milePaces: MilePacePlan[], unit: 'mi' | 'km', distanceMi?: number): UnitSplit[] {
  const totalMi = distanceMi ?? (milePaces[milePaces.length - 1]?.mile ?? 0);
  if (totalMi <= 0) return [];
  const step = unit === 'km' ? 1 / KM_PER_MI : 1;
  const totalUnits = totalMi / step;
  const rows: UnitSplit[] = [];
  let prevCum = 0;
  let prevEnd = 0;
  for (let i = 1; prevEnd < totalUnits - 1e-6; i++) {
    const end = Math.min(i, totalUnits);
    const endMi = Math.min(end * step, totalMi);
    const cum = timeAtDistance(milePaces, endMi);
    const length = end - prevEnd;
    rows.push({
      index: i,
      endDistance: Math.round(end * 100) / 100,
      length,
      endMi,
      splitSec: cum - prevCum,
      cumulativeSec: cum,
      paceSecPerUnit: length > 0 ? (cum - prevCum) / length : 0,
    });
    prevCum = cum;
    prevEnd = end;
  }
  return rows;
}

// ── Utility Exports ──

export { formatPace, formatTimeSec };
