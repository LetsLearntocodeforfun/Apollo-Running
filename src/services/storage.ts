/**
 * Credential and token persistence layer.
 *
 * Security model:
 *   - **Electron**: Sensitive credentials (client secrets, OAuth tokens) are
 *     encrypted at rest using the OS keychain via Electron's safeStorage API
 *     and stored in a separate file in the app's userData directory. This
 *     protects against localStorage/XSS-based credential theft.
 *   - **Web**: Client secrets are NEVER stored in the browser. The frontend
 *     only holds short-lived access tokens; refresh/exchange flows go through
 *     the Azure Functions backend (BFF pattern). The setStravaCredentials and
 *     setGarminCredentials functions are no-ops on web.
 *   - **Non-sensitive data** continues to flow through the persistence service
 *     (IndexedDB primary, localStorage fallback).
 *
 * Migration: On first run in Electron, any existing plaintext credentials in
 * persistence/localStorage are automatically migrated to secure storage and
 * the plaintext copies are removed.
 */

import { persistence } from './db/persistence';

const STRAVA_KEY = 'strava_tokens';
const GARMIN_KEY = 'garmin_tokens';
const STRAVA_CREDENTIALS = 'strava_credentials';
const GARMIN_CREDENTIALS = 'garmin_credentials';

/** Keys that hold sensitive data and should use encrypted storage in Electron */
const SENSITIVE_KEYS = new Set([STRAVA_KEY, GARMIN_KEY, STRAVA_CREDENTIALS, GARMIN_CREDENTIALS]);

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

// ── Environment Detection ─────────────────────────────────────────────────────

function isElectron(): boolean {
  return typeof window !== 'undefined' && !!window.electronAPI;
}

function isWeb(): boolean {
  return typeof window !== 'undefined' && !window.electronAPI;
}

// ── Secure Storage Helpers (Electron only) ────────────────────────────────────
// These are async because they go through IPC. We maintain an in-memory cache
// to provide synchronous reads (same as the persistence layer pattern).

const secureCache = new Map<string, string>();
let secureMigrationDone = false;

/**
 * Migrate plaintext credentials from persistence/localStorage to encrypted
 * storage. Runs once on app startup in Electron. Removes plaintext copies.
 */
async function migrateToSecureStorage(): Promise<void> {
  if (secureMigrationDone || !isElectron()) return;
  secureMigrationDone = true;

  const api = window.electronAPI!;
  for (const key of SENSITIVE_KEYS) {
    // Check if there's already a secure copy
    const existing = await api.secureStorage.get(key);
    if (existing) {
      // Populate cache from secure storage
      secureCache.set(key, existing);
      // Remove plaintext copy if it exists
      persistence.removeItem(key);
      continue;
    }

    // Check for plaintext in persistence (legacy)
    const plaintext = persistence.getItem(key);
    if (plaintext) {
      // Migrate to secure storage
      await api.secureStorage.set(key, plaintext);
      secureCache.set(key, plaintext);
      // Remove the plaintext copy
      persistence.removeItem(key);
      // Also remove from raw localStorage as extra safety
      try { localStorage.removeItem(key); } catch { /* ignore */ }
      console.info(`[Apollo] Migrated ${key} to secure storage`);
    }
  }
}

/** Bootstrap: load all secure credentials into memory cache */
async function loadSecureCredentials(): Promise<void> {
  if (!isElectron()) return;
  const api = window.electronAPI!;
  for (const key of SENSITIVE_KEYS) {
    try {
      const value = await api.secureStorage.get(key);
      if (value) secureCache.set(key, value);
    } catch {
      // Individual key failure is non-fatal
    }
  }
}

/** Initialize secure storage: migrate legacy data, then load into cache */
export async function initSecureStorage(): Promise<void> {
  if (!isElectron()) return;
  await migrateToSecureStorage();
  await loadSecureCredentials();
}

// Run initialization on module load in Electron (non-blocking)
if (typeof window !== 'undefined' && window.electronAPI) {
  initSecureStorage().catch((err) =>
    console.warn('[Apollo] Secure storage init failed, falling back to persistence:', err),
  );
}

