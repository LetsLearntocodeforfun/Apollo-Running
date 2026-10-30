/**
 * Garmin Connect Personal API client (v1.0.8, DS-01). Desktop app only.
 *
 * Garmin now lets every Garmin Connect user create a personal API key
 * (Garmin Connect › Settings › Personal API Key). The key reads the account's
 * own data: activity summaries, original activity files (FIT), health and
 * women's-health data. It is pull only and needs no developer approval.
 * Apollo uses it to sync activities straight from Garmin Connect, with no
 * third-party account in between.
 *
 * How it works:
 *  - The key is exchanged for a bearer token: a JWT valid for at most 24 h.
 *    Garmin issues no refresh tokens, so Apollo mints a new one from the key
 *    once the cached one is within an hour of expiring, as Garmin's own
 *    Python client does.
 *  - Garmin's API rejects browser (CORS) requests, so every call goes through
 *    the desktop app's main process (electron/main.ts; policy in
 *    electron/garminProxy.ts). The web version can't connect.
 *  - Keys expire after the period the athlete picked (30, 90 or 180 days, or
 *    one year). A rejected key flags Garmin as needing reconnect
 *    (connectionHealth.ts), so syncs stop retrying and Settings explains what
 *    to do.
 *  - Activity lists are summaries without GPS. Routes, splits and laps come
 *    from the original file (garminFit.ts, loaded lazily so the FIT parser
 *    stays out of the first-screen bundle).
 *
 * Docs: https://developer.garmin.com/gc-developer-program/personal/
 * Reference client: https://github.com/garmin/connect-personal-api-python
 */

import { getGarminPersonalCredentials, setGarminPersonalCredentials, type GarminPersonalCredentials } from './storage';
import { setNeedsReconnect } from './connectionHealth';
import { formatSportType, isRunActivity, normalizeSportType } from './activity/sports';
import { toStravaStyleLocal } from './intervals';
import type { Activity, AthleteProfile } from './activity/types';

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * Garmin activity IDs are mapped into their own numeric range so they never
 * collide with Strava IDs, intervals.icu IDs (1e14 numeric, 2e14 hashed) or
 * file imports (3e14 + start epoch seconds) in the shared store.
 */
export const GARMIN_ID_OFFSET = 4e14;
/** Largest Garmin activity ID that keeps store IDs below 5e14 (they are ~2e10 today). */
const MAX_GARMIN_ACTIVITY_ID = 1e14;

/**
 * Activities per list page. The spec documents a default of 99, but testers
 * report HTTP 500 above ~45 per page, so Apollo asks for 40.
 */
export const GARMIN_PAGE_SIZE = 40;
/** Safety cap on pages per date window (40 × 100 = 4,000 activities). */
const MAX_PAGES_PER_WINDOW = 100;
/**
 * Minimum spacing between requests. Garmin publishes no rate limits; ~100
 * requests/minute has been observed, and 429s are retried with Retry-After.
 */
const MIN_REQUEST_INTERVAL_MS = 500;

/** Mint a new token once the cached one has less than this left (Garmin's own client uses 1 h). */
const TOKEN_RENEW_WINDOW_MS = 60 * 60 * 1000;
/** Lifetime assumed for a token whose JWT has no readable `exp` (Garmin documents 24 h). */
const TOKEN_FALLBACK_LIFETIME_MS = 23 * 60 * 60 * 1000;
/** Retries for network errors, 429 and 5xx (every call Apollo makes is a read). */
const MAX_RETRIES = 2;
const MAX_RETRY_WAIT_SEC = 30;

const LIST_PATH = '/activitylist-service/activities/search/activities';
const PROFILE_PATH = '/userprofile-service/userprofile/settings';
const activityPath = (id: string) => `/activity-service/activity/${id}`;
const filePath = (id: string) => `/download-service/files/activity/${id}`;

/** Where athletes create (and renew) their personal API key. */
export const GARMIN_KEY_SETTINGS_URL = 'https://connect.garmin.com/app/settings/personalApiToken';

// ── Errors ────────────────────────────────────────────────────────────────────

/** Garmin rejected the personal API key (deleted, expired or mistyped). */
export class GarminAuthError extends Error {
  constructor(
    message: string = 'Garmin Connect rejected your personal API key. It may have expired or been deleted: create a new key in Garmin Connect and connect again.',
  ) {
    super(message);
    this.name = 'GarminAuthError';
  }
}

