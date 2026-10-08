import { useEffect, useRef, useState } from 'react';
import { runSync } from '../services/autoSync';
import { syncPlanCalendarIfChanged } from '../services/planCalendarSync';
import {
  getLastActivitySyncTime,
  isActivitySourceConnected,
  isSyncRunning,
} from '../services/activitySource';
import {
  APP_PREFS_CHANGED_EVENT,
  getAppPreferences,
  isAutoSyncCooldownElapsed,
  markAutoSyncRan,
} from '../services/appPreferences';
import { isStorageDegraded } from '../services/storageHealth';

/** Show a status message; autoHideMs = 0 keeps it up (progress messages). */
export type ShowStatus = (message: string | null, autoHideMs?: number) => void;

/**
 * Automatic activity sync (opt-in; turned on when a source is connected):
 * once on launch, then every N minutes while Apollo is open, catching up after
 * sleep, refocus or reconnect. Skipped while storage is degraded (the shell
 * shows a banner and activitySource refuses to sync anyway).
 */
export function useAutoSync(showStatus: ShowStatus): void {
  const [prefsVersion, setPrefsVersion] = useState(0);
  const launchSyncRanRef = useRef(false);

  // Re-read sync preferences when Settings changes them.
  useEffect(() => {
    const onPrefsChanged = () => setPrefsVersion((v) => v + 1);
    window.addEventListener(APP_PREFS_CHANGED_EVENT, onPrefsChanged);
    return () => window.removeEventListener(APP_PREFS_CHANGED_EVENT, onPrefsChanged);
  }, []);

  useEffect(() => {
    const prefs = getAppPreferences();
    if (!prefs.autoSyncOnLaunch) return;
    const intervalMs = Math.max(0, prefs.backgroundSyncMinutes) * 60_000;

    const sync = (announce: boolean) => {
      if (isStorageDegraded()) return;
      if (!isActivitySourceConnected() || isSyncRunning() || !isAutoSyncCooldownElapsed()) return;
      markAutoSyncRan();
      if (announce) showStatus('Syncing activities…', 0);
      runSync({ onProgress: announce ? (p) => showStatus(p.message, 0) : undefined })
        .then(({ summary }) => {
          const added = summary?.added ?? 0;
          const error = summary?.errors[0]?.message;
          if (added > 0) {
            showStatus(`Synced ${added} new activit${added === 1 ? 'y' : 'ies'}`);
          } else if (!announce) {
            return; // background syncs stay quiet unless something new arrived
          } else if (error) {
            showStatus(`Sync problem: ${error}`, 7000);
          } else {
            showStatus('Activities are up to date');
          }
        })
        .catch(() => {
          if (announce) showStatus('Sync failed — will retry later');
        });
    };

    if (!launchSyncRanRef.current) {
      launchSyncRanRef.current = true;
      sync(true);
    }
    if (intervalMs === 0) return;

    const timer = window.setInterval(() => sync(false), intervalMs);
    // Timers pause while the computer sleeps — catch up on wake, refocus or reconnect.
    const catchUp = () => {
      if (document.visibilityState !== 'visible') return;
      const last = getLastActivitySyncTime();
      if (!last || Date.now() - Date.parse(last) >= intervalMs) sync(false);
    };
    document.addEventListener('visibilitychange', catchUp);
    window.addEventListener('focus', catchUp);
    window.addEventListener('online', catchUp);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', catchUp);
      window.removeEventListener('focus', catchUp);
      window.removeEventListener('online', catchUp);
    };
  }, [prefsVersion, showStatus]);

  // "Send your plan to your watch" auto-update (opt-in, Plan page): runs on
  // launch and when Apollo regains focus, independent of activity auto-sync.
  // The service only calls intervals.icu when the plan or paces changed (or a
  // day has passed), and never throws.
  useEffect(() => {
    void syncPlanCalendarIfChanged();
    const onVisible = () => {
      if (document.visibilityState === 'visible') void syncPlanCalendarIfChanged();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, []);
}
