/**
 * Custom marathon plan builder: configure → assign workout days → preview.
 *
 * v1.0.6:
 * - V21: the peak slider's lower bound depends on the current weekly distance. The stored peak now
 *   follows that clamp (before, only the rendered value was clamped, so "Next" was disabled with no
 *   reason), and validation reasons are shown inline (role="alert", linked with aria-describedby).
 * - Exactly one long-run day, chosen with a native radio group.
 * - Every control is labelled; the preview chart is coloured by periodization phase with a text
 *   legend, its bars are real buttons, and the week accordions expose aria-expanded/aria-controls.
 * - B7: design-system colour tokens only (see ./plan/PlanBuilder.css).
 * - Distances and paces follow the unit preference. The plan engine still works in miles: sliders
 *   show whole display units and convert back to miles on change.
 */
import { useId, useMemo, useState, type ReactNode } from 'react';
import {
  createCustomPlanFromScratch,
  getPlanOverview,
  type CustomDayType,
  type TrainingPlan,
} from '../data/plans';
import { getCurrentTrainingPaces, getSavedTrainingPaces } from '../services/paceCalculator';
import { getWorkoutTarget } from '../services/workoutTargets';
import { detectPhases, type PhaseName, type TrainingPhase } from '../services/periodization';
import {
  formatMiles,
  formatPaceFromMinPerMi,
  formatPaceShort,
  getDistanceUnit,
  milesToUnit,
  paceUnitLabel,
  unitLabel,
  type DistanceUnit,
} from '../services/unitPreferences';
import { workoutTitle } from './plan/planDisplay';
import './plan/PlanBuilder.css';

// ── Constants ──────────────────────────────────────────────────────────────────

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const DAY_FULL_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/** Workout types. Colours live in PlanBuilder.css (`.pb-type-<value>`, design tokens only — B7). */
const WORKOUT_TYPE_OPTIONS: { value: CustomDayType; label: string }[] = [
  { value: 'rest', label: 'Rest' },
  { value: 'easy', label: 'Easy' },
  { value: 'long', label: 'Long Run' },
  { value: 'tempo', label: 'Tempo' },
  { value: 'speed', label: 'Speed' },
  { value: 'marathon_pace', label: 'Marathon Pace' },
  { value: 'medium_long', label: 'Medium Long' },
  { value: 'cross', label: 'Cross-Train' },
];

/** Types offered in the per-day selects. The long run has its own radio group, so there is always exactly one. */
const DAY_TYPE_OPTIONS = WORKOUT_TYPE_OPTIONS.filter(o => o.value !== 'long');

/** Short phase names for the week badges (the legend uses the full labels). */
const PHASE_SHORT: Record<PhaseName, string> = {
  base: 'Base',
  build: 'Build',
  peak: 'Peak',
  taper: 'Taper',
  race: 'Race',
};

// Generator bounds in miles, mirroring the clamps in createCustomPlanFromScratch.
const WEEKS_MIN = 10;
const WEEKS_MAX = 30;
const RUN_DAYS_MIN = 3;
const RUN_DAYS_MAX = 6;
const CURRENT_MIN_MI = 8;
const CURRENT_MAX_MI = 80;
const PEAK_GAP_MI = 4;
const PEAK_FLOOR_MI = 12;
const PEAK_MAX_MI = 90;
/** Tolerance for miles ↔ km round trips. */
const EPS = 1e-6;

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

// ── Pure helpers ───────────────────────────────────────────────────────────────

/** Clamp that also maps NaN/Infinity to the lower bound. */
function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

/** Miles → display unit (unrounded). */
function toUnit(miles: number, unit: DistanceUnit): number {
  return milesToUnit(miles, unit);
}

/** Display-unit value → miles (the plan engine's unit). */
function fromUnit(value: number, unit: DistanceUnit): number {
  return value / milesToUnit(1, unit);
}

/** Smallest whole display-unit value that is ≥ `miles`. */
function ceilUnit(miles: number, unit: DistanceUnit): number {
  return Math.ceil(toUnit(miles, unit) - EPS);
}

/** Largest whole display-unit value that is ≤ `miles`. */
function floorUnit(miles: number, unit: DistanceUnit): number {
  return Math.floor(toUnit(miles, unit) + EPS);
}

