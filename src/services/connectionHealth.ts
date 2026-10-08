/**
 * Needs-reconnect state per live source (v1.0.6, V14).
 *
 * When intervals.icu or Strava rejects the stored credentials (HTTP 401/403,
 * or a Strava refresh token that no longer works), the source is flagged.
 * While flagged, automatic and page-triggered syncs skip it (no silent retry
 * every few minutes) and the UI shows a "Reconnect" banner. Connecting the
 * source again, a successful sync, or `clearNeedsReconnect` (a "Retry"
 * button) clears the flag. The state survives restarts.
 */

import { persistence } from './db/persistence';
import type { LiveActivitySource } from './activity/types';

const NEEDS_RECONNECT_KEY = 'apollo_needs_reconnect';

/** Window event dispatched when a source's needs-reconnect state changes. */
export const NEEDS_RECONNECT_EVENT = 'apollo:needs-reconnect-changed';

export interface NeedsReconnectState {
  /** When the credentials were first rejected (ISO). */
  since: string;
  /** The error message to show. */
  reason: string;
}

export interface NeedsReconnectChange {
  source: LiveActivitySource;
  /** The new state, or null when cleared. */
  state: NeedsReconnectState | null;
}

const listeners = new Set<(change: NeedsReconnectChange) => void>();

function readAll(): Partial<Record<LiveActivitySource, NeedsReconnectState>> {
  try {
    const raw = persistence.getItem(NEEDS_RECONNECT_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' ? parsed as Partial<Record<LiveActivitySource, NeedsReconnectState>> : {};
  } catch {
    return {};
  }
}

function writeAll(map: Partial<Record<LiveActivitySource, NeedsReconnectState>>): void {
  if (Object.keys(map).length === 0) persistence.removeItem(NEEDS_RECONNECT_KEY);
  else persistence.setItem(NEEDS_RECONNECT_KEY, JSON.stringify(map));
}

function emit(change: NeedsReconnectChange): void {
  for (const listener of listeners) {
    try { listener(change); } catch { /* listener errors must not break sync */ }
  }
  try {
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      window.dispatchEvent(new CustomEvent(NEEDS_RECONNECT_EVENT, { detail: change }));
    }
  } catch { /* no DOM */ }
}

/**
 * The source's needs-reconnect state, or null when its credentials are fine.
 * Truthy ⇒ show a "Reconnect" banner; auto sync skips this source.
 */
export function getNeedsReconnect(source: LiveActivitySource): NeedsReconnectState | null {
  return readAll()[source] ?? null;
}

/** Sources currently flagged, in no particular order. */
export function getSourcesNeedingReconnect(): LiveActivitySource[] {
  return Object.keys(readAll()) as LiveActivitySource[];
}

/** Flag a source after its credentials were rejected. Keeps the original `since`. */
export function setNeedsReconnect(source: LiveActivitySource, reason: string): void {
  const map = readAll();
  const existing = map[source];
  if (existing && existing.reason === reason) return;
  const state: NeedsReconnectState = { since: existing?.since ?? new Date().toISOString(), reason };
  map[source] = state;
  writeAll(map);
  emit({ source, state });
}

/** Clear the flag (reconnected, successful sync, disconnect, or a manual "Retry"). */
export function clearNeedsReconnect(source: LiveActivitySource): void {
  const map = readAll();
  if (!map[source]) return;
  delete map[source];
  writeAll(map);
  emit({ source, state: null });
}

/** Subscribe to needs-reconnect changes. Returns an unsubscribe function. */
export function onNeedsReconnectChanged(listener: (change: NeedsReconnectChange) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
