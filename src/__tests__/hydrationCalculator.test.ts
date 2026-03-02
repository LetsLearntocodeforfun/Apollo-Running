/**
 * Tests for hydrationCalculator.ts — Sweat Rate & Hydration Planning
 */

import { describe, it, expect } from 'vitest';
import {
  calculateSweatRate,
  assessDehydrationRisk,
} from '@/services/hydrationCalculator';

const baseAthlete = { weightKg: 70, vo2max: 50, sex: 'male' as const };
const coolConditions = { tempF: 55, humidityPct: 40, altitudeFt: 0 };
const hotConditions = { tempF: 85, humidityPct: 75, altitudeFt: 0 };

describe('calculateSweatRate', () => {
  it('should return a valid sweat rate estimate', () => {
    const result = calculateSweatRate(baseAthlete, coolConditions, 480, 240);
    expect(result.adjustedSweatRateMlHr).toBeGreaterThan(0);
    expect(result.totalFluidNeededMl).toBeGreaterThan(0);
    expect(result.recommendedIntakeMlHr).toBeGreaterThan(0);
    expect(result.sodiumLossMgHr).toBeGreaterThan(0);
  });

  it('should estimate higher sweat rate in hot conditions', () => {
    const cool = calculateSweatRate(baseAthlete, coolConditions, 480, 240);
    const hot = calculateSweatRate(baseAthlete, hotConditions, 480, 240);
    expect(hot.adjustedSweatRateMlHr).toBeGreaterThan(cool.adjustedSweatRateMlHr);
  });

  it('should estimate lower sweat rate for female athletes', () => {
    const male = calculateSweatRate(baseAthlete, coolConditions, 480, 240);
    const female = calculateSweatRate(
      { ...baseAthlete, sex: 'female' as const },
      coolConditions, 480, 240,
    );
    expect(female.adjustedSweatRateMlHr).toBeLessThan(male.adjustedSweatRateMlHr);
  });

  it('should not exceed maximum safe intake rate', () => {
    const result = calculateSweatRate(baseAthlete, hotConditions, 360, 240);
    expect(result.recommendedIntakeMlHr).toBeLessThanOrEqual(1000);
  });

  it('should provide aid station plan when stations are given', () => {
    const stations = [
      { distanceMi: 3, name: 'Station 1', offerings: ['water', 'electrolyte'] },
      { distanceMi: 6, name: 'Station 2', offerings: ['water'] },
      { distanceMi: 9, name: 'Station 3', offerings: ['water', 'electrolyte'] },
    ];
    const result = calculateSweatRate(baseAthlete, coolConditions, 480, 240, stations);
    expect(result.aidStationPlan).toBeDefined();
    expect(result.aidStationPlan.length).toBeGreaterThan(0);
  });

  it('should calculate total fluid needed over race duration', () => {
    const result = calculateSweatRate(baseAthlete, coolConditions, 480, 240);
    expect(result.totalFluidNeededMl).toBeGreaterThan(0);
  });

  it('should include dehydration risk level', () => {
    const result = calculateSweatRate(baseAthlete, coolConditions, 480, 240);
    expect(['low', 'moderate', 'high', 'extreme']).toContain(result.dehydrationRisk);
  });
});

describe('assessDehydrationRisk', () => {
  it('should return low or moderate risk in cool conditions', () => {
    const result = assessDehydrationRisk(baseAthlete, coolConditions, 540);
    expect(['low', 'moderate', 'high']).toContain(result.risk);
    expect(result.message).toBeTruthy();
  });

  it('should return higher risk in hot conditions', () => {
    const cool = assessDehydrationRisk(baseAthlete, coolConditions, 480);
    const hot = assessDehydrationRisk(baseAthlete, hotConditions, 480);
    const riskOrder: Record<string, number> = { low: 0, moderate: 1, high: 2, extreme: 3 };
    expect(riskOrder[hot.risk]).toBeGreaterThanOrEqual(riskOrder[cool.risk]);
  });

  it('should provide a risk message', () => {
    const result = assessDehydrationRisk(baseAthlete, hotConditions, 480);
    expect(result.message).toBeTruthy();
    expect(result.message.length).toBeGreaterThan(10);
  });
});