/** "24 mi" / "39 km": whole display units, as the sliders show them. */
function formatWhole(miles: number, unit: DistanceUnit): string {
  return `${Math.round(toUnit(miles, unit))} ${unitLabel(unit)}`;
}

/** Lowest peak (miles) the peak slider can show: current + 4 mi, rounded up to a whole display unit. */
function minPeakMiles(currentMiles: number, unit: DistanceUnit): number {
  return fromUnit(ceilUnit(Math.max(currentMiles + PEAK_GAP_MI, PEAK_FLOOR_MI), unit), unit);
}

/** Highest peak (miles) the peak slider can show. */
function maxPeakMiles(unit: DistanceUnit): number {
  return fromUnit(floorUnit(PEAK_MAX_MI, unit), unit);
}

/** Keeps a peak (miles) inside the peak slider's bounds for a current weekly distance (V21). */
function clampPeak(peakMiles: number, currentMiles: number, unit: DistanceUnit): number {
  const lo = minPeakMiles(currentMiles, unit);
  const hi = maxPeakMiles(unit);
  if (!Number.isFinite(peakMiles) || peakMiles < lo - EPS) return lo;
  if (peakMiles > hi + EPS) return hi;
  return peakMiles;
}

interface ConfigDraft {
  totalWeeks: number;
  currentMiles: number;
  peakMiles: number;
}

/** Why the plan generator would reject (or silently change) these inputs. Empty when valid. */
function getConfigIssues({ totalWeeks, currentMiles, peakMiles }: ConfigDraft, unit: DistanceUnit): string[] {
  const issues: string[] = [];
  const u = unitLabel(unit);
  if (!(totalWeeks >= WEEKS_MIN && totalWeeks <= WEEKS_MAX)) {
    issues.push(`Plan length must be ${WEEKS_MIN}–${WEEKS_MAX} weeks.`);
  }
  if (!(currentMiles >= CURRENT_MIN_MI - EPS && currentMiles <= CURRENT_MAX_MI + EPS)) {
    issues.push(
      `Current weekly distance must be between ${ceilUnit(CURRENT_MIN_MI, unit)} and ${floorUnit(CURRENT_MAX_MI, unit)} ${u}.`,
    );
  }
  if (!(peakMiles >= currentMiles + PEAK_GAP_MI - EPS)) {
    issues.push(
      `Peak weekly distance must be at least ${ceilUnit(currentMiles + PEAK_GAP_MI, unit)} ${u} ` +
      `(${formatWhole(PEAK_GAP_MI, unit)} above your current weekly distance).`,
    );
  }
  if (!(peakMiles <= PEAK_MAX_MI + EPS)) {
    issues.push(`Peak weekly distance can be at most ${floorUnit(PEAK_MAX_MI, unit)} ${u}.`);
  }
  return issues;
}

/** Running days: every day that isn't rest or cross-training (the long run counts). */
function countRunDays(assignments: Record<number, CustomDayType>): number {
  return Object.values(assignments).filter(v => v !== 'rest' && v !== 'cross').length;
}

/** Day index (0 = Mon) of the long run, or -1. */
function findLongDay(assignments: Record<number, CustomDayType>): number {
  for (let d = 0; d < 7; d++) if (assignments[d] === 'long') return d;
  return -1;
}

/** Moves the long run to `day`. The old long-run day takes over that day's previous workout (a swap). */
function moveLongRun(assignments: Record<number, CustomDayType>, day: number): Record<number, CustomDayType> {
  const from = findLongDay(assignments);
  if (from === day) return assignments;
  const next = { ...assignments };
  const displaced = assignments[day] ?? 'rest';
  next[day] = 'long';
  if (from >= 0) next[from] = displaced;
  return next;
}

/** Why the day assignments can't be built. Empty when valid. */
function getAssignIssues(assignments: Record<number, CustomDayType>): string[] {
  const issues: string[] = [];
  const runDays = countRunDays(assignments);
  if (runDays < RUN_DAYS_MIN) {
    issues.push(`Assign at least ${RUN_DAYS_MIN} running days (you have ${runDays}).`);
  }
  if (runDays > RUN_DAYS_MAX) {
    issues.push(`Assign at most ${RUN_DAYS_MAX} running days (you have ${runDays}). Make one a rest or cross-training day.`);
  }
  if (Object.values(assignments).filter(v => v === 'long').length !== 1) {
    issues.push('Choose exactly one long-run day.');
  }
  return issues;
}

