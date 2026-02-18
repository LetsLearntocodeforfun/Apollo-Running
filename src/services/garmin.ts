import { getGarminTokens, getGarminCredentials } from './storage';

// Garmin Connect uses OAuth 2.0 with PKCE. You must apply for the Garmin Connect Developer Program:
// https://developer.garmin.com/gc-developer-program/
// Once approved you get: Health API, Activity API, Women's Health API, Training API, Courses API.

export async function getGarminActivities(_params: { limit?: number; offset?: number } = {}): Promise<unknown[]> {
  const tokens = getGarminTokens();
  const creds = getGarminCredentials();
  if (!creds || !tokens) {
    return [];
  }
  // Garmin Connect APIs require approved developer access and API-specific endpoints.
  // Until that access is available, keep the integration in a safe no-op state.
  console.info('[Apollo Garmin] Garmin account is configured, but activity sync is not enabled in this build.');
  return [];
}

export function isGarminConfigured(): boolean {
  return !!getGarminCredentials()?.clientId && !!getGarminTokens();
}
