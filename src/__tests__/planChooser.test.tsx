/**
 * v1.0.9 PlanChooser: a base/recovery block no longer leaves the "choose a start
 * date" flag behind for the next (marathon) plan, imported plans are labeled as
 * imported and unverified, can't be removed while active and are only removed
 * after confirming (their stored progress goes with them), and plan search
 * matches every word of the query in any case.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import { getPlanById, planMatchesSearch } from '@/data/plans';
import { importAndSavePlanText } from '@/services/planImportExport';
import {
  getActivePlan,
  getStoredPlanProgress,
  isDayCompleted,
  setDayCompleted,
  startPlan,
} from '@/services/planProgress';
import { PlanChooser } from '@/components/plan/PlanChooser';
import { addDays } from '@/utils/localDate';

const TODAY = '2026-11-02'; // a Monday
const MILE_M = 1609.344;

/** Recent training: ten 6 mi runs in the last three weeks (≈15 mi a week, longest 6 mi). */
const recentRuns = vi.hoisted(() => ({ list: [] as unknown[] }));
vi.mock('@/services/analyticsService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/analyticsService')>();
  return { ...actual, getStoredActivities: () => recentRuns.list };
});

afterEach(() => {
  cleanup();
  recentRuns.list = [];
});

function renderChooser(props: Partial<Parameters<typeof PlanChooser>[0]> = {}) {
  const onStarted = vi.fn();
  const utils = render(
    <PlanChooser
      mode="start"
      activePlanId={null}
      onStarted={onStarted}
      onBuildCustom={vi.fn()}
      today={TODAY}
      {...props}
    />,
  );
  return { ...utils, onStarted };
}

function radio(container: HTMLElement, planId: string): HTMLInputElement {
  const el = container.querySelector<HTMLInputElement>(`input[type="radio"][value="${planId}"]`);
  if (!el) throw new Error(`no radio for ${planId}`);
  return el;
}

function visiblePlanIds(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll<HTMLInputElement>('input[type="radio"]')).map((r) => r.value);
}

function importPlan(name: string): string {
  const rest = { type: 'rest', label: 'Rest' };
  const run = (mi: number) => ({ type: 'run', label: `${mi} mi easy`, distanceMi: mi, note: 'Easy' });
  const res = importAndSavePlanText(
    JSON.stringify({
      name,
      author: 'Local Club',
      weeks: [{ days: [rest, run(4), run(5), run(4), rest, run(3), run(8)] }],
    }),
  );
  if (!res.ok) throw new Error(res.error);
  return res.plan.id;
}

