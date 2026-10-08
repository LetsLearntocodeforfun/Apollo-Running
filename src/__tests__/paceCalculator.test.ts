/**
 * Unit tests for paceCalculator.ts
 *
 * Tests VDOT-based training pace calculations, formatting,
 * and caching behavior.
 *
 * v1.0.6: paces come from the Daniels–Gilbert engine (V1, V13, A-01) and are
 * checked against Daniels' anchors; the VDOT comes from deriveVdot (V2).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  calculateTrainingPaces,
  calculatePacesFromRace,
  formatPaceSec,
  formatPaceRange,
  formatTrainingPacesSummary,
  saveTrainingPaces,
  getSavedTrainingPaces,
  getOrComputeTrainingPaces,
  getCurrentTrainingPaces,
  vdotToMarathonTime,
} from '@/services/paceCalculator';
import { estimateVDOT, formatTimeSec, vdotToMarathonSec } from '@/services/racePrediction';
import { updateAthleteProfile } from '@/services/athleteProfile';
import { persistence } from '@/services/db/persistence';
import { addDays, todayKey } from '@/utils/localDate';
import type { Activity } from '@/services/activity/types';

beforeEach(() => {
  persistence.clear();
});

/** "M:SS" → seconds */
function mmss(s: string): number {
  const [m, sec] = s.split(':').map(Number);
  return m * 60 + sec;
}

// ── calculateTrainingPaces ────────────────────────────────────────────────────

