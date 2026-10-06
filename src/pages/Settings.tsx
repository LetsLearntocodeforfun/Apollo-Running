import { useState, useEffect, useRef, useCallback, type CSSProperties } from 'react';
import {
  getStravaCredentials,
  setStravaCredentials,
  setStravaTokens,
  getIntervalsCredentials,
  getSecureStorageError,
  onSecureStorageError,
} from '../services/storage';
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
} from '../services/activitySource';
import { runSync, type AutoSyncReport } from '../services/autoSync';
import { setWelcomeCompleted } from '../services/planProgress';
import { isWeb } from '../services/stravaWeb';
import { getStravaAuthUrl } from '../services/stravaWeb';
import {
  getCoachingPreferences,
  setCoachingPreferences,
  WEEKDAY_NAMES,
} from '../services/coachingPreferences';
import { getHRProfile, setHRProfile as saveHRProfile } from '../services/heartRate';
import { getAdaptivePreferences, setAdaptivePreferences } from '../services/adaptiveTraining';
import { getDistanceUnit, setDistanceUnit, type DistanceUnit } from '../services/unitPreferences';
import {
  getBackupConfig,
  setBackupConfig,
  getBackupHealth,
  getBackupRecords,
  createBackup,
  downloadCurrentData,
  downloadBackup,
  importFromFile,
  restoreFromBackup,
  formatBytes,
  type BackupConfig,
} from '../services/backupService';
import {
  APP_PREFS_CHANGED_EVENT,
  getAppPreferences,
  setAppPreferences,
  BACKGROUND_SYNC_OPTIONS,
  type AppPreferences,
} from '../services/appPreferences';
import { syncPlanCalendarIfChanged } from '../services/planCalendarSync';
import { syncWellness } from '../services/wellness';
import ImportActivities from '../components/ImportActivities';
import PlanCalendarPush from '../components/PlanCalendarPush';

type IntervalsAction = 'connect' | 'sync' | 'full';

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

function formatCount(n: number, one: string, many: string): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

