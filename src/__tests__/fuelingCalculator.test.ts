/**
 * Tests for fuelingCalculator.ts — In-Race Fueling Calculator
 */

import { describe, it, expect } from 'vitest';
import {
  generateFuelingPlan,
  getGelSchedule,
} from '@/services/fuelingCalculator';

const baseAthlete = { weightKg: 70, vo2max: 50, sex: 'male' as const };

describe('generateFuelingPlan', () => {
  it('should generate fueling items for a marathon', () => {
    const plan = generateFuelingPlan({
      athlete: baseAthlete,
      paceSecPerMi: 480,
      experience: 'intermediate',
      gutTrained: false,
    });
    expect(plan.items.length).toBeGreaterThan(0);
    expect(plan.totalCarbsPlannedG).toBeGreaterThan(0);
    expect(plan.targetCarbRateGHr).toBeGreaterThan(0);
  });

  it('should recommend different carb rates based on duration and experience', () => {
    const fast = generateFuelingPlan({
      athlete: baseAthlete,
      paceSecPerMi: 390,
      experience: 'advanced',
      gutTrained: true,
    });
    const slow = generateFuelingPlan({
      athlete: baseAthlete,
      paceSecPerMi: 600,
      experience: 'beginner',
      gutTrained: false,
    });
    // Both should have positive carb rate targets
    expect(fast.targetCarbRateGHr).toBeGreaterThan(0);
    expect(slow.targetCarbRateGHr).toBeGreaterThan(0);
    // Gut-trained advanced runner may have higher rate than beginner
    expect(fast.targetCarbRateGHr).toBeGreaterThanOrEqual(slow.targetCarbRateGHr);
  });

  it('should include caffeine strategy', () => {
    const plan = generateFuelingPlan({
      athlete: baseAthlete,
      paceSecPerMi: 480,
      experience: 'intermediate',
      gutTrained: false,
    });
    expect(plan.caffeine).toBeDefined();
    expect(plan.caffeine.totalMg).toBeGreaterThan(0);
    expect(plan.caffeine.items.length).toBeGreaterThan(0);
    expect(plan.caffeine.items[0].mile).toBeGreaterThanOrEqual(16);
  });

  it('should flag GI risk for high carb rates without gut training', () => {
    const plan = generateFuelingPlan({
      athlete: baseAthlete,
      paceSecPerMi: 600,
      experience: 'beginner',
      gutTrained: false,
    });
    expect(plan.giRisk).toBeDefined();
  });

  it('should allow higher carb rates for gut-trained athletes', () => {
    const untrained = generateFuelingPlan({
      athlete: baseAthlete,
      paceSecPerMi: 480,
      experience: 'advanced',
      gutTrained: false,
    });
    const trained = generateFuelingPlan({
      athlete: baseAthlete,
      paceSecPerMi: 480,
      experience: 'advanced',
      gutTrained: true,
    });
    expect(trained.targetCarbRateGHr).toBeGreaterThanOrEqual(untrained.targetCarbRateGHr);
  });

  it('should place fueling items at reasonable mile intervals', () => {
    const plan = generateFuelingPlan({
      athlete: baseAthlete,
      paceSecPerMi: 480,
      experience: 'intermediate',
      gutTrained: false,
    });
    for (const item of plan.items) {
      expect(item.mile).toBeGreaterThanOrEqual(3);
      expect(item.mile).toBeLessThanOrEqual(25);
    }
  });

  it('should include a summary message', () => {
    const plan = generateFuelingPlan({
      athlete: baseAthlete,
      paceSecPerMi: 480,
      experience: 'intermediate',
      gutTrained: false,
    });
    expect(plan.summary).toBeTruthy();
    expect(plan.summary.length).toBeGreaterThan(20);
  });
});

describe('getGelSchedule', () => {
  it('should return mile numbers for gel intake', () => {
    const schedule = getGelSchedule(480);
    expect(schedule.miles.length).toBeGreaterThan(0);
    for (const mile of schedule.miles) {
      expect(mile).toBeGreaterThanOrEqual(3);
      expect(mile).toBeLessThanOrEqual(25);
    }
  });

  it('should space gels reasonably', () => {
    const schedule = getGelSchedule(480);
    for (let i = 1; i < schedule.miles.length; i++) {
      const gap = schedule.miles[i] - schedule.miles[i - 1];
      expect(gap).toBeGreaterThanOrEqual(2);
      expect(gap).toBeLessThanOrEqual(6);
    }
  });
});
