/**
 * Unit tests for autoSync.ts
 *
 * Tests conversion utilities, pace calculations, and activity type detection.
 */

import { describe, it, expect } from 'vitest';
import {
  metersToMiles,
  calcPaceMinPerMi,
  formatPaceMinPerMi,
  isRunActivity,
} from '@/services/autoSync';
import type { StravaActivity } from '@/services/strava';

// ── metersToMiles ─────────────────────────────────────────────────────────────

describe('metersToMiles', () => {
  it('should convert 1609.34 meters to approximately 1 mile', () => {
    const miles = metersToMiles(1609.34);
    expect(miles).toBeCloseTo(1, 2);
  });

  it('should convert 0 meters to 0 miles', () => {
    expect(metersToMiles(0)).toBe(0);
  });

  it('should convert 5000 meters (~3.1 miles)', () => {
    const miles = metersToMiles(5000);
    expect(miles).toBeCloseTo(3.107, 1);
  });

  it('should convert 42195 meters (marathon) to approximately 26.2 miles', () => {
    const miles = metersToMiles(42195);
    expect(miles).toBeCloseTo(26.2, 0);
  });

  it('should convert 10000 meters to approximately 6.2 miles', () => {
    const miles = metersToMiles(10000);
    expect(miles).toBeCloseTo(6.214, 1);
  });

  it('should handle large distances', () => {
    const miles = metersToMiles(100000);
    expect(miles).toBeCloseTo(62.14, 0);
  });
});

// ── calcPaceMinPerMi ──────────────────────────────────────────────────────────

describe('calcPaceMinPerMi', () => {
  it('should calculate correct pace for a 10-minute mile', () => {
    // 1609.34 m in 600 seconds = 10:00/mi
    const pace = calcPaceMinPerMi(1609.34, 600);
    expect(pace).toBeCloseTo(10, 1);
  });

  it('should calculate correct pace for a 5K in 25 minutes', () => {
    // 5000m in 1500s = 25 min for ~3.107 mi = ~8:03/mi
    const pace = calcPaceMinPerMi(5000, 1500);
    expect(pace).toBeCloseTo(8.05, 0);
  });

  it('should calculate correct pace for a 4-hour marathon', () => {
    // 42195m in 14400s = 4 hours for 26.2 mi ≈ 9:09/mi
    const pace = calcPaceMinPerMi(42195, 14400);
    expect(pace).toBeCloseTo(9.15, 0);
  });

  it('should return 0 for zero distance', () => {
    expect(calcPaceMinPerMi(0, 1500)).toBe(0);
  });

  it('should return 0 for zero time', () => {
    expect(calcPaceMinPerMi(5000, 0)).toBe(0);
  });

  it('should return 0 when both are zero', () => {
    expect(calcPaceMinPerMi(0, 0)).toBe(0);
  });

  it('should produce faster pace for faster runs at same distance', () => {
    const fast = calcPaceMinPerMi(5000, 1200);  // 20 min 5K
    const slow = calcPaceMinPerMi(5000, 1800);  // 30 min 5K
    expect(fast).toBeLessThan(slow);
  });
});

// ── formatPaceMinPerMi ────────────────────────────────────────────────────────

describe('formatPaceMinPerMi', () => {
  it('should format a 10:00/mi pace', () => {
    expect(formatPaceMinPerMi(10)).toBe('10:00/mi');
  });

  it('should format an 8:30/mi pace', () => {
    expect(formatPaceMinPerMi(8.5)).toBe('8:30/mi');
  });

  it('should format a 7:15/mi pace', () => {
    expect(formatPaceMinPerMi(7.25)).toBe('7:15/mi');
  });

  it('should format a 6:00/mi pace', () => {
    expect(formatPaceMinPerMi(6)).toBe('6:00/mi');
  });

  it('should pad seconds with leading zero', () => {
    expect(formatPaceMinPerMi(9.0833)).toBe('9:05/mi');
  });

  it('should return dash for 0 pace', () => {
    expect(formatPaceMinPerMi(0)).toBe('—');
  });

  it('should handle decimal paces correctly', () => {
    const formatted = formatPaceMinPerMi(8.75);
    expect(formatted).toBe('8:45/mi');
  });
});

// ── isRunActivity ─────────────────────────────────────────────────────────────

describe('isRunActivity', () => {
  const makeActivity = (type: string, sportType = ''): StravaActivity => ({
    id: 1,
    name: 'Test',
    type,
    sport_type: sportType || type,
    distance: 5000,
    moving_time: 1500,
    elapsed_time: 1600,
    start_date: '2025-01-01T12:00:00Z',
    start_date_local: '2025-01-01T12:00:00Z',
    kudos_count: 0,
  });

  it('should identify "Run" as a running activity', () => {
    expect(isRunActivity(makeActivity('Run'))).toBe(true);
  });

  it('should identify "VirtualRun" as a running activity', () => {
    expect(isRunActivity(makeActivity('VirtualRun'))).toBe(true);
  });

  it('should identify "TrailRun" as a running activity', () => {
    expect(isRunActivity(makeActivity('TrailRun'))).toBe(true);
  });

  it('should not identify "Ride" as a running activity', () => {
    expect(isRunActivity(makeActivity('Ride'))).toBe(false);
  });

  it('should not identify "Swim" as a running activity', () => {
    expect(isRunActivity(makeActivity('Swim'))).toBe(false);
  });

  it('should not identify "Walk" as a running activity', () => {
    expect(isRunActivity(makeActivity('Walk'))).toBe(false);
  });

  it('should check sport_type when type does not match', () => {
    expect(isRunActivity(makeActivity('Other', 'Run'))).toBe(true);
    expect(isRunActivity(makeActivity('Other', 'TrailRun'))).toBe(true);
  });

  it('should not identify "Yoga" as a running activity', () => {
    expect(isRunActivity(makeActivity('Yoga'))).toBe(false);
  });
});
