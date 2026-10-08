/**
 * Cross-source deduplication for the local activity store.
 *
 * The same run can arrive from several places: legacy Strava history already
 * cached on the device, intervals.icu (from Garmin/Zwift…), and Strava again if
 * the athlete keeps both connected. Records are matched by ID, or — across
 * different sources — by start time (±2 min) and distance (±3% / 100 m).
 *
 * When a duplicate arrives it is merged INTO the existing record, which keeps
 * its original ID so everything keyed by activity ID (plan-day sync metadata,
 * HR history, effort recognitions, cached routes) stays valid.
 *
 * v1.0.6: records the athlete deleted (tombstones.ts) are skipped, so a sync
 * or re-import can't resurrect them, and `findDuplicateCandidates` surfaces
 * same-source duplicates (e.g. a Garmin virtual run + its Zwift copy, both
 * relayed by intervals.icu) for the athlete to merge or keep.
 */

import type { Activity, ActivitySource } from './types';
import { loadTombstones, type TombstoneSet } from './tombstones';
import { getSportCategory } from './sports';

const START_TOLERANCE_SEC = 120;
const DISTANCE_TOLERANCE_RATIO = 0.03;
const DISTANCE_TOLERANCE_MIN_M = 100;

/**
 * Higher wins when two sources disagree:
 * intervals.icu > Strava > legacy (pre-migration Strava cache, no `source`) > file.
 * File imports therefore only fill in what a platform copy is missing (splits,
 * laps, routes) and never overwrite names or stats the athlete already sees.
 */
const SOURCE_PRIORITY: Record<ActivitySource, number> = { intervals: 3, strava: 2, file: 0 };
const LEGACY_PRIORITY = 1;

function priority(source: ActivitySource | undefined): number {
  return source ? SOURCE_PRIORITY[source] ?? LEGACY_PRIORITY : LEGACY_PRIORITY;
}

/** Legacy records without a source were always synced from Strava. */
function sourceOf(a: Activity): ActivitySource {
  return a.source ?? 'strava';
}

function startEpochSec(a: Activity): number {
  const utc = Date.parse(a.start_date);
  if (Number.isFinite(utc)) return utc / 1000;
  const local = Date.parse(a.start_date_local);
  return Number.isFinite(local) ? local / 1000 : NaN;
}

function utcDayKey(epochSec: number, fallback: string): string {
  return Number.isFinite(epochSec) ? new Date(epochSec * 1000).toISOString().slice(0, 10) : fallback.slice(0, 10);
}

/** Do two records describe the same real-world activity? */
export function isSameActivity(a: Activity, b: Activity): boolean {
  if (a.id === b.id) return true;
  // Same provider record. After a cross-source merge the stored copy keeps its
  // original ID but carries the winning source's identity.
  if (a.source && a.source === b.source && a.source_id && a.source_id === b.source_id) return true;
  // A live source never returns the same activity under two different IDs.
  // File imports can (the same run exported as FIT and as GPX), so they are
  // always compared by fingerprint.
  if (sourceOf(a) === sourceOf(b) && sourceOf(a) !== 'file') return false;

  const ta = startEpochSec(a);
  const tb = startEpochSec(b);
  if (!Number.isFinite(ta) || !Number.isFinite(tb) || Math.abs(ta - tb) > START_TOLERANCE_SEC) return false;

  const da = a.distance || 0;
  const db = b.distance || 0;
  if (da === 0 && db === 0) {
    // Distance-less sessions (strength, yoga…): compare duration instead.
    const ma = a.moving_time || a.elapsed_time || 0;
    const mb = b.moving_time || b.elapsed_time || 0;
    return Math.abs(ma - mb) <= Math.max(120, 0.1 * Math.max(ma, mb));
  }
  return Math.abs(da - db) <= Math.max(DISTANCE_TOLERANCE_MIN_M, DISTANCE_TOLERANCE_RATIO * Math.max(da, db));
}

function isEmptyValue(v: unknown): boolean {
  return v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
}

function mergeMap(
  existing: Activity['map'],
  incoming: Activity['map'],
  incomingWins: boolean,
): Activity['map'] {
  if (!incoming) return existing;
  const existingPoly = existing?.summary_polyline;
  if (incoming.summary_polyline) {
    if (existingPoly && !incomingWins) return existing;
    return {
      ...incoming,
      polyline: incoming.polyline || existing?.polyline || undefined,
    };
  }
  // Incoming has no route: never clobber a known route, but accept the
  // "checked — no GPS" marker (empty polyline) when nothing is known yet.
  return existingPoly ? existing : incoming;
}

