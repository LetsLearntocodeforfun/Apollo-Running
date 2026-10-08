/**
 * My Race (v1.0.6) — the athlete's single target race for the Race Day hub.
 *
 * Stores which race they're running (a World Marathon Major id or a custom
 * race id), the race date, the local start time + IANA time zone, start
 * wave, the active (saved) race strategy and the race-morning setup.
 *
 * The goal time is NOT stored here: the single goal store is
 * `athleteProfile.goalMarathonSec` (a strategy keeps its own target time).
 * The race date is read through `journey.getRaceDate()` (active plan first);
 * `date` here is only written when there is no active plan.
 *
 * Stored under `apollo_my_race` (covered by backup/export/clear via the
 * `apollo_` prefix). Reads never throw; invalid fields are dropped; legacy
 * race ids ('boston-marathon-2026') are normalised on read. Saving is an
 * explicit call — nothing here persists as a side effect.
 */

import { persistence } from './db/persistence';
import { isDateKey } from '../utils/localDate';
import { normalizeMarathonId } from '../data/worldMajors';

export const MY_RACE_KEY = 'apollo_my_race';
export const MY_RACE_CHANGED_EVENT = 'apollo:my-race-changed';

export type MealSize = 'light' | 'moderate' | 'full';

export interface MyRace {
  /** Race id: a stable World Major id ('boston', 'london', …) or a custom race id. */
  raceId?: string;
  /** Race date, local YYYY-MM-DD in the race's time zone. */
  date?: string;
  /** Local start time at the race (your wave), 24 h 'HH:mm'. */
  startTime?: string;
  /** IANA time zone of the race, e.g. 'America/New_York'. */
  timeZone?: string;
  /** Start wave / corral label, e.g. 'Wave 2, Corral 4'. */
  wave?: string;
  /** Id of the saved race strategy to use on race day. */
  activeStrategyId?: string;
  /** Race morning: minutes from where you sleep to the start area. */
  travelMinutes?: number;
  /** Race morning: minutes before the gun you want to be in the start area. */
  arrivalLeadMin?: number;
  /** Race morning: breakfast size. */
  mealSize?: MealSize;
  /** Race morning: include a short warm-up. */
  warmup?: boolean;
  updatedAt?: string;
}

const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** True for a 24 h 'HH:mm' string such as '07:30' or '17:05'. */
export function isHHmm(s: unknown): s is string {
  return typeof s === 'string' && HHMM_RE.test(s);
}

/** True if `tz` is an IANA zone the runtime's Intl knows about. */
export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz.trim() || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function cleanString(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t ? t.slice(0, max) : undefined;
}

function intInRange(v: unknown, lo: number, hi: number): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? Math.round(v) : undefined;
}

/** Drop invalid (and retired, e.g. `goalTimeSec`) fields instead of throwing. */
export function sanitizeMyRace(input: unknown): MyRace {
  if (!input || typeof input !== 'object') return {};
  const p = input as Record<string, unknown>;
  const out: MyRace = {};
  const raceId = cleanString(p.raceId, 200);
  if (raceId) out.raceId = normalizeMarathonId(raceId);
  if (isDateKey(p.date)) out.date = p.date;
  if (isHHmm(p.startTime)) out.startTime = p.startTime;
  if (isValidTimeZone(p.timeZone)) out.timeZone = p.timeZone;
  const wave = cleanString(p.wave, 60);
  if (wave) out.wave = wave;
  const strategyId = cleanString(p.activeStrategyId, 200);
  if (strategyId) out.activeStrategyId = strategyId;
  const travel = intInRange(p.travelMinutes, 0, 600);
  if (travel !== undefined) out.travelMinutes = travel;
  const lead = intInRange(p.arrivalLeadMin, 15, 300);
  if (lead !== undefined) out.arrivalLeadMin = lead;
  if (p.mealSize === 'light' || p.mealSize === 'moderate' || p.mealSize === 'full') out.mealSize = p.mealSize;
  if (typeof p.warmup === 'boolean') out.warmup = p.warmup;
  if (typeof p.updatedAt === 'string') out.updatedAt = p.updatedAt;
  return out;
}

/** The saved race, or `{}` when none is set. Never throws. */
export function getMyRace(): MyRace {
  try {
    const raw = persistence.getItem(MY_RACE_KEY);
    return raw ? sanitizeMyRace(JSON.parse(raw)) : {};
  } catch {
    return {};
  }
}

/**
 * Merge `patch` into the saved race (pass `undefined` for a field to clear
 * it). Invalid values are dropped. Idempotent; returns the saved record.
 */
export function setMyRace(patch: Partial<MyRace>): MyRace {
  const merged: Record<string, unknown> = { ...getMyRace() };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete merged[k];
    else merged[k] = v;
  }
  merged.updatedAt = new Date().toISOString();
  const clean = sanitizeMyRace(merged);
  persistence.setItem(MY_RACE_KEY, JSON.stringify(clean));
  try {
    window.dispatchEvent(new CustomEvent(MY_RACE_CHANGED_EVENT, { detail: clean }));
  } catch { /* non-browser context */ }
  return clean;
}

/** Forget the saved race. */
export function clearMyRace(): void {
  persistence.removeItem(MY_RACE_KEY);
  try {
    window.dispatchEvent(new CustomEvent(MY_RACE_CHANGED_EVENT, { detail: {} }));
  } catch { /* non-browser context */ }
}

/** Subscribe to My Race changes. Returns an unsubscribe function. */
export function onMyRaceChanged(cb: (race: MyRace) => void): () => void {
  const handler = (e: Event) => cb(((e as CustomEvent).detail as MyRace) ?? getMyRace());
  window.addEventListener(MY_RACE_CHANGED_EVENT, handler);
  return () => window.removeEventListener(MY_RACE_CHANGED_EVENT, handler);
}

/**
 * One-time, idempotent write-back of a normalised raceId (legacy
 * '*-marathon-2026' → stable id). Reads already normalise; call this from an
 * explicit migration step. Returns true when something was rewritten.
 */
export function migrateMyRaceId(): boolean {
  try {
    const raw = persistence.getItem(MY_RACE_KEY);
    if (!raw) return false;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const clean = sanitizeMyRace(parsed);
    if (typeof parsed.raceId === 'string' && parsed.raceId !== clean.raceId) {
      persistence.setItem(MY_RACE_KEY, JSON.stringify(clean));
      return true;
    }
  } catch { /* ignore corrupt data */ }
  return false;
}
