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
 *   - Later syncs are incremental (newest activity − 30 days overlap), so every
 *     daily activity — including late uploads and edits — lands in the store.
 *     intervals.icu activities deleted remotely inside that window are removed
 *     (conservatively — see reconcileIntervalsDeletions).
 *   - A source whose credentials were rejected is skipped until it is
 *     reconnected (connectionHealth.ts), unless a sync is forced.
 *   - One sync runs at a time; `cancelSync()` or a 5-minute watchdog stops it.
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
import {
  getStoredActivities,
  getAllStoredActivities,
  storeActivities,
  writeActivityStore,
  MAX_STORED_ACTIVITIES,
  type StoreActivitiesResult,
} from './analyticsService';
import { persistence } from './db/persistence';
import { isRunActivity } from './activity/sports';
import { clearNeedsReconnect, getNeedsReconnect } from './connectionHealth';
import { isStorageDegraded, requestPersistentStorageOnce } from './storageHealth';
import { scheduleEffortRebuild } from './effortService';
import { dateKeyFromLocalIso } from '../utils/localDate';
import type { Activity, ActivitySource, AthleteProfile, LiveActivitySource } from './activity/types';

export type { Activity, ActivitySource, AthleteProfile, LiveActivitySource } from './activity/types';
export { getStoredActivities } from './analyticsService';

// ── Constants ─────────────────────────────────────────────────────────────────

const SYNC_STATE_KEY = 'apollo_activity_sync_state';
const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * Re-fetch this many days before the newest known activity, so late uploads
 * (a watch synced weeks later) and edits still land in the store. Also the
 * window in which remote deletions are reconciled.
 */
const INCREMENTAL_OVERLAP_DAYS = 30;
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
/** A sync running longer than this is stopped (watchdog), so one hung request can't block syncing. */
const MAX_SYNC_AGE_MS = 5 * 60 * 1000;
/**
 * Remote-deletion reconcile removes at most max(this, share × activities in
 * the window) per sync; more looks like an incomplete reply and is skipped.
 */
const RECONCILE_ALWAYS_ALLOWED = 3;
const RECONCILE_MAX_SHARE = 0.5;

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
  /**
   * Sources this sync covered, including ones skipped because they need to be
   * reconnected (each skipped source also has an entry in `errors`).
   */
  sources: ActivitySource[];
  fetched: number;
  added: number;
  updated: number;
  /** True if at least one source performed a full-history import. */
  full: boolean;
  errors: { source: ActivitySource; message: string }[];
  startedAt: string;
  finishedAt: string;
  /** Activities removed because they were deleted on the source (sync only). */
  removed?: number;
  /**
   * The device store reached MAX_STORED_ACTIVITIES during this sync, so older
   * history was not imported (or older records were trimmed).
   */
  storeFull?: boolean;
  /**
   * The sync was stopped early by `cancelSync()` or the watchdog. Activities
   * stored before that are kept; unfinished sources are listed in `errors`.
   */
  cancelled?: boolean;
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

/** Options for {@link syncActivities}. */
export interface SyncOptions {
  /** Re-import the complete history (the first sync per source is always full). */
  full?: boolean;
  /** Only sync these sources (default: every connected source). */
  sources?: LiveActivitySource[];
  /**
   * Also sync sources flagged as needing reconnect (a manual "Retry"). Without
   * it they are skipped and reported in `summary.errors`.
   */
  force?: boolean;
  onProgress?: (p: SyncProgress) => void;
}

/** `errors[].message` for sources a cancelled sync didn't finish. */
const SYNC_CANCELLED_MESSAGE = 'Sync was cancelled.';
/** `errors[].message` (and the source's lastError) when the watchdog stops a sync. */
const SYNC_TIMED_OUT_MESSAGE = 'Sync took longer than 5 minutes and was stopped. It will try again later.';
/** `errors[].message` while storage is degraded. */
const SYNC_STORAGE_DEGRADED_MESSAGE =
  'Sync is paused: Apollo couldn\u2019t open its saved data on this device, so new activities can\u2019t be stored safely. Restart Apollo to try again.';

