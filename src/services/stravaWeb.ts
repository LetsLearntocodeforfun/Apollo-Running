/**
 * Strava API helpers for web (no Electron): call our backend to refresh tokens.
 */

const API = '/api';

export async function getStravaAuthUrl(): Promise<string> {
  const res = await fetch(`${API}/strava-auth-url`);
  if (!res.ok) throw new Error('Could not get Strava auth URL');
  const data = await res.json();
  if (!data?.url) throw new Error('Invalid auth URL response');
  return data.url;
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
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error || 'Token exchange failed');
  return data;
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
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error || 'Token refresh failed');
  return data;
}

export function isWeb(): boolean {
  return typeof window !== 'undefined' && !(window as unknown as { electronAPI?: unknown }).electronAPI;
}
