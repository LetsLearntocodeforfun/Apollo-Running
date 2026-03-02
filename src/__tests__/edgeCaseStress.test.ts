/**
 * Edge Case & Stress Tests — Phase 4 Services
 *
 * Tests extreme inputs, boundary conditions, and adversarial data
 * to ensure all Phase 4 services degrade gracefully and never crash.
 */

import { describe, it, expect } from 'vitest';
import { simulateGlycogenDepletion, willGlycogenLast } from '@/services/glycogenModel';
import { calculateSweatRate, assessDehydrationRisk } from '@/services/hydrationCalculator';
import { getDailyCarbTarget, getRaceMorningCarbTarget } from '@/services/carbLoading';
import { generateFuelingPlan, getGelSchedule } from '@/services/fuelingCalculator';
import { simulateWhatIf, type WhatIfScenario } from '@/services/whatIfSimulator';
import { calculateFRI } from '@/services/fatigueResistance';
import { fitDecayModel, predictRacePacing, compareDecayToIdeal } from '@/services/pacingDecay';
import { normalizeToIdeal, normalizeMarathonTime } from '@/services/raceEquivalence';
import { calculateDecoupling } from '@/services/aerobicDecoupling';
import { compareRuns, buildGhostRun } from '@/services/ghostRunner';
import { generateRaceDayTimeline } from '@/services/raceDayTimeline';
import { calculateFitnessFatigue, estimateTSS, generateTaperPlan } from '@/services/taperOptimizer';
import { assessBonkRisk } from '@/services/bonkRisk';

// ── Glycogen Model Edge Cases ─────────────────────────────────────────────────

describe('Glycogen Model — Edge Cases', () => {
  it('handles ultra-light runner (40kg)', () => {
    const sim = simulateGlycogenDepletion({
      athlete: { weightKg: 40, sex: 'female', vo2max: 45 },
      paceSecPerMi: 540,
    });
    expect(sim.miles.length).toBe(27);
    expect(sim.totalCalsBurned).toBeGreaterThan(0);
    for (const m of sim.miles) {
      expect(m.glycogenRemainingG).toBeGreaterThanOrEqual(0);
      expect(isFinite(m.glycogenRemainingG)).toBe(true);
    }
  });

  it('handles very heavy runner (150kg)', () => {
    const sim = simulateGlycogenDepletion({
      athlete: { weightKg: 150, sex: 'male', vo2max: 35 },
      paceSecPerMi: 720,
    });
    expect(sim.totalCalsBurned).toBeGreaterThan(4000);
    expect(sim.depletionMile).not.toBeNull(); // should bonk
  });

  it('handles elite 4:30/mi pace', () => {
    const sim = simulateGlycogenDepletion({
      athlete: { weightKg: 55, sex: 'male', vo2max: 85 },
      paceSecPerMi: 270,
    });
    expect(sim.miles.length).toBe(27);
    for (const m of sim.miles) {
      expect(isFinite(m.calsBurnedThisMile)).toBe(true);
    }
  });

  it('handles very slow walker pace (20:00/mi)', () => {
    const sim = simulateGlycogenDepletion({
      athlete: { weightKg: 70, sex: 'male' },
      paceSecPerMi: 1200,
    });
    expect(sim.miles.length).toBe(27);
    // At walking pace, mostly fat burning, glycogen should last longer
    if (sim.depletionMile) {
      expect(sim.depletionMile).toBeGreaterThanOrEqual(14);
    }
  });

  it('handles custom short distance (5 miles)', () => {
    const sim = simulateGlycogenDepletion({
      athlete: { weightKg: 70, sex: 'male', vo2max: 50 },
      paceSecPerMi: 480,
      distanceMi: 5,
    });
    expect(sim.miles.length).toBe(5);
    expect(sim.depletionMile).toBeNull(); // 5 miles won't deplete
  });

  it('handles ultra distance (50 miles)', () => {
    const sim = simulateGlycogenDepletion({
      athlete: { weightKg: 70, sex: 'male', vo2max: 50 },
      paceSecPerMi: 600,
      distanceMi: 50,
    });
    expect(sim.miles.length).toBe(50);
    expect(sim.depletionMile).not.toBeNull();
  });

  it('handles excessive fueling (100g/hr)', () => {
    const manyGels = Array.from({ length: 20 }, (_, i) => ({
      mile: i + 3,
      name: 'Mega Gel',
      carbsG: 50,
    }));
    const sim = simulateGlycogenDepletion({
      athlete: { weightKg: 70, sex: 'male', vo2max: 50 },
      paceSecPerMi: 480,
      carbLoaded: true,
      fuelingItems: manyGels,
    });
    // With 1000g of carbs consumed, glycogen should never deplete
    expect(sim.depletionMileWithFueling).toBeNull();
  });

  it('handles zero VO2max (should use fallback)', () => {
    const sim = simulateGlycogenDepletion({
      athlete: { weightKg: 70, sex: 'male', vo2max: 0 },
      paceSecPerMi: 480,
    });
    expect(sim.miles.length).toBe(27);
    expect(sim.totalCalsBurned).toBeGreaterThan(0);
  });

  it('handles no VO2max provided', () => {
    const sim = simulateGlycogenDepletion({
      athlete: { weightKg: 70, sex: 'male' },
      paceSecPerMi: 480,
    });
    expect(sim.miles.length).toBe(27);
    for (const m of sim.miles) {
      expect(isFinite(m.glycogenRemainingG)).toBe(true);
    }
  });

  it('willGlycogenLast returns consistent results', () => {
    const result = willGlycogenLast(
      { weightKg: 70, sex: 'male', vo2max: 50 },
      480,
      false,
    );
    expect(typeof result.lasts).toBe('boolean');
    expect(typeof result.message).toBe('string');
    expect(result.message.length).toBeGreaterThan(0);
  });
});

