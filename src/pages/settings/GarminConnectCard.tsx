/**
 * Settings › Connections › Garmin Connect (v1.0.8, DS-01).
 *
 * Direct sync with the athlete's own Garmin Connect personal API key: no
 * intervals.icu or Strava account in between. Since Garmin's relaunched
 * developer program (October 2026), intervals.icu may no longer pass Garmin
 * activities to apps like Apollo, so this is the way Garmin data reaches
 * Apollo. Desktop only: Garmin's API rejects browser requests, so the web
 * version shows a note instead of the form.
 */

import { useCallback, useEffect, useState } from 'react';
import { ConfirmDialog } from '../../components/ui';
import { getGarminPersonalCredentials } from '../../services/storage';
import {
  GARMIN_KEY_VALIDITY_DAYS,
  connectGarmin,
  disconnectSource,
  getSourceSyncState,
  getStoredActivities,
  isSyncRunning,
  onActivitiesUpdated,
  onSyncStatus,
  type SyncProgress,
} from '../../services/activitySource';
import { runSync, type AutoSyncReport } from '../../services/autoSync';
import { GARMIN_KEY_SETTINGS_URL } from '../../services/garmin';
import { clearNeedsReconnect } from '../../services/connectionHealth';
import { GARMIN_DESKTOP_ONLY_NOTE, isGarminAvailable } from '../../utils/platform';
import { useNeedsReconnect } from '../../hooks/useNeedsReconnect';
import { ReconnectBanner } from './ReconnectBanner';
import { StatusLine, formatCount, formatSyncTime, useAppPrefs, useKeychainError, useStatus } from './shared';

type GarminAction = 'connect' | 'replace' | 'sync' | 'full';

/** What the card shows about the connection — deliberately without the key. */
interface GarminInfo {
  displayName?: string;
  connectedAt?: string;
  keyExpiresAt?: string;
}

function readGarminInfo(): GarminInfo | null {
  const c = getGarminPersonalCredentials();
  return c ? { displayName: c.displayName, connectedAt: c.connectedAt, keyExpiresAt: c.keyExpiresAt } : null;
}

function countGarminActivities(): number {
  return getStoredActivities().filter((a) => a.source === 'garmin').length;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** Warn this many days before the key's expiry (Garmin emails about a week before, too). */
const EXPIRY_WARNING_DAYS = 7;

function keyValidityLabel(days: number): string {
  return days === 365 ? '1 year' : `${days} days`;
}

/** "Expires Mar 3, 2027 (in 120 days)" plus whether it's time to warn. */
function describeKeyExpiry(iso: string | undefined): { text: string; warn: boolean } | null {
  const at = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(at)) return null;
  const days = Math.ceil((at - Date.now()) / DAY_MS);
  const date = new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  if (days <= 0) return { text: `About ${date} — it has probably expired`, warn: true };
  return { text: `About ${date} (in ${formatCount(days, 'day', 'days')})`, warn: days <= EXPIRY_WARNING_DAYS };
}

function formatProgress(p: SyncProgress): string {
  const showCount = p.fetched > 0 && !/route/i.test(p.message);
  return showCount ? `${p.message} (${formatCount(p.fetched, 'activity', 'activities')})` : p.message;
}

function garminErrors(report: AutoSyncReport): string | null {
  const errors = (report.summary?.errors ?? []).filter((e) => e.source === 'garmin');
  return errors.length ? errors.map((e) => e.message).join(' · ') : null;
}

