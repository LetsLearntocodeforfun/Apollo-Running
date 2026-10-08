/**
 * Tests for fuelingCalculator.ts — In-Race Fueling Calculator
 */

import { describe, it, expect } from 'vitest';
import {
  generateFuelingPlan,
  getGelSchedule,
  planRaceFueling,
  fluidCeilingMlPerHour,
  assessGIRisk,
} from '@/services/fuelingCalculator';
import { getCarbToleranceGPerHour } from '@/services/athleteProfile';
import {
  buildRaceStrategy,
  distanceAtTime,
  getMarathon,
  getStrategyDistanceMi,
} from '@/services/raceStrategy';

const baseAthlete = { weightKg: 70, vo2max: 50, sex: 'male' as const };
const MARATHON_MI = 26.21875;
const HALF_MI = 13.109375;

describe('generateFuelingPlan', () => {
  it('should generate fueling items for a marathon', () => {
    const plan = generateFuelingPlan({
      athlete: baseAthlete,
      paceSecPerMi: 480,
      experience: 'intermediate',
      gutTrained: false,
    });
    expect(plan.items.length).toBeGreaterThan(0);
    expect(plan.totalCarbsPlannedG).toBeGreaterThan(0);
    expect(plan.targetCarbRateGHr).toBeGreaterThan(0);
  });

  it('should recommend different carb rates based on duration and experience', () => {
    const fast = generateFuelingPlan({
      athlete: baseAthlete,
      paceSecPerMi: 390,
      experience: 'advanced',
      gutTrained: true,
    });
    const slow = generateFuelingPlan({
      athlete: baseAthlete,
      paceSecPerMi: 600,
      experience: 'beginner',
      gutTrained: false,
    });
    // Both should have positive carb rate targets
    expect(fast.targetCarbRateGHr).toBeGreaterThan(0);
    expect(slow.targetCarbRateGHr).toBeGreaterThan(0);
    // Gut-trained advanced runner may have higher rate than beginner
    expect(fast.targetCarbRateGHr).toBeGreaterThanOrEqual(slow.targetCarbRateGHr);
  });

  // v1.0.6 (N-18): caffeine is opt-in. This used to assert caffeine was always included.
  it('should include a caffeine strategy only when opted in', () => {
    const plain = generateFuelingPlan({
      athlete: baseAthlete,
      paceSecPerMi: 480,
      experience: 'intermediate',
      gutTrained: false,
    });
    expect(plain.caffeine).toBeUndefined();
    expect(plain.items.some((i) => i.caffeineMg)).toBe(false);

    const plan = generateFuelingPlan({
      athlete: baseAthlete,
      paceSecPerMi: 480,
      experience: 'intermediate',
      gutTrained: false,
      caffeine: true,
    });
    expect(plan.caffeine).toBeDefined();
    expect(plan.caffeine!.totalMg).toBeGreaterThan(0);
    expect(plan.caffeine!.items.length).toBeGreaterThan(0);
    expect(plan.caffeine!.items[0].mile).toBeGreaterThanOrEqual(13);
  });

  it('doses caffeine by body mass (~1–3 mg/kg), merged into gel items whose carbs still count', () => {
    for (const weightKg of [45, 70, 100, 130]) {
      const athlete = { ...baseAthlete, weightKg };
      const plain = generateFuelingPlan({ athlete, paceSecPerMi: 480 });
      const plan = generateFuelingPlan({ athlete, paceSecPerMi: 480, caffeine: true });
      const caffeine = plan.caffeine!;
      const mgPerKg = caffeine.totalMg / weightKg;
      expect(mgPerKg).toBeGreaterThanOrEqual(1);
      expect(mgPerKg).toBeLessThanOrEqual(3);
      const caffeinated = plan.items.filter((i) => i.caffeineMg);
      expect(caffeinated).toHaveLength(caffeine.items.length);
      expect(caffeinated.reduce((s, i) => s + (i.caffeineMg ?? 0), 0)).toBe(caffeine.totalMg);
      expect(caffeinated.every((i) => i.carbsG > 0)).toBe(true);
      expect(plan.totalCarbsPlannedG).toBe(plain.totalCarbsPlannedG);
      expect(caffeinated[0].raceTimeMin).toBeGreaterThanOrEqual(plan.estimatedDurationMin / 2);
      expect(caffeine.summary).not.toMatch(/NaN|Infinity/);
    }
  });

  it('gives no caffeine without a valid body mass', () => {
    const plan = generateFuelingPlan({ athlete: { weightKg: 0 }, paceSecPerMi: 480, caffeine: true });
    expect(plan.caffeine).toBeUndefined();
    expect(plan.summary).not.toMatch(/NaN|Infinity/);
  });

  it('should flag GI risk for high carb rates without gut training', () => {
    const plan = generateFuelingPlan({
      athlete: baseAthlete,
      paceSecPerMi: 600,
      experience: 'beginner',
      gutTrained: false,
    });
    expect(plan.giRisk).toBeDefined();
  });

  it('reaches every GI-risk level and explains glucose+fructose above 60 g/h (N-17)', () => {
    expect(assessGIRisk(90, 'intermediate', false)).toBe('high');
    expect(assessGIRisk(70, 'beginner', true)).toBe('high');
    expect(assessGIRisk(70, 'intermediate', false)).toBe('moderate');
    expect(assessGIRisk(50, 'beginner', false)).toBe('moderate');
    expect(assessGIRisk(60, 'intermediate', false)).toBe('low');

    const plan = generateFuelingPlan({ athlete: baseAthlete, paceSecPerMi: 540, carbsPerHourG: 90 });
    expect(plan.giRisk).toBe('high');
    expect(plan.needsMultipleTransportable).toBe(true);
    expect(plan.summary).toMatch(/glucose\+fructose/);
  });

  it('should allow higher carb rates for gut-trained athletes', () => {
    const untrained = generateFuelingPlan({
      athlete: baseAthlete,
      paceSecPerMi: 480,
      experience: 'advanced',
      gutTrained: false,
    });
    const trained = generateFuelingPlan({
      athlete: baseAthlete,
      paceSecPerMi: 480,
      experience: 'advanced',
      gutTrained: true,
    });
    expect(trained.targetCarbRateGHr).toBeGreaterThanOrEqual(untrained.targetCarbRateGHr);
  });

  it('should place fueling items at reasonable mile intervals', () => {
    const plan = generateFuelingPlan({
      athlete: baseAthlete,
      paceSecPerMi: 480,
      experience: 'intermediate',
      gutTrained: false,
    });
    for (const item of plan.items) {
      expect(item.mile).toBeGreaterThanOrEqual(3);
      expect(item.mile).toBeLessThanOrEqual(25);
    }
  });

  it('should include a summary message', () => {
    const plan = generateFuelingPlan({
      athlete: baseAthlete,
      paceSecPerMi: 480,
      experience: 'intermediate',
      gutTrained: false,
    });
    expect(plan.summary).toBeTruthy();
    expect(plan.summary.length).toBeGreaterThan(20);
  });

  it('uses the shared planRaceFueling cadence: target = carb tolerance, default 60 g/h (N-16)', () => {
    const plan = generateFuelingPlan({ athlete: baseAthlete, paceSecPerMi: 480 });
    expect(plan.targetCarbRateGHr).toBe(60);
    expect(plan.gelIntervalMin).toBe(25);
    const race = planRaceFueling({
      finishSec: 480 * MARATHON_MI, distanceMi: MARATHON_MI, carbsPerHourG: 60, preRaceGel: false,
    });
    expect(plan.items.map((i) => i.raceTimeMin)).toEqual(race.items.map((i) => Math.round(i.timeSec / 60)));

    const custom = generateFuelingPlan({ athlete: baseAthlete, paceSecPerMi: 480, carbsPerHourG: 75 });
    expect(custom.targetCarbRateGHr).toBe(75);
    expect(custom.gelIntervalMin).toBe(20);
  });

  it('accepts a race distance instead of assuming 26.2 mi (N-15)', () => {
    const half = generateFuelingPlan({ athlete: baseAthlete, paceSecPerMi: 480, distanceMi: HALF_MI });
    expect(half.estimatedDurationMin).toBe(Math.round((480 * HALF_MI) / 60));
    expect(half.items.length).toBeGreaterThan(0);
    for (const item of half.items) expect(item.distanceMi!).toBeLessThan(HALF_MI);
  });

  it('drink mode never exceeds 800 mL/h or 0.8 × the sweat rate, and derives carbs from the volume (N-01)', () => {
    for (const sweat of [undefined, 0.3, 0.6, 1.0, 1.5, 2.5]) {
      for (const pace of [360, 480, 630, 840]) {
        const plan = generateFuelingPlan({
          athlete: { weightKg: 60, sex: 'female' },
          paceSecPerMi: pace,
          preferredProducts: ['drink'],
          sweatRateLPerHour: sweat,
          carbsPerHourG: 90,
        });
        const cap = sweat === undefined ? 800 : Math.min(800, sweat * 1000 * 0.8);
        const hours = (pace * MARATHON_MI) / 3600;
        const drinks = plan.items.filter((i) => i.fluidMl);
        const fluidMl = drinks.reduce((s, i) => s + (i.fluidMl ?? 0), 0);
        expect(fluidMl / hours).toBeLessThanOrEqual(cap);
        expect(plan.fluidMlPerHour!).toBeLessThanOrEqual(cap);
        // 6 % drink: 9 g carbs per 150 mL — carbs come FROM the volume…
        for (const d of drinks) expect(d.carbsG).toBe(Math.round((d.fluidMl! / 1000) * 60));
        // …and gels top up the rest of the target.
        expect(plan.items.some((i) => !i.fluidMl)).toBe(true);
      }
    }
  });

  it('never produces NaN or Infinity for invalid input', () => {
    for (const pace of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const plan = generateFuelingPlan({ athlete: baseAthlete, paceSecPerMi: pace, caffeine: true });
      expect(plan.items).toEqual([]);
      expect(plan.coveragePct).toBe(0);
      expect(plan.caffeine).toBeUndefined();
      expect(plan.summary).not.toMatch(/NaN|Infinity/);
    }
    const badDistance = generateFuelingPlan({ athlete: baseAthlete, paceSecPerMi: 480, distanceMi: Number.NaN });
    expect(badDistance.items).toEqual([]);
    expect(Number.isFinite(badDistance.totalCarbsNeededG)).toBe(true);
  });
});

