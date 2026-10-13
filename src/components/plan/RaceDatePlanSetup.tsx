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

import { useMemo } from 'react';
import { BUILT_IN_PLANS } from '../../data/plans';
import type { TrainingPlan } from '../../data/plans';
import {
  checkJoinFitness,
  getDateKeyForDay,
  getRaceDayRef,
  placePlan,
  saferPlansForRace,
  snapToMonday,
  summarizeRecentFitness,
} from '../../services/planProgress';
import type { RecentFitness, StartPlanInput } from '../../services/planProgress';
import { getRaceDate } from '../../services/journey';
import { getMyRace } from '../../services/myRace';
import { getStoredActivities } from '../../services/analyticsService';
import { isRunActivity } from '../../services/activity/sports';
import { dateKeyFromLocalIso, daysBetween, isDateKey, todayKey } from '../../utils/localDate';
import { formatLongDate } from './planDisplay';
import './plan.css';

const METERS_PER_MILE = 1609.344;

/**
 * v1.0.7 (T-3): the runner's recent weekly volume and 30-day longest run from
 * stored activities, or null with too little data. Never throws.
 */
export function readRecentFitness(today: string = todayKey()): RecentFitness | null {
  try {
    const runs = getStoredActivities()
      .filter((a) => isRunActivity(a))
      .map((a) => ({ date: dateKeyFromLocalIso(a.start_date_local) ?? '', miles: (a.distance || 0) / METERS_PER_MILE }));
    return summarizeRecentFitness(runs, today);
  } catch {
    return null;
  }
}

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
  /**
   * v1.0.7 (T-3): recent training for the join check. Omitted → read from stored
   * activities; null → no data (no check).
   */
  fitness?: RecentFitness | null;
  /** v1.0.7 (T-3): switch to a gentler plan offered by the join check. Without it, plan names are listed. */
  onChoosePlan?: (planId: string) => void;
  /** Plans the join check may offer instead (default: the built-in plans). */
  candidatePlans?: readonly TrainingPlan[];
}

function weeksLabel(n: number): string {
  return `${n} week${n === 1 ? '' : 's'}`;
}

/**
 * v1.0.7 (T-3): warns when the plan week the runner would join is an unsafe jump
 * from their recent training, and offers a later race, a ramp-in or a gentler plan.
 */
function JoinFitnessWarning({
  plan,
  value,
  onChange,
  today,
  fitness,
  onChoosePlan,
  candidatePlans,
  idPrefix,
}: {
  plan: TrainingPlan;
  value: PlanSetupValue;
  onChange: (value: PlanSetupValue) => void;
  today: string;
  fitness: RecentFitness | null;
  onChoosePlan?: (planId: string) => void;
  candidatePlans: readonly TrainingPlan[];
  idPrefix: string;
}) {
  if (value.useStartDate || planSetupError(value, today) || !fitness) return null;
  const placement = placePlan(plan, value.raceDate, today);
  const check = checkJoinFitness(plan, placement, fitness);
  if (!check || check.safe) return null;
  const safer = saferPlansForRace(candidatePlans, value.raceDate, fitness, plan.id, today).slice(0, 3);
  const titleId = `${idPrefix}-fitness-title`;
  return (
    <section className="plan-setup-warning" aria-labelledby={titleId}>
      <p id={titleId} className="plan-setup-warning-title">
        <strong>Week {check.joinWeekIndex + 1} is a big jump from your recent training</strong>
      </p>
      <ul className="plan-setup-notes">
        {check.issues.map((issue) => (
          <li key={issue}>{issue}</li>
        ))}
      </ul>
      <p className="plan-setup-muted">Big jumps in volume or long-run distance raise injury risk. Some safer options:</p>
      <ul className="plan-setup-options">
        {check.laterRaceDate && (
          <li>
            <strong>A later race.</strong> Racing on {formatLongDate(check.laterRaceDate)} lets you join at an easier week.{' '}
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => onChange({ ...value, raceDate: check.laterRaceDate! })}>
              Use {formatLongDate(check.laterRaceDate)}
            </button>
          </li>
        )}
        {check.rampIn && (
          <li>
            <strong>A ramp-in.</strong> Keep this race, but for the first {weeksLabel(check.rampIn.weeklyMiles.length)} run about{' '}
            {check.rampIn.weeklyMiles.join(', ')} mi a week, with long runs of at most {check.rampIn.longRunMi.join(', ')} mi. Then follow the plan in full.
          </li>
        )}
        {safer.length > 0 ? (
          <li>
            <strong>A gentler plan</strong> for this race date:{' '}
            {onChoosePlan
              ? safer.map((p, i) => (
                  <span key={p.id}>
                    {i > 0 && ' '}
                    <button type="button" className="btn btn-secondary btn-sm" onClick={() => onChoosePlan(p.id)}>
                      {p.author} {p.name}
                    </button>
                  </span>
                ))
              : safer.map((p) => `${p.author} ${p.name}`).join(', ')}
          </li>
        ) : (
          !check.laterRaceDate && <li>No plan here starts gently enough for this race date. Consider a later race or a shorter goal race.</li>
        )}
      </ul>
    </section>
  );
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
export function RaceDatePlanSetup({
  plan,
  value,
  onChange,
  idPrefix,
  today = todayKey(),
  fitness,
  onChoosePlan,
  candidatePlans = BUILT_IN_PLANS,
}: RaceDatePlanSetupProps) {
  const raceId = `${idPrefix}-race-date`;
  const advId = `${idPrefix}-use-start-date`;
  const startId = `${idPrefix}-start-date`;
  const previewId = `${idPrefix}-placement`;
  // v1.0.7 (T-3): recent training for the join check (read from stored activities unless given).
  const storedFitness = useMemo(() => (fitness === undefined ? readRecentFitness(today) : null), [fitness, today]);
  const recentFitness = fitness === undefined ? storedFitness : fitness;

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

      <JoinFitnessWarning
        plan={plan}
        value={value}
        onChange={onChange}
        today={today}
        fitness={recentFitness}
        onChoosePlan={onChoosePlan}
        candidatePlans={candidatePlans}
        idPrefix={idPrefix}
      />
    </div>
  );
}

export default RaceDatePlanSetup;
