/**
 * Onboarding v2 (src/pages/WelcomeFlow.tsx): units default, race-date-first plan
 * placement, restart confirmation, goal time + recent race persistence, history
 * Back, focus management and the Race Strategy flag removal.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import WelcomeFlow from '../pages/WelcomeFlow';
import { getPlanById } from '../data/plans';
import {
  getActivePlan,
  getWelcomeCompleted,
  isDayCompleted,
  placePlan,
  setDayCompleted,
  startPlan,
} from '../services/planProgress';
import { getAthleteProfile } from '../services/athleteProfile';
import { getDistanceUnit, setDistanceUnit } from '../services/unitPreferences';
import { isCoachingOnboardingDone } from '../services/coachingPreferences';
import { persistence } from '../services/db/persistence';

/** An 18-week built-in plan. */
const PLAN_ID = 'hal-higdon-novice-1';

function renderFlow() {
  const onComplete = vi.fn();
  const utils = render(<WelcomeFlow onComplete={onComplete} />);
  return { ...utils, onComplete };
}

function heading(): HTMLElement {
  return screen.getByRole('heading', { level: 1 });
}

function clickButton(name: string | RegExp): void {
  fireEvent.click(screen.getByRole('button', { name }));
}

function radioByValue(value: string): HTMLInputElement {
  const radio = screen.getAllByRole('radio').find((r) => (r as HTMLInputElement).value === value);
  if (!radio) throw new Error(`No radio with value "${value}"`);
  return radio as HTMLInputElement;
}

/** Render and continue past the units step. */
function goToPlanStep() {
  const utils = renderFlow();
  clickButton('Continue');
  expect(heading().textContent).toBe('Your race and plan');
  return utils;
}

/** Plan step → "Skip — no plan for now" → recent race step. */
function goToRecentRaceStep() {
  const utils = goToPlanStep();
  fireEvent.click(radioByValue('none'));
  clickButton('Continue');
  expect(heading().textContent).toBe('A recent race (optional)');
  return utils;
}