/** Which sources one sync covers. */
interface SyncPlan {
  /** Connected sources the caller asked for, in priority order. */
  requested: LiveActivitySource[];
  /** Of `requested`: sources to pull from. */
  sync: LiveActivitySource[];
  /** Of `requested`: sources skipped because their credentials were rejected. */
  skipped: { source: LiveActivitySource; reason: string }[];
}

/** State of one sync run, shared by the run itself and its stop path (cancel / watchdog). */
interface SyncRun {
  summary: SyncSummary;
  /** Sources whose outcome is already recorded in `summary`. */
  settled: Set<ActivitySource>;
  /** Aborted when the run is stopped; every request of the run observes it. */
  signal: AbortSignal;
  onProgress?: (p: SyncProgress) => void;
  /** Source being synced and what it stored so far (counted if the run is stopped). */
  current: { source: LiveActivitySource; result: SourceSyncResult } | null;
  /** `finishRun` ran: listeners were notified and `running: false` was emitted. */
  finished: boolean;
}

interface InFlightSync {
  promise: Promise<SyncSummary>;
  /** `Date.now()` when the sync started. */
  startedAt: number;
  full: boolean;
  /** Sources the sync pulls from (captured when it started). */
  sources: LiveActivitySource[];
  /** Stop now: abort requests, report unfinished sources, settle `promise`. */
  stop: (reason: string) => void;
}

let inFlight: InFlightSync | null = null;

export function isSyncRunning(): boolean {
  return inFlight !== null;
}

/**
 * Pull activities from every connected source (or `opts.sources`) into the
 * local store. Never throws — per-source failures are reported in
 * `summary.errors`. Sources whose credentials were rejected are skipped (and
 * reported) until they are reconnected, unless `opts.force` is set.
 *
 * One sync runs at a time; callers share it when it covers what they asked
 * for. A sync running longer than 5 minutes is stopped by a watchdog, so a
 * hung request can't block later syncs.
 */
export function syncActivities(opts: SyncOptions = {}): Promise<SyncSummary> {
  // Backstop for the watchdog timer, which can fire late (sleep, throttled tab).
  if (inFlight && Date.now() - inFlight.startedAt >= MAX_SYNC_AGE_MS) inFlight.stop(SYNC_TIMED_OUT_MESSAGE);
  const plan = planSources(opts);
  const running = inFlight;
  if (running) {
    // A source connected after the running sync started (e.g. Strava OAuth
    // finishing during the launch sync) isn't covered by it — queue a follow-up
    // so its first import isn't skipped. Same for a full import requested while
    // an incremental sync is running.
    const covers = plan.sync.every((s) => running.sources.includes(s));
    if (covers && (!opts.full || running.full)) return running.promise;
    const next = (): Promise<SyncSummary> => syncActivities(opts);
    return running.promise.then(next, next);
  }
  return startSync(opts, plan).promise;
}

/**
 * Stop the running sync, if any. Its requests are aborted, activities stored
 * so far stay stored, and its promise resolves with `summary.cancelled` set
 * (unfinished sources are listed in `summary.errors`). Returns false when no
 * sync was running.
 */
export function cancelSync(): boolean {
  const running = inFlight;
  if (!running) return false;
  running.stop(SYNC_CANCELLED_MESSAGE);
  return true;
}

function planSources(opts: SyncOptions): SyncPlan {
  const requested = getConnectedSources().filter((s) => !opts.sources || opts.sources.includes(s));
  const plan: SyncPlan = { requested, sync: [], skipped: [] };
  for (const source of requested) {
    const flagged = opts.force ? null : getNeedsReconnect(source);
    if (flagged) plan.skipped.push({ source, reason: flagged.reason });
    else plan.sync.push(source);
  }
  return plan;
}

