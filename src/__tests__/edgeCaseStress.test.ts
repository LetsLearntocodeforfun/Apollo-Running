/**
 * Edge Case & Stress Tests — Phase 4 Services
 *
 * Tests extreme inputs, boundary conditions, and adversarial data
 * to ensure all Phase 4 services degrade gracefully and never crash.
 *
 * v1.0.7 (R-14): the experimental modules' cases moved to
 * src/labs/__tests__/edgeCaseStress.labs.test.ts.
 */

import { describe, it, expect } from 'vitest';
import { getDailyCarbTarget, getRaceMorningCarbTarget } from '@/services/carbLoading';
import { generateFuelingPlan, getGelSchedule } from '@/services/fuelingCalculator';
import { generateRaceDayTimeline } from '@/services/raceDayTimeline';
import { calculateFitnessFatigue, estimateTSS, generateTaperPlan } from '@/services/taperOptimizer';
// ── Carb Loading Edge Cases ───────────────────────────────────────────────────

describe('Carb Loading — Edge Cases', () => {
  it('handles very light runner (40kg)', () => {
    expect(getDailyCarbTarget(40, 3)).toBe(320);  // 8 × 40
    expect(getDailyCarbTarget(40, 1)).toBe(400);  // 10 × 40 (v1.0.6 default, N-14)
  });

  it('handles very heavy runner (130kg)', () => {
    expect(getDailyCarbTarget(130, 1)).toBe(900); // 10 × 90 (v1.0.6: capped at 90 kg, N-14)
  });

  it('handles day 0 (race day) gracefully', () => {
    const target = getDailyCarbTarget(70, 0);
    // Day 0 should return some value or use day 1 target
    expect(target).toBeGreaterThanOrEqual(0);
    expect(isFinite(target)).toBe(true);
  });

  it('handles day 5+ (before loading window)', () => {
    const target = getDailyCarbTarget(70, 5);
    expect(target).toBeGreaterThanOrEqual(0);
    expect(isFinite(target)).toBe(true);
  });

  it('race morning target scales with weight', () => {
    const light = getRaceMorningCarbTarget(50);
    const heavy = getRaceMorningCarbTarget(90);
    expect(heavy).toBeGreaterThan(light);
  });
});

// ── Fueling Calculator Edge Cases ─────────────────────────────────────────────

describe('Fueling Calculator — Edge Cases', () => {
  const baseInput = {
    athlete: { weightKg: 70, sex: 'male' as const, vo2max: 50 },
    paceSecPerMi: 480,
    experience: 'intermediate' as const,
    gutTrained: false,
    preferredProducts: ['gel' as const],
  };

  it('gut-trained runner gets higher carb rate', () => {
    const untrained = generateFuelingPlan({ ...baseInput, gutTrained: false });
    const trained = generateFuelingPlan({ ...baseInput, gutTrained: true });
    expect(trained.targetCarbRateGHr).toBeGreaterThanOrEqual(untrained.targetCarbRateGHr);
  });

  it('very fast marathon (sub-2:30) uses appropriate carb rate', () => {
    const plan = generateFuelingPlan({
      ...baseInput,
      paceSecPerMi: 345,
    });
    expect(plan.targetCarbRateGHr).toBeGreaterThanOrEqual(30);
    expect(plan.targetCarbRateGHr).toBeLessThanOrEqual(90);
  });

  it('very slow marathon (6+ hours) uses appropriate carb rate', () => {
    const plan = generateFuelingPlan({
      ...baseInput,
      paceSecPerMi: 840,
    });
    expect(plan.targetCarbRateGHr).toBeGreaterThanOrEqual(40);
  });

  it('gel schedule produces at least 1 gel mile', () => {
    const schedule = getGelSchedule(480);
    expect(schedule.miles.length).toBeGreaterThanOrEqual(1);
  });

  it('gel schedule produces gels only within marathon distance', () => {
    const schedule = getGelSchedule(480);
    for (const mile of schedule.miles) {
      expect(mile).toBeGreaterThanOrEqual(1);
      expect(mile).toBeLessThanOrEqual(26);
    }
  });
});

// ── Race Day Timeline Edge Cases ──────────────────────────────────────────────

