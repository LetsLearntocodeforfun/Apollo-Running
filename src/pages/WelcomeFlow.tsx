/**
 * First-run onboarding — "Onboarding v2" (v1.0.6).
 *
 * Steps: Units → Race & plan → Recent race (optional) → Connect → Done.
 * - Units come first, preselected from the system language (US, Liberia and
 *   Myanmar → miles) unless the athlete already chose a unit.
 * - Race-date-first: the chosen plan is placed so its race day lands on the race
 *   date (`RaceDatePlanSetup` → `previewStartPlan` → `startPlan`). When starting
 *   would clear the stored progress of an active plan, the athlete confirms first.
 * - The optional goal time and recent race go to the athlete profile, which
 *   drives VDOT, training paces and the race prediction.
 * - "Step n of N" + progress bar; Back walks a history stack of visited steps;
 *   every step change moves focus to the step's <h1>.
 *
 * App.tsx renders this outside the router, so no router hooks or <Link>s here.
 */
import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import {
  BUILT_IN_PLANS,
  CUSTOM_PLAN_ID,
  getCustomPlan,
  getPlanById,
  getPlanOverview,
  setCustomPlan,
  type TrainingPlan,
} from '../data/plans';
import PlanBuilder from '../components/PlanBuilder';
import {
  getActivePlan,
  previewStartPlan,
  setWelcomeCompleted,
  startPlan,
  type StartPlanInput,
} from '../services/planProgress';
import { getRaceDate } from '../services/journey';
import {
  isCoachingOnboardingDone,
  setCoachingPreferences,
  suggestWeeklyRecapDay,
} from '../services/coachingPreferences';
import {
  formatDistanceShort,
  formatMiles,
  getDistanceUnit,
  setDistanceUnit,
  type DistanceUnit,
} from '../services/unitPreferences';
import { getAthleteProfile, updateAthleteProfile, type RecentRace } from '../services/athleteProfile';
import { persistence } from '../services/db/persistence';
import {
  RaceDatePlanSetup,
  initialPlanSetupValue,
  planSetupError,
  planSetupToStartInput,
  type PlanSetupValue,
} from '../components/plan/RaceDatePlanSetup';
import { formatLongDate } from '../components/plan/planDisplay';
import { ConfirmDialog } from '../components/ui';
import { daysBetween, isDateKey, todayKey } from '../utils/localDate';
import '../components/plan/WelcomeFlow.css';

/** The file importer is only loaded when the athlete picks "Import files". */
const ImportActivities = lazy(() => import('../components/ImportActivities'));

type Step = 'units' | 'plan' | 'recent-race' | 'connect' | 'done';

/** Canonical order — drives "Step n of N". Back uses the visit history instead. */
const STEP_ORDER: readonly Step[] = ['units', 'plan', 'recent-race', 'connect', 'done'];

const STEP_TITLES: Record<Step, string> = {
  units: 'Welcome to Apollo',
  plan: 'Your race and plan',
  'recent-race': 'A recent race (optional)',
  connect: 'Connect your training data',
  done: 'You’re all set',
};

/** Plan radio value for "Skip — no plan for now". */
const NO_PLAN = 'none';

type ConnectChoice = 'connect' | 'import' | 'later';

/** Where "Connect intervals.icu or Strava" lands once onboarding is finished. */
const CONNECTIONS_HASH = '#/settings?tab=connections';

// ── Units ────────────────────────────────────────────────────────────────────

/**
 * Storage key of the distance unit (owned by unitPreferences). Read only to tell
 * "never chose" apart from "chose miles" — `getDistanceUnit()` defaults to 'mi'.
 */
const DISTANCE_UNIT_KEY = 'apollo_distance_unit';
const MILE_REGIONS = new Set(['US', 'LR', 'MM']);

/** Distance unit for a BCP 47 language tag: miles in the US, Liberia and Myanmar, otherwise km. */
function unitForLanguageTag(tag: string | null | undefined): DistanceUnit {
  if (!tag) return 'km';
  const [language = '', ...rest] = tag.replace(/_/g, '-').split('-');
  const region = rest.find((part) => /^[a-z]{2}$/i.test(part))?.toUpperCase();
  if (region) return MILE_REGIONS.has(region) ? 'mi' : 'km';
  return language.toLowerCase() === 'my' ? 'mi' : 'km';
}

