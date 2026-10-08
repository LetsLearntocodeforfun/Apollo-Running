/**
 * Shared props contract for the Race Day hub panels (v1.0.6).
 *
 * RaceDay.tsx builds one `RaceDayContext` and passes it to every tab panel:
 * Strategy, Fuel (FuelPanel), Race Week (RaceWeekPanel), Race Morning
 * (RaceMorningPanel) and Course (CourseTrainingCard). Panels must render a
 * helpful empty state when `race` or `strategy` is null, and must not
 * persist anything as a side effect of rendering.
 */
import type { MarathonRace, RaceStrategy } from '../../types/raceStrategy';

export interface RaceDayContext {
  /** Selected race (World Major dated to its next edition, or a custom race). */
  race: MarathonRace | null;
  /** Race date, YYYY-MM-DD (plan race date → My Race date → edition date). */
  raceDate: string | null;
  /** Race-local start time of the athlete's wave, 24 h 'HH:mm'. */
  startTime: string | null;
  /** IANA time zone of the race (e.g. 'America/Chicago'). */
  timeZone: string | null;
  /** Start wave / corral label. */
  wave: string | null;
  /** Goal finish time (s): active strategy target, else athleteProfile.goalMarathonSec. */
  goalTimeSec: number | null;
  /** The active saved strategy, if any. */
  strategy: RaceStrategy | null;
  /** Today's local date key. */
  today: string;
  /** Calendar days from today to the race (0 = race day, negative = past). */
  daysToRace: number | null;
}

/** Props every hub panel receives. */
export interface RacePanelProps {
  ctx: RaceDayContext;
}
