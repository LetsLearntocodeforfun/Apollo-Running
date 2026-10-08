// Strava API client — token refresh, rate limiting, typed endpoint wrappers.

import { getStravaTokens, setStravaTokens, getStravaCredentials, type StravaTokens } from './storage';
import { refreshStravaToken, isWeb } from './stravaWeb';
import { setNeedsReconnect } from './connectionHealth';
import type { Activity, ActivityLap, ActivitySplit } from './activity/types';

const STRAVA_API = 'https://www.strava.com/api/v3';

// ─── Rate Limiter ────────────────────────────────────────────
// Strava enforces: 100 requests / 15 min, 1 000 requests / day.
// We track timestamps of each request and reject before hitting limits.

const RATE_LIMIT_15MIN = 95;   // leave 5-request buffer
const RATE_LIMIT_DAILY = 950;  // leave 50-request buffer
const FIFTEEN_MIN_MS = 15 * 60 * 1000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

const requestTimestamps: number[] = [];

function pruneTimestamps(): void {
  const cutoff = Date.now() - ONE_DAY_MS;
  const idx = requestTimestamps.findIndex((t) => t >= cutoff);
  if (idx > 0) {
    requestTimestamps.splice(0, idx);
  } else if (idx === -1 && requestTimestamps.length > 0) {
    requestTimestamps.length = 0;
  }
}

function checkRateLimit(): void {
  pruneTimestamps();
  const now = Date.now();
  const recentCount = requestTimestamps.filter((t) => t > now - FIFTEEN_MIN_MS).length;
  if (recentCount >= RATE_LIMIT_15MIN) {
    throw new Error('Approaching Strava rate limit (100 requests / 15 min). Please wait a few minutes before syncing again.');
  }
  if (requestTimestamps.length >= RATE_LIMIT_DAILY) {
    throw new Error('Approaching Strava daily rate limit (1,000 requests / day). Try again tomorrow.');
  }
}

function recordRequest(): void {
  requestTimestamps.push(Date.now());
}

/** Expose rate usage for UI feedback. */
export function getRateLimitStatus(): { recent15Min: number; daily: number; limit15Min: number; limitDaily: number } {
  pruneTimestamps();
  const now = Date.now();
  return {
    recent15Min: requestTimestamps.filter((t) => t > now - FIFTEEN_MIN_MS).length,
    daily: requestTimestamps.length,
    limit15Min: RATE_LIMIT_15MIN,
    limitDaily: RATE_LIMIT_DAILY,
  };
}

// ─── Errors ──────────────────────────────────────────────────

/**
 * Strava rejected the stored tokens (HTTP 401/403, or the refresh token no
 * longer works — e.g. the athlete revoked access). The athlete must reconnect.
 */
export class StravaAuthError extends Error {
  constructor(message: string = 'Strava access was revoked or expired. Reconnect Strava in Settings.') {
    super(message);
    this.name = 'StravaAuthError';
  }
}

/** How long one Strava request (including reading the body) may take. */
const REQUEST_TIMEOUT_MS = 30_000;

/** Flag Strava as needing reconnect and build the error to throw. */
function rejectedTokens(message?: string): StravaAuthError {
  const err = new StravaAuthError(message);
  try { setNeedsReconnect('strava', err.message); } catch { /* best-effort */ }
  return err;
}

/** HTTP status of a failed token refresh, if the error carries one. */
function refreshFailureStatus(err: unknown): number | null {
  const status = (err as { status?: unknown } | null)?.status;
  if (typeof status === 'number') return status;
  // Electron's IPC handler throws "Refresh failed: <status>".
  const m = /Refresh failed: (\d{3})/.exec(err instanceof Error ? err.message : String(err));
  return m ? Number(m[1]) : null;
}

/**
 * Settle with `promise`, or reject with an AbortError once `signal` aborts —
 * even if the promise never settles (stalled body, signal-ignoring fetch).
 */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      const err = new Error('Strava did not respond in time. Check your connection and try again.');
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

// ─── Token Refresh Mutex ─────────────────────────────────────
// Prevents concurrent refresh attempts from racing each other.

let refreshInFlight: Promise<string> | null = null;

/** Check whether an OAuth token has expired (with a safety buffer). */
function isExpired(expiresAt: number, bufferSeconds = 300): boolean {
  return Date.now() / 1000 >= expiresAt - bufferSeconds;
}

/** Perform the actual token refresh (called only from the mutex). */
async function doRefresh(tokens: StravaTokens): Promise<string> {
  try {
    return await doRefreshUnchecked(tokens);
  } catch (err) {
    // 400/401/403 from the token endpoint: the refresh token itself was rejected.
    const status = refreshFailureStatus(err);
    if (status === 400 || status === 401 || status === 403) throw rejectedTokens();
    throw err;
  }
}

