/**
 * Comprehensive tests for graduated src/services/aerobicDecoupling.ts
 * and AerobicDurabilitySection in src/pages/Progress.tsx.
 *
 * Covers:
 * - A-02: Joe Friel Efficiency Factor (speed m/min ÷ HR) & Pa:HR % sign correctness
 * - A-18: Trailing partial split removal (< 50% median distance) & exact duration-weighted midpoint
 * - A-21: Honest EF unit labeling (`m/min/bpm`) & km / mi pace formatting via unitPreferences
 * - A-26: Steady-state gating (interval workouts, structured laps, short runs, extreme elevation swing)
 * - Empty, zero-HR, NaN, Infinity, non-run, and hidden-activity edge cases
 * - Progress.tsx AerobicDurabilitySection empty state, <= 5% Coupled badge, EF trend, and unit support
 */

import { createElement } from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import {
  calculateDecoupling,
  analyzeActivityDecoupling,
  getSteadyRunDecouplingHistory,
  buildAerobicDurabilityOverview,
  formatEfficiencyFactor,
  gradeCostMultiplier,
  rateDecoupling,
  getDecouplingCoachingMessage,
  saveDecouplingResult,
  getDecouplingTrend,
  LONG_RUN_DECOUPLING_MIN_DURATION_SEC,
  MIN_STEADY_DURATION_SEC,
  STEADY_HISTORY_MIN_DURATION_SEC,
  type SplitHRPace,
} from '@/services/aerobicDecoupling';
import { storeActivities } from '@/services/analyticsService';
import { setDistanceUnit } from '@/services/unitPreferences';
import type { Activity, ActivityLap, ActivitySplit } from '@/services/activity/types';
import { AerobicDurabilitySection } from '@/pages/Progress';

const METERS_PER_MILE = 1609.344;

function makeActivity(overrides: Partial<Activity> & { id: number }): Activity {
  return {
    name: 'Sunday Steady Long Run',
    type: 'Run',
    sport_type: 'Run',
    distance: 20_000,
    moving_time: 6_000,
    elapsed_time: 6_060,
    start_date: '2026-10-18T13:00:00Z',
    start_date_local: '2026-10-18T08:00:00Z',
    average_heartrate: 148,
    max_heartrate: 160,
    kudos_count: 0,
    source: 'intervals',
    source_id: `act-${overrides.id}`,
    ...overrides,
  };
}

function makeMetricSplits(
  items: { distM?: number; timeSec: number; hr?: number; elevDiffM?: number }[],
): ActivitySplit[] {
  return items.map((it, idx) => {
    const distance = it.distM ?? 1000;
    const moving_time = it.timeSec;
    return {
      split: idx + 1,
      distance,
      moving_time,
      elapsed_time: moving_time,
      average_speed: distance / moving_time,
      average_heartrate: it.hr,
      elevation_difference: it.elevDiffM ?? 0,
    };
  });
}

beforeEach(() => {
  setDistanceUnit('mi');
});

// ── A-02: Sign Correctness & Friel Thresholds ────────────────────────────────

