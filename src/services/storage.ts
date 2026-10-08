// Credential & token storage.
// Electron: encrypted via OS keychain (safeStorage). Web: kept in this browser's
// app storage (Strava client secrets stay on the server — BFF pattern — but the
// OAuth tokens and the intervals.icu API key are stored locally). Credentials
// are never included in exports or backups (dataManager.isExcludedFromExport).

import { persistence } from './db/persistence';
import { clearNeedsReconnect } from './connectionHealth';

const STRAVA_KEY = 'strava_tokens';
const GARMIN_KEY = 'garmin_tokens';
const STRAVA_CREDENTIALS = 'strava_credentials';
const GARMIN_CREDENTIALS = 'garmin_credentials';
const INTERVALS_CREDENTIALS = 'intervals_credentials';

/** Keys that hold sensitive data and should use encrypted storage in Electron */
const SENSITIVE_KEYS = new Set([
  STRAVA_KEY, GARMIN_KEY, STRAVA_CREDENTIALS, GARMIN_CREDENTIALS, INTERVALS_CREDENTIALS,
]);

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

/**
 * intervals.icu personal API access (free). Garmin, Zwift, Wahoo, COROS,
 * Suunto, Polar… sync into intervals.icu, and Apollo reads from there.
 */
export interface IntervalsCredentials {
  /** Personal API key from intervals.icu → Settings → Developer Settings. */
  apiKey: string;
  /** Athlete ID (e.g. "i12345"). "0" means "the athlete that owns the key". */
  athleteId: string;
  /** Display name captured when the connection was verified. */
  athleteName?: string;
  /** ISO timestamp of when the key was verified and saved. */
  connectedAt?: string;
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
      const result = await api.secureStorage.set(key, plaintext);
      if (result.success) {
        secureCache.set(key, plaintext);
        persistence.removeItem(key);
        try { localStorage.removeItem(key); } catch { /* ignore */ }
        console.info(`[Apollo] Migrated ${key} to secure storage`);
      } else {
        console.warn(`[Apollo] Failed to migrate ${key} to secure storage: ${result.error ?? 'unknown error'}`);
      }
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
  // Wait for IndexedDB hydration first (S5): otherwise hydrate could restore a
  // plaintext copy the migration just deleted, and a legacy key stored only in
  // IndexedDB would be missed.
  await persistence.ready.catch(() => { /* localStorage-only fallback */ });
  await migrateToSecureStorage();
  await loadSecureCredentials();
}

// Run initialization on module load in Electron (non-blocking).
/**
 * Resolves once encrypted credentials have been loaded into the in-memory cache
 * (immediately on web). The app waits for this before first render so that
 * connection checks such as `getIntervalsCredentials()` are accurate at startup.
 */
export const secureStorageReady: Promise<void> =
  typeof window !== 'undefined' && window.electronAPI
    ? initSecureStorage().catch((err) =>
        console.warn('[Apollo] Secure storage init failed, falling back to persistence:', err),
      )
    : Promise.resolve();

// ── Synchronous Read Helpers ──────────────────────────────────────────────────

/** Read a sensitive value: secure cache (Electron) or persistence (web) */
function getSecure(key: string): string | null {
  if (isElectron()) {
    return secureCache.get(key) ?? null;
  }
  return persistence.getItem(key);
}

/** Why the last credential couldn't be saved to the OS keychain (desktop), or null. */
let secureWriteError: string | null = null;
const secureWriteListeners = new Set<(error: string | null) => void>();

function setSecureWriteError(error: string | null): void {
  if (secureWriteError === error) return;
  secureWriteError = error;
  for (const listener of secureWriteListeners) {
    try { listener(error); } catch { /* listener errors must not break storage */ }
  }
}

/**
 * Why the most recent credential couldn't be stored in the OS keychain
 * (desktop only), or null when the last write succeeded. The credential stays
 * usable for the current session but won't survive a restart.
 */
export function getSecureStorageError(): string | null {
  return secureWriteError;
}

