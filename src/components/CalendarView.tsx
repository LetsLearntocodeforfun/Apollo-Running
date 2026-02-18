/**
 * CalendarView — Best-in-class monthly training calendar for Apollo.
 *
 * Displays a full month grid with:
 *   - Planned workouts with type icons and distance
 *   - Completed/synced status with visual indicators
 *   - Intensity color bars per workout type
 *   - Weekly mileage summary column
 *   - Click-to-expand day detail panel (plan vs actual, route map, feedback)
 *   - Smooth month navigation with Today quick-jump
 *   - Legend for workout types
 */

import { useState, useMemo, useCallback, memo } from 'react';
import type { TrainingPlan, PlanDay } from '../data/plans';
import type { ActivePlan, SyncMeta } from '../services/planProgress';
import {
  isDayCompleted,
  getSyncMeta,
  formatDateKey,
  getWeekDayForDate,
} from '../services/planProgress';
import { getWeeklyMileageSummary } from '../services/autoSync';
import { getStoredActivities } from '../services/analyticsService';
import { getEffortRecognition } from '../services/effortService';
import { TIER_CONFIG } from './TierBadge';
import RouteMap from './RouteMap';
import { formatMiles, formatPaceFromMinPerMi } from '../services/unitPreferences';
import './CalendarView.css';

// ─── Constants ───────────────────────────────────────────────

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const WORKOUT_ICONS: Record<string, string> = {
  rest: '💤',
  run: '🏃',
  cross: '🔄',
  race: '🏁',
  marathon: '🏅',
};

const NOTE_ICONS: Record<string, string> = {
  easy: '🟢',
  long: '🟡',
  tempo: '🟠',
  speed: '🔴',
  race: '🏁',
  'race day': '🏅',
};

/** Intensity bar colors by workout note */
function getIntensityColor(day: PlanDay): string {
  if (day.type === 'rest') return 'transparent';
  if (day.type === 'marathon') return 'linear-gradient(90deg, var(--apollo-gold-dark), var(--apollo-gold), var(--apollo-gold-light))';
  if (day.type === 'race') return 'linear-gradient(90deg, var(--apollo-orange), var(--apollo-orange-light))';
  if (day.type === 'cross') return 'var(--apollo-teal)';
  const note = (day.note || '').toLowerCase();
  if (note === 'speed') return 'var(--color-error)';
  if (note === 'tempo') return 'var(--apollo-orange)';
  if (note === 'long') return 'var(--apollo-gold)';
  return 'var(--color-success)'; // easy / default run
}

// ─── Types ───────────────────────────────────────────────────

interface CalendarDay {
  date: Date;
  dateKey: string;
  dayOfMonth: number;
  isCurrentMonth: boolean;
  /** Whether this date falls within the training plan range */
  inPlan: boolean;
  /** Plan week/day indices, if in plan */
  weekIndex: number | null;
  dayIndex: number | null;
  /** The planned day, if in plan */
  planDay: PlanDay | null;
  /** Whether the plan day is completed */
  completed: boolean;
  /** Sync metadata if the day was matched to a Strava activity */
  syncMeta: SyncMeta | null;
  isToday: boolean;
}

interface CalendarWeekRow {
  days: CalendarDay[];
  /** Plan week number (1-based), if any days are in this plan week */
  planWeekNum: number | null;
  /** Weekly mileage summary for this plan week */
  plannedMi: number;
  actualMi: number;
}

interface Props {
  plan: TrainingPlan;
  active: ActivePlan;
  onToggleDay: (weekIndex: number, dayIndex: number) => void;
}

// ─── Helpers ─────────────────────────────────────────────────

/** Get the Monday of the week for a given date */
function getMonday(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day; // Monday = 1
  d.setDate(d.getDate() + diff);
  return d;
}

