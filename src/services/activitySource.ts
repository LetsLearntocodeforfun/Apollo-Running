/**
 * Activity source facade + sync engine.
 *
 * Pages and services read activities through this module instead of talking
 * to a specific platform. Activities from every connected source are synced
 * into one local store (IndexedDB-backed via analyticsService), deduplicated
 * across sources, and served from there — so the app keeps working offline
 * and regardless of which platform the athlete uses.
 *
 * Sources (in priority order):
 *   1. intervals.icu — free. Relays Garmin Connect, Zwift, Wahoo, COROS,
 *      Suunto, Polar and more, including rides and other cross-training.
 *   2. Strava        — optional, for athletes who have Strava API access.
 *
 * Sync model:
 *   - First sync per source imports the full history (year-by-year windows).
 *   - Later syncs are incremental (newest activity − 7 days overlap), so every
 *     daily activity — including late uploads and edits — lands in the store.
 */

import {
  getIntervalsCredentials,
  setIntervalsCredentials,
  clearIntervalsCredentials,
  getStravaTokens,
  clearStravaTokens,
} from './storage';
import * as stravaApi from './strava';
import * as intervalsApi from './intervals';
import { getStoredActivities, storeActivities } from './analyticsService';
import { persistence } from './db/persistence';
import { isRunActivity } from './activity/sports';
import type { Activity, ActivitySource, AthleteProfile, LiveActivitySource } from './activity/types';

export type { Activity, ActivitySource, AthleteProfile, LiveActivitySource } from './activity/types';
export { getStoredActivities } from './analyticsService';

// ── Constants ─────────────────────────────────────────────────────────────────

const SYNC_STATE_KEY = 'apollo_activity_sync_state';
const DAY_MS = 24 * 60 * 60 * 1000;
/** Re-fetch this many days before the newest known activity to catch late uploads/edits. */
const INCREMENTAL_OVERLAP_DAYS = 7;
/** Pages trigger a background refresh when the last sync is older than this. */
const STALE_AFTER_MS = 5 * 60 * 1000;
/** Full-history import walks back in 1-year windows up to this many years. */
const MAX_HISTORY_YEARS = 25;
/** Stop walking back after this many consecutive empty years. */
const EMPTY_YEARS_BEFORE_STOP = 3;
/** intervals.icu lists don't include GPS — fetch route maps for recent runs, a few per sync. */
const ROUTE_ENRICH_PER_SYNC = 30;
const ROUTE_ENRICH_WINDOW_DAYS = 180;
const STRAVA_PAGE_SIZE = 200;

/** Source priority: first connected source is the "primary" one. */
const SOURCE_ORDER: LiveActivitySource[] = ['intervals', 'strava'];

// ── Connection status ─────────────────────────────────────────────────────────

export function isIntervalsConnected(): boolean {
  return !!getIntervalsCredentials();
}

export function isStravaConnected(): boolean {
  return !!getStravaTokens();
}

/** Connected live sources in priority order (file imports are not a connection). */
export function getConnectedSources(): LiveActivitySource[] {
  return SOURCE_ORDER.filter((s) => (s === 'intervals' ? isIntervalsConnected() : isStravaConnected()));
}

/** True when at least one live data source is connected. */
export function isActivitySourceConnected(): boolean {
  return getConnectedSources().length > 0;
}

/** True when activities are available locally (connected now, synced before, or imported from files). */
export function hasActivityData(): boolean {
  return isActivitySourceConnected() || getStoredActivities().length > 0;
}

export function getSourceDisplayName(source: ActivitySource | string | null | undefined): string {
  if (source === 'intervals') return 'intervals.icu';
  if (source === 'file') return 'File import';
  return 'Strava';
}

/** e.g. "intervals.icu", "Strava", "intervals.icu + Strava" or "Not connected". */
export function getActiveSourceName(): string {
  const sources = getConnectedSources();
  return sources.length ? sources.map(getSourceDisplayName).join(' + ') : 'Not connected';
}

