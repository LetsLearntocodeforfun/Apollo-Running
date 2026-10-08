/**
 * Unit tests for racePrediction.ts
 *
 * Tests the core mathematical functions used for VDOT calculations,
 * Riegel formula predictions, and blended race time predictions.
 */

import { describe, it, expect } from 'vitest';
import {
  riegelPredict,
  estimateVDOT,
  vdotToMarathonSec,
  formatTimeSec,
  raceTimeFromVdot,
  vo2AtVelocity,
  velocityAtVo2,
  isRaceActivity,
  deriveVdot,
  computeRacePrediction,
  calculateRacePrediction,
  getSavedPrediction,
  getPredictedMarathonSec,
  calculateTrainingAdherence,
  MARATHON_M,
} from '@/services/racePrediction';
import type { Activity } from '@/services/activity/types';
import type { HRProfile } from '@/services/heartRate';
import { updateAthleteProfile } from '@/services/athleteProfile';
import { persistence } from '@/services/db/persistence';
import { setDayCompleted, startPlan } from '@/services/planProgress';
import { getEffectivePlan } from '@/services/planOverlay';
import { addDays, daysBetween, mondayOf, todayKey } from '@/utils/localDate';

const HALF_M = 21097.5;

// ── riegelPredict ─────────────────────────────────────────────────────────────

describe('riegelPredict', () => {
  it('should predict a longer race time from a shorter race', () => {
    // A runner who does 3.1 mi (5K) in 20 minutes should have a slower marathon
    const marathonSec = riegelPredict(3.1, 20 * 60, 26.2);
    // Riegel: T2 = 1200 * (26.2/3.1)^1.06
    expect(marathonSec).toBeGreaterThan(20 * 60);
    expect(marathonSec).toBeGreaterThan(3 * 3600); // > 3 hours
    expect(marathonSec).toBeLessThan(5 * 3600);    // < 5 hours
  });

  it('should predict a shorter race time from a longer race', () => {
    // A 4:00 marathon runner predicting 5K time
    const fiveKSec = riegelPredict(26.2, 4 * 3600, 3.1);
    expect(fiveKSec).toBeLessThan(4 * 3600);
    expect(fiveKSec).toBeGreaterThan(15 * 60); // > 15 minutes
    expect(fiveKSec).toBeLessThan(35 * 60);    // < 35 minutes
  });

  it('should return 0 for zero or negative inputs', () => {
    expect(riegelPredict(0, 1200, 26.2)).toBe(0);
    expect(riegelPredict(3.1, 0, 26.2)).toBe(0);
    expect(riegelPredict(-1, 1200, 26.2)).toBe(0);
    expect(riegelPredict(3.1, -1, 26.2)).toBe(0);
  });

  it('should return the same time when distances are equal', () => {
    const time = riegelPredict(10, 3600, 10);
    expect(time).toBeCloseTo(3600, 0);
  });

  it('should produce consistent predictions for known race equivalences', () => {
    // A 20:00 5K runner (3.1 mi)
    const halfMarathon = riegelPredict(3.1, 20 * 60, 13.1);
    const tenK = riegelPredict(3.1, 20 * 60, 6.2);

    // 10K should be roughly double the 5K + a bit extra
    expect(tenK).toBeGreaterThan(40 * 60);
    expect(tenK).toBeLessThan(50 * 60);

    // Half marathon should be more than the 10K
    expect(halfMarathon).toBeGreaterThan(tenK);
  });
});

// ── estimateVDOT ──────────────────────────────────────────────────────────────

