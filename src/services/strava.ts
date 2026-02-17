/**
 * Strava API client — handles token refresh, authenticated requests,
 * and typed wrappers for athlete/activity endpoints.
 */

import { getStravaTokens, setStravaTokens, getStravaCredentials, type StravaTokens } from './storage';
import { refreshStravaToken, isWeb } from './stravaWeb';

const STRAVA_API = 'https://www.strava.com/api/v3';

/** Check whether an OAuth token has expired (with a safety buffer). */
function isExpired(expiresAt: number, bufferSeconds = 300): boolean {
  return Date.now() / 1000 >= expiresAt - bufferSeconds;
}

/** Ensure we have a valid access token, refreshing if needed. */
async function ensureAccessToken(): Promise<string> {
  let tokens = getStravaTokens();
  if (!tokens) throw new Error('Not connected to Strava. Connect in Settings.');

  if (isExpired(tokens.expires_at)) {
    if (isWeb()) {
      const refreshed = await refreshStravaToken(tokens.refresh_token);
      const newTokens: StravaTokens = {
        ...tokens,
        access_token: refreshed.access_token,
        refresh_token: refreshed.refresh_token,
        expires_at: refreshed.expires_at,
      };
      setStravaTokens(newTokens);
      tokens = newTokens;
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
      tokens = newTokens;
    }
  }
  return tokens.access_token;
}

/** Authenticated fetch wrapper for the Strava API. Handles token injection. */
export async function fetchStrava<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = await ensureAccessToken();
  const res = await fetch(`${STRAVA_API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.headers as Record<string, string>),
    },
  });
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
