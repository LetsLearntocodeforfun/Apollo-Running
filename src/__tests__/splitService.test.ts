/**
 * splitService.test.ts — Tests for the Split & Lap Analysis Engine.
 *
 * Validates: split processing, lap processing, pace consistency analysis,
 * split pattern detection, interval detection, insight generation,
 * caching, and the main analyzeSplits entry point.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  processSplits,
  processLaps,
  analyzePaceConsistency,
  detectSplitPattern,
  detectIntervals,
  analyzeSplits,
  getCachedSplitAnalysis,
  hasSplitData,
  formatPaceShort,
} from '@/services/splitService';
import { setDistanceUnit } from '@/services/unitPreferences';
import type { StravaSplit, StravaLap, StravaActivity } from '@/services/strava';

// ─── Helpers ─────────────────────────────────────────────────

const MILE_M = 1609.344;
const KM_M = 1000;

/** Create a mock Strava split (per-mile or per-km). */
function mockSplit(overrides: Partial<StravaSplit> = {}): StravaSplit {
  return {
    distance: MILE_M,
    elapsed_time: 480,
    moving_time: 480,
    average_speed: MILE_M / 480,
    average_heartrate: 155,
    elevation_difference: 5,
    split: 1,
    pace_zone: 3,
    ...overrides,
  };
}

/** Create a series of mock splits with varying paces. */
function mockSplitSeries(paces: number[], unit: 'mi' | 'km' = 'mi'): StravaSplit[] {
  const dist = unit === 'km' ? KM_M : MILE_M;
  return paces.map((paceMin, i) => ({
    distance: dist,
    elapsed_time: Math.round(paceMin * 60),
    moving_time: Math.round(paceMin * 60),
    average_speed: dist / (paceMin * 60),
    average_heartrate: 140 + i * 2,
    elevation_difference: (i % 2 === 0 ? 3 : -2),
    split: i + 1,
    pace_zone: 3,
  }));
}

/** Create a mock Strava lap. */
function mockLap(overrides: Partial<StravaLap> = {}): StravaLap {
  return {
    id: 1,
    name: 'Lap 1',
    lap_index: 0,
    split: 1,
    distance: MILE_M,
    elapsed_time: 480,
    moving_time: 480,
    average_speed: MILE_M / 480,
    max_speed: 5.0,
    average_heartrate: 155,
    max_heartrate: 170,
    average_cadence: 88,
    total_elevation_gain: 10,
    start_index: 0,
    end_index: 100,
    pace_zone: 3,
    ...overrides,
  };
}

/** Create a mock StravaActivity with splits. */
function mockActivity(opts: {
  splits_standard?: StravaSplit[];
  splits_metric?: StravaSplit[];
  laps?: StravaLap[];
} = {}): StravaActivity {
  return {
    id: 12345,
    name: 'Morning Run',
    type: 'Run',
    sport_type: 'Run',
    distance: 10000,
    moving_time: 3000,
    elapsed_time: 3100,
    total_elevation_gain: 50,
    start_date: '2024-01-15T07:00:00Z',
    start_date_local: '2024-01-15T07:00:00',
    average_speed: 3.33,
    max_speed: 4.5,
    average_heartrate: 155,
    max_heartrate: 175,
    map: { id: 'a123', summary_polyline: '' },
    ...opts,
  } as StravaActivity;
}

// ─── processSplits ───────────────────────────────────────────

describe('processSplits', () => {
  it('returns empty array for null/undefined input', () => {
    expect(processSplits(null as unknown as StravaSplit[], 'mi')).toEqual([]);
    expect(processSplits(undefined as unknown as StravaSplit[], 'mi')).toEqual([]);
  });

  it('returns empty for fewer than 2 splits', () => {
    expect(processSplits([mockSplit()], 'mi')).toEqual([]);
  });

  it('processes 3 splits with correct pace values', () => {
    const splits = mockSplitSeries([8, 7.5, 8.5], 'mi');
    const result = processSplits(splits, 'mi');
    expect(result).toHaveLength(3);
    expect(result[0].paceMinPerUnit).toBeCloseTo(8.0, 1);
    expect(result[1].paceMinPerUnit).toBeCloseTo(7.5, 1);
    expect(result[2].paceMinPerUnit).toBeCloseTo(8.5, 1);
  });

  it('marks fastest and slowest splits', () => {
    const splits = mockSplitSeries([8, 7, 9, 8], 'mi');
    const result = processSplits(splits, 'mi');
    expect(result.find(s => s.isFastest)?.number).toBe(2);
    expect(result.find(s => s.isSlowest)?.number).toBe(3);
  });

  it('filters out very short partial splits', () => {
    const splits = [
      ...mockSplitSeries([8, 8], 'mi'),
      mockSplit({ distance: MILE_M * 0.2, split: 3, moving_time: 120 }), // < 40%
    ];
    const result = processSplits(splits, 'mi');
    expect(result).toHaveLength(2);
  });

  it('calculates pace deviation from mean', () => {
    const splits = mockSplitSeries([8, 8, 8], 'mi');
    const result = processSplits(splits, 'mi');
    // All same pace → deviation should be ~0
    result.forEach(s => expect(Math.abs(s.paceDeviationPct)).toBeLessThan(1));
  });

  it('works with km splits', () => {
    const splits = mockSplitSeries([5, 5.2, 4.8], 'km');
    const result = processSplits(splits, 'km');
    expect(result).toHaveLength(3);
    expect(result[0].paceMinPerUnit).toBeCloseTo(5.0, 1);
  });

  it('populates HR and elevation', () => {
    const splits = mockSplitSeries([8, 8], 'mi');
    const result = processSplits(splits, 'mi');
    expect(result[0].avgHR).toBe(140);
    expect(result[0].elevationDiffMeters).toBeDefined();
  });
});

