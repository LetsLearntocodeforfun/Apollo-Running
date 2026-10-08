/**
 * Settings › Connections — intervals.icu (free, recommended), activity file
 * import, Strava (optional) and how Garmin / Zwift reach Apollo through
 * intervals.icu.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ConfirmDialog } from '../../components/ui';
import ImportActivities from '../../components/ImportActivities';
import {
  getIntervalsCredentials,
  getStravaCredentials,
  setStravaCredentials,
  setStravaTokens,
} from '../../services/storage';
import {
  connectIntervals,
  disconnectSource,
  getSourceDisplayName,
  getSourceSyncState,
  getStoredActivities,
  isStravaConnected,
  isSyncRunning,
  onActivitiesUpdated,
  onSyncStatus,
  type SyncProgress,
} from '../../services/activitySource';
import { runSync, type AutoSyncReport } from '../../services/autoSync';
import { getStravaAuthUrl, isWeb } from '../../services/stravaWeb';
import {
  clearNeedsReconnect,
  getNeedsReconnect,
  onNeedsReconnectChanged,
  type NeedsReconnectState,
} from '../../services/connectionHealth';
import {
  StatusLine,
  formatCount,
  formatSyncTime,
  settingsTabPath,
  useAppPrefs,
  useKeychainError,
  useStatus,
} from './shared';

type IntervalsAction = 'connect' | 'sync' | 'full';
type LiveSource = 'intervals' | 'strava';

/** intervals.icu connection details shown in the UI — deliberately without the API key. */
interface IntervalsInfo {
  athleteId: string;
  athleteName?: string;
}

function readIntervalsInfo(): IntervalsInfo | null {
  const creds = getIntervalsCredentials();
  return creds ? { athleteId: creds.athleteId, athleteName: creds.athleteName } : null;
}

function intervalsDisplayName(info: IntervalsInfo): string {
  if (info.athleteName) return info.athleteName;
  return info.athleteId && info.athleteId !== '0' ? `Athlete ${info.athleteId}` : 'Your intervals.icu account';
}

/** e.g. "Importing 2024–2025 history… (412 activities)". */
function formatSyncProgress(p: SyncProgress): string {
  const showCount = p.fetched > 0 && !/route/i.test(p.message);
  return showCount ? `${p.message} (${formatCount(p.fetched, 'activity', 'activities')})` : p.message;
}

function describeSyncErrors(report: AutoSyncReport): string | null {
  const errors = report.summary?.errors ?? [];
  if (errors.length === 0) return null;
  return errors.map((e) => `${getSourceDisplayName(e.source)}: ${e.message}`).join(' · ');
}

function describeSyncResult(report: AutoSyncReport): string {
  const s = report.summary;
  if (!s) return 'Connect intervals.icu or Strava to sync activities.';
  const completed = report.results.filter((r) => r.isNew).length;
  const planNote = completed > 0 ? ` · ${formatCount(completed, 'plan day', 'plan days')} completed` : '';
  if (s.full) return `Imported ${formatCount(s.fetched, 'activity', 'activities')}${planNote}.`;
  if (s.added === 0 && s.updated === 0) return `Everything is up to date${planNote}.`;
  return `Synced ${s.added.toLocaleString()} new and ${s.updated.toLocaleString()} updated ${s.added + s.updated === 1 ? 'activity' : 'activities'}${planNote}.`;
}

/**
 * Options for an intervals.icu history import (connect and "Re-import full history").
 * U7: scoped to intervals.icu so a re-import never re-downloads Strava history.
 */
function intervalsImportOptions(onProgress: (p: SyncProgress) => void): Parameters<typeof runSync>[0] {
  return { full: true, sources: ['intervals'], onProgress };
}

const INTERVALS_DORMANT_TIP =
  'Tip: free intervals.icu accounts go dormant after a long time without logging in, and then stop collecting new activities from your watch and Zwift. Log in to intervals.icu every few weeks. If new runs stop arriving, log in, click \u201cDownload Old Data\u201d on the Garmin box to catch up, then sync again.';