// ── Hydration Calculator Edge Cases ───────────────────────────────────────────

describe('Hydration Calculator — Edge Cases', () => {
  it('handles freezing conditions (0°F)', () => {
    const result = calculateSweatRate(
      { weightKg: 70, sex: 'male', vo2max: 50 },
      { tempF: 0, humidityPct: 20 },
      480, 210,
    );
    expect(result.adjustedSweatRateMlHr).toBeGreaterThan(0);
    expect(isFinite(result.adjustedSweatRateMlHr)).toBe(true);
  });

  it('handles extreme heat (120°F)', () => {
    const result = calculateSweatRate(
      { weightKg: 70, sex: 'male', vo2max: 50 },
      { tempF: 120, humidityPct: 90 },
      480, 210,
    );
    expect(result.adjustedSweatRateMlHr).toBeGreaterThan(800);
    expect(result.recommendedIntakeMlHr).toBeLessThanOrEqual(1000);
  });

  it('handles zero humidity', () => {
    const result = calculateSweatRate(
      { weightKg: 70, sex: 'male', vo2max: 50 },
      { tempF: 55, humidityPct: 0 },
      480, 210,
    );
    expect(result.adjustedSweatRateMlHr).toBeGreaterThan(0);
  });

  it('handles 100% humidity', () => {
    const result = calculateSweatRate(
      { weightKg: 70, sex: 'male', vo2max: 50 },
      { tempF: 80, humidityPct: 100 },
      480, 210,
    );
    expect(result.adjustedSweatRateMlHr).toBeGreaterThan(0);
    expect(isFinite(result.recommendedIntakeMlHr)).toBe(true);
  });

  it('handles very fast pace (4:00/mi)', () => {
    const result = calculateSweatRate(
      { weightKg: 60, sex: 'male', vo2max: 75 },
      { tempF: 60, humidityPct: 50 },
      240, 120,
    );
    expect(result.adjustedSweatRateMlHr).toBeGreaterThan(0);
  });

  it('handles very slow pace (15:00/mi)', () => {
    const result = calculateSweatRate(
      { weightKg: 90, sex: 'female', vo2max: 30 },
      { tempF: 70, humidityPct: 60 },
      900, 360,
    );
    expect(result.adjustedSweatRateMlHr).toBeGreaterThan(0);
  });

  it('dehydration risk always returns valid risk level', () => {
    const conditions = [
      { tempF: 0, humidityPct: 0 },
      { tempF: 55, humidityPct: 40 },
      { tempF: 100, humidityPct: 90 },
    ];
    for (const c of conditions) {
      const risk = assessDehydrationRisk({ weightKg: 70, sex: 'male', vo2max: 50 }, c, 480);
      expect(['low', 'moderate', 'high', 'extreme']).toContain(risk.risk);
    }
  });
});

