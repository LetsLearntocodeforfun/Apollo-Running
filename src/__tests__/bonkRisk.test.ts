/**
 * Tests for bonkRisk.ts — Bonk Risk Assessment
 */

import { describe, it, expect } from 'vitest';
import { assessBonkRisk } from '@/services/bonkRisk';
import type { BonkRiskInput } from '@/services/bonkRisk';

const lowRiskInput: BonkRiskInput = {
  longestRunMi: 22,
  runsOver18Mi: 5,
  longRunsPlanned: 10,
  longRunsCompleted: 10,
  targetRacePaceSec: 480,
  avgLongRunPaceSec: 510,
  practicedFueling: true,
  fueledLongRuns: 8,
  carbLoading: true,
  carbLoadingDaysCompleted: 3,
  raceTempF: 55,
  experience: 'advanced',
};

const highRiskInput: BonkRiskInput = {
  longestRunMi: 14,
  runsOver18Mi: 0,
  longRunsPlanned: 8,
  longRunsCompleted: 3,
  targetRacePaceSec: 420,
  avgLongRunPaceSec: 540,
  practicedFueling: false,
  carbLoading: false,
  raceTempF: 82,
  experience: 'beginner',
};

describe('assessBonkRisk', () => {
  it('should return a low risk score for well-prepared runner', () => {
    const result = assessBonkRisk(lowRiskInput);
    expect(result.score).toBeLessThanOrEqual(30);
    expect(result.level).toBe('low');
    expect(result.factors.length).toBeGreaterThan(0);
  });

  it('should return a high risk score for underprepared runner', () => {
    const result = assessBonkRisk(highRiskInput);
    expect(result.score).toBeGreaterThanOrEqual(60);
    expect(['high', 'very_high']).toContain(result.level);
  });

  it('should provide mitigations for high-risk factors', () => {
    const result = assessBonkRisk(highRiskInput);
    expect(result.mitigations.length).toBeGreaterThan(0);
  });

  it('should include individual factor scores', () => {
    const result = assessBonkRisk(lowRiskInput);
    const factorNames = result.factors.map((f) => f.name);
    expect(factorNames).toContain('Longest Run');
    expect(factorNames).toContain('Fueling Practice');
    expect(factorNames).toContain('Carb Loading');
    expect(factorNames).toContain('Pace Aggression');
  });

  it('should score longest run based on mileage thresholds', () => {
    const result22 = assessBonkRisk({ ...lowRiskInput, longestRunMi: 22 });
    const result16 = assessBonkRisk({ ...lowRiskInput, longestRunMi: 16 });
    const result14 = assessBonkRisk({ ...lowRiskInput, longestRunMi: 14 });

    const longest22 = result22.factors.find((f) => f.name === 'Longest Run')!;
    const longest16 = result16.factors.find((f) => f.name === 'Longest Run')!;
    const longest14 = result14.factors.find((f) => f.name === 'Longest Run')!;

    expect(longest22.score).toBeLessThan(longest16.score);
    expect(longest16.score).toBeLessThan(longest14.score);
  });

  it('should penalize aggressive pace targets', () => {
    const conservative = assessBonkRisk({ ...lowRiskInput, targetRacePaceSec: 500, avgLongRunPaceSec: 510 });
    const aggressive = assessBonkRisk({ ...lowRiskInput, targetRacePaceSec: 420, avgLongRunPaceSec: 510 });

    expect(aggressive.score).toBeGreaterThan(conservative.score);
  });

  it('should reward fueling practice', () => {
    const practiced = assessBonkRisk({ ...highRiskInput, practicedFueling: true, fueledLongRuns: 5 });
    const notPracticed = assessBonkRisk({ ...highRiskInput, practicedFueling: false });

    expect(notPracticed.score).toBeGreaterThan(practiced.score);
  });

  it('should reward carb loading', () => {
    const loaded = assessBonkRisk({ ...highRiskInput, carbLoading: true, carbLoadingDaysCompleted: 3 });
    const notLoaded = assessBonkRisk({ ...highRiskInput, carbLoading: false });

    expect(notLoaded.score).toBeGreaterThan(loaded.score);
  });

  it('should include heat risk when temperature is provided', () => {
    const result = assessBonkRisk({ ...lowRiskInput, raceTempF: 85 });
    const heatFactor = result.factors.find((f) => f.name === 'Heat Risk');
    expect(heatFactor).toBeDefined();
    expect(heatFactor!.score).toBeGreaterThan(50);
  });

  it('should include a summary message', () => {
    const result = assessBonkRisk(lowRiskInput);
    expect(result.summary).toBeTruthy();
    expect(result.summary).toContain('Bonk Risk');
  });

  it('should have all factor weighted scores sum to approximately the total', () => {
    const result = assessBonkRisk(lowRiskInput);
    const weightedSum = result.factors.reduce((s, f) => s + f.weightedScore, 0);
    expect(result.score).toBeCloseTo(weightedSum, 0);
  });

  it('should keep score within 0-100 range', () => {
    const low = assessBonkRisk(lowRiskInput);
    const high = assessBonkRisk(highRiskInput);
    expect(low.score).toBeGreaterThanOrEqual(0);
    expect(low.score).toBeLessThanOrEqual(100);
    expect(high.score).toBeGreaterThanOrEqual(0);
    expect(high.score).toBeLessThanOrEqual(100);
  });
});
