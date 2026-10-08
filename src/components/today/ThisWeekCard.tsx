import type { WeeklyMileage } from '../../services/autoSync';
import type { TrainingAdherence } from '../../services/racePrediction';
import type { ReadinessScore } from '../../services/weeklyReadiness';
import { formatMiles } from '../../services/unitPreferences';
import type { ProgressStats } from '../plan/planDisplay';
import ProgressBar, { type ProgressTone } from './ProgressBar';

export interface ThisWeekCardProps {
  weeklyMileage: WeeklyMileage | null;
  /** Workout-day progress of the whole plan (rest days excluded — B6). */
  planProgress: ProgressStats | null;
  adherence: TrainingAdherence | null;
  readiness: ReadinessScore | null;
}

function mileageTone(status: WeeklyMileage['status']): ProgressTone {
  if (status === 'on_track' || status === 'ahead') return 'good';
  return status === 'behind' ? 'warn' : 'bad';
}

/** "This week" strip: weekly volume vs plan, plan progress, adherence and readiness grade. */
export default function ThisWeekCard({ weeklyMileage, planProgress, adherence, readiness }: ThisWeekCardProps) {
  const showMileage = !!weeklyMileage && weeklyMileage.plannedMi > 0;
  if (!showMileage && !planProgress && !adherence && !readiness) return null;
  return (
    <section className="card" aria-labelledby="today-week-title">
      <h2 id="today-week-title" className="today-section-title">This week</h2>
      {showMileage && weeklyMileage && (
        <ProgressBar
          label="Weekly distance"
          pct={(weeklyMileage.actualMi / weeklyMileage.plannedMi) * 100}
          valueText={`${formatMiles(weeklyMileage.actualMi)} of ${formatMiles(weeklyMileage.plannedMi)}`}
          note={weeklyMileage.message}
          tone={mileageTone(weeklyMileage.status)}
        />
      )}
      {planProgress && planProgress.total > 0 && (
        <ProgressBar
          label="Plan progress"
          pct={planProgress.pct}
          valueText={`${planProgress.completed} of ${planProgress.total} workouts`}
        />
      )}
      {(adherence || readiness) && (
        <dl className="today-stats">
          {adherence && (
            <div className="today-stat">
              <dt>Adherence</dt>
              <dd>{adherence.score}% · {adherence.rating}</dd>
            </div>
          )}
          {readiness && (
            <div className="today-stat">
              <dt>Readiness wk {readiness.weekNumber}</dt>
              <dd>{readiness.grade} · {readiness.score}/100</dd>
            </div>
          )}
        </dl>
      )}
    </section>
  );
}
