/**
 * Athlete Profile (v1.0.6) — the single place for personal inputs that many
 * features need: body mass (fueling, carb loading), a recent race result
 * (VDOT / training paces / prediction), goal time, carb tolerance, and
 * display units for temperature and mass.
 *
 * Stored locally under `apollo_athlete_profile` (included in backups/exports
 * via the `apollo_` prefix). Everything is optional; consumers must handle a
 * missing field gracefully and ask for it inline when they need it.
 */

import { persistence } from './db/persistence';
import { getDistanceUnit } from './unitPreferences';
import { isDateKey } from '../utils/localDate';

export const ATHLETE_PROFILE_KEY = 'apollo_athlete_profile';
export const ATHLETE_PROFILE_CHANGED_EVENT = 'apollo:athlete-profile-changed';

export type TemperatureUnit = 'F' | 'C';
export type MassUnit = 'kg' | 'lb';
export type AthleteSex = 'female' | 'male' | 'unspecified';

/** A real race result (all-out effort). Used as the primary VDOT source. */
export interface RecentRace {
  distanceM: number;
  timeSec: number;
  /** YYYY-MM-DD (local) */
  date: string;
  name?: string;
}

export interface AthleteProfile {
  name?: string;
  weightKg?: number;
  sex?: AthleteSex;
  birthYear?: number;
  /** Best recent race result — drives VDOT, paces and predictions. */
  recentRace?: RecentRace;
  /** Goal finish time for the target marathon, in seconds. */
  goalMarathonSec?: number;
  /** Gut-trained carbohydrate tolerance in grams per hour (default 60). */
  carbToleranceGPerHour?: number;
  /** Uses caffeine during races. */
  caffeine?: boolean;
  /** Measured sweat rate in litres per hour. */
  sweatRateLPerHour?: number;
  temperatureUnit?: TemperatureUnit;
  massUnit?: MassUnit;
  updatedAt?: string;
}

export const DEFAULT_CARB_TOLERANCE_G_PER_HOUR = 60;

const LIMITS = {
  weightKg: [25, 250],
  birthYear: [1920, new Date().getFullYear() - 10],
  raceDistanceM: [1000, 100_000],
  raceTimeSec: [120, 24 * 3600],
  goalMarathonSec: [2 * 3600 - 300, 8 * 3600],
  carbTolerance: [0, 120],
  sweatRate: [0.2, 3.5],
} as const;

function inRange(v: unknown, [lo, hi]: readonly [number, number]): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
}

/** Drop invalid fields instead of throwing — profile data must never break the app. */
export function sanitizeAthleteProfile(input: unknown): AthleteProfile {
  if (!input || typeof input !== 'object') return {};
  const p = input as Record<string, unknown>;
  const out: AthleteProfile = {};
  if (typeof p.name === 'string' && p.name.trim()) out.name = p.name.trim().slice(0, 80);
  if (inRange(p.weightKg, LIMITS.weightKg)) out.weightKg = Math.round(p.weightKg * 10) / 10;
  if (p.sex === 'female' || p.sex === 'male' || p.sex === 'unspecified') out.sex = p.sex;
  if (inRange(p.birthYear, LIMITS.birthYear)) out.birthYear = Math.round(p.birthYear);
  const rr = p.recentRace as Record<string, unknown> | undefined;
  if (
    rr && typeof rr === 'object' &&
    inRange(rr.distanceM, LIMITS.raceDistanceM) &&
    inRange(rr.timeSec, LIMITS.raceTimeSec) &&
    isDateKey(rr.date)
  ) {
    out.recentRace = {
      distanceM: rr.distanceM,
      timeSec: Math.round(rr.timeSec),
      date: rr.date,
      ...(typeof rr.name === 'string' && rr.name.trim() ? { name: rr.name.trim().slice(0, 80) } : {}),
    };
  }
  if (inRange(p.goalMarathonSec, LIMITS.goalMarathonSec)) out.goalMarathonSec = Math.round(p.goalMarathonSec);
  if (inRange(p.carbToleranceGPerHour, LIMITS.carbTolerance)) out.carbToleranceGPerHour = Math.round(p.carbToleranceGPerHour);
  if (typeof p.caffeine === 'boolean') out.caffeine = p.caffeine;
  if (inRange(p.sweatRateLPerHour, LIMITS.sweatRate)) out.sweatRateLPerHour = Math.round(p.sweatRateLPerHour * 100) / 100;
  if (p.temperatureUnit === 'F' || p.temperatureUnit === 'C') out.temperatureUnit = p.temperatureUnit;
  if (p.massUnit === 'kg' || p.massUnit === 'lb') out.massUnit = p.massUnit;
  if (typeof p.updatedAt === 'string') out.updatedAt = p.updatedAt;
  return out;
}

