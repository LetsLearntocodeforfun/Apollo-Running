/**
 * Unit tests for storage.ts
 *
 * Tests credential and token persistence functions. In the test environment
 * (no Electron), storage falls through to the mocked persistence layer.
 * Electron-specific secure storage is tested via integration tests.
 */

import { describe, it, expect } from 'vitest';
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