/** "Just now", "12 min ago", "3 hr ago", else a short local date/time. */
function formatSyncTime(iso: string | null): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return 'Never';
  const minutes = Math.floor((Date.now() - t) / 60000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)} hr ago`;
  return new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
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

function backgroundSyncLabel(minutes: number): string {
  if (minutes <= 0) return 'Only when Apollo opens';
  if (minutes === 60) return 'Every hour';
  if (minutes > 60 && minutes % 60 === 0) return `Every ${minutes / 60} hours`;
  return `Every ${minutes} minutes`;
}

/** Offered intervals, keeping a custom stored value selectable. */
function backgroundSyncChoices(current: number): number[] {
  const options = [...BACKGROUND_SYNC_OPTIONS];
  if (!options.includes(current)) options.push(current);
  return options.sort((a, b) => a - b);
}

const textInputStyle: CSSProperties = {
  padding: '0.5rem 0.75rem', borderRadius: 'var(--radius-md)', border: '1px solid var(--border)',
  background: 'var(--bg)', color: 'var(--text)',
};

export default function Settings() {
  const [stravaClientId, setStravaClientId] = useState('');
  const [stravaSecret, setStravaSecret] = useState('');
  const [stravaConnected, setStravaConnected] = useState(() => isStravaConnected());
  const [intervalsApiKey, setIntervalsApiKey] = useState('');
  const [intervalsAthleteId, setIntervalsAthleteId] = useState('');
  const [intervalsInfo, setIntervalsInfo] = useState<IntervalsInfo | null>(() => readIntervalsInfo());
  const [intervalsSync, setIntervalsSync] = useState(() => getSourceSyncState('intervals'));
  const [intervalsAction, setIntervalsAction] = useState<IntervalsAction | null>(null);
  const [activityCount, setActivityCount] = useState(() => getStoredActivities().length);
  const [syncRunning, setSyncRunning] = useState(() => isSyncRunning());
  const [syncProgressText, setSyncProgressText] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const messageTimeoutRef = useRef<number | null>(null);
  const mountedRef = useRef(true);
  const [coachPrefs, setCoachPrefs] = useState(getCoachingPreferences());
  const [hrMax, setHrMax] = useState(String(getHRProfile().maxHR));
  const [hrResting, setHrResting] = useState(String(getHRProfile().restingHR));
  const [adaptivePrefs, setAdaptivePrefsState] = useState(getAdaptivePreferences());
  const [distanceUnit, setDistanceUnitState] = useState<DistanceUnit>(getDistanceUnit());
  const [backupConfig, setBackupConfigState] = useState<BackupConfig>(() => getBackupConfig());
  const [backupHealth] = useState(() => getBackupHealth());
  const [backupRecords, setBackupRecords] = useState(() => getBackupRecords());
  const [backupBusy, setBackupBusy] = useState(false);
  const [appPrefs, setAppPrefsState] = useState<AppPreferences>(() => getAppPreferences());
  const [updateState, setUpdateState] = useState<UpdateState | null>(null);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  /** Desktop only: why the OS keychain refused a credential (it then lasts for this session only). */
  const [keychainError, setKeychainError] = useState<string | null>(() => getSecureStorageError());

  const syncBusy = syncRunning || intervalsAction !== null;
  const syncStatusText = syncProgressText ?? (syncRunning ? 'Syncing activities…' : null);

  const showMessage = useCallback((text: string, ms = 3000) => {
    if (!mountedRef.current) return; // async handler finished after navigating away
    if (messageTimeoutRef.current != null) {
      window.clearTimeout(messageTimeoutRef.current);
      messageTimeoutRef.current = null;
    }
    setMessage(text);
    messageTimeoutRef.current = window.setTimeout(() => {
      setMessage(null);
      messageTimeoutRef.current = null;
    }, ms);
  }, []);

  /** Re-read connection + sync state for every source (after connect/disconnect/sync). */
  const refreshSourceState = useCallback(() => {
    setIntervalsInfo(readIntervalsInfo());
    setIntervalsSync(getSourceSyncState('intervals'));
    setStravaConnected(isStravaConnected());
    setActivityCount(getStoredActivities().length);
  }, []);

  /** Persist app prefs and tell App.tsx to re-read them (auto/background sync schedule). */
  const updateAppPrefs = useCallback((patch: Partial<AppPreferences>) => {
    setAppPreferences(patch);
    setAppPrefsState(getAppPreferences());
    window.dispatchEvent(new Event(APP_PREFS_CHANGED_EVENT));
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    const creds = getStravaCredentials();
    if (creds) {
      setStravaClientId(creds.clientId);
      setStravaSecret(creds.clientSecret);
    }
    setStravaConnected(isStravaConnected());
    // Load initial updater state if available
    if (window.electronAPI?.updater) {
      window.electronAPI.updater.getState().then(setUpdateState);
    }
    return () => {
      mountedRef.current = false;
      if (messageTimeoutRef.current != null) {
        window.clearTimeout(messageTimeoutRef.current);
        messageTimeoutRef.current = null;
      }
    };
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

  // Listen for real-time update state changes from main process
  useEffect(() => {
    if (!window.electronAPI?.updater) return;
    const unsub = window.electronAPI.updater.onStateChanged((state) => {
      setUpdateState(state);
      setCheckingUpdate(false);
    });
    return unsub;
  }, []);

  // Desktop: surface keychain failures (credentials then work for this session only).
  useEffect(() => {
    setKeychainError(getSecureStorageError());
    return onSecureStorageError(setKeychainError);
  }, []);

  const handleConnectIntervals = async () => {
    if (syncBusy) return;
    setError(null);
    setIntervalsAction('connect');
    setSyncProgressText('Checking your intervals.icu API key…');
    try {
      const athlete = await connectIntervals(intervalsApiKey, intervalsAthleteId.trim() || undefined);
      setIntervalsApiKey(''); // never keep the key in UI state once it's saved
      setIntervalsAthleteId('');
      refreshSourceState();
      // intervals.icu is the "set and forget" source: sync automatically from now on.
      updateAppPrefs({ autoSyncOnLaunch: true });
      setSyncProgressText('Importing your activity history…');
      const report = await runSync({
        full: true,
        onProgress: (p) => setSyncProgressText(formatSyncProgress(p)),
      });
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
        ? ' No activities found — in intervals.icu → Settings, connect Garmin, COROS or your other device platform directly (activities it imports from Strava aren\u2019t available to other apps).'
        : '';
      showMessage(`Connected as ${name} — imported ${formatCount(imported, 'activity', 'activities')}${planNote}.${emptyNote}`, emptyNote ? 20000 : 8000);
      if (errorText) setError(errorText);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not connect to intervals.icu.');
    } finally {
      setIntervalsAction(null);
      setSyncProgressText(null);
    }
  };

  const handleIntervalsSync = async (full: boolean) => {
    if (syncBusy) return;
    setError(null);
    setIntervalsAction(full ? 'full' : 'sync');
    try {
      const report = await runSync({
        full,
        onProgress: (p) => setSyncProgressText(formatSyncProgress(p)),
      });
      refreshSourceState();
      const s = report.summary;
      const errorText = describeSyncErrors(report);
      if (errorText) setError(errorText);
      if (!s || s.errors.length < s.sources.length) showMessage(describeSyncResult(report), 5000);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sync failed.');
    } finally {
      setIntervalsAction(null);
      setSyncProgressText(null);
    }
  };

  const handleDisconnectIntervals = () => {
    if (!confirm('Disconnect intervals.icu? Activities already synced stay on this device.')) return;
    disconnectSource('intervals');
    refreshSourceState();
    showMessage('intervals.icu disconnected. Activities already synced stay on this device.', 4000);
  };

  const saveStravaCredentials = () => {
    if (!stravaClientId.trim()) return;
    setStravaCredentials(stravaClientId.trim(), stravaSecret.trim());
    showMessage('Strava credentials saved.');
  };

  const connectStrava = async () => {
    if (isWeb()) {
      setError(null);
      setLoading(true);
      try {
        const url = await getStravaAuthUrl();
        window.location.href = url;
        return;
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not start Strava connection.');
        setLoading(false);
        return;
      }
    }
    if (!window.electronAPI || !stravaClientId.trim() || !stravaSecret.trim()) {
      setError('Enter Strava Client ID and Secret first, then save.');
      return;
    }
    setError(null);
    setLoading(true);
    try {
      saveStravaCredentials();
      // The main process starts the loopback server and waits for its port before building the
      // auth URL. Start waiting for the redirect *before* opening the browser so a fast approval
      // can't slip in between.
      const authUrl = await window.electronAPI.strava.getAuthUrl(stravaClientId.trim());
      const callback = window.electronAPI.oauth.startServer();
      callback.catch(() => { /* awaited below */ });
      await window.electronAPI.openExternal(authUrl);
      const server = await callback;
      const tokens = await window.electronAPI.strava.exchangeCode({
        clientId: stravaClientId.trim(),
        clientSecret: stravaSecret.trim(),
        code: server.code,
      });
      setStravaTokens({
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_at: tokens.expires_at,
        athlete: tokens.athlete,
      });
      setStravaConnected(true);
      showMessage(`Connected as ${tokens.athlete?.firstname ?? 'Strava'} — importing your Strava activities in the background…`, 5000);
      // Fire-and-forget: progress shows via onSyncStatus; failures land in the source's sync state.
      runSync().catch(() => { /* reported via sync state */ });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Strava connection failed.');
    } finally {
      setLoading(false);
    }
  };

  const disconnectStrava = () => {
    disconnectSource('strava');
    refreshSourceState();
    showMessage('Strava disconnected. Activities already synced stay on this device.', 4000);
  };

  return (
    <div>
      <h1 className="page-title">Settings</h1>
      {message && (
        <div className="card" role="status" style={{ background: 'var(--color-success-dim)', borderColor: 'var(--color-success)', borderLeftWidth: 3, borderLeftStyle: 'solid' }}>
          <span style={{ color: 'var(--color-success)', fontWeight: 600 }}>{message}</span>
        </div>
      )}
      {error && (
        <div className="card" role="alert" style={{ background: 'var(--color-error-dim)', borderColor: 'var(--color-error)', borderLeftWidth: 3, borderLeftStyle: 'solid' }}>
          <span style={{ color: 'var(--color-error)', fontWeight: 600 }}>Error:</span> {error}
        </div>
      )}
      {keychainError && window.electronAPI && (
        <div className="card" role="alert" style={{ borderColor: 'var(--apollo-gold)', borderLeftWidth: 3, borderLeftStyle: 'solid' }}>
          <span style={{ color: 'var(--apollo-gold)', fontWeight: 600 }}>Sign-in not saved:</span>{' '}
          your system keychain isn&apos;t available, so Apollo can&apos;t store your connection details securely.
          You&apos;re connected for this session, but you&apos;ll need to reconnect after restarting Apollo.
          On Linux, install or unlock a keyring such as GNOME Keyring or KWallet.
          <span style={{ display: 'block', color: 'var(--text-muted)', fontSize: '0.78rem', marginTop: '0.35rem' }}>
            Details: {keychainError}
          </span>
        </div>
      )}

      <h2 className="section-heading" style={{ margin: '0 0 0.75rem' }}>Data sources</h2>

      {/* ── intervals.icu (free, recommended source) ── */}
      <div className="card" style={{
        borderLeftWidth: 3, borderLeftStyle: 'solid',
        borderLeftColor: intervalsInfo ? 'var(--apollo-teal)' : 'var(--apollo-gold)',
      }}>
        <h3 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
          <span style={{ color: 'var(--apollo-teal)' }}>intervals.icu</span>
          <span style={{
            fontSize: '0.72rem', background: 'var(--apollo-gold-dim)',
            color: 'var(--apollo-gold)', padding: '0.15rem 0.6rem',
            borderRadius: 'var(--radius-full)', fontWeight: 600,
            fontFamily: 'var(--font-display)',
          }}>Free · Recommended</span>
          {intervalsInfo && (
            <span style={{
              fontSize: '0.72rem', background: 'var(--apollo-teal-dim)',
              color: 'var(--apollo-teal)', padding: '0.15rem 0.6rem',
              borderRadius: 'var(--radius-full)', fontWeight: 600,
              fontFamily: 'var(--font-display)',
            }}>Connected</span>
          )}
        </h3>
        <p style={{ color: 'var(--text-secondary)', margin: '0 0 1rem', fontSize: 'var(--text-sm)', lineHeight: 1.5 }}>
          intervals.icu is a free training platform that collects your workouts from Garmin Connect, Zwift, Wahoo, COROS, Suunto, Polar and more — runs, rides and cross-training.
          Connect it once and Apollo syncs every activity automatically.
        </p>
        {intervalsInfo ? (
          <>
            <dl style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '0.35rem 1rem', margin: '0 0 1rem', fontSize: 'var(--text-sm)', maxWidth: 520 }}>
              <dt style={{ color: 'var(--text-muted)' }}>Athlete</dt>
              <dd style={{ margin: 0, fontWeight: 600 }}>{intervalsDisplayName(intervalsInfo)}</dd>
              <dt style={{ color: 'var(--text-muted)' }}>API key</dt>
              <dd style={{ margin: 0 }}>
                {window.electronAPI
                  ? (keychainError ? 'For this session only (system keychain unavailable)' : 'Saved (encrypted on this device)')
                  : 'Saved in this browser'}
              </dd>
              <dt style={{ color: 'var(--text-muted)' }}>Last sync</dt>
              <dd style={{ margin: 0 }}>{formatSyncTime(intervalsSync.lastSyncAt)}</dd>
              <dt style={{ color: 'var(--text-muted)' }}>On this device</dt>
              <dd style={{ margin: 0 }}>{formatCount(activityCount, 'activity', 'activities')}</dd>
            </dl>
            {intervalsSync.lastError && (
              <p style={{ color: 'var(--color-error)', fontSize: '0.82rem', margin: '0 0 1rem', lineHeight: 1.4 }}>
                Last sync failed{intervalsSync.lastErrorAt ? ` (${formatSyncTime(intervalsSync.lastErrorAt)})` : ''}: {intervalsSync.lastError}
              </p>
            )}
            <div style={{ margin: '0 0 1rem', maxWidth: 520 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer', flexWrap: 'wrap' }}>
                <input
                  type="checkbox"
                  checked={appPrefs.syncWellness}
                  onChange={(e) => {
                    const checked = e.target.checked;
                    updateAppPrefs({ syncWellness: checked });
                    showMessage('Wellness sync ' + (checked ? 'enabled' : 'disabled') + '.');
                    if (checked) void syncWellness();
                  }}
                  style={{ width: 18, height: 18, accentColor: 'var(--apollo-teal)' }}
                />
                <span style={{ fontWeight: 500 }}>Sync sleep, HRV and resting HR</span>
              </label>
              <p style={{ color: 'var(--text-muted)', fontSize: '0.82rem', margin: '0.35rem 0 0 1.65rem', lineHeight: 1.4 }}>
                Powers the Recovery card and fills in your heart-rate profile. Your watch must send wellness data to
                intervals.icu (Settings → Connections; Garmin: tick “Wellness”).
              </p>
            </div>
            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
              <button type="button" className="btn btn-primary" disabled={syncBusy} onClick={() => { void handleIntervalsSync(false); }}>
                {intervalsAction === 'sync' ? 'Syncing…' : 'Sync now'}
              </button>
              <button type="button" className="btn btn-secondary" disabled={syncBusy} onClick={() => { void handleIntervalsSync(true); }}>
                {intervalsAction === 'full' ? 'Importing…' : 'Re-import full history'}
              </button>
              <button type="button" className="btn btn-secondary" disabled={syncBusy} onClick={handleDisconnectIntervals}>
                Disconnect
              </button>
            </div>
          </>
        ) : (
          <>
            <ol style={{
              margin: '0 0 1rem', paddingLeft: '1.25rem', color: 'var(--text-secondary)',
              fontSize: 'var(--text-sm)', lineHeight: 1.55, display: 'flex', flexDirection: 'column', gap: '0.4rem',
            }}>
              <li>
                Create a free account at{' '}
                <a href="https://intervals.icu" target="_blank" rel="noopener noreferrer">intervals.icu</a>.
              </li>
              <li>
                In intervals.icu → <strong>Settings</strong>, connect Garmin Connect, Zwift, Wahoo, COROS, Suunto or Polar.
                <span style={{ display: 'block', color: 'var(--text-muted)', fontSize: '0.8rem' }}>
                  Connect your device platform directly — activities intervals.icu imports from Strava aren&apos;t available to other apps.
                </span>
              </li>
              <li>
                In intervals.icu → <strong>Settings → Developer Settings</strong>, copy your <strong>API key</strong> (and Athlete ID) and paste them below.
              </li>
            </ol>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void handleConnectIntervals();
              }}
              style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', maxWidth: 400 }}
            >
              <label style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>API key</span>
                <input
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="Paste your intervals.icu API key"
                  value={intervalsApiKey}
                  onChange={(e) => setIntervalsApiKey(e.target.value)}
                  style={textInputStyle}
                />
              </label>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                <label style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                  <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>Athlete ID</span>
                  <input
                    type="text"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="i12345 (optional)"
                    aria-describedby="intervals-athlete-id-hint"
                    value={intervalsAthleteId}
                    onChange={(e) => setIntervalsAthleteId(e.target.value)}
                    style={textInputStyle}
                  />
                </label>
                <span id="intervals-athlete-id-hint" style={{ fontSize: '0.75rem', color: 'var(--text-muted)', lineHeight: 1.4 }}>
                  Shown next to your API key, e.g. i12345. Leave blank (or enter 0) to use the account that owns the key.
                </span>
              </div>
              <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                <button type="submit" className="btn btn-primary" disabled={syncBusy}>
                  {intervalsAction === 'connect' ? 'Connecting…' : 'Connect & import history'}
                </button>
              </div>
            </form>
          </>
        )}
        <div role="status" aria-live="polite" style={{
          display: 'flex', alignItems: 'center', gap: '0.5rem',
          marginTop: syncStatusText ? '0.85rem' : 0,
          fontSize: 'var(--text-sm)', color: 'var(--apollo-teal)',
        }}>
          {syncStatusText && (
            <>
              <span aria-hidden="true">⟳</span>
              <span>{syncStatusText}</span>
            </>
          )}
        </div>
      </div>

      {/* ── Activity files & Strava / Garmin exports (free, no account needed) ── */}
      <ImportActivities />

      {/* ── Strava (optional source) ── */}
      <div className="card" style={{
        borderLeftWidth: 3, borderLeftStyle: 'solid',
        borderLeftColor: stravaConnected ? 'var(--strava)' : 'var(--border)',
      }}>
        <h3 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
          <span style={{ color: 'var(--strava)' }}>Strava</span>
          <span style={{ color: 'var(--text-muted)', fontWeight: 500, fontSize: 'var(--text-sm)' }}>(optional)</span>
          {stravaConnected && (
            <span style={{
              fontSize: '0.72rem', background: 'rgba(252,76,2,0.12)',
              color: 'var(--strava)', padding: '0.15rem 0.6rem',
              borderRadius: 'var(--radius-full)', fontWeight: 600,
              fontFamily: 'var(--font-display)',
            }}>Connected</span>
          )}
        </h3>
        <p style={{ color: 'var(--text-secondary)', margin: '0 0 0.75rem', fontSize: 'var(--text-sm)', lineHeight: 1.5 }}>
          Strava API access may require a paid plan. If you have access, connect it here — otherwise use intervals.icu above, it&apos;s free.
        </p>
        {isWeb() ? (
          <>
            <p style={{ color: 'var(--text-muted)', marginBottom: '1rem', fontSize: 'var(--text-sm)', lineHeight: 1.5 }}>
              You’ll be redirected to Strava to authorize. Activities then sync automatically along with your other sources.
            </p>
            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
              {stravaConnected ? (
                <button type="button" onClick={disconnectStrava} disabled={syncBusy} className="btn btn-secondary">Disconnect</button>
              ) : (
                <button type="button" onClick={connectStrava} disabled={loading} className="btn btn-primary">
                  {loading ? 'Redirecting…' : 'Connect Strava'}
                </button>
              )}
            </div>
          </>
        ) : (
          <>
            <p style={{ color: 'var(--text-secondary)', marginBottom: '1rem', fontSize: 'var(--text-sm)', lineHeight: 1.5 }}>
              Create an app at <a href="https://www.strava.com/settings/api" target="_blank" rel="noopener noreferrer">strava.com/settings/api</a> to get Client ID and Client Secret. Use Authorization Callback Domain: <code style={{ background: 'var(--bg-surface)', padding: '0.1rem 0.4rem', borderRadius: 4 }}>127.0.0.1</code> (or leave default).
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', maxWidth: '400px' }}>
              <input
                type="text"
                placeholder="Strava Client ID"
                aria-label="Strava Client ID"
                value={stravaClientId}
                onChange={(e) => setStravaClientId(e.target.value)}
                style={{ padding: '0.5rem 0.75rem', borderRadius: 'var(--radius-md)', border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)' }}
              />
              <input
                type="password"
                placeholder="Strava Client Secret"
                aria-label="Strava Client Secret"
                value={stravaSecret}
                onChange={(e) => setStravaSecret(e.target.value)}
                style={{ padding: '0.5rem 0.75rem', borderRadius: 'var(--radius-md)', border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)' }}
              />
              <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                <button type="button" onClick={saveStravaCredentials} className="btn btn-secondary">Save credentials</button>
                {stravaConnected ? (
                  <button type="button" onClick={disconnectStrava} disabled={syncBusy} className="btn btn-secondary">Disconnect</button>
                ) : (
                  <button type="button" onClick={connectStrava} disabled={loading} className="btn btn-primary">
                    {loading ? 'Connecting…' : 'Connect Strava'}
                  </button>
                )}
              </div>
            </div>
          </>
        )}
      </div>

      {/* ── Garmin Connect (via intervals.icu) ── */}
      <div className="card" style={{
        borderLeftWidth: 3, borderLeftStyle: 'solid',
        borderLeftColor: intervalsInfo ? 'var(--apollo-teal)' : 'var(--border)',
      }}>
        <h3 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
          Garmin Connect
          {intervalsInfo && (
            <span style={{
              fontSize: '0.72rem', background: 'var(--apollo-teal-dim)',
              color: 'var(--apollo-teal)', padding: '0.15rem 0.6rem',
              borderRadius: 'var(--radius-full)', fontWeight: 600,
              fontFamily: 'var(--font-display)',
            }}>Via intervals.icu</span>
          )}
        </h3>
        <p style={{ color: 'var(--text-secondary)', margin: '0 0 0.5rem', fontSize: 'var(--text-sm)', lineHeight: 1.5 }}>
          Garmin watches sync to Apollo through <strong>intervals.icu</strong> — free, and no Garmin developer approval needed.
          Setup: in intervals.icu → Settings, connect Garmin Connect, then connect intervals.icu above. New activities flow Garmin → intervals.icu → Apollo automatically.
        </p>
        <p style={{ color: 'var(--text-muted)', margin: 0, fontSize: '0.82rem', lineHeight: 1.4 }}>
          Zwift rides and runs work the same way — as do Wahoo, COROS, Suunto and Polar. Connect them in intervals.icu and they show up here.
        </p>
      </div>

      {/* ── Training plan → intervals.icu calendar (and the watch) ── */}
      <PlanCalendarPush />

      <h2 className="section-heading" style={{ margin: '2rem 0 0.75rem' }}>Training &amp; preferences</h2>

      {/* ── Auto-Sync & Updates ── */}
      <div className="card" style={{
        borderLeftWidth: 3, borderLeftStyle: 'solid',
        borderLeftColor: 'var(--apollo-teal)',
      }}>
        <h3 style={{ color: 'var(--apollo-teal)' }}>Auto-Sync & Updates</h3>
        <p style={{ color: 'var(--text-secondary)', marginBottom: '1rem', fontSize: 'var(--text-sm)', lineHeight: 1.5 }}>
          Keep your data fresh and your app up to date automatically. Both features are opt-in.
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem', maxWidth: 520 }}>
          {/* Automatic activity sync (all connected sources) */}
          <div>
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer', flexWrap: 'wrap' }}>
              <input
                type="checkbox"
                checked={appPrefs.autoSyncOnLaunch}
                onChange={(e) => {
                  const checked = e.target.checked;
                  updateAppPrefs({ autoSyncOnLaunch: checked });
                  showMessage('Automatic activity sync ' + (checked ? 'enabled' : 'disabled') + '.');
                }}
                style={{ width: 18, height: 18, accentColor: 'var(--apollo-teal)' }}
              />
              <span style={{ fontWeight: 500 }}>Automatically sync activities</span>
              {!intervalsInfo && !stravaConnected && (
                <span style={{
                  fontSize: '0.68rem', background: 'var(--color-warning-dim, rgba(224,123,48,0.12))',
                  color: 'var(--color-warning, #E07B30)', padding: '0.1rem 0.5rem',
                  borderRadius: 'var(--radius-full)', fontWeight: 600,
                  fontFamily: 'var(--font-display)',
                }}>Connect intervals.icu or Strava first</span>
              )}
            </label>
            <p style={{ color: 'var(--text-muted)', fontSize: '0.82rem', margin: '0.35rem 0 0 1.65rem', lineHeight: 1.4 }}>
              Syncs every connected source when Apollo opens and in the background while it&apos;s open, so each day&apos;s runs, rides and other workouts are pulled in automatically.
            </p>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap', margin: '0.6rem 0 0 1.65rem' }}>
              <label htmlFor="settings-background-sync" style={{ fontSize: '0.88rem', color: 'var(--text-muted)' }}>
                Sync while open
              </label>
              <select
                id="settings-background-sync"
                value={appPrefs.backgroundSyncMinutes}
                disabled={!appPrefs.autoSyncOnLaunch}
                onChange={(e) => {
                  const minutes = Number(e.target.value);
                  updateAppPrefs({ backgroundSyncMinutes: minutes });
                  showMessage(`Background sync: ${backgroundSyncLabel(minutes).toLowerCase()}.`);
                }}
                style={{
                  padding: '0.35rem 0.5rem', borderRadius: 8, border: '1px solid var(--border)',
                  background: 'var(--bg)', color: 'var(--text)', fontSize: '0.9rem',
                  opacity: appPrefs.autoSyncOnLaunch ? 1 : 0.5,
                }}
              >
                {backgroundSyncChoices(appPrefs.backgroundSyncMinutes).map((minutes) => (
                  <option key={minutes} value={minutes}>{backgroundSyncLabel(minutes)}</option>
                ))}
              </select>
            </div>
          </div>

          {/* Auto-Update (Electron only) */}
          {window.electronAPI?.updater && (
            <div style={{ borderTop: '1px solid var(--border)', paddingTop: '1.25rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.75rem' }}>
                <span style={{ fontWeight: 600, fontSize: '0.95rem' }}>App Updates</span>
                <span style={{
                  fontSize: '0.65rem', background: 'rgba(76, 175, 80, 0.12)',
                  color: 'var(--color-success, #4CAF50)', padding: '0.1rem 0.5rem',
                  borderRadius: 'var(--radius-full)', fontWeight: 600,
                  fontFamily: 'var(--font-display)',
                }}>Recommended</span>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={appPrefs.autoCheckUpdates}
                    onChange={(e) => {
                      const checked = e.target.checked;
                      const next: AppPreferences = {
                        ...appPrefs,
                        autoCheckUpdates: checked,
                        // If unchecking auto-check, also disable auto-download
                        autoDownloadUpdates: checked ? appPrefs.autoDownloadUpdates : false,
                      };
                      setAppPreferences(next);
                      setAppPrefsState(next);
                      // Reconfigure the main process immediately
                      window.electronAPI?.updater.configure({
                        autoCheck: next.autoCheckUpdates,
                        autoDownload: next.autoDownloadUpdates,
                      });
                      showMessage('Auto-check for updates ' + (checked ? 'enabled' : 'disabled') + '.');
                    }}
                    style={{ width: 18, height: 18, accentColor: 'var(--accent)' }}
                  />
                  <span style={{ fontWeight: 500 }}>Check for updates on launch</span>
                </label>

                {appPrefs.autoCheckUpdates && (
                  <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer', marginLeft: '1.65rem' }}>
                    <input
                      type="checkbox"
                      checked={appPrefs.autoDownloadUpdates}
                      onChange={(e) => {
                        const next = { ...appPrefs, autoDownloadUpdates: e.target.checked };
                        setAppPreferences(next);
                        setAppPrefsState(next);
                        window.electronAPI?.updater.configure({
                          autoCheck: next.autoCheckUpdates,
                          autoDownload: next.autoDownloadUpdates,
                        });
                        showMessage('Auto-download updates ' + (e.target.checked ? 'enabled' : 'disabled') + '.');
                      }}
                      style={{ width: 18, height: 18, accentColor: 'var(--accent)' }}
                    />
                    <span style={{ fontWeight: 500 }}>Download updates automatically</span>
                  </label>
                )}
              </div>

              <p style={{ color: 'var(--text-muted)', fontSize: '0.82rem', margin: '0.5rem 0 0 1.65rem', lineHeight: 1.4 }}>
                Apollo checks GitHub for new releases. Updates are never forced — you always decide when to install. Enabling auto-update keeps you on the latest version with the newest features and bug fixes.
              </p>

              {/* Manual update controls & status */}
              <div style={{ marginTop: '1rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    disabled={checkingUpdate}
                    style={{ fontSize: 'var(--text-sm)' }}
                    onClick={async () => {
                      setCheckingUpdate(true);
                      try {
                        const state = await window.electronAPI!.updater.check();
                        setUpdateState(state);
                        if (state.status === 'not-available') {
                          showMessage('You\'re on the latest version.');
                        }
                      } catch {
                        showMessage('Could not check for updates.');
                      } finally {
                        setCheckingUpdate(false);
                      }
                    }}
                  >
                    {checkingUpdate ? 'Checking…' : 'Check for Updates'}
                  </button>

                  {updateState?.status === 'available' && (
                    <button
                      type="button"
                      className="btn btn-primary"
                      style={{ fontSize: 'var(--text-sm)' }}
                      onClick={async () => {
                        const state = await window.electronAPI!.updater.download();
                        setUpdateState(state);
                      }}
                    >
                      Download v{updateState.version}
                    </button>
                  )}

                  {updateState?.status === 'downloaded' && (
                    <button
                      type="button"
                      className="btn btn-primary"
                      style={{ fontSize: 'var(--text-sm)' }}
                      onClick={() => window.electronAPI!.updater.install()}
                    >
                      Restart & Install
                    </button>
                  )}
                </div>

                {/* Progress / status display */}
                {updateState?.status === 'downloading' && updateState.downloadProgress != null && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                    <div style={{
                      flex: 1, height: 6, background: 'var(--bg-surface, #1B2838)',
                      borderRadius: 'var(--radius-full)', overflow: 'hidden',
                    }}>
                      <div style={{
                        width: `${updateState.downloadProgress}%`, height: '100%',
                        background: 'var(--apollo-teal)', borderRadius: 'var(--radius-full)',
                        transition: 'width 0.3s ease',
                      }} />
                    </div>
                    <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums', minWidth: 36 }}>
                      {updateState.downloadProgress}%
                    </span>
                  </div>
                )}

                {updateState?.status === 'downloaded' && (
                  <div style={{
                    fontSize: '0.82rem', color: 'var(--color-success, #4CAF50)',
                    display: 'flex', alignItems: 'center', gap: '0.4rem',
                  }}>
                    <span>✓</span> Update v{updateState.version} downloaded — ready to install
                  </div>
                )}

                {updateState?.status === 'error' && (
                  <div style={{ fontSize: '0.82rem', color: 'var(--color-error, #f44336)' }}>
                    {updateState.error}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── Distance Units ── */}
      <div className="card" style={{
        borderLeftWidth: 3, borderLeftStyle: 'solid',
        borderLeftColor: 'var(--apollo-gold)',
      }}>
        <h3 style={{ color: 'var(--apollo-gold)' }}>Distance Units</h3>
        <p style={{ color: 'var(--text-secondary)', marginBottom: '1rem', fontSize: 'var(--text-sm)', lineHeight: 1.5 }}>
          Choose how distances, paces, and elevations are displayed across Apollo.
        </p>
        <div style={{ display: 'flex', gap: '0.75rem', maxWidth: 360 }}>
          <button
            type="button"
            onClick={() => {
              setDistanceUnit('mi');
              void syncPlanCalendarIfChanged();
              setDistanceUnitState('mi');
              showMessage('Switched to miles.');
            }}
            style={{
              flex: 1, padding: '0.85rem 0.75rem',
              borderRadius: 'var(--radius-md)',
              border: distanceUnit === 'mi' ? '2px solid var(--apollo-gold)' : '2px solid var(--border)',
              background: distanceUnit === 'mi' ? 'var(--apollo-gold-dim)' : 'var(--bg)',
              color: distanceUnit === 'mi' ? 'var(--apollo-gold)' : 'var(--text-secondary)',
              cursor: 'pointer', textAlign: 'center',
              transition: 'all var(--transition-fast)',
              fontFamily: 'var(--font-display)', fontWeight: 600,
            }}
          >
            <div style={{ fontSize: '1.15rem', marginBottom: '0.25rem' }}>Miles</div>
            <div style={{ fontSize: '0.72rem', fontWeight: 400, color: 'var(--text-muted)' }}>min/mi · ft</div>
          </button>
          <button
            type="button"
            onClick={() => {
              setDistanceUnit('km');
              void syncPlanCalendarIfChanged();
              setDistanceUnitState('km');
              showMessage('Switched to kilometers.');
            }}
            style={{
              flex: 1, padding: '0.85rem 0.75rem',
              borderRadius: 'var(--radius-md)',
              border: distanceUnit === 'km' ? '2px solid var(--apollo-teal)' : '2px solid var(--border)',
              background: distanceUnit === 'km' ? 'var(--apollo-teal-dim)' : 'var(--bg)',
              color: distanceUnit === 'km' ? 'var(--apollo-teal)' : 'var(--text-secondary)',
              cursor: 'pointer', textAlign: 'center',
              transition: 'all var(--transition-fast)',
              fontFamily: 'var(--font-display)', fontWeight: 600,
            }}
          >
            <div style={{ fontSize: '1.15rem', marginBottom: '0.25rem' }}>Kilometers</div>
            <div style={{ fontSize: '0.72rem', fontWeight: 400, color: 'var(--text-muted)' }}>min/km · m</div>
          </button>
        </div>
      </div>

      {/* ── Coaching & Insights ── */}
      <div className="card" style={{
        borderLeftWidth: 3, borderLeftStyle: 'solid',
        borderLeftColor: 'var(--apollo-teal)',
      }}>
        <h3 style={{ color: 'var(--apollo-teal)' }}>Coaching & Insights</h3>
        <p style={{ color: 'var(--text-secondary)', marginBottom: '1rem', fontSize: 'var(--text-sm)', lineHeight: 1.5 }}>
          Configure your daily recap and weekly Race Day Readiness notifications.
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', maxWidth: 480 }}>
          {/* Daily Recap */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={coachPrefs.dailyRecapEnabled}
                onChange={(e) => {
                  const next = { ...coachPrefs, dailyRecapEnabled: e.target.checked };
                  setCoachingPreferences(next);
                  setCoachPrefs(next);
                  showMessage('Daily recap ' + (e.target.checked ? 'enabled' : 'disabled') + '.');
                }}
                style={{ width: 18, height: 18, accentColor: 'var(--accent)' }}
              />
              <span style={{ fontWeight: 500 }}>Daily training recap</span>
            </label>
            {coachPrefs.dailyRecapEnabled && (
              <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                <span style={{ fontSize: '0.88rem', color: 'var(--text-muted)' }}>at</span>
                <input
                  type="time"
                  value={coachPrefs.dailyRecapTime}
                  onChange={(e) => {
                    const next = { ...coachPrefs, dailyRecapTime: e.target.value };
                    setCoachingPreferences(next);
                    setCoachPrefs(next);
                  }}
                  style={{ padding: '0.35rem 0.5rem', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', fontSize: '0.9rem' }}
                />
              </label>
            )}
          </div>

          {/* Weekly Readiness */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={coachPrefs.weeklyRecapEnabled}
                onChange={(e) => {
                  const next = { ...coachPrefs, weeklyRecapEnabled: e.target.checked };
                  setCoachingPreferences(next);
                  setCoachPrefs(next);
                  showMessage('Weekly readiness ' + (e.target.checked ? 'enabled' : 'disabled') + '.');
                }}
                style={{ width: 18, height: 18, accentColor: 'var(--accent)' }}
              />
              <span style={{ fontWeight: 500 }}>Weekly Race Day Readiness</span>
            </label>
            {coachPrefs.weeklyRecapEnabled && (
              <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                <span style={{ fontSize: '0.88rem', color: 'var(--text-muted)' }}>on</span>
                <select
                  value={coachPrefs.weeklyRecapDay}
                  onChange={(e) => {
                    const next = { ...coachPrefs, weeklyRecapDay: Number(e.target.value) };
                    setCoachingPreferences(next);
                    setCoachPrefs(next);
                  }}
                  style={{ padding: '0.35rem 0.5rem', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', fontSize: '0.9rem' }}
                >
                  {WEEKDAY_NAMES.map((name, i) => (
                    <option key={i} value={i}>{name}</option>
                  ))}
                </select>
              </label>
            )}
          </div>

          {/* Heart Rate Profile */}
          <div style={{ borderTop: '1px solid var(--border)', paddingTop: '1rem', marginTop: '0.25rem' }}>
            <strong style={{ fontSize: '0.95rem' }}>Heart Rate Profile</strong>
            <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', margin: '0.25rem 0 0.75rem' }}>
              Set your max and resting HR for accurate zone calculations. Auto-updates when a synced activity records a higher max HR.
            </p>
            <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', alignItems: 'end' }}>
              <label style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>Max HR (bpm)</span>
                <input
                  type="number"
                  value={hrMax}
                  onChange={(e) => setHrMax(e.target.value)}
                  style={{ width: 80, padding: '0.4rem', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)' }}
                />
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>Resting HR (bpm)</span>
                <input
                  type="number"
                  value={hrResting}
                  onChange={(e) => setHrResting(e.target.value)}
                  style={{ width: 80, padding: '0.4rem', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)' }}
                />
              </label>
              <button
                type="button"
                className="btn btn-primary"
                style={{ fontSize: '0.85rem' }}
                onClick={() => {
                  const maxVal = parseInt(hrMax, 10);
                  const restVal = parseInt(hrResting, 10);
                  if (!maxVal || maxVal < 100 || maxVal > 230) return;
                  if (!restVal || restVal < 30 || restVal > 120) return;
                  saveHRProfile({ maxHR: maxVal, restingHR: restVal, source: 'manual', updatedAt: new Date().toISOString() });
                  showMessage('Heart rate profile saved.');
                }}
              >Save</button>
            </div>
          </div>
        </div>
      </div>

      {/* ── Adaptive Training Recommendations ── */}
      <div className="card" style={{
        borderLeftWidth: 3, borderLeftStyle: 'solid',
        borderLeftColor: 'var(--apollo-gold)',
      }}>
        <h3 style={{ color: 'var(--apollo-gold)' }}>Adaptive Training Recommendations</h3>
        <p style={{ color: 'var(--text-secondary)', marginBottom: '1rem', fontSize: 'var(--text-sm)', lineHeight: 1.5 }}>
          Apollo analyzes your synced activities and plan progress to suggest intelligent adjustments — like reducing mileage when you're overtraining or leveling up when you're ahead of schedule.
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', maxWidth: 480 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={adaptivePrefs.enabled}
              onChange={(e) => {
                const next = { ...adaptivePrefs, enabled: e.target.checked };
                setAdaptivePreferences(next);
                setAdaptivePrefsState(next);
                showMessage('Adaptive recommendations ' + (e.target.checked ? 'enabled' : 'disabled') + '.');
              }}
              style={{ width: 18, height: 18, accentColor: 'var(--accent)' }}
            />
            <span style={{ fontWeight: 500 }}>Enable Adaptive Recommendations</span>
          </label>

          {adaptivePrefs.enabled && (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
                <span style={{ fontSize: '0.88rem', color: 'var(--text-muted)' }}>Frequency</span>
                <select
                  value={adaptivePrefs.frequency}
                  onChange={(e) => {
                    const next = { ...adaptivePrefs, frequency: e.target.value as 'daily' | 'weekly' | 'before_key_workouts' };
                    setAdaptivePreferences(next);
                    setAdaptivePrefsState(next);
                  }}
                  style={{ padding: '0.35rem 0.5rem', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', fontSize: '0.9rem' }}
                >
                  <option value="daily">Daily</option>
                  <option value="weekly">Weekly</option>
                  <option value="before_key_workouts">Before Key Workouts</option>
                </select>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
                <span style={{ fontSize: '0.88rem', color: 'var(--text-muted)' }}>Aggressiveness</span>
                <select
                  value={adaptivePrefs.aggressiveness}
                  onChange={(e) => {
                    const next = { ...adaptivePrefs, aggressiveness: e.target.value as 'conservative' | 'balanced' | 'aggressive' };
                    setAdaptivePreferences(next);
                    setAdaptivePrefsState(next);
                  }}
                  style={{ padding: '0.35rem 0.5rem', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', fontSize: '0.9rem' }}
                >
                  <option value="conservative">Conservative — fewer, gentler suggestions</option>
                  <option value="balanced">Balanced — default sensitivity</option>
                  <option value="aggressive">Aggressive — more proactive suggestions</option>
                </select>
              </div>

              <p style={{ color: 'var(--text-muted)', fontSize: '0.82rem', margin: 0, lineHeight: 1.4 }}>
                Recommendations use your synced activities, plan completion rate, readiness scores, and pace trends. No data leaves your device.
              </p>
            </>
          )}
        </div>
      </div>

      {/* ── Data Management & Backups ── */}
      <div className="card" style={{
        borderLeftWidth: 3, borderLeftStyle: 'solid',
        borderLeftColor: backupHealth.status === 'healthy' ? 'var(--color-success)' : backupHealth.status === 'warning' ? 'var(--color-warning)' : 'var(--color-error)',
      }}>
        <h3 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          Data Management & Backups
          <span style={{
            fontSize: '0.72rem',
            background: backupHealth.status === 'healthy' ? 'var(--color-success-dim)' : backupHealth.status === 'warning' ? 'rgba(224,123,48,0.12)' : 'var(--color-error-dim)',
            color: backupHealth.status === 'healthy' ? 'var(--color-success)' : backupHealth.status === 'warning' ? 'var(--color-warning)' : 'var(--color-error)',
            padding: '0.15rem 0.6rem', borderRadius: 'var(--radius-full)',
            fontWeight: 600, fontFamily: 'var(--font-display)',
          }}>
            {backupHealth.status === 'healthy' ? 'Protected' : backupHealth.status === 'warning' ? 'Warning' : 'At Risk'}
          </span>
        </h3>
        <p style={{ color: 'var(--text-secondary)', marginBottom: '1rem', fontSize: 'var(--text-sm)', lineHeight: 1.5 }}>
          {backupHealth.message}
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', maxWidth: 520 }}>
          {/* Auto-Backup Toggle */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={backupConfig.autoBackupEnabled}
                onChange={(e) => {
                  const next = { ...backupConfig, autoBackupEnabled: e.target.checked };
                  setBackupConfig(next);
                  setBackupConfigState(next);
                  showMessage('Auto-backup ' + (e.target.checked ? 'enabled' : 'disabled') + '.');
                }}
                style={{ width: 18, height: 18, accentColor: 'var(--accent)' }}
              />
              <span style={{ fontWeight: 500 }}>Automatic backups</span>
            </label>
            {backupConfig.autoBackupEnabled && (
              <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                <span style={{ fontSize: '0.88rem', color: 'var(--text-muted)' }}>every</span>
                <select
                  value={backupConfig.intervalHours}
                  onChange={(e) => {
                    const next = { ...backupConfig, intervalHours: Number(e.target.value) };
                    setBackupConfig(next);
                    setBackupConfigState(next);
                  }}
                  style={{ padding: '0.35rem 0.5rem', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', fontSize: '0.9rem' }}
                >
                  <option value={12}>12 hours</option>
                  <option value={24}>24 hours</option>
                  <option value={48}>2 days</option>
                  <option value={168}>1 week</option>
                </select>
                <span style={{ fontSize: '0.88rem', color: 'var(--text-muted)' }}>
                  · keep {backupConfig.maxBackups}
                </span>
              </label>
            )}
          </div>

          {/* Manual Actions */}
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            <button
              type="button"
              className="btn btn-primary"
              disabled={backupBusy}
              style={{ fontSize: 'var(--text-sm)' }}
              onClick={async () => {
                setBackupBusy(true);
                try {
                  const record = await createBackup('manual');
                  setBackupRecords(getBackupRecords());
                  showMessage(record ? `Backup created (${formatBytes(record.sizeBytes)}).` : 'Backup failed.', 3000);
                } finally {
                  setBackupBusy(false);
                }
              }}
            >
              {backupBusy ? 'Working…' : 'Create Backup Now'}
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              style={{ fontSize: 'var(--text-sm)' }}
              onClick={() => downloadCurrentData()}
            >
              Export Data
            </button>
            <label
              className="btn btn-secondary"
              style={{ fontSize: 'var(--text-sm)', cursor: 'pointer', display: 'inline-flex', alignItems: 'center' }}
            >
              Import Data
              <input
                type="file"
                accept=".json"
                style={{ display: 'none' }}
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  setBackupBusy(true);
                  try {
                    const result = await importFromFile(file);
                    showMessage(result.message, result.success ? 4000 : 5000);
                  } finally {
                    setBackupBusy(false);
                    e.target.value = '';
                  }
                }}
              />
            </label>
          </div>

          {/* Backup History */}
          {backupRecords.length > 0 && (
            <div style={{ borderTop: '1px solid var(--border)', paddingTop: '0.75rem' }}>
              <strong style={{ fontSize: '0.88rem', color: 'var(--text-muted)' }}>Backup History ({backupRecords.length})</strong>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem', marginTop: '0.5rem' }}>
                {backupRecords.slice(-5).reverse().map((r) => (
                  <div key={r.id} style={{
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                    fontSize: 'var(--text-sm)', padding: '0.35rem 0.5rem',
                    background: 'var(--bg-surface)', borderRadius: 'var(--radius-sm)',
                  }}>
                    <div>
                      <span style={{ color: 'var(--text)' }}>{new Date(r.createdAt).toLocaleDateString()}</span>
                      <span style={{ color: 'var(--text-muted)', marginLeft: '0.5rem' }}>
                        {new Date(r.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </span>
                      <span style={{ color: 'var(--text-muted)', marginLeft: '0.5rem' }}>{r.keyCount} keys · {formatBytes(r.sizeBytes)}</span>
                      <span style={{
                        marginLeft: '0.35rem', fontSize: '0.68rem',
                        padding: '0.08rem 0.35rem', borderRadius: 'var(--radius-full)',
                        background: r.trigger === 'auto' ? 'var(--apollo-teal-dim)' : 'var(--apollo-gold-dim)',
                        color: r.trigger === 'auto' ? 'var(--apollo-teal)' : 'var(--apollo-gold)',
                        fontWeight: 600, fontFamily: 'var(--font-display)',
                      }}>{r.trigger}</span>
                      {r.verified && (
                        <span style={{ marginLeft: '0.25rem', color: 'var(--color-success)', fontSize: '0.72rem' }} title="Integrity verified">✓</span>
                      )}
                    </div>
                    <div style={{ display: 'flex', gap: '0.35rem' }}>
                      <button
                        type="button"
                        onClick={() => downloadBackup(r.id)}
                        style={{
                          background: 'none', border: 'none', color: 'var(--apollo-gold)',
                          cursor: 'pointer', fontSize: '0.78rem', fontFamily: 'var(--font-display)',
                          fontWeight: 600, padding: '0.2rem 0.4rem',
                        }}
                      >↓</button>
                      <button
                        type="button"
                        onClick={async () => {
                          if (!confirm('Restore this backup? Current data will be backed up first.')) return;
                          setBackupBusy(true);
                          try {
                            const ok = await restoreFromBackup(r.id);
                            showMessage(ok ? 'Restored successfully. Refresh to see changes.' : 'Restore failed — checksum mismatch.', 4000);
                          } finally {
                            setBackupBusy(false);
                          }
                        }}
                        style={{
                          background: 'none', border: 'none', color: 'var(--text-muted)',
                          cursor: 'pointer', fontSize: '0.78rem', fontFamily: 'var(--font-display)',
                          fontWeight: 600, padding: '0.2rem 0.4rem',
                        }}
                      >Restore</button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <p style={{ color: 'var(--text-muted)', fontSize: '0.78rem', margin: 0, lineHeight: 1.4 }}>
            Backups use SHA-256 checksums to detect corruption. All data stays on your device — nothing is sent anywhere.
          </p>
        </div>
      </div>

      <div className="card">
        <h3>Training Plan</h3>
        <p style={{ color: 'var(--text-secondary)', marginBottom: '1rem', fontSize: 'var(--text-sm)', lineHeight: 1.5 }}>
          To change or pick a plan from the full library (Hal Higdon, Hanson&apos;s, Pfitzinger, Nike Run Club, FIRST) or rebuild a custom plan, you can see the welcome screen again.
        </p>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => {
            setWelcomeCompleted(false);
            window.location.reload();
          }}
        >
          Show plan picker again
        </button>
      </div>
    </div>
  );
}