/** Link to the activity on the platform it was synced from, or null (file imports). */
export function getActivityExternalUrl(a: Pick<Activity, 'id' | 'source' | 'source_id'>): string | null {
  if (a.source === 'file') return null;
  if (a.source === 'intervals') {
    return a.source_id ? `https://intervals.icu/activities/${encodeURIComponent(a.source_id)}` : null;
  }
  // Strava records (and legacy records without a source) use Strava IDs
  return `https://www.strava.com/activities/${encodeURIComponent(a.source_id ?? String(a.id))}`;
}

// ── Sync state ────────────────────────────────────────────────────────────────

export interface SourceSyncState {
  /** Last successful sync (ISO). */
  lastSyncAt: string | null;
  /** Last completed full-history import (ISO). Null → next sync imports everything. */
  lastFullSyncAt: string | null;
  /** UTC start time of the newest activity received from this source. */
  newestActivityAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  /** Activities received from this source over its lifetime (includes re-fetches). */
  totalFetched: number;
}

const EMPTY_SYNC_STATE: SourceSyncState = {
  lastSyncAt: null,
  lastFullSyncAt: null,
  newestActivityAt: null,
  lastError: null,
  lastErrorAt: null,
  totalFetched: 0,
};

function readSyncStateMap(): Partial<Record<ActivitySource, SourceSyncState>> {
  try {
    const raw = persistence.getItem(SYNC_STATE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

export function getSourceSyncState(source: ActivitySource): SourceSyncState {
  return { ...EMPTY_SYNC_STATE, ...(readSyncStateMap()[source] ?? {}) };
}

function saveSourceSyncState(source: ActivitySource, patch: Partial<SourceSyncState>): void {
  const map = readSyncStateMap();
  map[source] = { ...EMPTY_SYNC_STATE, ...(map[source] ?? {}), ...patch };
  persistence.setItem(SYNC_STATE_KEY, JSON.stringify(map));
}

/** Forget sync progress for a source (next sync performs a full import). */
export function resetSourceSyncState(source: ActivitySource): void {
  const map = readSyncStateMap();
  delete map[source];
  persistence.setItem(SYNC_STATE_KEY, JSON.stringify(map));
}

/** Most recent successful sync across all sources (ISO) or null. */
export function getLastActivitySyncTime(): string | null {
  let latest: string | null = null;
  for (const s of SOURCE_ORDER) {
    const t = getSourceSyncState(s).lastSyncAt;
    if (t && (!latest || t > latest)) latest = t;
  }
  return latest;
}

/** How long a page visit may reuse the last sync instead of syncing again. */
export const PAGE_SYNC_FRESH_MS = 10 * 60 * 1000;

/**
 * True when the last successful activity sync finished less than `maxAgeMs`
 * ago. Pages then re-match the activities already stored (offline, instant)
 * instead of calling the network on every visit.
 */
export function isActivitySyncFresh(maxAgeMs: number = PAGE_SYNC_FRESH_MS): boolean {
  const last = getLastActivitySyncTime();
  const at = last ? Date.parse(last) : NaN;
  return Number.isFinite(at) && Date.now() - at < maxAgeMs;
}

// ── Events ────────────────────────────────────────────────────────────────────

export interface SyncProgress {
  source: ActivitySource;
  message: string;
  /** Activities received so far from this source during the current sync. */
  fetched: number;
}

export interface SyncSummary {
  sources: ActivitySource[];
  fetched: number;
  added: number;
  updated: number;
  /** True if at least one source performed a full-history import. */
  full: boolean;
  errors: { source: ActivitySource; message: string }[];
  startedAt: string;
  finishedAt: string;
}

export interface SyncStatus {
  running: boolean;
  progress?: SyncProgress;
  summary?: SyncSummary;
}

const updateListeners = new Set<(summary: SyncSummary) => void>();
const statusListeners = new Set<(status: SyncStatus) => void>();
let lastSummary: SyncSummary | null = null;

/** Subscribe to "new or changed activities were stored". Returns an unsubscribe function. */
export function onActivitiesUpdated(listener: (summary: SyncSummary) => void): () => void {
  updateListeners.add(listener);
  return () => {
    updateListeners.delete(listener);
  };
}

/** Subscribe to sync start/progress/finish events. Returns an unsubscribe function. */
export function onSyncStatus(listener: (status: SyncStatus) => void): () => void {
  statusListeners.add(listener);
  return () => {
    statusListeners.delete(listener);
  };
}

function emitStatus(status: SyncStatus): void {
  for (const l of statusListeners) {
    try { l(status); } catch { /* listener errors must not break sync */ }
  }
}

export function getLastSyncSummary(): SyncSummary | null {
  return lastSummary;
}

/**
 * Tell `onActivitiesUpdated` listeners that the local store changed outside a
 * sync (e.g. a file import), so open pages refresh the same way they do after
 * a sync.
 */
export function notifyActivitiesUpdated(summary: SyncSummary): void {
  if (summary.added === 0 && summary.updated === 0) return;
  for (const l of updateListeners) {
    try { l(summary); } catch { /* ignore */ }
  }
}

// ── Sync engine ───────────────────────────────────────────────────────────────

let inFlight: Promise<SyncSummary> | null = null;
let inFlightFull = false;
/** Sources the in-flight sync is pulling from (captured when it started). */
let inFlightSources: LiveActivitySource[] = [];

export function isSyncRunning(): boolean {
  return inFlight !== null;
}

/**
 * Pull activities from every connected source into the local store.
 * Never throws — per-source failures are reported in `summary.errors`.
 *
 * @param opts.full Re-import the complete history (first sync is always full).
 */
export function syncActivities(
  opts: { full?: boolean; onProgress?: (p: SyncProgress) => void } = {},
): Promise<SyncSummary> {
  if (inFlight) {
    // A source connected after the running sync started (e.g. Strava OAuth
    // finishing during the launch sync) isn't covered by it — queue a follow-up
    // so its first import isn't skipped. Same for a full import requested while
    // an incremental sync is running.
    const coversSources = getConnectedSources().every((s) => inFlightSources.includes(s));
    if (coversSources && (!opts.full || inFlightFull)) return inFlight;
    return inFlight.then(() => syncActivities(opts));
  }
  inFlightFull = !!opts.full;
  inFlightSources = getConnectedSources();
  inFlight = runSync(!!opts.full, opts.onProgress).finally(() => {
    inFlight = null;
    inFlightFull = false;
    inFlightSources = [];
  });
  return inFlight;
}

interface SourceSyncResult {
  fetched: number;
  added: number;
  updated: number;
  newestStart: string | null;
}

type ProgressReporter = (message: string, fetched: number) => void;

async function runSync(full: boolean, onProgress?: (p: SyncProgress) => void): Promise<SyncSummary> {
  const startedAt = new Date().toISOString();
  const sources = getConnectedSources();
  const summary: SyncSummary = {
    sources, fetched: 0, added: 0, updated: 0, full: false, errors: [], startedAt, finishedAt: startedAt,
  };
  emitStatus({ running: true });

  for (const source of sources) {
    const state = getSourceSyncState(source);
    const doFull = full || !state.lastFullSyncAt;
    const report: ProgressReporter = (message, fetched) => {
      const progress: SyncProgress = { source, message, fetched };
      try { onProgress?.(progress); } catch { /* ignore */ }
      emitStatus({ running: true, progress });
    };
    try {
      const r = source === 'intervals'
        ? await syncFromIntervals(doFull, state, report)
        : await syncFromStrava(doFull, state, report);
      summary.fetched += r.fetched;
      summary.added += r.added;
      summary.updated += r.updated;
      summary.full = summary.full || doFull;
      const now = new Date().toISOString();
      saveSourceSyncState(source, {
        lastSyncAt: now,
        lastFullSyncAt: doFull ? now : state.lastFullSyncAt,
        newestActivityAt: maxIso(state.newestActivityAt, r.newestStart),
        lastError: null,
        lastErrorAt: null,
        totalFetched: state.totalFetched + r.fetched,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      summary.errors.push({ source, message });
      saveSourceSyncState(source, { lastError: message, lastErrorAt: new Date().toISOString() });
    }
  }

  if (sources.includes('intervals') && !summary.errors.some((e) => e.source === 'intervals')) {
    try {
      summary.updated += await enrichIntervalsRoutes((message, fetched) => {
        const progress: SyncProgress = { source: 'intervals', message, fetched };
        try { onProgress?.(progress); } catch { /* ignore */ }
        emitStatus({ running: true, progress });
      });
    } catch {
      // Route maps are a nice-to-have; they'll be retried next sync.
    }
  }

  summary.finishedAt = new Date().toISOString();
  lastSummary = summary;
  if (summary.added > 0 || summary.updated > 0) {
    for (const l of updateListeners) {
      try { l(summary); } catch { /* ignore */ }
    }
  }
  emitStatus({ running: false, summary });
  return summary;
}

function ingestInto(result: SourceSyncResult, activities: Activity[]): void {
  if (activities.length === 0) return;
  const r = storeActivities(activities);
  result.fetched += activities.length;
  result.added += r.added;
  result.updated += r.updated;
  for (const a of activities) result.newestStart = maxIso(result.newestStart, a.start_date);
}

async function syncFromIntervals(
  full: boolean,
  state: SourceSyncState,
  report: ProgressReporter,
): Promise<SourceSyncResult> {
  const result: SourceSyncResult = { fetched: 0, added: 0, updated: 0, newestStart: null };
  // `newest` is a local date; use tomorrow so today's activities are always included.
  const tomorrow = addDays(new Date(), 1);

  if (full) {
    let windowEnd = tomorrow;
    let emptyStreak = 0;
    for (let year = 0; year < MAX_HISTORY_YEARS; year++) {
      const windowStart = addDays(windowEnd, -365);
      report(`Importing ${windowStart.getFullYear()}–${windowEnd.getFullYear()} history…`, result.fetched);
      const batch = await intervalsApi.listIntervalsActivities({
        oldest: toLocalDate(windowStart),
        newest: toLocalDate(windowEnd),
      });
      ingestInto(result, batch);
      emptyStreak = batch.length === 0 ? emptyStreak + 1 : 0;
      if (emptyStreak >= EMPTY_YEARS_BEFORE_STOP) break;
      // Windows share their boundary date; duplicates are merged by ID.
      windowEnd = windowStart;
    }
    return result;
  }

  const since = state.newestActivityAt
    ? addDays(new Date(state.newestActivityAt), -INCREMENTAL_OVERLAP_DAYS)
    : addDays(new Date(), -30);
  report('Checking intervals.icu for new activities…', 0);
  const batch = await intervalsApi.listIntervalsActivities({
    oldest: toLocalDate(since),
    newest: toLocalDate(tomorrow),
  });
  ingestInto(result, batch);
  return result;
}

async function syncFromStrava(
  full: boolean,
  state: SourceSyncState,
  report: ProgressReporter,
): Promise<SourceSyncResult> {
  const result: SourceSyncResult = { fetched: 0, added: 0, updated: 0, newestStart: null };
  const tag = (a: Activity): Activity => ({ ...a, source: 'strava', source_id: String(a.id) });

  const after = full
    ? undefined
    : Math.floor(
        ((state.newestActivityAt ? Date.parse(state.newestActivityAt) : Date.now() - 30 * DAY_MS)
          - INCREMENTAL_OVERLAP_DAYS * DAY_MS) / 1000,
      );
  const maxPages = full ? 50 : 5;
  for (let page = 1; page <= maxPages; page++) {
    report(full ? `Importing Strava history (page ${page})…` : 'Checking Strava for new activities…', result.fetched);
    const batch = await stravaApi.getActivities({ page, per_page: STRAVA_PAGE_SIZE, after });
    ingestInto(result, batch.map(tag));
    if (batch.length < STRAVA_PAGE_SIZE) break;
  }
  return result;
}

/**
 * intervals.icu activity lists don't include GPS. Fetch route maps for recent
 * outdoor runs (newest first, a bounded number per sync) so route maps and
 * effort recognition work. Runs without GPS are marked with an empty polyline
 * so they aren't re-requested.
 */
async function enrichIntervalsRoutes(report: ProgressReporter): Promise<number> {
  const cutoff = Date.now() - ROUTE_ENRICH_WINDOW_DAYS * DAY_MS;
  const candidates = getStoredActivities()
    .filter((a) =>
      a.source === 'intervals'
      && !!a.source_id
      && isRunActivity(a)
      && !a.trainer
      && (a.map?.summary_polyline === undefined || a.map?.summary_polyline === null)
      && Date.parse(a.start_date) >= cutoff)
    .slice(0, ROUTE_ENRICH_PER_SYNC);
  if (candidates.length === 0) return 0;

  const patched: Activity[] = [];
  for (const a of candidates) {
    report(`Fetching route maps (${patched.length + 1}/${candidates.length})…`, patched.length);
    try {
      const route = await intervalsApi.getIntervalsRoute(a.source_id!);
      patched.push({
        ...a,
        map: { id: `icu-${a.source_id}`, summary_polyline: route.summaryPolyline },
        start_latlng: route.start ?? a.start_latlng ?? null,
        end_latlng: route.end ?? a.end_latlng ?? null,
      });
    } catch (err) {
      if (err instanceof intervalsApi.IntervalsAuthError) throw err;
      // Transient failure — try again next sync.
    }
  }
  if (patched.length) storeActivities(patched);
  return patched.length;
}

// ── Reading activities ────────────────────────────────────────────────────────

function isSyncStale(): boolean {
  const now = Date.now();
  return getConnectedSources().some((s) => {
    const st = getSourceSyncState(s);
    // Back off after a failure so every page load doesn't hammer a failing source.
    if (st.lastErrorAt && now - Date.parse(st.lastErrorAt) < STALE_AFTER_MS) return false;
    return !st.lastSyncAt || now - Date.parse(st.lastSyncAt) > STALE_AFTER_MS;
  });
}

function activityEpochSec(a: Activity): number {
  const t = Date.parse(a.start_date || a.start_date_local);
  return Number.isFinite(t) ? t / 1000 : 0;
}

export interface ActivityQuery {
  page?: number;
  per_page?: number;
  /** Only activities starting after this epoch (seconds). */
  after?: number;
  /** Only activities starting before this epoch (seconds). */
  before?: number;
}

/** Query the local store (newest first). Never touches the network. */
export function queryStoredActivities({ page = 1, per_page = 30, after, before }: ActivityQuery = {}): Activity[] {
  let list = getStoredActivities();
  if (after != null) list = list.filter((a) => activityEpochSec(a) > after);
  if (before != null) list = list.filter((a) => activityEpochSec(a) < before);
  const start = (Math.max(1, page) - 1) * per_page;
  return list.slice(start, start + per_page);
}

/**
 * Drop-in replacement for the old Strava `getActivities()` call: refreshes the
 * local store from connected sources when stale, then serves the page from it.
 * Returns all sports (runs, rides, swims…) — filter with activity/sports.ts.
 */
export async function getActivities(params: ActivityQuery = {}): Promise<Activity[]> {
  if (isActivitySourceConnected() && isSyncStale()) {
    const summary = await syncActivities();
    const view = queryStoredActivities(params);
    if (view.length === 0 && summary.sources.length > 0 && summary.errors.length >= summary.sources.length) {
      throw new Error(summary.errors[0].message);
    }
    return view;
  }
  return queryStoredActivities(params);
}

const detailCache = new Map<number, Activity>();
const DETAIL_CACHE_MAX = 50;

/**
 * Fetch full detail (splits, laps, route) for an activity from the source it
 * was synced from. Falls back to the stored summary when that source is not
 * connected anymore. The returned object always keeps the store ID.
 */
export async function getActivityDetail(activityOrId: Activity | number): Promise<Activity> {
  const base = typeof activityOrId === 'number'
    ? getStoredActivities().find((a) => a.id === activityOrId)
    : activityOrId;
  if (!base) throw new Error('Activity not found. Try syncing again.');

  const cached = detailCache.get(base.id);
  if (cached) return cached;

  let detail: Activity;
  if (base.source === 'file') {
    // Splits, laps and the route were extracted from the file at import time.
    return base;
  } else if (base.source === 'intervals') {
    if (!isIntervalsConnected() || !base.source_id) return base;
    detail = await intervalsApi.getIntervalsActivityDetail(base);
  } else {
    if (!isStravaConnected()) return base;
    const stravaId = base.source === 'strava' && base.source_id ? Number(base.source_id) : base.id;
    const raw = await stravaApi.getActivityDetail(stravaId);
    detail = { ...base, ...raw, source: base.source ?? 'strava', source_id: String(stravaId) };
  }
  detail = { ...detail, id: base.id };

  // Persist a newly discovered route so maps and effort recognition work offline.
  const poly = detail.map?.summary_polyline;
  if (poly && !base.map?.summary_polyline) {
    try {
      storeActivities([{ ...base, map: { id: detail.map?.id ?? `route-${base.id}`, summary_polyline: poly } }]);
    } catch { /* non-critical */ }
  }

  if (detailCache.size >= DETAIL_CACHE_MAX) {
    const oldest = detailCache.keys().next();
    if (!oldest.done) detailCache.delete(oldest.value);
  }
  detailCache.set(base.id, detail);
  return detail;
}

let athleteCache: { at: number; value: AthleteProfile } | null = null;
const ATHLETE_CACHE_MS = 10 * 60 * 1000;

/** Profile of the connected athlete (primary source first). Never throws. */
export async function getAthlete(): Promise<AthleteProfile | null> {
  if (athleteCache && Date.now() - athleteCache.at < ATHLETE_CACHE_MS) return athleteCache.value;

  let value: AthleteProfile | null = null;
  const creds = getIntervalsCredentials();
  if (creds) {
    try {
      value = await intervalsApi.getIntervalsAthlete();
    } catch {
      if (creds.athleteName) {
        const [first, ...rest] = creds.athleteName.split(' ');
        value = { id: creds.athleteId, firstname: first ?? '', lastname: rest.join(' '), source: 'intervals' };
      }
    }
  }
  if (!value) {
    const tokens = getStravaTokens();
    if (tokens) {
      try {
        const a = await stravaApi.getAthlete();
        value = { id: a.id, firstname: a.firstname, lastname: a.lastname, profile: a.profile, source: 'strava' };
      } catch {
        if (tokens.athlete) {
          value = {
            id: tokens.athlete.id,
            firstname: tokens.athlete.firstname,
            lastname: tokens.athlete.lastname,
            profile: tokens.athlete.profile,
            source: 'strava',
          };
        }
      }
    }
  }
  if (value) athleteCache = { at: Date.now(), value };
  return value;
}

// ── Connect / disconnect ──────────────────────────────────────────────────────

/**
 * Accepts "i12345", "12345", "0", or an intervals.icu URL containing the athlete
 * ID. Empty input means "the athlete who owns the API key" ("0").
 */
export function normalizeIntervalsAthleteId(input: string | null | undefined): string {
  const value = (input ?? '').trim();
  if (!value) return '0';
  const fromUrl = /athlete\/(i?\d+)/i.exec(value);
  if (fromUrl) return fromUrl[1].toLowerCase();
  const plain = /^i?\d+$/i.exec(value);
  return plain ? value.toLowerCase() : value;
}

/**
 * Verify an intervals.icu API key and save it (encrypted on desktop).
 * The next sync imports the athlete's full history. If the OS keychain refuses
 * the key, it still works for this session and `getSecureStorageError()`
 * (storage.ts) explains why it won't survive a restart.
 */
export async function connectIntervals(apiKey: string, athleteId?: string): Promise<AthleteProfile> {
  const key = apiKey.trim();
  if (!key) throw new Error('Paste your intervals.icu API key first.');
  const probe = { apiKey: key, athleteId: normalizeIntervalsAthleteId(athleteId) };
  const athlete = await intervalsApi.getIntervalsAthlete(probe);
  const resolvedId = athlete.id ? String(athlete.id) : probe.athleteId;
  await setIntervalsCredentials({
    apiKey: key,
    athleteId: resolvedId,
    athleteName: `${athlete.firstname} ${athlete.lastname}`.trim() || undefined,
    connectedAt: new Date().toISOString(),
  });
  resetSourceSyncState('intervals');
  athleteCache = null;
  return athlete;
}

/** Disconnect a source. Already-synced history stays on this device. */
export function disconnectSource(source: LiveActivitySource): void {
  if (source === 'intervals') clearIntervalsCredentials();
  else clearStravaTokens();
  resetSourceSyncState(source);
  athleteCache = null;
  detailCache.clear();
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function maxIso(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return Date.parse(b) > Date.parse(a) ? b : a;
}

function addDays(d: Date, days: number): Date {
  const out = new Date(d);
  out.setDate(out.getDate() + days);
  return out;
}

/** Local calendar date as YYYY-MM-DD. */
function toLocalDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
