import { useState, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { getStravaTokens, getGarminTokens } from '../services/storage';
import { getAthlete } from '../services/strava';
import { getActivities, type StravaActivity } from '../services/strava';
import { getActivePlan, getWeekDayForDate, getCompletedCount, getSyncMeta, isDayCompleted } from '../services/planProgress';
import { getPlanById } from '../data/plans';
import { runAutoSync, getWeeklyMileageSummary, type SyncResult, type WeeklyMileage } from '../services/autoSync';
import { getSavedPrediction, getSavedAdherence, type RacePrediction, type TrainingAdherence } from '../services/racePrediction';
import { getLatestReadinessScore, type ReadinessScore } from '../services/weeklyReadiness';
import { generateTodayRecap, type DailyRecap } from '../services/dailyRecap';
import { isDailyRecapDue, markDailyRecapShown, isWeeklyRecapDue, markWeeklyRecapShown } from '../services/coachingPreferences';

function formatDistance(m: number): string {
  if (m >= 1000) return `${(m / 1000).toFixed(2)} km`;
  return `${Math.round(m)} m`;
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

function formatPaceMinPerMi(paceMinPerMi: number): string {
  if (!paceMinPerMi) return '—';
  const totalSec = Math.round(paceMinPerMi * 60);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${sec.toString().padStart(2, '0')}/mi`;
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
  const [syncResults, setSyncResults] = useState<SyncResult[]>([]);
  const [, forceUpdate] = useState(0);
  const autoSyncedPlanRef = useRef<string | null>(null);
  const [prediction, setPrediction] = useState<RacePrediction | null>(null);
  const [adherence, setAdherence] = useState<TrainingAdherence | null>(null);
  const [readiness, setReadiness] = useState<ReadinessScore | null>(null);
  const [dailyRecap, setDailyRecap] = useState<DailyRecap | null>(null);
  const [showDailyRecap, setShowDailyRecap] = useState(false);
  const [showWeeklyRecap, setShowWeeklyRecap] = useState(false);
  const stravaConnected = !!getStravaTokens();
  const garminConnected = !!getGarminTokens();
  const activePlan = getActivePlan();
  const activePlanKey = activePlan ? `${activePlan.planId}:${activePlan.startDate}` : null;
  const plan = activePlan ? getPlanById(activePlan.planId) : null;
  const today = new Date();
  const todayWeekDay = plan && activePlan ? getWeekDayForDate(activePlan.startDate, plan.totalWeeks, today) : null;
  const todayWorkout = plan && todayWeekDay != null ? plan.weeks[todayWeekDay.weekIndex]?.days[todayWeekDay.dayIndex] : null;
  const todaySyncMeta = plan && todayWeekDay ? getSyncMeta(plan.id, todayWeekDay.weekIndex, todayWeekDay.dayIndex) : null;
  const todayCompleted = plan && todayWeekDay ? isDayCompleted(plan.id, todayWeekDay.weekIndex, todayWeekDay.dayIndex) : false;
  const completedCount = plan && activePlan ? getCompletedCount(plan.id) : 0;
  const totalDays = plan ? plan.totalWeeks * 7 : 0;
  const weeklyMileage: WeeklyMileage | null = plan && todayWeekDay ? getWeeklyMileageSummary(plan.id, todayWeekDay.weekIndex) : null;

  useEffect(() => {
    if (!stravaConnected) {
      autoSyncedPlanRef.current = null;
      setAthlete(null);
      setRecent([]);
      setError(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        setError(null);
        setLoading(true);
        const [athleteRes, activitiesRes] = await Promise.all([
          getAthlete(),
          getActivities({ per_page: 10 }),
        ]);
        if (!cancelled) {
          setAthlete(athleteRes);
          setRecent(Array.isArray(activitiesRes) ? activitiesRes : []);
        }

        if (activePlanKey && autoSyncedPlanRef.current !== activePlanKey) {
          autoSyncedPlanRef.current = activePlanKey;
          try {
            const results = await runAutoSync();
            if (!cancelled) {
              setSyncResults(results);
              forceUpdate((n) => n + 1);
            }
          } catch {
            // keep dashboard data load successful even if auto-sync fails
          }
        }

        // Load insights data after sync
        if (!cancelled) {
          setPrediction(getSavedPrediction());
          setAdherence(getSavedAdherence());
          setReadiness(getLatestReadinessScore());
          const recap = generateTodayRecap();
          if (recap) setDailyRecap(recap);
          if (isDailyRecapDue()) { setShowDailyRecap(true); markDailyRecapShown(); }
          if (isWeeklyRecapDue()) { setShowWeeklyRecap(true); markWeeklyRecapShown(); }
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [stravaConnected, activePlanKey]);

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
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.25rem' }}>
                <strong style={{ fontSize: '0.9rem', color: 'var(--text-muted)' }}>Today&apos;s workout</strong>
                {todaySyncMeta && (
                  <span style={{
                    fontSize: '0.72rem',
                    background: 'rgba(0,200,83,0.2)',
                    color: 'var(--accent)',
                    padding: '0.1rem 0.5rem',
                    borderRadius: '999px',
                    fontWeight: 600,
                  }}>Auto-synced</span>
                )}
                {todayCompleted && !todaySyncMeta && (
                  <span style={{
                    fontSize: '0.72rem',
                    background: 'rgba(0,200,83,0.15)',
                    color: 'var(--accent)',
                    padding: '0.1rem 0.5rem',
                    borderRadius: '999px',
                    fontWeight: 600,
                  }}>Completed</span>
                )}
              </div>
              <div style={{ marginTop: '0.25rem', fontWeight: 500 }} className={`day-type-${todayWorkout.type}`}>
                {todayWorkout.label}
                {todayWorkout.distanceMi != null && (
                  <span style={{ color: 'var(--text-muted)', fontWeight: 'normal', marginLeft: '0.5rem' }}>
                    {todayWorkout.distanceMi} mi ({(todayWorkout.distanceMi * 1.60934).toFixed(1)} km)
                  </span>
                )}
              </div>
              {todaySyncMeta && (
                <div style={{
                  marginTop: '0.5rem',
                  padding: '0.5rem 0.75rem',
                  background: 'rgba(0,200,83,0.08)',
                  borderRadius: '8px',
                  fontSize: '0.85rem',
                  lineHeight: 1.5,
                }}>
                  <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', color: 'var(--text-muted)', marginBottom: '0.25rem' }}>
                    <span style={{ color: 'var(--accent)', fontWeight: 600 }}>{todaySyncMeta.actualDistanceMi.toFixed(1)} mi</span>
                    <span>{formatPaceMinPerMi(todaySyncMeta.actualPaceMinPerMi)} pace</span>
                    <span>{Math.floor(todaySyncMeta.movingTimeSec / 60)}m {todaySyncMeta.movingTimeSec % 60}s</span>
                  </div>
                  <div style={{ color: 'var(--text)', fontStyle: 'italic' }}>{todaySyncMeta.feedback}</div>
                </div>
              )}
            </div>
          )}
          {weeklyMileage && weeklyMileage.actualMi > 0 && (
            <div style={{ background: 'var(--bg)', padding: '0.75rem 1rem', borderRadius: '8px', marginBottom: '0.75rem' }}>
              <strong style={{ fontSize: '0.9rem', color: 'var(--text-muted)' }}>This week&apos;s mileage</strong>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginTop: '0.5rem' }}>
                <div style={{
                  flex: 1,
                  height: 8,
                  borderRadius: 4,
                  background: 'rgba(255,255,255,0.08)',
                  overflow: 'hidden',
                }}>
                  <div style={{
                    height: '100%',
                    width: `${weeklyMileage.plannedMi > 0 ? Math.min((weeklyMileage.actualMi / weeklyMileage.plannedMi) * 100, 100) : 0}%`,
                    borderRadius: 4,
                    background: weeklyMileage.status === 'on_track' || weeklyMileage.status === 'ahead' ? 'var(--accent)' : weeklyMileage.status === 'behind' ? '#f0a030' : '#f55',
                    transition: 'width 0.3s',
                  }} />
                </div>
                <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                  {weeklyMileage.actualMi.toFixed(1)} / {weeklyMileage.plannedMi.toFixed(1)} mi
                </span>
              </div>
              <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', margin: '0.35rem 0 0', fontStyle: 'italic' }}>
                {weeklyMileage.message}
              </p>
            </div>
          )}
          {syncResults.length > 0 && (
            <div style={{ marginBottom: '0.75rem', display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
              {syncResults.slice(0, 3).map((r, i) => (
                <div key={i} style={{
                  background: 'rgba(0,200,83,0.08)',
                  borderRadius: '8px',
                  padding: '0.5rem 0.75rem',
                  fontSize: '0.82rem',
                  lineHeight: 1.4,
                }}>
                  <span style={{ fontWeight: 600, color: 'var(--accent)' }}>
                    {r.isNew ? 'Auto-completed' : 'Synced'}:
                  </span>{' '}
                  {r.plannedDay.label} — {r.actualDistanceMi.toFixed(1)} mi
                </div>
              ))}
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

      {/* ── Race Prediction & Adherence Strip ── */}
      {plan && activePlan && (prediction || adherence) && (
        <div className="card" style={{ display: 'flex', gap: '1.5rem', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between' }}>
          {prediction && (
            <div>
              <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>Marathon Prediction</div>
              <div style={{ fontSize: '1.5rem', fontWeight: 700, color: 'var(--accent)' }}>{prediction.marathonTimeFormatted}</div>
              <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>VDOT {prediction.vdot} · {prediction.confidence}% confidence</div>
            </div>
          )}
          {adherence && (
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>Adherence</div>
              <div style={{ fontSize: '1.5rem', fontWeight: 700, color: adherence.score >= 80 ? 'var(--accent)' : adherence.score >= 60 ? '#f0a030' : '#f55' }}>{adherence.score}%</div>
              <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', textTransform: 'capitalize' }}>{adherence.rating}</div>
            </div>
          )}
          {readiness && (
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>Readiness Wk {readiness.weekNumber}</div>
              <div style={{ fontSize: '1.5rem', fontWeight: 700, color: readiness.grade.startsWith('A') ? 'var(--accent)' : readiness.grade.startsWith('B') ? '#4FC3F7' : '#f0a030' }}>{readiness.grade}</div>
              <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>{readiness.score}/100</div>
            </div>
          )}
          <Link to="/insights" className="btn btn-secondary" style={{ fontSize: '0.85rem' }}>View Insights</Link>
        </div>
      )}

      {/* ── Daily Recap Popup ── */}
      {showDailyRecap && dailyRecap && (
        <div className="card" style={{
          borderLeft: `4px solid ${dailyRecap.grade === 'outstanding' ? '#00c853' : dailyRecap.grade === 'strong' ? '#4FC3F7' : dailyRecap.grade === 'missed' ? '#f55' : 'var(--border)'}`,
          background: 'linear-gradient(135deg, rgba(0,200,83,0.06) 0%, var(--bg-card) 100%)',
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h3 style={{ margin: 0 }}>Daily Training Recap</h3>
            <button type="button" onClick={() => setShowDailyRecap(false)} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: '1.2rem', cursor: 'pointer' }}>✕</button>
          </div>
          {dailyRecap.synced && (
            <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', margin: '0.75rem 0', fontSize: '0.88rem' }}>
              <span style={{ color: 'var(--accent)', fontWeight: 600 }}>{dailyRecap.actualDistanceMi.toFixed(1)} mi</span>
              <span style={{ color: 'var(--text-muted)' }}>{formatPaceMinPerMi(dailyRecap.actualPaceMinPerMi)}</span>
              {dailyRecap.avgHR && <span style={{ color: 'var(--text-muted)' }}>{dailyRecap.avgHR} bpm</span>}
              {dailyRecap.primaryZone && <span style={{ color: 'var(--text-muted)' }}>Zone: {dailyRecap.primaryZone}</span>}
            </div>
          )}
          <p style={{ fontSize: '0.88rem', color: 'var(--text)', lineHeight: 1.5, margin: '0.5rem 0 0', fontStyle: 'italic' }}>{dailyRecap.coachMessage}</p>
        </div>
      )}

      {/* ── Weekly Readiness Popup ── */}
      {showWeeklyRecap && readiness && (
        <div className="card" style={{
          borderLeft: `4px solid ${readiness.grade.startsWith('A') ? '#00c853' : readiness.grade.startsWith('B') ? '#4FC3F7' : '#f0a030'}`,
          background: 'linear-gradient(135deg, rgba(79,195,247,0.06) 0%, var(--bg-card) 100%)',
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h3 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              Race Day Readiness — Week {readiness.weekNumber}
              <span style={{ fontSize: '1.3rem', fontWeight: 700, color: readiness.grade.startsWith('A') ? '#00c853' : readiness.grade.startsWith('B') ? '#4FC3F7' : '#f0a030' }}>{readiness.grade}</span>
            </h3>
            <button type="button" onClick={() => setShowWeeklyRecap(false)} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: '1.2rem', cursor: 'pointer' }}>✕</button>
          </div>
          {readiness.strengths.length > 0 && (
            <div style={{ margin: '0.75rem 0 0' }}>
              <strong style={{ fontSize: '0.85rem', color: 'var(--accent)' }}>Strengths</strong>
              {readiness.strengths.map((s, i) => <p key={i} style={{ margin: '0.2rem 0 0', fontSize: '0.85rem', color: 'var(--text-muted)' }}>{s}</p>)}
            </div>
          )}
          {readiness.improvements.length > 0 && (
            <div style={{ margin: '0.5rem 0 0' }}>
              <strong style={{ fontSize: '0.85rem', color: '#f0a030' }}>Areas to improve</strong>
              {readiness.improvements.map((s, i) => <p key={i} style={{ margin: '0.2rem 0 0', fontSize: '0.85rem', color: 'var(--text-muted)' }}>{s}</p>)}
            </div>
          )}
          {readiness.nextWeekTips.length > 0 && (
            <div style={{ margin: '0.5rem 0 0' }}>
              <strong style={{ fontSize: '0.85rem', color: '#4FC3F7' }}>Next week</strong>
              {readiness.nextWeekTips.map((s, i) => <p key={i} style={{ margin: '0.2rem 0 0', fontSize: '0.85rem', color: 'var(--text-muted)' }}>{s}</p>)}
            </div>
          )}
          <div style={{ marginTop: '0.75rem' }}>
            <Link to="/insights" style={{ fontSize: '0.85rem' }}>View full insights →</Link>
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
