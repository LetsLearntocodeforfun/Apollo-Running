/**
 * v1.0.7 (PX-03, PX-14): app-shell notices about data safety.
 *
 * - "Not saved — Retry": shown while any write failed to reach the local
 *   database (persistence.failedWrites). The changes are kept in memory and
 *   retried with every later save, every 30 s, and when Retry is pressed; the
 *   banner clears itself as soon as everything is saved.
 * - "Damaged data set aside": shown when a stored value couldn't be read and
 *   was moved to a quarantine key (PX-14) instead of being overwritten.
 *
 * Rendered inside App's polite live region; the failure notice is an alert.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { persistence, type WriteHealth } from '../services/db/persistence';
import {
  acknowledgeQuarantines,
  getUnacknowledgedQuarantines,
  onQuarantineChange,
  type QuarantineEntry,
} from '../services/db/quarantine';
import './SaveStatusBanner.css';

/** How often unsaved changes are retried automatically while the banner is up. */
export const AUTO_RETRY_MS = 30_000;

/** Live write health from the persistence layer. */
export function useWriteHealth(): WriteHealth {
  const [health, setHealth] = useState<WriteHealth>(() => persistence.getWriteHealth());
  useEffect(() => {
    const update = () => setHealth(persistence.getWriteHealth());
    const unsubscribe = persistence.onWriteHealthChange(update);
    update(); // a write may have failed before we subscribed
    return unsubscribe;
  }, []);
  return health;
}

/** Quarantined values the athlete hasn't dismissed yet. */
export function useQuarantineNotices(): QuarantineEntry[] {
  const [entries, setEntries] = useState<QuarantineEntry[]>(() => getUnacknowledgedQuarantines());
  useEffect(() => {
    const update = () => setEntries(getUnacknowledgedQuarantines());
    const unsubscribe = onQuarantineChange(update);
    update();
    return unsubscribe;
  }, []);
  return entries;
}

const STORE_LABELS: Record<string, string> = {
  apollo_activities_store: 'Your activity history',
  apollo_wellness: 'Your wellness data',
};

function describeQuarantine(entries: QuarantineEntry[]): string {
  const labels = [...new Set(entries.map((e) => STORE_LABELS[e.originalKey] ?? 'Some saved data'))];
  return labels.join(' and ');
}

export default function SaveStatusBanner() {
  const health = useWriteHealth();
  const quarantined = useQuarantineNotices();
  const [retrying, setRetrying] = useState(false);
  const [stillFailing, setStillFailing] = useState(false);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  const retry = useCallback(async () => {
    setRetrying(true);
    try {
      await persistence.retryFailedWrites();
    } finally {
      if (mounted.current) {
        setRetrying(false);
        setStillFailing(!persistence.getWriteHealth().ok);
      }
    }
  }, []);

  // Keep retrying quietly while something is unsaved (disk space freed, lock released…).
  useEffect(() => {
    if (health.ok) {
      setStillFailing(false);
      return;
    }
    const timer = window.setInterval(() => { void persistence.retryFailedWrites(); }, AUTO_RETRY_MS);
    return () => window.clearInterval(timer);
  }, [health.ok]);

  const count = health.failedKeys.length;
  return (
    <>
      {!health.ok && (
        <div className="app-banner app-banner--error save-status-banner" role="alert" data-testid="save-status-banner">
          <div className="app-banner-text">
            <strong>Not saved.</strong>{' '}
            Apollo couldn&rsquo;t save {count === 1 ? '1 change' : `${count} changes`} to this device.
            {' '}Your changes are kept while Apollo stays open and are retried automatically.
            {stillFailing && (
              <span className="save-status-detail">
                {' '}Still not saved — free up disk space or close other Apollo windows, then retry.
              </span>
            )}
          </div>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => { void retry(); }}
            disabled={retrying}
            aria-busy={retrying}
          >
            {retrying ? 'Retrying…' : 'Retry'}
          </button>
        </div>
      )}
      {quarantined.length > 0 && (
        <div className="app-banner app-banner--warning" data-testid="quarantine-banner">
          <div className="app-banner-text">
            <strong>{describeQuarantine(quarantined)} couldn&rsquo;t be read.</strong>{' '}
            The damaged copy was set aside on this device instead of being overwritten. Sync again to
            re-download it, or restore a backup.
          </div>
          <Link to="/settings?tab=data" className="btn btn-secondary">
            Restore a backup
          </Link>
          <button
            type="button"
            className="app-banner-dismiss"
            onClick={acknowledgeQuarantines}
            aria-label="Dismiss damaged data message"
          >
            <span aria-hidden="true">×</span>
          </button>
        </div>
      )}
    </>
  );
}