/** Fields that say where a record came from; only a winning copy may set them. */
const IDENTITY_KEYS: ReadonlySet<string> = new Set(['source', 'source_id', 'origin']);

/**
 * Merge a newly synced copy into an existing record. The existing ID is kept.
 * If the incoming source has equal or higher priority its values overwrite;
 * otherwise it only fills in fields the existing record is missing — never its
 * identity (a legacy Strava record has no `source`, and must not become a file).
 */
export function mergeActivity(existing: Activity, incoming: Activity): Activity {
  const incomingWins = priority(incoming.source) >= priority(existing.source);
  const result: Activity = { ...existing };
  const target = result as unknown as Record<string, unknown>;
  const current = existing as unknown as Record<string, unknown>;

  for (const [key, value] of Object.entries(incoming)) {
    if (key === 'id') continue;
    if (key === 'map') {
      result.map = mergeMap(existing.map, incoming.map, incomingWins);
      continue;
    }
    if (!incomingWins && IDENTITY_KEYS.has(key)) continue;
    if (isEmptyValue(value)) continue;
    if (!incomingWins && !isEmptyValue(current[key])) continue;
    target[key] = value;
  }
  return result;
}

export interface MergeResult {
  /** All records, newest first. */
  activities: Activity[];
  added: number;
  updated: number;
  /** Incoming records skipped because the athlete deleted them on this device. */
  skippedDeleted: number;
}

export interface MergeOptions {
  /** Deleted-activity tombstones. Defaults to the stored ones (a read, never a write). */
  tombstones?: TombstoneSet;
}

/**
 * Merge a batch of synced activities into the stored list (deduplicating across sources).
 * Every write path (sync, route enrichment, file import) goes through here, so
 * tombstoned records are never resurrected.
 */
export function mergeIntoStore(existing: Activity[], incoming: Activity[], options: MergeOptions = {}): MergeResult {
  const tombstones = options.tombstones ?? loadTombstones();
  const byId = new Map<number, Activity>();
  const byDay = new Map<string, number[]>();
  /** "intervals:i123" / "strava:456" → store ID (merged records keep their original ID). */
  const bySourceKey = new Map<string, number>();

  const sourceKey = (a: Activity): string | null =>
    a.source && a.source_id ? `${a.source}:${a.source_id}` : null;

  const index = (a: Activity) => {
    const key = utcDayKey(startEpochSec(a), a.start_date_local);
    const ids = byDay.get(key);
    if (!ids) byDay.set(key, [a.id]);
    else if (!ids.includes(a.id)) ids.push(a.id);
    const sk = sourceKey(a);
    if (sk) bySourceKey.set(sk, a.id);
  };

  for (const a of existing) {
    byId.set(a.id, a);
    index(a);
  }

  const findDuplicate = (inc: Activity): number | undefined => {
    if (byId.has(inc.id)) return inc.id;
    const sk = sourceKey(inc);
    const bySource = sk ? bySourceKey.get(sk) : undefined;
    if (bySource !== undefined && byId.has(bySource)) return bySource;
    const t = startEpochSec(inc);
    const days = new Set<string>([utcDayKey(t, inc.start_date_local)]);
    if (Number.isFinite(t)) {
      days.add(utcDayKey(t - START_TOLERANCE_SEC, inc.start_date_local));
      days.add(utcDayKey(t + START_TOLERANCE_SEC, inc.start_date_local));
    }
    for (const day of days) {
      for (const id of byDay.get(day) ?? []) {
        const candidate = byId.get(id);
        if (candidate && isSameActivity(candidate, inc)) return id;
      }
    }
    return undefined;
  };

  let added = 0;
  let updated = 0;
  let skippedDeleted = 0;
  /** Records added by this call: later duplicates merging into them are part of the "added" count. */
  const addedNow = new Set<number>();
  for (const inc of incoming) {
    if (tombstones.size > 0 && tombstones.hasKey(inc)) {
      skippedDeleted++;
      continue;
    }
    const targetId = findDuplicate(inc);
    if (targetId === undefined) {
      // Another source's copy of a deleted workout (nothing left in the store to merge into).
      if (tombstones.matchesPrint(inc)) {
        skippedDeleted++;
        continue;
      }
      byId.set(inc.id, inc);
      index(inc);
      addedNow.add(inc.id);
      added++;
      continue;
    }
    const current = byId.get(targetId)!;
    const merged = mergeActivity(current, inc);
    if (JSON.stringify(merged) !== JSON.stringify(current)) {
      byId.set(targetId, merged);
      index(merged);
      if (!addedNow.has(targetId)) updated++;
    }
  }

  const activities = Array.from(byId.values()).sort((a, b) =>
    b.start_date_local < a.start_date_local ? -1 : b.start_date_local > a.start_date_local ? 1 : 0,
  );
  return { activities, added, updated, skippedDeleted };
}

