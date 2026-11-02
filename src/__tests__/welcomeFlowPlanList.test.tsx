/**
 * v1.0.9 onboarding plan list (src/pages/WelcomeFlow.tsx): the peak weekly
 * distance matches the plan chooser (the race itself isn't counted — Galloway
 * peaks at 28 mi, not 31), and search matches every word of the query.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import WelcomeFlow from '../pages/WelcomeFlow';
import { BUILT_IN_PLANS, getPlanById, getPlanOverview, getPlanStats } from '../data/plans';
import { formatMiles } from '../services/unitPreferences';

function goToPlanStep(): void {
  render(<WelcomeFlow onComplete={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Your race and plan');
}

function optionText(planId: string): string {
  const radio = screen.getAllByRole('radio').find((r) => (r as HTMLInputElement).value === planId);
  return radio?.closest('label')?.textContent ?? '';
}

function visiblePlanIds(): string[] {
  return screen
    .getAllByRole('radio')
    .map((r) => (r as HTMLInputElement).value)
    .filter((v) => getPlanById(v) && BUILT_IN_PLANS.some((p) => p.id === v));
}

describe('WelcomeFlow plan list (v1.0.9)', () => {
  beforeEach(() => {
    vi.spyOn(navigator, 'language', 'get').mockReturnValue('en-US');
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('shows the same peak weekly distance as the plan chooser (race not counted)', () => {
    goToPlanStep();
    for (const plan of BUILT_IN_PLANS) {
      expect(optionText(plan.id), plan.id).toContain(
        `peak ~${formatMiles(getPlanStats(plan).peakMiles, 0, 'mi')} a week`,
      );
    }
    const galloway = getPlanById('galloway-run-walk')!;
    const withRace = Math.max(...getPlanOverview(galloway).map((w) => w.totalMiles));
    expect(Math.round(getPlanStats(galloway).peakMiles)).toBeLessThan(Math.round(withRace));
    expect(optionText('galloway-run-walk')).not.toContain(`peak ~${formatMiles(withRace, 0, 'mi')} a week`);
  });

  it('search matches every word, in any case', () => {
    goToPlanStep();
    const search = screen.getByLabelText('Search marathon plans');
    fireEvent.change(search, { target: { value: 'daniels 2q' } });
    const ids = visiblePlanIds();
    expect(ids).toEqual(expect.arrayContaining(['daniels-2q-40', 'daniels-2q-55', 'daniels-2q-70', 'daniels-2q-85']));
    for (const id of ids) expect(getPlanById(id)!.author).toMatch(/Daniels/);

    fireEvent.change(search, { target: { value: 'Pfitzinger 18' } });
    expect(visiblePlanIds()).toEqual(
      expect.arrayContaining(['pfitzinger-18-55', 'pfitzinger-18-70', 'pfitzinger-18-85']),
    );
    expect(visiblePlanIds()).not.toContain('pfitzinger-12-55');
    // "Build my own plan" and "Skip" stay available.
    expect(screen.getAllByRole('radio').some((r) => (r as HTMLInputElement).value === 'none')).toBe(true);
  });
});
