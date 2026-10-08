/**
 * intervals.icu API client (free).
 *
 * intervals.icu relays activities from Garmin Connect, Zwift, Wahoo, COROS,
 * Suunto, Polar and more — runs, rides and every other sport. Apollo
 * authenticates with the athlete's personal API key (HTTP Basic auth with the
 * username "API_KEY") and calls the API directly: intervals.icu supports CORS,
 * so the desktop and web builds need no backend.
 *
 * Besides reading activities, Apollo writes planned workouts to the athlete's
 * intervals.icu calendar (see planCalendarSync.ts), which intervals.icu can
 * forward to the athlete's watch. It also reads daily wellness (sleep, HRV,
 * resting HR) and the sport settings (threshold pace, max HR); see wellness.ts.
 *
 * API docs: https://intervals.icu/api-docs.html
 */

import { getIntervalsCredentials, type IntervalsCredentials } from './storage';
import { setNeedsReconnect } from './connectionHealth';
import type { Activity, ActivityLap, AthleteProfile } from './activity/types';
import { isRunActivity, formatSportType } from './activity/sports';
import {
  cleanLatLngs,
  decimate,
  deriveSplits,
  encodePolyline,
  type LatLngPair,
  type StreamSample,
} from './activity/streams';

const INTERVALS_API = 'https://intervals.icu/api/v1';
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 2;
/** Points kept for list/summary maps and for the detailed route. */
const SUMMARY_MAX_POINTS = 500;
const DETAIL_MAX_POINTS = 2000;

/**
 * intervals.icu IDs ("i12345678") are mapped into their own numeric range so
 * they can never collide with Strava activity IDs in the shared store.
 */
export const INTERVALS_ID_OFFSET = 1e14;

// ── Errors ────────────────────────────────────────────────────────────────────

/** The API key / athlete ID was rejected (401/403). */
export class IntervalsAuthError extends Error {
  constructor(message: string = 'intervals.icu rejected the API key. Check the key and athlete ID in Settings.') {
    super(message);
    this.name = 'IntervalsAuthError';
  }
}

/** Any other non-success HTTP response. */
export class IntervalsHttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'IntervalsHttpError';
    this.status = status;
  }
}

/** The caller cancelled the request (e.g. `cancelSync()` or the sync watchdog). */
export class IntervalsAbortError extends Error {
  constructor(message: string = 'Sync was cancelled.') {
    super(message);
    this.name = 'AbortError';
  }
}

// ── HTTP ──────────────────────────────────────────────────────────────────────

/** Wait `ms`; rejects early with IntervalsAbortError when `signal` aborts. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new IntervalsAbortError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new IntervalsAbortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Settle with `promise`, or reject with an AbortError as soon as `signal`
 * aborts — even if the underlying promise never settles (a stalled response
 * body, or a fetch implementation that ignores its signal).
 */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      const err = new Error('The request was aborted.');
      err.name = 'AbortError';
      reject(err);
    };
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

/**
 * A 401/403 made with the credentials saved in Settings means the athlete has
 * to reconnect: flag it so syncs stop retrying and the UI shows a banner.
 * Probes with a key that isn't saved yet (the connect dialog) don't flag.
 */
function flagRejectedStoredKey(used: IntervalsCredentials, message: string): void {
  try {
    if (getIntervalsCredentials()?.apiKey === used.apiKey) setNeedsReconnect('intervals', message);
  } catch { /* flagging is best-effort */ }
}

function requireCredentials(creds?: IntervalsCredentials | null): IntervalsCredentials {
  const c = creds ?? getIntervalsCredentials();
  if (!c) throw new Error('intervals.icu is not connected. Add your API key in Settings.');
  return c;
}

function athletePath(c: IntervalsCredentials): string {
  return encodeURIComponent(c.athleteId || '0');
}

/** HTTP methods Apollo uses to write to intervals.icu. */
export type IntervalsWriteMethod = 'POST' | 'PUT' | 'DELETE';

interface RequestSpec {
  method: 'GET' | IntervalsWriteMethod;
  /** JSON request body (writes only). */
  body?: unknown;
  /**
   * Retry network errors, timeouts and 5xx responses. Only safe when repeating
   * the request cannot duplicate its effect (reads, idempotent writes).
   * HTTP 429 is always retried: the server rejected the request unprocessed.
   */
  retry: boolean;
  /** Cancels the request and any pending retry (throws IntervalsAbortError). */
  signal?: AbortSignal;
}

