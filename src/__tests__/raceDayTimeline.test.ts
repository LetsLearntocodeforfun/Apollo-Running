/**
 * Tests for raceDayTimeline.ts — Race Day Timeline Generator
 */

import { describe, it, expect } from 'vitest';
import { generateRaceDayTimeline, parseClockTime, defaultArrivalLeadMin } from '@/services/raceDayTimeline';
import type { RaceDayInput, TimelineFuelItem, RaceDayTimeline, TimelineEvent } from '@/services/raceDayTimeline';
import {
  buildRaceStrategy,
  importCustomMarathon,
  getStrategyDistanceMi,
  timeAtDistance,
} from '@/services/raceStrategy';

/** Five time-based fuel items (every 35 min from 30 min). */
const fiveGels: TimelineFuelItem[] = Array.from({ length: 5 }, (_, i) => ({
  timeSec: (30 + i * 35) * 60,
  distanceMi: (30 + i * 35) / 8,
  label: `Gel ${i + 1}`,
  carbsG: 25,
}));

const baseInput: RaceDayInput = {
  raceStartTime: '07:00',
  travelMinutes: 30,
  mealPreference: 'moderate',
  weightKg: 70,
  projectedFinishSec: 3 * 3600 + 30 * 60, // 3:30
  raceName: 'Chicago Marathon',
  fuelItems: fiveGels,
  includeWarmup: true,
};

const find = (t: RaceDayTimeline, re: RegExp): TimelineEvent | undefined => t.events.find((e) => re.test(e.title));

