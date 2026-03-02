/**
 * Tests for carbLoading.ts — Carb Loading Protocol Generator
 */

import { describe, it, expect } from 'vitest';
import {
  generateCarbLoadingProtocol,
  getDailyCarbTarget,
  getRaceMorningCarbTarget,
} from '@/services/carbLoading';

const baseAthlete = { weightKg: 70, vo2max: 50, sex: 'male' as const };

describe('generateCarbLoadingProtocol', () => {
  it('should generate a 3-day protocol', () => {
    const protocol = generateCarbLoadingProtocol(baseAthlete, '2025-10-15');
    expect(protocol.days.length).toBe(3);
    // Days should be D-3, D-2, D-1
    expect(protocol.days[0].daysBefore).toBe(3);
    expect(protocol.days[1].daysBefore).toBe(2);
    expect(protocol.days[2].daysBefore).toBe(1);
  });

  it('should increase carb targets each day', () => {
    const protocol = generateCarbLoadingProtocol(baseAthlete, '2025-10-15');
    for (let i = 1; i < protocol.days.length; i++) {
      expect(protocol.days[i].targetCarbsG).toBeGreaterThanOrEqual(
        protocol.days[i - 1].targetCarbsG,
      );
    }
  });

  it('should include race morning target', () => {
    const protocol = generateCarbLoadingProtocol(baseAthlete, '2025-10-15');
    expect(protocol.raceMorning).toBeDefined();
    expect(protocol.raceMorning.targetCarbsG).toBeGreaterThan(0);
    expect(protocol.raceMorning.targetCarbsG).toBeLessThan(protocol.days[0].targetCarbsG);
  });

  it('should include meal suggestions', () => {
    const protocol = generateCarbLoadingProtocol(baseAthlete, '2025-10-15');
    for (const day of protocol.days) {
      expect(day.meals.length).toBeGreaterThan(0);
      for (const meal of day.meals) {
        expect(meal.name).toBeTruthy();
        expect(meal.carbsG).toBeGreaterThan(0);
      }
    }
  });

  it('should scale targets by body weight', () => {
    const light = generateCarbLoadingProtocol(
      { ...baseAthlete, weightKg: 55 }, '2025-10-15',
    );
    const heavy = generateCarbLoadingProtocol(
      { ...baseAthlete, weightKg: 90 }, '2025-10-15',
    );
    expect(heavy.days[0].targetCarbsG).toBeGreaterThan(light.days[0].targetCarbsG);
  });

  it('should reduce fiber in later days', () => {
    const protocol = generateCarbLoadingProtocol(baseAthlete, '2025-10-15');
    // D-1 should have low-fiber guidance
    const lastDay = protocol.days[2];
    expect(lastDay.fiberGuidance).toBeDefined();
    expect(lastDay.fiberGuidance.toLowerCase()).toContain('fiber');
  });
});

describe('getDailyCarbTarget', () => {
  it('should return higher targets for fewer days before race', () => {
    const d3 = getDailyCarbTarget(70, 3);
    const d2 = getDailyCarbTarget(70, 2);
    const d1 = getDailyCarbTarget(70, 1);
    expect(d2).toBeGreaterThanOrEqual(d3);
    expect(d1).toBeGreaterThanOrEqual(d2);
  });

  it('should scale linearly with body weight', () => {
    const t60 = getDailyCarbTarget(60, 2);
    const t80 = getDailyCarbTarget(80, 2);
    expect(t80 / t60).toBeCloseTo(80 / 60, 1);
  });
});

describe('getRaceMorningCarbTarget', () => {
  it('should return a reasonable pre-race carb target', () => {
    const target = getRaceMorningCarbTarget(70);
    expect(target).toBeGreaterThan(100); // at least 100g
    expect(target).toBeLessThan(300); // not excessive
  });
});
