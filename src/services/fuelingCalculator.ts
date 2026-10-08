/**
 * In-Race Fueling Calculator — carbohydrate (and optional caffeine) timing
 * for any race distance.
 *
 * v1.0.6: ONE gel cadence for the whole app. The athlete's carb target
 * (athleteProfile carb tolerance, default 60 g/h, capped at 90 g/h) sets the
 * interval: `60 × gelCarbsG / target` minutes (25 g gels at 60 g/h → every
 * 25 min). {@link planRaceFueling} builds the race-day timeline; the older
 * {@link generateFuelingPlan} and {@link getGelSchedule} reuse it.
 *
 * Based on:
 * - Jeukendrup (2014): 30–60 g/h for 1–2.5 h; up to 90 g/h beyond 2.5 h, which
 *   needs glucose + fructose (multiple transportable carbs) and a trained gut
 * - Burke et al. (2011) / Thomas, Erdman & Burke (ACSM 2016): practical sport nutrition guidelines
 * - Goldstein et al. (2010): caffeine 3–6 mg/kg ~60 min pre-race, or ~1–3 mg/kg late in the race
 * - Pfeiffer et al. (2012): GI distress incidence in marathon runners
 * - ACSM (2007) / EAH consensus: never plan to drink more than you sweat
 */

import type {
  AthleteProfile,
  FuelingPlan,
  FuelingItem,
  CaffeineStrategy,
} from '../types/nutrition';
import type { AidStation } from '../types/raceStrategy';

// ── Race-day fueling timeline (v1.0.6) ────────────────────────────────────────

/** Input for {@link planRaceFueling}. */
export interface RaceFuelingInput {
  /** Expected finish time in seconds after the gun. */
  finishSec: number;
  /** Race distance in miles. */
  distanceMi: number;
  /** The athlete's carbohydrate target / gut tolerance in g/h (capped at 90). */
  carbsPerHourG: number;
  /** Carbohydrate per gel in grams. Default 25. */
  gelCarbsG?: number;
  /** Distance covered (mi) at a race time (s), e.g. from the pacing plan. Default: even pace. */
  distanceAtTimeSec?: (sec: number) => number;
  /** Course aid stations; gels close to one get a note. */
  aidStations?: AidStation[];
  /** Plan a gel ~15 min before the start. Default true. */
  preRaceGel?: boolean;
}

/** One entry of the race fueling timeline. */
export interface RaceFuelingItem {
  kind: 'pre-race' | 'gel';
  /** Seconds after the gun (negative = before the start). */
  timeSec: number;
  /** Distance covered at that moment, in miles (0 for the pre-race gel). */
  distanceMi: number;
  carbsG: number;
  label: string;
  note?: string;
}

/** Output of {@link planRaceFueling}. */
export interface RaceFuelingPlan {
  /** Carb target actually planned (g/h): the athlete's value capped at 90. */
  targetCarbsPerHourG: number;
  /** Minutes between gels (one cadence for the whole race). */
  gelIntervalMin: number;
  items: RaceFuelingItem[];
  /** In-race carbohydrate (g); the pre-race gel is not counted. */
  totalCarbsG: number;
  /** True above ~60 g/h, where glucose + fructose products are needed. */
  needsMultipleTransportable: boolean;
  notes: string[];
}

/** Default carb target (g/h) — the same as athleteProfile's default carb tolerance. */
export const DEFAULT_CARBS_PER_HOUR_G = 60;
/** Highest carb target the planner uses (g/h). */
export const RACE_MAX_CARBS_PER_HOUR_G = 90;
const RACE_LOW_CARBS_PER_HOUR_G = 30;
const MULTIPLE_TRANSPORTABLE_ABOVE_G = 60;
/** Standard gel: 25 g carbs. */
export const DEFAULT_GEL_CARBS_G = 25;
const FIRST_GEL_MIN_SEC = 20 * 60;
const FIRST_GEL_MAX_SEC = 45 * 60;
/** Carbs taken in the final 15 min can't be absorbed in time to help. */
const NO_GEL_FINAL_SEC = 15 * 60;
/** Below ~60 min, in-race carbs aren't needed (a mouth rinse is enough). */
const MIN_FUELED_RACE_SEC = 60 * 60;
const PRE_RACE_GEL_SEC = -15 * 60;
const AID_STATION_RADIUS_MI = 0.6;
/** Safety bound on timeline length (tiny gels / huge targets). */
const MAX_RACE_GELS = 60;

