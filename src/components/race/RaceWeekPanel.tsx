/**
 * Race Week tab of the Race Day hub (v1.0.6): the race-week checklist and
 * the printable race card.
 */
import type { RacePanelProps } from './types';
import RaceChecklistPanel from './RaceChecklistPanel';
import RaceCardPanel from './RaceCardPanel';
import './RaceWeek.css';

export default function RaceWeekPanel({ ctx }: RacePanelProps) {
  return (
    <div className="race-week">
      <RaceChecklistPanel ctx={ctx} />
      <RaceCardPanel ctx={ctx} />
    </div>
  );
}
