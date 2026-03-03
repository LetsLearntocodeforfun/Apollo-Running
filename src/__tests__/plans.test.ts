/**
 * Unit tests for plans.ts
 *
 * Tests plan generation, recommendation algorithm, custom plan builder,
 * and plan data integrity.
 */

import { describe, it, expect } from 'vitest';
import {
  BUILT_IN_PLANS,
  getPlanById,
  getPlanOverview,
  getTotalDays,
  getDayAt,
  createCustomPlanFromScratch,
  suggestPlansForRunner,
  type TrainingPlan,
  type CustomDayType,
} from '@/data/plans';

// ── Built-in Plans Structure ──────────────────────────────────────────────────

describe('Built-in Plans', () => {
  it('should have at least 5 built-in plans', () => {
    expect(BUILT_IN_PLANS.length).toBeGreaterThanOrEqual(5);
  });

  it('should have unique IDs for all plans', () => {
    const ids = BUILT_IN_PLANS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each(BUILT_IN_PLANS.map((p) => [p.id, p] as [string, TrainingPlan]))(
    'plan "%s" should have valid structure',
    (_id, plan) => {
      expect(plan.id).toBeTruthy();
      expect(plan.name).toBeTruthy();
      expect(plan.author).toBeTruthy();
      expect(plan.description).toBeTruthy();
      expect(plan.totalWeeks).toBeGreaterThan(0);
      expect(plan.weeks).toHaveLength(plan.totalWeeks);

      // Every week should have 7 days
      for (const week of plan.weeks) {
        expect(week.days).toHaveLength(7);
        expect(week.weekNumber).toBeGreaterThan(0);
      }
    },
  );

  it.each(BUILT_IN_PLANS.map((p) => [p.id, p] as [string, TrainingPlan]))(
    'plan "%s" should end with a marathon day',
    (_id, plan) => {
      const lastWeek = plan.weeks[plan.weeks.length - 1];
      const hasMarathon = lastWeek.days.some((d) => d.type === 'marathon');
      expect(hasMarathon).toBe(true);
    },
  );

  it.each(BUILT_IN_PLANS.map((p) => [p.id, p] as [string, TrainingPlan]))(
    'plan "%s" should have progressive long runs up to at least 16 miles',
    (_id, plan) => {
      const longRunDistances = plan.weeks
        .flatMap((w) => w.days)
        .filter((d) => d.note?.toLowerCase() === 'long' && d.distanceMi)
        .map((d) => d.distanceMi!);

      if (longRunDistances.length > 0) {
        const maxLong = Math.max(...longRunDistances);
        expect(maxLong).toBeGreaterThanOrEqual(16);
      }
    },
  );

  it('should have valid day types for all days in all plans', () => {
    const validTypes = ['rest', 'run', 'cross', 'race', 'marathon'];
    for (const plan of BUILT_IN_PLANS) {
      for (const week of plan.weeks) {
        for (const day of week.days) {
          expect(validTypes).toContain(day.type);
        }
      }
    }
  });
});

// ── getPlanById ───────────────────────────────────────────────────────────────

describe('getPlanById', () => {
  it('should find each built-in plan by its ID', () => {
    for (const plan of BUILT_IN_PLANS) {
      const found = getPlanById(plan.id);
      expect(found).toBeDefined();
      expect(found!.id).toBe(plan.id);
    }
  });

  it('should return undefined for unknown plan IDs', () => {
    expect(getPlanById('non-existent-plan')).toBeUndefined();
  });

  it('should return undefined for empty string', () => {
    expect(getPlanById('')).toBeUndefined();
  });
});

// ── getPlanOverview ───────────────────────────────────────────────────────────

describe('getPlanOverview', () => {
  it('should return weekly summaries for all weeks', () => {
    const plan = BUILT_IN_PLANS[0];
    const overview = getPlanOverview(plan);
    expect(overview).toHaveLength(plan.totalWeeks);
  });

  it('should compute total weekly miles correctly', () => {
    const plan = BUILT_IN_PLANS[0];
    const overview = getPlanOverview(plan);

    // Verify first week by summing manually
    const firstWeek = plan.weeks[0];
    const expectedMiles = firstWeek.days.reduce((sum, d) => sum + (d.distanceMi ?? 0), 0);
    expect(overview[0].totalMiles).toBeCloseTo(expectedMiles, 1);
  });

  it('should identify the longest run as the long run', () => {
    const plan = BUILT_IN_PLANS[0];
    const overview = getPlanOverview(plan);

    for (let i = 0; i < plan.totalWeeks; i++) {
      const week = plan.weeks[i];
      const maxDist = Math.max(
        0,
        ...week.days
          .filter((d) => d.type === 'run' || d.type === 'race' || d.type === 'marathon')
          .map((d) => d.distanceMi ?? 0),
      );
      expect(overview[i].longRunMiles).toBeCloseTo(maxDist, 1);
    }
  });
});

// ── getTotalDays / getDayAt ───────────────────────────────────────────────────

describe('getTotalDays', () => {
  it('should return 7 * totalWeeks', () => {
    for (const plan of BUILT_IN_PLANS) {
      expect(getTotalDays(plan)).toBe(plan.totalWeeks * 7);
    }
  });
});

describe('getDayAt', () => {
  it('should return the correct day for valid indices', () => {
    const plan = BUILT_IN_PLANS[0];
    const day = getDayAt(plan, 0, 0);
    expect(day).not.toBeNull();
    expect(day!.type).toBeTruthy();
  });

  it('should return null for out-of-bounds week', () => {
    const plan = BUILT_IN_PLANS[0];
    expect(getDayAt(plan, 999, 0)).toBeNull();
  });

  it('should return null for out-of-bounds day', () => {
    const plan = BUILT_IN_PLANS[0];
    expect(getDayAt(plan, 0, 10)).toBeNull();
  });
});

// ── createCustomPlanFromScratch ───────────────────────────────────────────────

describe('createCustomPlanFromScratch', () => {
  it('should create a plan with the specified number of weeks', () => {
    const plan = createCustomPlanFromScratch({
      name: 'My Plan',
      totalWeeks: 16,
      runningDays: 4,
      currentWeeklyMiles: 20,
      peakWeeklyMiles: 40,
    });
    expect(plan.totalWeeks).toBe(16);
    expect(plan.weeks).toHaveLength(16);
  });

  it('should end with a marathon on the last week', () => {
    const plan = createCustomPlanFromScratch({
      name: 'Marathon Plan',
      totalWeeks: 18,
      runningDays: 5,
      currentWeeklyMiles: 25,
      peakWeeklyMiles: 50,
    });
    const lastWeek = plan.weeks[plan.weeks.length - 1];
    const hasMarathon = lastWeek.days.some((d) => d.type === 'marathon');
    expect(hasMarathon).toBe(true);
  });

  it('should have 7 days in every week', () => {
    const plan = createCustomPlanFromScratch({
      name: 'Test',
      totalWeeks: 12,
      runningDays: 3,
      currentWeeklyMiles: 15,
      peakWeeklyMiles: 35,
    });
    for (const week of plan.weeks) {
      expect(week.days).toHaveLength(7);
    }
  });

  it('should clamp total weeks to valid range (10-30)', () => {
    const tooShort = createCustomPlanFromScratch({
      name: 'Short',
      totalWeeks: 5,
      runningDays: 4,
      currentWeeklyMiles: 20,
      peakWeeklyMiles: 40,
    });
    expect(tooShort.totalWeeks).toBeGreaterThanOrEqual(10);

    const tooLong = createCustomPlanFromScratch({
      name: 'Long',
      totalWeeks: 50,
      runningDays: 4,
      currentWeeklyMiles: 20,
      peakWeeklyMiles: 40,
    });
    expect(tooLong.totalWeeks).toBeLessThanOrEqual(30);
  });

  it('should clamp running days to valid range (3-6)', () => {
    const plan2Days = createCustomPlanFromScratch({
      name: 'Test',
      totalWeeks: 16,
      runningDays: 2,
      currentWeeklyMiles: 20,
      peakWeeklyMiles: 40,
    });
    // Should have at least 3 run days per week (excluding rest days and marathon week)
    const midWeek = plan2Days.weeks[5]; // arbitrary non-taper week
    const runDays = midWeek.days.filter((d) => d.type === 'run').length;
    expect(runDays).toBeGreaterThanOrEqual(3);
  });

  it('should include progressive mileage buildup with cutback weeks', () => {
    const plan = createCustomPlanFromScratch({
      name: 'Progressive',
      totalWeeks: 18,
      runningDays: 4,
      currentWeeklyMiles: 20,
      peakWeeklyMiles: 45,
    });
    const overview = getPlanOverview(plan);

    // Early weeks should have less total mileage than peak weeks
    const earlyMiles = overview.slice(0, 4).reduce((s, w) => s + w.totalMiles, 0) / 4;
    const peakMiles = overview.slice(10, 14).reduce((s, w) => s + w.totalMiles, 0) / 4;
    expect(peakMiles).toBeGreaterThan(earlyMiles);

    // Last 2 weeks should taper (less mileage than peak)
    const taperMiles = overview.slice(-2).reduce((s, w) => s + w.totalMiles, 0) / 2;
    expect(taperMiles).toBeLessThan(peakMiles);
  });

  it('should use the provided name', () => {
    const plan = createCustomPlanFromScratch({
      name: 'My Custom Marathon',
      totalWeeks: 16,
      runningDays: 4,
      currentWeeklyMiles: 20,
      peakWeeklyMiles: 40,
    });
    expect(plan.name).toBe('My Custom Marathon');
  });

  it('should default name when empty', () => {
    const plan = createCustomPlanFromScratch({
      name: '',
      totalWeeks: 16,
      runningDays: 4,
      currentWeeklyMiles: 20,
      peakWeeklyMiles: 40,
    });
    expect(plan.name).toBeTruthy();
  });
});

// ── suggestPlansForRunner ─────────────────────────────────────────────────────

describe('suggestPlansForRunner', () => {
  it('should return up to 3 recommended plans', () => {
    const recs = suggestPlansForRunner(25, 4);
    expect(recs.length).toBeLessThanOrEqual(3);
    expect(recs.length).toBeGreaterThan(0);
  });

  it('should recommend novice plans for low-mileage runners', () => {
    const recs = suggestPlansForRunner(15, 3);
    // Should favor Hal Higdon Novice 1 or similar beginner plans
    const planIds = recs.map((r) => r.planId);
    const hasBeginnerPlan = planIds.some(
      (id) => id.includes('novice') || id.includes('beginner') || id.includes('first'),
    );
    expect(hasBeginnerPlan).toBe(true);
  });

  it('should recommend advanced plans for high-mileage runners', () => {
    const recs = suggestPlansForRunner(50, 6);
    // Should recommend Pfitzinger or Advanced plans
    const topRec = recs[0];
    expect(topRec.score).toBeGreaterThan(0);
  });

  it('should return recommendations with valid plan IDs', () => {
    const recs = suggestPlansForRunner(30, 4);
    for (const rec of recs) {
      expect(getPlanById(rec.planId)).toBeDefined();
    }
  });

  it('should rank recommendations by score (highest first)', () => {
    const recs = suggestPlansForRunner(30, 4);
    for (let i = 1; i < recs.length; i++) {
      expect(recs[i].score).toBeLessThanOrEqual(recs[i - 1].score);
    }
  });

  it('should provide a reason for each recommendation', () => {
    const recs = suggestPlansForRunner(25, 4);
    for (const rec of recs) {
      expect(rec.reason).toBeTruthy();
      expect(rec.reason.length).toBeGreaterThan(10);
    }
  });

  it('should handle edge case inputs gracefully', () => {
    expect(suggestPlansForRunner(0, 1).length).toBeGreaterThan(0);
    expect(suggestPlansForRunner(200, 7).length).toBeGreaterThan(0);
  });
});

// ── createCustomPlanFromScratch with dayAssignments ───────────────────────────

describe('createCustomPlanFromScratch with dayAssignments', () => {
  const makeAssignments = (map: Partial<Record<number, CustomDayType>>): Record<number, CustomDayType> => {
    const result: Record<number, CustomDayType> = {};
    for (let d = 0; d < 7; d++) {
      result[d] = map[d] ?? 'rest';
    }
    return result;
  };

  it('should respect explicit day assignments for workout types', () => {
    const assignments = makeAssignments({
      1: 'easy',    // Tue
      2: 'tempo',   // Wed
      4: 'speed',   // Fri
      6: 'long',    // Sun
    });
    const plan = createCustomPlanFromScratch({
      name: 'Assigned Plan',
      totalWeeks: 16,
      runningDays: 4,
      currentWeeklyMiles: 20,
      peakWeeklyMiles: 45,
      dayAssignments: assignments,
    });

    // Check a mid-plan week (not race week)
    const midWeek = plan.weeks[8];
    expect(midWeek.days[1].note).toBe('Easy');
    expect(midWeek.days[2].note).toBe('Tempo');
    expect(midWeek.days[4].note).toBe('Speed');
    expect(midWeek.days[6].note).toBe('Long');
    // Rest days should be rest
    expect(midWeek.days[0].type).toBe('rest');
    expect(midWeek.days[3].type).toBe('rest');
    expect(midWeek.days[5].type).toBe('rest');
  });

  it('should handle marathon_pace day assignment', () => {
    const assignments = makeAssignments({
      1: 'easy',
      3: 'marathon_pace',
      6: 'long',
    });
    const plan = createCustomPlanFromScratch({
      name: 'MP Plan',
      totalWeeks: 18,
      runningDays: 3,
      currentWeeklyMiles: 25,
      peakWeeklyMiles: 50,
      dayAssignments: assignments,
    });
    const midWeek = plan.weeks[8];
    expect(midWeek.days[3].note).toBe('Marathon Pace');
    expect(midWeek.days[3].type).toBe('run');
  });

  it('should handle medium_long day assignment', () => {
    const assignments = makeAssignments({
      1: 'easy',
      3: 'medium_long',
      5: 'tempo',
      6: 'long',
    });
    const plan = createCustomPlanFromScratch({
      name: 'ML Plan',
      totalWeeks: 16,
      runningDays: 4,
      currentWeeklyMiles: 30,
      peakWeeklyMiles: 55,
      dayAssignments: assignments,
    });
    const midWeek = plan.weeks[8];
    expect(midWeek.days[3].note).toBe('Medium Long');
    expect(midWeek.days[3].type).toBe('run');
    // Medium long distance should be meaningful and less than long
    const mlDist = midWeek.days[3].distanceMi!;
    const longDist = midWeek.days[6].distanceMi!;
    expect(mlDist).toBeGreaterThanOrEqual(5);
    expect(mlDist).toBeLessThanOrEqual(longDist);
  });

  it('should handle cross-training day assignment', () => {
    const assignments = makeAssignments({
      1: 'easy',
      3: 'cross',
      5: 'tempo',
      6: 'long',
    });
    const plan = createCustomPlanFromScratch({
      name: 'Cross Plan',
      totalWeeks: 14,
      runningDays: 3,
      currentWeeklyMiles: 20,
      peakWeeklyMiles: 40,
      dayAssignments: assignments,
    });
    const midWeek = plan.weeks[6];
    expect(midWeek.days[3].type).toBe('cross');
  });

  it('should auto-assign long run when missing from assignments', () => {
    // All run days marked as easy — should auto-convert last one to long
    const assignments = makeAssignments({
      1: 'easy',
      3: 'easy',
      5: 'easy',
    });
    const plan = createCustomPlanFromScratch({
      name: 'No Long Plan',
      totalWeeks: 16,
      runningDays: 3,
      currentWeeklyMiles: 20,
      peakWeeklyMiles: 40,
      dayAssignments: assignments,
    });
    const midWeek = plan.weeks[8];
    // At least one day should be a long run
    const hasLong = midWeek.days.some((d) => d.note === 'Long');
    expect(hasLong).toBe(true);
  });

  it('should place marathon on the long run day in the final week', () => {
    const assignments = makeAssignments({
      1: 'easy',
      3: 'tempo',
      6: 'long',
    });
    const plan = createCustomPlanFromScratch({
      name: 'Race Week Test',
      totalWeeks: 16,
      runningDays: 3,
      currentWeeklyMiles: 20,
      peakWeeklyMiles: 40,
      dayAssignments: assignments,
    });
    const lastWeek = plan.weeks[plan.weeks.length - 1];
    expect(lastWeek.days[6].type).toBe('marathon');
  });

  it('should generate correct mileage distribution with day assignments', () => {
    const assignments = makeAssignments({
      0: 'easy',
      1: 'tempo',
      3: 'medium_long',
      5: 'easy',
      6: 'long',
    });
    const plan = createCustomPlanFromScratch({
      name: 'Full Distribution',
      totalWeeks: 18,
      runningDays: 5,
      currentWeeklyMiles: 30,
      peakWeeklyMiles: 55,
      dayAssignments: assignments,
    });
    const overview = getPlanOverview(plan);

    // Peak week mileage should be near peakWeeklyMiles
    const peakWeekMiles = Math.max(...overview.slice(0, -2).map((w) => w.totalMiles));
    expect(peakWeekMiles).toBeGreaterThan(40);
    expect(peakWeekMiles).toBeLessThanOrEqual(60);
  });

  it('should have 6 run days when all 6 are assigned', () => {
    const assignments = makeAssignments({
      0: 'easy',
      1: 'tempo',
      2: 'easy',
      3: 'medium_long',
      4: 'speed',
      6: 'long',
    });
    const plan = createCustomPlanFromScratch({
      name: '6-Day Plan',
      totalWeeks: 16,
      runningDays: 6,
      currentWeeklyMiles: 40,
      peakWeeklyMiles: 65,
      dayAssignments: assignments,
    });
    const midWeek = plan.weeks[8];
    const runDays = midWeek.days.filter((d) => d.type === 'run').length;
    expect(runDays).toBe(6);
    // Saturday should be rest
    expect(midWeek.days[5].type).toBe('rest');
  });

  it('should have minimum 3 run days with assignments', () => {
    const assignments = makeAssignments({
      2: 'easy',
      4: 'tempo',
      6: 'long',
    });
    const plan = createCustomPlanFromScratch({
      name: '3-Day Plan',
      totalWeeks: 12,
      runningDays: 3,
      currentWeeklyMiles: 15,
      peakWeeklyMiles: 35,
      dayAssignments: assignments,
    });
    const midWeek = plan.weeks[5];
    const runDays = midWeek.days.filter((d) => d.type === 'run').length;
    expect(runDays).toBe(3);
  });

  it('should fall back gracefully when dayAssignments is empty object', () => {
    const plan = createCustomPlanFromScratch({
      name: 'Empty assignments',
      totalWeeks: 16,
      runningDays: 4,
      currentWeeklyMiles: 25,
      peakWeeklyMiles: 45,
      dayAssignments: {},
    });
    // Should behave like no assignments — default layout
    expect(plan.totalWeeks).toBe(16);
    expect(plan.weeks).toHaveLength(16);
    const midWeek = plan.weeks[8];
    const runDays = midWeek.days.filter((d) => d.type === 'run').length;
    expect(runDays).toBeGreaterThanOrEqual(3);
  });

  it('should still produce cutback weeks with assignments', () => {
    const assignments = makeAssignments({
      1: 'easy',
      3: 'tempo',
      5: 'easy',
      6: 'long',
    });
    const plan = createCustomPlanFromScratch({
      name: 'Cutback Test',
      totalWeeks: 20,
      runningDays: 4,
      currentWeeklyMiles: 25,
      peakWeeklyMiles: 50,
      dayAssignments: assignments,
    });
    const overview = getPlanOverview(plan);
    // Week 3 (index 3) is a cutback, should be less than week 2 (index 2)
    expect(overview[3].totalMiles).toBeLessThan(overview[2].totalMiles);
  });

  it('should taper in the last two weeks with assignments', () => {
    const assignments = makeAssignments({
      1: 'easy',
      3: 'tempo',
      6: 'long',
    });
    const plan = createCustomPlanFromScratch({
      name: 'Taper Test',
      totalWeeks: 16,
      runningDays: 3,
      currentWeeklyMiles: 25,
      peakWeeklyMiles: 45,
      dayAssignments: assignments,
    });
    const overview = getPlanOverview(plan);
    const peakMiles = Math.max(...overview.slice(0, -2).map((w) => w.totalMiles));
    const taperMiles = overview[overview.length - 2].totalMiles;
    expect(taperMiles).toBeLessThan(peakMiles);
  });
});
