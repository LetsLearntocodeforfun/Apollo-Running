/**
 * Strava API client — handles token refresh, authenticated requests,
 * and typed wrappers for athlete/activity endpoints.
 */

import { getStravaTokens, setStravaTokens, getStravaCredentials, type StravaTokens } from './storage';
import { refreshStravaToken, isWeb } from './stravaWeb';

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
  while (requestTimestamps.length > 0 && requestTimestamps[0] < cutoff) {
    requestTimestamps.shift();
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

// ─── Token Refresh Mutex ─────────────────────────────────────
// Prevents concurrent refresh attempts from racing each other.

let refreshInFlight: Promise<string> | null = null;

/** Check whether an OAuth token has expired (with a safety buffer). */
function isExpired(expiresAt: number, bufferSeconds = 300): boolean {
  return Date.now() / 1000 >= expiresAt - bufferSeconds;
}

/** Perform the actual token refresh (called only from the mutex). */
async function doRefresh(tokens: StravaTokens): Promise<string> {
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

/** Authenticated fetch wrapper for the Strava API. Handles token injection and rate limiting. */
export async function fetchStrava<T>(path: string, options: RequestInit = {}): Promise<T> {
  checkRateLimit();
  const token = await ensureAccessToken();
  recordRequest();
  const res = await fetch(`${STRAVA_API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.headers as Record<string, string>),
    },
  });

  // Read Strava's rate limit headers for observability
  const usage15 = res.headers.get('X-RateLimit-Usage');
  if (usage15) {
    const [short, daily] = usage15.split(',').map(Number);
    if (short >= 90 || daily >= 900) {
      console.warn(`[Strava] Rate limit warning — 15-min: ${short}/100, daily: ${daily}/1000`);
    }
  }

  if (res.status === 429) {
    throw new Error('Strava rate limit exceeded. Please wait before making more requests.');
  }
  if (!res.ok) {
    const err = await res.text();
    throw new Error(err || `Strava API ${res.status}`);
  }
  return res.json();
}

/** A single split (per-km or per-mile) returned by the Strava detail endpoint. */
export interface StravaSplit {
  distance: number;            // meters
  elapsed_time: number;        // seconds
  moving_time: number;         // seconds
  average_speed: number;       // m/s
  average_heartrate?: number;  // bpm (may be absent)
  elevation_difference: number; // meters (+ or -)
  split: number;               // 1-indexed split number
  pace_zone?: number;          // Strava pace zone (0-based)
}

/** A lap recorded by the device or manually created. */
export interface StravaLap {
  id: number;
  name: string;
  lap_index: number;           // 0-indexed
  split: number;               // 1-indexed split number
  distance: number;            // meters
  elapsed_time: number;        // seconds
  moving_time: number;         // seconds
  average_speed: number;       // m/s
  max_speed: number;           // m/s
  average_heartrate?: number;  // bpm
  max_heartrate?: number;      // bpm
  average_cadence?: number;    // strides/min (multiply by 2 for steps)
  total_elevation_gain: number; // meters
  start_index: number;
  end_index: number;
  pace_zone?: number;
}

export interface StravaActivity {
  id: number;
  name: string;
  type: string;
  sport_type: string;
  distance: number;
  moving_time: number;
  elapsed_time: number;
  start_date: string;
  start_date_local: string;
  average_heartrate?: number;
  max_heartrate?: number;
  average_speed?: number;
  max_speed?: number;
  total_elevation_gain?: number;
  average_cadence?: number;
  suffer_score?: number;
  kudos_count: number;
  start_latlng?: [number, number] | null;
  end_latlng?: [number, number] | null;
  map?: {
    id: string;
    summary_polyline: string | null;
    polyline?: string | null;
  } | null;
  /** Per-km splits — only present on detailed fetch */
  splits_metric?: StravaSplit[];
  /** Per-mile splits — only present on detailed fetch */
  splits_standard?: StravaSplit[];
  /** Laps — only present on detailed fetch */
  laps?: StravaLap[];
}

export interface StravaAthlete {
  id: number;
  firstname: string;
  lastname: string;
  profile: string;
}

/** Fetch a page of the authenticated athlete's activities. */
export function getActivities(params: { page?: number; per_page?: number; after?: number } = {}): Promise<StravaActivity[]> {
  const search = new URLSearchParams();
  if (params.page != null) search.set('page', String(params.page));
  if (params.per_page != null) search.set('per_page', String(params.per_page));
  if (params.after != null) search.set('after', String(params.after));
  const qs = search.toString();
  return fetchStrava<StravaActivity[]>(`/athlete/activities${qs ? `?${qs}` : ''}`);
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
