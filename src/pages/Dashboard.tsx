import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { summarizeBySport, currentWeekRange, type SportSummary } from '../services/crossTraining';
import { getHRProfile } from '../services/heartRate';
import { getActivePlan, getDateKeyForDay, getSyncMeta, isDayCompleted, type SyncMeta } from '../services/planProgress';
import { getEffectivePlan, onPlanOverlayChanged } from '../services/planOverlay';
import { onPlanEvent, PLAN_PROGRESS_CHANGED_EVENT } from '../services/planEvents';
import { getJourneyState } from '../services/journey';
import {
  runAutoSync,
  refreshPlanFromStoredActivities,
  onPlanRefreshed,
  getWeeklyMileageSummary,
  type SyncResult,
} from '../services/autoSync';
import {
  calculateRacePrediction,
  getSavedPrediction,
  getSavedAdherence,
  type RacePrediction,
  type TrainingAdherence,
} from '../services/racePrediction';
import { getLatestReadinessScore, type ReadinessScore } from '../services/weeklyReadiness';
import { generateTodayRecap, type DailyRecap } from '../services/dailyRecap';
import { isDailyRecapDue, markDailyRecapShown, isWeeklyRecapDue, markWeeklyRecapShown } from '../services/coachingPreferences';
import { onAthleteProfileChanged } from '../services/athleteProfile';
import AdaptiveRecommendations from '../components/AdaptiveRecommendations';
import ErrorBoundary from '../components/ErrorBoundary';
import LoadingScreen from '../components/LoadingScreen';
import RecoveryCard from '../components/RecoveryCard';
import ConnectDataSourceCTA from '../components/ConnectDataSourceCTA';
import FormChip from '../components/fitness/FormChip';
import { computePlanProgress } from '../components/plan/planDisplay';
import TodayHeader from '../components/today/TodayHeader';
import TodayHero, { type HeroWorkoutProps } from '../components/today/TodayHero';
import { DailyRecapCard, WeeklyReadinessCard } from '../components/today/CoachCards';
import ThisWeekCard from '../components/today/ThisWeekCard';
import PredictionCard from '../components/today/PredictionCard';
import CrossTrainingCard from '../components/today/CrossTrainingCard';
import RecentActivities from '../components/today/RecentActivities';
import { getTodayVdot } from '../components/today/todayModel';
import { parseDateKey, todayKey } from '../utils/localDate';
import '../components/today/today.css';

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

/** Non-running volume for the current Monday-based week, read from the local store (no network). */
function loadWeekCrossTraining(): SportSummary[] {
  const range = currentWeekRange();
  const after = Math.floor(parseDateKey(range.from).getTime() / 1000) - DAY_SEC;
  const list = queryStoredActivities({ per_page: 1000, after });
  return summarizeBySport(list, { ...range, maxHR: getHRProfile().maxHR }).filter((s) => s.category !== 'run');
}

/** Activity that fulfilled a plan day (source-aware when the meta records its source). */
function findMetaActivity(list: Activity[], meta: SyncMeta): Activity | undefined {
  const matches = list.filter((a) => a.id === meta.activityId);
  if (matches.length <= 1 || !meta.activitySource) return matches[0];
  return matches.find((a) => (a.source ?? 'strava') === meta.activitySource) ?? matches[0];
}

/** Run a read that must never take the page down; `fallback` on any error. */
function safely<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch {
    return fallback;
  }
}

/**
 * Today (v1.0.6 "Today v2"): journey header, phase-aware hero with today's
 * workout, targets and actions, coach recaps, readiness, this week, prediction,
 * cross-training and recent activities. Nothing here imports chart libraries.
 */