describe('generateRaceDayTimeline', () => {
  it('should generate a timeline with multiple events', () => {
    const timeline = generateRaceDayTimeline(baseInput);
    expect(timeline.events.length).toBeGreaterThan(10);
    expect(timeline.raceName).toBe('Chicago Marathon');
  });

  it('should include key event categories', () => {
    const timeline = generateRaceDayTimeline(baseInput);
    const categories = new Set(timeline.events.map((e) => e.category));
    expect(categories.has('wake')).toBe(true);
    expect(categories.has('nutrition')).toBe(true);
    expect(categories.has('logistics')).toBe(true);
    expect(categories.has('race')).toBe(true);
    expect(categories.has('milestone')).toBe(true);
  });

  it('should include breakfast 3 hours before race', () => {
    const timeline = generateRaceDayTimeline(baseInput);
    const breakfast = timeline.events.find((e) => e.title.toLowerCase().includes('breakfast'));
    expect(breakfast).toBeDefined();
    expect(breakfast!.minutesBeforeStart).toBeCloseTo(180, -1);
  });

  it('should include alarm event', () => {
    const timeline = generateRaceDayTimeline(baseInput);
    const alarm = timeline.events.find((e) => e.title.toLowerCase().includes('alarm') || e.title.toLowerCase().includes('wake'));
    expect(alarm).toBeDefined();
    expect(alarm!.minutesBeforeStart).toBeGreaterThan(180);
  });

  it('should include race start event', () => {
    const timeline = generateRaceDayTimeline(baseInput);
    const start = timeline.events.find((e) => e.title.toLowerCase().includes('gun time') && e.category === 'race');
    expect(start).toBeDefined();
    expect(start!.minutesBeforeStart).toBe(0);
  });

  it('should include projected finish', () => {
    const timeline = generateRaceDayTimeline(baseInput);
    const finish = timeline.events.find((e) => e.title.toLowerCase().includes('finish'));
    expect(finish).toBeDefined();
  });

  // v1.0.6 (L-17): the old test passed `fuelingItemsCount: 5` and expected 5
  // mile-spaced gels — that count-based spacing was the bug (20 gels all
  // landed on "Mile 5"). Fuel rows now come only from time-based fuel items.
  it('should include one fueling reminder per in-race fuel item, at gun + timeSec', () => {
    const timeline = generateRaceDayTimeline(baseInput);
    const fuelingEvents = timeline.events.filter((e) => e.category === 'fueling');
    expect(fuelingEvents.length).toBe(5);
    expect(fuelingEvents.map((e) => e.offsetSec)).toEqual(fiveGels.map((g) => g.timeSec));
    expect(fuelingEvents[0].time).toBe('7:30 AM');
  });

  it('ignores the deprecated fuelingItemsCount (no mile-based gel spacing)', () => {
    const timeline = generateRaceDayTimeline({ ...baseInput, fuelItems: undefined, fuelingItemsCount: 20 });
    expect(timeline.events.filter((e) => e.category === 'fueling')).toHaveLength(0);
  });

  it('should include warmup when requested', () => {
    const timeline = generateRaceDayTimeline(baseInput);
    const warmup = timeline.events.find((e) => e.category === 'warmup');
    expect(warmup).toBeDefined();
  });

  it('should skip warmup when not requested', () => {
    const timeline = generateRaceDayTimeline({ ...baseInput, includeWarmup: false });
    const warmup = timeline.events.find((e) => e.category === 'warmup');
    expect(warmup).toBeUndefined();
  });

  it('should include race milestones', () => {
    const timeline = generateRaceDayTimeline(baseInput);
    const milestones = timeline.events.filter((e) => e.category === 'milestone');
    expect(milestones.length).toBeGreaterThanOrEqual(5);
  });

  it('should generate exportable text', () => {
    const timeline = generateRaceDayTimeline(baseInput);
    expect(timeline.textExport).toBeTruthy();
    expect(timeline.textExport).toContain('Chicago Marathon');
    expect(timeline.textExport).toContain('Apollo Running');
  });

  it('should include carb targets in breakfast event', () => {
    const timeline = generateRaceDayTimeline(baseInput);
    const breakfast = timeline.events.find((e) => e.title.toLowerCase().includes('breakfast'));
    expect(breakfast!.description).toContain('g carbs');
  });

  it('should set times in AM/PM format', () => {
    const timeline = generateRaceDayTimeline(baseInput);
    for (const event of timeline.events) {
      expect(event.time).toMatch(/\d{1,2}:\d{2} (AM|PM)/);
    }
  });

  it('should handle evening race start', () => {
    const eveningInput = { ...baseInput, raceStartTime: '18:00' };
    const timeline = generateRaceDayTimeline(eveningInput);
    expect(timeline.events.length).toBeGreaterThan(10);
    // Breakfast should be at 3:00 PM
    const breakfast = timeline.events.find((e) => e.title.toLowerCase().includes('breakfast'));
    expect(breakfast!.time).toContain('PM');
  });

  it('keeps events sorted by offset and never emits -0 minutes', () => {
    const timeline = generateRaceDayTimeline(baseInput);
    for (let i = 1; i < timeline.events.length; i++) {
      expect(timeline.events[i].offsetSec).toBeGreaterThanOrEqual(timeline.events[i - 1].offsetSec);
    }
    expect(Object.is(find(timeline, /gun time/i)!.minutesBeforeStart, 0)).toBe(true);
  });
});

// ── L-14: start-time parsing ──────────────────────────────────────────────────

describe('parseClockTime (L-14)', () => {
  it.each([
    ['7:30 AM CT', 450, 'CT'],
    ['7:30am', 450, null],
    ['17:30', 1050, null],
    ['07:30', 450, null],
    ['5:30 PM', 1050, null],
    ['10:00 AM ET (Wave 1)', 600, 'ET'],
    ['9:10 AM JST', 550, 'JST'],
    ['12:00 AM', 0, null],
    ['12:30 PM', 750, null],
    ['7 AM', 420, null],
  ])('parses %s', (s, minutes, tzLabel) => {
    expect(parseClockTime(s)).toEqual({ minutes, tzLabel });
  });

  it.each(['25:00', '13:00 PM', 'abc', '', '7', '0730', '7:60'])('rejects %j', (s) => {
    expect(parseClockTime(s)).toBeNull();
  });

  it('starts the Chicago timeline at 7:30, not 7:00', () => {
    const timeline = generateRaceDayTimeline({ ...baseInput, raceStartTime: '7:30 AM CT' });
    const gun = find(timeline, /gun time/i)!;
    expect(gun.time).toBe('7:30 AM');
    expect(gun.clockMinutes).toBe(450);
    expect(timeline.startMinutes).toBe(450);
    expect(timeline.timeZoneLabel).toBe('CT');
  });

  it('handles 12 h PM starts', () => {
    const timeline = generateRaceDayTimeline({ ...baseInput, raceStartTime: '5:30 PM' });
    expect(find(timeline, /gun time/i)!.time).toBe('5:30 PM');
  });

  it('throws a clear error for an invalid start time instead of defaulting to 7:00', () => {
    expect(() => generateRaceDayTimeline({ ...baseInput, raceStartTime: 'abc' })).toThrow(RangeError);
    expect(() => generateRaceDayTimeline({ ...baseInput, raceStartTime: '25:00' })).toThrow(/start time/i);
  });

  it('shows the race-local zone label and race date (L-22)', () => {
    const timeline = generateRaceDayTimeline({
      ...baseInput,
      raceStartTime: '07:30',
      timeZoneLabel: 'CDT',
      raceDate: '2026-10-11',
    });
    expect(timeline.timeZoneLabel).toBe('CDT');
    expect(timeline.raceDate).toBe('2026-10-11');
    expect(timeline.textExport).toContain('Times are race-local (CDT)');
    expect(timeline.textExport).toContain('2026-10-11');
  });
});

