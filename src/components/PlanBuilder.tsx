import { useState, useMemo } from 'react';
import {
  createCustomPlanFromScratch,
  getPlanOverview,
  type CustomDayType,
  type TrainingPlan,
} from '../data/plans';
import { getSavedTrainingPaces, formatPaceSec, formatPaceRange } from '../services/paceCalculator';
import { getWorkoutTarget } from '../services/workoutTargets';

// ── Constants ──────────────────────────────────────────────────────────────────

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const WORKOUT_TYPE_OPTIONS: { value: CustomDayType; label: string; color: string }[] = [
  { value: 'rest', label: 'Rest', color: 'var(--text-muted)' },
  { value: 'easy', label: 'Easy', color: 'var(--success)' },
  { value: 'long', label: 'Long Run', color: 'var(--apollo-gold)' },
  { value: 'tempo', label: 'Tempo', color: 'var(--warning)' },
  { value: 'speed', label: 'Speed', color: 'var(--error)' },
  { value: 'marathon_pace', label: 'Marathon Pace', color: 'var(--apollo-teal)' },
  { value: 'medium_long', label: 'Medium Long', color: '#8b5cf6' },
  { value: 'cross', label: 'Cross-Train', color: 'var(--text-secondary)' },
];

type BuilderStep = 'configure' | 'assign-days' | 'preview';

interface PlanBuilderProps {
  onComplete: (plan: TrainingPlan) => void;
  onCancel: () => void;
  /** Initial values for editing an existing custom plan config */
  initialConfig?: {
    name?: string;
    totalWeeks?: number;
    runningDays?: number;
    currentWeeklyMiles?: number;
    peakWeeklyMiles?: number;
  };
}

// ── Default day assignments based on running days count ─────────────────────

function getDefaultAssignments(runningDays: number): Record<number, CustomDayType> {
  const assignments: Record<number, CustomDayType> = {};
  for (let i = 0; i < 7; i++) assignments[i] = 'rest';

  switch (runningDays) {
    case 3:
      assignments[1] = 'easy'; // Tue
      assignments[3] = 'easy'; // Thu
      assignments[6] = 'long'; // Sun
      break;
    case 4:
      assignments[1] = 'easy';  // Tue
      assignments[2] = 'tempo'; // Wed
      assignments[4] = 'easy';  // Fri
      assignments[6] = 'long';  // Sun
      break;
    case 5:
      assignments[1] = 'easy';  // Tue
      assignments[2] = 'tempo'; // Wed
      assignments[3] = 'easy';  // Thu
      assignments[5] = 'easy';  // Sat
      assignments[6] = 'long';  // Sun
      break;
    case 6:
      assignments[0] = 'easy';        // Mon
      assignments[1] = 'tempo';       // Tue
      assignments[2] = 'easy';        // Wed
      assignments[3] = 'marathon_pace'; // Thu
      assignments[5] = 'medium_long'; // Sat
      assignments[6] = 'long';        // Sun
      break;
    default:
      assignments[1] = 'easy';
      assignments[3] = 'tempo';
      assignments[6] = 'long';
  }
  return assignments;
}

// ── Component ──────────────────────────────────────────────────────────────────

