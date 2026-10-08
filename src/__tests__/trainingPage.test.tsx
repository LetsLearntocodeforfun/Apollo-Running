/**
 * v1.0.6 Training (Plan) page (T2b):
 *  - B1: the "Change plan or race date" picker keeps the choice pending — the page doesn't swap
 *    until "Switch plan" is pressed, and Cancel discards it.
 *  - The ⋯ day menu skips a workout through the plan overlay and the checklist row shows a
 *    "Skipped" badge.
 *  - S4: a future workout can't be ticked off yet (T2a's canToggleDayCompletion); today's can.
 *  - One h1; week accordions expose aria-expanded.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { persistence } from '../services/db/persistence';
import { getPlanById, type TrainingPlan } from '../data/plans';
import {
  startPlan,
  getActivePlan,
  getDateKeyForDay,
  getRaceDayRef,
  getWeekDayForDate,
  isDayCompleted,
} from '../services/planProgress';
import { getEffectivePlan, getEffectiveDay } from '../services/planOverlay';
import { formatDayLabel, isWorkoutDay } from '../components/plan/planDisplay';
import Training from '../pages/Training';

// Keep the page test focused: no maps, no intervals.icu calendar widgets, no calendar push.
vi.mock('../components/RouteMap', () => ({ RouteMapThumbnail: () => null, default: () => null }));
vi.mock('../components/PlanCalendarPush', () => ({ default: () => null }));
vi.mock('../components/PlanCalendarExport', () => ({ default: () => null }));
vi.mock('../services/planCalendarSync', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/planCalendarSync')>()),
  syncPlanCalendarIfChanged: vi.fn(async () => undefined),
}));

const PLAN_ID = 'hal-higdon-novice-1';
const OTHER_ID = 'hansons-beginner';
const TODAY = '2026-10-07'; // a Wednesday → week index 1, day index 2 of a plan placed on RACE
const RACE = '2027-01-31'; // a Sunday

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function renderPage(path = '/plan') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Training />
    </MemoryRouter>,
  );
}

function startTestPlan() {
  startPlan({ planId: PLAN_ID, raceDate: RACE }, TODAY);
  const active = getActivePlan();
  const plan = getEffectivePlan();
  if (!active || !plan) throw new Error('plan not started');
  return { active, plan };
}

/** Workout days of today's week: the last one on/before today and the first one after it. */
function workoutsAroundToday(plan: TrainingPlan, startDate: string) {
  const pos = getWeekDayForDate(startDate, plan.weeks.length, TODAY)!;
  const race = getRaceDayRef(plan);
  const days = plan.weeks[pos.weekIndex].days;
  let past: { weekIndex: number; dayIndex: number } | null = null;
  let future: { weekIndex: number; dayIndex: number } | null = null;
  days.forEach((day, d) => {
    if (!isWorkoutDay(day)) return;
    if (pos.weekIndex * 7 + d >= race.weekIndex * 7 + race.dayIndex) return;
    if (d <= pos.dayIndex) past = { weekIndex: pos.weekIndex, dayIndex: d };
    else if (!future) future = { weekIndex: pos.weekIndex, dayIndex: d };
  });
  return { pos, past: past as { weekIndex: number; dayIndex: number } | null, future: future as { weekIndex: number; dayIndex: number } | null };
}