describe('estimateVDOT', () => {
  it('should estimate a reasonable VDOT for a 5K effort', () => {
    // 20:00 5K = ~5000m in 1200 sec → VDOT ~42-45
    const vdot = estimateVDOT(5000, 1200);
    expect(vdot).toBeGreaterThan(30);
    expect(vdot).toBeLessThan(60);
  });

  it('should estimate higher VDOT for faster performances', () => {
    const slower = estimateVDOT(5000, 1500); // 25:00 5K
    const faster = estimateVDOT(5000, 1200); // 20:00 5K
    expect(faster).toBeGreaterThan(slower);
  });

  it('should estimate reasonable VDOT for a marathon effort', () => {
    // 3:30 marathon = ~42195m in 12600 sec → VDOT ~45-55
    const vdot = estimateVDOT(42195, 3.5 * 3600);
    expect(vdot).toBeGreaterThan(35);
    expect(vdot).toBeLessThan(65);
  });

  it('should return 0 for invalid inputs', () => {
    expect(estimateVDOT(0, 1200)).toBe(0);
    expect(estimateVDOT(5000, 0)).toBe(0);
    expect(estimateVDOT(-100, 1200)).toBe(0);
    expect(estimateVDOT(5000, -100)).toBe(0);
  });

  it('should produce consistent ordering across distances', () => {
    // Same runner: faster 5K performance should give higher VDOT than same-VDOT 10K
    const vdot5K = estimateVDOT(5000, 20 * 60);
    // A runner with similar VDOT doing ~42 min 10K
    const vdot10K = estimateVDOT(10000, 42 * 60);
    // Both should be in similar VDOT range (not exact due to approximation)
    expect(Math.abs(vdot5K - vdot10K)).toBeLessThan(15);
  });
});

// ── vdotToMarathonSec ─────────────────────────────────────────────────────────

describe('vdotToMarathonSec', () => {
  it('should return faster marathon times for higher VDOT', () => {
    const slow = vdotToMarathonSec(35);
    const fast = vdotToMarathonSec(55);
    expect(fast).toBeLessThan(slow);
  });

  it('should match the Daniels anchors (±60 s)', () => {
    // V1/A-01: the old power-law fit returned ~7.2 h for VDOT 50. Daniels' tables:
    expect(Math.abs(vdotToMarathonSec(40) - (3 * 3600 + 49 * 60 + 45))).toBeLessThanOrEqual(60); // 3:49:45
    expect(Math.abs(vdotToMarathonSec(50) - (3 * 3600 + 10 * 60 + 49))).toBeLessThanOrEqual(60); // 3:10:49
    expect(Math.abs(vdotToMarathonSec(60) - (2 * 3600 + 43 * 60 + 25))).toBeLessThanOrEqual(60); // 2:43:25
  });

  it('should enforce minimum of 2 hours', () => {
    const extreme = vdotToMarathonSec(200);
    expect(extreme).toBeGreaterThanOrEqual(7200);
  });

  it('should return 0 for zero or negative VDOT', () => {
    expect(vdotToMarathonSec(0)).toBe(0);
    expect(vdotToMarathonSec(-10)).toBe(0);
  });

  it('should be monotonically decreasing for increasing VDOT', () => {
    const vdots = [30, 35, 40, 45, 50, 55, 60, 65, 70];
    const times = vdots.map(vdotToMarathonSec);
    for (let i = 1; i < times.length; i++) {
      expect(times[i]).toBeLessThanOrEqual(times[i - 1]);
    }
  });
});

// ── formatTimeSec ─────────────────────────────────────────────────────────────

describe('formatTimeSec', () => {
  it('should format hours:minutes:seconds correctly', () => {
    expect(formatTimeSec(3600)).toBe('1:00:00');
    expect(formatTimeSec(3661)).toBe('1:01:01');
    expect(formatTimeSec(3 * 3600 + 45 * 60 + 22)).toBe('3:45:22');
  });

  it('should format minutes:seconds when under an hour', () => {
    expect(formatTimeSec(60)).toBe('1:00');
    expect(formatTimeSec(90)).toBe('1:30');
    expect(formatTimeSec(600)).toBe('10:00');
    expect(formatTimeSec(1265)).toBe('21:05');
  });

  it('should pad minutes and seconds', () => {
    expect(formatTimeSec(3605)).toBe('1:00:05');
    expect(formatTimeSec(7261)).toBe('2:01:01');
  });

  it('should return dash for zero or negative input', () => {
    expect(formatTimeSec(0)).toBe('—');
    expect(formatTimeSec(-100)).toBe('—');
  });
});