// ── Carb Loading Edge Cases ───────────────────────────────────────────────────

describe('Carb Loading — Edge Cases', () => {
  it('handles very light runner (40kg)', () => {
    expect(getDailyCarbTarget(40, 3)).toBe(320);  // 8 × 40
    expect(getDailyCarbTarget(40, 1)).toBe(480);  // 12 × 40
  });

  it('handles very heavy runner (130kg)', () => {
    expect(getDailyCarbTarget(130, 1)).toBe(1560); // 12 × 130
  });

  it('handles day 0 (race day) gracefully', () => {
    const target = getDailyCarbTarget(70, 0);
    // Day 0 should return some value or use day 1 target
    expect(target).toBeGreaterThanOrEqual(0);
    expect(isFinite(target)).toBe(true);
  });

  it('handles day 5+ (before loading window)', () => {
    const target = getDailyCarbTarget(70, 5);
    expect(target).toBeGreaterThanOrEqual(0);
    expect(isFinite(target)).toBe(true);
  });

  it('race morning target scales with weight', () => {
    const light = getRaceMorningCarbTarget(50);
    const heavy = getRaceMorningCarbTarget(90);
    expect(heavy).toBeGreaterThan(light);
  });
});

// ── Fueling Calculator Edge Cases ─────────────────────────────────────────────

describe('Fueling Calculator — Edge Cases', () => {
  const baseInput = {
    athlete: { weightKg: 70, sex: 'male' as const, vo2max: 50 },
    paceSecPerMi: 480,
    experience: 'intermediate' as const,
    gutTrained: false,
    preferredProducts: ['gel' as const],
  };

  it('gut-trained runner gets higher carb rate', () => {
    const untrained = generateFuelingPlan({ ...baseInput, gutTrained: false });
    const trained = generateFuelingPlan({ ...baseInput, gutTrained: true });
    expect(trained.targetCarbRateGHr).toBeGreaterThanOrEqual(untrained.targetCarbRateGHr);
  });

  it('very fast marathon (sub-2:30) uses appropriate carb rate', () => {
    const plan = generateFuelingPlan({
      ...baseInput,
      paceSecPerMi: 345,
    });
    expect(plan.targetCarbRateGHr).toBeGreaterThanOrEqual(30);
    expect(plan.targetCarbRateGHr).toBeLessThanOrEqual(90);
  });

  it('very slow marathon (6+ hours) uses appropriate carb rate', () => {
    const plan = generateFuelingPlan({
      ...baseInput,
      paceSecPerMi: 840,
    });
    expect(plan.targetCarbRateGHr).toBeGreaterThanOrEqual(40);
  });

  it('gel schedule produces at least 1 gel mile', () => {
    const schedule = getGelSchedule(480);
    expect(schedule.miles.length).toBeGreaterThanOrEqual(1);
  });

  it('gel schedule produces gels only within marathon distance', () => {
    const schedule = getGelSchedule(480);
    for (const mile of schedule.miles) {
      expect(mile).toBeGreaterThanOrEqual(1);
      expect(mile).toBeLessThanOrEqual(26);
    }
  });
});

// ── What-If Simulator Edge Cases ──────────────────────────────────────────────

describe('What-If Simulator — Edge Cases', () => {
  const mkScenario = (type: string, value: number): WhatIfScenario => ({
    type, label: `Test ${type}`, description: `Edge case test for ${type}`, value,
  });

  it('handles zero weight change', () => {
    const result = simulateWhatIf(mkScenario('weight_change', 0), 50, 40);
    expect(result.deltaSec).toBe(0);
  });

  it('handles extreme weight loss (-30 lbs)', () => {
    const result = simulateWhatIf(mkScenario('weight_change', -30), 50, 40);
    expect(result.deltaSec).toBeLessThan(0);
    expect(isFinite(result.deltaSec)).toBe(true);
  });

  it('handles extreme mileage increase (100%)', () => {
    const result = simulateWhatIf(mkScenario('increase_mileage', 100), 50, 40);
    expect(result.deltaSec).toBeLessThan(0);
    // 100% increase → capped improvement
    expect(Math.abs(result.deltaSec)).toBeLessThanOrEqual(1500);
  });

  it('handles zero skip days', () => {
    const result = simulateWhatIf(mkScenario('skip_days', 0), 50, 40);
    expect(result.deltaSec).toBe(0);
  });

  it('handles extreme skip days (90 days)', () => {
    const result = simulateWhatIf(mkScenario('skip_days', 90), 50, 40);
    expect(result.deltaSec).toBeGreaterThan(0);
    expect(isFinite(result.deltaSec)).toBe(true);
  });

  it('handles very low VDOT (25)', () => {
    const result = simulateWhatIf(mkScenario('weight_change', -5), 25, 20);
    expect(isFinite(result.deltaSec)).toBe(true);
  });

  it('handles very high VDOT (85)', () => {
    const result = simulateWhatIf(mkScenario('weight_change', -5), 85, 80);
    expect(isFinite(result.deltaSec)).toBe(true);
  });
});

