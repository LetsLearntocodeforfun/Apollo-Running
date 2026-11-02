import { describe, it, expect, beforeEach } from 'vitest';
import {
  CANONICAL_MARATHON_M,
  analyzeRace,
  analyzeRaceActivity,
  deleteReport,
  getAllReports,
  getReportByActivityId,
  getReportById,
  updateLessonsLearned,
  type ActualMileSplit,
} from '@/labs/postRaceAnalysis';
import { buildRaceStrategy } from '@/services/raceStrategy';
import type { Activity, ActivitySplit } from '@/services/activity/types';
import { persistence } from '@/services/db/persistence';

const METERS_PER_MILE = 1609.344;

function makeMarathonActivity(overrides: Partial<Activity> = {}): Activity {
  const splits: ActivitySplit[] = [];
  for (let i = 1; i <= 26; i++) {
    splits.push({
      split: i,
      distance: METERS_PER_MILE,
      elapsed_time: 480,
      moving_time: 480,
      average_speed: METERS_PER_MILE / 480,
      elevation_difference: 0,
      average_heartrate: 155,
    });
  }
  // Partial 27th split: 0.21875 mi (352.04 m) at exact same 480 sec/mi pace (~105s)
  const finalDistM = CANONICAL_MARATHON_M - 26 * METERS_PER_MILE;
  const finalSec = Math.round((finalDistM / METERS_PER_MILE) * 480);
  splits.push({
    split: 27,
    distance: finalDistM,
    elapsed_time: finalSec,
    moving_time: finalSec,
    average_speed: finalDistM / finalSec,
    elevation_difference: 0,
    average_heartrate: 158,
  });

  const totalSec = 26 * 480 + finalSec; // 12,585s (3:29:45)
  return {
    id: 7001,
    name: 'Chicago Marathon',
    type: 'Run',
    sport_type: 'Run',
    distance: CANONICAL_MARATHON_M,
    moving_time: totalSec,
    elapsed_time: totalSec,
    start_date: '2026-10-11T12:30:00Z',
    start_date_local: '2026-10-11T07:30:00Z',
    kudos_count: 12,
    splits_standard: splits,
    ...overrides,
  };
}

beforeEach(() => {
  persistence.clear();
});

