/**
 * Golden race-day consistency tests (Race Day hub, v1.0.6).
 *
 * One Boston 4:00:00 even-split plan must agree everywhere it is shown:
 * the halves, the mile and km split tables, the race card and the
 * race-morning timeline. Plus: a 1:45 half marathon builds end to end.
 */
import { describe, it, expect } from 'vitest';
import {
  buildRaceStrategy,
  buildUnitSplits,
  getStrategyDistanceMi,
  importCustomMarathon,
  segmentTimeSec,
  timeAtDistance,
  validateGoalTime,
  KM_PER_MI,
} from '@/services/raceStrategy';
import { generateRaceCard } from '@/services/raceCard';
import { generateRaceDayTimeline } from '@/services/raceDayTimeline';
import type { RaceStrategy } from '@/types/raceStrategy';

const GOAL_SEC = 4 * 3600;

function boston400(): RaceStrategy {
  const s = buildRaceStrategy('boston', GOAL_SEC, 'even-split');
  if (!s) throw new Error('fixture: Boston 4:00 even split did not build');
  return s;
}

function finishOf(s: RaceStrategy): number {
  return s.milePaces[s.milePaces.length - 1].cumulativeTimeSec;
}

describe('golden: Boston 4:00:00 even split', () => {
  it('builds a 26.2 mi plan whose halves are equal and sum to the goal (RS-1)', () => {
    const s = boston400();
    expect(s.marathonId).toBe('boston');
    expect(getStrategyDistanceMi(s)).toBeCloseTo(26.2, 6);
    expect(s.milePaces).toHaveLength(27);
    expect(s.milePaces[26].mile).toBeCloseTo(26.2, 6);
    expect(Math.abs(finishOf(s) - GOAL_SEC)).toBeLessThanOrEqual(1);

    expect(s.firstHalfSec).toBe(7200);
    expect(s.secondHalfSec).toBe(7200);
    expect(s.firstHalfSec + s.secondHalfSec).toBe(GOAL_SEC);
    expect(s.splitPct).toBe(0);

    // The plan's own cumulative times put halfway (13.1 mi, not mile 13) at 2:00:00.
    const atHalf = timeAtDistance(s.milePaces, getStrategyDistanceMi(s) / 2);
    expect(Math.abs(atHalf - 7200)).toBeLessThanOrEqual(1.5);
  });

  it('segment times come from cumulative differences and sum to the finish', () => {
    const s = boston400();
    const sum = s.milePaces.reduce((acc, _, i) => acc + segmentTimeSec(s.milePaces, i), 0);
    expect(sum).toBe(finishOf(s));
    // The last entry is a 0.2 mi segment: its time is about a fifth of a mile.
    const last = segmentTimeSec(s.milePaces, 26);
    expect(last).toBeGreaterThan(0.15 * s.milePaces[26].targetPaceSec);
    expect(last).toBeLessThan(0.25 * s.milePaces[26].targetPaceSec);
  });

  it('mile split table: 27 rows that match the plan exactly', () => {
    const s = boston400();
    const rows = buildUnitSplits(s.milePaces, 'mi', getStrategyDistanceMi(s));
    expect(rows).toHaveLength(27);
    rows.forEach((r, i) => expect(r.cumulativeSec).toBeCloseTo(s.milePaces[i].cumulativeTimeSec, 9));
    expect(rows[26].endDistance).toBe(26.2);
    expect(rows[26].length).toBeCloseTo(0.2, 6);
  });

  it('km split table: 43 rows, the last one partial, agreeing with the mile plan and the finish', () => {
    const s = boston400();
    const finish = finishOf(s);
    const rows = buildUnitSplits(s.milePaces, 'km', getStrategyDistanceMi(s));
    expect(rows).toHaveLength(43);
    expect(rows[41].endDistance).toBe(42);
    expect(rows[42].endDistance).toBe(42.16);
    expect(rows[42].length).toBeCloseTo(26.2 * KM_PER_MI - 42, 6);
    expect(rows[42].cumulativeSec).toBeCloseTo(finish, 6);
    expect(rows.reduce((acc, r) => acc + r.splitSec, 0)).toBeCloseTo(finish, 6);
    for (const r of rows) {
      expect(r.cumulativeSec).toBeCloseTo(timeAtDistance(s.milePaces, r.endMi), 9);
      // Every full km of a 4:00 marathon on Boston's course is between 5:00 and 6:30 /km.
      if (r.length > 0.99) {
        expect(r.paceSecPerUnit).toBeGreaterThan(300);
        expect(r.paceSecPerUnit).toBeLessThan(390);
      }
    }
    // The partial last km is short in time, not a full km at a fake pace.
    expect(rows[42].splitSec).toBeLessThan(0.2 * rows[42].paceSecPerUnit + 1);
  });

  it('race card: rows and segments sum to the finish, the Half checkpoint matches the plan (mi and km)', () => {
    const s = boston400();
    const finish = finishOf(s);
    for (const unit of ['mi', 'km'] as const) {
      const card = generateRaceCard({ strategy: s, unit });
      expect(card.unit).toBe(unit);
      const rowSum = card.miles.reduce((acc, m) => acc + m.splitSec, 0);
      const segSum = card.segments.reduce((acc, g) => acc + g.totalSec, 0);
      expect(Math.abs(rowSum - finish)).toBeLessThanOrEqual(1);
      expect(Math.abs(segSum - finish)).toBeLessThanOrEqual(1);
      expect(card.miles).toHaveLength(unit === 'km' ? 43 : 27);
      expect(card.targetFinish).toBe('4:00:00');

      const halves = card.fiveKCheckpoints.filter((c) => c.label === 'Half');
      expect(halves).toHaveLength(1);
      expect(Math.abs(halves[0].cumSec - s.firstHalfSec)).toBeLessThanOrEqual(1);
      expect(card.fiveKCheckpoints.every((c) => c.distanceMi <= 26.2 + 1e-9)).toBe(true);
      expect(card.htmlContent).not.toMatch(/:60\b/);
    }
  });

  it('race-morning timeline: milestones follow the plan and land on consistent clock times', () => {
    const s = boston400();
    const timeline = generateRaceDayTimeline({
      raceStartTime: '10:00',
      travelMinutes: 60,
      mealPreference: 'moderate',
      projectedFinishSec: s.targetTimeSec,
      raceName: 'Boston Marathon',
      raceDate: '2027-04-19',
      distanceMi: getStrategyDistanceMi(s),
      milePaces: s.milePaces,
      fuelItems: [],
    });
    const milestones = timeline.events.filter((e) => e.category === 'milestone');
    expect(milestones.map((e) => e.title)).toEqual(['5K', '10K', 'Half marathon', '20 mi', 'Projected finish']);

    const byTitle = (title: string) => milestones.find((e) => e.title === title)!;
    expect(Math.abs(byTitle('Half marathon').offsetSec - s.firstHalfSec)).toBeLessThanOrEqual(1);
    expect(byTitle('Half marathon').time).toBe('12:00 PM');
    expect(byTitle('Projected finish').offsetSec).toBe(GOAL_SEC);
    expect(byTitle('Projected finish').time).toBe('2:00 PM');
    expect(byTitle('5K').offsetSec).toBeCloseTo(timeAtDistance(s.milePaces, 5 / KM_PER_MI) * (GOAL_SEC / finishOf(s)), 6);
    expect(byTitle('20 mi').offsetSec).toBeCloseTo(timeAtDistance(s.milePaces, 20) * (GOAL_SEC / finishOf(s)), 6);

    // Events are sorted, the gun is at 0 and every milestone is after it.
    const offsets = timeline.events.map((e) => e.offsetSec);
    expect([...offsets].sort((a, b) => a - b)).toEqual(offsets);
    const gun = timeline.events.find((e) => e.category === 'race' && e.offsetSec === 0);
    expect(gun?.time).toBe('10:00 AM');
    expect(milestones.every((e) => e.offsetSec > 0 && e.phase === 'race')).toBe(true);
    expect(timeline.textExport).toContain('Half marathon');
  });
});