export default function PlanBuilder({ onComplete, onCancel, initialConfig }: PlanBuilderProps) {
  const [step, setStep] = useState<BuilderStep>('configure');

  // Config state
  const [name, setName] = useState(initialConfig?.name ?? 'My Custom Marathon Plan');
  const [totalWeeks, setTotalWeeks] = useState(initialConfig?.totalWeeks ?? 18);
  const [runningDays, setRunningDays] = useState(initialConfig?.runningDays ?? 4);
  const [currentMiles, setCurrentMiles] = useState(initialConfig?.currentWeeklyMiles ?? 24);
  const [peakMiles, setPeakMiles] = useState(initialConfig?.peakWeeklyMiles ?? 40);

  // Day assignment state
  const [assignments, setAssignments] = useState<Record<number, CustomDayType>>(
    () => getDefaultAssignments(initialConfig?.runningDays ?? 4),
  );

  // Preview state
  const [expandedWeek, setExpandedWeek] = useState<number | null>(null);

  // Count actual running days from assignments
  const assignedRunDays = Object.values(assignments).filter(v => v !== 'rest' && v !== 'cross').length;

  // Validation
  const hasLongRun = Object.values(assignments).includes('long');
  const configValid = totalWeeks >= 10 && totalWeeks <= 30
    && currentMiles >= 8 && currentMiles <= 80
    && peakMiles >= currentMiles + 4 && peakMiles <= 90;
  const assignValid = assignedRunDays >= 3 && assignedRunDays <= 6 && hasLongRun;

  // Generate the preview plan
  const previewPlan = useMemo(() => {
    if (step !== 'preview') return null;
    return createCustomPlanFromScratch({
      name,
      totalWeeks,
      runningDays: assignedRunDays,
      currentWeeklyMiles: currentMiles,
      peakWeeklyMiles: peakMiles,
      dayAssignments: assignments,
    });
  }, [step, name, totalWeeks, assignedRunDays, currentMiles, peakMiles, assignments]);

  const overview = useMemo(() => {
    if (!previewPlan) return [];
    return getPlanOverview(previewPlan);
  }, [previewPlan]);

  // Get saved paces for target display
  const savedPaces = getSavedTrainingPaces();
  const vdot = savedPaces?.vdot ?? 0;

  const handleAssignmentChange = (dayIndex: number, value: CustomDayType) => {
    setAssignments(prev => ({ ...prev, [dayIndex]: value }));
  };

  const handleRunningDaysChange = (newDays: number) => {
    setRunningDays(newDays);
    setAssignments(getDefaultAssignments(newDays));
  };

  const handleAcceptPlan = () => {
    if (!previewPlan) return;
    onComplete(previewPlan);
  };

  // ── Configure Step ─────────────────────────────────────────────────────────

  if (step === 'configure') {
    return (
      <div className="plan-builder">
        <div className="plan-builder-header">
          <h2 className="plan-builder-title">Build Your Marathon Plan</h2>
          <p className="plan-builder-subtitle">
            Configure your plan parameters. Apollo will generate a progressive training plan
            with cutback weeks and a race-week taper.
          </p>
        </div>

        <div className="plan-builder-form">
          <label className="plan-builder-field">
            <span className="plan-builder-label">Plan Name</span>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              className="plan-builder-input"
              placeholder="My Custom Marathon Plan"
              maxLength={60}
            />
          </label>

          <div className="plan-builder-grid">
            <label className="plan-builder-field">
              <span className="plan-builder-label">Plan Length</span>
              <div className="plan-builder-range-row">
                <input
                  type="range"
                  min={10}
                  max={30}
                  value={totalWeeks}
                  onChange={e => setTotalWeeks(Number(e.target.value))}
                  className="plan-builder-slider"
                />
                <span className="plan-builder-range-value">{totalWeeks} weeks</span>
              </div>
            </label>

            <label className="plan-builder-field">
              <span className="plan-builder-label">Running Days / Week</span>
              <div className="plan-builder-range-row">
                <input
                  type="range"
                  min={3}
                  max={6}
                  value={runningDays}
                  onChange={e => handleRunningDaysChange(Number(e.target.value))}
                  className="plan-builder-slider"
                />
                <span className="plan-builder-range-value">{runningDays} days</span>
              </div>
            </label>

            <label className="plan-builder-field">
              <span className="plan-builder-label">Current Weekly Miles</span>
              <div className="plan-builder-range-row">
                <input
                  type="range"
                  min={8}
                  max={80}
                  value={currentMiles}
                  onChange={e => setCurrentMiles(Number(e.target.value))}
                  className="plan-builder-slider"
                />
                <span className="plan-builder-range-value">{currentMiles} mi</span>
              </div>
            </label>

            <label className="plan-builder-field">
              <span className="plan-builder-label">Peak Weekly Miles</span>
              <div className="plan-builder-range-row">
                <input
                  type="range"
                  min={Math.max(currentMiles + 4, 12)}
                  max={90}
                  value={Math.max(peakMiles, currentMiles + 4)}
                  onChange={e => setPeakMiles(Number(e.target.value))}
                  className="plan-builder-slider"
                />
                <span className="plan-builder-range-value">{Math.max(peakMiles, currentMiles + 4)} mi</span>
              </div>
            </label>
          </div>
        </div>

        <div className="plan-builder-actions">
          <button
            type="button"
            className="btn btn-primary"
            disabled={!configValid}
            onClick={() => setStep('assign-days')}
          >
            Next: Assign Workout Days →
          </button>
          <button type="button" className="btn btn-secondary" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  // ── Assign Days Step ───────────────────────────────────────────────────────

  if (step === 'assign-days') {
    return (
      <div className="plan-builder">
        <div className="plan-builder-header">
          <h2 className="plan-builder-title">Assign Workout Types</h2>
          <p className="plan-builder-subtitle">
            Choose what type of workout goes on each day. You need exactly one long run day and 3–6 total running days.
          </p>
        </div>

        <div className="plan-builder-day-grid">
          {DAY_NAMES.map((dayName, idx) => {
            const assigned = assignments[idx];
            const opt = WORKOUT_TYPE_OPTIONS.find(o => o.value === assigned);
            return (
              <div key={idx} className="plan-builder-day-card">
                <div className="plan-builder-day-name">{dayName}</div>
                <select
                  value={assigned}
                  onChange={e => handleAssignmentChange(idx, e.target.value as CustomDayType)}
                  className="plan-builder-day-select"
                  style={{ borderColor: opt?.color }}
                >
                  {WORKOUT_TYPE_OPTIONS.map(o => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
                <div
                  className="plan-builder-day-indicator"
                  style={{ background: opt?.color ?? 'var(--text-muted)' }}
                />
              </div>
            );
          })}
        </div>

        {/* Day assignment summary */}
        <div className="plan-builder-summary">
          <span className={assignedRunDays >= 3 && assignedRunDays <= 6 ? 'plan-builder-valid' : 'plan-builder-invalid'}>
            {assignedRunDays} running day{assignedRunDays !== 1 ? 's' : ''} assigned
          </span>
          <span style={{ color: 'var(--text-muted)' }}>·</span>
          <span className={hasLongRun ? 'plan-builder-valid' : 'plan-builder-invalid'}>
            {hasLongRun ? '✓ Long run assigned' : '✗ Need a long run day'}
          </span>
        </div>

        {/* VDOT pace preview */}
        {vdot > 0 && savedPaces && (
          <div className="plan-builder-pace-card">
            <div className="plan-builder-pace-title">Your VDOT Pace Targets (VDOT {savedPaces.vdot})</div>
            <div className="plan-builder-pace-grid">
              <div><span className="plan-builder-pace-label">Easy</span> <span className="plan-builder-pace-value">{formatPaceRange(savedPaces.easy.min, savedPaces.easy.max)}</span></div>
              <div><span className="plan-builder-pace-label">Marathon</span> <span className="plan-builder-pace-value">{formatPaceSec(savedPaces.marathon)}</span></div>
              <div><span className="plan-builder-pace-label">Threshold</span> <span className="plan-builder-pace-value">{formatPaceSec(savedPaces.threshold)}</span></div>
              <div><span className="plan-builder-pace-label">Interval</span> <span className="plan-builder-pace-value">{formatPaceSec(savedPaces.interval)}</span></div>
            </div>
          </div>
        )}

        <div className="plan-builder-actions">
          <button
            type="button"
            className="btn btn-primary"
            disabled={!assignValid}
            onClick={() => { setExpandedWeek(null); setStep('preview'); }}
          >
            Next: Preview Plan →
          </button>
          <button type="button" className="btn btn-secondary" onClick={() => setStep('configure')}>
            ← Back
          </button>
        </div>
      </div>
    );
  }

  // ── Preview Step ───────────────────────────────────────────────────────────

  if (step === 'preview' && previewPlan) {
    const peakWeekMiles = Math.max(...overview.map(o => o.totalMiles));

    return (
      <div className="plan-builder">
        <div className="plan-builder-header">
          <h2 className="plan-builder-title">Preview: {previewPlan.name}</h2>
          <p className="plan-builder-subtitle">
            {previewPlan.totalWeeks} weeks · {assignedRunDays} run days/week ·
            {' '}{currentMiles}→{Math.max(peakMiles, currentMiles + 4)} mi/week ·
            {' '}Peak: {peakWeekMiles} mi/week
          </p>
        </div>

        {/* Mileage chart */}
        <div className="plan-builder-chart">
          {overview.map((week, i) => {
            const heightPct = peakWeekMiles > 0 ? (week.totalMiles / peakWeekMiles) * 100 : 0;
            const isCutback = week.totalMiles < (overview[Math.max(0, i - 1)]?.totalMiles ?? 0) * 0.9
              && i > 0 && i < overview.length - 2;
            const isTaper = i >= overview.length - 2;
            const isRace = i === overview.length - 1;
            return (
              <div
                key={week.weekNumber}
                className="plan-builder-chart-bar-wrap"
                title={`Week ${week.weekNumber}: ${week.totalMiles} mi (Long: ${week.longRunMiles} mi)`}
                onClick={() => setExpandedWeek(expandedWeek === i ? null : i)}
              >
                <div
                  className="plan-builder-chart-bar"
                  style={{
                    height: `${Math.max(heightPct, 4)}%`,
                    background: isRace ? 'var(--apollo-gold)'
                      : isTaper ? 'var(--apollo-teal)'
                      : isCutback ? 'var(--text-muted)'
                      : 'var(--accent)',
                  }}
                />
                <span className="plan-builder-chart-label">
                  {week.weekNumber}
                </span>
              </div>
            );
          })}
        </div>

        {/* Week-by-week expandable detail */}
        <div className="plan-builder-weeks">
          {previewPlan.weeks.map((week, weekIdx) => {
            const isExpanded = expandedWeek === weekIdx;
            const weekSummary = overview[weekIdx];
            const isTaper = weekIdx >= previewPlan.totalWeeks - 2;
            const isRace = weekIdx === previewPlan.totalWeeks - 1;
            return (
              <div key={week.weekNumber} className="plan-builder-week">
                <button
                  type="button"
                  className="plan-builder-week-header"
                  onClick={() => setExpandedWeek(isExpanded ? null : weekIdx)}
                >
                  <span className="plan-builder-week-num">
                    Week {week.weekNumber}
                    {isRace && <span className="plan-builder-week-badge plan-builder-week-badge--race">Race</span>}
                    {isTaper && !isRace && <span className="plan-builder-week-badge plan-builder-week-badge--taper">Taper</span>}
                  </span>
                  <span className="plan-builder-week-miles">
                    {weekSummary.totalMiles} mi · Long: {weekSummary.longRunMiles} mi
                  </span>
                  <span className="plan-builder-week-chevron">{isExpanded ? '▼' : '▶'}</span>
                </button>
                {isExpanded && (
                  <div className="plan-builder-week-body">
                    <table className="plan-builder-week-table">
                      <thead>
                        <tr>
                          <th>Day</th>
                          <th>Workout</th>
                          <th>Distance</th>
                          {vdot > 0 && <th>Target Pace</th>}
                        </tr>
                      </thead>
                      <tbody>
                        {week.days.map((day, dayIdx) => {
                          const target = vdot > 0 && day.note ? getWorkoutTarget(day.note, vdot, day.distanceMi) : null;
                          const paceStr = target?.targetPaceRange
                            ? formatPaceRange(target.targetPaceRange.minSecPerMi, target.targetPaceRange.maxSecPerMi)
                            : '';
                          return (
                            <tr key={dayIdx}>
                              <td className="plan-builder-cell-day">{DAY_NAMES[dayIdx]}</td>
                              <td>{day.label}</td>
                              <td className="plan-builder-cell-dist">
                                {day.distanceMi != null ? `${day.distanceMi} mi` : '—'}
                              </td>
                              {vdot > 0 && (
                                <td className="plan-builder-cell-pace">{paceStr || '—'}</td>
                              )}
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="plan-builder-actions">
          <button type="button" className="btn btn-primary" onClick={handleAcceptPlan}>
            ✓ Accept This Plan
          </button>
          <button type="button" className="btn btn-secondary" onClick={() => setStep('assign-days')}>
            ← Edit Days
          </button>
          <button type="button" className="btn btn-secondary" onClick={() => setStep('configure')}>
            ← Edit Config
          </button>
        </div>
      </div>
    );
  }

  return null;
}