// ── Integration: VDOT ↔ Riegel cross-validation ──────────────────────────────

describe('VDOT and Riegel cross-validation', () => {
  it('should produce roughly agreeing predictions from different methods', () => {
    // A runner does a 10K (6.2 miles) in 50 minutes
    const tenKTimeSec = 50 * 60;
    const tenKDistMi = 6.2;
    const tenKDistMeters = 10000;

    // Method 1: Riegel prediction for marathon
    const riegelMarathon = riegelPredict(tenKDistMi, tenKTimeSec, 26.2);

    // Method 2: VDOT estimation → marathon time
    const vdot = estimateVDOT(tenKDistMeters, tenKTimeSec);
    const vdotMarathon = vdotToMarathonSec(vdot);

    // Each method should individually produce a plausible marathon time
    expect(riegelMarathon).toBeGreaterThan(2.5 * 3600);
    expect(riegelMarathon).toBeLessThan(8 * 3600);
    expect(vdotMarathon).toBeGreaterThan(2 * 3600);
    expect(vdotMarathon).toBeLessThan(12 * 3600);

    // VDOT should be a positive number in a reasonable range
    expect(vdot).toBeGreaterThan(20);
    expect(vdot).toBeLessThan(80);

    // The 1.0.6 prediction blends Daniels–Gilbert and Riegel 50/50 for races
    // (no training-pace extrapolation any more): the blend lies between them.
    const blended = (vdotMarathon + riegelMarathon) / 2;
    expect(blended).toBeGreaterThanOrEqual(Math.min(riegelMarathon, vdotMarathon));
    expect(blended).toBeLessThanOrEqual(Math.max(riegelMarathon, vdotMarathon));
    // Both methods agree within ~4 % for a 10K-based marathon.
    expect(Math.abs(riegelMarathon - vdotMarathon) / vdotMarathon).toBeLessThan(0.04);
  });
});

// ── v1.0.6 engine ─────────────────────────────────────────────────────────────

function run(
  id: number,
  date: string,
  distanceM: number,
  timeSec: number,
  extra: Partial<Activity> = {},
): Activity {
  return {
    id,
    name: 'Morning Run',
    type: 'Run',
    sport_type: 'Run',
    distance: distanceM,
    moving_time: timeSec,
    elapsed_time: timeSec,
    start_date: `${date}T07:00:00Z`,
    start_date_local: `${date}T07:00:00Z`,
    kudos_count: 0,
    ...extra,
  };
}

const TODAY = '2026-06-15';
const NO_PLAN = new Map<string, number>();
const HR: HRProfile = { maxHR: 190, restingHR: 50, source: 'manual', updatedAt: '' };

describe('raceTimeFromVdot', () => {
  it('is the exact inverse of estimateVDOT (round trip)', () => {
    for (const vdot of [30, 35, 42.5, 50, 57, 65, 75, 85]) {
      for (const meters of [1609.344, 5000, 10000, HALF_M, MARATHON_M]) {
        const t = raceTimeFromVdot(vdot, meters);
        expect(estimateVDOT(meters, t)).toBeCloseTo(vdot, 3);
      }
    }
  });

  it('matches the Daniels 5K anchor (VDOT 50 → ~19:57)', () => {
    expect(Math.abs(raceTimeFromVdot(50, 5000) - (19 * 60 + 57))).toBeLessThanOrEqual(10);
  });

  it('returns 0 for invalid input', () => {
    expect(raceTimeFromVdot(0, 5000)).toBe(0);
    expect(raceTimeFromVdot(50, 0)).toBe(0);
    expect(raceTimeFromVdot(NaN, 5000)).toBe(0);
  });

  it('velocityAtVo2 inverts vo2AtVelocity', () => {
    for (const v of [150, 200, 250, 320]) expect(velocityAtVo2(vo2AtVelocity(v))).toBeCloseTo(v, 6);
  });
});

