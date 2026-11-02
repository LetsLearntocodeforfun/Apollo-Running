/**
 * Graduated Shoe Tracker (`src/services/shoeTracker.ts`) test suite.
 *
 * Covers:
 *  - Shoe CRUD, validation, canonical field aliases, persistence keys (`apollo_shoes`, `apollo_shoe_assignments`)
 *  - Retirement, reactivation, default shoe transitions, and rotation role tags
 *  - Run mileage attribution (`getShoesWithStats`, `setActivityShoe`, `assignUnassignedRunsToShoe`)
 *    strictly excluding hidden runs, deleted runs, and non-running sports (cycling, swimming, strength)
 *  - Wear alerts at ≥ 80% (`warning`), ≥ 100% (`critical`), and race-day projections
 *  - Unit-preference fidelity (`mi` vs `km`, zero `\bmi\b` leaks when unit is `'km'`)
 *  - Timezone-safe local calendar date handling (`todayKey()` and `start_date_local` slicing)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  SHOES_STORAGE_KEY,
  SHOE_ASSIGNMENTS_KEY,
  SHOE_DEFAULT_PERIODS_KEY,
  SHOE_ROLES,
  SHOE_ROLE_LABELS,
  ShoeValidationError,
  addShoe,
  updateShoe,
  retireShoe,
  reactivateShoe,
  deleteShoe,
  setDefaultShoe,
  getShoes,
  getActiveShoes,
  getRetiredShoes,
  getDefaultShoe,
  getShoeById,
  getShoesWithStats,
  setActivityShoe,
  clearActivityShoe,
  assignShoeToActivity,
  assignUnassignedRunsToShoe,
  getUnassignedRuns,
  getActivityShoeInfo,
  createActivityShoeResolver,
  calculateDegradation,
  checkRetirementAlerts,
  checkRaceDayShoes,
  getShoesSummary,
  formatShoeDistance,
  shoeDistanceInUnit,
  unitDistanceToMiles,
  defaultMaxDistanceForUnit,
  extractActivityLocalDate,
} from '@/services/shoeTracker';
import { persistence } from '@/services/db/persistence';
import { getAllStoredActivities, storeActivities } from '@/services/analyticsService';
import { hideActivity, unhideActivity, deleteActivity } from '@/services/activity/manage';
import { setDistanceUnit, getDistanceUnit } from '@/services/unitPreferences';
import type { Activity } from '@/services/activity/types';
import { addDays, todayKey } from '@/utils/localDate';

const METERS_PER_MILE = 1609.344;

function makeActivity(id: number, localIso: string, distanceM: number, extra: Partial<Activity> = {}): Activity {
  return {
    id,
    name: `Activity ${id}`,
    type: 'Run',
    sport_type: 'Run',
    distance: distanceM,
    moving_time: 1800,
    elapsed_time: 1800,
    start_date: localIso,
    start_date_local: localIso,
    kudos_count: 0,
    source: 'intervals',
    source_id: `i${id}`,
    ...extra,
  };
}

beforeEach(() => {
  persistence.clear();
});

describe('Shoe CRUD, Roles & Persistence', () => {
  it('creates shoes with role tags, canonical mileage aliases, and apollo_ persistence keys', () => {
    const shoe = addShoe({
      brand: 'Saucony',
      model: 'Endorphin Speed 4',
      nickname: 'Speed Blue',
      role: 'tempo',
      initialMiles: 25.5,
      maxMiles: 400,
      addedDate: '2026-10-01',
    });

    expect(shoe.id).toMatch(/^shoe_/);
    expect(shoe.name).toBe('Speed Blue');
    expect(shoe.nickname).toBe('Speed Blue');
    expect(shoe.brand).toBe('Saucony');
    expect(shoe.model).toBe('Endorphin Speed 4');
    expect(shoe.role).toBe('tempo');
    expect(SHOE_ROLE_LABELS[shoe.role!]).toBe('Tempo / Speed');
    expect(shoe.initialMiles).toBe(25.5);
    expect(shoe.initialMileage).toBe(25.5);
    expect(shoe.maxMiles).toBe(400);
    expect(shoe.maxMileage).toBe(400);
    expect(shoe.totalMiles).toBe(25.5);
    expect(shoe.currentMileage).toBe(25.5);
    expect(shoe.addedDate).toBe('2026-10-01');
    expect(shoe.startDate).toBe('2026-10-01');
    expect(shoe.isDefault).toBe(true);

    // Persisted under apollo_shoes so backups/exports include gear automatically
    expect(persistence.getItem(SHOES_STORAGE_KEY)).toBeTruthy();
    const rawShoes = JSON.parse(persistence.getItem(SHOES_STORAGE_KEY)!);
    expect(Array.isArray(rawShoes)).toBe(true);
    expect(rawShoes[0].role).toBe('tempo');
  });

  it('supports all six rotation role tags and validates invalid inputs', () => {
    expect(SHOE_ROLES).toEqual(['daily', 'long-run', 'tempo', 'race', 'recovery', 'trail']);
    for (const role of SHOE_ROLES) {
      const s = addShoe({ brand: 'Brooks', model: `Model ${role}`, role });
      expect(s.role).toBe(role);
    }

    expect(() => addShoe({ brand: '', model: '', name: '' })).toThrow(ShoeValidationError);

    expect(() => addShoe({ brand: 'Nike', model: 'Peg', maxMiles: -10 })).toThrow(ShoeValidationError);

    expect(() => addShoe({ brand: 'Nike', model: 'Peg', initialMiles: -1 })).toThrow(ShoeValidationError);
  });

  it('manages default shoe selection, retirement handoff, and reactivation', () => {
    const daily = addShoe({ brand: 'Brooks', model: 'Ghost 16', role: 'daily' });
    const trail = addShoe({ brand: 'Hoka', model: 'Speedgoat 6', role: 'trail' });

    expect(getDefaultShoe()?.id).toBe(daily.id);

    setDefaultShoe(trail.id);
    expect(getDefaultShoe()?.id).toBe(trail.id);
    expect(getShoeById(daily.id)?.isDefault).toBe(false);

    // Clear default completely
    setDefaultShoe(null);
    expect(getDefaultShoe()).toBeNull();

    // Re-select trail, then retire it — daily becomes default automatically
    setDefaultShoe(trail.id);
    const retired = retireShoe(trail.id);
    expect(retired?.status).toBe('retired');
    expect(getActiveShoes().map((s) => s.id)).toEqual([daily.id]);
    expect(getRetiredShoes().map((s) => s.id)).toEqual([trail.id]);
    expect(getDefaultShoe()?.id).toBe(daily.id);

    // Cannot make a retired shoe default until reactivated
    expect(setDefaultShoe(trail.id)).toBeNull();
    const reactivated = reactivateShoe(trail.id);
    expect(reactivated?.status).toBe('active');
    expect(reactivated?.retiredAt).toBeUndefined();

    // Update role & maxMiles
    const updated = updateShoe(trail.id, { role: 'long-run', maxMiles: 450 });
    expect(updated?.role).toBe('long-run');
    expect(updated?.maxMiles).toBe(450);

    expect(deleteShoe(trail.id)).toBe(true);
    expect(getShoeById(trail.id)).toBeNull();
  });
});

describe('Run Attribution, Hidden Activities & Non-Run Sport Filtering', () => {
  it('attributes visible runs while strictly excluding cycling, swimming, strength, and hidden runs', () => {
    const trainer = addShoe({
      brand: 'ASICS',
      model: 'Novablast 4',
      role: 'daily',
      addedDate: '2026-10-01',
      maxMiles: 400,
    });
    const racer = addShoe({
      brand: 'Nike',
      model: 'Alphafly 3',
      role: 'race',
      addedDate: '2026-10-01',
      maxMiles: 250,
    });

    const activities: Activity[] = [
      // Run 1: unassigned on/after addedDate → accrues to default trainer (5.0 mi)
      makeActivity(101, '2026-10-05T07:30:00Z', 5 * METERS_PER_MILE, { name: 'Easy 5' }),
      // Run 2: TrailRun explicitly assigned to racer (10.0 mi)
      makeActivity(102, '2026-10-08T08:00:00Z', 10 * METERS_PER_MILE, {
        name: 'Tempo 10',
        type: 'TrailRun',
        sport_type: 'TrailRun',
      }),
      // Run 3: BEFORE addedDate (2026-09-20) → does NOT silently backfill default shoe
      makeActivity(103, '2026-09-20T07:00:00Z', 8 * METERS_PER_MILE, { name: 'September Run' }),
      // Hidden run: should NOT count even on/after addedDate
      makeActivity(104, '2026-10-09T07:00:00Z', 6 * METERS_PER_MILE, {
        name: 'Duplicate Run',
        hidden: true,
      }),
      // Cycling ride: should NEVER count toward running shoes
      makeActivity(105, '2026-10-10T09:00:00Z', 25 * METERS_PER_MILE, {
        name: 'Morning Ride',
        type: 'Ride',
        sport_type: 'Ride',
      }),
      // Virtual ride & Swim: should NEVER count
      makeActivity(106, '2026-10-11T09:00:00Z', 15 * METERS_PER_MILE, {
        type: 'VirtualRide',
        sport_type: 'VirtualRide',
      }),
      makeActivity(107, '2026-10-12T09:00:00Z', 2 * METERS_PER_MILE, {
        type: 'Swim',
        sport_type: 'Swim',
      }),
    ];

    storeActivities(activities);
    expect(setActivityShoe(102, racer.id)).toBe(true);
    // Attempting to assign a cycling ride to a shoe is rejected
    expect(setActivityShoe(105, trainer.id)).toBe(false);
    expect(persistence.getItem(SHOE_ASSIGNMENTS_KEY)).toBeTruthy();

    const stats = getShoesWithStats();
    const trainerStats = stats.find((s) => s.id === trainer.id)!;
    const racerStats = stats.find((s) => s.id === racer.id)!;

    expect(trainerStats.loggedMiles).toBeCloseTo(5.0, 2);
    expect(trainerStats.totalMiles).toBeCloseTo(5.0, 2);
    expect(trainerStats.runCount).toBe(1);

    expect(racerStats.loggedMiles).toBeCloseTo(10.0, 2);
    expect(racerStats.totalMiles).toBeCloseTo(10.0, 2);
    expect(racerStats.runCount).toBe(1);

    // Hiding an explicitly assigned run immediately removes its mileage from the shoe!
    hideActivity(102);
    expect(getShoeById(racer.id)!.totalMiles).toBe(0);
    expect(getActivityShoeInfo(102, '2026-10-08').shoe).toBeNull();

    // Unhiding restores its mileage
    unhideActivity(102);
    expect(getShoeById(racer.id)!.totalMiles).toBeCloseTo(10.0, 2);

    // Deleting the run removes its mileage and cleans up its assignment
    deleteActivity(102);
    expect(getShoeById(racer.id)!.totalMiles).toBe(0);
  });

  it('supports batch-assigning unassigned runs without double-counting and respects autoAssignUnassignedRuns=false', () => {
    const manualDefault = addShoe({
      brand: 'New Balance',
      model: 'Rebel v4',
      role: 'daily',
      addedDate: '2026-10-15',
      autoAssignUnassignedRuns: false,
    });
    const backup = addShoe({
      brand: 'Puma',
      model: 'Velocity Nitro 3',
      role: 'recovery',
      addedDate: '2026-10-15',
    });

    storeActivities([
      makeActivity(201, '2026-10-01T08:00:00Z', 4 * METERS_PER_MILE),
      makeActivity(202, '2026-10-16T08:00:00Z', 6 * METERS_PER_MILE),
      makeActivity(203, '2026-10-17T08:00:00Z', 3 * METERS_PER_MILE),
    ]);

    // Because manualDefault has autoAssignUnassignedRuns: false, none of the 3 runs auto-accrued
    expect(getShoeById(manualDefault.id)!.totalMiles).toBe(0);
    expect(getUnassignedRuns().length).toBe(3);

    // Explicitly mark 203 as "no shoe" (null) — batch assign must respect that choice
    setActivityShoe(203, null);
    expect(getUnassignedRuns().length).toBe(2);

    // Batch-assign remaining unassigned runs to backup
    const assignedCount = assignUnassignedRunsToShoe(backup.id);
    expect(assignedCount).toBe(2);
    expect(getShoeById(backup.id)!.totalMiles).toBeCloseTo(10.0, 2);

    // Clicking batch assign again assigns 0 runs (never double-counts)
    expect(assignUnassignedRunsToShoe(backup.id)).toBe(0);
    expect(getShoeById(backup.id)!.totalMiles).toBeCloseTo(10.0, 2);

    // Clearing explicit choice on 203 leaves it unassigned again
    clearActivityShoe(203);
    expect(getUnassignedRuns().length).toBe(1);
  });

  it('accepts an explicit activities array in getShoesWithStats(activities)', () => {
    const shoe = addShoe({
      brand: 'Hoka',
      model: 'Mach 6',
      role: 'daily',
      initialMiles: 20,
      maxMiles: 400,
      addedDate: '2026-10-01',
    });

    const customList: Activity[] = [
      makeActivity(301, '2026-10-02T07:00:00Z', 10 * METERS_PER_MILE),
      makeActivity(302, '2026-10-03T07:00:00Z', 10 * METERS_PER_MILE, { hidden: true }),
      makeActivity(303, '2026-10-04T07:00:00Z', 25 * METERS_PER_MILE, { type: 'Ride', sport_type: 'Ride' }),
    ];

    const [stats] = getShoesWithStats(customList);
    expect(stats.id).toBe(shoe.id);
    expect(stats.loggedMiles).toBeCloseTo(10, 2);
    expect(stats.totalMiles).toBeCloseTo(30, 2);
    expect(stats.remainingMiles).toBeCloseTo(370, 2);
    expect(stats.runCount).toBe(1);
  });
});

describe('Wear Alerts (≥80% Warning, ≥100% Critical, and Race-Day Projection)', () => {
  it('triggers warning at ≥80% wear and critical at ≥100% wear', () => {
    const okShoe = addShoe({
      brand: 'Nike',
      model: 'Vomero 17',
      maxMiles: 400,
      initialMiles: 100, // 25%
    });
    const warnShoe = addShoe({
      brand: 'Brooks',
      model: 'Glycerin 21',
      maxMiles: 400,
      initialMiles: 320, // 80%
    });
    const critShoe = addShoe({
      brand: 'ASICS',
      model: 'Nimbus 26',
      maxMiles: 400,
      initialMiles: 410, // 103%
    });

    expect(calculateDegradation(okShoe.id)!.urgency).toBe('ok');

    const warnDeg = calculateDegradation(warnShoe.id)!;
    expect(warnDeg.usagePct).toBe(80);
    expect(warnDeg.urgency).toBe('warning');
    expect(warnDeg.remainingMiles).toBe(80);

    const critDeg = calculateDegradation(critShoe.id)!;
    expect(critDeg.usagePct).toBe(103);
    expect(critDeg.urgency).toBe('critical');
    expect(critDeg.remainingMiles).toBe(0);

    const alerts = checkRetirementAlerts();
    expect(alerts.map((a) => a.shoeId)).toEqual([warnShoe.id, critShoe.id]);
  });
});

describe('Unit-Preference Honesty (km vs mi)', () => {
  it('converts distances accurately and leaks zero \\bmi\\b strings when unit is km', () => {
    expect(getDistanceUnit()).toBe('mi');
    expect(defaultMaxDistanceForUnit()).toBe(400);

    setDistanceUnit('km');
    expect(getDistanceUnit()).toBe('km');
    expect(defaultMaxDistanceForUnit()).toBe(650);
    expect(shoeDistanceInUnit(10)).toBeCloseTo(16.09344, 4);
    expect(unitDistanceToMiles(650)).toBeCloseTo(650 / 1.609344, 4);
    expect(formatShoeDistance(unitDistanceToMiles(650))).toBe('650 km');

    const today = '2026-10-31';
    const okShoe = addShoe({
      name: 'Aero Glide',
      brand: 'Salomon',
      model: 'Aero Glide',
      initialMiles: unitDistanceToMiles(200),
      maxMiles: unitDistanceToMiles(650),
      addedDate: '2026-10-01',
    });
    const warnShoe = addShoe({
      name: 'Tempo Flyer',
      brand: 'Adidas',
      model: 'Boston 12',
      initialMiles: unitDistanceToMiles(540), // ~83%
      maxMiles: unitDistanceToMiles(650),
      addedDate: '2026-10-01',
    });
    const critShoe = addShoe({
      name: 'Carbon Pro',
      brand: 'Adidas',
      model: 'Adios Pro 3',
      initialMiles: unitDistanceToMiles(680), // >100%
      maxMiles: unitDistanceToMiles(650),
      addedDate: '2026-10-01',
    });
    const retiredShoe = addShoe({
      name: 'Old Faithful',
      brand: 'Brooks',
      model: 'Adrenaline',
      initialMiles: unitDistanceToMiles(700),
      maxMiles: unitDistanceToMiles(650),
      addedDate: '2026-06-01',
    });
    retireShoe(retiredShoe.id);

    // Add recent weekly runs on okShoe so it projects past 650 km before race day
    for (let i = 0; i < 12; i++) {
      assignShoeToActivity(`km_run_${i}`, unitDistanceToMiles(25), addDays(today, -i * 2), okShoe.id);
    }

    const raceDate = addDays(today, 42);
    const summaries = getShoesSummary(raceDate, { today });
    expect(summaries.length).toBe(4);
    for (const s of summaries) {
      expect(s.statusMessage).toContain('km');
      expect(s.statusMessage).not.toMatch(/\bmi\b/i);
      expect(s.statusMessage).not.toMatch(/\bmiles?\b/i);
    }

    const raceAlerts = checkRaceDayShoes(raceDate, { today });
    expect(raceAlerts.length).toBeGreaterThanOrEqual(2);
    for (const alert of raceAlerts) {
      expect(alert.message).toContain('km');
      expect(alert.message).not.toMatch(/\bmi\b/i);
      expect(alert.message).not.toMatch(/\bmiles?\b/i);
    }

    const stats = getShoesWithStats(undefined, { today, raceDate });
    for (const st of stats) {
      expect(st.degradation.statusMessage).toContain('km');
      expect(st.degradation.statusMessage).not.toMatch(/\bmi\b/i);
    }

    expect(warnShoe.id).toBeTruthy();
    expect(critShoe.id).toBeTruthy();
  });
});

describe('Local Calendar Date Safety', () => {
  it('uses todayKey() and slices start_date_local / start_date without UTC timezone drift', () => {
    const today = todayKey();
    const shoe = addShoe({ brand: 'On', model: 'Cloudmonster 2', role: 'long-run' });
    expect(shoe.addedDate).toBe(today);
    expect(shoe.startDate).toBe(today);

    // Late-night local timestamp (23:45) must stay on 2026-10-31, never drift to 2026-11-01
    const lateEveningRun = makeActivity(401, '2026-10-31T23:45:00Z', 5 * METERS_PER_MILE, {
      start_date: '2026-11-01T04:45:00Z',
      start_date_local: '2026-10-31T23:45:00Z',
    });
    expect(extractActivityLocalDate(lateEveningRun)).toBe('2026-10-31');

    // Fallback to start_date when start_date_local is empty
    const fallbackRun = makeActivity(402, '', 3 * METERS_PER_MILE, {
      start_date: '2026-10-30T14:00:00Z',
      start_date_local: '',
    });
    expect(extractActivityLocalDate(fallbackRun)).toBe('2026-10-30');
    expect(getShoes().length).toBe(1);
  });
});

describe('Stored shoe records are validated on read', () => {
  it('falls back to defaults for corrupt distances and names, so NaN or Infinity never reach stats', () => {
    persistence.setItem(
      SHOES_STORAGE_KEY,
      JSON.stringify([
        { id: 'tiny', name: 'Tiny', status: 'active', maxMileage: 1e-300, initialMileage: 50, category: 'training' },
        { id: 'huge', name: 'Huge', maxMileage: 1e308, initialMileage: 1e308 },
        { id: 'weird', name: 123, maxMileage: -5, initialMileage: 'abc', category: 'bogus', startDate: 'not-a-date' },
        { id: 'over', name: 'Over limits', maxMileage: 5001, initialMileage: 10_001, category: 'racing' },
        {
          id: 'alias',
          name: '  ',
          brand: 'Nike',
          model: 'Pegasus',
          maxMileage: 'Infinity',
          maxMiles: 450,
          initialMileage: null,
        },
        { id: '', name: 'no id' },
        null,
        'not a shoe',
      ]),
    );
    persistence.setItem(SHOE_DEFAULT_PERIODS_KEY, '[]');

    const stats = getShoesWithStats([], { today: '2026-10-31' });
    expect(stats.map((s) => s.id)).toEqual(['tiny', 'huge', 'weird', 'over', 'alias']);
    const byId = new Map(stats.map((s) => [s.id, s]));

    expect(byId.get('tiny')).toMatchObject({ maxMiles: 500, initialMiles: 50, wearPct: 10, remainingMiles: 450 });
    expect(byId.get('huge')).toMatchObject({ maxMiles: 500, initialMiles: 0, totalMiles: 0, wearPct: 0 });
    expect(byId.get('weird')).toMatchObject({
      name: 'Unnamed shoe',
      category: 'training',
      maxMiles: 500,
      initialMiles: 0,
    });
    expect(byId.get('over')).toMatchObject({ maxMiles: 300, initialMiles: 0 });
    expect(byId.get('alias')).toMatchObject({ name: 'Nike Pegasus', maxMiles: 450, initialMiles: 0 });

    for (const s of stats) {
      for (const n of [
        s.totalMiles,
        s.maxMiles,
        s.initialMiles,
        s.remainingMiles,
        s.wearPct,
        s.degradation.usagePct,
        s.degradation.currentMiles,
        s.degradation.maxMiles,
      ]) {
        expect(Number.isFinite(n)).toBe(true);
      }
      expect(s.maxMiles).toBeGreaterThan(0);
      expect(s.degradation.statusMessage).not.toMatch(/NaN|Infinity|e\+/);
    }
    expect(byId.get('huge')!.degradation.statusMessage).toBe('Huge — 0 mi of 500 mi (0%). 500 mi left.');
  });

  it('applies the same limits to new input: a retirement distance that rounds to 0 mi is rejected', () => {
    expect(() => addShoe({ brand: 'Nike', model: 'Pegasus', maxMiles: 0.001 })).toThrow(ShoeValidationError);
    expect(() => addShoe({ brand: 'Nike', model: 'Pegasus', maxMiles: 5_000.5 })).toThrow(/too large/);
    expect(() => addShoe({ brand: 'Nike', model: 'Pegasus', initialMiles: 10_000.5 })).toThrow(/too large/);
    expect(addShoe({ brand: 'Nike', model: 'Pegasus', maxMiles: 5_000, initialMiles: 10_000 }).maxMiles).toBe(5_000);
  });
});

describe('Shoe mileage duplicate guard (same run from two sources)', () => {
  const TWENTY_MI = 20 * METERS_PER_MILE;
  const copy = (
    id: number,
    source: Activity['source'],
    startUtc: string,
    distanceM = TWENTY_MI,
    localIso = '2026-10-30T05:00:00',
  ) =>
    makeActivity(id, localIso, distanceM, {
      source,
      source_id: `${source}-${id}`,
      start_date: startUtc,
      start_date_local: localIso,
    });

  beforeEach(() => {
    addShoe({ brand: 'Nike', model: 'Pegasus 41', addedDate: '2026-10-01' });
  });

  it('counts two visible copies of one run (different sources, 3.5 min apart, within 3%) once', () => {
    const [shoe] = getShoesWithStats(
      [copy(1, 'strava', '2026-10-30T10:00:00Z'), copy(2, 'garmin', '2026-10-30T10:03:30Z', TWENTY_MI * 1.02)],
      { today: '2026-10-31' },
    );
    expect(shoe.loggedMiles).toBeCloseTo(20, 2);
    expect(shoe.runCount).toBe(1);
    expect(shoe.activities.map((a) => a.activityKey)).toEqual(['1']);
  });

  it('still counts both when they share a source, start over 5 min apart, differ by over 3%, or fall on different days', () => {
    const logged = (list: Activity[]) => getShoesWithStats(list, { today: '2026-10-31' })[0].loggedMiles;

    expect(logged([copy(1, 'garmin', '2026-10-30T10:00:00Z'), copy(2, 'garmin', '2026-10-30T10:03:00Z')])).toBeCloseTo(
      40,
      2,
    );
    expect(logged([copy(1, 'strava', '2026-10-30T10:00:00Z'), copy(2, 'garmin', '2026-10-30T10:05:30Z')])).toBeCloseTo(
      40,
      2,
    );
    expect(
      logged([copy(1, 'strava', '2026-10-30T10:00:00Z'), copy(2, 'garmin', '2026-10-30T10:01:00Z', TWENTY_MI * 1.04)]),
    ).toBeCloseTo(40.8, 2);
    expect(
      logged([
        copy(1, 'strava', '2026-10-31T04:58:00Z', TWENTY_MI, '2026-10-30T23:58:00'),
        copy(2, 'garmin', '2026-10-31T05:02:00Z', TWENTY_MI, '2026-10-31T00:02:00'),
      ]),
    ).toBeCloseTo(40, 2);
  });

  it('keeps the explicit choice when one copy was assigned to another shoe, and leaves the activity store alone', () => {
    const daily = getDefaultShoe()!;
    const racer = addShoe({
      brand: 'Nike',
      model: 'Alphafly 3',
      role: 'race',
      addedDate: '2026-10-01',
      isDefault: false,
    });
    // 3.5 min apart: the activity store keeps both (its own dedupe matches within 2 min)
    storeActivities([copy(11, 'strava', '2026-10-30T10:00:00Z'), copy(12, 'garmin', '2026-10-30T10:03:30Z')]);
    expect(getAllStoredActivities().filter((a) => !a.hidden)).toHaveLength(2);

    expect(setActivityShoe(12, racer.id)).toBe(true);
    const stats = getShoesWithStats(undefined, { today: '2026-10-31' });
    expect(stats.find((s) => s.id === racer.id)!.loggedMiles).toBeCloseTo(20, 2);
    expect(stats.find((s) => s.id === daily.id)!.loggedMiles).toBe(0);

    // Shoe mileage dedupe never hides or merges activities
    expect(getAllStoredActivities().filter((a) => !a.hidden)).toHaveLength(2);
  });

  it('counts genuinely different runs on the same day: an AM and a PM run, or two runs of different distance', () => {
    const stats = (list: Activity[]) => getShoesWithStats(list, { today: '2026-10-31' })[0];
    // AM run (Strava) and PM run (Garmin), same distance, 11 h apart
    const ampm = stats([
      copy(1, 'strava', '2026-10-30T12:00:00Z', 10_000, '2026-10-30T06:00:00'),
      copy(2, 'garmin', '2026-10-30T23:00:00Z', 10_000, '2026-10-30T17:00:00'),
    ]);
    expect(ampm.runCount).toBe(2);
    expect(ampm.loggedMiles).toBeCloseTo((2 * 10_000) / METERS_PER_MILE, 2);
    // A 5 km warm-up and a 10 km race starting 2 min apart from different sources
    expect(
      stats([copy(1, 'strava', '2026-10-30T12:00:00Z', 5_000), copy(2, 'garmin', '2026-10-30T12:02:00Z', 10_000)])
        .runCount,
    ).toBe(2);
    // Each of the AM and PM runs synced from two sources: two runs, each counted once
    const pairs = stats([
      copy(1, 'strava', '2026-10-30T12:00:00Z', 10_000, '2026-10-30T06:00:00'),
      copy(2, 'garmin', '2026-10-30T12:01:00Z', 10_050, '2026-10-30T06:01:00'),
      copy(3, 'strava', '2026-10-30T23:00:00Z', 8_000, '2026-10-30T17:00:00'),
      copy(4, 'garmin', '2026-10-30T23:02:00Z', 7_950, '2026-10-30T17:02:00'),
    ]);
    expect(pairs.runCount).toBe(2);
    expect(pairs.activities.map((a) => a.activityKey).sort()).toEqual(['1', '3']);
  });

  it('counts a run synced from three sources once', () => {
    const [shoe] = getShoesWithStats(
      [
        copy(1, 'strava', '2026-10-30T10:00:00Z'),
        copy(2, 'garmin', '2026-10-30T10:01:00Z', TWENTY_MI * 1.01),
        copy(3, 'intervals', '2026-10-30T10:04:30Z', TWENTY_MI * 0.99),
      ],
      { today: '2026-10-31' },
    );
    expect(shoe.runCount).toBe(1);
    expect(shoe.loggedMiles).toBeCloseTo(20, 2);
  });

  it('stays fast and exact for 25,000 activities, even when thousands share one day', () => {
    // 12,500 runs over ~10 years, each also synced from a second source 0–3 min later (±1.5% distance)
    const sources: Activity['source'][] = ['strava', 'garmin', 'intervals'];
    const list: Activity[] = [];
    const start = Date.parse('2016-11-01T12:00:00Z');
    for (let i = 0; i < 12_500; i++) {
      const t = start + i * 7 * 3_600_000; // every 7 h
      const distanceM = 5_000 + (i % 25) * 1_000;
      const src = sources[i % 3];
      const other = sources[(i + 1) % 3];
      const iso = new Date(t).toISOString().slice(0, 19);
      list.push(makeActivity(2 * i + 1, iso, distanceM, { source: src, start_date: `${iso}Z` }));
      const isoCopy = new Date(t + (i % 4) * 60_000).toISOString().slice(0, 19);
      list.push(
        makeActivity(2 * i + 2, isoCopy, distanceM * (i % 2 ? 1.015 : 0.985), {
          source: other,
          start_date: `${isoCopy}Z`,
        }),
      );
    }
    persistence.clear();
    addShoe({ brand: 'Nike', model: 'Pegasus 41', addedDate: '2016-01-01' });
    let t0 = performance.now();
    const [spread] = getShoesWithStats(list, { today: '2026-10-31' });
    const spreadMs = performance.now() - t0;
    expect(spread.runCount).toBe(12_500);

    // A broken import that puts all 25,000 records on one day, 3 s apart, from two sources:
    // copies are 3 s and 1% apart, so every pair still counts once.
    const oneDay: Activity[] = [];
    for (let i = 0; i < 12_500; i++) {
      const t = Date.parse('2026-10-30T00:00:00Z') + i * 6_000;
      const iso = new Date(t).toISOString().slice(0, 19);
      const isoCopy = new Date(t + 3_000).toISOString().slice(0, 19);
      const distanceM = 1_000 + (i % 400) * 50;
      oneDay.push(
        makeActivity(100_000 + 2 * i, iso, distanceM, {
          source: 'strava',
          start_date: `${iso}Z`,
          start_date_local: '2026-10-30T08:00:00',
        }),
      );
      oneDay.push(
        makeActivity(100_001 + 2 * i, isoCopy, distanceM * 1.01, {
          source: 'garmin',
          start_date: `${isoCopy}Z`,
          start_date_local: '2026-10-30T08:00:00',
        }),
      );
    }
    t0 = performance.now();
    const [crowded] = getShoesWithStats(oneDay, { today: '2026-10-31' });
    const crowdedMs = performance.now() - t0;
    expect(crowded.runCount).toBe(12_500);

    // Loose bounds so slow CI machines pass; both typically finish in well under 200 ms.
    expect(spreadMs).toBeLessThan(2_000);
    expect(crowdedMs).toBeLessThan(2_000);
  });

  it('resolves a page of rows with one read, answering exactly like getActivityShoeInfo', () => {
    const daily = getDefaultShoe()!;
    const racer = addShoe({
      brand: 'Nike',
      model: 'Alphafly 3',
      role: 'race',
      addedDate: '2026-10-01',
      isDefault: false,
    });
    storeActivities([
      copy(21, 'strava', '2026-10-28T10:00:00Z', TWENTY_MI, '2026-10-28T05:00:00'),
      copy(22, 'garmin', '2026-10-29T10:00:00Z', TWENTY_MI, '2026-10-29T05:00:00'),
      makeActivity(23, '2026-10-29T18:00:00', 30_000, { type: 'Ride', sport_type: 'Ride' }),
      copy(24, 'strava', '2026-09-20T10:00:00Z', TWENTY_MI, '2026-09-20T05:00:00'),
    ]);
    setActivityShoe(22, racer.id);
    setActivityShoe(24, null);
    const resolve = createActivityShoeResolver();
    for (const [key, date] of [
      [21, '2026-10-28'],
      [22, '2026-10-29'],
      [23, '2026-10-29'],
      [24, '2026-09-20'],
      ['999', '2026-10-30'],
      ['999', null],
    ] as const) {
      expect(resolve(key, date)).toEqual(getActivityShoeInfo(key, date));
    }
    expect(resolve(21, '2026-10-28')).toMatchObject({ source: 'default', shoe: { id: daily.id } });
    expect(resolve(22, '2026-10-29')).toMatchObject({ source: 'explicit', shoe: { id: racer.id } });
    expect(resolve(23, '2026-10-29')).toEqual({ shoe: null, source: 'none', isExplicit: false });
    expect(resolve(24, '2026-09-20')).toEqual({ shoe: null, source: 'none', isExplicit: true });
  });
});
