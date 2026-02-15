import { getStravaTokens, setStravaTokens, getStravaCredentials, type StravaTokens } from './storage';
import { refreshStravaToken, isWeb } from './stravaWeb';

const STRAVA_API = 'https://www.strava.com/api/v3';

function isExpired(expiresAt: number, bufferSeconds = 300): boolean {
  return Date.now() / 1000 >= expiresAt - bufferSeconds;
}

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
}

export interface StravaAthlete {
  id: number;
  firstname: string;
  lastname: string;
  profile: string;
}

export function getActivities(params: { page?: number; per_page?: number; after?: number } = {}): Promise<StravaActivity[]> {
  const search = new URLSearchParams();
  if (params.page != null) search.set('page', String(params.page));
  if (params.per_page != null) search.set('per_page', String(params.per_page));
  if (params.after != null) search.set('after', String(params.after));
  const qs = search.toString();
  return fetchStrava<StravaActivity[]>(`/athlete/activities${qs ? `?${qs}` : ''}`);
}

export function getAthlete(): Promise<StravaAthlete> {
  return fetchStrava<StravaAthlete>('/athlete');
}

export function getActivity(id: number): Promise<StravaActivity> {
  return fetchStrava<StravaActivity>(`/activities/${id}`);
}