/** Subscribe to keychain write failures/recoveries. Returns an unsubscribe function. */
export function onSecureStorageError(listener: (error: string | null) => void): () => void {
  secureWriteListeners.add(listener);
  return () => {
    secureWriteListeners.delete(listener);
  };
}

/**
 * Write a sensitive value: secure storage (Electron) or persistence (web).
 * Resolves to whether it was persisted; never rejects.
 */
function setSecure(key: string, value: string): Promise<boolean> {
  if (isElectron()) {
    // Do NOT write to persistence/localStorage for sensitive data.
    // Cache first so the credential works immediately — and keeps working for
    // this session even if the keychain refuses it (reported via
    // getSecureStorageError instead of silently disconnecting).
    secureCache.set(key, value);
    return Promise.resolve()
      .then(() => window.electronAPI!.secureStorage.set(key, value))
      .then(
        (result) => {
          if (result.success) {
            setSecureWriteError(null);
            return true;
          }
          const reason = result.error ?? 'unknown error';
          console.error(`[Apollo] Failed to securely persist ${key}: ${reason}`);
          setSecureWriteError(reason);
          return false;
        },
        (err: unknown) => {
          console.error(`[Apollo] Failed to encrypt ${key}:`, err);
          setSecureWriteError(err instanceof Error ? err.message : String(err));
          return false;
        },
      );
  }
  // Web fallback: tokens only (credentials should go through BFF)
  persistence.setItem(key, value);
  return Promise.resolve(true);
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

/**
 * Persist Strava OAuth tokens after authentication or refresh. Resolves to
 * whether they were persisted (false: usable this session only).
 */
export function setStravaTokens(t: StravaTokens): Promise<boolean> {
  // Fresh tokens (connect or refresh) mean the connection works again.
  clearNeedsReconnect('strava');
  return setSecure(STRAVA_KEY, JSON.stringify(t));
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

/** Retrieve the stored intervals.icu API credentials, or null if not connected. */
export function getIntervalsCredentials(): IntervalsCredentials | null {
  try {
    const raw = getSecure(INTERVALS_CREDENTIALS);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<IntervalsCredentials> | null;
    if (!parsed || typeof parsed.apiKey !== 'string' || !parsed.apiKey) return null;
    return {
      apiKey: parsed.apiKey,
      athleteId: typeof parsed.athleteId === 'string' && parsed.athleteId ? parsed.athleteId : '0',
      athleteName: parsed.athleteName,
      connectedAt: parsed.connectedAt,
    };
  } catch {
    return null;
  }
}

/**
 * Persist intervals.icu credentials.
 * Electron: encrypted at rest via safeStorage. Web: kept in this browser's app
 * storage (the key is personal and is only ever sent to intervals.icu).
 * Resolves to whether they were persisted (false: usable this session only —
 * see getSecureStorageError).
 */
export function setIntervalsCredentials(creds: IntervalsCredentials): Promise<boolean> {
  return setSecure(INTERVALS_CREDENTIALS, JSON.stringify(creds));
}

/** Remove intervals.icu credentials (disconnect). */
export function clearIntervalsCredentials(): void {
  removeSecure(INTERVALS_CREDENTIALS);
}

/**
 * Remove every stored credential (tokens, API keys, client secrets) from all
 * layers: the in-memory cache, the desktop encrypted store (awaited) and any
 * plaintext copies in persistence/localStorage. Used by "Delete all data".
 * Resolves to the keys the desktop store failed to remove (empty on success).
 */
export async function clearAllCredentials(): Promise<string[]> {
  const failed: string[] = [];
  for (const key of SENSITIVE_KEYS) {
    secureCache.delete(key);
    if (isElectron()) {
      try {
        const result = await window.electronAPI!.secureStorage.remove(key);
        if (!result?.success) failed.push(key);
      } catch {
        failed.push(key);
      }
    }
    persistence.removeItem(key);
    try { localStorage.removeItem(key); } catch { /* ignore */ }
  }
  return failed;
}