describe('A-02: Efficiency Factor (EF) & Pa:HR sign correctness', () => {
  it('computes positive Pa:HR (> 5%, high) when a runner fades in pace while HR rises', () => {
    // 8 mi @ 8:00/mi (201.17 m/min) & 145 bpm, then 8 mi @ 8:30/mi (189.33 m/min) & 158 bpm.
    // Halves split at half the moving time (3,960 s): half 1 = 3,840 s fast + 120 s slow
    //   -> 200.81 m/min @ 145.39 bpm -> EF1 = 1.381; half 2 = all slow -> EF2 = 1.198 m/min/bpm
    // Pa:HR = ((1.38114 - 1.19832) / 1.38114) * 100 = +13.24%
    const splits: SplitHRPace[] = [
      ...Array.from({ length: 8 }, (_, i) => ({ mile: i + 1, paceSec: 480, avgHR: 145 })),
      ...Array.from({ length: 8 }, (_, i) => ({ mile: i + 9, paceSec: 510, avgHR: 158 })),
    ];

    const res = calculateDecoupling(splits, 16, 101, '2026-10-04');
    expect(res).not.toBeNull();
    expect(res!.efFirstHalf).toBeCloseTo(1.381, 2);
    expect(res!.efSecondHalf).toBeCloseTo(1.198, 2);
    expect(res!.efFirstHalf).toBeGreaterThan(res!.efSecondHalf);
    expect(res!.decouplingPct).toBeCloseTo(13.24, 1);
    expect(res!.rating).toBe('high');
    expect(res!.rating).not.toBe('excellent');
    expect(res!.isCoupled).toBe(false);
    expect(res!.isSteadyState).toBe(true);
  });

  it('computes positive Pa:HR when pace slows even if HR remains constant (pins old HR/pace bug)', () => {
    // Under the buggy HR/paceSec formula, slowing from 8:00/mi to 9:00/mi at 150 bpm
    // gave -11.1% ('excellent')! Under true Friel EF with time halves (3,060 s each),
    // EF drops 1.332 -> 1.192 => +10.53% ('high').
    const splits: SplitHRPace[] = [
      ...Array.from({ length: 6 }, (_, i) => ({ mile: i + 1, paceSec: 480, avgHR: 150 })),
      ...Array.from({ length: 6 }, (_, i) => ({ mile: i + 7, paceSec: 540, avgHR: 150 })),
    ];

    const res = calculateDecoupling(splits, 12, 102, '2026-10-05');
    expect(res).not.toBeNull();
    expect(res!.decouplingPct).toBeCloseTo(10.53, 1);
    expect(res!.rating).toBe('high');
    expect(res!.isCoupled).toBe(false);
  });

  it('splits the halves by moving time, not distance: 5:00/km then 6:00/km at 150 bpm gives ~15.4%', () => {
    // 10 km @ 5:00/km then 10 km @ 6:00/km, HR constant 150 bpm. Total 6,600 s, so the midpoint
    // (3,300 s) falls 300 s into the first 6:00 km, which is prorated by time.
    // Time halves (Friel / TrainingPeaks): EF1 = 196.97 / 150, EF2 = 166.67 / 150 -> +15.38%.
    // Splitting at half the distance instead would give +16.67%.
    const splits: SplitHRPace[] = Array.from({ length: 20 }, (_, i) => ({
      mile: i + 1,
      paceSec: 0,
      avgHR: 150,
      distanceM: 1000,
      durationSec: i < 10 ? 300 : 360,
    }));

    const res = calculateDecoupling(splits, 12.43, 106, '2026-10-07', { minDistanceMi: 0.5, minSplits: 2 });
    expect(res).not.toBeNull();
    expect(res!.decouplingPct).toBeCloseTo(15.38, 2);
    expect(res!.decouplingPct).not.toBeCloseTo(16.67, 1);
    expect(res!.efFirstHalf).toBeCloseTo(196.97 / 150, 3);
    expect(res!.efSecondHalf).toBeCloseTo(166.67 / 150, 3);
    expect(res!.paceFirstHalf).toBe(Math.round((1609.344 * 60) / (6_500_000 / 33_000)));
    expect(res!.hrFirstHalf).toBe(150);
    expect(res!.isSteadyState).toBe(true);
  });

  it('keeps the eligibility gates: 30 min steady, 40 min history, 60 min long runs, at least 4 splits', () => {
    expect(MIN_STEADY_DURATION_SEC).toBe(30 * 60);
    expect(STEADY_HISTORY_MIN_DURATION_SEC).toBe(40 * 60);
    expect(LONG_RUN_DECOUPLING_MIN_DURATION_SEC).toBe(60 * 60);
    // 3 full splits (36 min) still can't support a steady-state half comparison
    const threeSplits = calculateDecoupling(
      Array.from({ length: 3 }, (_, i) => ({ mile: i + 1, paceSec: 720, avgHR: 140 })),
      3,
      107,
      '2026-10-08',
      { minDistanceMi: 0.5, minSplits: 2 },
    );
    expect(threeSplits).not.toBeNull();
    expect(threeSplits!.isSteadyState).toBe(false);
  });

  it('computes slight negative Pa:HR (-2.3%) and coupled rating for a controlled negative split at steady HR', () => {
    // Half 1: EF1 ~= 1.300 m/min/bpm (195 m/min @ 150 bpm)
    // Half 2: EF2 ~= 1.330 m/min/bpm (mostly 199.5 m/min @ 150 bpm; the time midpoint falls
    //         ~39 s before the faster miles start, so EF2 = 1.3297)
    // Pa:HR = ((1.30 - 1.3297) / 1.30) * 100 = -2.28%
    const pace1 = (METERS_PER_MILE / 195) * 60;
    const pace2 = (METERS_PER_MILE / 199.5) * 60;
    const splits: SplitHRPace[] = [
      ...Array.from({ length: 7 }, (_, i) => ({ mile: i + 1, paceSec: pace1, avgHR: 150 })),
      ...Array.from({ length: 7 }, (_, i) => ({ mile: i + 8, paceSec: pace2, avgHR: 150 })),
    ];

    const res = calculateDecoupling(splits, 14, 103, '2026-10-06');
    expect(res).not.toBeNull();
    expect(res!.efFirstHalf).toBeCloseTo(1.3, 2);
    expect(res!.efSecondHalf).toBeCloseTo(1.33, 2);
    expect(res!.decouplingPct).toBeCloseTo(-2.28, 1);
    expect(res!.rating).toBe('excellent');
    expect(res!.isCoupled).toBe(true);
  });

  it('classifies coupled marathon long runs across Friel rating bands', () => {
    // 2.0% drift -> 'excellent' (<= 3.5%)
    const excellentSplits: SplitHRPace[] = [
      ...Array.from({ length: 9 }, (_, i) => ({ mile: i + 1, paceSec: 480, avgHR: 147 })),
      ...Array.from({ length: 9 }, (_, i) => ({ mile: i + 10, paceSec: 480, avgHR: 150 })),
    ];
    const exc = calculateDecoupling(excellentSplits, 18, 104, '2026-10-10')!;
    expect(exc.decouplingPct).toBeCloseTo(2.0, 1);
    expect(exc.rating).toBe('excellent');
    expect(exc.isCoupled).toBe(true);

    // 4.5% drift -> 'good' (3.5% < pct <= 5.0%, still coupled!)
    const goodSplits: SplitHRPace[] = [
      ...Array.from({ length: 10 }, (_, i) => ({ mile: i + 1, paceSec: 480, avgHR: 148 })),
      ...Array.from({ length: 10 }, (_, i) => ({ mile: i + 11, paceSec: 480, avgHR: 155 })),
    ];
    const good = calculateDecoupling(goodSplits, 20, 105, '2026-10-17')!;
    expect(good.decouplingPct).toBeCloseTo(4.52, 1);
    expect(good.rating).toBe('good');
    expect(good.isCoupled).toBe(true);

    // Direct boundary checks on rateDecoupling
    expect(rateDecoupling(3.5)).toBe('excellent');
    expect(rateDecoupling(3.6)).toBe('good');
    expect(rateDecoupling(5.0)).toBe('good');
    expect(rateDecoupling(-8.0)).toBe('good');
    expect(rateDecoupling(5.1)).toBe('moderate');
    expect(rateDecoupling(8.0)).toBe('moderate');
    expect(rateDecoupling(8.1)).toBe('high');
  });
});

