import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { setStravaTokens } from '../services/storage';
import { exchangeStravaCode } from '../services/stravaWeb';

export default function AuthStravaCallback() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const code = searchParams.get('code');
    const errParam = searchParams.get('error');

    if (errParam) {
      setError(errParam === 'access_denied' ? 'You denied access to Strava.' : `Strava error: ${errParam}`);
      return;
    }

    if (!code) {
      setError('No authorization code received.');
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        const tokens = await exchangeStravaCode(code);
        if (cancelled) return;
        setStravaTokens({
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token,
          expires_at: tokens.expires_at,
          athlete: tokens.athlete,
        });
        navigate('/settings', { replace: true });
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Connection failed.');
      }
    })();
    return () => { cancelled = true; };
  }, [searchParams, navigate]);

  if (error) {
    return (
      <div className="welcome-flow">
        <div className="welcome-card">
          <h1 className="welcome-title">Strava connection failed</h1>
          <p style={{ color: 'var(--text-muted)', marginBottom: '1rem' }}>{error}</p>
          <button type="button" className="btn btn-primary" onClick={() => navigate('/settings', { replace: true })}>
            Back to Settings
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="welcome-flow">
      <div className="welcome-card">
        <h1 className="welcome-title">Connecting to Strava…</h1>
        <p style={{ color: 'var(--text-muted)' }}>Please wait.</p>
      </div>
    </div>
  );
}
