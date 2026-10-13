/**
 * v1.0.7 (T-3): late-join fitness check. Joining a plan part-way through (or at
 * week 1 of a high-volume plan) is compared with the runner's recent weekly
 * volume and 30-day longest run; unsafe jumps are flagged with a later race, a
 * ramp-in or a gentler plan.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { BUILT_IN_PLANS, getPlanById } from '@/data/plans';
import {
  checkJoinFitness,
  placePlan,
  safeLongRunMiles,
  safeWeeklyMiles,
  saferPlansForRace,
  summarizeRecentFitness,
} from '@/services/planProgress';
import { RaceDatePlanSetup } from '@/components/plan/RaceDatePlanSetup';

const TODAY = '2026-10-13'; // a Tuesday
const RACE_8_WEEKS = '2026-12-06'; // Sunday; 8 plan weeks including this one
const novice1 = getPlanById('hal-higdon-novice-1')!;
const pfitz = getPlanById('pfitzinger-18-55')!;

afterEach(() => cleanup());

describe('summarizeRecentFitness (T-3)', () => {
  it('averages the last 4 weeks and finds the 30-day longest run', () => {
    const runs = [
      { date: '2026-10-12', miles: 5 },
      { date: '2026-10-05', miles: 10 },
      { date: '2026-09-28', miles: 5 },
      { date: '2026-09-20', miles: 4 },
      { date: '2026-09-14', miles: 12 }, // 29 days ago: longest, but outside the 28-day volume window
      { date: '2026-08-01', miles: 20 }, // too old
    ];
    expect(summarizeRecentFitness(runs, TODAY)).toEqual({ weeklyMiles: 6, longestRunMi: 12 });
  });

  it('returns null with too little data', () => {
    expect(summarizeRecentFitness([{ date: '2026-10-12', miles: 5 }], TODAY)).toBeNull();
    expect(summarizeRecentFitness([], TODAY)).toBeNull();
  });
});

describe('checkJoinFitness (T-3)', () => {
  it('flags a 15 mi/week runner joining Pfitzinger 18/55 late (≈46 mi weeks at once)', () => {
    const placement = placePlan(pfitz, RACE_8_WEEKS, TODAY);
    expect(placement.joinWeekIndex).toBe(10);
    const check = checkJoinFitness(pfitz, placement, { weeklyMiles: 15, longestRunMi: 6 })!;
    expect(check.safe).toBe(false);
    expect(check.issues.join(' ')).toMatch(/Week 11 has .* mi of running; you've averaged about 15 mi/);
    expect(check.issues.join(' ')).toMatch(/longest run in the last 30 days is 6 mi/);
    // Even week 1 (33 mi) is too much, so no later race helps — pick another plan.
    expect(check.laterRaceDate).toBeNull();
    // Ramp-in: ~10% steps from recent volume, never above the join week.
    expect(check.rampIn!.weeklyMiles[0]).toBe(17);
    expect(check.rampIn!.weeklyMiles.every((m, i, a) => i === 0 || m >= a[i - 1])).toBe(true);
    expect(check.rampIn!.longRunMi[0]).toBeLessThanOrEqual(safeLongRunMiles(6));
  });

  it('offers a later race that joins at an easier week', () => {
    const placement = placePlan(novice1, RACE_8_WEEKS, TODAY);
    const check = checkJoinFitness(novice1, placement, { weeklyMiles: 25, longestRunMi: 10 })!;
    expect(check.safe).toBe(false);
    // Week 8 (index 7) is the first earlier week that suits 25 mi/week and a 10 mi longest run: 3 weeks later.
    expect(check.laterRaceDate).toBe('2026-12-27');
    const later = placePlan(novice1, check.laterRaceDate!, TODAY);
    expect(later.joinWeekIndex).toBe(7);
    expect(checkJoinFitness(novice1, later, { weeklyMiles: 25, longestRunMi: 10 })!.safe).toBe(true);
  });

  it('passes a runner whose training matches the join week', () => {
    const placement = placePlan(novice1, RACE_8_WEEKS, TODAY);
    const check = checkJoinFitness(novice1, placement, { weeklyMiles: 30, longestRunMi: 15 })!;
    expect(check.safe).toBe(true);
    expect(check.issues).toEqual([]);
  });

  it('also checks week 1 when the whole plan fits', () => {
    const placement = placePlan(pfitz, '2027-04-25', TODAY);
    expect(placement.fits).toBe(true);
    expect(checkJoinFitness(pfitz, placement, { weeklyMiles: 15, longestRunMi: 6 })!.safe).toBe(false);
  });

  it('skips the check without fitness data', () => {
    expect(checkJoinFitness(pfitz, placePlan(pfitz, RACE_8_WEEKS, TODAY), null)).toBeNull();
    expect(
      checkJoinFitness(pfitz, placePlan(pfitz, RACE_8_WEEKS, TODAY), { weeklyMiles: null, longestRunMi: null }),
    ).toBeNull();
  });

  it('uses +20% (min +5 mi) for weekly volume and +10% (min +1 mi) for the long run', () => {
    expect(safeWeeklyMiles(15)).toBe(20);
    expect(safeWeeklyMiles(50)).toBe(60);
    expect(safeLongRunMiles(6)).toBe(7);
    expect(safeLongRunMiles(18)).toBeCloseTo(19.8);
  });

  it('suggests gentler plans for the same race date', () => {
    const safer = saferPlansForRace(
      BUILT_IN_PLANS,
      '2027-04-25',
      { weeklyMiles: 15, longestRunMi: 6 },
      'pfitzinger-18-55',
      TODAY,
    );
    expect(safer.map((p) => p.id)).toContain('hal-higdon-novice-1');
    expect(safer.map((p) => p.id)).not.toContain('pfitzinger-18-55');
  });
});

describe('RaceDatePlanSetup join warning (T-3)', () => {
  it('warns and switches to the later race date', () => {
    const onChange = vi.fn();
    render(
      <RaceDatePlanSetup
        plan={novice1}
        value={{ raceDate: RACE_8_WEEKS, useStartDate: false, startDate: '' }}
        onChange={onChange}
        idPrefix="t3"
        today={TODAY}
        fitness={{ weeklyMiles: 25, longestRunMi: 10 }}
      />,
    );
    expect(screen.getByText(/Week 11 is a big jump from your recent training/)).toBeTruthy();
    expect(screen.getByText(/A ramp-in\./)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^Use / }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ raceDate: '2026-12-27' }));
  });

  it('offers gentler plans as buttons when the chooser can switch', () => {
    const onChoosePlan = vi.fn();
    render(
      <RaceDatePlanSetup
        plan={pfitz}
        value={{ raceDate: '2027-04-25', useStartDate: false, startDate: '' }}
        onChange={vi.fn()}
        idPrefix="t3b"
        today={TODAY}
        fitness={{ weeklyMiles: 15, longestRunMi: 6 }}
        onChoosePlan={onChoosePlan}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Hal Higdon Novice 1/ }));
    expect(onChoosePlan).toHaveBeenCalledWith('hal-higdon-novice-1');
  });

  it('shows nothing when the join is safe or there is no data', () => {
    const { container, rerender } = render(
      <RaceDatePlanSetup
        plan={novice1}
        value={{ raceDate: RACE_8_WEEKS, useStartDate: false, startDate: '' }}
        onChange={vi.fn()}
        idPrefix="t3c"
        today={TODAY}
        fitness={{ weeklyMiles: 30, longestRunMi: 15 }}
      />,
    );
    expect(container.querySelector('.plan-setup-warning')).toBeNull();
    rerender(
      <RaceDatePlanSetup
        plan={novice1}
        value={{ raceDate: RACE_8_WEEKS, useStartDate: false, startDate: '' }}
        onChange={vi.fn()}
        idPrefix="t3c"
        today={TODAY}
        fitness={null}
      />,
    );
    expect(container.querySelector('.plan-setup-warning')).toBeNull();
  });
});
