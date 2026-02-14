import { useState, useEffect } from 'react';
import {
  getStravaTokens,
  getStravaCredentials,
  setStravaCredentials,
  clearStravaTokens,
  getGarminCredentials,
  setGarminCredentials,
  clearGarminTokens,
  getGarminTokens,
} from '../services/storage';
import { setWelcomeCompleted } from '../services/planProgress';
import { isWeb } from '../services/stravaWeb';
import { getStravaAuthUrl } from '../services/stravaWeb';

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
  }, []);

  const saveStravaCredentials = () => {
    if (!stravaClientId.trim()) return;
    setStravaCredentials(stravaClientId.trim(), stravaSecret.trim());
    setMessage('Strava credentials saved.');
    setTimeout(() => setMessage(null), 3000);
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
      const { setStravaTokens } = await import('../services/storage');
      setStravaTokens({
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_at: tokens.expires_at,
        athlete: tokens.athlete,
      });
      setStravaConnected(true);
      setMessage(`Connected as ${tokens.athlete?.firstname ?? 'Strava'}.`);
      setTimeout(() => setMessage(null), 4000);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Strava connection failed.');
    } finally {
      setLoading(false);
    }
  };

  const disconnectStrava = () => {
    clearStravaTokens();
    setStravaConnected(false);
    setMessage('Strava disconnected.');
    setTimeout(() => setMessage(null), 3000);
  };

  const saveGarminCredentials = () => {
    if (!garminClientId.trim()) return;
    setGarminCredentials(garminClientId.trim(), garminSecret.trim());
    setMessage('Garmin credentials saved.');
    setTimeout(() => setMessage(null), 3000);
  };

  const disconnectGarmin = () => {
    clearGarminTokens();
    setGarminConnected(false);
    setMessage('Garmin disconnected.');
    setTimeout(() => setMessage(null), 3000);
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

      <div className="card">
        <h3>Training plan</h3>
        <p style={{ color: 'var(--text-muted)', marginBottom: '1rem', fontSize: '0.95rem' }}>
          To change or pick a plan from the full library (Hal Higdon, Hanson&apos;s, FIRST), you can see the welcome screen again.
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
