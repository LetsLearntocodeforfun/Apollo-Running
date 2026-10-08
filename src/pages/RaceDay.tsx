/**
 * Race Day hub (/race), v1.0.6.
 *
 * One page for everything about the goal race: a "My race" header card and
 * tabs (in the URL as ?tab=) for Strategy, Fuel, Race Week, Race Morning and
 * Course. Without ?tab= the default follows the days to race: > 21 Strategy,
 * 8–21 Fuel, 1–7 Race Week, race day Race Morning.
 *
 * Always on (no opt-in gate). The race date comes from `journey.getRaceDate()`
 * (the active plan owns it); the goal from the athlete profile. Nothing is
 * written on render.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Tabs, TabPanel } from '../components/ui';
import MyRaceCard from '../components/race/MyRaceCard';
import StrategyPanel from '../components/race/StrategyPanel';
import FuelPanel from '../components/race/FuelPanel';
import RaceWeekPanel from '../components/race/RaceWeekPanel';
import RaceMorningPanel from '../components/race/RaceMorningPanel';
import CourseTrainingCard from '../components/race/CourseTrainingCard';
import {
  buildRaceDayState,
  defaultTabForDays,
  isRaceDayTab,
  RACE_DAY_TABS,
  type RaceDayTab,
} from '../components/race/context';
import { chooseMyRace } from '../components/race/actions';
import { onMyRaceChanged } from '../services/myRace';
import { onAthleteProfileChanged } from '../services/athleteProfile';
import { onPlanEvent, PLAN_OVERLAY_CHANGED_EVENT, PLAN_PROGRESS_CHANGED_EVENT } from '../services/planEvents';
import { todayKey } from '../utils/localDate';
import type { MarathonRace } from '../types/raceStrategy';
import './RaceDay.css';

const TAB_PREFIX = 'raceday';

export default function RaceDay() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [version, setVersion] = useState(0);
  const refresh = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => {
    const offs = [
      onMyRaceChanged(refresh),
      onAthleteProfileChanged(refresh),
      onPlanEvent(PLAN_OVERLAY_CHANGED_EVENT, refresh),
      onPlanEvent(PLAN_PROGRESS_CHANGED_EVENT, refresh),
    ];
    return () => offs.forEach((off) => off());
  }, [refresh]);

  const today = todayKey();
  // `version` re-resolves the state after My Race / profile / plan changes.
  const state = useMemo(() => {
    void version;
    return buildRaceDayState(today);
  }, [today, version]);
  const { ctx } = state;

  const tabParam = searchParams.get('tab');
  const tab: RaceDayTab = isRaceDayTab(tabParam) ? tabParam : defaultTabForDays(ctx.daysToRace);

  const goToTab = useCallback((next: string) => {
    if (!isRaceDayTab(next)) return;
    const params = new URLSearchParams(searchParams);
    params.set('tab', next);
    setSearchParams(params, { replace: true });
  }, [searchParams, setSearchParams]);

  const handleChooseRace = useCallback((race: MarathonRace) => {
    chooseMyRace(race);
    refresh();
  }, [refresh]);

  return (
    <div className="race-day">
      <h1 className="page-title">Race Day</h1>

      <MyRaceCard state={state} onChooseRace={handleChooseRace} onGoToTab={goToTab} />

      <Tabs
        label="Race Day sections"
        idPrefix={TAB_PREFIX}
        tabs={RACE_DAY_TABS}
        value={tab}
        onChange={goToTab}
        className="rd-tabs"
      />
      <TabPanel idPrefix={TAB_PREFIX} id={tab} className="rd-tabpanel">
        {tab === 'strategy' && <StrategyPanel ctx={ctx} onChooseRace={handleChooseRace} onChanged={refresh} />}
        {tab === 'fuel' && <FuelPanel ctx={ctx} />}
        {tab === 'race-week' && <RaceWeekPanel ctx={ctx} />}
        {tab === 'race-morning' && <RaceMorningPanel ctx={ctx} />}
        {tab === 'course' && <CourseTrainingCard ctx={ctx} />}
      </TabPanel>
    </div>
  );
}
