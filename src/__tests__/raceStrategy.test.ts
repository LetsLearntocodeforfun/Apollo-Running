/**
 * Unit tests for raceStrategy service and worldMajors data.
 *
 * Tests strategy building, pacing calculations, marathon imports,
 * and data integrity of the World Majors database.
 */

import { describe, it, expect } from 'vitest';
import {
  buildRaceStrategy,
  importCustomMarathon,
  removeCustomMarathon,
  getAllMarathons,
  getMarathon,
  getStrategiesForMarathon,
  getAllStrategies,
  deleteStrategy,
  getRaceStrategyPrefs,
  setRaceStrategyPrefs,
  formatPace,
  saveStrategy,
} from '@/services/raceStrategy';
import { WORLD_MAJOR_MARATHONS, getMarathonById, getWorldMajorsByDate, getNextWorldMajor } from '@/data/worldMajors';
import { todayKey } from '@/utils/localDate';

// ── World Majors Data Integrity ───────────────────────────────────────────────

describe('World Major Marathons Database', () => {
  it('should have exactly 6 World Major Marathons', () => {
    expect(WORLD_MAJOR_MARATHONS).toHaveLength(6);
  });

  it('should include all 6 Majors by name', () => {
    const names = WORLD_MAJOR_MARATHONS.map((m) => m.city);
    expect(names).toContain('Tokyo');
    expect(names).toContain('Boston');
    expect(names).toContain('London');
    expect(names).toContain('Berlin');
    expect(names).toContain('Chicago');
    expect(names).toContain('New York City');
  });

  it('all majors should be marked isWorldMajor', () => {
    for (const m of WORLD_MAJOR_MARATHONS) {
      expect(m.isWorldMajor).toBe(true);
      expect(m.category).toBe('world-major');
    }
  });

  it('all majors should be 26.2 miles', () => {
    for (const m of WORLD_MAJOR_MARATHONS) {
      expect(m.distanceMi).toBe(26.2);
    }
  });

  it('all majors should have elevation data with at least 5 points', () => {
    for (const m of WORLD_MAJOR_MARATHONS) {
      expect(m.course.elevationPoints.length).toBeGreaterThanOrEqual(5);
      // First point should be at or near 0
      expect(m.course.elevationPoints[0].distanceMi).toBeLessThanOrEqual(0.5);
      // Last point should be near 26.2
      const lastPoint = m.course.elevationPoints[m.course.elevationPoints.length - 1];
      expect(lastPoint.distanceMi).toBeGreaterThanOrEqual(25);
    }
  });

  it('all majors should have aid stations', () => {
    for (const m of WORLD_MAJOR_MARATHONS) {
      expect(m.aidStations.length).toBeGreaterThanOrEqual(5);
    }
  });

  it('all majors should have splits', () => {
    for (const m of WORLD_MAJOR_MARATHONS) {
      expect(m.splits.length).toBeGreaterThanOrEqual(20);
    }
  });

  it('all majors should have tips', () => {
    for (const m of WORLD_MAJOR_MARATHONS) {
      expect(m.tips.length).toBeGreaterThanOrEqual(3);
    }
  });

  it('should have correct difficulty ratings', () => {
    const berlin = getMarathonById('berlin-marathon-2026');
    const boston = getMarathonById('boston-marathon-2026');
    const nyc = getMarathonById('nyc-marathon-2026');

    expect(berlin!.course.difficulty).toBeLessThanOrEqual(2); // Flattest
    expect(boston!.course.difficulty).toBeGreaterThanOrEqual(6); // Hilly
    expect(nyc!.course.difficulty).toBeGreaterThanOrEqual(7); // Very hilly
  });

  it('Berlin and Chicago should be PR-friendly', () => {
    const berlin = getMarathonById('berlin-marathon-2026');
    const chicago = getMarathonById('chicago-marathon-2026');
    expect(berlin!.course.prFriendly).toBe(true);
    expect(chicago!.course.prFriendly).toBe(true);
  });

  it('Boston and NYC should NOT be PR-friendly', () => {
    const boston = getMarathonById('boston-marathon-2026');
    const nyc = getMarathonById('nyc-marathon-2026');
    expect(boston!.course.prFriendly).toBe(false);
    expect(nyc!.course.prFriendly).toBe(false);
  });

  it('getWorldMajorsByDate returns marathons sorted by date', () => {
    const sorted = getWorldMajorsByDate();
    for (let i = 1; i < sorted.length; i++) {
      expect(new Date(sorted[i].date).getTime()).toBeGreaterThanOrEqual(new Date(sorted[i - 1].date).getTime());
    }
  });

  it('getMarathonById returns correct marathon', () => {
    const tokyo = getMarathonById('tokyo-marathon-2026');
    expect(tokyo).toBeDefined();
    expect(tokyo!.city).toBe('Tokyo');
  });

  it('getNextWorldMajor returns the soonest edition on or after a given day', () => {
    // v1.0.9: fixed days instead of the wall clock (the old version broke on NYC race day 2026).
    expect(getNextWorldMajor('2026-10-12')!.id).toBe('nyc');
    expect(getNextWorldMajor('2026-10-12')!.date).toBe('2026-11-01');
    // Race day itself still counts as next (the Race Day screen shows it all day).
    expect(getNextWorldMajor('2026-11-01')!.id).toBe('nyc');
    expect(getNextWorldMajor('2026-11-01')!.date).toBe('2026-11-01');
    // The day after, the next one is Tokyo 2027 (an estimated date).
    const tokyo = getNextWorldMajor('2026-11-02')!;
    expect(tokyo.id).toBe('tokyo');
    expect(tokyo.date).toBe('2027-03-07');
    expect(tokyo.dateEstimated).toBe(true);
    // Past the last known editions, the usual scheduling rules keep it upcoming.
    const later = getNextWorldMajor('2030-11-15')!;
    expect(later.date >= '2030-11-15').toBe(true);
    expect(later.dateEstimated).toBe(true);
    // Whatever today is, the default call returns an edition on or after today.
    expect(getNextWorldMajor()!.date >= todayKey()).toBe(true);
  });
});

