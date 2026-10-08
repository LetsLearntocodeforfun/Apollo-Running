/**
 * World Marathon Majors data (RS-8, v1.0.6): stable ids, 2026/2027 editions
 * with `estimated` flags, rule-based fallback dates, `nextEdition`, legacy id
 * normalisation and the on-read strategy migration.
 */
import { describe, it, expect } from 'vitest';
import {
  WORLD_MAJOR_IDS,
  estimateMajorDate,
  getMarathonById,
  getNextWorldMajor,
  getWorldMajors,
  getWorldMajorsByDate,
  isWorldMajorId,
  nextEdition,
  normalizeMarathonId,
  withNextEdition,
} from '@/data/worldMajors';
import {
  getStrategiesForMarathon,
  getStrategyById,
  importCustomMarathon,
  migrateStrategyRaceIds,
} from '@/services/raceStrategy';
import { isValidTimeZone } from '@/services/myRace';
import { persistence } from '@/services/db/persistence';
import type { MarathonRace } from '@/types/raceStrategy';

const TODAY = '2026-10-08';

function major(id: string, today = TODAY): MarathonRace {
  const race = getMarathonById(id, today);
  if (!race) throw new Error(`fixture: no major ${id}`);
  return race;
}

function weekday(dateKey: string): number {
  const [y, m, d] = dateKey.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

describe('World Marathon Majors: ids and data', () => {
  it('uses stable, year-free ids', () => {
    expect([...WORLD_MAJOR_IDS]).toEqual(['tokyo', 'boston', 'london', 'berlin', 'chicago', 'nyc']);
    const races = getWorldMajors(TODAY);
    expect(races.map((r) => r.id)).toEqual([...WORLD_MAJOR_IDS]);
    for (const r of races) {
      expect(r.id).not.toMatch(/\d{4}/);
      expect(r.isWorldMajor).toBe(true);
      expect(isWorldMajorId(r.id)).toBe(true);
    }
  });

  it('every major has coordinates, a valid IANA time zone and an HH:mm start', () => {
    for (const r of getWorldMajors(TODAY)) {
      expect(typeof r.lat).toBe('number');
      expect(typeof r.lon).toBe('number');
      expect(Math.abs(r.lat ?? 999)).toBeLessThanOrEqual(90);
      expect(Math.abs(r.lon ?? 999)).toBeLessThanOrEqual(180);
      expect(isValidTimeZone(r.timeZone)).toBe(true);
      expect(r.startTime).toMatch(/^([01]\d|2[0-3]):[0-5]\d$/);
    }
    expect(major('chicago').timeZone).toBe('America/Chicago');
    expect(major('tokyo').timeZone).toBe('Asia/Tokyo');
  });

  it('only https websites', () => {
    for (const r of getWorldMajors(TODAY)) {
      if (r.website) expect(r.website).toMatch(/^https:\/\//);
    }
  });
});

describe('editions and estimated dates', () => {
  it('2026 editions are announced; 2027 is estimated except Boston (Patriots\u2019 Day)', () => {
    const jan2026 = '2026-01-01';
    for (const id of WORLD_MAJOR_IDS) {
      const ed2026 = nextEdition(major(id, jan2026), jan2026);
      expect(ed2026?.year).toBe(2026);
      expect(ed2026?.estimated).not.toBe(true);
    }
    const jan2027 = '2027-01-01';
    for (const id of WORLD_MAJOR_IDS) {
      const ed2027 = nextEdition(major(id, jan2027), jan2027);
      expect(ed2027?.year).toBe(2027);
      expect(ed2027?.estimated === true).toBe(id !== 'boston');
    }
  });

  it('known dates', () => {
    expect(nextEdition(major('boston', '2026-01-01'), '2026-01-01')?.date).toBe('2026-04-20');
    expect(nextEdition(major('chicago'), TODAY)?.date).toBe('2026-10-11');
    expect(nextEdition(major('nyc'), TODAY)?.date).toBe('2026-11-01');
    expect(nextEdition(major('boston'), TODAY)?.date).toBe('2027-04-19');
  });

  it('estimated 2027 editions follow each race\u2019s usual rule', () => {
    const jan2027 = '2027-01-01';
    for (const id of WORLD_MAJOR_IDS) {
      const ed = nextEdition(major(id, jan2027), jan2027);
      expect(ed?.date).toBe(estimateMajorDate(id, 2027));
    }
    expect(weekday(estimateMajorDate('boston', 2027))).toBe(1); // Monday
    for (const id of ['tokyo', 'london', 'berlin', 'chicago', 'nyc'] as const) {
      expect(weekday(estimateMajorDate(id, 2028))).toBe(0); // Sunday
    }
  });

  it('getWorldMajors(today) dates each race to its next edition and flags estimates', () => {
    const byId = new Map(getWorldMajors(TODAY).map((r) => [r.id, r]));
    expect(byId.get('chicago')?.date).toBe('2026-10-11');
    expect(byId.get('chicago')?.dateEstimated).toBe(false);
    expect(byId.get('nyc')?.date).toBe('2026-11-01');
    expect(byId.get('berlin')?.date).toBe('2027-09-26');
    expect(byId.get('berlin')?.dateEstimated).toBe(true);
    expect(byId.get('boston')?.dateEstimated).toBe(false);
    expect(byId.get('tokyo')?.year).toBe(2027);
  });

  it('sorts by next edition and finds the next major', () => {
    expect(getWorldMajorsByDate(TODAY).map((r) => r.id)).toEqual(['chicago', 'nyc', 'tokyo', 'boston', 'london', 'berlin']);
    expect(getNextWorldMajor(TODAY)?.id).toBe('chicago');
  });
});

describe('nextEdition', () => {
  it('a race on today counts as next; the day after moves to the following edition', () => {
    const chicago = major('chicago');
    expect(nextEdition(chicago, '2026-10-11')?.date).toBe('2026-10-11');
    const after = nextEdition(chicago, '2026-10-12');
    expect(after?.year).toBe(2027);
    expect(after?.date).toBe('2027-10-10');
    expect(after?.estimated).toBe(true);
    expect(nextEdition(chicago, '2026-03-01')?.date).toBe('2026-10-11');
  });

  it('falls back to the usual rule after the last known edition (estimated)', () => {
    const today = '2027-10-11';
    const ed = nextEdition(major('chicago', today), today);
    expect(ed).toEqual({
      year: 2028,
      date: estimateMajorDate('chicago', 2028),
      startTime: '07:30',
      timeZone: 'America/Chicago',
      estimated: true,
    });
    const tokyo2029 = nextEdition(major('tokyo', '2028-12-31'), '2028-12-31');
    expect(tokyo2029?.year).toBe(2029);
    expect(tokyo2029?.estimated).toBe(true);
  });

  it('custom races use their own date and have no next edition once it has passed', () => {
    const race = importCustomMarathon({
      name: 'Harvest Half',
      city: 'Portland',
      country: 'USA',
      date: '2026-11-15',
      courseType: 'loop',
      distanceMi: 13.1,
      startTime: '08:00',
      timeZone: 'America/Los_Angeles',
    });
    expect(nextEdition(race, TODAY)).toEqual({
      year: 2026,
      date: '2026-11-15',
      startTime: '08:00',
      timeZone: 'America/Los_Angeles',
    });
    expect(nextEdition(race, '2026-11-16')).toBeNull();
    // withNextEdition leaves custom races alone.
    expect(withNextEdition(race, '2027-01-01').date).toBe('2026-11-15');
  });
});

describe('normalizeMarathonId', () => {
  it('maps legacy year-pinned ids to stable ids', () => {
    expect(normalizeMarathonId('boston-marathon-2026')).toBe('boston');
    expect(normalizeMarathonId('nyc-marathon-2025')).toBe('nyc');
    expect(normalizeMarathonId('tokyo-marathon-2027')).toBe('tokyo');
  });

  it('leaves stable and custom ids unchanged', () => {
    expect(normalizeMarathonId('chicago')).toBe('chicago');
    expect(normalizeMarathonId('custom-boston-run-half-1700000000000-x1y2z')).toBe('custom-boston-run-half-1700000000000-x1y2z');
    expect(normalizeMarathonId('boston-marathon')).toBe('boston-marathon');
  });

  it('is idempotent', () => {
    for (const id of ['boston-marathon-2026', 'boston', 'berlin-marathon-2024', 'custom-x-1', '', 'nyc']) {
      const once = normalizeMarathonId(id);
      expect(normalizeMarathonId(once)).toBe(once);
    }
  });

  it('getMarathonById accepts legacy ids and returns the stable race', () => {
    expect(getMarathonById('boston-marathon-2026', TODAY)?.id).toBe('boston');
    expect(getMarathonById('unknown-race', TODAY)).toBeUndefined();
  });
});

describe('strategy race-id migration (on read, idempotent)', () => {
  it('finds legacy strategies under the stable id and rewrites them once', () => {
    const legacy = {
      id: 'strategy-legacy-1',
      name: 'Old Boston plan',
      marathonId: 'boston-marathon-2026',
      marathonName: 'Boston Marathon',
      targetTimeSec: 14400,
      targetTimeFormatted: '4:00:00',
      pacingStrategy: 'even-split',
      milePaces: [],
      nutritionPlan: [],
      firstHalfSec: 7200,
      secondHalfSec: 7200,
      avgPaceSec: 549,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      notes: '',
    };
    persistence.setItem('apollo_race_strategies', JSON.stringify([legacy]));

    expect(getStrategiesForMarathon('boston').map((s) => s.id)).toEqual(['strategy-legacy-1']);
    expect(getStrategyById('strategy-legacy-1')?.marathonId).toBe('boston');

    expect(migrateStrategyRaceIds()).toBeGreaterThanOrEqual(1);
    expect(migrateStrategyRaceIds()).toBe(0);
    const raw = JSON.parse(persistence.getItem('apollo_race_strategies') ?? '[]') as { marathonId: string }[];
    expect(raw[0].marathonId).toBe('boston');
  });
});
