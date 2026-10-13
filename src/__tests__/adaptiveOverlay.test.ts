/**
 * v1.0.7 (T-2): adaptive apply/undo goes through the plan overlay, per plan
 * instance, using effective-plan week numbers. The shared built-in plan is
 * never mutated; changes persist across reload and work for custom plans.
 */
import { describe, it, expect, vi } from 'vitest';
import { persistence } from '@/services/db/persistence';
import { startPlan, getActivePlanInstanceId } from '@/services/planProgress';
import { getEffectivePlan, getOverlayLog, undoLastChange } from '@/services/planOverlay';
import { applyRecommendation, getLastModification, undoRecommendation } from '@/services/adaptiveTraining';
import { CUSTOM_PLAN_ID, getPlanById, setCustomPlan } from '@/data/plans';
import type { AdaptiveRecommendation } from '@/types/recommendations';

const NOVICE1 = 'hal-higdon-novice-1';
const RECS_KEY = 'apollo_adaptive_recommendations';

function seedRec(weekIndex: number, multiplier: number, planInstanceId?: string): string {
  const rec: AdaptiveRecommendation = {
    id: 'rec-t2',
    scenario: 'behind_schedule',
    type: 'reduce',
    priority: 'high',
    status: 'active',
    title: 't',
    message: 'm',
    reasoning: 'r',
    dismissible: true,
    createdAt: new Date().toISOString(),
    planInstanceId,
    options: [
      {
        key: 'reduce',
        label: 'Reduce',
        description: '',
        impact: '',
        actionType: 'apply_modification',
        actionPayload: {
          id: '',
          description: 'Reduced mileage 20%',
          modificationType: 'mileage_reduction',
          weekAdjustments: [{ weekIndex, mileageMultiplier: multiplier }],
          appliedAt: '',
          undone: false,
          originalSnapshot: [],
        },
      },
    ],
  };
  persistence.setItem(RECS_KEY, JSON.stringify([rec]));
  return rec.id;
}

const runMiles = (weekIndex: number): number =>
  getEffectivePlan()!.weeks[weekIndex].days.reduce((s, d) => s + (d.type === 'run' ? (d.distanceMi ?? 0) : 0), 0);

describe('adaptive apply/undo through the overlay (T-2)', () => {
  it('applies to the active instance only and never mutates the built-in plan', () => {
    startPlan({ planId: NOVICE1, raceDate: '2026-04-19' }, '2025-12-01');
    const baseBefore = JSON.stringify(getPlanById(NOVICE1));
    const before = runMiles(4);
    const id = seedRec(4, 0.8, getActivePlanInstanceId() ?? undefined);

    const mod = applyRecommendation(id, 'reduce');
    expect(mod).not.toBeNull();
    expect(mod!.planInstanceId).toBe(getActivePlanInstanceId());
    expect(mod!.overlayLogIds).toHaveLength(1);
    expect(runMiles(4)).toBeLessThan(before);
    expect(getOverlayLog().map((e) => e.kind)).toEqual(['adaptive']);
    expect(JSON.stringify(getPlanById(NOVICE1))).toBe(baseBefore);

    expect(undoRecommendation(mod!.id)).toBe(true);
    expect(runMiles(4)).toBeCloseTo(before, 5);
    expect(getOverlayLog()).toEqual([]);
    expect(getLastModification()).toBeNull();
  });

  it('persists across a reload and can be undone afterwards', async () => {
    startPlan({ planId: NOVICE1, raceDate: '2026-04-19' }, '2025-12-01');
    const before = runMiles(5);
    const mod = applyRecommendation(seedRec(5, 0.8), 'reduce')!;
    const after = runMiles(5);

    vi.resetModules();
    const overlay = await import('@/services/planOverlay');
    const adaptive = await import('@/services/adaptiveTraining');
    const sum = (w: number) =>
      overlay.getEffectivePlan()!.weeks[w].days.reduce((s, d) => s + (d.type === 'run' ? (d.distanceMi ?? 0) : 0), 0);
    expect(sum(5)).toBeCloseTo(after, 5);
    expect(adaptive.getLastModification()?.id).toBe(mod.id);
    expect(adaptive.undoRecommendation(mod.id)).toBe(true);
    expect(sum(5)).toBeCloseTo(before, 5);
  });

  it('uses effective (placed) week numbers after a late join', () => {
    // Race 10 weeks away on an 18-week plan: the athlete joins at week index 8.
    startPlan({ planId: NOVICE1, raceDate: '2026-04-26' }, '2026-02-16');
    const before = runMiles(9);
    const otherBefore = runMiles(1);
    applyRecommendation(seedRec(9, 0.8), 'reduce');
    expect(runMiles(9)).toBeLessThan(before);
    expect(runMiles(1)).toBe(otherBefore);
  });

  it('works for custom plans', () => {
    const base = getPlanById(NOVICE1)!;
    setCustomPlan({ ...JSON.parse(JSON.stringify(base)), id: CUSTOM_PLAN_ID, name: 'Mine' });
    startPlan({ planId: CUSTOM_PLAN_ID, raceDate: '2026-04-19' }, '2025-12-01');
    const before = runMiles(4);
    const mod = applyRecommendation(seedRec(4, 0.8), 'reduce');
    expect(mod).not.toBeNull();
    expect(runMiles(4)).toBeLessThan(before);
    expect(undoRecommendation(mod!.id)).toBe(true);
    expect(runMiles(4)).toBeCloseTo(before, 5);
  });

  it('refuses a recommendation made for another plan instance', () => {
    startPlan({ planId: NOVICE1, raceDate: '2026-04-19' }, '2025-12-01');
    expect(applyRecommendation(seedRec(4, 0.8, 'pfitzinger-18-55@2025-12-29'), 'reduce')).toBeNull();
    expect(getOverlayLog()).toEqual([]);
  });

  it('changes stay with their instance; switching plans hides them from undo', () => {
    startPlan({ planId: NOVICE1, raceDate: '2026-04-19' }, '2025-12-01');
    const mod = applyRecommendation(seedRec(4, 0.8), 'reduce')!;
    startPlan({ planId: 'pfitzinger-18-55', raceDate: '2026-05-03' }, '2025-12-01');
    expect(getOverlayLog()).toEqual([]);
    expect(getLastModification()).toBeNull();
    startPlan({ planId: NOVICE1, raceDate: '2026-04-19' }, '2025-12-01');
    expect(getLastModification()?.id).toBe(mod.id);
  });

  it('treats a change already undone from the plan screen as undone', () => {
    startPlan({ planId: NOVICE1, raceDate: '2026-04-19' }, '2025-12-01');
    const before = runMiles(4);
    const mod = applyRecommendation(seedRec(4, 0.8), 'reduce')!;
    expect(undoLastChange().ok).toBe(true);
    expect(undoRecommendation(mod.id)).toBe(true);
    expect(runMiles(4)).toBeCloseTo(before, 5);
  });
});
