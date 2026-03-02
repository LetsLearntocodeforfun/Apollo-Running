/**
 * Tests for taperOptimizer.ts — Taper Optimization Model
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  calculateFitnessFatigue,
  getCurrentFitness,
  generateTaperPlan,
  estimateTSS,
  saveTrainingLoad,
  getTrainingLoadHistory,
} from '@/services/taperOptimizer';
import type { DailyTrainingLoad } from '@/services/taperOptimizer';
import { persistence } from '@/services/db/persistence';

beforeEach(() => {
  persistence.clear();
});

function generateTrainingHistory(days: number, avgTSS: number = 50): DailyTrainingLoad[] {
  const history: DailyTrainingLoad[] = [];
  const start = new Date('2025-01-01');
  for (let i = 0; i < days; i++) {
    const date = new Date(start);
    date.setDate(date.getDate() + i);
    const dayOfWeek = date.getDay();
    const isRest = dayOfWeek === 0; // Sunday rest
    const isLongRun = dayOfWeek === 6; // Saturday long run

    history.push({
      date: date.toISOString().slice(0, 10),
      tss: isRest ? 0 : isLongRun ? avgTSS * 2 : avgTSS,
      distanceMi: isRest ? 0 : isLongRun ? 18 : 6,
      type: isRest ? 'rest' : isLongRun ? 'long_run' : 'easy',
    });
  }
  return history;
}

describe('calculateFitnessFatigue', () => {
  it('should return empty for empty history', () => {
    expect(calculateFitnessFatigue([]).length).toBe(0);
  });

  it('should calculate CTL, ATL, TSB for each day', () => {
    const history = generateTrainingHistory(30);
    const snapshots = calculateFitnessFatigue(history);
    expect(snapshots.length).toBe(30);

    for (const s of snapshots) {
      expect(s.date).toBeTruthy();
      expect(typeof s.ctl).toBe('number');
      expect(typeof s.atl).toBe('number');
      expect(s.tsb).toBeCloseTo(s.ctl - s.atl, 0);
    }
  });

  it('should have increasing CTL over consistent training', () => {
    const history = generateTrainingHistory(60);
    const snapshots = calculateFitnessFatigue(history);
    // CTL should be higher at day 60 vs day 10
    expect(snapshots[59].ctl).toBeGreaterThan(snapshots[9].ctl);
  });

  it('should have TSB = CTL - ATL', () => {
    const history = generateTrainingHistory(30);
    const snapshots = calculateFitnessFatigue(history);
    for (const s of snapshots) {
      expect(s.tsb).toBeCloseTo(s.ctl - s.atl, 0);
    }
  });

  it('should handle rest days (TSS = 0)', () => {
    const history = generateTrainingHistory(14);
    const snapshots = calculateFitnessFatigue(history);
    expect(snapshots.length).toBe(14);
    // All values should be finite
    for (const s of snapshots) {
      expect(isFinite(s.ctl)).toBe(true);
      expect(isFinite(s.atl)).toBe(true);
    }
  });
});

describe('getCurrentFitness', () => {
  it('should return the latest snapshot', () => {
    const history = generateTrainingHistory(30);
    const current = getCurrentFitness(history);
    expect(current).not.toBeNull();
    expect(current!.date).toBe(history[history.length - 1].date);
  });

  it('should return null for empty history', () => {
    expect(getCurrentFitness([])).toBeNull();
  });
});

describe('generateTaperPlan', () => {
  it('should generate a taper recommendation', () => {
    const history = generateTrainingHistory(60);
    const taper = generateTaperPlan(history, '2025-04-15');
    expect(taper.taperStartDays).toBeGreaterThanOrEqual(10);
    expect(taper.taperLengthDays).toBeGreaterThanOrEqual(10);
    expect(taper.weeklyReductions.length).toBeGreaterThanOrEqual(2);
    expect(taper.intensitySessions.length).toBeGreaterThan(0);
    expect(taper.summary).toBeTruthy();
  });

  it('should have decreasing volume percentages', () => {
    const history = generateTrainingHistory(60);
    const taper = generateTaperPlan(history, '2025-04-15');
    for (let i = 1; i < taper.weeklyReductions.length; i++) {
      expect(taper.weeklyReductions[i].volumePct).toBeLessThanOrEqual(
        taper.weeklyReductions[i - 1].volumePct,
      );
    }
  });

  it('should project positive TSB on race day', () => {
    const history = generateTrainingHistory(60);
    const taper = generateTaperPlan(history, '2025-04-15');
    expect(taper.projectedRaceDayTSB).toBeGreaterThan(0);
  });

  it('should include current CTL and TSB', () => {
    const history = generateTrainingHistory(60);
    const taper = generateTaperPlan(history, '2025-04-15');
    expect(taper.currentCTL).toBeGreaterThan(0);
    expect(typeof taper.currentTSB).toBe('number');
  });

  it('should recommend longer taper for higher fitness', () => {
    const moderate = generateTrainingHistory(60, 40);
    const high = generateTrainingHistory(90, 80);
    const taperMod = generateTaperPlan(moderate, '2025-04-15');
    const taperHigh = generateTaperPlan(high, '2025-04-15');
    expect(taperHigh.taperLengthDays).toBeGreaterThanOrEqual(taperMod.taperLengthDays);
  });
});

describe('estimateTSS', () => {
  it('should return 0 for rest days', () => {
    expect(estimateTSS(0, 0, 'rest')).toBe(0);
  });

  it('should return higher TSS for harder efforts', () => {
    const easy = estimateTSS(6, 54, 'easy');
    const tempo = estimateTSS(6, 48, 'tempo');
    const interval = estimateTSS(6, 42, 'interval');
    expect(tempo).toBeGreaterThan(easy);
    expect(interval).toBeGreaterThan(tempo);
  });

  it('should scale with distance', () => {
    const short = estimateTSS(4, 36, 'easy');
    const long = estimateTSS(10, 90, 'easy');
    expect(long).toBeGreaterThan(short);
  });
});

describe('saveTrainingLoad & getTrainingLoadHistory', () => {
  it('should save and retrieve training loads', () => {
    saveTrainingLoad({ date: '2025-01-15', tss: 50, distanceMi: 6, type: 'easy' });
    saveTrainingLoad({ date: '2025-01-16', tss: 80, distanceMi: 10, type: 'tempo' });

    const history = getTrainingLoadHistory();
    expect(history.length).toBe(2);
  });

  it('should update existing entry for same date', () => {
    saveTrainingLoad({ date: '2025-01-15', tss: 50, distanceMi: 6, type: 'easy' });
    saveTrainingLoad({ date: '2025-01-15', tss: 70, distanceMi: 8, type: 'tempo' });

    const history = getTrainingLoadHistory();
    expect(history.length).toBe(1);
    expect(history[0].tss).toBe(70);
  });
});
