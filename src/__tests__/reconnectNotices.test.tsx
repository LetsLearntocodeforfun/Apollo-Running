/**
 * v1.0.7: the web version can't (re)connect Strava, so it never shows a
 * "Strava needs to be reconnected" notice; intervals.icu notices still show.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useReconnectNotices } from '../hooks/useAppHealth';
import { clearNeedsReconnect, setNeedsReconnect } from '../services/connectionHealth';

afterEach(() => {
  clearNeedsReconnect('strava');
  clearNeedsReconnect('intervals');
  delete (window as { electronAPI?: unknown }).electronAPI;
  vi.unstubAllEnvs();
});

describe('useReconnectNotices', () => {
  it('web: hides the Strava notice but keeps intervals.icu', () => {
    setNeedsReconnect('strava', 'Strava rejected the token (401).');
    setNeedsReconnect('intervals', 'intervals.icu rejected the API key (401).');
    const { result } = renderHook(() => useReconnectNotices());
    expect(result.current.map((n) => n.source)).toEqual(['intervals']);
  });

  it('desktop: shows the Strava notice', () => {
    (window as { electronAPI?: unknown }).electronAPI = {};
    setNeedsReconnect('strava', 'Strava rejected the token (401).');
    const { result } = renderHook(() => useReconnectNotices());
    expect(result.current.map((n) => n.source)).toEqual(['strava']);
  });

  it('a web build with Strava enabled shows it', () => {
    vi.stubEnv('VITE_WEB_STRAVA', 'true');
    setNeedsReconnect('strava', 'Strava rejected the token (401).');
    const { result } = renderHook(() => useReconnectNotices());
    expect(result.current.map((n) => n.source)).toEqual(['strava']);
  });
});