describe('calculateTrainingPaces', () => {
  it('should return null for invalid VDOT', () => {
    expect(calculateTrainingPaces(0)).toBeNull();
    expect(calculateTrainingPaces(-10)).toBeNull();
    expect(calculateTrainingPaces(NaN)).toBeNull();
    expect(calculateTrainingPaces(Infinity)).toBeNull();
  });

  it('should calculate paces for VDOT 40 (approx 3:50 marathoner)', () => {
    const paces = calculateTrainingPaces(40)!;
    expect(paces).not.toBeNull();
    expect(paces.vdot).toBe(40);

    // Easy = 59–74 % VO2max (Daniels) ≈ 9:25–11:15/mi. (≤ 1.0.6 used a ±2 % band — V13.)
    expect(paces.easy.min).toBeGreaterThan(555);
    expect(paces.easy.min).toBeLessThan(575);
    expect(paces.easy.max).toBeGreaterThan(660);
    expect(paces.easy.max).toBeLessThan(690);
    expect(paces.easy.max).toBeGreaterThan(paces.easy.min);

    // Marathon pace = 3:49:45 / 26.22 mi ≈ 8:46/mi (526 sec)
    expect(Math.abs(paces.marathon - 526)).toBeLessThanOrEqual(5);

    // Threshold should be faster than marathon
    expect(paces.threshold).toBeLessThan(paces.marathon);

    // Interval should be faster than threshold
    expect(paces.interval).toBeLessThan(paces.threshold);

    // Repetition should be fastest
    expect(paces.repetition).toBeLessThan(paces.interval);
  });

  it('should match the Daniels anchors at VDOT 50 (3:10:49 marathoner)', () => {
    const paces = calculateTrainingPaces(50)!;
    expect(paces.vdot).toBe(50);

    // M ≈ 7:17/mi, T ≈ 6:51/mi (±5 s)
    expect(Math.abs(paces.marathon - mmss('7:17'))).toBeLessThanOrEqual(5);
    expect(Math.abs(paces.threshold - mmss('6:51'))).toBeLessThanOrEqual(5);

    // E range brackets ~8:15–9:30/mi
    expect(paces.easy.min).toBeLessThanOrEqual(mmss('8:15'));
    expect(paces.easy.max).toBeGreaterThanOrEqual(mmss('9:30') - 5);
    expect(paces.easy.max).toBeLessThan(mmss('9:45'));

    // I ≈ 6:18/mi, R (mile race pace) ≈ 5:50/mi
    expect(Math.abs(paces.interval - mmss('6:18'))).toBeLessThanOrEqual(5);
    expect(Math.abs(paces.repetition - mmss('5:50'))).toBeLessThanOrEqual(6);
  });

  it('should calculate paces for VDOT 60 (approx 2:43 marathoner)', () => {
    const paces = calculateTrainingPaces(60)!;

    // Easy ≈ 6:48–8:09/mi
    expect(paces.easy.min).toBeGreaterThan(400);
    expect(paces.easy.max).toBeGreaterThan(480);
    expect(paces.easy.max).toBeLessThan(500);

    // Marathon pace = 2:43:25 / 26.22 mi ≈ 6:14/mi (374 sec)
    expect(Math.abs(paces.marathon - 374)).toBeLessThanOrEqual(5);
  });

  it('marathon pace × distance equals the Daniels–Gilbert marathon time', () => {
    for (const vdot of [35, 45, 55, 65]) {
      const paces = calculateTrainingPaces(vdot)!;
      expect(Math.abs(paces.marathon * (42195 / 1609.344) - vdotToMarathonSec(vdot))).toBeLessThan(15);
    }
  });

  it('should produce faster paces for higher VDOT', () => {
    const paces40 = calculateTrainingPaces(40)!;
    const paces50 = calculateTrainingPaces(50)!;
    const paces60 = calculateTrainingPaces(60)!;

    expect(paces50.easy.min).toBeLessThan(paces40.easy.min);
    expect(paces60.easy.min).toBeLessThan(paces50.easy.min);
    expect(paces50.marathon).toBeLessThan(paces40.marathon);
    expect(paces60.threshold).toBeLessThan(paces50.threshold);
    expect(paces60.interval).toBeLessThan(paces50.interval);
    expect(paces60.repetition).toBeLessThan(paces50.repetition);
  });

  it('should maintain correct pace ordering for all VDOT values', () => {
    for (const vdot of [30, 35, 40, 45, 50, 55, 60, 65, 70, 85]) {
      const paces = calculateTrainingPaces(vdot)!;
      // Easy > Marathon > Threshold > Interval > Repetition (in sec/mi, higher = slower)
      expect(paces.easy.max).toBeGreaterThan(paces.marathon);
      expect(paces.easy.min).toBeGreaterThan(paces.marathon);
      expect(paces.marathon).toBeGreaterThan(paces.threshold);
      expect(paces.threshold).toBeGreaterThan(paces.interval);
      expect(paces.interval).toBeGreaterThan(paces.repetition);
    }
  });

  it('should have a positive easy pace range', () => {
    const paces = calculateTrainingPaces(45)!;
    expect(paces.easy.max - paces.easy.min).toBeGreaterThanOrEqual(10);
  });

  it('should include an updatedAt timestamp', () => {
    const paces = calculateTrainingPaces(40)!;
    expect(paces.updatedAt).toBeDefined();
    expect(new Date(paces.updatedAt).getTime()).not.toBeNaN();
  });
});

// ── calculatePacesFromRace ────────────────────────────────────────────────────

describe('calculatePacesFromRace', () => {
  it('should calculate paces from a 20:00 5K', () => {
    const paces = calculatePacesFromRace(5000, 20 * 60);
    expect(paces).not.toBeNull();
    expect(paces!.vdot).toBeGreaterThan(30);
    expect(paces!.vdot).toBeLessThan(60);
    expect(paces!.marathon).toBeGreaterThan(400);
    expect(paces!.marathon).toBeLessThan(650);
  });

  it('should calculate paces from a 3:30 marathon', () => {
    const paces = calculatePacesFromRace(42195, 3.5 * 3600);
    expect(paces).not.toBeNull();
    expect(paces!.marathon).toBeGreaterThan(400);
    expect(paces!.marathon).toBeLessThan(600);
    // A marathon race gives back its own pace: 3:30:00 / 26.22 mi ≈ 8:01/mi.
    expect(Math.abs(paces!.marathon - 12600 / (42195 / 1609.344))).toBeLessThanOrEqual(2);
  });

  it('should return null for invalid inputs', () => {
    expect(calculatePacesFromRace(0, 1200)).toBeNull();
    expect(calculatePacesFromRace(5000, 0)).toBeNull();
    expect(calculatePacesFromRace(-1, 1200)).toBeNull();
  });
});

