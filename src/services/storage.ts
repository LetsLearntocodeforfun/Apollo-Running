/**
 * Credential and token persistence layer.
 * All auth tokens and API credentials are stored via the persistence service
 * (IndexedDB primary, localStorage fallback).
 */

import { persistence } from './db/persistence';

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

/** Retrieve stored Strava OAuth tokens, or null if not connected. */
export function getStravaTokens(): StravaTokens | null {
  try {
    const raw = persistence.getItem(STRAVA_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/** Persist Strava OAuth tokens after authentication or refresh. */
export function setStravaTokens(t: StravaTokens): void {
  persistence.setItem(STRAVA_KEY, JSON.stringify(t));
}

/** Remove Strava tokens (disconnect). */
export function clearStravaTokens(): void {
  persistence.removeItem(STRAVA_KEY);
}

/** Retrieve stored Garmin OAuth tokens, or null if not connected. */
export function getGarminTokens(): GarminTokens | null {
  try {
    const raw = persistence.getItem(GARMIN_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/** Persist Garmin OAuth tokens. */
export function setGarminTokens(t: GarminTokens): void {
  persistence.setItem(GARMIN_KEY, JSON.stringify(t));
}

/** Remove Garmin tokens (disconnect). */
export function clearGarminTokens(): void {
  persistence.removeItem(GARMIN_KEY);
}

/** Retrieve stored Strava API credentials (Client ID + Secret). */
export function getStravaCredentials(): { clientId: string; clientSecret: string } | null {
  try {
    const raw = persistence.getItem(STRAVA_CREDENTIALS);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/** Persist Strava API credentials for Electron OAuth flow. */
export function setStravaCredentials(clientId: string, clientSecret: string): void {
  persistence.setItem(STRAVA_CREDENTIALS, JSON.stringify({ clientId, clientSecret }));
}

/** Retrieve stored Garmin API credentials. */
export function getGarminCredentials(): { clientId: string; clientSecret: string } | null {
  try {
    const raw = persistence.getItem(GARMIN_CREDENTIALS);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/** Persist Garmin API credentials. */
export function setGarminCredentials(clientId: string, clientSecret: string): void {
  persistence.setItem(GARMIN_CREDENTIALS, JSON.stringify({ clientId, clientSecret }));
}
