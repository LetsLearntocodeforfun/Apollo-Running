/**
 * v1.0.9: safer-plan suggestions and plan recommendations offer marathon-build
 * plans only — never a multi-marathon bridge (it assumes a marathon was just
 * run), a base or recovery block, or any plan without a `marathon` day. The race
 * dates and fitness below reproduce the reviewer's probe (today Mon 2026-11-02).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import {
  ALL_BUILT_IN_PLANS,
  BUILT_IN_PLANS,
  getPlanById,
  isMarathonBuildPlan,
  suggestPlansForRunner,
  type TrainingPlan,
} from '@/data/plans';
import { saferPlansForRace } from '@/services/planProgress';
import { RaceDatePlanSetup } from '@/components/plan/RaceDatePlanSetup';

const TODAY = '2026-11-02';
const BRIDGES_AND_BLOCKS = [
  'apollo-multi-8',
  'pfitzinger-multi-12',
  'apollo-base-8',
  'apollo-base-12',
  'apollo-recovery-4',
  'apollo-maintenance-6',
];

afterEach(() => cleanup());

/** An imported-style block: no category and no marathon day. */
const importedBlock: TrainingPlan = {
  id: 'imported-easy-block',
  name: 'Easy block',
  author: 'Unknown author',
  description: 'Imported training plan.',
  totalWeeks: 1,
  weeks: [
    {
      weekNumber: 1,
      days: [
        { type: 'rest', label: 'Rest' },
        { type: 'run', label: '2 mi easy', distanceMi: 2, note: 'Easy' },
        { type: 'rest', label: 'Rest' },
        { type: 'run', label: '2 mi easy', distanceMi: 2, note: 'Easy' },
        { type: 'rest', label: 'Rest' },
        { type: 'rest', label: 'Rest' },
        { type: 'run', label: '3 mi easy', distanceMi: 3, note: 'Easy' },
      ],
    },
  ],
};

function expectOnlyBuildPlans(plans: readonly TrainingPlan[]) {
  for (const p of plans) {
    expect(isMarathonBuildPlan(p), p.id).toBe(true);
    expect(BRIDGES_AND_BLOCKS).not.toContain(p.id);
  }
}

describe('isMarathonBuildPlan', () => {
  it('excludes multi-marathon bridges, base/recovery blocks and plans without a marathon day', () => {
    for (const id of BRIDGES_AND_BLOCKS) expect(isMarathonBuildPlan(getPlanById(id)!), id).toBe(false);
    expect(isMarathonBuildPlan(importedBlock)).toBe(false);
    for (const id of ['hal-higdon-novice-1', 'pfitzinger-18-55', 'galloway-run-walk', 'daniels-2q-55']) {
      expect(isMarathonBuildPlan(getPlanById(id)!), id).toBe(true);
    }
  });
});

describe('saferPlansForRace (reviewer probe scenarios)', () => {
  it('8 weeks out at 25 mpw (longest 10 mi): no post-marathon bridge is offered', () => {
    // Before v1.0.9 the only suggestion was apollo-multi-8.
    const safer = saferPlansForRace(
      BUILT_IN_PLANS,
      '2026-12-27',
      { weeklyMiles: 25, longestRunMi: 10 },
      'pfitzinger-18-85',
      TODAY,
    );
    expect(safer.map((p) => p.id)).not.toContain('apollo-multi-8');
    expectOnlyBuildPlans(safer);
  });

  it('12 weeks out at 30 mpw (longest 12 mi): marathon-build plans only, Novice 1 among them', () => {
    // Before: apollo-multi-8, pfitzinger-multi-12, hal-higdon-novice-1.
    const safer = saferPlansForRace(
      BUILT_IN_PLANS,
      '2027-01-24',
      { weeklyMiles: 30, longestRunMi: 12 },
      'pfitzinger-18-85',
      TODAY,
    );
    expect(safer.map((p) => p.id)).toContain('hal-higdon-novice-1');
    expectOnlyBuildPlans(safer);
  });

  it('12 weeks out at 45 mpw (longest 15 mi): marathon-build plans only, Galloway among them', () => {
    // Before: galloway-run-walk, apollo-multi-8, pfitzinger-multi-12.
    const safer = saferPlansForRace(
      BUILT_IN_PLANS,
      '2027-01-24',
      { weeklyMiles: 45, longestRunMi: 15 },
      'pfitzinger-18-85',
      TODAY,
    );
    expect(safer.map((p) => p.id)).toContain('galloway-run-walk');
    expectOnlyBuildPlans(safer);
  });

  it('ignores blocks and bridges in any candidate list, including imported plans', () => {
    const candidates = [...ALL_BUILT_IN_PLANS, importedBlock];
    for (const fitness of [
      { weeklyMiles: 5, longestRunMi: 3 },
      { weeklyMiles: 25, longestRunMi: 10 },
      { weeklyMiles: 60, longestRunMi: 18 },
    ]) {
      for (const race of ['2026-12-27', '2027-01-24', '2027-04-25']) {
        expectOnlyBuildPlans(saferPlansForRace(candidates, race, fitness, null, TODAY));
      }
    }
  });
});

describe('suggestPlansForRunner', () => {
  it('never recommends a multi-marathon bridge or a block', () => {
    for (const miles of [0, 10, 22, 35, 50, 70, 90, 120]) {
      for (let days = 1; days <= 7; days++) {
        const recs = suggestPlansForRunner(miles, days);
        expect(recs.length).toBeGreaterThan(0);
        for (const rec of recs)
          expect(isMarathonBuildPlan(getPlanById(rec.planId)!), `${miles}/${days}: ${rec.planId}`).toBe(true);
      }
    }
  });
});

describe('RaceDatePlanSetup gentler-plan offer', () => {
  it('a 25 mpw runner 8 weeks out is not offered a post-marathon bridge', () => {
    render(
      <RaceDatePlanSetup
        plan={getPlanById('hal-higdon-novice-1')!}
        value={{ raceDate: '2026-12-27', useStartDate: false, startDate: '' }}
        onChange={vi.fn()}
        onChoosePlan={vi.fn()}
        idPrefix="safer"
        today={TODAY}
        fitness={{ weeklyMiles: 25, longestRunMi: 10 }}
      />,
    );
    expect(screen.getByText(/is a big jump from your recent training/)).toBeTruthy();
    expect(screen.queryByText(/Multiple Marathoning/)).toBeNull();
    expect(screen.queryByRole('button', { name: /Multiple Marathoning/ })).toBeNull();

    // No plan here fits that race date safely, so the calm ways out are a later race and a ramp-in.
    const warning = screen.getByText(/is a big jump from your recent training/).closest('section')!;
    expect(within(warning).getByText('A later race.')).toBeTruthy();
    expect(within(warning).getByRole('button', { name: /^Use / })).toBeTruthy();
    expect(within(warning).getByText('A ramp-in.')).toBeTruthy();
    expect(within(warning).queryByText(/A gentler plan/)).toBeNull();
  });
});
