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
      {message && <div className="card" style={{ background: 'rgba(0,200,83,0.15)', borderColor: 'var(--accent)' }}>{message}</div>}
      {error && <div className="card" style={{ background: 'rgba(255,80,80,0.15)', borderColor: '#f55' }}>{error}</div>}

      <div className="card">
        <h3 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <span style={{ color: 'var(--strava)' }}>Strava</span>
          {stravaConnected && <span style={{ fontSize: '0.85rem', color: 'var(--accent)' }}>• Connected</span>}
        </h3>
        {isWeb() ? (
          <>
            <p style={{ color: 'var(--text-muted)', marginBottom: '1rem', fontSize: '0.95rem' }}>
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
            <p style={{ color: 'var(--text-muted)', marginBottom: '1rem', fontSize: '0.95rem' }}>
              Create an app at <a href="https://www.strava.com/settings/api" target="_blank" rel="noopener noreferrer">strava.com/settings/api</a> to get Client ID and Client Secret. Use Authorization Callback Domain: <code>127.0.0.1</code> (or leave default).
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', maxWidth: '400px' }}>
              <input
                type="text"
                placeholder="Strava Client ID"
                value={stravaClientId}
                onChange={(e) => setStravaClientId(e.target.value)}
                style={{ padding: '0.5rem 0.75rem', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)' }}
              />
              <input
                type="password"
                placeholder="Strava Client Secret"
                value={stravaSecret}
                onChange={(e) => setStravaSecret(e.target.value)}
                style={{ padding: '0.5rem 0.75rem', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)' }}
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

      <div className="card">
        <h3 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          Garmin Connect
          {garminConnected && <span style={{ fontSize: '0.85rem', color: 'var(--accent)' }}>• Connected</span>}
        </h3>
        <p style={{ color: 'var(--text-muted)', marginBottom: '1rem', fontSize: '0.95rem' }}>
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

      {/* ── Coaching & Insights ── */}
      <div className="card">
        <h3>Coaching & Insights</h3>
        <p style={{ color: 'var(--text-muted)', marginBottom: '1rem', fontSize: '0.95rem' }}>
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
      <div className="card">
        <h3>Adaptive Training Recommendations</h3>
        <p style={{ color: 'var(--text-muted)', marginBottom: '1rem', fontSize: '0.95rem' }}>
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

      <div className="card">
        <h3>Training plan</h3>
        <p style={{ color: 'var(--text-muted)', marginBottom: '1rem', fontSize: '0.95rem' }}>
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