/** Any other unsuccessful reply. `status` 0 means Garmin couldn't be reached. */
export class GarminHttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'GarminHttpError';
    this.status = status;
  }
}

/** The caller cancelled the request (`cancelSync()` or the sync watchdog). */
export class GarminAbortError extends Error {
  constructor(message: string = 'Sync was cancelled.') {
    super(message);
    this.name = 'AbortError';
  }
}

/** This build can't reach Garmin (the web version: Garmin blocks browser requests). */
export class GarminUnavailableError extends Error {
  constructor(
    message: string = 'Garmin Connect sync works in the Apollo desktop app. In your browser, use intervals.icu or import activity files.',
  ) {
    super(message);
    this.name = 'GarminUnavailableError';
  }
}

// ── Transport ─────────────────────────────────────────────────────────────────

/** How requests reach Garmin: the desktop main process (default) or an injected one (tests). */
export interface GarminTransport {
  obtainToken(apiKey: string): Promise<GarminTokenReply>;
  request(req: GarminProxyRequest): Promise<GarminProxyReply>;
}

let transportOverride: GarminTransport | null = null;
let minRequestIntervalMs = MIN_REQUEST_INTERVAL_MS;
let lastRequestAt = 0;

/**
 * Replace the transport (tests; a future self-hosted relay for the web build).
 * Pass null to go back to the desktop main process. `minRequestIntervalMs`
 * overrides the spacing between requests (tests use 0).
 */
export function setGarminTransport(
  transport: GarminTransport | null,
  options: { minRequestIntervalMs?: number } = {},
): void {
  transportOverride = transport;
  minRequestIntervalMs = transport
    ? (options.minRequestIntervalMs ?? MIN_REQUEST_INTERVAL_MS)
    : MIN_REQUEST_INTERVAL_MS;
  lastRequestAt = 0;
  forgetGarminToken();
}

function desktopTransport(): GarminTransport | null {
  if (typeof window === 'undefined') return null;
  const garmin = window.electronAPI?.garmin;
  return garmin && typeof garmin.request === 'function' && typeof garmin.obtainToken === 'function' ? garmin : null;
}

/** True when this build can talk to Garmin Connect (the desktop app). */
export function isGarminTransportAvailable(): boolean {
  return !!(transportOverride ?? desktopTransport());
}

function getTransport(): GarminTransport {
  const transport = transportOverride ?? desktopTransport();
  if (!transport) throw new GarminUnavailableError();
  return transport;
}

// ── Small helpers ─────────────────────────────────────────────────────────────

/** Wait `ms`; rejects early with GarminAbortError when `signal` aborts. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new GarminAbortError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new GarminAbortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Settle with `promise`, or reject with GarminAbortError as soon as `signal`
 * aborts. An IPC call can't be cancelled, so a stopped sync stops waiting for
 * it instead (the main process times the request out on its own).
 */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new GarminAbortError());
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function positive(v: unknown): number | undefined {
  const n = num(v);
  return n !== undefined && n > 0 ? n : undefined;
}

function stripUndefined<T extends object>(obj: T): T {
  const rec = obj as Record<string, unknown>;
  for (const k of Object.keys(rec)) if (rec[k] === undefined) delete rec[k];
  return obj;
}

function requireCredentials(creds?: GarminPersonalCredentials | null): GarminPersonalCredentials {
  const c = creds ?? getGarminPersonalCredentials();
  if (!c) throw new Error('Garmin Connect is not connected. Add your personal API key in Settings › Connections.');
  return c;
}

// ── Bearer tokens ─────────────────────────────────────────────────────────────

/**
 * Expiry (epoch ms) from a JWT's `exp` claim, read without verifying the
 * signature (Garmin verifies it; Apollo only needs to know when to renew).
 * Null when the token isn't a readable JWT.
 */
export function parseJwtExpiry(token: string): number | null {
  const payload = token.split('.')[1];
  if (!payload) return null;
  try {
    const b64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const json: unknown = JSON.parse(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)));
    const exp = json && typeof json === 'object' ? (json as { exp?: unknown }).exp : undefined;
    return typeof exp === 'number' && Number.isFinite(exp) && exp > 0 ? exp * 1000 : null;
  } catch {
    return null;
  }
}

