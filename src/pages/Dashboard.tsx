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
import AdaptiveRecommendations from '../components/AdaptiveRecommendations';
import ErrorBoundary from '../components/ErrorBoundary';
import LoadingScreen from '../components/LoadingScreen';

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

/** Stat card with icon, label, value */
function StatCard({ label, value, color, sub }: { label: string; value: string; color: string; sub?: string }) {
  return (
    <div style={{
      flex: '1 1 140px',
      background: 'var(--bg)',
      border: '1px solid var(--border)',
      borderRadius: 'var(--radius-md)',
      padding: '1rem 1.1rem',
      textAlign: 'center',
      transition: 'all var(--transition-base)',
    }}>
      <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', fontFamily: 'var(--font-display)', fontWeight: 500, marginBottom: '0.35rem' }}>{label}</div>
      <div style={{ fontSize: '1.5rem', fontWeight: 700, color, fontFamily: 'var(--font-display)', lineHeight: 1.2 }}>{value}</div>
      {sub && <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: '0.2rem' }}>{sub}</div>}
    </div>
  );
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
  const progressPct = totalDays > 0 ? Math.round((completedCount / totalDays) * 100) : 0;
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

  if (loading && stravaConnected && !athlete) {
    return <LoadingScreen message="Loading your training data…" />;
  }

  return (
    <div>
      {/* ── Page Header with Welcome ── */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.75rem', flexWrap: 'wrap', gap: '1rem' }}>
        <div>
          <h1 style={{
            fontFamily: 'var(--font-display)',
            fontSize: 'var(--text-2xl)',
            fontWeight: 700,
            margin: 0,
            color: 'var(--text)',
          }}>
            {athlete ? `Welcome back, ${athlete.firstname}` : 'Dashboard'}
          </h1>
          {plan && <p style={{ color: 'var(--text-muted)', margin: '0.25rem 0 0', fontSize: 'var(--text-sm)' }}>{plan.name} by {plan.author}</p>}
        </div>
        <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: '0.4rem',
            fontSize: '0.78rem', padding: '0.35rem 0.75rem',
            borderRadius: 'var(--radius-full)',
            background: stravaConnected ? 'rgba(252,76,2,0.12)' : 'var(--bg-surface)',
            color: stravaConnected ? 'var(--strava)' : 'var(--text-muted)',
            fontWeight: 600,
          }}>
            Strava {stravaConnected ? '●' : '○'}
          </span>
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: '0.4rem',
            fontSize: '0.78rem', padding: '0.35rem 0.75rem',
            borderRadius: 'var(--radius-full)',
            background: garminConnected ? 'var(--color-success-dim)' : 'var(--bg-surface)',
            color: garminConnected ? 'var(--color-success)' : 'var(--text-muted)',
            fontWeight: 600,
          }}>
            Garmin {garminConnected ? '●' : '○'}
          </span>
        </div>
      </div>

      {error && (
        <div className="card" style={{ background: 'var(--color-error-dim)', borderColor: 'var(--color-error)', borderLeftWidth: 4, borderLeftStyle: 'solid' }}>
          <span style={{ color: 'var(--color-error)', fontWeight: 600 }}>Error:</span> {error}
        </div>
      )}

      {/* ═══ HERO: Today's Quest ═══ */}
      {plan && activePlan && todayWorkout && (
        <div className="card" style={{
          background: 'linear-gradient(135deg, rgba(212, 165, 55, 0.08) 0%, var(--bg-card) 60%, rgba(91, 181, 181, 0.05) 100%)',
          borderColor: 'var(--apollo-gold)',
          borderWidth: '1px',
          padding: '1.75rem',
          position: 'relative',
          overflow: 'hidden',
        }}>
          {/* Decorative top border */}
          <div style={{
            position: 'absolute', top: 0, left: 0, right: 0, height: 3,
            background: 'linear-gradient(90deg, transparent 0%, var(--apollo-gold-dark) 20%, var(--apollo-gold) 50%, var(--apollo-gold-dark) 80%, transparent 100%)',
          }} />

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '1rem' }}>
            <div>
              <div style={{
                fontSize: '0.72rem', fontFamily: 'var(--font-display)', fontWeight: 600,
                textTransform: 'uppercase', letterSpacing: '0.1em',
                color: 'var(--apollo-gold)', marginBottom: '0.5rem',
              }}>
                Today&apos;s Quest
              </div>
              <div style={{
                fontSize: 'var(--text-xl)', fontFamily: 'var(--font-display)', fontWeight: 700,
                color: 'var(--text)', lineHeight: 1.2, marginBottom: '0.35rem',
              }} className={`day-type-${todayWorkout.type}`}>
                {todayWorkout.label}
              </div>
              {todayWorkout.distanceMi != null && (
                <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>
                  {todayWorkout.distanceMi} mi ({(todayWorkout.distanceMi * 1.60934).toFixed(1)} km)
                </div>
              )}
            </div>
            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
              {todaySyncMeta && (
                <span style={{
                  fontSize: '0.75rem', background: 'var(--apollo-gold-dim)',
                  color: 'var(--apollo-gold)', padding: '0.25rem 0.75rem',
                  borderRadius: 'var(--radius-full)', fontWeight: 600,
                  fontFamily: 'var(--font-display)', letterSpacing: '0.02em',
                }}>Auto-synced</span>
              )}
              {todayCompleted && !todaySyncMeta && (
                <span style={{
                  fontSize: '0.75rem', background: 'var(--color-success-dim)',
                  color: 'var(--color-success)', padding: '0.25rem 0.75rem',
                  borderRadius: 'var(--radius-full)', fontWeight: 600,
                  fontFamily: 'var(--font-display)',
                }}>Completed</span>
              )}
            </div>
          </div>

          {todaySyncMeta && (
            <div style={{
              marginTop: '1rem', padding: '0.85rem 1rem',
              background: 'rgba(212, 165, 55, 0.06)', borderRadius: 'var(--radius-md)',
              border: '1px solid var(--border)',
            }}>
              <div style={{ display: 'flex', gap: '1.25rem', flexWrap: 'wrap', marginBottom: '0.35rem' }}>
                <span style={{ color: 'var(--apollo-gold)', fontWeight: 700, fontFamily: 'var(--font-display)', fontSize: '1.1rem' }}>{todaySyncMeta.actualDistanceMi.toFixed(1)} mi</span>
                <span style={{ color: 'var(--text-secondary)', fontSize: 'var(--text-sm)' }}>{formatPaceMinPerMi(todaySyncMeta.actualPaceMinPerMi)} pace</span>
                <span style={{ color: 'var(--text-secondary)', fontSize: 'var(--text-sm)' }}>{Math.floor(todaySyncMeta.movingTimeSec / 60)}m {todaySyncMeta.movingTimeSec % 60}s</span>
              </div>
              <div style={{ color: 'var(--text)', fontStyle: 'italic', fontSize: 'var(--text-sm)', lineHeight: 1.5 }}>{todaySyncMeta.feedback}</div>
            </div>
          )}

          {/* Weekly mileage progress */}
          {weeklyMileage && weeklyMileage.actualMi > 0 && (
            <div style={{ marginTop: '1rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.4rem' }}>
                <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', fontFamily: 'var(--font-display)', fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.06em' }}>This week</span>
                <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', fontWeight: 600 }}>
                  {weeklyMileage.actualMi.toFixed(1)} / {weeklyMileage.plannedMi.toFixed(1)} mi
                </span>
              </div>
              <div style={{
                height: 8, borderRadius: 4,
                background: 'rgba(255,255,255,0.06)', overflow: 'hidden',
              }}>
                <div style={{
                  height: '100%',
                  width: `${weeklyMileage.plannedMi > 0 ? Math.min((weeklyMileage.actualMi / weeklyMileage.plannedMi) * 100, 100) : 0}%`,
                  borderRadius: 4,
                  background: weeklyMileage.status === 'on_track' || weeklyMileage.status === 'ahead'
                    ? 'linear-gradient(90deg, var(--apollo-gold-dark), var(--apollo-gold))'
                    : weeklyMileage.status === 'behind' ? 'var(--color-warning)' : 'var(--color-error)',
                  transition: 'width 0.5s ease',
                }} />
              </div>
              <p style={{ color: 'var(--text-muted)', fontSize: '0.78rem', margin: '0.35rem 0 0', fontStyle: 'italic' }}>
                {weeklyMileage.message}
              </p>
            </div>
          )}

          {/* Sync results */}
          {syncResults.length > 0 && (
            <div style={{ marginTop: '0.75rem', display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
              {syncResults.slice(0, 3).map((r, i) => (
                <div key={i} style={{
                  background: 'var(--apollo-gold-dim)', borderRadius: 'var(--radius-sm)',
                  padding: '0.4rem 0.75rem', fontSize: '0.78rem', lineHeight: 1.4,
                }}>
                  <span style={{ fontWeight: 600, color: 'var(--apollo-gold)' }}>
                    {r.isNew ? 'Auto-completed' : 'Synced'}:
                  </span>{' '}
                  <span style={{ color: 'var(--text-secondary)' }}>{r.plannedDay.label} — {r.actualDistanceMi.toFixed(1)} mi</span>
                </div>
              ))}
            </div>
          )}

          <div style={{ marginTop: '1.25rem' }}>
            <Link to="/training" className="btn btn-primary" style={{ fontSize: 'var(--text-sm)' }}>
              Open Training Plan
            </Link>
          </div>
        </div>
      )}

      {/* ═══ Plan Progress Bar (when plan active) ═══ */}
      {plan && activePlan && (
        <div className="card" style={{ padding: '1.25rem 1.5rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
            <span style={{ fontSize: '0.75rem', fontFamily: 'var(--font-display)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-muted)' }}>Plan Progress</span>
            <span style={{ fontSize: 'var(--text-sm)', fontFamily: 'var(--font-display)', fontWeight: 700, color: 'var(--apollo-gold)' }}>{progressPct}%</span>
          </div>
          <div style={{
            height: 10, borderRadius: 5,
            background: 'rgba(255,255,255,0.06)', overflow: 'hidden',
          }}>
            <div style={{
              height: '100%', borderRadius: 5,
              width: `${progressPct}%`,
              background: 'linear-gradient(90deg, var(--apollo-gold-dark), var(--apollo-gold), var(--apollo-gold-light))',
              transition: 'width 0.6s ease',
              boxShadow: '0 0 8px rgba(212, 165, 55, 0.3)',
            }} />
          </div>
          <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginTop: '0.35rem' }}>
            {completedCount} of {totalDays} days completed
          </div>
        </div>
      )}

      {/* ═══ Race Prediction & Stats Strip ═══ */}
      {plan && activePlan && (prediction || adherence) && (
        <div className="card" style={{ padding: '1.25rem 1.5rem' }}>
          <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
            {prediction && (
              <StatCard label="Marathon" value={prediction.marathonTimeFormatted} color="var(--apollo-gold)" sub={`VDOT ${prediction.vdot} · ${prediction.confidence}%`} />
            )}
            {adherence && (
              <StatCard label="Adherence" value={`${adherence.score}%`}
                color={adherence.score >= 80 ? 'var(--color-success)' : adherence.score >= 60 ? 'var(--color-warning)' : 'var(--color-error)'}
                sub={adherence.rating} />
            )}
            {readiness && (
              <StatCard label={`Readiness Wk ${readiness.weekNumber}`} value={readiness.grade}
                color={readiness.grade.startsWith('A') ? 'var(--color-success)' : readiness.grade.startsWith('B') ? 'var(--apollo-teal)' : 'var(--color-warning)'}
                sub={`${readiness.score}/100`} />
            )}
          </div>
          <div style={{ marginTop: '1rem', textAlign: 'right' }}>
            <Link to="/insights" className="btn btn-outline" style={{ fontSize: '0.82rem' }}>View Full Insights</Link>
          </div>
        </div>
      )}

      {/* ── Adaptive Training Recommendations ── */}
      {plan && activePlan && stravaConnected && (
        <ErrorBoundary>
          <AdaptiveRecommendations />
        </ErrorBoundary>
      )}

      {/* ═══ Daily Recap Popup ═══ */}
      {showDailyRecap && dailyRecap && (
        <div className="card" style={{
          borderLeft: `3px solid ${dailyRecap.grade === 'outstanding' ? 'var(--color-success)' : dailyRecap.grade === 'strong' ? 'var(--apollo-teal)' : dailyRecap.grade === 'missed' ? 'var(--color-error)' : 'var(--border)'}`,
          background: 'linear-gradient(135deg, rgba(212,165,55,0.04) 0%, var(--bg-card) 100%)',
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h3 style={{ margin: 0 }}>Daily Training Recap</h3>
            <button type="button" onClick={() => setShowDailyRecap(false)} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: '1.2rem', cursor: 'pointer', padding: '0.25rem' }}>✕</button>
          </div>
          {dailyRecap.synced && (
            <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', margin: '0.75rem 0', fontSize: 'var(--text-sm)' }}>
              <span style={{ color: 'var(--apollo-gold)', fontWeight: 600 }}>{dailyRecap.actualDistanceMi.toFixed(1)} mi</span>
              <span style={{ color: 'var(--text-secondary)' }}>{formatPaceMinPerMi(dailyRecap.actualPaceMinPerMi)}</span>
              {dailyRecap.avgHR && <span style={{ color: 'var(--text-secondary)' }}>{dailyRecap.avgHR} bpm</span>}
              {dailyRecap.primaryZone && <span style={{ color: 'var(--text-secondary)' }}>Zone: {dailyRecap.primaryZone}</span>}
            </div>
          )}
          <p style={{ fontSize: 'var(--text-sm)', color: 'var(--text)', lineHeight: 1.5, margin: '0.5rem 0 0', fontStyle: 'italic' }}>{dailyRecap.coachMessage}</p>
        </div>
      )}

      {/* ═══ Weekly Readiness Popup ═══ */}
      {showWeeklyRecap && readiness && (
        <div className="card" style={{
          borderLeft: `3px solid ${readiness.grade.startsWith('A') ? 'var(--color-success)' : readiness.grade.startsWith('B') ? 'var(--apollo-teal)' : 'var(--color-warning)'}`,
          background: 'linear-gradient(135deg, rgba(91,181,181,0.04) 0%, var(--bg-card) 100%)',
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h3 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              Race Day Readiness — Week {readiness.weekNumber}
              <span style={{ fontSize: '1.3rem', fontWeight: 700, color: readiness.grade.startsWith('A') ? 'var(--color-success)' : readiness.grade.startsWith('B') ? 'var(--apollo-teal)' : 'var(--color-warning)' }}>{readiness.grade}</span>
            </h3>
            <button type="button" onClick={() => setShowWeeklyRecap(false)} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: '1.2rem', cursor: 'pointer', padding: '0.25rem' }}>✕</button>
          </div>
          {readiness.strengths.length > 0 && (
            <div style={{ margin: '0.75rem 0 0' }}>
              <strong style={{ fontSize: 'var(--text-sm)', color: 'var(--color-success)' }}>Strengths</strong>
              {readiness.strengths.map((s, i) => <p key={i} style={{ margin: '0.2rem 0 0', fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>{s}</p>)}
            </div>
          )}
          {readiness.improvements.length > 0 && (
            <div style={{ margin: '0.5rem 0 0' }}>
              <strong style={{ fontSize: 'var(--text-sm)', color: 'var(--color-warning)' }}>Areas to improve</strong>
              {readiness.improvements.map((s, i) => <p key={i} style={{ margin: '0.2rem 0 0', fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>{s}</p>)}
            </div>
          )}
          {readiness.nextWeekTips.length > 0 && (
            <div style={{ margin: '0.5rem 0 0' }}>
              <strong style={{ fontSize: 'var(--text-sm)', color: 'var(--apollo-teal)' }}>Next week</strong>
              {readiness.nextWeekTips.map((s, i) => <p key={i} style={{ margin: '0.2rem 0 0', fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>{s}</p>)}
            </div>
          )}
          <div style={{ marginTop: '0.75rem' }}>
            <Link to="/insights" style={{ fontSize: 'var(--text-sm)', fontWeight: 600 }}>View full insights →</Link>
          </div>
        </div>
      )}

      {/* ═══ Recent Activities ═══ */}
      {stravaConnected && (
        <div className="card">
          <h3 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <span style={{ color: 'var(--apollo-gold)' }}>Recent Activities</span>
          </h3>
          {loading ? (
            <p style={{ color: 'var(--text-muted)' }}>Loading…</p>
          ) : recent.length === 0 ? (
            <p style={{ color: 'var(--text-muted)' }}>No activities yet. Get out there and run!</p>
          ) : (
            <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {recent.slice(0, 5).map((a) => (
                <li
                  key={a.id}
                  style={{
                    padding: '0.85rem 0',
                    borderBottom: '1px solid var(--border)',
                    display: 'flex',
                    justifyContent: 'space-between',
                    flexWrap: 'wrap',
                    gap: '0.5rem',
                    transition: 'background var(--transition-fast)',
                  }}
                >
                  <div>
                    <strong style={{ fontFamily: 'var(--font-display)', fontWeight: 600 }}>{a.name || a.type}</strong>
                    <span style={{ color: 'var(--text-muted)', marginLeft: '0.5rem', fontSize: 'var(--text-sm)' }}>
                      {new Date(a.start_date_local).toLocaleDateString()} · {a.sport_type || a.type}
                    </span>
                  </div>
                  <div style={{ color: 'var(--text-secondary)', fontSize: 'var(--text-sm)', fontFamily: 'var(--font-display)' }}>
                    {formatDistance(a.distance)} · {formatDuration(a.moving_time)}
                    {a.average_speed != null && a.average_speed > 0 && (
                      <> · {formatPace(a.distance, a.moving_time)}</>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
          <div style={{ marginTop: '1rem' }}>
            <Link to="/activities" className="btn btn-secondary" style={{ fontSize: 'var(--text-sm)' }}>View All Activities</Link>
          </div>
        </div>
      )}

      {/* ═══ No Plan CTA ═══ */}
      {!plan && (
        <div className="card" style={{
          textAlign: 'center',
          padding: '2.5rem',
          background: 'linear-gradient(135deg, rgba(212,165,55,0.06) 0%, var(--bg-card) 100%)',
          borderColor: 'var(--border-strong)',
        }}>
          <div style={{ fontSize: '2.5rem', marginBottom: '0.75rem' }}>⚡</div>
          <h3 style={{ fontSize: 'var(--text-lg)', marginBottom: '0.5rem' }}>Begin Your Legendary Journey</h3>
          <p style={{ color: 'var(--text-secondary)', marginBottom: '1.25rem', maxWidth: 420, marginLeft: 'auto', marginRight: 'auto', lineHeight: 1.6 }}>
            Choose from Hal Higdon, Hanson&apos;s, Pfitzinger, and more — set your race date, and let Apollo guide your training.
          </p>
          <Link to="/training" className="btn btn-primary" style={{ fontSize: 'var(--text-base)' }}>Choose a Training Plan</Link>
        </div>
      )}

      {/* ═══ Not Connected CTA ═══ */}
      {!stravaConnected && (
        <div className="card" style={{
          display: 'flex', gap: '1.5rem', alignItems: 'center', flexWrap: 'wrap',
          borderColor: 'var(--border)',
        }}>
          <div style={{ flex: 1, minWidth: 200 }}>
            <h3 style={{ margin: '0 0 0.5rem', color: 'var(--strava)' }}>Connect Strava</h3>
            <p style={{ color: 'var(--text-secondary)', margin: 0, fontSize: 'var(--text-sm)', lineHeight: 1.5 }}>
              Unlock auto-sync, race predictions, and personalized coaching by connecting your Strava account.
            </p>
          </div>
          <Link to="/settings" className="btn btn-primary">Connect Now</Link>
        </div>
      )}
    </div>
  );
}
