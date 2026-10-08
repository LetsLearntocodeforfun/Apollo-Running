/**
 * Tests for courseTraining.ts — Course-Specific Training Recommendations
 */

import { describe, it, expect } from 'vitest';
import {
  generateCourseTraining,
  getKeyWorkouts,
  groupWorkoutsByWindow,
  identifyWorldMajor,
  getCourseFacts,
  parseWeeksOut,
  type CourseWorkout,
} from '@/services/courseTraining';
import { getMarathonById } from '@/data/worldMajors';
import { importCustomMarathon } from '@/services/raceStrategy';
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

/**
 * A World Major fixture. v1.0.6 (L-36): majors are identified by id + the
 * World Major flag, so the old name-only fixtures ('Boston Marathon' with
 * id 'test-race') encoded the substring-matching bug and were updated.
 */
function makeMajor(id: string, name: string, city: string): MarathonRace {
  return makeRace({ id, name, city, isWorldMajor: true, category: 'world-major' });
}

const allText = (plan: object): string => JSON.stringify(plan);

describe('generateCourseTraining', () => {
  it('should generate a plan for Boston', () => {
    const race = makeMajor('boston', 'Boston Marathon', 'Boston');
    const plan = generateCourseTraining(race);
    expect(plan.raceName).toBe('Boston Marathon');
    expect(plan.keyWorkouts.length).toBeGreaterThanOrEqual(3);
    // Should include hill workouts
    const hillWorkouts = plan.keyWorkouts.filter((w) => w.category === 'hill');
    expect(hillWorkouts.length).toBeGreaterThanOrEqual(2);
  });

  it('should generate a plan for NYC', () => {
    const race = makeMajor('nyc', 'NYC Marathon', 'New York');
    const plan = generateCourseTraining(race);
    expect(plan.keyWorkouts.length).toBeGreaterThanOrEqual(3);
    // Should mention bridges
    const hasBridge = plan.keyWorkouts.some((w) =>
      w.description.toLowerCase().includes('bridge'),
    );
    expect(hasBridge).toBe(true);
  });

  it('should generate a plan for Berlin', () => {
    const race = makeMajor('berlin', 'Berlin Marathon', 'Berlin');
    const plan = generateCourseTraining(race);
    // Berlin should focus on pace consistency
    const tempoWorkouts = plan.keyWorkouts.filter((w) => w.category === 'tempo');
    expect(tempoWorkouts.length).toBeGreaterThanOrEqual(2);
  });

  it('should generate a plan for Chicago', () => {
    const race = makeMajor('chicago', 'Chicago Marathon', 'Chicago');
    const plan = generateCourseTraining(race);
    expect(plan.keyWorkouts.length).toBeGreaterThanOrEqual(2);
    // Should mention wind
    const hasWind = plan.keyWorkouts.some((w) =>
      w.description.toLowerCase().includes('wind'),
    );
    expect(hasWind).toBe(true);
  });

  it('should generate a plan for Tokyo', () => {
    const race = makeMajor('tokyo', 'Tokyo Marathon', 'Tokyo');
    const plan = generateCourseTraining(race);
    expect(plan.keyWorkouts.length).toBeGreaterThanOrEqual(2);
  });

  it('should generate a plan for London', () => {
    const race = makeMajor('london', 'London Marathon', 'London');
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
    const race = makeMajor('boston', 'Boston Marathon', 'Boston');
    const plan = generateCourseTraining(race);
    expect(plan.taperNotes.length).toBeGreaterThan(0);
    expect(plan.raceExecutionTips.length).toBeGreaterThan(0);
  });
});

describe('getKeyWorkouts', () => {
  it('should return workouts sorted by priority', () => {
    const race = makeMajor('boston', 'Boston Marathon', 'Boston');
    const workouts = getKeyWorkouts(race);
    expect(workouts.length).toBeGreaterThanOrEqual(3);
    // Priority 1 items should come first
    for (let i = 1; i < workouts.length; i++) {
      expect(workouts[i].priority).toBeGreaterThanOrEqual(workouts[i - 1].priority);
    }
  });
});

// ── v1.0.6 regressions ────────────────────────────────────────────────────────