// ── Fatigue Resistance Edge Cases ─────────────────────────────────────────────

describe('Fatigue Resistance — Edge Cases', () => {
  it('handles exactly 10 splits (minimum)', () => {
    const splits = Array(10).fill(480);
    // 10 splits at 1 mi each = 10 miles, but minimum is 16
    expect(calculateFRI(splits, 10, 'e1', '2025-01-01')).toBeNull();
  });

  it('handles 16 miles with exactly 10 splits', () => {
    const splits = Array(16).fill(480);
    const result = calculateFRI(splits, 16, 'e2', '2025-01-01');
    expect(result).not.toBeNull();
  });

  it('handles all splits identical', () => {
    const splits = Array(20).fill(480);
    const result = calculateFRI(splits, 20, 'e3', '2025-01-01');
    expect(result).not.toBeNull();
    expect(result!.fri).toBeCloseTo(100, 0);
  });

  it('handles decreasing splits (progressive run)', () => {
    const splits = Array(20).fill(0).map((_, i) => 600 - i * 5);
    const result = calculateFRI(splits, 20, 'e4', '2025-01-01');
    expect(result).not.toBeNull();
    expect(result!.fri).toBeLessThan(100);
  });

  it('handles all anomalous splits (returns null)', () => {
    // All splits wildly different — filtering might leave too few
    const splits = [100, 900, 200, 800, 150, 850, 120, 780, 180, 820,
      130, 870, 160, 830, 140, 860, 170, 810, 190, 790];
    const result = calculateFRI(splits, 20, 'e5', '2025-01-01');
    // May return null or a result depending on filtering
    if (result) {
      expect(isFinite(result.fri)).toBe(true);
    }
  });

  it('handles very long run (50 splits)', () => {
    const splits = Array(50).fill(540);
    const result = calculateFRI(splits, 50, 'e6', '2025-01-01');
    expect(result).not.toBeNull();
  });
});

// ── Pacing Decay Edge Cases ───────────────────────────────────────────────────

describe('Pacing Decay — Edge Cases', () => {
  it('returns null with fewer than 3 runs', () => {
    const runs = [
      { date: '2025-01-01', splits: Array(18).fill(480) },
      { date: '2025-01-15', splits: Array(18).fill(480) },
    ];
    expect(fitDecayModel(runs)).toBeNull();
  });

  it('returns null with short runs (< 16 splits)', () => {
    const runs = [
      { date: '2025-01-01', splits: Array(12).fill(480) },
      { date: '2025-01-15', splits: Array(12).fill(480) },
      { date: '2025-02-01', splits: Array(12).fill(480) },
    ];
    expect(fitDecayModel(runs)).toBeNull();
  });

  it('handles perfectly constant splits (zero decay)', () => {
    const runs = Array(3).fill(0).map((_, i) => ({
      date: `2025-0${i + 1}-01`,
      splits: Array(20).fill(480),
    }));
    const model = fitDecayModel(runs);
    expect(model).not.toBeNull();
    expect(Math.abs(model!.decayRatePerMi)).toBeLessThan(0.005);
  });

  it('predicted pacing for 26 miles has correct length', () => {
    const model = {
      basePaceSec: 480,
      decayRatePerMi: 0.005,
      decayStartMile: 8,
      rSquared: 0.7,
      sampleSize: 5,
      dateRange: { from: '2025-01-01', to: '2025-03-01' },
      updatedAt: new Date().toISOString(),
    };
    const paces = predictRacePacing(model, 420, 26);
    expect(paces.length).toBe(26);
  });

  it('predicted paces are always positive', () => {
    const model = {
      basePaceSec: 480,
      decayRatePerMi: 0.01,
      decayStartMile: 8,
      rSquared: 0.7,
      sampleSize: 5,
      dateRange: { from: '2025-01-01', to: '2025-03-01' },
      updatedAt: new Date().toISOString(),
    };
    const paces = predictRacePacing(model, 420, 30);
    for (const p of paces) {
      expect(p.paceSec).toBeGreaterThan(0);
    }
  });

  it('decay comparison handles extreme target times', () => {
    const model = {
      basePaceSec: 480,
      decayRatePerMi: 0.008,
      decayStartMile: 8,
      rSquared: 0.7,
      sampleSize: 5,
      dateRange: { from: '2025-01-01', to: '2025-03-01' },
      updatedAt: new Date().toISOString(),
    };
    // Sub-2:30 elite
    const elite = compareDecayToIdeal(model, 9000);
    expect(elite.idealDecayPct).toBeLessThanOrEqual(0.5);
    // 5+ hour marathon
    const slow = compareDecayToIdeal(model, 5 * 3600);
    expect(slow.idealDecayPct).toBeGreaterThan(1.0);
  });
});

