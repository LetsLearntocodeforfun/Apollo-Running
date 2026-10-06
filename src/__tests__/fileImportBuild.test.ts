/**
 * Unit tests for fileImport/build.ts — turning parsed FIT / GPX / TCX workouts
 * into Apollo activities: identity, local start times, distance and moving
 * time, elevation hysteresis, heart rate, cadence normalization, power, routes,
 * splits, laps, sport inference and the records that are rejected.
 */

import { describe, it, expect } from 'vitest';
import {
  FILE_ID_OFFSET,
  elevationGain,
  normalizeSportType,
  originFromName,
  toActivity,
  type ToActivityOptions,
} from '@/services/fileImport/build';
import type { ParsedActivity, ParsedLap, ParsedSample } from '@/services/fileImport/types';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** 2024-03-10 06:00:00 UTC. */
const T0 = Date.UTC(2024, 2, 10, 6, 0, 0);
const T0_SEC = T0 / 1000;
/** Meters per 0.0001° of latitude on Apollo's Earth radius (6371008.8 m). */
const LAT_STEP_M = 11.119508;

function sample(sec: number, extra: Partial<ParsedSample> = {}): ParsedSample {
  return { time: T0 + sec * 1000, ...extra };
}

/** One sample per second for `durationSec` at a steady `speed` (device distance), plus extra channels. */
function steady(
  durationSec: number,
  speed: number,
  extra: (sec: number) => Partial<ParsedSample> = () => ({}),
): ParsedSample[] {
  const out: ParsedSample[] = [];
  for (let s = 0; s <= durationSec; s++) out.push(sample(s, { distance: s * speed, ...extra(s) }));
  return out;
}

/** A 10-minute 1.8 km run unless overridden. */
function workout(overrides: Partial<ParsedActivity> = {}): ParsedActivity {
  return { type: 'Run', startTime: T0, samples: steady(600, 3), laps: [], totals: {}, ...overrides };
}

function build(p: ParsedActivity, opts: Partial<ToActivityOptions> = {}) {
  const activity = toActivity(p, { fileName: 'test.fit', ...opts });
  if (!activity) throw new Error('Expected an activity');
  return activity;
}