describe('L-36 — World Majors are matched by id, never by name', () => {
  it('a custom "Boston Run to Remember Half" gets the generic plan (no Newton hills)', () => {
    const half = importCustomMarathon({
      name: 'Boston Run to Remember Half', city: 'Boston', country: 'United States',
      date: '2027-05-30', courseType: 'loop', distanceMi: 13.1,
    });
    expect(identifyWorldMajor(half)).toBeNull();
    const plan = generateCourseTraining(half);
    expect(plan.source).toBe('generic');
    expect(allText(plan)).not.toMatch(/newton|heartbreak/i);
  });

  it('the stable "boston" id gets the Boston plan', () => {
    const boston = getMarathonById('boston', '2027-01-01')!;
    const plan = generateCourseTraining(boston);
    expect(plan.source).toBe('boston');
    expect(plan.keyWorkouts.some((w) => w.name === 'Newton Hills Simulation')).toBe(true);
  });

  it('a legacy "boston-marathon-2026" race gets the Boston plan', () => {
    const legacy = { ...getMarathonById('boston', '2026-01-01')!, id: 'boston-marathon-2026' };
    expect(identifyWorldMajor(legacy)).toBe('boston');
    expect(generateCourseTraining(legacy).source).toBe('boston');
  });

  it('a major id without the World Major flag is not treated as a major', () => {
    expect(identifyWorldMajor(makeRace({ id: 'boston', category: 'custom', isWorldMajor: false }))).toBeNull();
    expect(identifyWorldMajor(makeRace({ id: 'boston', category: 'world-major' }))).toBe('boston');
    expect(identifyWorldMajor(makeRace({ id: 'boston', isWorldMajor: true, distanceMi: 13.1 }))).toBeNull();
  });

  it('a name-only race called "Boston Marathon" is generic', () => {
    const plan = generateCourseTraining(makeRace({ name: 'Boston Marathon', city: 'Boston' }));
    expect(plan.source).toBe('generic');
  });
});

describe('L-37 — no shared state is mutated', () => {
  it('getKeyWorkouts does not reorder later plans', () => {
    const nyc = makeMajor('nyc', 'TCS New York City Marathon', 'New York City');
    const before = generateCourseTraining(nyc).keyWorkouts.map((w) => w.name);
    getKeyWorkouts(nyc);
    getKeyWorkouts(nyc);
    expect(generateCourseTraining(nyc).keyWorkouts.map((w) => w.name)).toEqual(before);
  });

  it('mutating a returned plan does not leak into the next call', () => {
    const nyc = makeMajor('nyc', 'TCS New York City Marathon', 'New York City');
    const fresh = generateCourseTraining(nyc);
    const mutated = generateCourseTraining(nyc);
    mutated.keyWorkouts.reverse();
    mutated.keyWorkouts[0].name = 'CHANGED';
    mutated.weeklyGuidance.push('extra');
    mutated.raceExecutionTips.length = 0;
    expect(generateCourseTraining(nyc)).toEqual(fresh);
  });
});

