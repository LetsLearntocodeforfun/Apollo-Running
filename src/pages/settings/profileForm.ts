/**
 * Settings › Athlete Profile form logic (pure, no React): turn the text the
 * athlete typed into an athleteProfile patch plus heart-rate values, with one
 * inline error per invalid field.
 *
 * The ranges mirror athleteProfile.ts's sanitizer (its LIMITS aren't
 * exported); every value is also run through sanitizeAthleteProfile() so a
 * value the store would silently drop is reported instead of "saved".
 */

import {
  kgToLb,
  lbToKg,
  sanitizeAthleteProfile,
  type AthleteProfile,
  type AthleteSex,
  type MassUnit,
  type RecentRace,
} from '../../services/athleteProfile';
import { metersToUnit, unitToMeters, type DistanceUnit } from '../../services/unitPreferences';
import { isDateKey, todayKey } from '../../utils/localDate';

export const RACE_PRESETS = [
  { id: '5k', label: '5K', meters: 5000 },
  { id: '10k', label: '10K', meters: 10000 },
  { id: 'half', label: 'Half marathon', meters: 21097.5 },
  { id: 'marathon', label: 'Marathon', meters: 42195 },
] as const;

export type RacePresetId = typeof RACE_PRESETS[number]['id'];
/** '' = no recent race. */
export type RaceDistanceChoice = '' | RacePresetId | 'custom';

/** Same bounds as Settings has always used for the HR profile. */
export const HR_LIMITS = { max: [100, 230], resting: [30, 120] } as const;

/** Mirrors `LIMITS` in athleteProfile.ts. */
export const PROFILE_LIMITS = {
  weightKg: [25, 250],
  birthYear: [1920, new Date().getFullYear() - 10],
  raceDistanceM: [1000, 100_000],
  raceTimeSec: [120, 24 * 3600],
  goalMarathonSec: [2 * 3600 - 300, 8 * 3600],
  carbTolerance: [0, 120],
} as const;

/** Raw form values (strings as typed). */
export interface ProfileDraft {
  maxHR: string;
  restingHR: string;
  /** In the athlete's mass unit. */
  weight: string;
  birthYear: string;
  sex: '' | AthleteSex;
  raceDistance: RaceDistanceChoice;
  /** Custom race distance in the athlete's distance unit. */
  raceCustom: string;
  raceTime: string;
  raceDate: string;
  raceName: string;
  goalTime: string;
  carbTolerance: string;
  caffeine: boolean;
}

export type ProfileField = keyof ProfileDraft;
export type ProfileErrors = Partial<Record<ProfileField, string>>;

export interface ProfileValidation {
  errors: ProfileErrors;
  /** athleteProfile patch (undefined clears a field); null when there are errors. */
  patch: Partial<AthleteProfile> | null;
  /** Valid heart-rate values; null when there are errors. */
  hr: { maxHR: number; restingHR: number } | null;
}

/** "h:mm:ss" or "mm:ss" → seconds; null when malformed. */
export function parseDuration(text: string): number | null {
  const parts = text.trim().split(':');
  if (parts.length < 2 || parts.length > 3 || parts.some((p) => !/^\d+$/.test(p))) return null;
  const nums = parts.map(Number);
  if (nums.length === 3) {
    const [h, m, s] = nums;
    if (m > 59 || s > 59) return null;
    return h * 3600 + m * 60 + s;
  }
  const [m, s] = nums;
  if (s > 59) return null;
  return m * 60 + s;
}