/** Last token minted this session (also covers a key that isn't saved yet: the connect probe). */
let memoryToken: { apiKey: string; token: string; expiresAt: number } | null = null;
/** Token request in progress, so concurrent calls share one mint. */
let tokenInFlight: { apiKey: string; promise: Promise<string> } | null = null;

/** Drop cached tokens (disconnect, key change, transport change). */
export function forgetGarminToken(): void {
  memoryToken = null;
  tokenInFlight = null;
}

function isFresh(expiresAt: number | undefined, now: number): boolean {
  return typeof expiresAt === 'number' && expiresAt - now > TOKEN_RENEW_WINDOW_MS;
}

function cachedToken(c: GarminPersonalCredentials): string | null {
  const now = Date.now();
  if (memoryToken && memoryToken.apiKey === c.apiKey && isFresh(memoryToken.expiresAt, now)) return memoryToken.token;
  if (c.accessToken && isFresh(c.accessTokenExpiresAt, now)) return c.accessToken;
  return null;
}

/** A 401 for the key saved in Settings means "reconnect"; probes with an unsaved key don't flag. */
function flagRejectedKey(apiKey: string, message: string): void {
  try {
    if (getGarminPersonalCredentials()?.apiKey === apiKey) setNeedsReconnect('garmin', message);
  } catch {
    /* best-effort */
  }
}

/** Keep a fresh token in memory and, when it belongs to the saved key, in the encrypted store. */
function rememberToken(apiKey: string, token: string, expiresAt: number): void {
  memoryToken = { apiKey, token, expiresAt };
  const saved = getGarminPersonalCredentials();
  if (saved && saved.apiKey === apiKey) {
    void setGarminPersonalCredentials({ ...saved, accessToken: token, accessTokenExpiresAt: expiresAt });
  }
}

/** Friendly error for an unsuccessful proxy reply. */
function replyError(reply: { status: number; error?: string; text?: string }, what: 'token' | 'file' | 'data'): Error {
  const { status } = reply;
  if (status === 0) {
    return new GarminHttpError(
      0,
      reply.error === 'timeout'
        ? 'Garmin Connect did not respond in time. Check your connection and try again.'
        : 'Could not reach Garmin Connect. Check your internet connection.',
    );
  }
  if (reply.error === 'too-large') {
    return new GarminHttpError(status, 'The file from Garmin Connect is too large to import.');
  }
  if (status === 429) {
    return new GarminHttpError(429, 'Garmin Connect rate limit reached. Please try again in a few minutes.');
  }
  if (status === 404) {
    return new GarminHttpError(
      404,
      what === 'file'
        ? 'Garmin Connect has no original file for this activity.'
        : 'Garmin Connect could not find that activity.',
    );
  }
  if (status === 403) {
    return new GarminHttpError(403, 'Garmin Connect refused access to this data with your personal API key.');
  }
  if (status >= 500) {
    return new GarminHttpError(status, `Garmin Connect is having problems (error ${status}). Try again later.`);
  }
  let detail = '';
  try {
    const parsed: unknown = reply.text ? JSON.parse(reply.text) : null;
    const message = parsed && typeof parsed === 'object' ? (parsed as { error?: unknown }).error : undefined;
    if (typeof message === 'string') detail = `: ${message.slice(0, 160)}`;
  } catch {
    /* not JSON */
  }
  return new GarminHttpError(status, `Garmin Connect error ${status}${detail}`);
}

function isRetryable(status: number): boolean {
  return status === 0 || status === 429 || status >= 500;
}

function retryWaitMs(reply: { status: number; retryAfter: number | null }, attempt: number): number {
  if (reply.status === 429) {
    const sec = reply.retryAfter != null && reply.retryAfter > 0 ? reply.retryAfter : 2 * (attempt + 1);
    return Math.min(sec, MAX_RETRY_WAIT_SEC) * 1000;
  }
  return 1000 * (attempt + 1);
}

/** Exchange the key for a bearer token (retries transient failures). */
async function mintToken(apiKey: string, signal?: AbortSignal): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    if (signal?.aborted) throw new GarminAbortError();
    const reply = await untilAborted(getTransport().obtainToken(apiKey), signal);
    if (reply.ok && reply.token) {
      const expiresAt = parseJwtExpiry(reply.token) ?? Date.now() + TOKEN_FALLBACK_LIFETIME_MS;
      rememberToken(apiKey, reply.token, expiresAt);
      return reply.token;
    }
    // 400 here means Garmin couldn't read the key at all (we always send one).
    if (reply.status === 400 || reply.status === 401 || reply.status === 403) {
      const err = new GarminAuthError();
      flagRejectedKey(apiKey, err.message);
      throw err;
    }
    if (isRetryable(reply.status) && attempt < MAX_RETRIES) {
      await sleep(retryWaitMs(reply, attempt), signal);
      continue;
    }
    if (reply.ok || reply.error === 'bad-token') {
      throw new GarminHttpError(reply.status, 'Garmin Connect returned an unexpected token. Try again later.');
    }
    throw replyError(reply, 'token');
  }
}

