import { afterEach, describe, expect, it, vi } from 'vitest';
import { isDesktop, isStravaAvailable, isWeb } from '../utils/platform';

describe('platform capabilities', () => {
  afterEach(() => {
    delete (window as { electronAPI?: unknown }).electronAPI;
    vi.unstubAllEnvs();
  });

  it('browser: web, no Strava by default', () => {
    expect(isWeb()).toBe(true);
    expect(isDesktop()).toBe(false);
    expect(isStravaAvailable()).toBe(false);
  });

  it('browser build can opt in to Strava with VITE_WEB_STRAVA=true', () => {
    vi.stubEnv('VITE_WEB_STRAVA', 'true');
    expect(isStravaAvailable()).toBe(true);
  });

  it('desktop: Strava available', () => {
    (window as { electronAPI?: unknown }).electronAPI = {};
    expect(isDesktop()).toBe(true);
    expect(isWeb()).toBe(false);
    expect(isStravaAvailable()).toBe(true);
  });
});
