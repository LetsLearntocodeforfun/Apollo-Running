/**
 * v1.0.6 analytics correctness sweep (review B2, B3, B5, B7, B8, S6).
 * The reviewer's probes (scratch/analytics.probe.test.ts) as regression tests.
 */
import {
  calculateTrainingLoad,
  weekOverWeek,
  formatWeekCompareValue,
  calculateStreaks,
  calculateConsistency,
  calculatePaceProgression,
  calculateWeeklyMileage,
  calculateHREfficiency,
  MIN_CHRONIC_HISTORY_DAYS,
} from '@/services/analyticsService';
import { persistence } from '@/services/db/persistence';
import type { StravaActivity } from '@/services/strava';

const ORIGINAL_TZ = process.env.TZ;

type Extra = Partial<StravaActivity> & Record<string, unknown>;

function act(id: number, local: string, distance: number, moving: number, extra: Extra = {}): StravaActivity {
  return {
    id, name: `Run ${id}`, type: 'Run', sport_type: 'Run', distance, moving_time: moving, elapsed_time: moving,
    start_date: local, start_date_local: local, kudos_count: 0, ...extra,
  } as unknown as StravaActivity;
}

/** One run per calendar day from..to (inclusive), at 07:00 local wall time. */
function dailyRuns(from: string, to: string, distance: number, moving: number): StravaActivity[] {
  const out: StravaActivity[] = [];
  const d = new Date(`${from}T12:00:00Z`);
  const end = new Date(`${to}T12:00:00Z`);
  let id = 1;
  while (d <= end) {
    out.push(act(id++, `${d.toISOString().slice(0, 10)}T07:00:00Z`, distance, moving));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

afterEach(() => {
  vi.useRealTimers();
  process.env.TZ = ORIGINAL_TZ;
});

describe('training load (B2)', () => {
  it('a perfectly steady runner is ~1.0 "optimal" at every point, including the first ones', () => {
    process.env.TZ = 'America/Los_Angeles';
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-05T19:00:00-07:00'));
    const tl = calculateTrainingLoad(dailyRuns('2026-04-01', '2026-10-05', 10000, 3000), 56);
    expect(tl.length).toBeGreaterThan(5);
    expect(tl[0].date).toBe('2026-08-10');
    for (const p of tl) {
      expect(p.ratio).toBeCloseTo(1, 2);
      expect(p.status).toBe('optimal');
    }
  });

  it('marks points with under 21 days of history as insufficient instead of "danger"', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-05T19:00:00'));
    const tl = calculateTrainingLoad(dailyRuns('2026-09-20', '2026-10-05', 10000, 3000), 28);
    const last = tl[tl.length - 1];
    expect(MIN_CHRONIC_HISTORY_DAYS).toBe(21);
    expect(last.date).toBe('2026-10-05');
    expect(last.status).toBe('insufficient'); // 16 days of history
    expect(tl.every((p) => p.status === 'insufficient')).toBe(true);
  });

  it('ignores hidden activities and future-dated records', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-05T19:00:00'));
    const base = dailyRuns('2026-08-01', '2026-10-05', 10000, 3000);
    const withNoise = [
      ...base,
      act(900, '2026-10-04T07:00:00Z', 30000, 7200, { hidden: true }),
      act(901, '2026-10-09T07:00:00Z', 30000, 7200),
    ];
    expect(calculateTrainingLoad(withNoise, 28)).toEqual(calculateTrainingLoad(base, 28));
  });
});

describe('week over week (B3)', () => {
  for (const tz of ['America/Los_Angeles', 'Asia/Tokyo']) {
    it(`counts a Monday 06:00 run in the current week (${tz})`, () => {
      process.env.TZ = tz;
      vi.useFakeTimers();
      // Monday 10:00 local in either zone (east of UTC the old code excluded it until 15:00)
      vi.setSystemTime(new Date(2026, 9, 5, 10, 0, 0));
      const wow = weekOverWeek([
        act(10, '2026-10-05T06:00:00Z', 10000, 3000), // Monday 06:00 local -> this week
        act(11, '2026-10-03T08:00:00Z', 12000, 3600), // Saturday -> last week
        act(12, '2026-09-28T05:30:00Z', 5000, 1500),  // last Monday early -> last week
      ]);
      const runs = wow.find((w) => w.label === 'Runs')!;
      expect(runs.current).toBe(1);
      expect(runs.previous).toBe(2);
      const dist = wow.find((w) => w.label === 'Distance')!;
      expect(dist.kind).toBe('distance');
      expect(dist.current).toBe(10000);
      expect(dist.previous).toBe(17000);
    });
  }

  it('returns base units and formats them in the athlete\'s unit (km users see km)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 5, 19, 0, 0));
    const wow = weekOverWeek([act(10, '2026-10-05T06:00:00Z', 10000, 3000, { total_elevation_gain: 120 })]);
    const dist = wow.find((w) => w.label === 'Distance')!;
    const elev = wow.find((w) => w.label === 'Elevation')!;
    const time = wow.find((w) => w.label === 'Time')!;

    persistence.setItem('apollo_distance_unit', 'km');
    expect(formatWeekCompareValue(dist.kind, dist.current)).toBe('10.0 km');
    expect(formatWeekCompareValue(elev.kind, elev.current)).toBe('120 m');
    expect(formatWeekCompareValue(time.kind, time.current)).toBe('50 min');

    persistence.setItem('apollo_distance_unit', 'mi');
    expect(formatWeekCompareValue(dist.kind, dist.current)).toBe('6.2 mi');
    expect(formatWeekCompareValue(elev.kind, elev.current)).toBe('394 ft');
    expect(formatWeekCompareValue('duration', 3900)).toBe('1h 05m');
  });
});