/** Build the grid of CalendarDays for a given month */
function buildMonthGrid(
  year: number,
  month: number, // 0-based
  plan: TrainingPlan,
  active: ActivePlan
): CalendarWeekRow[] {
  const firstOfMonth = new Date(year, month, 1);
  const lastOfMonth = new Date(year, month + 1, 0);

  // Start from the Monday before (or on) the 1st
  const gridStart = getMonday(firstOfMonth);
  // End on the Sunday after (or on) the last day
  const lastDay = new Date(lastOfMonth);
  const lastDayOfWeek = lastDay.getDay();
  const gridEnd = new Date(lastDay);
  if (lastDayOfWeek !== 0) {
    gridEnd.setDate(gridEnd.getDate() + (7 - lastDayOfWeek));
  }
  gridEnd.setHours(23, 59, 59, 999);

  const todayKey = formatDateKey(new Date());
  const rows: CalendarWeekRow[] = [];
  let current = new Date(gridStart);

  while (current <= gridEnd) {
    const week: CalendarDay[] = [];
    let rowPlanWeekNum: number | null = null;
    let rowPlannedMi = 0;
    let rowActualMi = 0;

    for (let d = 0; d < 7; d++) {
      const dateKey = formatDateKey(current);
      const isCurrentMonth = current.getMonth() === month && current.getFullYear() === year;
      const planPos = getWeekDayForDate(active.startDate, plan.totalWeeks, current);
      const inPlan = !!planPos;
      let planDay: PlanDay | null = null;
      let completed = false;
      let syncMeta: SyncMeta | null = null;

      if (planPos) {
        planDay = plan.weeks[planPos.weekIndex]?.days[planPos.dayIndex] ?? null;
        completed = isDayCompleted(plan.id, planPos.weekIndex, planPos.dayIndex);
        syncMeta = getSyncMeta(plan.id, planPos.weekIndex, planPos.dayIndex);

        if (rowPlanWeekNum === null) {
          rowPlanWeekNum = planPos.weekIndex + 1;
          const wm = getWeeklyMileageSummary(plan.id, planPos.weekIndex);
          if (wm) {
            rowPlannedMi = wm.plannedMi;
            rowActualMi = wm.actualMi;
          }
        }
      }

      week.push({
        date: new Date(current),
        dateKey,
        dayOfMonth: current.getDate(),
        isCurrentMonth,
        inPlan,
        weekIndex: planPos?.weekIndex ?? null,
        dayIndex: planPos?.dayIndex ?? null,
        planDay,
        completed,
        syncMeta,
        isToday: dateKey === todayKey,
      });

      current.setDate(current.getDate() + 1);
    }

    rows.push({
      days: week,
      planWeekNum: rowPlanWeekNum,
      plannedMi: rowPlannedMi,
      actualMi: rowActualMi,
    });
  }

  return rows;
}

// ─── DayCell Component ───────────────────────────────────────

