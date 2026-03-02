/**
 * Tests for aerobicDecoupling.ts — Aerobic Decoupling Monitor
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  calculateDecoupling,
  saveDecouplingResult,
  getDecouplingHistory,
  getDecouplingTrend,
  getDecouplingCoachingMessage,
} from '@/services/aerobicDecoupling';
import type { SplitHRPace } from '@/services/aerobicDecoupling';
import { persistence } from '@/services/db/persistence';

beforeEach(() => {
  persistence.clear();
});

function makeSplits(count: number, basePace: number, baseHR: number, hrDrift: number): SplitHRPace[] {
  return Array.from({ length: count }, (_, i) => ({
    mile: i + 1,
    paceSec: basePace,
    avgHR: baseHR + (hrDrift * i / count),
  }));
}

describe('calculateDecoupling', () => {
  it('should calculate decoupling for a valid long run', () => {
    const splits = makeSplits(14, 480, 140, 15);
    const result = calculateDecoupling(splits, 14, 1001, '2025-01-15');
    expect(result).not.toBeNull();
    expect(result!.decouplingPct).toBeGreaterThan(0);
    expect(result!.rating).toBeDefined();
    expect(result!.splitsUsed).toBeGreaterThan(0);
  });

  it('should return null for runs shorter than 8 miles', () => {
    const splits = makeSplits(6, 480, 140, 10);
    const result = calculateDecoupling(splits, 6, 1001, '2025-01-15');
    expect(result).toBeNull();
  });

  it('should rate excellent for minimal HR drift', () => {
    const splits = makeSplits(14, 480, 145, 3); // only 3 bpm drift
    const result = calculateDecoupling(splits, 14, 1001, '2025-01-15');
    expect(result).not.toBeNull();
    expect(result!.decouplingPct).toBeLessThan(5);
    expect(result!.rating).toBe('excellent');
  });

  it('should rate needs_work for significant HR drift', () => {
    const splits = makeSplits(14, 480, 135, 35); // 35 bpm drift
    const result = calculateDecoupling(splits, 14, 1001, '2025-01-15');
    expect(result).not.toBeNull();
    expect(result!.decouplingPct).toBeGreaterThan(10);
    expect(result!.rating).toBe('needs_work');
  });

  it('should filter out splits with very low HR', () => {
    const splits = makeSplits(12, 480, 145, 10);
    splits[5] = { mile: 6, paceSec: 480, avgHR: 60 }; // implausibly low
    const result = calculateDecoupling(splits, 12, 1001, '2025-01-15');
    // Should still work with filtered data
    expect(result).not.toBeNull();
  });

  it('should filter out anomalous pace splits', () => {
    const splits = makeSplits(12, 480, 145, 10);
    splits[6] = { mile: 7, paceSec: 800, avgHR: 110 }; // walk break
    const result = calculateDecoupling(splits, 12, 1001, '2025-01-15');
    expect(result).not.toBeNull();
  });

  it('should have HR first half lower than second half for drifting', () => {
    const splits = makeSplits(14, 480, 140, 20);
    const result = calculateDecoupling(splits, 14, 1001, '2025-01-15');
    expect(result).not.toBeNull();
    expect(result!.hrSecondHalf).toBeGreaterThan(result!.hrFirstHalf);
  });
});

describe('saveDecouplingResult & getDecouplingHistory', () => {
  it('should save and retrieve results', () => {
    const splits = makeSplits(12, 480, 145, 12);
    const result = calculateDecoupling(splits, 12, 1001, '2025-01-15')!;
    saveDecouplingResult(result);

    const history = getDecouplingHistory();
    expect(history.length).toBe(1);
    expect(history[0].activityId).toBe(1001);
  });

  it('should update existing result for same activity', () => {
    const splits = makeSplits(12, 480, 145, 12);
    const result = calculateDecoupling(splits, 12, 1001, '2025-01-15')!;
    saveDecouplingResult(result);
    saveDecouplingResult({ ...result, decouplingPct: 5.5 });

    const history = getDecouplingHistory();
    expect(history.length).toBe(1);
    expect(history[0].decouplingPct).toBe(5.5);
  });
});

describe('getDecouplingTrend', () => {
  it('should return null with insufficient data', () => {
    expect(getDecouplingTrend(4)).toBeNull();
  });

  it('should detect an improving trend', () => {
    for (let i = 0; i < 6; i++) {
      saveDecouplingResult({
        activityId: 1000 + i,
        date: `2025-01-${String(i + 1).padStart(2, '0')}`,
        distanceMi: 14,
        hrFirstHalf: 145,
        hrSecondHalf: 155 - i * 2,
        paceFirstHalf: 480,
        paceSecondHalf: 485,
        decouplingPct: 12 - i * 2, // 12, 10, 8, 6, 4, 2
        rating: 'adequate',
        splitsUsed: 14,
      });
    }
    const trend = getDecouplingTrend(4);
    expect(trend).not.toBeNull();
    expect(trend!.trend).toBe('improving');
    expect(trend!.message).toContain('dropped');
  });
});

describe('getDecouplingCoachingMessage', () => {
  it('should return encouraging message for excellent decoupling', () => {
    const result = {
      activityId: 1, date: '2025-01-15', distanceMi: 14,
      hrFirstHalf: 145, hrSecondHalf: 148,
      paceFirstHalf: 480, paceSecondHalf: 482,
      decouplingPct: 2.1, rating: 'excellent' as const, splitsUsed: 14,
    };
    const msg = getDecouplingCoachingMessage(result);
    expect(msg).toContain('excellent');
  });

  it('should suggest improvement for poor decoupling', () => {
    const result = {
      activityId: 1, date: '2025-01-15', distanceMi: 14,
      hrFirstHalf: 140, hrSecondHalf: 165,
      paceFirstHalf: 480, paceSecondHalf: 490,
      decouplingPct: 14.5, rating: 'needs_work' as const, splitsUsed: 14,
    };
    const msg = getDecouplingCoachingMessage(result);
    expect(msg).toContain('aerobic base');
  });
});