function phaseForWeek(phases: TrainingPhase[], weekIndex: number): TrainingPhase | undefined {
  return phases.find(p => weekIndex >= p.startWeek && weekIndex <= p.endWeek);
}

/** "week 18" / "weeks 1–6" (1-based). */
function weekRangeText(phase: TrainingPhase): string {
  return phase.startWeek === phase.endWeek
    ? `week ${phase.startWeek + 1}`
    : `weeks ${phase.startWeek + 1}–${phase.endWeek + 1}`;
}

/** Pace in sec/mi → "5:30/km" or "8:51/mi". */
function formatPaceForUnit(secPerMi: number, unit: DistanceUnit): string {
  return secPerMi > 0 ? formatPaceFromMinPerMi(secPerMi / 60, unit) : '—';
}

/** Pace range in sec/mi → "5:20–5:40/km". */
function formatPaceRangeForUnit(minSecPerMi: number, maxSecPerMi: number, unit: DistanceUnit): string {
  if (!(minSecPerMi > 0) || !(maxSecPerMi > 0)) return '—';
  const perUnit = (secPerMi: number) => secPerMi / 60 / milesToUnit(1, unit);
  return `${formatPaceShort(perUnit(minSecPerMi))}–${formatPaceShort(perUnit(maxSecPerMi))}${paceUnitLabel(unit)}`;
}

interface InitialState {
  totalWeeks: number;
  runningDays: number;
  currentMiles: number;
  peakMiles: number;
}

/** Initial slider values, clamped to the slider bounds so stored state matches what is shown (V21). */
function getInitialState(config: PlanBuilderProps['initialConfig'], unit: DistanceUnit): InitialState {
  const currentMiles = clamp(config?.currentWeeklyMiles ?? 24, CURRENT_MIN_MI, CURRENT_MAX_MI);
  return {
    totalWeeks: clamp(Math.round(config?.totalWeeks ?? 18), WEEKS_MIN, WEEKS_MAX),
    runningDays: clamp(Math.round(config?.runningDays ?? 4), RUN_DAYS_MIN, RUN_DAYS_MAX),
    currentMiles,
    peakMiles: clampPeak(config?.peakWeeklyMiles ?? 40, currentMiles, unit),
  };
}

// ── Small presentational pieces ────────────────────────────────────────────────

interface RangeFieldProps {
  id: string;
  label: string;
  min: number;
  max: number;
  value: number;
  /** Visible value and the slider's aria-valuetext, e.g. "18 weeks" or "39 km". */
  valueText: string;
  onChange: (value: number) => void;
  describedBy?: string;
  children?: ReactNode;
}

/** A labelled range slider with its value shown beside it. */
function RangeField({ id, label, min, max, value, valueText, onChange, describedBy, children }: RangeFieldProps) {
  return (
    <div className="plan-builder-field">
      <label htmlFor={id} className="plan-builder-label">{label}</label>
      <div className="plan-builder-range-row">
        <input
          id={id}
          type="range"
          min={min}
          max={max}
          step={1}
          value={value}
          aria-valuetext={valueText}
          aria-describedby={describedBy}
          onChange={e => onChange(Number(e.target.value))}
          className="plan-builder-slider"
        />
        <span className="plan-builder-range-value" aria-hidden="true">{valueText}</span>
      </div>
      {children}
    </div>
  );
}

/** Inline validation messages. Always rendered so screen readers announce new content. */
function IssueList({ id, issues }: { id: string; issues: string[] }) {
  return (
    <div id={id} role="alert" className="pb-issues">
      {issues.length > 0 && (
        <ul>
          {issues.map(message => <li key={message}>{message}</li>)}
        </ul>
      )}
    </div>
  );
}

// ── Component ──────────────────────────────────────────────────────────────────