// ── Race Equivalence Edge Cases ───────────────────────────────────────────────

describe('Race Equivalence — Edge Cases', () => {
  it('handles extreme heat (110°F)', () => {
    const result = normalizeToIdeal(10800, { tempF: 110, humidityPct: 80 });
    expect(result.adjustedTimeSec).toBeLessThan(10800);
    expect(isFinite(result.adjustedTimeSec)).toBe(true);
  });

  it('handles extreme cold (10°F)', () => {
    const result = normalizeToIdeal(10800, { tempF: 10, humidityPct: 30 });
    expect(isFinite(result.adjustedTimeSec)).toBe(true);
    // Cold benefit is capped at 10°F below ideal
    const maxBenefit = normalizeToIdeal(10800, { tempF: 45, humidityPct: 30 });
    // Difference between 10°F and 45°F should be small (cold benefit caps)
    expect(Math.abs(result.adjustedTimeSec - maxBenefit.adjustedTimeSec)).toBeLessThan(200);
  });

  it('handles high altitude (10000 ft)', () => {
    const result = normalizeToIdeal(10800, {
      tempF: 55, humidityPct: 40, altitudeFt: 10000,
    });
    expect(result.adjustedTimeSec).toBeLessThan(10800);
    const pctImprovement = ((10800 - result.adjustedTimeSec) / 10800) * 100;
    // 10000ft ≈ 9.1% improvement when normalizing to sea level
    expect(pctImprovement).toBeGreaterThanOrEqual(5);
    expect(pctImprovement).toBeLessThanOrEqual(15);
  });

  it('handles very fast time (sub 2:00)', () => {
    const result = normalizeToIdeal(7200, { tempF: 75, humidityPct: 50 });
    expect(result.adjustedTimeSec).toBeGreaterThan(0);
    expect(isFinite(result.adjustedTimeSec)).toBe(true);
  });

  it('handles very slow time (6+ hours)', () => {
    const result = normalizeToIdeal(6 * 3600, { tempF: 80, humidityPct: 70 });
    expect(result.adjustedTimeSec).toBeGreaterThan(0);
    expect(result.adjustedTimeSec).toBeLessThan(6 * 3600);
  });

  it('normalizeMarathonTime returns formatted string', () => {
    const result = normalizeMarathonTime(10800, 75, 60);
    expect(result.normalizedSec).toBeGreaterThan(0);
    expect(result.normalizedFormatted).toMatch(/\d+:\d{2}:\d{2}/);
    expect(result.message.length).toBeGreaterThan(0);
  });
});

// ── Aerobic Decoupling Edge Cases ─────────────────────────────────────────────

