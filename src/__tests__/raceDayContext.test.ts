/**
 * Race Day hub state and actions (v1.0.6): default tab by days to race,
 * race-date ownership (active plan vs My Race), the goal chain
 * (strategy → profile → prediction), mismatched strategies, and the
 * explicit My Race actions. All pure reads except the actions.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  RACE_DAY_TABS,
  buildRaceDayState,
  defaultTabForDays,
  isRaceDayTab,
} from '@/components/race/context';
import { chooseMyRace, setMyRaceDate } from '@/components/race/actions';
import {
  FALLBACK_MARATHON_GOAL_SEC,
  getDefaultGoalSec,
  getMarathonGoal,
  scaleMarathonTime,
} from '@/components/race/goal';
import { getMyRace, setMyRace } from '@/services/myRace';
import { setActivePlan } from '@/services/planProgress';
import { updateAthleteProfile } from '@/services/athleteProfile';
import { buildRaceStrategy, getMarathon, importCustomMarathon, saveStrategy } from '@/services/raceStrategy';
import { persistence } from '@/services/db/persistence';
import type { MarathonRace, RaceStrategy } from '@/types/raceStrategy';

const TODAY = '2026-10-08';

function race(id: string): MarathonRace {
  const r = getMarathon(id);
  if (!r) throw new Error(`fixture: no race ${id}`);
  return r;
}

function savedStrategy(raceId: string, goalSec: number): RaceStrategy {
  const s = buildRaceStrategy(raceId, goalSec, 'even-split');
  if (!s) throw new Error('fixture: strategy did not build');
  saveStrategy(s);
  return s;
}

function activatePlan(raceDate: string): void {
  setActivePlan({ planId: 'hal-higdon-novice-1', startDate: '2026-06-22', raceDate });
}

beforeEach(() => {
  // Freeze only Date so World Major editions resolve as of Oct 8 2026.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 9, 8, 12, 0, 0));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('defaultTabForDays', () => {
  it.each([
    [60, 'strategy'],
    [22, 'strategy'],
    [21, 'fuel'],
    [8, 'fuel'],
    [7, 'race-week'],
    [1, 'race-week'],
    [0, 'race-morning'],
    [-1, 'strategy'],
    [null, 'strategy'],
  ] as const)('%s days → %s', (days, tab) => {
    expect(defaultTabForDays(days)).toBe(tab);
  });

  it('knows the five hub tabs in order', () => {
    expect(RACE_DAY_TABS.map((t) => t.label)).toEqual(['Strategy', 'Fuel', 'Race Week', 'Race Morning', 'Course']);
    expect(isRaceDayTab('race-week')).toBe(true);
    expect(isRaceDayTab('weather')).toBe(false);
    expect(isRaceDayTab(null)).toBe(false);
  });
});

describe('buildRaceDayState', () => {
  it('empty data: no race, no date, no goal — and nothing is written', () => {
    const state = buildRaceDayState(TODAY);
    expect(state.ctx).toEqual({
      race: null,
      raceDate: null,
      startTime: null,
      timeZone: null,
      wave: null,
      goalTimeSec: null,
      strategy: null,
      today: TODAY,
      daysToRace: null,
    });
    expect(state.hasActivePlan).toBe(false);
    expect(state.raceDateSource).toBeNull();
    expect(state.raceDateMismatch).toBeNull();
    expect(state.goalSource).toBeNull();
    expect(state.raceMissing).toBe(false);
    expect(persistence.keys()).toEqual([]);
  });

  it('My Race without a plan: date, start time and zone from My Race / the race', () => {
    chooseMyRace(race('chicago'));
    setMyRace({ wave: 'Wave 2' });
    const state = buildRaceDayState(TODAY);
    expect(state.ctx.race?.id).toBe('chicago');
    expect(state.ctx.raceDate).toBe('2026-10-11');
    expect(state.raceDateSource).toBe('my-race');
    expect(state.ctx.daysToRace).toBe(3);
    expect(state.ctx.startTime).toBe('07:30');
    expect(state.ctx.timeZone).toBe('America/Chicago');
    expect(state.ctx.wave).toBe('Wave 2');
    expect(defaultTabForDays(state.ctx.daysToRace)).toBe('race-week');
  });

  it('falls back to the race edition date when My Race has no date', () => {
    setMyRace({ raceId: 'nyc' });
    const state = buildRaceDayState(TODAY);
    expect(state.ctx.raceDate).toBe('2026-11-01');
    expect(state.raceDateSource).toBe('race');
    expect(state.ctx.daysToRace).toBe(24);
    expect(state.ctx.startTime).toBe('09:10');
  });

  it('a user-set start time and zone override the race defaults', () => {
    setMyRace({ raceId: 'chicago', startTime: '08:00', timeZone: 'America/New_York' });
    const state = buildRaceDayState(TODAY);
    expect(state.ctx.startTime).toBe('08:00');
    expect(state.ctx.timeZone).toBe('America/New_York');
  });

  it('with an active plan the plan owns the date, and a different race date is flagged', () => {
    setMyRace({ raceId: 'chicago', date: '2026-10-11' });
    activatePlan('2026-10-18');
    const state = buildRaceDayState(TODAY);
    expect(state.hasActivePlan).toBe(true);
    expect(state.ctx.raceDate).toBe('2026-10-18');
    expect(state.raceDateSource).toBe('plan');
    expect(state.raceDateMismatch).toEqual({ planDate: '2026-10-18', raceDate: '2026-10-11' });
    expect(state.ctx.daysToRace).toBe(10);
  });

  it('no mismatch notice when the plan date equals the race date', () => {
    setMyRace({ raceId: 'chicago' });
    activatePlan('2026-10-11');
    expect(buildRaceDayState(TODAY).raceDateMismatch).toBeNull();
  });

  it('goal chain: race-day strategy → profile goal (scaled to the distance) → none', () => {
    setMyRace({ raceId: 'chicago' });
    expect(buildRaceDayState(TODAY).goalSource).toBeNull();

    updateAthleteProfile({ goalMarathonSec: 3 * 3600 + 30 * 60 });
    let state = buildRaceDayState(TODAY);
    expect(state.goalSource).toBe('profile');
    expect(state.ctx.goalTimeSec).toBe(12600);

    const s = savedStrategy('chicago', 3 * 3600 + 45 * 60);
    setMyRace({ activeStrategyId: s.id });
    state = buildRaceDayState(TODAY);
    expect(state.goalSource).toBe('strategy');
    expect(state.ctx.goalTimeSec).toBe(13500);
    expect(state.ctx.strategy?.id).toBe(s.id);
  });

  it('scales the profile goal to a half marathon with Riegel', () => {
    updateAthleteProfile({ goalMarathonSec: 4 * 3600 });
    const half = importCustomMarathon({
      name: 'Harvest Half', city: 'Portland', country: 'USA', date: '2026-11-15', courseType: 'loop', distanceMi: 13.1,
    });
    setMyRace({ raceId: half.id });
    const state = buildRaceDayState(TODAY);
    expect(state.ctx.goalTimeSec).toBe(scaleMarathonTime(14400, 13.1));
    expect(state.ctx.goalTimeSec).toBeGreaterThan(6600);
    expect(state.ctx.goalTimeSec).toBeLessThan(7000);
  });

  it('ignores a race-day strategy that belongs to another race', () => {
    updateAthleteProfile({ goalMarathonSec: 4 * 3600 });
    const boston = savedStrategy('boston', 3 * 3600 + 30 * 60);
    setMyRace({ raceId: 'chicago', activeStrategyId: boston.id });
    const state = buildRaceDayState(TODAY);
    expect(state.ctx.strategy).toBeNull();
    expect(state.mismatchedStrategy?.id).toBe(boston.id);
    expect(state.goalSource).toBe('profile');
    expect(state.ctx.goalTimeSec).toBe(14400);
  });

  it('flags a My Race that points at a removed race', () => {
    setMyRace({ raceId: 'custom-gone-1700000000000-abcde' });
    const state = buildRaceDayState(TODAY);
    expect(state.raceMissing).toBe(true);
    expect(state.ctx.race).toBeNull();
  });

  it('is pure: resolving state never writes', () => {
    setMyRace({ raceId: 'boston-marathon-2026' });
    updateAthleteProfile({ goalMarathonSec: 4 * 3600 });
    const before = JSON.stringify(persistence.toRecord());
    const spy = vi.spyOn(persistence, 'setItem');
    buildRaceDayState(TODAY);
    buildRaceDayState('2027-04-19');
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    expect(JSON.stringify(persistence.toRecord())).toBe(before);
  });
});

describe('My Race actions', () => {
  it('chooseMyRace copies id, start time and zone, and writes the date only without a plan', () => {
    const saved = chooseMyRace(race('chicago'));
    expect(saved).toMatchObject({ raceId: 'chicago', date: '2026-10-11', startTime: '07:30', timeZone: 'America/Chicago' });
  });

  it('chooseMyRace never writes the date while a plan is active', () => {
    activatePlan('2026-10-18');
    const saved = chooseMyRace(race('chicago'));
    expect(saved.raceId).toBe('chicago');
    expect(saved.date).toBeUndefined();
    expect(getMyRace().date).toBeUndefined();
  });

  it('changing race clears the wave and a strategy for the old race; same race keeps them', () => {
    const chicagoPlan = savedStrategy('chicago', 4 * 3600);
    chooseMyRace(race('chicago'));
    setMyRace({ wave: 'Wave 2', activeStrategyId: chicagoPlan.id });

    chooseMyRace(race('chicago'));
    expect(getMyRace()).toMatchObject({ wave: 'Wave 2', activeStrategyId: chicagoPlan.id });

    chooseMyRace(race('nyc'));
    const after = getMyRace();
    expect(after.raceId).toBe('nyc');
    expect(after.wave).toBeUndefined();
    expect(after.activeStrategyId).toBeUndefined();
    expect(after.date).toBe('2026-11-01');
  });

  it('setMyRaceDate writes only a valid date and only without a plan', () => {
    expect(setMyRaceDate('2026-13-01')).toBe(false);
    expect(getMyRace().date).toBeUndefined();
    expect(setMyRaceDate('2026-10-25')).toBe(true);
    expect(getMyRace().date).toBe('2026-10-25');

    activatePlan('2026-10-18');
    expect(setMyRaceDate('2026-11-01')).toBe(false);
    expect(getMyRace().date).toBe('2026-10-25');
  });
});

describe('goal defaults', () => {
  it('profile goal → prediction → 4:00:00 fallback', () => {
    expect(getMarathonGoal()).toEqual({ sec: FALLBACK_MARATHON_GOAL_SEC, source: 'default' });
    updateAthleteProfile({ goalMarathonSec: 3 * 3600 });
    expect(getMarathonGoal()).toEqual({ sec: 10800, source: 'profile' });
  });

  it('scales by distance and keeps the marathon unchanged', () => {
    expect(scaleMarathonTime(14400, 26.2)).toBe(14400);
    expect(scaleMarathonTime(14400, 26.21875)).toBe(14400);
    expect(scaleMarathonTime(14400, 0)).toBe(14400);
    const half = scaleMarathonTime(14400, 13.1);
    expect(half).toBe(Math.round(14400 * Math.pow(13.1 / 26.21875, 1.06)));
    expect(getDefaultGoalSec(13.1)).toBe(half);
  });
});
