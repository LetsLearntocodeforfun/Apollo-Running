/**
 * Shared pieces for the Settings tabs (v1.0.6): tab ids (other pages deep-link
 * to `/settings?tab=<id>`), inline status feedback next to each action, and
 * small formatters/hooks used by more than one tab.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { getSecureStorageError, onSecureStorageError } from '../../services/storage';
import {
  APP_PREFS_CHANGED_EVENT,
  getAppPreferences,
  setAppPreferences,
  type AppPreferences,
} from '../../services/appPreferences';

// ── Tabs ──────────────────────────────────────────────────────────────────────

/** Settings tab ids. Stable: other pages link to `/settings?tab=<id>`. */
export type SettingsTabId = 'connections' | 'sync' | 'profile' | 'coaching' | 'data' | 'about';

export const SETTINGS_TABS: readonly { id: SettingsTabId; label: string }[] = [
  { id: 'connections', label: 'Connections' },
  { id: 'sync', label: 'Sync' },
  { id: 'profile', label: 'Athlete Profile' },
  { id: 'coaching', label: 'Coaching' },
  { id: 'data', label: 'Data & Privacy' },
  { id: 'about', label: 'About' },
];

export const DEFAULT_SETTINGS_TAB: SettingsTabId = 'connections';

export function isSettingsTabId(value: unknown): value is SettingsTabId {
  return typeof value === 'string' && SETTINGS_TABS.some((t) => t.id === value);
}

/** Router path of a Settings tab, e.g. `settingsTabPath('sync')` → `/settings?tab=sync`. */
export function settingsTabPath(tab: SettingsTabId): string {
  return `/settings?tab=${tab}`;
}

// ── Inline status (always-mounted polite live region) ─────────────────────────

export type StatusTone = 'success' | 'error' | 'info';

export interface Status {
  tone: StatusTone;
  text: string;
}

export interface StatusApi {
  status: Status | null;
  success: (text: string) => void;
  error: (text: string) => void;
  info: (text: string) => void;
  clear: () => void;
}

/**
 * Feedback state for one card or action. Updates after unmount are ignored
 * (async handlers that finish after the user switched tabs).
 */
export function useStatus(): StatusApi {
  const [status, setStatus] = useState<Status | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const set = useCallback((next: Status | null) => {
    if (mounted.current) setStatus(next);
  }, []);
  const actions = useMemo(() => ({
    success: (text: string) => set({ tone: 'success', text }),
    error: (text: string) => set({ tone: 'error', text }),
    info: (text: string) => set({ tone: 'info', text }),
    clear: () => set(null),
  }), [set]);
  return { status, ...actions };
}

interface StatusLineProps {
  status: Status | null;
  /** Extra inline content shown after the text (e.g. a "Reload now" button). */
  children?: ReactNode;
  className?: string;
  id?: string;
}

/**
 * Polite live region placed right next to the action it reports on. It is
 * always mounted (empty when idle) so screen readers announce changes.
 */
export function StatusLine({ status, children, className, id }: StatusLineProps) {
  const classes = ['settings-status', status ? `settings-status--${status.tone}` : '', className ?? '']
    .filter(Boolean)
    .join(' ');
  return (
    <p id={id} role="status" aria-live="polite" className={classes}>
      {status?.text}
      {children}
    </p>
  );
}

// ── Hooks ─────────────────────────────────────────────────────────────────────

/** Desktop only: why the OS keychain refused a credential (it then lasts for this session only). */
export function useKeychainError(): string | null {
  const [error, setError] = useState<string | null>(() => getSecureStorageError());
  useEffect(() => {
    setError(getSecureStorageError());
    return onSecureStorageError(setError);
  }, []);
  return error;
}

/**
 * App preferences plus an updater that persists a patch and tells App.tsx to
 * re-read them (auto/background sync schedule). Stays in sync across tabs.
 */
export function useAppPrefs(): [AppPreferences, (patch: Partial<AppPreferences>) => AppPreferences] {
  const [prefs, setPrefs] = useState<AppPreferences>(() => getAppPreferences());
  useEffect(() => {
    const onChange = () => setPrefs(getAppPreferences());
    window.addEventListener(APP_PREFS_CHANGED_EVENT, onChange);
    return () => window.removeEventListener(APP_PREFS_CHANGED_EVENT, onChange);
  }, []);
  const update = useCallback((patch: Partial<AppPreferences>) => {
    setAppPreferences(patch);
    const next = getAppPreferences();
    setPrefs(next);
    window.dispatchEvent(new Event(APP_PREFS_CHANGED_EVENT));
    return next;
  }, []);
  return [prefs, update];
}

// ── Formatters ────────────────────────────────────────────────────────────────

export function formatCount(n: number, one: string, many: string): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

/** "Just now", "12 min ago", "3 hr ago", else a short local date/time. */
export function formatSyncTime(iso: string | null): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return 'Never';
  const minutes = Math.floor((Date.now() - t) / 60000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)} hr ago`;
  return new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/** Human size for a byte count, e.g. "2.3 MB". */
export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}