// ─── processLaps ─────────────────────────────────────────────

describe('processLaps', () => {
  it('returns empty for null/undefined', () => {
    expect(processLaps(null as unknown as StravaLap[], 'mi')).toEqual([]);
  });

  it('processes laps with correct pace', () => {
    const laps = [
      mockLap({ lap_index: 0, distance: MILE_M, moving_time: 480, name: 'Lap 1' }),
      mockLap({ lap_index: 1, distance: MILE_M, moving_time: 420, name: 'Lap 2' }),
    ];
    const result = processLaps(laps, 'mi');
    expect(result).toHaveLength(2);
    expect(result[0].paceMinPerUnit).toBeCloseTo(8.0, 1);
    expect(result[1].paceMinPerUnit).toBeCloseTo(7.0, 1);
  });

  it('doubles cadence from Strava (half-cycle) to steps-per-min', () => {
    const laps = [mockLap({ average_cadence: 88 })];
    const result = processLaps(laps, 'mi');
    expect(result[0].avgCadenceSpm).toBe(176);
  });

  it('returns null cadence when not available', () => {
    const laps = [mockLap({ average_cadence: undefined as unknown as number })];
    const result = processLaps(laps, 'mi');
    expect(result[0].avgCadenceSpm).toBeNull();
  });
});

// ─── analyzePaceConsistency ──────────────────────────────────

describe('analyzePaceConsistency', () => {
  it('grades gold for CV < 4%', () => {
    // All splits at ~8:00 pace with tiny variation
    const splits = processSplits(mockSplitSeries([8.0, 8.05, 7.95, 8.02, 7.98], 'mi'), 'mi');
    const result = analyzePaceConsistency(splits);
    expect(result.grade).toBe('gold');
    expect(result.coefficientOfVariation).toBeLessThan(4);
  });

  it('grades silver for CV 4-7%', () => {
    const splits = processSplits(mockSplitSeries([8.0, 8.5, 7.5, 8.4, 7.6], 'mi'), 'mi');
    const result = analyzePaceConsistency(splits);
    expect(result.grade).toBe('silver');
    expect(result.coefficientOfVariation).toBeGreaterThanOrEqual(4);
    expect(result.coefficientOfVariation).toBeLessThan(7);
  });

  it('grades bronze for CV 7-12%', () => {
    // CV ≈ 10.4% → bronze
    const splits = processSplits(mockSplitSeries([7.0, 9.0, 7.5, 8.5, 7.0], 'mi'), 'mi');
    const result = analyzePaceConsistency(splits);
    expect(result.grade).toBe('bronze');
  });

  it('grades iron for CV >= 12%', () => {
    const splits = processSplits(mockSplitSeries([6.0, 10.0, 6.5, 9.5], 'mi'), 'mi');
    const result = analyzePaceConsistency(splits);
    expect(result.grade).toBe('iron');
  });

  it('calculates mean pace accurately', () => {
    const splits = processSplits(mockSplitSeries([8, 8, 8, 8], 'mi'), 'mi');
    const result = analyzePaceConsistency(splits);
    expect(result.meanPace).toBeCloseTo(8.0, 1);
  });

  it('computes correct range in seconds', () => {
    const splits = processSplits(mockSplitSeries([8, 9, 8, 8], 'mi'), 'mi');
    const result = analyzePaceConsistency(splits);
    expect(result.rangeSec).toBeCloseTo(60, 0);
  });

  it('handles insufficient splits gracefully', () => {
    const result = analyzePaceConsistency([]);
    expect(result.grade).toBe('iron');
    expect(result.coefficientOfVariation).toBe(0);
  });
});

// ─── detectSplitPattern ──────────────────────────────────────

