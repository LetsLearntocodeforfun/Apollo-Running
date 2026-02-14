import { useState } from 'react';
import { BUILT_IN_PLANS, getPlanById, getPlanOverview } from '../data/plans';
import { setActivePlan, setWelcomeCompleted, formatDateKey } from '../services/planProgress';

type Step = 'choice' | 'overview' | 'start-date';

export default function WelcomeFlow({ onComplete }: { onComplete: () => void }) {
  const [step, setStep] = useState<Step>('choice');
  const [selectedPlanId, setSelectedPlanId] = useState<string | null>(null);
  const [startDate, setStartDate] = useState(formatDateKey(new Date()));
  const [expandedPlanId, setExpandedPlanId] = useState<string | null>(null);

  const plan = selectedPlanId ? getPlanById(selectedPlanId) : null;

  const handleNoThanks = () => {
    setWelcomeCompleted(true);
    onComplete();
  };

  const handleConfirmStartDate = () => {
    if (!plan) return;
    setActivePlan({ planId: plan.id, startDate });
    setWelcomeCompleted(true);
    onComplete();
  };

  if (step === 'choice') {
    return (
      <div className="welcome-flow">
        <div className="welcome-card">
          <h1 className="welcome-title">Welcome to Apollo</h1>
          <p className="welcome-text">
            Your all-in-one marathon training app. Connect Strava and Garmin, follow a day-by-day checklist, and stay on track.
          </p>
          <p className="welcome-question">
            Would you like to choose a marathon training plan from our library of popular plans?
          </p>
          <p className="welcome-hint">
            We include plans from Hal Higdon, Hanson&apos;s, and FIRST — the same plans runners use from books and the web. You can change or skip this anytime.
          </p>
          <div className="welcome-actions">
            <button type="button" className="btn btn-primary welcome-btn" onClick={() => setStep('overview')}>
              Yes, show me the plans
            </button>
            <button type="button" className="btn btn-secondary welcome-btn" onClick={handleNoThanks}>
              No thanks, I&apos;ll decide later
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (step === 'overview') {
    return (
      <div className="welcome-flow">
        <div className="welcome-card welcome-overview">
          <h1 className="welcome-title">Choose a training plan</h1>
          <p className="welcome-text">
            Review each plan below. Expand any plan to see the full week-by-week overview, then select one and set your start date.
          </p>
          <div className="plan-overview-list">
            {BUILT_IN_PLANS.map((p) => {
              const overview = getPlanOverview(p);
              const isExpanded = expandedPlanId === p.id;
              return (
                <div key={p.id} className="plan-overview-item">
                  <button
                    type="button"
                    className="plan-overview-header"
                    onClick={() => setExpandedPlanId(isExpanded ? null : p.id)}
                  >
                    <span className="plan-overview-name">{p.name}</span>
                    <span className="plan-overview-author">{p.author}</span>
                    <span className="plan-overview-meta">{p.totalWeeks} weeks · Peak ~{Math.max(...overview.map((o) => o.totalMiles))} mi/week</span>
                    <span className="plan-overview-chevron">{isExpanded ? '▼' : '▶'}</span>
                  </button>
                  {isExpanded && (
                    <div className="plan-overview-body">
                      <p className="plan-overview-desc">{p.description}</p>
                      <div className="plan-overview-table-wrap">
                        <table className="plan-overview-table">
                          <thead>
                            <tr>
                              <th>Week</th>
                              <th>Total (mi)</th>
                              <th>Long run (mi)</th>
                            </tr>
                          </thead>
                          <tbody>
                            {overview.map((row) => (
                              <tr key={row.weekNumber}>
                                <td>{row.weekNumber}</td>
                                <td>{row.totalMiles}</td>
                                <td>{row.longRunMiles || '—'}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      <button
                        type="button"
                        className="btn btn-primary"
                        onClick={() => {
                          setSelectedPlanId(p.id);
                          setStep('start-date');
                        }}
                      >
                        Select this plan
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <div className="welcome-actions" style={{ marginTop: '1.5rem' }}>
            <button type="button" className="btn btn-secondary" onClick={handleNoThanks}>
              Skip for now
            </button>
          </div>
        </div>
      </div>
    );
  }

  // step === 'start-date'
  return (
    <div className="welcome-flow">
      <div className="welcome-card">
        <h1 className="welcome-title">Start your plan</h1>
        {plan && (
          <>
            <p className="welcome-text">
              <strong>{plan.name}</strong> by {plan.author} — {plan.totalWeeks} weeks. Set the date of Week 1, Monday (your first day of the plan).
            </p>
            <div className="start-date-row">
              <label>
                <span className="start-date-label">Week 1 start date (Monday)</span>
                <input
                  type="date"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                  className="start-date-input"
                />
              </label>
            </div>
            <div className="welcome-actions">
              <button type="button" className="btn btn-primary welcome-btn" onClick={handleConfirmStartDate}>
                Start plan
              </button>
              <button type="button" className="btn btn-secondary welcome-btn" onClick={() => setStep('overview')}>
                Back to plans
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
