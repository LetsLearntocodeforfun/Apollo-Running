/**
 * Unit tests for the source-agnostic activity helpers:
 * sport classification (activity/sports.ts) and stream utilities
 * (activity/streams.ts — polyline encoding, decimation, split derivation).
 */

import { describe, it, expect } from 'vitest';
import {
  isRunActivity,
  isRideActivity,
  isCrossTrainingActivity,
  getSportCategory,
  formatSportType,
  getSportLabel,
} from '@/services/activity/sports';
import {
  encodePolyline,
  decimate,
  cleanLatLngs,
  deriveSplits,
  type StreamSample,
} from '@/services/activity/streams';
import { decodePolyline } from '@/services/routeService';

// ── Sports ────────────────────────────────────────────────────────────────────

describe('sport classification', () => {
  it('treats road, trail, treadmill and virtual runs as runs', () => {
    for (const type of ['Run', 'TrailRun', 'VirtualRun']) {
      expect(isRunActivity({ type })).toBe(true);
      expect(getSportCategory({ type })).toBe('run');
    }
  });

  it('classifies Zwift and outdoor rides as cycling cross-training', () => {
    for (const type of ['Ride', 'VirtualRide', 'GravelRide', 'EBikeRide']) {
      expect(isRideActivity({ type })).toBe(true);
      expect(isCrossTrainingActivity({ type })).toBe(true);
      expect(getSportCategory({ type })).toBe('ride');
    }
  });

  it('uses sport_type when type is generic', () => {
    expect(isRunActivity({ type: 'Workout', sport_type: 'TrailRun' })).toBe(true);
    expect(getSportCategory({ type: 'Workout', sport_type: 'VirtualRide' })).toBe('ride');
  });

  it('groups other sports into swim / walk / strength / other', () => {
    expect(getSportCategory({ type: 'Swim' })).toBe('swim');
    expect(getSportCategory({ type: 'Hike' })).toBe('walk');
    expect(getSportCategory({ type: 'WeightTraining' })).toBe('strength');
    expect(getSportCategory({ type: 'Rowing' })).toBe('other');
    expect(getSportCategory({})).toBe('other');
  });

  it('formats raw types as readable labels', () => {
    expect(formatSportType('VirtualRide')).toBe('Virtual Ride');
    expect(formatSportType('EBikeRide')).toBe('E-Bike Ride');
    expect(formatSportType('EMountainBikeRide')).toBe('E-Mountain Bike Ride');
    expect(formatSportType('Elliptical')).toBe('Elliptical');
    expect(formatSportType('HighIntensityIntervalTraining')).toBe('HIIT');
    expect(formatSportType('WeightTraining')).toBe('Strength Training');
    expect(formatSportType(undefined)).toBe('Activity');
    expect(getSportLabel({ type: 'Ride', sport_type: 'GravelRide' })).toBe('Gravel Ride');
  });
});

// ── Polylines ─────────────────────────────────────────────────────────────────

describe('encodePolyline', () => {
  it('matches the reference Google polyline example', () => {
    const points: [number, number][] = [[38.5, -120.2], [40.7, -120.95], [43.252, -126.453]];
    expect(encodePolyline(points)).toBe('_p~iF~ps|U_ulLnnqC_mqNvxq`@');
  });

  it('round-trips through routeService.decodePolyline', () => {
    const points: [number, number][] = [[51.50722, -0.1275], [51.5081, -0.12901], [51.50925, -0.13215]];
    const decoded = decodePolyline(encodePolyline(points));
    expect(decoded).toHaveLength(3);
    decoded.forEach((p, i) => {
      expect(p.lat).toBeCloseTo(points[i][0], 5);
      expect(p.lng).toBeCloseTo(points[i][1], 5);
    });
  });

  it('encodes an empty route as an empty string', () => {
    expect(encodePolyline([])).toBe('');
  });
});