describe('isRaceActivity', () => {
  it('detects Strava races, named races at standard distances and plan race days', () => {
    expect(isRaceActivity(run(1, TODAY, 7000, 1800, { workout_type: 1 } as Partial<Activity>))).toBe(true);
    expect(isRaceActivity(run(2, TODAY, 42300, 12600, { name: 'Chicago Marathon' }))).toBe(true);
    expect(isRaceActivity(run(3, TODAY, 21150, 5700, { name: 'City Half Marathon' }))).toBe(true);
    expect(isRaceActivity(run(4, TODAY, 21500, 6000), new Map([[TODAY, 21097.5]]))).toBe(true);
  });

  it('does not treat training runs as races', () => {
    expect(isRaceActivity(run(5, TODAY, 25750, 9000, { name: 'Marathon pace long run' }))).toBe(false);
    expect(isRaceActivity(run(6, TODAY, 10000, 3300, { name: 'Easy 10k' }))).toBe(false);
    expect(isRaceActivity(run(7, TODAY, 10000, 3000))).toBe(false);
    expect(isRaceActivity(run(8, TODAY, 13000, 3600, { name: 'Half marathon' }))).toBe(false); // not a standard distance
    expect(isRaceActivity(run(9, TODAY, 5000, 1300, { type: 'Ride', sport_type: 'Ride', name: '5K race' }))).toBe(false);
  });
});

describe('deriveVdot', () => {
  const base = { today: TODAY, hrProfile: null, planRaceDays: NO_PLAN };

  it('prefers a fresh profile race over a detected race', () => {
    const d = deriveVdot({
      ...base,
      profile: { recentRace: { distanceM: 10000, timeSec: 2700, date: '2026-05-01' } },
      activities: [run(1, '2026-06-01', 5000, 1250, { name: 'Parkrun 5K' })],
    });
    expect(d.source).toBe('recent_race');
    expect(d.confidence).toBe('high');
    expect(d.vdot).toBeCloseTo(estimateVDOT(10000, 2700), 1);
    expect(d.asOf).toBe('2026-05-01');
  });

  it('prefers a fresh detected race over a stale profile race; ignores races > 365 days', () => {
    const fresh = deriveVdot({
      ...base,
      profile: { recentRace: { distanceM: 10000, timeSec: 2700, date: '2025-11-01' } }, // ~226 days: medium
      activities: [run(1, '2026-06-01', 5000, 1250, { name: 'Parkrun 5K' })],
    });
    expect(fresh.source).toBe('race_activity');
    expect(fresh.performance?.activityId).toBe(1);

    const stale = deriveVdot({ ...base, activities: [], profile: { recentRace: { distanceM: 10000, timeSec: 2700, date: '2025-01-01' } } });
    expect(stale.source).toBe('none');
    expect(stale.vdot).toBeNull();
  });

  it('easy runs never lower a race-derived VDOT (even with heart-rate data)', () => {
    const race = { distanceM: 21097.5, timeSec: 5700, date: '2026-05-20' };
    const easy = Array.from({ length: 15 }, (_, i) =>
      run(i + 1, `2026-06-${String(i + 1).padStart(2, '0')}`, 12000, 12000 / 1609.344 * 600, { average_heartrate: 135 }));
    const withEasy = deriveVdot({ ...base, hrProfile: HR, profile: { recentRace: race }, activities: easy });
    const raceOnly = deriveVdot({ ...base, profile: { recentRace: race }, activities: [] });
    expect(withEasy.source).toBe('recent_race');
    expect(withEasy.vdot).toBe(raceOnly.vdot);
  });

  it('uses typed best efforts (A3 BestEffort shape) when there is no race', () => {
    const effort = run(1, '2026-06-01', 8000, 2200, {
      best_efforts: [{ key: '5k', distanceM: 5000, elapsedSec: 1260, startM: 1000, source: 'splits' }],
    });
    const d = deriveVdot({ ...base, profile: {}, activities: [effort] });
    expect(d.source).toBe('best_effort');
    expect(d.vdot).toBeCloseTo(estimateVDOT(5000, 1260), 1);
  });

  it('a slow best effort (easy run segment) does not beat the heart-rate estimate', () => {
    // Steady 9:00/mi runs at 150 bpm (HRR 0.71) → HR estimate ≈ 42.
    const steady = [3, 5, 7, 9].map((day, i) =>
      run(i + 1, `2026-06-0${day}`, 12000, 12000 / 1609.344 * 540, { average_heartrate: 150 }));
    const slowEffort = run(10, '2026-06-10', 10000, 3600, {
      best_efforts: [{ key: '5k', distanceM: 5000, elapsedSec: 1800, startM: 0, source: 'splits' }], // 30:00 5K ≈ VDOT 31
    });
    const d = deriveVdot({ ...base, hrProfile: HR, profile: {}, activities: [...steady, slowEffort] });
    expect(d.source).toBe('hr_estimate');
    expect(d.confidence).toBe('low');
    expect(d.vdot!).toBeGreaterThan(38);
    expect(d.vdot!).toBeLessThan(47);
  });

  it('needs a non-default HR profile and ≥ 3 steady runs for the HR estimate', () => {
    const steady = [3, 5].map((day, i) => run(i + 1, `2026-06-0${day}`, 12000, 4000, { average_heartrate: 150 }));
    expect(deriveVdot({ ...base, hrProfile: HR, profile: {}, activities: steady }).source).toBe('none');
    const three = [...steady, run(3, '2026-06-07', 12000, 4000, { average_heartrate: 150 })];
    expect(deriveVdot({ ...base, hrProfile: { ...HR, source: 'default' }, profile: {}, activities: three }).source).toBe('none');
    expect(deriveVdot({ ...base, hrProfile: HR, profile: {}, activities: three }).source).toBe('hr_estimate');
  });

  it('falls back to the goal time, unless disabled', () => {
    expect(deriveVdot({ ...base, activities: [], profile: { goalMarathonSec: 4 * 3600 } }).source).toBe('goal');
    expect(deriveVdot({ ...base, activities: [], profile: { goalMarathonSec: 4 * 3600 }, allowGoal: false }).source).toBe('none');
  });
});