/** A source's needs-reconnect state (credentials rejected), kept current. */
function useNeedsReconnect(source: LiveSource): NeedsReconnectState | null {
  const [state, setState] = useState<NeedsReconnectState | null>(() => getNeedsReconnect(source));
  useEffect(() => {
    setState(getNeedsReconnect(source));
    return onNeedsReconnectChanged(() => setState(getNeedsReconnect(source)));
  }, [source]);
  return state;
}

interface ReconnectBannerProps {
  source: LiveSource;
  state: NeedsReconnectState;
  busy: boolean;
  onRetry: () => void;
  /** Extra action, e.g. "Connect Strava again". */
  children?: ReactNode;
}

/** "Reconnect needed" banner on a card whose saved credentials were rejected. */
function ReconnectBanner({ source, state, busy, onRetry, children }: ReconnectBannerProps) {
  const name = source === 'intervals' ? 'intervals.icu' : 'Strava';
  return (
    <div className="settings-reconnect">
      <p className="settings-reconnect-title">
        <span aria-hidden="true">⚠ </span>Reconnect needed — {name} sync is paused
      </p>
      <p className="settings-reconnect-reason">
        {state.reason}
        {state.since ? ` (since ${formatSyncTime(state.since)})` : ''}
      </p>
      <p className="settings-hint">
        {source === 'intervals'
          ? 'If you changed or revoked your API key, disconnect and connect again with the new key. Otherwise, retry.'
          : 'Connect Strava again to renew access, or retry if the problem was temporary.'}
      </p>
      <div className="settings-actions">
        <button type="button" className="btn btn-secondary" disabled={busy} onClick={onRetry}>Retry</button>
        {children}
      </div>
    </div>
  );
}

