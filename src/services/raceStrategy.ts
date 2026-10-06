// Race strategy service — mile-by-mile pacing plans, nutrition strategies, custom marathon imports.

import { persistence } from './db/persistence';
import { WORLD_MAJOR_MARATHONS, getMarathonById } from '../data/worldMajors';
import { formatTimeSec } from './racePrediction';
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
    return raw ? JSON.parse(raw) : { enabled: false };
  } catch {
    return { enabled: false };
  }
}

export function setRaceStrategyPrefs(prefs: RaceStrategyPreferences): void {
  persistence.setItem(PREFS_KEY, JSON.stringify(prefs));
}

export function isRaceStrategyEnabled(): boolean {
  return getRaceStrategyPrefs().enabled;
}

export function enableRaceStrategy(): void {
  const prefs = getRaceStrategyPrefs();
  prefs.enabled = true;
  prefs.enabledAt = new Date().toISOString();
  setRaceStrategyPrefs(prefs);
}

export function disableRaceStrategy(): void {
  const prefs = getRaceStrategyPrefs();
  prefs.enabled = false;
  setRaceStrategyPrefs(prefs);
}

// ── Custom Marathons (Import) ──

function getCustomMarathons(): MarathonRace[] {
  try {
    const raw = persistence.getItem(CUSTOM_MARATHONS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveCustomMarathons(marathons: MarathonRace[]): void {
  persistence.setItem(CUSTOM_MARATHONS_KEY, JSON.stringify(marathons));
}

export function getAllMarathons(): MarathonRace[] {
  return [...WORLD_MAJOR_MARATHONS, ...getCustomMarathons()];
}

export function getMarathon(id: string): MarathonRace | undefined {
  return getMarathonById(id) ?? getCustomMarathons().find((m) => m.id === id);
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
}

export function importCustomMarathon(input: CustomMarathonInput): MarathonRace {
  const id = `custom-${input.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Date.now()}`;
  const gain = input.elevationGainFt ?? 200;
  const loss = input.elevationLossFt ?? gain;
  const difficulty = input.difficulty ?? Math.min(10, Math.max(1, Math.round(gain / 150)));

  const marathon: MarathonRace = {
    id,
    name: input.name.trim(),
    city: input.city.trim(),
    country: input.country.trim(),
    category: 'custom',
    date: input.date,
    typicalMonth: new Date(input.date + 'T00:00:00').getMonth() + 1,
    distanceMi: input.distanceMi ?? 26.2,
    courseType: input.courseType,
    typicalTempF: input.typicalTempF ?? { low: 50, high: 65 },
    typicalHumidity: 55,
    website: input.website ?? '',
    isWorldMajor: false,
    year: new Date(input.date + 'T00:00:00').getFullYear(),
    courseDescription: input.notes ?? `Custom marathon: ${input.name} in ${input.city}, ${input.country}.`,
    tips: [],
    course: {
      totalGainFt: gain,
      totalLossFt: loss,
      netChangeFt: loss - gain,
      highPointFt: gain,
      lowPointFt: 0,
      difficulty,
      bqFriendly: difficulty <= 3,
      prFriendly: difficulty <= 3,
      elevationPoints: buildFlatElevationProfile(input.distanceMi ?? 26.2),
    },
    splits: buildDefaultSplits(Math.floor(input.distanceMi ?? 26)),
    aidStations: buildDefaultAidStations(input.distanceMi ?? 26.2),
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

function getSavedStrategies(): RaceStrategy[] {
  try {
    const raw = persistence.getItem(STRATEGIES_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveStrategies(strategies: RaceStrategy[]): void {
  persistence.setItem(STRATEGIES_KEY, JSON.stringify(strategies));
}

export function getStrategiesForMarathon(marathonId: string): RaceStrategy[] {
  return getSavedStrategies().filter((s) => s.marathonId === marathonId);
}

export function getStrategyById(id: string): RaceStrategy | undefined {
  return getSavedStrategies().find((s) => s.id === id);
}

export function saveStrategy(strategy: RaceStrategy): void {
  const strategies = getSavedStrategies();
  const idx = strategies.findIndex((s) => s.id === strategy.id);
  if (idx >= 0) strategies[idx] = strategy;
  else strategies.push(strategy);
  saveStrategies(strategies);
}

export function deleteStrategy(id: string): void {
  saveStrategies(getSavedStrategies().filter((s) => s.id !== id));
}

export function getAllStrategies(): RaceStrategy[] {
  return getSavedStrategies();
}

// ── Strategy Builder ──

/**
 * Grade-adjusted pace factor. Uphill slows you down, downhill speeds you up
 * (but with diminishing returns and quad cost on steep descents).
 *
 * @param elevationChangeFt  elevation change over 1 mile
 * @returns multiplier (>1 = slower, <1 = faster)
 */
function gradeAdjustmentFactor(elevationChangeFt: number): number {
  const gradePct = (elevationChangeFt / 5280) * 100; // % grade
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

/**
 * Build a full mile-by-mile pacing plan based on target time, course profile,
 * and pacing strategy.
 */
export function buildRaceStrategy(
  marathonId: string,
  targetTimeSec: number,
  pacingStrategy: PacingStrategy,
  name?: string
): RaceStrategy | null {
  const marathon = getMarathon(marathonId);
  if (!marathon) return null;

  const totalMiles = marathon.distanceMi;
  const avgPaceSec = targetTimeSec / totalMiles;

  // Calculate elevation change per mile from course profile
  const mileElevationChanges = getMileElevationChanges(marathon);

  // Build base pace array with grade adjustments
  const basePaces = Array.from({ length: Math.ceil(totalMiles) }, (_, i) => {
    const elevChange = mileElevationChanges[i] ?? 0;
    return avgPaceSec * gradeAdjustmentFactor(elevChange);
  });

  // Apply pacing strategy
  const adjustedPaces = applyPacingStrategy(basePaces, pacingStrategy);

  // Normalize paces so total time matches target
  const rawTotal = adjustedPaces.reduce((sum, p, i) => {
    const mileDist = i === adjustedPaces.length - 1 ? totalMiles - Math.floor(totalMiles) || 1 : 1;
    return sum + p * mileDist;
  }, 0);
  const normFactor = targetTimeSec / rawTotal;
  const normalizedPaces = adjustedPaces.map((p) => p * normFactor);

  // Build mile-by-mile plan
  const milePaces: MilePacePlan[] = [];
  let cumulativeTime = 0;

  for (let i = 0; i < normalizedPaces.length; i++) {
    const mileNum = i + 1;
    const isLastMile = i === normalizedPaces.length - 1;
    const mileDist = isLastMile && totalMiles % 1 > 0 ? totalMiles % 1 : 1;
    const mileTime = normalizedPaces[i] * mileDist;
    cumulativeTime += mileTime;

    const elevChange = mileElevationChanges[i] ?? 0;
    const split = marathon.splits[i];
    const notes = buildMileNotes(elevChange, split, i === 0, isLastMile);

    milePaces.push({
      mile: isLastMile && totalMiles % 1 > 0 ? Math.round(totalMiles * 10) / 10 : mileNum,
      targetPaceSec: Math.round(normalizedPaces[i]),
      targetPaceFormatted: formatPace(Math.round(normalizedPaces[i])),
      cumulativeTimeSec: Math.round(cumulativeTime),
      cumulativeTimeFormatted: formatTimeSec(Math.round(cumulativeTime)),
      elevationChangeFt: Math.round(elevChange),
      notes,
    });
  }

  // Nutrition plan based on aid stations and general guidelines
  const nutritionPlan = buildNutritionPlan(marathon, normalizedPaces);

  // First/second half times
  const halfIdx = milePaces.findIndex((m) => m.mile >= 13);
  const firstHalfSec = halfIdx >= 0 ? milePaces[halfIdx].cumulativeTimeSec : Math.round(targetTimeSec / 2);
  const secondHalfSec = Math.round(targetTimeSec) - firstHalfSec;

  const strategy: RaceStrategy = {
    id: `strategy-${marathonId}-${Date.now()}-${++strategyCounter}`,
    name: name?.trim() || `${marathon.name} — ${formatTimeSec(targetTimeSec)} Plan`,
    marathonId,
    marathonName: marathon.name,
    targetTimeSec: Math.round(targetTimeSec),
    targetTimeFormatted: formatTimeSec(Math.round(targetTimeSec)),
    pacingStrategy,
    milePaces,
    nutritionPlan,
    firstHalfSec,
    secondHalfSec,
    avgPaceSec: Math.round(avgPaceSec),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    notes: '',
  };

  saveStrategy(strategy);
  return strategy;
}

/** Extract mile-by-mile elevation change from course elevation points */
function getMileElevationChanges(marathon: MarathonRace): number[] {
  const points = marathon.course.elevationPoints;
  if (points.length < 2) return Array(Math.ceil(marathon.distanceMi)).fill(0);

  const changes: number[] = [];
  const totalMiles = Math.ceil(marathon.distanceMi);

  for (let mile = 0; mile < totalMiles; mile++) {
    const startDist = mile;
    const endDist = mile + 1;
    const startElev = interpolateElevation(points, startDist);
    const endElev = interpolateElevation(points, Math.min(endDist, marathon.distanceMi));
    changes.push(endElev - startElev);
  }

  return changes;
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

/** Apply pacing strategy adjustments to base paces */
function applyPacingStrategy(basePaces: number[], strategy: PacingStrategy): number[] {
  // Guard against a single-split course (n - 1 === 0 would yield NaN paces).
  const n = Math.max(2, basePaces.length);

  switch (strategy) {
    case 'even-split':
      // Just use grade-adjusted paces as-is
      return [...basePaces];

    case 'negative-split': {
      // Start 3-5% slower, finish 3-5% faster
      return basePaces.map((pace, i) => {
        const progress = i / (n - 1);
        // 1.04 at start → 0.96 at finish
        const factor = 1.04 - progress * 0.08;
        return pace * factor;
      });
    }

    case 'positive-split': {
      // Start 2% faster, finish 2-4% slower (more realistic for most runners)
      return basePaces.map((pace, i) => {
        const progress = i / (n - 1);
        const factor = 0.98 + progress * 0.06;
        return pace * factor;
      });
    }

    case 'effort-based': {
      // Run by perceived effort — even effort, not even pace
      // Already handled by grade adjustments, but add some fatigue modeling
      return basePaces.map((pace, i) => {
        const progress = i / (n - 1);
        // Minimal fatigue factor: 1.0 → 1.03 over the course
        const fatigueFactor = 1 + progress * 0.03;
        return pace * fatigueFactor;
      });
    }

    default:
      return [...basePaces];
  }
}

/** Build contextual notes for a mile based on elevation and landmarks */
function buildMileNotes(elevChangeFt: number, split: CourseSplit | undefined, isFirst: boolean, isLast: boolean): string {
  const parts: string[] = [];

  if (isFirst) parts.push('Start controlled — don\'t go out too fast');
  if (isLast) parts.push('Give everything you have left');

  if (elevChangeFt > 60) parts.push('Steep uphill — ease back on pace, keep effort steady');
  else if (elevChangeFt > 30) parts.push('Uphill — shorten stride, maintain effort');
  else if (elevChangeFt < -60) parts.push('Steep downhill — protect your quads');
  else if (elevChangeFt < -30) parts.push('Downhill — don\'t overstride, controlled descent');

  if (split?.landmarks?.length) {
    parts.push(split.landmarks.join(', '));
  }

  return parts.join(' · ');
}

/** Build a sensible nutrition/hydration plan */
function buildNutritionPlan(marathon: MarathonRace, paces: number[]): NutritionPlan[] {
  const plan: NutritionPlan[] = [];

  // General guidelines: water every 2-3 miles, gel every ~40 min, electrolytes
  plan.push({ mile: 0, item: 'Pre-race: Gel + water', notes: '15-20 min before start' });

  // Gels are time-based, so place them from the projected per-mile paces —
  // slower runners are out longer and get more gels.
  const gelMiles = getGelMiles(marathon.distanceMi, paces);
  for (const mile of gelMiles) {
    const nearAid = marathon.aidStations.find((a) => Math.abs(a.distanceMi - mile) <= 1.5);
    plan.push({
      mile,
      item: `Energy gel + water`,
      notes: nearAid ? `Near ${nearAid.name} (mi ${nearAid.distanceMi})` : 'Carry your own gel',
    });
  }

  // Water at aid stations not covered by gel miles
  for (const aid of marathon.aidStations) {
    const nearGel = gelMiles.some((g) => Math.abs(aid.distanceMi - g) <= 1.5);
    if (!nearGel && aid.distanceMi > 2) {
      plan.push({
        mile: aid.distanceMi,
        item: 'Water or electrolyte',
        notes: `${aid.name} — ${aid.offerings.join(', ')}`,
      });
    }
  }

  return plan.sort((a, b) => a.mile - b.mile);
}

/** Target gap between gels, in seconds of projected race time. */
const GEL_INTERVAL_SEC = 40 * 60;

/**
 * Whole-mile markers for gels roughly every {@link GEL_INTERVAL_SEC} of
 * projected race time (using the course-adjusted per-mile paces), with none in
 * the final two miles where a gel can't be absorbed in time. Falls back to the
 * classic 5/10/15/20/23 schedule when the paces are unusable.
 */
function getGelMiles(distanceMi: number, paces: number[]): number[] {
  const wholeMiles = Math.floor(distanceMi);
  if (paces.length === 0 || !paces.every((p) => Number.isFinite(p) && p > 0)) {
    return [5, 10, 15, 20, 23].filter((m) => m < wholeMiles);
  }

  const lastGelMile = wholeMiles - 2;
  const miles: number[] = [];
  let elapsedSec = 0;
  let nextGelSec = GEL_INTERVAL_SEC;
  for (let i = 0; i < paces.length && i + 1 <= lastGelMile; i++) {
    elapsedSec += paces[i];
    if (elapsedSec >= nextGelSec) {
      miles.push(i + 1);
      while (nextGelSec <= elapsedSec) nextGelSec += GEL_INTERVAL_SEC;
    }
  }
  return miles;
}

// ── Helpers ──

function formatPace(totalSec: number): string {
  const m = Math.floor(totalSec / 60);
  const s = Math.round(totalSec % 60);
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

// ── Utility Exports ──

export { formatPace, formatTimeSec };