describe('postRaceAnalysis — L-23..L-30 regression & graduation suite', () => {
  it('L-23: distance-weights partial final splits (0.2 mi) instead of counting paceSec as a full mile', () => {
    const strategy = buildRaceStrategy('chicago', 12_585, 'even-split')!;
    const splits: ActualMileSplit[] = [
      ...Array.from({ length: 26 }, (_, i) => ({
        mile: i + 1,
        paceSec: 480, // 8:00/mi
      })),
      // 0.2 mi kick at 7:30/mi (450 sec/mi) -> should add 0.2 * 450 = 90s, NOT 450s!
      { mile: 26.2, paceSec: 450 },
    ];

    const report = analyzeRace(strategy, splits, '2026-10-11', undefined, { unit: 'mi' });
    expect(report.actualFinishSec).toBe(26 * 480 + Math.round(0.2 * 450)); // 12,570s
    expect(report.mileComparisons[26].distanceMi).toBeCloseTo(0.2, 3);

    // Final segment (Miles 21-26.2 = 6.2 mi) weighted pace should be ~479 sec/mi, not unweighted 476
    const lastSeg = report.segments[report.segments.length - 1];
    expect(lastSeg.avgPaceSec).toBe(Math.round((6 * 480 + 0.2 * 450) / 6.2));
  });

  it('L-24: beating the goal time (3:50 actual vs 4:00 goal) earns an A+ grade, never penalized', () => {
    const fourHourGoalSec = 4 * 3600; // 14,400s
    const threeFiftySec = 3 * 3600 + 50 * 60; // 13,800s (10 min PR!)
    const evenPace = threeFiftySec / 26.21875;

    const splits: ActivitySplit[] = [];
    for (let i = 1; i <= 26; i++) {
      splits.push({
        split: i,
        distance: METERS_PER_MILE,
        elapsed_time: Math.round(evenPace),
        moving_time: Math.round(evenPace),
        average_speed: METERS_PER_MILE / evenPace,
        elevation_difference: 0,
      });
    }
    const remM = CANONICAL_MARATHON_M - 26 * METERS_PER_MILE;
    splits.push({
      split: 27,
      distance: remM,
      elapsed_time: Math.round((remM / METERS_PER_MILE) * evenPace),
      moving_time: Math.round((remM / METERS_PER_MILE) * evenPace),
      average_speed: METERS_PER_MILE / evenPace,
      elevation_difference: 0,
    });

    const activity = makeMarathonActivity({
      id: 7002,
      moving_time: threeFiftySec,
      elapsed_time: threeFiftySec,
      splits_standard: splits,
    });

    const report = analyzeRaceActivity(activity, { goalTimeSec: fourHourGoalSec, unit: 'mi' });
    expect(report.deltaFinishSec).toBe(-600);
    expect(['A+', 'A']).toContain(report.grade);
    expect(report.score).toBeGreaterThanOrEqual(92);
  });

  it('L-25: interpolates exact 50% halfway distance (13.11 mi / 21,097.5 m) so an even marathon has equal halves', () => {
    const activity = makeMarathonActivity({ id: 7003 });
    const report = analyzeRaceActivity(activity, { goalTimeSec: 12_585, unit: 'mi' });

    expect(report.splitAnalysis.halfDistanceM).toBeCloseTo(21_097.5, 0);
    expect(report.splitAnalysis.halfDistanceMi).toBeCloseTo(13.109, 2);
    expect(Math.abs(report.splitAnalysis.actualSplitDiff)).toBeLessThanOrEqual(2);
    expect(report.splitAnalysis.splitType).toBe('even');
    expect(report.splitAnalysis.firstHalfActualSec + report.splitAnalysis.secondHalfActualSec).toBe(
      report.actualFinishSec,
    );
  });

  it('L-26: strongest segment has negative deltaSec (faster) and weakest has positive deltaSec (slower)', () => {
    const strategy = buildRaceStrategy('chicago', 4 * 3600, 'even-split')!; // ~549.6 sec/mi
    const basePace = 553; // +3s/mi slower in miles 1-20
    const closingPace = 520; // -30s/mi faster in miles 21-26.2!

    const splits: ActualMileSplit[] = [
      ...Array.from({ length: 20 }, (_, i) => ({ mile: i + 1, paceSec: basePace })),
      ...Array.from({ length: 6 }, (_, i) => ({ mile: 21 + i, paceSec: closingPace })),
      { mile: 26.2, paceSec: closingPace },
    ];

    const report = analyzeRace(strategy, splits, '2026-10-11', undefined, { unit: 'mi' });
    expect(report.strongestSegment).not.toBeNull();
    expect(report.strongestSegment!.label).toBe('Miles 21-26.2');
    expect(report.strongestSegment!.deltaSec).toBeLessThan(-20);

    expect(report.weakestSegment).not.toBeNull();
    expect(report.weakestSegment!.label).not.toBe('Miles 21-26.2');
    expect(report.weakestSegment!.deltaSec).toBeGreaterThan(0);

    // Ensure insight text never flips negative delta into Δ+
    const segInsight = report.insights.find((t) => t.includes('Strongest segment')) ?? '';
    expect(segInsight).toContain('Strongest segment: Miles 21-26.2');
    expect(segInsight).toContain('−');
  });

  it('L-27: deduplicates/upserts saved reports by activityId and keeps newest first', () => {
    const act1 = makeMarathonActivity({ id: 8001, name: 'Berlin Marathon' });
    const act2 = makeMarathonActivity({ id: 8002, name: 'Chicago Marathon' });

    const first = analyzeRaceActivity(act1, {
      goalTimeSec: 12_600,
      lessonsLearned: 'Great Maurten gel timing.',
    });
    expect(getAllReports()).toHaveLength(1);

    // Re-analyze act1 with updated goal time (no duplicate created, lessonsLearned preserved)
    const updated = analyzeRaceActivity(act1, { goalTimeSec: 12_300 });
    expect(getAllReports()).toHaveLength(1);
    expect(updated.id).toBe(first.id);
    expect(updated.lessonsLearned).toBe('Great Maurten gel timing.');
    expect(getReportByActivityId(8001)?.plannedFinishSec).toBe(12_300);

    // Analyze act2 -> now 2 reports, act2 newest first
    const second = analyzeRaceActivity(act2, { goalTimeSec: 12_600 });
    const all = getAllReports();
    expect(all).toHaveLength(2);
    expect(all[0].id).toBe(second.id);
    expect(all[1].id).toBe(first.id);

    expect(updateLessonsLearned(second.id, 'Run tighter tangents.')).toBe(true);
    expect(getReportById(second.id)?.lessonsLearned).toBe('Run tighter tangents.');
    expect(deleteReport(first.id)).toBe(true);
    expect(getAllReports()).toHaveLength(1);
  });

  it('L-28: guards empty splits, 1 split, zero distance, and zero moving_time without NaN or crashes', () => {
    const strategy = buildRaceStrategy('chicago', 14_400, 'even-split')!;

    // 0 splits, 0 distance, 0 time
    const zeroReport = analyzeRace(strategy, [], '2026-10-11', undefined, { persist: false });
    expect(zeroReport.actualFinishSec).toBe(0);
    expect(zeroReport.mileComparisons).toEqual([]);
    expect(zeroReport.segments).toEqual([]);
    expect(JSON.stringify(zeroReport)).not.toMatch(/NaN|Infinity/);

    // Summary-only activity with 0 splits but valid distance & time
    const summaryOnly = makeMarathonActivity({
      id: 8099,
      splits_standard: [],
      splits_metric: [],
      distance: CANONICAL_MARATHON_M,
      moving_time: 13_500,
      elapsed_time: 13_560,
    });
    const summaryReport = analyzeRaceActivity(summaryOnly, { goalTimeSec: 14_400, persist: false });
    expect(summaryReport.actualFinishSec).toBe(13_560);
    expect(summaryReport.grade).toBe('A+');
    expect(JSON.stringify(summaryReport)).not.toMatch(/NaN|Infinity/);

    // Single split
    const oneSplit = analyzeRace(strategy, [{ mile: 1, paceSec: 520 }], '2026-10-11', undefined, { persist: false });
    expect(oneSplit.actualFinishSec).toBe(520);
    expect(JSON.stringify(oneSplit)).not.toMatch(/NaN|Infinity/);
  });

  it('L-29: omits fabricated 0.3x multiplier claims and surfaces cardiac drift when HR rises with fade', () => {
    // Positive split with rising HR (148 -> 171 bpm)
    const splits: ActivitySplit[] = [];
    for (let i = 1; i <= 26; i++) {
      const secondHalf = i > 13;
      const sec = secondHalf ? 545 : 475;
      splits.push({
        split: i,
        distance: METERS_PER_MILE,
        elapsed_time: sec,
        moving_time: sec,
        average_speed: METERS_PER_MILE / sec,
        elevation_difference: 0,
        average_heartrate: secondHalf ? 171 : 148,
      });
    }
    const totalSec = splits.reduce((s, x) => s + x.elapsed_time, 0);
    const act = makeMarathonActivity({
      id: 8200,
      distance: 26 * METERS_PER_MILE,
      moving_time: totalSec,
      elapsed_time: totalSec,
      splits_standard: splits,
    });

    const report = analyzeRaceActivity(act, { goalTimeSec: 12_600, persist: false });
    const joined = report.insights.join(' ');
    expect(joined).not.toMatch(/0\.3|saves ~/i);
    expect(joined).toMatch(/Heart rate rose from 148 bpm.*171 bpm/);
  });

  it('L-30: uses official elapsed_time (gun/chip clock) and reports GPS overdistance (>0.3%) in both mi and km', () => {
    // Runner ran 42,650 m (+455 m tangents = +1.08%) in 3:58:00 moving, 4:02:00 elapsed (4 min stops) vs 4:00:00 goal
    const act = makeMarathonActivity({
      id: 8300,
      distance: 42_650,
      moving_time: 3 * 3600 + 58 * 60, // 14,280s
      elapsed_time: 4 * 3600 + 2 * 60, // 14,520s (2 min over 4:00:00 official clock!)
    });

    const miReport = analyzeRaceActivity(act, { goalTimeSec: 4 * 3600, unit: 'mi', persist: false });
    expect(miReport.actualFinishSec).toBe(14_520);
    expect(miReport.deltaFinishSec).toBe(120); // +2:00 slower than 4:00:00 on official clock
    expect(miReport.gpsAnalysis.stoppedTimeSec).toBe(240);
    expect(miReport.gpsAnalysis.isOverdistance).toBe(true);
    expect(miReport.gpsAnalysis.extraDistanceM).toBeCloseTo(455, 0);
    expect(miReport.gpsAnalysis.effectiveGpsPaceSecPerMi).toBeLessThan(miReport.gpsAnalysis.officialClockPaceSecPerMi);
    expect(miReport.gpsAnalysis.summary).toContain('mi');
    expect(miReport.gpsAnalysis.summary).toContain('/mi');

    const kmReport = analyzeRaceActivity(act, { goalTimeSec: 4 * 3600, unit: 'km', persist: false });
    expect(kmReport.gpsAnalysis.summary).toContain('42.65 km');
    expect(kmReport.gpsAnalysis.summary).toContain('+455 m');
    expect(kmReport.gpsAnalysis.summary).toContain('/km');
    expect(kmReport.segments[0].label).toBe('0–5K');
  });
});