/** A usable bearer token for `c`: the cached one, or a newly minted one. */
async function getAccessToken(c: GarminPersonalCredentials, force: boolean, signal?: AbortSignal): Promise<string> {
  if (!force) {
    const cached = cachedToken(c);
    if (cached) return cached;
  }
  if (tokenInFlight && tokenInFlight.apiKey === c.apiKey) return untilAborted(tokenInFlight.promise, signal);
  // The shared mint must not be cancelled by one caller's signal.
  const promise: Promise<string> = mintToken(c.apiKey).finally(() => {
    if (tokenInFlight?.promise === promise) tokenInFlight = null;
  });
  tokenInFlight = { apiKey: c.apiKey, promise };
  return untilAborted(promise, signal);
}

// ── Requests ──────────────────────────────────────────────────────────────────

type QueryParams = Record<string, string | number | boolean>;

interface RequestSpec {
  path: string;
  query?: QueryParams;
  accept?: 'json' | 'file';
  signal?: AbortSignal;
  creds?: GarminPersonalCredentials | null;
}

/** Wait so requests are at least `minRequestIntervalMs` apart (Garmin publishes no limits). */
async function throttle(signal?: AbortSignal): Promise<void> {
  const wait = lastRequestAt + minRequestIntervalMs - Date.now();
  if (wait > 0) await sleep(wait, signal);
  lastRequestAt = Date.now();
}

/**
 * Authenticated GET through the transport: token handling, request spacing,
 * retries for network errors / 429 / 5xx, one fresh token after a 401 (a
 * token can stop working before it expires), then GarminAuthError.
 */
async function garminRequest(spec: RequestSpec): Promise<GarminProxyReply> {
  const c = requireCredentials(spec.creds);
  let forceToken = false;
  let renewedAfter401 = false;
  for (let attempt = 0; ; attempt++) {
    if (spec.signal?.aborted) throw new GarminAbortError();
    const accessToken = await getAccessToken(c, forceToken, spec.signal);
    forceToken = false;
    await throttle(spec.signal);
    const reply = await untilAborted(
      getTransport().request({ path: spec.path, query: spec.query, accessToken, accept: spec.accept ?? 'json' }),
      spec.signal,
    );
    if (reply.ok) return reply;
    if (reply.status === 401) {
      if (!renewedAfter401) {
        renewedAfter401 = true;
        forceToken = true;
        if (memoryToken?.token === accessToken) memoryToken = null;
        continue;
      }
      const err = new GarminAuthError();
      flagRejectedKey(c.apiKey, err.message);
      throw err;
    }
    if (isRetryable(reply.status) && attempt < MAX_RETRIES) {
      await sleep(retryWaitMs(reply, attempt), spec.signal);
      continue;
    }
    throw replyError(reply, spec.accept === 'file' ? 'file' : 'data');
  }
}

async function getJson<T>(spec: Omit<RequestSpec, 'accept'>): Promise<T | null> {
  const reply = await garminRequest({ ...spec, accept: 'json' });
  const text = reply.text ?? '';
  if (!text.trim()) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new GarminHttpError(reply.status, 'Garmin Connect returned an unexpected response.');
  }
}

// ── Mapping ───────────────────────────────────────────────────────────────────

