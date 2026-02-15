/**
 * Strava API helpers for web (no Electron): call our backend to refresh tokens.
 */

const API = '/api';

async function parseApiResponse(res: Response): Promise<unknown> {
  const text = await res.text().catch(() => '');
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function getApiErrorMessage(data: unknown, fallback: string): string {
  if (typeof data === 'string' && data.trim()) return data;
  if (data && typeof data === 'object' && 'error' in data) {
    const err = (data as { error?: unknown }).error;
    if (typeof err === 'string' && err.trim()) return err;
  }
  return fallback;
}

export async function getStravaAuthUrl(): Promise<string> {
  const res = await fetch(`${API}/strava-auth-url`);
  const data = await parseApiResponse(res);
  if (!res.ok) throw new Error(getApiErrorMessage(data, `Could not get Strava auth URL (${res.status})`));
  if (!data || typeof data !== 'object' || typeof (data as { url?: unknown }).url !== 'string') {
    throw new Error('Invalid auth URL response');
  }
  return (data as { url: string }).url;
}

export async function exchangeStravaCode(code: string): Promise<{
  access_token: string;
  refresh_token: string;
  expires_at: number;
  athlete: { id: number; firstname: string; lastname: string; profile?: string };
}> {
  const res = await fetch(`${API}/strava-exchange`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  const data = await parseApiResponse(res);
  if (!res.ok) throw new Error(getApiErrorMessage(data, `Token exchange failed (${res.status})`));
  if (!data || typeof data !== 'object') throw new Error('Invalid token exchange response');
  return data as {
    access_token: string;
    refresh_token: string;
    expires_at: number;
    athlete: { id: number; firstname: string; lastname: string; profile?: string };
  };
}

export async function refreshStravaToken(refreshToken: string): Promise<{
  access_token: string;
  refresh_token: string;
  expires_at: number;
}> {
  const res = await fetch(`${API}/strava-refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: refreshToken }),
  });
  const data = await parseApiResponse(res);
  if (!res.ok) throw new Error(getApiErrorMessage(data, `Token refresh failed (${res.status})`));
  if (!data || typeof data !== 'object') throw new Error('Invalid token refresh response');
  return data as {
    access_token: string;
    refresh_token: string;
    expires_at: number;
  };
}

export function isWeb(): boolean {
  return typeof window !== 'undefined' && !(window as unknown as { electronAPI?: unknown }).electronAPI;
}
