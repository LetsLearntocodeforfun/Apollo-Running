import { useState } from 'react';
import { BUILT_IN_PLANS, getPlanById, getPlanOverview } from '../data/plans';
import { setActivePlan, setWelcomeCompleted, formatDateKey } from '../services/planProgress';
import {
  setCoachingPreferences,
  setCoachingOnboardingDone,
  suggestWeeklyRecapDay,
  WEEKDAY_NAMES,
} from '../services/coachingPreferences';

type Step = 'choice' | 'overview' | 'start-date' | 'coaching';

export default function WelcomeFlow({ onComplete }: { onComplete: () => void }) {
  const [step, setStep] = useState<Step>('choice');
  const [selectedPlanId, setSelectedPlanId] = useState<string | null>(null);
  const [startDate, setStartDate] = useState(formatDateKey(new Date()));
  const [expandedPlanId, setExpandedPlanId] = useState<string | null>(null);
  const [dailyRecapEnabled, setDailyRecapEnabled] = useState(true);
  const [dailyRecapTime, setDailyRecapTime] = useState('20:00');
  const [weeklyRecapEnabled, setWeeklyRecapEnabled] = useState(true);
  const [weeklyRecapDay, setWeeklyRecapDay] = useState(6);

  const plan = selectedPlanId ? getPlanById(selectedPlanId) : null;

  const handleNoThanks = () => {
    setWelcomeCompleted(true);
    setCoachingOnboardingDone(true);
    onComplete();
  };

  const handleConfirmStartDate = () => {
    if (!plan) return;
    setActivePlan({ planId: plan.id, startDate });
    // Find the long run day to suggest a weekly recap day
    const longRunIdx = plan.weeks[0]?.days.findIndex((d) => d.note?.toLowerCase() === 'long') ?? -1;
    setWeeklyRecapDay(suggestWeeklyRecapDay(longRunIdx >= 0 ? longRunIdx : null));
    setStep('coaching');
  };

  const handleFinishCoaching = () => {
    setCoachingPreferences({
      dailyRecapEnabled,
      dailyRecapTime,
      weeklyRecapEnabled,
      weeklyRecapDay,
      onboardingDone: true,
    });
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

  if (step === 'start-date') {
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
                  Next
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

  // step === 'coaching'
  return (
    <div className="welcome-flow">
      <div className="welcome-card" style={{ maxWidth: 580 }}>
        <h1 className="welcome-title">Your Personal Coach</h1>
        <p className="welcome-text">
          Apollo can deliver a <strong>daily training recap</strong> and a <strong>weekly Race Day Readiness Score</strong> to keep you on track and predict your race performance.
        </p>

        {/* Daily Recap */}
        <div style={{ background: 'var(--bg)', borderRadius: 12, padding: '1.25rem', marginBottom: '1rem', border: '1px solid var(--border)' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.75rem' }}>
            <div>
              <strong style={{ fontSize: '1.05rem' }}>Daily Training Recap</strong>
              <p style={{ color: 'var(--text-muted)', fontSize: '0.88rem', margin: '0.25rem 0 0' }}>
                Get a personalized summary of your day&apos;s training vs your plan, with coaching insights and heart rate analysis.
              </p>
            </div>
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer', flexShrink: 0, marginLeft: '1rem' }}>
              <input
                type="checkbox"
                checked={dailyRecapEnabled}
                onChange={(e) => setDailyRecapEnabled(e.target.checked)}
                style={{ width: 20, height: 20, accentColor: 'var(--accent)' }}
              />
            </label>
          </div>
          {dailyRecapEnabled && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
              <label style={{ fontSize: '0.9rem', color: 'var(--text-muted)' }}>Show recap at</label>
              <input
                type="time"
                value={dailyRecapTime}
                onChange={(e) => setDailyRecapTime(e.target.value)}
                style={{
                  padding: '0.4rem 0.6rem',
                  borderRadius: 8,
                  border: '1px solid var(--border)',
                  background: 'var(--bg-card)',
                  color: 'var(--text)',
                  fontSize: '0.95rem',
                }}
              />
              <span style={{ fontSize: '0.82rem', color: 'var(--text-muted)' }}>daily</span>
            </div>
          )}
        </div>

        {/* Weekly Readiness */}
        <div style={{ background: 'var(--bg)', borderRadius: 12, padding: '1.25rem', marginBottom: '1.5rem', border: '1px solid var(--border)' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.75rem' }}>
            <div>
              <strong style={{ fontSize: '1.05rem' }}>Race Day Readiness Score</strong>
              <p style={{ color: 'var(--text-muted)', fontSize: '0.88rem', margin: '0.25rem 0 0' }}>
                Weekly recap with a readiness grade, what went well, areas to improve, and next-week coaching tips.
              </p>
            </div>
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer', flexShrink: 0, marginLeft: '1rem' }}>
              <input
                type="checkbox"
                checked={weeklyRecapEnabled}
                onChange={(e) => setWeeklyRecapEnabled(e.target.checked)}
                style={{ width: 20, height: 20, accentColor: 'var(--accent)' }}
              />
            </label>
          </div>
          {weeklyRecapEnabled && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
              <label style={{ fontSize: '0.9rem', color: 'var(--text-muted)' }}>Show on</label>
              <select
                value={weeklyRecapDay}
                onChange={(e) => setWeeklyRecapDay(Number(e.target.value))}
                style={{
                  padding: '0.4rem 0.6rem',
                  borderRadius: 8,
                  border: '1px solid var(--border)',
                  background: 'var(--bg-card)',
                  color: 'var(--text)',
                  fontSize: '0.95rem',
                }}
              >
                {WEEKDAY_NAMES.map((name, i) => (
                  <option key={i} value={i}>{name}</option>
                ))}
              </select>
              <span style={{ fontSize: '0.82rem', color: 'var(--text-muted)', fontStyle: 'italic' }}>
                Tip: the day after your weekly long run or end of the week works best
              </span>
            </div>
          )}
        </div>

        <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', marginBottom: '1.25rem', lineHeight: 1.5 }}>
          You&apos;ll also get a <strong>Race Day Time Prediction</strong> and <strong>Training Adherence Score</strong> updated daily after each Strava sync. These features use VDOT modeling, heart rate zones, and your training consistency to build an accurate race picture.
        </p>

        <div className="welcome-actions">
          <button type="button" className="btn btn-primary welcome-btn" onClick={handleFinishCoaching}>
            Let&apos;s go!
          </button>
          <button type="button" className="btn btn-secondary welcome-btn" onClick={() => setStep('start-date')}>
            Back
          </button>
        </div>
      </div>
    </div>
  );
}
