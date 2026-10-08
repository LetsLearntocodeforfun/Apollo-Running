import type { SportSummary } from '../../services/crossTraining';
import { formatHoursMinutes } from '../../services/crossTraining';
import { formatDistanceShort } from '../../services/unitPreferences';

export interface CrossTrainingCardProps {
  /** This week's non-running volume by sport; the card renders nothing when empty. */
  summaries: SportSummary[];
}

/** This week's cross-training (rides, swims, strength…), only when there is some. */
export default function CrossTrainingCard({ summaries }: CrossTrainingCardProps) {
  if (summaries.length === 0) return null;
  const totalSec = summaries.reduce((sum, s) => sum + s.movingTimeSec, 0);
  return (
    <section className="card" aria-labelledby="today-cross-title">
      <div className="today-cross-head">
        <h2 id="today-cross-title" className="today-section-title">Cross-training this week</h2>
        <span className="today-cross-total">{formatHoursMinutes(totalSec)}</span>
      </div>
      <ul className="today-cross-list">
        {summaries.map((s) => (
          <li key={s.category} className="today-cross-item">
            <span className="today-cross-label"><span aria-hidden="true">{s.icon} </span>{s.label}</span>
            <span className="today-cross-value">{formatHoursMinutes(s.movingTimeSec)}</span>
            <span className="today-cross-sub">
              {[
                `${s.count} session${s.count === 1 ? '' : 's'}`,
                s.distanceMeters > 0 ? formatDistanceShort(s.distanceMeters) : null,
                s.trainingLoad > 0 ? `Load ${Math.round(s.trainingLoad)}` : null,
              ].filter(Boolean).join(' · ')}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
