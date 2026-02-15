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

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function miToKm(mi: number): string {
  return (mi * 1.60934).toFixed(1);
}

function formatSyncPace(paceMinPerMi: number): string {
  if (!paceMinPerMi) return '—';
  const totalSec = Math.round(paceMinPerMi * 60);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${sec.toString().padStart(2, '0')}/mi`;
}

/** Single day row in the training plan checklist. Memoized to avoid re-renders on sibling changes. */
const DayRow = memo(function DayRow({
  planId: _planId,
  weekIndex: _weekIndex,
  dayIndex,
  day,
  date,
  isToday,
  completed,
  syncMeta,
  onToggle,
}: {
  planId: string;
  weekIndex: number;
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
      <tr style={{ background: isToday ? 'rgba(0,200,83,0.12)' : isSynced ? 'rgba(0,200,83,0.05)' : undefined }}>
        <td style={{ padding: '0.5rem', width: 36 }}>
          {(day.type === 'run' || day.type === 'cross' || day.type === 'race' || day.type === 'marathon') ? (
            <input
              type="checkbox"
              checked={completed}
              onChange={() => onToggle()}
              aria-label={`Mark ${day.label} complete`}
            />
          ) : (
            <span style={{ color: 'var(--text-muted)' }}>—</span>
          )}
        </td>
        <td style={{ padding: '0.5rem', color: 'var(--text-muted)', fontSize: '0.9rem' }}>{DAY_NAMES[dayIndex]}</td>
        <td style={{ padding: '0.5rem' }}>{dateStr}</td>
        <td style={{ padding: '0.5rem' }}>
          <span className={`day-type-${day.type}`}>{day.label}</span>
          {day.distanceMi != null && (
            <span style={{ color: 'var(--text-muted)', marginLeft: '0.5rem', fontSize: '0.9rem' }}>
              {day.distanceMi} mi ({miToKm(day.distanceMi)} km)
            </span>
          )}
          {isSynced && (
            <span style={{
              marginLeft: '0.5rem',
              fontSize: '0.75rem',
              background: 'rgba(0,200,83,0.2)',
              color: 'var(--accent)',
              padding: '0.15rem 0.5rem',
              borderRadius: '999px',
              fontWeight: 600,
            }}>
              Synced
            </span>
          )}
        </td>
        <td style={{ padding: '0.5rem' }}>
          {isToday ? <span style={{ color: 'var(--accent)', fontWeight: 600 }}>Today</span> : null}
        </td>
      </tr>
      {isSynced && syncMeta && (
        <tr style={{ background: isToday ? 'rgba(0,200,83,0.08)' : 'rgba(0,200,83,0.03)' }}>
          <td colSpan={5} style={{ padding: '0.25rem 0.5rem 0.5rem 2.75rem' }}>
            <div style={{
              fontSize: '0.82rem',
              color: 'var(--text-muted)',
              display: 'flex',
              gap: '1rem',
              flexWrap: 'wrap',
              alignItems: 'center',
            }}>
              <span style={{ color: 'var(--accent)', fontWeight: 600 }}>
                {syncMeta.actualDistanceMi.toFixed(1)} mi
              </span>
              <span>{formatSyncPace(syncMeta.actualPaceMinPerMi)} pace</span>
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
          <div className="card">
            <h3>Choose a plan</h3>
            <p style={{ color: 'var(--text-muted)', marginBottom: '1rem' }}>
              Pick a popular plan below, set your start date, and track each day as you complete it.
            </p>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '1rem' }}>
              {BUILT_IN_PLANS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className="plan-card"
                  onClick={() => setSelectedPlanId(p.id)}
                  style={{
                    border: selectedPlanId === p.id ? '2px solid var(--accent)' : '1px solid var(--border)',
                    textAlign: 'left',
                    padding: '1rem',
                    borderRadius: '12px',
                    background: 'var(--bg-card)',
                    color: 'var(--text)',
                    cursor: 'pointer',
                  }}
                >
                  <div style={{ fontWeight: 600, marginBottom: '0.25rem' }}>{p.name}</div>
                  <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '0.5rem' }}>{p.author}</div>
                  <div style={{ fontSize: '0.9rem', color: 'var(--text-muted)' }}>{p.description}</div>
                </button>
              ))}
            </div>
          </div>

          {plan && (
            <div className="card">
              <h3>Start your plan</h3>
              <p style={{ color: 'var(--text-muted)', marginBottom: '1rem' }}>
                <strong>{plan.name}</strong> — {plan.totalWeeks} weeks. Set the date of Week 1, Monday.
              </p>
              <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <span style={{ fontSize: '0.9rem', color: 'var(--text-muted)' }}>Start date (Week 1 Mon)</span>
                  <input
                    type="date"
                    value={startDate}
                    onChange={(e) => setStartDate(e.target.value)}
                    style={{ padding: '0.5rem', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)' }}
                  />
                </label>
                <button type="button" className="btn btn-primary" onClick={handleStartPlan}>
                  Start plan
                </button>
              </div>
            </div>
          )}
        </>
      ) : (
        <>
          {plan && (
            <>
              <div className="card" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1rem' }}>
                <div>
                  <h3 style={{ margin: 0 }}>{plan.name} — {plan.author}</h3>
                  <p style={{ color: 'var(--text-muted)', margin: '0.25rem 0 0', fontSize: '0.9rem' }}>
                    Started {active.startDate} • {getCompletedCount(plan.id)} / {plan.totalWeeks * 7} days completed
                  </p>
                </div>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  <button type="button" className="btn btn-secondary" onClick={() => setShowPicker(true)}>Change plan</button>
                  <button type="button" className="btn btn-secondary" onClick={handleClearPlan}>Clear plan</button>
                </div>
              </div>

              {showPicker && (
                <div className="card">
                  <h3>Switch plan</h3>
                  <p style={{ color: 'var(--text-muted)', marginBottom: '1rem' }}>Starting a new plan will keep your completed days for the previous plan.</p>
                  <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                    {BUILT_IN_PLANS.map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        className="btn btn-secondary"
                        onClick={() => { setSelectedPlanId(p.id); setStartDate(formatDateKey(new Date())); }}
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
                          style={{ padding: '0.5rem', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)' }}
                        />
                        <button type="button" className="btn btn-primary" onClick={handleStartPlan}>Switch & start</button>
                      </>
                    )}
                    <button type="button" className="btn btn-secondary" onClick={() => setShowPicker(false)}>Cancel</button>
                  </div>
                </div>
              )}

              <div className="card">
                <h3>Day-by-day checklist</h3>
                <p style={{ color: 'var(--text-muted)', marginBottom: '1rem', fontSize: '0.9rem' }}>
                  Check off each run, cross-training, or race day as you complete it. Rest days are for recovery.
                </p>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                  {plan.weeks.map((week) => {
                    const isExpanded = expandedWeek === week.weekNumber - 1;
                    return (
                      <div key={week.weekNumber} style={{ border: '1px solid var(--border)', borderRadius: '8px', overflow: 'hidden' }}>
                        <button
                          type="button"
                          onClick={() => setExpandedWeek(expandedWeek === week.weekNumber - 1 ? null : week.weekNumber - 1)}
                          style={{
                            width: '100%',
                            padding: '0.75rem 1rem',
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center',
                            background: 'var(--bg)',
                            border: 'none',
                            color: 'var(--text)',
                            cursor: 'pointer',
                            fontSize: '1rem',
                            gap: '0.5rem',
                          }}
                        >
                          <span style={{ minWidth: '5rem' }}>Week {week.weekNumber}</span>
                          {(() => {
                            const wm = getWeeklyMileageSummary(plan.id, week.weekNumber - 1);
                            if (!wm || wm.actualMi === 0) return null;
                            const pct = wm.plannedMi > 0 ? Math.min((wm.actualMi / wm.plannedMi) * 100, 100) : 0;
                            const barColor = wm.status === 'on_track' || wm.status === 'ahead' ? 'var(--accent)' : wm.status === 'behind' ? '#f0a030' : '#f55';
                            return (
                              <span style={{ flex: 1, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                <span style={{
                                  flex: 1,
                                  height: 6,
                                  borderRadius: 3,
                                  background: 'rgba(255,255,255,0.08)',
                                  overflow: 'hidden',
                                }}>
                                  <span style={{
                                    display: 'block',
                                    height: '100%',
                                    width: `${pct}%`,
                                    borderRadius: 3,
                                    background: barColor,
                                    transition: 'width 0.3s',
                                  }} />
                                </span>
                                <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                                  {wm.actualMi.toFixed(1)}/{wm.plannedMi.toFixed(1)} mi
                                </span>
                              </span>
                            );
                          })()}
                          <span style={{ color: 'var(--text-muted)', fontSize: '0.9rem', whiteSpace: 'nowrap' }}>
                            {week.days.filter((_, di) => isDayCompleted(plan.id, week.weekNumber - 1, di)).length} done
                          </span>
                          <span>{isExpanded ? '▼' : '▶'}</span>
                        </button>
                        {isExpanded && (
                          <div style={{ padding: '0 1rem 1rem' }}>
                            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.9rem' }}>
                              <thead>
                                <tr style={{ borderBottom: '1px solid var(--border)' }}>
                                  <th style={{ textAlign: 'left', padding: '0.5rem', width: 36 }}></th>
                                  <th style={{ textAlign: 'left', padding: '0.5rem' }}>Day</th>
                                  <th style={{ textAlign: 'left', padding: '0.5rem' }}>Date</th>
                                  <th style={{ textAlign: 'left', padding: '0.5rem' }}>Workout</th>
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
                                      planId={plan.id}
                                      weekIndex={week.weekNumber - 1}
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
              </div>
            </>
          )}
        </>
      )}

      <div className="card" style={{ background: 'rgba(0,200,83,0.08)', borderColor: 'var(--accent)' }}>
        <h3 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          Smart Auto-Sync
          {stravaConnected && (
            <span style={{ fontSize: '0.8rem', color: 'var(--accent)', fontWeight: 500 }}>Active</span>
          )}
        </h3>
        {!stravaConnected ? (
          <p style={{ color: 'var(--text-muted)', margin: 0 }}>
            Connect <strong>Strava</strong> in Settings to automatically sync your runs with the training plan.
          </p>
        ) : (
          <div>
            <p style={{ color: 'var(--text-muted)', margin: '0 0 0.75rem', fontSize: '0.9rem' }}>
              Your Strava runs are automatically matched to plan days. Distance, pace, and weekly mileage are analyzed after every sync.
              {lastSync && (
                <span style={{ marginLeft: '0.5rem' }}>
                  Last synced: {new Date(lastSync).toLocaleTimeString()}
                </span>
              )}
            </p>
            <button
              type="button"
              className="btn btn-primary"
              onClick={handleSync}
              disabled={syncing}
              style={{ marginBottom: syncResults.length > 0 ? '0.75rem' : 0 }}
            >
              {syncing ? 'Syncing…' : 'Sync now'}
            </button>
            {syncResults.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginTop: '0.5rem' }}>
                {syncResults.map((r, i) => (
                  <div
                    key={i}
                    style={{
                      background: 'rgba(0,200,83,0.1)',
                      borderRadius: '8px',
                      padding: '0.75rem 1rem',
                      fontSize: '0.88rem',
                      lineHeight: 1.5,
                    }}
                  >
                    <div style={{ fontWeight: 600, color: 'var(--accent)', marginBottom: '0.25rem' }}>
                      {r.isNew ? 'Auto-completed' : 'Updated'}: Week {r.weekIndex + 1}, {DAY_NAMES[r.dayIndex]} — {r.plannedDay.label}
                    </div>
                    <div style={{ color: 'var(--text)' }}>{r.feedback}</div>
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
