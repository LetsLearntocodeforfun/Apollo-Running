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
  // Placeholder: Garmin Activity API base URL and endpoints depend on your approved APIs.
  // Example: GET https://connectapi.garmin.com/activity-api/activities
  // You will need to implement PKCE flow in electron/main and store tokens, then call their REST API here.
  return [];
}

export function isGarminConfigured(): boolean {
  return !!getGarminCredentials()?.clientId && !!getGarminTokens();
}
