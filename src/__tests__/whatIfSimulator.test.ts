/**
 * Tests for whatIfSimulator.ts — What-If Training Simulator
 */

import { describe, it, expect } from 'vitest';
import {
  simulateWhatIf,
  getAvailableScenarios,
  simulateAllScenarios,
} from '@/services/whatIfSimulator';
import { vdotToMarathonSec } from '@/services/racePrediction';

describe('simulateWhatIf', () => {
  it('should project time change for increasing mileage', () => {
    const result = simulateWhatIf(
      { type: 'increase_mileage', label: '', description: '', value: 10 },
      45,
      40,
    );
    expect(result).toBeDefined();
    expect(result.baselineTimeSec).toBeGreaterThan(0);
    expect(result.projectedTimeSec).toBeLessThan(result.baselineTimeSec);
    expect(result.deltaSec).toBeLessThan(0); // faster
  });

  it('should project slower time for decreasing mileage', () => {
    const result = simulateWhatIf(
      { type: 'decrease_mileage', label: '', description: '', value: 10 },
      45,
      40,
    );
    expect(result.projectedTimeSec).toBeGreaterThan(result.baselineTimeSec);
    expect(result.deltaSec).toBeGreaterThan(0); // slower
  });

  it('should project slower time for skipping training days', () => {
    const result = simulateWhatIf(
      { type: 'skip_days', label: '', description: '', value: 14 },
      45,
      40,
    );
    expect(result.projectedTimeSec).toBeGreaterThan(result.baselineTimeSec);
  });

  it('should project faster time for weight loss', () => {
    const result = simulateWhatIf(
      { type: 'weight_change', label: '', description: '', value: -5 },
      45,
      40,
    );
    expect(result.projectedTimeSec).toBeLessThan(result.baselineTimeSec);
  });

  it('should project slower time for weight gain', () => {
    const result = simulateWhatIf(
      { type: 'weight_change', label: '', description: '', value: 5 },
      45,
      40,
    );
    expect(result.projectedTimeSec).toBeGreaterThan(result.baselineTimeSec);
  });

  it('should include a human-readable explanation', () => {
    const result = simulateWhatIf(
      { type: 'increase_mileage', label: '', description: '', value: 10 },
      45,
      40,
    );
    expect(result.explanation).toBeTruthy();
    expect(result.explanation.length).toBeGreaterThan(10);
  });
});

describe('getAvailableScenarios', () => {
  it('should return multiple scenarios', () => {
    const scenarios = getAvailableScenarios();
    expect(scenarios.length).toBeGreaterThanOrEqual(5);
  });

  it('should have valid scenario shapes', () => {
    const scenarios = getAvailableScenarios();
    for (const s of scenarios) {
      expect(s.type).toBeTruthy();
      expect(s.label).toBeTruthy();
      expect(typeof s.value).toBe('number');
    }
  });

  it('does not offer weight-change presets by default (A-05)', () => {
    expect(getAvailableScenarios().some((s) => s.type === 'weight_change')).toBe(false);
  });
});

describe('baseline (A-03)', () => {
  it('uses the corrected Daniels–Gilbert marathon time (VDOT 50 → ~3:10:49, not ~7 h)', () => {
    const result = simulateWhatIf({ type: 'increase_mileage', label: '', description: '', value: 10 }, 50, 40);
    expect(result.baselineTimeSec).toBe(vdotToMarathonSec(50));
    expect(Math.abs(result.baselineTimeSec - (3 * 3600 + 10 * 60 + 49))).toBeLessThanOrEqual(60);
  });
});

describe('simulateAllScenarios', () => {
  it('should return results for all scenarios', () => {
    const results = simulateAllScenarios(45, 40);
    expect(results.length).toBe(getAvailableScenarios().length);
  });

  it('should include both positive and negative deltas', () => {
    const results = simulateAllScenarios(45, 40);
    const hasPositive = results.some((r) => r.deltaSec > 0);
    const hasNegative = results.some((r) => r.deltaSec < 0);
    expect(hasPositive).toBe(true);
    expect(hasNegative).toBe(true);
  });
});
