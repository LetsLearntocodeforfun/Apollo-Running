/**
 * v1.0.7 section B: coaching and charts that don't mislead.
 *  - L-2  race-morning form (TSB before race day's own load)
 *  - L-3  no "Overreached" for brand-new users (seed from 28 days, else hide)
 *  - L-14 "Very fresh" instead of "Detrained" above +30
 *  - L-11 time in zone labelled estimated unless measured
 *  - L-7 / L-8 VDOT pace bands and predicted race pace range
 *  - L-5  plan-relative weekly load + single-run spike rule
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { persistence } from '@/services/db/persistence';
import { storeActivities } from '@/services/analyticsService';
import {
  buildPMC,
  classifyTSBZone,
  getZoneLabel,
  projectForward,
  raceMorningTsb,
  FORM_SEED_DAYS,
} from '@/services/pmcChart';
import { calculateFitnessFatigue, seedLoad, type DailyTrainingLoad } from '@/services/taperOptimizer';
import {
  buildHRDataFromActivity,
  getAggregateZoneDistribution,
  setHRProfile,
  timeInZonesFromStream,
  upsertActivityHR,
} from '@/services/heartRate';
import {
  findOverPlanWeek,
  findRunSpike,
  isEasyPaceTooFast,
  isLongRunPaceAhead,
  paceBandsFromTrainingPaces,
  raceWeekPaceRange,
} from '@/services/adaptiveTraining';
import { calculateTrainingPaces } from '@/services/paceCalculator';
import FormChip from '@/components/fitness/FormChip';
import { fitnessTakeaway } from '@/components/fitness/FitnessFormChart';
import { getFitnessForm } from '@/components/fitness/fitnessData';
import { HeartRatePanel } from '@/pages/Insights';
import { MemoryRouter } from 'react-router-dom';
import type { Activity } from '@/services/activity/types';
import type { SyncedRunData } from '@/types/recommendations';
import { addDays } from '@/utils/localDate';

function run(id: number, key: string, meters: number, sec: number): Activity {
  return {
    id,
    name: 'Run',
    type: 'Run',
    sport_type: 'Run',
    distance: meters,
    moving_time: sec,
    elapsed_time: sec,
    start_date: `${key}T13:00:00Z`,
    start_date_local: `${key}T07:00:00Z`,
    kudos_count: 0,
    source: 'intervals',
    source_id: `t${id}`,
  } as Activity;
}

function dailyRuns(fromKey: string, days: number): Activity[] {
  return Array.from({ length: days }, (_, i) => run(9000 + i, addDays(fromKey, i), 10000, 3300));
}

beforeEach(() => {
  persistence.clear();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-07T12:00:00'));
});

afterEach(() => {
  vi.useRealTimers();
});

// ── L-2 ──────────────────────────────────────────────────────────────────────

describe('race-morning form (L-2)', () => {
  it('projection carries the form before each day\'s load', () => {
    const planned = new Map([['2026-10-11', 260]]);
    const proj = projectForward({ date: '2026-10-07', ctl: 60, atl: 40, tsb: 20 }, 10, 5, planned);
    const raceIdx = proj.findIndex((p) => p.date === '2026-10-11');
    expect(proj[raceIdx].morningTsb).toBe(proj[raceIdx - 1].tsb);
    // The post-race value is far lower than race-morning form.
    expect(proj[raceIdx].tsb).toBeLessThan((proj[raceIdx].morningTsb ?? 0) - 20);
    expect(proj[0].morningTsb).toBe(20);
  });

  it('raceMorningTsb reads the day before (history or projection)', () => {
    const pmc = {
      dataPoints: [
        { date: '2026-10-05', ctl: 50, atl: 30, tsb: 20, zone: classifyTSBZone(20), dailyTSS: 0 },
        { date: '2026-10-06', ctl: 52, atl: 60, tsb: -8, zone: classifyTSBZone(-8), dailyTSS: 250 },
      ],
      projection: [],
    };
    expect(raceMorningTsb(pmc, '2026-10-06')).toBe(20);
    expect(raceMorningTsb(pmc, '2026-10-05')).toBeNull();
    expect(raceMorningTsb(pmc, '2026-12-01')).toBeNull();
  });

  it('getFitnessForm reports race-morning form, not the post-race value', () => {
    storeActivities(dailyRuns('2026-05-01', 150));
    const data = getFitnessForm({ raceDate: '2026-10-20', today: '2026-10-07' });
    const raceDay = data.pmc.projection.find((p) => p.date === '2026-10-20')!;
    const dayBefore = data.pmc.projection.find((p) => p.date === '2026-10-19')!;
    expect(data.raceDayTsb).toBe(dayBefore.tsb);
    expect(data.raceDayTsb).toBe(raceDay.morningTsb);
    expect(fitnessTakeaway(data)).toMatch(/Race-morning form projects to/);
  });
});

// ── L-3 ──────────────────────────────────────────────────────────────────────

describe('cold start (L-3)', () => {
  const loads = (days: number, tss: number): DailyTrainingLoad[] =>
    Array.from({ length: days }, (_, i) => ({ date: addDays('2026-01-01', i), tss, distanceMi: 6, type: 'easy' as const }));

  it('seeds CTL/ATL from the average of the first 28 days', () => {
    expect(seedLoad(loads(28, 50), 28)).toBe(50);
    expect(seedLoad(loads(27, 50), 28)).toBeNull();
    const seeded = calculateFitnessFatigue(loads(40, 50), { seedDays: 28 });
    // Steady load from a seeded start: form stays near zero instead of deeply negative.
    expect(Math.abs(seeded[0].tsb)).toBeLessThan(1);
    expect(seeded.every((s) => s.tsb > -5)).toBe(true);
    // Unseeded (legacy default) still starts from zero.
    const unseeded = calculateFitnessFatigue(loads(40, 50));
    expect(unseeded[6].tsb).toBeLessThan(-15);
  });

  it('a steady new runner with 30 days of history is not "overreaching"', () => {
    const pmc = buildPMC(dailyRuns(addDays('2026-10-07', -29), 30), 0, { today: '2026-10-07' });
    expect(pmc.formReliable).toBe(true);
    expect(pmc.current?.zone).not.toBe('overreaching');
    expect(pmc.current?.readinessLabel).not.toMatch(/Overreached/);
  });

  it('hides the zone and readiness with less than 28 days of history', () => {
    storeActivities(dailyRuns(addDays('2026-10-07', -10), 11));
    const data = getFitnessForm({ raceDate: null });
    expect(data.formReliable).toBe(false);
    expect(fitnessTakeaway(data)).toMatch(new RegExp(`${FORM_SEED_DAYS} days of history`));
    expect(fitnessTakeaway(data)).not.toMatch(/Overreach/);
    expect(data.pmc.insights.join(' ')).not.toMatch(/overreach/i);
    render(<FormChip />);
    expect(screen.getByText(/Building baseline/)).toBeTruthy();
    expect(screen.queryByText(/Readiness/)).toBeNull();
    expect(screen.queryByText(/Overreach/)).toBeNull();
  });
});

// ── L-14 ─────────────────────────────────────────────────────────────────────

describe('"Very fresh" label (L-14)', () => {
  it('form above +30 is very fresh, never "detrained"', () => {
    expect(classifyTSBZone(35)).toBe('very_fresh');
    expect(getZoneLabel('very_fresh')).toBe('Very fresh');
    // Old cached values fall back to the honest label.
    expect(getZoneLabel('detrained' as never)).toBe('Very fresh');
  });
});

// ── L-11 ─────────────────────────────────────────────────────────────────────

describe('time in zone honesty (L-11)', () => {
  it('computes measured zone times from an HR stream', () => {
    // max HR 200 → Z2 starts at 120, Z4 at 160.
    const samples = [
      { t: 0, hr: 125 }, { t: 10, hr: 125 }, { t: 20, hr: 165 }, { t: 30, hr: 165 }, { t: 40, hr: 165 },
    ];
    expect(timeInZonesFromStream(samples, 200)).toEqual([0, 20, 0, 20, 0]);
    expect(timeInZonesFromStream([{ t: 0, hr: 120 }], 200)).toBeNull();
  });

  it('tags synthesized zones as estimated and measured ones as measured', () => {
    setHRProfile({ maxHR: 200, restingHR: 50, source: 'manual', updatedAt: '' });
    const est = buildHRDataFromActivity(1, '2026-10-06', 150, 170, 3600)!;
    expect(est.zoneSource).toBe('estimated');
    const real = buildHRDataFromActivity(2, '2026-10-06', 150, 170, 3600, undefined, 'intervals', [600, 1800, 900, 300, 0])!;
    expect(real.zoneSource).toBe('measured');
    expect(real.timeInZones).toEqual([600, 1800, 900, 300, 0]);
  });

  it('aggregate is flagged estimated unless every activity is measured', () => {
    setHRProfile({ maxHR: 200, restingHR: 50, source: 'manual', updatedAt: '' });
    upsertActivityHR(buildHRDataFromActivity(2, '2026-10-06', 150, 170, 3600, undefined, 'intervals', [600, 1800, 900, 300, 0])!);
    expect(getAggregateZoneDistribution(30)).toMatchObject({ estimated: false, measuredShare: 1 });
    upsertActivityHR(buildHRDataFromActivity(3, '2026-10-05', 140, 160, 3600)!);
    const agg = getAggregateZoneDistribution(30);
    expect(agg.estimated).toBe(true);
    expect(agg.measuredShare).toBeCloseTo(0.5, 5);
  });

  it('a later average-HR rebuild never replaces measured zone times', () => {
    setHRProfile({ maxHR: 200, restingHR: 50, source: 'manual', updatedAt: '' });
    upsertActivityHR(buildHRDataFromActivity(2, '2026-10-06', 150, 170, 3600, undefined, 'intervals', [600, 1800, 900, 300, 0])!);
    upsertActivityHR(buildHRDataFromActivity(2, '2026-10-06', 150, 170, 3600)!);
    expect(getAggregateZoneDistribution(30).estimated).toBe(false);
  });

  it('the Insights zone panel says "Estimated" for synthesized data', () => {
    setHRProfile({ maxHR: 200, restingHR: 50, source: 'manual', updatedAt: '' });
    upsertActivityHR(buildHRDataFromActivity(3, '2026-10-05', 140, 160, 3600)!);
    render(<MemoryRouter><HeartRatePanel /></MemoryRouter>);
    expect(screen.getByText(/Estimated zone distribution/)).toBeTruthy();
    expect(screen.getByTestId('hr-zones-estimated-note').textContent).toMatch(/average heart rate/);
  });
});

// ── L-7 / L-8 ────────────────────────────────────────────────────────────────

describe('VDOT pace bands (L-7) and race pace range (L-8)', () => {
  const v50 = paceBandsFromTrainingPaces(calculateTrainingPaces(50))!; // E ≈ 7:52–9:26, M ≈ 7:17
  const v35 = paceBandsFromTrainingPaces(calculateTrainingPaces(35))!; // slower runner

  it('judges easy pace against the runner\'s own easy band', () => {
    // 8:15/mi: inside a VDOT-50 easy band, but far too fast for a VDOT-35 runner.
    expect(isEasyPaceTooFast(8.25, v50)).toBe(false);
    expect(isEasyPaceTooFast(8.25, v35)).toBe(true);
    // A fast runner's 7:30 easy run is too fast for them; the old fixed 8:30 rule
    // would have flagged every easy run of an elite as well.
    expect(isEasyPaceTooFast(7.5, v50)).toBe(true);
    // No VDOT source: no judgement (no false positives).
    expect(isEasyPaceTooFast(7, null)).toBe(false);
  });

  it('long runs are "ahead" only relative to the runner\'s band', () => {
    // 9:15 long runs: not ahead for VDOT 50 (old rule: < 9:30 = ahead).
    expect(isLongRunPaceAhead(9.25, v50)).toBe(false);
    expect(isLongRunPaceAhead(7.6, v50)).toBe(true);
    expect(isLongRunPaceAhead(9.25, null)).toBe(false);
  });

  it('race-week pace is a range around predicted marathon pace, never avg training pace × 1.03', () => {
    const r = raceWeekPaceRange(v50, { marathonTimeSec: 3 * 3600 + 10 * 60, rangeLowSec: 3 * 3600 + 5 * 60, rangeHighSec: 3 * 3600 + 18 * 60 })!;
    expect(r.basis).toBe('prediction');
    expect(r.fastMinPerMi).toBeCloseTo((3 * 60 + 5) / 26.2188, 2);
    expect(r.slowMinPerMi).toBeCloseTo((3 * 60 + 18) / 26.2188, 2);
    const fromVdot = raceWeekPaceRange(v50, null)!;
    expect(fromVdot.basis).toBe('vdot');
    expect(fromVdot.fastMinPerMi).toBeLessThan(v50.marathonMinPerMi);
    expect(fromVdot.slowMinPerMi).toBeGreaterThan(v50.marathonMinPerMi);
    expect(raceWeekPaceRange(null, null)).toBeNull();
  });
});

// ── L-5 ──────────────────────────────────────────────────────────────────────

describe('plan-relative load (L-5)', () => {
  it('does not flag a jump the plan prescribes (after a cutback week)', () => {
    const weekly = [
      { weekIndex: 3, plannedMi: 20, actualMi: 20 }, // cutback
      { weekIndex: 4, plannedMi: 30, actualMi: 30 }, // +50 % week-over-week, as planned
    ];
    expect(findOverPlanWeek(weekly, 4)).toBeNull();
  });

  it('flags actual mileage well above the plan', () => {
    const weekly = [{ weekIndex: 4, plannedMi: 30, actualMi: 36 }];
    expect(findOverPlanWeek(weekly, 4)).toMatchObject({ weekIndex: 4, plannedMi: 30, actualMi: 36 });
    // +10 % is within tolerance; small weeks need 2+ extra miles.
    expect(findOverPlanWeek([{ weekIndex: 4, plannedMi: 30, actualMi: 33 }], 4)).toBeNull();
    expect(findOverPlanWeek([{ weekIndex: 4, plannedMi: 8, actualMi: 9.5 }], 4)).toBeNull();
  });

  it('flags a single run > 110 % of the 30-day longest', () => {
    const r = (date: string, mi: number, planned = mi): SyncedRunData => ({
      weekIndex: 0, dayIndex: 0, actualDistanceMi: mi, actualPaceMinPerMi: 9, plannedDistanceMi: planned,
      plannedNote: 'Long', movingTimeSec: mi * 540, date,
    });
    const runs = [r('2026-09-20', 12), r('2026-09-27', 13), r('2026-10-05', 16, 13)];
    const spike = findRunSpike(runs, '2026-10-07');
    expect(spike).toMatchObject({ date: '2026-10-05', distanceMi: 16, longestPrior30Mi: 13, beyondPlan: true });
    // 13 → 14 mi (+7.7 %) is not a spike.
    expect(findRunSpike([r('2026-09-27', 13), r('2026-10-05', 14)], '2026-10-07')).toBeNull();
    // Old runs (outside the last 7 days) are not re-flagged.
    expect(findRunSpike(runs, '2026-10-20')).toBeNull();
  });
});

describe('plan-prescribed jumps end to end (L-5)', () => {
  it('completing a planned +25 % week after a cutback raises no "slow down" card', async () => {
    const { setActivePlan, setDayCompleted, setSyncMeta, getDateKeyForDay } = await import('@/services/planProgress');
    const { getEffectivePlan } = await import('@/services/planOverlay');
    const { analyzeTrainingProgress } = await import('@/services/adaptiveTraining');
    const PLAN = 'pfitzinger-18-55';
    const START = '2026-01-05';
    setActivePlan({ planId: PLAN, startDate: START });
    const plan = getEffectivePlan()!;
    const miles = (w: number) => plan.weeks[w].days.reduce((s, d) => s + (d.type === 'run' ? d.distanceMi ?? 0 : 0), 0);
    // A week the plan itself raises by > 25 % over the week before (e.g. after a cutback).
    let w = 1;
    while (w < plan.weeks.length - 5 && !(miles(w) > miles(w - 1) * 1.25)) w++;
    expect(miles(w)).toBeGreaterThan(miles(w - 1) * 1.25);
    for (const wi of [w - 1, w]) {
      plan.weeks[wi].days.forEach((day, d) => {
        if (day.type === 'rest') return;
        setDayCompleted(PLAN, wi, d, true);
        setSyncMeta(PLAN, wi, d, {
          activityId: wi * 10 + d + 1,
          activityDate: getDateKeyForDay(START, wi, d),
          actualDistanceMi: day.distanceMi ?? 0,
          actualPaceMinPerMi: 8.5,
          movingTimeSec: Math.round((day.distanceMi ?? 0) * 510),
          feedback: '',
          syncedAt: new Date().toISOString(),
        });
      });
    }
    const sunday = getDateKeyForDay(START, w, 6);
    vi.setSystemTime(new Date(`${sunday}T20:00:00`));
    const result = analyzeTrainingProgress(true);
    expect(result).not.toBeNull();
    expect(result!.stats.weeklyMileageChangePct).toBeGreaterThan(0.25); // the old trigger would have fired
    const overtraining = result?.detectedScenarios.find((s) => s.scenario === 'overtraining');
    expect(overtraining?.triggers.join(' ') ?? '').not.toMatch(/jumped|planned \(\+/);
  });
});
