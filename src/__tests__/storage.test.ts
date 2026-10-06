/**
 * Unit tests for storage.ts
 *
 * Tests credential and token persistence functions. In the test environment
 * (no Electron), storage falls through to the mocked persistence layer.
 * Electron-specific secure storage is tested via integration tests.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getStravaTokens,
  setStravaTokens,
  clearStravaTokens,
  getStravaCredentials,
  setStravaCredentials,
  getGarminTokens,
  setGarminTokens,
  clearGarminTokens,
  getGarminCredentials,
  setGarminCredentials,
  getIntervalsCredentials,
  setIntervalsCredentials,
  clearIntervalsCredentials,
  getSecureStorageError,
  onSecureStorageError,
  type StravaTokens,
} from '@/services/storage';
import { persistence } from '@/services/db/persistence';

// Note: In the test environment, window.electronAPI is undefined,
// so isElectron() returns false and isWeb() returns true.
// This means credential functions use the persistence fallback path.

// ── Strava Tokens ─────────────────────────────────────────────────────────────

describe('Strava Tokens', () => {
  it('should return null when no tokens are stored', () => {
    expect(getStravaTokens()).toBeNull();
  });

  it('should store and retrieve tokens', () => {
    const tokens: StravaTokens = {
      access_token: 'test-access-token',
      refresh_token: 'test-refresh-token',
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      athlete: { id: 12345, firstname: 'Test', lastname: 'Runner' },
    };
    setStravaTokens(tokens);
    const retrieved = getStravaTokens();
    expect(retrieved).not.toBeNull();
    expect(retrieved!.access_token).toBe('test-access-token');
    expect(retrieved!.refresh_token).toBe('test-refresh-token');
    expect(retrieved!.athlete.id).toBe(12345);
  });

  it('should clear tokens', () => {
    const tokens: StravaTokens = {
      access_token: 'to-be-cleared',
      refresh_token: 'to-be-cleared',
      expires_at: 0,
      athlete: { id: 1, firstname: 'A', lastname: 'B' },
    };
    setStravaTokens(tokens);
    expect(getStravaTokens()).not.toBeNull();

    clearStravaTokens();
    expect(getStravaTokens()).toBeNull();
  });

  it('should handle corrupted token data gracefully', () => {
    // Manually inject bad data using the mocked persistence
    persistence.setItem('strava_tokens', 'not-valid-json');
    expect(getStravaTokens()).toBeNull();
  });
});

// ── Strava Credentials ────────────────────────────────────────────────────────

describe('Strava Credentials (web mode)', () => {
  // In web mode (test env), credentials should NOT be stored client-side.
  // getStravaCredentials returns null, setStravaCredentials is a no-op.

  it('should return null on web (credentials stay server-side)', () => {
    expect(getStravaCredentials()).toBeNull();
  });

  it('should refuse to store credentials on web', () => {
    setStravaCredentials('client-123', 'secret-456');
    // Should still be null — web mode blocks client-side secret storage
    expect(getStravaCredentials()).toBeNull();
  });
});

// ── Garmin Tokens ─────────────────────────────────────────────────────────────

describe('Garmin Tokens', () => {
  it('should return null when no tokens are stored', () => {
    expect(getGarminTokens()).toBeNull();
  });

  it('should store and retrieve tokens', () => {
    setGarminTokens({
      access_token: 'garmin-access',
      refresh_token: 'garmin-refresh',
      expires_at: 9999999999,
    });
    const tokens = getGarminTokens();
    expect(tokens).not.toBeNull();
    expect(tokens!.access_token).toBe('garmin-access');
  });

  it('should clear tokens', () => {
    setGarminTokens({
      access_token: 'a',
      refresh_token: 'b',
      expires_at: 0,
    });
    clearGarminTokens();
    expect(getGarminTokens()).toBeNull();
  });
});

// ── Garmin Credentials ────────────────────────────────────────────────────────

describe('Garmin Credentials (web mode)', () => {
  it('should return null on web (credentials stay server-side)', () => {
    expect(getGarminCredentials()).toBeNull();
  });

  it('should refuse to store credentials on web', () => {
    setGarminCredentials('garmin-client', 'garmin-secret');
    expect(getGarminCredentials()).toBeNull();
  });
});

// ── intervals.icu Credentials ─────────────────────────────────────────────────

describe('intervals.icu Credentials (web mode)', () => {
  it('stores, normalises and clears credentials', async () => {
    await expect(setIntervalsCredentials({ apiKey: 'key-123', athleteId: '' })).resolves.toBe(true);
    const creds = getIntervalsCredentials();
    expect(creds?.apiKey).toBe('key-123');
    expect(creds?.athleteId).toBe('0'); // "0" = the athlete that owns the key
    clearIntervalsCredentials();
    expect(getIntervalsCredentials()).toBeNull();
  });

  it('ignores corrupt or incomplete stored credentials', () => {
    persistence.setItem('intervals_credentials', '{"athleteId":"i1"}');
    expect(getIntervalsCredentials()).toBeNull();
    persistence.setItem('intervals_credentials', 'not json');
    expect(getIntervalsCredentials()).toBeNull();
  });
});

// ── Desktop keychain (Electron secure storage) ────────────────────────────────

describe('Desktop keychain failures', () => {
  type SetResult = { success: boolean; error?: string };
  let nextSet: SetResult | Error;
  const keychain = new Map<string, string>();
  const win = window as unknown as { electronAPI?: unknown };
  const original = win.electronAPI;

  beforeEach(() => {
    keychain.clear();
    nextSet = { success: true };
    win.electronAPI = {
      secureStorage: {
        set: vi.fn(async (key: string, value: string): Promise<SetResult> => {
          if (nextSet instanceof Error) throw nextSet;
          if (nextSet.success) keychain.set(key, value);
          return nextSet;
        }),
        get: vi.fn(async (key: string) => keychain.get(key) ?? null),
        remove: vi.fn(async (key: string) => {
          keychain.delete(key);
          return { success: true };
        }),
        isAvailable: vi.fn(async () => true),
      },
    };
  });

  afterEach(() => {
    // Clear while the desktop bridge is still present so the in-memory cache is emptied.
    clearIntervalsCredentials();
    clearStravaTokens();
    win.electronAPI = original;
  });

  it('keeps a refused credential usable for this session and reports why', async () => {
    const errors: Array<string | null> = [];
    const unsubscribe = onSecureStorageError((e) => errors.push(e));
    nextSet = { success: false, error: 'OS-level encryption is unavailable' };

    await expect(setIntervalsCredentials({ apiKey: 'k-1', athleteId: 'i1' })).resolves.toBe(false);

    // Still connected for this session (the old behaviour silently disconnected)…
    expect(getIntervalsCredentials()?.apiKey).toBe('k-1');
    // …the reason is surfaced, and the secret never falls back to plaintext storage.
    expect(getSecureStorageError()).toMatch(/encryption is unavailable/);
    expect(persistence.getItem('intervals_credentials')).toBeNull();
    expect(keychain.has('intervals_credentials')).toBe(false);

    // A later successful write clears the error.
    nextSet = { success: true };
    await expect(setIntervalsCredentials({ apiKey: 'k-2', athleteId: 'i1' })).resolves.toBe(true);
    expect(getSecureStorageError()).toBeNull();
    expect(keychain.has('intervals_credentials')).toBe(true);
    expect(errors).toEqual(['OS-level encryption is unavailable', null]);
    unsubscribe();
  });

  it('never rejects when the IPC call itself fails', async () => {
    nextSet = new Error('IPC channel closed');
    const tokens: StravaTokens = {
      access_token: 'a',
      refresh_token: 'r',
      expires_at: 9999999999,
      athlete: { id: 1, firstname: 'A', lastname: 'B' },
    };

    await expect(setStravaTokens(tokens)).resolves.toBe(false);
    expect(getStravaTokens()?.access_token).toBe('a');
    expect(getSecureStorageError()).toBe('IPC channel closed');

    nextSet = { success: true };
    await expect(setStravaTokens(tokens)).resolves.toBe(true);
    expect(getSecureStorageError()).toBeNull();
  });
});