describe('WelcomeFlow (onboarding v2)', () => {
  beforeEach(() => {
    persistence.clear();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 9, 7, 9)); // Wed 7 Oct 2026
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    window.location.hash = '';
  });

  it('shows "Step 1 of 5" and defaults units from navigator.language (en-GB → km)', () => {
    vi.spyOn(navigator, 'language', 'get').mockReturnValue('en-GB');
    renderFlow();
    expect(screen.getByText('Step 1 of 5')).toBeTruthy();
    const bar = screen.getByRole('progressbar');
    expect(bar.getAttribute('aria-valuenow')).toBe('1');
    expect(bar.getAttribute('aria-valuemin')).toBe('1');
    expect(bar.getAttribute('aria-valuemax')).toBe('5');
    expect(radioByValue('km').checked).toBe(true);
    expect(radioByValue('mi').checked).toBe(false);
    expect(heading().textContent).toBe('Welcome to Apollo');
    expect(document.activeElement).toBe(heading());

    clickButton('Continue');
    expect(getDistanceUnit()).toBe('km');
    expect(screen.getByText('Step 2 of 5')).toBeTruthy();
  });

  it('defaults to miles for en-US and keeps a unit the athlete already chose', () => {
    const lang = vi.spyOn(navigator, 'language', 'get').mockReturnValue('en-US');
    const first = renderFlow();
    expect(radioByValue('mi').checked).toBe(true);
    first.unmount();

    setDistanceUnit('mi');
    lang.mockReturnValue('en-GB');
    renderFlow();
    expect(radioByValue('mi').checked).toBe(true);
    fireEvent.click(radioByValue('km'));
    expect(radioByValue('km').checked).toBe(true);
  });

  it('race date → placement preview → startPlan with that race date', () => {
    goToPlanStep();
    fireEvent.click(radioByValue(PLAN_ID));
    fireEvent.change(screen.getByLabelText('Race date'), { target: { value: '2026-12-27' } });

    const plan = getPlanById(PLAN_ID);
    expect(plan).toBeTruthy();
    const expected = placePlan(plan!, '2026-12-27', '2026-10-07');
    const status = screen.getByRole('status');
    expect(status.textContent).toContain(`week ${expected.joinWeekIndex + 1} of 18`);
    expect(status.textContent).toContain('Race day:');

    clickButton('Continue');
    expect(heading().textContent).toBe('A recent race (optional)');
    const active = getActivePlan();
    expect(active?.planId).toBe(PLAN_ID);
    expect(active?.raceDate).toBe('2026-12-27');
    expect(active?.startDate).toBe(expected.startDate);
    expect(active?.joinedWeekIndex ?? 0).toBe(expected.joinWeekIndex);
  });

  it('a late race date (6 weeks out for an 18-week plan) shows "join at week"', () => {
    goToPlanStep();
    fireEvent.click(radioByValue(PLAN_ID));
    fireEvent.change(screen.getByLabelText('Race date'), { target: { value: '2026-11-15' } });
    expect(screen.getByRole('status').textContent).toMatch(/join at week 13/i);
  });

  it('needs a race date before starting, and "Skip — no plan for now" moves on without a plan', () => {
    goToPlanStep();
    clickButton('Continue');
    expect(screen.getByRole('alert').textContent).toMatch(/Choose a plan/);

    fireEvent.click(radioByValue(PLAN_ID));
    clickButton('Continue');
    expect(screen.getByRole('alert').textContent).toBe('Choose your race date.');
    expect(heading().textContent).toBe('Your race and plan');
    expect(getActivePlan()).toBeNull();

    fireEvent.click(radioByValue('none'));
    clickButton('Continue');
    expect(heading().textContent).toBe('A recent race (optional)');
    expect(getActivePlan()).toBeNull();
  });

  it('asks "Restart this plan?" before clearing progress, and only restarts on confirm', () => {
    startPlan({ planId: PLAN_ID, raceDate: '2027-01-31' });
    setDayCompleted(PLAN_ID, 0, 1, true);

    goToPlanStep();
    expect(radioByValue(PLAN_ID).checked).toBe(true); // preselected from the active plan
    fireEvent.change(screen.getByLabelText('Race date'), { target: { value: '2026-12-27' } });
    clickButton('Continue');
    expect(screen.getByText('Restart this plan?')).toBeTruthy();
    expect(screen.getByText('Progress for this plan will be cleared.')).toBeTruthy();

    fireEvent.click(screen.getByText('Keep my progress'));
    expect(screen.queryByText('Restart this plan?')).toBeNull();
    expect(getActivePlan()?.raceDate).toBe('2027-01-31');
    expect(isDayCompleted(PLAN_ID, 0, 1)).toBe(true);
    expect(heading().textContent).toBe('Your race and plan');

    clickButton('Continue');
    fireEvent.click(screen.getByText('Restart plan'));
    expect(getActivePlan()?.raceDate).toBe('2026-12-27');
    expect(isDayCompleted(PLAN_ID, 0, 1)).toBe(false);
    expect(heading().textContent).toBe('A recent race (optional)');
  });

  it('validates and saves the optional goal marathon time', () => {
    goToPlanStep();
    fireEvent.click(radioByValue('none'));
    const goal = screen.getByLabelText('Goal marathon time (optional)');
    fireEvent.change(goal, { target: { value: '345' } });
    clickButton('Continue');
    expect(screen.getByRole('alert').textContent).toMatch(/H:MM:SS/);
    expect(goal.getAttribute('aria-invalid')).toBe('true');
    expect(heading().textContent).toBe('Your race and plan');
    expect(getAthleteProfile().goalMarathonSec).toBeUndefined();

    fireEvent.change(screen.getByLabelText('Goal marathon time (optional)'), { target: { value: '3:30:00' } });
    clickButton('Continue');
    expect(heading().textContent).toBe('A recent race (optional)');
    expect(getAthleteProfile().goalMarathonSec).toBe(3.5 * 3600);
  });

  it('saves a recent race to the athlete profile, with inline validation', () => {
    goToRecentRaceStep();
    fireEvent.change(screen.getByLabelText('Distance'), { target: { value: '10k' } });
    fireEvent.change(screen.getByLabelText('Finish time'), { target: { value: '4530' } });
    fireEvent.change(screen.getByLabelText('Race date'), { target: { value: '2026-10-20' } });
    clickButton('Save and continue');
    expect(screen.getByText(/Use H:MM:SS or MM:SS/)).toBeTruthy();
    expect(screen.getByText('The race date can’t be in the future.')).toBeTruthy();
    expect(getAthleteProfile().recentRace).toBeUndefined();
    expect(heading().textContent).toBe('A recent race (optional)');

    fireEvent.change(screen.getByLabelText('Finish time'), { target: { value: '45:30' } });
    fireEvent.change(screen.getByLabelText('Race date'), { target: { value: '2026-09-20' } });
    clickButton('Save and continue');
    expect(getAthleteProfile().recentRace).toEqual({ distanceM: 10000, timeSec: 45 * 60 + 30, date: '2026-09-20' });
    expect(heading().textContent).toBe('Connect your training data');
  });

  it('Back returns to the previously visited step and focus moves to each step heading', () => {
    goToPlanStep();
    expect(document.activeElement).toBe(heading());
    fireEvent.click(radioByValue('none'));
    clickButton('Continue');
    clickButton('Skip this step');
    expect(heading().textContent).toBe('Connect your training data');
    expect(screen.getByText('Step 4 of 5')).toBeTruthy();
    expect(document.activeElement).toBe(heading());

    clickButton('Back');
    expect(heading().textContent).toBe('A recent race (optional)');
    expect(document.activeElement).toBe(heading());
    clickButton('Back');
    expect(heading().textContent).toBe('Your race and plan');
    expect(radioByValue('none').checked).toBe(true); // choices survive going back
    clickButton('Back');
    expect(heading().textContent).toBe('Welcome to Apollo');
    expect(screen.getByText('Step 1 of 5')).toBeTruthy();
  });

  it('Done completes onboarding and opens Settings › Connections when chosen', () => {
    const { onComplete } = goToRecentRaceStep();
    clickButton('Skip this step');
    fireEvent.click(radioByValue('connect'));
    clickButton('Continue');
    expect(heading().textContent).toBe('You’re all set');
    expect(screen.getByText('Step 5 of 5')).toBeTruthy();
    expect(screen.getByText('No plan yet')).toBeTruthy();

    clickButton('Finish and open Connections');
    expect(getWelcomeCompleted()).toBe(true);
    expect(isCoachingOnboardingDone()).toBe(true);
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(window.location.hash).toBe('#/settings?tab=connections');
  });

  it('"Skip setup" saves the units and finishes straight away', () => {
    vi.spyOn(navigator, 'language', 'get').mockReturnValue('de-DE');
    const { onComplete } = renderFlow();
    clickButton('Skip setup');
    expect(getDistanceUnit()).toBe('km');
    expect(getWelcomeCompleted()).toBe(true);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('no longer references the Race Strategy feature flag, release-note copy or the flag emoji', () => {
    const src = readFileSync(resolve(__dirname, '../pages/WelcomeFlow.tsx'), 'utf8');
    expect(src).not.toContain('enableRaceStrategy');
    expect(src).not.toContain('isRaceStrategyEnabled');
    expect(src).not.toContain('🇺🇸');
    expect(src).not.toMatch(/now offers/i);
  });
});