// ── Synchronous Read Helpers ──────────────────────────────────────────────────

/** Read a sensitive value: secure cache (Electron) or persistence (web) */
function getSecure(key: string): string | null {
  if (isElectron()) {
    return secureCache.get(key) ?? null;
  }
  return persistence.getItem(key);
}

/** Write a sensitive value: secure storage (Electron) or persistence (web) */
function setSecure(key: string, value: string): void {
  if (isElectron()) {
    secureCache.set(key, value);
    // Async write to encrypted storage (fire-and-forget)
    window.electronAPI!.secureStorage.set(key, value).catch((err) =>
      console.error(`[Apollo] Failed to encrypt ${key}:`, err),
    );
    // Do NOT write to persistence/localStorage for sensitive data
    return;
  }
  // Web fallback: tokens only (credentials should go through BFF)
  persistence.setItem(key, value);
}

/** Remove a sensitive value from all storage layers */
function removeSecure(key: string): void {
  secureCache.delete(key);
  if (isElectron()) {
    window.electronAPI!.secureStorage.remove(key).catch(() => {});
  }
  // Always clean up any legacy plaintext copies
  persistence.removeItem(key);
  try { localStorage.removeItem(key); } catch { /* ignore */ }
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Retrieve stored Strava OAuth tokens, or null if not connected. */
export function getStravaTokens(): StravaTokens | null {
  try {
    const raw = getSecure(STRAVA_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/** Persist Strava OAuth tokens after authentication or refresh. */
export function setStravaTokens(t: StravaTokens): void {
  setSecure(STRAVA_KEY, JSON.stringify(t));
}

/** Remove Strava tokens (disconnect). */
export function clearStravaTokens(): void {
  removeSecure(STRAVA_KEY);
}

/** Retrieve stored Garmin OAuth tokens, or null if not connected. */
export function getGarminTokens(): GarminTokens | null {
  try {
    const raw = getSecure(GARMIN_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/** Persist Garmin OAuth tokens. */
export function setGarminTokens(t: GarminTokens): void {
  setSecure(GARMIN_KEY, JSON.stringify(t));
}

/** Remove Garmin tokens (disconnect). */
export function clearGarminTokens(): void {
  removeSecure(GARMIN_KEY);
}

/**
 * Retrieve stored Strava API credentials (Client ID + Secret).
 * On web, returns null — secrets should never be stored client-side.
 */
export function getStravaCredentials(): { clientId: string; clientSecret: string } | null {
  if (isWeb()) {
    // Web: client secrets must stay server-side (BFF pattern)
    return null;
  }
  try {
    const raw = getSecure(STRAVA_CREDENTIALS);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/**
 * Persist Strava API credentials for Electron OAuth flow.
 * Encrypted at rest via Electron's safeStorage API.
 * No-op on web — secrets must stay server-side.
 */
export function setStravaCredentials(clientId: string, clientSecret: string): void {
  if (isWeb()) {
    console.warn('[Apollo] Refusing to store client secret in browser. Use the backend API.');
    return;
  }
  setSecure(STRAVA_CREDENTIALS, JSON.stringify({ clientId, clientSecret }));
}

/**
 * Retrieve stored Garmin API credentials.
 * On web, returns null — secrets should never be stored client-side.
 */
export function getGarminCredentials(): { clientId: string; clientSecret: string } | null {
  if (isWeb()) {
    return null;
  }
  try {
    const raw = getSecure(GARMIN_CREDENTIALS);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/**
 * Persist Garmin API credentials.
 * Encrypted at rest via Electron's safeStorage API.
 * No-op on web.
 */
export function setGarminCredentials(clientId: string, clientSecret: string): void {
  if (isWeb()) {
    console.warn('[Apollo] Refusing to store client secret in browser. Use the backend API.');
    return;
  }
  setSecure(GARMIN_CREDENTIALS, JSON.stringify({ clientId, clientSecret }));
}