describe('detectSplitPattern', () => {
  it('detects negative split (2nd half faster)', () => {
    // Moderate negative split with 8 splits to avoid false surge trigger
    const splits = processSplits(
      mockSplitSeries([8.2, 8.2, 8.1, 8.1, 7.8, 7.8, 7.9, 7.9], 'mi'),
      'mi',
    );
    const result = detectSplitPattern(splits, 'mi');
    expect(result.pattern).toBe('negative');
    expect(result.halfDiffPct).toBeLessThan(0);
    expect(result.description).toContain('Negative split');
  });

  it('detects positive split (1st half faster)', () => {
    const splits = processSplits(
      mockSplitSeries([7.8, 7.8, 7.9, 7.9, 8.2, 8.2, 8.1, 8.1], 'mi'),
      'mi',
    );
    const result = detectSplitPattern(splits, 'mi');
    expect(result.pattern).toBe('positive');
    expect(result.halfDiffPct).toBeGreaterThan(0);
  });

  it('detects even split within tolerance', () => {
    const splits = processSplits(mockSplitSeries([8.0, 8.02, 8.01, 7.99], 'mi'), 'mi');
    const result = detectSplitPattern(splits, 'mi');
    expect(result.pattern).toBe('even');
  });

  it('detects fade pattern in last quarter', () => {
    // Strong fade: steady then sudden slowdown
    const splits = processSplits(
      mockSplitSeries([8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 10], 'mi'),
      'mi',
    );
    const result = detectSplitPattern(splits, 'mi');
    expect(result.pattern).toBe('fade');
    expect(result.description).toContain('fade');
  });

  it('returns variable for insufficient splits', () => {
    const splits = processSplits(mockSplitSeries([8, 8], 'mi'), 'mi');
    const result = detectSplitPattern(splits, 'mi');
    expect(result.pattern).toBe('variable');
  });
});

// ─── detectIntervals ─────────────────────────────────────────

describe('detectIntervals', () => {
  it('returns null for fewer than 3 laps', () => {
    const laps = processLaps([mockLap(), mockLap({ lap_index: 1 })], 'mi');
    expect(detectIntervals(laps)).toBeNull();
  });

  it('detects interval workout from alternating fast/slow laps', () => {
    const laps = processLaps([
      mockLap({ lap_index: 0, name: 'Warmup', distance: MILE_M, moving_time: 600 }),
      mockLap({ lap_index: 1, name: 'Interval 1', distance: MILE_M * 0.25, moving_time: 90 }),
      mockLap({ lap_index: 2, name: 'Recovery 1', distance: MILE_M * 0.25, moving_time: 180 }),
      mockLap({ lap_index: 3, name: 'Interval 2', distance: MILE_M * 0.25, moving_time: 88 }),
      mockLap({ lap_index: 4, name: 'Recovery 2', distance: MILE_M * 0.25, moving_time: 175 }),
      mockLap({ lap_index: 5, name: 'Cooldown', distance: MILE_M, moving_time: 600 }),
    ], 'mi');

    const result = detectIntervals(laps);
    expect(result).not.toBeNull();
    expect(result!.isInterval).toBe(true);
    expect(result!.workIntervals).toBeGreaterThanOrEqual(2);
  });

  it('returns isInterval=false for steady-pace laps', () => {
    // All laps at same pace → no intervals
    const laps = processLaps([
      mockLap({ lap_index: 0, distance: MILE_M, moving_time: 480 }),
      mockLap({ lap_index: 1, distance: MILE_M, moving_time: 478 }),
      mockLap({ lap_index: 2, distance: MILE_M, moving_time: 482 }),
      mockLap({ lap_index: 3, distance: MILE_M, moving_time: 480 }),
    ], 'mi');

    const result = detectIntervals(laps);
    expect(result).not.toBeNull();
    expect(result!.isInterval).toBe(false);
  });
});

// ─── formatPaceShort ─────────────────────────────────────────

describe('formatPaceShort', () => {
  it('formats 8.5 as 8:30', () => {
    expect(formatPaceShort(8.5)).toBe('8:30');
  });

  it('formats 5.0 as 5:00', () => {
    expect(formatPaceShort(5)).toBe('5:00');
  });

  it('returns — for zero', () => {
    expect(formatPaceShort(0)).toBe('—');
  });

  it('returns — for > 30', () => {
    expect(formatPaceShort(31)).toBe('—');
  });
});

// ─── analyzeSplits (Integration) ─────────────────────────────

