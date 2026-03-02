/**
 * Tests for pacingDecay.ts — Pacing Decay Curve Model
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  fitDecayModel,
  predictRacePacing,
  compareDecayToIdeal,
  saveDecayModel,
  getSavedDecayModel,
} from '@/services/pacingDecay';
import { persistence } from '@/services/db/persistence';

beforeEach(() => {
  persistence.clear();
});

describe('fitDecayModel', () => {
  it('should fit a decay model from long run data', () => {
    // Need at least 3 qualified long runs with 16+ splits (plain number arrays)
    const longRuns = [
      {
        date: '2025-01-01',
        splits: Array.from({ length: 18 }, (_, i) => 480 + i * 2),
      },
      {
        date: '2025-01-08',
        splits: Array.from({ length: 20 }, (_, i) => 475 + i * 3),
      },
      {
        date: '2025-01-15',
        splits: Array.from({ length: 18 }, (_, i) => 485 + i * 2),
      },
    ];
    const model = fitDecayModel(longRuns);
    expect(model).not.toBeNull();
    expect(model!.decayRatePerMi).toBeGreaterThan(0);
    expect(model!.basePaceSec).toBeGreaterThan(0);
    expect(model!.sampleSize).toBe(3);
  });

  it('should return null with insufficient data', () => {
    const model = fitDecayModel([]);
    expect(model).toBeNull();
  });

  it('should detect steeper decay with faster deterioration', () => {
    const mild = [
      { date: '2025-01-01', splits: Array.from({ length: 18 }, (_, i) => 480 + i * 1) },
      { date: '2025-01-08', splits: Array.from({ length: 18 }, (_, i) => 480 + i * 1) },
      { date: '2025-01-15', splits: Array.from({ length: 18 }, (_, i) => 480 + i * 1) },
    ];
    const steep = [
      { date: '2025-01-01', splits: Array.from({ length: 18 }, (_, i) => 480 + i * 5) },
      { date: '2025-01-08', splits: Array.from({ length: 18 }, (_, i) => 480 + i * 5) },
      { date: '2025-01-15', splits: Array.from({ length: 18 }, (_, i) => 480 + i * 5) },
    ];
    const mildModel = fitDecayModel(mild)!;
    const steepModel = fitDecayModel(steep)!;
    expect(steepModel.decayRatePerMi).toBeGreaterThan(mildModel.decayRatePerMi);
  });
});

describe('predictRacePacing', () => {
  it('should predict pace for each mile of a marathon', () => {
    const model = {
      decayRatePerMi: 0.005,
      basePaceSec: 480,
      decayStartMile: 8,
      rSquared: 0.85,
      sampleSize: 3,
      dateRange: { from: '2025-01-01', to: '2025-01-15' },
      updatedAt: new Date().toISOString(),
    };
    const pacing = predictRacePacing(model, 480, 26);
    expect(pacing.length).toBe(26);
    // First miles should be near target pace
    expect(pacing[0].paceSec).toBeCloseTo(480, 0);
    // Later miles should be slower
    expect(pacing[25].paceSec).toBeGreaterThan(480);
  });

  it('should have stable pacing in early miles', () => {
    const model = {
      decayRatePerMi: 0.008,
      basePaceSec: 480,
      decayStartMile: 8,
      rSquared: 0.85,
      sampleSize: 3,
      dateRange: { from: '2025-01-01', to: '2025-01-15' },
      updatedAt: new Date().toISOString(),
    };
    const pacing = predictRacePacing(model, 480, 26);
    // Miles 1-8 should be very close to target
    for (let i = 0; i < 8; i++) {
      expect(Math.abs(pacing[i].paceSec - 480)).toBeLessThan(10);
    }
  });
});

describe('compareDecayToIdeal', () => {
  it('should compare personal decay to ideal for target time', () => {
    const model = {
      decayRatePerMi: 0.008,
      basePaceSec: 480,
      decayStartMile: 8,
      rSquared: 0.85,
      sampleSize: 3,
      dateRange: { from: '2025-01-01', to: '2025-01-15' },
      updatedAt: new Date().toISOString(),
    };
    const comparison = compareDecayToIdeal(model, 3.5 * 3600);
    expect(comparison).toBeDefined();
    expect(comparison.idealDecayPct).toBeGreaterThan(0);
    expect(comparison.message).toBeTruthy();
  });
});

describe('saveDecayModel & getSavedDecayModel', () => {
  it('should persist and retrieve a decay model', () => {
    const model = {
      decayRatePerMi: 0.006,
      basePaceSec: 490,
      decayStartMile: 8,
      rSquared: 0.85,
      sampleSize: 4,
      dateRange: { from: '2025-01-01', to: '2025-01-22' },
      updatedAt: new Date().toISOString(),
    };
    saveDecayModel(model);
    const saved = getSavedDecayModel();
    expect(saved).not.toBeNull();
    expect(saved!.decayRatePerMi).toBe(0.006);
    expect(saved!.basePaceSec).toBe(490);
  });
});