describe('Aerobic Decoupling — Edge Cases', () => {
  it('handles exactly 6 splits (minimum)', () => {
    const splits = Array(6).fill(0).map((_, i) => ({
      mile: i + 1, paceSec: 480, avgHR: 150,
    }));
    const result = calculateDecoupling(splits, 8, 1, '2025-01-01');
    expect(result).not.toBeNull();
  });

  it('handles fewer than 6 splits (returns null)', () => {
    const splits = Array(4).fill(0).map((_, i) => ({
      mile: i + 1, paceSec: 480, avgHR: 150,
    }));
    expect(calculateDecoupling(splits, 4, 2, '2025-01-01')).toBeNull();
  });

  it('handles all low HR readings (returns null — all filtered)', () => {
    const splits = Array(10).fill(0).map((_, i) => ({
      mile: i + 1, paceSec: 480, avgHR: 60, // all below 90
    }));
    expect(calculateDecoupling(splits, 10, 3, '2025-01-01')).toBeNull();
  });

  it('handles extremely high HR (200+ bpm)', () => {
    const splits = Array(10).fill(0).map((_, i) => ({
      mile: i + 1, paceSec: 480, avgHR: 190 + i, // 190-199
    }));
    const result = calculateDecoupling(splits, 10, 4, '2025-01-01');
    expect(result).not.toBeNull();
    expect(isFinite(result!.decouplingPct)).toBe(true);
  });

  it('handles one anomalous pace split', () => {
    const splits = Array(10).fill(0).map((_, i) => ({
      mile: i + 1,
      paceSec: i === 5 ? 900 : 480, // one walk
      avgHR: 150,
    }));
    const result = calculateDecoupling(splits, 10, 5, '2025-01-01');
    if (result) {
      expect(isFinite(result.decouplingPct)).toBe(true);
    }
  });
});

// ── Ghost Runner Edge Cases ───────────────────────────────────────────────────

describe('Ghost Runner — Edge Cases', () => {
  it('handles single-mile runs', () => {
    const a = buildGhostRun(1, '2025-01-01', 'A', [480]);
    const b = buildGhostRun(2, '2025-01-01', 'B', [490]);
    const cmp = compareRuns(a, b);
    expect(cmp.milesCompared).toBe(1);
    expect(cmp.totalDeltaSec).toBe(-10);
  });

  it('handles mismatched run lengths', () => {
    const short = buildGhostRun(1, '2025-01-01', 'Short', Array(5).fill(480));
    const long = buildGhostRun(2, '2025-01-01', 'Long', Array(20).fill(490));
    const cmp = compareRuns(short, long);
    expect(cmp.milesCompared).toBe(5);
  });

  it('buildGhostRun computes cumulative elapsed time correctly', () => {
    const run = buildGhostRun(1, '2025-01-01', 'Test', [480, 490, 500]);
    expect(run.splits[0].elapsedSec).toBe(480);
    expect(run.splits[1].elapsedSec).toBe(970);
    expect(run.splits[2].elapsedSec).toBe(1470);
    expect(run.totalTimeSec).toBe(1470);
    expect(run.distanceMi).toBe(3);
  });

  it('handles very fast splits', () => {
    const run = buildGhostRun(1, '2025-01-01', 'Fast', Array(26).fill(270));
    expect(run.totalTimeSec).toBe(270 * 26);
  });
});

// ── Race Day Timeline Edge Cases ──────────────────────────────────────────────

describe('Race Day Timeline — Edge Cases', () => {
  it('handles very early start (4:00 AM)', () => {
    const timeline = generateRaceDayTimeline({
      raceStartTime: '04:00',
      travelMinutes: 30,
      mealPreference: 'moderate',
      weightKg: 70,
      projectedFinishSec: 3.5 * 3600,
      raceName: 'Early Bird Marathon',
    });
    expect(timeline.events.length).toBeGreaterThan(0);
    // Alarm should wrap around midnight
    const alarm = timeline.events.find((e) => e.title.includes('Alarm'));
    expect(alarm).toBeDefined();
  });

  it('handles late start (11:00 AM)', () => {
    const timeline = generateRaceDayTimeline({
      raceStartTime: '11:00',
      travelMinutes: 60,
      mealPreference: 'full',
      weightKg: 80,
      projectedFinishSec: 4 * 3600,
      raceName: 'Late Start Marathon',
    });
    expect(timeline.events.length).toBeGreaterThan(0);
  });

  it('handles long travel time (120 min)', () => {
    const timeline = generateRaceDayTimeline({
      raceStartTime: '07:00',
      travelMinutes: 120,
      mealPreference: 'moderate',
      weightKg: 70,
      projectedFinishSec: 3.5 * 3600,
      raceName: 'Long Drive Marathon',
    });
    const leave = timeline.events.find((e) => e.title.includes('Leave'));
    expect(leave).toBeDefined();
    expect(leave!.minutesBeforeStart).toBeGreaterThanOrEqual(120);
  });

  it('includes warmup when requested', () => {
    const timeline = generateRaceDayTimeline({
      raceStartTime: '07:00',
      travelMinutes: 30,
      mealPreference: 'moderate',
      weightKg: 70,
      projectedFinishSec: 3.5 * 3600,
      raceName: 'Warmup Test',
      includeWarmup: true,
    });
    const warmup = timeline.events.find((e) => e.title.includes('Warmup'));
    expect(warmup).toBeDefined();
  });

  it('generates text export for all timelines', () => {
    const timeline = generateRaceDayTimeline({
      raceStartTime: '07:00',
      travelMinutes: 30,
      mealPreference: 'moderate',
      weightKg: 70,
      projectedFinishSec: 3.5 * 3600,
      raceName: 'Export Test',
    });
    expect(timeline.textExport).toContain('Export Test');
    expect(timeline.textExport.length).toBeGreaterThan(100);
  });
});