describe('analyzeSplits', () => {
  beforeEach(() => {
    setDistanceUnit('mi');
  });

  it('returns null if no split data', () => {
    const activity = mockActivity();
    expect(analyzeSplits(activity)).toBeNull();
  });

  it('returns null if only 1 split', () => {
    const activity = mockActivity({
      splits_standard: [mockSplit()],
    });
    expect(analyzeSplits(activity)).toBeNull();
  });

  it('performs full analysis for a 6-mile run with standard splits', () => {
    const activity = mockActivity({
      splits_standard: mockSplitSeries([8.0, 8.1, 7.9, 8.0, 7.8, 8.2], 'mi'),
      laps: [
        mockLap({ lap_index: 0, distance: MILE_M, moving_time: 480, name: 'Lap 1' }),
        mockLap({ lap_index: 1, distance: MILE_M, moving_time: 486, name: 'Lap 2' }),
        mockLap({ lap_index: 2, distance: MILE_M, moving_time: 474, name: 'Lap 3' }),
      ],
    });

    const result = analyzeSplits(activity);
    expect(result).not.toBeNull();

    // Splits
    expect(result!.splits).toHaveLength(6);
    expect(result!.splits[0].paceMinPerUnit).toBeCloseTo(8.0, 1);

    // Consistency
    expect(result!.consistency.grade).toBeDefined();
    expect(result!.consistency.coefficientOfVariation).toBeGreaterThan(0);

    // Pattern
    expect(['negative', 'positive', 'even', 'variable', 'fade', 'surge']).toContain(result!.pattern.pattern);

    // Laps
    expect(result!.laps).toHaveLength(3);

    // Metadata
    expect(result!.unit).toBe('mi');
    expect(result!.activityId).toBe(12345);
    expect(result!.analyzedAt).toBeTruthy();

    // Insights
    expect(result!.insights).toBeDefined();
    expect(Array.isArray(result!.insights)).toBe(true);
  });

  it('uses km splits when unit preference is km', () => {
    setDistanceUnit('km');
    const activity = mockActivity({
      splits_metric: mockSplitSeries([5.0, 5.1, 4.9, 5.0], 'km'),
    });

    const result = analyzeSplits(activity);
    expect(result).not.toBeNull();
    expect(result!.unit).toBe('km');
    expect(result!.splits).toHaveLength(4);
  });

  it('caches analysis and retrieves it', () => {
    const activity = mockActivity({
      splits_standard: mockSplitSeries([8, 8, 8, 8], 'mi'),
    });

    analyzeSplits(activity);
    const cached = getCachedSplitAnalysis(12345);
    expect(cached).not.toBeNull();
    expect(cached!.activityId).toBe(12345);
  });
});

// ─── hasSplitData ────────────────────────────────────────────

describe('hasSplitData', () => {
  it('returns false for no splits', () => {
    expect(hasSplitData(mockActivity())).toBe(false);
  });

  it('returns false for only 1 split', () => {
    expect(hasSplitData(mockActivity({
      splits_standard: [mockSplit()],
    }))).toBe(false);
  });

  it('returns true for 2+ standard splits', () => {
    expect(hasSplitData(mockActivity({
      splits_standard: mockSplitSeries([8, 8], 'mi'),
    }))).toBe(true);
  });

  it('returns true for 2+ metric splits', () => {
    expect(hasSplitData(mockActivity({
      splits_metric: mockSplitSeries([5, 5], 'km'),
    }))).toBe(true);
  });
});

// ─── Insight Generation (via full analysis) ──────────────────

describe('insight generation', () => {
  beforeEach(() => {
    setDistanceUnit('mi');
  });

  it('generates gold consistency insight for metronomic pacing', () => {
    const activity = mockActivity({
      splits_standard: mockSplitSeries([8.0, 8.01, 7.99, 8.0, 8.0], 'mi'),
    });
    const result = analyzeSplits(activity);
    const goldInsight = result?.insights.find(i =>
      i.category === 'consistency' && i.message.includes('Metronomic'),
    );
    expect(goldInsight).toBeDefined();
    expect(goldInsight!.sentiment).toBe('positive');
  });

  it('generates negative split insight', () => {
    const activity = mockActivity({
      splits_standard: mockSplitSeries([8.2, 8.2, 8.1, 8.1, 7.8, 7.8, 7.9, 7.9], 'mi'),
    });
    const result = analyzeSplits(activity);
    const patternInsight = result?.insights.find(i =>
      i.category === 'pattern' && i.message.includes('Negative split'),
    );
    expect(patternInsight).toBeDefined();
    expect(patternInsight!.sentiment).toBe('positive');
  });

  it('generates HR drift insight for significant cardiac drift', () => {
    // Create splits with rising HR
    const splits = Array.from({ length: 8 }, (_, i) => mockSplit({
      split: i + 1,
      distance: MILE_M,
      moving_time: 480,
      average_heartrate: 140 + i * 6, // 140 to 182
    }));
    const activity = mockActivity({ splits_standard: splits });
    const result = analyzeSplits(activity);
    const hrInsight = result?.insights.find(i => i.category === 'heartrate');
    expect(hrInsight).toBeDefined();
    expect(hrInsight!.message).toContain('drift');
  });
});