// ── A-18: Trailing Partial Split & Weighted Midpoint ─────────────────────────

describe('A-18: Trailing partial split exclusion & duration-weighted halves', () => {
  it('automatically drops a 0.18 mi trailing partial split without skewing second-half EF', () => {
    const fullMiles: SplitHRPace[] = Array.from({ length: 16 }, (_, i) => ({
      mile: i + 1,
      paceSec: 480,
      avgHR: 148,
      distanceM: METERS_PER_MILE,
      durationSec: 480,
    }));
    // Add a noisy 0.18 mi (290 m) cooldown/crosswalk stub at 12:30/mi & 168 bpm
    const withPartialStub: SplitHRPace[] = [
      ...fullMiles,
      {
        mile: 17,
        paceSec: 750,
        avgHR: 168,
        distanceM: 0.18 * METERS_PER_MILE,
        durationSec: 135,
      },
    ];

    const res = calculateDecoupling(withPartialStub, 16.18, 201, '2026-10-11');
    expect(res).not.toBeNull();
    expect(res!.droppedTrailingPartial).toBe(true);
    expect(res!.splitsUsed).toBe(16);
    expect(res!.decouplingPct).toBe(0);
    expect(res!.efFirstHalf).toBe(res!.efSecondHalf);
  });

  it('weights odd split counts symmetrically across exact temporal midpoint', () => {
    // 9 full splits: first 4 @ 145 bpm, middle split 5 @ 150 bpm, last 4 @ 155 bpm (constant 480s pace).
    // Exact midpoint splits split #5 50/50 -> Half 1 HR = (4*145 + 0.5*150)/4.5 = 145.556,
    // Half 2 HR = (0.5*150 + 4*155)/4.5 = 154.444 -> Pa:HR = (1 - 145.556/154.444)*100 = 5.76%.
    const splits: SplitHRPace[] = Array.from({ length: 9 }, (_, i) => ({
      mile: i + 1,
      paceSec: 480,
      avgHR: i < 4 ? 145 : i === 4 ? 150 : 155,
      distanceM: METERS_PER_MILE,
      durationSec: 480,
    }));

    const res = calculateDecoupling(splits, 9, 202, '2026-10-12');
    expect(res).not.toBeNull();
    expect(res!.decouplingPct).toBeCloseTo(5.76, 1);
  });

  it('extracts splits_metric from Activity, drops partial km stub, and applies Minetti grade adjustment', () => {
    // 16 km run: first 8 km flat @ 5:00/km (300s) & 150 bpm;
    // second 8 km gentle +3% uphill (+30m/km) where runner slows naturally to match metabolic cost @ 150 bpm;
    // plus a 220m partial stub at the end.
    const uphillMultiplier = gradeCostMultiplier(0.03);
    expect(uphillMultiplier).toBeGreaterThan(1.1);

    const splits_metric = makeMetricSplits([
      ...Array.from({ length: 8 }, () => ({ distM: 1000, timeSec: 300, hr: 150, elevDiffM: 0 })),
      ...Array.from({ length: 8 }, () => ({
        distM: 1000,
        timeSec: Math.round(300 * uphillMultiplier),
        hr: 150,
        elevDiffM: 30,
      })),
      { distM: 220, timeSec: 95, hr: 162, elevDiffM: 0 }, // < 500m stub
    ]);

    const act = makeActivity({
      id: 203,
      distance: 16_220,
      moving_time: splits_metric.reduce((s, x) => s + x.moving_time, 0),
      splits_metric,
    });

    const summary = analyzeActivityDecoupling(act);
    expect(summary).not.toBeNull();
    expect(summary!.splitSource).toBe('metric');
    expect(summary!.droppedTrailingPartial).toBe(true);
    expect(summary!.splitsUsed).toBe(16);
    expect(summary!.isSteadyState).toBe(true);
    // Because NGP accounts for the +3% climb, physiological decoupling stays near 0%!
    expect(Math.abs(summary!.decouplingPct)).toBeLessThan(1.5);
    expect(summary!.isCoupled).toBe(true);
  });
});