/** The subset of Garmin's `SummarizedActivityDTO` that Apollo uses. */
export interface GarminActivitySummary {
  activityId?: number | string | null;
  activityName?: string | null;
  /**
   * "2026-08-31 17:01:18": local wall clock, no offset. Sometimes epoch ms
   * with the wall clock encoded as UTC (as in Garmin's account exports).
   */
  startTimeLocal?: string | number | null;
  /** "2026-08-31 22:01:18": UTC without suffix, or epoch ms. */
  startTimeGMT?: string | number | null;
  /** Start, epoch milliseconds. */
  beginTimestamp?: number | null;
  activityType?: { typeKey?: string | null; typeId?: number | null; parentTypeId?: number | null } | null;
  /** Meters. */
  distance?: number | null;
  /** Timer time, seconds (excludes pauses). */
  duration?: number | null;
  /** Wall-clock time, seconds. */
  elapsedDuration?: number | null;
  /** Time spent moving, seconds. */
  movingDuration?: number | null;
  elevationGain?: number | null;
  /** m/s. */
  averageSpeed?: number | null;
  maxSpeed?: number | null;
  averageHR?: number | null;
  maxHR?: number | null;
  /** Steps per minute (Apollo stores running cadence as strides per minute). */
  averageRunningCadenceInStepsPerMinute?: number | null;
  averageBikingCadenceInRevPerMinute?: number | null;
  /** Kilocalories. */
  calories?: number | null;
  avgPower?: number | null;
  normPower?: number | null;
  /** TSS (power-based activities only). */
  trainingStressScore?: number | null;
  startLatitude?: number | null;
  startLongitude?: number | null;
  endLatitude?: number | null;
  endLongitude?: number | null;
  /** False: no GPS track (indoor, treadmill, manual). */
  hasPolyline?: boolean | null;
  /** Multisport parent; its legs are separate activities with `parentId`. */
  isParent?: boolean | null;
  parentId?: number | string | null;
  isManualActivity?: boolean | null;
  manufacturer?: string | null;
}

/** Garmin activity ID → store ID, or null when it isn't a usable positive integer. */
export function toGarminStoreId(activityId: number | string | null | undefined): number | null {
  const n = typeof activityId === 'string' && /^\d{1,19}$/.test(activityId) ? Number(activityId) : activityId;
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n <= 0 || n >= MAX_GARMIN_ACTIVITY_ID) return null;
  return GARMIN_ID_OFFSET + n;
}

/** Inverse of {@link toGarminStoreId}: the Garmin activity ID as a string, or null. */
export function fromGarminStoreId(id: number): string | null {
  return id > GARMIN_ID_OFFSET && id < GARMIN_ID_OFFSET + MAX_GARMIN_ACTIVITY_ID ? String(id - GARMIN_ID_OFFSET) : null;
}

function epochToIso(ms: unknown): string | null {
  const t = num(ms);
  return t !== undefined && t > 0 ? new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z') : null;
}

/** "2026-08-31 22:01:18" / "2026-08-31T22:01:18.0" / epoch ms → "2026-08-31T22:01:18Z" (UTC). */
function parseGarminUtc(value: string | number | null | undefined): string | null {
  if (typeof value === 'number') return epochToIso(value);
  const m = typeof value === 'string' ? /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})/.exec(value.trim()) : null;
  return m ? `${m[1]}T${m[2]}Z` : null;
}

/**
 * "2026-08-31 17:01:18" → "2026-08-31T17:01:18Z" (Strava-style local time —
 * see activity/types.ts). Epoch ms carry the wall clock encoded as UTC.
 */
function parseGarminLocal(value: string | number | null | undefined): string | null {
  if (typeof value === 'number') return epochToIso(value);
  const text = typeof value === 'string' ? value.trim() : '';
  return /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(text) ? toStravaStyleLocal(text) : null;
}

function defaultName(type: string, startLocal: string): string {
  const hour = Number(startLocal.slice(11, 13));
  const part =
    hour >= 5 && hour < 12
      ? 'Morning'
      : hour >= 12 && hour < 17
        ? 'Afternoon'
        : hour >= 17 && hour < 21
          ? 'Evening'
          : 'Night';
  return `${part} ${formatSportType(type)}`;
}

function latLng(lat: unknown, lng: unknown): [number, number] | null {
  const a = num(lat);
  const b = num(lng);
  if (a === undefined || b === undefined || Math.abs(a) > 90 || Math.abs(b) > 180 || (a === 0 && b === 0)) return null;
  return [a, b];
}

/**
 * Convert a Garmin activity summary to Apollo's canonical model. Returns null
 * for records without a usable ID or start time.
 */
