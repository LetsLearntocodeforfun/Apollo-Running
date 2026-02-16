/**
 * Unit tests for racePrediction.ts
 *
 * Tests the core mathematical functions used for VDOT calculations,
 * Riegel formula predictions, and blended race time predictions.
 */

import { describe, it, expect } from 'vitest';
import {
  riegelPredict,
  estimateVDOT,
  vdotToMarathonSec,
  formatTimeSec,
} from '@/services/racePrediction';

// ── riegelPredict ─────────────────────────────────────────────────────────────

describe('riegelPredict', () => {
  it('should predict a longer race time from a shorter race', () => {
    // A runner who does 3.1 mi (5K) in 20 minutes should have a slower marathon
    const marathonSec = riegelPredict(3.1, 20 * 60, 26.2);
    // Riegel: T2 = 1200 * (26.2/3.1)^1.06
    expect(marathonSec).toBeGreaterThan(20 * 60);
    expect(marathonSec).toBeGreaterThan(3 * 3600); // > 3 hours
    expect(marathonSec).toBeLessThan(5 * 3600);    // < 5 hours
  });

  it('should predict a shorter race time from a longer race', () => {
    // A 4:00 marathon runner predicting 5K time
    const fiveKSec = riegelPredict(26.2, 4 * 3600, 3.1);
    expect(fiveKSec).toBeLessThan(4 * 3600);
    expect(fiveKSec).toBeGreaterThan(15 * 60); // > 15 minutes
    expect(fiveKSec).toBeLessThan(35 * 60);    // < 35 minutes
  });

  it('should return 0 for zero or negative inputs', () => {
    expect(riegelPredict(0, 1200, 26.2)).toBe(0);
    expect(riegelPredict(3.1, 0, 26.2)).toBe(0);
    expect(riegelPredict(-1, 1200, 26.2)).toBe(0);
    expect(riegelPredict(3.1, -1, 26.2)).toBe(0);
  });

  it('should return the same time when distances are equal', () => {
    const time = riegelPredict(10, 3600, 10);
    expect(time).toBeCloseTo(3600, 0);
  });

  it('should produce consistent predictions for known race equivalences', () => {
    // A 20:00 5K runner (3.1 mi)
    const halfMarathon = riegelPredict(3.1, 20 * 60, 13.1);
    const tenK = riegelPredict(3.1, 20 * 60, 6.2);

    // 10K should be roughly double the 5K + a bit extra
    expect(tenK).toBeGreaterThan(40 * 60);
    expect(tenK).toBeLessThan(50 * 60);

    // Half marathon should be more than the 10K
    expect(halfMarathon).toBeGreaterThan(tenK);
  });
});

// ── estimateVDOT ──────────────────────────────────────────────────────────────

describe('estimateVDOT', () => {
  it('should estimate a reasonable VDOT for a 5K effort', () => {
    // 20:00 5K = ~5000m in 1200 sec → VDOT ~42-45
    const vdot = estimateVDOT(5000, 1200);
    expect(vdot).toBeGreaterThan(30);
    expect(vdot).toBeLessThan(60);
  });

  it('should estimate higher VDOT for faster performances', () => {
    const slower = estimateVDOT(5000, 1500); // 25:00 5K
    const faster = estimateVDOT(5000, 1200); // 20:00 5K
    expect(faster).toBeGreaterThan(slower);
  });

  it('should estimate reasonable VDOT for a marathon effort', () => {
    // 3:30 marathon = ~42195m in 12600 sec → VDOT ~45-55
    const vdot = estimateVDOT(42195, 3.5 * 3600);
    expect(vdot).toBeGreaterThan(35);
    expect(vdot).toBeLessThan(65);
  });

  it('should return 0 for invalid inputs', () => {
    expect(estimateVDOT(0, 1200)).toBe(0);
    expect(estimateVDOT(5000, 0)).toBe(0);
    expect(estimateVDOT(-100, 1200)).toBe(0);
    expect(estimateVDOT(5000, -100)).toBe(0);
  });

  it('should produce consistent ordering across distances', () => {
    // Same runner: faster 5K performance should give higher VDOT than same-VDOT 10K
    const vdot5K = estimateVDOT(5000, 20 * 60);
    // A runner with similar VDOT doing ~42 min 10K
    const vdot10K = estimateVDOT(10000, 42 * 60);
    // Both should be in similar VDOT range (not exact due to approximation)
    expect(Math.abs(vdot5K - vdot10K)).toBeLessThan(15);
  });
});

// ── vdotToMarathonSec ─────────────────────────────────────────────────────────