// ── Race Strategy Preferences ─────────────────────────────────────────────────

describe('Race Strategy Preferences', () => {
  // v1.0.6 (RS-14): there is no opt-in gate any more; old prefs stay readable.
  it('reads defaults when nothing is stored', () => {
    expect(getRaceStrategyPrefs()).toEqual({ enabled: false });
  });

  it('normalises a legacy selected race id on read', () => {
    setRaceStrategyPrefs({ enabled: true, selectedMarathonId: 'boston-marathon-2026' });
    expect(getRaceStrategyPrefs().selectedMarathonId).toBe('boston');
  });
});

// ── Strategy Builder ──────────────────────────────────────────────────────────

describe('buildRaceStrategy', () => {
  it('should build a strategy for a World Major', () => {
    const targetTime = 3 * 3600 + 45 * 60; // 3:45:00
    const strategy = buildRaceStrategy('berlin-marathon-2026', targetTime, 'negative-split');

    expect(strategy).not.toBeNull();
    // v1.0.6 (RS-8): legacy ids resolve, strategies carry the stable id.
    expect(strategy!.marathonId).toBe('berlin');
    expect(strategy!.targetTimeSec).toBe(targetTime);
    expect(strategy!.pacingStrategy).toBe('negative-split');
    expect(strategy!.milePaces.length).toBeGreaterThanOrEqual(26);
  });

  it('should produce paces that sum to approximately the target time', () => {
    const targetTime = 4 * 3600; // 4:00:00
    const strategy = buildRaceStrategy('chicago-marathon-2026', targetTime, 'even-split');

    expect(strategy).not.toBeNull();
    const lastMile = strategy!.milePaces[strategy!.milePaces.length - 1];
    // Cumulative time should be within 2 seconds of target
    expect(Math.abs(lastMile.cumulativeTimeSec - targetTime)).toBeLessThanOrEqual(2);
  });

  it('negative-split should have first half slower than second half', () => {
    const strategy = buildRaceStrategy('berlin-marathon-2026', 3.5 * 3600, 'negative-split');
    expect(strategy).not.toBeNull();
    expect(strategy!.firstHalfSec).toBeGreaterThan(strategy!.secondHalfSec);
  });

  it('should adjust pace for hills on Boston course', () => {
    const targetTime = 3 * 3600 + 30 * 60;
    const strategy = buildRaceStrategy('boston-marathon-2026', targetTime, 'even-split');
    expect(strategy).not.toBeNull();

    // Heartbreak Hill area (miles 17-21) should have slower paces than flat miles
    const flatMilePace = strategy!.milePaces[3]?.targetPaceSec ?? 0; // mile 4 (downhill)
    const uphillMilePace = strategy!.milePaces[20]?.targetPaceSec ?? 0; // mile 21 (Heartbreak)
    // On Boston, mile 4 is downhill and mile 21 is uphill, so pace difference should exist
    expect(uphillMilePace).toBeGreaterThan(flatMilePace);
  });

  it('should include a nutrition plan', () => {
    const strategy = buildRaceStrategy('london-marathon-2026', 4 * 3600, 'even-split');
    expect(strategy).not.toBeNull();
    expect(strategy!.nutritionPlan.length).toBeGreaterThanOrEqual(3);
  });

  // v1.0.7 (R-5): gels now run up to 15 min before the finish so the plan delivers its
  // target; at a 5:00 finish that is ~1.3 mi from the end (was "none in the last 2 miles").
  it('places gels by projected race time (slower = more gels, none in the final 15 min)', () => {
    const gels = (targetSec: number) =>
      buildRaceStrategy('chicago-marathon-2026', targetSec, 'even-split')!.nutritionPlan.filter((n) =>
        n.item.startsWith('Energy gel'),
      );
    for (const [targetSec, list] of [
      [2.75 * 3600, gels(2.75 * 3600)],
      [5 * 3600, gels(5 * 3600)],
    ] as const) {
      for (const g of list) {
        expect(g.mile).toBeGreaterThan(0);
        expect(g.mile).toBeLessThan(26.2);
        expect(g.timeSec!).toBeLessThanOrEqual(targetSec - 15 * 60);
      }
    }
    const fast = gels(2.75 * 3600);
    const slow = gels(5 * 3600);
    expect(fast.length).toBeGreaterThanOrEqual(3);
    expect(slow.length).toBeGreaterThan(fast.length);
  });

  it('should return null for an invalid marathon ID', () => {
    const strategy = buildRaceStrategy('nonexistent', 4 * 3600, 'even-split');
    expect(strategy).toBeNull();
  });

  it('should save strategies and be retrievable', () => {
    // v1.0.6 (RS-5): building is a pure preview; saving is explicit.
    const a = buildRaceStrategy('tokyo-marathon-2026', 4 * 3600, 'even-split');
    const b = buildRaceStrategy('tokyo-marathon-2026', 3.5 * 3600, 'negative-split');
    expect(getAllStrategies().length).toBe(0);
    saveStrategy(a!);
    saveStrategy(b!);

    const strategies = getStrategiesForMarathon('tokyo-marathon-2026');
    expect(strategies.length).toBe(2);

    const all = getAllStrategies();
    expect(all.length).toBe(2);
  });

  it('should delete strategies', () => {
    const s = buildRaceStrategy('berlin-marathon-2026', 4 * 3600, 'even-split');
    expect(s).not.toBeNull();
    saveStrategy(s!);
    expect(getAllStrategies().length).toBe(1);

    deleteStrategy(s!.id);
    expect(getAllStrategies().length).toBe(0);
  });
});