// ── Taper Optimizer Edge Cases ────────────────────────────────────────────────

describe('Taper Optimizer — Edge Cases', () => {
  it('handles empty training history', () => {
    const snapshots = calculateFitnessFatigue([]);
    expect(snapshots).toEqual([]);
  });

  it('handles single day of training', () => {
    const snapshots = calculateFitnessFatigue([
      { date: '2025-01-01', tss: 50, distanceMi: 6, type: 'easy' },
    ]);
    expect(snapshots.length).toBe(1);
    expect(snapshots[0].ctl).toBeGreaterThan(0);
    expect(snapshots[0].atl).toBeGreaterThan(0);
  });

  it('rest days have zero TSS', () => {
    expect(estimateTSS(0, 0, 'rest')).toBe(0);
  });

  it('interval TSS > tempo TSS > easy TSS for same distance', () => {
    const easy = estimateTSS(6, 48, 'easy');
    const tempo = estimateTSS(6, 48, 'tempo');
    const interval = estimateTSS(6, 48, 'interval');
    expect(interval).toBeGreaterThan(tempo);
    expect(tempo).toBeGreaterThan(easy);
  });

  it('generateTaperPlan with sparse history still produces valid output', () => {
    const sparseHistory = [
      { date: '2025-01-01', tss: 50, distanceMi: 6, type: 'easy' as const },
      { date: '2025-01-15', tss: 80, distanceMi: 10, type: 'tempo' as const },
      { date: '2025-02-01', tss: 120, distanceMi: 18, type: 'long_run' as const },
    ];
    const taper = generateTaperPlan(sparseHistory, '2025-04-01');
    expect(taper.taperLengthDays).toBeGreaterThanOrEqual(10);
    expect(taper.weeklyReductions.length).toBeGreaterThanOrEqual(1);
    expect(typeof taper.summary).toBe('string');
  });
});

// ── Bonk Risk Edge Cases ──────────────────────────────────────────────────────

