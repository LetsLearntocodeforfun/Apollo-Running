import { Link } from 'react-router-dom';
import type { RacePrediction } from '../../services/racePrediction';
import { EmptyState } from '../ui';
import { predictionRangeText } from './todayModel';

export interface PredictionCardProps {
  /** From calculateRacePrediction(); null when no VDOT source exists. */
  prediction: RacePrediction | null;
}

/** Marathon prediction range with its source, or a CTA to add a recent race. */
export default function PredictionCard({ prediction }: PredictionCardProps) {
  const usable = prediction && prediction.vdotSource && prediction.vdotSource !== 'none' && prediction.marathonTimeSec > 0;
  return (
    <section className="card" aria-labelledby="today-prediction-title">
      <h2 id="today-prediction-title" className="today-section-title">Marathon prediction</h2>
      {usable ? (
        <>
          <p className="today-prediction-range">{predictionRangeText(prediction)}</p>
          <p className="today-prediction-meta">
            {[prediction.sourceLabel, `VDOT ${prediction.vdot}`].filter(Boolean).join(' · ')}
          </p>
          {prediction.basis && <p className="today-prediction-basis">{prediction.basis}</p>}
          <Link to="/progress?tab=overview" className="today-link">Prediction details</Link>
        </>
      ) : (
        <EmptyState
          title="No prediction yet"
          action={<Link to="/settings?tab=profile" className="btn btn-secondary">Add a recent race in Settings › Athlete Profile</Link>}
        >
          A recent race result gives Apollo your fitness, your marathon range and personal training paces.
        </EmptyState>
      )}
    </section>
  );
}