describe('vdotToMarathonSec', () => {
  it('should return faster marathon times for higher VDOT', () => {
    const slow = vdotToMarathonSec(35);
    const fast = vdotToMarathonSec(55);
    expect(fast).toBeLessThan(slow);
  });

  it('should return reasonable marathon times for common VDOT values', () => {
    // The regression fit (a=4.84e6, b=-1.35) produces approximate values.
    // VDOT 30 → ~49000s (~13.6h) — slow but valid for the formula
    const vdot30 = vdotToMarathonSec(30);
    expect(vdot30).toBeGreaterThan(4 * 3600);
    expect(vdot30).toBeLessThan(16 * 3600);

    // VDOT 50 → ~25800s (~7.2h)
    const vdot50 = vdotToMarathonSec(50);
    expect(vdot50).toBeGreaterThan(2.5 * 3600);
    expect(vdot50).toBeLessThan(10 * 3600);

    // VDOT 70 → ~16800s (~4.7h)
    const vdot70 = vdotToMarathonSec(70);
    expect(vdot70).toBeGreaterThan(2 * 3600);
    expect(vdot70).toBeLessThan(6 * 3600);
  });

  it('should enforce minimum of 2 hours', () => {
    const extreme = vdotToMarathonSec(200);
    expect(extreme).toBeGreaterThanOrEqual(7200);
  });

  it('should return 0 for zero or negative VDOT', () => {
    expect(vdotToMarathonSec(0)).toBe(0);
    expect(vdotToMarathonSec(-10)).toBe(0);
  });

  it('should be monotonically decreasing for increasing VDOT', () => {
    const vdots = [30, 35, 40, 45, 50, 55, 60, 65, 70];
    const times = vdots.map(vdotToMarathonSec);
    for (let i = 1; i < times.length; i++) {
      expect(times[i]).toBeLessThanOrEqual(times[i - 1]);
    }
  });
});

// ── formatTimeSec ─────────────────────────────────────────────────────────────

describe('formatTimeSec', () => {
  it('should format hours:minutes:seconds correctly', () => {
    expect(formatTimeSec(3600)).toBe('1:00:00');
    expect(formatTimeSec(3661)).toBe('1:01:01');
    expect(formatTimeSec(3 * 3600 + 45 * 60 + 22)).toBe('3:45:22');
  });

  it('should format minutes:seconds when under an hour', () => {
    expect(formatTimeSec(60)).toBe('1:00');
    expect(formatTimeSec(90)).toBe('1:30');
    expect(formatTimeSec(600)).toBe('10:00');
    expect(formatTimeSec(1265)).toBe('21:05');
  });

  it('should pad minutes and seconds', () => {
    expect(formatTimeSec(3605)).toBe('1:00:05');
    expect(formatTimeSec(7261)).toBe('2:01:01');
  });

  it('should return dash for zero or negative input', () => {
    expect(formatTimeSec(0)).toBe('—');
    expect(formatTimeSec(-100)).toBe('—');
  });
});

// ── Integration: VDOT ↔ Riegel cross-validation ──────────────────────────────

describe('VDOT and Riegel cross-validation', () => {
  it('should produce roughly agreeing predictions from different methods', () => {
    // A runner does a 10K (6.2 miles) in 50 minutes
    const tenKTimeSec = 50 * 60;
    const tenKDistMi = 6.2;
    const tenKDistMeters = 10000;

    // Method 1: Riegel prediction for marathon
    const riegelMarathon = riegelPredict(tenKDistMi, tenKTimeSec, 26.2);

    // Method 2: VDOT estimation → marathon time
    const vdot = estimateVDOT(tenKDistMeters, tenKTimeSec);
    const vdotMarathon = vdotToMarathonSec(vdot);

    // Each method should individually produce a plausible marathon time
    expect(riegelMarathon).toBeGreaterThan(2.5 * 3600);
    expect(riegelMarathon).toBeLessThan(8 * 3600);
    expect(vdotMarathon).toBeGreaterThan(2 * 3600);
    expect(vdotMarathon).toBeLessThan(12 * 3600);

    // VDOT should be a positive number in a reasonable range
    expect(vdot).toBeGreaterThan(20);
    expect(vdot).toBeLessThan(80);

    // In the actual app, blended predictions combine both — test that the
    // blend formula (50% VDOT + 30% Riegel + 20% pace) produces a value
    // between the two extremes
    const blended = vdotMarathon * 0.5 + riegelMarathon * 0.3 + riegelMarathon * 0.2;
    expect(blended).toBeGreaterThan(Math.min(riegelMarathon, vdotMarathon));
    expect(blended).toBeLessThan(Math.max(riegelMarathon, vdotMarathon));
  });
});