// ── L-15 / L-18: milestones from the real plan ────────────────────────────────

describe('milestones (L-15, L-18)', () => {
  it('places the 5K at 5 km on the real Boston plan (timeAtDistance), not at 5 miles', () => {
    const strategy = buildRaceStrategy('boston', 4 * 3600, 'even-split');
    expect(strategy).not.toBeNull();
    const timeline = generateRaceDayTimeline({
      ...baseInput,
      raceStartTime: '10:00',
      projectedFinishSec: strategy!.targetTimeSec,
      milePaces: strategy!.milePaces,
      distanceMi: getStrategyDistanceMi(strategy!),
    });
    const fiveK = find(timeline, /^5K$/)!;
    const expected = timeAtDistance(strategy!.milePaces, 5 / 1.609344);
    expect(fiveK.offsetSec).toBeCloseTo(expected, 0);
    expect(fiveK.offsetSec).toBeLessThan(40 * 60); // the old bug put it at 5 mi (~45:48)
    const tenK = find(timeline, /^10K$/)!;
    expect(tenK.offsetSec).toBeCloseTo(timeAtDistance(strategy!.milePaces, 10 / 1.609344), 0);
    expect(find(timeline, /^Half marathon$/)).toBeDefined();
    expect(find(timeline, /^20 mi$/)!.description).toMatch(/wall zone/i);
  });

  it('uses 30K instead of 20 mi for km users, with km labels', () => {
    const timeline = generateRaceDayTimeline({ ...baseInput, unit: 'km' });
    expect(find(timeline, /^30K$/)).toBeDefined();
    expect(find(timeline, /^20 mi$/)).toBeUndefined();
    expect(find(timeline, /^5K$/)!.description).toContain('5.0 km');
  });

  it('builds a 1:45 half marathon without marathon-only events and finishes at start + 1:45:00', () => {
    const half = importCustomMarathon({
      name: 'Test Half',
      city: 'Testville',
      country: 'USA',
      date: '2026-11-15',
      courseType: 'loop',
      distanceMi: 13.1,
    });
    const strategy = buildRaceStrategy(half.id, 105 * 60, 'even-split');
    expect(strategy).not.toBeNull();
    const timeline = generateRaceDayTimeline({
      ...baseInput,
      raceStartTime: '08:00',
      raceName: half.name,
      projectedFinishSec: strategy!.targetTimeSec,
      milePaces: strategy!.milePaces,
      distanceMi: getStrategyDistanceMi(strategy!),
      fuelItems: [],
    });
    const titles = timeline.events.map((e) => `${e.title} ${e.description}`).join('\n');
    expect(titles).not.toMatch(/wall/i);
    expect(titles).not.toMatch(/mile 18/i);
    expect(titles).not.toMatch(/\b20 mi\b/);
    expect(titles).not.toMatch(/half marathon/i);
    expect(find(timeline, /^Halfway$/)).toBeDefined();
    const finish = find(timeline, /finish/i)!;
    expect(finish.offsetSec).toBe(105 * 60);
    expect(finish.time).toBe('9:45 AM');
    expect(finish.description).toContain('1:45:00');
  });

  it('rounds durations once (L-19)', () => {
    const timeline = generateRaceDayTimeline({ ...baseInput, projectedFinishSec: 14399.6 });
    const finish = find(timeline, /finish/i)!;
    expect(finish.description).toContain('4:00:00');
    expect(finish.description).not.toMatch(/:60|\.\d/);
  });

  it('omits race milestones (with a warning) when no finish time is known', () => {
    const timeline = generateRaceDayTimeline({ ...baseInput, projectedFinishSec: 0 });
    expect(timeline.events.some((e) => e.category === 'milestone')).toBe(false);
    expect(find(timeline, /gun time/i)).toBeDefined();
    expect(timeline.warnings.join(' ')).toMatch(/goal time/i);
  });
});