/** Outcome of one HTTP attempt: a parsed body, or "retry after waiting". */
type AttemptOutcome<T> = { kind: 'done'; value: T } | { kind: 'retry'; waitMs: number };

/**
 * One HTTP attempt. The timeout stays armed until the response body has been
 * read (V8): a server that sends headers and then stalls must not hang sync.
 */
async function attemptRequest<T>(
  url: string,
  init: RequestInit,
  c: IntervalsCredentials,
  spec: RequestSpec,
  attempt: number,
): Promise<AttemptOutcome<T>> {
  const external = spec.signal;
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS) : null;
  const onExternalAbort = () => controller?.abort();
  external?.addEventListener('abort', onExternalAbort, { once: true });
  const signal = controller?.signal;

  /** Network failure, timeout or stalled body: retry when allowed, else a friendly error. */
  const transportFailure = (err: unknown): AttemptOutcome<T> => {
    if (external?.aborted) throw new IntervalsAbortError();
    if (spec.retry && attempt < MAX_RETRIES) return { kind: 'retry', waitMs: 1000 * (attempt + 1) };
    const aborted = err instanceof Error && err.name === 'AbortError';
    throw new Error(aborted
      ? 'intervals.icu did not respond in time. Check your connection and try again.'
      : 'Could not reach intervals.icu. Check your internet connection.');
  };

  try {
    let res: Response;
    try {
      res = await untilAborted(fetch(url, { ...init, signal }), signal);
    } catch (err) {
      return transportFailure(err);
    }

    if (res.status === 401 || res.status === 403) {
      const authError = new IntervalsAuthError();
      flagRejectedStoredKey(c, authError.message);
      throw authError;
    }
    const retryable = res.status === 429 || (spec.retry && res.status >= 500);
    if (retryable && attempt < MAX_RETRIES) {
      const retryAfter = Number(res.headers.get('Retry-After'));
      const waitSec = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 30) : 2 * (attempt + 1);
      return { kind: 'retry', waitMs: waitSec * 1000 };
    }
    if (res.status === 429) {
      throw new IntervalsHttpError(429, 'intervals.icu rate limit reached. Please try again in a few minutes.');
    }
    if (res.status === 404) {
      throw new IntervalsHttpError(404, 'intervals.icu could not find that athlete or activity. Check the athlete ID in Settings.');
    }
    if (!res.ok) {
      const text = await untilAborted(res.text(), signal).catch(() => '');
      throw new IntervalsHttpError(res.status, `intervals.icu error ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
    }
    // Some endpoints (e.g. the map of an indoor activity) answer 200 with an empty body.
    let body: string;
    try {
      body = await untilAborted(res.text(), signal);
    } catch (err) {
      return transportFailure(err);
    }
    if (!body) return { kind: 'done', value: null as T };
    try {
      return { kind: 'done', value: JSON.parse(body) as T };
    } catch {
      throw new IntervalsHttpError(res.status, 'intervals.icu returned an unexpected response.');
    }
  } finally {
    if (timer) clearTimeout(timer);
    external?.removeEventListener('abort', onExternalAbort);
  }
}

/**
 * Shared transport for reads and writes: Basic auth, timeout, retries with
 * back-off (honouring Retry-After), and error mapping (401/403 →
 * IntervalsAuthError, other failures → IntervalsHttpError). Empty 2xx bodies
 * resolve to null.
 */
async function requestIntervals<T>(path: string, creds: IntervalsCredentials | null | undefined, spec: RequestSpec): Promise<T> {
  const c = requireCredentials(creds);
  const authorization = 'Basic ' + btoa(`API_KEY:${c.apiKey}`);
  const headers: Record<string, string> = { Authorization: authorization, Accept: 'application/json' };
  // GETs keep the exact request shape fetchIntervals always used.
  const init: RequestInit = spec.method === 'GET' ? { headers } : { method: spec.method, headers };
  if (spec.method !== 'GET' && spec.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(spec.body);
  }

  for (let attempt = 0; ; attempt++) {
    if (spec.signal?.aborted) throw new IntervalsAbortError();
    const outcome = await attemptRequest<T>(`${INTERVALS_API}${path}`, init, c, spec, attempt);
    if (outcome.kind === 'done') return outcome.value;
    await sleep(outcome.waitMs, spec.signal);
  }
}

/**
 * Authenticated GET with timeout, retry on network errors / 5xx, and 429 back-off.
 * `opts.signal` cancels the request (IntervalsAbortError).
 */
export async function fetchIntervals<T>(
  path: string,
  creds?: IntervalsCredentials | null,
  opts: { signal?: AbortSignal } = {},
): Promise<T> {
  return requestIntervals<T>(path, creds, { method: 'GET', retry: true, signal: opts.signal });
}

/**
 * Authenticated JSON write with the same auth, timeout and error handling as
 * fetchIntervals. Network errors, timeouts and 5xx responses are retried only
 * for idempotent calls — PUT and DELETE by default; pass `{ idempotent: true }`
 * for POSTs that are safe to repeat (e.g. bulk upserts keyed by external_id).
 * 429 responses are always retried.
 */
export async function sendIntervals<T>(
  method: IntervalsWriteMethod,
  path: string,
  body?: unknown,
  creds?: IntervalsCredentials | null,
  opts: { idempotent?: boolean } = {},
): Promise<T> {
  return requestIntervals<T>(path, creds, { method, body, retry: opts.idempotent ?? method !== 'POST' });
}

// ── Mapping ───────────────────────────────────────────────────────────────────

/** Subset of the intervals.icu Activity schema that Apollo uses. */
export interface IcuActivity {
  id: string | number;
  name?: string | null;
  type?: string | null;
  start_date_local?: string | null;
  start_date?: string | null;
  distance?: number | null;
  icu_distance?: number | null;
  moving_time?: number | null;
  elapsed_time?: number | null;
  icu_recording_time?: number | null;
  total_elevation_gain?: number | null;
  average_speed?: number | null;
  max_speed?: number | null;
  average_heartrate?: number | null;
  max_heartrate?: number | null;
  average_cadence?: number | null;
  icu_training_load?: number | null;
  icu_average_watts?: number | null;
  icu_weighted_avg_watts?: number | null;
  trainer?: boolean | null;
  device_name?: string | null;
  calories?: number | null;
  /** Upstream platform, e.g. GARMIN_CONNECT, ZWIFT, WAHOO, STRAVA, UPLOAD. */
  source?: string | null;
}

/** Fields requested from the list endpoint (keeps payloads small for full-history imports). */
const LIST_FIELDS = [
  'id', 'name', 'type', 'start_date_local', 'start_date', 'distance', 'icu_distance',
  'moving_time', 'elapsed_time', 'icu_recording_time', 'total_elevation_gain',
  'average_speed', 'max_speed', 'average_heartrate', 'max_heartrate', 'average_cadence',
  'icu_training_load', 'icu_average_watts', 'icu_weighted_avg_watts', 'trainer',
  'device_name', 'calories', 'source',
].join(',');

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

/** Map an intervals.icu activity ID into the store's numeric ID space. */
export function toStoreId(icuId: string | number): number {
  const s = String(icuId);
  const m = /^i?(\d+)$/.exec(s);
  if (m) return INTERVALS_ID_OFFSET + Number(m[1]);
  // Non-numeric IDs: stable 32-bit hash in a range above the numeric ones.
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) >>> 0;
  return INTERVALS_ID_OFFSET * 2 + h;
}

/** Inverse of toStoreId for numeric intervals.icu IDs. */
export function fromStoreId(id: number): string {
  return id >= INTERVALS_ID_OFFSET && id < INTERVALS_ID_OFFSET * 2 ? `i${id - INTERVALS_ID_OFFSET}` : String(id);
}

/** "2024-05-12T07:31:02" → "2024-05-12T07:31:02Z" (Strava-style local time — see activity/types.ts). */
export function toStravaStyleLocal(local: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2})(:\d{2})?)?/.exec(local);
  if (!m) return local;
  return `${m[1]}T${m[2] ?? '00:00'}${m[3] ?? ':00'}Z`;
}

function toUtcIso(value: string): string {
  return /([zZ]|[+-]\d{2}:?\d{2})$/.test(value) ? value : `${value}Z`;
}

/**
 * Apollo stores running cadence as strides/min (Strava semantics; the UI
 * doubles it). Anything above 120 can only be steps/min, so halve it.
 */
function normalizeCadence(cadence: unknown, isRun: boolean): number | undefined {
  const c = positive(cadence);
  if (c === undefined) return undefined;
  return isRun && c > 120 ? Math.round((c / 2) * 10) / 10 : c;
}

function defaultName(type: string, startLocal: string): string {
  const hour = Number(startLocal.slice(11, 13));
  const part = hour >= 5 && hour < 12 ? 'Morning'
    : hour >= 12 && hour < 17 ? 'Afternoon'
    : hour >= 17 && hour < 21 ? 'Evening'
    : 'Night';
  return `${part} ${formatSportType(type)}`;
}

/**
 * Convert an intervals.icu activity to Apollo's canonical model.
 * Returns null for records the API can't serve (activities intervals.icu
 * imported from Strava are not available to third-party apps) or that lack
 * the basics.
 */
export function mapIntervalsActivity(raw: IcuActivity): Activity | null {
  if (!raw || raw.id == null || !raw.type || !raw.start_date_local) return null;
  if ((raw.source ?? '').toUpperCase() === 'STRAVA') return null;

  const type = raw.type;
  const isRun = isRunActivity({ type });
  const distance = num(raw.distance) ?? num(raw.icu_distance) ?? 0;
  const moving = num(raw.moving_time) ?? num(raw.elapsed_time) ?? num(raw.icu_recording_time) ?? 0;
  const elapsed = num(raw.elapsed_time) ?? num(raw.icu_recording_time) ?? moving;
  const startLocal = toStravaStyleLocal(raw.start_date_local);

  return stripUndefined<Activity>({
    id: toStoreId(raw.id),
    name: raw.name?.trim() || defaultName(type, startLocal),
    type,
    sport_type: type,
    distance,
    moving_time: Math.round(moving),
    elapsed_time: Math.round(elapsed),
    start_date: raw.start_date ? toUtcIso(raw.start_date) : startLocal,
    start_date_local: startLocal,
    kudos_count: 0,
    average_heartrate: positive(raw.average_heartrate),
    max_heartrate: positive(raw.max_heartrate),
    average_speed: positive(raw.average_speed) ?? (moving > 0 && distance > 0 ? distance / moving : undefined),
    max_speed: positive(raw.max_speed),
    total_elevation_gain: num(raw.total_elevation_gain),
    average_cadence: normalizeCadence(raw.average_cadence, isRun),
    training_load: positive(raw.icu_training_load),
    average_watts: positive(raw.icu_average_watts),
    weighted_average_watts: positive(raw.icu_weighted_avg_watts),
    trainer: typeof raw.trainer === 'boolean' ? raw.trainer : undefined,
    device_name: raw.device_name || undefined,
    calories: positive(raw.calories),
    source: 'intervals',
    source_id: String(raw.id),
    origin: raw.source || undefined,
  });
}

// ── Endpoints ─────────────────────────────────────────────────────────────────

export interface ListIntervalsParams {
  /** Local date (YYYY-MM-DD), inclusive. */
  oldest: string;
  /** Local date (YYYY-MM-DD), inclusive. The server defaults to today. */
  newest?: string;
  limit?: number;
  /** Cancels the request (IntervalsAbortError). */
  signal?: AbortSignal;
}

/** Result of {@link listIntervalsActivitiesDetailed}. */
export interface IntervalsActivityList {
  /** Activities Apollo can use, mapped to its model. */
  activities: Activity[];
  /** Rows the API returned, including ones Apollo skips (e.g. Strava-origin). */
  rawCount: number;
  /**
   * IDs of every row the API returned (as `source_id` strings), or null when
   * the response wasn't a list — then nothing can be concluded about deletions.
   */
  rawIds: string[] | null;
}

/**
 * Every activity (all sports) in a local-date window, plus what the API
 * actually returned: the raw row count (an "empty year" means 0 rows, not 0
 * usable rows) and every row ID (remote-deletion reconcile).
 */
export async function listIntervalsActivitiesDetailed(
  params: ListIntervalsParams,
  creds?: IntervalsCredentials | null,
): Promise<IntervalsActivityList> {
  const c = requireCredentials(creds);
  const qs = new URLSearchParams({ oldest: params.oldest, fields: LIST_FIELDS });
  if (params.newest) qs.set('newest', params.newest);
  if (params.limit) qs.set('limit', String(params.limit));
  const raw = await fetchIntervals<IcuActivity[] | null>(`/athlete/${athletePath(c)}/activities?${qs}`, c, {
    signal: params.signal,
  });
  if (!Array.isArray(raw)) return { activities: [], rawCount: 0, rawIds: null };
  const activities: Activity[] = [];
  const rawIds: string[] = [];
  for (const r of raw) {
    if (r && r.id != null) rawIds.push(String(r.id));
    const a = mapIntervalsActivity(r);
    if (a) activities.push(a);
  }
  return { activities, rawCount: raw.length, rawIds };
}

/** Every activity (all sports) in a local-date window, mapped to Apollo's model. */
export async function listIntervalsActivities(
  params: ListIntervalsParams,
  creds?: IntervalsCredentials | null,
): Promise<Activity[]> {
  return (await listIntervalsActivitiesDetailed(params, creds)).activities;
}

interface IcuAthlete {
  id?: string | number | null;
  name?: string | null;
  firstname?: string | null;
  lastname?: string | null;
  profile_medium?: string | null;
}

/** Profile of the athlete that owns the API key (also used to verify a key). */
export async function getIntervalsAthlete(creds?: IntervalsCredentials | null): Promise<AthleteProfile> {
  const c = requireCredentials(creds);
  const raw = await fetchIntervals<IcuAthlete | null>(`/athlete/${athletePath(c)}`, c);
  let first = raw?.firstname?.trim() ?? '';
  let last = raw?.lastname?.trim() ?? '';
  if (!first && !last && raw?.name) {
    const [f, ...rest] = raw.name.trim().split(/\s+/);
    first = f ?? '';
    last = rest.join(' ');
  }
  return {
    id: raw?.id != null && String(raw.id) !== '' ? String(raw.id) : c.athleteId,
    firstname: first || 'Athlete',
    lastname: last,
    profile: raw?.profile_medium || undefined,
    source: 'intervals',
  };
}

export interface IntervalsRoute {
  /** Encoded polyline (≤ 500 points) for lists and effort recognition; '' = no GPS. */
  summaryPolyline: string;
  /** Encoded polyline (≤ 2000 points) for the detail map; '' = no GPS. */
  polyline: string;
  start: LatLngPair | null;
  end: LatLngPair | null;
}

/**
 * GPS route of an activity. Indoor / GPS-less activities return empty polylines.
 * `opts.signal` cancels the request (IntervalsAbortError).
 */
export async function getIntervalsRoute(
  sourceId: string,
  creds?: IntervalsCredentials | null,
  opts: { signal?: AbortSignal } = {},
): Promise<IntervalsRoute> {
  let latlngs: LatLngPair[] = [];
  try {
    const raw = await fetchIntervals<{ latlngs?: unknown } | null>(
      `/activity/${encodeURIComponent(sourceId)}/map`,
      creds,
      { signal: opts.signal },
    );
    latlngs = cleanLatLngs(raw?.latlngs);
  } catch (err) {
    // No map for this activity is "no GPS", not a failure.
    if (!(err instanceof IntervalsHttpError && err.status === 404)) throw err;
  }
  if (latlngs.length < 2) return { summaryPolyline: '', polyline: '', start: null, end: null };
  return {
    summaryPolyline: encodePolyline(decimate(latlngs, SUMMARY_MAX_POINTS)),
    polyline: encodePolyline(decimate(latlngs, DETAIL_MAX_POINTS)),
    start: latlngs[0],
    end: latlngs[latlngs.length - 1],
  };
}

// ── Detail ────────────────────────────────────────────────────────────────────

interface IcuInterval {
  id?: number | null;
  type?: string | null;
  label?: string | null;
  start_index?: number | null;
  end_index?: number | null;
  distance?: number | null;
  moving_time?: number | null;
  elapsed_time?: number | null;
  average_speed?: number | null;
  max_speed?: number | null;
  average_heartrate?: number | null;
  max_heartrate?: number | null;
  average_cadence?: number | null;
  total_elevation_gain?: number | null;
}

interface IcuStream {
  type?: string;
  data?: unknown;
}

type IcuActivityWithIntervals = IcuActivity & { icu_intervals?: IcuInterval[] | null };

/** intervals.icu intervals (device laps or detected work/recovery blocks) → Strava-style laps. */
function toLaps(intervals: IcuInterval[] | null | undefined, isRun: boolean): ActivityLap[] {
  if (!Array.isArray(intervals)) return [];
  let work = 0;
  return intervals.map((iv, i) => {
    const distance = num(iv.distance) ?? 0;
    const moving = num(iv.moving_time) ?? num(iv.elapsed_time) ?? 0;
    const kind = (iv.type ?? '').toUpperCase();
    if (kind === 'WORK') work++;
    const name = iv.label?.trim()
      || (kind === 'WORK' ? `Interval ${work}` : kind === 'RECOVERY' ? 'Recovery' : `Lap ${i + 1}`);
    return stripUndefined<ActivityLap>({
      id: num(iv.id) ?? i + 1,
      name,
      lap_index: i,
      split: i + 1,
      distance,
      elapsed_time: Math.round(num(iv.elapsed_time) ?? moving),
      moving_time: Math.round(moving),
      average_speed: positive(iv.average_speed) ?? (moving > 0 ? distance / moving : 0),
      max_speed: positive(iv.max_speed) ?? 0,
      average_heartrate: positive(iv.average_heartrate),
      max_heartrate: positive(iv.max_heartrate),
      average_cadence: normalizeCadence(iv.average_cadence, isRun),
      total_elevation_gain: num(iv.total_elevation_gain) ?? 0,
      start_index: num(iv.start_index) ?? 0,
      end_index: num(iv.end_index) ?? 0,
    });
  });
}

function streamData(streams: IcuStream[], type: string): unknown[] | null {
  const s = streams.find((x) => x?.type === type);
  return s && Array.isArray(s.data) ? s.data : null;
}

/** Zip time/distance/heartrate/altitude streams into samples for split derivation. */
function toSamples(streams: IcuStream[]): StreamSample[] {
  const time = streamData(streams, 'time');
  const dist = streamData(streams, 'distance');
  if (!time || !dist) return [];
  const hr = streamData(streams, 'heartrate');
  const alt = streamData(streams, 'altitude');
  const out: StreamSample[] = [];
  const n = Math.min(time.length, dist.length);
  for (let i = 0; i < n; i++) {
    const t = time[i];
    const d = dist[i];
    if (typeof t !== 'number' || typeof d !== 'number') continue;
    const sample: StreamSample = { t, d };
    const h = hr?.[i];
    if (typeof h === 'number' && h > 0) sample.hr = h;
    const a = alt?.[i];
    if (typeof a === 'number') sample.alt = a;
    out.push(sample);
  }
  return out;
}

/**
 * Full detail for one activity: refreshed summary, laps, per-km and per-mile
 * splits (derived from the streams) and the GPS route. Sub-requests fail
 * independently — anything missing falls back to the stored summary.
 */
export async function getIntervalsActivityDetail(base: Activity, creds?: IntervalsCredentials | null): Promise<Activity> {
  const c = requireCredentials(creds);
  const id = base.source_id ?? fromStoreId(base.id);
  const path = `/activity/${encodeURIComponent(id)}`;
  const isRun = isRunActivity(base);
  const hasDistance = (base.distance ?? 0) > 0;

  const [summaryRes, streamsRes, routeRes] = await Promise.allSettled([
    fetchIntervals<IcuActivityWithIntervals | null>(`${path}?intervals=true`, c),
    hasDistance
      ? fetchIntervals<IcuStream[] | null>(`${path}/streams.json?types=time,distance,heartrate,altitude`, c)
      : Promise.resolve(null),
    base.trainer || !hasDistance ? Promise.resolve(null) : getIntervalsRoute(id, c),
  ]);

  // A rejected key must surface so the UI can ask the user to reconnect.
  for (const r of [summaryRes, streamsRes, routeRes]) {
    if (r.status === 'rejected' && r.reason instanceof IntervalsAuthError) throw r.reason;
  }
  if (summaryRes.status === 'rejected' && streamsRes.status === 'rejected') throw summaryRes.reason;

  const raw = summaryRes.status === 'fulfilled' ? summaryRes.value : null;
  const mapped = raw ? mapIntervalsActivity(raw) : null;
  const detail: Activity = { ...base, ...(mapped ?? {}), id: base.id };

  let intervals = raw?.icu_intervals;
  if (raw && !Array.isArray(intervals)) {
    try {
      intervals = (await fetchIntervals<{ icu_intervals?: IcuInterval[] } | null>(`${path}/intervals`, c))?.icu_intervals;
    } catch { /* laps are optional */ }
  }
  const laps = toLaps(intervals, isRun);
  if (laps.length) detail.laps = laps;

  if (streamsRes.status === 'fulfilled' && Array.isArray(streamsRes.value)) {
    const samples = toSamples(streamsRes.value);
    if (samples.length > 1) {
      detail.splits_metric = deriveSplits(samples, 1000);
      detail.splits_standard = deriveSplits(samples, 1609.344);
    }
  }

  const route = routeRes.status === 'fulfilled' ? routeRes.value : null;
  if (route?.summaryPolyline) {
    detail.map = { id: `icu-${id}`, summary_polyline: route.summaryPolyline, polyline: route.polyline };
    detail.start_latlng = route.start;
    detail.end_latlng = route.end;
  }
  return detail;
}

// ── Calendar events (planned workouts) ───────────────────────────────────────

/** Event categories Apollo writes (subset of the intervals.icu enum). */
export type IcuEventCategory = 'WORKOUT' | 'NOTE' | 'RACE_A' | 'RACE_B' | 'RACE_C';

/**
 * Planned-event fields Apollo writes (subset of the intervals.icu EventEx
 * schema). intervals.icu parses workout steps from `description`.
 */
export interface IcuEventInput {
  category: IcuEventCategory;
  /** Local start, e.g. "2026-10-12T00:00:00". */
  start_date_local: string;
  /** Sport, e.g. "Run", "Ride", "Workout". */
  type?: string;
  name: string;
  /** Plain-text workout in intervals.icu syntax (plus free-text notes). */
  description?: string;
  /** Planned moving time (s). */
  moving_time?: number;
  /** Caller-defined ID; bulk upserts match on it. */
  external_id?: string;
  /** Which target type to use when the workout is exported to a device. */
  target?: 'AUTO' | 'POWER' | 'HR' | 'PACE';
  indoor?: boolean;
  color?: string;
  tags?: string[];
}

/** Calendar event as returned by intervals.icu (subset of the Event schema). */
export interface IcuEvent {
  id: number;
  category?: string | null;
  start_date_local?: string | null;
  type?: string | null;
  name?: string | null;
  description?: string | null;
  moving_time?: number | null;
  external_id?: string | null;
  /** Problems reported when forwarding the workout to a connected platform. */
  push_errors?: { service?: string | null; message?: string | null; date?: string | null }[] | null;
}

export interface ListIntervalsEventsParams {
  /** Local date (YYYY-MM-DD), inclusive. */
  oldest: string;
  /** Local date (YYYY-MM-DD), inclusive. */
  newest: string;
  /** Only these categories, e.g. "WORKOUT" or ["WORKOUT", "NOTE"]. */
  category?: IcuEventCategory | IcuEventCategory[];
}

/** Max events per bulk request. */
const EVENTS_CHUNK_SIZE = 100;

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Create or update calendar events, matched on `external_id` (required on
 * every event, so retries and repeated pushes never duplicate workouts).
 * Sent in chunks of up to 100; returns the saved events.
 */
export async function upsertIntervalsEvents(
  events: IcuEventInput[],
  creds?: IntervalsCredentials | null,
): Promise<IcuEvent[]> {
  if (events.length === 0) return [];
  if (events.some((e) => !e.external_id)) {
    throw new Error('Every intervals.icu event needs an external_id to be upserted.');
  }
  const c = requireCredentials(creds);
  const qs = new URLSearchParams({ upsert: 'true', upsertOnUid: 'false', updatePlanApplied: 'false' });
  const path = `/athlete/${athletePath(c)}/events/bulk?${qs}`;
  const saved: IcuEvent[] = [];
  for (const chunk of chunks(events, EVENTS_CHUNK_SIZE)) {
    const res = await sendIntervals<IcuEvent[] | null>('POST', path, chunk, c, { idempotent: true });
    if (Array.isArray(res)) saved.push(...res);
  }
  return saved;
}

/**
 * Delete calendar events by `external_id`. intervals.icu only deletes events
 * created with the same credentials and ignores IDs that don't exist.
 * Returns the number of events deleted.
 */
export async function deleteIntervalsEventsByExternalId(
  externalIds: string[],
  creds?: IntervalsCredentials | null,
): Promise<number> {
  const ids = [...new Set(externalIds.filter((id) => !!id))];
  if (ids.length === 0) return 0;
  const c = requireCredentials(creds);
  const path = `/athlete/${athletePath(c)}/events/bulk-delete`;
  let deleted = 0;
  for (const chunk of chunks(ids, EVENTS_CHUNK_SIZE)) {
    const res = await sendIntervals<{ eventsDeleted?: number | null } | null>(
      'PUT', path, chunk.map((external_id) => ({ external_id })), c,
    );
    deleted += typeof res?.eventsDeleted === 'number' ? res.eventsDeleted : chunk.length;
  }
  return deleted;
}

/** Calendar events (planned workouts, notes, races…) in a local-date window. */
export async function listIntervalsEvents(
  params: ListIntervalsEventsParams,
  creds?: IntervalsCredentials | null,
): Promise<IcuEvent[]> {
  const c = requireCredentials(creds);
  const qs = new URLSearchParams({ oldest: params.oldest, newest: params.newest });
  const category = Array.isArray(params.category) ? params.category.join(',') : params.category;
  if (category) qs.set('category', category);
  const raw = await fetchIntervals<IcuEvent[] | null>(`/athlete/${athletePath(c)}/events?${qs}`, c);
  return Array.isArray(raw) ? raw : [];
}

// ── Wellness & sport settings ─────────────────────────────────────────────────

/**
 * One day of wellness data (subset of the intervals.icu Wellness schema).
 * Garmin, COROS, Oura, Whoop, Polar, Suunto and others push sleep, HRV and
 * resting HR into it. `id` is the local date (YYYY-MM-DD).
 *
 * Self-reported scores use intervals.icu's scales: soreness, fatigue and
 * stress 1 = low … 4 = extreme; sleepQuality and mood 1 = excellent … 4 = poor.
 */
export interface IcuWellness {
  id: string;
  /** When the record last changed (ISO date-time). */
  updated?: string | null;
  restingHR?: number | null;
  /** Overnight HRV as rMSSD (ms). */
  hrv?: number | null;
  hrvSDNN?: number | null;
  sleepSecs?: number | null;
  /** Device sleep score (0–100). */
  sleepScore?: number | null;
  sleepQuality?: number | null;
  avgSleepingHR?: number | null;
  /** Device readiness / recovery score. */
  readiness?: number | null;
  weight?: number | null;
  vo2max?: number | null;
  steps?: number | null;
  soreness?: number | null;
  fatigue?: number | null;
  stress?: number | null;
  mood?: number | null;
  /** True when restingHR was copied from the athlete's settings rather than measured. */
  tempRestingHR?: boolean | null;
  /** True when weight was copied from the athlete's settings rather than measured. */
  tempWeight?: boolean | null;
}

export interface ListIntervalsWellnessParams {
  /** Local date (YYYY-MM-DD), inclusive. */
  oldest: string;
  /** Local date (YYYY-MM-DD), inclusive. */
  newest: string;
}

/** Fields requested from the wellness endpoint (intervals.icu also drops null values). */
const WELLNESS_FIELDS = [
  'id', 'updated', 'restingHR', 'hrv', 'hrvSDNN', 'sleepSecs', 'sleepScore', 'sleepQuality',
  'avgSleepingHR', 'readiness', 'weight', 'vo2max', 'steps', 'soreness', 'fatigue', 'stress',
  'mood', 'tempRestingHR', 'tempWeight',
].join(',');

/** Daily wellness records (sleep, HRV, resting HR…) in a local-date window. */
export async function fetchIntervalsWellness(
  params: ListIntervalsWellnessParams,
  creds?: IntervalsCredentials | null,
): Promise<IcuWellness[]> {
  const c = requireCredentials(creds);
  const qs = new URLSearchParams({ oldest: params.oldest, newest: params.newest, fields: WELLNESS_FIELDS });
  const raw = await fetchIntervals<unknown>(`/athlete/${athletePath(c)}/wellness?${qs}`, c);
  if (!Array.isArray(raw)) return [];
  return raw.filter((r): r is IcuWellness =>
    !!r && typeof r === 'object' && typeof (r as { id?: unknown }).id === 'string');
}

/** Per-sport settings (subset of the intervals.icu SportSettings schema). */
export interface IcuSportSettings {
  id?: number | null;
  /** Activity types the settings apply to, e.g. ["Run", "VirtualRun", "TrailRun"]. */
  types?: string[] | null;
  /** Lactate threshold heart rate (bpm). */
  lthr?: number | null;
  max_hr?: number | null;
  /**
   * Threshold pace in metres per second: intervals.icu's storage unit, whatever
   * `pace_units` (the display unit) says. Absent or 0 when not set.
   */
  threshold_pace?: number | null;
  /** Display unit for paces, e.g. "MINS_KM" or "MINS_MILE". */
  pace_units?: string | null;
}

/** The athlete's per-sport settings (thresholds, max HR, zones…). */
export async function fetchIntervalsSportSettings(creds?: IntervalsCredentials | null): Promise<IcuSportSettings[]> {
  const c = requireCredentials(creds);
  const raw = await fetchIntervals<unknown>(`/athlete/${athletePath(c)}/sport-settings`, c);
  if (!Array.isArray(raw)) return [];
  return raw.filter((s): s is IcuSportSettings => !!s && typeof s === 'object' && !Array.isArray(s));
}
