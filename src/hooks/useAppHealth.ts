import { useEffect, useState } from 'react';
import { getStorageHealth, onStorageHealthChanged, type StorageHealth } from '../services/storageHealth';
import {
  getNeedsReconnect,
  getSourcesNeedingReconnect,
  onNeedsReconnectChanged,
  type NeedsReconnectState,
} from '../services/connectionHealth';
import type { LiveActivitySource } from '../services/activity/types';

/** Current storage health; re-renders when IndexedDB fails or recovers. */
export function useStorageHealth(): StorageHealth {
  const [health, setHealth] = useState<StorageHealth>(() => getStorageHealth());
  useEffect(() => {
    // Catch a change that happened between the first render and subscribing.
    setHealth(getStorageHealth());
    return onStorageHealthChanged(setHealth);
  }, []);
  return health;
}

/** A live source whose credentials were rejected, with the reason to show. */
export interface ReconnectNotice {
  source: LiveActivitySource;
  state: NeedsReconnectState;
}

function readReconnectNotices(): ReconnectNotice[] {
  const notices: ReconnectNotice[] = [];
  for (const source of getSourcesNeedingReconnect()) {
    const state = getNeedsReconnect(source);
    if (state) notices.push({ source, state });
  }
  return notices.sort((a, b) => a.source.localeCompare(b.source));
}

/** Sources that need to be reconnected (empty when every connection is fine). */
export function useReconnectNotices(): ReconnectNotice[] {
  const [notices, setNotices] = useState<ReconnectNotice[]>(readReconnectNotices);
  useEffect(() => {
    setNotices(readReconnectNotices());
    return onNeedsReconnectChanged(() => setNotices(readReconnectNotices()));
  }, []);
  return notices;
}

/** Display name of a live source. */
export function sourceDisplayName(source: LiveActivitySource): string {
  return source === 'intervals' ? 'intervals.icu' : source === 'strava' ? 'Strava' : source;
}
