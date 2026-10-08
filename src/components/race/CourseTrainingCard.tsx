/**
 * Course training card — Race Day hub, Course tab (v1.0.6).
 *
 * Header: course difficulty (text + 1-10 meter), course type, distance and
 * gain/loss in the athlete's unit. Body: course-specific workouts grouped by
 * training window ("Now" / "Upcoming" / "Window passed") relative to the race
 * date, then collapsible weekly guidance, taper notes and race-day tips.
 * Pure presentation: nothing is persisted.
 */
import { useId, useMemo, useState } from 'react';
import { EmptyState } from '../ui';
import type { RacePanelProps } from './types';
import type { MarathonRace } from '../../types/raceStrategy';
import {
  generateCourseTraining,
  getCourseFacts,
  groupWorkoutsByWindow,
} from '../../services/courseTraining';
import type { CourseWorkout, WorkoutWindows } from '../../services/courseTraining';
import { formatElevation, formatMiles, getDistanceUnit } from '../../services/unitPreferences';
import type { DistanceUnit } from '../../services/unitPreferences';
import { getTemperatureUnit } from '../../services/athleteProfile';
import './CourseTraining.css';

const M_PER_FT = 0.3048;

const PRIORITY_LABEL: Record<CourseWorkout['priority'], string> = {
  1: 'Essential',
  2: 'Recommended',
  3: 'Optional',
};

const CATEGORY_LABEL: Record<CourseWorkout['category'], string> = {
  hill: 'Hills',
  long_run: 'Long run',
  tempo: 'Tempo',
  specific: 'Race-specific',
  surface: 'Surface',
  mental: 'Mental',
};

const COURSE_TYPE_LABEL: Record<MarathonRace['courseType'], string> = {
  loop: 'Loop',
  'point-to-point': 'Point-to-point',
  'out-and-back': 'Out-and-back',
  'multi-loop': 'Multi-loop',
};

type DifficultyTone = 'easy' | 'moderate' | 'hard' | 'very-hard';

function difficultyTone(d: number): DifficultyTone {
  if (d <= 3) return 'easy';
  if (d <= 6) return 'moderate';
  if (d <= 8) return 'hard';
  return 'very-hard';
}

const DIFFICULTY_LABEL: Record<DifficultyTone, string> = {
  easy: 'Easy',
  moderate: 'Moderate',
  hard: 'Hard',
  'very-hard': 'Very hard',
};

function elevationText(ft: number, unit: DistanceUnit): string {
  return formatElevation(ft * M_PER_FT, unit);
}

function weeksOutText(weeksOut: string): string {
  return `${weeksOut.replace('-', '–')} weeks out`;
}

function weeksToRaceText(weeks: number): string {
  if (weeks <= 0) return 'race week';
  return weeks === 1 ? '1 week out' : `${weeks} weeks out`;
}

/** Course training card for the Race Day hub. */
export default function CourseTrainingCard({ ctx }: RacePanelProps) {
  const headingId = useId();
  if (!ctx.race) {
    return (
      <section className="ct-card" aria-labelledby={headingId}>
        <h2 id={headingId} className="ct-title">Course training</h2>
        <EmptyState icon="⛰️" title="No race selected">
          Choose your race to see course-specific workouts, taper notes and race-day tips.
        </EmptyState>
      </section>
    );
  }
  return <CourseTrainingContent race={ctx.race} daysToRace={ctx.daysToRace} headingId={headingId} />;
}

interface ContentProps {
  race: MarathonRace;
  daysToRace: number | null;
  headingId: string;
}

