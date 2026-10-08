/**
 * Tombstones for activities the athlete deleted on this device (v1.0.6, B18).
 *
 * A deleted activity must not come back on the next sync or file re-import.
 * Two records are kept:
 *  - `apollo_activity_tombstones`: `${source}:${source_id}` keys (legacy
 *    records without a source are Strava records keyed by their ID). An
 *    incoming copy with a tombstoned key is always skipped.
 *  - `apollo_activity_tombstone_prints`: start time + distance fingerprints.
 *    They catch the same workout arriving from ANOTHER source (e.g. the
 *    Strava copy of a deleted intervals.icu run), but only when the incoming
 *    record doesn't match anything still in the store, so a kept duplicate
 *    can always be updated.
 *
 * Reading is side-effect free; writing happens only through
 * {@link addTombstones} / {@link clearTombstones}.
 */

import { persistence } from '../db/persistence';
import type { Activity } from './types';

export const TOMBSTONES_KEY = 'apollo_activity_tombstones';
export const TOMBSTONE_PRINTS_KEY = 'apollo_activity_tombstone_prints';

/** Same tolerances as cross-source deduplication. */
const PRINT_START_TOLERANCE_SEC = 120;
const PRINT_DISTANCE_RATIO = 0.03;
const PRINT_DISTANCE_MIN_M = 100;

/** Start time (epoch seconds) + distance (meters) of a deleted activity. */
export interface TombstonePrint {
  t: number;
  d: number;
}

type Identified = Pick<Activity, 'id' | 'source' | 'source_id'>;

/** `${source}:${source_id}` identity of a record, e.g. "intervals:i123" or "strava:456". */
export function activitySourceKey(a: Identified): string {
  const source = a.source ?? 'strava';
  const sourceId = a.source_id ?? String(a.id);
  return `${source}:${sourceId}`;
}

function startEpochSec(a: Pick<Activity, 'start_date' | 'start_date_local'>): number {
  const utc = Date.parse(a.start_date);
  if (Number.isFinite(utc)) return utc / 1000;
  const local = Date.parse(a.start_date_local);
  return Number.isFinite(local) ? local / 1000 : NaN;
}

function readJsonArray<T>(key: string): T[] {
  try {
    const raw = persistence.getItem(key);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

/** Read-only view over the stored tombstones. */
export interface TombstoneSet {
  /** True when this exact provider record was deleted. */
  hasKey(a: Identified): boolean;
  /** True when a deleted record had the same start time and distance. */
  matchesPrint(a: Pick<Activity, 'start_date' | 'start_date_local' | 'distance'>): boolean;
  readonly size: number;
}

/** Build a matcher from explicit lists (pure; used by tests and by {@link loadTombstones}). */
export function createTombstoneSet(keys: Iterable<string>, prints: TombstonePrint[] = []): TombstoneSet {
  const keySet = new Set(keys);
  const sortedPrints = prints
    .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.d))
    .sort((a, b) => a.t - b.t);
  return {
    size: keySet.size,
    hasKey: (a) => keySet.size > 0 && keySet.has(activitySourceKey(a)),
    matchesPrint: (a) => {
      if (sortedPrints.length === 0) return false;
      const t = startEpochSec(a);
      if (!Number.isFinite(t)) return false;
      const d = a.distance || 0;
      return sortedPrints.some((p) =>
        Math.abs(p.t - t) <= PRINT_START_TOLERANCE_SEC
        && Math.abs(p.d - d) <= Math.max(PRINT_DISTANCE_MIN_M, PRINT_DISTANCE_RATIO * Math.max(p.d, d)));
    },
  };
}

/** Current tombstones from storage (a read; never writes). */
export function loadTombstones(): TombstoneSet {
  return createTombstoneSet(
    readJsonArray<string>(TOMBSTONES_KEY).filter((k) => typeof k === 'string'),
    readJsonArray<TombstonePrint>(TOMBSTONE_PRINTS_KEY),
  );
}

/** All tombstoned `${source}:${source_id}` keys. */
export function getTombstoneKeys(): string[] {
  return readJsonArray<string>(TOMBSTONES_KEY).filter((k) => typeof k === 'string');
}

/**
 * True when the athlete deleted this provider record on this device
 * (e.g. `isTombstoned('intervals', 'i123')`). For ingest/reconcile code;
 * `mergeIntoStore` already applies tombstones to every store write.
 */
export function isTombstoned(source: string, sourceId: string): boolean {
  return getTombstoneKeys().includes(`${source}:${sourceId}`);
}

/** Remember deleted records so syncs and re-imports skip them (idempotent). */
export function addTombstones(activities: Array<Identified & Pick<Activity, 'start_date' | 'start_date_local' | 'distance'>>): void {
  if (activities.length === 0) return;
  const keys = new Set(getTombstoneKeys());
  const prints = readJsonArray<TombstonePrint>(TOMBSTONE_PRINTS_KEY);
  for (const a of activities) {
    keys.add(activitySourceKey(a));
    const t = startEpochSec(a);
    if (Number.isFinite(t) && !prints.some((p) => p.t === t && p.d === (a.distance || 0))) {
      prints.push({ t, d: a.distance || 0 });
    }
  }
  persistence.setItem(TOMBSTONES_KEY, JSON.stringify([...keys]));
  persistence.setItem(TOMBSTONE_PRINTS_KEY, JSON.stringify(prints));
}

/** Forget tombstones (e.g. "restore deleted activities"); the next sync re-imports them. */
export function clearTombstones(): void {
  persistence.removeItem(TOMBSTONES_KEY);
  persistence.removeItem(TOMBSTONE_PRINTS_KEY);
}