export default function Dashboard() {
  const [athlete, setAthlete] = useState<AthleteProfile | null>(null);
  // Seeded from the local store so synced or imported history shows immediately — with or without a live source.
  const [recent, setRecent] = useState<Activity[]>(() => queryStoredActivities({ per_page: RECENT_COUNT }));
  const [weekCross, setWeekCross] = useState<SportSummary[]>(loadWeekCrossTraining);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [syncResults, setSyncResults] = useState<SyncResult[]>([]);
  const [syncProgress, setSyncProgress] = useState<string | null>(() => (isSyncRunning() ? SYNC_RUNNING_MESSAGE : null));
  /** Bumped when the effective plan or a day's completion changes (overlay edits, toggles, syncs). */
  const [planVersion, setPlanVersion] = useState(0);
  /** Bumped when activities or the athlete profile change (VDOT and targets depend on them). */
  const [dataVersion, setDataVersion] = useState(0);
  /** Plan auto-synced on this visit, with its pass — StrictMode's effect re-run awaits it instead of dropping the results. */
  const autoSyncedPlanRef = useRef<{ key: string; results: Promise<SyncResult[]> } | null>(null);
  const [prediction, setPrediction] = useState<RacePrediction | null>(() => safely(getSavedPrediction, null));
  const [adherence, setAdherence] = useState<TrainingAdherence | null>(() => safely(getSavedAdherence, null));
  const [readiness, setReadiness] = useState<ReadinessScore | null>(() => safely(getLatestReadinessScore, null));
  const [dailyRecap, setDailyRecap] = useState<DailyRecap | null>(null);
  const [showDailyRecap, setShowDailyRecap] = useState(false);
  const [showWeeklyRecap, setShowWeeklyRecap] = useState(false);
  const connected = isActivitySourceConnected();
  const sourceName = getActiveSourceName();
  const activePlan = getActivePlan();
  const activePlanKey = activePlan ? `${activePlan.planId}:${activePlan.startDate}` : null;
  const today = todayKey();

  const bumpPlan = useCallback(() => setPlanVersion((n) => n + 1), []);

  /**
   * Re-read prediction, adherence, readiness and the coach recaps. B13: the
   * daily recap is generated for every athlete with activity data (synced or
   * file-imported), not only in the connected branch, and it is marked seen
   * only when dismissed.
   */
  const refreshInsights = useCallback(() => {
    setPrediction(safely(calculateRacePrediction, null));
    setAdherence(safely(getSavedAdherence, null));
    const latestReadiness = safely(getLatestReadinessScore, null);
    setReadiness(latestReadiness);
    const recap = hasActivityData() ? safely(generateTodayRecap, null) : null;
    setDailyRecap(recap);
    setShowDailyRecap(!!recap && isDailyRecapDue());
    setShowWeeklyRecap(!!latestReadiness && isWeeklyRecapDue());
  }, []);

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
          refreshInsights();
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
              bumpPlan();
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
        if (!cancelled) {
          setWeekCross(loadWeekCrossTraining());
          setDataVersion((n) => n + 1);
          refreshInsights();
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [connected, activePlanKey, bumpPlan, refreshInsights]);

  // Any source (intervals.icu, Strava or a file import) added/updated activities → refresh local views
  useEffect(() => onActivitiesUpdated(() => {
    setRecent(queryStoredActivities({ per_page: RECENT_COUNT }));
    setWeekCross(loadWeekCrossTraining());
    setDataVersion((n) => n + 1);
  }), []);

  // Plan days were re-matched (a sync anywhere, a file import or an offline re-match) and prediction,
  // readiness and recap recomputed → re-read them. An empty pass keeps the last matches on screen.
  useEffect(() => onPlanRefreshed((results) => {
    if (results.length > 0) setSyncResults(results);
    refreshInsights();
    bumpPlan();
  }), [bumpPlan, refreshInsights]);

  // Overlay edits (move/skip/convert/undo, new plan, race date) and completion toggles → re-render the plan views.
  useEffect(() => {
    const offOverlay = onPlanOverlayChanged(bumpPlan);
    const offProgress = onPlanEvent(PLAN_PROGRESS_CHANGED_EVENT, bumpPlan);
    return () => {
      offOverlay();
      offProgress();
    };
  }, [bumpPlan]);

  // A new recent race or goal changes the VDOT, the targets and the prediction.
  useEffect(() => onAthleteProfileChanged(() => {
    setDataVersion((n) => n + 1);
    setPrediction(safely(calculateRacePrediction, null));
  }), []);

  // Progress for the first sync, which imports the full history and can take a while.
  useEffect(() => onSyncStatus((status) => {
    setSyncProgress(status.running ? (status.progress?.message ?? SYNC_RUNNING_MESSAGE) : null);
  }), []);

  const { journey, plan } = useMemo(() => {
    void planVersion;
    void activePlanKey;
    return { journey: getJourneyState(today), plan: getEffectivePlan() };
  }, [planVersion, activePlanKey, today]);

  const vdot = useMemo(() => {
    void dataVersion;
    return safely(getTodayVdot, null);
  }, [dataVersion]);

  const planId = activePlan?.planId ?? null;
  const weekIndex = journey.weekIndex;
  const dayIndex = journey.dayIndex;

  const planProgress = useMemo(() => {
    void planVersion;
    if (!plan || !planId) return null;
    return computePlanProgress(plan, (w, d) => isDayCompleted(planId, w, d));
  }, [plan, planId, planVersion]);

  let workout: HeroWorkoutProps | null = null;
  if (plan && planId && activePlan && weekIndex != null && dayIndex != null && plan.weeks[weekIndex]?.days[dayIndex]) {
    const syncMeta = getSyncMeta(planId, weekIndex, dayIndex);
    workout = {
      plan,
      planId,
      weekIndex,
      dayIndex,
      dateKey: getDateKeyForDay(activePlan.startDate, weekIndex, dayIndex),
      startDate: activePlan.startDate,
      completed: isDayCompleted(planId, weekIndex, dayIndex),
      syncMeta,
      vdot,
      activity: syncMeta ? findMetaActivity(recent, syncMeta) : undefined,
      syncResults,
    };
  }
  const weeklyMileage = plan && planId && weekIndex != null ? safely(() => getWeeklyMileageSummary(planId, weekIndex), null) : null;

  const dismissDailyRecap = () => {
    setShowDailyRecap(false);
    markDailyRecapShown();
  };
  const dismissWeeklyRecap = () => {
    setShowWeeklyRecap(false);
    markWeeklyRecapShown();
  };

  if (loading && connected && !athlete && recent.length === 0) {
    return <LoadingScreen message="Loading your training data…" />;
  }

  const hasData = connected || recent.length > 0;

  return (
    <div className="today">
      <TodayHeader
        journey={journey}
        today={today}
        greeting={athlete?.firstname ? `Welcome back, ${athlete.firstname}` : null}
        sourceName={sourceName}
        connected={connected}
      />

      {error && (
        <div className="card today-status--error" role="alert">
          <strong>Error:</strong> {error}
        </div>
      )}

      <TodayHero journey={journey} today={today} startDate={activePlan?.startDate ?? null} workout={workout} />

      {showDailyRecap && dailyRecap && <DailyRecapCard recap={dailyRecap} onDismiss={dismissDailyRecap} />}
      {showWeeklyRecap && readiness && <WeeklyReadinessCard readiness={readiness} onDismiss={dismissWeeklyRecap} />}

      {hasData && (
        <div className="today-form">
          <ErrorBoundary>
            <FormChip />
          </ErrorBoundary>
          <Link to="/progress?tab=fitness" className="today-link">Fitness &amp; form</Link>
        </div>
      )}

      {/* Recovery (sleep / HRV / resting HR via intervals.icu) */}
      {connected && (
        <ErrorBoundary>
          <RecoveryCard compact headingLevel={2} />
        </ErrorBoundary>
      )}

      {plan && (
        <ThisWeekCard
          weeklyMileage={weeklyMileage}
          planProgress={planProgress}
          adherence={adherence}
          readiness={readiness}
        />
      )}

      <PredictionCard prediction={prediction} />

      {/* Adaptive Training Recommendations */}
      {plan && activePlan && (connected || hasActivityData()) && (
        <ErrorBoundary>
          <AdaptiveRecommendations />
        </ErrorBoundary>
      )}

      <CrossTrainingCard summaries={weekCross} />

      {hasData && (
        <RecentActivities activities={recent} busyMessage={loading || syncProgress !== null ? (syncProgress ?? 'Loading…') : null} />
      )}

      {!connected && <ConnectDataSourceCTA />}
    </div>
  );
}
