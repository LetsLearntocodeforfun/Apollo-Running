/**
 * v1.0.6 Plan components (T2b): CalendarView keyboard access, the ⋯ day menu
 * (overlay writes + badges), race-date-first setup preview, phase ribbon,
 * display helpers (B6 progress, unit-free titles) and push status copy.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import { persistence } from '../services/db/persistence';
import { getPlanById, type TrainingPlan } from '../data/plans';
import { startPlan, getActivePlan, getDateKeyForDay, getRaceDayRef, getWeekDayForDate } from '../services/planProgress';
import { getEffectivePlan, getEffectiveDay } from '../services/planOverlay';
import CalendarView from '../components/CalendarView';
import { DayActionsMenu, getDayBadges } from '../components/plan/DayActionsMenu';
import { RaceDatePlanSetup, planSetupToStartInput, planSetupError, type PlanSetupValue } from '../components/plan/RaceDatePlanSetup';
import PhaseRibbon from '../components/plan/PhaseRibbon';
import { computePlanProgress, workoutTitle, workoutSummary, formatDayLabel } from '../components/plan/planDisplay';
import { describePushStatus } from '../components/PlanCalendarPush';
import { startNeedsConfirm, describeClears } from '../components/plan/PlanChooser';
import { setDistanceUnit } from '../services/unitPreferences';

const PLAN_ID = 'hal-higdon-novice-1';
const TODAY = '2026-10-07'; // a Wednesday
const RACE = '2027-01-31'; // a Sunday, 17 weeks after the plan's Monday start

function startTestPlan(raceDate = RACE) {
  startPlan({ planId: PLAN_ID, raceDate }, TODAY);
  const active = getActivePlan();
  const plan = getEffectivePlan();
  if (!active || !plan) throw new Error('plan not started');
  return { active, plan };
}

/** First workout day strictly after today and before race day. */
function nextWorkoutRef(plan: TrainingPlan, startDate: string) {
  const race = getRaceDayRef(plan);
  const pos = getWeekDayForDate(startDate, plan.weeks.length, TODAY)!;
  for (let w = pos.weekIndex; w < plan.weeks.length; w++) {
    for (let d = 0; d < 7; d++) {
      if (w === pos.weekIndex && d <= pos.dayIndex) continue;
      if (w * 7 + d >= race.weekIndex * 7 + race.dayIndex) return null;
      if (plan.weeks[w].days[d].type === 'run') return { weekIndex: w, dayIndex: d };
    }
  }
  return null;
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

describe('CalendarView keyboard and ARIA', () => {
  it('day cells are buttons; Enter opens the day, arrows move focus, Escape closes', () => {
    const { active, plan } = startTestPlan();
    const { container } = render(<CalendarView plan={plan} active={active} onToggleDay={vi.fn()} />);

    const today = container.querySelector<HTMLButtonElement>('button[aria-current="date"]');
    expect(today).not.toBeNull();
    expect(today!.tagName).toBe('BUTTON');
    expect(today!.getAttribute('data-date')).toBe(TODAY);
    expect(today!.getAttribute('aria-label')).toMatch(/October 7/);
    expect(today!.getAttribute('tabindex')).toBe('0');
    expect(today!.getAttribute('aria-expanded')).toBe('false');

    today!.focus();
    fireEvent.keyDown(today!, { key: 'Enter' });
    expect(today!.getAttribute('aria-expanded')).toBe('true');
    const detail = screen.getByRole('region');
    expect(today!.getAttribute('aria-controls')).toBe(detail.id);

    fireEvent.keyDown(today!, { key: 'ArrowRight' });
    expect((document.activeElement as HTMLElement).getAttribute('data-date')).toBe('2026-10-08');

    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Escape' });
    expect(screen.queryByRole('region')).toBeNull();
  });

  it('a click toggles the same day open and closed without remounting the grid', () => {
    const { active, plan } = startTestPlan();
    const { container } = render(<CalendarView plan={plan} active={active} onToggleDay={vi.fn()} />);
    const btn = container.querySelector<HTMLButtonElement>(`button[data-date="${TODAY}"]`)!;
    fireEvent.click(btn);
    expect(screen.getByRole('region')).not.toBeNull();
    // Same DOM node after the toggle (grid keyed by month only).
    expect(container.querySelector(`button[data-date="${TODAY}"]`)).toBe(btn);
    fireEvent.click(btn);
    expect(screen.queryByRole('region')).toBeNull();
  });

  it('renders the day-actions slot and the modified-day badge', () => {
    const { active, plan } = startTestPlan();
    const { container } = render(
      <CalendarView
        plan={plan}
        active={active}
        onToggleDay={vi.fn()}
        renderDayActions={(ref) => <button type="button">actions {ref.dateKey}</button>}
        getDayBadge={(w, d) => (w === 1 && d === 2 ? 'Moved' : null)}
      />,
    );
    const btn = container.querySelector<HTMLButtonElement>(`button[data-date="${TODAY}"]`)!;
    expect(btn.getAttribute('aria-label')).toMatch(/moved/i);
    fireEvent.click(btn);
    expect(screen.getByRole('button', { name: `actions ${TODAY}` })).not.toBeNull();
  });
});

describe('DayActionsMenu (plan overlay)', () => {
  it('Skip writes through the overlay, shows a Skipped badge, and Undo restores it', () => {
    const { active, plan } = startTestPlan();
    const ref = nextWorkoutRef(plan, active.startDate)!;
    expect(ref).not.toBeNull();
    const label = formatDayLabel(getDateKeyForDay(active.startDate, ref.weekIndex, ref.dayIndex));
    const onChanged = vi.fn();
    const { rerender } = render(<DayActionsMenu plan={plan} weekIndex={ref.weekIndex} dayIndex={ref.dayIndex} dayLabel={label} onChanged={onChanged} />);

    const trigger = screen.getByRole('button', { name: new RegExp(`^Change ${label}`) });
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
    fireEvent.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    const menu = screen.getByRole('menu');
    expect(document.activeElement).toBe(within(menu).getAllByRole('menuitem')[0]);

    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Skip' }));
    expect(onChanged).toHaveBeenCalledWith(expect.stringMatching(/Skipped/));
    expect(screen.queryByRole('menu')).toBeNull();
    expect(getEffectiveDay(ref)?.skipped).toBe(true);
    const updated = getEffectivePlan()!;
    expect(getDayBadges(updated).get(`${ref.weekIndex}:${ref.dayIndex}`)).toBe('Skipped');

    rerender(<DayActionsMenu plan={updated} weekIndex={ref.weekIndex} dayIndex={ref.dayIndex} dayLabel={label} onChanged={onChanged} />);
    fireEvent.click(screen.getByRole('button', { name: new RegExp(`^Change ${label}`) }));
    expect(screen.queryByRole('menuitem', { name: 'Skip' })).toBeNull();
    fireEvent.click(screen.getByRole('menuitem', { name: /Undo last change/ }));
    expect(getEffectiveDay(ref)?.skipped).toBeFalsy();
    expect(getDayBadges(getEffectivePlan()!).size).toBe(0);
  });

  it('Move to… swaps two days and marks both as Moved; Escape closes the menu', () => {
    const { active, plan } = startTestPlan();
    const ref = nextWorkoutRef(plan, active.startDate)!;
    const label = formatDayLabel(getDateKeyForDay(active.startDate, ref.weekIndex, ref.dayIndex));
    render(<DayActionsMenu plan={plan} weekIndex={ref.weekIndex} dayIndex={ref.dayIndex} dayLabel={label} />);
    const trigger = screen.getByRole('button', { name: new RegExp(`^Change ${label}`) });

    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);

    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Move to…' }));
    const targets = screen.getAllByRole('menuitem').filter((el) => !/Back/.test(el.textContent ?? ''));
    expect(targets.length).toBeGreaterThan(0);
    fireEvent.click(targets[0]);
    const badges = getDayBadges(getEffectivePlan()!);
    expect([...badges.values()].filter((b) => b === 'Moved')).toHaveLength(2);
  });

  it('renders nothing for race day (it cannot be changed) when there is nothing to undo', () => {
    const { plan } = startTestPlan();
    const race = getRaceDayRef(plan);
    const { container } = render(<DayActionsMenu plan={plan} weekIndex={race.weekIndex} dayIndex={race.dayIndex} dayLabel="Race day" />);
    expect(container.innerHTML).toBe('');
  });
});

