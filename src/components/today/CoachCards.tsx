import { Link } from 'react-router-dom';
import type { DailyRecap } from '../../services/dailyRecap';
import type { ReadinessScore } from '../../services/weeklyReadiness';
import { formatMiles, formatPaceFromMinPerMi } from '../../services/unitPreferences';

function DismissButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" className="today-dismiss" aria-label={label} onClick={onClick}>
      <span aria-hidden="true">✕</span>
    </button>
  );
}

const RECAP_TONE: Record<string, string> = {
  outstanding: 'today-coach--good',
  strong: 'today-coach--ok',
  missed: 'today-coach--warn',
};

const RECAP_GRADE_LABEL: Record<string, string> = {
  outstanding: 'Outstanding',
  strong: 'Strong',
  solid: 'Solid',
  missed: 'Missed',
  pending: 'Still to do',
  rest_day: 'Rest day',
};

export interface DailyRecapCardProps {
  recap: DailyRecap;
  /** Hide the card and mark today's recap as seen (B13). */
  onDismiss: () => void;
}

/** Daily coach recap, shown under the hero until dismissed. */
export function DailyRecapCard({ recap, onDismiss }: DailyRecapCardProps) {
  const gradeLabel = RECAP_GRADE_LABEL[recap.grade];
  return (
    <section className={`card today-coach ${RECAP_TONE[recap.grade] ?? ''}`} aria-labelledby="today-recap-title">
      <div className="today-coach-head">
        <h2 id="today-recap-title" className="today-section-title">
          Daily recap{gradeLabel ? ` · ${gradeLabel}` : ''}
        </h2>
        <DismissButton label="Dismiss daily recap" onClick={onDismiss} />
      </div>
      {recap.synced && (
        <p className="today-result-stats">
          <span className="today-result-main">{formatMiles(recap.actualDistanceMi)}</span>
          <span>{formatPaceFromMinPerMi(recap.actualPaceMinPerMi)} pace</span>
          {recap.avgHR ? <span>{recap.avgHR} bpm</span> : null}
          {recap.primaryZone ? <span>Zone: {recap.primaryZone}</span> : null}
        </p>
      )}
      <p className="today-result-feedback">{recap.coachMessage}</p>
    </section>
  );
}

function readinessTone(grade: string): string {
  if (grade.startsWith('A')) return 'today-coach--good';
  if (grade.startsWith('B')) return 'today-coach--ok';
  return 'today-coach--warn';
}

export interface WeeklyReadinessCardProps {
  readiness: ReadinessScore;
  /** Hide the card and mark this week's recap as seen. */
  onDismiss: () => void;
}

/** Weekly race-day readiness recap, shown on the athlete's recap day until dismissed. */
export function WeeklyReadinessCard({ readiness, onDismiss }: WeeklyReadinessCardProps) {
  return (
    <section className={`card today-coach ${readinessTone(readiness.grade)}`} aria-labelledby="today-readiness-title">
      <div className="today-coach-head">
        <h2 id="today-readiness-title" className="today-section-title">
          Race readiness · Week {readiness.weekNumber}: {readiness.grade}
        </h2>
        <DismissButton label="Dismiss weekly readiness recap" onClick={onDismiss} />
      </div>
      {readiness.strengths.length > 0 && (
        <>
          <span className="today-coach-label">Strengths</span>
          <ul className="today-coach-list">{readiness.strengths.map((s) => <li key={s}>{s}</li>)}</ul>
        </>
      )}
      {readiness.improvements.length > 0 && (
        <>
          <span className="today-coach-label">Areas to improve</span>
          <ul className="today-coach-list">{readiness.improvements.map((s) => <li key={s}>{s}</li>)}</ul>
        </>
      )}
      {readiness.nextWeekTips.length > 0 && (
        <>
          <span className="today-coach-label">Next week</span>
          <ul className="today-coach-list">{readiness.nextWeekTips.map((s) => <li key={s}>{s}</li>)}</ul>
        </>
      )}
      <Link to="/progress?tab=overview" className="today-link">View your progress</Link>
    </section>
  );
}
