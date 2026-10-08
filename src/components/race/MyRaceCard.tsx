/**
 * "My race" header card of the Race Day hub (v1.0.6): race picker, race date
 * (read-only from the active plan, editable otherwise), countdown, start
 * time + time zone + wave, goal time and the race-day strategy.
 */
import { Link } from 'react-router-dom';
import { getAllMarathons, formatDurationSec } from '../../services/raceStrategy';
import { isDateKey, parseDateKey } from '../../utils/localDate';
import { setMyRaceDate } from './actions';
import type { RaceDayState, RaceDayTab } from './context';
import type { MarathonRace } from '../../types/raceStrategy';

interface Props {
  state: RaceDayState;
  onChooseRace: (race: MarathonRace) => void;
  onGoToTab: (tab: RaceDayTab) => void;
}

/** "Sun, Oct 11, 2026" for a YYYY-MM-DD key. */
export function formatRaceDate(dateKey: string | null): string {
  if (!dateKey || !isDateKey(dateKey)) return 'Not set';
  return parseDateKey(dateKey).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

/** "7:30 AM" for a 24 h 'HH:mm' string. */
export function formatClock(hhmm: string | null): string {
  if (!hhmm || !/^\d{2}:\d{2}$/.test(hhmm)) return '';
  const [h, m] = hhmm.split(':').map(Number);
  const suffix = h < 12 ? 'AM' : 'PM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${suffix}`;
}

/** Short time-zone name for a zone on a date, e.g. 'CDT', or '' when unknown. */
export function timeZoneAbbrev(timeZone: string | null, dateKey: string | null): string {
  if (!timeZone) return '';
  try {
    const [y, mo, d] = (dateKey && isDateKey(dateKey) ? dateKey : '2026-06-01').split('-').map(Number);
    const instant = new Date(Date.UTC(y, mo - 1, d, 12));
    const part = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'short' })
      .formatToParts(instant)
      .find((p) => p.type === 'timeZoneName');
    return part?.value ?? '';
  } catch {
    return '';
  }
}

/** Countdown copy for a number of calendar days to the race. */
export function countdownText(days: number | null): string {
  if (days === null) return 'No race date yet';
  if (days === 0) return 'Race day!';
  if (days === 1) return 'Tomorrow';
  if (days > 1) return days >= 14 ? `${days} days to go (${Math.floor(days / 7)} weeks)` : `${days} days to go`;
  const ago = -days;
  return `Race was ${ago} day${ago === 1 ? '' : 's'} ago`;
}

const GOAL_SOURCE_TEXT: Record<string, string> = {
  strategy: 'from your race-day strategy',
  profile: 'from your profile',
  prediction: 'predicted from your training',
};

/** The hub's header card. All writes happen in response to user input. */
export default function MyRaceCard({ state, onChooseRace, onGoToTab }: Props) {
  const { ctx, myRace, hasActivePlan, raceDateMismatch, goalSource, mismatchedStrategy, raceMissing } = state;
  const race = ctx.race;
  const marathons = getAllMarathons();
  const majors = marathons.filter((m) => m.isWorldMajor);
  const customs = marathons.filter((m) => !m.isWorldMajor);
  const tz = timeZoneAbbrev(ctx.timeZone, ctx.raceDate);
  const start = formatClock(ctx.startTime);

  return (
    <section className="card rd-myrace" aria-labelledby="rd-myrace-title">
      <div className="rd-myrace-head">
        <h2 id="rd-myrace-title" className="rd-myrace-title">My race</h2>
        <p className="rd-countdown" data-testid="rd-countdown">{countdownText(ctx.daysToRace)}</p>
      </div>

      <div className="rd-grid">
        <div className="rd-field">
          <label className="rd-label" htmlFor="rd-race-select">Race</label>
          <select
            id="rd-race-select"
            className="rd-input"
            value={race?.id ?? ''}
            onChange={(e) => {
              const picked = marathons.find((m) => m.id === e.target.value);
              if (picked) onChooseRace(picked);
            }}
          >
            <option value="" disabled>Choose a race…</option>
            <optgroup label="World Marathon Majors">
              {majors.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </optgroup>
            {customs.length > 0 && (
              <optgroup label="Your races">
                {customs.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
              </optgroup>
            )}
          </select>
          {race && (
            <p className="rd-hint">
              {[race.city, race.country].filter(Boolean).join(', ')}
              {race.dateEstimated ? ' · date to be confirmed' : ''}
            </p>
          )}
        </div>

        <div className="rd-field">
          {hasActivePlan ? (
            <>
              <p className="rd-label">Race date</p>
              <p className="rd-value">{formatRaceDate(ctx.raceDate)}</p>
              <p className="rd-hint">From your training plan</p>
            </>
          ) : (
            <>
              <label className="rd-label" htmlFor="rd-race-date">Race date</label>
              <input
                id="rd-race-date"
                className="rd-input"
                type="date"
                value={myRace.date ?? ctx.raceDate ?? ''}
                onChange={(e) => { if (isDateKey(e.target.value)) setMyRaceDate(e.target.value); }}
              />
              {state.raceDateSource === 'race' && <p className="rd-hint">The race's next date. Change it if you're running another year.</p>}
            </>
          )}
        </div>

        <div className="rd-field">
          <p className="rd-label">Start</p>
          <p className="rd-value">
            {start ? `${start}${tz ? ` ${tz}` : ''}` : 'Not set'}
            {ctx.wave ? ` · ${ctx.wave}` : ''}
          </p>
          <p className="rd-hint">
            <button type="button" className="rd-link-btn" onClick={() => onGoToTab('race-morning')}>
              {start ? 'Edit start and wave' : 'Set your start time'}
            </button>
          </p>
        </div>

        <div className="rd-field">
          <p className="rd-label">Goal</p>
          <p className="rd-value rd-gold">{ctx.goalTimeSec ? formatDurationSec(ctx.goalTimeSec) : 'Not set'}</p>
          <p className="rd-hint">
            {goalSource && GOAL_SOURCE_TEXT[goalSource] ? `${GOAL_SOURCE_TEXT[goalSource]} · ` : ''}
            <Link to="/settings?tab=profile">{ctx.goalTimeSec ? 'Edit goal' : 'Set a goal'}</Link>
          </p>
        </div>

        <div className="rd-field">
          <p className="rd-label">Race-day strategy</p>
          <p className="rd-value">{ctx.strategy ? ctx.strategy.name : 'None yet'}</p>
          <p className="rd-hint">
            <button type="button" className="rd-link-btn" onClick={() => onGoToTab('strategy')}>
              {ctx.strategy ? 'Change strategy' : race ? 'Build or choose one' : 'Pick a race first'}
            </button>
          </p>
        </div>
      </div>

      {raceDateMismatch && race && (
        <div className="rd-notice" role="note">
          <p>
            <strong>Dates don't match.</strong> Your training plan's race day is {formatRaceDate(raceDateMismatch.planDate)}, but {race.name} is on {formatRaceDate(raceDateMismatch.raceDate)}.
            {' '}Change the race date in your plan if you're running {race.name}.
          </p>
          <p><Link to="/plan">Open your training plan</Link></p>
        </div>
      )}
      {mismatchedStrategy && race && (
        <p className="rd-notice" role="note">
          Your saved race-day strategy “{mismatchedStrategy.name}” is for {mismatchedStrategy.marathonName}, not {race.name}. Choose a strategy for this race on the Strategy tab.
        </p>
      )}
      {raceMissing && (
        <p className="rd-notice" role="note">The race you picked earlier is no longer available. Choose a race above.</p>
      )}
    </section>
  );
}
