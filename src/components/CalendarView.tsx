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
 *
 * Accessibility (v1.0.6): every in-month day is a real <button> with a full
 * label ("Tuesday, October 7, 2026, Tempo run, 8.0 km, completed") and
 * aria-current="date" on today. One day is tabbable at a time (roving
 * tabindex); arrow keys move between days, Enter/Space open the detail and
 * Escape closes it. The grid only remounts when the month changes, so
 * completing a day keeps focus where it was. Dates come from local date keys
 * (DST-safe). At ≤640 px the cells collapse to dots (see CalendarView.css).
 */

import { Fragment, useState, useMemo, useCallback, useEffect, useId, useRef, memo, type KeyboardEvent, type ReactNode } from 'react';
import type { TrainingPlan, PlanDay } from '../data/plans';
import type { ActivePlan, SyncMeta } from '../services/planProgress';
import { isDayCompleted, getSyncMeta, canToggleDayCompletion } from '../services/planProgress';
import { getWeeklyMileageSummary } from '../services/autoSync';
import { getStoredActivities, getSourceDisplayName } from '../services/activitySource';
import { getSportCategoryIcon, SPORT_CATEGORIES, type SportCategory } from '../services/activity/sports';
import { formatHoursMinutes } from '../services/crossTraining';
import { getEffortRecognition } from '../services/effortService';
import { TIER_CONFIG } from './TierBadge';
import RouteMap from './RouteMap';
import { formatMiles, formatPaceFromMinPerMi, formatDistanceShort } from '../services/unitPreferences';
import { addDays, daysBetween, eachDay, isDateKey, mondayOf, parseDateKey, toDateKey, todayKey as getTodayKey, weekdayMon0 } from '../utils/localDate';
import { formatLongDate, workoutSummary, workoutTitle } from './plan/planDisplay';
import './CalendarView.css';

/** Icon for a stored cross-training category (falls back safely for unknown values). */
function categoryIcon(category: string): string {
  return (SPORT_CATEGORIES as readonly string[]).includes(category)
    ? getSportCategoryIcon(category as SportCategory)
    : '⚡';
}

// ─── Constants ───────────────────────────────────────────────

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const WEEKDAYS_LONG = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

const WORKOUT_ICONS: Record<string, string> = {
  rest: '💤',
  run: '🏃',
  cross: '🔄',
  race: '🏁',
  marathon: '🏅',
};

const NOTE_ICONS: Record<string, string> = {
  easy: '🟢',
  recovery: '🟢',
  long: '🟡',
  'medium long': '🟡',
  tempo: '🟠',
  'marathon pace': '🔵',
  speed: '🔴',
  strength: '🏋️',
  race: '🏁',
  'race day': '🏅',
};

/** Icon for a plan day: the marathon always gets 🏅 (its note is 'Race' since T2a's taxonomy), else by note, else by type. */
function planDayIcon(day: PlanDay): string | null {
  if (day.type === 'marathon') return WORKOUT_ICONS.marathon;
  return NOTE_ICONS[(day.note || '').toLowerCase()] || WORKOUT_ICONS[day.type] || null;
}