describe('Bonk Risk — Edge Cases', () => {
  it('handles zero planned long runs (avoid division by zero)', () => {
    const result = assessBonkRisk({
      longestRunMi: 10,
      runsOver18Mi: 0,
      longRunsPlanned: 0,
      longRunsCompleted: 0,
      targetRacePaceSec: 480,
      avgLongRunPaceSec: 540,
      practicedFueling: false,
      carbLoading: false,
      experience: 'beginner',
    });
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
    expect(isFinite(result.score)).toBe(true);
  });

  it('handles training pace equal to race pace', () => {
    const result = assessBonkRisk({
      longestRunMi: 22,
      runsOver18Mi: 5,
      longRunsPlanned: 6,
      longRunsCompleted: 6,
      targetRacePaceSec: 480,
      avgLongRunPaceSec: 480,
      practicedFueling: true,
      carbLoading: true,
      carbLoadingDaysCompleted: 3,
      experience: 'intermediate',
    });
    // Zero pace aggression
    const paceFactor = result.factors.find((f) => f.name === 'Pace Aggression');
    expect(paceFactor).toBeDefined();
    expect(paceFactor!.score).toBeLessThanOrEqual(20); // low risk
  });

  it('handles race pace faster than training pace (negative pace aggression)', () => {
    const result = assessBonkRisk({
      longestRunMi: 20,
      runsOver18Mi: 3,
      longRunsPlanned: 6,
      longRunsCompleted: 5,
      targetRacePaceSec: 420,
      avgLongRunPaceSec: 540,
      practicedFueling: true,
      carbLoading: true,
      experience: 'beginner',
    });
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
  });

  it('all factors produce scores in [0, 100]', () => {
    const result = assessBonkRisk({
      longestRunMi: 22, runsOver18Mi: 5, longRunsPlanned: 6, longRunsCompleted: 6,
      targetRacePaceSec: 480, avgLongRunPaceSec: 510,
      practicedFueling: true, fueledLongRuns: 5,
      carbLoading: true, carbLoadingDaysCompleted: 3,
      experience: 'advanced', raceTempF: 55,
    });
    for (const f of result.factors) {
      expect(f.score).toBeGreaterThanOrEqual(0);
      expect(f.score).toBeLessThanOrEqual(100);
      expect(f.weight).toBeGreaterThan(0);
      expect(f.weight).toBeLessThanOrEqual(1);
    }
  });

  it('summary is always non-empty', () => {
    const cases = [
      { longestRunMi: 22, runsOver18Mi: 5 }, // low risk
      { longestRunMi: 10, runsOver18Mi: 0 }, // high risk
    ];
    for (const c of cases) {
      const result = assessBonkRisk({
        ...c,
        longRunsPlanned: 6, longRunsCompleted: 3,
        targetRacePaceSec: 480, avgLongRunPaceSec: 540,
        practicedFueling: false, carbLoading: false, experience: 'beginner',
      });
      expect(result.summary.length).toBeGreaterThan(0);
    }
  });
});

// ── Cross-Service Integration Stress Test ─────────────────────────────────────

describe('Cross-Service Integration — Extreme Athlete Profiles', () => {
  it('elite male: all services produce coherent results', () => {
    const athlete = { weightKg: 58, sex: 'male' as const, vo2max: 80 };
    const pace = 300; // 5:00/mi — elite marathon pace

    const glycogen = simulateGlycogenDepletion({ athlete, paceSecPerMi: pace, carbLoaded: true });
    expect(glycogen.totalCalsBurned).toBeGreaterThan(0);

    const hydration = calculateSweatRate(athlete, { tempF: 55, humidityPct: 40 }, pace, 130);
    expect(hydration.adjustedSweatRateMlHr).toBeGreaterThan(0);

    const fueling = generateFuelingPlan({
      athlete, paceSecPerMi: pace,
      experience: 'advanced', gutTrained: true,
      preferredProducts: ['gel'],
    });
    expect(fueling.targetCarbRateGHr).toBeGreaterThan(0);
  });

  it('recreational female: all services produce coherent results', () => {
    const athlete = { weightKg: 65, sex: 'female' as const, vo2max: 35 };
    const pace = 660; // 11:00/mi

    const glycogen = simulateGlycogenDepletion({ athlete, paceSecPerMi: pace });
    expect(glycogen.totalCalsBurned).toBeGreaterThan(0);

    const hydration = calculateSweatRate(athlete, { tempF: 70, humidityPct: 60 }, pace, 290);
    expect(hydration.adjustedSweatRateMlHr).toBeGreaterThan(0);

    const risk = assessBonkRisk({
      longestRunMi: 16, runsOver18Mi: 1, longRunsPlanned: 8, longRunsCompleted: 5,
      targetRacePaceSec: pace, avgLongRunPaceSec: pace + 30,
      practicedFueling: true, carbLoading: false, experience: 'beginner',
    });
    expect(risk.score).toBeGreaterThanOrEqual(0);
    expect(risk.score).toBeLessThanOrEqual(100);
  });

  it('all numerical outputs are finite (no NaN or Infinity)', () => {
    const athletes = [
      { weightKg: 45, sex: 'female' as const, vo2max: 30 },
      { weightKg: 100, sex: 'male' as const, vo2max: 70 },
    ];
    const paces = [270, 480, 900]; // 4:30, 8:00, 15:00 per mile

    for (const athlete of athletes) {
      for (const pace of paces) {
        const sim = simulateGlycogenDepletion({ athlete, paceSecPerMi: pace });
        expect(isFinite(sim.totalCalsBurned)).toBe(true);
        for (const m of sim.miles) {
          expect(isFinite(m.glycogenRemainingG)).toBe(true);
          expect(isFinite(m.calsBurnedThisMile)).toBe(true);
        }
      }
    }
  });
});
