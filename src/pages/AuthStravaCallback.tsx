import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { setStravaTokens } from '../services/storage';
import { exchangeStravaCode } from '../services/stravaWeb';
import { runSync } from '../services/autoSync';

/**
 * Strava authorization codes are single-use, and React StrictMode runs effects
 * twice in development. Exchange each code once and share the outcome, so a
 * re-run (or an unmount mid-exchange) can't burn the code or drop the tokens.
 */
const codeExchanges = new Map<string, Promise<void>>();

function connectWithCode(code: string): Promise<void> {
  let pending = codeExchanges.get(code);
  if (!pending) {
    pending = exchangeStravaCode(code).then((tokens) => {
      setStravaTokens({
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_at: tokens.expires_at,
        athlete: tokens.athlete,
      });
      // Import history + match the plan in the background; failures are recorded in sync state.
      runSync().catch(() => { /* recorded as the source's last sync error */ });
    });
    codeExchanges.set(code, pending);
  }
  return pending;
}

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
    connectWithCode(code)
      .then(() => {
        if (!cancelled) navigate('/settings?tab=connections', { replace: true });
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Connection failed.');
      });
    return () => { cancelled = true; };
  }, [searchParams, navigate]);

  if (error) {
    return (
      <div className="welcome-flow">
        <div className="welcome-card">
          <h1 className="welcome-title">Strava connection failed</h1>
          <p style={{ color: 'var(--text-muted)', marginBottom: '1rem' }}>{error}</p>
          <p style={{ color: 'var(--text-secondary)', marginBottom: '1rem', fontSize: 'var(--text-sm)', lineHeight: 1.5 }}>
            Strava API access may require a paid plan. You can connect <strong>intervals.icu</strong> in Settings instead —
            it&apos;s free and syncs from Garmin, Zwift, Wahoo, COROS and more.
          </p>
          <button type="button" className="btn btn-primary" onClick={() => navigate('/settings?tab=connections', { replace: true })}>
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
        <p style={{ color: 'var(--text-muted)' }}>Please wait — your activities will start syncing in the background.</p>
      </div>
    </div>
  );
}
