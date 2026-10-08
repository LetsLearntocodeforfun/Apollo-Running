import { describe, it, expect } from 'vitest';
import {
  isDateKey,
  toDateKey,
  parseDateKey,
  daysBetween,
  addDays,
  weekdayMon0,
  mondayOf,
  dateKeyFromLocalIso,
  eachDay,
  weekdayShort,
  compareDateKeys,
} from '../utils/localDate';

describe('localDate', () => {
  it('validates date keys', () => {
    expect(isDateKey('2026-03-08')).toBe(true);
    expect(isDateKey('2026-02-29')).toBe(false);
    expect(isDateKey('2028-02-29')).toBe(true);
    expect(isDateKey('2026-13-01')).toBe(false);
    expect(isDateKey('2026-3-8')).toBe(false);
    expect(isDateKey(20260308)).toBe(false);
  });

  it('round-trips local dates', () => {
    expect(toDateKey(parseDateKey('2026-03-08'))).toBe('2026-03-08');
    expect(toDateKey(parseDateKey('2026-11-01'))).toBe('2026-11-01');
    expect(() => parseDateKey('nope')).toThrow(RangeError);
  });

  it('counts whole days across US and EU DST transitions', () => {
    // US spring-forward 2026-03-08, EU 2026-03-29, US fall-back 2026-11-01
    expect(daysBetween('2026-03-07', '2026-03-09')).toBe(2);
    expect(daysBetween('2026-03-28', '2026-03-30')).toBe(2);
    expect(daysBetween('2026-10-31', '2026-11-02')).toBe(2);
    expect(daysBetween('2025-12-22', '2026-03-14')).toBe(82);
    expect(daysBetween('2026-03-14', '2025-12-22')).toBe(-82);
  });

  it('adds days across DST and month/year boundaries', () => {
    expect(addDays('2026-03-07', 1)).toBe('2026-03-08');
    expect(addDays('2026-03-08', 1)).toBe('2026-03-09');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2025-12-22', 18 * 7 - 1)).toBe('2026-04-26');
  });

  it('uses Monday = 0 weekday indexing', () => {
    expect(weekdayMon0('2026-10-05')).toBe(0); // Monday
    expect(weekdayMon0('2026-10-07')).toBe(2); // Wednesday
    expect(weekdayMon0('2026-10-11')).toBe(6); // Sunday
    expect(weekdayShort('2026-04-19')).toBe('Sun');
    expect(mondayOf('2026-10-07')).toBe('2026-10-05');
    expect(mondayOf('2026-10-05')).toBe('2026-10-05');
    expect(mondayOf('2026-10-11')).toBe('2026-10-05');
  });

  it('extracts local dates from start_date_local without timezone shifts', () => {
    expect(dateKeyFromLocalIso('2026-03-09T06:00:00Z')).toBe('2026-03-09');
    expect(dateKeyFromLocalIso('2026-03-09')).toBe('2026-03-09');
    expect(dateKeyFromLocalIso('bad')).toBeNull();
    expect(dateKeyFromLocalIso(undefined)).toBeNull();
  });

  it('enumerates inclusive day ranges', () => {
    expect(eachDay('2026-03-07', '2026-03-10')).toEqual([
      '2026-03-07', '2026-03-08', '2026-03-09', '2026-03-10',
    ]);
    expect(eachDay('2026-03-10', '2026-03-07')).toEqual([]);
    expect(compareDateKeys('2026-03-07', '2026-03-10')).toBeLessThan(0);
  });
});