export default function ConnectionsTab() {
  const keychainError = useKeychainError();
  const [appPrefs, updateAppPrefs] = useAppPrefs();
  const intervalsStatus = useStatus();
  const stravaStatus = useStatus();

  // ── intervals.icu ──
  const [intervalsApiKey, setIntervalsApiKey] = useState('');
  const [intervalsAthleteId, setIntervalsAthleteId] = useState('');
  // U1: asked before connecting and applied only after a successful connect.
  const [connectAutoSync, setConnectAutoSync] = useState(true);
  const [connectWellness, setConnectWellness] = useState(false);
  const [intervalsInfo, setIntervalsInfo] = useState<IntervalsInfo | null>(() => readIntervalsInfo());
  const [intervalsSync, setIntervalsSync] = useState(() => getSourceSyncState('intervals'));
  const [intervalsAction, setIntervalsAction] = useState<IntervalsAction | null>(null);
  const [activityCount, setActivityCount] = useState(() => getStoredActivities().length);
  const [syncRunning, setSyncRunning] = useState(() => isSyncRunning());
  const [syncProgressText, setSyncProgressText] = useState<string | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState<LiveSource | null>(null);

  // ── Strava (U8: the client secret is write-only and never loaded into state) ──
  const [stravaConnected, setStravaConnected] = useState(() => isStravaConnected());
  const [stravaClientId, setStravaClientId] = useState(() => getStravaCredentials()?.clientId ?? '');
  const [stravaSecretSaved, setStravaSecretSaved] = useState(() => !!getStravaCredentials()?.clientSecret);
  const [replacingSecret, setReplacingSecret] = useState(false);
  const [stravaSecretInput, setStravaSecretInput] = useState('');
  const [stravaBusy, setStravaBusy] = useState(false);
  const secretInputRef = useRef<HTMLInputElement>(null);

  const intervalsReconnect = useNeedsReconnect('intervals');
  const stravaReconnect = useNeedsReconnect('strava');

  const syncBusy = syncRunning || intervalsAction !== null;
  const syncStatusText = syncProgressText ?? (syncRunning ? 'Syncing activities…' : null);

  /** Re-read connection + sync state for every source (after connect/disconnect/sync). */
  const refreshSourceState = useCallback(() => {
    setIntervalsInfo(readIntervalsInfo());
    setIntervalsSync(getSourceSyncState('intervals'));
    setStravaConnected(isStravaConnected());
    setActivityCount(getStoredActivities().length);
  }, []);

  // Reflect sync progress — including syncs started elsewhere (launch / background sync).
  useEffect(() => {
    const unsubscribe = onSyncStatus((status) => {
      setSyncRunning(status.running);
      if (status.running) {
        if (status.progress) setSyncProgressText(formatSyncProgress(status.progress));
      } else {
        setSyncProgressText(null);
        refreshSourceState();
      }
    });
    // A sync may have finished between the first render and subscribing.
    setSyncRunning(isSyncRunning());
    return unsubscribe;
  }, [refreshSourceState]);

  // File imports store activities without a sync status event: keep "On this device" current.
  useEffect(() => onActivitiesUpdated(() => {
    setActivityCount(getStoredActivities().length);
  }), []);

  useEffect(() => {
    if (replacingSecret) secretInputRef.current?.focus();
  }, [replacingSecret]);

  const handleConnectIntervals = async () => {
    if (syncBusy) return;
    intervalsStatus.clear();
    setIntervalsAction('connect');
    setSyncProgressText('Checking your intervals.icu API key…');
    try {
      const athlete = await connectIntervals(intervalsApiKey, intervalsAthleteId.trim() || undefined);
      setIntervalsApiKey(''); // never keep the key in UI state once it's saved
      setIntervalsAthleteId('');
      refreshSourceState();
      // U1: exactly what the athlete chose before connecting — never turn sync on silently.
      // Set before the import so its wellness step follows the choice.
      updateAppPrefs({ autoSyncOnLaunch: connectAutoSync, syncWellness: connectWellness });
      setSyncProgressText('Importing your activity history…');
      const report = await runSync(intervalsImportOptions((p) => setSyncProgressText(formatSyncProgress(p))));
      refreshSourceState();
      const name = (athlete.firstname || '').trim()
        || `${athlete.firstname || ''} ${athlete.lastname || ''}`.trim()
        || 'your intervals.icu athlete';
      const imported = report.summary?.fetched ?? 0;
      const matched = report.results.length;
      const planNote = matched > 0 ? ` (${formatCount(matched, 'plan day', 'plan days')} matched)` : '';
      const errorText = describeSyncErrors(report);
      // Usually means the account only has activities intervals.icu imported from Strava, which its API doesn't share.
      const emptyNote = imported === 0 && !errorText
        ? ' No activities found — in intervals.icu › Settings, connect Garmin, COROS or your other device platform directly (activities it imports from Strava aren\u2019t available to other apps).'
        : '';
      const summary = `Connected as ${name} — imported ${formatCount(imported, 'activity', 'activities')}${planNote}.${emptyNote}`;
      if (errorText) intervalsStatus.error(`${summary} Some data could not be synced: ${errorText}`);
      else intervalsStatus.success(summary);
    } catch (e) {
      intervalsStatus.error(e instanceof Error ? e.message : 'Could not connect to intervals.icu.');
    } finally {
      setIntervalsAction(null);
      setSyncProgressText(null);
    }
  };

  const handleIntervalsSync = async (full: boolean) => {
    if (syncBusy) return;
    intervalsStatus.clear();
    setIntervalsAction(full ? 'full' : 'sync');
    try {
      const onProgress = (p: SyncProgress) => setSyncProgressText(formatSyncProgress(p));
      const report = await runSync(full ? intervalsImportOptions(onProgress) : { onProgress });
      refreshSourceState();
      const s = report.summary;
      const errorText = describeSyncErrors(report);
      const allFailed = !!s && s.errors.length >= s.sources.length && s.sources.length > 0;
      if (errorText) intervalsStatus.error(allFailed ? errorText : `${describeSyncResult(report)} ${errorText}`);
      else intervalsStatus.success(describeSyncResult(report));
    } catch (e) {
      intervalsStatus.error(e instanceof Error ? e.message : 'Sync failed.');
    } finally {
      setIntervalsAction(null);
      setSyncProgressText(null);
    }
  };

  /** "Retry" on a needs-reconnect banner: clear the flag, then sync just that source. */
  const handleRetry = async (source: LiveSource) => {
    const status = source === 'intervals' ? intervalsStatus : stravaStatus;
    const name = getSourceDisplayName(source);
    clearNeedsReconnect(source);
    if (syncBusy) {
      status.info(`${name} will be tried again with the next sync.`);
      return;
    }
    status.info(`Retrying ${name}…`);
    try {
      const report = await runSync({
        sources: [source],
        force: true,
        onProgress: (p) => setSyncProgressText(formatSyncProgress(p)),
      });
      refreshSourceState();
      const failure = report.summary?.errors.find((e) => e.source === source);
      if (failure) status.error(`${name}: ${failure.message}`);
      else status.success(describeSyncResult(report));
    } catch (e) {
      status.error(e instanceof Error ? e.message : `${name} sync failed.`);
    } finally {
      setSyncProgressText(null);
    }
  };

  const handleConfirmDisconnect = () => {
    const source = confirmDisconnect;
    setConfirmDisconnect(null);
    if (!source) return;
    disconnectSource(source);
    refreshSourceState();
    const message = `${getSourceDisplayName(source)} disconnected. Activities already synced stay on this device.`;
    if (source === 'intervals') intervalsStatus.success(message);
    else stravaStatus.success(message);
  };

  /**
   * Save the Strava app credentials. An empty secret field keeps the stored
   * secret (U8), which is read from storage only to write it back.
   */
  const saveStravaForm = (): boolean => {
    const clientId = stravaClientId.trim();
    if (!clientId) {
      stravaStatus.error('Enter your Strava Client ID.');
      return false;
    }
    const typedSecret = stravaSecretInput.trim();
    const stored = getStravaCredentials();
    const secret = typedSecret || stored?.clientSecret || '';
    if (!secret) {
      stravaStatus.error('Enter your Strava Client Secret.');
      return false;
    }
    if (typedSecret || clientId !== stored?.clientId) setStravaCredentials(clientId, secret);
    setStravaClientId(clientId);
    setStravaSecretInput('');
    setReplacingSecret(false);
    setStravaSecretSaved(true);
    return true;
  };

  const handleSaveStrava = () => {
    if (saveStravaForm()) stravaStatus.success('Strava credentials saved.');
  };

  const connectStrava = async () => {
    stravaStatus.clear();
    if (isWeb()) {
      setStravaBusy(true);
      try {
        window.location.href = await getStravaAuthUrl();
      } catch (e) {
        stravaStatus.error(e instanceof Error ? e.message : 'Could not start Strava connection.');
        setStravaBusy(false);
      }
      return;
    }
    const api = window.electronAPI;
    if (!api || !saveStravaForm()) return;
    // U8: the secret comes from storage, never from React state.
    const creds = getStravaCredentials();
    if (!creds?.clientId || !creds.clientSecret) {
      stravaStatus.error('Enter your Strava Client ID and Client Secret first, then save.');
      return;
    }
    setStravaBusy(true);
    try {
      // The main process starts the loopback server and waits for its port before building the
      // auth URL. Start waiting for the redirect *before* opening the browser so a fast approval
      // can't slip in between.
      const authUrl = await api.strava.getAuthUrl(creds.clientId);
      const callback = api.oauth.startServer();
      callback.catch(() => { /* awaited below */ });
      await api.openExternal(authUrl);
      const server = await callback;
      const tokens = await api.strava.exchangeCode({
        clientId: creds.clientId,
        clientSecret: creds.clientSecret,
        code: server.code,
      });
      void setStravaTokens({
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_at: tokens.expires_at,
        athlete: tokens.athlete,
      });
      setStravaConnected(true);
      stravaStatus.success(`Connected as ${tokens.athlete?.firstname ?? 'Strava'} — importing your Strava activities in the background…`);
      // Fire-and-forget: progress shows via onSyncStatus; failures land in the source's sync state.
      runSync().catch(() => { /* reported via sync state */ });
    } catch (e) {
      stravaStatus.error(e instanceof Error ? e.message : 'Strava connection failed.');
    } finally {
      setStravaBusy(false);
    }
  };

  const showSecretInput = !stravaSecretSaved || replacingSecret;

  return (
    <>
      {/* ── intervals.icu (free, recommended source) ── */}
      <div className={`card settings-card ${intervalsInfo ? 'settings-card--teal' : 'settings-card--gold'}`}>
        <h2 className="card-title settings-card-title">
          <span className="settings-brand-intervals">intervals.icu</span>
          <span className="settings-badge settings-badge--gold">Free · Recommended</span>
          {intervalsInfo && <span className="settings-badge settings-badge--teal">Connected</span>}
        </h2>
        <p className="settings-lead">
          intervals.icu is a free training platform that collects your workouts from Garmin Connect, Zwift, Wahoo, COROS, Suunto, Polar and more — runs, rides and cross-training.
          Connect it once and Apollo can sync every activity.
        </p>
        {intervalsInfo ? (
          <>
            <dl className="settings-dl">
              <dt>Athlete</dt>
              <dd className="settings-strong">{intervalsDisplayName(intervalsInfo)}</dd>
              <dt>API key</dt>
              <dd>
                {window.electronAPI
                  ? (keychainError ? 'For this session only (system keychain unavailable)' : 'Saved (encrypted on this device)')
                  : 'Saved in this browser'}
              </dd>
              <dt>Last sync</dt>
              <dd>{formatSyncTime(intervalsSync.lastSyncAt)}</dd>
              <dt>On this device</dt>
              <dd>{formatCount(activityCount, 'activity', 'activities')}</dd>
            </dl>
            {intervalsReconnect && (
              <ReconnectBanner
                source="intervals"
                state={intervalsReconnect}
                busy={syncBusy}
                onRetry={() => { void handleRetry('intervals'); }}
              />
            )}
            {intervalsSync.lastError && !intervalsReconnect && (
              <p className="settings-error-text">
                Last sync failed{intervalsSync.lastErrorAt ? ` (${formatSyncTime(intervalsSync.lastErrorAt)})` : ''}: {intervalsSync.lastError}
              </p>
            )}
            <p className="settings-hint">
              Automatic sync: {appPrefs.autoSyncOnLaunch ? 'On' : 'Off'} · Wellness: {appPrefs.syncWellness ? 'On' : 'Off'} —{' '}
              <Link to={settingsTabPath('sync')}>change in Sync</Link>
            </p>
            <div className="settings-actions">
              <button type="button" className="btn btn-primary" disabled={syncBusy} onClick={() => { void handleIntervalsSync(false); }}>
                {intervalsAction === 'sync' ? 'Syncing…' : 'Sync now'}
              </button>
              <button type="button" className="btn btn-secondary" disabled={syncBusy} onClick={() => { void handleIntervalsSync(true); }}>
                {intervalsAction === 'full' ? 'Importing…' : 'Re-import full history'}
              </button>
              <button type="button" className="btn btn-secondary" disabled={syncBusy} onClick={() => setConfirmDisconnect('intervals')}>
                Disconnect
              </button>
            </div>
          </>
        ) : (
          <>
            <ol className="settings-steps">
              <li>
                Create a free account at{' '}
                <a href="https://intervals.icu" target="_blank" rel="noopener noreferrer">intervals.icu</a>.
              </li>
              <li>
                In intervals.icu › <strong>Settings</strong>, connect Garmin Connect, Zwift, Wahoo, COROS, Suunto or Polar.
                <span className="settings-hint settings-hint--block">
                  For Garmin, allow <strong>Download activities</strong> and <strong>Download wellness data</strong>.
                  Connect your device platform directly — activities intervals.icu imports from Strava aren&apos;t available to other apps.
                </span>
              </li>
              <li>
                In intervals.icu › <strong>Settings › Developer Settings</strong>, copy your <strong>API key</strong> (and Athlete ID) and paste them below.
              </li>
            </ol>
            <form
              className="settings-form"
              onSubmit={(e) => {
                e.preventDefault();
                void handleConnectIntervals();
              }}
            >
              <div className="settings-field">
                <label htmlFor="settings-intervals-key" className="settings-label">API key</label>
                <input
                  id="settings-intervals-key"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="Paste your intervals.icu API key"
                  value={intervalsApiKey}
                  onChange={(e) => setIntervalsApiKey(e.target.value)}
                  className="settings-input"
                />
              </div>
              <div className="settings-field">
                <label htmlFor="settings-intervals-athlete" className="settings-label">Athlete ID</label>
                <input
                  id="settings-intervals-athlete"
                  type="text"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="i12345 (optional)"
                  aria-describedby="settings-intervals-athlete-hint"
                  value={intervalsAthleteId}
                  onChange={(e) => setIntervalsAthleteId(e.target.value)}
                  className="settings-input"
                />
                <p id="settings-intervals-athlete-hint" className="settings-hint">
                  Shown next to your API key, e.g. i12345. Leave blank (or enter 0) to use the account that owns the key.
                </p>
              </div>
              <fieldset className="settings-fieldset">
                <legend className="settings-label">After connecting</legend>
                <p className="settings-hint">Choose what Apollo does after connecting. You can change both any time in Settings › Sync.</p>
                <label className="settings-check">
                  <input
                    type="checkbox"
                    checked={connectAutoSync}
                    onChange={(e) => setConnectAutoSync(e.target.checked)}
                  />
                  <span>Sync new activities automatically when Apollo opens and while it runs</span>
                </label>
                <label className="settings-check">
                  <input
                    type="checkbox"
                    checked={connectWellness}
                    onChange={(e) => setConnectWellness(e.target.checked)}
                  />
                  <span>Also sync sleep, HRV and resting HR (wellness data)</span>
                </label>
              </fieldset>
              <div className="settings-actions">
                <button type="submit" className="btn btn-primary" disabled={syncBusy}>
                  {intervalsAction === 'connect' ? 'Connecting…' : 'Connect & import history'}
                </button>
              </div>
            </form>
          </>
        )}
        <p className="settings-hint">{INTERVALS_DORMANT_TIP}</p>
        <p role="status" aria-live="polite" className="settings-status settings-status--info">
          {syncStatusText && (
            <>
              <span aria-hidden="true">⟳ </span>
              {syncStatusText}
            </>
          )}
        </p>
        <StatusLine status={intervalsStatus.status} />
      </div>

      {/* ── Activity files & Strava / Garmin exports (free, no account needed) ── */}
      <ImportActivities />

      {/* ── Strava (optional source) ── */}
      <div className={`card settings-card ${stravaConnected ? 'settings-card--strava' : ''}`}>
        <h2 className="card-title settings-card-title">
          <span className="settings-brand-strava">Strava</span>
          <span className="settings-muted">(optional)</span>
          {stravaConnected && <span className="settings-badge settings-badge--strava">Connected</span>}
        </h2>
        <p className="settings-lead">
          Strava API access may require a paid plan. If you have access, connect it here — otherwise use intervals.icu above, it&apos;s free.
        </p>
        {stravaConnected && stravaReconnect && (
          <ReconnectBanner
            source="strava"
            state={stravaReconnect}
            busy={syncBusy || stravaBusy}
            onRetry={() => { void handleRetry('strava'); }}
          >
            <button type="button" className="btn btn-primary" disabled={stravaBusy} onClick={() => { void connectStrava(); }}>
              Connect Strava again
            </button>
          </ReconnectBanner>
        )}
        {isWeb() ? (
          <>
            <p className="settings-hint">
              You&apos;ll be redirected to Strava to authorize. Activities then sync along with your other sources.
            </p>
            <div className="settings-actions">
              {stravaConnected ? (
                <button type="button" onClick={() => setConfirmDisconnect('strava')} disabled={syncBusy} className="btn btn-secondary">Disconnect</button>
              ) : (
                <button type="button" onClick={() => { void connectStrava(); }} disabled={stravaBusy} className="btn btn-primary">
                  {stravaBusy ? 'Redirecting…' : 'Connect Strava'}
                </button>
              )}
            </div>
          </>
        ) : (
          <>
            <p className="settings-lead">
              Create an app at <a href="https://www.strava.com/settings/api" target="_blank" rel="noopener noreferrer">strava.com/settings/api</a> to get a Client ID and Client Secret.
              Use Authorization Callback Domain: <code className="settings-code">127.0.0.1</code> (or leave default).
            </p>
            <div className="settings-form">
              <div className="settings-field">
                <label htmlFor="settings-strava-client-id" className="settings-label">Client ID</label>
                <input
                  id="settings-strava-client-id"
                  type="text"
                  autoComplete="off"
                  spellCheck={false}
                  value={stravaClientId}
                  onChange={(e) => setStravaClientId(e.target.value)}
                  className="settings-input"
                />
              </div>
              {showSecretInput ? (
                <div className="settings-field">
                  <label htmlFor="settings-strava-secret" className="settings-label">
                    {stravaSecretSaved ? 'New client secret' : 'Client secret'}
                  </label>
                  <input
                    ref={secretInputRef}
                    id="settings-strava-secret"
                    type="password"
                    autoComplete="new-password"
                    spellCheck={false}
                    aria-describedby={stravaSecretSaved ? 'settings-strava-secret-hint' : undefined}
                    value={stravaSecretInput}
                    onChange={(e) => setStravaSecretInput(e.target.value)}
                    className="settings-input"
                  />
                  {stravaSecretSaved && (
                    <div className="settings-row">
                      <p id="settings-strava-secret-hint" className="settings-hint">Leave empty to keep the saved secret.</p>
                      <button
                        type="button"
                        className="btn btn-ghost"
                        onClick={() => { setReplacingSecret(false); setStravaSecretInput(''); }}
                      >
                        Keep saved secret
                      </button>
                    </div>
                  )}
                </div>
              ) : (
                <div className="settings-field">
                  <span id="settings-strava-secret-label" className="settings-label">Client secret</span>
                  <div className="settings-row">
                    <span className="settings-secret-saved"><span aria-hidden="true">••••</span> saved</span>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      aria-describedby="settings-strava-secret-label"
                      onClick={() => setReplacingSecret(true)}
                    >
                      Replace
                    </button>
                  </div>
                </div>
              )}
              <div className="settings-actions">
                <button type="button" onClick={handleSaveStrava} className="btn btn-secondary">Save credentials</button>
                {stravaConnected ? (
                  <button type="button" onClick={() => setConfirmDisconnect('strava')} disabled={syncBusy} className="btn btn-secondary">Disconnect</button>
                ) : (
                  <button type="button" onClick={() => { void connectStrava(); }} disabled={stravaBusy} className="btn btn-primary">
                    {stravaBusy ? 'Connecting…' : 'Connect Strava'}
                  </button>
                )}
              </div>
            </div>
          </>
        )}
        <StatusLine status={stravaStatus.status} />
      </div>

      {/* ── Garmin, Zwift & other devices (via intervals.icu) ── */}
      <div className={`card settings-card ${intervalsInfo ? 'settings-card--teal' : ''}`}>
        <h2 className="card-title settings-card-title">
          Garmin, Zwift &amp; other devices
          {intervalsInfo && <span className="settings-badge settings-badge--teal">Via intervals.icu</span>}
        </h2>
        <p className="settings-lead">
          Garmin watches sync to Apollo through <strong>intervals.icu</strong> — free, and no Garmin developer approval needed.
        </p>
        <ol className="settings-steps">
          <li>
            In intervals.icu › Settings, connect Garmin Connect. Garmin asks for each permission separately: allow{' '}
            <strong>Download activities</strong> and <strong>Download wellness data</strong> (sleep, HRV, resting HR).
          </li>
          <li>
            To send your Apollo training plan to the watch, Garmin needs a second, separate approval:{' '}
            <strong>Upload planned workouts</strong>. The download approvals don&apos;t cover it, and it&apos;s only needed for that.
          </li>
          <li>Connect intervals.icu above. New activities then flow Garmin › intervals.icu › Apollo.</li>
        </ol>
        <p className="settings-hint">
          Zwift works the same way: connect it in intervals.icu. intervals.icu can also send your run workouts to Zwift — set your
          Zwift profile 5K time so the paces fit. Wahoo, COROS, Suunto and Polar connect through intervals.icu too.
        </p>
      </div>

      <p className="settings-note">
        Want your training plan on your watch or in your intervals.icu calendar? Send it from the{' '}
        <Link to="/plan">Plan page</Link>.
      </p>

      <ConfirmDialog
        open={confirmDisconnect !== null}
        title={confirmDisconnect === 'strava' ? 'Disconnect Strava?' : 'Disconnect intervals.icu?'}
        message="Activities already synced stay on this device. You can connect again any time."
        confirmLabel="Disconnect"
        onConfirm={handleConfirmDisconnect}
        onCancel={() => setConfirmDisconnect(null)}
      />
    </>
  );
}
