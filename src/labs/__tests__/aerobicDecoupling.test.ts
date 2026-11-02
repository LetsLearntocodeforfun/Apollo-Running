/**
 * Tests for aerobicDecoupling.ts — Aerobic Decoupling & Efficiency Factor Monitor
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  calculateDecoupling,
  saveDecouplingResult,
  getDecouplingHistory,
  getDecouplingTrend,
  getDecouplingCoachingMessage,
} from '@/labs/aerobicDecoupling';
import type { DecouplingResult, SplitHRPace } from '@/labs/aerobicDecoupling';
import { persistence } from '@/services/db/persistence';

beforeEach(() => {
  persistence.clear();
});

function makeSplits(count: number, basePace: number, baseHR: number, hrDrift: number): SplitHRPace[] {
  return Array.from({ length: count }, (_, i) => ({
    mile: i + 1,
    paceSec: basePace,
    avgHR: baseHR + (hrDrift * i) / count,
  }));
}

function makeFixtureResult(overrides: Partial<DecouplingResult> = {}): DecouplingResult {
  return {
    activityId: 1,
    date: '2025-01-15',
    distanceMi: 14,
    durationSec: 14 * 480,
    hrFirstHalf: 145,
    hrSecondHalf: 148,
    paceFirstHalf: 480,
    paceSecondHalf: 482,
    efFirstHalf: 1.387,
    efSecondHalf: 1.354,
    efOverall: 1.37,
    efUnit: 'm/min/bpm',
    decouplingPct: 2.38,
    rating: 'excellent',
    isCoupled: true,
    isSteadyState: true,
    paceCV: 0.01,
    droppedTrailingPartial: false,
    splitsUsed: 14,
    ...overrides,
  };
}

describe('calculateDecoupling', () => {
  it('should calculate decoupling for a valid long run', () => {
    const splits = makeSplits(14, 480, 140, 15);
    const result = calculateDecoupling(splits, 14, 1001, '2025-01-15');
    expect(result).not.toBeNull();
    expect(result!.decouplingPct).toBeGreaterThan(0);
    expect(result!.efFirstHalf).toBeGreaterThan(result!.efSecondHalf);
    expect(result!.efUnit).toBe('m/min/bpm');
    expect(result!.rating).toBeDefined();
    expect(result!.splitsUsed).toBeGreaterThan(0);
  });

  it('should return null for runs shorter than 8 miles by default', () => {
    const splits = makeSplits(6, 480, 140, 10);
    const result = calculateDecoupling(splits, 6, 1001, '2025-01-15');
    expect(result).toBeNull();
  });

  it('should rate excellent for minimal HR drift (<= 3.5%)', () => {
    const splits = makeSplits(14, 480, 145, 3); // only 3 bpm drift
    const result = calculateDecoupling(splits, 14, 1001, '2025-01-15');
    expect(result).not.toBeNull();
    expect(result!.decouplingPct).toBeLessThanOrEqual(3.5);
    expect(result!.rating).toBe('excellent');
    expect(result!.isCoupled).toBe(true);
  });

  it('should rate high for significant HR drift (> 8%)', () => {
    const splits = makeSplits(14, 480, 135, 35); // 35 bpm drift
    const result = calculateDecoupling(splits, 14, 1001, '2025-01-15');
    expect(result).not.toBeNull();
    expect(result!.decouplingPct).toBeGreaterThan(8);
    expect(result!.rating).toBe('high');
    expect(result!.isCoupled).toBe(false);
  });

  it('should rate high (positive Pa:HR) when runner fades in pace as HR rises (A-02 fix)', () => {
    // Halves split at half the moving time: +13.24% (the old half-distance split gave +13.63%).
    const splits: SplitHRPace[] = [
      ...Array.from({ length: 7 }, (_, i) => ({ mile: i + 1, paceSec: 480, avgHR: 145 })),
      ...Array.from({ length: 7 }, (_, i) => ({ mile: i + 8, paceSec: 510, avgHR: 158 })),
    ];
    const result = calculateDecoupling(splits, 14, 1002, '2025-01-16');
    expect(result).not.toBeNull();
    expect(result!.decouplingPct).toBeCloseTo(13.24, 1);
    expect(result!.rating).toBe('high');
  });

  it('should filter out splits with very low HR', () => {
    const splits = makeSplits(12, 480, 145, 10);
    splits[5] = { mile: 6, paceSec: 480, avgHR: 60 }; // implausibly low
    const result = calculateDecoupling(splits, 12, 1001, '2025-01-15');
    expect(result).not.toBeNull();
    expect(result!.splitsUsed).toBe(11);
  });

  it('should filter out an isolated anomalous pace split (stop / walk break)', () => {
    const splits = makeSplits(12, 480, 145, 10);
    splits[6] = { mile: 7, paceSec: 800, avgHR: 110 }; // isolated walk break
    const result = calculateDecoupling(splits, 12, 1001, '2025-01-15');
    expect(result).not.toBeNull();
    expect(result!.splitsUsed).toBe(11);
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
      saveDecouplingResult(
        makeFixtureResult({
          activityId: 1000 + i,
          date: `2025-01-${String(i + 1).padStart(2, '0')}`,
          hrSecondHalf: 155 - i * 2,
          paceSecondHalf: 485,
          decouplingPct: 12 - i * 2, // 12, 10, 8, 6, 4, 2
          rating: 'moderate',
        }),
      );
    }
    const trend = getDecouplingTrend(4);
    expect(trend).not.toBeNull();
    expect(trend!.trend).toBe('improving');
    expect(trend!.message).toContain('dropped');
  });
});

describe('getDecouplingCoachingMessage', () => {
  it('should return encouraging message for excellent decoupling', () => {
    const result = makeFixtureResult({
      decouplingPct: 2.1,
      rating: 'excellent',
    });
    const msg = getDecouplingCoachingMessage(result);
    expect(msg).toContain('excellent');
    expect(msg).toContain('m/min/bpm');
  });

  it('should suggest improvement for high decoupling', () => {
    const result = makeFixtureResult({
      hrFirstHalf: 140,
      hrSecondHalf: 165,
      paceFirstHalf: 480,
      paceSecondHalf: 510,
      efFirstHalf: 1.437,
      efSecondHalf: 1.147,
      efOverall: 1.292,
      decouplingPct: 20.18,
      rating: 'high',
      isCoupled: false,
    });
    const msg = getDecouplingCoachingMessage(result);
    expect(msg).toContain('aerobic base');
  });
});
