import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { getStravaTokens, getGarminTokens } from '../services/storage';
import { getAthlete } from '../services/strava';
import { getActivities, type StravaActivity } from '../services/strava';
import { getActivePlan, getWeekDayForDate, getCompletedCount } from '../services/planProgress';
import { getPlanById } from '../data/plans';

function formatDistance(m: number): string {
  if (m >= 1000) return `${(m / 1000).toFixed(2)} km`;
  return `${Math.round(m)} m`;
}

function formatPace(meters: number, seconds: number): string {
  if (!seconds || !meters) return '—';
  const km = meters / 1000;
  const minPerKm = (seconds / 60) / km;
  const min = Math.floor(minPerKm);
  const sec = Math.round((minPerKm - min) * 60);
  return `${min}:${sec.toString().padStart(2, '0')}/km`;
}

function formatDuration(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}

export default function Dashboard() {
  const [athlete, setAthlete] = useState<{ firstname: string; lastname: string; profile?: string } | null>(null);
  const [recent, setRecent] = useState<StravaActivity[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const stravaConnected = !!getStravaTokens();
  const garminConnected = !!getGarminTokens();
  const activePlan = getActivePlan();
  const plan = activePlan ? getPlanById(activePlan.planId) : null;
  const today = new Date();
  const todayWeekDay = plan && activePlan ? getWeekDayForDate(activePlan.startDate, plan.totalWeeks, today) : null;
  const todayWorkout = plan && todayWeekDay != null ? plan.weeks[todayWeekDay.weekIndex]?.days[todayWeekDay.dayIndex] : null;
  const completedCount = plan && activePlan ? getCompletedCount(plan.id) : 0;
  const totalDays = plan ? plan.totalWeeks * 7 : 0;

  useEffect(() => {
    if (!stravaConnected) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const [athleteRes, activitiesRes] = await Promise.all([
          getAthlete(),
          getActivities({ per_page: 10 }),
        ]);
        if (!cancelled) {
          setAthlete(athleteRes);
          setRecent(Array.isArray(activitiesRes) ? activitiesRes : []);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [stravaConnected]);

  return (
    <div>
      <h1 className="page-title">Dashboard</h1>

      <div className="card" style={{ display: 'flex', gap: '1.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
        <div>
          <strong style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>Connections</strong>
          <div style={{ display: 'flex', gap: '1rem', marginTop: '0.25rem' }}>
            <span style={{ color: stravaConnected ? 'var(--strava)' : 'var(--text-muted)' }}>Strava {stravaConnected ? '✓' : '—'}</span>
            <span style={{ color: garminConnected ? 'var(--accent)' : 'var(--text-muted)' }}>Garmin {garminConnected ? '✓' : '—'}</span>
          </div>
        </div>
        {!stravaConnected && (
          <Link to="/settings" className="btn btn-primary">Connect Strava & Garmin</Link>
        )}
      </div>

      {stravaConnected && athlete && (
        <div className="card">
          <h3>Welcome, {athlete.firstname}</h3>
          {athlete.profile && (
            <img src={athlete.profile} alt="" style={{ width: 64, height: 64, borderRadius: '50%', marginBottom: '0.5rem' }} />
          )}
        </div>
      )}

      {error && <div className="card" style={{ background: 'rgba(255,80,80,0.1)', borderColor: '#f55' }}>{error}</div>}

      {plan && activePlan && (
        <div className="card" style={{ borderLeft: '4px solid var(--accent)' }}>
          <h3>Your plan — {plan.name}</h3>
          <p style={{ color: 'var(--text-muted)', marginBottom: '0.75rem' }}>
            {completedCount} of {totalDays} days completed
          </p>
          {todayWorkout && (
            <div style={{ background: 'var(--bg)', padding: '0.75rem 1rem', borderRadius: '8px', marginBottom: '0.75rem' }}>
              <strong style={{ fontSize: '0.9rem', color: 'var(--text-muted)' }}>Today&apos;s workout</strong>
              <div style={{ marginTop: '0.25rem', fontWeight: 500 }} className={`day-type-${todayWorkout.type}`}>
                {todayWorkout.label}
                {todayWorkout.distanceMi != null && (
                  <span style={{ color: 'var(--text-muted)', fontWeight: 'normal', marginLeft: '0.5rem' }}>
                    {todayWorkout.distanceMi} mi ({(todayWorkout.distanceMi * 1.60934).toFixed(1)} km)
                  </span>
                )}
              </div>
            </div>
          )}
          <Link to="/training" className="btn btn-primary">Open training plan</Link>
        </div>
      )}

      {stravaConnected && (
        <div className="card">
          <h3>Recent activities</h3>
          {loading ? (
            <p style={{ color: 'var(--text-muted)' }}>Loading…</p>
          ) : recent.length === 0 ? (
            <p style={{ color: 'var(--text-muted)' }}>No activities yet.</p>
          ) : (
            <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {recent.map((a) => (
                <li
                  key={a.id}
                  style={{
                    padding: '0.75rem 0',
                    borderBottom: '1px solid var(--border)',
                    display: 'flex',
                    justifyContent: 'space-between',
                    flexWrap: 'wrap',
                    gap: '0.5rem',
                  }}
                >
                  <div>
                    <strong>{a.name || a.type}</strong>
                    <span style={{ color: 'var(--text-muted)', marginLeft: '0.5rem', fontSize: '0.9rem' }}>
                      {new Date(a.start_date_local).toLocaleDateString()} • {a.sport_type || a.type}
                    </span>
                  </div>
                  <div style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>
                    {formatDistance(a.distance)} • {formatDuration(a.moving_time)}
                    {a.average_speed != null && a.average_speed > 0 && (
                      <> • {formatPace(a.distance, a.moving_time)}</>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
          <div style={{ marginTop: '1rem' }}>
            <Link to="/activities" className="btn btn-secondary">View all activities</Link>
          </div>
        </div>
      )}

      {!plan && (
        <div className="card">
          <h3>Training plan</h3>
          <p style={{ color: 'var(--text-muted)', marginBottom: '1rem' }}>
            Choose Hal Higdon or Hanson&apos;s, set your start date, and track every day with the checklist.
          </p>
          <Link to="/training" className="btn btn-primary">Choose a plan</Link>
        </div>
      )}
    </div>
  );
}
