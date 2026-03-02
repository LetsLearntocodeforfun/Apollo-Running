/**
 * Tests for courseTraining.ts — Course-Specific Training Recommendations
 */

import { describe, it, expect } from 'vitest';
import {
  generateCourseTraining,
  getKeyWorkouts,
} from '@/services/courseTraining';
import type { MarathonRace } from '@/types/raceStrategy';

function makeRace(overrides: Partial<MarathonRace> = {}): MarathonRace {
  return {
    id: 'test-race',
    name: 'Test Marathon',
    city: 'Test City',
    country: 'US',
    category: 'other',
    date: '2025-10-15',
    typicalMonth: 10,
    distanceMi: 26.2,
    courseType: 'loop',
    typicalTempF: { low: 45, high: 60 },
    typicalHumidity: 50,
    website: 'https://example.com',
    startTime: '7:00 AM',
    timeLimitHours: 6,
    fieldSize: 10000,
    isWorldMajor: false,
    year: 2025,
    courseDescription: 'A test marathon',
    qualifyingInfo: 'None',
    tips: [],
    course: {
      totalGainFt: 200,
      totalLossFt: 200,
      netChangeFt: 0,
      highPointFt: 100,
      lowPointFt: 0,
      difficulty: 3,
      bqFriendly: true,
      prFriendly: true,
      elevationPoints: [],
      aidStations: [],
      courseSplits: [],
    },
    ...overrides,
  } as MarathonRace;
}

describe('generateCourseTraining', () => {
  it('should generate a plan for Boston', () => {
    const race = makeRace({ name: 'Boston Marathon', city: 'Boston' });
    const plan = generateCourseTraining(race);
    expect(plan.raceName).toBe('Boston Marathon');
    expect(plan.keyWorkouts.length).toBeGreaterThanOrEqual(3);
    // Should include hill workouts
    const hillWorkouts = plan.keyWorkouts.filter((w) => w.category === 'hill');
    expect(hillWorkouts.length).toBeGreaterThanOrEqual(2);
  });

  it('should generate a plan for NYC', () => {
    const race = makeRace({ name: 'NYC Marathon', city: 'New York' });
    const plan = generateCourseTraining(race);
    expect(plan.keyWorkouts.length).toBeGreaterThanOrEqual(3);
    // Should mention bridges
    const hasBridge = plan.keyWorkouts.some((w) =>
      w.description.toLowerCase().includes('bridge'),
    );
    expect(hasBridge).toBe(true);
  });

  it('should generate a plan for Berlin', () => {
    const race = makeRace({ name: 'Berlin Marathon', city: 'Berlin' });
    const plan = generateCourseTraining(race);
    // Berlin should focus on pace consistency
    const tempoWorkouts = plan.keyWorkouts.filter((w) => w.category === 'tempo');
    expect(tempoWorkouts.length).toBeGreaterThanOrEqual(2);
  });

  it('should generate a plan for Chicago', () => {
    const race = makeRace({ name: 'Chicago Marathon', city: 'Chicago' });
    const plan = generateCourseTraining(race);
    expect(plan.keyWorkouts.length).toBeGreaterThanOrEqual(2);
    // Should mention wind
    const hasWind = plan.keyWorkouts.some((w) =>
      w.description.toLowerCase().includes('wind'),
    );
    expect(hasWind).toBe(true);
  });

  it('should generate a plan for Tokyo', () => {
    const race = makeRace({ name: 'Tokyo Marathon', city: 'Tokyo' });
    const plan = generateCourseTraining(race);
    expect(plan.keyWorkouts.length).toBeGreaterThanOrEqual(2);
  });

  it('should generate a plan for London', () => {
    const race = makeRace({ name: 'London Marathon', city: 'London' });
    const plan = generateCourseTraining(race);
    expect(plan.keyWorkouts.length).toBeGreaterThanOrEqual(2);
    // Should mention cobblestone or varied surfaces
    const hasSurface = plan.keyWorkouts.some((w) =>
      w.description.toLowerCase().includes('cobble') ||
      w.description.toLowerCase().includes('surface'),
    );
    expect(hasSurface).toBe(true);
  });

  it('should generate a generic plan for unknown races', () => {
    const race = makeRace({ name: 'My Local Marathon', city: 'Smallville' });
    const plan = generateCourseTraining(race);
    expect(plan.keyWorkouts.length).toBeGreaterThanOrEqual(1);
    expect(plan.weeklyGuidance.length).toBeGreaterThan(0);
  });

  it('should generate hill-heavy plan for difficult courses', () => {
    const race = makeRace({
      name: 'Mountain Marathon', city: 'Denver',
      course: {
        totalGainFt: 2000, totalLossFt: 2000, netChangeFt: 0,
        highPointFt: 500, lowPointFt: 0, difficulty: 8,
        bqFriendly: false, prFriendly: false,
        elevationPoints: [],
      },
    });
    const plan = generateCourseTraining(race);
    const hillWorkouts = plan.keyWorkouts.filter((w) => w.category === 'hill');
    expect(hillWorkouts.length).toBeGreaterThanOrEqual(2);
  });

  it('should generate flat-focused plan for easy courses', () => {
    const race = makeRace({
      name: 'Flat Fast Marathon', city: 'Flatland',
      course: {
        totalGainFt: 50, totalLossFt: 50, netChangeFt: 0,
        highPointFt: 20, lowPointFt: 0, difficulty: 1,
        bqFriendly: true, prFriendly: true,
        elevationPoints: [],
      },
    });
    const plan = generateCourseTraining(race);
    const hasTempoOrLongRun = plan.keyWorkouts.some((w) =>
      w.category === 'tempo' || w.category === 'long_run',
    );
    expect(hasTempoOrLongRun).toBe(true);
  });

  it('should include taper notes and race execution tips', () => {
    const race = makeRace({ name: 'Boston Marathon', city: 'Boston' });
    const plan = generateCourseTraining(race);
    expect(plan.taperNotes.length).toBeGreaterThan(0);
    expect(plan.raceExecutionTips.length).toBeGreaterThan(0);
  });
});

describe('getKeyWorkouts', () => {
  it('should return workouts sorted by priority', () => {
    const race = makeRace({ name: 'Boston Marathon', city: 'Boston' });
    const workouts = getKeyWorkouts(race);
    expect(workouts.length).toBeGreaterThanOrEqual(3);
    // Priority 1 items should come first
    for (let i = 1; i < workouts.length; i++) {
      expect(workouts[i].priority).toBeGreaterThanOrEqual(workouts[i - 1].priority);
    }
  });
});