async function doRefreshUnchecked(tokens: StravaTokens): Promise<string> {
  if (isWeb()) {
    const refreshed = await refreshStravaToken(tokens.refresh_token);
    const newTokens: StravaTokens = {
      ...tokens,
      access_token: refreshed.access_token,
      refresh_token: refreshed.refresh_token,
      expires_at: refreshed.expires_at,
    };
    setStravaTokens(newTokens);
    return newTokens.access_token;
  } else {
    const creds = getStravaCredentials();
    if (!creds) throw new Error('Strava credentials not set. Add Client ID and Secret in Settings.');
    const api = window.electronAPI;
    if (!api) throw new Error('Electron API not available');
    const refreshed = await api.strava.refreshToken({
      clientId: creds.clientId,
      clientSecret: creds.clientSecret,
      refreshToken: tokens.refresh_token,
    });
    const newTokens: StravaTokens = {
      ...tokens,
      access_token: refreshed.access_token,
      refresh_token: refreshed.refresh_token,
      expires_at: refreshed.expires_at,
    };
    setStravaTokens(newTokens);
    return newTokens.access_token;
  }
}

/** Ensure we have a valid access token, refreshing if needed (mutex-protected). */
async function ensureAccessToken(): Promise<string> {
  const tokens = getStravaTokens();
  if (!tokens) throw new Error('Not connected to Strava. Connect in Settings.');

  if (!isExpired(tokens.expires_at)) return tokens.access_token;

  // If a refresh is already in progress, wait for it
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = doRefresh(tokens).finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

/**
 * Authenticated fetch wrapper for the Strava API. Handles token injection,
 * rate limiting and a 30 s timeout (combined with `options.signal`).
 * 401/403 → StravaAuthError (and Strava is flagged as needing reconnect).
 */
export async function fetchStrava<T>(path: string, options: RequestInit = {}): Promise<T> {
  checkRateLimit();
  const token = await ensureAccessToken();
  recordRequest();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const external = options.signal ?? null;
  const onExternalAbort = () => controller.abort();
  if (external?.aborted) controller.abort();
  else external?.addEventListener('abort', onExternalAbort, { once: true });

  try {
    const res = await untilAborted(fetch(`${STRAVA_API}${path}`, {
      ...options,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(options.headers as Record<string, string>),
      },
    }), controller.signal);

    // Read Strava's rate limit headers for observability
    const usage15 = res.headers.get('X-RateLimit-Usage');
    if (usage15) {
      const [short, daily] = usage15.split(',').map(Number);
      if (short >= 90 || daily >= 900) {
        console.warn(`[Strava] Rate limit warning — 15-min: ${short}/100, daily: ${daily}/1000`);
      }
    }

    if (res.status === 401 || res.status === 403) throw rejectedTokens();
    if (res.status === 429) {
      throw new Error('Strava rate limit exceeded. Please wait before making more requests.');
    }
    if (!res.ok) {
      const err = await untilAborted(res.text(), controller.signal).catch(() => '');
      throw new Error(err || `Strava API ${res.status}`);
    }
    return await untilAborted(res.json() as Promise<T>, controller.signal);
  } catch (err) {
    if (external?.aborted && err instanceof Error && err.name === 'AbortError') {
      const cancelled = new Error('Sync was cancelled.');
      cancelled.name = 'AbortError';
      throw cancelled;
    }
    throw err;
  } finally {
    clearTimeout(timer);
    external?.removeEventListener('abort', onExternalAbort);
  }
}

/**
 * Strava's activity JSON is the canonical shape for every source, so these are
 * aliases of the shared model in ./activity/types (kept for existing imports).
 */
/** A single split (per-km or per-mile) returned by the Strava detail endpoint. */
export type StravaSplit = ActivitySplit;

/** A lap recorded by the device or manually created. */
export type StravaLap = ActivityLap;

export type StravaActivity = Activity;

export interface StravaAthlete {
  id: number;
  firstname: string;
  lastname: string;
  profile: string;
}

/**
 * Fetch a page of the authenticated athlete's activities.
 * `opts.signal` cancels the request (sync cancel / watchdog).
 */
export function getActivities(
  params: { page?: number; per_page?: number; after?: number } = {},
  opts: { signal?: AbortSignal } = {},
): Promise<StravaActivity[]> {
  const search = new URLSearchParams();
  if (params.page != null) search.set('page', String(params.page));
  if (params.per_page != null) search.set('per_page', String(params.per_page));
  if (params.after != null) search.set('after', String(params.after));
  const qs = search.toString();
  return fetchStrava<StravaActivity[]>(`/athlete/activities${qs ? `?${qs}` : ''}`, opts.signal ? { signal: opts.signal } : {});
}

/** Fetch the authenticated athlete's profile. */
export function getAthlete(): Promise<StravaAthlete> {
  return fetchStrava<StravaAthlete>('/athlete');
}

/** Fetch a single activity by ID (list-level fields only). */
export function getActivity(id: number): Promise<StravaActivity> {
  return fetchStrava<StravaActivity>(`/activities/${id}`);
}

/**
 * Fetch a single activity with full detail — includes splits_metric,
 * splits_standard, and laps arrays that are NOT returned by the list endpoint.
 * Use this when the user expands an activity to see split-level data.
 */
export function getActivityDetail(id: number): Promise<StravaActivity> {
  return fetchStrava<StravaActivity>(`/activities/${id}?include_all_efforts=false`);
}