// ── Duplicate candidates (same source allowed) ───────────────────────────────

/** A pair of records that look like the same workout. */
export interface DuplicateCandidate {
  /** Stable key for remembering a "keep both" decision. */
  key: string;
  /** The richer record (HR, route, splits) — kept when merging. */
  keep: Activity;
  /** The lesser record — hidden when merging. */
  drop: Activity;
  /** Seconds between the two start times. */
  startDeltaSec: number;
  /** Relative distance difference (0.01 = 1 %). */
  distanceDeltaRatio: number;
}

/** Order-independent key for a pair of activity IDs. */
export function duplicatePairKey(a: number, b: number): string {
  return a < b ? `${a}-${b}` : `${b}-${a}`;
}

/** Run, VirtualRun and TrailRun are interchangeable; other sports must share a category (and type for "other"). */
function compatibleTypes(a: Activity, b: Activity): boolean {
  const ca = getSportCategory(a);
  const cb = getSportCategory(b);
  if (ca !== cb) return false;
  if (ca === 'other') return (a.sport_type || a.type) === (b.sport_type || b.type);
  return true;
}

/** Richness score: which copy of a duplicate pair to keep. */
function richness(a: Activity): number {
  let score = priority(a.source);
  if (a.average_heartrate && a.average_heartrate > 0) score += 4;
  if (a.map?.summary_polyline) score += 2;
  if ((a.splits_metric?.length ?? 0) > 0 || (a.splits_standard?.length ?? 0) > 0 || (a.laps?.length ?? 0) > 0) score += 1;
  return score;
}

/**
 * Pairs of visible records that are probably the same workout, including two
 * records from the SAME source (|Δstart| ≤ 120 s, |Δdistance| ≤ 3 %, compatible
 * sport types). Hidden records and pairs in `dismissed` (keys from
 * {@link duplicatePairKey}) are ignored. Pure.
 */
export function findDuplicateCandidates(
  activities: Activity[],
  options: { dismissed?: ReadonlySet<string> } = {},
): DuplicateCandidate[] {
  const dismissed = options.dismissed ?? new Set<string>();
  const timed = activities
    .filter((a) => !a.hidden)
    .map((a) => ({ a, t: startEpochSec(a) }))
    .filter((x) => Number.isFinite(x.t))
    .sort((x, y) => x.t - y.t);

  const out: DuplicateCandidate[] = [];
  const paired = new Set<number>();
  for (let i = 0; i < timed.length; i++) {
    const { a, t } = timed[i];
    if (paired.has(a.id)) continue;
    for (let j = i + 1; j < timed.length && timed[j].t - t <= START_TOLERANCE_SEC; j++) {
      const b = timed[j].a;
      if (paired.has(b.id) || a.id === b.id) continue;
      const key = duplicatePairKey(a.id, b.id);
      if (dismissed.has(key) || !compatibleTypes(a, b)) continue;
      const da = a.distance || 0;
      const db = b.distance || 0;
      const maxD = Math.max(da, db);
      if (maxD > 0) {
        if (Math.abs(da - db) > DISTANCE_TOLERANCE_RATIO * maxD) continue;
      } else {
        const ma = a.moving_time || a.elapsed_time || 0;
        const mb = b.moving_time || b.elapsed_time || 0;
        if (Math.abs(ma - mb) > Math.max(120, 0.1 * Math.max(ma, mb))) continue;
      }
      const ra = richness(a);
      const rb = richness(b);
      const keepA = ra !== rb ? ra > rb : da !== db ? da > db : a.id < b.id;
      out.push({
        key,
        keep: keepA ? a : b,
        drop: keepA ? b : a,
        startDeltaSec: Math.abs(timed[j].t - t),
        distanceDeltaRatio: maxD > 0 ? Math.abs(da - db) / maxD : 0,
      });
      paired.add(a.id);
      paired.add(b.id);
      break;
    }
  }
  return out;
}