describe('golden: a 1:45 half marathon', () => {
  it('builds from a 13.1 mi custom race with equal halves and correct tables', () => {
    const race = importCustomMarathon({
      name: 'Harvest Half',
      city: 'Portland',
      country: 'USA',
      date: '2026-11-15',
      courseType: 'loop',
      distanceMi: 13.1,
    });
    expect(validateGoalTime(13.1, 6300)).toBeNull();

    const s = buildRaceStrategy(race.id, 6300, 'even-split');
    expect(s).not.toBeNull();
    if (!s) return;
    expect(s.distanceMi).toBe(13.1);
    expect(s.milePaces).toHaveLength(14);
    expect(s.milePaces[13].mile).toBeCloseTo(13.1, 6);
    expect(Math.abs(finishOf(s) - 6300)).toBeLessThanOrEqual(1);
    expect(s.firstHalfSec).toBe(3150);
    expect(s.secondHalfSec).toBe(3150);
    expect(s.avgPaceSec).toBe(481); // 8:01 /mi
    expect(s.marathonName).toBe('Harvest Half');

    // Halfway is at 6.55 mi, not at a marathon's 13.1.
    expect(Math.abs(timeAtDistance(s.milePaces, 6.55) - 3150)).toBeLessThanOrEqual(1.5);

    const km = buildUnitSplits(s.milePaces, 'km', 13.1);
    expect(km).toHaveLength(22);
    expect(km[21].cumulativeSec).toBeCloseTo(finishOf(s), 6);

    // In-race fuel stays inside the race.
    for (const item of s.nutritionPlan) {
      expect(item.mile).toBeLessThanOrEqual(13.1);
      if (typeof item.timeSec === 'number') expect(item.timeSec).toBeLessThanOrEqual(6300);
    }
  });

  it('rejects a goal faster than world-record pace for the distance (RS-11)', () => {
    const race = importCustomMarathon({
      name: 'Quick Half',
      city: 'Austin',
      country: 'USA',
      date: '2026-12-06',
      courseType: 'loop',
      distanceMi: 13.1,
    });
    expect(validateGoalTime(13.1, 50 * 60)).toMatch(/world record/i);
    expect(buildRaceStrategy(race.id, 50 * 60, 'even-split')).toBeNull();
  });
});