export function mapGarminActivity(raw: GarminActivitySummary): Activity | null {
  if (!raw) return null;
  const id = toGarminStoreId(raw.activityId);
  if (id === null) return null;
  const utc = parseGarminUtc(raw.startTimeGMT) ?? epochToIso(raw.beginTimestamp);
  const local = parseGarminLocal(raw.startTimeLocal) ?? utc;
  if (!local) return null;

  const sport = normalizeSportType(raw.activityType?.typeKey);
  const type = sport.type || 'Workout';
  const isRun = isRunActivity({ type });
  const distance = num(raw.distance) ?? 0;
  const timer = num(raw.duration);
  const moving = num(raw.movingDuration) ?? timer ?? num(raw.elapsedDuration) ?? 0;
  const elapsed = Math.max(num(raw.elapsedDuration) ?? timer ?? moving, moving);
  const stepsPerMin = positive(raw.averageRunningCadenceInStepsPerMinute);
  const cadence = isRun
    ? stepsPerMin !== undefined
      ? Math.round((stepsPerMin / 2) * 10) / 10
      : undefined
    : positive(raw.averageBikingCadenceInRevPerMinute);
  const start = latLng(raw.startLatitude, raw.startLongitude);
  const end = latLng(raw.endLatitude, raw.endLongitude);
  const sourceId = String(id - GARMIN_ID_OFFSET);

  return stripUndefined<Activity>({
    id,
    name: raw.activityName?.trim() || defaultName(type, local),
    type,
    sport_type: type,
    distance,
    moving_time: Math.round(moving),
    elapsed_time: Math.round(elapsed),
    start_date: utc ?? local,
    start_date_local: local,
    kudos_count: 0,
    average_heartrate: positive(raw.averageHR),
    max_heartrate: positive(raw.maxHR),
    average_speed: positive(raw.averageSpeed) ?? (moving > 0 && distance > 0 ? distance / moving : undefined),
    max_speed: positive(raw.maxSpeed),
    total_elevation_gain: num(raw.elevationGain),
    average_cadence: cadence,
    calories: positive(raw.calories),
    average_watts: positive(raw.avgPower),
    weighted_average_watts: positive(raw.normPower),
    // Only true TSS: Garmin's EPOC-based "training load" is a different scale.
    training_load: positive(raw.trainingStressScore),
    trainer: sport.trainer ? true : undefined,
    start_latlng: start,
    end_latlng: end,
    // No GPS track: mark the route as checked so nothing downloads the file just for a map.
    map: raw.hasPolyline === false ? { id: `garmin-${sourceId}`, summary_polyline: '' } : undefined,
    source: 'garmin',
    source_id: sourceId,
    origin: 'GARMIN_CONNECT',
  });
}

/**
 * Drop multisport parents whose legs are in the same batch: the legs (run,
 * ride, swim) are what training analysis needs. A parent without visible legs
 * is kept so the workout isn't lost.
 */
function dropParentsWithLegs(rows: GarminActivitySummary[]): GarminActivitySummary[] {
  const parentsWithLegs = new Set<string>();
  for (const r of rows) if (r?.parentId != null) parentsWithLegs.add(String(r.parentId));
  return rows.filter((r) => !(r?.isParent && r.activityId != null && parentsWithLegs.has(String(r.activityId))));
}

// ── Endpoints ─────────────────────────────────────────────────────────────────

export interface ListGarminParams {
  /** Local date (YYYY-MM-DD), inclusive. */
  startDate: string;
  /** Local date (YYYY-MM-DD), inclusive. */
  endDate: string;
  /** Cancels the requests (GarminAbortError). */
  signal?: AbortSignal;
  /** Called after each page with the number of rows received so far. */
  onPage?: (rowsSoFar: number) => void;
}

/** Result of {@link listGarminActivities}. */
export interface GarminActivityList {
  /** Activities Apollo can use, mapped to its model. */
  activities: Activity[];
  /** Rows Garmin returned, including ones Apollo skips (multisport parents, unusable rows). */
  rawCount: number;
  /** Garmin activity IDs of every row returned (for remote-deletion reconcile). */
  rawIds: string[];
}

/**
 * Every activity (all sports) whose local start date falls in the window,
 * across all pages. Multisport legs are listed individually.
 */
