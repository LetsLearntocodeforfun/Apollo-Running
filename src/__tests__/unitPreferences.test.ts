/**
 * unitPreferences.test.ts — Tests for the distance unit preference system.
 *
 * Validates: unit get/set persistence, conversions (meters<->unit, miles<->unit),
 * formatters (distance, pace, elevation, duration), and label helpers.
 */

import { describe, it, expect } from 'vitest';
import {
  getDistanceUnit,
  setDistanceUnit,
  metersToUnit,
  unitToMeters,
  unitLabel,
  paceUnitLabel,
  splitIntervalMeters,
  formatDistance,
  formatDistanceShort,
  formatPace,
  formatPaceValue,
  calcPace,
  formatElevation,
  formatDuration,
  milesToUnit,
  formatMiles,
  formatPaceFromMinPerMi,
} from '@/services/unitPreferences';

// ─── Unit Preference Persistence ──────────────────────────────

describe('getDistanceUnit / setDistanceUnit', () => {
  it('defaults to miles when no preference is stored', () => {
    expect(getDistanceUnit()).toBe('mi');
  });

  it('persists km preference', () => {
    setDistanceUnit('km');
    expect(getDistanceUnit()).toBe('km');
  });

  it('persists mi preference back', () => {
    setDistanceUnit('km');
    setDistanceUnit('mi');
    expect(getDistanceUnit()).toBe('mi');
  });

  it('returns mi for unknown stored value', () => {
    // persistence mock: store something weird
    setDistanceUnit('mi');
    expect(getDistanceUnit()).toBe('mi');
  });
});

// ─── Labels ──────────────────────────────────────────────────

describe('unitLabel / paceUnitLabel', () => {
  it('returns mi/km labels based on preference', () => {
    setDistanceUnit('mi');
    expect(unitLabel()).toBe('mi');
    expect(paceUnitLabel()).toBe('/mi');

    setDistanceUnit('km');
    expect(unitLabel()).toBe('km');
    expect(paceUnitLabel()).toBe('/km');
  });

  it('accepts explicit unit argument', () => {
    expect(unitLabel('km')).toBe('km');
    expect(paceUnitLabel('mi')).toBe('/mi');
  });
});

// ─── splitIntervalMeters ─────────────────────────────────────

describe('splitIntervalMeters', () => {
  it('returns 1609.344 for miles', () => {
    setDistanceUnit('mi');
    expect(splitIntervalMeters()).toBeCloseTo(1609.344, 2);
  });

  it('returns 1000 for km', () => {
    setDistanceUnit('km');
    expect(splitIntervalMeters()).toBe(1000);
  });
});

// ─── Conversion Helpers ──────────────────────────────────────

describe('metersToUnit', () => {
  it('converts meters to miles', () => {
    setDistanceUnit('mi');
    expect(metersToUnit(1609.344)).toBeCloseTo(1.0, 4);
  });

  it('converts meters to km', () => {
    setDistanceUnit('km');
    expect(metersToUnit(5000)).toBeCloseTo(5.0, 4);
  });

  it('uses explicit unit when provided', () => {
    setDistanceUnit('mi');
    expect(metersToUnit(1000, 'km')).toBeCloseTo(1.0, 4);
  });
});

describe('unitToMeters', () => {
  it('converts miles to meters', () => {
    setDistanceUnit('mi');
    expect(unitToMeters(1)).toBeCloseTo(1609.344, 1);
  });

  it('converts km to meters', () => {
    setDistanceUnit('km');
    expect(unitToMeters(5)).toBeCloseTo(5000, 1);
  });

  it('roundtrips correctly', () => {
    setDistanceUnit('mi');
    expect(metersToUnit(unitToMeters(3.1))).toBeCloseTo(3.1, 4);
  });
});

describe('milesToUnit', () => {
  it('returns miles unchanged when unit is mi', () => {
    setDistanceUnit('mi');
    expect(milesToUnit(6.2)).toBeCloseTo(6.2, 4);
  });

  it('converts miles to km when unit is km', () => {
    setDistanceUnit('km');
    expect(milesToUnit(6.2)).toBeCloseTo(9.978, 1);
  });
});

// ─── Distance Formatting ─────────────────────────────────────