function isPositiveFinite(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** The aid station closest to `mi`, if one lies within {@link AID_STATION_RADIUS_MI}. */
function nearestAidStation(stations: AidStation[] | undefined, mi: number): AidStation | null {
  let best: AidStation | null = null;
  let bestGap = Infinity;
  for (const station of stations ?? []) {
    if (!Number.isFinite(station.distanceMi)) continue;
    const gap = Math.abs(station.distanceMi - mi);
    if (gap <= AID_STATION_RADIUS_MI && gap < bestGap) {
      best = station;
      bestGap = gap;
    }
  }
  return best;
}

/**
 * Builds the race-day fueling timeline with ONE gel cadence derived from the
 * athlete's carb target: `gelIntervalMin = 60 × gelCarbsG / target`
 * (25 g gels at 60 g/h → every 25 min).
 *
 * - target = min(carbsPerHourG, 90); lower values are respected (with a note under 30 g/h).
 * - First gel one interval after the gun, clamped to 20–45 min; none in the final 15 min.
 * - Races under ~60 min get no in-race carbs (a carb mouth rinse is enough).
 * - Optional pre-race gel at −15 min (not counted in `totalCarbsG`).
 * - Invalid input yields an empty timeline plus a note — never NaN.
 *
 * Pure: no persistence, no unit formatting (distances are miles; the UI converts).
 */
export function planRaceFueling(input: RaceFuelingInput): RaceFuelingPlan {
  const notes: string[] = [];
  if (!isPositiveFinite(input.carbsPerHourG)) {
    return {
      targetCarbsPerHourG: 0,
      gelIntervalMin: 0,
      items: [],
      totalCarbsG: 0,
      needsMultipleTransportable: false,
      notes: ['Set a carbohydrate target (g/h) to build a fueling plan.'],
    };
  }

  const gelCarbsG = isPositiveFinite(input.gelCarbsG) ? input.gelCarbsG : DEFAULT_GEL_CARBS_G;
  const target = Math.min(input.carbsPerHourG, RACE_MAX_CARBS_PER_HOUR_G);
  const gelIntervalMin = (60 * gelCarbsG) / target;
  const needsMultipleTransportable = target > MULTIPLE_TRANSPORTABLE_ABOVE_G;

  if (input.carbsPerHourG > RACE_MAX_CARBS_PER_HOUR_G) {
    notes.push('Capped at 90 g/h — the top of the evidence for running.');
  }
  if (target < RACE_LOW_CARBS_PER_HOUR_G) {
    notes.push(
      `${Math.round(target)} g/h is below the usual 30–60 g/h guidance for races over an hour — fine if it is what your gut tolerates, but consider training it up.`,
    );
  }
  if (needsMultipleTransportable) {
    notes.push('Above ~60 g/h use glucose+fructose products and a trained gut — practise this intake on long runs first.');
  }

  const plan = (items: RaceFuelingItem[]): RaceFuelingPlan => ({
    targetCarbsPerHourG: target,
    gelIntervalMin,
    items,
    totalCarbsG: items.filter((i) => i.kind === 'gel').reduce((sum, i) => sum + i.carbsG, 0),
    needsMultipleTransportable,
    notes,
  });

  const { finishSec, distanceMi } = input;
  if (!isPositiveFinite(finishSec) || !isPositiveFinite(distanceMi)) {
    notes.push('Add a goal time and race distance to build the fueling timeline.');
    return plan([]);
  }

  const evenPaceDistance = (sec: number): number => (sec / finishSec) * distanceMi;
  const distanceAt = (sec: number): number => {
    const raw = input.distanceAtTimeSec ? input.distanceAtTimeSec(sec) : evenPaceDistance(sec);
    const mi = Number.isFinite(raw) ? raw : evenPaceDistance(sec);
    return Math.round(clampNumber(mi, 0, distanceMi) * 100) / 100;
  };

  const items: RaceFuelingItem[] = [];
  if (input.preRaceGel !== false) {
    items.push({
      kind: 'pre-race',
      timeSec: PRE_RACE_GEL_SEC,
      distanceMi: 0,
      carbsG: gelCarbsG,
      label: 'Pre-race gel',
      note: 'About 15 min before the start, with a few sips of water.',
    });
  }

  if (finishSec < MIN_FUELED_RACE_SEC) {
    notes.push('Under ~60 minutes no in-race carbs are needed — a carb mouth rinse is enough.');
    return plan(items);
  }

  const intervalSec = gelIntervalMin * 60;
  const firstSec = clampNumber(intervalSec, FIRST_GEL_MIN_SEC, FIRST_GEL_MAX_SEC);
  const lastAllowedSec = finishSec - NO_GEL_FINAL_SEC;
  for (let k = 0; k < MAX_RACE_GELS; k++) {
    const timeSec = Math.round(firstSec + k * intervalSec);
    if (timeSec > lastAllowedSec) break;
    const mi = distanceAt(timeSec);
    const station = nearestAidStation(input.aidStations, mi);
    items.push({
      kind: 'gel',
      timeSec,
      distanceMi: mi,
      carbsG: gelCarbsG,
      label: `Gel ${k + 1}`,
      ...(station ? { note: `Near ${station.name}` } : {}),
    });
  }
  notes.push("No gels in the final 15 minutes — they can't be absorbed in time to help.");
  return plan(items);
}

// ── Fluid safety (shared with the Fuel tab) ───────────────────────────────────

/** Absolute ceiling on planned fluid (mL/h) — exercise-associated hyponatremia safety. */
export const MAX_PLANNED_FLUID_ML_PER_HOUR = 800;
/** Planned fluid never exceeds this fraction of the sweat rate (you should not gain weight). */
export const SWEAT_REPLACEMENT_CAP = 0.8;
/** Planned drink volume when the sweat rate is unknown (low end of 400–800 mL/h). */
const DEFAULT_DRINK_ML_PER_HOUR = 400;

/**
 * Upper limit for planned fluid (mL/h): min(sweat rate × 0.8, 800 mL/h).
 * Returns null when the sweat rate is unknown or invalid. A LIMIT, not a target.
 */
export function fluidCeilingMlPerHour(sweatRateLPerHour: number | undefined): number | null {
  if (!isPositiveFinite(sweatRateLPerHour)) return null;
  return Math.floor(Math.min(sweatRateLPerHour * 1000 * SWEAT_REPLACEMENT_CAP, MAX_PLANNED_FLUID_ML_PER_HOUR));
}

// ── Legacy fueling plan builder (now on the shared cadence) ───────────────────

/** Default race distance when none is given: the marathon (42.195 km) in miles. */
const DEFAULT_DISTANCE_MI = 26.21875;
/** Sports drink: 6 % carbohydrate = 60 g per litre. */
const DRINK_CARBS_G_PER_L = 60;
/** One drink serving at an aid station (mL). */
const DRINK_SERVING_ML = 150;
/** Late-race caffeine: ~2 mg/kg (inside the ~1–3 mg/kg late-race range). */
const CAFFEINE_MG_PER_KG = 2;
const CAFFEINE_MAX_PER_GEL_MG = 100;
const CAFFEINE_MAX_DOSES = 2;
/** Caffeine peaks ~45–60 min after ingestion: aim the first dose at the last hour. */
const CAFFEINE_LEAD_SEC = 60 * 60;

export interface FuelingInput {
  athlete: AthleteProfile;
  paceSecPerMi: number;
  /** Race distance in miles. Default: the marathon. */
  distanceMi?: number;
  /** Carb target / gut tolerance in g/h (athleteProfile carb tolerance). Default 60; capped at 90. */
  carbsPerHourG?: number;
  /** Carbs per gel / chew serving / food item (g). Default 25. */
  gelCarbsG?: number;
  /** Runner's experience level — affects the GI-risk rating */
  experience?: 'beginner' | 'intermediate' | 'advanced';
  /** Has the athlete trained their gut for higher carb intake? */
  gutTrained?: boolean;
  /** Preferred fueling products (the first is used) */
  preferredProducts?: ('gel' | 'chews' | 'drink' | 'real_food')[];
  /** Opt in to a late-race caffeine plan (athleteProfile.caffeine). Default false: no caffeine. */
  caffeine?: boolean;
  /** Measured sweat rate (L/h); caps the sports-drink volume in 'drink' mode. */
  sweatRateLPerHour?: number;
  /** Course aid stations, used for item notes. */
  aidStations?: AidStation[];
}

/**
 * Generate a complete in-race fueling plan on the shared cadence
 * ({@link planRaceFueling}): target = the athlete's carb tolerance (default 60 g/h).
 *
 * 'drink' mode plans a SAFE fluid volume first — min(sweat × 0.8, 800 mL/h), or
 * 400 mL/h when the sweat rate is unknown — derives the carbs from that volume
 * and tops up the rest with gels. Caffeine appears only when `caffeine` is true.
 */
export function generateFuelingPlan(input: FuelingInput): FuelingPlan {
  const {
    athlete,
    paceSecPerMi,
    experience = 'intermediate',
    gutTrained = false,
    preferredProducts = ['gel'],
  } = input;
  const distanceMi = input.distanceMi ?? DEFAULT_DISTANCE_MI;
  const requestedRate = input.carbsPerHourG ?? DEFAULT_CARBS_PER_HOUR_G;
  const gelCarbsG = isPositiveFinite(input.gelCarbsG) ? input.gelCarbsG : DEFAULT_GEL_CARBS_G;
  const product = preferredProducts[0] ?? 'gel';

  if (!isPositiveFinite(paceSecPerMi) || !isPositiveFinite(distanceMi) || !isPositiveFinite(requestedRate)) {
    return emptyFuelingPlan('Enter a valid pace, race distance and carb target to build a fueling plan.');
  }

  const finishSec = paceSecPerMi * distanceMi;
  const estimatedDurationMin = finishSec / 60;
  const targetCarbRate = Math.min(requestedRate, RACE_MAX_CARBS_PER_HOUR_G);
  const fueled = finishSec >= MIN_FUELED_RACE_SEC;

  // Drink mode: carbs come FROM a safe fluid volume (N-01), gels top up the rest.
  const fluidMlPerHour = product === 'drink'
    ? fluidCeilingMlPerHour(input.sweatRateLPerHour) ?? DEFAULT_DRINK_ML_PER_HOUR
    : 0;
  const drinkCarbsPerHour = (fluidMlPerHour / 1000) * DRINK_CARBS_G_PER_L;
  const gelRate = Math.max(0, targetCarbRate - drinkCarbsPerHour);
  const solidProduct = product === 'drink' ? 'gel' : product;

  const items: FuelingItem[] = [];
  let gelIntervalMin = 0;
  if (fueled && gelRate > 0) {
    const timeline = planRaceFueling({
      finishSec,
      distanceMi,
      carbsPerHourG: gelRate,
      gelCarbsG,
      aidStations: input.aidStations,
      preRaceGel: false,
    });
    gelIntervalMin = timeline.gelIntervalMin;
    timeline.items.forEach((g, i) => items.push({
      mile: Math.round(g.distanceMi),
      distanceMi: g.distanceMi,
      raceTimeMin: Math.round(g.timeSec / 60),
      item: getItemName(solidProduct),
      carbsG: g.carbsG,
      notes: [i === 0 ? 'First fuel — take with a few sips of water' : 'Take with a few sips of water', g.note]
        .filter(Boolean).join('. '),
    }));
  }
  if (fueled && fluidMlPerHour > 0) {
    items.push(...buildDrinkItems(finishSec, distanceMi, fluidMlPerHour));
  }
  items.sort((a, b) => a.raceTimeMin - b.raceTimeMin);

  const caffeine = input.caffeine === true ? applyCaffeine(items, athlete, finishSec) : undefined;
  const totalCarbsPlanned = items.reduce((sum, item) => sum + item.carbsG, 0);
  const totalCarbsNeeded = Math.round(targetCarbRate * (estimatedDurationMin / 60));
  const coveragePct = totalCarbsNeeded > 0 ? Math.round((totalCarbsPlanned / totalCarbsNeeded) * 100) : 0;
  const giRisk = assessGIRisk(targetCarbRate, experience, gutTrained);

  const summary = buildFuelingSummary({
    durationMin: estimatedDurationMin,
    requestedRate,
    carbRate: targetCarbRate,
    carbsPlanned: totalCarbsPlanned,
    gelCarbsG,
    gelIntervalMin,
    fluidMlPerHour,
    drinkCarbsPerHour,
    fueled,
    caffeine,
    giRisk,
  });

  return {
    estimatedDurationMin: Math.round(estimatedDurationMin),
    targetCarbRateGHr: targetCarbRate,
    totalCarbsPlannedG: totalCarbsPlanned,
    totalCarbsNeededG: totalCarbsNeeded,
    coveragePct,
    items,
    ...(caffeine ? { caffeine } : {}),
    giRisk,
    summary,
    gelIntervalMin,
    ...(fluidMlPerHour > 0 ? { fluidMlPerHour } : {}),
    needsMultipleTransportable: targetCarbRate > MULTIPLE_TRANSPORTABLE_ABOVE_G,
  };
}

function emptyFuelingPlan(summary: string): FuelingPlan {
  return {
    estimatedDurationMin: 0,
    targetCarbRateGHr: 0,
    totalCarbsPlannedG: 0,
    totalCarbsNeededG: 0,
    coveragePct: 0,
    items: [],
    giRisk: 'low',
    summary,
    gelIntervalMin: 0,
    needsMultipleTransportable: false,
  };
}

function getItemName(product: string): string {
  switch (product) {
    case 'chews': return 'Energy Chews';
    case 'real_food': return 'Energy Bar/Banana';
    default: return 'Energy Gel';
  }
}

/**
 * Sports-drink servings at a fixed, safe hourly volume: one serving per
 * interval, none in the final 15 min, so total fluid ≤ `mlPerHour` × duration.
 */
function buildDrinkItems(finishSec: number, distanceMi: number, mlPerHour: number): FuelingItem[] {
  const intervalSec = (DRINK_SERVING_ML / mlPerHour) * 3600;
  const carbsPerServing = Math.round((DRINK_SERVING_ML / 1000) * DRINK_CARBS_G_PER_L);
  const items: FuelingItem[] = [];
  for (let t = intervalSec; t <= finishSec - NO_GEL_FINAL_SEC && items.length < 200; t += intervalSec) {
    const mi = Math.round(((t / finishSec) * distanceMi) * 100) / 100;
    items.push({
      mile: Math.round(mi),
      distanceMi: mi,
      raceTimeMin: Math.round(t / 60),
      item: `Sports drink (${DRINK_SERVING_ML} mL)`,
      carbsG: carbsPerServing,
      fluidMl: DRINK_SERVING_ML,
      notes: "Sip it — don't force fluid you're not thirsty for",
    });
  }
  return items;
}

/**
 * Opt-in late-race caffeine (N-18): ~2 mg/kg split over at most two
 * caffeinated gels (≤ 100 mg each), starting with the gel nearest one hour
 * before the finish (not before halfway). The caffeinated gels REPLACE regular
 * gels, so their carbs stay counted. Mutates the chosen `items`.
 */
function applyCaffeine(items: FuelingItem[], athlete: AthleteProfile, finishSec: number): CaffeineStrategy | undefined {
  const weightKg = athlete.weightKg;
  if (!isPositiveFinite(weightKg)) return undefined;
  const gels = items.filter((i) => i.fluidMl === undefined);
  if (gels.length === 0) return undefined;

  const targetMg = CAFFEINE_MG_PER_KG * weightKg;
  const doses = Math.min(CAFFEINE_MAX_DOSES, gels.length, Math.max(1, Math.ceil(targetMg / CAFFEINE_MAX_PER_GEL_MG)));
  const aimSec = Math.max(finishSec / 2, finishSec - CAFFEINE_LEAD_SEC);
  let start = 0;
  gels.forEach((g, i) => {
    if (Math.abs(g.raceTimeMin * 60 - aimSec) < Math.abs(gels[start].raceTimeMin * 60 - aimSec)) start = i;
  });
  start = Math.min(start, gels.length - doses);
  const chosen = gels.slice(start, start + doses);
  const perDoseMg = Math.min(CAFFEINE_MAX_PER_GEL_MG, Math.max(5, Math.round(targetMg / doses / 5) * 5));

  for (const g of chosen) {
    g.caffeineMg = perDoseMg;
    g.item = 'Caffeinated gel';
    g.notes = `${g.notes}. Contains ~${perDoseMg} mg caffeine (replaces a regular gel)`;
  }
  const totalMg = perDoseMg * chosen.length;
  return {
    totalMg,
    recommendedMgPerKg: CAFFEINE_MG_PER_KG,
    items: chosen.map((g) => ({
      mile: g.mile,
      mg: perDoseMg,
      notes: 'Caffeinated gel — replaces a regular gel; its carbs still count',
    })),
    summary: `${totalMg} mg caffeine late in the race (${(totalMg / weightKg).toFixed(1)} mg/kg, within the ~1–3 mg/kg late-race range). Only use caffeine you have tried in training.`,
  };
}

/** GI-distress risk for a carb rate; every level is reachable (N-17). */
export function assessGIRisk(
  carbRateGHr: number,
  experience: string,
  gutTrained: boolean,
): FuelingPlan['giRisk'] {
  if (carbRateGHr > 75 && !gutTrained) return 'high';
  if (carbRateGHr > 60 && experience === 'beginner') return 'high';
  if (carbRateGHr > 60 && !gutTrained) return 'moderate';
  if (carbRateGHr > 45 && experience === 'beginner' && !gutTrained) return 'moderate';
  return 'low';
}

interface SummaryInput {
  durationMin: number;
  requestedRate: number;
  carbRate: number;
  carbsPlanned: number;
  gelCarbsG: number;
  gelIntervalMin: number;
  fluidMlPerHour: number;
  drinkCarbsPerHour: number;
  fueled: boolean;
  caffeine: CaffeineStrategy | undefined;
  giRisk: FuelingPlan['giRisk'];
}

function buildFuelingSummary(s: SummaryInput): string {
  const parts: string[] = [];
  const totalMin = Math.round(s.durationMin);
  parts.push(`Estimated race time: ${Math.floor(totalMin / 60)}h${String(totalMin % 60).padStart(2, '0')}min.`);

  if (!s.fueled) {
    parts.push('Under ~60 minutes no in-race carbs are needed — a carb mouth rinse is enough.');
    return parts.join(' ');
  }

  const source = s.fluidMlPerHour > 0
    ? `${Math.round(s.drinkCarbsPerHour)} g/h from ~${s.fluidMlPerHour} mL/h of sports drink${s.gelIntervalMin > 0 ? `, the rest from a ${s.gelCarbsG} g gel every ${Math.round(s.gelIntervalMin)} min` : ''}`
    : `one ${s.gelCarbsG} g gel every ${Math.round(s.gelIntervalMin)} min`;
  parts.push(`Target: ${Math.round(s.carbRate)} g carbs/h (${source}); ${s.carbsPlanned} g planned.`);
  if (s.requestedRate > RACE_MAX_CARBS_PER_HOUR_G) parts.push('Capped at 90 g/h.');
  if (s.carbRate < RACE_LOW_CARBS_PER_HOUR_G) parts.push('That is below the usual 30–60 g/h guidance — fine if it is what your gut tolerates.');
  if (s.carbRate > MULTIPLE_TRANSPORTABLE_ABOVE_G) {
    parts.push('Above ~60 g/h use glucose+fructose (multiple transportable carbohydrate) products and a trained gut.');
  }
  if (s.caffeine) parts.push(s.caffeine.summary);

  if (s.giRisk === 'high') {
    parts.push('High GI risk at this intake rate. Practice this fueling strategy in training before race day.');
  } else if (s.giRisk === 'moderate') {
    parts.push('Moderate GI risk — practice this intake rate on long runs first.');
  }
  parts.push('Optional: one gel about 15 minutes before the start.');
  return parts.join(' ');
}

/**
 * Gel distances (mi, 1 dp) and the interval for a pace — the same cadence as
 * {@link planRaceFueling}. Distance defaults to the marathon.
 */
export function getGelSchedule(
  paceSecPerMi: number,
  distanceMi: number = DEFAULT_DISTANCE_MI,
  carbsPerHourG: number = DEFAULT_CARBS_PER_HOUR_G,
  gelCarbsG: number = DEFAULT_GEL_CARBS_G,
): { miles: number[]; intervalMin: number } {
  if (!isPositiveFinite(paceSecPerMi) || !isPositiveFinite(distanceMi)) return { miles: [], intervalMin: 0 };
  const plan = planRaceFueling({
    finishSec: paceSecPerMi * distanceMi,
    distanceMi,
    carbsPerHourG,
    gelCarbsG,
    preRaceGel: false,
  });
  return {
    miles: plan.items.map((i) => Math.round(i.distanceMi * 10) / 10),
    intervalMin: Math.round(plan.gelIntervalMin * 10) / 10,
  };
}
