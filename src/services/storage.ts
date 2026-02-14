const STRAVA_KEY = 'strava_tokens';
const GARMIN_KEY = 'garmin_tokens';
const STRAVA_CREDENTIALS = 'strava_credentials';
const GARMIN_CREDENTIALS = 'garmin_credentials';

export interface StravaTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  athlete: { id: number; firstname: string; lastname: string; profile?: string };
}

export interface GarminTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number;
}

export function getStravaTokens(): StravaTokens | null {
  try {
    const raw = localStorage.getItem(STRAVA_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function setStravaTokens(t: StravaTokens): void {
  localStorage.setItem(STRAVA_KEY, JSON.stringify(t));
}

export function clearStravaTokens(): void {
  localStorage.removeItem(STRAVA_KEY);
}

export function getGarminTokens(): GarminTokens | null {
  try {
    const raw = localStorage.getItem(GARMIN_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function setGarminTokens(t: GarminTokens): void {
  localStorage.setItem(GARMIN_KEY, JSON.stringify(t));
}

export function clearGarminTokens(): void {
  localStorage.removeItem(GARMIN_KEY);
}

export function getStravaCredentials(): { clientId: string; clientSecret: string } | null {
  try {
    const raw = localStorage.getItem(STRAVA_CREDENTIALS);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function setStravaCredentials(clientId: string, clientSecret: string): void {
  localStorage.setItem(STRAVA_CREDENTIALS, JSON.stringify({ clientId, clientSecret }));
}

export function getGarminCredentials(): { clientId: string; clientSecret: string } | null {
  try {
    const raw = localStorage.getItem(GARMIN_CREDENTIALS);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function setGarminCredentials(clientId: string, clientSecret: string): void {
  localStorage.setItem(GARMIN_CREDENTIALS, JSON.stringify({ clientId, clientSecret }));
}