export default function GarminConnectCard() {
  const available = isGarminAvailable();
  const keychainError = useKeychainError();
  const [appPrefs, updateAppPrefs] = useAppPrefs();
  const status = useStatus();
  const reconnect = useNeedsReconnect('garmin');

  const [info, setInfo] = useState<GarminInfo | null>(() => readGarminInfo());
  const [sync, setSync] = useState(() => getSourceSyncState('garmin'));
  const [count, setCount] = useState(() => countGarminActivities());
  const [apiKey, setApiKey] = useState('');
  const [validDays, setValidDays] = useState('');
  // U1 (as for intervals.icu): asked before connecting, applied only after a successful connect.
  const [connectAutoSync, setConnectAutoSync] = useState(true);
  const [replacing, setReplacing] = useState(false);
  const [action, setAction] = useState<GarminAction | null>(null);
  const [syncRunning, setSyncRunning] = useState(() => isSyncRunning());
  const [progress, setProgress] = useState<string | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);

  const busy = syncRunning || action !== null;

  const refresh = useCallback(() => {
    setInfo(readGarminInfo());
    setSync(getSourceSyncState('garmin'));
    setCount(countGarminActivities());
  }, []);

  useEffect(() => {
    const unsubscribe = onSyncStatus((s) => {
      setSyncRunning(s.running);
      if (s.running) {
        if (s.progress?.source === 'garmin') setProgress(formatProgress(s.progress));
      } else {
        setProgress(null);
        refresh();
      }
    });
    setSyncRunning(isSyncRunning());
    return unsubscribe;
  }, [refresh]);

  useEffect(() => onActivitiesUpdated(() => setCount(countGarminActivities())), []);

  const onProgress = (p: SyncProgress) => {
    if (p.source === 'garmin') setProgress(formatProgress(p));
  };

  /** Connect (or replace the key), then import: the full history for a new connection, new activities for a new key. */
  const handleConnect = async () => {
    if (busy) return;
    const isReplace = replacing && !!info;
    status.clear();
    setAction(isReplace ? 'replace' : 'connect');
    setProgress('Checking your Garmin key…');
    try {
      const days = validDays ? Number(validDays) : undefined;
      const athlete = await connectGarmin(apiKey, { keyValidDays: days, replace: isReplace });
      setApiKey(''); // never keep the key in UI state once it's saved
      setValidDays('');
      setReplacing(false);
      refresh();
      if (!isReplace) updateAppPrefs({ autoSyncOnLaunch: connectAutoSync });
      setProgress(isReplace ? 'Checking Garmin Connect for new activities…' : 'Importing your Garmin Connect history…');
      const report = await runSync(
        isReplace ? { sources: ['garmin'], force: true, onProgress } : { full: true, sources: ['garmin'], onProgress },
      );
      refresh();
      const name = athlete.firstname && athlete.firstname !== 'Garmin athlete' ? athlete.firstname : 'Garmin Connect';
      const fetched = report.summary?.fetched ?? 0;
      const matched = report.results.length;
      const planNote = matched > 0 ? ` (${formatCount(matched, 'plan day', 'plan days')} matched)` : '';
      const summary = isReplace
        ? `New key saved — Garmin sync is running again${planNote}.`
        : `Connected as ${name} — imported ${formatCount(fetched, 'activity', 'activities')}${planNote}.`;
      const errorText = garminErrors(report);
      if (errorText) status.error(`${summary} Some data could not be synced: ${errorText}`);
      else status.success(summary);
    } catch (e) {
      status.error(e instanceof Error ? e.message : 'Could not connect to Garmin Connect.');
    } finally {
      setAction(null);
      setProgress(null);
    }
  };

  const handleSync = async (full: boolean) => {
    if (busy) return;
    status.clear();
    setAction(full ? 'full' : 'sync');
    try {
      const report = await runSync(
        full ? { full: true, sources: ['garmin'], onProgress } : { sources: ['garmin'], onProgress },
      );
      refresh();
      const s = report.summary;
      const errorText = garminErrors(report);
      if (errorText) status.error(errorText);
      else if (!s) status.info('Nothing to sync.');
      else if (s.full)
        status.success(`Imported ${formatCount(s.fetched, 'activity', 'activities')} from Garmin Connect.`);
      else if (s.added === 0 && s.updated === 0) status.success('Everything is up to date.');
      else status.success(`Synced ${s.added.toLocaleString()} new and ${s.updated.toLocaleString()} updated.`);
    } catch (e) {
      status.error(e instanceof Error ? e.message : 'Sync failed.');
    } finally {
      setAction(null);
      setProgress(null);
    }
  };

  const handleRetry = async () => {
    clearNeedsReconnect('garmin');
    if (busy) {
      status.info('Garmin Connect will be tried again with the next sync.');
      return;
    }
    status.info('Retrying Garmin Connect…');
    try {
      const report = await runSync({ sources: ['garmin'], force: true, onProgress });
      refresh();
      const errorText = garminErrors(report);
      if (errorText) status.error(errorText);
      else status.success('Garmin Connect is syncing again.');
    } catch (e) {
      status.error(e instanceof Error ? e.message : 'Garmin Connect sync failed.');
    } finally {
      setProgress(null);
    }
  };

  const handleDisconnect = () => {
    setConfirmDisconnect(false);
    disconnectSource('garmin');
    setReplacing(false);
    refresh();
    status.success('Garmin Connect disconnected. Activities already synced stay on this device.');
  };

  const expiry = describeKeyExpiry(info?.keyExpiresAt);
  const showForm = available && (!info || replacing);

  return (
    <div className={`card settings-card ${info ? 'settings-card--garmin' : 'settings-card--gold'}`}>
      <h2 className="card-title settings-card-title">
        <span className="settings-brand-garmin">Garmin Connect</span>
        <span className="settings-badge settings-badge--gold">Direct · New</span>
        {info && <span className="settings-badge settings-badge--garmin">Connected</span>}
      </h2>
      <p className="settings-lead">
        Sync runs, rides and every other activity straight from your Garmin Connect account with your own personal API
        key. No other account needed. Routes, splits and laps come from your watch&apos;s original files.
      </p>

      {!available ? (
        <p className="settings-hint" data-testid="garmin-desktop-only">
          {GARMIN_DESKTOP_ONLY_NOTE}
        </p>
      ) : (
        <>
          {info && (
            <>
              <dl className="settings-dl">
                <dt>Account</dt>
                <dd className="settings-strong">{info.displayName || 'Your Garmin Connect account'}</dd>
                <dt>Personal API key</dt>
                <dd>
                  {keychainError
                    ? 'For this session only (system keychain unavailable)'
                    : 'Saved (encrypted on this device)'}
                </dd>
                <dt>Key expires</dt>
                <dd className={expiry?.warn ? 'settings-error-text' : undefined}>
                  {expiry ? expiry.text : 'Not set: Garmin emails you about a week before'}
                </dd>
                <dt>Last sync</dt>
                <dd>{formatSyncTime(sync.lastSyncAt)}</dd>
                <dt>From Garmin</dt>
                <dd>{formatCount(count, 'activity', 'activities')}</dd>
              </dl>
              {expiry?.warn && !reconnect && (
                <p className="settings-error-text" role="status">
                  Your Garmin key is about to stop working. Create a new key in Garmin Connect, then choose Replace key.
                </p>
              )}
              {reconnect && (
                <ReconnectBanner
                  source="garmin"
                  state={reconnect}
                  busy={busy}
                  onRetry={() => {
                    void handleRetry();
                  }}
                />
              )}
              {sync.lastError && !reconnect && (
                <p className="settings-error-text">
                  Last sync failed{sync.lastErrorAt ? ` (${formatSyncTime(sync.lastErrorAt)})` : ''}: {sync.lastError}
                </p>
              )}
              <p className="settings-hint">Automatic sync: {appPrefs.autoSyncOnLaunch ? 'On' : 'Off'}</p>
              {!replacing && (
                <div className="settings-actions">
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={busy}
                    onClick={() => {
                      void handleSync(false);
                    }}
                  >
                    {action === 'sync' ? 'Syncing…' : 'Sync Garmin now'}
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    disabled={busy}
                    onClick={() => {
                      void handleSync(true);
                    }}
                  >
                    {action === 'full' ? 'Importing…' : 'Re-import Garmin history'}
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    disabled={busy}
                    onClick={() => setReplacing(true)}
                  >
                    Replace key
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    disabled={busy}
                    onClick={() => setConfirmDisconnect(true)}
                  >
                    Disconnect Garmin
                  </button>
                </div>
              )}
            </>
          )}

          {showForm && (
            <>
              <ol className="settings-steps">
                <li>
                  Sign in to Garmin Connect on the web and open{' '}
                  <a href={GARMIN_KEY_SETTINGS_URL} target="_blank" rel="noopener noreferrer">
                    Settings › Personal API Key
                  </a>
                  .
                </li>
                <li>
                  Select <strong>Create Key</strong>, accept Garmin&apos;s terms and choose how long the key lasts (up
                  to a year).
                </li>
                <li>Copy the key (Garmin shows it only once) and paste it below.</li>
              </ol>
              <form
                className="settings-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  void handleConnect();
                }}
              >
                <div className="settings-field">
                  <label htmlFor="settings-garmin-key" className="settings-label">
                    Personal API key
                  </label>
                  <input
                    id="settings-garmin-key"
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="Paste your Garmin personal API key"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    className="settings-input"
                  />
                </div>
                <div className="settings-field">
                  <label htmlFor="settings-garmin-validity" className="settings-label">
                    Expiration you chose
                  </label>
                  <select
                    id="settings-garmin-validity"
                    className="settings-input"
                    aria-describedby="settings-garmin-validity-hint"
                    value={validDays}
                    onChange={(e) => setValidDays(e.target.value)}
                  >
                    <option value="">Not sure</option>
                    {GARMIN_KEY_VALIDITY_DAYS.map((d) => (
                      <option key={d} value={String(d)}>
                        {keyValidityLabel(d)}
                      </option>
                    ))}
                  </select>
                  <p id="settings-garmin-validity-hint" className="settings-hint">
                    Optional. Apollo reminds you a week before the key stops working.
                  </p>
                </div>
                {!replacing && (
                  <label className="settings-check">
                    <input
                      type="checkbox"
                      checked={connectAutoSync}
                      onChange={(e) => setConnectAutoSync(e.target.checked)}
                    />
                    <span>Sync automatically when Apollo opens and while it runs</span>
                  </label>
                )}
                <div className="settings-actions">
                  <button type="submit" className="btn btn-primary" disabled={busy}>
                    {action === 'connect'
                      ? 'Connecting…'
                      : action === 'replace'
                        ? 'Saving…'
                        : replacing
                          ? 'Save new key'
                          : 'Connect Garmin & import history'}
                  </button>
                  {replacing && (
                    <button
                      type="button"
                      className="btn btn-ghost"
                      disabled={busy}
                      onClick={() => {
                        setReplacing(false);
                        setApiKey('');
                      }}
                    >
                      Keep current key
                    </button>
                  )}
                </div>
              </form>
            </>
          )}

          <p className="settings-hint">
            Read-only. Your key is stored encrypted on this computer and is sent only to Garmin. Garmin&apos;s Personal
            API is for your own data, for personal use. Sending your Apollo plan to the watch still goes through
            intervals.icu.
          </p>
        </>
      )}

      <p role="status" aria-live="polite" className="settings-status settings-status--info">
        {progress && (
          <>
            <span aria-hidden="true">⟳ </span>
            {progress}
          </>
        )}
      </p>
      <StatusLine status={status.status} />

      <ConfirmDialog
        open={confirmDisconnect}
        title="Disconnect Garmin Connect?"
        message="Activities already synced stay on this device. To revoke the key itself, delete it in Garmin Connect › Settings › Personal API Key."
        confirmLabel="Disconnect"
        onConfirm={handleDisconnect}
        onCancel={() => setConfirmDisconnect(false)}
      />
    </div>
  );
}