export default function PlanBuilder({ onComplete, onCancel, initialConfig }: PlanBuilderProps) {
  const uid = useId();
  const unit = getDistanceUnit();
  const [step, setStep] = useState<BuilderStep>('configure');

  // Config state. Distances are in miles (the engine's unit); the sliders show the user's unit.
  const [initial] = useState(() => getInitialState(initialConfig, unit));
  const [name, setName] = useState(initialConfig?.name ?? 'My Custom Marathon Plan');
  const [totalWeeks, setTotalWeeks] = useState(initial.totalWeeks);
  const [runningDays, setRunningDays] = useState(initial.runningDays);
  const [currentMiles, setCurrentMiles] = useState(initial.currentMiles);
  const [peakMiles, setPeakMiles] = useState(initial.peakMiles);
  /** Announces an automatic peak change (V21) so it isn't silent. */
  const [peakNote, setPeakNote] = useState('');

  // Day assignment state
  const [assignments, setAssignments] = useState<Record<number, CustomDayType>>(
    () => getDefaultAssignments(initial.runningDays),
  );

  // Preview state
  const [expandedWeek, setExpandedWeek] = useState<number | null>(null);

  // Count actual running days from assignments
  const assignedRunDays = countRunDays(assignments);
  const longDay = findLongDay(assignments);

  // Validation (with reasons, shown inline)
  const configIssues = getConfigIssues({ totalWeeks, currentMiles, peakMiles }, unit);
  const configValid = configIssues.length === 0;
  const assignIssues = getAssignIssues(assignments);
  const assignValid = assignIssues.length === 0;

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

  const phases = useMemo(() => (previewPlan ? detectPhases(previewPlan) : []), [previewPlan]);

  // Paces for target display: the athlete's current paces (pure, no writes), else the saved cache.
  const savedPaces = useMemo(() => getCurrentTrainingPaces() ?? getSavedTrainingPaces(), []);
  const vdot = savedPaces?.vdot ?? 0;

  const ids = {
    name: `${uid}-name`,
    weeks: `${uid}-weeks`,
    days: `${uid}-days`,
    current: `${uid}-current`,
    peak: `${uid}-peak`,
    peakHint: `${uid}-peak-hint`,
    configIssues: `${uid}-config-issues`,
    assignIssues: `${uid}-assign-issues`,
    longRunHint: `${uid}-long-run-hint`,
  };
  const dayId = (dayIndex: number) => `${uid}-day-${dayIndex}`;
  const weekHeaderId = (weekIndex: number) => `${uid}-week-${weekIndex}-header`;
  const weekBodyId = (weekIndex: number) => `${uid}-week-${weekIndex}-body`;

  const handleAssignmentChange = (dayIndex: number, value: CustomDayType) => {
    // The long run is moved only through the radio group, which keeps exactly one.
    if (value === 'long') return;
    setAssignments(prev => (prev[dayIndex] === 'long' ? prev : { ...prev, [dayIndex]: value }));
  };

  const handleLongDayChange = (dayIndex: number) => {
    setAssignments(prev => moveLongRun(prev, dayIndex));
  };

  const handleRunningDaysChange = (newDays: number) => {
    setRunningDays(newDays);
    setAssignments(getDefaultAssignments(newDays));
  };

  const handleCurrentChange = (displayValue: number) => {
    const nextCurrent = clamp(fromUnit(displayValue, unit), CURRENT_MIN_MI, CURRENT_MAX_MI);
    setCurrentMiles(nextCurrent);
    // V21: move the stored peak with the slider's new lower bound, not just the rendered value.
    const nextPeak = clampPeak(peakMiles, nextCurrent, unit);
    if (Math.abs(nextPeak - peakMiles) > EPS) {
      setPeakMiles(nextPeak);
      setPeakNote(
        `Peak raised to ${formatWhole(nextPeak, unit)} to stay at least ${formatWhole(PEAK_GAP_MI, unit)} above your current weekly distance.`,
      );
    } else {
      setPeakNote('');
    }
  };

  const handlePeakChange = (displayValue: number) => {
    setPeakMiles(clampPeak(fromUnit(displayValue, unit), currentMiles, unit));
    setPeakNote('');
  };

  const handleAcceptPlan = () => {
    if (!previewPlan) return;
    onComplete(previewPlan);
  };

  // ── Configure Step ─────────────────────────────────────────────────────────

  if (step === 'configure') {
    const peakMin = ceilUnit(Math.max(currentMiles + PEAK_GAP_MI, PEAK_FLOOR_MI), unit);
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
          <div className="plan-builder-field">
            <label htmlFor={ids.name} className="plan-builder-label">Plan Name</label>
            <input
              id={ids.name}
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              className="plan-builder-input"
              placeholder="My Custom Marathon Plan"
              maxLength={60}
            />
          </div>

          <div className="plan-builder-grid">
            <RangeField
              id={ids.weeks}
              label="Plan Length"
              min={WEEKS_MIN}
              max={WEEKS_MAX}
              value={totalWeeks}
              valueText={`${totalWeeks} weeks`}
              onChange={setTotalWeeks}
            />

            <RangeField
              id={ids.days}
              label="Running Days per Week"
              min={RUN_DAYS_MIN}
              max={RUN_DAYS_MAX}
              value={runningDays}
              valueText={`${runningDays} days`}
              onChange={handleRunningDaysChange}
            />

            <RangeField
              id={ids.current}
              label="Current Weekly Distance"
              min={ceilUnit(CURRENT_MIN_MI, unit)}
              max={floorUnit(CURRENT_MAX_MI, unit)}
              value={Math.round(toUnit(currentMiles, unit))}
              valueText={formatWhole(currentMiles, unit)}
              onChange={handleCurrentChange}
            />

            <RangeField
              id={ids.peak}
              label="Peak Weekly Distance"
              min={peakMin}
              max={floorUnit(PEAK_MAX_MI, unit)}
              value={Math.round(toUnit(peakMiles, unit))}
              valueText={formatWhole(peakMiles, unit)}
              onChange={handlePeakChange}
              describedBy={ids.peakHint}
            >
              <p id={ids.peakHint} className="pb-hint">
                At least {peakMin} {unitLabel(unit)}: {formatWhole(PEAK_GAP_MI, unit)} above your current weekly distance.
              </p>
              <p className="pb-hint pb-hint--status" role="status">{peakNote}</p>
            </RangeField>
          </div>
        </div>

        <IssueList id={ids.configIssues} issues={configIssues} />

        <div className="plan-builder-actions">
          <button
            type="button"
            className="btn btn-primary"
            disabled={!configValid}
            aria-describedby={configValid ? undefined : ids.configIssues}
            onClick={() => setStep('assign-days')}
          >
            Next: Assign Workout Days <span aria-hidden="true">→</span>
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
    const runDaysOk = assignedRunDays >= RUN_DAYS_MIN && assignedRunDays <= RUN_DAYS_MAX;
    return (
      <div className="plan-builder">
        <div className="plan-builder-header">
          <h2 className="plan-builder-title">Assign Workout Types</h2>
          <p className="plan-builder-subtitle">
            Choose what type of workout goes on each day. You need exactly one long run day and 3–6 total running days.
          </p>
        </div>

        <fieldset className="pb-longrun" aria-describedby={ids.longRunHint}>
          <legend className="plan-builder-label">Long run day</legend>
          <div className="pb-longrun-options">
            {DAY_NAMES.map((dayName, idx) => (
              <label key={dayName} className="pb-longrun-option">
                <input
                  type="radio"
                  name={`${uid}-long-run-day`}
                  value={idx}
                  checked={longDay === idx}
                  onChange={() => handleLongDayChange(idx)}
                  aria-label={DAY_FULL_NAMES[idx]}
                />
                <span aria-hidden="true">{dayName}</span>
              </label>
            ))}
          </div>
          <p id={ids.longRunHint} className="pb-hint">
            Moving the long run swaps it with that day&apos;s workout.
          </p>
        </fieldset>

        <div className="plan-builder-day-grid">
          {DAY_NAMES.map((dayName, idx) => {
            const assigned = assignments[idx] ?? 'rest';
            const isLong = assigned === 'long';
            return (
              <div key={dayName} className={`plan-builder-day-card pb-type-${assigned}`}>
                {isLong ? (
                  <>
                    <span className="plan-builder-day-name">{dayName}</span>
                    <span className="pb-day-long">Long Run</span>
                  </>
                ) : (
                  <>
                    <label htmlFor={dayId(idx)} className="plan-builder-day-name">
                      {dayName}<span className="sr-only"> workout</span>
                    </label>
                    <select
                      id={dayId(idx)}
                      value={assigned}
                      onChange={e => handleAssignmentChange(idx, e.target.value as CustomDayType)}
                      className="plan-builder-day-select"
                    >
                      {DAY_TYPE_OPTIONS.map(o => (
                        <option key={o.value} value={o.value}>{o.label}</option>
                      ))}
                    </select>
                  </>
                )}
                <div className="plan-builder-day-indicator" aria-hidden="true" />
              </div>
            );
          })}
        </div>

        {/* Day assignment summary */}
        <div className="plan-builder-summary">
          <span className={runDaysOk ? 'pb-status-ok' : 'pb-status-error'}>
            <span aria-hidden="true">{runDaysOk ? '✓ ' : '✗ '}</span>
            {assignedRunDays} running day{assignedRunDays !== 1 ? 's' : ''} assigned
          </span>
          <span className="pb-summary-sep" aria-hidden="true">·</span>
          <span className={longDay >= 0 ? 'pb-status-ok' : 'pb-status-error'}>
            {longDay >= 0 ? `Long run: ${DAY_FULL_NAMES[longDay]}` : 'Need a long run day'}
          </span>
        </div>

        {/* VDOT pace preview */}
        {vdot > 0 && savedPaces && (
          <div className="plan-builder-pace-card">
            <div className="plan-builder-pace-title">Your VDOT Pace Targets (VDOT {savedPaces.vdot})</div>
            <div className="plan-builder-pace-grid">
              <div><span className="plan-builder-pace-label">Easy</span> <span className="plan-builder-pace-value">{formatPaceRangeForUnit(savedPaces.easy.min, savedPaces.easy.max, unit)}</span></div>
              <div><span className="plan-builder-pace-label">Marathon</span> <span className="plan-builder-pace-value">{formatPaceForUnit(savedPaces.marathon, unit)}</span></div>
              <div><span className="plan-builder-pace-label">Threshold</span> <span className="plan-builder-pace-value">{formatPaceForUnit(savedPaces.threshold, unit)}</span></div>
              <div><span className="plan-builder-pace-label">Interval</span> <span className="plan-builder-pace-value">{formatPaceForUnit(savedPaces.interval, unit)}</span></div>
            </div>
          </div>
        )}

        <IssueList id={ids.assignIssues} issues={assignIssues} />

        <div className="plan-builder-actions">
          <button
            type="button"
            className="btn btn-primary"
            disabled={!assignValid}
            aria-describedby={assignValid ? undefined : ids.assignIssues}
            onClick={() => { setExpandedWeek(null); setStep('preview'); }}
          >
            Next: Preview Plan <span aria-hidden="true">→</span>
          </button>
          <button type="button" className="btn btn-secondary" onClick={() => setStep('configure')}>
            <span aria-hidden="true">←</span> Back
          </button>
        </div>
      </div>
    );
  }

  // ── Preview Step ───────────────────────────────────────────────────────────

  if (step === 'preview' && previewPlan) {
    const peakWeekMiles = Math.max(0, ...overview.map(o => o.totalMiles));

    return (
      <div className="plan-builder">
        <div className="plan-builder-header">
          <h2 className="plan-builder-title">Preview: {previewPlan.name}</h2>
          <p className="plan-builder-subtitle">
            {previewPlan.totalWeeks} weeks · {assignedRunDays} run days/week ·
            {' '}{Math.round(toUnit(currentMiles, unit))}→{Math.round(toUnit(peakMiles, unit))} {unitLabel(unit)}/week ·
            {' '}Peak: {formatMiles(peakWeekMiles, 1, unit)}/week
          </p>
        </div>

        {/* Weekly distance chart, coloured by periodization phase */}
        <div className="pb-chart" role="group" aria-label="Weekly distance by week. Select a week to show its workouts.">
          {overview.map((week, i) => {
            const phase = phaseForWeek(phases, i);
            const heightPct = peakWeekMiles > 0 ? (week.totalMiles / peakWeekMiles) * 100 : 0;
            const isCutback = week.totalMiles < (overview[Math.max(0, i - 1)]?.totalMiles ?? 0) * 0.9
              && i > 0 && i < overview.length - 2;
            const isExpanded = expandedWeek === i;
            const label = `Week ${week.weekNumber}: ${formatMiles(week.totalMiles, 1, unit)}, ${phase?.label ?? 'Training'}`
              + (isCutback ? ', cutback week' : '');
            return (
              <button
                key={week.weekNumber}
                type="button"
                className={`pb-chart-bar-btn pb-phase--${phase?.name ?? 'base'}${isCutback ? ' pb-chart-bar-btn--cutback' : ''}`}
                aria-label={label}
                title={label}
                aria-expanded={isExpanded}
                aria-controls={weekBodyId(i)}
                onClick={() => setExpandedWeek(isExpanded ? null : i)}
              >
                <span className="pb-chart-bar-track" aria-hidden="true">
                  <span className="pb-chart-bar" style={{ height: `${Math.max(heightPct, 4)}%` }} />
                </span>
                <span className="pb-chart-label" aria-hidden="true">{week.weekNumber}</span>
              </button>
            );
          })}
        </div>

        {/* Text legend: colour is never the only cue */}
        <ul className="pb-legend" aria-label="Training phases">
          {phases.map(phase => (
            <li key={phase.name} className={`pb-legend-item pb-phase--${phase.name}`}>
              <span className="pb-legend-swatch" aria-hidden="true" />
              <span className="pb-legend-name">{phase.label}</span>
              <span className="pb-legend-weeks">{weekRangeText(phase)}</span>
            </li>
          ))}
          <li className="pb-legend-item">
            <span className="pb-legend-swatch pb-legend-swatch--cutback" aria-hidden="true" />
            <span className="pb-legend-name">Faded bar: cutback week</span>
          </li>
        </ul>

        {/* Week-by-week expandable detail */}
        <div className="plan-builder-weeks">
          {previewPlan.weeks.map((week, weekIdx) => {
            const isExpanded = expandedWeek === weekIdx;
            const weekSummary = overview[weekIdx];
            const phase = phaseForWeek(phases, weekIdx);
            return (
              <div key={week.weekNumber} className="plan-builder-week">
                <button
                  type="button"
                  id={weekHeaderId(weekIdx)}
                  className="plan-builder-week-header"
                  aria-expanded={isExpanded}
                  aria-controls={weekBodyId(weekIdx)}
                  onClick={() => setExpandedWeek(isExpanded ? null : weekIdx)}
                >
                  <span className="plan-builder-week-num">
                    Week {week.weekNumber}
                    {phase && (
                      <>
                        {' '}
                        <span className={`plan-builder-week-badge pb-phase-badge pb-phase--${phase.name}`}>
                          {PHASE_SHORT[phase.name]}
                        </span>
                      </>
                    )}
                  </span>
                  <span className="plan-builder-week-miles">
                    {formatMiles(weekSummary.totalMiles, 1, unit)} · Long: {formatMiles(weekSummary.longRunMiles, 1, unit)}
                  </span>
                  <span className="plan-builder-week-chevron" aria-hidden="true">{isExpanded ? '▼' : '▶'}</span>
                </button>
                <div id={weekBodyId(weekIdx)} className="plan-builder-week-body" hidden={!isExpanded}>
                  {isExpanded && (
                    <table className="plan-builder-week-table">
                      <caption className="sr-only">Week {week.weekNumber} workouts</caption>
                      <thead>
                        <tr>
                          <th scope="col">Day</th>
                          <th scope="col">Workout</th>
                          <th scope="col">Distance</th>
                          {vdot > 0 && <th scope="col">Target Pace</th>}
                        </tr>
                      </thead>
                      <tbody>
                        {week.days.map((day, dayIdx) => {
                          const target = vdot > 0 && day.note ? getWorkoutTarget(day.note, vdot, day.distanceMi) : null;
                          const paceStr = target?.targetPaceRange
                            ? formatPaceRangeForUnit(target.targetPaceRange.minSecPerMi, target.targetPaceRange.maxSecPerMi, unit)
                            : '';
                          return (
                            <tr key={dayIdx}>
                              <td className="plan-builder-cell-day">{DAY_NAMES[dayIdx]}</td>
                              <td>{workoutTitle(day)}</td>
                              <td className="plan-builder-cell-dist">
                                {day.distanceMi != null ? formatMiles(day.distanceMi, 1, unit) : '—'}
                              </td>
                              {vdot > 0 && (
                                <td className="plan-builder-cell-pace">{paceStr || '—'}</td>
                              )}
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        <div className="plan-builder-actions">
          <button type="button" className="btn btn-primary" onClick={handleAcceptPlan}>
            <span aria-hidden="true">✓</span> Accept This Plan
          </button>
          <button type="button" className="btn btn-secondary" onClick={() => setStep('assign-days')}>
            <span aria-hidden="true">←</span> Edit Days
          </button>
          <button type="button" className="btn btn-secondary" onClick={() => setStep('configure')}>
            <span aria-hidden="true">←</span> Edit Config
          </button>
        </div>
      </div>
    );
  }

  return null;
}