describe('decimate', () => {
  it('returns a copy when already small enough', () => {
    const pts = [1, 2, 3];
    const out = decimate(pts, 5);
    expect(out).toEqual(pts);
    expect(out).not.toBe(pts);
  });

  it('keeps first and last points and the requested count', () => {
    const pts = Array.from({ length: 1000 }, (_, i) => i);
    const out = decimate(pts, 10);
    expect(out).toHaveLength(10);
    expect(out[0]).toBe(0);
    expect(out[9]).toBe(999);
  });
});

describe('cleanLatLngs', () => {
  it('drops nulls, out-of-range values and 0,0 GPS-lock artifacts', () => {
    const raw = [[45.1, -122.6], null, [0, 0], [95, 10], [45.2, 'x'], [45.3, -122.7], [45.4]];
    expect(cleanLatLngs(raw)).toEqual([[45.1, -122.6], [45.3, -122.7]]);
  });

  it('returns [] for non-array input', () => {
    expect(cleanLatLngs(null)).toEqual([]);
    expect(cleanLatLngs({ latlngs: [] })).toEqual([]);
  });
});

// ── Splits ────────────────────────────────────────────────────────────────────

/** Samples every `step` seconds at a constant speed (m/s). */
function steadySamples(totalMeters: number, speed: number, step = 1, hr?: number): StreamSample[] {
  const out: StreamSample[] = [];
  for (let t = 0; ; t += step) {
    const d = Math.min(totalMeters, t * speed);
    out.push({ t, d, hr, alt: 100 + d / 100 });
    if (d >= totalMeters) break;
  }
  return out;
}

describe('deriveSplits', () => {
  it('creates per-km splits with interpolated boundaries and a final partial split', () => {
    const splits = deriveSplits(steadySamples(2500, 4, 1, 150), 1000);
    expect(splits).toHaveLength(3);
    expect(splits.map((s) => s.split)).toEqual([1, 2, 3]);
    expect(splits[0].distance).toBe(1000);
    expect(splits[0].elapsed_time).toBe(250);
    expect(splits[0].moving_time).toBe(250);
    expect(splits[0].average_speed).toBeCloseTo(4, 3);
    expect(splits[0].average_heartrate).toBe(150);
    expect(splits[0].elevation_difference).toBeCloseTo(10, 1);
    expect(splits[2].distance).toBeCloseTo(500, 1);
    expect(splits[2].elapsed_time).toBe(125);
  });

  it('supports mile splits', () => {
    const splits = deriveSplits(steadySamples(3218.688, 3.5), 1609.344);
    expect(splits).toHaveLength(2);
    expect(splits[1].distance).toBeCloseTo(1609.344, 1);
  });

  it('excludes stops and long pauses from moving time', () => {
    const samples: StreamSample[] = [
      { t: 0, d: 0 },
      { t: 50, d: 200 },
      { t: 100, d: 400 },
      { t: 160, d: 400 },   // standing still for a minute
      { t: 400, d: 400 },   // watch paused (gap > 60 s)
      { t: 450, d: 600 },
      { t: 500, d: 800 },
      { t: 550, d: 1000 },
    ];
    const [first] = deriveSplits(samples, 1000);
    expect(first.elapsed_time).toBe(550);
    expect(first.moving_time).toBe(250);
    expect(first.average_speed).toBeCloseTo(4, 3);
  });

  it('skips trivial remainders and bad input', () => {
    expect(deriveSplits(steadySamples(1005, 5), 1000)).toHaveLength(1);
    expect(deriveSplits([{ t: 0, d: 0 }], 1000)).toEqual([]);
    expect(deriveSplits(steadySamples(2000, 4), 0)).toEqual([]);
  });

  it('handles samples that cross several boundaries at once', () => {
    const splits = deriveSplits([{ t: 0, d: 0 }, { t: 30, d: 3000 }], 1000);
    expect(splits).toHaveLength(3);
    splits.forEach((s) => expect(s.elapsed_time).toBe(10));
  });
});