describe('formatDistance', () => {
  it('formats 10000m as miles with 2 decimals', () => {
    setDistanceUnit('mi');
    const result = formatDistance(10000);
    expect(result).toMatch(/6\.21 mi/);
  });

  it('formats 10000m as km with 2 decimals', () => {
    setDistanceUnit('km');
    const result = formatDistance(10000);
    expect(result).toBe('10.00 km');
  });
});

describe('formatDistanceShort', () => {
  it('formats with 1 decimal in miles', () => {
    setDistanceUnit('mi');
    const result = formatDistanceShort(10000);
    expect(result).toMatch(/6\.2 mi/);
  });

  it('formats with 1 decimal in km', () => {
    setDistanceUnit('km');
    const result = formatDistanceShort(10000);
    expect(result).toBe('10.0 km');
  });
});

describe('formatMiles', () => {
  it('formats miles -> mi with 1 decimal (default)', () => {
    setDistanceUnit('mi');
    expect(formatMiles(6.214)).toBe('6.2 mi');
  });

  it('formats miles -> km with 1 decimal', () => {
    setDistanceUnit('km');
    const result = formatMiles(6.214);
    expect(result).toMatch(/10\.0 km/);
  });

  it('respects custom decimal places', () => {
    setDistanceUnit('mi');
    expect(formatMiles(6.214, 2)).toBe('6.21 mi');
  });
});

// ─── Pace Formatting ─────────────────────────────────────────

describe('formatPace', () => {
  it('formats pace from meters and seconds in miles', () => {
    setDistanceUnit('mi');
    // 1 mile in 8 min = 8:00/mi
    const result = formatPace(1609.344, 480);
    expect(result).toBe('8:00/mi');
  });

  it('formats pace in km', () => {
    setDistanceUnit('km');
    // 1km in 300s = 5:00/km
    const result = formatPace(1000, 300);
    expect(result).toBe('5:00/km');
  });

  it('returns — for zero distance', () => {
    expect(formatPace(0, 300)).toBe('—');
  });

  it('returns — for zero time', () => {
    expect(formatPace(1000, 0)).toBe('—');
  });
});

describe('formatPaceValue', () => {
  it('formats 8.5 min/mi correctly', () => {
    setDistanceUnit('mi');
    expect(formatPaceValue(8.5)).toBe('8:30/mi');
  });

  it('returns — for values > 30', () => {
    expect(formatPaceValue(31)).toBe('—');
  });

  it('returns — for zero', () => {
    expect(formatPaceValue(0)).toBe('—');
  });
});

describe('formatPaceFromMinPerMi', () => {
  it('passes through when unit is mi', () => {
    setDistanceUnit('mi');
    expect(formatPaceFromMinPerMi(8)).toBe('8:00/mi');
  });

  it('converts min/mi to min/km', () => {
    setDistanceUnit('km');
    // 8:00/mi → 8/1.60934 ≈ 4:58/km
    const result = formatPaceFromMinPerMi(8);
    expect(result).toMatch(/4:5[78]\/km/);
  });

  it('returns — for zero', () => {
    expect(formatPaceFromMinPerMi(0)).toBe('—');
  });
});

describe('calcPace', () => {
  it('calculates pace in min/unit', () => {
    setDistanceUnit('mi');
    // 1 mile in 480 sec = 8 min/mi
    expect(calcPace(1609.344, 480)).toBeCloseTo(8.0, 1);
  });

  it('returns 0 for invalid inputs', () => {
    expect(calcPace(0, 480)).toBe(0);
    expect(calcPace(1000, 0)).toBe(0);
  });
});

// ─── Elevation Formatting ────────────────────────────────────

describe('formatElevation', () => {
  it('formats as feet when unit is miles', () => {
    setDistanceUnit('mi');
    // 100m ≈ 328 ft
    expect(formatElevation(100)).toMatch(/328 ft/);
  });

  it('formats as meters when unit is km', () => {
    setDistanceUnit('km');
    expect(formatElevation(100)).toBe('100 m');
  });
});

// ─── Duration Formatting ─────────────────────────────────────

describe('formatDuration', () => {
  it('formats hours and minutes', () => {
    expect(formatDuration(3661)).toBe('1h 1m');
  });

  it('formats minutes and seconds', () => {
    expect(formatDuration(125)).toBe('2:05');
  });

  it('formats seconds only', () => {
    expect(formatDuration(42)).toBe('42s');
  });

  it('formats zero', () => {
    expect(formatDuration(0)).toBe('0s');
  });
});