describe('computeRacePrediction / calculateRacePrediction', () => {
  const base = { today: TODAY, hrProfile: null, planRaceDays: NO_PLAN };

  it('returns null without a source — and never predicts from the goal time', () => {
    expect(computeRacePrediction({ ...base, activities: [], profile: {} })).toBeNull();
    expect(computeRacePrediction({ ...base, activities: [], profile: { goalMarathonSec: 3 * 3600 } })).toBeNull();
  });

  it('blends Daniels–Gilbert with Riegel for a real race and reports source, basis and range', () => {
    const race = { distanceM: 21097.5, timeSec: 5700, date: '2026-05-20', name: 'Spring Half' };
    const p = computeRacePrediction({ ...base, activities: [], profile: { recentRace: race } })!;
    const vdot = estimateVDOT(race.distanceM, race.timeSec);
    const dg = raceTimeFromVdot(Math.round(vdot * 10) / 10, MARATHON_M);
    const riegel = race.timeSec * Math.pow(MARATHON_M / race.distanceM, 1.06);
    expect(p.method).toBe('daniels_riegel_blend');
    expect(p.vdotSource).toBe('recent_race');
    expect(p.sourceLabel).toBe('Recent race');
    expect(p.confidenceLevel).toBe('high');
    expect(p.asOf).toBe('2026-05-20');
    expect(p.marathonTimeSec).toBeGreaterThanOrEqual(Math.floor(Math.min(dg, riegel)));
    expect(p.marathonTimeSec).toBeLessThanOrEqual(Math.ceil(Math.max(dg, riegel)));
    expect(p.rangeLowSec!).toBeLessThanOrEqual(p.marathonTimeSec);
    expect(p.rangeHighSec!).toBeGreaterThanOrEqual(p.marathonTimeSec);
    expect(p.basis).toMatch(/Half marathon/);
    // Shorter distances come straight from the VDOT.
    expect(Math.abs(p.halfMarathonTimeSec - race.timeSec)).toBeLessThanOrEqual(5);
    expect(p.fiveKTimeSec).toBeLessThan(p.tenKTimeSec);
  });

  it('widens the range for low weekly mileage', () => {
    const race = { distanceM: 10000, timeSec: 2700, date: '2026-06-01' };
    const weeks = (miPerWeek: number) => Array.from({ length: 24 }, (_, i) =>
      run(100 + i, addDays(TODAY, -1 - i * 1.75 | 0), (miPerWeek / 4) * 1609.344, 3600));
    const high = computeRacePrediction({ ...base, profile: { recentRace: race }, activities: weeks(55) })!;
    const low = computeRacePrediction({ ...base, profile: { recentRace: race }, activities: weeks(20) })!;
    expect(low.rangeHighSec! - low.marathonTimeSec).toBeGreaterThan(high.rangeHighSec! - high.marathonTimeSec);
    expect(low.basis).toMatch(/wider/);
  });

  it('labels heart-rate predictions as estimates with low confidence', () => {
    const steady = [3, 5, 7, 9].map((day, i) =>
      run(i + 1, `2026-06-0${day}`, 12000, 12000 / 1609.344 * 540, { average_heartrate: 150 }));
    const p = computeRacePrediction({ ...base, hrProfile: HR, profile: {}, activities: steady })!;
    expect(p.method).toBe('heart_rate_estimate');
    expect(p.vdotSource).toBe('hr_estimate');
    expect(p.confidence).toBeLessThanOrEqual(45);
    expect(p.rangeHighSec! - p.rangeLowSec!).toBeGreaterThan(0.12 * p.marathonTimeSec);
  });

  it('calculateRacePrediction saves the prediction and clears it when the source disappears', () => {
    updateAthleteProfile({ recentRace: { distanceM: 10000, timeSec: 2700, date: addDays(todayKey(), -14) } });
    const p = calculateRacePrediction();
    expect(p).not.toBeNull();
    expect(getSavedPrediction()?.marathonTimeSec).toBe(p!.marathonTimeSec);
    expect(getPredictedMarathonSec()).toBe(p!.marathonTimeSec);

    updateAthleteProfile({ recentRace: undefined });
    expect(calculateRacePrediction()).toBeNull();
    expect(getSavedPrediction()).toBeNull();
    expect(getPredictedMarathonSec()).toBeNull();
  });

  it('ignores predictions saved by ≤ 1.0.5 (no vdotSource)', () => {
    persistence.setItem('apollo_race_prediction', JSON.stringify({ marathonTimeSec: 25800, vdot: 50 }));
    expect(getSavedPrediction()).toBeNull();
  });
});

