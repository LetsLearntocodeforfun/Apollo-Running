/**
 * Tests for glycogenModel.ts — Glycogen Depletion Simulation
 */

import { describe, it, expect } from 'vitest';
import {
  simulateGlycogenDepletion,
  willGlycogenLast,
} from '@/services/glycogenModel';

describe('simulateGlycogenDepletion', () => {
  const baseAthlete = { weightKg: 70, vo2max: 50, sex: 'male' as const };

  it('should return 27 miles of data for a marathon', () => {
    const result = simulateGlycogenDepletion({
      athlete: baseAthlete,
      paceSecPerMi: 480,
      carbLoaded: false,
    });
    expect(result.miles.length).toBe(27); // Math.ceil(26.2) = 27
    expect(result.miles[0].mile).toBe(1);
    expect(result.miles[26].mile).toBe(27);
  });

  it('should start with higher glycogen when carb loaded', () => {
    const normal = simulateGlycogenDepletion({
      athlete: baseAthlete,
      paceSecPerMi: 480,
      carbLoaded: false,
    });
    const loaded = simulateGlycogenDepletion({
      athlete: baseAthlete,
      paceSecPerMi: 480,
      carbLoaded: true,
    });
    expect(loaded.startingGlycogenG).toBeGreaterThan(normal.startingGlycogenG);
    // Compare at mid-race before both hit zero floor
    expect(loaded.miles[14].glycogenRemainingG).toBeGreaterThan(
      normal.miles[14].glycogenRemainingG,
    );
  });

  it('should deplete glycogen progressively over distance', () => {
    const result = simulateGlycogenDepletion({
      athlete: baseAthlete,
      paceSecPerMi: 480,
      carbLoaded: false,
    });
    // Each mile should have less or equal glycogen than the previous
    for (let i = 1; i < result.miles.length; i++) {
      expect(result.miles[i].glycogenRemainingG).toBeLessThanOrEqual(
        result.miles[i - 1].glycogenRemainingG,
      );
    }
  });

  it('should deplete faster at a faster pace', () => {
    const fast = simulateGlycogenDepletion({
      athlete: baseAthlete,
      paceSecPerMi: 360,
      carbLoaded: false,
    });
    const slow = simulateGlycogenDepletion({
      athlete: baseAthlete,
      paceSecPerMi: 600,
      carbLoaded: false,
    });
    // Compare at mid-race before both hit zero floor
    expect(fast.miles[14].glycogenRemainingG).toBeLessThan(
      slow.miles[14].glycogenRemainingG,
    );
  });

  it('should account for in-race fueling', () => {
    const noFuel = simulateGlycogenDepletion({
      athlete: baseAthlete,
      paceSecPerMi: 480,
      carbLoaded: false,
    });
    const fueled = simulateGlycogenDepletion({
      athlete: baseAthlete,
      paceSecPerMi: 480,
      carbLoaded: false,
      fuelingItems: [
        { mile: 5, raceTimeMin: 40, item: 'gel', carbsG: 25, notes: '' },
        { mile: 10, raceTimeMin: 80, item: 'gel', carbsG: 25, notes: '' },
        { mile: 15, raceTimeMin: 120, item: 'gel', carbsG: 25, notes: '' },
        { mile: 20, raceTimeMin: 160, item: 'gel', carbsG: 25, notes: '' },
      ],
    });
    // Compare at mid-race before both may hit zero floor
    expect(fueled.miles[19].glycogenRemainingG).toBeGreaterThan(
      noFuel.miles[19].glycogenRemainingG,
    );
  });

  it('should detect bonk risk when glycogen runs critically low', () => {
    const result = simulateGlycogenDepletion({
      athlete: baseAthlete,
      paceSecPerMi: 360,
      carbLoaded: false,
    });
    // Fast pace with no fueling should hit critical at some point
    expect(result.depletionMile).not.toBeNull();
    expect(result.depletionMile).toBeGreaterThan(0);
  });

  it('should return reasonable per-mile calorie usage', () => {
    const result = simulateGlycogenDepletion({
      athlete: baseAthlete,
      paceSecPerMi: 480,
      carbLoaded: false,
    });
    // 70kg runner: ~70 * 1.609 ≈ 113 kcal/mi (last mile is partial 0.2mi)
    for (let i = 0; i < result.miles.length - 1; i++) {
      expect(result.miles[i].calsBurnedThisMile).toBeGreaterThan(50);
      expect(result.miles[i].calsBurnedThisMile).toBeLessThan(200);
    }
    // Last mile is partial (0.2 mi) so it burns less
    const lastMile = result.miles[result.miles.length - 1];
    expect(lastMile.calsBurnedThisMile).toBeGreaterThan(0);
    expect(lastMile.calsBurnedThisMile).toBeLessThan(50);
  });
});

describe('willGlycogenLast', () => {
  const athlete = { weightKg: 70, vo2max: 50, sex: 'male' as const };

  it('should return lasts=true for slow pace with carb loading', () => {
    const result = willGlycogenLast(athlete, 600, true);
    expect(result.lasts).toBe(true);
  });

  it('should return lasts=false for very fast pace without loading', () => {
    const result = willGlycogenLast(athlete, 300, false);
    expect(result.lasts).toBe(false);
  });
});
