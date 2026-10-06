/**
 * Wellness & recovery, free via intervals.icu.
 *
 * Garmin, COROS, Oura, Whoop, Polar, Suunto and others push daily wellness
 * data (resting HR, overnight HRV as rMSSD, sleep, readiness) into
 * intervals.icu, and Apollo reads it with the athlete's personal API key
 * (see intervals.ts).
 *
 * This module:
 * - keeps ~400 days of normalized daily records on this device (`apollo_wellness`);
 * - syncs incrementally, re-reading the last week every time because sleep and
 *   HRV for recent days arrive or get edited late;
 * - caches the Run sport settings, to spot a missing threshold pace (Garmin
 *   shows "No Target" for pushed workouts without one) and to fill in the HR
 *   profile (resting HR, max HR, LTHR) unless the athlete entered it manually;
 * - turns the data into a conservative daily recovery signal
 *   (computeRecoverySnapshot).
 */

import { persistence } from './db/persistence';
import { getIntervalsCredentials, type IntervalsCredentials } from './storage';
import { getAppPreferences } from './appPreferences';
import { getHRProfile, setHRProfile } from './heartRate';
import {
  fetchIntervalsSportSettings,
  fetchIntervalsWellness,
  type IcuSportSettings,
  type IcuWellness,
} from './intervals';

const WELLNESS_KEY = 'apollo_wellness';
const STATE_KEY = 'apollo_wellness_state';

/** Days of records kept on this device. */
const KEEP_DAYS = 400;
/** Days fetched by the first (or a full) sync. */
const FULL_SYNC_DAYS = 365;
/** Incremental syncs re-read this many days before the newest stored record. */
const INCREMENTAL_OVERLAP_DAYS = 7;
/** While nothing is stored yet, look back over the full window at most this often. */
const EMPTY_STORE_FULL_SYNC_MS = 24 * 60 * 60 * 1000;
/** Sport settings are re-read at most this often once the Run threshold pace is known… */
const SPORT_SETTINGS_TTL_MS = 24 * 60 * 60 * 1000;
/** …and at most hourly while it's missing (so the warning clears soon after it's set) or the last read failed. */
const SPORT_SETTINGS_RECHECK_MS = 60 * 60 * 1000;
/** HR profile resting HR = median of the last N days… */
const HR_PROFILE_DAYS = 14;
/** …with at least this many readings. */
const HR_PROFILE_MIN_READINGS = 3;

const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CANCELLED = 'Wellness sync was cancelled.';

// ── Types ─────────────────────────────────────────────────────────────────────

/** One day of wellness data, normalized to the fields Apollo uses. */
export interface WellnessRecord {
  /** Local date (YYYY-MM-DD). Sleep belongs to the night that ended that morning. */
  date: string;
  /** Resting heart rate (bpm). */
  restingHR?: number;
  /** Overnight HRV as rMSSD (ms). */
  hrv?: number;
  hrvSDNN?: number;
  sleepSecs?: number;
  /** Device sleep score (0–100). */
  sleepScore?: number;
  /** intervals.icu scale: 1 = excellent, 2 = good, 3 = average, 4 = poor. */
  sleepQuality?: number;
  avgSleepingHR?: number;
  /** Device readiness / recovery score (the scale depends on the device). */
  readiness?: number;
  /** kg */
  weight?: number;
  vo2max?: number;
  steps?: number;
  /** Self-reported in intervals.icu: 1 = low … 4 = extreme (0 = none). */
  soreness?: number;
  fatigue?: number;
  stress?: number;
  /** Self-reported in intervals.icu: 1 = excellent … 4 = poor. */
  mood?: number;
  /** When intervals.icu last changed the record (ISO). */
  updated?: string;
}

type NumericField = Exclude<keyof WellnessRecord, 'date' | 'updated'>;

export interface WellnessSyncState {
  /** Last successful sync (ISO). */
  lastSyncAt: string | null;
  /** Last sync that read the full 365-day window (ISO). */
  lastFullSyncAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  /** Days of wellness data stored on this device. */
  days: number;
  /** Newest stored date (YYYY-MM-DD), or null. */
  latestDate: string | null;
}

export interface WellnessSyncResult {
  /** Days with wellness data received from intervals.icu. */
  fetched: number;
  /** Why the sync failed (syncWellness never throws). */
  error?: string;
  /** Set when the sync didn't run. */
  skipped?: 'not_connected' | 'disabled';
}

export interface ThresholdPaceStatus {
  /** A Run threshold pace is set in intervals.icu. */
  known: boolean;
  /** Sport settings were read and the Run threshold pace is absent or 0. */
  missing: boolean;
  /** Threshold pace in seconds per km, when known. */
  secPerKm?: number;
}

/** Run sport settings cached from intervals.icu. */
interface RunSettings {
  /** When they were read (ISO). */
  fetchedAt: string;
  /** Connection they were read with (see connectionKey). */
  connection: string;
  /** intervals.icu has sport settings covering "Run". */
  hasRun: boolean;
  /** m/s, only when set (> 0). */
  thresholdPace?: number;
  lthr?: number;
  maxHR?: number;
  paceUnits?: string;
}

interface StoredState {
  lastSyncAt: string | null;
  lastFullSyncAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  /** Connection the stored data came from (detects reconnects and athlete switches). */
  athleteId?: string | null;
  connectedAt?: string | null;
  /** Last attempt to read the sport settings (ISO), successful or not… */
  sportSettingsCheckedAt?: string | null;
  /** …and the connection it was made with. */
  sportSettingsConnection?: string | null;
  run?: RunSettings | null;
  /**
   * Max HR / LTHR last copied from the sport settings into the HR profile. They
   * are copied again only when intervals.icu's values change, so activity-based
   * max-HR updates (heartRate.buildHRDataFromActivity) aren't undone every sync.
   */
  appliedMaxHR?: number | null;
  appliedLthr?: number | null;
}

