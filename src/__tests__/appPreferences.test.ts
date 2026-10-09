/**
 * App preference defaults (v1.0.7, PX-18): wellness sync is off by default for
 * new installs, while preferences saved by earlier versions without a wellness
 * choice keep the old behaviour (on), so nobody's recovery card silently stops.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { getAppPreferences, setAppPreferences } from '@/services/appPreferences';
import { persistence } from '@/services/db/persistence';

const KEY = 'apollo_app_prefs';

describe('app preference defaults (PX-18)', () => {
  beforeEach(() => {
    persistence.removeItem(KEY);
  });

  it('new installs: every network-related option is off', () => {
    expect(getAppPreferences()).toMatchObject({
      autoSyncOnLaunch: false,
      autoCheckUpdates: false,
      autoDownloadUpdates: false,
      syncWellness: false,
    });
  });

  it('a first saved preference on a new install keeps wellness off', () => {
    setAppPreferences({ autoCheckUpdates: true });
    expect(getAppPreferences()).toMatchObject({ autoCheckUpdates: true, syncWellness: false });
    expect(JSON.parse(persistence.getItem(KEY)!)).toMatchObject({ syncWellness: false });
  });

  it('earlier versions that never stored a wellness choice keep it on', () => {
    persistence.setItem(KEY, JSON.stringify({ autoSyncOnLaunch: true, backgroundSyncMinutes: 30 }));
    expect(getAppPreferences()).toMatchObject({ autoSyncOnLaunch: true, syncWellness: true });
  });

  it('an explicit choice always wins', () => {
    persistence.setItem(KEY, JSON.stringify({ syncWellness: false }));
    expect(getAppPreferences().syncWellness).toBe(false);
    setAppPreferences({ syncWellness: true });
    expect(getAppPreferences().syncWellness).toBe(true);
  });
});