function startSync(opts: SyncOptions, plan: SyncPlan): InFlightSync {
  const controller = new AbortController();
  const started = new Date();
  const run: SyncRun = {
    summary: {
      sources: plan.requested,
      fetched: 0,
      added: 0,
      updated: 0,
      removed: 0,
      full: false,
      errors: [],
      startedAt: started.toISOString(),
      finishedAt: started.toISOString(),
    },
    settled: new Set(),
    signal: controller.signal,
    onProgress: opts.onProgress,
    current: null,
    finished: false,
  };
  let resolveStopped: (summary: SyncSummary) => void = () => undefined;
  const stopped = new Promise<SyncSummary>((resolve) => {
    resolveStopped = resolve;
  });
  const entry: InFlightSync = {
    promise: stopped,
    startedAt: started.getTime(),
    full: !!opts.full,
    sources: plan.sync,
    stop: (reason) => {
      if (inFlight === entry) inFlight = null;
      if (run.finished) return;
      controller.abort();
      recordStop(run, plan.sync, reason);
      resolveStopped(finishRun(run));
    },
  };
  const watchdog = setTimeout(() => entry.stop(SYNC_TIMED_OUT_MESSAGE), MAX_SYNC_AGE_MS);
  inFlight = entry;
  // Deferred one microtask so `entry.promise` is in place before any status
  // listener runs (a listener may call syncActivities again).
  const work = Promise.resolve()
    .then(() => runSync(run, !!opts.full, plan))
    .catch((err: unknown) => {
      // Defensive: runSync records per-source failures itself.
      console.warn('[Apollo] Activity sync failed:', err);
      return finishRun(run);
    });
  entry.promise = Promise.race([work, stopped]).finally(() => {
    clearTimeout(watchdog);
    if (inFlight === entry) inFlight = null;
  });
  return entry;
}

interface SourceSyncResult {
  fetched: number;
  added: number;
  updated: number;
  /** Activities removed because the source deleted them (intervals.icu reconcile). */
  removed: number;
  newestStart: string | null;
  /** The store reached MAX_STORED_ACTIVITIES during this source's import. */
  storeFull: boolean;
}

type ProgressReporter = (message: string, fetched: number) => void;

function progressReporter(run: SyncRun, source: ActivitySource): ProgressReporter {
  return (message, fetched) => {
    if (run.signal.aborted) return;
    const progress: SyncProgress = { source, message, fetched };
    try { run.onProgress?.(progress); } catch { /* ignore */ }
    emitStatus({ running: true, progress });
  };
}

function addCounts(summary: SyncSummary, r: SourceSyncResult): void {
  summary.fetched += r.fetched;
  summary.added += r.added;
  summary.updated += r.updated;
  summary.removed = (summary.removed ?? 0) + r.removed;
  if (r.storeFull) summary.storeFull = true;
}

/** Record a stopped run: count what was already stored and report every unfinished source. */
function recordStop(run: SyncRun, syncing: LiveActivitySource[], reason: string): void {
  const { summary } = run;
  summary.cancelled = true;
  // Activities the interrupted source already stored stay stored — count them.
  if (run.current) addCounts(summary, run.current.result);
  run.current = null;
  const timedOut = reason === SYNC_TIMED_OUT_MESSAGE;
  for (const source of syncing) {
    if (run.settled.has(source)) continue;
    run.settled.add(source);
    summary.errors.push({ source, message: reason });
    // A timeout is a source problem worth showing (and backing off from); a user cancel isn't.
    if (timedOut) saveSourceSyncState(source, { lastError: reason, lastErrorAt: new Date().toISOString() });
  }
}

/**
 * Finish a run exactly once (normal end, cancel or watchdog): publish the
 * summary and start follow-up work.
 */