// ── Custom Marathon Import ────────────────────────────────────────────────────

describe('Custom Marathon Import', () => {
  it('should import a custom marathon', () => {
    const marathon = importCustomMarathon({
      name: 'Marine Corps Marathon',
      city: 'Washington, D.C.',
      country: 'United States',
      date: '2026-10-25',
      courseType: 'loop',
    });

    expect(marathon.id).toContain('custom-');
    expect(marathon.name).toBe('Marine Corps Marathon');
    expect(marathon.category).toBe('custom');
    expect(marathon.isWorldMajor).toBe(false);
    expect(marathon.distanceMi).toBe(26.2);
  });

  it('should appear in getAllMarathons', () => {
    importCustomMarathon({
      name: "Grandma's Marathon",
      city: 'Duluth',
      country: 'United States',
      date: '2026-06-20',
      courseType: 'point-to-point',
    });

    const all = getAllMarathons();
    expect(all.length).toBe(WORLD_MAJOR_MARATHONS.length + 1);
    expect(all.some((m) => m.name === "Grandma's Marathon")).toBe(true);
  });

  it('should build strategies for custom marathons', () => {
    const marathon = importCustomMarathon({
      name: 'Test Marathon',
      city: 'Test City',
      country: 'Test Country',
      date: '2026-09-01',
      courseType: 'loop',
      elevationGainFt: 500,
    });

    const strategy = buildRaceStrategy(marathon.id, 4 * 3600, 'even-split');
    expect(strategy).not.toBeNull();
    expect(strategy!.marathonId).toBe(marathon.id);
  });

  it('should remove custom marathons and their strategies', () => {
    const marathon = importCustomMarathon({
      name: 'To Remove',
      city: 'City',
      country: 'Country',
      date: '2026-05-01',
      courseType: 'loop',
    });

    saveStrategy(buildRaceStrategy(marathon.id, 4 * 3600, 'even-split')!);
    expect(getStrategiesForMarathon(marathon.id).length).toBe(1);

    removeCustomMarathon(marathon.id);
    expect(getMarathon(marathon.id)).toBeUndefined();
    expect(getStrategiesForMarathon(marathon.id).length).toBe(0);
  });

  it('should handle optional fields gracefully', () => {
    const marathon = importCustomMarathon({
      name: 'Minimal Marathon',
      city: 'City',
      country: 'Country',
      date: '2026-11-15',
      courseType: 'out-and-back',
    });

    expect(Number.isFinite(marathon.course.totalGainFt)).toBe(true);
    expect(marathon.course.totalGainFt).toBeGreaterThanOrEqual(0);
    expect(marathon.course.elevationPoints.length).toBeGreaterThanOrEqual(2);
    expect(marathon.aidStations.length).toBeGreaterThanOrEqual(3);
  });
});

// ── Utility Functions ─────────────────────────────────────────────────────────

describe('formatPace', () => {
  it('formats pace correctly', () => {
    expect(formatPace(510)).toBe('8:30');
    expect(formatPace(360)).toBe('6:00');
    expect(formatPace(455)).toBe('7:35');
  });
});
