/**
 * v1.0.7 race-day promises: R-3 (live race-card fuel plan), R-4 (one
 * race-breakfast rule) and R-7 (one carb ceiling). R-1/R-2/R-5 are covered in
 * fuelingCalculator.test.ts and fuelPanel.test.tsx.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { buildRaceStrategy, isNutritionPlanStale, liveNutritionPlan } from '@/services/raceStrategy';
import { generateRaceCard } from '@/services/raceCard';
import { getAthleteProfile, sanitizeAthleteProfile, updateAthleteProfile } from '@/services/athleteProfile';
import {
  RACE_BREAKFAST_FOODS,
  generateCarbLoadingProtocol,
  getRaceMorningCarbTarget,
  raceBreakfastCarbsG,
  raceBreakfastGPerKg,
} from '@/services/carbLoading';
import { generateRaceDayTimeline } from '@/services/raceDayTimeline';
import type { RaceDayInput } from '@/services/raceDayTimeline';
import { CARB_TOLERANCE_MAX_G_PER_HOUR, CARB_TOLERANCE_MIN_G_PER_HOUR } from '@/services/fuelingCalculator';
import { PROFILE_LIMITS } from '@/pages/settings/profileForm';
import { persistence } from '@/services/db/persistence';

beforeEach(() => {
  for (const key of persistence.keys()) persistence.removeItem(key);
});

// ── R-3 ───────────────────────────────────────────────────────────────────────

describe('live race-card fuel plan (R-3)', () => {
  it('matches the saved snapshot when nothing changed', () => {
    const strategy = buildRaceStrategy('chicago', 4 * 3600, 'even-split')!;
    const live = liveNutritionPlan(strategy);
    expect(live).toEqual(strategy.nutritionPlan);
    expect(isNutritionPlanStale(strategy, live)).toBe(false);
  });

  it('follows a carb-tolerance change made after the strategy was saved', () => {
    const strategy = buildRaceStrategy('chicago', 4 * 3600, 'even-split')!; // saved at 60 g/h
    updateAthleteProfile({ carbToleranceGPerHour: 90 });
    const live = liveNutritionPlan(strategy);
    expect(live.length).toBeGreaterThan(strategy.nutritionPlan.length);
    expect(isNutritionPlanStale(strategy, live)).toBe(true);
  });

  it('the race card prints the live plan, not the stale snapshot', () => {
    const strategy = buildRaceStrategy('chicago', 4 * 3600, 'even-split')!;
    const live = liveNutritionPlan(strategy, undefined, { carbsPerHourG: 90 });
    const stale = generateRaceCard({ strategy });
    const fresh = generateRaceCard({ strategy, nutritionPlan: live });
    const gelCount = (summary: string) => (summary.match(/Energy gel \d+/g) ?? []).length;
    expect(gelCount(stale.nutritionSummary)).toBe(strategy.nutritionPlan.length - 1);
    expect(gelCount(fresh.nutritionSummary)).toBe(live.length - 1);
    expect(gelCount(fresh.nutritionSummary)).toBeGreaterThan(gelCount(stale.nutritionSummary));
  });

  it('handles a strategy without a saved plan (older data)', () => {
    const strategy = { ...buildRaceStrategy('chicago', 4 * 3600, 'even-split')!, nutritionPlan: [] };
    const live = liveNutritionPlan(strategy);
    expect(live.length).toBeGreaterThan(0);
    expect(isNutritionPlanStale(strategy, live)).toBe(true);
  });
});

// ── R-4 ───────────────────────────────────────────────────────────────────────

describe('one race-breakfast rule (R-4)', () => {
  it('is light 1 / moderate 2 / full 3 g/kg, never more than ~1 g/kg per hour before (1–4)', () => {
    expect(raceBreakfastGPerKg('light')).toBe(1);
    expect(raceBreakfastGPerKg('moderate')).toBe(2);
    expect(raceBreakfastGPerKg('full')).toBe(3);
    expect(raceBreakfastGPerKg('full', 120)).toBe(2);
    expect(raceBreakfastGPerKg('full', 30)).toBe(1);
    expect(raceBreakfastGPerKg('full', 600)).toBe(3);
    expect(raceBreakfastGPerKg(undefined)).toBe(2);
  });

  it('uses the same 90 kg mass cap as carb loading; invalid mass → 0', () => {
    expect(raceBreakfastCarbsG(70, 'moderate')).toBe(140);
    expect(raceBreakfastCarbsG(130, 'full')).toBe(270);
    expect(raceBreakfastCarbsG(0)).toBe(0);
    expect(raceBreakfastCarbsG(Number.NaN)).toBe(0);
  });

  it('gives the Fuel tab and the race-morning timeline the same grams', () => {
    const base: RaceDayInput = {
      raceStartTime: '07:30',
      travelMinutes: 30,
      mealPreference: 'moderate',
      weightKg: 70,
      projectedFinishSec: 4 * 3600,
      raceName: 'Test',
    };
    for (const size of ['light', 'moderate', 'full'] as const) {
      for (const weightKg of [55, 70, 120]) {
        const fuelTab = generateCarbLoadingProtocol({ weightKg }, '2026-10-11', { breakfastSize: size }).raceMorning;
        const timeline = generateRaceDayTimeline({ ...base, mealPreference: size, weightKg });
        const breakfast = timeline.events.find((e) => e.title === 'Breakfast')!;
        expect(breakfast.description).toContain(`~${fuelTab.targetCarbsG}g carbs`);
        expect(fuelTab.targetCarbsG).toBe(getRaceMorningCarbTarget(weightKg, size));
      }
    }
  });

  it('never calls oatmeal low-fibre, on either surface', () => {
    expect(RACE_BREAKFAST_FOODS).not.toMatch(/low-fibre[^.]*oatmeal/i);
    expect(RACE_BREAKFAST_FOODS).toMatch(/Oatmeal has more fibre/);
    const timeline = generateRaceDayTimeline({
      raceStartTime: '07:30',
      travelMinutes: 30,
      mealPreference: 'full',
      weightKg: 70,
      projectedFinishSec: 4 * 3600,
      raceName: 'T',
    });
    const breakfast = timeline.events.find((e) => e.title === 'Breakfast')!.description;
    expect(breakfast).not.toMatch(/low-fibre[^.]*oatmeal/i);
    const morning = generateCarbLoadingProtocol({ weightKg: 70 }, '2026-10-11').raceMorning;
    expect(morning.fiberGuidance).toBe(RACE_BREAKFAST_FOODS);
    expect(morning.meals[0].description).not.toMatch(/Oatmeal/);
  });
});

// ── R-7 ───────────────────────────────────────────────────────────────────────

describe('one carb ceiling (R-7)', () => {
  it('Settings validates against the shared range', () => {
    expect(PROFILE_LIMITS.carbTolerance).toEqual([CARB_TOLERANCE_MIN_G_PER_HOUR, CARB_TOLERANCE_MAX_G_PER_HOUR]);
  });

  it('older stored values outside 20–90 are kept, clamped into the range', () => {
    expect(sanitizeAthleteProfile({ carbToleranceGPerHour: 120 }).carbToleranceGPerHour).toBe(90);
    expect(sanitizeAthleteProfile({ carbToleranceGPerHour: 75 }).carbToleranceGPerHour).toBe(75);
    expect(sanitizeAthleteProfile({ carbToleranceGPerHour: 10 }).carbToleranceGPerHour).toBe(20);
    expect(sanitizeAthleteProfile({ carbToleranceGPerHour: 0 }).carbToleranceGPerHour).toBe(20);
    updateAthleteProfile({ carbToleranceGPerHour: 100 });
    expect(getAthleteProfile().carbToleranceGPerHour).toBe(CARB_TOLERANCE_MAX_G_PER_HOUR);
  });

  it('stores the salty-sweater flag (R-2) and drops junk', () => {
    expect(sanitizeAthleteProfile({ saltySweater: true }).saltySweater).toBe(true);
    expect(sanitizeAthleteProfile({ saltySweater: 'yes' }).saltySweater).toBeUndefined();
  });
});