beforeEach(() => {
  persistence.clear();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 9, 7, 9, 0, 0));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('Training page — B1 switch plan', () => {
  it('keeps the choice pending until "Switch plan" is pressed; Cancel keeps the current plan', () => {
    startTestPlan();
    const current = getPlanById(PLAN_ID)!;
    const other = getPlanById(OTHER_ID)!;
    renderPage();

    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    const header = () => document.getElementById('plan-header-title')!.textContent;
    expect(header()).toBe(current.name);

    const toggle = screen.getByRole('button', { name: 'Change plan or race date' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');

    const chooser = screen.getByRole('region', { name: 'Switch plan' });
    const otherRadio = () =>
      within(screen.getByRole('region', { name: 'Switch plan' })).getByRole('radio', { name: new RegExp(`^${escapeRe(other.name)}`) }) as HTMLInputElement;
    fireEvent.click(otherRadio());
    expect(otherRadio().checked).toBe(true);

    // Pending only: nothing about the active plan or the page changed yet.
    expect(getActivePlan()!.planId).toBe(PLAN_ID);
    expect(header()).toBe(current.name);

    fireEvent.click(within(chooser).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('region', { name: 'Switch plan' })).toBeNull();
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(getActivePlan()!.planId).toBe(PLAN_ID);
    expect(header()).toBe(current.name);

    // Re-opening starts fresh: the discarded choice is gone.
    fireEvent.click(toggle);
    expect(otherRadio().checked).toBe(false);

    // Confirming swaps the plan (race date is prefilled from the active plan).
    fireEvent.click(otherRadio());
    fireEvent.click(within(screen.getByRole('region', { name: 'Switch plan' })).getByRole('button', { name: 'Switch plan' }));
    expect(getActivePlan()!.planId).toBe(OTHER_ID);
    expect(header()).toBe(other.name);
    expect(screen.queryByRole('region', { name: 'Switch plan' })).toBeNull();
  });
});

describe('Training page — checklist', () => {
  it('the ⋯ day menu skips a workout and the row shows a "Skipped" badge', () => {
    const { active, plan } = startTestPlan();
    const { future } = workoutsAroundToday(plan, active.startDate);
    expect(future).not.toBeNull();
    const ref = future!;
    renderPage('/plan?view=checklist');

    const label = formatDayLabel(getDateKeyForDay(active.startDate, ref.weekIndex, ref.dayIndex));
    const panel = () => document.getElementById(`plan-week-panel-${ref.weekIndex}`)!;
    const trigger = () => within(panel()).getByRole('button', { name: new RegExp(`^Change ${escapeRe(label)}`) });
    expect(trigger().closest('tr')!.querySelector('.day-badge')).toBeNull();

    fireEvent.click(trigger());
    fireEvent.click(screen.getByRole('menuitem', { name: 'Skip' }));

    expect(getEffectiveDay(ref)?.skipped).toBe(true);
    const badge = trigger().closest('tr')!.querySelector('.day-badge');
    expect(badge).not.toBeNull();
    expect(badge!.textContent).toBe('Skipped');
    expect(screen.getAllByRole('status').some((el) => /Skipped/.test(el.textContent ?? ''))).toBe(true);
  });

  it('S4: a future workout cannot be ticked off yet; an earlier one can', () => {
    const { active, plan } = startTestPlan();
    const { past, future } = workoutsAroundToday(plan, active.startDate);
    expect(past).not.toBeNull();
    expect(future).not.toBeNull();
    renderPage('/plan?view=checklist');

    const box = (ref: { weekIndex: number; dayIndex: number }) => {
      const label = formatDayLabel(getDateKeyForDay(active.startDate, ref.weekIndex, ref.dayIndex));
      return screen.getByRole('checkbox', { name: new RegExp(`on ${escapeRe(label)} complete$`) }) as HTMLInputElement;
    };

    const later = box(future!);
    expect(later.disabled).toBe(true);
    const whyId = later.getAttribute('aria-describedby');
    expect(whyId).toBeTruthy();
    expect(document.getElementById(whyId!)!.textContent).toMatch(/on or after its day/);
    fireEvent.click(later);
    expect(isDayCompleted(PLAN_ID, future!.weekIndex, future!.dayIndex)).toBe(false);

    const earlier = box(past!);
    expect(earlier.disabled).toBe(false);
    fireEvent.click(earlier);
    expect(isDayCompleted(PLAN_ID, past!.weekIndex, past!.dayIndex)).toBe(true);
    expect(box(past!).checked).toBe(true);
  });

  it('week accordions expose aria-expanded; this week starts open', () => {
    const { active, plan } = startTestPlan();
    const { pos } = workoutsAroundToday(plan, active.startDate);
    renderPage('/plan?view=checklist');

    const weekBtn = screen.getByRole('button', { name: new RegExp(`^Week ${pos.weekIndex + 1}\\b`) });
    expect(weekBtn.getAttribute('aria-expanded')).toBe('true');
    expect(weekBtn.getAttribute('aria-controls')).toBe(`plan-week-panel-${pos.weekIndex}`);
    fireEvent.click(weekBtn);
    expect(weekBtn.getAttribute('aria-expanded')).toBe('false');
    expect(document.getElementById(`plan-week-panel-${pos.weekIndex}`)).toBeNull();
  });
});
