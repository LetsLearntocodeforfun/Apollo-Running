import { useState, useEffect, useCallback, useRef, memo } from 'react';
import { BUILT_IN_PLANS, getPlanById, type PlanDay } from '../data/plans';
import {
  getActivePlan,
  setActivePlan,
  isDayCompleted,
  toggleDayCompleted,
  getDateForDay,
  getCompletedCount,
  formatDateKey,
  getSyncMeta,
  getLastSyncTime,
  type ActivePlan,
  type SyncMeta,
} from '../services/planProgress';
import { getStravaTokens } from '../services/storage';
import { runAutoSync, getWeeklyMileageSummary, type SyncResult } from '../services/autoSync';
import { RouteMapThumbnail } from '../components/RouteMap';
import { getStoredActivities } from '../services/analyticsService';
import { getEffortRecognition } from '../services/effortService';
import { TIER_CONFIG } from '../components/TierBadge';
import { formatMiles, formatPaceFromMinPerMi } from '../services/unitPreferences';
import CalendarView from '../components/CalendarView';

type TrainingViewMode = 'calendar' | 'checklist';

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** Single day row in the training plan checklist. Memoized to avoid re-renders on sibling changes. */
const DayRow = memo(function DayRow({
  dayIndex,
  day,
  date,
  isToday,
  completed,
  syncMeta,
  onToggle,
}: {
  dayIndex: number;
  day: PlanDay;
  date: Date;
  isToday: boolean;
  completed: boolean;
  syncMeta: SyncMeta | null;
  onToggle: () => void;
}) {
  const dateStr = formatDateKey(date);
  const isSynced = !!syncMeta;
  return (
    <>
      <tr style={{ background: isToday ? 'rgba(212,165,55,0.08)' : isSynced ? 'rgba(212,165,55,0.03)' : undefined, transition: 'background 0.2s' }}>
        <td style={{ padding: '0.5rem', width: 36 }}>
          {(day.type === 'run' || day.type === 'cross' || day.type === 'race' || day.type === 'marathon') ? (
            <input
              type="checkbox"
              checked={completed}
              onChange={() => onToggle()}
              aria-label={`Mark ${day.label} complete`}
              style={{ accentColor: 'var(--apollo-gold)', width: 16, height: 16 }}
            />
          ) : (
            <span style={{ color: 'var(--text-muted)' }}>—</span>
          )}
        </td>
        <td style={{ padding: '0.5rem', color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>{DAY_NAMES[dayIndex]}</td>
        <td style={{ padding: '0.5rem', fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>{dateStr}</td>
        <td style={{ padding: '0.5rem' }}>
          <span className={`day-type-${day.type}`} style={{ fontFamily: 'var(--font-display)', fontWeight: completed ? 600 : 400 }}>{day.label}</span>
          {day.distanceMi != null && (
            <span style={{ color: 'var(--text-muted)', marginLeft: '0.5rem', fontSize: 'var(--text-sm)' }}>
              {formatMiles(day.distanceMi)}
            </span>
          )}
          {isSynced && (
            <span style={{
              marginLeft: '0.5rem',
              fontSize: '0.72rem',
              background: 'var(--apollo-gold-dim)',
              color: 'var(--apollo-gold)',
              padding: '0.12rem 0.5rem',
              borderRadius: 'var(--radius-full)',
              fontWeight: 600,
              fontFamily: 'var(--font-display)',
            }}>
              Synced
            </span>
          )}
          {isSynced && syncMeta?.stravaActivityId && (() => {
            const rec = getEffortRecognition(syncMeta.stravaActivityId);
            if (!rec?.paceTier) return null;
            const tc = TIER_CONFIG[rec.paceTier];
            return (
              <span style={{
                marginLeft: '0.35rem', fontSize: '0.68rem',
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
      </tr>
      {isSynced && syncMeta && (
        <tr style={{ background: isToday ? 'rgba(212,165,55,0.05)' : 'rgba(212,165,55,0.02)' }}>
          <td colSpan={5} style={{ padding: '0.25rem 0.5rem 0.5rem 2.75rem' }}>
            <div style={{
              fontSize: '0.82rem',
              color: 'var(--text-secondary)',
              display: 'flex',
              gap: '1rem',
              flexWrap: 'wrap',
              alignItems: 'center',
            }}>
              {/* Route thumbnail for synced activity */}
              {syncMeta.stravaActivityId && (() => {
                const stored = getStoredActivities();
                const matched = stored.find(a => a.id === syncMeta.stravaActivityId);
                if (matched?.map?.summary_polyline) {
                  return <RouteMapThumbnail activity={matched} />;
                }
                return null;
              })()}
              <span style={{ color: 'var(--apollo-gold)', fontWeight: 600, fontFamily: 'var(--font-display)' }}>
                {formatMiles(syncMeta.actualDistanceMi)}
              </span>
              <span>{formatPaceFromMinPerMi(syncMeta.actualPaceMinPerMi)} pace</span>
              <span>{Math.floor(syncMeta.movingTimeSec / 60)}m {syncMeta.movingTimeSec % 60}s</span>
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
  const [active, setActiveState] = useState<ActivePlan | null>(() => getActivePlan());
  const [selectedPlanId, setSelectedPlanId] = useState<string | null>(active?.planId ?? null);
  const [startDate, setStartDate] = useState(active?.startDate ?? formatDateKey(new Date()));
  const [expandedWeek, setExpandedWeek] = useState<number | null>(() => (getActivePlan() ? 0 : null));
  const [showPicker, setShowPicker] = useState(!active);
  const [viewMode, setViewMode] = useState<TrainingViewMode>('calendar');
  const [syncing, setSyncing] = useState(false);
  const [syncResults, setSyncResults] = useState<SyncResult[]>([]);
  const [lastSync, setLastSync] = useState<string | null>(() => getLastSyncTime());
  const [, forceUpdate] = useState(0);
  const isMountedRef = useRef(true);
  const autoSyncedPlanRef = useRef<string | null>(null);

  const plan = selectedPlanId ? getPlanById(selectedPlanId) : null;
  const activePlanKey = active ? `${active.planId}:${active.startDate}` : null;
  const today = new Date();
  const todayKey = formatDateKey(today);
  const stravaConnected = !!getStravaTokens();

  const handleSync = useCallback(async () => {
    setSyncing(true);
    try {
      const results = await runAutoSync();
      if (!isMountedRef.current) return;
      setSyncResults(results);
      setLastSync(getLastSyncTime());
      setActiveState(getActivePlan());
      forceUpdate((n) => n + 1);
    } catch {
      // silent fail — user can retry
    } finally {
      if (isMountedRef.current) setSyncing(false);
    }
  }, []);

  useEffect(() => {
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    setActiveState(getActivePlan());
    if (!stravaConnected) {
      autoSyncedPlanRef.current = null;
      return;
    }
    // Auto-sync on mount if Strava is connected and a plan is active
    if (activePlanKey && autoSyncedPlanRef.current !== activePlanKey) {
      autoSyncedPlanRef.current = activePlanKey;
      handleSync();
    }
  }, [stravaConnected, activePlanKey, handleSync]);

  const handleStartPlan = () => {
    if (!selectedPlanId || !plan) return;
    setActivePlan({ planId: selectedPlanId, startDate });
    setActiveState(getActivePlan());
    setShowPicker(false);
    setExpandedWeek(0);
  };

  const handleClearPlan = () => {
    setActivePlan(null);
    setActiveState(null);
    setSelectedPlanId(null);
    setShowPicker(true);
  };

  return (
    <div>
      <h1 className="page-title">Training Plan</h1>

      {!active ? (
        <>
          <div className="card" style={{
            textAlign: 'center', padding: '2rem',
            background: 'linear-gradient(135deg, rgba(212,165,55,0.06) 0%, var(--bg-card) 100%)',
          }}>
            <div style={{ fontSize: '0.72rem', fontFamily: 'var(--font-display)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--apollo-gold)', marginBottom: '0.75rem' }}>
              Choose Your Path
            </div>
            <h3 style={{ fontSize: 'var(--text-lg)', margin: '0 0 0.5rem' }}>Select a Training Plan</h3>
            <p style={{ color: 'var(--text-secondary)', marginBottom: '1.5rem', fontSize: 'var(--text-sm)' }}>
              Pick a proven marathon plan, set your start date, and let the journey begin.
            </p>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '1rem', textAlign: 'left' }}>
              {BUILT_IN_PLANS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className="plan-card"
                  onClick={() => setSelectedPlanId(p.id)}
                  style={{
                    border: selectedPlanId === p.id ? '2px solid var(--apollo-gold)' : '1px solid var(--border)',
                    textAlign: 'left',
                    padding: '1.25rem',
                    borderRadius: 'var(--radius-lg)',
                    background: selectedPlanId === p.id ? 'var(--apollo-gold-dim)' : 'var(--bg)',
                    color: 'var(--text)',
                    cursor: 'pointer',
                    transition: 'all var(--transition-base)',
                  }}
                >
                  <div style={{ fontFamily: 'var(--font-display)', fontWeight: 600, marginBottom: '0.25rem' }}>{p.name}</div>
                  <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', marginBottom: '0.5rem' }}>{p.author}</div>
                  <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', lineHeight: 1.5 }}>{p.description}</div>
                </button>
              ))}
            </div>
          </div>

          {plan && (
            <div className="card" style={{ borderColor: 'var(--apollo-gold)', borderLeftWidth: 3, borderLeftStyle: 'solid' }}>
              <h3 style={{ color: 'var(--apollo-gold)' }}>Start Your Plan</h3>
              <p style={{ color: 'var(--text-secondary)', marginBottom: '1rem', fontSize: 'var(--text-sm)' }}>
                <strong>{plan.name}</strong> — {plan.totalWeeks} weeks. Set the date of Week 1, Monday.
              </p>
              <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>Start date</span>
                  <input
                    type="date"
                    value={startDate}
                    onChange={(e) => setStartDate(e.target.value)}
                    style={{ padding: '0.5rem', borderRadius: 'var(--radius-md)', border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)' }}
                  />
                </label>
                <button type="button" className="btn btn-primary" onClick={handleStartPlan}>
                  Begin Training
                </button>
              </div>
            </div>
          )}
        </>
      ) : (
        <>
          {plan && (
            <>
              {/* Plan header card */}
              <div className="card" style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1rem',
                background: 'linear-gradient(135deg, rgba(212,165,55,0.06) 0%, var(--bg-card) 100%)',
                position: 'relative', overflow: 'hidden',
              }}>
                <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 2, background: 'linear-gradient(90deg, transparent, var(--apollo-gold-dark), var(--apollo-gold), var(--apollo-gold-dark), transparent)' }} />
                <div>
                  <h3 style={{ margin: 0, fontFamily: 'var(--font-display)', fontSize: 'var(--text-lg)' }}>{plan.name}</h3>
                  <p style={{ color: 'var(--text-secondary)', margin: '0.25rem 0 0', fontSize: 'var(--text-sm)' }}>
                    by {plan.author} · Started {active.startDate} · <span style={{ color: 'var(--apollo-gold)', fontWeight: 600 }}>{getCompletedCount(plan.id)} / {plan.totalWeeks * 7} days</span>
                  </p>
                </div>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  <button type="button" className="btn btn-secondary" onClick={() => setShowPicker(true)} style={{ fontSize: 'var(--text-sm)' }}>Change</button>
                  <button type="button" className="btn btn-ghost" onClick={handleClearPlan} style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>Clear</button>
                </div>
              </div>

              {/* View toggle */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
                <div className="cal-view-toggle">
                  <button
                    type="button"
                    className={`cal-view-toggle-btn ${viewMode === 'calendar' ? 'cal-view-toggle-btn--active' : ''}`}
                    onClick={() => setViewMode('calendar')}
                  >
                    📅 Calendar
                  </button>
                  <button
                    type="button"
                    className={`cal-view-toggle-btn ${viewMode === 'checklist' ? 'cal-view-toggle-btn--active' : ''}`}
                    onClick={() => setViewMode('checklist')}
                  >
                    ☰ Checklist
                  </button>
                </div>
              </div>

              {showPicker && (
                <div className="card">
                  <h3>Switch Plan</h3>
                  <p style={{ color: 'var(--text-secondary)', marginBottom: '1rem', fontSize: 'var(--text-sm)' }}>Starting a new plan keeps your completed days for the previous plan.</p>
                  <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                    {BUILT_IN_PLANS.map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        className="btn btn-secondary"
                        onClick={() => { setSelectedPlanId(p.id); setStartDate(formatDateKey(new Date())); }}
                        style={{ fontSize: 'var(--text-sm)' }}
                      >
                        {p.name}
                      </button>
                    ))}
                  </div>
                  <div style={{ marginTop: '1rem', display: 'flex', gap: '0.5rem' }}>
                    {plan && (
                      <>
                        <input
                          type="date"
                          value={startDate}
                          onChange={(e) => setStartDate(e.target.value)}
                          style={{ padding: '0.5rem', borderRadius: 'var(--radius-md)', border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)' }}
                        />
                        <button type="button" className="btn btn-primary" onClick={handleStartPlan} style={{ fontSize: 'var(--text-sm)' }}>Switch & Start</button>
                      </>
                    )}
                    <button type="button" className="btn btn-ghost" onClick={() => setShowPicker(false)} style={{ fontSize: 'var(--text-sm)' }}>Cancel</button>
                  </div>
                </div>
              )}

              {/* Calendar view */}
              {viewMode === 'calendar' && (
                <div className="card">
                  <CalendarView
                    plan={plan}
                    active={active}
                    onToggleDay={(weekIndex, dayIndex) => {
                      toggleDayCompleted(plan.id, weekIndex, dayIndex);
                      setActiveState(getActivePlan());
                      forceUpdate((n) => n + 1);
                    }}
                  />
                </div>
              )}

              {/* Week-by-week checklist */}
              {viewMode === 'checklist' && <div className="card">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
                  <h3 style={{ margin: 0 }}>Week-by-Week Checklist</h3>
                  <span style={{ fontSize: '0.72rem', fontFamily: 'var(--font-display)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)' }}>
                    {plan.totalWeeks} Weeks
                  </span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                  {plan.weeks.map((week) => {
                    const isExpanded = expandedWeek === week.weekNumber - 1;
                    const completedInWeek = week.days.filter((_, di) => isDayCompleted(plan.id, week.weekNumber - 1, di)).length;
                    return (
                      <div key={week.weekNumber} style={{
                        border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', overflow: 'hidden',
                        transition: 'border-color var(--transition-base)',
                        ...(isExpanded ? { borderColor: 'var(--border-strong)' } : {}),
                      }}>
                        <button
                          type="button"
                          onClick={() => setExpandedWeek(expandedWeek === week.weekNumber - 1 ? null : week.weekNumber - 1)}
                          style={{
                            width: '100%',
                            padding: '0.85rem 1rem',
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center',
                            background: isExpanded ? 'var(--bg-hover)' : 'var(--bg)',
                            border: 'none',
                            color: 'var(--text)',
                            cursor: 'pointer',
                            fontSize: 'var(--text-base)',
                            fontFamily: 'var(--font-display)',
                            fontWeight: 500,
                            gap: '0.5rem',
                            transition: 'background var(--transition-fast)',
                          }}
                        >
                          <span style={{ minWidth: '5rem', fontWeight: 600 }}>Week {week.weekNumber}</span>
                          {(() => {
                            const wm = getWeeklyMileageSummary(plan.id, week.weekNumber - 1);
                            if (!wm || wm.actualMi === 0) return null;
                            const pct = wm.plannedMi > 0 ? Math.min((wm.actualMi / wm.plannedMi) * 100, 100) : 0;
                            const barColor = wm.status === 'on_track' || wm.status === 'ahead'
                              ? 'linear-gradient(90deg, var(--apollo-gold-dark), var(--apollo-gold))'
                              : wm.status === 'behind' ? 'var(--color-warning)' : 'var(--color-error)';
                            return (
                              <span style={{ flex: 1, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                <span style={{
                                  flex: 1, height: 6, borderRadius: 3,
                                  background: 'rgba(255,255,255,0.06)', overflow: 'hidden',
                                }}>
                                  <span style={{
                                    display: 'block', height: '100%', width: `${pct}%`,
                                    borderRadius: 3, background: barColor,
                                    transition: 'width 0.4s ease',
                                  }} />
                                </span>
                                <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                                  {formatMiles(wm.actualMi)}/{formatMiles(wm.plannedMi)}
                                </span>
                              </span>
                            );
                          })()}
                          <span style={{
                            fontSize: '0.78rem', color: completedInWeek === 7 ? 'var(--color-success)' : 'var(--text-muted)',
                            whiteSpace: 'nowrap', fontWeight: completedInWeek === 7 ? 600 : 400,
                          }}>
                            {completedInWeek === 7 ? '✓ Complete' : `${completedInWeek}/7`}
                          </span>
                          <span style={{ color: 'var(--apollo-gold)', fontSize: '0.8rem', transition: 'transform var(--transition-fast)', transform: isExpanded ? 'rotate(180deg)' : 'rotate(0)' }}>▾</span>
                        </button>
                        {isExpanded && (
                          <div style={{ padding: '0 1rem 1rem', animation: 'slideUp 0.2s ease' }}>
                            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--text-sm)' }}>
                              <thead>
                                <tr style={{ borderBottom: '1px solid var(--border)' }}>
                                  <th style={{ textAlign: 'left', padding: '0.5rem', width: 36 }}></th>
                                  <th style={{ textAlign: 'left', padding: '0.5rem', fontSize: 'var(--text-xs)', textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)', fontWeight: 500 }}>Day</th>
                                  <th style={{ textAlign: 'left', padding: '0.5rem', fontSize: 'var(--text-xs)', textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)', fontWeight: 500 }}>Date</th>
                                  <th style={{ textAlign: 'left', padding: '0.5rem', fontSize: 'var(--text-xs)', textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)', fontWeight: 500 }}>Workout</th>
                                  <th style={{ textAlign: 'left', padding: '0.5rem', width: 80 }}></th>
                                </tr>
                              </thead>
                              <tbody>
                                {week.days.map((day, dayIndex) => {
                                  const date = getDateForDay(active.startDate, week.weekNumber - 1, dayIndex);
                                  const isToday = formatDateKey(date) === todayKey;
                                  const completed = isDayCompleted(plan.id, week.weekNumber - 1, dayIndex);
                                  const meta = getSyncMeta(plan.id, week.weekNumber - 1, dayIndex);
                                  return (
                                    <DayRow
                                      key={dayIndex}
                                      dayIndex={dayIndex}
                                      day={day}
                                      date={date}
                                      isToday={isToday}
                                      completed={completed}
                                      syncMeta={meta}
                                      onToggle={() => {
                                        toggleDayCompleted(plan.id, week.weekNumber - 1, dayIndex);
                                        setActiveState(getActivePlan());
                                        forceUpdate((n) => n + 1);
                                      }}
                                    />
                                  );
                                })}
                              </tbody>
                            </table>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>}
            </>
          )}
        </>
      )}

      {/* Smart Auto-Sync Card */}
      <div className="card" style={{
        background: 'linear-gradient(135deg, rgba(91,181,181,0.06) 0%, var(--bg-card) 100%)',
        borderColor: stravaConnected ? 'var(--apollo-teal-dark)' : 'var(--border)',
        borderLeftWidth: 3, borderLeftStyle: 'solid',
        borderLeftColor: stravaConnected ? 'var(--apollo-teal)' : 'var(--border)',
      }}>
        <h3 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <span style={{ color: 'var(--apollo-teal)' }}>Smart Auto-Sync</span>
          {stravaConnected && (
            <span style={{
              fontSize: '0.72rem', background: 'var(--apollo-teal-dim)',
              color: 'var(--apollo-teal)', padding: '0.15rem 0.6rem',
              borderRadius: 'var(--radius-full)', fontWeight: 600,
              fontFamily: 'var(--font-display)',
            }}>Active</span>
          )}
        </h3>
        {!stravaConnected ? (
          <p style={{ color: 'var(--text-secondary)', margin: 0, fontSize: 'var(--text-sm)' }}>
            Connect <strong>Strava</strong> in Settings to automatically sync your runs with the training plan.
          </p>
        ) : (
          <div>
            <p style={{ color: 'var(--text-secondary)', margin: '0 0 0.75rem', fontSize: 'var(--text-sm)', lineHeight: 1.5 }}>
              Your Strava runs are automatically matched to plan days. Distance, pace, and weekly mileage analyzed after every sync.
              {lastSync && (
                <span style={{ marginLeft: '0.5rem', color: 'var(--text-muted)' }}>
                  Last synced: {new Date(lastSync).toLocaleTimeString()}
                </span>
              )}
            </p>
            <button
              type="button"
              className="btn btn-primary"
              onClick={handleSync}
              disabled={syncing}
              style={{ marginBottom: syncResults.length > 0 ? '0.75rem' : 0, fontSize: 'var(--text-sm)' }}
            >
              {syncing ? 'Syncing…' : 'Sync Now'}
            </button>
            {syncResults.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', marginTop: '0.5rem' }}>
                {syncResults.map((r, i) => (
                  <div
                    key={i}
                    style={{
                      background: 'var(--apollo-gold-dim)',
                      borderRadius: 'var(--radius-sm)',
                      padding: '0.65rem 1rem',
                      fontSize: 'var(--text-sm)',
                      lineHeight: 1.5,
                    }}
                  >
                    <div style={{ fontWeight: 600, color: 'var(--apollo-gold)', marginBottom: '0.15rem', fontFamily: 'var(--font-display)' }}>
                      {r.isNew ? 'Auto-completed' : 'Updated'}: Week {r.weekIndex + 1}, {DAY_NAMES[r.dayIndex]} — {r.plannedDay.label}
                    </div>
                    <div style={{ color: 'var(--text-secondary)' }}>{r.feedback}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
