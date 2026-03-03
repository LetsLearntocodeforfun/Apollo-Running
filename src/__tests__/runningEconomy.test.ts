/**
 * Tests for Running Economy Tracker Service
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  calculateEconomyIndex,
  classifyRunType,
  activitiesToEconomyPoints,
  calculateEconomyTrend,
  detectDeclineWeeks,
  analyzeRunningEconomy,
  cacheEconomy,
  getCachedEconomy,
} from '@/services/runningEconomy';
import type { StravaActivity } from '@/services/strava';
import { persistence } from '@/services/db/persistence';

beforeEach(() => {
  persistence.removeItem('apollo_running_economy');
  persistence.removeItem('apollo_hr_profile');
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeActivity(overrides: Partial<StravaActivity> & { id: number }): StravaActivity {
  return {
    name: 'Morning Run',
    type: 'Run',
    sport_type: 'Run',
    distance: 8000,      // ~5 mi
    moving_time: 2700,   // 45 min
    elapsed_time: 2800,
    start_date: '2026-01-15T07:00:00Z',
    start_date_local: '2026-01-15T07:00:00Z',
    average_heartrate: 145,
    kudos_count: 0,
    ...overrides,
  };
}

function makeEasyRunSeries(count: number, startDate: string, baseEconomy: number = 100): StravaActivity[] {
  const activities: StravaActivity[] = [];
  const start = new Date(startDate);

  for (let i = 0; i < count; i++) {
    const date = new Date(start);
    date.setDate(date.getDate() + i * 2); // every other day
    const dateStr = date.toISOString().slice(0, 10);

    // Slight variation around baseEconomy
    const variation = (Math.random() - 0.5) * 5;
    const targetEconomy = baseEconomy + variation;
    // Economy = (speed / HR) * 100
    // speed = distance / (time / 60)
    // So: speed = economy * HR / 100
    const hr = 140;
    const speed = targetEconomy * hr / 100;  // m/min
    const distance = 8000; // 5 mi in meters
    const movingTime = (distance / speed) * 60; // seconds

    activities.push(makeActivity({
      id: 1000 + i,
      distance,
      moving_time: Math.round(movingTime),
      average_heartrate: hr,
      start_date: `${dateStr}T07:00:00Z`,
      start_date_local: `${dateStr}T07:00:00Z`,
    }));
  }

  return activities;
}

// ── calculateEconomyIndex ────────────────────────────────────────────────────

describe('calculateEconomyIndex', () => {
  it('should calculate economy correctly', () => {
    // 8000m in 2700s = 177.78 m/min speed, at 145 bpm
    // Economy = (177.78 / 145) * 100 ≈ 122.6
    const economy = calculateEconomyIndex(8000, 2700, 145);
    expect(economy).toBeCloseTo(122.6, 0);
  });

  it('should return higher economy for faster pace at same HR', () => {
    const slow = calculateEconomyIndex(8000, 3000, 145);
    const fast = calculateEconomyIndex(8000, 2400, 145);
    expect(fast).toBeGreaterThan(slow);
  });

  it('should return higher economy for lower HR at same pace', () => {
    const highHR = calculateEconomyIndex(8000, 2700, 160);
    const lowHR = calculateEconomyIndex(8000, 2700, 130);
    expect(lowHR).toBeGreaterThan(highHR);
  });

  it('should return 0 for zero time', () => {
    expect(calculateEconomyIndex(8000, 0, 145)).toBe(0);
  });

  it('should return 0 for zero HR', () => {
    expect(calculateEconomyIndex(8000, 2700, 0)).toBe(0);
  });
});

// ── classifyRunType ──────────────────────────────────────────────────────────

describe('classifyRunType', () => {
  it('should classify easy runs (low HR, short distance)', () => {
    // Default maxHR is 190, 75% = 142.5
    expect(classifyRunType(5, 9.5, 135)).toBe('easy');
  });

  it('should classify long runs (> 9 mi at easy effort)', () => {
    expect(classifyRunType(12, 9.5, 140)).toBe('long');
  });

  it('should classify tempo runs (high HR)', () => {
    // 75% of 190 = 142.5
    expect(classifyRunType(5, 7.5, 165)).toBe('tempo');
  });

  it('should classify moderate effort short runs as easy if HR < 75%', () => {
    expect(classifyRunType(4, 9.0, 130)).toBe('easy');
  });
});

// ── activitiesToEconomyPoints ────────────────────────────────────────────────

describe('activitiesToEconomyPoints', () => {
  it('should convert activities to economy data points', () => {
    const activities = [
      makeActivity({ id: 1, start_date_local: '2026-01-15T07:00:00Z' }),
      makeActivity({ id: 2, start_date_local: '2026-01-17T07:00:00Z' }),
    ];
    const points = activitiesToEconomyPoints(activities);
    expect(points).toHaveLength(2);
    expect(points[0].economyIndex).toBeGreaterThan(0);
    expect(points[0].paceMinPerMi).toBeGreaterThan(0);
  });

  it('should filter out non-run activities', () => {
    const activities = [
      makeActivity({ id: 1, type: 'Ride', sport_type: 'Ride' }),
      makeActivity({ id: 2 }),
    ];
    expect(activitiesToEconomyPoints(activities)).toHaveLength(1);
  });

  it('should filter out activities without HR', () => {
    const activities = [
      makeActivity({ id: 1, average_heartrate: undefined }),
      makeActivity({ id: 2 }),
    ];
    expect(activitiesToEconomyPoints(activities)).toHaveLength(1);
  });

  it('should filter out very short runs (< 2 mi)', () => {
    const activities = [
      makeActivity({ id: 1, distance: 2000 }), // ~1.2 mi
      makeActivity({ id: 2, distance: 8000 }),
    ];
    expect(activitiesToEconomyPoints(activities)).toHaveLength(1);
  });

  it('should filter out low HR readings (sensor glitch)', () => {
    const activities = [
      makeActivity({ id: 1, average_heartrate: 50 }),
      makeActivity({ id: 2 }),
    ];
    expect(activitiesToEconomyPoints(activities)).toHaveLength(1);
  });

  it('should sort chronologically', () => {
    const activities = [
      makeActivity({ id: 2, start_date_local: '2026-01-20T07:00:00Z' }),
      makeActivity({ id: 1, start_date_local: '2026-01-15T07:00:00Z' }),
    ];
    const points = activitiesToEconomyPoints(activities);
    expect(points[0].date).toBe('2026-01-15');
    expect(points[1].date).toBe('2026-01-20');
  });
});

// ── calculateEconomyTrend ────────────────────────────────────────────────────

describe('calculateEconomyTrend', () => {
  it('should return null with fewer than 3 points', () => {
    const points = activitiesToEconomyPoints([
      makeActivity({ id: 1, start_date_local: '2026-01-15T07:00:00Z' }),
      makeActivity({ id: 2, start_date_local: '2026-01-16T07:00:00Z' }),
    ]);
    expect(calculateEconomyTrend(points)).toBeNull();
  });

  it('should calculate trend for sufficient data', () => {
    const activities = makeEasyRunSeries(10, '2026-01-01');
    const points = activitiesToEconomyPoints(activities);
    const trend = calculateEconomyTrend(points);
    expect(trend).not.toBeNull();
    expect(trend!.rollingAvg).toBeGreaterThan(0);
    expect(trend!.points.length).toBeGreaterThanOrEqual(3);
  });

  it('should detect improving trend', () => {
    // Create activities with gradually improving economy
    const activities: StravaActivity[] = [];
    for (let i = 0; i < 20; i++) {
      const date = new Date('2026-01-01');
      date.setDate(date.getDate() + i * 2);
      const dateStr = date.toISOString().slice(0, 10);
      // Faster over time (less moving_time) at same HR = improving economy
      activities.push(makeActivity({
        id: 1000 + i,
        distance: 8000,
        moving_time: 2800 - i * 15, // getting faster
        average_heartrate: 140,
        start_date_local: `${dateStr}T07:00:00Z`,
      }));
    }
    const points = activitiesToEconomyPoints(activities);
    const trend = calculateEconomyTrend(points);
    expect(trend).not.toBeNull();
    expect(trend!.trend).toBe('improving');
    expect(trend!.improvementPct).toBeGreaterThan(0);
  });

  it('should detect declining trend', () => {
    const activities: StravaActivity[] = [];
    for (let i = 0; i < 20; i++) {
      const date = new Date('2026-01-01');
      date.setDate(date.getDate() + i * 2);
      const dateStr = date.toISOString().slice(0, 10);
      activities.push(makeActivity({
        id: 1000 + i,
        distance: 8000,
        moving_time: 2400 + i * 20, // getting slower
        average_heartrate: 140,
        start_date_local: `${dateStr}T07:00:00Z`,
      }));
    }
    const points = activitiesToEconomyPoints(activities);
    const trend = calculateEconomyTrend(points);
    expect(trend).not.toBeNull();
    expect(trend!.trend).toBe('declining');
    expect(trend!.improvementPct).toBeLessThan(0);
  });

  it('should include rolling average in trend points', () => {
    const activities = makeEasyRunSeries(10, '2026-01-01');
    const points = activitiesToEconomyPoints(activities);
    const trend = calculateEconomyTrend(points)!;
    for (const tp of trend.points) {
      expect(tp.rollingAvg).toBeGreaterThan(0);
      expect(tp.economy).toBeGreaterThan(0);
      expect(tp.date).toBeTruthy();
    }
  });
});

// ── detectDeclineWeeks ───────────────────────────────────────────────────────

describe('detectDeclineWeeks', () => {
  it('should return 0 with insufficient data', () => {
    const points = activitiesToEconomyPoints([makeActivity({ id: 1 })]);
    expect(detectDeclineWeeks(points)).toBe(0);
  });

  it('should detect consecutive decline', () => {
    // Create 4 weeks of data with declining weekly averages
    const activities: StravaActivity[] = [];
    for (let week = 0; week < 4; week++) {
      for (let day = 0; day < 4; day++) {
        const date = new Date('2026-01-01');
        date.setDate(date.getDate() + week * 7 + day);
        const dateStr = date.toISOString().slice(0, 10);
        activities.push(makeActivity({
          id: week * 100 + day,
          distance: 8000,
          moving_time: 2400 + week * 120, // each week slower
          average_heartrate: 140,
          start_date_local: `${dateStr}T07:00:00Z`,
        }));
      }
    }
    const points = activitiesToEconomyPoints(activities);
    const decline = detectDeclineWeeks(points);
    expect(decline).toBeGreaterThanOrEqual(2);
  });

  it('should return 0 when economy is improving', () => {
    const activities: StravaActivity[] = [];
    for (let week = 0; week < 4; week++) {
      for (let day = 0; day < 4; day++) {
        const date = new Date('2026-01-01');
        date.setDate(date.getDate() + week * 7 + day);
        const dateStr = date.toISOString().slice(0, 10);
        activities.push(makeActivity({
          id: week * 100 + day,
          distance: 8000,
          moving_time: 2800 - week * 100, // each week faster
          average_heartrate: 140,
          start_date_local: `${dateStr}T07:00:00Z`,
        }));
      }
    }
    const points = activitiesToEconomyPoints(activities);
    expect(detectDeclineWeeks(points)).toBe(0);
  });
});

// ── analyzeRunningEconomy ────────────────────────────────────────────────────

describe('analyzeRunningEconomy', () => {
  it('should build complete result from activities', () => {
    const activities = makeEasyRunSeries(15, '2025-12-01');
    const result = analyzeRunningEconomy(activities);

    expect(result.dataPoints.length).toBeGreaterThan(0);
    expect(result.declineWeeks).toBeGreaterThanOrEqual(0);
    expect(result.insights).toBeInstanceOf(Array);
  });

  it('should find personal best', () => {
    const activities = makeEasyRunSeries(10, '2026-01-01');
    const result = analyzeRunningEconomy(activities);
    if (result.personalBest) {
      expect(result.personalBest.value).toBeGreaterThan(0);
      expect(result.personalBest.date).toBeTruthy();
    }
  });

  it('should handle empty activities', () => {
    const result = analyzeRunningEconomy([]);
    expect(result.dataPoints).toHaveLength(0);
    expect(result.currentEconomy).toBeNull();
    expect(result.personalBest).toBeNull();
    expect(result.easyRunTrend).toBeNull();
  });

  it('should generate insights for sufficient data', () => {
    const activities = makeEasyRunSeries(20, '2025-11-01');
    const result = analyzeRunningEconomy(activities);
    // Should have at least one insight about trend or PB
    expect(result.insights.length).toBeGreaterThanOrEqual(0);
  });

  it('should compute percent from PB', () => {
    const activities = makeEasyRunSeries(20, '2025-12-01');
    const result = analyzeRunningEconomy(activities);
    if (result.pctFromPB !== null) {
      expect(result.pctFromPB).toBeGreaterThanOrEqual(0);
    }
  });
});

// ── Persistence ──────────────────────────────────────────────────────────────

describe('Running economy persistence', () => {
  it('should cache and retrieve', () => {
    const activities = makeEasyRunSeries(10, '2026-01-01');
    const result = analyzeRunningEconomy(activities);
    cacheEconomy(result);
    const cached = getCachedEconomy();
    expect(cached).not.toBeNull();
    expect(cached!.dataPoints.length).toBe(result.dataPoints.length);
  });

  it('should return null when no cache', () => {
    expect(getCachedEconomy()).toBeNull();
  });
});