const DayCell = memo(function DayCell({
  day,
  isSelected,
  onClick,
}: {
  day: CalendarDay;
  isSelected: boolean;
  onClick: () => void;
}) {
  const classNames = [
    'cal-day',
    isSelected && 'cal-day--selected',
    day.isToday && 'cal-day--today',
    !day.isCurrentMonth && 'cal-day--outside',
    day.isCurrentMonth && !day.inPlan && 'cal-day--outside-plan',
  ].filter(Boolean).join(' ');

  const intensityColor = day.planDay ? getIntensityColor(day.planDay) : 'transparent';
  const hasSync = !!day.syncMeta;
  const noteKey = (day.planDay?.note || '').toLowerCase();
  const noteIcon = NOTE_ICONS[noteKey] || (day.planDay ? WORKOUT_ICONS[day.planDay.type] : null);

  return (
    <div className={classNames} onClick={onClick} role="button" tabIndex={day.isCurrentMonth ? 0 : -1}>
      {/* Intensity bar at top */}
      <div className="cal-day-bar" style={{ background: intensityColor }} />

      {/* Date number */}
      <div className="cal-day-num">
        <span className="cal-day-num-badge">{day.dayOfMonth}</span>
      </div>

      {/* Workout content */}
      {day.planDay && (
        <div className="cal-day-content">
          <div className="cal-day-workout">
            {noteIcon && <span className="cal-day-icon">{noteIcon}</span>}{' '}
            {day.planDay.type === 'rest' ? 'Rest' : day.planDay.note || day.planDay.type}
          </div>
          {day.planDay.distanceMi != null && day.planDay.distanceMi > 0 && (
            <div className="cal-day-distance">
              {hasSync ? (
                <>
                  <span style={{ color: 'var(--apollo-gold)' }}>{formatMiles(day.syncMeta!.actualDistanceMi)}</span>
                  <span style={{ opacity: 0.5 }}>/</span>
                  <span>{formatMiles(day.planDay.distanceMi)}</span>
                </>
              ) : (
                <span>{formatMiles(day.planDay.distanceMi)}</span>
              )}
            </div>
          )}
          {/* Progress bar: actual vs planned */}
          {hasSync && day.planDay.distanceMi != null && day.planDay.distanceMi > 0 && (
            <div className="cal-day-progress">
              <div
                className="cal-day-progress-fill"
                style={{
                  width: `${Math.min((day.syncMeta!.actualDistanceMi / day.planDay.distanceMi) * 100, 100)}%`,
                  background: day.syncMeta!.actualDistanceMi >= day.planDay.distanceMi * 0.95
                    ? 'var(--color-success)'
                    : 'var(--color-warning)',
                }}
              />
            </div>
          )}
        </div>
      )}

      {/* Status indicators */}
      {(day.completed || hasSync) && (
        <div className="cal-day-status">
          {hasSync ? (
            <>
              <span className="cal-day-check cal-day-check--synced">✓</span>
              <span className="cal-day-sync-label">Synced</span>
            </>
          ) : day.completed ? (
            <span className="cal-day-check cal-day-check--done">✓</span>
          ) : null}
        </div>
      )}
    </div>
  );
});

// ─── WeekSummary Component ───────────────────────────────────

const WeekSummary = memo(function WeekSummary({
  row,
}: {
  row: CalendarWeekRow;
}) {
  if (!row.planWeekNum) {
    return <div className="cal-week-summary" style={{ opacity: 0.3 }}><span className="cal-week-label">—</span></div>;
  }
  const pct = row.plannedMi > 0 ? Math.min((row.actualMi / row.plannedMi) * 100, 100) : 0;
  return (
    <div className="cal-week-summary">
      <span className="cal-week-label">Wk {row.planWeekNum}</span>
      <span className="cal-week-miles">{formatMiles(row.actualMi > 0 ? row.actualMi : row.plannedMi)}</span>
      <span className="cal-week-label" style={{ color: row.actualMi > 0 ? 'var(--text-muted)' : undefined }}>
        {row.actualMi > 0 ? `/ ${formatMiles(row.plannedMi)}` : 'planned'}
      </span>
      {row.actualMi > 0 && (
        <div className="cal-week-bar">
          <div className="cal-week-bar-fill" style={{ width: `${pct}%` }} />
        </div>
      )}
    </div>
  );
});

// ─── DayDetail Component ─────────────────────────────────────

