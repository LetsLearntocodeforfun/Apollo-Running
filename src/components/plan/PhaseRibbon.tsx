/**
 * Phase ribbon for the Plan page (v1.0.6): the effective plan's periodization
 * phases (detectPhases) as a horizontal ribbon whose segments are sized by their
 * number of weeks, with a "You are here" marker on today's phase. Every segment
 * carries its name and week range as text, so colour is never the only cue.
 */

import { useId, useMemo } from 'react';
import type { TrainingPlan } from '../../data/plans';
import { detectPhases } from '../../services/periodization';
import type { TrainingPhase } from '../../services/periodization';
import './plan.css';

export interface PhaseRibbonProps {
  /** The effective plan (getEffectivePlan()). */
  plan: TrainingPlan;
  /** Today's 0-based plan week, or null outside the plan. */
  currentWeekIndex: number | null;
  /** Heading level of the ribbon title (default 2). */
  headingLevel?: 2 | 3;
}

function weekRange(p: TrainingPhase): string {
  return p.startWeek === p.endWeek ? `Week ${p.startWeek + 1}` : `Weeks ${p.startWeek + 1}–${p.endWeek + 1}`;
}

export function PhaseRibbon({ plan, currentWeekIndex, headingLevel = 2 }: PhaseRibbonProps) {
  const titleId = `phase-ribbon-${useId().replace(/:/g, '')}`;
  const phases = useMemo(() => detectPhases(plan), [plan]);
  if (phases.length === 0) return null;

  const current =
    currentWeekIndex == null ? null : phases.find((p) => currentWeekIndex >= p.startWeek && currentWeekIndex <= p.endWeek) ?? null;
  const Heading = headingLevel === 3 ? 'h3' : 'h2';

  return (
    <section className="phase-ribbon" aria-labelledby={titleId}>
      <Heading id={titleId} className="phase-ribbon-title">
        Training phases
      </Heading>
      <ol className="phase-ribbon-track">
        {phases.map((p) => {
          const weeks = p.endWeek - p.startWeek + 1;
          const isCurrent = current === p;
          return (
            <li
              key={`${p.name}-${p.startWeek}`}
              className={`phase-ribbon-seg phase-ribbon-seg--${p.name}${isCurrent ? ' phase-ribbon-seg--current' : ''}`}
              style={{ flex: `${weeks} 1 0` }}
              aria-current={isCurrent ? 'step' : undefined}
              title={`${p.label}: ${weekRange(p).toLowerCase()}`}
            >
              <span className="phase-ribbon-name">{p.label}</span>
              <span className="phase-ribbon-weeks">{weekRange(p)}</span>
              {isCurrent && currentWeekIndex != null && (
                <span className="phase-ribbon-here">
                  <span aria-hidden="true">▲ </span>You are here · week {currentWeekIndex + 1}
                </span>
              )}
            </li>
          );
        })}
      </ol>
      {current && <p className="phase-ribbon-message">{current.coachingMessage}</p>}
    </section>
  );
}

export default PhaseRibbon;
