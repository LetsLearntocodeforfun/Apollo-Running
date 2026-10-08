import { Fragment } from 'react';
import { Link } from 'react-router-dom';
import type { JourneyState } from '../../services/journey';
import { countdownText, formatWeekdayDate, journeyHeaderParts } from './todayModel';

export interface TodayHeaderProps {
  journey: JourneyState;
  /** Today's local date key. */
  today: string;
  /** e.g. "Welcome back, Marc" (omitted when the athlete is unknown). */
  greeting?: string | null;
  /** e.g. "intervals.icu" or "Not connected". */
  sourceName: string;
  connected: boolean;
}

/**
 * Page header: the only h1, today's date and the journey line
 * "Week 9 of 18 · Build · 47 days to race" (unknown parts are left out).
 */
export default function TodayHeader({ journey, today, greeting, sourceName, connected }: TodayHeaderProps) {
  const parts = [formatWeekdayDate(today), ...journeyHeaderParts(journey)];
  const countdown = countdownText(journey.daysToRace);
  const sourceText = connected ? sourceName : 'Connect a data source';

  return (
    <header className="today-header">
      <div className="today-header-main">
        <h1 className="today-title" tabIndex={-1}>Today</h1>
        <p className="today-journey">
          {parts.map((part, i) => (
            <Fragment key={part}>
              {i > 0 && <span className="today-journey-sep" aria-hidden="true">·</span>}
              <span className={part === countdown ? 'today-journey-countdown' : undefined}>{part}</span>
            </Fragment>
          ))}
        </p>
        {greeting && <p className="today-greeting">{greeting}</p>}
      </div>
      <Link
        to="/settings"
        className={`today-source${connected ? ' today-source--connected' : ''}`}
        aria-label={connected ? `Activities sync from ${sourceName}. Open Settings` : 'No data source connected. Open Settings to connect one'}
      >
        <span aria-hidden="true">{connected ? '●' : '○'}</span>
        {sourceText}
      </Link>
    </header>
  );
}