export function getAthleteProfile(): AthleteProfile {
  try {
    const raw = persistence.getItem(ATHLETE_PROFILE_KEY);
    return raw ? sanitizeAthleteProfile(JSON.parse(raw)) : {};
  } catch {
    return {};
  }
}

/**
 * Merge `patch` into the stored profile. Pass `undefined` for a field to clear it.
 * Invalid values are dropped. Returns the saved profile.
 */
export function updateAthleteProfile(patch: Partial<AthleteProfile>): AthleteProfile {
  const merged: Record<string, unknown> = { ...getAthleteProfile() };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete merged[k];
    else merged[k] = v;
  }
  merged.updatedAt = new Date().toISOString();
  const clean = sanitizeAthleteProfile(merged);
  persistence.setItem(ATHLETE_PROFILE_KEY, JSON.stringify(clean));
  try {
    window.dispatchEvent(new CustomEvent(ATHLETE_PROFILE_CHANGED_EVENT, { detail: clean }));
  } catch { /* non-browser context */ }
  return clean;
}

export function clearAthleteProfile(): void {
  persistence.removeItem(ATHLETE_PROFILE_KEY);
  try {
    window.dispatchEvent(new CustomEvent(ATHLETE_PROFILE_CHANGED_EVENT, { detail: {} }));
  } catch { /* non-browser context */ }
}

/** Subscribe to profile changes. Returns an unsubscribe function. */
export function onAthleteProfileChanged(cb: (p: AthleteProfile) => void): () => void {
  const handler = (e: Event) => cb(((e as CustomEvent).detail as AthleteProfile) ?? getAthleteProfile());
  window.addEventListener(ATHLETE_PROFILE_CHANGED_EVENT, handler);
  return () => window.removeEventListener(ATHLETE_PROFILE_CHANGED_EVENT, handler);
}

export function getCarbToleranceGPerHour(): number {
  return getAthleteProfile().carbToleranceGPerHour ?? DEFAULT_CARB_TOLERANCE_G_PER_HOUR;
}

/** Temperature unit: explicit preference, otherwise °C for km users and °F for mile users. */
export function getTemperatureUnit(): TemperatureUnit {
  return getAthleteProfile().temperatureUnit ?? (getDistanceUnit() === 'km' ? 'C' : 'F');
}

/** Mass unit: explicit preference, otherwise kg for km users and lb for mile users. */
export function getMassUnit(): MassUnit {
  return getAthleteProfile().massUnit ?? (getDistanceUnit() === 'km' ? 'kg' : 'lb');
}

export const kgToLb = (kg: number): number => kg * 2.2046226218;
export const lbToKg = (lb: number): number => lb / 2.2046226218;
export const fToC = (f: number): number => ((f - 32) * 5) / 9;
export const cToF = (c: number): number => (c * 9) / 5 + 32;

/** Format a Fahrenheit temperature in the athlete's unit, e.g. "18°C". */
export function formatTemperatureF(tempF: number, unit: TemperatureUnit = getTemperatureUnit()): string {
  if (!Number.isFinite(tempF)) return '—';
  return unit === 'C' ? `${Math.round(fToC(tempF))}°C` : `${Math.round(tempF)}°F`;
}

/** Format a mass in kilograms in the athlete's unit, e.g. "154 lb". */
export function formatMassKg(kg: number, unit: MassUnit = getMassUnit()): string {
  if (!Number.isFinite(kg)) return '—';
  return unit === 'lb' ? `${Math.round(kgToLb(kg))} lb` : `${Math.round(kg * 10) / 10} kg`;
}