type WellnessStore = Record<string, WellnessRecord>;

// ── Small helpers ─────────────────────────────────────────────────────────────

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** Local calendar date as YYYY-MM-DD. */
function localDateKey(d: Date = new Date()): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** Shift a YYYY-MM-DD key by whole days (calendar arithmetic, immune to DST). */
function addDays(key: string, days: number): string {
  const [y, m, d] = key.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d) + days * DAY_MS);
  return `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}`;
}

/** Finite number within [min, max], else undefined. */
function within(v: unknown, min: number, max: number): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : undefined;
}

/** Like `within`, rounded to a whole number. */
function intWithin(v: unknown, min: number, max: number): number | undefined {
  const n = within(v, min, max);
  return n === undefined ? undefined : Math.round(n);
}

function mean(values: number[]): number {
  return values.reduce((s, v) => s + v, 0) / values.length;
}

/** Sample standard deviation (0 for fewer than 2 values). */
function stdev(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  return Math.sqrt(values.reduce((s, v) => s + (v - m) ** 2, 0) / (values.length - 1));
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** "7h 32m" (or "45m"). */
function formatDuration(secs: number): string {
  const totalMin = Math.round(secs / 60);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}h ${pad2(m)}m` : `${m}m`;
}

/** ["a", "b", "c"] → "a, b and c". */
function joinAnd(parts: string[]): string {
  return parts.length <= 1 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function errorMessage(err: unknown): string {
  return err instanceof Error && err.message ? err.message : String(err);
}

function msSince(iso: string | null | undefined, now: number): number {
  const t = iso ? Date.parse(iso) : NaN;
  // Unknown or in the future (clock changed): treat as long ago.
  return Number.isFinite(t) && t <= now ? now - t : Infinity;
}

class WellnessAbortError extends Error {
  constructor() {
    super(CANCELLED);
    this.name = 'AbortError';
  }
}

/** Settle with `promise`, or reject as soon as `signal` aborts (the request itself finishes in the background). */
function raceAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    promise.catch(() => { /* result no longer wanted */ });
    return Promise.reject(new WellnessAbortError());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new WellnessAbortError());
    signal.addEventListener('abort', onAbort);
    promise.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value); },
      (err: unknown) => { signal.removeEventListener('abort', onAbort); reject(err); },
    );
  });
}

// ── Normalization ─────────────────────────────────────────────────────────────

/**
 * Convert an intervals.icu wellness record to Apollo's model. Drops 0/null
 * placeholders, implausible values and values intervals.icu copied from the
 * athlete's settings (tempRestingHR / tempWeight) instead of measuring.
 * Returns null when nothing usable is left.
 */
export function normalizeWellness(raw: IcuWellness | null | undefined): WellnessRecord | null {
  if (!raw || typeof raw.id !== 'string') return null;
  const date = raw.id.slice(0, 10);
  if (!DATE_RE.test(date)) return null;

  const values: Record<NumericField, number | undefined> = {
    restingHR: raw.tempRestingHR ? undefined : intWithin(raw.restingHR, 25, 120),
    hrv: within(raw.hrv, 1, 400),
    hrvSDNN: within(raw.hrvSDNN, 1, 500),
    sleepSecs: intWithin(raw.sleepSecs, 1, 24 * 3600),
    sleepScore: within(raw.sleepScore, 1, 100),
    sleepQuality: intWithin(raw.sleepQuality, 1, 4),
    avgSleepingHR: within(raw.avgSleepingHR, 25, 150),
    readiness: within(raw.readiness, 0.5, 1000),
    weight: raw.tempWeight ? undefined : within(raw.weight, 20, 400),
    vo2max: within(raw.vo2max, 10, 100),
    steps: intWithin(raw.steps, 1, 200_000),
    soreness: intWithin(raw.soreness, 0, 4),
    fatigue: intWithin(raw.fatigue, 0, 4),
    stress: intWithin(raw.stress, 0, 4),
    mood: intWithin(raw.mood, 1, 4),
  };

  const rec: WellnessRecord = { date };
  let hasData = false;
  for (const key of Object.keys(values) as NumericField[]) {
    const v = values[key];
    if (v !== undefined) {
      rec[key] = v;
      hasData = true;
    }
  }
  if (!hasData) return null;
  if (typeof raw.updated === 'string' && raw.updated) rec.updated = raw.updated;
  return rec;
}

// ── Local store ───────────────────────────────────────────────────────────────

let memoRaw: string | null = null;
let memoStore: WellnessStore = {};

/** Parsed store (memoized on the stored string). Treat as read-only. */
function readStore(): WellnessStore {
  const raw = persistence.getItem(WELLNESS_KEY);
  if (raw === memoRaw) return memoStore;
  let parsed: WellnessStore = {};
  if (raw) {
    try {
      const obj: unknown = JSON.parse(raw);
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) parsed = obj as WellnessStore;
    } catch { /* unreadable → start over */ }
  }
  memoRaw = raw;
  memoStore = parsed;
  return parsed;
}

function writeStore(store: WellnessStore): void {
  const raw = JSON.stringify(store);
  persistence.setItem(WELLNESS_KEY, raw);
  memoRaw = raw;
  memoStore = store;
}

function storedDates(store: WellnessStore): string[] {
  return Object.keys(store).filter((k) => DATE_RE.test(k) && !!store[k] && typeof store[k] === 'object').sort();
}

function trimStore(store: WellnessStore, today: string): void {
  const cutoff = addDays(today, -KEEP_DAYS);
  for (const key of Object.keys(store)) {
    if (!DATE_RE.test(key) || key < cutoff) delete store[key];
  }
}

const EMPTY_STATE: StoredState = { lastSyncAt: null, lastFullSyncAt: null, lastError: null, lastErrorAt: null };

function readState(): StoredState {
  try {
    const raw = persistence.getItem(STATE_KEY);
    return raw ? { ...EMPTY_STATE, ...(JSON.parse(raw) as Partial<StoredState>) } : { ...EMPTY_STATE };
  } catch {
    return { ...EMPTY_STATE };
  }
}

function saveState(patch: Partial<StoredState>): StoredState {
  const next = { ...readState(), ...patch };
  persistence.setItem(STATE_KEY, JSON.stringify(next));
  return next;
}

// ── Getters ───────────────────────────────────────────────────────────────────

/** Wellness for one local date (YYYY-MM-DD), or null. */
export function getWellnessForDate(date: string): WellnessRecord | null {
  const rec = readStore()[date];
  return rec && typeof rec === 'object' ? { ...rec } : null;
}

/** Wellness records between two local dates (inclusive), oldest first. */
export function getWellnessRange(from: string, to: string): WellnessRecord[] {
  const store = readStore();
  return storedDates(store)
    .filter((d) => d >= from && d <= to)
    .map((d) => ({ ...store[d] }));
}

/** Sync bookkeeping plus how much data is stored. */
export function getWellnessSyncState(): WellnessSyncState {
  const state = readState();
  const dates = storedDates(readStore());
  return {
    lastSyncAt: state.lastSyncAt,
    lastFullSyncAt: state.lastFullSyncAt,
    lastError: state.lastError,
    lastErrorAt: state.lastErrorAt,
    days: dates.length,
    latestDate: dates.length ? dates[dates.length - 1] : null,
  };
}

/**
 * Hours slept the night before `date` (one decimal), from the watch via
 * intervals.icu, to prefill the training journal. Null when unknown.
 */
export function getSuggestedSleepHours(date: string): number | null {
  const secs = getWellnessForDate(date)?.sleepSecs;
  return secs ? Math.round(secs / 360) / 10 : null;
}

const listeners = new Set<(result: WellnessSyncResult) => void>();

/**
 * Subscribe to wellness updates: fired after every sync attempt that reached
 * intervals.icu (new data stored, or the error recorded) and after the sport
 * settings are re-read. Returns an unsubscribe function.
 */
export function onWellnessUpdated(listener: (result: WellnessSyncResult) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function emit(result: WellnessSyncResult): void {
  for (const listener of listeners) {
    try { listener(result); } catch { /* listener errors must not break sync */ }
  }
}

// ── Sport settings (threshold pace, max HR, LTHR) ─────────────────────────────

/** Identifies an intervals.icu connection: cached sport settings only count for the one they were read with. */
function connectionKey(creds: IntervalsCredentials): string {
  return `${creds.athleteId || '0'}|${creds.connectedAt ?? ''}`;
}

function pickRunSettings(list: IcuSportSettings[]): IcuSportSettings | null {
  return list.find((s) => Array.isArray(s.types) && s.types.includes('Run')) ?? null;
}

/**
 * Sport settings are read right away for a new connection, then re-read daily
 * once a Run threshold pace is known, and hourly while it's missing (so the
 * warning clears soon after it's set) or the last read failed.
 */
function sportSettingsDue(state: StoredState, creds: IntervalsCredentials, now: number): boolean {
  const connection = connectionKey(creds);
  if (state.sportSettingsConnection !== connection) return true;
  const run = state.run;
  const settled = !!run && run.connection === connection && run.fetchedAt === state.sportSettingsCheckedAt
    && !!run.thresholdPace;
  return msSince(state.sportSettingsCheckedAt, now) >= (settled ? SPORT_SETTINGS_TTL_MS : SPORT_SETTINGS_RECHECK_MS);
}

/** Outcome of reading the sport settings (never thrown: see refreshRunSportSettings). */
export interface SportSettingsResult {
  ok: boolean;
  error?: string;
}

let sportSettingsInFlight: Promise<SportSettingsResult> | null = null;

/** Read the sport settings and cache the Run entry (one request at a time). Never rejects. */
function readSportSettings(creds: IntervalsCredentials): Promise<SportSettingsResult> {
  if (sportSettingsInFlight) return sportSettingsInFlight;
  const read = async (): Promise<SportSettingsResult> => {
    const attemptAt = new Date().toISOString();
    const connection = connectionKey(creds);
    try {
      const run = pickRunSettings(await fetchIntervalsSportSettings(creds));
      const cache: RunSettings = { fetchedAt: attemptAt, connection, hasRun: !!run };
      const pace = within(run?.threshold_pace, Number.MIN_VALUE, Number.MAX_VALUE);
      if (pace !== undefined) cache.thresholdPace = pace;
      const lthr = intWithin(run?.lthr, 1, 300);
      if (lthr !== undefined) cache.lthr = lthr;
      const maxHR = intWithin(run?.max_hr, 1, 300);
      if (maxHR !== undefined) cache.maxHR = maxHR;
      if (typeof run?.pace_units === 'string' && run.pace_units) cache.paceUnits = run.pace_units;
      saveState({ sportSettingsCheckedAt: attemptAt, sportSettingsConnection: connection, run: cache });
      return { ok: true };
    } catch (err) {
      saveState({ sportSettingsCheckedAt: attemptAt, sportSettingsConnection: connection });
      return { ok: false, error: errorMessage(err) };
    }
  };
  sportSettingsInFlight = read().finally(() => {
    sportSettingsInFlight = null;
  });
  return sportSettingsInFlight;
}

/**
 * Whether a Run threshold pace is set in intervals.icu. Without one,
 * intervals.icu sends Apollo's structured workouts to Garmin without pace
 * targets ("No Target" on the watch). `missing` is true only after the sport
 * settings were read successfully (for the current connection) and the Run
 * threshold pace was absent or 0.
 */
export function getRunThresholdPaceStatus(): ThresholdPaceStatus {
  const creds = getIntervalsCredentials();
  if (!creds) return { known: false, missing: false };
  const run = readState().run;
  // Not read yet for this connection.
  if (!run || run.connection !== connectionKey(creds)) return { known: false, missing: false };
  const pace = run.thresholdPace;
  if (!pace || !(pace > 0)) return { known: false, missing: true };
  const status: ThresholdPaceStatus = { known: true, missing: false };
  // intervals.icu stores threshold pace in m/s.
  const secPerKm = 1000 / pace;
  if (secPerKm >= 90 && secPerKm <= 1800) status.secPerKm = round1(secPerKm);
  return status;
}

/**
 * Re-read the sport settings now (e.g. after the athlete set a threshold pace
 * in intervals.icu), then update the HR profile while wellness sync is on.
 * Never throws.
 */
export async function refreshRunSportSettings(): Promise<SportSettingsResult> {
  const creds = getIntervalsCredentials();
  if (!creds) return { ok: false, error: 'intervals.icu is not connected.' };
  const result = await readSportSettings(creds);
  if (result.ok) {
    if (getAppPreferences().syncWellness) {
      try { applyHRProfileFromWellness(); } catch { /* non-critical */ }
    }
    emit({ fetched: 0 });
  }
  return result;
}

/**
 * Re-read the Run sport settings if they're due (new connection; otherwise
 * daily, or hourly while the threshold pace is missing) and return the
 * threshold pace status. For screens that warn about "No Target" workouts,
 * which matters even with wellness sync turned off. Never throws.
 */
export async function checkRunThresholdPace(): Promise<ThresholdPaceStatus> {
  try {
    const creds = getIntervalsCredentials();
    if (creds && sportSettingsDue(readState(), creds, Date.now())) await refreshRunSportSettings();
    return getRunThresholdPaceStatus();
  } catch {
    return { known: false, missing: false };
  }
}

// ── HR profile ────────────────────────────────────────────────────────────────

/**
 * Fill the HR profile from intervals.icu: resting HR = median of the last 14
 * days of wellness (≥ 3 readings); max HR (120–230 bpm) and LTHR from the Run
 * sport settings. A profile the athlete entered manually is never changed.
 */
function applyHRProfileFromWellness(today: string = localDateKey()): void {
  const profile = getHRProfile();
  if (profile.source === 'manual') return;
  const state = readState();
  const next = { ...profile };
  let changed = false;

  const from = addDays(today, -(HR_PROFILE_DAYS - 1));
  const store = readStore();
  const resting: number[] = [];
  for (const date of storedDates(store)) {
    const v = store[date].restingHR;
    if (date >= from && date <= today && typeof v === 'number') resting.push(v);
  }
  if (resting.length >= HR_PROFILE_MIN_READINGS) {
    const value = Math.round(median(resting));
    if (value !== next.restingHR) {
      next.restingHR = value;
      changed = true;
    }
  }

  const patch: Partial<StoredState> = {};
  const maxHR = state.run?.maxHR;
  if (maxHR !== undefined && maxHR >= 120 && maxHR <= 230
    && (maxHR !== state.appliedMaxHR || profile.source === 'default')) {
    if (next.maxHR !== maxHR) {
      next.maxHR = maxHR;
      changed = true;
    }
    patch.appliedMaxHR = maxHR;
  }
  const lthr = state.run?.lthr;
  if (lthr !== undefined && lthr >= 100 && lthr < next.maxHR && lthr !== state.appliedLthr) {
    if (next.lthr !== lthr) {
      next.lthr = lthr;
      changed = true;
    }
    patch.appliedLthr = lthr;
  }

  if (changed) setHRProfile({ ...next, source: 'intervals', updatedAt: new Date().toISOString() });
  if (Object.keys(patch).length > 0) saveState(patch);
}

// ── Sync ──────────────────────────────────────────────────────────────────────

let inFlight: Promise<WellnessSyncResult> | null = null;
let inFlightFull = false;

/**
 * Pull wellness (sleep, HRV, resting HR, readiness…) from intervals.icu into
 * the local store. The first sync (or `full`) reads the last 365 days; later
 * ones re-read from a week before the newest stored day, because recent sleep
 * and HRV arrive or get edited late. Also refreshes the cached Run sport
 * settings (daily, or hourly while the threshold pace is missing) and the HR
 * profile. Skipped while intervals.icu isn't connected or wellness sync is
 * turned off. Never throws.
 */
export function syncWellness(opts: { full?: boolean; signal?: AbortSignal } = {}): Promise<WellnessSyncResult> {
  if (inFlight) {
    if (!opts.full || inFlightFull) return inFlight;
    return inFlight.then(() => syncWellness(opts));
  }
  inFlightFull = !!opts.full;
  inFlight = runWellnessSync(!!opts.full, opts.signal)
    .catch((err: unknown): WellnessSyncResult => ({ fetched: 0, error: errorMessage(err) }))
    .finally(() => {
      inFlight = null;
      inFlightFull = false;
    });
  return inFlight;
}

async function runWellnessSync(full: boolean, signal?: AbortSignal): Promise<WellnessSyncResult> {
  const creds = getIntervalsCredentials();
  if (!creds) return { fetched: 0, skipped: 'not_connected' };
  if (!getAppPreferences().syncWellness) return { fetched: 0, skipped: 'disabled' };
  if (signal?.aborted) return { fetched: 0, error: CANCELLED };

  let state = readState();
  const athleteId = creds.athleteId || '0';
  const connectedAt = creds.connectedAt ?? null;
  const switchedAthlete = !!state.athleteId && state.athleteId !== athleteId;
  const reconnected = switchedAthlete || (state.connectedAt ?? null) !== connectedAt;
  if (switchedAthlete) {
    // Different intervals.icu athlete: their data replaces the previous one's.
    writeStore({});
    state = saveState({
      ...EMPTY_STATE, athleteId, connectedAt,
      sportSettingsCheckedAt: null, sportSettingsConnection: null, run: null, appliedMaxHR: null, appliedLthr: null,
    });
  }

  const now = Date.now();
  const today = localDateKey(new Date(now));
  const dates = storedDates(readStore());
  const latest = dates.length ? dates[dates.length - 1] : null;
  const doFull = full || reconnected || !state.lastFullSyncAt
    || (!latest && msSince(state.lastFullSyncAt, now) >= EMPTY_STORE_FULL_SYNC_MS);
  const newest = today;
  const oldest = doFull
    ? addDays(today, -(FULL_SYNC_DAYS - 1))
    : addDays(latest && latest < today ? latest : today, -INCREMENTAL_OVERLAP_DAYS);

  let rows: IcuWellness[];
  try {
    rows = await raceAbort(fetchIntervalsWellness({ oldest, newest }, creds), signal);
  } catch (err) {
    if (err instanceof WellnessAbortError) return { fetched: 0, error: CANCELLED };
    const message = errorMessage(err);
    saveState({ lastError: message, lastErrorAt: new Date().toISOString() });
    const failed: WellnessSyncResult = { fetched: 0, error: message };
    emit(failed);
    return failed;
  }
  if (signal?.aborted) return { fetched: 0, error: CANCELLED };

  // The response is the full truth for the window: replace it, so values
  // removed or corrected in intervals.icu are removed or corrected here too.
  const store: WellnessStore = { ...readStore() };
  for (const key of Object.keys(store)) {
    if (key >= oldest && key <= newest) delete store[key];
  }
  let fetched = 0;
  for (const row of rows) {
    const rec = normalizeWellness(row);
    if (!rec) continue;
    store[rec.date] = rec;
    fetched++;
  }
  trimStore(store, today);
  writeStore(store);

  const syncedAt = new Date().toISOString();
  state = saveState({
    lastSyncAt: syncedAt,
    lastFullSyncAt: doFull ? syncedAt : state.lastFullSyncAt,
    lastError: null,
    lastErrorAt: null,
    athleteId,
    connectedAt,
  });

  if (!signal?.aborted && sportSettingsDue(state, creds, Date.now())) {
    // Cancelling stops waiting; the read itself finishes and is cached in the background.
    try { await raceAbort(readSportSettings(creds), signal); } catch { /* cancelled */ }
  }
  try { applyHRProfileFromWellness(today); } catch { /* non-critical */ }

  const result: WellnessSyncResult = { fetched };
  emit(result);
  return result;
}

// ── Recovery model ────────────────────────────────────────────────────────────

export type RecoveryStatus = 'good' | 'ok' | 'caution' | 'unknown';

/** One day of the 14-day sparkline series. */
export interface RecoverySeriesPoint {
  date: string;
  /** rMSSD (ms). */
  hrv?: number;
  restingHR?: number;
  sleepHours?: number;
}

export interface RecoverySleep {
  /** Morning the night ended (YYYY-MM-DD). */
  date: string;
  secs: number;
  score?: number;
  /** Average of the 7 nights before (needs ≥ 3). */
  avg7Secs?: number;
  /** Short enough to count as a warning signal. */
  flagged: boolean;
}

export interface RecoveryRestingHR {
  date: string;
  bpm: number;
  /** Mean of the 30 days before (needs ≥ 7 readings). */
  baseline?: number;
  /** bpm − baseline, rounded. */
  delta?: number;
  /** Raised enough (≥ 5 bpm) to count as a warning signal. */
  flagged: boolean;
}

export interface RecoveryHRV {
  /** Day of the newest reading within 2 days. */
  date?: string;
  /** Newest reading (ms). */
  latest?: number;
  /** 7-day rolling average (ms; needs ≥ 3 readings). */
  avg7?: number;
  /** 60-day average (ms; needs ≥ 14 readings), with the normal range around it. */
  baseline?: number;
  low?: number;
  high?: number;
  /** Where the 7-day average sits relative to the normal range. */
  position?: 'below' | 'within' | 'above';
  /** Readings in the 60-day window. */
  baselineDays: number;
  /** 7-day average below the normal range (a warning signal). */
  flagged: boolean;
}

export interface RecoverySnapshot {
  status: RecoveryStatus;
  /** Short headline, e.g. "Take it easy today". */
  headline: string;
  /** Plain-English bullets explaining the status (most important first). */
  reasons: string[];
  /** One-line training suggestion. */
  suggestion: string;
  /** Day the snapshot describes (YYYY-MM-DD). */
  date: string;
  /** Days with sleep, HRV or resting HR in the last 60 days. */
  daysWithData: number;
  /** Last night's sleep (newest within 2 days). */
  sleep?: RecoverySleep;
  /** Newest resting HR within 2 days vs the 30 days before it. */
  restingHR?: RecoveryRestingHR;
  /** HRV 7-day average vs the 60-day normal range. */
  hrv?: RecoveryHRV;
  /** Device readiness score from the newest record within 2 days. */
  readiness?: number;
  /** Last 14 days, oldest first: one entry per day, values absent on days without data. */
  series: RecoverySeriesPoint[];
}

/** "Last night" values may be at most this many days old. */
const RECENT_DAYS = 2;
/** Days with data needed before Apollo rates recovery. */
const MIN_DAYS_FOR_STATUS = 7;
const SERIES_DAYS = 14;
/** HRV: rolling 7-day average of ln rMSSD; ≥ 3 readings a week keep it valid (Plews et al. 2014). */
const HRV_ROLLING_DAYS = 7;
const HRV_MIN_ROLLING_READINGS = 3;
/** HRV: 60-day baseline, needs ≥ 14 readings. */
const HRV_BASELINE_DAYS = 60;
const HRV_MIN_BASELINE_READINGS = 14;
/** Normal range = baseline ± 0.5 SD of daily ln rMSSD ("smallest worthwhile change"). */
const HRV_NORMAL_SD = 0.5;
/** A 7-day average more than 1 SD below the baseline is a strong signal. */
const HRV_STRONG_SD = 1;
/** Minimum SD (ln units, ≈ 5 %) so very steady readings don't make the range razor-thin. */
const HRV_MIN_SD = 0.05;
/** Resting HR vs the mean of the 30 days before, needs ≥ 7 readings. */
const RHR_BASELINE_DAYS = 30;
const RHR_MIN_BASELINE_READINGS = 7;
const RHR_FLAG_BPM = 5;
const RHR_STRONG_BPM = 10;
const SLEEP_FLOOR_HOURS = 7;
const SLEEP_SHORT_HOURS = 6;
const SLEEP_VERY_SHORT_HOURS = 5;
/** Sleep this much below the 7-night average (with < 7 h) counts as short. */
const SLEEP_BELOW_USUAL_HOURS = 1;
const SLEEP_MIN_BASELINE_NIGHTS = 3;
/** intervals.icu self-reported fatigue / soreness / stress: 3 = high, 4 = extreme. */
const SUBJECTIVE_HIGH = 3;

interface Signal {
  /** Strong enough to suggest an easy day on its own. */
  strong: boolean;
  /** Listing order among equally strong signals: HRV 0, resting HR 1, sleep 2, self-reported 3. */
  rank: number;
  /** Fragment for the suggestion, e.g. "resting HR is up 6 bpm". */
  phrase: string;
  reason: string;
}

function hasRecoveryData(r: WellnessRecord): boolean {
  return r.hrv !== undefined || r.restingHR !== undefined || r.sleepSecs !== undefined;
}

/**
 * Turn daily wellness records into a recovery status for `today`. Pure, so it
 * can be tested and reused; getRecoverySnapshot() feeds it the stored data.
 *
 * Conservative by design — one noisy reading never triggers a warning, and
 * each metric is only rated with a reading from the last 2 days:
 * - HRV: the 7-day rolling average of ln rMSSD is compared with a normal range
 *   of the 60-day mean ± 0.5 SD, the rolling-average approach of Plews et al.
 *   2013 (IJSPP 8:688; Sports Med 43:773) used for HRV-guided training
 *   (Vesterinen et al. 2016, MSSE 48:1347) and by HRV4Training. Below the
 *   range is a signal; more than 1 SD below is a strong one. Single-day
 *   readings are reported, not acted on.
 * - Resting HR: the newest reading vs the mean of the 30 days before it;
 *   ≥ 5 bpm above is a signal, ≥ 10 bpm a strong one. Resting HR is a slow,
 *   coarse marker (Buchheit 2014, Front Physiol 5:73), hence the wide margin.
 * - Sleep: last night vs a 7 h floor and the 7-night average; < 6 h, or < 7 h
 *   and ≥ 1 h under the average, is a signal; < 5 h a strong one.
 * - Self-reported high fatigue, soreness or stress in intervals.icu is a
 *   signal: subjective ratings track training load well (Saw et al. 2016,
 *   BJSM 50:281).
 *
 * 'caution' needs two signals or one strong one; 'unknown' when there's
 * under a week of data or nothing from the last 2 days. 'good' needs an HRV or
 * resting-HR baseline to back it.
 */
export function computeRecoverySnapshot(records: readonly WellnessRecord[], today: string = localDateKey()): RecoverySnapshot {
  const byDate = new Map<string, WellnessRecord>();
  for (const r of records) {
    if (r && typeof r.date === 'string' && DATE_RE.test(r.date) && r.date <= today) byDate.set(r.date, r);
  }
  const valuesBetween = (field: NumericField, from: string, to: string): number[] => {
    const out: number[] = [];
    for (const [date, r] of byDate) {
      const v = r[field];
      if (date >= from && date <= to && typeof v === 'number') out.push(v);
    }
    return out;
  };
  const newestWith = (has: (r: WellnessRecord) => boolean): WellnessRecord | undefined => {
    for (let i = 0; i <= RECENT_DAYS; i++) {
      const r = byDate.get(addDays(today, -i));
      if (r && has(r)) return r;
    }
    return undefined;
  };

  const series: RecoverySeriesPoint[] = [];
  for (let i = SERIES_DAYS - 1; i >= 0; i--) {
    const date = addDays(today, -i);
    const r = byDate.get(date);
    const point: RecoverySeriesPoint = { date };
    if (r?.hrv !== undefined) point.hrv = r.hrv;
    if (r?.restingHR !== undefined) point.restingHR = r.restingHR;
    if (r?.sleepSecs !== undefined) point.sleepHours = Math.round((r.sleepSecs / 3600) * 100) / 100;
    series.push(point);
  }

  const windowStart = addDays(today, -(HRV_BASELINE_DAYS - 1));
  let daysWithData = 0;
  for (const [date, r] of byDate) if (date >= windowStart && hasRecoveryData(r)) daysWithData++;

  const snapshot: RecoverySnapshot = {
    status: 'unknown', headline: '', reasons: [], suggestion: '', date: today, daysWithData, series,
  };
  const signals: Signal[] = [];
  const notes: string[] = [];

  // Sleep
  const sleepRec = newestWith((r) => r.sleepSecs !== undefined);
  if (sleepRec?.sleepSecs !== undefined) {
    const secs = sleepRec.sleepSecs;
    const sleep: RecoverySleep = { date: sleepRec.date, secs, flagged: false };
    if (sleepRec.sleepScore !== undefined) sleep.score = sleepRec.sleepScore;
    const prior = valuesBetween('sleepSecs', addDays(sleepRec.date, -7), addDays(sleepRec.date, -1));
    if (prior.length >= SLEEP_MIN_BASELINE_NIGHTS) sleep.avg7Secs = Math.round(mean(prior));
    snapshot.sleep = sleep;

    const hours = secs / 3600;
    const dur = formatDuration(secs);
    const deficit = sleep.avg7Secs !== undefined ? sleep.avg7Secs - secs : 0;
    const belowUsual = deficit >= SLEEP_BELOW_USUAL_HOURS * 3600;
    const vsUsual = belowUsual && sleep.avg7Secs !== undefined
      ? `, ${formatDuration(deficit)} less than your 7-night average (${formatDuration(sleep.avg7Secs)})`
      : '';
    if (hours < SLEEP_VERY_SHORT_HOURS) {
      sleep.flagged = true;
      signals.push({ strong: true, rank: 2, phrase: `you slept only ${dur}`, reason: `You slept only ${dur}${vsUsual}.` });
    } else if (hours < SLEEP_SHORT_HOURS || (hours < SLEEP_FLOOR_HOURS && belowUsual)) {
      sleep.flagged = true;
      signals.push({
        strong: false,
        rank: 2,
        phrase: `sleep was short (${dur})`,
        reason: `You slept ${dur}${vsUsual || ', well under 7 hours'}.`,
      });
    } else if (hours < SLEEP_FLOOR_HOURS) {
      notes.push(`You slept ${dur}, a little under 7 hours.`);
    } else {
      notes.push(`You slept ${dur}${sleep.score !== undefined ? ` (sleep score ${Math.round(sleep.score)})` : ''}.`);
    }
  }

  // Resting HR
  const rhrRec = newestWith((r) => r.restingHR !== undefined);
  if (rhrRec?.restingHR !== undefined) {
    const bpm = rhrRec.restingHR;
    const rhr: RecoveryRestingHR = { date: rhrRec.date, bpm, flagged: false };
    const prior = valuesBetween('restingHR', addDays(rhrRec.date, -RHR_BASELINE_DAYS), addDays(rhrRec.date, -1));
    if (prior.length >= RHR_MIN_BASELINE_READINGS) {
      const baseline = mean(prior);
      rhr.baseline = round1(baseline);
      rhr.delta = Math.round(bpm - baseline);
    }
    snapshot.restingHR = rhr;

    const avg = rhr.baseline !== undefined ? Math.round(rhr.baseline) : 0;
    if (rhr.delta === undefined) {
      notes.push(`Resting HR is ${bpm} bpm (building your 30-day average).`);
    } else if (rhr.delta >= RHR_FLAG_BPM) {
      rhr.flagged = true;
      signals.push({
        strong: rhr.delta >= RHR_STRONG_BPM,
        rank: 1,
        phrase: `resting HR is up ${rhr.delta} bpm`,
        reason: `Resting HR is ${bpm} bpm, ${rhr.delta} bpm above your 30-day average (${avg}).`,
      });
    } else if (rhr.delta <= -3) {
      notes.push(`Resting HR is ${bpm} bpm, ${-rhr.delta} bpm below your 30-day average (${avg}).`);
    } else if (rhr.delta >= 3) {
      notes.push(`Resting HR is ${bpm} bpm, slightly above your 30-day average (${avg}).`);
    } else {
      notes.push(`Resting HR is ${bpm} bpm, in line with your 30-day average (${avg}).`);
    }
  }

  // HRV
  const hrvRec = newestWith((r) => r.hrv !== undefined);
  const lnBaseline = valuesBetween('hrv', windowStart, today).map(Math.log);
  if (lnBaseline.length > 0) {
    const hrv: RecoveryHRV = { baselineDays: lnBaseline.length, flagged: false };
    if (hrvRec?.hrv !== undefined) {
      hrv.date = hrvRec.date;
      hrv.latest = hrvRec.hrv;
    }
    const lnRolling = valuesBetween('hrv', addDays(today, -(HRV_ROLLING_DAYS - 1)), today).map(Math.log);
    const lnAvg7 = lnRolling.length >= HRV_MIN_ROLLING_READINGS ? mean(lnRolling) : undefined;
    if (lnAvg7 !== undefined) hrv.avg7 = round1(Math.exp(lnAvg7));
    let strongLow = false;
    let latestLow = false;
    if (lnBaseline.length >= HRV_MIN_BASELINE_READINGS) {
      const mu = mean(lnBaseline);
      const sd = Math.max(stdev(lnBaseline), HRV_MIN_SD);
      hrv.baseline = round1(Math.exp(mu));
      hrv.low = round1(Math.exp(mu - HRV_NORMAL_SD * sd));
      hrv.high = round1(Math.exp(mu + HRV_NORMAL_SD * sd));
      // Only rated with a reading from the last 2 days, like the other metrics.
      if (lnAvg7 !== undefined && hrv.latest !== undefined) {
        hrv.position = lnAvg7 < mu - HRV_NORMAL_SD * sd ? 'below' : lnAvg7 > mu + HRV_NORMAL_SD * sd ? 'above' : 'within';
        strongLow = lnAvg7 < mu - HRV_STRONG_SD * sd;
      }
      latestLow = hrv.latest !== undefined && Math.log(hrv.latest) < mu - sd;
    }
    snapshot.hrv = hrv;

    const range = hrv.low !== undefined && hrv.high !== undefined ? `${Math.round(hrv.low)}–${Math.round(hrv.high)} ms` : '';
    const avg7 = hrv.avg7 !== undefined ? Math.round(hrv.avg7) : 0;
    if (lnBaseline.length < HRV_MIN_BASELINE_READINGS) {
      notes.push(`Building your HRV baseline (${lnBaseline.length} of ${HRV_MIN_BASELINE_READINGS} days).`);
    } else if (hrv.latest === undefined) {
      notes.push('No HRV reading from the last 2 days.');
    } else if (hrv.position === undefined) {
      notes.push(`Need at least ${HRV_MIN_ROLLING_READINGS} HRV readings in the last 7 days for a reliable average.`);
    } else if (hrv.position === 'below') {
      hrv.flagged = true;
      signals.push({
        strong: strongLow,
        rank: 0,
        phrase: strongLow ? 'HRV is well below your normal range' : 'HRV is below your normal range',
        reason: `HRV 7-day average is ${avg7} ms, ${strongLow ? 'well ' : ''}below your normal range (${range}).`,
      });
    } else {
      notes.push(`HRV 7-day average (${avg7} ms) is ${hrv.position} your normal range (${range}).`);
      if (latestLow && hrv.latest !== undefined) {
        notes.push(`Your latest HRV reading (${Math.round(hrv.latest)} ms) was low, but one reading on its own isn't a concern.`);
      }
    }
  }

  // Self-reported fatigue / soreness / stress (intervals.icu)
  const feelRec = newestWith((r) => r.fatigue !== undefined || r.soreness !== undefined || r.stress !== undefined);
  if (feelRec) {
    const high = (['fatigue', 'soreness', 'stress'] as const).filter((k) => (feelRec[k] ?? 0) >= SUBJECTIVE_HIGH);
    if (high.length > 0) {
      signals.push({
        strong: false,
        rank: 3,
        phrase: `you logged high ${joinAnd([...high])}`,
        reason: `You logged high ${joinAnd([...high])} in intervals.icu.`,
      });
    }
  }

  const readinessRec = newestWith((r) => r.readiness !== undefined);
  if (readinessRec?.readiness !== undefined) snapshot.readiness = readinessRec.readiness;

  // Strong signals first, then HRV, resting HR, sleep, self-reported.
  signals.sort((a, b) => Number(b.strong) - Number(a.strong) || a.rank - b.rank);

  // Status
  const recentData = !!(sleepRec || rhrRec || hrvRec);
  if (daysWithData === 0) {
    snapshot.headline = 'No recovery data yet';
    snapshot.reasons = ['Need about a week of sleep, HRV or resting HR data from your watch.'];
    snapshot.suggestion = 'Train as planned and go by feel for now.';
    return snapshot;
  }
  if (!recentData) {
    snapshot.headline = 'No recent recovery data';
    snapshot.reasons = [
      'Nothing new from your watch in the last couple of days. Open its app so it syncs to intervals.icu.',
    ];
    snapshot.suggestion = 'Train as planned and go by feel for now.';
    return snapshot;
  }
  if (daysWithData < MIN_DAYS_FOR_STATUS) {
    snapshot.headline = 'Learning your normal ranges';
    snapshot.reasons = [
      `Need about a week of data to learn your normal ranges (${daysWithData} of ${MIN_DAYS_FOR_STATUS} days so far).`,
      ...signals.map((s) => s.reason),
      ...notes,
    ];
    snapshot.suggestion = 'Train as planned and go by feel for now.';
    return snapshot;
  }

  snapshot.reasons = [...signals.map((s) => s.reason), ...notes];
  const what = capitalize(joinAnd(signals.map((s) => s.phrase)));
  if (signals.some((s) => s.strong) || signals.length >= 2) {
    snapshot.status = 'caution';
    snapshot.headline = 'Take it easy today';
    snapshot.suggestion = `${what}: keep today easy or swap the workout with a rest day.`;
  } else if (signals.length === 1) {
    snapshot.status = 'ok';
    snapshot.headline = 'Mostly recovered';
    snapshot.suggestion = `${what}: train as planned, but back off if your warm-up feels harder than usual.`;
  } else if (snapshot.hrv?.position !== undefined || snapshot.restingHR?.delta !== undefined) {
    snapshot.status = 'good';
    snapshot.headline = 'Well recovered';
    snapshot.suggestion = 'Train as planned.';
  } else {
    // Nothing alarming, but no HRV or resting-HR baseline to confirm it yet.
    snapshot.status = 'ok';
    snapshot.headline = 'No warning signs';
    snapshot.suggestion = 'Train as planned.';
  }
  return snapshot;
}

/** Today's recovery from the wellness stored on this device (see computeRecoverySnapshot). */
export function getRecoverySnapshot(today: string = localDateKey()): RecoverySnapshot {
  return computeRecoverySnapshot(Object.values(readStore()), today);
}
