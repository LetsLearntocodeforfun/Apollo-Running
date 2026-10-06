/**
 * App Preferences — user settings for automatic activity sync and auto-updates.
 * Both features are opt-in (disabled by default); connecting intervals.icu turns
 * automatic sync on. Wellness sync (sleep, HRV and resting HR from intervals.icu)
 * is on by default. Persisted via the persistence service.
 */

import { persistence } from './db/persistence';

const PREFS_KEY = 'apollo_app_prefs';

export interface AppPreferences {
  /** Automatically sync activities (all connected sources) when the app opens and while it runs */
  autoSyncOnLaunch: boolean;
  /** While the app is open, re-sync every N minutes (0 = only on launch). Requires autoSyncOnLaunch. */
  backgroundSyncMinutes: number;
  /** Automatically check for app updates on launch (Electron only) */
  autoCheckUpdates: boolean;
  /** Automatically download updates when available (Electron only) */
  autoDownloadUpdates: boolean;
  /**
   * Read sleep, HRV, resting HR and readiness from intervals.icu (wellness) on every
   * sync. Only runs while intervals.icu is connected. On by default.
   */
  syncWellness: boolean;
  /** Timestamp of last auto-sync to implement cooldown */
  lastAutoSyncAt: string | null;
}

/** Choices offered in Settings for the background sync interval (minutes, 0 = off). */
export const BACKGROUND_SYNC_OPTIONS: readonly number[] = [0, 15, 30, 60, 180];

const DEFAULT_PREFS: AppPreferences = {
  autoSyncOnLaunch: false,
  backgroundSyncMinutes: 60,
  autoCheckUpdates: false,
  autoDownloadUpdates: false,
  syncWellness: true,
  lastAutoSyncAt: null,
};

/** Minimum seconds between auto-syncs to avoid hammering data sources on rapid reopens */
const AUTO_SYNC_COOLDOWN_SEC = 300; // 5 minutes

/** Window event dispatched (by Settings) after preferences change. */
export const APP_PREFS_CHANGED_EVENT = 'apollo:prefs-changed';

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