// ── L-16: breakfast vs departure ──────────────────────────────────────────────

describe('morning sequence (L-16)', () => {
  it('finishes breakfast at least 15 min before leaving with 150 min of travel', () => {
    const timeline = generateRaceDayTimeline({ ...baseInput, travelMinutes: 150 });
    const breakfast = find(timeline, /breakfast/i)!;
    const leave = find(timeline, /leave/i)!;
    const alarm = find(timeline, /alarm/i)!;
    // Breakfast takes ~20 min and must end ≥ 15 min before leaving.
    expect(breakfast.minutesBeforeStart - 20).toBeGreaterThanOrEqual(leave.minutesBeforeStart + 15);
    expect(alarm.minutesBeforeStart).toBeGreaterThan(breakfast.minutesBeforeStart);
    // Nothing from the morning routine happens after leaving.
    const morning = timeline.events.filter((e) => ['wake', 'nutrition'].includes(e.category) && e.offsetSec < -leave.minutesBeforeStart * 60);
    expect(morning.length).toBeGreaterThanOrEqual(3);
    expect(leave.minutesBeforeStart).toBe(60 + 150);
  });

  it('adds a carb snack when breakfast ends up more than 4 h before the gun', () => {
    const timeline = generateRaceDayTimeline({ ...baseInput, travelMinutes: 150, fieldSize: 40_000 });
    expect(find(timeline, /breakfast/i)!.minutesBeforeStart).toBeGreaterThan(240);
    expect(find(timeline, /snack/i)).toBeDefined();
  });
});

// ── L-17: fuel by time ────────────────────────────────────────────────────────

describe('fuel items (L-17)', () => {
  it('spreads 20 fuel items by time instead of piling them on one mile', () => {
    const items: TimelineFuelItem[] = Array.from({ length: 20 }, (_, i) => ({
      timeSec: (20 + i * 10) * 60,
      distanceMi: ((20 + i * 10) * 60) / 600,
      label: `Gel ${i + 1}`,
      carbsG: 25,
    }));
    const timeline = generateRaceDayTimeline({ ...baseInput, projectedFinishSec: 4 * 3600, fuelItems: items });
    const fuel = timeline.events.filter((e) => e.category === 'fueling');
    expect(fuel).toHaveLength(20);
    expect(new Set(fuel.map((e) => e.clockMinutes)).size).toBe(20);
    expect(new Set(fuel.map((e) => e.description.match(/around ([\d.]+ mi)/)?.[1])).size).toBe(20);
    expect(fuel[19].offsetSec - fuel[0].offsetSec).toBe(190 * 60);
  });

  it('uses a pre-race fuel item instead of the default gel', () => {
    const timeline = generateRaceDayTimeline({
      ...baseInput,
      fuelItems: [{ timeSec: -20 * 60, distanceMi: 0, label: 'Pre-race gel', carbsG: 25, note: 'With a few sips of water.' }],
    });
    const gels = timeline.events.filter((e) => /pre-race gel/i.test(e.title));
    expect(gels).toHaveLength(1);
    expect(gels[0].minutesBeforeStart).toBe(20);
  });
});

// ── L-20: arrival and start-area sequencing ──────────────────────────────────

