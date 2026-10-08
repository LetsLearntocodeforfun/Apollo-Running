import { useEffect, useState } from 'react';
import { getRaceDate } from '../services/journey';
import { onPlanOverlayChanged } from '../services/planOverlay';
import { onMyRaceChanged } from '../services/myRace';
import { daysBetween, todayKey } from '../utils/localDate';

/** Calendar days from today to the goal race (0 on race day), or null when there is no upcoming race. */
export function computeDaysToRace(today: string = todayKey()): number | null {
  const raceDate = getRaceDate();
  if (!raceDate) return null;
  const days = daysBetween(today, raceDate);
  return days >= 0 ? days : null;
}

/**
 * Days to the goal race for the nav badge. Re-reads when the plan or race
 * changes (plan started/cleared, race date edited, My Race saved) and when the
 * window regains focus, so the count rolls over after midnight.
 */
export function useRaceCountdown(): number | null {
  const [days, setDays] = useState<number | null>(() => computeDaysToRace());

  useEffect(() => {
    const refresh = () => setDays(computeDaysToRace());
    const onVisible = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    const offPlan = onPlanOverlayChanged(refresh);
    const offRace = onMyRaceChanged(refresh);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      offPlan();
      offRace();
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  return days;
}