function finishRun(run: SyncRun): SyncSummary {
  const { summary } = run;
  if (run.finished) return summary;
  run.finished = true;
  summary.finishedAt = new Date().toISOString();
  lastSummary = summary;
  const changed = summary.added > 0 || summary.updated > 0 || (summary.removed ?? 0) > 0;
  if (changed) {
    for (const l of updateListeners) {
      try { l(summary); } catch { /* ignore */ }
    }
  }
  if (changed || summary.full) {
    // Effort recognitions depend on the whole run history (debounced, fire-and-forget).
    try { scheduleEffortRebuild(); } catch { /* non-critical */ }
  }
  if (summary.added > 0) {
    // Browsers grant persistent storage more readily once the site holds real data (web only, asked once).
    void requestPersistentStorageOnce().catch(() => false);
  }
  emitStatus({ running: false, summary });
  return summary;
}

async function runSync(run: SyncRun, full: boolean, plan: SyncPlan): Promise<SyncSummary> {
  const { summary } = run;
  if (run.signal.aborted) return summary; // stopped before it started; stop() finished the run
  emitStatus({ running: true });

  for (const { source, reason } of plan.skipped) {
    run.settled.add(source);
    summary.errors.push({ source, message: reason });
  }

  // Saved data failed to load (P2): a sync would merge into an empty in-memory
  // store and could overwrite the saved history, so wait until storage recovers.
  if (plan.sync.length > 0 && isStorageDegraded()) {
    for (const source of plan.sync) {
      run.settled.add(source);
      summary.errors.push({ source, message: SYNC_STORAGE_DEGRADED_MESSAGE });
    }
    return finishRun(run);
  }

  for (const source of plan.sync) {
    const state = getSourceSyncState(source);
    const doFull = full || !state.lastFullSyncAt;
    const result: SourceSyncResult = {
      fetched: 0, added: 0, updated: 0, removed: 0, newestStart: null, storeFull: false,
    };
    const report = progressReporter(run, source);
    run.current = { source, result };
    try {
      if (source === 'intervals') await syncFromIntervals(run, result, doFull, state, report);
      else await syncFromStrava(run, result, doFull, state, report);
      if (run.signal.aborted) return summary; // stop() recorded this source
      run.current = null;
      run.settled.add(source);
      addCounts(summary, result);
      summary.full = summary.full || doFull;
      const now = new Date().toISOString();
      saveSourceSyncState(source, {
        lastSyncAt: now,
        lastFullSyncAt: doFull ? now : state.lastFullSyncAt,
        newestActivityAt: maxIso(state.newestActivityAt, result.newestStart),
        lastError: null,
        lastErrorAt: null,
        totalFetched: state.totalFetched + result.fetched,
      });
      // The credentials work (e.g. a forced retry after re-authorizing elsewhere).
      clearNeedsReconnect(source);
    } catch (err) {
      if (run.signal.aborted) return summary;
      run.current = null;
      run.settled.add(source);
      // Batches stored before the failure stay stored — count them.
      addCounts(summary, result);
      // Rejected credentials are flagged by intervals.ts / strava.ts, which know
      // whether the stored credentials were the ones rejected.
      const message = err instanceof Error ? err.message : String(err);
      summary.errors.push({ source, message });
      saveSourceSyncState(source, { lastError: message, lastErrorAt: new Date().toISOString() });
    }
  }

  if (plan.sync.includes('intervals') && !summary.errors.some((e) => e.source === 'intervals')) {
    try {
      const patched = await enrichIntervalsRoutes(progressReporter(run, 'intervals'), run.signal);
      if (!run.signal.aborted) summary.updated += patched;
    } catch {
      // Route maps are a nice-to-have; they'll be retried next sync.
    }
  }

  if (run.signal.aborted) return summary;
  return finishRun(run);
}

/**
 * Store one batch and add it to the source's tally. Throws IntervalsAbortError
 * when the run was stopped meanwhile, so nothing is written after a cancel.
 * Returns the store result (null for an empty batch).
 */