describe('arrival lead and start area (L-20)', () => {
  it('defaults the arrival lead by field size', () => {
    expect(defaultArrivalLeadMin(47_000)).toBe(120);
    expect(defaultArrivalLeadMin(20_000)).toBe(120);
    expect(defaultArrivalLeadMin(10_000)).toBe(90);
    expect(defaultArrivalLeadMin(1_000)).toBe(60);
    expect(defaultArrivalLeadMin(undefined)).toBe(60);
    const arrive = (fieldSize?: number, arrivalLeadMin?: number) =>
      find(generateRaceDayTimeline({ ...baseInput, fieldSize, arrivalLeadMin }), /arrive/i)!.minutesBeforeStart;
    expect(arrive(47_000)).toBe(120);
    expect(arrive(10_000)).toBe(90);
    expect(arrive(1_000)).toBe(60);
    expect(arrive(47_000, 75)).toBe(75);
  });

  it('sequences bag check, porta-potty, corral and warm-up on distinct minutes', () => {
    const timeline = generateRaceDayTimeline({ ...baseInput, fieldSize: 47_000 });
    const pre = timeline.events.filter((e) => e.phase === 'pre-race');
    expect(new Set(pre.map((e) => e.minutesBeforeStart)).size).toBe(pre.length);
    const bag = find(timeline, /bag/i)!;
    const potty = find(timeline, /porta-potty/i)!;
    const corral = find(timeline, /corral/i)!;
    const warmup = find(timeline, /warmup/i)!;
    expect(bag.minutesBeforeStart).toBeGreaterThan(60); // before bag check closes (~60 min out)
    expect(potty.minutesBeforeStart).toBeLessThan(bag.minutesBeforeStart);
    expect(corral.minutesBeforeStart).toBeGreaterThan(15); // before the corral closes
    expect(corral.minutesBeforeStart).toBeLessThan(potty.minutesBeforeStart);
    // Warm-up of 10–15 min that ends ~10 min before the gun.
    expect(warmup.minutesBeforeStart).toBeGreaterThanOrEqual(20);
    expect(warmup.minutesBeforeStart).toBeLessThanOrEqual(25);
    expect(timeline.warnings).toHaveLength(0);
  });

  it('warns instead of piling up events when the arrival lead is too short', () => {
    const timeline = generateRaceDayTimeline({ ...baseInput, fieldSize: 47_000, arrivalLeadMin: 30 });
    expect(timeline.warnings.join(' ')).toMatch(/bag check/i);
    expect(timeline.warnings.join(' ')).toMatch(/warm-up/i);
    const pre = timeline.events.filter((e) => e.phase === 'pre-race');
    expect(new Set(pre.map((e) => e.minutesBeforeStart)).size).toBe(pre.length);
  });
});

// ── L-21: body-mass scaling ──────────────────────────────────────────────────

describe('fluids and carbs scale with body mass (L-21)', () => {
  const fluids = (weightKg?: number) => find(generateRaceDayTimeline({ ...baseInput, weightKg }), /fluids/i)!.description;

  it('uses 5–7 mL/kg, in mL and oz', () => {
    expect(fluids(50)).toContain('250–350 mL (8–12 oz)');
    expect(fluids(90)).toContain('450–630 mL (15–21 oz)');
  });

  it('falls back to generic copy without a body mass', () => {
    const text = fluids(undefined);
    expect(text).toContain('5–7 mL per kg');
    expect(text).not.toMatch(/\d{3}–\d{3} mL/);
  });

  it('scales breakfast carbs by meal size (1 / 2 / 3 g/kg)', () => {
    const carbs = (mealPreference: RaceDayInput['mealPreference'], weightKg?: number) =>
      find(generateRaceDayTimeline({ ...baseInput, mealPreference, weightKg }), /breakfast/i)!.description;
    expect(carbs('light', 60)).toContain('~60g carbs (1 g/kg)');
    expect(carbs('moderate', 60)).toContain('~120g carbs (2 g/kg)');
    expect(carbs('full', 60)).toContain('~180g carbs (3 g/kg)');
    expect(carbs('full', undefined)).toContain('3 g of carbs per kg');
  });
});