/** Intensity bar colors by workout note */
function getIntensityColor(day: PlanDay): string {
  if (day.type === 'rest') return 'transparent';
  if (day.type === 'marathon') return 'linear-gradient(90deg, var(--apollo-gold-dark), var(--apollo-gold), var(--apollo-gold-light))';
  if (day.type === 'race') return 'linear-gradient(90deg, var(--apollo-orange), var(--apollo-orange-light))';
  if (day.type === 'cross') return 'var(--apollo-teal)';
  const note = (day.note || '').toLowerCase();
  if (note === 'speed') return 'var(--color-error)';
  if (note === 'tempo') return 'var(--apollo-orange)';
  if (note === 'marathon pace') return 'var(--apollo-teal)';
  if (note === 'long') return 'var(--apollo-gold)';
  if (note === 'medium long') return 'var(--apollo-gold-light)';
  return 'var(--color-success)'; // easy / recovery / default run
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
  /** Sync metadata if the day was matched to a synced activity (any source) */
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

/** A plan day addressed by its position and date. */
export interface CalendarDayRef {
  weekIndex: number;
  dayIndex: number;
  dateKey: string;
}

interface Props {
  plan: TrainingPlan;
  active: ActivePlan;
  onToggleDay: (weekIndex: number, dayIndex: number) => void;
  /** Bump whenever completions, sync matches or plan changes happen outside the calendar, so it re-reads them. */
  version?: number;
  /** Extra controls for the selected day's detail panel (e.g. the day actions menu). */
  renderDayActions?: (ref: CalendarDayRef) => ReactNode;
  /** Short badge for a modified day ("Moved", "Skipped"), or null. */
  getDayBadge?: (weekIndex: number, dayIndex: number) => string | null;
}

// ─── Helpers ─────────────────────────────────────────────────

/** Build the grid of CalendarDays for a given month (date keys only, so DST can't shift a day). */
function buildMonthGrid(
  year: number,
  month: number, // 0-based
  plan: TrainingPlan,
  active: ActivePlan,
  todayKey: string,
): CalendarWeekRow[] {
  const firstKey = toDateKey(new Date(year, month, 1));
  const lastKey = toDateKey(new Date(year, month + 1, 0));
  const monthPrefix = firstKey.slice(0, 7);
  const keys = eachDay(mondayOf(firstKey), addDays(mondayOf(lastKey), 6));
  const startOk = isDateKey(active.startDate);
  const totalDays = plan.weeks.length * 7;

  const rows: CalendarWeekRow[] = [];
  for (let i = 0; i < keys.length; i += 7) {
    const week: CalendarDay[] = [];
    let rowPlanWeekNum: number | null = null;
    let rowPlannedMi = 0;
    let rowActualMi = 0;

    for (const dateKey of keys.slice(i, i + 7)) {
      const offset = startOk ? daysBetween(active.startDate, dateKey) : -1;
      const inPlan = offset >= 0 && offset < totalDays;
      const weekIndex = inPlan ? Math.floor(offset / 7) : null;
      const dayIndex = inPlan ? offset % 7 : null;
      let planDay: PlanDay | null = null;
      let completed = false;
      let syncMeta: SyncMeta | null = null;

      if (weekIndex !== null && dayIndex !== null) {
        planDay = plan.weeks[weekIndex]?.days[dayIndex] ?? null;
        completed = isDayCompleted(plan.id, weekIndex, dayIndex);
        syncMeta = getSyncMeta(plan.id, weekIndex, dayIndex);

        if (rowPlanWeekNum === null) {
          rowPlanWeekNum = weekIndex + 1;
          const wm = getWeeklyMileageSummary(plan.id, weekIndex);
          if (wm) {
            rowPlannedMi = wm.plannedMi;
            rowActualMi = wm.actualMi;
          }
        }
      }

      week.push({
        date: parseDateKey(dateKey),
        dateKey,
        dayOfMonth: Number(dateKey.slice(8)),
        isCurrentMonth: dateKey.slice(0, 7) === monthPrefix,
        inPlan,
        weekIndex,
        dayIndex,
        planDay,
        completed,
        syncMeta,
        isToday: dateKey === todayKey,
      });
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

/** Month to open on: today's, clamped to the plan's date range so a future or finished plan isn't an empty month. */
function initialMonth(plan: TrainingPlan, active: ActivePlan): { year: number; month: number } {
  const today = getTodayKey();
  let key = today;
  if (isDateKey(active.startDate) && plan.weeks.length > 0) {
    const planEnd = addDays(active.startDate, plan.weeks.length * 7 - 1);
    if (today < active.startDate) key = active.startDate;
    else if (today > planEnd) key = planEnd;
  }
  const d = parseDateKey(key);
  return { year: d.getFullYear(), month: d.getMonth() };
}

/** Screen-reader label for a day button: full date, workout, badge and status. */
function dayAriaLabel(day: CalendarDay, badge: string | null): string {
  const parts = [formatLongDate(day.dateKey)];
  if (day.planDay) parts.push(workoutSummary(day.planDay, ', '));
  else if (!day.inPlan) parts.push('outside your plan');
  if (badge) parts.push(badge.toLowerCase());
  if (day.syncMeta) {
    parts.push(day.syncMeta.crossTraining
      ? `synced: ${day.syncMeta.crossTraining.label}`
      : `synced: ${formatMiles(day.syncMeta.actualDistanceMi)}`);
  } else if (day.completed) {
    parts.push('completed');
  }
  return parts.join(', ');
}

// ─── DayCell Component ───────────────────────────────────────

const DayCell = memo(function DayCell({
  day,
  isSelected,
  isFocusTarget,
  badge,
  detailId,
  onSelect,
}: {
  day: CalendarDay;
  isSelected: boolean;
  /** The one day in the grid that is reachable with Tab (roving tabindex). */
  isFocusTarget: boolean;
  badge: string | null;
  detailId: string;
  onSelect: (dateKey: string) => void;
}) {
  // Days of the neighbouring months are context only: not focusable, not announced.
  if (!day.isCurrentMonth) {
    return (
      <div className="cal-day cal-day--outside" aria-hidden="true">
        <span className="cal-day-num"><span className="cal-day-num-badge">{day.dayOfMonth}</span></span>
      </div>
    );
  }

  const classNames = [
    'cal-day',
    isSelected && 'cal-day--selected',
    day.isToday && 'cal-day--today',
    !day.inPlan && 'cal-day--outside-plan',
    badge && 'cal-day--modified',
  ].filter(Boolean).join(' ');

  const intensityColor = day.planDay ? getIntensityColor(day.planDay) : 'transparent';
  const hasSync = !!day.syncMeta;
  const cross = day.syncMeta?.crossTraining;
  const noteIcon = day.planDay ? planDayIcon(day.planDay) : null;

  return (
    <button
      type="button"
      className={classNames}
      data-date={day.dateKey}
      aria-label={dayAriaLabel(day, badge)}
      aria-current={day.isToday ? 'date' : undefined}
      aria-expanded={isSelected}
      aria-controls={isSelected ? detailId : undefined}
      tabIndex={isFocusTarget ? 0 : -1}
      onClick={() => onSelect(day.dateKey)}
    >
      {/* Intensity bar at top */}
      <span className="cal-day-bar" style={{ background: intensityColor }} aria-hidden="true" />

      {/* Date number */}
      <span className="cal-day-num" aria-hidden="true">
        <span className="cal-day-num-badge">{day.dayOfMonth}</span>
        {day.planDay && day.planDay.type !== 'rest' && (
          <span className="cal-day-dot" style={{ background: intensityColor }} />
        )}
      </span>

      {/* Workout content */}
      {day.planDay && (
        <span className="cal-day-content" aria-hidden="true">
          <span className="cal-day-workout">
            {noteIcon && <span className="cal-day-icon">{noteIcon}</span>}{' '}
            {day.planDay.type === 'rest' ? 'Rest' : day.planDay.note || workoutTitle(day.planDay)}
          </span>
          {cross && day.syncMeta ? (
            <span className="cal-day-distance">
              <span style={{ color: 'var(--apollo-teal)' }}>
                {categoryIcon(cross.category)} {formatHoursMinutes(day.syncMeta.movingTimeSec)}
              </span>
            </span>
          ) : day.planDay.distanceMi != null && day.planDay.distanceMi > 0 && (
            <span className="cal-day-distance">
              {hasSync ? (
                <>
                  <span style={{ color: 'var(--apollo-gold)' }}>{formatMiles(day.syncMeta!.actualDistanceMi)}</span>
                  <span style={{ opacity: 0.5 }}>/</span>
                  <span>{formatMiles(day.planDay.distanceMi)}</span>
                </>
              ) : (
                <span>{formatMiles(day.planDay.distanceMi)}</span>
              )}
            </span>
          )}
          {/* Progress bar: actual vs planned (runs only) */}
          {hasSync && !cross && day.planDay.distanceMi != null && day.planDay.distanceMi > 0 && (
            <span className="cal-day-progress">
              <span
                className="cal-day-progress-fill"
                style={{
                  width: `${Math.min((day.syncMeta!.actualDistanceMi / day.planDay.distanceMi) * 100, 100)}%`,
                  background: day.syncMeta!.actualDistanceMi >= day.planDay.distanceMi * 0.95
                    ? 'var(--color-success)'
                    : 'var(--color-warning)',
                }}
              />
            </span>
          )}
          {badge && <span className="cal-day-badge">{badge}</span>}
        </span>
      )}

      {/* Status indicators */}
      {(day.completed || hasSync) && (
        <span className="cal-day-status" aria-hidden="true">
          {hasSync ? (
            <>
              <span className="cal-day-check cal-day-check--synced">✓</span>
              <span className="cal-day-sync-label">Synced</span>
            </>
          ) : day.completed ? (
            <span className="cal-day-check cal-day-check--done">✓</span>
          ) : null}
        </span>
      )}
    </button>
  );
});

// ─── WeekSummary Component ───────────────────────────────────

const WeekSummary = memo(function WeekSummary({
  row,
}: {
  row: CalendarWeekRow;
}) {
  if (!row.planWeekNum) {
    return <div className="cal-week-summary cal-week-summary--empty" aria-hidden="true"><span className="cal-week-label">—</span></div>;
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
        <div className="cal-week-bar" aria-hidden="true">
          <div className="cal-week-bar-fill" style={{ width: `${pct}%` }} />
        </div>
      )}
    </div>
  );
});

// ─── DayDetail Component ─────────────────────────────────────

function DayDetail({
  id,
  day,
  startDate,
  badge,
  actions,
  onClose,
  onToggle,
}: {
  id: string;
  day: CalendarDay;
  /** Plan start date — used to block ticking future days (T2a's canToggleDayCompletion). */
  startDate: string;
  badge: string | null;
  actions: ReactNode;
  onClose: () => void;
  onToggle: () => void;
}) {
  const { planDay, syncMeta, completed, weekIndex, dayIndex } = day;
  const toggleCheck = planDay && weekIndex != null && dayIndex != null
    ? canToggleDayCompletion(startDate, weekIndex, dayIndex, { completed, dayType: planDay.type })
    : null;
  const dayName = WEEKDAYS_LONG[weekdayMon0(day.dateKey)];

  // Find matching stored activity for route map (source-aware when the meta records its source)
  const matchedActivity = useMemo(() => {
    if (!syncMeta) return null;
    const matches = getStoredActivities().filter(a => a.id === syncMeta.activityId);
    if (matches.length <= 1 || !syncMeta.activitySource) return matches[0] ?? null;
    return matches.find(a => (a.source ?? 'strava') === syncMeta.activitySource) ?? matches[0];
  }, [syncMeta]);

  // Effort recognition (runs only)
  const effortRec = useMemo(() => {
    if (!syncMeta || syncMeta.crossTraining) return null;
    return getEffortRecognition(syncMeta.activityId);
  }, [syncMeta]);

  // Older metas have no activitySource — those came from Strava, which getSourceDisplayName defaults to.
  const sourceKey = matchedActivity?.source ?? syncMeta?.activitySource;
  const sourceLabel = getSourceDisplayName(sourceKey);
  const dateFormatted = formatLongDate(day.dateKey);
  const titleId = `${id}-title`;

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
    }
  };

  return (
    <div className="cal-detail" id={id} role="region" aria-labelledby={titleId} onKeyDown={onKeyDown}>
      <div className="cal-detail-header">
        <div>
          <h3 className="cal-detail-title" id={titleId}>
            {planDay ? (
              <>
                <span aria-hidden="true">{WORKOUT_ICONS[planDay.type]}</span> {workoutTitle(planDay)}
              </>
            ) : (
              dateFormatted
            )}
            {badge && <span className="cal-detail-badge">{badge}</span>}
          </h3>
          <div className="cal-detail-subtitle">
            {dateFormatted}
            {weekIndex != null && <> · Week {weekIndex + 1}, {dayName}</>}
          </div>
        </div>
        <button type="button" className="cal-detail-close" onClick={onClose} aria-label="Close day details">×</button>
      </div>

      {/* Plan vs Actual comparison */}
      {planDay && (
        <div className="cal-detail-compare">
          {/* Planned column */}
          <div className="cal-detail-col">
            <div className="cal-detail-col-label"><span aria-hidden="true">📋 </span>Planned</div>
            <div className="cal-detail-stat">
              <span className="cal-detail-stat-label">Workout</span>
              <span className="cal-detail-stat-value">{workoutTitle(planDay)}</span>
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
                  <span aria-hidden="true">{planDayIcon(planDay) || ''} </span>{planDay.note}
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
              {syncMeta ? <><span aria-hidden="true">⚡ </span>Actual ({sourceLabel})</> : <><span aria-hidden="true">⏳ </span>Actual</>}
            </div>
            {syncMeta?.crossTraining ? (
              <>
                <div className="cal-detail-stat">
                  <span className="cal-detail-stat-label">Sport</span>
                  <span className="cal-detail-stat-value" style={{ color: 'var(--apollo-teal)' }}>
                    <span aria-hidden="true">{categoryIcon(syncMeta.crossTraining.category)} </span>{syncMeta.crossTraining.label}
                  </span>
                </div>
                <div className="cal-detail-stat">
                  <span className="cal-detail-stat-label">Duration</span>
                  <span className="cal-detail-stat-value">{formatHoursMinutes(syncMeta.movingTimeSec)}</span>
                </div>
                {syncMeta.crossTraining.distanceMeters > 0 && (
                  <div className="cal-detail-stat">
                    <span className="cal-detail-stat-label">Distance</span>
                    <span className="cal-detail-stat-value">{formatDistanceShort(syncMeta.crossTraining.distanceMeters)}</span>
                  </div>
                )}
                {!!syncMeta.crossTraining.averageWatts && (
                  <div className="cal-detail-stat">
                    <span className="cal-detail-stat-label">Avg Power</span>
                    <span className="cal-detail-stat-value">{Math.round(syncMeta.crossTraining.averageWatts)} W</span>
                  </div>
                )}
                {!!syncMeta.crossTraining.averageHR && (
                  <div className="cal-detail-stat">
                    <span className="cal-detail-stat-label">Avg HR</span>
                    <span className="cal-detail-stat-value">{Math.round(syncMeta.crossTraining.averageHR)} bpm</span>
                  </div>
                )}
                {!!syncMeta.crossTraining.trainingLoad && (
                  <div className="cal-detail-stat">
                    <span className="cal-detail-stat-label">Load</span>
                    <span className="cal-detail-stat-value">{Math.round(syncMeta.crossTraining.trainingLoad)}</span>
                  </div>
                )}
              </>
            ) : syncMeta ? (
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
              <div className="cal-detail-empty">
                {day.inPlan ? 'No synced activity yet' : 'Outside plan range'}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Effort tier + tags */}
      {(effortRec?.paceTier || syncMeta || (completed && !syncMeta)) && (
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
              {sourceKey === 'file' ? 'Imported from a file' : `Synced via ${sourceLabel}`}
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

      {/* Toggle completion (for in-plan workout days) + day actions */}
      {planDay && weekIndex != null && dayIndex != null && (planDay.type !== 'rest' || actions) && (
        <div className="cal-detail-actions">
          {planDay.type !== 'rest' && (
            <button
              type="button"
              className={`btn ${completed ? 'btn-secondary' : 'btn-primary'}`}
              onClick={onToggle}
              disabled={toggleCheck ? !toggleCheck.allowed : false}
              aria-describedby={toggleCheck?.message ? `${id}-toggle-why` : undefined}
              style={{ fontSize: 'var(--text-sm)' }}
            >
              {completed ? 'Mark Incomplete' : 'Mark Complete'}
            </button>
          )}
          {planDay.type !== 'rest' && toggleCheck?.message && (
            <span id={`${id}-toggle-why`} className="cal-detail-hint">{toggleCheck.message}</span>
          )}
          {actions}
        </div>
      )}
    </div>
  );
}

// ─── Main CalendarView Component ─────────────────────────────

export default function CalendarView({ plan, active, onToggleDay, version = 0, renderDayActions, getDayBadge }: Props) {
  const [{ viewYear, viewMonth }, setView] = useState(() => {
    const m = initialMonth(plan, active);
    return { viewYear: m.year, viewMonth: m.month };
  });
  const [selectedDateKey, setSelectedDateKey] = useState<string | null>(null);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  /** Bumped after a toggle made here, so the grid re-reads completions without remounting. */
  const [localVersion, setLocalVersion] = useState(0);
  const gridRef = useRef<HTMLDivElement>(null);
  /** Date key whose button should receive focus after the next render. */
  const pendingFocusRef = useRef<string | null>(null);
  const baseId = useId().replace(/:/g, '');
  const todayKey = getTodayKey();

  // Build month grid (re-read when the plan, the month or the parent's data version changes)
  const rows = useMemo(
    () => buildMonthGrid(viewYear, viewMonth, plan, active, todayKey),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [viewYear, viewMonth, plan, active.startDate, todayKey, version, localVersion],
  );

  const monthDays = useMemo(() => rows.flatMap((r) => r.days).filter((d) => d.isCurrentMonth), [rows]);

  // Find selected day
  const selectedDay = useMemo(
    () => (selectedDateKey ? monthDays.find((d) => d.dateKey === selectedDateKey) ?? null : null),
    [selectedDateKey, monthDays],
  );

  // The single tabbable day: last focused/selected day, else today, else the first plan day, else the 1st.
  const rovingKey = useMemo(() => {
    const inMonth = (k: string | null) => !!k && monthDays.some((d) => d.dateKey === k);
    if (inMonth(focusKey)) return focusKey as string;
    if (inMonth(selectedDateKey)) return selectedDateKey as string;
    if (inMonth(todayKey)) return todayKey;
    return (monthDays.find((d) => d.inPlan) ?? monthDays[0])?.dateKey ?? null;
  }, [focusKey, selectedDateKey, todayKey, monthDays]);

  useEffect(() => {
    const key = pendingFocusRef.current;
    if (!key) return;
    pendingFocusRef.current = null;
    gridRef.current?.querySelector<HTMLButtonElement>(`button[data-date="${key}"]`)?.focus();
  });

  const showMonthOf = useCallback((key: string) => {
    const d = parseDateKey(key);
    setView((v) => (v.viewYear === d.getFullYear() && v.viewMonth === d.getMonth()
      ? v
      : { viewYear: d.getFullYear(), viewMonth: d.getMonth() }));
  }, []);

  // Month navigation
  const goToPrevMonth = useCallback(() => {
    setView(({ viewYear: y, viewMonth: m }) => (m === 0 ? { viewYear: y - 1, viewMonth: 11 } : { viewYear: y, viewMonth: m - 1 }));
  }, []);

  const goToNextMonth = useCallback(() => {
    setView(({ viewYear: y, viewMonth: m }) => (m === 11 ? { viewYear: y + 1, viewMonth: 0 } : { viewYear: y, viewMonth: m + 1 }));
  }, []);

  const goToToday = useCallback(() => {
    const key = getTodayKey();
    showMonthOf(key);
    setSelectedDateKey(key);
    setFocusKey(key);
  }, [showMonthOf]);

  const handleSelect = useCallback((dateKey: string) => {
    setFocusKey(dateKey);
    setSelectedDateKey((prev) => (prev === dateKey ? null : dateKey));
  }, []);

  const handleClose = useCallback(() => {
    setSelectedDateKey((prev) => {
      if (prev) pendingFocusRef.current = prev;
      return null;
    });
  }, []);

  const handleToggle = useCallback(() => {
    if (!selectedDay || selectedDay.weekIndex == null || selectedDay.dayIndex == null) return;
    onToggleDay(selectedDay.weekIndex, selectedDay.dayIndex);
    // Re-read completions; the grid keeps its DOM (and focus) because it is keyed by month only.
    setLocalVersion((v) => v + 1);
  }, [selectedDay, onToggleDay]);

  /** Arrow keys move between days (crossing into the next/previous month); Home/End go to the week's ends. */
  const onGridKeyDown = useCallback((e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      handleClose();
      return;
    }
    const target = e.target as HTMLElement;
    const from = target.getAttribute?.('data-date');
    if (!from || target.tagName !== 'BUTTON') return;
    if (e.key === 'Enter') {
      // Handled here (not via the native button click) so it toggles exactly once everywhere.
      e.preventDefault();
      handleSelect(from);
      return;
    }
    const deltas: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    let next: string | null = null;
    if (e.key in deltas) next = addDays(from, deltas[e.key]);
    else if (e.key === 'Home') next = mondayOf(from);
    else if (e.key === 'End') next = addDays(mondayOf(from), 6);
    if (!next) return;
    e.preventDefault();
    pendingFocusRef.current = next;
    setFocusKey(next);
    showMonthOf(next);
  }, [showMonthOf, handleClose, handleSelect]);

  const monthLabel = new Date(viewYear, viewMonth).toLocaleDateString(undefined, {
    month: 'long',
    year: 'numeric',
  });

  const detailId = `${baseId}-detail`;
  const monthKey = `${viewYear}-${viewMonth}`;
  const selectedBadge = selectedDay && selectedDay.weekIndex != null && selectedDay.dayIndex != null
    ? getDayBadge?.(selectedDay.weekIndex, selectedDay.dayIndex) ?? null
    : null;
  const selectedActions = selectedDay && selectedDay.weekIndex != null && selectedDay.dayIndex != null && renderDayActions
    ? renderDayActions({ weekIndex: selectedDay.weekIndex, dayIndex: selectedDay.dayIndex, dateKey: selectedDay.dateKey })
    : null;

  return (
    <div className="cal">
      {/* Month navigation */}
      <div className="cal-nav">
        <h3 className="cal-nav-title" id={`${baseId}-month`} aria-live="polite">{monthLabel}</h3>
        <div className="cal-nav-btns">
          <button type="button" className="cal-nav-today" onClick={goToToday}>Today</button>
          <button type="button" className="cal-nav-btn" onClick={goToPrevMonth} aria-label="Previous month">‹</button>
          <button type="button" className="cal-nav-btn" onClick={goToNextMonth} aria-label="Next month">›</button>
        </div>
      </div>
      <p className="cal-sr-only" id={`${baseId}-hint`}>
        Use the arrow keys to move between days. Press Enter to open a day.
      </p>

      {/* Weekday headers */}
      <div className="cal-header" aria-hidden="true">
        {WEEKDAYS.map(d => (
          <div key={d} className="cal-header-day">{d}</div>
        ))}
        <div className="cal-header-summary">Week</div>
      </div>

      {/* Calendar grid — keyed by month so it only remounts (and animates) when the month changes */}
      <div
        className="cal-grid cal-month-enter"
        key={monthKey}
        ref={gridRef}
        role="group"
        aria-labelledby={`${baseId}-month`}
        aria-describedby={`${baseId}-hint`}
        onKeyDown={onGridKeyDown}
      >
        {rows.map((row, rowIdx) => (
          <Fragment key={row.days[0].dateKey}>
            {row.days.map((day) => (
              <DayCell
                key={day.dateKey}
                day={day}
                isSelected={day.dateKey === selectedDateKey}
                isFocusTarget={day.dateKey === rovingKey}
                badge={day.weekIndex != null && day.dayIndex != null ? getDayBadge?.(day.weekIndex, day.dayIndex) ?? null : null}
                detailId={detailId}
                onSelect={handleSelect}
              />
            ))}
            <WeekSummary row={row} />

            {/* Day detail panel — inserted after the row containing the selected day */}
            {selectedDay && row.days.some((d) => d.dateKey === selectedDay.dateKey) && (
              <DayDetail
                key={`detail-${selectedDay.dateKey}-${rowIdx}`}
                id={detailId}
                day={selectedDay}
                startDate={active.startDate}
                badge={selectedBadge}
                actions={selectedActions}
                onClose={handleClose}
                onToggle={handleToggle}
              />
            )}
          </Fragment>
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
          <span className="cal-day-check cal-day-check--synced cal-legend-check" aria-hidden="true">✓</span>
          Synced
        </div>
        <div className="cal-legend-item">
          <span className="cal-day-check cal-day-check--done cal-legend-check" aria-hidden="true">✓</span>
          Completed
        </div>
      </div>
    </div>
  );
}