describe('RaceDatePlanSetup', () => {
  const plan = getPlanById(PLAN_ID)!;
  const value = (v: Partial<PlanSetupValue>): PlanSetupValue => ({ raceDate: '', useStartDate: false, startDate: '', ...v });

  it('previews a plan that fits, with the Monday start date', () => {
    // 18 weeks from the Monday of TODAY (2026-10-05) through race week → the full plan fits.
    const fitsRace = '2027-02-07';
    render(<RaceDatePlanSetup plan={plan} value={value({ raceDate: fitsRace })} onChange={vi.fn()} idPrefix="t" today={TODAY} />);
    const status = screen.getByRole('status');
    expect(status.textContent).toMatch(/fit — week 1 starts/);
    expect(status.textContent).toMatch(/Monday, October 5, 2026/);
    expect((screen.getByLabelText('Race date') as HTMLInputElement).value).toBe(fitsRace);
  });

  it('says which week a late starter joins at', () => {
    render(<RaceDatePlanSetup plan={plan} value={value({ raceDate: '2026-11-15' })} onChange={vi.fn()} idPrefix="t" today={TODAY} />);
    expect(screen.getByRole('status').textContent).toMatch(/You join at week \d+ of \d+/);
  });

  it('advanced start date snaps to Monday with a visible note', () => {
    const onChange = vi.fn();
    const { rerender } = render(<RaceDatePlanSetup plan={plan} value={value({})} onChange={onChange} idPrefix="t" today={TODAY} />);
    fireEvent.click(screen.getByLabelText('Advanced: choose a start date instead'));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ useStartDate: true }));
    rerender(<RaceDatePlanSetup plan={plan} value={value({ useStartDate: true, startDate: '2026-10-14' })} onChange={onChange} idPrefix="t" today={TODAY} />);
    expect(screen.getByRole('status').textContent).toMatch(/snaps to Monday, October 12, 2026/);
  });

  it('planSetupToStartInput validates the value', () => {
    expect(planSetupToStartInput(PLAN_ID, value({}), TODAY)).toBeNull();
    expect(planSetupError(value({ raceDate: '2026-01-01' }), TODAY)).toMatch(/past/);
    expect(planSetupToStartInput(PLAN_ID, value({ raceDate: RACE }), TODAY)).toEqual({ planId: PLAN_ID, raceDate: RACE });
    expect(planSetupToStartInput(PLAN_ID, value({ useStartDate: true, startDate: '2026-10-14' }), TODAY)).toEqual({ planId: PLAN_ID, startDate: '2026-10-14' });
  });
});