describe('getGelSchedule', () => {
  it('should return mile numbers for gel intake', () => {
    const schedule = getGelSchedule(480);
    expect(schedule.miles.length).toBeGreaterThan(0);
    for (const mile of schedule.miles) {
      expect(mile).toBeGreaterThanOrEqual(3);
      expect(mile).toBeLessThanOrEqual(25);
    }
  });

  it('should space gels reasonably', () => {
    const schedule = getGelSchedule(480);
    for (let i = 1; i < schedule.miles.length; i++) {
      const gap = schedule.miles[i] - schedule.miles[i - 1];
      expect(gap).toBeGreaterThanOrEqual(2);
      expect(gap).toBeLessThanOrEqual(6);
    }
  });

  it('follows the carb target and the distance (N-15, N-16)', () => {
    expect(getGelSchedule(480).intervalMin).toBe(25);
    expect(getGelSchedule(480, MARATHON_MI, 90).intervalMin).toBeCloseTo(16.7, 1);
    const half = getGelSchedule(480, HALF_MI);
    expect(half.miles.every((m) => m < HALF_MI)).toBe(true);
    expect(getGelSchedule(Number.NaN)).toEqual({ miles: [], intervalMin: 0 });
  });
});

describe('planRaceFueling', () => {
  it('targets the carb tolerance (60 g/h by default) with a 25-min interval for 25 g gels', () => {
    const tolerance = getCarbToleranceGPerHour();
    expect(tolerance).toBe(60);
    const plan = planRaceFueling({ finishSec: 4 * 3600, distanceMi: MARATHON_MI, carbsPerHourG: tolerance });
    expect(plan.targetCarbsPerHourG).toBe(tolerance);
    expect(plan.gelIntervalMin).toBe(25);
    expect(plan.needsMultipleTransportable).toBe(false);
  });

  it('delivers ≈ the target g/h between the first and the last gel', () => {
    for (const carbs of [40, 60, 75, 90]) {
      const plan = planRaceFueling({
        finishSec: 4 * 3600, distanceMi: MARATHON_MI, carbsPerHourG: carbs, preRaceGel: false,
      });
      const gels = plan.items;
      const spanH = (gels[gels.length - 1].timeSec - gels[0].timeSec) / 3600;
      expect(((gels.length - 1) * 25) / spanH).toBeCloseTo(carbs, 0);
    }
  });

  it('caps a 100 g/h tolerance at 90 and needs glucose + fructose', () => {
    const plan = planRaceFueling({ finishSec: 4 * 3600, distanceMi: MARATHON_MI, carbsPerHourG: 100 });
    expect(plan.targetCarbsPerHourG).toBe(90);
    expect(plan.needsMultipleTransportable).toBe(true);
    expect(plan.notes.join(' ')).toMatch(/glucose\+fructose/);
  });

  it('respects a low target, with a note', () => {
    const plan = planRaceFueling({ finishSec: 4 * 3600, distanceMi: MARATHON_MI, carbsPerHourG: 20 });
    expect(plan.targetCarbsPerHourG).toBe(20);
    expect(plan.notes.join(' ')).toMatch(/below the usual 30–60 g\/h/);
  });

  it('starts at 20–45 min and never fuels in the final 15 min', () => {
    for (const carbs of [20, 45, 60, 90]) {
      for (const finishSec of [75 * 60, 3 * 3600, 5.5 * 3600]) {
        const gels = planRaceFueling({ finishSec, distanceMi: MARATHON_MI, carbsPerHourG: carbs })
          .items.filter((i) => i.kind === 'gel');
        if (gels.length === 0) continue;
        expect(gels[0].timeSec).toBeGreaterThanOrEqual(20 * 60);
        expect(gels[0].timeSec).toBeLessThanOrEqual(45 * 60);
        for (const g of gels) expect(g.timeSec).toBeLessThanOrEqual(finishSec - 15 * 60);
      }
    }
  });

  it('plans a pre-race gel at −15 min that is not counted as in-race carbs', () => {
    const plan = planRaceFueling({ finishSec: 4 * 3600, distanceMi: MARATHON_MI, carbsPerHourG: 60 });
    expect(plan.items[0]).toMatchObject({ kind: 'pre-race', timeSec: -900, distanceMi: 0 });
    const gels = plan.items.filter((i) => i.kind === 'gel');
    expect(plan.totalCarbsG).toBe(gels.length * 25);
    const without = planRaceFueling({
      finishSec: 4 * 3600, distanceMi: MARATHON_MI, carbsPerHourG: 60, preRaceGel: false,
    });
    expect(without.items.some((i) => i.kind === 'pre-race')).toBe(false);
    expect(without.totalCarbsG).toBe(plan.totalCarbsG);
  });

  it("places gels at a real strategy's distanceAtTime and notes nearby aid stations", () => {
    const strategy = buildRaceStrategy('boston', 4 * 3600, 'even-split');
    expect(strategy).not.toBeNull();
    const s = strategy!;
    const race = getMarathon('boston')!;
    const plan = planRaceFueling({
      finishSec: s.targetTimeSec,
      distanceMi: getStrategyDistanceMi(s),
      carbsPerHourG: 60,
      distanceAtTimeSec: (t) => distanceAtTime(s.milePaces, t),
      aidStations: race.aidStations,
    });
    const gels = plan.items.filter((i) => i.kind === 'gel');
    expect(gels.length).toBeGreaterThan(5);
    for (const g of gels) {
      expect(g.distanceMi).toBeCloseTo(distanceAtTime(s.milePaces, g.timeSec), 1);
      if (g.note) {
        const station = race.aidStations.find((a) => `Near ${a.name}` === g.note);
        expect(station).toBeDefined();
        expect(Math.abs(station!.distanceMi - g.distanceMi)).toBeLessThanOrEqual(0.6);
        expect(g.note).not.toMatch(/\bmi\b|\bkm\b/);
      }
    }
  });

  it('builds a sensible 1:45 half marathon', () => {
    const plan = planRaceFueling({ finishSec: 6300, distanceMi: HALF_MI, carbsPerHourG: 60 });
    const gels = plan.items.filter((i) => i.kind === 'gel');
    expect(gels.map((g) => g.timeSec)).toEqual([1500, 3000, 4500]);
    expect(gels.every((g) => g.distanceMi > 0 && g.distanceMi < HALF_MI)).toBe(true);
    expect(plan.totalCarbsG).toBe(75);
  });

  it('plans no in-race gels under 60 minutes', () => {
    const plan = planRaceFueling({ finishSec: 50 * 60, distanceMi: 6.2137, carbsPerHourG: 60 });
    expect(plan.items.filter((i) => i.kind === 'gel')).toHaveLength(0);
    expect(plan.totalCarbsG).toBe(0);
    expect(plan.notes.join(' ')).toMatch(/mouth rinse/);
  });

  it('returns empty items plus a note for invalid input — never NaN', () => {
    const bads = [Number.NaN, 0, -100, Number.POSITIVE_INFINITY];
    for (const bad of bads) {
      for (const field of ['finishSec', 'distanceMi', 'carbsPerHourG'] as const) {
        const plan = planRaceFueling({
          finishSec: 4 * 3600, distanceMi: MARATHON_MI, carbsPerHourG: 60, [field]: bad,
        });
        expect(plan.items).toEqual([]);
        expect(plan.notes.length).toBeGreaterThan(0);
        expect(plan.notes.join(' ')).not.toMatch(/NaN|Infinity/);
        expect(Number.isFinite(plan.totalCarbsG)).toBe(true);
        expect(Number.isFinite(plan.gelIntervalMin)).toBe(true);
        expect(Number.isFinite(plan.targetCarbsPerHourG)).toBe(true);
      }
    }
    const nanDistance = planRaceFueling({
      finishSec: 4 * 3600, distanceMi: MARATHON_MI, carbsPerHourG: 60, distanceAtTimeSec: () => Number.NaN,
    });
    expect(nanDistance.items.every((i) => Number.isFinite(i.distanceMi))).toBe(true);
  });
});

describe('fluidCeilingMlPerHour', () => {
  it('is min(sweat × 0.8, 800 mL/h), or null when unknown', () => {
    expect(fluidCeilingMlPerHour(1.5)).toBe(800);
    expect(fluidCeilingMlPerHour(0.5)).toBe(400);
    expect(fluidCeilingMlPerHour(undefined)).toBeNull();
    expect(fluidCeilingMlPerHour(Number.NaN)).toBeNull();
    expect(fluidCeilingMlPerHour(0)).toBeNull();
  });
});