describe('L-38 — net drop and distance', () => {
  it('a big net-downhill custom course gets eccentric downhill prep, not the flat plan', () => {
    const race = importCustomMarathon({
      name: 'Canyon Drop Marathon', city: 'Somewhere', country: 'United States',
      date: '2027-06-05', courseType: 'point-to-point',
      elevationGainFt: 300, elevationLossFt: 5300,
    });
    expect(getCourseFacts(race).netDropFt).toBe(5000);
    const plan = generateCourseTraining(race);
    expect(plan.source).toBe('generic');
    const downhill = plan.keyWorkouts.filter((w) => /downhill/i.test(w.name));
    expect(downhill.length).toBeGreaterThanOrEqual(2);
    const prep = plan.keyWorkouts.find((w) => w.name === 'Eccentric Downhill Prep')!;
    expect(prep.priority).toBe(1);
    expect(prep.description).toMatch(/2-4 %/);
    expect(prep.description).toMatch(/final 10 days/);
    expect(plan.taperNotes.some((t) => /final 10 days/.test(t))).toBe(true);
    expect(allText(plan)).not.toMatch(/Flat course/);
    expect(allText(plan)).not.toMatch(/sprints down|downhill sprints/i);
  });

  it('net drop comes from gain/loss even when netChangeFt has the wrong sign', () => {
    const race = makeRace({
      course: {
        totalGainFt: 300, totalLossFt: 5300, netChangeFt: 5000,
        highPointFt: 5400, lowPointFt: 100, difficulty: 2,
        bqFriendly: true, prFriendly: true, elevationPoints: [],
      },
    });
    expect(getCourseFacts(race).netDropFt).toBe(5000);
  });

  it('half-marathon long runs are 10-13 mi / 90-120 min, never 18-20 mi', () => {
    const half = importCustomMarathon({
      name: 'Hilly Harbour Half', city: 'Anywhere', country: 'United States',
      date: '2027-04-04', courseType: 'loop', distanceMi: 13.1,
      elevationGainFt: 900, elevationLossFt: 900, difficulty: 7,
    });
    const flatHalf = makeRace({ distanceMi: 13.1 });
    for (const race of [half, flatHalf]) {
      const plan = generateCourseTraining(race);
      const text = allText(plan);
      expect(text).not.toMatch(/18-20|\b20 mi\b|\b20 miles\b/);
      expect(text).toMatch(/10-13 mi \(90-120 min\)/);
    }
  });

  it('races longer than a marathon talk about time on feet', () => {
    const plan = generateCourseTraining(makeRace({ distanceMi: 31.1 }));
    expect(allText(plan)).toMatch(/time on feet/i);
  });

  it('copes with partial race objects (no loss, net change or distance)', () => {
    const partial = { name: 'Mountain Marathon', city: 'Denver', courseType: 'out-and-back', course: { totalGainFt: 2000, difficulty: 8 } };
    const plan = generateCourseTraining(partial as unknown as MarathonRace);
    expect(plan.source).toBe('generic');
    expect(plan.keyWorkouts.some((w) => w.category === 'hill')).toBe(true);
    expect(allText(plan)).not.toMatch(/NaN|undefined/);
  });
});

describe('L-39 — course facts', () => {
  const plan = (id: string) => generateCourseTraining(makeMajor(id, id, id));

  it('Boston: a west wind is a tailwind, never a headwind', () => {
    const text = allText(plan('boston'));
    expect(text).toMatch(/west wind is a tailwind/i);
    expect(text).toMatch(/easterly sea-breeze headwind/i);
    expect(text).not.toMatch(/(west(erly)?\s+wind|wind\s+from\s+the\s+west)[^.]*headwind/i);
  });

  it('NYC: mile 1 climbs the Verrazzano-Narrows Bridge and mile 2 descends', () => {
    const p = plan('nyc');
    const text = allText(p);
    expect(p.raceExecutionTips.some((t) => /^Mile 1 climbs the Verrazzano/.test(t))).toBe(true);
    expect(text).toMatch(/Mile 2 is the descent/);
    expect(text).not.toMatch(/start is DOWNHILL|pure downhill/i);
  });

  it('London: no climb at mile 3; the early miles are net downhill', () => {
    const text = allText(plan('london'));
    expect(text).not.toMatch(/Shooters Hill|significant climb/i);
    expect(text).toMatch(/net downhill/);
  });

  it('Chicago: Chinatown is a crowd highlight and Roosevelt Road is the only hill', () => {
    const text = allText(plan('chicago'));
    expect(text).not.toMatch(/lonely/i);
    expect(text).toMatch(/Chinatown[^.]*crowd highlight/);
    expect(text).toMatch(/Roosevelt Road/);
    expect(text).not.toMatch(/southwest headwind/i);
  });

  it('no plan prescribes downhill sprints', () => {
    for (const id of ['boston', 'nyc', 'berlin', 'chicago', 'tokyo', 'london']) {
      expect(allText(plan(id))).not.toMatch(/sprints down|downhill sprints/i);
    }
  });

  it('former checklist training items are course workouts (downhill, cobbles)', () => {
    expect(plan('nyc').keyWorkouts.some((w) => /descent/i.test(w.name))).toBe(true);
    expect(plan('berlin').keyWorkouts.some((w) => w.category === 'surface')).toBe(true);
    expect(plan('london').keyWorkouts.some((w) => w.category === 'surface')).toBe(true);
  });
});