describe('pace progression (B5)', () => {
  it('is distance-weighted: 3 mi @ 10:00 + 20 mi @ 8:00 = 8.261 min/mi', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-05T19:00:00'));
    const pp = calculatePaceProgression([
      act(20, '2026-09-29T07:00:00Z', 3 * 1609.344, 30 * 60),
      act(21, '2026-10-04T07:00:00Z', 20 * 1609.344, 160 * 60),
    ], 2);
    expect(pp).toHaveLength(1);
    expect(pp[0].weekStart).toBe('2026-09-28');
    expect(pp[0].avgPace).toBeCloseTo(190 / 23, 2);
    expect(pp[0].longRunPace).toBeCloseTo(8, 2);
  });

  it('applies the outlier filter to every series (a 25 min/mi "run" is ignored)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-05T19:00:00'));
    const pp = calculatePaceProgression([
      act(30, '2026-09-29T07:00:00Z', 3 * 1609.344, 30 * 60),
      act(31, '2026-09-30T07:00:00Z', 3 * 1609.344, 75 * 60), // 25:00/mi walk logged as a run
    ], 2);
    expect(pp[0].avgPace).toBeCloseTo(10, 2);
    expect(pp[0].easyPace).toBeCloseTo(10, 2);
  });
});

describe('weekly mileage (B4, B7)', () => {
  it('returns exactly `weeks` Monday buckets and the first one is a full week', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-07T12:00:00')); // Wednesday
    const wm = calculateWeeklyMileage(dailyRuns('2026-03-01', '2026-10-07', 5 * 1609.344, 2400), 12);
    expect(wm).toHaveLength(12);
    expect(wm[0].weekStart).toBe('2026-07-20');
    expect(wm[0].runCount).toBe(7);
    expect(wm[0].miles).toBe(35);
    expect(wm[0].distanceM).toBe(Math.round(35 * 1609.344));
    expect(wm[11].weekStart).toBe('2026-10-05');
    expect(wm[11].runCount).toBe(3); // Mon–Wed so far
  });
});

describe('streaks (B8)', () => {
  it('a runner who ran every day through yesterday has a 15-day current streak this morning', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-05T09:00:00'));
    const s = calculateStreaks(calculateConsistency(dailyRuns('2026-09-20', '2026-10-04', 8000, 2400), 30));
    expect(s.current).toBe(15);
    expect(s.longest).toBe(15);
  });

  it('counts runs (not run days) per week and breaks the streak after a missed day', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-05T20:00:00'));
    const runs = [
      ...dailyRuns('2026-09-29', '2026-10-01', 8000, 2400),
      act(500, '2026-10-01T18:00:00Z', 5000, 1500), // double day
      act(501, '2026-10-05T07:00:00Z', 8000, 2400), // today (10-02..10-04 missed)
    ];
    const con = calculateConsistency(runs, 13); // 14 days = 2 weeks
    const s = calculateStreaks(con);
    expect(s.current).toBe(1);
    expect(s.longest).toBe(3);
    expect(s.runsPerWeek).toBe(2.5); // 5 runs / 2 weeks
  });
});

describe('HR efficiency (S6)', () => {
  it('leaves out treadmill / virtual runs', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-05T19:00:00'));
    const pts = calculateHREfficiency([
      act(40, '2026-10-01T07:00:00Z', 10000, 3000, { average_heartrate: 150 }),
      act(41, '2026-10-02T07:00:00Z', 10000, 3000, { average_heartrate: 150, trainer: true }),
      act(42, '2026-10-03T07:00:00Z', 10000, 3000, { average_heartrate: 150, sport_type: 'VirtualRun', type: 'VirtualRun' }),
    ], 30);
    expect(pts.map((p) => p.date)).toEqual(['2026-10-01']);
  });
});
