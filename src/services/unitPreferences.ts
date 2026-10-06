// Distance unit preference system — km vs miles.
// All distance/pace formatting flows through this service.

import { persistence } from './db/persistence';

const UNIT_KEY = 'apollo_distance_unit';

export type DistanceUnit = 'mi' | 'km';

const METERS_PER_MILE = 1609.344;
const METERS_PER_KM = 1000;

export function getDistanceUnit(): DistanceUnit {
  const raw = persistence.getItem(UNIT_KEY);
  return raw === 'km' ? 'km' : 'mi';
}

export function setDistanceUnit(unit: DistanceUnit): void {
  persistence.setItem(UNIT_KEY, unit);
}

// ─── Conversion Helpers ──────────────────────────────────────

export function metersToUnit(meters: number, unit?: DistanceUnit): number {
  const u = unit ?? getDistanceUnit();
  return u === 'km' ? meters / METERS_PER_KM : meters / METERS_PER_MILE;
}

export function unitToMeters(value: number, unit?: DistanceUnit): number {
  const u = unit ?? getDistanceUnit();
  return u === 'km' ? value * METERS_PER_KM : value * METERS_PER_MILE;
}

export function unitLabel(unit?: DistanceUnit): string {
  return (unit ?? getDistanceUnit()) === 'km' ? 'km' : 'mi';
}

export function paceUnitLabel(unit?: DistanceUnit): string {
  return (unit ?? getDistanceUnit()) === 'km' ? '/km' : '/mi';
}

export function splitIntervalMeters(unit?: DistanceUnit): number {
  return (unit ?? getDistanceUnit()) === 'km' ? METERS_PER_KM : METERS_PER_MILE;
}

// ─── Formatting Helpers ──────────────────────────────────────

/** Example: 10000m → "6.21 mi" or "10.00 km" */
export function formatDistance(meters: number, unit?: DistanceUnit): string {
  const u = unit ?? getDistanceUnit();
  const value = metersToUnit(meters, u);
  return `${value.toFixed(2)} ${unitLabel(u)}`;
}

export function formatDistanceShort(meters: number, unit?: DistanceUnit): string {
  const u = unit ?? getDistanceUnit();
  const value = metersToUnit(meters, u);
  return `${value.toFixed(1)} ${unitLabel(u)}`;
}

export function formatPace(distanceMeters: number, timeSec: number, unit?: DistanceUnit): string {
  if (!distanceMeters || !timeSec) return '—';
  const u = unit ?? getDistanceUnit();
  const dist = metersToUnit(distanceMeters, u);
  if (dist <= 0) return '—';
  const minPerUnit = (timeSec / 60) / dist;
  return formatPaceValue(minPerUnit, u);
}

export function formatPaceValue(paceMinPerUnit: number, unit?: DistanceUnit): string {
  if (!paceMinPerUnit || paceMinPerUnit > 30) return '—';
  const totalSec = Math.round(paceMinPerUnit * 60);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${sec.toString().padStart(2, '0')}${paceUnitLabel(unit)}`;
}

export function calcPace(distanceMeters: number, timeSec: number, unit?: DistanceUnit): number {
  if (!distanceMeters || !timeSec) return 0;
  const dist = metersToUnit(distanceMeters, unit);
  return dist > 0 ? (timeSec / 60) / dist : 0;
}

export function formatElevation(meters: number, unit?: DistanceUnit): string {
  const u = unit ?? getDistanceUnit();
  if (u === 'km') return `${Math.round(meters)} m`;
  return `${Math.round(meters * 3.28084)} ft`;
}

/** Speed for rides and other non-running sports. Example: 8.33 m/s → "18.6 mph" or "30.0 km/h" */
export function formatSpeed(metersPerSecond: number | null | undefined, unit?: DistanceUnit): string {
  if (!metersPerSecond || metersPerSecond <= 0) return '—';
  const u = unit ?? getDistanceUnit();
  return u === 'km'
    ? `${(metersPerSecond * 3.6).toFixed(1)} km/h`
    : `${((metersPerSecond * 3600) / METERS_PER_MILE).toFixed(1)} mph`;
}

export function formatDuration(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.round(sec % 60);
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}:${s.toString().padStart(2, '0')}`;
  return `${s}s`;
}

// ─── Raw Conversion Helpers ──────────────────────────────────

export function metersToMiles(m: number): number {
  return m / METERS_PER_MILE;
}

export function metersToKm(m: number): number {
  return m / 1000;
}

/** Calculate pace in min/mi from raw distance (meters) and time (seconds). */
export function calcPaceMinPerMi(distanceMeters: number, movingTimeSec: number): number {
  if (!distanceMeters || !movingTimeSec) return 0;
  return (movingTimeSec / 60) / metersToMiles(distanceMeters);
}

/** Format a pace value as "M:SS" (no unit suffix). Used for PRs and compact display. */
export function formatPaceShort(paceMinPerUnit: number): string {
  if (!paceMinPerUnit || paceMinPerUnit > 30) return '—';
  const totalSec = Math.round(paceMinPerUnit * 60);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${sec.toString().padStart(2, '0')}`;
}

// ─── Mile-based Data Converters ──────────────────────────────
// Plan data, sync data, and recap data are stored in miles.
// These helpers convert to the user's preferred unit for display.

export function milesToUnit(miles: number, unit?: DistanceUnit): number {
  const u = unit ?? getDistanceUnit();
  return u === 'km' ? miles * 1.60934 : miles;
}

export function formatMiles(miles: number, decimals: number = 1, unit?: DistanceUnit): string {
  const u = unit ?? getDistanceUnit();
  const value = milesToUnit(miles, u);
  return `${value.toFixed(decimals)} ${unitLabel(u)}`;
}

export function formatPaceFromMinPerMi(paceMinPerMi: number, unit?: DistanceUnit): string {
  if (!paceMinPerMi) return '—';
  const u = unit ?? getDistanceUnit();
  const paceInUnit = u === 'km' ? paceMinPerMi / 1.60934 : paceMinPerMi;
  return formatPaceValue(paceInUnit, u);
}
