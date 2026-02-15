import { useState, useEffect } from 'react';
import { getActivities, type StravaActivity } from '../services/strava';
import { getStravaTokens } from '../services/storage';
import { Link } from 'react-router-dom';

function formatDistance(m: number): string {
  if (m >= 1000) return `${(m / 1000).toFixed(2)} km`;
  return `${Math.round(m)} m`;
}

function formatDuration(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}

function formatPace(meters: number, seconds: number): string {
  if (!seconds || !meters) return '—';
  const km = meters / 1000;
  const minPerKm = (seconds / 60) / km;
  const totalSec = Math.round(minPerKm * 60);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${sec.toString().padStart(2, '0')}/km`;
}

export default function Activities() {
  const [activities, setActivities] = useState<StravaActivity[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const connected = !!getStravaTokens();

  useEffect(() => {
    if (!connected) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setError(null);
    setLoading(true);
    getActivities({ page, per_page: 30 })
      .then((data) => {
        if (!cancelled) setActivities(Array.isArray(data) ? data : []);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [connected, page]);

  if (!connected) {
    return (
      <div>
        <h1 className="page-title">Activities</h1>
        <div className="card" style={{
          textAlign: 'center', padding: '2.5rem',
          background: 'linear-gradient(135deg, rgba(212,165,55,0.04) 0%, var(--bg-card) 100%)',
        }}>
          <div style={{ fontSize: '2rem', marginBottom: '0.75rem' }}>🏅</div>
          <h3 style={{ fontSize: 'var(--text-lg)', marginBottom: '0.5rem' }}>Your Hall of Victories</h3>
          <p style={{ color: 'var(--text-secondary)', marginBottom: '1.25rem', lineHeight: 1.6 }}>
            Connect Strava to see all your activities catalogued here — every run is an achievement.
          </p>
          <Link to="/settings" className="btn btn-primary">Connect Strava</Link>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.75rem', flexWrap: 'wrap', gap: '1rem' }}>
        <h1 style={{
          fontFamily: 'var(--font-display)', fontSize: 'var(--text-2xl)',
          fontWeight: 700, margin: 0, color: 'var(--text)',
        }}>Activities</h1>
        <span style={{
          fontSize: '0.72rem', fontFamily: 'var(--font-display)', fontWeight: 600,
          textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-muted)',
        }}>
          {activities.length > 0 ? `${activities.length} runs loaded` : ''}
        </span>
      </div>

      {error && (
        <div className="card" style={{ background: 'var(--color-error-dim)', borderColor: 'var(--color-error)', borderLeftWidth: 3, borderLeftStyle: 'solid' }}>
          <span style={{ color: 'var(--color-error)', fontWeight: 600 }}>Error:</span> {error}
        </div>
      )}

      {loading ? (
        <div className="card" style={{ textAlign: 'center', padding: '2rem' }}>
          <div style={{ color: 'var(--apollo-gold)', fontSize: '1.2rem', marginBottom: '0.5rem', animation: 'breathe 2s ease-in-out infinite' }}>⚡</div>
          <p style={{ color: 'var(--text-muted)', margin: 0 }}>Loading your victories…</p>
        </div>
      ) : (
        <>
          <div className="card" style={{ padding: '0.75rem 1.5rem' }}>
            <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {activities.map((a, idx) => (
                <li
                  key={a.id}
                  style={{
                    padding: '1rem 0',
                    borderBottom: idx < activities.length - 1 ? '1px solid var(--border)' : 'none',
                    display: 'grid',
                    gridTemplateColumns: '1fr auto auto',
                    gap: '1rem',
                    alignItems: 'center',
                    transition: 'background var(--transition-fast)',
                  }}
                >
                  <div>
                    <strong style={{ fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 'var(--text-base)' }}>{a.name || a.type}</strong>
                    <div style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)', marginTop: '0.15rem' }}>
                      {new Date(a.start_date_local).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })} · {a.sport_type || a.type}
                    </div>
                  </div>
                  <div style={{ textAlign: 'right', fontSize: 'var(--text-sm)' }}>
                    <span style={{ color: 'var(--apollo-gold)', fontWeight: 600, fontFamily: 'var(--font-display)' }}>{formatDistance(a.distance)}</span><br />
                    <span style={{ color: 'var(--text-muted)' }}>{formatDuration(a.moving_time)}</span>
                  </div>
                  <div style={{ textAlign: 'right', fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>
                    {a.average_speed != null && a.average_speed > 0 ? formatPace(a.distance, a.moving_time) : '—'}
                    {a.total_elevation_gain != null && a.total_elevation_gain > 0 && (
                      <><br /><span style={{ color: 'var(--apollo-teal)' }}>+{Math.round(a.total_elevation_gain)} m</span></>
                    )}
                    {a.average_heartrate != null && a.average_heartrate > 0 && (
                      <><br /><span style={{ color: 'var(--color-error)' }}>{Math.round(a.average_heartrate)}</span> / {a.max_heartrate ? Math.round(a.max_heartrate) : '—'} bpm</>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </div>
          <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'center', marginTop: '1.25rem', alignItems: 'center' }}>
            <button type="button" className="btn btn-secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)} style={{ fontSize: 'var(--text-sm)' }}>← Previous</button>
            <span style={{
              color: 'var(--apollo-gold)', fontFamily: 'var(--font-display)',
              fontWeight: 600, fontSize: 'var(--text-sm)',
              padding: '0.35rem 0.75rem', borderRadius: 'var(--radius-sm)',
              background: 'var(--apollo-gold-dim)',
            }}>Page {page}</span>
            <button type="button" className="btn btn-secondary" disabled={activities.length < 30} onClick={() => setPage((p) => p + 1)} style={{ fontSize: 'var(--text-sm)' }}>Next →</button>
          </div>
        </>
      )}
    </div>
  );
}
