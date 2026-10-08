/**
 * Race-date-first plan setup (v1.0.6), shared by onboarding (WelcomeFlow) and the
 * Plan page's "Start / Switch plan" flow.
 *
 * The primary input is the race date: the plan is placed so its race day lands
 * on that date (`placePlan`), and the live preview says when week 1 starts and —
 * when the race is too close for the full plan — which week the athlete joins
 * at. "Advanced: choose a start date" keeps the old start-date flow; start dates
 * snap to the Monday of their week (shown in the preview).
 *
 * Persisting is the caller's job: `planSetupToStartInput()` → `previewStartPlan()`
 * (confirm when progress would be cleared) → `startPlan()`.
 */

import type { TrainingPlan } from '../../data/plans';
import {
  getDateKeyForDay,
  getRaceDayRef,
  placePlan,
  snapToMonday,
} from '../../services/planProgress';
import type { StartPlanInput } from '../../services/planProgress';
import { getRaceDate } from '../../services/journey';
import { getMyRace } from '../../services/myRace';
import { daysBetween, isDateKey, todayKey } from '../../utils/localDate';
import { formatLongDate } from './planDisplay';
import './plan.css';

export interface PlanSetupValue {
  /** Goal race date, 'YYYY-MM-DD' ('' when not set). */
  raceDate: string;
  /** "Advanced: choose a start date" instead of placing by race date. */
  useStartDate: boolean;
  /** Explicit start date ('YYYY-MM-DD', snapped to Monday by startPlan); '' when not set. */
  startDate: string;
}

/** Initial value: the race date is prefilled from the journey / My Race (future dates only). */
export function initialPlanSetupValue(today: string = todayKey()): PlanSetupValue {
  const candidates = [getRaceDate(), getMyRace().date];
  const raceDate = candidates.find((d): d is string => isDateKey(d) && daysBetween(today, d) >= 0) ?? '';
  return { raceDate, useStartDate: false, startDate: '' };
}

/** Why the value can't be used yet, or null when it's complete. */
export function planSetupError(v: PlanSetupValue, today: string = todayKey()): string | null {
  if (v.useStartDate) {
    return isDateKey(v.startDate) ? null : 'Choose a start date.';
  }
  if (!isDateKey(v.raceDate)) return 'Choose your race date.';
  if (daysBetween(today, v.raceDate) < 0) return 'That race date is in the past.';
  return null;
}

/** `startPlan` input for the value, or null while it's incomplete or invalid. */
export function planSetupToStartInput(planId: string, v: PlanSetupValue, today: string = todayKey()): StartPlanInput | null {
  if (planSetupError(v, today)) return null;
  return v.useStartDate ? { planId, startDate: v.startDate } : { planId, raceDate: v.raceDate };
}

export interface RaceDatePlanSetupProps {
  /** The (base) plan that would be started. */
  plan: TrainingPlan;
  value: PlanSetupValue;
  onChange: (value: PlanSetupValue) => void;
  /** Prefix for element ids (must be unique on the page). */
  idPrefix: string;
  /** Override "today" (tests). */
  today?: string;
}

function weeksLabel(n: number): string {
  return `${n} week${n === 1 ? '' : 's'}`;
}

function PlacementPreview({ plan, value, today }: { plan: TrainingPlan; value: PlanSetupValue; today: string }) {
  const raceRef = getRaceDayRef(plan);
  const planWeeks = raceRef.weekIndex + 1;
  const error = planSetupError(value, today);

  if (value.useStartDate) {
    if (error) return <p className="plan-setup-muted">{error}</p>;
    const start = snapToMonday(value.startDate);
    const raceDay = getDateKeyForDay(start, raceRef.weekIndex, raceRef.dayIndex);
    const snapped = start !== value.startDate;
    const elapsedWeeks = Math.floor(daysBetween(start, today) / 7);
    return (
      <>
        <p className="plan-setup-summary">
          Week 1 starts <strong>{formatLongDate(start)}</strong> · race day <strong>{formatLongDate(raceDay)}</strong>
        </p>
        <ul className="plan-setup-notes">
          {snapped && <li>Plans start on a Monday, so your start date snaps to {formatLongDate(start)}.</li>}
          {elapsedWeeks > 0 && elapsedWeeks < planWeeks && (
            <li>That start date is in the past — you’ll join at week {elapsedWeeks + 1}.</li>
          )}
          {elapsedWeeks >= planWeeks && <li>That whole plan would already be over — pick a later start date.</li>}
        </ul>
      </>
    );
  }

  if (error) return <p className="plan-setup-muted">{error === 'Choose your race date.' ? 'Pick your race date to see when the plan starts.' : error}</p>;

  const placement = placePlan(plan, value.raceDate, today);
  return (
    <>
      <p className="plan-setup-summary">
        {placement.fits ? (
          <>
            The full {weeksLabel(planWeeks)} fit — week 1 starts <strong>{formatLongDate(placement.startDate)}</strong>.
          </>
        ) : (
          <>
            You join at <strong>week {placement.joinWeekIndex + 1} of {planWeeks}</strong> ({weeksLabel(placement.weeksAvailable)} to go).
          </>
        )}
      </p>
      <p className="plan-setup-muted">Race day: {formatLongDate(placement.raceDate)}</p>
      {placement.notes.length > 0 && (
        <ul className="plan-setup-notes">
          {placement.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      )}
    </>
  );
}

/** Race date input + live placement preview + optional start date. */
export function RaceDatePlanSetup({ plan, value, onChange, idPrefix, today = todayKey() }: RaceDatePlanSetupProps) {
  const raceId = `${idPrefix}-race-date`;
  const advId = `${idPrefix}-use-start-date`;
  const startId = `${idPrefix}-start-date`;
  const previewId = `${idPrefix}-placement`;

  return (
    <div className="plan-setup">
      <div className="plan-setup-field">
        <label htmlFor={raceId}>Race date</label>
        <input
          id={raceId}
          type="date"
          className="plan-setup-input"
          value={value.raceDate}
          min={today}
          disabled={value.useStartDate}
          aria-describedby={previewId}
          onChange={(e) => onChange({ ...value, raceDate: e.target.value })}
        />
      </div>

      <div className="plan-setup-check">
        <input
          id={advId}
          type="checkbox"
          checked={value.useStartDate}
          onChange={(e) => onChange({ ...value, useStartDate: e.target.checked })}
        />
        <label htmlFor={advId}>Advanced: choose a start date instead</label>
      </div>

      {value.useStartDate && (
        <div className="plan-setup-field">
          <label htmlFor={startId}>Start date</label>
          <input
            id={startId}
            type="date"
            className="plan-setup-input"
            value={value.startDate}
            aria-describedby={previewId}
            onChange={(e) => onChange({ ...value, startDate: e.target.value })}
          />
          <p className="plan-setup-muted">Plans start on a Monday — other days snap to the Monday of that week.</p>
        </div>
      )}

      <div id={previewId} className="plan-setup-preview" role="status" aria-live="polite">
        <PlacementPreview plan={plan} value={value} today={today} />
      </div>
    </div>
  );
}

export default RaceDatePlanSetup;
