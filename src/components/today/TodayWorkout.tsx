import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { PlanDay, TrainingPlan } from '../../data/plans';
import type { Activity } from '../../services/activitySource';
import { canToggleDayCompletion, toggleDayCompleted, type SyncMeta } from '../../services/planProgress';
import { restoreDay, skipWorkout } from '../../services/planOverlay';
import type { SyncResult } from '../../services/autoSync';
import { formatHoursMinutes } from '../../services/crossTraining';
import { getSportCategoryIcon, getSportIcon, getSportLabel, SPORT_CATEGORIES, type SportCategory } from '../../services/activity/sports';
import { formatDistanceShort, formatMiles, formatPaceFromMinPerMi } from '../../services/unitPreferences';
import RouteMap from '../RouteMap';
import { DayActionsMenu } from '../plan/DayActionsMenu';
import { isWorkoutDay, workoutSummary, workoutTitle } from '../plan/planDisplay';
import { firstSentence, formatPaceRangeSecPerMi, formatWeekdayDate, targetForDay, type TodayVdot } from './todayModel';

export interface TodayWorkoutProps {
  /** The effective plan (getEffectivePlan()); read-only. */
  plan: TrainingPlan;
  planId: string;
  weekIndex: number;
  dayIndex: number;
  /** Local date key of the day. */
  dateKey: string;
  /** Start date of the active plan (for the Mark done guard). */
  startDate: string;
  /** h2 when the workout is the hero itself, h3 under a phase banner. */
  headingLevel: 2 | 3;
  completed: boolean;
  syncMeta: SyncMeta | null;
  vdot: TodayVdot | null;
  /** The activity that fulfilled the day (for the route map). */
  activity?: Activity;
  /** Latest plan matches from a sync (max 3 shown). */
  syncResults?: SyncResult[];
  taper?: boolean;
}

interface Status {
  text: string;
  error: boolean;
}

/** Icon for a stored cross-training category (falls back safely for unknown values). */
function categoryIcon(category: string): string {
  return (SPORT_CATEGORIES as readonly string[]).includes(category)
    ? getSportCategoryIcon(category as SportCategory)
    : '⚡';
}

