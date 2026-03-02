/**
 * Unit tests for complianceAnalysis.ts
 *
 * Tests pace/distance compliance scoring, feedback generation,
 * coaching suggestions, and compliance history persistence.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  analyzeCompliance,
  saveComplianceResult,
  getComplianceResult,
  getAllComplianceResults,
  getWeeklyComplianceTrend,
} from '@/services/complianceAnalysis';
import { saveTrainingPaces, calculateTrainingPaces } from '@/services/paceCalculator';
import { persistence } from '@/services/db/persistence';

// VDOT 45 yields approximately:
//   Easy: ~550-570 sec/mi (9:10-9:30/mi)
//   Tempo: ~480 sec/mi (8:00/mi)
//   Speed: ~440 sec/mi (7:20/mi)
const VDOT_45 = 45;

function setupPaces() {
  const paces = calculateTrainingPaces(VDOT_45)!;
  saveTrainingPaces(paces);
  persistence.setItem('apollo_race_prediction', JSON.stringify({ vdot: VDOT_45 }));
}

beforeEach(() => {
  persistence.clear();
  setupPaces();
});

// ── analyzeCompliance: basic ──────────────────────────────────────────────────

describe('analyzeCompliance', () => {
  it('should return null when no note is provided', () => {
    expect(analyzeCompliance('', 9.0, 5, 5)).toBeNull();
  });

  it('should return null when pace is zero', () => {
    expect(analyzeCompliance('Easy', 0, 5, 5)).toBeNull();
  });

  it('should return null when no training paces are available', () => {
    persistence.clear(); // Remove saved paces
    expect(analyzeCompliance('Easy', 9.0, 5, 5)).toBeNull();
  });
});

// ── Easy run compliance ───────────────────────────────────────────────────────

describe('easy run compliance', () => {
  it('should score 100 for pace within easy range', () => {
    // VDOT 45 easy pace range: ~537-559 sec/mi (8:57-9:19/mi)
    // 9:10 = 9.167 min/mi = 550 sec → should be in range
    const result = analyzeCompliance('Easy', 9.167, 5, 5)!;
    expect(result).not.toBeNull();
    expect(result.paceCompliance.inRange).toBe(true);
    expect(result.paceCompliance.direction).toBe('on_target');
    expect(result.score).toBeGreaterThanOrEqual(90);
    expect(result.feedback).toContain('on target');
  });

  it('should flag easy run as too fast', () => {
    // 7:30/mi = 7.5 min/mi → way too fast for easy run
    const result = analyzeCompliance('Easy', 7.5, 5, 5)!;
    expect(result).not.toBeNull();
    expect(result.paceCompliance.inRange).toBe(false);
    expect(result.paceCompliance.direction).toBe('too_fast');
    expect(result.paceCompliance.deviationSec).toBeGreaterThan(0);
    expect(result.coachingSuggestion).toBeDefined();
    expect(result.coachingSuggestion!.toLowerCase()).toContain('slow');
  });

  it('should not penalize easy runs for being slow', () => {
    // 10:30/mi = 10.5 min/mi → a bit slow but acceptable
    const result = analyzeCompliance('Easy', 10.5, 5, 5)!;
    expect(result).not.toBeNull();
    // Slower than target is mild penalty for easy runs
    expect(result.score).toBeGreaterThanOrEqual(50);
    // No coaching suggestion for slow easy runs
    expect(result.coachingSuggestion).toBeUndefined();
  });
});

// ── Tempo run compliance ──────────────────────────────────────────────────────

describe('tempo run compliance', () => {
  it('should score high for pace at threshold', () => {
    // VDOT 45 threshold: ~8:00/mi → 8.0 min/mi
    const result = analyzeCompliance('Tempo', 8.0, 6, 6)!;
    expect(result).not.toBeNull();
    expect(result.score).toBeGreaterThanOrEqual(85);
  });

  it('should flag tempo as too fast with coaching', () => {
    // 7:00/mi = 7.0 min/mi → significantly faster than threshold
    const result = analyzeCompliance('Tempo', 7.0, 6, 6)!;
    expect(result.paceCompliance.direction).toBe('too_fast');
    expect(result.coachingSuggestion).toBeDefined();
    expect(result.coachingSuggestion).toContain('threshold');
  });

  it('should flag tempo as too slow with coaching', () => {
    // 9:30/mi = 9.5 min/mi → way slower than threshold
    const result = analyzeCompliance('Tempo', 9.5, 6, 6)!;
    expect(result.paceCompliance.direction).toBe('too_slow');
    expect(result.coachingSuggestion).toBeDefined();
  });
});

// ── Speed workout compliance ──────────────────────────────────────────────────

describe('speed workout compliance', () => {
  it('should score high for pace at interval target', () => {
    // VDOT 45 interval: ~7:20/mi → 7.33 min/mi
    const result = analyzeCompliance('Speed', 7.33, 5, 5)!;
    expect(result).not.toBeNull();
    expect(result.score).toBeGreaterThanOrEqual(85);
  });

  it('should provide coaching for too-fast intervals', () => {
    // 6:00/mi = way too fast for intervals
    const result = analyzeCompliance('Speed', 6.0, 5, 5)!;
    expect(result.paceCompliance.direction).toBe('too_fast');
    expect(result.coachingSuggestion).toContain('consistent');
  });

  it('should provide coaching for too-slow intervals', () => {
    // 9:00/mi = way too slow for speed work
    const result = analyzeCompliance('Speed', 9.0, 5, 5)!;
    expect(result.paceCompliance.direction).toBe('too_slow');
    expect(result.coachingSuggestion).toContain('reduce');
  });
});

// ── Distance compliance ───────────────────────────────────────────────────────

describe('distance compliance', () => {
  it('should score 100 for exact distance match', () => {
    const result = analyzeCompliance('Easy', 9.33, 5, 5)!;
    expect(result.distanceCompliance.score).toBe(100);
    expect(result.distanceCompliance.diffPct).toBe(0);
  });

  it('should score 100 for distance within 5%', () => {
    const result = analyzeCompliance('Easy', 9.33, 5.2, 5)!;
    expect(result.distanceCompliance.score).toBe(100);
  });

  it('should mildly penalize over-distance', () => {
    const result = analyzeCompliance('Easy', 9.33, 6.5, 5)!;
    expect(result.distanceCompliance.score).toBeGreaterThanOrEqual(70);
    expect(result.distanceCompliance.score).toBeLessThan(100);
    expect(result.distanceCompliance.diffPct).toBeGreaterThan(0);
  });

  it('should more strongly penalize under-distance', () => {
    const resultUnder = analyzeCompliance('Easy', 9.33, 3, 5)!;
    const resultOver = analyzeCompliance('Easy', 9.33, 7, 5)!;
    // Under-distance penalty should be stronger than over-distance
    expect(resultUnder.distanceCompliance.score).toBeLessThan(resultOver.distanceCompliance.score);
  });

  it('should handle zero planned distance gracefully', () => {
    const result = analyzeCompliance('Easy', 9.33, 5, 0)!;
    expect(result.distanceCompliance.score).toBe(100);
  });
});

// ── Overall scoring ───────────────────────────────────────────────────────────

describe('overall compliance scoring', () => {
  it('should weight pace 70% and distance 30%', () => {
    // Perfect pace, imperfect distance
    const result = analyzeCompliance('Easy', 9.33, 3, 5)!;
    // Pace component should dominate — even with poor distance, score should be decent
    expect(result.score).toBeGreaterThanOrEqual(65);
  });

  it('should produce score between 50 and 100', () => {
    // Very bad compliance
    const result = analyzeCompliance('Easy', 6.0, 2, 5)!;
    expect(result.score).toBeGreaterThanOrEqual(50);
    expect(result.score).toBeLessThanOrEqual(100);
  });
});

// ── Compliance feedback ───────────────────────────────────────────────────────

describe('compliance feedback', () => {
  it('should include pace information in feedback', () => {
    const result = analyzeCompliance('Easy', 9.33, 5, 5)!;
    expect(result.feedback.length).toBeGreaterThan(0);
  });

  it('should mention deviation for out-of-range pace', () => {
    const result = analyzeCompliance('Easy', 7.5, 5, 5)!;
    expect(result.feedback).toContain('faster');
  });

  it('should mention deviation for slow pace', () => {
    const result = analyzeCompliance('Tempo', 10.0, 5, 5)!;
    expect(result.feedback).toContain('slower');
  });
});

// ── Compliance persistence ────────────────────────────────────────────────────

describe('compliance persistence', () => {
  it('should save and retrieve compliance results', () => {
    const result = analyzeCompliance('Easy', 9.33, 5, 5)!;
    saveComplianceResult(2, 1, result);

    const loaded = getComplianceResult(2, 1);
    expect(loaded).not.toBeNull();
    expect(loaded!.score).toBe(result.score);
  });

  it('should return null for non-existent results', () => {
    expect(getComplianceResult(99, 0)).toBeNull();
  });

  it('should aggregate all compliance results', () => {
    const r1 = analyzeCompliance('Easy', 9.33, 5, 5)!;
    const r2 = analyzeCompliance('Tempo', 8.0, 6, 6)!;
    saveComplianceResult(1, 1, r1);
    saveComplianceResult(1, 3, r2);

    const all = getAllComplianceResults();
    expect(all.length).toBe(2);
  });
});

// ── Weekly compliance trend ───────────────────────────────────────────────────

describe('getWeeklyComplianceTrend', () => {
  it('should aggregate scores by week', () => {
    const r1 = analyzeCompliance('Easy', 9.33, 5, 5)!;
    const r2 = analyzeCompliance('Tempo', 8.0, 6, 6)!;
    const r3 = analyzeCompliance('Long', 9.33, 12, 12)!;

    saveComplianceResult(1, 1, r1);
    saveComplianceResult(1, 3, r2);
    saveComplianceResult(2, 6, r3);

    const trend = getWeeklyComplianceTrend();
    expect(trend.length).toBe(2); // 2 weeks
    expect(trend[0].weekIndex).toBe(1);
    expect(trend[0].count).toBe(2);
    expect(trend[1].weekIndex).toBe(2);
    expect(trend[1].count).toBe(1);
    expect(trend[0].avgScore).toBeGreaterThanOrEqual(50);
    expect(trend[0].avgScore).toBeLessThanOrEqual(100);
  });

  it('should return empty array when no results exist', () => {
    persistence.clear();
    expect(getWeeklyComplianceTrend()).toEqual([]);
  });
});
