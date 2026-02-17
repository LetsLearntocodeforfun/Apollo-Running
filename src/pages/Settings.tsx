import { useState, useEffect, useRef, useCallback } from 'react';
import {
  getStravaTokens,
  getStravaCredentials,
  setStravaCredentials,
  setStravaTokens,
  clearStravaTokens,
  getGarminCredentials,
  setGarminCredentials,
  clearGarminTokens,
  getGarminTokens,
} from '../services/storage';
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

export default function Settings() {
  const [stravaClientId, setStravaClientId] = useState('');
  const [stravaSecret, setStravaSecret] = useState('');
  const [garminClientId, setGarminClientId] = useState('');
  const [garminSecret, setGarminSecret] = useState('');
  const [stravaConnected, setStravaConnected] = useState(false);
  const [garminConnected, setGarminConnected] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const messageTimeoutRef = useRef<number | null>(null);
  const [coachPrefs, setCoachPrefs] = useState(getCoachingPreferences());
  const [hrMax, setHrMax] = useState(String(getHRProfile().maxHR));
  const [hrResting, setHrResting] = useState(String(getHRProfile().restingHR));
  const [adaptivePrefs, setAdaptivePrefsState] = useState(getAdaptivePreferences());
  const [distanceUnit, setDistanceUnitState] = useState<DistanceUnit>(getDistanceUnit());
  const [backupConfig, setBackupConfigState] = useState<BackupConfig>(() => getBackupConfig());
  const [backupHealth] = useState(() => getBackupHealth());
  const [backupRecords, setBackupRecords] = useState(() => getBackupRecords());
  const [backupBusy, setBackupBusy] = useState(false);

  const showMessage = useCallback((text: string, ms = 3000) => {
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

  useEffect(() => {
    const creds = getStravaCredentials();
    if (creds) {
      setStravaClientId(creds.clientId);
      setStravaSecret(creds.clientSecret);
    }
    setStravaConnected(!!getStravaTokens());
    const gcreds = getGarminCredentials();
    if (gcreds) {
      setGarminClientId(gcreds.clientId);
      setGarminSecret(gcreds.clientSecret);
    }
    setGarminConnected(!!getGarminTokens());
    return () => {
      if (messageTimeoutRef.current != null) {
        window.clearTimeout(messageTimeoutRef.current);
        messageTimeoutRef.current = null;
      }
    };
  }, []);

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
      const authUrl = await window.electronAPI.strava.getAuthUrl(stravaClientId.trim());
      await window.electronAPI.openExternal(authUrl);
      const server = await window.electronAPI.oauth.startServer();
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
      showMessage(`Connected as ${tokens.athlete?.firstname ?? 'Strava'}.`, 4000);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Strava connection failed.');
    } finally {
      setLoading(false);
    }
  };

  const disconnectStrava = () => {
    clearStravaTokens();
    setStravaConnected(false);
    showMessage('Strava disconnected.');
  };

  const saveGarminCredentials = () => {
    if (!garminClientId.trim()) return;
    setGarminCredentials(garminClientId.trim(), garminSecret.trim());
    showMessage('Garmin credentials saved.');
  };

  const disconnectGarmin = () => {
    clearGarminTokens();
    setGarminConnected(false);
    showMessage('Garmin disconnected.');
  };

  return (
    <div>
      <h1 className="page-title">Settings</h1>
      {message && (
        <div className="card" style={{ background: 'var(--color-success-dim)', borderColor: 'var(--color-success)', borderLeftWidth: 3, borderLeftStyle: 'solid' }}>
          <span style={{ color: 'var(--color-success)', fontWeight: 600 }}>{message}</span>
        </div>
      )}
      {error && (
        <div className="card" style={{ background: 'var(--color-error-dim)', borderColor: 'var(--color-error)', borderLeftWidth: 3, borderLeftStyle: 'solid' }}>
          <span style={{ color: 'var(--color-error)', fontWeight: 600 }}>Error:</span> {error}
        </div>
      )}

      <div className="card" style={{
        borderLeftWidth: 3, borderLeftStyle: 'solid',
        borderLeftColor: stravaConnected ? 'var(--strava)' : 'var(--border)',
      }}>
        <h3 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <span style={{ color: 'var(--strava)' }}>Strava</span>
          {stravaConnected && (
            <span style={{
              fontSize: '0.72rem', background: 'rgba(252,76,2,0.12)',
              color: 'var(--strava)', padding: '0.15rem 0.6rem',
              borderRadius: 'var(--radius-full)', fontWeight: 600,
              fontFamily: 'var(--font-display)',
            }}>Connected</span>
          )}
        </h3>
        {isWeb() ? (
          <>
            <p style={{ color: 'var(--text-muted)', marginBottom: '1rem', fontSize: 'var(--text-sm)', lineHeight: 1.5 }}>
              Connect your Strava account to sync activities. You’ll be redirected to Strava to authorize.
            </p>
            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
              {stravaConnected ? (
                <button type="button" onClick={disconnectStrava} className="btn btn-secondary">Disconnect</button>
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
                value={stravaClientId}
                onChange={(e) => setStravaClientId(e.target.value)}
                style={{ padding: '0.5rem 0.75rem', borderRadius: 'var(--radius-md)', border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)' }}
              />
              <input
                type="password"
                placeholder="Strava Client Secret"
                value={stravaSecret}
                onChange={(e) => setStravaSecret(e.target.value)}
                style={{ padding: '0.5rem 0.75rem', borderRadius: 'var(--radius-md)', border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)' }}
              />
              <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                <button type="button" onClick={saveStravaCredentials} className="btn btn-secondary">Save credentials</button>
                {stravaConnected ? (
                  <button type="button" onClick={disconnectStrava} className="btn btn-secondary">Disconnect</button>
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

      <div className="card" style={{
        borderLeftWidth: 3, borderLeftStyle: 'solid',
        borderLeftColor: garminConnected ? 'var(--color-success)' : 'var(--border)',
      }}>
        <h3 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          Garmin Connect
          {garminConnected && (
            <span style={{
              fontSize: '0.72rem', background: 'var(--color-success-dim)',
              color: 'var(--color-success)', padding: '0.15rem 0.6rem',
              borderRadius: 'var(--radius-full)', fontWeight: 600,
              fontFamily: 'var(--font-display)',
            }}>Connected</span>
          )}
        </h3>
        <p style={{ color: 'var(--text-secondary)', marginBottom: '1rem', fontSize: 'var(--text-sm)', lineHeight: 1.5 }}>
          Garmin uses the <strong>Garmin Connect Developer Program</strong>. Apply at <a href="https://developer.garmin.com/gc-developer-program/" target="_blank" rel="noopener noreferrer">developer.garmin.com</a>. Once approved you get Activity API, Health API, Training API, and Courses API. This app includes the structure; full OAuth 2.0 + PKCE can be added when you have keys.
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', maxWidth: '400px' }}>
          <input
            type="text"
            placeholder="Garmin Client ID (when approved)"
            value={garminClientId}
            onChange={(e) => setGarminClientId(e.target.value)}
            style={{ padding: '0.5rem 0.75rem', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)' }}
          />
          <input
            type="password"
            placeholder="Garmin Client Secret"
            value={garminSecret}
            onChange={(e) => setGarminSecret(e.target.value)}
            style={{ padding: '0.5rem 0.75rem', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)' }}
          />
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            <button type="button" onClick={saveGarminCredentials} className="btn btn-secondary">Save credentials</button>
            {garminConnected && (
              <button type="button" onClick={disconnectGarmin} className="btn btn-secondary">Disconnect</button>
            )}
          </div>
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
              Set your max and resting HR for accurate zone calculations. Auto-updates when Strava detects a higher max HR.
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
          Apollo analyzes your Strava data and plan progress to suggest intelligent adjustments — like reducing mileage when you're overtraining or leveling up when you're ahead of schedule.
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
                Recommendations use your Strava sync data, plan completion rate, readiness scores, and pace trends. No data leaves your device.
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