/** Seconds → "h:mm:ss" (or "m:ss" under an hour). */
export function formatDuration(totalSec: number): string {
  const sec = Math.max(0, Math.round(totalSec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

function trimNumber(n: number, decimals: number): string {
  return String(Number(n.toFixed(decimals)));
}

/** Weight text in `unit` for a stored kg value. */
export function formatWeightInput(kg: number, unit: MassUnit): string {
  return trimNumber(unit === 'lb' ? kgToLb(kg) : kg, 1);
}

/** Smallest and largest weight the store accepts, in `unit` (rounded inwards). */
export function weightRange(unit: MassUnit): [number, number] {
  const [lo, hi] = PROFILE_LIMITS.weightKg;
  return unit === 'lb' ? [Math.ceil(kgToLb(lo)), Math.floor(kgToLb(hi))] : [lo, hi];
}

/** Smallest and largest custom race distance the store accepts, in `unit`. */
export function raceDistanceRange(unit: DistanceUnit): [number, number] {
  const [lo, hi] = PROFILE_LIMITS.raceDistanceM;
  return [Math.ceil(metersToUnit(lo, unit) * 10) / 10, Math.floor(metersToUnit(hi, unit) * 10) / 10];
}

/** Form values for the stored profile. */
export function draftFromProfile(
  profile: AthleteProfile,
  hr: { maxHR: number; restingHR: number },
  massUnit: MassUnit,
  distanceUnit: DistanceUnit,
): ProfileDraft {
  const race = profile.recentRace;
  const preset = race ? RACE_PRESETS.find((p) => Math.abs(p.meters - race.distanceM) < 1) : undefined;
  return {
    maxHR: Number.isFinite(hr.maxHR) ? String(hr.maxHR) : '',
    restingHR: Number.isFinite(hr.restingHR) ? String(hr.restingHR) : '',
    weight: profile.weightKg != null ? formatWeightInput(profile.weightKg, massUnit) : '',
    birthYear: profile.birthYear != null ? String(profile.birthYear) : '',
    sex: profile.sex ?? '',
    raceDistance: race ? (preset ? preset.id : 'custom') : '',
    raceCustom: race && !preset ? trimNumber(metersToUnit(race.distanceM, distanceUnit), 2) : '',
    raceTime: race ? formatDuration(race.timeSec) : '',
    raceDate: race?.date ?? '',
    raceName: race?.name ?? '',
    goalTime: profile.goalMarathonSec != null ? formatDuration(profile.goalMarathonSec) : '',
    carbTolerance: profile.carbToleranceGPerHour != null ? String(profile.carbToleranceGPerHour) : '',
    caffeine: profile.caffeine ?? false,
  };
}

/** Re-express unit-dependent draft values after the athlete switches units. */
export function convertDraftUnits(
  draft: ProfileDraft,
  from: { mass: MassUnit; distance: DistanceUnit },
  to: { mass: MassUnit; distance: DistanceUnit },
): ProfileDraft {
  const next = { ...draft };
  const weight = Number(draft.weight);
  if (from.mass !== to.mass && draft.weight.trim() && Number.isFinite(weight)) {
    next.weight = formatWeightInput(from.mass === 'lb' ? lbToKg(weight) : weight, to.mass);
  }
  const custom = Number(draft.raceCustom);
  if (from.distance !== to.distance && draft.raceCustom.trim() && Number.isFinite(custom)) {
    next.raceCustom = trimNumber(metersToUnit(unitToMeters(custom, from.distance), to.distance), 2);
  }
  return next;
}

function parseNumber(text: string): number | null {
  const t = text.trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : NaN;
}

function inRange(n: number, [lo, hi]: readonly [number, number]): boolean {
  return Number.isFinite(n) && n >= lo && n <= hi;
}

/**
 * Validate the draft. Returns a patch for updateAthleteProfile() (fields left
 * empty are cleared with `undefined`) and HR values, or per-field errors.
 */
export function validateProfileDraft(
  draft: ProfileDraft,
  massUnit: MassUnit,
  distanceUnit: DistanceUnit,
  today: string = todayKey(),
): ProfileValidation {
  const errors: ProfileErrors = {};

  // Heart rate (required: the HR profile always has values).
  const maxHR = parseNumber(draft.maxHR);
  if (maxHR === null || !Number.isInteger(maxHR) || !inRange(maxHR, HR_LIMITS.max)) {
    errors.maxHR = `Enter a max heart rate between ${HR_LIMITS.max[0]} and ${HR_LIMITS.max[1]} bpm.`;
  }
  const restingHR = parseNumber(draft.restingHR);
  if (restingHR === null || !Number.isInteger(restingHR) || !inRange(restingHR, HR_LIMITS.resting)) {
    errors.restingHR = `Enter a resting heart rate between ${HR_LIMITS.resting[0]} and ${HR_LIMITS.resting[1]} bpm.`;
  } else if (maxHR !== null && !errors.maxHR && restingHR >= maxHR) {
    errors.restingHR = 'Resting heart rate must be lower than max heart rate.';
  }

  // Weight, entered in the athlete's mass unit and stored in kg.
  const weight = parseNumber(draft.weight);
  let weightKg: number | undefined;
  if (weight !== null) {
    weightKg = massUnit === 'lb' ? lbToKg(weight) : weight;
    if (!inRange(weightKg, PROFILE_LIMITS.weightKg)) {
      const [lo, hi] = weightRange(massUnit);
      errors.weight = `Enter a weight between ${lo} and ${hi} ${massUnit}.`;
    }
  }

  const birthYear = parseNumber(draft.birthYear);
  if (birthYear !== null && (!Number.isInteger(birthYear) || !inRange(birthYear, PROFILE_LIMITS.birthYear))) {
    errors.birthYear = `Enter a year between ${PROFILE_LIMITS.birthYear[0]} and ${PROFILE_LIMITS.birthYear[1]}.`;
  }

  // Recent race: all-or-nothing.
  let recentRace: RecentRace | undefined;
  const raceTouched = !!(draft.raceTime.trim() || draft.raceDate.trim() || draft.raceName.trim() || draft.raceCustom.trim());
  if (draft.raceDistance === '') {
    if (raceTouched) errors.raceDistance = 'Choose the race distance, or clear the race fields.';
  } else {
    let distanceM: number | null = null;
    if (draft.raceDistance === 'custom') {
      const custom = parseNumber(draft.raceCustom);
      const meters = custom === null ? NaN : unitToMeters(custom, distanceUnit);
      if (!inRange(meters, PROFILE_LIMITS.raceDistanceM)) {
        const [lo, hi] = raceDistanceRange(distanceUnit);
        errors.raceCustom = `Enter a distance between ${lo} and ${hi} ${distanceUnit}.`;
      } else {
        distanceM = Math.round(meters * 10) / 10;
      }
    } else {
      distanceM = RACE_PRESETS.find((p) => p.id === draft.raceDistance)?.meters ?? null;
    }
    const timeSec = draft.raceTime.trim() ? parseDuration(draft.raceTime) : null;
    if (!draft.raceTime.trim()) errors.raceTime = 'Enter your finish time as h:mm:ss or mm:ss.';
    else if (timeSec === null) errors.raceTime = 'Use h:mm:ss or mm:ss, e.g. 1:45:30 or 24:10.';
    else if (!inRange(timeSec, PROFILE_LIMITS.raceTimeSec)) {
      errors.raceTime = `Enter a finish time between ${formatDuration(PROFILE_LIMITS.raceTimeSec[0])} and ${formatDuration(PROFILE_LIMITS.raceTimeSec[1])}.`;
    }
    const date = draft.raceDate.trim();
    if (!date) errors.raceDate = 'Enter the race date.';
    else if (!isDateKey(date)) errors.raceDate = 'Enter a valid date.';
    else if (date > today) errors.raceDate = 'The race date can\u2019t be in the future.';
    if (distanceM !== null && timeSec !== null && !errors.raceTime && !errors.raceDate) {
      const name = draft.raceName.trim();
      recentRace = { distanceM, timeSec, date, ...(name ? { name } : {}) };
    }
  }

  let goalMarathonSec: number | undefined;
  if (draft.goalTime.trim()) {
    const goal = parseDuration(draft.goalTime);
    if (goal === null) errors.goalTime = 'Use h:mm:ss, e.g. 3:45:00.';
    else if (!inRange(goal, PROFILE_LIMITS.goalMarathonSec)) {
      errors.goalTime = `Enter a goal between ${formatDuration(PROFILE_LIMITS.goalMarathonSec[0])} and ${formatDuration(PROFILE_LIMITS.goalMarathonSec[1])}.`;
    } else goalMarathonSec = goal;
  }

  const carb = parseNumber(draft.carbTolerance);
  if (carb !== null && (!Number.isInteger(carb) || !inRange(carb, PROFILE_LIMITS.carbTolerance))) {
    errors.carbTolerance = `Enter a whole number between ${PROFILE_LIMITS.carbTolerance[0]} and ${PROFILE_LIMITS.carbTolerance[1]} g per hour.`;
  }

  const patch: Partial<AthleteProfile> = {
    weightKg: errors.weight ? undefined : weightKg,
    birthYear: birthYear ?? undefined,
    sex: draft.sex || undefined,
    recentRace,
    goalMarathonSec,
    carbToleranceGPerHour: carb ?? undefined,
    caffeine: draft.caffeine,
  };

  // Belt and braces: anything the store's sanitizer would drop is an error, not a silent no-op.
  const clean = sanitizeAthleteProfile(patch);
  if (patch.weightKg !== undefined && clean.weightKg === undefined) errors.weight ??= 'Enter a valid weight.';
  if (patch.birthYear !== undefined && clean.birthYear === undefined) errors.birthYear ??= 'Enter a valid year.';
  if (patch.recentRace && !clean.recentRace) errors.raceTime ??= 'Check the race distance, time and date.';
  if (patch.goalMarathonSec !== undefined && clean.goalMarathonSec === undefined) errors.goalTime ??= 'Enter a valid goal time.';
  if (patch.carbToleranceGPerHour !== undefined && clean.carbToleranceGPerHour === undefined) {
    errors.carbTolerance ??= 'Enter a valid number.';
  }

  if (Object.keys(errors).length > 0) return { errors, patch: null, hr: null };
  return { errors, patch, hr: { maxHR: maxHR as number, restingHR: restingHR as number } };
}

/** Field order for focusing the first invalid input. */
export const PROFILE_FIELD_ORDER: readonly ProfileField[] = [
  'maxHR', 'restingHR', 'weight', 'birthYear', 'sex',
  'raceDistance', 'raceCustom', 'raceTime', 'raceDate', 'raceName',
  'goalTime', 'carbTolerance', 'caffeine',
];