// ── A-21: EF Labeling & Unit Honesty ─────────────────────────────────────────

describe('A-21: Efficiency Factor unit labeling & km / mi formatting', () => {
  it('labels EF explicitly in m/min/bpm and formats coaching paces in user distance unit', () => {
    expect(formatEfficiencyFactor(1.387)).toBe('1.39 m/min/bpm');
    expect(formatEfficiencyFactor(1.387, false)).toBe('1.39');
    expect(formatEfficiencyFactor(NaN)).toBe('—');
    expect(formatEfficiencyFactor(0)).toBe('—');

    const splits: SplitHRPace[] = Array.from({ length: 10 }, (_, i) => ({
      mile: i + 1,
      paceSec: 480, // 8:00/mi = 4:58/km
      avgHR: 148 + (i >= 5 ? 3 : 0),
    }));
    const res = calculateDecoupling(splits, 10, 301, '2026-10-14')!;
    expect(res.efUnit).toBe('m/min/bpm');

    setDistanceUnit('km');
    const kmMsg = getDecouplingCoachingMessage(res);
    expect(kmMsg).toContain('m/min/bpm');
    expect(kmMsg).toContain('/km');
    expect(kmMsg).not.toMatch(/\/mi\b/);

    setDistanceUnit('mi');
    const miMsg = getDecouplingCoachingMessage(res);
    expect(miMsg).toContain('m/min/bpm');
    expect(miMsg).toContain('/mi');
  });
});

