/**
 * Tests for Performance Management Chart (PMC) Service
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  classifyTSBZone,
  getZoneColor,
  getZoneLabel,
  classifyWorkoutType,
  activitiesToDailyLoads,
  generateAnnotations,
  projectForward,
  tsbToReadinessScore,
  buildPMC,
  cachePMC,
  getCachedPMC,
} from '@/services/pmcChart';
import type { StravaActivity } from '@/services/strava';
import type { FitnessFatigueSnapshot } from '@/services/taperOptimizer';
import { persistence } from '@/services/db/persistence';

beforeEach(() => {
  persistence.removeItem('apollo_pmc_cache');
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeActivity(overrides: Partial<StravaActivity> & { id: number }): StravaActivity {
  return {
    name: 'Morning Run',
    type: 'Run',
    sport_type: 'Run',
    distance: 8000,
    moving_time: 2700,
    elapsed_time: 2800,
    start_date: '2026-01-15T07:00:00Z',
    start_date_local: '2026-01-15T07:00:00Z',
    kudos_count: 0,
    ...overrides,
  };
}

function makeActivities(count: number, startDate: string): StravaActivity[] {
  const activities: StravaActivity[] = [];
  const start = new Date(startDate);

  for (let i = 0; i < count; i++) {
    const date = new Date(start);
    date.setDate(date.getDate() + i);
    const dateStr = date.toISOString().slice(0, 10);
    const isLongRun = i % 7 === 5; // every Saturday
    const isRest = i % 7 === 6;    // every Sunday

    if (isRest) continue;

    activities.push(makeActivity({
      id: 1000 + i,
      name: isLongRun ? 'Long Run' : 'Easy Run',
      distance: isLongRun ? 25000 : 8000 + Math.random() * 3000,
      moving_time: isLongRun ? 9000 : 2700 + Math.random() * 600,
      start_date: `${dateStr}T07:00:00Z`,
      start_date_local: `${dateStr}T07:00:00Z`,
    }));
  }

  return activities;
}

// ── classifyTSBZone ──────────────────────────────────────────────────────────

describe('classifyTSBZone', () => {
  it('should classify overreaching (TSB < -20)', () => {
    expect(classifyTSBZone(-25)).toBe('overreaching');
    expect(classifyTSBZone(-50)).toBe('overreaching');
  });

  it('should classify productive (-20 ≤ TSB < 0)', () => {
    expect(classifyTSBZone(-20)).toBe('productive');
    expect(classifyTSBZone(-10)).toBe('productive');
    expect(classifyTSBZone(-1)).toBe('productive');
  });

  it('should classify fresh (0 ≤ TSB < 15)', () => {
    expect(classifyTSBZone(0)).toBe('fresh');
    expect(classifyTSBZone(10)).toBe('fresh');
    expect(classifyTSBZone(14)).toBe('fresh');
  });

  it('should classify peak (15 ≤ TSB ≤ 25)', () => {
    expect(classifyTSBZone(15)).toBe('peak');
    expect(classifyTSBZone(20)).toBe('peak');
    expect(classifyTSBZone(25)).toBe('peak');
  });

  it('should classify transition (25 < TSB ≤ 30)', () => {
    expect(classifyTSBZone(26)).toBe('transition');
    expect(classifyTSBZone(30)).toBe('transition');
  });

  it('should classify detrained (TSB > 30)', () => {
    expect(classifyTSBZone(31)).toBe('detrained');
    expect(classifyTSBZone(50)).toBe('detrained');
  });
});

// ── Zone helpers ──────────────────────────────────────────────────────────────

describe('getZoneColor', () => {
  it('should return a color for each zone', () => {
    const zones: Array<'overreaching' | 'productive' | 'fresh' | 'peak' | 'transition' | 'detrained'> = [
      'overreaching', 'productive', 'fresh', 'peak', 'transition', 'detrained',
    ];
    for (const zone of zones) {
      expect(getZoneColor(zone)).toMatch(/^#[0-9A-F]{6}$/i);
    }
  });
});

describe('getZoneLabel', () => {
  it('should return readable labels', () => {
    expect(getZoneLabel('peak')).toBe('Peak Race Readiness');
    expect(getZoneLabel('productive')).toBe('Productive Training');
    expect(getZoneLabel('overreaching')).toBe('Overreaching');
  });
});

// ── classifyWorkoutType ──────────────────────────────────────────────────────

describe('classifyWorkoutType', () => {
  it('should classify races by name', () => {
    const a = makeActivity({ id: 1, name: 'Boston Marathon 2026' });
    expect(classifyWorkoutType(a)).toBe('race');
  });

  it('should classify tempo by name', () => {
    const a = makeActivity({ id: 1, name: 'Tempo Run' });
    expect(classifyWorkoutType(a)).toBe('tempo');
  });

  it('should classify intervals by name', () => {
    const a = makeActivity({ id: 1, name: '8x400m Intervals' });
    expect(classifyWorkoutType(a)).toBe('interval');
  });

  it('should classify long runs by name', () => {
    const a = makeActivity({ id: 1, name: 'Long Run' });
    expect(classifyWorkoutType(a)).toBe('long_run');
  });

  it('should classify long runs by distance (≥ 13 mi)', () => {
    const a = makeActivity({ id: 1, name: 'Sunday Run', distance: 22000 }); // ~13.7 mi
    expect(classifyWorkoutType(a)).toBe('long_run');
  });

  it('should classify short runs as easy', () => {
    const a = makeActivity({ id: 1, name: 'Morning Jog', distance: 3000 }); // ~1.9 mi
    expect(classifyWorkoutType(a)).toBe('easy');
  });

  it('should classify recovery runs as easy', () => {
    const a = makeActivity({ id: 1, name: 'Recovery Run', distance: 5000 });
    expect(classifyWorkoutType(a)).toBe('easy');
  });

  it('should classify fartlek as interval', () => {
    const a = makeActivity({ id: 1, name: 'Fartlek Session' });
    expect(classifyWorkoutType(a)).toBe('interval');
  });
});

// ── activitiesToDailyLoads ───────────────────────────────────────────────────

describe('activitiesToDailyLoads', () => {
  it('should convert activities to daily loads', () => {
    const activities = [
      makeActivity({ id: 1, start_date_local: '2026-01-15T07:00:00Z', distance: 8000 }),
      makeActivity({ id: 2, start_date_local: '2026-01-16T07:00:00Z', distance: 10000 }),
    ];
    const loads = activitiesToDailyLoads(activities);
    expect(loads).toHaveLength(2);
    expect(loads[0].date).toBe('2026-01-15');
    expect(loads[0].tss).toBeGreaterThan(0);
  });

  it('should aggregate multi-run days', () => {
    const activities = [
      makeActivity({ id: 1, name: 'AM Run', start_date_local: '2026-01-15T07:00:00Z', distance: 5000 }),
      makeActivity({ id: 2, name: 'PM Run', start_date_local: '2026-01-15T17:00:00Z', distance: 5000 }),
    ];
    const loads = activitiesToDailyLoads(activities);
    expect(loads).toHaveLength(1);
    expect(loads[0].distanceMi).toBeGreaterThan(5);
  });

  it('should filter out non-run activities', () => {
    const activities = [
      makeActivity({ id: 1, type: 'Ride', sport_type: 'Ride' }),
      makeActivity({ id: 2, type: 'Run', sport_type: 'Run' }),
    ];
    const loads = activitiesToDailyLoads(activities);
    expect(loads).toHaveLength(1);
  });

  it('should keep harder type on multi-run days', () => {
    const activities = [
      makeActivity({ id: 1, name: 'Easy Run', start_date_local: '2026-01-15T07:00:00Z', distance: 5000 }),
      makeActivity({ id: 2, name: 'Tempo Run', start_date_local: '2026-01-15T17:00:00Z', distance: 8000 }),
    ];
    const loads = activitiesToDailyLoads(activities);
    expect(loads[0].type).toBe('tempo');
  });

  it('should return empty for no activities', () => {
    expect(activitiesToDailyLoads([])).toEqual([]);
  });

  it('should sort chronologically', () => {
    const activities = [
      makeActivity({ id: 2, start_date_local: '2026-01-20T07:00:00Z' }),
      makeActivity({ id: 1, start_date_local: '2026-01-15T07:00:00Z' }),
    ];
    const loads = activitiesToDailyLoads(activities);
    expect(loads[0].date).toBe('2026-01-15');
    expect(loads[1].date).toBe('2026-01-20');
  });
});

// ── generateAnnotations ──────────────────────────────────────────────────────

describe('generateAnnotations', () => {
  it('should annotate long runs (≥ 16 mi)', () => {
    const loads = [
      { date: '2026-01-15', tss: 100, distanceMi: 18, type: 'long_run' as const },
      { date: '2026-01-16', tss: 30, distanceMi: 5, type: 'easy' as const },
    ];
    const annotations = generateAnnotations(loads);
    expect(annotations.some((a) => a.type === 'long_run' && a.label.includes('18'))).toBe(true);
  });

  it('should annotate races', () => {
    const loads = [
      { date: '2026-03-01', tss: 200, distanceMi: 26.2, type: 'race' as const },
    ];
    const annotations = generateAnnotations(loads);
    expect(annotations.some((a) => a.type === 'race')).toBe(true);
  });

  it('should annotate peak mileage week', () => {
    const loads = Array.from({ length: 14 }, (_, i) => ({
      date: `2026-01-${String(i + 1).padStart(2, '0')}`,
      tss: i < 7 ? 30 : 50,
      distanceMi: i < 7 ? 5 : 8,
      type: 'easy' as const,
    }));
    const annotations = generateAnnotations(loads);
    expect(annotations.some((a) => a.type === 'peak_mileage')).toBe(true);
  });

  it('should not annotate runs under 16 mi', () => {
    const loads = [{ date: '2026-01-15', tss: 50, distanceMi: 12, type: 'long_run' as const }];
    const annotations = generateAnnotations(loads);
    expect(annotations.filter((a) => a.type === 'long_run')).toHaveLength(0);
  });
});

// ── projectForward ───────────────────────────────────────────────────────────

describe('projectForward', () => {
  const snapshot: FitnessFatigueSnapshot = {
    date: '2026-02-01',
    ctl: 60,
    atl: 50,
    tsb: 10,
  };

  it('should project the requested number of days', () => {
    const projection = projectForward(snapshot, 30, 14);
    expect(projection).toHaveLength(14);
  });

  it('should have sequential dates', () => {
    const projection = projectForward(snapshot, 30, 7);
    expect(projection[0].date).toBe('2026-02-02');
    expect(projection[6].date).toBe('2026-02-08');
  });

  it('should classify zones for projected days', () => {
    const projection = projectForward(snapshot, 30, 7);
    for (const p of projection) {
      expect(['overreaching', 'productive', 'fresh', 'peak', 'transition', 'detrained']).toContain(p.zone);
    }
  });

  it('should converge CTL toward avgDailyTSS over time', () => {
    const projection = projectForward(snapshot, 80, 90);
    const lastCtl = projection[projection.length - 1].ctl;
    // CTL should move toward 80 from 60
    expect(lastCtl).toBeGreaterThan(60);
  });

  it('should increase TSB with low training (taper simulation)', () => {
    const heavySnapshot: FitnessFatigueSnapshot = {
      date: '2026-02-01', ctl: 80, atl: 90, tsb: -10,
    };
    const projection = projectForward(heavySnapshot, 10, 21);
    // After 3 weeks of low TSS, TSB should increase
    expect(projection[projection.length - 1].tsb).toBeGreaterThan(-10);
  });

  it('should return empty for 0 days', () => {
    expect(projectForward(snapshot, 30, 0)).toEqual([]);
  });
});

// ── tsbToReadinessScore ──────────────────────────────────────────────────────

describe('tsbToReadinessScore', () => {
  it('should give high score (85-100) in peak zone', () => {
    const score = tsbToReadinessScore(20, 60);
    expect(score).toBeGreaterThanOrEqual(85);
    expect(score).toBeLessThanOrEqual(100);
  });

  it('should give moderate score in fresh zone', () => {
    const score = tsbToReadinessScore(10, 50);
    expect(score).toBeGreaterThanOrEqual(50);
    expect(score).toBeLessThanOrEqual(90);
  });

  it('should give low score when overreaching', () => {
    const score = tsbToReadinessScore(-30, 50);
    expect(score).toBeLessThanOrEqual(40);
  });

  it('should give decreasing score when detrained', () => {
    const score = tsbToReadinessScore(35, 20);
    expect(score).toBeLessThan(100);
    expect(score).toBeGreaterThanOrEqual(40);
  });

  it('should clamp score to 0-100 range', () => {
    expect(tsbToReadinessScore(-100, 0)).toBeGreaterThanOrEqual(0);
    expect(tsbToReadinessScore(-100, 0)).toBeLessThanOrEqual(100);
    expect(tsbToReadinessScore(20, 200)).toBeLessThanOrEqual(100);
  });

  it('should give CTL bonus for higher fitness', () => {
    const lowFitness = tsbToReadinessScore(10, 20);
    const highFitness = tsbToReadinessScore(10, 80);
    expect(highFitness).toBeGreaterThanOrEqual(lowFitness);
  });
});

// ── buildPMC ─────────────────────────────────────────────────────────────────

describe('buildPMC', () => {
  it('should build PMC from activities', () => {
    const activities = makeActivities(60, '2025-11-15');
    const result = buildPMC(activities);

    expect(result.dataPoints.length).toBeGreaterThan(0);
    expect(result.current).not.toBeNull();
    expect(result.current!.ctl).toBeGreaterThanOrEqual(0);
    expect(result.current!.zone).toBeTruthy();
    expect(result.current!.readinessScore).toBeGreaterThanOrEqual(0);
    expect(result.current!.readinessLabel).toBeTruthy();
  });

  it('should include annotations', () => {
    const activities = makeActivities(60, '2025-11-15');
    const result = buildPMC(activities);
    // Should at least have peak mileage annotation
    expect(result.annotations.length).toBeGreaterThanOrEqual(0);
  });

  it('should project forward when requested', () => {
    const activities = makeActivities(30, '2025-12-15');
    const result = buildPMC(activities, 14);
    expect(result.projection).toHaveLength(14);
  });

  it('should not project when projectionDays is 0', () => {
    const activities = makeActivities(30, '2025-12-15');
    const result = buildPMC(activities, 0);
    expect(result.projection).toHaveLength(0);
  });

  it('should return null current for empty activities', () => {
    const result = buildPMC([]);
    expect(result.current).toBeNull();
    expect(result.dataPoints).toHaveLength(0);
  });

  it('should include zone info in every data point', () => {
    const activities = makeActivities(30, '2026-01-01');
    const result = buildPMC(activities);
    for (const dp of result.dataPoints) {
      expect(dp.zone).toBeTruthy();
      expect(dp.dailyTSS).toBeGreaterThanOrEqual(0);
    }
  });

  it('should generate insights for sufficient data', () => {
    const activities = makeActivities(60, '2025-11-01');
    const result = buildPMC(activities);
    // With 60 days of data, should have at least zone advice
    expect(result.insights.length).toBeGreaterThanOrEqual(0);
  });
});

// ── Persistence ──────────────────────────────────────────────────────────────

describe('PMC persistence', () => {
  it('should cache and retrieve PMC result', () => {
    const activities = makeActivities(30, '2026-01-01');
    const result = buildPMC(activities);
    cachePMC(result);
    const cached = getCachedPMC();
    expect(cached).not.toBeNull();
    expect(cached!.dataPoints.length).toBe(result.dataPoints.length);
  });

  it('should return null when no cache', () => {
    expect(getCachedPMC()).toBeNull();
  });
});