function ingestInto(run: SyncRun, result: SourceSyncResult, activities: Activity[]): StoreActivitiesResult | null {
  if (run.signal.aborted) throw new intervalsApi.IntervalsAbortError();
  if (activities.length === 0) return null;
  const r = storeActivities(activities);
  result.fetched += activities.length;
  result.added += r.added;
  result.updated += r.updated;
  if (r.dropped > 0) result.storeFull = true;
  for (const a of activities) result.newestStart = maxIso(result.newestStart, a.start_date);
  return r;
}

/** The store is at its cap: importing further back in time would only trim what was just stored. */
function isStoreAtCap(stored: StoreActivitiesResult | null): boolean {
  return (stored?.dropped ?? 0) > 0 || getAllStoredActivities().length >= MAX_STORED_ACTIVITIES;
}

/** Where an incremental sync starts counting back from: the newest activity seen (never in the future), else now. */
function incrementalAnchor(state: SourceSyncState): Date {
  const newest = state.newestActivityAt ? Date.parse(state.newestActivityAt) : NaN;
  return new Date(Number.isFinite(newest) ? Math.min(newest, Date.now()) : Date.now());
}

async function syncFromIntervals(
  run: SyncRun,
  result: SourceSyncResult,
  full: boolean,
  state: SourceSyncState,
  report: ProgressReporter,
): Promise<void> {
  // `newest` is a local date; use tomorrow so today's activities are always included.
  const tomorrow = addDays(new Date(), 1);

  if (full) {
    let windowEnd = tomorrow;
    let emptyStreak = 0;
    for (let year = 0; year < MAX_HISTORY_YEARS; year++) {
      const windowStart = addDays(windowEnd, -365);
      report(`Importing ${windowStart.getFullYear()}–${windowEnd.getFullYear()} history…`, result.fetched);
      const list = await intervalsApi.listIntervalsActivitiesDetailed({
        oldest: toLocalDate(windowStart),
        newest: toLocalDate(windowEnd),
        signal: run.signal,
      });
      const stored = ingestInto(run, result, list.activities);
      if (isStoreAtCap(stored)) {
        result.storeFull = true;
        break;
      }
      // "Empty" means the API returned no rows at all: a year of rows Apollo
      // can't use (e.g. Strava-origin entries) still means older history exists.
      emptyStreak = list.rawCount === 0 ? emptyStreak + 1 : 0;
      if (emptyStreak >= EMPTY_YEARS_BEFORE_STOP) break;
      // Windows share their boundary date; duplicates are merged by ID.
      windowEnd = windowStart;
    }
    return;
  }

  const oldest = toLocalDate(addDays(incrementalAnchor(state), -INCREMENTAL_OVERLAP_DAYS));
  const newest = toLocalDate(tomorrow);
  report('Checking intervals.icu for new activities…', 0);
  const list = await intervalsApi.listIntervalsActivitiesDetailed({ oldest, newest, signal: run.signal });
  ingestInto(run, result, list.activities);
  result.removed += reconcileIntervalsDeletions(oldest, newest, list);
}

/**
 * Remove activities that were deleted on intervals.icu: stored records dated
 * strictly inside the window just listed whose IDs the list no longer
 * contains. Conservative on purpose — an incomplete reply must never wipe
 * history:
 *   - needs a well-formed, non-empty list;
 *   - leaves the window's edge days alone (date-boundary differences);
 *   - only touches records whose identity is the intervals.icu ID, never
 *     legacy Strava records that intervals.icu data was merged into;
 *   - removes at most max(RECONCILE_ALWAYS_ALLOWED, RECONCILE_MAX_SHARE × the
 *     window's records) per sync, otherwise nothing.
 * Survivors keep their local flags. No tombstone is written, so an activity
 * that reappears remotely is imported again. Returns how many were removed.
 */