export async function listGarminActivities(
  params: ListGarminParams,
  creds?: GarminPersonalCredentials | null,
): Promise<GarminActivityList> {
  const c = requireCredentials(creds);
  const rows: GarminActivitySummary[] = [];
  for (let page = 0; page < MAX_PAGES_PER_WINDOW; page++) {
    const batch = await getJson<GarminActivitySummary[]>({
      path: LIST_PATH,
      query: {
        start: page * GARMIN_PAGE_SIZE,
        limit: GARMIN_PAGE_SIZE,
        startDate: params.startDate,
        endDate: params.endDate,
        excludeChildren: false,
      },
      signal: params.signal,
      creds: c,
    });
    if (!Array.isArray(batch)) break;
    rows.push(...batch);
    params.onPage?.(rows.length);
    if (batch.length < GARMIN_PAGE_SIZE) break;
  }
  const activities: Activity[] = [];
  const seen = new Set<number>();
  for (const r of dropParentsWithLegs(rows)) {
    const a = mapGarminActivity(r);
    // Offset pages can overlap if an activity was added meanwhile.
    if (a && !seen.has(a.id)) {
      seen.add(a.id);
      activities.push(a);
    }
  }
  const rawIds = rows.filter((r) => r?.activityId != null).map((r) => String(r.activityId));
  return { activities, rawCount: rows.length, rawIds };
}

/** Full summary of one activity (same shape as a list row). */
export async function getGarminActivitySummary(
  activityId: string,
  creds?: GarminPersonalCredentials | null,
  opts: { signal?: AbortSignal } = {},
): Promise<GarminActivitySummary | null> {
  return getJson<GarminActivitySummary>({ path: activityPath(activityId), signal: opts.signal, creds });
}

/** The original activity file as uploaded by the device: ZIP bytes (holding a FIT, GPX or TCX). */
export async function downloadGarminActivityFile(
  activityId: string,
  creds?: GarminPersonalCredentials | null,
  opts: { signal?: AbortSignal } = {},
): Promise<Uint8Array> {
  const reply = await garminRequest({ path: filePath(activityId), accept: 'file', signal: opts.signal, creds });
  if (!reply.bytes || reply.bytes.length === 0) {
    throw new GarminHttpError(reply.status, 'Garmin Connect returned an empty activity file.');
  }
  return reply.bytes;
}

interface GarminUserSettings {
  displayName?: string | null;
  timeZone?: string | null;
  measurementSystem?: string | null;
}

/** The account's display name from its profile settings, or null. Also proves the key works. */
export async function getGarminDisplayName(creds?: GarminPersonalCredentials | null): Promise<string | null> {
  const settings = await getJson<GarminUserSettings>({ path: PROFILE_PATH, creds });
  return settings?.displayName?.trim() || null;
}

/** Apollo's athlete profile for a Garmin display name (Garmin's settings carry no first/last name or avatar). */
export function garminAthleteProfile(displayName: string | null | undefined): AthleteProfile {
  const name = displayName?.trim() ?? '';
  const [first, ...rest] = name.split(/\s+/).filter(Boolean);
  return { id: name || 'garmin', firstname: first || 'Garmin athlete', lastname: rest.join(' '), source: 'garmin' };
}

/** Profile of the account that owns the saved key. */
export async function getGarminAthlete(creds?: GarminPersonalCredentials | null): Promise<AthleteProfile> {
  const c = requireCredentials(creds);
  return garminAthleteProfile((await getGarminDisplayName(c)) ?? c.displayName);
}

/**
 * Check a personal API key: mint a token (Garmin validates the key) and read
 * the profile. Throws GarminAuthError for a rejected key. Nothing is saved;
 * the minted token is kept in memory for the import that follows.
 */
export async function verifyGarminKey(apiKey: string): Promise<{ displayName: string | null }> {
  const key = apiKey.trim();
  if (!key) throw new Error('Paste your Garmin personal API key first.');
  return { displayName: await getGarminDisplayName({ apiKey: key }) };
}

/**
 * Route, splits, laps and device for one activity from its original file.
 * The FIT parser is loaded on first use. Returns the activity with those
 * fields added (Garmin's own summary values are kept), or null when the file
 * holds no usable workout.
 */
export async function getGarminActivityDetail(
  base: Activity,
  creds?: GarminPersonalCredentials | null,
  opts: { signal?: AbortSignal } = {},
): Promise<Activity | null> {
  const garminId = base.source_id ?? fromGarminStoreId(base.id);
  if (!garminId || !/^\d+$/.test(garminId)) return null;
  const bytes = await downloadGarminActivityFile(garminId, creds, opts);
  if (opts.signal?.aborted) throw new GarminAbortError();
  const { buildGarminDetail } = await import('./garminFit');
  return buildGarminDetail(base, bytes);
}