/** Decode a Google encoded polyline (precision 5). */
function decodePolyline(text: string): [number, number][] {
  const points: [number, number][] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  const next = (): number => {
    let result = 0;
    let shift = 0;
    let byte: number;
    do {
      byte = text.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  while (index < text.length) {
    lat += next();
    lng += next();
    points.push([lat / 1e5, lng / 1e5]);
  }
  return points;
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

// ── Identity ──────────────────────────────────────────────────────────────────

describe('toActivity: identity', () => {
  it('derives a stable ID, source_id and map ID from the start second', () => {
    const a = build(workout({ startTime: T0 + 999 }));
    expect(a.id).toBe(FILE_ID_OFFSET + T0_SEC);
    expect(a.source).toBe('file');
    expect(a.source_id).toBe(`file:${T0_SEC}`);
    expect(a.map?.id).toBe(`file-${FILE_ID_OFFSET + T0_SEC}`);
    expect(a.start_date).toBe('2024-03-10T06:00:00Z');
    expect(a.kudos_count).toBe(0);
    // The same workout from another file (or format) maps to the same record.
    expect(build(workout({ samples: steady(600, 3.01) }), { fileName: 'other.gpx' }).id).toBe(a.id);
  });

  it('takes the ID, name, type and origin from archive metadata', () => {
    const a = build(workout({ name: 'Name in the file', origin: 'GARMIN' }), {
      id: 10_123_456_789, sourceId: 'strava:10123456789', name: ' Strava name ', type: 'Virtual Run', origin: 'STRAVA',
    });
    expect(a).toMatchObject({
      id: 10_123_456_789, source_id: 'strava:10123456789', name: 'Strava name',
      type: 'VirtualRun', sport_type: 'VirtualRun', trainer: true, origin: 'STRAVA',
    });
    for (const id of [0, -5, 1.5, Number.NaN]) expect(build(workout(), { id }).id).toBe(FILE_ID_OFFSET + T0_SEC);
  });

  it("keeps the file's own name, device and origin otherwise", () => {
    const a = build(workout({ name: '  Lunch Run  ', device: ' Forerunner 965 ', origin: 'GARMIN' }));
    expect(a).toMatchObject({ name: 'Lunch Run', device_name: 'Forerunner 965', origin: 'GARMIN' });
  });

  it('names unnamed workouts from the local start hour, like synced ones', () => {
    expect(build(workout({ utcOffsetSec: 0 })).name).toBe('Morning Run');
    expect(build(workout({ utcOffsetSec: 7 * 3600 })).name).toBe('Afternoon Run'); // 13:00
    expect(build(workout({ utcOffsetSec: 12 * 3600 })).name).toBe('Evening Run'); // 18:00
    expect(build(workout({ utcOffsetSec: -7 * 3600 })).name).toBe('Night Run'); // 23:00 the day before
    expect(build(workout({ type: 'VirtualRide', utcOffsetSec: 0, name: '   ' })).name).toBe('Morning Virtual Ride');
  });
});

// ── Local time ────────────────────────────────────────────────────────────────

describe('toActivity: local start time', () => {
  it('applies the UTC offset recorded in the file', () => {
    expect(build(workout({ utcOffsetSec: 5.5 * 3600 })).start_date_local).toBe('2024-03-10T11:30:00Z');
    const west = build(workout({ utcOffsetSec: -8 * 3600 }));
    expect(west.start_date_local).toBe('2024-03-09T22:00:00Z');
    expect(west.start_date).toBe('2024-03-10T06:00:00Z');
  });

  it("falls back to the computer's time zone without a plausible offset", () => {
    const d = new Date(T0);
    const local = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
      + `T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}Z`;
    expect(build(workout()).start_date_local).toBe(local);
    expect(build(workout({ utcOffsetSec: 30 * 3600 })).start_date_local).toBe(local);
  });
});

// ── Distance and time ─────────────────────────────────────────────────────────

describe('toActivity: distance and time', () => {
  it('measures GPS tracks with haversine distance and skips position glitches', () => {
    const samples: ParsedSample[] = [];
    for (let i = 0; i <= 60; i++) {
      // 2.8 m/s due north, with one point thrown 111 km off course.
      samples.push(sample(i * 10, { lat: 45 + i * 2.5e-4 + (i === 30 ? 1 : 0), lng: 7 }));
    }
    const a = build(workout({ samples }));
    expect(a.distance).toBeCloseTo(60 * 2.5 * LAT_STEP_M, 0);
    expect(a.elapsed_time).toBe(600);
  });

  it('excludes stops and pauses from moving time', () => {
    const samples: ParsedSample[] = [];
    for (let s = 0; s <= 300; s++) samples.push(sample(s, { distance: s * 3 })); // 5 minutes at 3 m/s
    for (let s = 301; s <= 360; s++) samples.push(sample(s, { distance: 900 })); // a minute waiting at a crossing
    for (let s = 660; s <= 960; s++) samples.push(sample(s, { distance: 900 + (s - 660) * 3 })); // after a 5-minute pause
    const a = build(workout({ samples }));
    expect(a.distance).toBe(1800);
    expect(a.moving_time).toBe(600);
    expect(a.elapsed_time).toBe(960);
    expect(a.average_speed).toBe(3);
  });

  it('prefers the totals the device recorded', () => {
    const a = build(workout({
      totals: {
        distance: 5000, movingSec: 1500, elapsedSec: 1600, ascent: 42, calories: 400.4, avgHeartRate: 150,
        maxHeartRate: 181, avgSpeed: 3.33, maxSpeed: 5.1, trainingLoad: 55.44,
      },
    }));
    expect(a).toMatchObject({
      distance: 5000, moving_time: 1500, elapsed_time: 1600, total_elevation_gain: 42, calories: 400,
      average_heartrate: 150, max_heartrate: 181, average_speed: 3.33, max_speed: 5.1, training_load: 55.4,
    });
    // Elapsed time is never shorter than moving time.
    expect(build(workout({ totals: { movingSec: 2000, elapsedSec: 1600 } })).elapsed_time).toBe(2000);
  });

  it('falls back to laps for workouts without samples (pool swims, manual laps)', () => {
    const laps: ParsedLap[] = [
      { startTime: T0, elapsedSec: 600, distance: 1000 },
      { startTime: T0 + 600_000, elapsedSec: 660, movingSec: 600, distance: 1000 },
    ];
    const a = build(workout({ type: 'Swim', samples: [], laps }));
    expect(a).toMatchObject({ distance: 2000, moving_time: 1200, elapsed_time: 1260 });
    expect(a.map?.summary_polyline).toBe('');
    expect(a.start_latlng).toBeNull();
    expect(a.laps?.map((l) => [l.distance, l.moving_time, l.elapsed_time])).toEqual([[1000, 600, 600], [1000, 600, 660]]);
  });
});

// ── Sensors ───────────────────────────────────────────────────────────────────

describe('elevationGain', () => {
  it('ignores altitude noise smaller than the hysteresis', () => {
    expect(elevationGain([100, 101, 100, 101.5, 100, 102, 100])).toBe(0);
    expect(elevationGain([])).toBe(0);
    expect(elevationGain([100])).toBe(0);
  });

  it('counts every real climb in full, also after an initial descent', () => {
    expect(elevationGain([100, 110, 108, 112, 100, 105])).toBe(17);
    expect(elevationGain([120, 110, 115, 100, 130])).toBe(35);
    expect(elevationGain([Number.NaN, 100, Number.NaN, 110])).toBe(10);
    expect(elevationGain([100, 101, 100, 101], 0.5)).toBe(2);
  });
});

describe('toActivity: sensors', () => {
  it('derives elevation gain from noisy altitude samples', () => {
    // A 30 m climb with ±1 m of noise on every sample: summing every rise would give 315 m.
    const a = build(workout({ samples: steady(300, 3, (s) => ({ altitude: 100 + s / 10 + (s % 2 ? 1 : -1) })) }));
    expect(a.total_elevation_gain).toBeCloseTo(31.9, 1);
  });

  it('ignores implausible heart rates and weights the average by time', () => {
    const a = build(workout({
      samples: steady(600, 3, (s) => ({ heartRate: s === 100 ? 0 : s === 200 ? 255 : s <= 300 ? 140 : 160 })),
    }));
    expect(a.average_heartrate).toBeCloseTo(150, 0);
    expect(a.max_heartrate).toBe(160);
  });

  it('stores running cadence in strides per minute and leaves cycling cadence alone', () => {
    const cadence = (value: number): ParsedSample[] => steady(600, 3, () => ({ cadence: value }));
    expect(build(workout({ samples: cadence(170) })).average_cadence).toBe(85); // exported as steps/min
    expect(build(workout({ samples: cadence(86) })).average_cadence).toBe(86); // FIT strides/min
    expect(build(workout({ type: 'Ride', samples: cadence(130) })).average_cadence).toBe(130);
    expect(build(workout({ totals: { avgCadence: 172 } })).average_cadence).toBe(86);
    const laps: ParsedLap[] = [
      { startTime: T0, elapsedSec: 300, distance: 900, avgCadence: 170 },
      { startTime: T0 + 300_000, elapsedSec: 300, distance: 900, avgCadence: 176 },
    ];
    expect(build(workout({ samples: cadence(173), laps })).laps?.map((l) => l.average_cadence)).toEqual([85, 88]);
  });

  it('computes average and normalized power', () => {
    const even = build(workout({ type: 'Ride', samples: steady(600, 8, () => ({ power: 200 })) }));
    expect(even.average_watts).toBe(200);
    expect(even.weighted_average_watts).toBe(200);
    const intervals = build(workout({ type: 'Ride', samples: steady(600, 8, (s) => ({ power: s < 300 ? 100 : 300 })) }));
    expect(intervals.average_watts).toBe(200);
    expect(intervals.weighted_average_watts).toBeGreaterThan(240);
    expect(intervals.weighted_average_watts).toBeLessThan(260);
    const device = build(workout({ type: 'Ride', totals: { avgPower: 180, normalizedPower: 190 } }));
    expect(device).toMatchObject({ average_watts: 180, weighted_average_watts: 190 });
  });

  it('takes max speed from the speed channel, else the fastest 5-second window', () => {
    expect(build(workout({ samples: steady(600, 3, (s) => ({ speed: s === 42 ? 4.5 : 3 })) })).max_speed).toBe(4.5);
    // No speed channel: a 10-second surge at 5 m/s in a steady 3 m/s run.
    const samples: ParsedSample[] = [];
    let d = 0;
    for (let s = 0; s <= 600; s++) {
      samples.push(sample(s, { distance: d }));
      d += s >= 100 && s < 110 ? 5 : 3;
    }
    expect(build(workout({ samples })).max_speed).toBe(5);
  });
});

// ── Route, splits and laps ────────────────────────────────────────────────────

describe('toActivity: route, splits and laps', () => {
  it('stores a route of at most 500 points and no full-resolution polyline', () => {
    const samples: ParsedSample[] = [];
    for (let s = 0; s <= 1200; s++) samples.push(sample(s, { lat: 45 + s * 2.5e-5, lng: 7 + s * 2.5e-5 }));
    samples.splice(10, 0, sample(10.5, { lat: 0, lng: 0 })); // a GPS-lock artifact
    const a = build(workout({ samples }));
    const route = decodePolyline(a.map?.summary_polyline ?? '');
    expect(route).toHaveLength(500);
    expect(route[0]).toEqual([45, 7]);
    expect(route[route.length - 1][0]).toBeCloseTo(45.03, 5);
    expect(route.every(([lat, lng]) => lat !== 0 && lng !== 0)).toBe(true);
    expect(a.map && 'polyline' in a.map).toBe(false);
    expect(a.start_latlng).toEqual([45, 7]);
    expect(a.end_latlng?.[1]).toBeCloseTo(7.03, 6);
  });

  it('marks workouts without GPS with an empty route', () => {
    const a = build(workout());
    expect(a.map).toEqual({ id: `file-${a.id}`, summary_polyline: '' });
    expect(a.start_latlng).toBeNull();
    expect(a.end_latlng).toBeNull();
  });

  it('derives per-km and per-mile splits for runs, walks and hikes only', () => {
    const run = build(workout({ samples: steady(1000, 2.5, (s) => ({ heartRate: 150, altitude: 100 + s / 100 })) }));
    expect(run.splits_metric?.map((s) => s.distance)).toEqual([1000, 1000, 500]);
    expect(run.splits_metric?.map((s) => s.elapsed_time)).toEqual([400, 400, 200]);
    expect(run.splits_metric?.[0]).toMatchObject({ split: 1, average_speed: 2.5, average_heartrate: 150, elevation_difference: 4 });
    expect(run.splits_standard?.map((s) => s.distance)).toEqual([1609.3, 890.7]);
    expect(build(workout({ type: 'Hike', samples: steady(1000, 2.5) })).splits_metric).toHaveLength(3);
    const ride = build(workout({ type: 'Ride', samples: steady(1000, 2.5) }));
    expect(ride.splits_metric).toBeUndefined();
    expect(ride.splits_standard).toBeUndefined();
  });

  it('keeps device laps when a workout has 2 to 100 of them', () => {
    const samples = steady(900, 10 / 3); // 3 km in 15 minutes
    const laps: ParsedLap[] = [0, 1, 2].map((i) => ({
      startTime: T0 + i * 300_000, elapsedSec: 300, distance: 1000, avgHeartRate: 140 + i * 5,
      name: i === 2 ? 'Cool-down' : undefined,
    }));
    const a = build(workout({ samples, laps }));
    expect(a.laps?.map((l) => [l.lap_index, l.split, l.name, l.start_index, l.end_index])).toEqual([
      [0, 1, 'Lap 1', 0, 299],
      [1, 2, 'Lap 2', 300, 599],
      [2, 3, 'Cool-down', 600, 900],
    ]);
    expect(a.laps?.[1]).toMatchObject({
      distance: 1000, elapsed_time: 300, moving_time: 300, average_heartrate: 145, average_speed: 3.333,
    });
    expect(build(workout({ samples, laps: laps.slice(0, 1) })).laps).toBeUndefined();
    const many = Array.from({ length: 101 }, (_, i): ParsedLap => ({ startTime: T0 + i * 5000, elapsedSec: 5, distance: 15 }));
    expect(build(workout({ samples, laps: many })).laps).toBeUndefined();
    const withEmpty: ParsedLap[] = [...laps.slice(0, 2), { startTime: T0 + 600_000, elapsedSec: 0, distance: 0 }];
    expect(build(workout({ samples, laps: withEmpty })).laps).toHaveLength(2);
  });
});

// ── Sports and rejected records ───────────────────────────────────────────────

describe('toActivity: sport type', () => {
  it('infers the sport of untyped workouts from their speed', () => {
    expect(build(workout({ type: '', samples: steady(600, 3) })).type).toBe('Run');
    expect(build(workout({ type: '', samples: steady(600, 8) })).type).toBe('Ride');
    expect(build(workout({ type: '', samples: steady(600, 1.2) })).type).toBe('Walk');
    expect(build(workout({ type: '', samples: [], totals: { elapsedSec: 1800 } })).type).toBe('Workout');
  });

  it("normalizes the file's sport and flags indoor sessions", () => {
    expect(build(workout({ type: 'treadmill_running' }))).toMatchObject({ type: 'Run', trainer: true });
    expect(build(workout({ type: 'VirtualRide' }))).toMatchObject({ type: 'VirtualRide', trainer: true });
    expect(build(workout({ type: 'running', trainer: true }))).toMatchObject({ type: 'Run', trainer: true });
    expect(build(workout({ type: 'VirtualRide', trainer: false })).trainer).toBe(false);
    expect('trainer' in build(workout({ type: 'Run' }))).toBe(false);
  });
});

describe('toActivity: rejected records', () => {
  const convert = (p: ParsedActivity) => toActivity(p, { fileName: 'x.fit' });

  it('returns null without a plausible start time', () => {
    expect(convert(workout({ startTime: Number.NaN }))).toBeNull();
    expect(convert(workout({ startTime: Date.UTC(1989, 11, 31) }))).toBeNull(); // FIT's epoch: an unset clock
    expect(convert(null as unknown as ParsedActivity)).toBeNull();
  });

  it('returns null for accidental recordings under a minute without distance', () => {
    expect(convert(workout({ samples: steady(45, 0) }))).toBeNull();
    expect(convert(workout({ samples: [] }))).toBeNull();
    expect(convert(workout({ samples: steady(45, 3) }))).not.toBeNull(); // a short sprint still counts
  });

  it('never stores undefined fields', () => {
    const a = build(workout({ samples: [sample(0), sample(600)] }));
    expect(Object.entries(a).filter(([, v]) => v === undefined)).toEqual([]);
    expect(a).toMatchObject({ type: 'Run', distance: 0, moving_time: 600, elapsed_time: 600 });
  });
});

describe('normalizeSportType', () => {
  it('maps names from every platform to Strava / intervals.icu sport types', () => {
    const cases: [string, string][] = [
      ['running', 'Run'], ['Biking', 'Ride'], ['trail_running', 'TrailRun'], ['lap_swimming', 'Swim'],
      ['E-Bike Ride', 'EBikeRide'], ['HIIT', 'HighIntensityIntervalTraining'], ['strength_training', 'WeightTraining'],
      ['9', 'Run'], ['1', 'Ride'], ['42', ''], ['floor_climbing', 'FloorClimbing'], ['PADDLE_BOARD', 'PaddleBoard'],
      ['  ', ''],
    ];
    for (const [raw, type] of cases) expect(normalizeSportType(raw).type).toBe(type);
    expect(normalizeSportType(null)).toEqual({ type: '' });
    expect(normalizeSportType('Virtual Ride')).toEqual({ type: 'VirtualRide', trainer: true });
    expect(normalizeSportType('treadmill_running')).toEqual({ type: 'Run', trainer: true });
    expect(normalizeSportType('Run')).toEqual({ type: 'Run' });
  });
});

describe('originFromName', () => {
  it('recognizes the platform from a device or creator name', () => {
    expect(originFromName('Garmin Forerunner 965')).toBe('GARMIN');
    expect(originFromName('fēnix 7 Pro')).toBe('GARMIN');
    expect(originFromName('COROS PACE 3')).toBe('COROS');
    expect(originFromName('Polar Vantage V2')).toBe('POLAR');
    expect(originFromName('Wahoo ELEMNT BOLT')).toBe('WAHOO');
    expect(originFromName('Zwift')).toBe('ZWIFT');
    expect(originFromName('StravaGPX iPhone')).toBe('STRAVA');
    expect(originFromName('Apple Watch Ultra')).toBe('APPLE');
    expect(originFromName('Some App')).toBeUndefined();
    expect(originFromName(undefined)).toBeUndefined();
  });
});