describe('Race Day Timeline — Edge Cases', () => {
  it('handles very early start (4:00 AM)', () => {
    const timeline = generateRaceDayTimeline({
      raceStartTime: '04:00',
      travelMinutes: 30,
      mealPreference: 'moderate',
      weightKg: 70,
      projectedFinishSec: 3.5 * 3600,
      raceName: 'Early Bird Marathon',
    });
    expect(timeline.events.length).toBeGreaterThan(0);
    // Alarm should wrap around midnight
    const alarm = timeline.events.find((e) => e.title.includes('Alarm'));
    expect(alarm).toBeDefined();
  });

  it('handles late start (11:00 AM)', () => {
    const timeline = generateRaceDayTimeline({
      raceStartTime: '11:00',
      travelMinutes: 60,
      mealPreference: 'full',
      weightKg: 80,
      projectedFinishSec: 4 * 3600,
      raceName: 'Late Start Marathon',
    });
    expect(timeline.events.length).toBeGreaterThan(0);
  });

  it('handles long travel time (120 min)', () => {
    const timeline = generateRaceDayTimeline({
      raceStartTime: '07:00',
      travelMinutes: 120,
      mealPreference: 'moderate',
      weightKg: 70,
      projectedFinishSec: 3.5 * 3600,
      raceName: 'Long Drive Marathon',
    });
    const leave = timeline.events.find((e) => e.title.includes('Leave'));
    expect(leave).toBeDefined();
    expect(leave!.minutesBeforeStart).toBeGreaterThanOrEqual(120);
  });

  it('includes warmup when requested', () => {
    const timeline = generateRaceDayTimeline({
      raceStartTime: '07:00',
      travelMinutes: 30,
      mealPreference: 'moderate',
      weightKg: 70,
      projectedFinishSec: 3.5 * 3600,
      raceName: 'Warmup Test',
      includeWarmup: true,
    });
    const warmup = timeline.events.find((e) => e.title.includes('Warmup'));
    expect(warmup).toBeDefined();
  });

  it('generates text export for all timelines', () => {
    const timeline = generateRaceDayTimeline({
      raceStartTime: '07:00',
      travelMinutes: 30,
      mealPreference: 'moderate',
      weightKg: 70,
      projectedFinishSec: 3.5 * 3600,
      raceName: 'Export Test',
    });
    expect(timeline.textExport).toContain('Export Test');
    expect(timeline.textExport.length).toBeGreaterThan(100);
  });
});

// ── Taper Optimizer Edge Cases ────────────────────────────────────────────────

describe('Taper Optimizer — Edge Cases', () => {
  it('handles empty training history', () => {
    const snapshots = calculateFitnessFatigue([]);
    expect(snapshots).toEqual([]);
  });

  it('handles single day of training', () => {
    const snapshots = calculateFitnessFatigue([
      { date: '2025-01-01', tss: 50, distanceMi: 6, type: 'easy' },
    ]);
    expect(snapshots.length).toBe(1);
    expect(snapshots[0].ctl).toBeGreaterThan(0);
    expect(snapshots[0].atl).toBeGreaterThan(0);
  });

  it('rest days have zero TSS', () => {
    expect(estimateTSS(0, 0, 'rest')).toBe(0);
  });

  it('interval TSS > tempo TSS > easy TSS for same distance', () => {
    const easy = estimateTSS(6, 48, 'easy');
    const tempo = estimateTSS(6, 48, 'tempo');
    const interval = estimateTSS(6, 48, 'interval');
    expect(interval).toBeGreaterThan(tempo);
    expect(tempo).toBeGreaterThan(easy);
  });

  it('generateTaperPlan with sparse history still produces valid output', () => {
    const sparseHistory = [
      { date: '2025-01-01', tss: 50, distanceMi: 6, type: 'easy' as const },
      { date: '2025-01-15', tss: 80, distanceMi: 10, type: 'tempo' as const },
      { date: '2025-02-01', tss: 120, distanceMi: 18, type: 'long_run' as const },
    ];
    const taper = generateTaperPlan(sparseHistory, '2025-04-01');
    expect(taper.taperLengthDays).toBeGreaterThanOrEqual(10);
    expect(taper.weeklyReductions.length).toBeGreaterThanOrEqual(1);
    expect(typeof taper.summary).toBe('string');
  });
});
