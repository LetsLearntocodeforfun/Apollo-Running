/**
 * My Race store (v1.0.6): sanitising, the retired goal field, legacy race-id
 * normalisation, idempotent migration, clearing fields and change events.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  MY_RACE_KEY,
  clearMyRace,
  getMyRace,
  isHHmm,
  isValidTimeZone,
  migrateMyRaceId,
  onMyRaceChanged,
  sanitizeMyRace,
  setMyRace,
  type MyRace,
} from '@/services/myRace';
import { persistence } from '@/services/db/persistence';

function stored(): Record<string, unknown> | null {
  const raw = persistence.getItem(MY_RACE_KEY);
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
}

describe('myRace', () => {
  it('uses an apollo_ key and returns {} when nothing is saved or the data is corrupt', () => {
    expect(MY_RACE_KEY).toBe('apollo_my_race');
    expect(getMyRace()).toEqual({});
    persistence.setItem(MY_RACE_KEY, '{not json');
    expect(getMyRace()).toEqual({});
    persistence.setItem(MY_RACE_KEY, '"a string"');
    expect(getMyRace()).toEqual({});
  });

  it('sanitize drops the retired goalTimeSec (the goal lives in the athlete profile)', () => {
    const clean = sanitizeMyRace({ raceId: 'boston', goalTimeSec: 12600, date: '2027-04-19' });
    expect(clean).toEqual({ raceId: 'boston', date: '2027-04-19' });
    expect('goalTimeSec' in clean).toBe(false);

    // Old stored data with a goal reads back without it.
    persistence.setItem(MY_RACE_KEY, JSON.stringify({ raceId: 'chicago', goalTimeSec: 14400 }));
    expect(getMyRace()).toEqual({ raceId: 'chicago' });
  });

  it('normalises a legacy year-pinned race id on read', () => {
    expect(sanitizeMyRace({ raceId: 'boston-marathon-2026' }).raceId).toBe('boston');
    expect(sanitizeMyRace({ raceId: 'nyc-marathon-2025' }).raceId).toBe('nyc');
    expect(sanitizeMyRace({ raceId: 'custom-fall-half-1700000000000-abcde' }).raceId)
      .toBe('custom-fall-half-1700000000000-abcde');
    persistence.setItem(MY_RACE_KEY, JSON.stringify({ raceId: 'london-marathon-2026' }));
    expect(getMyRace().raceId).toBe('london');
  });

  it('drops invalid fields instead of throwing', () => {
    const clean = sanitizeMyRace({
      raceId: '   ',
      date: '2026-13-40',
      startTime: '7:30',
      timeZone: 'Mars/Olympus_Mons',
      wave: '  Wave 2, Corral 4  ',
      activeStrategyId: 42,
      travelMinutes: -5,
      arrivalLeadMin: 10,
      mealSize: 'huge',
      warmup: 'yes',
    });
    expect(clean).toEqual({ wave: 'Wave 2, Corral 4' });
    expect(sanitizeMyRace(null)).toEqual({});
    expect(sanitizeMyRace('boston')).toEqual({});
  });

  it('keeps valid race-morning fields and rounds minutes', () => {
    const clean = sanitizeMyRace({
      startTime: '07:30',
      timeZone: 'America/Chicago',
      travelMinutes: 44.6,
      arrivalLeadMin: 60,
      mealSize: 'light',
      warmup: false,
    });
    expect(clean).toEqual({
      startTime: '07:30',
      timeZone: 'America/Chicago',
      travelMinutes: 45,
      arrivalLeadMin: 60,
      mealSize: 'light',
      warmup: false,
    });
  });

  it('migrateMyRaceId rewrites a legacy id once and is idempotent', () => {
    expect(migrateMyRaceId()).toBe(false); // nothing saved
    persistence.setItem(MY_RACE_KEY, JSON.stringify({ raceId: 'berlin-marathon-2026', wave: 'B' }));
    expect(migrateMyRaceId()).toBe(true);
    expect(stored()).toEqual({ raceId: 'berlin', wave: 'B' });
    expect(migrateMyRaceId()).toBe(false);
    expect(stored()).toEqual({ raceId: 'berlin', wave: 'B' });

    persistence.setItem(MY_RACE_KEY, '{corrupt');
    expect(migrateMyRaceId()).toBe(false);
    expect(persistence.getItem(MY_RACE_KEY)).toBe('{corrupt');
  });

  it('setMyRace merges, drops invalid values and clears a field passed as undefined', () => {
    setMyRace({ raceId: 'chicago', wave: 'Wave 2', startTime: '07:30', timeZone: 'America/Chicago' });
    setMyRace({ date: '2026-10-11', startTime: '7:30 AM' });
    let race = getMyRace();
    expect(race.raceId).toBe('chicago');
    expect(race.date).toBe('2026-10-11');
    expect(race.startTime).toBeUndefined(); // '7:30 AM' is not 'HH:mm' → dropped
    expect(race.wave).toBe('Wave 2');
    expect(typeof race.updatedAt).toBe('string');

    setMyRace({ wave: undefined, timeZone: undefined });
    race = getMyRace();
    expect(race.wave).toBeUndefined();
    expect(race.timeZone).toBeUndefined();
    expect(race.raceId).toBe('chicago');
    expect('wave' in (stored() ?? {})).toBe(false);
  });

  it('setMyRace and clearMyRace notify listeners; unsubscribe stops them', () => {
    const seen: MyRace[] = [];
    const off = onMyRaceChanged((r) => seen.push(r));
    setMyRace({ raceId: 'nyc' });
    expect(seen).toHaveLength(1);
    expect(seen[0].raceId).toBe('nyc');

    clearMyRace();
    expect(seen).toHaveLength(2);
    expect(seen[1]).toEqual({});
    expect(persistence.getItem(MY_RACE_KEY)).toBeNull();

    off();
    setMyRace({ raceId: 'tokyo' });
    expect(seen).toHaveLength(2);
  });

  it('reading never writes', () => {
    const spy = vi.spyOn(persistence, 'setItem');
    getMyRace();
    persistence.setItem(MY_RACE_KEY, JSON.stringify({ raceId: 'boston-marathon-2026' }));
    spy.mockClear();
    getMyRace();
    sanitizeMyRace({ raceId: 'boston-marathon-2026' });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('isHHmm', () => {
  it.each([
    ['07:30', true],
    ['17:30', true],
    ['00:00', true],
    ['23:59', true],
    ['7:30', false],
    ['24:00', false],
    ['12:60', false],
    ['7:30 AM', false],
    ['', false],
  ])('%s → %s', (input, expected) => {
    expect(isHHmm(input)).toBe(expected);
  });

  it('rejects non-strings', () => {
    expect(isHHmm(730)).toBe(false);
    expect(isHHmm(null)).toBe(false);
    expect(isHHmm(undefined)).toBe(false);
  });
});

describe('isValidTimeZone', () => {
  it('accepts IANA zones the runtime knows', () => {
    expect(isValidTimeZone('America/Chicago')).toBe(true);
    expect(isValidTimeZone('Asia/Tokyo')).toBe(true);
    expect(isValidTimeZone('Europe/Berlin')).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);
  });

  it('rejects unknown zones, blanks and non-strings', () => {
    expect(isValidTimeZone('Not/AZone')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
    expect(isValidTimeZone('   ')).toBe(false);
    expect(isValidTimeZone('A'.repeat(65))).toBe(false);
    expect(isValidTimeZone(42)).toBe(false);
    expect(isValidTimeZone(undefined)).toBe(false);
  });
});