/** The saved unit, or a default from the system language when the athlete never chose one. */
function initialDistanceUnit(): { unit: DistanceUnit; detected: boolean } {
  if (persistence.getItem(DISTANCE_UNIT_KEY)) return { unit: getDistanceUnit(), detected: false };
  const tag = typeof navigator === 'undefined' ? undefined : navigator.language;
  return { unit: unitForLanguageTag(tag), detected: true };
}

// ── Times ────────────────────────────────────────────────────────────────────

/** Seconds for "H:MM:SS" (and "MM:SS" when `allowMinutes`), or null when the text doesn't match. */
function parseDuration(text: string, allowMinutes: boolean): number | null {
  const t = text.trim();
  const hms = /^(\d{1,2}):([0-5]\d):([0-5]\d)$/.exec(t);
  if (hms) return Number(hms[1]) * 3600 + Number(hms[2]) * 60 + Number(hms[3]);
  if (!allowMinutes) return null;
  const ms = /^(\d{1,3}):([0-5]\d)$/.exec(t);
  return ms ? Number(ms[1]) * 60 + Number(ms[2]) : null;
}

/** "3:45:00" for durations of an hour or more, otherwise "45:30". */
function formatDuration(totalSec: number): string {
  const s = Math.round(totalSec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

/** Bounds the athlete profile accepts for a goal (values outside are dropped on save). */
const GOAL_MIN_SEC = 2 * 3600 - 300; // 1:55:00
const GOAL_MAX_SEC = 8 * 3600; // 8:00:00

type GoalResult = { ok: true; sec: number | null } | { ok: false; error: string };

/** Validate the optional goal marathon time (empty = no goal). */
function validateGoal(text: string): GoalResult {
  if (!text.trim()) return { ok: true, sec: null };
  const sec = parseDuration(text, false);
  if (sec === null) return { ok: false, error: 'Use H:MM:SS for the goal time, e.g. 3:45:00.' };
  if (sec < GOAL_MIN_SEC || sec > GOAL_MAX_SEC) {
    return { ok: false, error: 'Enter a marathon goal between 1:55:00 and 8:00:00.' };
  }
  return { ok: true, sec };
}

// ── Recent race ──────────────────────────────────────────────────────────────

interface RaceDistanceOption {
  id: string;
  label: string;
  distanceM: number;
  /** Just under the world record — anything faster is a typo. */
  minSec: number;
}

const RACE_DISTANCES: readonly RaceDistanceOption[] = [
  { id: '5k', label: '5K', distanceM: 5000, minSec: 12 * 60 },
  { id: '10k', label: '10K', distanceM: 10000, minSec: 26 * 60 },
  { id: 'half', label: 'Half marathon', distanceM: 21097.5, minSec: 57 * 60 },
  { id: 'marathon', label: 'Marathon', distanceM: 42195, minSec: 119 * 60 },
];

const MAX_RACE_SEC = 24 * 3600;

interface RecentRaceForm {
  distanceId: string;
  time: string;
  date: string;
}

interface RecentRaceErrors {
  time?: string;
  date?: string;
}

function distanceOption(id: string): RaceDistanceOption {
  return RACE_DISTANCES.find((d) => d.id === id) ?? RACE_DISTANCES[1];
}

/** Prefill from a recent race already in the profile (standard distances only). */
function initialRecentRaceForm(): RecentRaceForm {
  const saved = getAthleteProfile().recentRace;
  const match = saved ? RACE_DISTANCES.find((d) => Math.abs(d.distanceM - saved.distanceM) < 1) : undefined;
  if (saved && match) return { distanceId: match.id, time: formatDuration(saved.timeSec), date: saved.date };
  return { distanceId: '10k', time: '', date: '' };
}

/** The race to save, or per-field errors. */
function validateRecentRace(form: RecentRaceForm, today: string): { race?: RecentRace; errors: RecentRaceErrors } {
  const distance = distanceOption(form.distanceId);
  const errors: RecentRaceErrors = {};
  const timeSec = parseDuration(form.time, true);
  if (!form.time.trim()) errors.time = 'Enter your finish time, or skip this step.';
  else if (timeSec === null) errors.time = 'Use H:MM:SS or MM:SS, e.g. 1:45:30 or 45:30.';
  else if (timeSec < distance.minSec) errors.time = `That’s faster than the ${distance.label} world record — check the time.`;
  else if (timeSec > MAX_RACE_SEC) errors.time = 'Enter a time under 24 hours.';
  if (!isDateKey(form.date)) errors.date = 'Enter the race date.';
  else if (daysBetween(today, form.date) > 0) errors.date = 'The race date can’t be in the future.';
  if (errors.time || errors.date || timeSec === null) return { errors };
  return { race: { distanceM: distance.distanceM, timeSec, date: form.date }, errors };
}

function describeRecentRace(race: RecentRace): string {
  const match = RACE_DISTANCES.find((d) => Math.abs(d.distanceM - race.distanceM) < 1);
  const label = match ? match.label : formatDistanceShort(race.distanceM);
  return `${label} in ${formatDuration(race.timeSec)} · ${formatLongDate(race.date)}`;
}

// ── Plans ────────────────────────────────────────────────────────────────────

function peakWeeklyMiles(plan: TrainingPlan): number {
  return Math.max(0, ...getPlanOverview(plan).map((w) => w.totalMiles));
}

/** A start waiting for the "Restart this plan?" confirmation. */
interface PendingStart {
  input: StartPlanInput;
  goalSec: number | null;
  planName: string;
  completions: number;
}

// ── Layout ───────────────────────────────────────────────────────────────────

interface StepFrameProps {
  step: Step;
  headingRef: RefObject<HTMLHeadingElement>;
  /** Wider card for steps with long lists. */
  wide?: boolean;
  children: ReactNode;
}

/** Card shared by every step: step counter, progress bar and the step's focusable <h1>. */
function StepFrame({ step, headingRef, wide = false, children }: StepFrameProps) {
  const n = STEP_ORDER.indexOf(step) + 1;
  const total = STEP_ORDER.length;
  const label = `Step ${n} of ${total}`;
  return (
    <div className="welcome-flow">
      <main className={wide ? 'welcome-card welcome-overview' : 'welcome-card'}>
        <div className="wf-progress">
          <p className="wf-step-count">{label}</p>
          <div
            className="wf-progress-track"
            role="progressbar"
            aria-label="Setup progress"
            aria-valuemin={1}
            aria-valuemax={total}
            aria-valuenow={n}
            aria-valuetext={label}
          >
            <div className="wf-progress-fill" style={{ width: `${(n / total) * 100}%` }} />
          </div>
        </div>
        <h1 ref={headingRef} tabIndex={-1} className="welcome-title">
          {STEP_TITLES[step]}
        </h1>
        <div key={step}>{children}</div>
      </main>
    </div>
  );
}

interface RadioOptionProps {
  name: string;
  value: string;
  checked: boolean;
  onSelect: (value: string) => void;
  title: ReactNode;
  sub?: ReactNode;
  tag?: string;
}

/** A native radio inside a large clickable label (the label text is the accessible name). */
function RadioOption({ name, value, checked, onSelect, title, sub, tag }: RadioOptionProps) {
  return (
    <label className="wf-option">
      <input type="radio" name={name} value={value} checked={checked} onChange={() => onSelect(value)} />
      <span className="wf-option-body">
        {tag && <span className="wf-option-tag">{tag}</span>}
        <span className="wf-option-title">{title}</span>
        {sub && <span className="wf-option-sub">{sub}</span>}
      </span>
    </label>
  );
}

// ── Flow ─────────────────────────────────────────────────────────────────────

export default function WelcomeFlow({ onComplete }: { onComplete: () => void }) {
  const [history, setHistory] = useState<Step[]>(['units']);
  const step = history[history.length - 1];
  const headingRef = useRef<HTMLHeadingElement>(null);

  // Units
  const [unitDefault] = useState(initialDistanceUnit);
  const [unit, setUnit] = useState<DistanceUnit>(unitDefault.unit);

  // Race & plan
  const [planChoice, setPlanChoice] = useState<string | null>(() => {
    const active = getActivePlan();
    return active && getPlanById(active.planId) ? active.planId : null;
  });
  const [customPlan, setCustomPlanState] = useState<TrainingPlan | null>(() => getCustomPlan());
  const [showBuilder, setShowBuilder] = useState(false);
  const [setup, setSetup] = useState<PlanSetupValue>(() => initialPlanSetupValue());
  const [goalText, setGoalText] = useState(() => {
    const goal = getAthleteProfile().goalMarathonSec;
    return goal ? formatDuration(goal) : '';
  });
  const [goalError, setGoalError] = useState<string | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [pendingStart, setPendingStart] = useState<PendingStart | null>(null);

  // Recent race
  const [raceForm, setRaceForm] = useState<RecentRaceForm>(initialRecentRaceForm);
  const [raceErrors, setRaceErrors] = useState<RecentRaceErrors>({});

  // Connect
  const [connectChoice, setConnectChoice] = useState<ConnectChoice | null>(null);

  const planPeaks = useMemo(() => BUILT_IN_PLANS.map((plan) => ({ plan, peakMi: peakWeeklyMiles(plan) })), []);

  // Focus the new step's heading so keyboard and screen-reader users start at the top.
  useEffect(() => {
    headingRef.current?.focus();
  }, [step]);

  const goTo = (next: Step) => setHistory((h) => [...h, next]);
  const goBack = () => setHistory((h) => (h.length > 1 ? h.slice(0, -1) : h));

  const finish = (choice: ConnectChoice | null) => {
    if (!isCoachingOnboardingDone()) {
      // Find the long run day to suggest a weekly recap day (the day after it).
      const active = getActivePlan();
      const plan = active ? getPlanById(active.planId) : undefined;
      const longRunIdx = plan?.weeks[0]?.days.findIndex((d) => d.note?.toLowerCase() === 'long') ?? -1;
      setCoachingPreferences({
        weeklyRecapDay: suggestWeeklyRecapDay(longRunIdx >= 0 ? longRunIdx : null),
        onboardingDone: true,
      });
    }
    setWelcomeCompleted(true);
    if (choice === 'connect') window.location.hash = CONNECTIONS_HASH;
    onComplete();
  };

  // ── Step 1: units ──
  if (step === 'units') {
    return (
      <StepFrame step={step} headingRef={headingRef}>
        <p className="welcome-text">
          Apollo turns your marathon plan into a day-by-day checklist, syncs your runs and keeps you on track to race day.
          A few quick questions first.
        </p>
        <fieldset className="wf-fieldset">
          <legend className="wf-legend">Distance units</legend>
          <div className="wf-choice-grid">
            <RadioOption
              name="welcome-unit"
              value="mi"
              checked={unit === 'mi'}
              onSelect={() => setUnit('mi')}
              title="Miles"
              sub="mi · min/mi · ft"
            />
            <RadioOption
              name="welcome-unit"
              value="km"
              checked={unit === 'km'}
              onSelect={() => setUnit('km')}
              title="Kilometres"
              sub="km · min/km · m"
            />
          </div>
        </fieldset>
        <p className="welcome-hint">
          {unitDefault.detected ? 'Preselected from your system language. ' : ''}
          Used for distances, paces and splits everywhere — you can change it any time in Settings.
        </p>
        <div className="welcome-actions wf-actions">
          <button
            type="button"
            className="btn btn-primary welcome-btn"
            onClick={() => {
              setDistanceUnit(unit);
              goTo('plan');
            }}
          >
            Continue
          </button>
          <button
            type="button"
            className="btn btn-secondary welcome-btn"
            onClick={() => {
              setDistanceUnit(unit);
              finish(null);
            }}
          >
            Skip setup
          </button>
        </div>
      </StepFrame>
    );
  }

  // ── Step 2: race & plan ──
  if (step === 'plan') {
    const selectedPlan: TrainingPlan | null =
      planChoice === null || planChoice === NO_PLAN
        ? null
        : planChoice === CUSTOM_PLAN_ID
          ? customPlan
          : (getPlanById(planChoice) ?? null);
    const builderOpen = planChoice === CUSTOM_PLAN_ID && (showBuilder || !customPlan);

    const choosePlan = (id: string) => {
      setPlanChoice(id);
      setPlanError(null);
      setShowBuilder(id === CUSTOM_PLAN_ID && !customPlan);
    };

    const saveGoal = (sec: number | null) => {
      if (sec !== null) updateAthleteProfile({ goalMarathonSec: sec });
      else if (getAthleteProfile().goalMarathonSec !== undefined) updateAthleteProfile({ goalMarathonSec: undefined });
    };

    const commitStart = (input: StartPlanInput, goalSec: number | null) => {
      startPlan(input);
      saveGoal(goalSec);
      setPendingStart(null);
      goTo('recent-race');
    };

    const handleContinue = () => {
      setPlanError(null);
      const goal = validateGoal(goalText);
      setGoalError(goal.ok ? null : goal.error);
      if (planChoice === null) {
        setPlanError('Choose a plan, or “Skip — no plan for now”.');
        return;
      }
      if (planChoice !== NO_PLAN && builderOpen) {
        setPlanError('Finish building your custom plan first, or choose another plan.');
        return;
      }
      if (!goal.ok) return;
      if (planChoice === NO_PLAN) {
        saveGoal(goal.sec);
        goTo('recent-race');
        return;
      }
      if (!selectedPlan) {
        setPlanError('That plan isn’t available — choose another one.');
        return;
      }
      const input = planSetupToStartInput(planChoice, setup);
      if (!input) {
        setPlanError(planSetupError(setup) ?? 'Choose your race date.');
        return;
      }
      const preview = previewStartPlan(input);
      if (getActivePlan() && preview.isNewInstance && (preview.clears.completions > 0 || preview.clears.overlay)) {
        setPendingStart({ input, goalSec: goal.sec, planName: selectedPlan.name, completions: preview.clears.completions });
        return;
      }
      commitStart(input, goal.sec);
    };

    return (
      <StepFrame step={step} headingRef={headingRef} wide>
        <p className="welcome-text">
          Pick a plan, then enter your race date — Apollo places the plan so race day lands on it.
        </p>
        <fieldset className="wf-fieldset">
          <legend className="wf-legend">Training plan</legend>
          <div className="wf-option-list">
            {planPeaks.map(({ plan, peakMi }) => (
              <RadioOption
                key={plan.id}
                name="welcome-plan"
                value={plan.id}
                checked={planChoice === plan.id}
                onSelect={choosePlan}
                title={plan.name}
                sub={`${plan.author} · ${plan.totalWeeks} weeks · peak ~${formatMiles(peakMi, 0, unit)} a week`}
              />
            ))}
            <RadioOption
              name="welcome-plan"
              value={CUSTOM_PLAN_ID}
              checked={planChoice === CUSTOM_PLAN_ID}
              onSelect={choosePlan}
              title={customPlan ? `Your custom plan: ${customPlan.name}` : 'Build my own plan'}
              sub={customPlan ? `${customPlan.totalWeeks} weeks · made with the plan builder` : 'Set your weeks, run days and mileage.'}
            />
            <RadioOption
              name="welcome-plan"
              value={NO_PLAN}
              checked={planChoice === NO_PLAN}
              onSelect={choosePlan}
              title="Skip — no plan for now"
              sub="You can pick a plan later on the Plan page."
            />
          </div>
        </fieldset>

        {builderOpen && (
          <div className="wf-panel">
            <PlanBuilder
              onComplete={(built) => {
                setCustomPlan(built);
                setCustomPlanState(built);
                setShowBuilder(false);
              }}
              onCancel={() => {
                setShowBuilder(false);
                if (!customPlan) setPlanChoice(null);
              }}
            />
          </div>
        )}

        {selectedPlan && !builderOpen && (
          <section className="wf-panel" aria-labelledby="welcome-race-heading">
            <h2 id="welcome-race-heading" className="wf-subtitle">
              When is your race?
            </h2>
            <RaceDatePlanSetup plan={selectedPlan} value={setup} onChange={setSetup} idPrefix="welcome" />
            {planChoice === CUSTOM_PLAN_ID && (
              <div className="wf-inline-actions">
                <button type="button" className="btn btn-secondary" onClick={() => setShowBuilder(true)}>
                  Rebuild custom plan
                </button>
              </div>
            )}
          </section>
        )}

        <div className="wf-field">
          <label htmlFor="welcome-goal">Goal marathon time (optional)</label>
          <input
            id="welcome-goal"
            className="wf-input"
            type="text"
            autoComplete="off"
            placeholder="3:45:00"
            value={goalText}
            onChange={(e) => setGoalText(e.target.value)}
            aria-invalid={goalError ? true : undefined}
            aria-describedby={goalError ? 'welcome-goal-hint welcome-goal-error' : 'welcome-goal-hint'}
          />
          <p id="welcome-goal-hint" className="wf-hint">
            H:MM:SS — used for goal pacing and race-day strategy.
          </p>
          {goalError && (
            <p id="welcome-goal-error" className="wf-error" role="alert">
              {goalError}
            </p>
          )}
        </div>

        {planError && (
          <p className="wf-error" role="alert">
            {planError}
          </p>
        )}

        <div className="welcome-actions wf-actions">
          <button type="button" className="btn btn-primary welcome-btn" onClick={handleContinue}>
            Continue
          </button>
          <button type="button" className="btn btn-secondary welcome-btn" onClick={goBack}>
            Back
          </button>
        </div>

        <ConfirmDialog
          open={pendingStart !== null}
          tone="danger"
          title="Restart this plan?"
          message="Progress for this plan will be cleared."
          confirmLabel="Restart plan"
          cancelLabel="Keep my progress"
          onConfirm={() => {
            if (pendingStart) commitStart(pendingStart.input, pendingStart.goalSec);
          }}
          onCancel={() => setPendingStart(null)}
        >
          {pendingStart && pendingStart.completions > 0 && (
            <p className="welcome-hint">
              {pendingStart.completions} completed {pendingStart.completions === 1 ? 'day' : 'days'} of {pendingStart.planName}{' '}
              will be reset, along with any moved or skipped workouts.
            </p>
          )}
        </ConfirmDialog>
      </StepFrame>
    );
  }

  // ── Step 3: recent race (optional) ──
  if (step === 'recent-race') {
    const handleSave = () => {
      const result = validateRecentRace(raceForm, todayKey());
      setRaceErrors(result.errors);
      if (!result.race) return;
      updateAthleteProfile({ recentRace: result.race });
      goTo('connect');
    };

    return (
      <StepFrame step={step} headingRef={headingRef}>
        <p className="welcome-text">
          A recent all-out race lets Apollo set your training paces and race prediction from day one. Haven’t raced lately?
          Skip this step.
        </p>
        <div className="wf-fields">
          <div className="wf-field">
            <label htmlFor="welcome-race-distance">Distance</label>
            <select
              id="welcome-race-distance"
              className="wf-input"
              value={raceForm.distanceId}
              onChange={(e) => setRaceForm({ ...raceForm, distanceId: e.target.value })}
            >
              {RACE_DISTANCES.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.label}
                </option>
              ))}
            </select>
          </div>
          <div className="wf-field">
            <label htmlFor="welcome-race-time">Finish time</label>
            <input
              id="welcome-race-time"
              className="wf-input"
              type="text"
              autoComplete="off"
              placeholder="45:00"
              value={raceForm.time}
              onChange={(e) => setRaceForm({ ...raceForm, time: e.target.value })}
              aria-invalid={raceErrors.time ? true : undefined}
              aria-describedby={raceErrors.time ? 'welcome-race-time-hint welcome-race-time-error' : 'welcome-race-time-hint'}
            />
            <p id="welcome-race-time-hint" className="wf-hint">
              H:MM:SS or MM:SS
            </p>
            {raceErrors.time && (
              <p id="welcome-race-time-error" className="wf-error" role="alert">
                {raceErrors.time}
              </p>
            )}
          </div>
          <div className="wf-field">
            <label htmlFor="welcome-race-date">Race date</label>
            <input
              id="welcome-race-date"
              className="wf-input"
              type="date"
              max={todayKey()}
              value={raceForm.date}
              onChange={(e) => setRaceForm({ ...raceForm, date: e.target.value })}
              aria-invalid={raceErrors.date ? true : undefined}
              aria-describedby={raceErrors.date ? 'welcome-race-date-error' : undefined}
            />
            {raceErrors.date && (
              <p id="welcome-race-date-error" className="wf-error" role="alert">
                {raceErrors.date}
              </p>
            )}
          </div>
        </div>
        <div className="welcome-actions wf-actions">
          <button type="button" className="btn btn-primary welcome-btn" onClick={handleSave}>
            Save and continue
          </button>
          <button
            type="button"
            className="btn btn-secondary welcome-btn"
            onClick={() => {
              setRaceErrors({});
              goTo('connect');
            }}
          >
            Skip this step
          </button>
          <button type="button" className="btn btn-secondary welcome-btn" onClick={goBack}>
            Back
          </button>
        </div>
      </StepFrame>
    );
  }

  // ── Step 4: connect ──
  if (step === 'connect') {
    return (
      <StepFrame step={step} headingRef={headingRef} wide={connectChoice === 'import'}>
        <p className="welcome-text">
          Apollo checks off plan days from your runs. Sync them from <strong>intervals.icu</strong> (free — works with
          Garmin, COROS, Suunto, Polar, Wahoo and Zwift) or <strong>Strava</strong>, or import files from your watch.
        </p>
        <fieldset className="wf-fieldset">
          <legend className="wf-legend">How do you want to add your runs?</legend>
          <div className="wf-option-list">
            <RadioOption
              name="welcome-connect"
              value="connect"
              checked={connectChoice === 'connect'}
              onSelect={() => setConnectChoice('connect')}
              title="Connect intervals.icu or Strava"
              sub="Settings › Connections opens when you finish setup."
            />
            <RadioOption
              name="welcome-connect"
              value="import"
              checked={connectChoice === 'import'}
              onSelect={() => setConnectChoice('import')}
              title="Import files"
              sub="FIT, GPX or TCX files, or a full Garmin or Strava account export."
            />
            <RadioOption
              name="welcome-connect"
              value="later"
              checked={connectChoice === 'later'}
              onSelect={() => setConnectChoice('later')}
              title="Not now"
              sub="You can connect a source any time in Settings."
            />
          </div>
        </fieldset>

        {connectChoice === 'import' && (
          <section className="wf-panel" aria-labelledby="welcome-import-heading">
            <h2 id="welcome-import-heading" className="wf-subtitle">
              Import files
            </h2>
            <Suspense fallback={<p className="welcome-hint">Loading the importer…</p>}>
              <ImportActivities compact />
            </Suspense>
          </section>
        )}

        <div className="welcome-actions wf-actions">
          <button type="button" className="btn btn-primary welcome-btn" onClick={() => goTo('done')}>
            Continue
          </button>
          <button type="button" className="btn btn-secondary welcome-btn" onClick={goBack}>
            Back
          </button>
        </div>
      </StepFrame>
    );
  }

  // ── Step 5: done ──
  const active = getActivePlan();
  const activePlan = active ? getPlanById(active.planId) : undefined;
  const raceDay = active ? getRaceDate() : null;
  const profile = getAthleteProfile();
  const dataSummary =
    connectChoice === 'connect'
      ? 'Settings › Connections opens next.'
      : connectChoice === 'import'
        ? 'Imported here — you can import more on the Activities page.'
        : 'Not connected yet — connect any time in Settings.';

  return (
    <StepFrame step={step} headingRef={headingRef}>
      <p className="welcome-text">Here’s your setup. You can change any of it later in Settings or on the Plan page.</p>
      <dl className="wf-summary">
        <div className="wf-summary-row">
          <dt>Units</dt>
          <dd>{unit === 'km' ? 'Kilometres' : 'Miles'}</dd>
        </div>
        <div className="wf-summary-row">
          <dt>Plan</dt>
          <dd>
            {active && activePlan
              ? `${activePlan.name} (${activePlan.author})${active.joinedWeekIndex ? ` — joining at week ${active.joinedWeekIndex + 1}` : ''}`
              : 'No plan yet'}
          </dd>
        </div>
        {active && (
          <div className="wf-summary-row">
            <dt>Week 1 starts</dt>
            <dd>{formatLongDate(active.startDate)}</dd>
          </div>
        )}
        {raceDay && (
          <div className="wf-summary-row">
            <dt>Race day</dt>
            <dd>{formatLongDate(raceDay)}</dd>
          </div>
        )}
        <div className="wf-summary-row">
          <dt>Goal time</dt>
          <dd>{profile.goalMarathonSec ? formatDuration(profile.goalMarathonSec) : 'Not set'}</dd>
        </div>
        <div className="wf-summary-row">
          <dt>Recent race</dt>
          <dd>{profile.recentRace ? describeRecentRace(profile.recentRace) : 'Not added'}</dd>
        </div>
        <div className="wf-summary-row">
          <dt>Your runs</dt>
          <dd>{dataSummary}</dd>
        </div>
      </dl>
      <div className="welcome-actions wf-actions">
        <button type="button" className="btn btn-primary welcome-btn" onClick={() => finish(connectChoice)}>
          {connectChoice === 'connect' ? 'Finish and open Connections' : 'Go to Today'}
        </button>
        <button type="button" className="btn btn-secondary welcome-btn" onClick={goBack}>
          Back
        </button>
      </div>
    </StepFrame>
  );
}