// ── A-26: Steady-State Gating ────────────────────────────────────────────────

describe('A-26: Steady-state gating & interval workout exclusion', () => {
  it('flags 1km interval repeats alternating fast/jog as isSteadyState: false and excludes from history', () => {
    // 14 km workout: alternating 1km @ 3:45/km (225s, 174 bpm) and 1km @ 6:15/km (375s, 136 bpm)
    const intervalSplits = makeMetricSplits(
      Array.from({ length: 14 }, (_, i) =>
        i % 2 === 0 ? { distM: 1000, timeSec: 225, hr: 174 } : { distM: 1000, timeSec: 375, hr: 136 },
      ),
    );
    const intervalRun = makeActivity({
      id: 401,
      name: '7x1km Threshold Repeats',
      distance: 14_000,
      moving_time: 7 * (225 + 375),
      splits_metric: intervalSplits,
    });

    const analyzed = analyzeActivityDecoupling(intervalRun);
    expect(analyzed).not.toBeNull();
    expect(analyzed!.isSteadyState).toBe(false);
    expect(analyzed!.isCoupled).toBe(false);
    expect(analyzed!.paceCV).toBeGreaterThan(0.12);
    expect(analyzed!.nonSteadyReason).toMatch(/interval|Varied-pace/i);

    const steadyRun = makeActivity({
      id: 402,
      name: 'Easy Aerobic 16K',
      distance: 16_000,
      moving_time: 16 * 310,
      splits_metric: makeMetricSplits(
        Array.from({ length: 16 }, (_, i) => ({
          distM: 1000,
          timeSec: 310,
          hr: 144 + Math.floor(i / 4),
        })),
      ),
    });

    const history = getSteadyRunDecouplingHistory([intervalRun, steadyRun]);
    expect(history.map((h) => h.activityId)).toEqual([402]);
  });

  it('flags 400m track repeats recorded via structured laps even when 1km auto-splits smooth them', () => {
    // Smoothed 1km auto-splits (each km contains fast + jog segments averaging ~300s/km)
    const smoothedKmSplits = makeMetricSplits(
      Array.from({ length: 10 }, () => ({ distM: 1000, timeSec: 300, hr: 156 })),
    );
    // Actual device laps: 12 x (400m in 84s + 400m jog in 156s)
    const laps: ActivityLap[] = Array.from({ length: 24 }, (_, i) => {
      const fast = i % 2 === 0;
      const dur = fast ? 84 : 156;
      return {
        id: 5000 + i,
        name: fast ? '400m Fast' : '400m Jog',
        lap_index: i,
        split: i + 1,
        distance: 400,
        elapsed_time: dur,
        moving_time: dur,
        average_speed: 400 / dur,
        max_speed: 400 / dur + 0.4,
        average_heartrate: fast ? 176 : 138,
        total_elevation_gain: 0,
        start_index: i * 50,
        end_index: (i + 1) * 50,
      };
    });

    const trackSession = makeActivity({
      id: 403,
      name: '12x400m Track Session',
      distance: 10_000,
      moving_time: 3_000,
      splits_metric: smoothedKmSplits,
      laps,
    });

    const analyzed = analyzeActivityDecoupling(trackSession);
    expect(analyzed).not.toBeNull();
    expect(analyzed!.isSteadyState).toBe(false);
    expect(analyzed!.nonSteadyReason).toMatch(/interval laps/i);
    expect(getSteadyRunDecouplingHistory([trackSession])).toEqual([]);
  });

  it('excludes short runs (< 40 min) from getSteadyRunDecouplingHistory and marks < 30 min runs non-steady', () => {
    // 25-minute 5km run (5 x 300s = 1500s < 1800s)
    const run25m = makeActivity({
      id: 404,
      name: '25m Shakeout',
      distance: 5_000,
      moving_time: 1_500,
      splits_metric: makeMetricSplits(Array.from({ length: 5 }, () => ({ distM: 1000, timeSec: 300, hr: 142 }))),
    });
    const analyzed25 = analyzeActivityDecoupling(run25m);
    expect(analyzed25).not.toBeNull();
    expect(analyzed25!.isSteadyState).toBe(false);
    expect(analyzed25!.nonSteadyReason).toMatch(/30 minutes/i);

    // 35-minute 7km steady run (2100s >= 1800s so steady, but < 2400s so excluded from >= 40m history)
    const run35m = makeActivity({
      id: 405,
      name: '35m Morning Run',
      distance: 7_000,
      moving_time: 2_100,
      splits_metric: makeMetricSplits(Array.from({ length: 7 }, () => ({ distM: 1000, timeSec: 300, hr: 145 }))),
    });
    expect(analyzeActivityDecoupling(run35m)!.isSteadyState).toBe(true);
    expect(getSteadyRunDecouplingHistory([run25m, run35m])).toEqual([]);
  });

  it('excludes non-steady persisted entries from getDecouplingTrend', () => {
    const steadyBase = calculateDecoupling(
      Array.from({ length: 10 }, (_, i) => ({ mile: i + 1, paceSec: 480, avgHR: 148 })),
      10,
      500,
      '2026-09-01',
    )!;
    // Save 3 steady entries + 2 non-steady interval entries: fewer than 4 steady entries -> null
    for (let i = 0; i < 3; i++) {
      saveDecouplingResult({ ...steadyBase, activityId: 500 + i, date: `2026-09-0${i + 1}` });
    }
    for (let i = 0; i < 2; i++) {
      saveDecouplingResult({
        ...steadyBase,
        activityId: 510 + i,
        date: `2026-09-1${i + 1}`,
        isSteadyState: false,
        nonSteadyReason: 'Interval session',
      });
    }
    expect(getDecouplingTrend(4)).toBeNull();
  });
});

