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

describe('carb loading v1.0.6 fixes', () => {
  const allDescriptions = (days: { meals: { description: string }[] }[]) =>
    days.flatMap((d) => d.meals.map((m) => m.description)).join(' | ');

  it('low-fiber filter excludes oatmeal and sweet potato on D-2 and D-1 (N-11, N-12)', () => {
    for (const weightKg of [50, 70, 90]) {
      for (const carbsPerKg of [8, 10, 12]) {
        const protocol = generateCarbLoadingProtocol({ weightKg }, '2025-10-15', { carbsPerKg });
        const lowFiberDays = protocol.days.filter((d) => d.daysBefore <= 2);
        expect(lowFiberDays).toHaveLength(2);
        const text = allDescriptions(lowFiberDays);
        expect(text).not.toMatch(/Oatmeal|Sweet potato|Granola|Dried fruit|Energy bar/);
        expect(allDescriptions([protocol.raceMorning])).not.toMatch(/Oatmeal|Sweet potato/);
      }
    }
  });

  it('defaults to 10 g/kg on D-2 and D-1, selectable 8/10/12, with an optional D-3 (N-14)', () => {
    const protocol = generateCarbLoadingProtocol({ weightKg: 70 }, '2025-10-15');
    expect(protocol.carbsPerKg).toBe(10);
    expect(protocol.days.map((d) => d.targetCarbsG)).toEqual([560, 700, 700]);
    expect(protocol.days[0].optional).toBe(true);
    const twelve = generateCarbLoadingProtocol({ weightKg: 70 }, '2025-10-15', { carbsPerKg: 12, includeDay3: false });
    expect(twelve.days.map((d) => d.daysBefore)).toEqual([2, 1]);
    expect(twelve.days.map((d) => d.targetCarbsG)).toEqual([840, 840]);
    expect(getDailyCarbTarget(70, 1, 8)).toBe(560);
    expect(protocol.notes?.join(' ')).toMatch(/10–12 g carbs per kg per day for the final 36–48 h/);
  });

  it('caps targets for heavy runners (N-14)', () => {
    const heavy = generateCarbLoadingProtocol({ weightKg: 130 }, '2025-10-15');
    expect(heavy.massCapped).toBe(true);
    expect(heavy.effectiveMassKg).toBe(90);
    expect(heavy.days.find((d) => d.daysBefore === 1)!.targetCarbsG).toBe(900);
    expect(getDailyCarbTarget(130, 1)).toBe(900);
    expect(getRaceMorningCarbTarget(130)).toBe(225);
  });

  it('day meal suggestions land close to each day target', () => {
    const protocol = generateCarbLoadingProtocol({ weightKg: 70 }, '2025-10-15');
    for (const day of protocol.days) {
      const total = day.meals.reduce((s, m) => s + m.carbsG, 0);
      expect(total).toBeGreaterThanOrEqual(day.targetCarbsG * 0.9);
      expect(total).toBeLessThanOrEqual(day.targetCarbsG * 1.15);
    }
  });

  it('builds the race-morning meal from the food database up to the target (N-13)', () => {
    for (const weightKg of [45, 70, 90, 110]) {
      const { raceMorning } = generateCarbLoadingProtocol({ weightKg }, '2025-10-15');
      const meal = raceMorning.meals[0];
      expect(meal.carbsG).toBeGreaterThanOrEqual(raceMorning.targetCarbsG - 10);
      expect(meal.carbsG).toBeLessThanOrEqual(raceMorning.targetCarbsG + 10);
      expect(raceMorning.warning).toBeUndefined();
      // Every listed amount comes from the database (no "toast with jam (53g)").
      const listed = [...meal.description.matchAll(/\((\d+)g\)/g)].reduce((s, m) => s + Number(m[1]), 0);
      expect(listed).toBe(meal.carbsG);
      expect(meal.description).not.toMatch(/53g/);
    }
  });

  it('guards against missing or invalid body mass', () => {
    for (const weightKg of [0, -5, Number.NaN]) {
      const protocol = generateCarbLoadingProtocol({ weightKg }, '2025-10-15');
      expect(protocol.days).toEqual([]);
      expect(protocol.totalCarbTargetG).toBe(0);
      expect(protocol.raceMorning.meals).toEqual([]);
      expect(protocol.summary).not.toMatch(/NaN|Infinity/);
      expect(getDailyCarbTarget(weightKg, 2)).toBe(0);
      expect(getRaceMorningCarbTarget(weightKg)).toBe(0);
    }
  });
});