/** True when the OS asks for reduced motion (JS-driven animation must honour it). */
function prefersReducedMotion(): boolean {
  try {
    return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/** Unit-free title of the workout a skipped/converted day replaced. */
function originalTitle(day: PlanDay): string {
  if (!day.originalLabel) return 'workout';
  return workoutTitle({ type: 'run', label: day.originalLabel }).toLowerCase();
}

/** What was done: run stats or the cross-training summary, plus the coach feedback. */
function WorkoutResult({ meta }: { meta: SyncMeta }) {
  const ct = meta.crossTraining;
  return (
    <div className="today-result">
      <p className="today-result-stats">
        {ct ? (
          <>
            <span className="today-result-main today-result-main--cross">
              <span aria-hidden="true">{categoryIcon(ct.category)} </span>{ct.label}
            </span>
            <span>{formatHoursMinutes(meta.movingTimeSec)}</span>
            {ct.distanceMeters > 0 && <span>{formatDistanceShort(ct.distanceMeters)}</span>}
            {ct.averageHR != null && ct.averageHR > 0 && <span>{Math.round(ct.averageHR)} bpm</span>}
          </>
        ) : (
          <>
            <span className="today-result-main">{formatMiles(meta.actualDistanceMi)}</span>
            <span>{formatPaceFromMinPerMi(meta.actualPaceMinPerMi)} pace</span>
            <span>{formatHoursMinutes(meta.movingTimeSec)}</span>
          </>
        )}
      </p>
      {meta.feedback && <p className="today-result-feedback">{meta.feedback}</p>}
    </div>
  );
}

/**
 * Today's workout from the effective plan: title, personal pace range + HR zone,
 * result after a sync, and the Mark done / Skip / Move actions. Every action
 * result is announced in a polite live region that stays mounted.
 */
export default function TodayWorkout(props: TodayWorkoutProps) {
  const { plan, planId, weekIndex, dayIndex, dateKey, startDate, headingLevel, completed, syncMeta, vdot, activity, syncResults, taper } = props;
  const [status, setStatus] = useState<Status>({ text: '', error: false });
  const day = plan.weeks[weekIndex]?.days[dayIndex];
  const Heading = headingLevel === 2 ? 'h2' : 'h3';
  const headingId = `today-workout-${weekIndex}-${dayIndex}`;
  const ref = { weekIndex, dayIndex };
  const dayLabel = formatWeekdayDate(dateKey);

  if (!day) {
    return (
      <div className="today-workout">
        <Heading className="today-hero-title">Nothing scheduled today</Heading>
        <p className="today-text">Your plan has no session for today. <Link to="/plan">Open your plan</Link></p>
      </div>
    );
  }

  // S4: future and rest/skipped days can't be ticked by hand; unticking is always allowed.
  const doneCheck = canToggleDayCompletion(startDate, weekIndex, dayIndex, { completed, dayType: day.type });
  const doneHintId = `${headingId}-done-hint`;

  const toggleDone = () => {
    if (!doneCheck.allowed) return;
    const next = toggleDayCompleted(planId, weekIndex, dayIndex);
    setStatus({ text: next ? 'Marked as done. Nice work!' : 'Marked as not done.', error: false });
  };

  const skip = () => {
    const result = skipWorkout(ref);
    setStatus(result.ok
      ? { text: 'Workout skipped. You can restore it from the menu or the Plan page.', error: false }
      : { text: result.error ?? 'This workout can’t be skipped.', error: true });
  };

  const restore = () => {
    const result = restoreDay(ref);
    setStatus(result.ok
      ? { text: 'Workout restored.', error: false }
      : { text: result.error ?? 'This day can’t be restored.', error: true });
  };

  const onMenuChanged = (message: string) => setStatus({ text: message, error: false });

  const statusRegion = (
    <p role="status" aria-live="polite" className={`today-status${status.error ? ' today-status--error' : ''}`}>
      {status.text}
    </p>
  );

  const menu = <DayActionsMenu plan={plan} weekIndex={weekIndex} dayIndex={dayIndex} dayLabel={dayLabel} onChanged={onMenuChanged} />;

  // Skipped day: rest with the option to bring the workout back.
  if (day.skipped) {
    return (
      <div className="today-workout" aria-labelledby={headingId}>
        <Heading id={headingId} className="today-hero-title">Workout skipped</Heading>
        <p className="today-text">You skipped today’s {originalTitle(day)}. Rest up, or bring it back if plans change.</p>
        <div className="today-actions">
          <button type="button" className="btn btn-secondary" onClick={restore}>Restore workout</button>
          {menu}
        </div>
        {statusRegion}
      </div>
    );
  }

  // Rest day: friendly copy, no completion (rest days can't be ticked off — B6).
  if (!isWorkoutDay(day)) {
    return (
      <div className="today-workout" aria-labelledby={headingId}>
        <Heading id={headingId} className="today-hero-title">Rest day</Heading>
        <p className="today-text">
          Recovery is part of training: sleep well, eat well and keep any movement easy. Your legs will thank you tomorrow.
        </p>
        <div className="today-actions">
          {menu}
          <Link to="/plan" className="today-link">Open your plan</Link>
        </div>
        {statusRegion}
      </div>
    );
  }

  const target = targetForDay(day, vdot?.vdot ?? null);
  const range = target?.targetPaceRange;
  const purpose = firstSentence(target?.description);

  return (
    <div className="today-workout" aria-labelledby={headingId}>
      <p className="today-eyebrow">Today’s workout</p>
      <Heading id={headingId} className="today-hero-title">{workoutSummary(day)}</Heading>
      <div className="today-badges">
        {completed && <span className="today-badge today-badge--done">Completed</span>}
        {syncMeta && <span className="today-badge">{syncMeta.activitySource === 'file' ? 'Imported' : 'Auto-synced'}</span>}
        {taper && <span className="today-badge today-badge--taper">Taper</span>}
      </div>

      {range ? (
        <ul className="today-targets" aria-label="Targets">
          <li className="today-target">
            <span className="today-target-label">Target pace</span>
            <span className="today-target-value">{formatPaceRangeSecPerMi(range.minSecPerMi, range.maxSecPerMi)}</span>
          </li>
          {target?.hrZone != null && (
            <li className="today-target">
              <span className="today-target-label">Heart rate</span>
              <span className="today-target-value">Zone {target.hrZone}</span>
            </li>
          )}
        </ul>
      ) : !vdot && day.type !== 'cross' ? (
        <p className="today-purpose">
          <Link to="/settings?tab=profile">Add a recent race in Settings › Athlete Profile for personal paces</Link>
        </p>
      ) : null}
      {purpose && <p className="today-purpose">{purpose}</p>}
      {taper && (
        <p className="today-purpose">Taper: less volume so you arrive fresh. Keep easy runs easy and trust your training.</p>
      )}

      {syncMeta && <WorkoutResult meta={syncMeta} />}
      {syncMeta && activity?.map?.summary_polyline && (
        <div className="today-map">
          <RouteMap activity={activity} size="card" colorMode={syncMeta.crossTraining ? 'teal' : 'apollo'} animate={!prefersReducedMotion()} />
        </div>
      )}

      {syncResults && syncResults.length > 0 && (
        <ul className="today-sync-list" aria-label="Latest synced workouts">
          {syncResults.slice(0, 3).map((r) => (
            <li key={`${r.weekIndex}-${r.dayIndex}-${r.activity.id}`}>
              <strong>{r.isNew ? 'Auto-completed' : 'Synced'}:</strong>{' '}
              {workoutTitle(r.plannedDay)} — {r.isCrossTraining
                ? <><span aria-hidden="true">{getSportIcon(r.activity)} </span>{getSportLabel(r.activity)} · {formatHoursMinutes(r.activity.moving_time || r.activity.elapsed_time)}</>
                : formatMiles(r.actualDistanceMi)}
            </li>
          ))}
        </ul>
      )}

      <div className="today-actions">
        <button
          type="button"
          className={`btn ${completed ? 'today-btn-pressed' : 'btn-primary'}`}
          aria-pressed={completed}
          disabled={!doneCheck.allowed}
          title={doneCheck.message}
          aria-describedby={!doneCheck.allowed && doneCheck.message ? doneHintId : undefined}
          onClick={toggleDone}
        >
          {completed ? <><span aria-hidden="true">✓ </span>Done</> : 'Mark done'}
        </button>
        {!completed && (
          <button type="button" className="btn btn-secondary" onClick={skip}>Skip</button>
        )}
        {menu}
        <Link to="/plan" className="today-link">Open your plan</Link>
      </div>
      {!doneCheck.allowed && doneCheck.message && (
        <p id={doneHintId} className="today-muted">{doneCheck.message}</p>
      )}
      {statusRegion}
    </div>
  );
}
