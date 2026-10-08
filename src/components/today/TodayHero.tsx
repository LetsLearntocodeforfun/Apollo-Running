import { Link } from 'react-router-dom';
import type { JourneyState } from '../../services/journey';
import { EmptyState } from '../ui';
import TodayWorkout, { type TodayWorkoutProps } from './TodayWorkout';
import { formatWeekdayDate, relativeDaysText } from './todayModel';

/** Workout props the hero completes with its heading level and taper flag. */
export type HeroWorkoutProps = Omit<TodayWorkoutProps, 'headingLevel' | 'taper'>;

export interface TodayHeroProps {
  journey: JourneyState;
  /** Today's local date key. */
  today: string;
  /** Active plan start date (pre-plan countdown). */
  startDate: string | null;
  /** Today's workout in the effective plan, or null when today is outside it. */
  workout: HeroWorkoutProps | null;
}

/** Phase-aware hero: what to do today in every phase of the journey. */
export default function TodayHero({ journey, today, startDate, workout }: TodayHeroProps) {
  return (
    <section className="card today-hero" aria-label="Today’s plan">
      <HeroBody journey={journey} today={today} startDate={startDate} workout={workout} />
    </section>
  );
}

function HeroBody({ journey, today, startDate, workout }: TodayHeroProps) {
  const days = journey.daysToRace;
  switch (journey.phase) {
    case 'pre-plan': {
      const start = startDate ?? '';
      return (
        <div className="today-hero-banner">
          <p className="today-eyebrow">Plan countdown</p>
          <h2 className="today-hero-title">Your plan starts {formatWeekdayDate(start)}</h2>
          <p className="today-text">
            Week 1 begins {relativeDaysText(today, start)}. Until then, keep running easy a few times a week to build your base.
          </p>
          <div className="today-actions">
            <Link to="/plan" className="btn btn-secondary">View your plan</Link>
          </div>
        </div>
      );
    }
    case 'training':
    case 'taper':
      return workout
        ? <TodayWorkout {...workout} headingLevel={2} taper={journey.phase === 'taper'} />
        : <NothingToday />;
    case 'race-week':
      return (
        <>
          <div className="today-hero-banner">
            <p className="today-eyebrow">Race week</p>
            <h2 className="today-hero-title">
              {days != null && days > 0 ? `${days} ${days === 1 ? 'day' : 'days'} to go` : 'Race week'}
            </h2>
            <p className="today-text">Keep runs short and easy, sleep well, hydrate and get your race-day kit ready.</p>
            <div className="today-actions">
              <Link to="/race?tab=race-week" className="btn btn-primary">Race week checklist</Link>
            </div>
          </div>
          {workout && <TodayWorkout {...workout} headingLevel={3} />}
        </>
      );
    case 'race-day':
      return (
        <div className="today-hero-banner">
          <p className="today-eyebrow">Race day</p>
          <h2 className="today-hero-title">Race day!</h2>
          <p className="today-text">Start conservatively, fuel early and trust your training. You’ve got this.</p>
          <div className="today-actions">
            <Link to="/race?tab=race-morning" className="btn btn-primary">Race morning plan</Link>
          </div>
        </div>
      );
    case 'post-race':
      return (
        <div className="today-hero-banner">
          <p className="today-eyebrow">Recovery</p>
          <h2 className="today-hero-title">Recover well</h2>
          <p className="today-text">
            Congratulations on your race! Take the next one to two weeks easy: walk, rest, and only jog gently when your legs feel fresh.
          </p>
          <div className="today-actions">
            <Link to="/race" className="btn btn-secondary">Review your race</Link>
            <Link to="/plan" className="today-link">Pick your next plan</Link>
          </div>
        </div>
      );
    case 'off-season':
      return (
        <div className="today-hero-banner">
          <p className="today-eyebrow">Off-season</p>
          <h2 className="today-hero-title">Between training blocks</h2>
          <p className="today-text">Enjoy relaxed running and cross-training. When you’re ready, pick a new race and plan.</p>
          <div className="today-actions">
            <Link to="/plan" className="btn btn-primary">Pick your next plan</Link>
          </div>
        </div>
      );
    case 'no-plan':
    default:
      return (
        <EmptyState
          icon="🏁"
          title="No training plan yet"
          action={<Link to="/plan" className="btn btn-primary">Pick a training plan</Link>}
        >
          Choose a plan from Hal Higdon, Hansons, Pfitzinger and more, set your race date, and Apollo schedules every run.
        </EmptyState>
      );
  }
}

function NothingToday() {
  return (
    <div className="today-hero-banner">
      <h2 className="today-hero-title">Nothing scheduled today</h2>
      <p className="today-text">Your plan has no session for today. <Link to="/plan">Open your plan</Link></p>
    </div>
  );
}