// ── formatPaceSec ─────────────────────────────────────────────────────────────

describe('formatPaceSec', () => {
  it('should format seconds to "M:SS/mi"', () => {
    expect(formatPaceSec(480)).toBe('8:00/mi');
    expect(formatPaceSec(510)).toBe('8:30/mi');
    expect(formatPaceSec(545)).toBe('9:05/mi');
    expect(formatPaceSec(600)).toBe('10:00/mi');
  });

  it('never shows 60 seconds', () => {
    expect(formatPaceSec(479.7)).toBe('8:00/mi');
    expect(formatPaceRange(479.6, 509.8)).toBe('8:00–8:30/mi');
  });

  it('should return "—" for zero or negative', () => {
    expect(formatPaceSec(0)).toBe('—');
    expect(formatPaceSec(-1)).toBe('—');
  });
});

// ── formatPaceRange ───────────────────────────────────────────────────────────

describe('formatPaceRange', () => {
  it('should format a pace range', () => {
    const result = formatPaceRange(480, 510);
    expect(result).toBe('8:00–8:30/mi');
  });

  it('should return "—" for invalid values', () => {
    expect(formatPaceRange(0, 510)).toBe('—');
    expect(formatPaceRange(480, 0)).toBe('—');
  });
});

// ── formatTrainingPacesSummary ────────────────────────────────────────────────

describe('formatTrainingPacesSummary', () => {
  it('should produce a multi-line summary', () => {
    const paces = calculateTrainingPaces(45)!;
    const summary = formatTrainingPacesSummary(paces);
    expect(summary).toContain('VDOT: 45');
    expect(summary).toContain('Easy:');
    expect(summary).toContain('Marathon:');
    expect(summary).toContain('Threshold:');
    expect(summary).toContain('Interval:');
    expect(summary).toContain('Repetition:');
    expect(summary).toContain('/mi');
  });
});

// ── save/load training paces ──────────────────────────────────────────────────

describe('training paces persistence', () => {
  it('should save and load training paces', () => {
    const paces = calculateTrainingPaces(42)!;
    saveTrainingPaces(paces);
    const loaded = getSavedTrainingPaces();
    expect(loaded).not.toBeNull();
    expect(loaded!.vdot).toBe(42);
    expect(loaded!.marathon).toBe(paces.marathon);
  });

  it('should return null when no paces are saved', () => {
    expect(getSavedTrainingPaces()).toBeNull();
  });

  it('ignores malformed saved paces', () => {
    persistence.setItem('apollo_training_paces', JSON.stringify({ vdot: 50, easy: { min: 0, max: 'x' } }));
    expect(getSavedTrainingPaces()).toBeNull();
    persistence.setItem('apollo_training_paces', '{not json');
    expect(getSavedTrainingPaces()).toBeNull();
  });
});

// ── getCurrentTrainingPaces (pure) ────────────────────────────────────────────

function run(id: number, date: string, distanceM: number, timeSec: number, name = 'Morning Run'): Activity {
  return {
    id,
    name,
    type: 'Run',
    sport_type: 'Run',
    distance: distanceM,
    moving_time: timeSec,
    elapsed_time: timeSec,
    start_date: `${date}T07:00:00Z`,
    start_date_local: `${date}T07:00:00Z`,
    kudos_count: 0,
  };
}