describe('calculateTrainingAdherence (V17, S4)', () => {
  it('returns null without an active plan', () => {
    expect(calculateTrainingAdherence()).toBeNull();
  });

  it('counts only past days (today once done) from the joined week, and computes a real streak', () => {
    const today = todayKey();
    const monday = mondayOf(today);
    // Plan started 2 weeks ago (Monday) → weeks 0–1 are in the past (and skipped: joined late).
    const active = startPlan({ planId: 'hal-higdon-novice-1', startDate: addDays(monday, -14) }, today);
    const plan = getEffectivePlan()!;
    const elapsed = daysBetween(active.startDate, today);
    const first = (active.joinedWeekIndex ?? 0) * 7;

    // Nothing done yet: skipped lead-in weeks don't count as missed.
    const none = calculateTrainingAdherence()!;
    expect(none.weeklyScores[0]?.week ?? first / 7 + 1).toBe(first / 7 + 1);

    // Complete every non-rest day before today.
    for (let d = 0; d < elapsed; d++) {
      const day = plan.weeks[Math.floor(d / 7)].days[d % 7];
      if (day.type !== 'rest') setDayCompleted(active.planId, Math.floor(d / 7), d % 7, true);
    }
    const a = calculateTrainingAdherence()!;
    expect(a.completedDays).toBe(a.totalScheduledDays);
    expect(a.weeklyScores.every((w) => w.score === 100)).toBe(true);
    expect(a.currentStreak).toBeGreaterThanOrEqual(elapsed - first);
  });
});
