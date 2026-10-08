import { useState, useEffect, useCallback, useRef, useMemo, memo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { CUSTOM_PLAN_ID, setCustomPlan, type PlanDay, type TrainingPlan } from '../data/plans';
import PlanBuilder from '../components/PlanBuilder';
import {
  getActivePlan,
  setActivePlan,
  isDayCompleted,
  toggleDayCompleted,
  getDateKeyForDay,
  getWeekDayForDate,
  getSyncMeta,
  canToggleDayCompletion,
  type ActivePlan,
  type SyncMeta,
} from '../services/planProgress';
import { getEffectivePlan, onPlanOverlayChanged } from '../services/planOverlay';
import { onPlanEvent, PLAN_PROGRESS_CHANGED_EVENT } from '../services/planEvents';
import { getRaceDate } from '../services/journey';
import {
  isActivitySourceConnected,
  hasActivityData,
  getActiveSourceName,
  getSourceDisplayName,
  getStoredActivities,
  getLastActivitySyncTime,
  isActivitySyncFresh,
  isSyncRunning,
  PAGE_SYNC_FRESH_MS,
  type SyncSummary,
} from '../services/activitySource';
import { runSync, refreshPlanFromStoredActivities, onPlanRefreshed, getWeeklyMileageSummary, type SyncResult } from '../services/autoSync';
import { syncPlanCalendarIfChanged } from '../services/planCalendarSync';
import { getSportIcon, getSportLabel, getSportCategoryIcon, SPORT_CATEGORIES, type SportCategory } from '../services/activity/sports';
import { formatHoursMinutes } from '../services/crossTraining';
import { RouteMapThumbnail } from '../components/RouteMap';
import { getEffortRecognition } from '../services/effortService';
import { TIER_CONFIG } from '../components/TierBadge';
import { formatMiles, formatPaceFromMinPerMi, formatDistanceShort } from '../services/unitPreferences';
import CalendarView, { type CalendarDayRef } from '../components/CalendarView';
import PlanCalendarPush from '../components/PlanCalendarPush';
import PlanCalendarExport from '../components/PlanCalendarExport';
import { ConfirmDialog } from '../components/ui';
import { DayActionsMenu, DayBadgeChip, getDayBadges, type DayBadge } from '../components/plan/DayActionsMenu';
import PhaseRibbon from '../components/plan/PhaseRibbon';
import PlanChooser from '../components/plan/PlanChooser';
import {
  computeWeekProgress,
  formatDayLabel,
  formatMediumDate,
  isWorkoutDay,
  workoutTitle,
  type ProgressStats,
} from '../components/plan/planDisplay';
import { todayKey as getTodayKey, weekdayShort } from '../utils/localDate';
import '../components/plan/plan.css';

type TrainingViewMode = 'calendar' | 'checklist';

/** When this page last started a network sync — module-level so it outlives the page; spaces out retries after failures. */
let lastTrainingSyncAt = 0;

/**
 * Skip the network on a visit: a sync is running (its plan matches arrive via onPlanRefreshed), the last
 * successful sync is fresh, or this page tried within PAGE_SYNC_FRESH_MS. "Sync activities" always syncs.
 */
function activitiesSyncedRecently(): boolean {
  return isSyncRunning() || isActivitySyncFresh() || Date.now() - lastTrainingSyncAt < PAGE_SYNC_FRESH_MS;
}

/** "Today 7:41 AM", or "Oct 3, 7:41 AM" for an earlier day (year added when it differs). */
function formatLastSynced(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return `Today ${time}`;
  const date = d.toLocaleDateString([], d.getFullYear() === now.getFullYear()
    ? { month: 'short', day: 'numeric' }
    : { month: 'short', day: 'numeric', year: 'numeric' });
  return `${date}, ${time}`;
}

/** Icon for a stored cross-training category (falls back safely for unknown values). */
function categoryIcon(category: string): string {
  return (SPORT_CATEGORIES as readonly string[]).includes(category)
    ? getSportCategoryIcon(category as SportCategory)
    : '⚡';
}

/** "1h 05m · 32.1 km · 185 W · 142 bpm · Load 64" for a cross-training plan day. */
function crossTrainingStats(meta: SyncMeta): string[] {
  const ct = meta.crossTraining;
  if (!ct) return [];
  return [
    formatHoursMinutes(meta.movingTimeSec),
    ct.distanceMeters > 0 ? formatDistanceShort(ct.distanceMeters) : null,
    ct.averageWatts ? `${Math.round(ct.averageWatts)} W` : null,
    ct.averageHR ? `${Math.round(ct.averageHR)} bpm` : null,
    ct.trainingLoad ? `Load ${Math.round(ct.trainingLoad)}` : null,
  ].filter((s): s is string => !!s);
}

/** Stored activity behind a plan day (source-aware when the meta records its source). */
function findSyncedActivity(meta: SyncMeta) {
  const matches = getStoredActivities().filter((a) => a.id === meta.activityId);
  if (matches.length <= 1 || !meta.activitySource) return matches[0];
  return matches.find((a) => (a.source ?? 'strava') === meta.activitySource) ?? matches[0];
}

/** Display title for a plan day: unit-free for runs (km users never see "mi"), the plan's own label for cross-training. */
function dayTitle(day: PlanDay): string {
  return day.type === 'cross' ? day.label : workoutTitle(day);
}

/**
 * Workout-day progress from the week the athlete joined at (B6): rest days can't be
 * ticked off, and weeks skipped by a late start aren't owed, so finishing reaches 100 %.
 */
function planProgress(plan: TrainingPlan, planId: string, fromWeek: number): ProgressStats {
  let completed = 0;
  let total = 0;
  plan.weeks.forEach((week, wi) => {
    if (wi < fromWeek) return;
    const w = computeWeekProgress(week, wi, (w2, d2) => isDayCompleted(planId, w2, d2));
    completed += w.completed;
    total += w.total;
  });
  return { completed, total, pct: total > 0 ? Math.round((completed / total) * 100) : 0 };
}

/** Single day row in the training plan checklist. */
const DayRow = memo(function DayRow({
  plan,
  startDate,
  weekIndex,
  dayIndex,
  day,
  dateKey,
  isToday,
  completed,
  syncMeta,
  badge,
  onToggle,
  onChanged,
}: {
  plan: TrainingPlan;
  /** Plan start date — ticking a future day is blocked (T2a's canToggleDayCompletion). */
  startDate: string;
  weekIndex: number;
  dayIndex: number;
  day: PlanDay;
  dateKey: string;
  isToday: boolean;
  completed: boolean;
  syncMeta: SyncMeta | null;
  badge: DayBadge | null;
  onToggle: (weekIndex: number, dayIndex: number) => void;
  onChanged: (message: string) => void;
}) {
  const isSynced = !!syncMeta;
  const title = dayTitle(day);
  const dayLabel = formatDayLabel(dateKey);
  const toggleCheck = canToggleDayCompletion(startDate, weekIndex, dayIndex, { completed, dayType: day.type });
  const whyId = `plan-day-why-${weekIndex}-${dayIndex}`;
  return (
    <>
      <tr style={{ background: isToday ? 'rgba(212,165,55,0.08)' : isSynced ? 'rgba(212,165,55,0.03)' : undefined, transition: 'background 0.2s' }}>
        <td style={{ padding: '0.5rem', width: 36 }}>
          {isWorkoutDay(day) ? (
            <>
              <input
                type="checkbox"
                checked={completed}
                disabled={!toggleCheck.allowed}
                title={toggleCheck.message}
                aria-describedby={toggleCheck.message ? whyId : undefined}
                onChange={() => { if (toggleCheck.allowed) onToggle(weekIndex, dayIndex); }}
                aria-label={`Mark ${title} on ${dayLabel} complete`}
                style={{ accentColor: 'var(--apollo-gold)', width: 18, height: 18 }}
              />
              {toggleCheck.message && <span id={whyId} className="sr-only">{toggleCheck.message}</span>}
            </>
          ) : (
            <span style={{ color: 'var(--text-muted)' }} aria-hidden="true">—</span>
          )}
        </td>
        <td style={{ padding: '0.5rem', color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>{weekdayShort(dateKey)}</td>
        <td style={{ padding: '0.5rem', fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>{formatMediumDate(dateKey)}</td>
        <td style={{ padding: '0.5rem' }}>
          <span className={`day-type-${day.type}`} style={{ fontFamily: 'var(--font-display)', fontWeight: completed ? 600 : 400 }}>{title}</span>
          {day.distanceMi != null && day.distanceMi > 0 && (
            <span style={{ color: 'var(--text-muted)', marginLeft: '0.5rem', fontSize: 'var(--text-sm)' }}>
              {formatMiles(day.distanceMi)}
            </span>
          )}
          {badge && (
            <span style={{ marginLeft: '0.5rem' }}>
              <DayBadgeChip badge={badge} />
            </span>
          )}
          {isSynced && (
            <span style={{
              marginLeft: '0.5rem',
              fontSize: '0.75rem',
              background: syncMeta?.crossTraining ? 'var(--apollo-teal-dim)' : 'var(--apollo-gold-dim)',
              color: syncMeta?.crossTraining ? 'var(--apollo-teal)' : 'var(--apollo-gold)',
              padding: '0.12rem 0.5rem',
              borderRadius: 'var(--radius-full)',
              fontWeight: 600,
              fontFamily: 'var(--font-display)',
            }}>
              {syncMeta?.crossTraining ? (
                <>
                  <span aria-hidden="true">{categoryIcon(syncMeta.crossTraining.category)} </span>
                  {syncMeta.crossTraining.label}
                </>
              ) : 'Synced'}
            </span>
          )}
          {syncMeta && !syncMeta.crossTraining && (() => {
            const rec = getEffortRecognition(syncMeta.activityId);
            if (!rec?.paceTier) return null;
            const tc = TIER_CONFIG[rec.paceTier];
            return (
              <span style={{
                marginLeft: '0.35rem', fontSize: '0.75rem',
                background: tc.bg, color: tc.color,
                padding: '0.1rem 0.45rem', borderRadius: 'var(--radius-full)',
                fontWeight: 600, fontFamily: 'var(--font-display)',
              }}>{tc.label}</span>
            );
          })()}
        </td>
        <td style={{ padding: '0.5rem' }}>
          {isToday ? <span style={{ color: 'var(--apollo-gold)', fontWeight: 600, fontFamily: 'var(--font-display)', fontSize: 'var(--text-sm)' }}>Today</span> : null}
        </td>
        <td style={{ padding: '0.25rem 0.5rem', textAlign: 'right' }}>
          <DayActionsMenu plan={plan} weekIndex={weekIndex} dayIndex={dayIndex} dayLabel={dayLabel} onChanged={onChanged} />
        </td>
      </tr>
      {isSynced && syncMeta && (
        <tr style={{ background: isToday ? 'rgba(212,165,55,0.05)' : 'rgba(212,165,55,0.02)' }}>
          <td colSpan={6} style={{ padding: '0.25rem 0.5rem 0.5rem 2.75rem' }}>
            <div style={{
              fontSize: '0.82rem',
              color: 'var(--text-secondary)',
              display: 'flex',
              gap: '1rem',
              flexWrap: 'wrap',
              alignItems: 'center',
            }}>
              {/* Route thumbnail for synced activity (any sport with GPS) */}
              {(() => {
                const matched = findSyncedActivity(syncMeta);
                if (matched?.map?.summary_polyline) {
                  return <RouteMapThumbnail activity={matched} />;
                }
                return null;
              })()}
              {syncMeta.crossTraining ? (
                crossTrainingStats(syncMeta).map((s, i) => (
                  <span key={i} style={i === 0 ? { color: 'var(--apollo-teal)', fontWeight: 600, fontFamily: 'var(--font-display)' } : undefined}>{s}</span>
                ))
              ) : (
                <>
                  <span style={{ color: 'var(--apollo-gold)', fontWeight: 600, fontFamily: 'var(--font-display)' }}>
                    {formatMiles(syncMeta.actualDistanceMi)}
                  </span>
                  <span>{formatPaceFromMinPerMi(syncMeta.actualPaceMinPerMi)} pace</span>
                  <span>{Math.floor(syncMeta.movingTimeSec / 60)}m {syncMeta.movingTimeSec % 60}s</span>
                </>
              )}
            </div>
            <div style={{
              fontSize: '0.82rem',
              color: 'var(--text)',
              marginTop: '0.25rem',
              lineHeight: 1.4,
              fontStyle: 'italic',
            }}>
              {syncMeta.feedback}
            </div>
          </td>
        </tr>
      )}
    </>
  );
});

export default function Training() {
  const [searchParams, setSearchParams] = useSearchParams();
  const viewMode: TrainingViewMode = searchParams.get('view') === 'checklist' ? 'checklist' : 'calendar';
  const [active, setActiveState] = useState<ActivePlan | null>(() => getActivePlan());
  /** Bumped whenever completions, the overlay or sync matches change, so derived views re-read them. */
  const [version, setVersion] = useState(0);
  const [chooserOpen, setChooserOpen] = useState(false);
  const [chooserPlanId, setChooserPlanId] = useState<string | null>(null);
  const [showBuilder, setShowBuilder] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  const [announcement, setAnnouncement] = useState<string | null>(null);
  const [expandedWeek, setExpandedWeek] = useState<number | null>(() => {
    const a = getActivePlan();
    const p = a ? getEffectivePlan() : null;
    if (!a || !p) return null;
    return getWeekDayForDate(a.startDate, p.weeks.length, getTodayKey())?.weekIndex ?? a.joinedWeekIndex ?? 0;
  });
  const [syncing, setSyncing] = useState(false);
  const [syncResults, setSyncResults] = useState<SyncResult[]>([]);
  const [syncSummary, setSyncSummary] = useState<SyncSummary | null>(null);
  const [syncWasManual, setSyncWasManual] = useState(false);
  const [syncProgress, setSyncProgress] = useState<string | null>(null);
  const [lastSync, setLastSync] = useState<string | null>(() => getLastActivitySyncTime());
  const isMountedRef = useRef(true);
  const autoSyncedPlanRef = useRef<string | null>(null);

  // The effective plan: placed on the race date, with the athlete's moves/skips applied (cached, read-only).
  const plan = active ? getEffectivePlan() : null;
  const activePlanKey = active ? `${active.planId}:${active.startDate}` : null;
  const todayKey = getTodayKey();
  const connected = isActivitySourceConnected();
  const sourceName = getActiveSourceName();
  const raceDate = active ? getRaceDate() : null;
  const todayPos = active && plan ? getWeekDayForDate(active.startDate, plan.weeks.length, todayKey) : null;

  const refresh = useCallback(() => {
    setActiveState(getActivePlan());
    setVersion((v) => v + 1);
  }, []);

  const announce = useCallback((message: string) => {
    setAnnouncement(message);
  }, []);

  useEffect(() => {
    if (!announcement) return;
    const t = setTimeout(() => setAnnouncement(null), 6000);
    return () => clearTimeout(t);
  }, [announcement]);

  const setViewMode = useCallback((mode: TrainingViewMode) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (mode === 'calendar') next.delete('view');
      else next.set('view', mode);
      return next;
    }, { replace: true });
  }, [setSearchParams]);

  const handleSync = useCallback(async (manual: boolean) => {
    lastTrainingSyncAt = Date.now();
    setSyncing(true);
    setSyncProgress(null);
    try {
      // Imports new activities from every connected source, then matches plan days. Never throws for network errors.
      const report = await runSync({
        onProgress: (p) => { if (isMountedRef.current) setSyncProgress(p.message); },
      });
      if (!isMountedRef.current) return;
      setSyncResults(report.results);
      setSyncSummary(report.summary);
      setSyncWasManual(manual);
      setLastSync(getLastActivitySyncTime());
      refresh();
    } catch {
      // unexpected failure — user can retry
    } finally {
      if (isMountedRef.current) {
        setSyncing(false);
        setSyncProgress(null);
      }
    }
  }, [refresh]);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    setActiveState(getActivePlan());
    if (!connected) {
      autoSyncedPlanRef.current = null;
      return;
    }
    // Auto-sync on mount if a data source is connected and a plan is active
    if (activePlanKey && autoSyncedPlanRef.current !== activePlanKey) {
      autoSyncedPlanRef.current = activePlanKey;
      if (activitiesSyncedRecently()) {
        // Synced recently, or a sync is running (its matches arrive via onPlanRefreshed):
        // re-match the stored activities offline instead of hitting the network on every visit.
        refreshPlanFromStoredActivities();
        setVersion((v) => v + 1);
      } else {
        handleSync(false);
      }
    }
  }, [connected, activePlanKey, handleSync]);

  // Plan days were re-matched (a sync anywhere, a file import or an offline re-match): re-read completed days,
  // sync feedback, weekly mileage and the last-synced time. Results of a sync started here are left as they are.
  useEffect(() => onPlanRefreshed(() => {
    setLastSync(getLastActivitySyncTime());
    refresh();
  }), [refresh]);

  // Overlay edits (move/skip/convert/undo, also from Today or the adaptive engine), plan start/stop and completion toggles.
  useEffect(() => onPlanOverlayChanged(refresh), [refresh]);
  useEffect(() => onPlanEvent(PLAN_PROGRESS_CHANGED_EVENT, refresh), [refresh]);

  const handleStarted = useCallback((next: ActivePlan) => {
    // A connected source matches via the effect above (syncing first unless it synced recently); otherwise match activities already on this device.
    if (!isActivitySourceConnected() && hasActivityData()) refreshPlanFromStoredActivities();
    // New plan, race date or start date: refresh the intervals.icu calendar (no-op unless auto-update is on; never throws).
    void syncPlanCalendarIfChanged();
    setChooserOpen(false);
    setChooserPlanId(null);
    setShowBuilder(false);
    refresh();
    const p = getEffectivePlan();
    setExpandedWeek(p ? getWeekDayForDate(next.startDate, p.weeks.length, getTodayKey())?.weekIndex ?? next.joinedWeekIndex ?? 0 : 0);
    if (p) announce(`${p.name} is your active plan.`);
  }, [refresh, announce]);

  const handleStopPlan = () => {
    setConfirmStop(false);
    setActivePlan(null);
    setChooserOpen(false);
    setChooserPlanId(null);
    refresh();
    announce('You stopped following the plan. Your completed days are kept.');
  };

  const handleCustomPlanSaved = (custom: TrainingPlan) => {
    setCustomPlan(custom);
    setShowBuilder(false);
    if (active?.planId === CUSTOM_PLAN_ID) {
      // Saved over the active custom plan: its workouts changed in place.
      refresh();
      announce('Your custom plan was updated.');
    } else {
      // Preselect it in the chooser so starting it is one click away.
      setChooserPlanId(CUSTOM_PLAN_ID);
      setChooserOpen(true);
    }
    // Saving over the active custom plan changes its workouts — keep the intervals.icu calendar current.
    void syncPlanCalendarIfChanged();
  };

  const handleToggleDay = useCallback((weekIndex: number, dayIndex: number) => {
    const a = getActivePlan();
    if (!a) return;
    toggleDayCompleted(a.planId, weekIndex, dayIndex);
    refresh();
  }, [refresh]);

  const badges = useMemo(
    () => getDayBadges(plan),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [plan, version],
  );
  const getBadge = useCallback((w: number, d: number) => badges.get(`${w}:${d}`) ?? null, [badges]);
  const renderDayActions = useCallback(
    (ref: CalendarDayRef) =>
      plan ? (
        <DayActionsMenu plan={plan} weekIndex={ref.weekIndex} dayIndex={ref.dayIndex} dayLabel={formatDayLabel(ref.dateKey)} onChanged={announce} />
      ) : null,
    [plan, announce],
  );

  // Rendered in both branches — "+ Build a custom plan" in the chooser opens it.
  const builderCard = showBuilder && (
    <div className="card">
      <PlanBuilder onComplete={handleCustomPlanSaved} onCancel={() => setShowBuilder(false)} />
    </div>
  );

  const progress = active && plan ? planProgress(plan, active.planId, active.joinedWeekIndex ?? 0) : null;

  return (
    <div>
      <h1 className="page-title">Training Plan</h1>

      <div role="status" aria-live="polite" className={announcement ? 'plan-toast' : 'plan-live'}>
        {announcement}
      </div>

      {!active || !plan ? (
        <>
          {active && !plan && (
            <div className="card" role="alert">
              <p style={{ margin: 0 }}>Your active plan could not be found. Choose a plan below to continue.</p>
            </div>
          )}
          <PlanChooser
            key={chooserPlanId ?? 'none'}
            mode="start"
            activePlanId={null}
            initialPlanId={chooserPlanId}
            onStarted={handleStarted}
            onBuildCustom={() => setShowBuilder(true)}
          />
          {builderCard}
          <p className="plan-setup-muted">
            Racing soon? The <Link to="/race">Race Day hub</Link> has pacing plans plus race-week and race-morning checklists.
          </p>
        </>
      ) : (
        <>
          {/* Plan header card */}
          <section className="card" aria-labelledby="plan-header-title" style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1rem',
            background: 'linear-gradient(135deg, rgba(212,165,55,0.06) 0%, var(--bg-card) 100%)',
            position: 'relative', overflow: 'hidden',
          }}>
            <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 2, background: 'linear-gradient(90deg, transparent, var(--apollo-gold-dark), var(--apollo-gold), var(--apollo-gold-dark), transparent)' }} />
            <div style={{ flex: '1 1 16rem' }}>
              <h2 id="plan-header-title" style={{ margin: 0, fontFamily: 'var(--font-display)', fontSize: 'var(--text-lg)' }}>{plan.name}</h2>
              <p style={{ color: 'var(--text-secondary)', margin: '0.25rem 0 0', fontSize: 'var(--text-sm)' }}>
                by {plan.author} · Week 1 began {formatMediumDate(active.startDate)}
                {raceDate ? ` · Race day ${formatMediumDate(raceDate)}` : ''}
                {todayPos ? ` · Week ${todayPos.weekIndex + 1} of ${plan.weeks.length}` : ''}
              </p>
              {progress && (
                <div style={{ marginTop: '0.5rem' }}>
                  <div
                    className="plan-progress"
                    role="progressbar"
                    aria-label="Workouts completed"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={progress.pct}
                    aria-valuetext={`${progress.completed} of ${progress.total} workouts done (${progress.pct}%)`}
                  >
                    <span className="plan-progress-fill" style={{ width: `${progress.pct}%` }} />
                  </div>
                  <p style={{ margin: '0.25rem 0 0', fontSize: 'var(--text-sm)', color: 'var(--apollo-gold)', fontWeight: 600 }}>
                    {progress.completed} / {progress.total} workouts · {progress.pct}%
                  </p>
                </div>
              )}
            </div>
            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
              <button
                type="button"
                className="btn btn-secondary"
                aria-expanded={chooserOpen}
                onClick={() => { setChooserPlanId(null); setChooserOpen((o) => !o); }}
              >
                Change plan or race date
              </button>
              <button type="button" className="btn btn-ghost" onClick={() => setConfirmStop(true)}>Stop plan</button>
              <Link to="/race" className="btn btn-ghost">Race Day hub</Link>
            </div>
          </section>

          {chooserOpen && (
            <PlanChooser
              key={chooserPlanId ?? 'none'}
              mode="switch"
              activePlanId={active.planId}
              initialPlanId={chooserPlanId}
              onStarted={handleStarted}
              onCancel={() => { setChooserOpen(false); setChooserPlanId(null); }}
              onBuildCustom={() => { setChooserOpen(false); setShowBuilder(true); }}
            />
          )}

          {builderCard}

          <PhaseRibbon plan={plan} currentWeekIndex={todayPos?.weekIndex ?? null} />

          {/* View toggle (kept in the URL: ?view=checklist) */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
            <div className="cal-view-toggle" role="group" aria-label="Plan view">
              <button
                type="button"
                className={`cal-view-toggle-btn ${viewMode === 'calendar' ? 'cal-view-toggle-btn--active' : ''}`}
                aria-pressed={viewMode === 'calendar'}
                onClick={() => setViewMode('calendar')}
              >
                <span aria-hidden="true">📅 </span>Calendar
              </button>
              <button
                type="button"
                className={`cal-view-toggle-btn ${viewMode === 'checklist' ? 'cal-view-toggle-btn--active' : ''}`}
                aria-pressed={viewMode === 'checklist'}
                onClick={() => setViewMode('checklist')}
              >
                <span aria-hidden="true">☰ </span>Checklist
              </button>
            </div>
          </div>

          {/* Calendar view */}
          {viewMode === 'calendar' && (
            <div className="card">
              <CalendarView
                plan={plan}
                active={active}
                version={version}
                onToggleDay={handleToggleDay}
                renderDayActions={renderDayActions}
                getDayBadge={getBadge}
              />
            </div>
          )}

          {/* Week-by-week checklist */}
          {viewMode === 'checklist' && (
            <section className="card" aria-labelledby="plan-checklist-title">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
                <h2 id="plan-checklist-title" style={{ margin: 0, fontSize: 'var(--text-lg)' }}>Week-by-week checklist</h2>
                <span style={{ fontSize: '0.75rem', fontFamily: 'var(--font-display)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)' }}>
                  {plan.weeks.length} weeks
                </span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                {plan.weeks.map((week, wi) => {
                  const isExpanded = expandedWeek === wi;
                  const wp = computeWeekProgress(week, wi, (w, d) => isDayCompleted(active.planId, w, d));
                  const weekDone = wp.total > 0 && wp.completed === wp.total;
                  const panelId = `plan-week-panel-${wi}`;
                  const wm = getWeeklyMileageSummary(active.planId, wi);
                  return (
                    <div key={wi} style={{
                      border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', overflow: 'visible',
                      ...(isExpanded ? { borderColor: 'var(--border-strong)' } : {}),
                    }}>
                      <h3 style={{ margin: 0, fontSize: 'var(--text-base)' }}>
                        <button
                          type="button"
                          className="plan-week-toggle"
                          aria-expanded={isExpanded}
                          aria-controls={isExpanded ? panelId : undefined}
                          onClick={() => setExpandedWeek(isExpanded ? null : wi)}
                          style={{ background: isExpanded ? 'var(--bg-hover)' : 'var(--bg)', fontFamily: 'var(--font-display)' }}
                        >
                          <span style={{ minWidth: '5rem', fontWeight: 600 }}>
                            Week {wi + 1}
                            {todayPos?.weekIndex === wi ? <span style={{ color: 'var(--apollo-gold)' }}> · this week</span> : null}
                          </span>
                          {wm && wm.actualMi > 0 ? (
                            <span style={{ flex: 1, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                              <span aria-hidden="true" style={{ flex: 1, height: 6, borderRadius: 3, background: 'rgba(255,255,255,0.06)', overflow: 'hidden' }}>
                                <span style={{
                                  display: 'block', height: '100%',
                                  width: `${wm.plannedMi > 0 ? Math.min((wm.actualMi / wm.plannedMi) * 100, 100) : 0}%`,
                                  borderRadius: 3,
                                  background: wm.status === 'on_track' || wm.status === 'ahead'
                                    ? 'linear-gradient(90deg, var(--apollo-gold-dark), var(--apollo-gold))'
                                    : wm.status === 'behind' ? 'var(--color-warning)' : 'var(--color-error)',
                                }} />
                              </span>
                              <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                                {formatMiles(wm.actualMi)} of {formatMiles(wm.plannedMi)}
                              </span>
                            </span>
                          ) : (
                            <span style={{ flex: 1 }} />
                          )}
                          <span style={{
                            fontSize: '0.78rem', color: weekDone ? 'var(--color-success)' : 'var(--text-muted)',
                            whiteSpace: 'nowrap', fontWeight: weekDone ? 600 : 400,
                          }}>
                            {weekDone ? '✓ Complete' : `${wp.completed}/${wp.total} workouts`}
                          </span>
                          <span aria-hidden="true" style={{ color: 'var(--apollo-gold)', fontSize: '0.8rem', transform: isExpanded ? 'rotate(180deg)' : 'rotate(0)' }}>▾</span>
                        </button>
                      </h3>
                      {isExpanded && (
                        <div id={panelId} style={{ padding: '0 1rem 1rem' }}>
                          <div className="plan-table-wrap">
                            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--text-sm)' }}>
                              <caption className="plan-live">Week {wi + 1} workouts</caption>
                              <thead>
                                <tr style={{ borderBottom: '1px solid var(--border)' }}>
                                  <th scope="col" style={{ textAlign: 'left', padding: '0.5rem', width: 36 }}><span className="plan-live">Done</span></th>
                                  <th scope="col" style={{ textAlign: 'left', padding: '0.5rem', fontSize: 'var(--text-xs)', textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)', fontWeight: 500 }}>Day</th>
                                  <th scope="col" style={{ textAlign: 'left', padding: '0.5rem', fontSize: 'var(--text-xs)', textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)', fontWeight: 500 }}>Date</th>
                                  <th scope="col" style={{ textAlign: 'left', padding: '0.5rem', fontSize: 'var(--text-xs)', textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)', fontWeight: 500 }}>Workout</th>
                                  <th scope="col" style={{ textAlign: 'left', padding: '0.5rem', width: 64 }}><span className="plan-live">Status</span></th>
                                  <th scope="col" style={{ textAlign: 'right', padding: '0.5rem', width: 48 }}><span className="plan-live">Actions</span></th>
                                </tr>
                              </thead>
                              <tbody>
                                {week.days.map((day, dayIndex) => {
                                  const dateKey = getDateKeyForDay(active.startDate, wi, dayIndex);
                                  return (
                                    <DayRow
                                      key={dayIndex}
                                      plan={plan}
                                      startDate={active.startDate}
                                      weekIndex={wi}
                                      dayIndex={dayIndex}
                                      day={day}
                                      dateKey={dateKey}
                                      isToday={dateKey === todayKey}
                                      completed={isDayCompleted(active.planId, wi, dayIndex)}
                                      syncMeta={getSyncMeta(active.planId, wi, dayIndex)}
                                      badge={badges.get(`${wi}:${dayIndex}`) ?? null}
                                      onToggle={handleToggleDay}
                                      onChanged={announce}
                                    />
                                  );
                                })}
                              </tbody>
                            </table>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {/* Export: send the plan to the watch via intervals.icu, or download an .ics calendar */}
          <section aria-labelledby="plan-export-title">
            <h2 id="plan-export-title" className="plan-section-title">Export</h2>
            <div className="plan-export">
              <PlanCalendarPush />
              <PlanCalendarExport headingLevel={3} />
            </div>
          </section>
        </>
      )}

      {/* Smart Auto-Sync Card */}
      <section className="card" aria-labelledby="plan-sync-title" style={{
        background: 'linear-gradient(135deg, rgba(91,181,181,0.06) 0%, var(--bg-card) 100%)',
        borderColor: connected ? 'var(--apollo-teal-dark)' : 'var(--border)',
        borderLeftWidth: 3, borderLeftStyle: 'solid',
        borderLeftColor: connected ? 'var(--apollo-teal)' : 'var(--border)',
      }}>
        <h2 id="plan-sync-title" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap', fontSize: 'var(--text-lg)' }}>
          <span style={{ color: 'var(--apollo-teal)' }}>Smart Auto-Sync</span>
          {connected && (
            <span style={{
              fontSize: '0.75rem', background: 'var(--apollo-teal-dim)',
              color: 'var(--apollo-teal)', padding: '0.15rem 0.6rem',
              borderRadius: 'var(--radius-full)', fontWeight: 600,
              fontFamily: 'var(--font-display)',
            }}>Active · {sourceName}</span>
          )}
        </h2>
        {!connected ? (
          <p style={{ color: 'var(--text-secondary)', margin: 0, fontSize: 'var(--text-sm)', lineHeight: 1.5 }}>
            <Link to="/settings?tab=connections" style={{ fontWeight: 600 }}>Connect a data source</Link> (intervals.icu or Strava) to automatically
            match your runs and cross-training to the training plan.
          </p>
        ) : (
          <div>
            <p style={{ color: 'var(--text-secondary)', margin: '0 0 0.75rem', fontSize: 'var(--text-sm)', lineHeight: 1.5 }}>
              Activities from {sourceName} are automatically matched to plan days — runs by distance and pace,
              rides, swims and strength sessions on cross-training days. Weekly mileage is analyzed after every sync.
              {lastSync && (
                <span style={{ marginLeft: '0.5rem', color: 'var(--text-muted)' }}>
                  Last synced: {formatLastSynced(lastSync)}
                </span>
              )}
            </p>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => handleSync(true)}
                disabled={syncing}
                style={{ fontSize: 'var(--text-sm)' }}
              >
                {syncing ? 'Syncing…' : 'Sync activities'}
              </button>
              <span role="status" style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>{syncing ? syncProgress : null}</span>
            </div>
            {!syncing && syncSummary && (syncWasManual || syncSummary.added > 0 || syncSummary.errors.length > 0 || syncResults.length > 0) && (
              <div style={{ marginTop: '0.6rem', fontSize: 'var(--text-sm)', lineHeight: 1.5 }}>
                <div style={{ color: 'var(--text-secondary)' }}>
                  {[
                    syncSummary.added > 0
                      ? `${syncSummary.added} new activit${syncSummary.added === 1 ? 'y' : 'ies'} imported`
                      : 'No new activities',
                    syncSummary.updated > 0 ? `${syncSummary.updated} updated` : null,
                    syncResults.length > 0 ? `${syncResults.length} plan day${syncResults.length === 1 ? '' : 's'} updated` : null,
                  ].filter(Boolean).join(' · ')}
                </div>
                {syncSummary.errors.map((e, i) => (
                  <div key={i} role="alert" style={{ color: 'var(--color-error)', marginTop: '0.2rem' }}>
                    <span aria-hidden="true">⚠ </span>{getSourceDisplayName(e.source)}: {e.message}
                  </div>
                ))}
              </div>
            )}
            {syncResults.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', marginTop: '0.75rem' }}>
                {syncResults.map((r, i) => (
                  <div
                    key={i}
                    style={{
                      background: r.isCrossTraining ? 'var(--apollo-teal-dim)' : 'var(--apollo-gold-dim)',
                      borderRadius: 'var(--radius-sm)',
                      padding: '0.65rem 1rem',
                      fontSize: 'var(--text-sm)',
                      lineHeight: 1.5,
                    }}
                  >
                    <div style={{ fontWeight: 600, color: r.isCrossTraining ? 'var(--apollo-teal)' : 'var(--apollo-gold)', marginBottom: '0.15rem', fontFamily: 'var(--font-display)' }}>
                      {r.isNew ? 'Auto-completed' : 'Updated'}: Week {r.weekIndex + 1},{' '}
                      {active ? formatDayLabel(getDateKeyForDay(active.startDate, r.weekIndex, r.dayIndex)) : `day ${r.dayIndex + 1}`} — {dayTitle(r.plannedDay)}
                      {r.isCrossTraining && (
                        <>
                          {' · '}
                          <span aria-hidden="true">{getSportIcon(r.activity)} </span>
                          {getSportLabel(r.activity)}
                        </>
                      )}
                    </div>
                    <div style={{ color: 'var(--text-secondary)' }}>{r.feedback}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </section>

      <ConfirmDialog
        open={confirmStop}
        title="Stop following this plan?"
        message="Your completed days are kept, and you can start a plan again at any time."
        confirmLabel="Stop plan"
        cancelLabel="Keep plan"
        onConfirm={handleStopPlan}
        onCancel={() => setConfirmStop(false)}
      />
    </div>
  );
}