describe('getCurrentTrainingPaces', () => {
  it('returns null when there is no VDOT source', () => {
    expect(getCurrentTrainingPaces({ activities: [], profile: {}, hrProfile: null, planRaceDays: new Map() })).toBeNull();
  });

  it('derives paces from the profile race and attaches the source — without writing storage', () => {
    const today = todayKey();
    const paces = getCurrentTrainingPaces({
      today,
      activities: [],
      hrProfile: null,
      planRaceDays: new Map(),
      profile: { recentRace: { distanceM: 21097.5, timeSec: 95 * 60, date: addDays(today, -30) } },
    })!;
    expect(paces).not.toBeNull();
    expect(paces.source).toBe('recent_race');
    expect(paces.confidence).toBe('high');
    expect(paces.vdot).toBeCloseTo(estimateVDOT(21097.5, 95 * 60), 1);
    expect(paces.asOf).toBe(addDays(today, -30));
    expect(paces.sourceDetail).toMatch(/Half marathon/);
    expect(persistence.getItem('apollo_training_paces')).toBeNull();
  });

  it('easy runs never lower a race-derived VDOT', () => {
    const today = todayKey();
    const race = { distanceM: 10000, timeSec: 42 * 60, date: addDays(today, -20) };
    const easyRuns = Array.from({ length: 12 }, (_, i) => run(i + 1, addDays(today, -i - 1), 10000, 10000 / 1609.344 * 600)); // 10:00/mi
    const withRuns = getCurrentTrainingPaces({ today, activities: easyRuns, hrProfile: null, planRaceDays: new Map(), profile: { recentRace: race } })!;
    const raceOnly = getCurrentTrainingPaces({ today, activities: [], hrProfile: null, planRaceDays: new Map(), profile: { recentRace: race } })!;
    expect(withRuns.vdot).toBe(raceOnly.vdot);
    expect(withRuns.source).toBe('recent_race');
  });

  it('falls back to the goal time (paces only, low confidence)', () => {
    const paces = getCurrentTrainingPaces({ activities: [], hrProfile: null, planRaceDays: new Map(), profile: { goalMarathonSec: 12600 } })!;
    expect(paces.source).toBe('goal');
    expect(paces.confidence).toBe('low');
    expect(Math.abs(paces.marathon - 12600 / (42195 / 1609.344))).toBeLessThanOrEqual(3);
  });
});

// ── getOrComputeTrainingPaces ─────────────────────────────────────────────────

describe('getOrComputeTrainingPaces', () => {
  it('computes from deriveVdot (profile race) and stores the source with the paces', () => {
    updateAthleteProfile({ recentRace: { distanceM: 5000, timeSec: 20 * 60, date: addDays(todayKey(), -10) } });
    const paces = getOrComputeTrainingPaces();
    expect(paces).not.toBeNull();
    expect(paces!.source).toBe('recent_race');
    expect(paces!.vdot).toBeCloseTo(estimateVDOT(5000, 1200), 1);
    const saved = getSavedTrainingPaces();
    expect(saved?.source).toBe('recent_race');
    expect(saved?.marathon).toBe(paces!.marathon);
  });

  it('no longer trusts a legacy saved prediction VDOT (training-run based, V2)', () => {
    persistence.setItem('apollo_race_prediction', JSON.stringify({ vdot: 48 }));
    expect(getOrComputeTrainingPaces()).toBeNull();
  });

  it('clears legacy cached paces when there is no VDOT source', () => {
    saveTrainingPaces(calculateTrainingPaces(50)!);
    expect(getOrComputeTrainingPaces()).toBeNull();
    expect(getSavedTrainingPaces()).toBeNull();
  });

  it('should return null when nothing available', () => {
    expect(getOrComputeTrainingPaces()).toBeNull();
  });
});

// ── vdotToMarathonTime ────────────────────────────────────────────────────────

describe('vdotToMarathonTime', () => {
  it('should return a formatted time string', () => {
    const time = vdotToMarathonTime(45);
    expect(time).toMatch(/^\d+:\d{2}:\d{2}$/);
  });

  it('should return "—" for invalid VDOT', () => {
    expect(vdotToMarathonTime(0)).toBe('—');
    expect(vdotToMarathonTime(-5)).toBe('—');
  });

  it('uses the same engine as the race prediction (VDOT 50 → ~3:10:49)', () => {
    expect(vdotToMarathonTime(50)).toBe(formatTimeSec(vdotToMarathonSec(50)));
    expect(Math.abs(vdotToMarathonSec(50) - (3 * 3600 + 10 * 60 + 49))).toBeLessThanOrEqual(60);
  });

  it('should produce faster times for higher VDOT', () => {
    const paces40 = calculateTrainingPaces(40)!;
    const paces60 = calculateTrainingPaces(60)!;
    expect(paces60.marathon * 26.2).toBeLessThan(paces40.marathon * 26.2);
    expect(vdotToMarathonSec(60)).toBeLessThan(vdotToMarathonSec(40));
  });
});
