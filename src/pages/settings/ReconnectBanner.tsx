/**
 * Settings › Connections — "Reconnect needed" banner, shared by the
 * intervals.icu, Strava and Garmin Connect cards (moved out of ConnectionsTab
 * in v1.0.8 when the Garmin card was added). Its state hook is
 * src/hooks/useNeedsReconnect.ts.
 */

import type { ReactNode } from 'react';
import type { NeedsReconnectState } from '../../services/connectionHealth';
import { getSourceDisplayName } from '../../services/activitySource';
import type { LiveActivitySource } from '../../services/activity/types';
import { formatSyncTime } from './shared';

/** What to do about rejected credentials, per source. */
const RECONNECT_HINTS: Record<LiveActivitySource, string> = {
  intervals: 'If you changed or revoked your API key, disconnect and connect again with the new key. Otherwise, retry.',
  strava: 'Connect Strava again to renew access, or retry if the problem was temporary.',
  garmin:
    'Garmin personal API keys expire after the period you chose (30 days to a year) and stop working if deleted. Create a new key in Garmin Connect and choose Replace key, or retry if the problem was temporary.',
};

interface ReconnectBannerProps {
  source: LiveActivitySource;
  state: NeedsReconnectState;
  busy: boolean;
  onRetry: () => void;
  /** Extra action, e.g. "Connect Strava again". */
  children?: ReactNode;
}

/** "Reconnect needed" banner on a card whose saved credentials were rejected. */
export function ReconnectBanner({ source, state, busy, onRetry, children }: ReconnectBannerProps) {
  return (
    <div className="settings-reconnect">
      <p className="settings-reconnect-title">
        <span aria-hidden="true">⚠ </span>Reconnect needed — {getSourceDisplayName(source)} sync is paused
      </p>
      <p className="settings-reconnect-reason">
        {state.reason}
        {state.since ? ` (since ${formatSyncTime(state.since)})` : ''}
      </p>
      <p className="settings-hint">{RECONNECT_HINTS[source]}</p>
      <div className="settings-actions">
        <button type="button" className="btn btn-secondary" disabled={busy} onClick={onRetry}>
          Retry
        </button>
        {children}
      </div>
    </div>
  );
}
