import { useState, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import {
  getActivities,
  getAthlete,
  hasActivityData,
  isActivitySourceConnected,
  isActivitySyncFresh,
  isSyncRunning,
  PAGE_SYNC_FRESH_MS,
  getActiveSourceName,
  onActivitiesUpdated,
  onSyncStatus,
  queryStoredActivities,
  type Activity,
  type AthleteProfile,
} from '../services/activitySource';
import {
  isRunActivity,
  isRideActivity,
  getSportIcon,
  getSportLabel,
  getSportCategoryIcon,
  SPORT_CATEGORIES,
  type SportCategory,
} from '../services/activity/sports';
import { summarizeBySport, currentWeekRange, formatHoursMinutes, type SportSummary } from '../services/crossTraining';
import { getHRProfile } from '../services/heartRate';
import { getActivePlan, getWeekDayForDate, getCompletedCount, getSyncMeta, isDayCompleted, type SyncMeta } from '../services/planProgress';
import { getPlanById } from '../data/plans';
import {
  runAutoSync,
  refreshPlanFromStoredActivities,
  onPlanRefreshed,
  getWeeklyMileageSummary,
  type SyncResult,
  type WeeklyMileage,
} from '../services/autoSync';
import { getSavedPrediction, getSavedAdherence, type RacePrediction, type TrainingAdherence } from '../services/racePrediction';
import { getLatestReadinessScore, type ReadinessScore } from '../services/weeklyReadiness';
import { generateTodayRecap, type DailyRecap } from '../services/dailyRecap';
import { isDailyRecapDue, markDailyRecapShown, isWeeklyRecapDue, markWeeklyRecapShown } from '../services/coachingPreferences';
import AdaptiveRecommendations from '../components/AdaptiveRecommendations';
import ErrorBoundary from '../components/ErrorBoundary';
import LoadingScreen from '../components/LoadingScreen';
import RouteMap, { RouteMapThumbnail } from '../components/RouteMap';
import RecoveryCard from '../components/RecoveryCard';
import { getEffortRecognition } from '../services/effortService';
import { TIER_CONFIG } from '../components/TierBadge';
import ConnectDataSourceCTA from '../components/ConnectDataSourceCTA';
import {
  formatDistanceShort,
  formatPace as fmtPace,
  formatDuration,
  formatMiles,
  formatPaceFromMinPerMi,
  formatSpeed,
} from '../services/unitPreferences';

const RECENT_COUNT = 10;
const DAY_SEC = 24 * 60 * 60;
const SYNC_RUNNING_MESSAGE = 'Syncing activities…';
/** When a Dashboard visit last started a network sync — module-level so it outlives the page; spaces out retries after failures. */
let lastDashboardSyncAt = 0;

/**
 * Skip the network on this visit: a sync is running (its plan matches arrive via onPlanRefreshed), the last
 * successful sync is fresh (launch/background sync, Training, Settings), or this page tried within PAGE_SYNC_FRESH_MS.
 */
function activitiesSyncedRecently(): boolean {
  return isSyncRunning() || isActivitySyncFresh() || Date.now() - lastDashboardSyncAt < PAGE_SYNC_FRESH_MS;
}

/** Offline plan match against the stored activities, as a promise (a throw becomes a rejection). */
async function matchStoredActivities(): Promise<SyncResult[]> {
  return refreshPlanFromStoredActivities();
}

/** `start_date_local` ends in a "Z" that isn't UTC — use only its calendar date. */
function formatLocalDate(startDateLocal: string): string {
  const [y, m, d] = startDateLocal.slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return '';
  return new Date(y, m - 1, d).toLocaleDateString();
}

/** Icon for a stored cross-training category (falls back safely for unknown values). */
function categoryIcon(category: string): string {
  return (SPORT_CATEGORIES as readonly string[]).includes(category)
    ? getSportCategoryIcon(category as SportCategory)
    : '⚡';
}

/** Non-running volume for the current Monday-based week, read from the local store (no network). */
function loadWeekCrossTraining(): SportSummary[] {
  const range = currentWeekRange();
  const after = Math.floor(new Date(`${range.from}T00:00:00`).getTime() / 1000) - DAY_SEC;
  const list = queryStoredActivities({ per_page: 1000, after });
  return summarizeBySport(list, { ...range, maxHR: getHRProfile().maxHR }).filter((s) => s.category !== 'run');
}

/** Compact one-line stats for a plan day fulfilled by cross-training (ride, swim, strength…). */
function CrossTrainingSummary({ meta }: { meta: SyncMeta }) {
  const ct = meta.crossTraining;
  if (!ct) return null;
  return (
    <>
      <span style={{ color: 'var(--apollo-teal)', fontWeight: 700, fontFamily: 'var(--font-display)', fontSize: '1.1rem' }}>
        {categoryIcon(ct.category)} {ct.label}
      </span>
      <span style={{ color: 'var(--text-secondary)', fontSize: 'var(--text-sm)' }}>{formatHoursMinutes(meta.movingTimeSec)}</span>
      {ct.distanceMeters > 0 && (
        <span style={{ color: 'var(--text-secondary)', fontSize: 'var(--text-sm)' }}>{formatDistanceShort(ct.distanceMeters)}</span>
      )}
      {ct.averageWatts != null && ct.averageWatts > 0 && (
        <span style={{ color: 'var(--text-secondary)', fontSize: 'var(--text-sm)' }}>{Math.round(ct.averageWatts)} W avg</span>
      )}
      {ct.averageHR != null && ct.averageHR > 0 && (
        <span style={{ color: 'var(--text-secondary)', fontSize: 'var(--text-sm)' }}>{Math.round(ct.averageHR)} bpm</span>
      )}
      {ct.trainingLoad != null && ct.trainingLoad > 0 && (
        <span style={{ color: 'var(--text-secondary)', fontSize: 'var(--text-sm)' }}>Load {Math.round(ct.trainingLoad)}</span>
      )}
    </>
  );
}

/** Distance · duration · pace (runs) or speed (rides); duration first for sports without distance. */
function activityStatsLine(a: Activity): string {
  if (!(a.distance > 0)) return formatDuration(a.moving_time || a.elapsed_time);
  const parts = [formatDistanceShort(a.distance), formatDuration(a.moving_time)];
  if ((a.average_speed ?? 0) > 0) {
    if (isRunActivity(a)) parts.push(fmtPace(a.distance, a.moving_time));
    else if (isRideActivity(a)) parts.push(formatSpeed(a.average_speed));
  }
  return parts.join(' · ');
}

/** Activity that fulfilled a plan day (source-aware when the meta records its source). */
function findMetaActivity(list: Activity[], meta: SyncMeta): Activity | undefined {
  const matches = list.filter((a) => a.id === meta.activityId);
  if (matches.length <= 1 || !meta.activitySource) return matches[0];
  return matches.find((a) => (a.source ?? 'strava') === meta.activitySource) ?? matches[0];
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
  const [athlete, setAthlete] = useState<AthleteProfile | null>(null);
  // Seeded from the local store so synced or imported history shows immediately — with or without a live source.
  const [recent, setRecent] = useState<Activity[]>(() => queryStoredActivities({ per_page: RECENT_COUNT }));
  const [weekCross, setWeekCross] = useState<SportSummary[]>(loadWeekCrossTraining);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [syncResults, setSyncResults] = useState<SyncResult[]>([]);
  const [syncProgress, setSyncProgress] = useState<string | null>(() => (isSyncRunning() ? SYNC_RUNNING_MESSAGE : null));
  const [, forceUpdate] = useState(0);
  /** Plan auto-synced on this visit, with its pass — StrictMode's effect re-run awaits it instead of dropping the results. */
  const autoSyncedPlanRef = useRef<{ key: string; results: Promise<SyncResult[]> } | null>(null);
  const [prediction, setPrediction] = useState<RacePrediction | null>(null);
  const [adherence, setAdherence] = useState<TrainingAdherence | null>(null);
  const [readiness, setReadiness] = useState<ReadinessScore | null>(null);
  const [dailyRecap, setDailyRecap] = useState<DailyRecap | null>(null);
  const [showDailyRecap, setShowDailyRecap] = useState(false);
  const [showWeeklyRecap, setShowWeeklyRecap] = useState(false);
  const connected = isActivitySourceConnected();
  const sourceName = getActiveSourceName();
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
    let cancelled = false;
    (async () => {
      try {
        setError(null);
        // Show what's already stored right away (the first sync can take a while)
        setRecent(queryStoredActivities({ per_page: RECENT_COUNT }));
        setWeekCross(loadWeekCrossTraining());

        if (!connected) {
          // No live source: show history already on this device (earlier syncs, file imports) — never sync.
          autoSyncedPlanRef.current = null;
          setAthlete(null);
          setPrediction(getSavedPrediction());
          setAdherence(getSavedAdherence());
          setReadiness(getLatestReadinessScore());
          return;
        }

        setLoading(true);
        getAthlete()
          .then((a) => { if (!cancelled) setAthlete(a); })
          .catch(() => { /* non-critical */ });

        if (activePlanKey) {
          let pass = autoSyncedPlanRef.current;
          if (!pass || pass.key !== activePlanKey) {
            if (activitiesSyncedRecently()) {
              // Synced in the last few minutes, or a sync is running (its matches arrive via onPlanRefreshed):
              // match the stored activities offline instead of syncing on every visit.
              pass = { key: activePlanKey, results: matchStoredActivities() };
            } else {
              // Pulls new activities from every connected source, then matches plan days
              lastDashboardSyncAt = Date.now();
              pass = { key: activePlanKey, results: runAutoSync() };
            }
            autoSyncedPlanRef.current = pass;
          }
          try {
            const results = await pass.results;
            if (!cancelled) {
              setSyncResults(results);
              forceUpdate((n) => n + 1);
            }
          } catch {
            // keep dashboard data load successful even if auto-sync fails
          }
          if (!cancelled) setRecent(queryStoredActivities({ per_page: RECENT_COUNT }));
        } else {
          // Refreshes from connected sources only when the last sync is stale
          const activitiesRes = await getActivities({ per_page: RECENT_COUNT });
          if (!cancelled) setRecent(activitiesRes);
        }
        if (!cancelled) setWeekCross(loadWeekCrossTraining());

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
  }, [connected, activePlanKey]);

  // Any source (intervals.icu, Strava or a file import) added/updated activities → refresh local views
  useEffect(() => onActivitiesUpdated(() => {
    setRecent(queryStoredActivities({ per_page: RECENT_COUNT }));
    setWeekCross(loadWeekCrossTraining());
  }), []);

  // Plan days were re-matched (a sync anywhere, a file import or an offline re-match) and prediction,
  // readiness and recap recomputed → re-read them. An empty pass keeps the last matches on screen.
  useEffect(() => onPlanRefreshed((results) => {
    if (results.length > 0) setSyncResults(results);
    setPrediction(getSavedPrediction());
    setAdherence(getSavedAdherence());
    setReadiness(getLatestReadinessScore());
    const recap = generateTodayRecap();
    if (recap) setDailyRecap(recap);
    forceUpdate((n) => n + 1);
  }), []);

  // Progress for the first sync, which imports the full history and can take a while.
  useEffect(() => onSyncStatus((status) => {
    setSyncProgress(status.running ? (status.progress?.message ?? SYNC_RUNNING_MESSAGE) : null);
  }), []);

  if (loading && connected && !athlete && recent.length === 0) {
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
          <Link
            to="/settings"
            title={connected ? `Activities sync from ${sourceName}` : 'Connect a data source in Settings'}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: '0.4rem',
              fontSize: '0.78rem', padding: '0.35rem 0.75rem',
              borderRadius: 'var(--radius-full)',
              background: connected ? 'rgba(91,181,181,0.12)' : 'var(--bg-surface)',
              color: connected ? 'var(--apollo-teal)' : 'var(--text-muted)',
              fontWeight: 600,
              textDecoration: 'none',
            }}
          >
            {sourceName} {connected ? '●' : '○'}
          </Link>
        </div>
      </div>

      {error && (
        <div className="card" role="alert" style={{ background: 'var(--color-error-dim)', borderColor: 'var(--color-error)', borderLeftWidth: 4, borderLeftStyle: 'solid' }}>
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
                  {formatMiles(todayWorkout.distanceMi)}
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
                }}>{todaySyncMeta.activitySource === 'file' ? 'Imported' : 'Auto-synced'}</span>
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
              <div style={{ display: 'flex', gap: '1.25rem', flexWrap: 'wrap', alignItems: 'baseline', marginBottom: '0.35rem' }}>
                {todaySyncMeta.crossTraining ? (
                  <CrossTrainingSummary meta={todaySyncMeta} />
                ) : (
                  <>
                    <span style={{ color: 'var(--apollo-gold)', fontWeight: 700, fontFamily: 'var(--font-display)', fontSize: '1.1rem' }}>{formatMiles(todaySyncMeta.actualDistanceMi)}</span>
                    <span style={{ color: 'var(--text-secondary)', fontSize: 'var(--text-sm)' }}>{formatPaceFromMinPerMi(todaySyncMeta.actualPaceMinPerMi)} pace</span>
                    <span style={{ color: 'var(--text-secondary)', fontSize: 'var(--text-sm)' }}>{Math.floor(todaySyncMeta.movingTimeSec / 60)}m {todaySyncMeta.movingTimeSec % 60}s</span>
                  </>
                )}
              </div>
              <div style={{ color: 'var(--text)', fontStyle: 'italic', fontSize: 'var(--text-sm)', lineHeight: 1.5 }}>{todaySyncMeta.feedback}</div>
            </div>
          )}

          {/* Route map for today's synced activity (any sport with GPS) */}
          {todaySyncMeta && (() => {
            const todayActivity = findMetaActivity(recent, todaySyncMeta);
            if (todayActivity?.map?.summary_polyline) {
              return (
                <div style={{ marginTop: '0.75rem' }}>
                  <RouteMap activity={todayActivity} size="card" colorMode={todaySyncMeta.crossTraining ? 'teal' : 'apollo'} animate={true} />
                </div>
              );
            }
            return null;
          })()}

          {/* Effort recognition for today's synced run */}
          {todaySyncMeta && !todaySyncMeta.crossTraining && (() => {
            const rec = getEffortRecognition(todaySyncMeta.activityId);
            if (!rec || (rec.insights.length === 0 && !rec.paceTier)) return null;
            return (
              <div style={{
                marginTop: '0.65rem', padding: '0.6rem 0.85rem',
                background: 'rgba(212, 165, 55, 0.03)', borderRadius: 'var(--radius-md)',
                border: '1px solid var(--border)',
                borderLeftWidth: 3,
                borderLeftColor: rec.paceTier ? TIER_CONFIG[rec.paceTier].color : 'var(--border)',
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: rec.insights.length > 0 ? '0.4rem' : 0 }}>
                  <span style={{ fontSize: '0.68rem', fontFamily: 'var(--font-display)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-muted)' }}>
                    Effort #{rec.effortNumber} · {rec.routeName}
                  </span>
                  {rec.paceTier && (
                    <span style={{
                      fontSize: '0.68rem', fontWeight: 600, padding: '0.12rem 0.5rem',
                      borderRadius: 'var(--radius-full)',
                      background: TIER_CONFIG[rec.paceTier].bg,
                      color: TIER_CONFIG[rec.paceTier].color,
                      fontFamily: 'var(--font-display)',
                    }}>{TIER_CONFIG[rec.paceTier].label}</span>
                  )}
                </div>
                {rec.insights.slice(0, 2).map((ins, i) => (
                  <div key={i} style={{
                    fontSize: '0.82rem', color: ins.sentiment === 'positive' ? 'var(--text)' : 'var(--text-secondary)',
                    lineHeight: 1.4, padding: '0.15rem 0 0.15rem 0.65rem',
                    borderLeft: `2px solid ${ins.sentiment === 'positive' ? 'var(--color-success)' : ins.sentiment === 'neutral' ? 'var(--border)' : 'var(--color-warning)'}`,
                    marginBottom: i < 1 ? '0.25rem' : 0,
                  }}>{ins.message}</div>
                ))}
              </div>
            );
          })()}

          {/* Weekly mileage progress */}
          {weeklyMileage && weeklyMileage.actualMi > 0 && (
            <div style={{ marginTop: '1rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.4rem' }}>
                <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', fontFamily: 'var(--font-display)', fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.06em' }}>This week</span>
                <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', fontWeight: 600 }}>
                  {formatMiles(weeklyMileage.actualMi)} / {formatMiles(weeklyMileage.plannedMi)}
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
                  <span style={{ color: 'var(--text-secondary)' }}>
                    {r.plannedDay.label} — {r.isCrossTraining
                      ? `${getSportIcon(r.activity)} ${getSportLabel(r.activity)} · ${formatHoursMinutes(r.activity.moving_time || r.activity.elapsed_time)}`
                      : formatMiles(r.actualDistanceMi)}
                  </span>
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

      {/* ═══ Recovery (sleep / HRV / resting HR via intervals.icu) ═══ */}
      {connected && (
        <ErrorBoundary>
          <RecoveryCard compact />
        </ErrorBoundary>
      )}

      {/* ═══ This Week: Cross-Training ═══ */}
      {(connected || weekCross.length > 0) && (
        <div className="card" style={{ padding: '1.1rem 1.5rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: weekCross.length > 0 ? '0.75rem' : '0.35rem' }}>
            <span style={{ fontSize: '0.75rem', fontFamily: 'var(--font-display)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-muted)' }}>
              This week · Cross-training
            </span>
            {weekCross.length > 0 && (
              <span style={{ fontSize: 'var(--text-sm)', fontFamily: 'var(--font-display)', fontWeight: 700, color: 'var(--apollo-teal)' }}>
                {formatHoursMinutes(weekCross.reduce((sum, s) => sum + s.movingTimeSec, 0))}
              </span>
            )}
          </div>
          {weekCross.length === 0 ? (
            <p style={{ color: 'var(--text-muted)', fontSize: '0.82rem', margin: 0 }}>
              No rides, swims or gym sessions yet this week — they&apos;ll appear here automatically.
            </p>
          ) : (
            <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
              {weekCross.map((s) => (
                <StatCard
                  key={s.category}
                  label={`${s.icon} ${s.label}`}
                  value={formatHoursMinutes(s.movingTimeSec)}
                  color="var(--apollo-teal)"
                  sub={[
                    `${s.count} session${s.count === 1 ? '' : 's'}`,
                    s.distanceMeters > 0 ? formatDistanceShort(s.distanceMeters) : null,
                    s.trainingLoad > 0 ? `Load ${Math.round(s.trainingLoad)}` : null,
                  ].filter(Boolean).join(' · ')}
                />
              ))}
            </div>
          )}
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
      {plan && activePlan && (connected || hasActivityData()) && (
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
              <span style={{ color: 'var(--apollo-gold)', fontWeight: 600 }}>{formatMiles(dailyRecap.actualDistanceMi)}</span>
              <span style={{ color: 'var(--text-secondary)' }}>{formatPaceFromMinPerMi(dailyRecap.actualPaceMinPerMi)}</span>
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
      {(connected || recent.length > 0) && (
        <div className="card">
          <h3 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <span style={{ color: 'var(--apollo-gold)' }}>Recent Activities</span>
          </h3>
          {(loading || syncProgress !== null) && recent.length === 0 ? (
            <p role="status" style={{ color: 'var(--text-muted)' }}>{syncProgress ?? 'Loading…'}</p>
          ) : recent.length === 0 ? (
            <p style={{ color: 'var(--text-muted)' }}>No activities yet. Get out there and train!</p>
          ) : (
            <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {recent.slice(0, 5).map((a) => {
                const actRec = isRunActivity(a) ? getEffortRecognition(a.id) : null;
                const actTier = actRec?.paceTier ?? actRec?.hrEfficiencyTier ?? null;
                const tierDotColor = actTier === 'gold' ? 'var(--apollo-gold)' : actTier === 'silver' ? 'var(--text-secondary)' : actTier === 'bronze' ? '#CD7F32' : null;

                return (
                <li
                  key={`${a.source ?? 'strava'}-${a.id}`}
                  style={{
                    padding: '0.85rem 0',
                    borderBottom: '1px solid var(--border)',
                    display: 'grid',
                    gridTemplateColumns: a.map?.summary_polyline ? '48px 1fr auto' : '1fr auto',
                    gap: '0.75rem',
                    alignItems: 'center',
                    transition: 'background var(--transition-fast)',
                  }}
                >
                  {a.map?.summary_polyline && (
                    <RouteMapThumbnail activity={a} />
                  )}
                  <div>
                    <strong style={{ fontFamily: 'var(--font-display)', fontWeight: 600 }}>
                      <span aria-hidden style={{ marginRight: '0.35rem' }}>{getSportIcon(a)}</span>
                      {a.name || getSportLabel(a)}
                      {tierDotColor && (
                        <span style={{
                          display: 'inline-block', width: 7, height: 7, borderRadius: '50%',
                          background: tierDotColor, marginLeft: '0.35rem', verticalAlign: 'middle',
                          boxShadow: actTier === 'gold' ? '0 0 6px rgba(212,165,55,0.4)' : 'none',
                        }} />
                      )}
                    </strong>
                    <span style={{ color: 'var(--text-muted)', marginLeft: '0.5rem', fontSize: 'var(--text-sm)' }}>
                      {formatLocalDate(a.start_date_local)} · {getSportLabel(a)}{a.trainer ? ' · Indoor' : ''}
                    </span>
                  </div>
                  <div style={{ color: 'var(--text-secondary)', fontSize: 'var(--text-sm)', fontFamily: 'var(--font-display)', whiteSpace: 'nowrap' }}>
                    {activityStatsLine(a)}
                  </div>
                </li>
                );
              })}
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
      {!connected && <ConnectDataSourceCTA />}
    </div>
  );
}