describe('PhaseRibbon', () => {
  it('shows every phase as text with a "You are here" marker', () => {
    const { plan } = startTestPlan();
    render(<PhaseRibbon plan={plan} currentWeekIndex={1} />);
    expect(screen.getByRole('heading', { level: 2, name: 'Training phases' })).not.toBeNull();
    const items = screen.getAllByRole('listitem');
    expect(items.length).toBeGreaterThan(1);
    const current = items.filter((li) => li.getAttribute('aria-current') === 'step');
    expect(current).toHaveLength(1);
    expect(current[0].textContent).toMatch(/You are here · week 2/);
    items.forEach((li) => expect(li.textContent).toMatch(/Weeks? \d+/));
  });
});

describe('plan display helpers', () => {
  it('B6: completing every workout day reaches 100 % (rest days are not counted)', () => {
    const plan = getPlanById(PLAN_ID)!;
    const progress = computePlanProgress(plan, (w, d) => plan.weeks[w].days[d].type !== 'rest');
    expect(progress.pct).toBe(100);
    expect(progress.completed).toBe(progress.total);
    const allDays = plan.weeks.length * 7;
    expect(progress.total).toBeLessThan(allDays);
  });

  it('titles are unit-free so km users never see "mi"', () => {
    setDistanceUnit('km');
    expect(workoutTitle({ type: 'run', label: '5 mi tempo', distanceMi: 5, note: 'Tempo' })).toBe('Tempo run');
    expect(workoutSummary({ type: 'run', label: '5 mi tempo', distanceMi: 5 })).not.toMatch(/\bmi\b/);
    expect(workoutTitle({ type: 'rest', label: 'Skipped: 5 mi tempo', skipped: true, originalLabel: '5 mi tempo' })).toBe('Skipped');
    // V11 race-week shakeout labels use a distance range.
    expect(workoutTitle({ type: 'run', label: '2–3 mi shakeout + strides', distanceMi: 2.5, note: 'Easy' })).toBe('Shakeout + strides');
    setDistanceUnit('mi');
  });
});

describe('CalendarView completion guard (S4)', () => {
  it('a future workout cannot be marked complete yet; the reason is shown and linked', () => {
    const { active, plan } = startTestPlan();
    const ref = nextWorkoutRef(plan, active.startDate)!;
    const onToggleDay = vi.fn();
    const { container } = render(<CalendarView plan={plan} active={active} onToggleDay={onToggleDay} />);
    const futureKey = getDateKeyForDay(active.startDate, ref.weekIndex, ref.dayIndex);
    fireEvent.click(container.querySelector<HTMLButtonElement>(`button[data-date="${futureKey}"]`)!);
    const mark = screen.getByRole('button', { name: 'Mark Complete' }) as HTMLButtonElement;
    expect(mark.disabled).toBe(true);
    const why = document.getElementById(mark.getAttribute('aria-describedby') ?? '');
    expect(why?.textContent).toMatch(/on or after its day/);
    fireEvent.click(mark);
    expect(onToggleDay).not.toHaveBeenCalled();
  });
});

describe('push status and restart confirmation copy', () => {
  it('maps T2a push statuses to user copy', () => {
    expect(describePushStatus('skipped-in-progress')).toMatch(/A push is already running/);
    expect(describePushStatus('nothing-changed')).toMatch(/Already up to date/);
  });

  it('asks before clearing stored progress of a new plan instance', () => {
    const base = { active: { planId: PLAN_ID, startDate: '2026-09-28' }, instanceId: 'x', placement: null };
    expect(startNeedsConfirm({ ...base, isNewInstance: true, clears: { completions: 3, syncMeta: 0, overlay: false } })).toBe(true);
    expect(startNeedsConfirm({ ...base, isNewInstance: true, clears: { completions: 0, syncMeta: 0, overlay: false } })).toBe(false);
    expect(startNeedsConfirm({ ...base, isNewInstance: false, clears: { completions: 3, syncMeta: 0, overlay: true } })).toBe(false);
    expect(describeClears({ completions: 1, syncMeta: 2, overlay: true })).toBe('1 completed day, your moves and skips, 2 activity matches');
  });
});
