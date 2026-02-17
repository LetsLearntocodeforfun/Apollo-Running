/**
 * unitPreferences.ts — Distance unit preference system for Apollo Running.
 *
 * Manages km vs miles preference throughout the app.
 * Set during onboarding (after plan selection) and toggleable in Settings.
 * All distance/pace formatting flows through this service so a single
 * toggle changes the entire app.
 */

import { persistence } from './db/persistence';

const UNIT_KEY = 'apollo_distance_unit';

export type DistanceUnit = 'mi' | 'km';

const METERS_PER_MILE = 1609.344;
const METERS_PER_KM = 1000;

/** Get the user's distance unit preference. Defaults to miles. */
export function getDistanceUnit(): DistanceUnit {
  const raw = persistence.getItem(UNIT_KEY);
  return raw === 'km' ? 'km' : 'mi';
}

/** Set the user's distance unit preference. */
export function setDistanceUnit(unit: DistanceUnit): void {
  persistence.setItem(UNIT_KEY, unit);
}

// ─── Conversion Helpers ──────────────────────────────────────

/** Convert meters to the user's preferred unit. */
export function metersToUnit(meters: number, unit?: DistanceUnit): number {
  const u = unit ?? getDistanceUnit();
  return u === 'km' ? meters / METERS_PER_KM : meters / METERS_PER_MILE;
}

/** Convert from user's unit back to meters. */
export function unitToMeters(value: number, unit?: DistanceUnit): number {
  const u = unit ?? getDistanceUnit();
  return u === 'km' ? value * METERS_PER_KM : value * METERS_PER_MILE;
}

/** Unit label: "mi" or "km". */
export function unitLabel(unit?: DistanceUnit): string {
  return (unit ?? getDistanceUnit()) === 'km' ? 'km' : 'mi';
}

/** Pace unit label: "/mi" or "/km". */
export function paceUnitLabel(unit?: DistanceUnit): string {
  return (unit ?? getDistanceUnit()) === 'km' ? '/km' : '/mi';
}

/** The interval in meters for one split in the user's unit. */
export function splitIntervalMeters(unit?: DistanceUnit): number {
  return (unit ?? getDistanceUnit()) === 'km' ? METERS_PER_KM : METERS_PER_MILE;
}

// ─── Formatting Helpers ──────────────────────────────────────

/**
 * Format a distance in meters to the user's preferred unit.
 * Example: 10000m → "6.21 mi" or "10.00 km"
 */
export function formatDistance(meters: number, unit?: DistanceUnit): string {
  const u = unit ?? getDistanceUnit();
  const value = metersToUnit(meters, u);
  return `${value.toFixed(2)} ${unitLabel(u)}`;
}

/**
 * Format a distance as a short label (1 decimal).
 * Example: 10000m → "6.2 mi" or "10.0 km"
 */
export function formatDistanceShort(meters: number, unit?: DistanceUnit): string {
  const u = unit ?? getDistanceUnit();
  const value = metersToUnit(meters, u);
  return `${value.toFixed(1)} ${unitLabel(u)}`;
}

/**
 * Format pace from distance (meters) and time (seconds).
 * Example: 1609m in 480s → "8:00/mi" or "4:58/km"
 */
export function formatPace(distanceMeters: number, timeSec: number, unit?: DistanceUnit): string {
  if (!distanceMeters || !timeSec) return '—';
  const u = unit ?? getDistanceUnit();
  const dist = metersToUnit(distanceMeters, u);
  if (dist <= 0) return '—';
  const minPerUnit = (timeSec / 60) / dist;
  return formatPaceValue(minPerUnit, u);
}

/** Format a raw pace value (min/unit) as "M:SS/unit". */
export function formatPaceValue(paceMinPerUnit: number, unit?: DistanceUnit): string {
  if (!paceMinPerUnit || paceMinPerUnit > 30) return '—';
  const totalSec = Math.round(paceMinPerUnit * 60);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${sec.toString().padStart(2, '0')}${paceUnitLabel(unit)}`;
}

/**
 * Calculate pace in min/unit from raw distance/time.
 * Returns 0 if inputs are invalid.
 */
export function calcPace(distanceMeters: number, timeSec: number, unit?: DistanceUnit): number {
  if (!distanceMeters || !timeSec) return 0;
  const dist = metersToUnit(distanceMeters, unit);
  return dist > 0 ? (timeSec / 60) / dist : 0;
}

/**
 * Format elevation in the user's preferred system.
 * Miles → feet, Kilometers → meters.
 */
export function formatElevation(meters: number, unit?: DistanceUnit): string {
  const u = unit ?? getDistanceUnit();
  if (u === 'km') return `${Math.round(meters)} m`;
  return `${Math.round(meters * 3.28084)} ft`;
}

/**
 * Format duration as human-readable.
 */
export function formatDuration(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.round(sec % 60);
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}:${s.toString().padStart(2, '0')}`;
  return `${s}s`;
}

// ─── Raw Conversion Helpers ──────────────────────────────────
// Used by services that need raw numeric conversions (not display formatting).

const METERS_TO_MILES = 0.000621371;

/** Convert meters to miles (raw numeric). */
export function metersToMiles(m: number): number {
  return m * METERS_TO_MILES;
}

/** Convert meters to kilometers (raw numeric). */
export function metersToKm(m: number): number {
  return m / 1000;
}

// ─── Mile-based Data Converters ──────────────────────────────
// Plan data, sync data, and recap data are stored in miles.
// These helpers convert to the user's preferred unit for display.

/** Convert a value already in miles to the user's preferred unit. */
export function milesToUnit(miles: number, unit?: DistanceUnit): number {
  const u = unit ?? getDistanceUnit();
  return u === 'km' ? miles * 1.60934 : miles;
}

/**
 * Format a distance already in miles to the user's preferred unit.
 * Example: 6.2 → "6.2 mi" or "10.0 km"
 */
export function formatMiles(miles: number, decimals: number = 1, unit?: DistanceUnit): string {
  const u = unit ?? getDistanceUnit();
  const value = milesToUnit(miles, u);
  return `${value.toFixed(decimals)} ${unitLabel(u)}`;
}

/**
 * Format a pace stored as min/mi to the user's preferred unit.
 * Sync data stores pace as min/mi — this converts to min/km if needed.
 */
export function formatPaceFromMinPerMi(paceMinPerMi: number, unit?: DistanceUnit): string {
  if (!paceMinPerMi) return '—';
  const u = unit ?? getDistanceUnit();
  const paceInUnit = u === 'km' ? paceMinPerMi / 1.60934 : paceMinPerMi;
  return formatPaceValue(paceInUnit, u);
}
