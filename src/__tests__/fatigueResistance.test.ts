/**
 * Tests for fatigueResistance.ts — Fatigue Resistance Index (FRI)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  calculateFRI,
  saveFRIResult,
  getFRIHistory,
  getFRITrend,
} from '@/services/fatigueResistance';
import { persistence } from '@/services/db/persistence';

beforeEach(() => {
  persistence.clear();
});

describe('calculateFRI', () => {
  it('should calculate FRI for a valid long run', () => {
    // 20-mile run with slight positive split (plain sec/mi values)
    const splits = Array.from({ length: 20 }, (_, i) => 480 + i * 2);
    const result = calculateFRI(splits, 20, '1001', '2025-01-15');
    expect(result).not.toBeNull();
    expect(result!.fri).toBeGreaterThan(95);
    expect(result!.fri).toBeLessThan(115);
    expect(result!.rating).toBeDefined();
  });

  it('should return null for runs under 16 miles', () => {
    const splits = Array.from({ length: 10 }, () => 480);
    const result = calculateFRI(splits, 10, '1001', '2025-01-15');
    expect(result).toBeNull();
  });

  it('should rate excellent FRI when back half is faster', () => {
    // Negative split
    const splits = Array.from({ length: 20 }, (_, i) => 500 - i * 2);
    const result = calculateFRI(splits, 20, '1001', '2025-01-15');
    expect(result).not.toBeNull();
    expect(result!.fri).toBeLessThanOrEqual(100);
    expect(result!.rating).toBe('excellent');
  });

  it('should rate severe_fade for major positive split', () => {
    // Big slowdown
    const splits = Array.from({ length: 20 }, (_, i) => 400 + i * 15);
    const result = calculateFRI(splits, 20, '1001', '2025-01-15');
    expect(result).not.toBeNull();
    expect(result!.fri).toBeGreaterThan(110);
    expect(result!.rating).toBe('severe_fade');
  });

  it('should filter anomalous splits', () => {
    const splits = Array.from({ length: 18 }, () => 480);
    // Add a walk break
    splits[10] = 900;
    const result = calculateFRI(splits, 18, '1001', '2025-01-15');
    // Should still work (filters outlier)
    expect(result).not.toBeNull();
  });
});

describe('saveFRIResult & getFRIHistory', () => {
  it('should save and retrieve FRI results', () => {
    const splits = Array.from({ length: 18 }, (_, i) => 480 + i);
    const result = calculateFRI(splits, 18, '1001', '2025-01-15');
    expect(result).not.toBeNull();
    saveFRIResult(result!);

    const history = getFRIHistory();
    expect(history.length).toBe(1);
    expect(history[0].activityId).toBe('1001');
  });

  it('should not duplicate results for the same activity', () => {
    const splits = Array.from({ length: 18 }, () => 480);
    const result = calculateFRI(splits, 18, '1001', '2025-01-15')!;
    saveFRIResult(result);
    saveFRIResult(result);

    const history = getFRIHistory();
    expect(history.length).toBe(1);
  });
});

describe('getFRITrend', () => {
  it('should return stable with empty summary when no data', () => {
    const trend = getFRITrend(4);
    expect(trend.trendDirection).toBe('stable');
    expect(trend.results.length).toBe(0);
  });

  it('should detect improving trend', () => {
    // Save multiple results with improving FRI
    for (let i = 0; i < 6; i++) {
      const fri = 110 - i * 3; // 110, 107, 104, 101, 98, 95
      const result = {
        activityId: String(1000 + i),
        date: `2025-01-${String(i + 1).padStart(2, '0')}`,
        distanceMi: 20,
        fri,
        rating: 'good' as const,
        firstSegmentPaceSec: 480,
        lastSegmentPaceSec: Math.round(480 * fri / 100),
        fadeRateSecPerMi: 1.5,
        message: 'test',
      };
      saveFRIResult(result);
    }

    const trend = getFRITrend(4);
    expect(trend).toBeDefined();
    expect(trend.trendDirection).toBe('improving');
  });
});