// ── Edge Cases: Empty / Zero-HR / NaN / Non-Run ──────────────────────────────

describe('Edge cases: empty, zero-HR, NaN, Infinity, non-run, hidden', () => {
  it('returns null safely on empty, zero-HR, NaN, and Infinity inputs', () => {
    expect(calculateDecoupling([], 12, 1, '2026-10-01')).toBeNull();
    expect(calculateDecoupling([], NaN, 1, '2026-10-01')).toBeNull();
    expect(calculateDecoupling([], -10, 1, '2026-10-01')).toBeNull();

    const zeroHrSplits: SplitHRPace[] = Array.from({ length: 10 }, (_, i) => ({
      mile: i + 1,
      paceSec: 480,
      avgHR: 0,
    }));
    expect(calculateDecoupling(zeroHrSplits, 10, 2, '2026-10-01')).toBeNull();

    const nanSplits: SplitHRPace[] = Array.from({ length: 10 }, (_, i) => ({
      mile: i + 1,
      paceSec: i % 2 === 0 ? NaN : Infinity,
      avgHR: NaN,
      distanceM: i === 3 ? -500 : NaN,
    }));
    expect(calculateDecoupling(nanSplits, 10, 3, '2026-10-01')).toBeNull();
  });

  it('ignores non-running sports and hidden activities in analyzeActivityDecoupling', () => {
    const validSplits = makeMetricSplits(Array.from({ length: 15 }, () => ({ distM: 1000, timeSec: 280, hr: 148 })));
    const ride = makeActivity({
      id: 601,
      type: 'Ride',
      sport_type: 'Ride',
      splits_metric: validSplits,
    });
    const hiddenRun = makeActivity({
      id: 602,
      hidden: true,
      splits_metric: validSplits,
    });
    const noHrRun = makeActivity({
      id: 603,
      splits_metric: makeMetricSplits(Array.from({ length: 15 }, () => ({ distM: 1000, timeSec: 280 }))),
    });

    expect(analyzeActivityDecoupling(ride)).toBeNull();
    expect(analyzeActivityDecoupling(hiddenRun)).toBeNull();
    expect(analyzeActivityDecoupling(noHrRun)).toBeNull();
  });
});