describe('block → marathon plan (start-date flag)', () => {
  it('a marathon plan picked after a block is placed by race date again, with the late-join check', () => {
    recentRuns.list = Array.from({ length: 10 }, (_, i) => ({
      id: i + 1,
      type: 'Run',
      sport_type: 'Run',
      start_date_local: `${addDays(TODAY, -(2 * i + 1))}T07:00:00Z`,
      distance: 6 * MILE_M,
    }));
    const { container, onStarted } = renderChooser();

    fireEvent.click(radio(container, 'apollo-base-8'));
    expect(screen.queryByLabelText('Race date')).toBeNull();
    expect((screen.getByLabelText('Start date') as HTMLInputElement).value).toBe(TODAY);
    expect(screen.getByRole('status').textContent).toMatch(/the block ends/);

    fireEvent.click(radio(container, 'pfitzinger-18-55'));
    const raceInput = screen.getByLabelText('Race date') as HTMLInputElement;
    expect(raceInput.disabled).toBe(false);
    expect((screen.getByLabelText('Advanced: choose a start date instead') as HTMLInputElement).checked).toBe(false);
    expect(screen.queryByLabelText('Start date')).toBeNull();

    fireEvent.change(raceInput, { target: { value: '2027-04-25' } });
    expect(screen.getByText(/Week 1 is a big jump from your recent training/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Start plan' }));
    expect(onStarted).toHaveBeenCalledWith(
      expect.objectContaining({ planId: 'pfitzinger-18-55', raceDate: '2027-04-25' }),
    );
    expect(getActivePlan()?.raceDate).toBe('2027-04-25');
  });

  it('starting a block uses its start date and stores no race date', () => {
    const { container, onStarted } = renderChooser();
    fireEvent.click(radio(container, 'apollo-recovery-4'));
    fireEvent.click(screen.getByRole('button', { name: 'Start plan' }));
    expect(onStarted).toHaveBeenCalledTimes(1);
    const active = onStarted.mock.calls[0][0];
    expect(active).toMatchObject({ planId: 'apollo-recovery-4', startDate: TODAY });
    expect(active.raceDate).toBeUndefined();
  });

  it('keeps the athlete’s own “choose a start date” choice across plans', () => {
    const { container } = renderChooser();
    fireEvent.click(radio(container, 'hal-higdon-novice-1'));
    fireEvent.click(screen.getByLabelText('Advanced: choose a start date instead'));
    fireEvent.click(radio(container, 'apollo-base-8'));
    fireEvent.click(radio(container, 'hal-higdon-novice-2'));
    expect((screen.getByLabelText('Advanced: choose a start date instead') as HTMLInputElement).checked).toBe(true);
  });
});

describe('removing imported plans', () => {
  it('the current plan can’t be removed; another one is removed only after confirming', () => {
    const current = importPlan('Plan A');
    const other = importPlan('Plan B');
    startPlan({ planId: current, startDate: TODAY }, TODAY);
    renderChooser({ mode: 'switch', activePlanId: current });

    fireEvent.click(screen.getByRole('button', { name: 'Remove imported plan Plan A' }));
    expect(
      screen.getByText(
        /“Plan A” is your current plan, so it can’t be removed\. To remove it, switch to another plan first\./,
      ),
    ).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(getPlanById(current)).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'Remove imported plan Plan B' }));
    let dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Remove this imported plan?')).toBeTruthy();
    expect(within(dialog).getByText(/“Plan B” will be removed from your plans/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep plan' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(getPlanById(other)).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'Remove imported plan Plan B' }));
    dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove plan' }));
    expect(getPlanById(other)).toBeUndefined();
    expect(screen.getByText('Removed imported plan “Plan B”.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Remove imported plan Plan B' })).toBeNull();
    expect(getPlanById(current)).toBeDefined();
  });

  it('marks imported plans as imported and unverified', () => {
    importPlan('Club Plan');
    const { container } = renderChooser();
    const label = radio(container, 'imported-club-plan').closest('label')!;
    expect(label.textContent).toContain('Imported, not verified by Apollo · author listed as “Local Club”');
    expect(label.textContent).not.toMatch(/Inspired by/);

    // The source note under the selected plan badges it as imported, not as a simplified coach plan.
    fireEvent.click(radio(container, 'imported-club-plan'));
    const note = screen.getByRole('complementary', { name: 'About the Club Plan plan' });
    expect(note.querySelector('.plan-fidelity-badge')?.textContent).toBe('Imported plan');
    expect(note.textContent).toContain('not verified by Apollo');
    expect(note.textContent).not.toMatch(/Simplified version/);
  });

  it('removing a plan with progress says so, and the progress goes with it', () => {
    const removed = importPlan('Old Plan');
    startPlan({ planId: removed, startDate: TODAY }, TODAY);
    setDayCompleted(removed, 0, 1, true);
    setDayCompleted(removed, 0, 2, true);
    startPlan({ planId: 'hal-higdon-novice-1', raceDate: '2027-04-25' }, TODAY);
    setDayCompleted('hal-higdon-novice-1', 0, 1, true);
    renderChooser({ mode: 'switch', activePlanId: 'hal-higdon-novice-1' });

    fireEvent.click(screen.getByRole('button', { name: 'Remove imported plan Old Plan' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(/“Old Plan” will be removed from your plans/).textContent).toBe(
      '“Old Plan” will be removed from your plans, along with its progress: 2 completed days. ' +
        'You can import its file again later.',
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove plan' }));
    expect(getPlanById(removed)).toBeUndefined();
    expect(getStoredPlanProgress(removed)).toEqual({ completions: 0, syncMeta: 0, overlay: false });
    // The current plan and its progress are untouched.
    expect(getActivePlan()?.planId).toBe('hal-higdon-novice-1');
    expect(isDayCompleted('hal-higdon-novice-1', 0, 1)).toBe(true);
  });
});

describe('plan search', () => {
  it('planMatchesSearch: every word must match name, author, coach, tags or category, in any case', () => {
    const daniels = getPlanById('daniels-2q-55')!;
    const pfitz = getPlanById('pfitzinger-18-55')!;
    expect(planMatchesSearch(daniels, 'Daniels 2Q')).toBe(true);
    expect(planMatchesSearch(daniels, '2q DANIELS')).toBe(true);
    expect(planMatchesSearch(daniels, 'daniels 18')).toBe(false);
    expect(planMatchesSearch(pfitz, 'pfitzinger 18')).toBe(true);
    expect(planMatchesSearch(pfitz, '  Pfitzinger   18/55 ')).toBe(true);
    expect(planMatchesSearch(pfitz, 'pfitzinger doubles')).toBe(false);
    expect(planMatchesSearch(pfitz, '')).toBe(true);
    expect(planMatchesSearch(getPlanById('apollo-bq-60')!, 'bq')).toBe(true);
    expect(planMatchesSearch(getPlanById('hansons-just-finish')!, 'first marathon')).toBe(true);
  });

  it('the chooser filters by every word of the query', () => {
    const { container } = renderChooser();
    const search = screen.getByLabelText('Search plans by coach, method or volume');

    fireEvent.change(search, { target: { value: 'Daniels 2Q' } });
    let ids = visiblePlanIds(container);
    expect(ids).toEqual(expect.arrayContaining(['daniels-2q-40', 'daniels-2q-55', 'daniels-2q-70', 'daniels-2q-85']));
    for (const id of ids) expect(getPlanById(id)!.author).toMatch(/Daniels/);

    fireEvent.change(search, { target: { value: 'pfitzinger 18' } });
    ids = visiblePlanIds(container);
    expect(ids).toEqual(expect.arrayContaining(['pfitzinger-18-55', 'pfitzinger-18-70', 'pfitzinger-18-85']));
    for (const id of ['pfitzinger-12-55', 'pfitzinger-12-70', 'pfitzinger-multi-12', 'apollo-multi-8']) {
      expect(ids).not.toContain(id);
    }

    fireEvent.change(search, { target: { value: 'PFITZINGER 18 doubles' } });
    ids = visiblePlanIds(container);
    expect(ids).toEqual(expect.arrayContaining(['pfitzinger-18-70', 'pfitzinger-18-85']));
    expect(ids).not.toContain('pfitzinger-18-55');

    fireEvent.change(search, { target: { value: 'higdon zzz' } });
    expect(screen.getByText(/No plans match those filters/)).toBeTruthy();
  });
});
