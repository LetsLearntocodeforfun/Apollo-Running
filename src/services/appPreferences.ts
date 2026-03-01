/**
 * App Preferences — user settings for auto-sync on launch and auto-updates.
 * Both features are opt-in (disabled by default). Persisted via the persistence service.
 */

import { persistence } from './db/persistence';

const PREFS_KEY = 'apollo_app_prefs';

export interface AppPreferences {
  /** Automatically sync Strava activities when the app opens */
  autoSyncOnLaunch: boolean;
  /** Automatically check for app updates on launch (Electron only) */
  autoCheckUpdates: boolean;
  /** Automatically download updates when available (Electron only) */
  autoDownloadUpdates: boolean;
  /** Timestamp of last auto-sync to implement cooldown */
  lastAutoSyncAt: string | null;
}

const DEFAULT_PREFS: AppPreferences = {
  autoSyncOnLaunch: false,
  autoCheckUpdates: false,
  autoDownloadUpdates: false,
  lastAutoSyncAt: null,
};

/** Minimum seconds between auto-syncs to avoid hammering Strava on rapid reopens */
const AUTO_SYNC_COOLDOWN_SEC = 300; // 5 minutes

export function getAppPreferences(): AppPreferences {
  try {
    const raw = persistence.getItem(PREFS_KEY);
    if (!raw) return { ...DEFAULT_PREFS };
    return { ...DEFAULT_PREFS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export function setAppPreferences(prefs: Partial<AppPreferences>): void {
  const current = getAppPreferences();
  const merged = { ...current, ...prefs };
  persistence.setItem(PREFS_KEY, JSON.stringify(merged));
}

/** Check whether auto-sync cooldown has elapsed */
export function isAutoSyncCooldownElapsed(): boolean {
  const prefs = getAppPreferences();
  if (!prefs.lastAutoSyncAt) return true;
  const lastSync = new Date(prefs.lastAutoSyncAt).getTime();
  return Date.now() - lastSync > AUTO_SYNC_COOLDOWN_SEC * 1000;
}

/** Record that an auto-sync just ran */
export function markAutoSyncRan(): void {
  setAppPreferences({ lastAutoSyncAt: new Date().toISOString() });
}