function CourseTrainingContent({ race, daysToRace, headingId }: ContentProps) {
  const unit = getDistanceUnit();
  const temperatureUnit = getTemperatureUnit();
  const plan = useMemo(
    () => generateCourseTraining(race, { unit, temperatureUnit }),
    [race, unit, temperatureUnit],
  );
  const facts = useMemo(() => getCourseFacts(race), [race]);
  const weeksToRace = typeof daysToRace === 'number' && Number.isFinite(daysToRace) ? Math.floor(daysToRace / 7) : null;
  const groups: WorkoutWindows = useMemo(
    () => (weeksToRace === null
      ? { now: [], upcoming: [...plan.keyWorkouts].sort((a, b) => a.priority - b.priority), passed: [] }
      : groupWorkoutsByWindow(plan.keyWorkouts, weeksToRace)),
    [plan, weeksToRace],
  );

  const tone = difficultyTone(plan.difficulty);
  const net = facts.netDropFt === 0
    ? elevationText(0, unit)
    : `${facts.netDropFt > 0 ? '−' : '+'}${elevationText(Math.abs(facts.netDropFt), unit)}`;

  return (
    <section className="ct-card" aria-labelledby={headingId}>
      <header className="ct-header">
        <h2 id={headingId} className="ct-title">Course training</h2>
        <p className="ct-subtitle">
          {plan.source === 'generic'
            ? `Based on the ${race.name} course profile`
            : `Course-specific plan for ${race.name}`}
        </p>
      </header>

      <dl className="ct-facts">
        <div className="ct-fact ct-fact--difficulty">
          <dt>Course difficulty</dt>
          <dd>
            <span className="ct-difficulty-text">{plan.difficulty}/10 · {DIFFICULTY_LABEL[tone]}</span>
            <DifficultyMeter value={plan.difficulty} tone={tone} />
          </dd>
        </div>
        <div className="ct-fact">
          <dt>Course type</dt>
          <dd>{COURSE_TYPE_LABEL[race.courseType] ?? race.courseType}</dd>
        </div>
        <div className="ct-fact">
          <dt>Distance</dt>
          <dd>{formatMiles(facts.distanceMi, 1, unit)}</dd>
        </div>
        <div className="ct-fact">
          <dt>Elevation gain</dt>
          <dd>{elevationText(facts.gainFt, unit)}</dd>
        </div>
        <div className="ct-fact">
          <dt>Elevation loss</dt>
          <dd>{elevationText(facts.lossFt, unit)}</dd>
        </div>
        <div className="ct-fact">
          <dt>Net elevation</dt>
          <dd>{net}</dd>
        </div>
      </dl>

      {weeksToRace === null && (
        <p className="ct-note">
          <span aria-hidden="true">📅 </span>Set a race date to see which workouts are due now. All workouts are listed as upcoming.
        </p>
      )}
      {weeksToRace !== null && daysToRace !== null && daysToRace < 0 && (
        <p className="ct-note">Race day has passed — these workouts are shown for reference.</p>
      )}

      {weeksToRace !== null && (
        <WorkoutGroup
          title="Now"
          note={weeksToRaceText(weeksToRace)}
          tone="now"
          workouts={groups.now}
          emptyText="No course-specific workout is due this week — keep following your training plan."
        />
      )}
      {(weeksToRace === null || groups.upcoming.length > 0) && (
        <WorkoutGroup title="Upcoming" tone="upcoming" workouts={groups.upcoming} emptyText="Nothing coming up." />
      )}
      {groups.passed.length > 0 && (
        <WorkoutGroup title="Window passed" tone="passed" workouts={groups.passed} emptyText="" />
      )}

      <Disclosure title="Weekly guidance" icon="🗓️" items={plan.weeklyGuidance} />
      <Disclosure title="Taper notes" icon="🧘" items={plan.taperNotes} />
      <Disclosure title="Race-day execution tips" icon="🏁" items={plan.raceExecutionTips} />
    </section>
  );
}

function DifficultyMeter({ value, tone }: { value: number; tone: DifficultyTone }) {
  return (
    <div
      className={`ct-meter ct-meter--${tone}`}
      role="meter"
      aria-label="Course difficulty"
      aria-valuemin={1}
      aria-valuemax={10}
      aria-valuenow={value}
      aria-valuetext={`${value} out of 10, ${DIFFICULTY_LABEL[tone]}`}
    >
      {Array.from({ length: 10 }, (_, i) => (
        <span key={i} className={i < value ? 'ct-meter-seg ct-meter-seg--on' : 'ct-meter-seg'} />
      ))}
    </div>
  );
}

interface WorkoutGroupProps {
  title: string;
  note?: string;
  tone: 'now' | 'upcoming' | 'passed';
  workouts: CourseWorkout[];
  emptyText: string;
}

function WorkoutGroup({ title, note, tone, workouts, emptyText }: WorkoutGroupProps) {
  const id = useId();
  return (
    <section className={`ct-group ct-group--${tone}`} aria-labelledby={id}>
      <h3 id={id} className="ct-group-title">
        {title}
        {note && <span className="ct-group-note"> · {note}</span>}
      </h3>
      {workouts.length === 0 ? (
        <p className="ct-empty">{emptyText}</p>
      ) : (
        <ul className="ct-workouts">
          {workouts.map((w) => (
            <li key={w.name} className="ct-workout">
              <div className="ct-workout-head">
                <h4 className="ct-workout-name">{w.name}</h4>
                <span className={`ct-badge ct-badge--p${w.priority}`}>{PRIORITY_LABEL[w.priority]}</span>
              </div>
              <p className="ct-workout-desc">{w.description}</p>
              <p className="ct-workout-meta">
                {CATEGORY_LABEL[w.category]} · {weeksOutText(w.weeksOut)}
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

interface DisclosureProps {
  title: string;
  icon: string;
  items: string[];
}

function Disclosure({ title, icon, items }: DisclosureProps) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  if (items.length === 0) return null;
  return (
    <section className="ct-disclosure">
      <h3 className="ct-disclosure-heading">
        <button
          type="button"
          className="ct-disclosure-toggle"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((o) => !o)}
        >
          <span aria-hidden="true">{icon}</span>
          <span>{title}</span>
          <span className="ct-count">({items.length})</span>
          <span className="ct-chevron" aria-hidden="true">▾</span>
        </button>
      </h3>
      <div id={panelId} className="ct-disclosure-panel" hidden={!open}>
        <ul>
          {items.map((text, i) => (
            <li key={i}>{text}</li>
          ))}
        </ul>
      </div>
    </section>
  );
}