function DayDetail({
  day,
  plan: _plan,
  onClose,
  onToggle,
}: {
  day: CalendarDay;
  plan: TrainingPlan;
  onClose: () => void;
  onToggle: () => void;
}) {
  const { planDay, syncMeta, completed, weekIndex, dayIndex } = day;
  const dayName = WEEKDAYS[day.date.getDay() === 0 ? 6 : day.date.getDay() - 1];

  // Find matching stored activity for route map
  const matchedActivity = useMemo(() => {
    if (!syncMeta?.stravaActivityId) return null;
    const stored = getStoredActivities();
    return stored.find(a => a.id === syncMeta.stravaActivityId) ?? null;
  }, [syncMeta]);

  // Effort recognition
  const effortRec = useMemo(() => {
    if (!syncMeta?.stravaActivityId) return null;
    return getEffortRecognition(syncMeta.stravaActivityId);
  }, [syncMeta]);

  const dateFormatted = day.date.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });

  return (
    <div className="cal-detail">
      <div className="cal-detail-header">
        <div>
          <div className="cal-detail-title">
            {planDay ? (
              <>
                {WORKOUT_ICONS[planDay.type]} {planDay.label}
              </>
            ) : (
              <>📅 {dateFormatted}</>
            )}
          </div>
          <div className="cal-detail-subtitle">
            {dateFormatted}
            {weekIndex != null && <> · Week {weekIndex + 1}, {dayName}</>}
          </div>
        </div>
        <button className="cal-detail-close" onClick={onClose} aria-label="Close detail">×</button>
      </div>

      {/* Plan vs Actual comparison */}
      {planDay && (
        <div className="cal-detail-compare">
          {/* Planned column */}
          <div className="cal-detail-col">
            <div className="cal-detail-col-label">📋 Planned</div>
            <div className="cal-detail-stat">
              <span className="cal-detail-stat-label">Workout</span>
              <span className="cal-detail-stat-value">{planDay.label}</span>
            </div>
            {planDay.distanceMi != null && (
              <div className="cal-detail-stat">
                <span className="cal-detail-stat-label">Distance</span>
                <span className="cal-detail-stat-value">{formatMiles(planDay.distanceMi)}</span>
              </div>
            )}
            {planDay.note && (
              <div className="cal-detail-stat">
                <span className="cal-detail-stat-label">Type</span>
                <span className="cal-detail-stat-value">
                  {NOTE_ICONS[(planDay.note || '').toLowerCase()] || ''} {planDay.note}
                </span>
              </div>
            )}
            <div className="cal-detail-stat">
              <span className="cal-detail-stat-label">Status</span>
              <span className="cal-detail-stat-value" style={{
                color: completed ? 'var(--color-success)' : 'var(--text-muted)',
              }}>
                {completed ? '✓ Complete' : 'Not done'}
              </span>
            </div>
          </div>

          {/* Actual column */}
          <div className="cal-detail-col" style={{
            borderColor: syncMeta ? 'rgba(212, 165, 55, 0.2)' : undefined,
          }}>
            <div className="cal-detail-col-label">
              {syncMeta ? '⚡ Actual (Strava)' : '⏳ Actual'}
            </div>
            {syncMeta ? (
              <>
                <div className="cal-detail-stat">
                  <span className="cal-detail-stat-label">Distance</span>
                  <span className="cal-detail-stat-value cal-detail-stat-value--gold">
                    {formatMiles(syncMeta.actualDistanceMi)}
                  </span>
                </div>
                <div className="cal-detail-stat">
                  <span className="cal-detail-stat-label">Pace</span>
                  <span className="cal-detail-stat-value cal-detail-stat-value--gold">
                    {formatPaceFromMinPerMi(syncMeta.actualPaceMinPerMi)}
                  </span>
                </div>
                <div className="cal-detail-stat">
                  <span className="cal-detail-stat-label">Duration</span>
                  <span className="cal-detail-stat-value">
                    {Math.floor(syncMeta.movingTimeSec / 60)}:{String(syncMeta.movingTimeSec % 60).padStart(2, '0')}
                  </span>
                </div>
                {planDay.distanceMi != null && planDay.distanceMi > 0 && (
                  <div className="cal-detail-stat">
                    <span className="cal-detail-stat-label">vs Plan</span>
                    <span className={`cal-detail-stat-value ${
                      syncMeta.actualDistanceMi >= planDay.distanceMi * 0.95
                        ? 'cal-detail-stat-value--success'
                        : 'cal-detail-stat-value--warning'
                    }`}>
                      {syncMeta.actualDistanceMi >= planDay.distanceMi
                        ? `+${formatMiles(syncMeta.actualDistanceMi - planDay.distanceMi)}`
                        : `-${formatMiles(planDay.distanceMi - syncMeta.actualDistanceMi)}`}
                    </span>
                  </div>
                )}
              </>
            ) : (
              <div style={{
                color: 'var(--text-muted)',
                fontSize: '0.82rem',
                padding: '0.5rem 0',
                fontStyle: 'italic',
              }}>
                {day.inPlan ? 'No synced activity yet' : 'Outside plan range'}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Effort tier + tags */}
      {(effortRec?.paceTier || syncMeta) && (
        <div className="cal-detail-tags">
          {effortRec?.paceTier && (() => {
            const tc = TIER_CONFIG[effortRec.paceTier];
            return (
              <span className="cal-detail-tag" style={{ background: tc.bg, color: tc.color }}>
                {tc.label}
              </span>
            );
          })()}
          {syncMeta && (
            <span className="cal-detail-tag" style={{
              background: 'var(--apollo-gold-dim)',
              color: 'var(--apollo-gold)',
            }}>
              Synced via Strava
            </span>
          )}
          {completed && !syncMeta && (
            <span className="cal-detail-tag" style={{
              background: 'var(--color-success-dim)',
              color: 'var(--color-success)',
            }}>
              Manually completed
            </span>
          )}
        </div>
      )}

      {/* Feedback */}
      {syncMeta?.feedback && (
        <div className="cal-detail-feedback" style={{ marginTop: '0.75rem' }}>
          {syncMeta.feedback}
        </div>
      )}

      {/* Route map */}
      {matchedActivity?.map?.summary_polyline && (
        <div className="cal-detail-route">
          <div className="cal-detail-route-map">
            <RouteMap
              activity={matchedActivity}
              size="card"
              animate={true}
              showMarkers={true}
              showEndpoints={true}
              showCompass={true}
            />
          </div>
        </div>
      )}

      {/* Toggle completion (for in-plan days) */}
      {planDay && weekIndex != null && dayIndex != null && planDay.type !== 'rest' && (
        <div style={{ marginTop: '1rem', display: 'flex', gap: '0.5rem' }}>
          <button
            type="button"
            className={`btn ${completed ? 'btn-secondary' : 'btn-primary'}`}
            onClick={onToggle}
            style={{ fontSize: 'var(--text-sm)' }}
          >
            {completed ? 'Mark Incomplete' : 'Mark Complete'}
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Main CalendarView Component ─────────────────────────────

export default function CalendarView({ plan, active, onToggleDay }: Props) {
  const today = new Date();
  const [viewMonth, setViewMonth] = useState(today.getMonth());
  const [viewYear, setViewYear] = useState(today.getFullYear());
  const [selectedDateKey, setSelectedDateKey] = useState<string | null>(null);
  const [monthKey, setMonthKey] = useState(0); // for transition animation

  // Build month grid
  const rows = useMemo(
    () => buildMonthGrid(viewYear, viewMonth, plan, active),
    [viewYear, viewMonth, plan, active]
  );

  // Find selected day
  const selectedDay = useMemo(() => {
    if (!selectedDateKey) return null;
    for (const row of rows) {
      for (const day of row.days) {
        if (day.dateKey === selectedDateKey) return day;
      }
    }
    return null;
  }, [selectedDateKey, rows]);

  // Month navigation
  const goToPrevMonth = useCallback(() => {
    setViewMonth(m => {
      if (m === 0) { setViewYear(y => y - 1); return 11; }
      return m - 1;
    });
    setMonthKey(k => k + 1);
  }, []);

  const goToNextMonth = useCallback(() => {
    setViewMonth(m => {
      if (m === 11) { setViewYear(y => y + 1); return 0; }
      return m + 1;
    });
    setMonthKey(k => k + 1);
  }, []);

  const goToToday = useCallback(() => {
    const now = new Date();
    setViewMonth(now.getMonth());
    setViewYear(now.getFullYear());
    setSelectedDateKey(formatDateKey(now));
    setMonthKey(k => k + 1);
  }, []);

  const handleDayClick = useCallback((day: CalendarDay) => {
    if (!day.isCurrentMonth) return;
    setSelectedDateKey(prev => prev === day.dateKey ? null : day.dateKey);
  }, []);

  const handleToggle = useCallback(() => {
    if (!selectedDay || selectedDay.weekIndex == null || selectedDay.dayIndex == null) return;
    onToggleDay(selectedDay.weekIndex, selectedDay.dayIndex);
    // Force rebuild
    setMonthKey(k => k + 1);
  }, [selectedDay, onToggleDay]);

  const monthLabel = new Date(viewYear, viewMonth).toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric',
  });

  // Determine which row the selected day is in
  const selectedRowIndex = useMemo(() => {
    if (!selectedDateKey) return -1;
    return rows.findIndex(row => row.days.some(d => d.dateKey === selectedDateKey));
  }, [selectedDateKey, rows]);

  return (
    <div>
      {/* Month navigation */}
      <div className="cal-nav">
        <span className="cal-nav-title">{monthLabel}</span>
        <div className="cal-nav-btns">
          <button className="cal-nav-today" onClick={goToToday}>Today</button>
          <button className="cal-nav-btn" onClick={goToPrevMonth} aria-label="Previous month">‹</button>
          <button className="cal-nav-btn" onClick={goToNextMonth} aria-label="Next month">›</button>
        </div>
      </div>

      {/* Weekday headers */}
      <div className="cal-header" key={`hdr-${monthKey}`}>
        {WEEKDAYS.map(d => (
          <div key={d} className="cal-header-day">{d}</div>
        ))}
        <div className="cal-header-summary">Week</div>
      </div>

      {/* Calendar grid */}
      <div className="cal-grid cal-month-enter" key={`grid-${monthKey}`}>
        {rows.map((row, rowIdx) => (
          <>
            {row.days.map((day) => (
              <DayCell
                key={day.dateKey}
                day={day}
                isSelected={day.dateKey === selectedDateKey}
                onClick={() => handleDayClick(day)}
              />
            ))}
            <WeekSummary key={`ws-${rowIdx}`} row={row} />

            {/* Day detail panel — inserted after the row containing the selected day */}
            {selectedRowIndex === rowIdx && selectedDay && (
              <DayDetail
                key={`detail-${selectedDay.dateKey}`}
                day={selectedDay}
                plan={plan}
                onClose={() => setSelectedDateKey(null)}
                onToggle={handleToggle}
              />
            )}
          </>
        ))}
      </div>

      {/* Legend */}
      <div className="cal-legend">
        <div className="cal-legend-item">
          <div className="cal-legend-swatch" style={{ background: 'var(--color-success)' }} />
          Easy
        </div>
        <div className="cal-legend-item">
          <div className="cal-legend-swatch" style={{ background: 'var(--apollo-gold)' }} />
          Long Run
        </div>
        <div className="cal-legend-item">
          <div className="cal-legend-swatch" style={{ background: 'var(--apollo-orange)' }} />
          Tempo
        </div>
        <div className="cal-legend-item">
          <div className="cal-legend-swatch" style={{ background: 'var(--color-error)' }} />
          Speed
        </div>
        <div className="cal-legend-item">
          <div className="cal-legend-swatch" style={{ background: 'var(--apollo-teal)' }} />
          Cross Training
        </div>
        <div className="cal-legend-item">
          <span className="cal-day-check cal-day-check--synced" style={{ width: 10, height: 10, fontSize: '0.45rem' }}>✓</span>
          Synced
        </div>
        <div className="cal-legend-item">
          <span className="cal-day-check cal-day-check--done" style={{ width: 10, height: 10, fontSize: '0.45rem' }}>✓</span>
          Completed
        </div>
      </div>
    </div>
  );
}
