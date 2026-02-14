import { useState, useEffect } from 'react';
import { getActivities, type StravaActivity } from '../services/strava';
import { getStravaTokens } from '../services/storage';

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
  const min = Math.floor(minPerKm);
  const sec = Math.round((minPerKm - min) * 60);
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
        <div className="card">
          <p style={{ color: 'var(--text-muted)' }}>Connect Strava in Settings to see your activities here.</p>
        </div>
      </div>
    );
  }

  return (
    <div>
      <h1 className="page-title">Activities</h1>
      {error && <div className="card" style={{ background: 'rgba(255,80,80,0.1)', borderColor: '#f55' }}>{error}</div>}
      {loading ? (
        <div className="card"><p style={{ color: 'var(--text-muted)' }}>Loading…</p></div>
      ) : (
        <>
          <div className="card">
            <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {activities.map((a) => (
                <li
                  key={a.id}
                  style={{
                    padding: '1rem 0',
                    borderBottom: '1px solid var(--border)',
                    display: 'grid',
                    gridTemplateColumns: '1fr auto auto',
                    gap: '1rem',
                    alignItems: 'center',
                  }}
                >
                  <div>
                    <strong>{a.name || a.type}</strong>
                    <div style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>
                      {new Date(a.start_date_local).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })} • {a.sport_type || a.type}
                    </div>
                  </div>
                  <div style={{ textAlign: 'right', color: 'var(--text-muted)', fontSize: '0.9rem' }}>
                    {formatDistance(a.distance)}<br />
                    {formatDuration(a.moving_time)}
                  </div>
                  <div style={{ textAlign: 'right', color: 'var(--text-muted)', fontSize: '0.9rem' }}>
                    {a.average_speed != null && a.average_speed > 0 ? formatPace(a.distance, a.moving_time) : '—'}
                    {a.total_elevation_gain != null && a.total_elevation_gain > 0 && (
                      <><br />+{Math.round(a.total_elevation_gain)} m</>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </div>
          <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'center', marginTop: '1rem' }}>
            <button type="button" className="btn btn-secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</button>
            <span style={{ alignSelf: 'center', color: 'var(--text-muted)' }}>Page {page}</span>
            <button type="button" className="btn btn-secondary" disabled={activities.length < 30} onClick={() => setPage((p) => p + 1)}>Next</button>
          </div>
        </>
      )}
    </div>
  );
}
