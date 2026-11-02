/**
 * v1.0.9: plans without a race day — the base, recovery and maintenance blocks
 * (and imported blocks) have no `marathon` day, so they yield no race date, race
 * week, race day or post-race phase of their own. Race-date consumers fall back to
 * the athlete's My Race date, setup gives the block's first and last day, every
 * day of a block stays editable, and its training phase is one base phase.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { BUILT_IN_PLANS, SUPPLEMENTAL_PLANS, getPlanById } from '@/data/plans';
import {
  getActivePlan,
  getActivePlanRaceDate,
  getPlanRaceDayRef,
  getRaceDayRef,
  previewStartPlan,
  resolveActivePlanRaceDate,
  setActivePlan,
  startPlan,
} from '@/services/planProgress';
import {
  getEffectivePlan,
  getEffectiveDay,
  getEffectiveRaceDayRef,
  moveWorkout,
  skipWorkout,
} from '@/services/planOverlay';
import { getJourneyState, getRaceDate } from '@/services/journey';
import { getMyRace, setMyRace } from '@/services/myRace';
import { getMarathon } from '@/services/raceStrategy';
import { importAndSavePlanText } from '@/services/planImportExport';
import { buildRaceDayState } from '@/components/race/context';
import { chooseMyRace, setMyRaceDate } from '@/components/race/actions';
import MyRaceCard from '@/components/race/MyRaceCard';
import { DayActionsMenu } from '@/components/plan/DayActionsMenu';
import { PhaseRibbon } from '@/components/plan/PhaseRibbon';
import { RaceDatePlanSetup, planSetupError, planSetupToStartInput } from '@/components/plan/RaceDatePlanSetup';
import { addDays } from '@/utils/localDate';

const BLOCK_ID = 'apollo-base-8';
const START = '2026-11-02'; // a Monday
const END = '2026-12-27'; // Sunday of week 8
const block = getPlanById(BLOCK_ID)!;

afterEach(() => cleanup());

function startBlock(planId = BLOCK_ID, startDate = START) {
  return startPlan({ planId, startDate }, startDate);
}

describe('race day of a plan without a marathon day', () => {
  it('the base and recovery blocks have no race day; marathon plans keep theirs', () => {
    expect(SUPPLEMENTAL_PLANS.length).toBeGreaterThan(0);
    for (const p of SUPPLEMENTAL_PLANS) {
      expect(getPlanRaceDayRef(p), p.id).toBeNull();
      // Past the end of the grid, so overlay guards never treat a block day as race day.
      expect(getRaceDayRef(p), p.id).toEqual({ weekIndex: p.weeks.length, dayIndex: 0 });
    }
    for (const p of BUILT_IN_PLANS) {
      const ref = getPlanRaceDayRef(p);
      expect(ref, p.id).not.toBeNull();
      expect(getRaceDayRef(p)).toEqual(ref);
      expect(p.weeks[ref!.weekIndex].days[ref!.dayIndex].type).toBe('marathon');
    }
  });

  it('starting a block stores no race date, even when one is passed', () => {
    const active = startPlan({ planId: BLOCK_ID, startDate: '2026-11-04' }, START);
    expect(active.startDate).toBe(START);
    expect(active.raceDate).toBeUndefined();
    expect(resolveActivePlanRaceDate(active)).toBeNull();
    expect(getActivePlanRaceDate()).toBeNull();
    expect(getRaceDate()).toBeNull();

    const preview = previewStartPlan({ planId: BLOCK_ID, raceDate: '2027-04-25' }, START);
    expect(preview.placement).toBeNull();
    expect(preview.active.raceDate).toBeUndefined();
    expect(preview.active.startDate).toBe(START);
  });

  it('race-date consumers fall back to the My Race date', () => {
    setMyRace({ date: '2027-04-25' });
    startBlock();
    expect(getRaceDate()).toBe('2027-04-25');
    expect(getJourneyState(START)).toMatchObject({ raceDate: '2027-04-25', daysToRace: 174 });
  });

  it('ignores a race date an earlier build stored for a block', () => {
    setActivePlan({ planId: BLOCK_ID, startDate: START, raceDate: END, startedAt: '2026-11-01T12:00:00.000Z' });
    expect(getRaceDate()).toBeNull();
    setMyRace({ date: '2027-04-25' });
    expect(getRaceDate()).toBe('2027-04-25');
  });

  it('a marathon plan still owns its race date over My Race', () => {
    setMyRace({ date: '2027-05-02' });
    startPlan({ planId: 'hal-higdon-novice-1', raceDate: '2027-04-25' }, START);
    expect(getRaceDate()).toBe('2027-04-25');
    expect(getActivePlanRaceDate()).toBe('2027-04-25');
  });

  it('an imported plan without a marathon day is a block too', () => {
    const day = (mi: number) => ({ type: 'run', label: `${mi} mi easy`, distanceMi: mi, note: 'Easy' });
    const rest = { type: 'rest', label: 'Rest' };
    const res = importAndSavePlanText(
      JSON.stringify({ name: 'Club base', weeks: [{ days: [rest, day(4), day(5), day(4), rest, day(3), day(8)] }] }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    startPlan({ planId: res.plan.id, startDate: START }, START);
    expect(getActivePlan()?.raceDate).toBeUndefined();
    expect(getRaceDate()).toBeNull();
    expect(getJourneyState(addDays(START, 6)).phase).toBe('training');
  });
});

describe('journey while a block is active', () => {
  it('has pre-plan, training and off-season phases — no taper, race week, race day or post-race', () => {
    startBlock();
    expect(getJourneyState('2026-10-30').phase).toBe('pre-plan');
    for (let i = 0; i < block.weeks.length * 7; i++) {
      const j = getJourneyState(addDays(START, i));
      expect(j.phase, `day ${i}`).toBe('training');
      expect(j.raceDate).toBeNull();
      expect(j.daysToRace).toBeNull();
      expect(['taper', 'race']).not.toContain(j.trainingPhase);
    }
    expect(getJourneyState(END)).toMatchObject({ phase: 'training', weekIndex: 7, dayIndex: 6, totalWeeks: 8 });
    expect(getJourneyState(addDays(END, 1)).phase).toBe('off-season');
    expect(getJourneyState('2027-02-01').phase).toBe('off-season');
  });

  it('the athlete’s own race still brings race week and race day, and the block stays in view after it', () => {
    setMyRace({ date: '2026-12-10' });
    startBlock();
    expect(getJourneyState('2026-12-07')).toMatchObject({ phase: 'race-week', daysToRace: 3, weekIndex: 5 });
    expect(getJourneyState('2026-12-10').phase).toBe('race-day');
    expect(getJourneyState('2026-12-13')).toMatchObject({ phase: 'training', daysToRace: -3 });
  });

  it('a recovery block after a marathon: recovery before it starts, its workouts once it runs', () => {
    setMyRace({ date: '2026-11-01' });
    startPlan({ planId: 'apollo-recovery-4', startDate: '2026-11-09' }, '2026-11-04');
    expect(getJourneyState('2026-11-04').phase).toBe('post-race');
    expect(getJourneyState('2026-11-10')).toMatchObject({ phase: 'training', weekIndex: 0, dayIndex: 1 });
    expect(getJourneyState('2026-12-10').phase).toBe('off-season');
  });
});

describe('plan overlay and day menu while a block is active', () => {
  it('every day of the block can be changed — the last one is not a race day', () => {
    startBlock();
    const plan = getEffectivePlan()!;
    expect(plan.weeks).toHaveLength(8);
    const last = { weekIndex: 7, dayIndex: 6 };
    expect(getEffectiveDay(last)?.type).toBe('run');
    expect(moveWorkout({ weekIndex: 7, dayIndex: 5 }, last)).toEqual({ ok: true });
    expect(skipWorkout(last)).toEqual({ ok: true });
    expect(getEffectiveDay(last)?.skipped).toBe(true);
  });

  it('the ⋯ menu offers Skip on the last day of the block', () => {
    startBlock();
    const plan = getEffectivePlan()!;
    render(<DayActionsMenu plan={plan} weekIndex={7} dayIndex={6} dayLabel="Sun, Dec 27" />);
    fireEvent.click(screen.getByRole('button', { name: /^Change Sun, Dec 27/ }));
    expect(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Skip' })).toBeTruthy();
  });

  it('getEffectiveRaceDayRef: none for a block, the marathon day for a marathon plan', () => {
    startBlock();
    expect(getEffectiveRaceDayRef()).toBeNull();
    startPlan({ planId: 'hal-higdon-novice-1', raceDate: '2027-04-24' }, START); // a Saturday race
    const ref = getEffectiveRaceDayRef();
    expect(ref).toEqual(getPlanRaceDayRef(getEffectivePlan()!));
    expect(ref).toEqual({ weekIndex: 17, dayIndex: 5 });
    expect(getEffectiveDay(ref!)?.type).toBe('marathon');
  });
});

describe('training phases of a block', () => {
  it('Today’s phase is Base on every day of the block', () => {
    startBlock();
    for (let i = 0; i < block.weeks.length * 7; i++) {
      expect(getJourneyState(addDays(START, i)).trainingPhase, `day ${i}`).toBe('base');
    }
  });

  it('the Plan page ribbon shows one Base Building segment — no Taper or Race Week', () => {
    for (const p of SUPPLEMENTAL_PLANS) {
      const { unmount } = render(<PhaseRibbon plan={p} currentWeekIndex={p.weeks.length - 1} />);
      const segments = screen.getAllByRole('listitem');
      expect(segments, p.id).toHaveLength(1);
      expect(segments[0].textContent).toContain('Base Building');
      expect(segments[0].textContent).toContain(`Weeks 1–${p.weeks.length}`);
      expect(segments[0].getAttribute('aria-current')).toBe('step');
      expect(screen.queryByText(/Taper|Race Week/)).toBeNull();
      unmount();
    }
  });
});

describe('Race Day hub while a block is active', () => {
  it('My Race owns the race date: no plan source, no mismatch notice', () => {
    setMyRace({ raceId: 'chicago', date: '2027-04-25' });
    startBlock();
    const state = buildRaceDayState(START);
    expect(state.hasActivePlan).toBe(true);
    expect(state.planOwnsRaceDate).toBe(false);
    expect(state.raceDateSource).toBe('my-race');
    expect(state.ctx.raceDate).toBe('2027-04-25');
    expect(state.raceDateMismatch).toBeNull();
  });

  it('the My Race date can be set and a chosen race writes its date', () => {
    startBlock();
    expect(setMyRaceDate('2027-05-02')).toBe(true);
    expect(getMyRace().date).toBe('2027-05-02');
    const nyc = getMarathon('nyc')!;
    expect(chooseMyRace(nyc).date).toBe(nyc.date);
  });

  it('My Race card: the date stays editable and says why', () => {
    setMyRace({ date: '2027-04-25' });
    startBlock();
    render(
      <MemoryRouter>
        <MyRaceCard state={buildRaceDayState(START)} onChooseRace={vi.fn()} onGoToTab={vi.fn()} />
      </MemoryRouter>,
    );
    expect((screen.getByLabelText('Race date') as HTMLInputElement).value).toBe('2027-04-25');
    expect(screen.getByText('Your current plan has no race day, so your race date is set here.')).toBeTruthy();
    expect(screen.queryByText('From your training plan')).toBeNull();
    expect(screen.getByTestId('rd-countdown').textContent).toBe('174 days to go (24 weeks)');
  });
});

describe('RaceDatePlanSetup for a block', () => {
  const value = { raceDate: '2027-04-25', useStartDate: false, startDate: START };

  it('asks for a start date only and previews the block’s first and last day', () => {
    const onChange = vi.fn();
    render(
      <RaceDatePlanSetup plan={block} value={value} onChange={onChange} idPrefix="blk" today={START} fitness={null} />,
    );
    expect(screen.queryByLabelText('Race date')).toBeNull();
    expect(screen.queryByLabelText('Advanced: choose a start date instead')).toBeNull();
    const startInput = screen.getByLabelText('Start date') as HTMLInputElement;
    expect(startInput.value).toBe(START);
    const status = screen.getByRole('status').textContent ?? '';
    expect(status).toContain('Week 1 starts Monday, November 2, 2026');
    expect(status).toContain('the block ends Sunday, December 27, 2026');
    expect(status).not.toMatch(/race day/i);
    fireEvent.change(startInput, { target: { value: '2026-11-11' } });
    expect(onChange).toHaveBeenCalledWith({ ...value, startDate: '2026-11-11' });
  });

  it('says when a past start date joins the block part-way', () => {
    render(
      <RaceDatePlanSetup
        plan={block}
        value={value}
        onChange={vi.fn()}
        idPrefix="blk2"
        today="2026-11-18"
        fitness={null}
      />,
    );
    expect(screen.getByRole('status').textContent).toMatch(/you’ll join at week 3/);
  });

  it('turns the value into a start-date start, whatever the race date says', () => {
    expect(planSetupToStartInput(BLOCK_ID, { ...value, startDate: '2026-11-04' }, START)).toEqual({
      planId: BLOCK_ID,
      startDate: '2026-11-04',
    });
    const noStart = { ...value, startDate: '' };
    expect(planSetupError(noStart, START, block)).toBe('Choose a start date.');
    expect(planSetupToStartInput(BLOCK_ID, noStart, START)).toBeNull();
    // Marathon plans are unchanged: the race date places them.
    expect(planSetupToStartInput('hal-higdon-novice-1', value, START)).toEqual({
      planId: 'hal-higdon-novice-1',
      raceDate: '2027-04-25',
    });
  });
});