// ── Progress.tsx UI: AerobicDurabilitySection ────────────────────────────────

describe('Progress.tsx AerobicDurabilitySection', () => {
  it('renders a concise empty-state note (without extra tables) when no steady HR runs exist', () => {
    render(createElement(AerobicDurabilitySection));
    expect(
      screen.getByRole('heading', {
        level: 2,
        name: 'Aerobic Durability (Pa:HR & Efficiency Factor)',
      }),
    ).toBeTruthy();
    expect(screen.getByTestId('aerobic-durability-empty')).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('surfaces <= 5% Coupled badge, rising EF trend, and km/mi unit-honest steady-run table', () => {
    // Earlier steady long run: 20 km @ 5:15/km (315s/km, 190.5 m/min) @ 150 bpm -> EF ~ 1.27, Pa:HR ~ 2.6%
    const earlyLong = makeActivity({
      id: 701,
      name: 'Early Block Long Run',
      distance: 20_000,
      moving_time: 20 * 315,
      start_date: '2026-09-20T12:00:00Z',
      start_date_local: '2026-09-20T07:30:00Z',
      average_heartrate: 150,
      splits_metric: makeMetricSplits([
        ...Array.from({ length: 10 }, () => ({ distM: 1000, timeSec: 315, hr: 148 })),
        ...Array.from({ length: 10 }, () => ({ distM: 1000, timeSec: 315, hr: 152 })),
      ]),
    });

    // Recent steady long run: 24 km @ 4:50/km (290s/km, 206.9 m/min) @ 149 bpm -> EF ~ 1.39 (+9% EF!), Pa:HR ~ 2.0%
    const recentLong = makeActivity({
      id: 702,
      name: 'Peak Coupled 24K',
      distance: 24_000,
      moving_time: 24 * 290,
      start_date: '2026-10-18T12:00:00Z',
      start_date_local: '2026-10-18T07:30:00Z',
      average_heartrate: 149,
      splits_metric: makeMetricSplits([
        ...Array.from({ length: 12 }, () => ({ distM: 1000, timeSec: 290, hr: 147.5 })),
        ...Array.from({ length: 12 }, () => ({ distM: 1000, timeSec: 290, hr: 150.5 })),
      ]),
    });

    storeActivities([earlyLong, recentLong]);

    const overview = buildAerobicDurabilityOverview();
    expect(overview.longRunCoupled).toBe(true);
    expect(overview.efTrend).toBe('rising');

    setDistanceUnit('km');
    render(createElement(AerobicDurabilitySection));

    expect(screen.getByTestId('decoupling-readiness-badge').textContent).toBe('≤ 5% Coupled');
    expect(screen.getByText(/Rising/)).toBeTruthy();
    expect(screen.getByTestId('latest-ef-value').textContent).toContain('1.39');
    expect(screen.getByTestId('latest-ef-value').textContent).toContain('m/min/bpm');

    const table = screen.getByRole('table');
    expect(within(table).getByText('Peak Coupled 24K')).toBeTruthy();
    expect(within(table).getByText('Early Block Long Run')).toBeTruthy();
    expect(within(table).getByText('1.39')).toBeTruthy();
    // Respects km unit preference (24.0 km and 20.0 km, never mi)
    expect(within(table).getByText('24.0 km')).toBeTruthy();
    expect(within(table).getByText('20.0 km')).toBeTruthy();
  });
});