function reconcileIntervalsDeletions(
  oldest: string,
  newest: string,
  list: intervalsApi.IntervalsActivityList,
): number {
  if (!list.rawIds || list.rawCount === 0) return 0;
  const remote = new Set(list.rawIds);
  const all = getAllStoredActivities();
  const gone = new Set<number>();
  let inWindow = 0;
  for (const a of all) {
    if (a.source !== 'intervals' || !a.source_id || a.id !== intervalsApi.toStoreId(a.source_id)) continue;
    const day = dateKeyFromLocalIso(a.start_date_local);
    if (!day || day <= oldest || day >= newest) continue;
    inWindow++;
    if (!remote.has(a.source_id)) gone.add(a.id);
  }
  if (gone.size === 0) return 0;
  const limit = Math.max(RECONCILE_ALWAYS_ALLOWED, Math.floor(inWindow * RECONCILE_MAX_SHARE));
  if (gone.size > limit) {
    console.warn(
      `[Apollo] intervals.icu no longer lists ${gone.size} of ${inWindow} recent activities; `
      + 'keeping them because the reply looks incomplete.',
    );
    return 0;
  }
  writeActivityStore(all.filter((a) => !gone.has(a.id)));
  return gone.size;
}

async function syncFromStrava(
  run: SyncRun,
  result: SourceSyncResult,
  full: boolean,
  state: SourceSyncState,
  report: ProgressReporter,
): Promise<void> {
  const tag = (a: Activity): Activity => ({ ...a, source: 'strava', source_id: String(a.id) });

  const after = full
    ? undefined
    : Math.floor((incrementalAnchor(state).getTime() - INCREMENTAL_OVERLAP_DAYS * DAY_MS) / 1000);
  const maxPages = full ? 50 : 5;
  for (let page = 1; page <= maxPages; page++) {
    report(full ? `Importing Strava history (page ${page})…` : 'Checking Strava for new activities…', result.fetched);
    const batch = await stravaApi.getActivities({ page, per_page: STRAVA_PAGE_SIZE, after }, { signal: run.signal });
    const stored = ingestInto(run, result, batch.map(tag));
    if (batch.length < STRAVA_PAGE_SIZE) break;
    // Full imports page newest → oldest, so stop once the store is full.
    // (Incremental pages with `after` run oldest → newest and must continue.)
    if (full && isStoreAtCap(stored)) {
      result.storeFull = true;
      break;
    }
  }
}

/**
 * intervals.icu activity lists don't include GPS. Fetch route maps for recent
 * outdoor runs (newest first, a bounded number per sync) so route maps and
 * effort recognition work. Runs without GPS are marked with an empty polyline
 * so they aren't re-requested. Stops (without writing) when `signal` aborts.
 */
async function enrichIntervalsRoutes(report: ProgressReporter, signal: AbortSignal): Promise<number> {
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
    if (signal.aborted) return 0;
    report(`Fetching route maps (${patched.length + 1}/${candidates.length})…`, patched.length);
    try {
      const route = await intervalsApi.getIntervalsRoute(a.source_id!, undefined, { signal });
      patched.push({
        ...a,
        map: { id: `icu-${a.source_id}`, summary_polyline: route.summaryPolyline },
        start_latlng: route.start ?? a.start_latlng ?? null,
        end_latlng: route.end ?? a.end_latlng ?? null,
      });
    } catch (err) {
      if (signal.aborted) return 0;
      if (err instanceof intervalsApi.IntervalsAuthError) throw err;
      // Transient failure — try again next sync.
    }
  }
  if (signal.aborted || patched.length === 0) return 0;
  storeActivities(patched);
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
  // Includes hidden records, so a hidden activity can still be opened and unhidden.
  const base = typeof activityOrId === 'number'
    ? getAllStoredActivities().find((a) => a.id === activityOrId)
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
  clearNeedsReconnect('intervals');
  athleteCache = null;
  return athlete;
}

/** Disconnect a source. Already-synced history stays on this device. */
export function disconnectSource(source: LiveActivitySource): void {
  if (source === 'intervals') clearIntervalsCredentials();
  else clearStravaTokens();
  resetSourceSyncState(source);
  clearNeedsReconnect(source);
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