describe('L-40 — units', () => {
  it('km copy has no miles, feet or °F', () => {
    const races = [
      ...['boston', 'nyc', 'berlin', 'chicago', 'tokyo', 'london'].map((id) => makeMajor(id, id, id)),
      makeRace(),
      makeRace({ distanceMi: 13.1 }),
      makeRace({ course: { totalGainFt: 2000, totalLossFt: 2000, netChangeFt: 0, highPointFt: 0, lowPointFt: 0, difficulty: 8, bqFriendly: false, prFriendly: false, elevationPoints: [] } }),
      makeRace({ course: { totalGainFt: 300, totalLossFt: 5300, netChangeFt: -5000, highPointFt: 0, lowPointFt: 0, difficulty: 2, bqFriendly: false, prFriendly: false, elevationPoints: [] } }),
    ];
    for (const race of races) {
      const text = allText(generateCourseTraining(race, { unit: 'km' }));
      expect(text, race.id).not.toMatch(/\bmiles?\b|\bmi\b|\bft\b|°F/i);
    }
  });

  it('converts distances, positions and temperatures', () => {
    const boston = generateCourseTraining(makeMajor('boston', 'Boston', 'Boston'), { unit: 'km' });
    expect(allText(boston)).toMatch(/Heartbreak Hill \(km 33\)/);
    expect(allText(boston)).toMatch(/29-32 km/);
    const berlin = generateCourseTraining(makeMajor('berlin', 'Berlin', 'Berlin'), { unit: 'km' });
    expect(allText(berlin)).toMatch(/16-21°C/);
    const berlinF = generateCourseTraining(makeMajor('berlin', 'Berlin', 'Berlin'));
    expect(allText(berlinF)).toMatch(/60-70°F/);
  });
});

describe('groupWorkoutsByWindow', () => {
  const w = (name: string, weeksOut: string, priority: 1 | 2 | 3 = 1): CourseWorkout =>
    ({ name, description: '', weeksOut, category: 'tempo', priority });

  it('parses windows', () => {
    expect(parseWeeksOut('12-16')).toEqual({ min: 12, max: 16 });
    expect(parseWeeksOut('8')).toEqual({ min: 8, max: 8 });
    expect(parseWeeksOut('soon')).toBeNull();
  });

  it('buckets by distance to the window (±1 week counts as now)', () => {
    const input = [w('far', '14-20'), w('edge-far', '11-13'), w('in', '8-12'), w('edge-near', '6-9'), w('near', '3-6'), w('single', '11')];
    const snapshot = input.map((x) => x.name);
    const g = groupWorkoutsByWindow(input, 10);
    expect(g.now.map((x) => x.name).sort()).toEqual(['edge-far', 'edge-near', 'in', 'single']);
    expect(g.upcoming.map((x) => x.name)).toEqual(['near']);
    expect(g.passed.map((x) => x.name)).toEqual(['far']);
    // input untouched
    expect(input.map((x) => x.name)).toEqual(snapshot);
  });

  it('orders upcoming by the window that opens first, then priority', () => {
    const g = groupWorkoutsByWindow([w('a', '2-4', 1), w('b', '6-8', 2), w('c', '6-8', 1)], 20);
    expect(g.upcoming.map((x) => x.name)).toEqual(['c', 'b', 'a']);
  });

  it('puts everything in passed after race day and in upcoming when unknown', () => {
    const items = [w('a', '3-6'), w('b', '8-12')];
    expect(groupWorkoutsByWindow(items, -1).passed).toHaveLength(2);
    expect(groupWorkoutsByWindow(items, Number.NaN).upcoming).toHaveLength(2);
    expect(groupWorkoutsByWindow([w('x', 'whenever')], 10).upcoming).toHaveLength(1);
  });

  it('Boston at 10 weeks out has workouts in all three buckets', () => {
    const plan = generateCourseTraining(getMarathonById('boston', '2027-01-01')!);
    const g = groupWorkoutsByWindow(plan.keyWorkouts, 10);
    expect(g.now.length).toBeGreaterThan(0);
    expect(g.upcoming.length).toBeGreaterThan(0);
    expect(g.passed.length).toBeGreaterThan(0);
    expect(g.now.length + g.upcoming.length + g.passed.length).toBe(plan.keyWorkouts.length);
  });
});
