import { describe, it, expect, beforeEach } from 'vitest';
import {
  COURSE_DISTANCE_FIT_TOLERANCE,
  DEFAULT_COURSE_DISTANCE_MI,
  ELEVATION_DEADBAND_M,
  ELEVATION_SAMPLE_SPACING_M,
  MARATHON_DISTANCE_MATCH_MI,
  MAX_COURSE_GPX_BYTES,
  MAX_COURSE_TRACKPOINTS,
  MAX_COURSE_WAYPOINTS,
  MAX_ELEVATION_PROFILE_POINTS,
  MAX_TRACK_JOIN_GAP_M,
  applyGpxCourseToMarathon,
  computeDeadbandGainLossMeters,
  computeElevationPass,
  courseFitTargetMi,
  fitCourseToDistance,
  haversineMeters,
  isMarathonDistanceMi,
  parseCourseGpx,
  type ParsedGpxCourse,
} from '@/services/courseGpxParser';
import { MARATHON_MI, buildRaceStrategy, getMarathon, importCustomMarathon } from '@/services/raceStrategy';
import { persistence } from '@/services/db/persistence';

const METERS_PER_DEG_LAT = (Math.PI / 180) * 6_371_000;
const METERS_PER_MILE = 1609.344;
/** The official marathon, 42.195 km (26.21875 mi). */
const MARATHON_M = 42_195;

function latAtMetersNorth(baseLat: number, metersNorth: number): number {
  return baseLat + metersNorth / METERS_PER_DEG_LAT;
}

/** Build a synthetic GPX track of `totalMeters` with `numPoints` samples and optional elevation function. */
function buildTrackGpx(opts: {
  totalMeters: number;
  numPoints: number;
  name?: string;
  elevationAtM?: (dMeters: number, idx: number) => number | undefined;
  waypointsXml?: string;
}): string {
  const { totalMeters, numPoints, name = 'Test Marathon Course', elevationAtM, waypointsXml = '' } = opts;
  const baseLat = 41.8781;
  const lon = -87.6298;
  const pts: string[] = [];
  for (let i = 0; i < numPoints; i++) {
    const d = numPoints > 1 ? (i / (numPoints - 1)) * totalMeters : 0;
    const lat = latAtMetersNorth(baseLat, d).toFixed(7);
    const ele = elevationAtM ? elevationAtM(d, i) : undefined;
    const eleXml = ele !== undefined ? `<ele>${ele.toFixed(2)}</ele>` : '';
    pts.push(`<trkpt lat="${lat}" lon="${lon}">${eleXml}</trkpt>`);
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="ApolloTest">
  <metadata><name>${name} Metadata</name></metadata>
  ${waypointsXml}
  <trk>
    <name>${name}</name>
    <trkseg>
      ${pts.join('\n      ')}
    </trkseg>
  </trk>
</gpx>`;
}

/** `<trkpt>` run due north from `fromM` to `toM` (meters from the base latitude), `count` points. */
function trackPoints(fromM: number, toM: number, count: number, ptTag = 'trkpt'): string {
  const pts: string[] = [];
  for (let i = 0; i < count; i++) {
    const d = fromM + (i / (count - 1)) * (toM - fromM);
    pts.push(`<${ptTag} lat="${latAtMetersNorth(41.8781, d).toFixed(7)}" lon="-87.6298"/>`);
  }
  return pts.join('');
}

/** Deterministic Park–Miller PRNG in [0, 1). */
function seededRandom(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647;
  };
}

/** True climb/descent of a profile function, sampled every 0.5 m. */
function trueGainLossM(profile: (d: number) => number, totalM: number): { gainM: number; lossM: number } {
  let gainM = 0;
  let lossM = 0;
  let prev = profile(0);
  for (let d = 0.5; d <= totalM; d += 0.5) {
    const v = profile(d);
    if (v > prev) gainM += v - prev;
    else lossM += prev - v;
    prev = v;
  }
  return { gainM, lossM };
}

function sumOf(parsed: ParsedGpxCourse, key: 'elevationGainFt' | 'elevationLossFt' | 'elevationChangeFt'): number {
  return parsed.splits.reduce((s, sp) => s + sp[key], 0);
}

/** Rolling marathon-length profile: 15 m waves every 3 km plus 8 m waves every 1.1 km. */
const rollingProfile = (d: number) =>
  50 + 15 * Math.sin((2 * Math.PI * d) / 3000) + 8 * Math.sin((2 * Math.PI * d) / 1100);

beforeEach(() => {
  persistence.clear();
});

describe('courseGpxParser — <trkpt> marathon with hills & deadband smoothing', () => {
  it('parses a 42.195 km hilly marathon track at its official length, downsamples <= 200 pts, and builds 27 splits incl. the final 0.2 mi', () => {
    // Climb 120 m between 16 km and 21 km (~3.1% grade), descend 80 m between 24 km and 28 km (~-2.5% grade)
    const gpx = buildTrackGpx({
      totalMeters: 42_195,
      numPoints: 650,
      name: 'Heartbreak Classic Marathon',
      elevationAtM: (d) => {
        if (d < 16_000) return 50;
        if (d <= 21_000) return 50 + ((d - 16_000) / 5_000) * 120; // 50m -> 170m
        if (d < 24_000) return 170;
        if (d <= 28_000) return 170 - ((d - 24_000) / 4_000) * 80; // 170m -> 90m
        return 90;
      },
    });

    const parsed = parseCourseGpx(gpx);

    expect(parsed.sourceKind).toBe('track');
    expect(parsed.suggestedName).toBe('Heartbreak Classic Marathon');
    expect(parsed.hasElevation).toBe(true);
    expect(parsed.pointCount).toBe(650);
    // Measured 42.195 km is the default race distance, the official marathon: nothing is rescaled.
    expect(parsed.distanceFit.measuredMi).toBeCloseTo(26.219, 2);
    expect(parsed.distanceFit.targetMi).toBe(MARATHON_MI);
    expect(parsed.distanceFit.fitted).toBe(true);
    expect(parsed.distanceFit.scale).toBeCloseTo(1, 4);
    expect(parsed.distanceMi).toBe(26.219);
    expect(parsed.distanceKm).toBe(42.195);
    expect(parsed.distanceM).toBe(42_195);

    // 120 m climb ≈ 394 ft, 80 m descent ≈ 262 ft
    expect(parsed.elevationGainM).toBeGreaterThanOrEqual(115);
    expect(parsed.elevationGainM).toBeLessThanOrEqual(122);
    expect(parsed.elevationLossM).toBeGreaterThanOrEqual(75);
    expect(parsed.elevationLossM).toBeLessThanOrEqual(82);
    expect(parsed.elevationGainFt).toBeGreaterThan(375);
    expect(parsed.elevationLossFt).toBeGreaterThan(245);

    // Downsampled cleanly to MAX_ELEVATION_PROFILE_POINTS (200)
    expect(parsed.elevationProfile.length).toBe(MAX_ELEVATION_PROFILE_POINTS);
    expect(parsed.elevationProfile[0].distanceMi).toBe(0);
    expect(parsed.elevationProfile[parsed.elevationProfile.length - 1].distanceMi).toBe(26.219);

    // 26 full miles + the final 0.2 mi (0.219 mi to 42.195 km)
    expect(parsed.splits).toHaveLength(27);
    expect(parsed.splits[0].splitNumber).toBe(1);
    expect(parsed.splits[0].distanceMi).toBe(1);
    const finalSplit = parsed.splits[26];
    expect(finalSplit.splitNumber).toBe(27);
    expect(finalSplit.distanceMi).toBe(0.219);
    expect(finalSplit.endMi).toBe(26.219);
    expect(finalSplit.notes).toContain('Final push');

    // Miles 11-13 (16-21 km) should flag climb; miles 16-17 (24-28 km) should flag downhill
    const climbSplit = parsed.splits.find((s) => s.splitNumber === 12)!;
    expect(climbSplit.avgGradePct).toBeGreaterThan(1.2);
    expect(climbSplit.notes).toMatch(/climb/i);

    const downhillSplit = parsed.splits.find((s) => s.splitNumber === 16)!;
    expect(downhillSplit.avgGradePct).toBeLessThan(-1.2);
    expect(downhillSplit.notes).toMatch(/downhill/i);

    expect(parsed.difficulty).toBeGreaterThanOrEqual(2);
    expect(parsed.aidStations.length).toBeGreaterThanOrEqual(10);
  });

  it('filters out DEM/GPS vertical jitter on a flat course with the 150 m smoothing window + 2 m hysteresis', () => {
    // Alternating ±1.8m noise on a completely flat 10 km course would sum to >1,800m raw climb without deadband!
    const gpx = buildTrackGpx({
      totalMeters: 10_000,
      numPoints: 500,
      name: 'Pancake Flat 10K',
      elevationAtM: (_d, idx) => 100 + (idx % 2 === 0 ? 1.8 : -1.8),
    });

    const parsed = parseCourseGpx(gpx);
    expect(parsed.hasElevation).toBe(true);
    expect(parsed.elevationGainM).toBe(0);
    expect(parsed.elevationLossM).toBe(0);
    expect(parsed.elevationGainFt).toBe(0);
    expect(parsed.elevationLossFt).toBe(0);
    expect(parsed.difficulty).toBe(1);
  });

  it('computeDeadbandGainLossMeters ignores wiggles under the deadband and counts real rises in full', () => {
    expect(ELEVATION_DEADBAND_M).toBe(2);
    expect(computeDeadbandGainLossMeters([])).toEqual({ gainM: 0, lossM: 0 });
    expect(computeDeadbandGainLossMeters([42])).toEqual({ gainM: 0, lossM: 0 });

    // Sub-3m oscillations ignored with a 3 m deadband; 10m real climb counted
    const wide = computeDeadbandGainLossMeters([100, 102.2, 100.5, 102.8, 110, 108.5, 103], 3);
    expect(wide.gainM).toBeCloseTo(10, 5);
    expect(wide.lossM).toBeCloseTo(7, 5);

    // Default 2 m: a 2.5 m bump is real and counts in full, a 1.9 m one doesn't count at all
    const bump = computeDeadbandGainLossMeters([100, 102.5, 100, 110]);
    expect(bump.gainM).toBeCloseTo(12.5, 5);
    expect(bump.lossM).toBeCloseTo(2.5, 5);
    expect(computeDeadbandGainLossMeters([100, 101.9, 100, 101.9, 100])).toEqual({ gainM: 0, lossM: 0 });
    expect(computeDeadbandGainLossMeters([100, 104, 100])).toEqual({ gainM: 4, lossM: 4 });
  });

  it('computeElevationPass samples every 25 m by distance, holds jitter flat and keeps a full climb', () => {
    const distancesM: number[] = [];
    const elevationsM: number[] = [];
    for (let x = 0; x <= 5_000; x += 5) {
      distancesM.push(x);
      // ±0.8 m jitter until 2 km, a 40 m climb to 3 km, then a plateau
      elevationsM.push(
        x < 2_000 ? 100 + (x % 10 === 0 ? 0.8 : -0.8) : x <= 3_000 ? 100 + ((x - 2_000) / 1_000) * 40 : 140,
      );
    }
    const pass = computeElevationPass(distancesM, elevationsM);
    expect(ELEVATION_SAMPLE_SPACING_M).toBe(25);
    expect(pass.sampleDistM[1]).toBe(25);
    expect(pass.sampleDistM[pass.sampleDistM.length - 1]).toBe(5_000);
    expect(pass.cumGainM[pass.sampleDistM.indexOf(1_900)]).toBe(0);
    expect(pass.cumGainM[pass.cumGainM.length - 1]).toBeCloseTo(40, 0);
    expect(pass.cumLossM[pass.cumLossM.length - 1]).toBe(0);
    // Cumulative totals never decrease
    expect(pass.cumGainM.every((g, i) => i === 0 || g >= pass.cumGainM[i - 1])).toBe(true);
  });
});

describe('courseGpxParser — one elevation pass: noise, real hills, and splits that add up', () => {
  it('reads a flat marathon with ±2.5 m GPS noise every 3 m as flat, with Flat splits that sum to the header', () => {
    const rnd = seededRandom(7);
    const gpx = buildTrackGpx({
      totalMeters: MARATHON_M,
      numPoints: Math.round(MARATHON_M / 3) + 1,
      name: 'Noisy Flat Marathon',
      elevationAtM: () => 50 + (rnd() - 0.5) * 5,
    });
    const parsed = parseCourseGpx(gpx);

    expect(parsed.elevationGainFt).toBeLessThanOrEqual(15);
    expect(parsed.elevationLossFt).toBeLessThanOrEqual(15);
    expect(sumOf(parsed, 'elevationGainFt')).toBe(parsed.elevationGainFt);
    expect(sumOf(parsed, 'elevationLossFt')).toBe(parsed.elevationLossFt);
    expect(parsed.splits.every((s) => s.terrain === 'Flat')).toBe(true);
    expect(parsed.difficulty).toBe(1);
    expect(parsed.course.difficulty).toBe(1);
    expect(parsed.course.prFriendly).toBe(true);
    expect(parsed.course.bqFriendly).toBe(true);
  });

  it('keeps heavier ±6 m noise from inventing a hilly course', () => {
    const rnd = seededRandom(7);
    const gpx = buildTrackGpx({
      totalMeters: MARATHON_M,
      numPoints: Math.round(MARATHON_M / 3) + 1,
      elevationAtM: () => 50 + (rnd() - 0.5) * 12,
    });
    const parsed = parseCourseGpx(gpx);

    expect(parsed.elevationGainFt).toBeLessThan(200);
    expect(sumOf(parsed, 'elevationGainFt')).toBe(parsed.elevationGainFt);
    expect(parsed.splits.every((s) => s.terrain === 'Flat')).toBe(true);
    expect(parsed.difficulty).toBe(1);
  });

  it('keeps a hilly course within 10% of its true climb and descent, clean or noisy, dense or sparse', () => {
    const truth = trueGainLossM(rollingProfile, MARATHON_M);
    for (const [spacingM, noiseM] of [
      [3, 0],
      [3, 5],
      [30, 0],
      [100, 0],
    ]) {
      const rnd = seededRandom(11);
      const parsed = parseCourseGpx(
        buildTrackGpx({
          totalMeters: MARATHON_M,
          numPoints: Math.round(MARATHON_M / spacingM) + 1,
          elevationAtM: (d) => rollingProfile(d) + (rnd() - 0.5) * noiseM,
        }),
      );
      expect(Math.abs(parsed.elevationGainM / truth.gainM - 1)).toBeLessThan(0.1);
      expect(Math.abs(parsed.elevationLossM / truth.lossM - 1)).toBeLessThan(0.1);
      expect(parsed.splits.some((s) => s.terrain === 'Rolling')).toBe(true);
    }
  });

  it('reads real-world course shapes within 10%: bridge climbs of 8–44 m, and a net-downhill point-to-point', () => {
    /** Smooth climbs and descents: [start mi, end mi, rise m]. */
    const ramps = (base: number, features: [number, number, number][]) => (dMeters: number) => {
      const mi = dMeters / METERS_PER_MILE;
      let e = base;
      for (const [a, b, rise] of features) {
        if (mi > a) e += (rise * (1 - Math.cos(Math.PI * Math.min(1, (mi - a) / (b - a))))) / 2;
      }
      return e;
    };
    // A city marathon with bridges (44 m, 33 m, 18 m, 10 m, 8 m) and a late 30 m drag into a rolling park
    const city = ramps(10, [
      [0, 1, 44],
      [1, 2.1, -44],
      [3, 3.5, 5],
      [3.5, 4, -5],
      [12.9, 13.15, 18],
      [13.15, 13.4, -18],
      [14.9, 15.6, 33],
      [15.6, 16.2, -33],
      [19.6, 19.8, 10],
      [19.8, 20, -10],
      [20.9, 21.05, 8],
      [21.05, 21.2, -8],
      [22.8, 23.9, 30],
      [24, 24.4, -10],
      [24.4, 24.8, 8],
      [24.8, 25.4, -12],
      [25.4, 26, 10],
      [26, 26.2, -6],
    ]);
    // A net-downhill point-to-point: 145 m lower at the finish, with four climbs between miles 16 and 21
    const downhill = ramps(150, [
      [0, 1, -40],
      [1, 1.3, 6],
      [1.3, 2.3, -25],
      [2.3, 2.6, 5],
      [2.6, 4, -36],
      [5, 7, -10],
      [8, 9, 8],
      [10, 12, -15],
      [12.5, 13, 6],
      [14, 16, -20],
      [16, 16.5, 18],
      [16.5, 17, -5],
      [17.5, 18, 15],
      [18, 18.5, -3],
      [19.3, 19.7, 12],
      [19.7, 20, -2],
      [20.4, 21, 27],
      [21, 22.5, -40],
      [23, 23.3, 4],
      [23.5, 25, -35],
      [25, 26.2, -15],
    ]);
    for (const profile of [city, downhill]) {
      const truth = trueGainLossM(profile, MARATHON_M);
      for (const [spacingM, noiseM] of [
        [3, 0],
        [3, 5],
        [30, 0],
      ]) {
        const rnd = seededRandom(5);
        const parsed = parseCourseGpx(
          buildTrackGpx({
            totalMeters: MARATHON_M,
            numPoints: Math.round(MARATHON_M / spacingM) + 1,
            elevationAtM: (d) => profile(d) + (rnd() - 0.5) * noiseM,
          }),
        );
        expect(Math.abs(parsed.elevationGainM / truth.gainM - 1)).toBeLessThan(0.1);
        expect(Math.abs(parsed.elevationLossM / truth.lossM - 1)).toBeLessThan(0.1);
        expect(sumOf(parsed, 'elevationGainFt')).toBe(parsed.elevationGainFt);
        expect(sumOf(parsed, 'elevationLossFt')).toBe(parsed.elevationLossFt);
        expect(sumOf(parsed, 'elevationChangeFt')).toBe(parsed.course.netChangeFt);
      }
    }
    // The net-downhill course really ends lower, and its steepest early mile reads as a descent
    const p = parseCourseGpx(buildTrackGpx({ totalMeters: MARATHON_M, numPoints: 8_000, elevationAtM: downhill }));
    expect(p.course.netChangeFt).toBeLessThan(-450);
    expect(p.splits[0].terrain).toMatch(/descent|Downhill/);
  });

  it('always adds per-split climb, descent and net change up to the course totals', () => {
    const rnd = seededRandom(3);
    const courses: ParsedGpxCourse[] = [
      parseCourseGpx(buildTrackGpx({ totalMeters: MARATHON_M, numPoints: 4_000, elevationAtM: rollingProfile })),
      parseCourseGpx(
        buildTrackGpx({
          totalMeters: 16_700, // 10.38 mi: partial final split
          numPoints: 3_000,
          elevationAtM: (d) => 120 + 25 * Math.sin(d / 900) + (rnd() - 0.5) * 4,
        }),
      ),
      parseCourseGpx(
        buildTrackGpx({
          totalMeters: 26.6 * METERS_PER_MILE, // fitted down to 26.2 mi
          numPoints: 1_200,
          elevationAtM: (d) => 40 + d / 400 + 6 * Math.sin(d / 700),
        }),
      ),
    ];
    for (const parsed of courses) {
      expect(sumOf(parsed, 'elevationGainFt')).toBe(parsed.elevationGainFt);
      expect(sumOf(parsed, 'elevationLossFt')).toBe(parsed.elevationLossFt);
      expect(sumOf(parsed, 'elevationChangeFt')).toBe(parsed.course.netChangeFt);
      expect(parsed.course.totalGainFt).toBe(parsed.elevationGainFt);
      expect(parsed.splits.every((s) => s.elevationGainFt >= 0 && s.elevationLossFt >= 0)).toBe(true);
    }
  });
});

describe('courseGpxParser — <rtept> route fallback & flat GPX without <ele>', () => {
  it('falls back to <rtept> route points when <trkpt> is absent', () => {
    const baseLat = 42.3601;
    const lon = -71.0589;
    const rtePts: string[] = [];
    for (let i = 0; i <= 40; i++) {
      const d = (i / 40) * 21_097.5; // Half marathon
      const lat = latAtMetersNorth(baseLat, d).toFixed(6);
      const ele = 20 + Math.sin((i / 40) * Math.PI) * 35;
      rtePts.push(`<rtept lat="${lat}" lon="${lon}"><ele>${ele.toFixed(1)}</ele></rtept>`);
    }
    const routeGpx = `<?xml version="1.0"?>
<gpx version="1.1">
  <rte>
    <name>Harbor Half Route</name>
    ${rtePts.join('\n    ')}
  </rte>
</gpx>`;

    const parsed = parseCourseGpx(routeGpx);
    expect(parsed.sourceKind).toBe('route');
    expect(parsed.suggestedName).toBe('Harbor Half Route');
    expect(parsed.distanceMi).toBeCloseTo(13.109, 2);
    expect(parsed.distanceFit.fitted).toBe(false); // a half is far from the marathon default
    expect(parsed.hasElevation).toBe(true);
    expect(parsed.elevationGainFt).toBeGreaterThan(80);
    expect(parsed.splits).toHaveLength(14); // 13 full miles + ~0.11 mi final push
  });

  it('gracefully handles GPX files without any <ele> tags (hasElevation: false)', () => {
    const gpx = buildTrackGpx({
      totalMeters: 5_000,
      numPoints: 50,
      name: 'No Elevation 5K',
    });

    const parsed = parseCourseGpx(gpx);
    expect(parsed.hasElevation).toBe(false);
    expect(parsed.elevationGainFt).toBe(0);
    expect(parsed.elevationLossFt).toBe(0);
    expect(parsed.difficulty).toBe(1);
    expect(parsed.elevationProfile.every((p) => p.elevationFt === 0)).toBe(true);
    expect(parsed.splits.every((s) => s.elevationChangeFt === 0 && s.avgGradePct === 0)).toBe(true);
  });
});

describe('courseGpxParser — track sections and gaps', () => {
  it('uses only the longest track when two <trk> elements are far apart, and says so', () => {
    const gpx = `<gpx>
      <trk><name>Warm-up loop</name><trkseg>${trackPoints(0, 2_000, 41)}</trkseg></trk>
      <trk><name>Race course</name><trkseg>${trackPoints(110_000, 115_000, 101)}</trkseg></trk>
    </gpx>`;
    const parsed = parseCourseGpx(gpx);

    expect(parsed.distanceM).toBeGreaterThan(4_990);
    expect(parsed.distanceM).toBeLessThan(5_010); // not 115 km including the jump
    expect(parsed.pointCount).toBe(101);
    expect(parsed.startLat).toBeCloseTo(latAtMetersNorth(41.8781, 110_000), 3);
    expect(parsed.warnings).toHaveLength(1);
    expect(parsed.warnings[0]).toMatch(/2 separate track sections more than 200 m apart/);
    expect(parsed.warnings[0]).toMatch(/longest one/);
  });

  it(`joins consecutive segments split by a GPS dropout of ${MAX_TRACK_JOIN_GAP_M} m or less`, () => {
    const gpx = `<gpx><trk>
      <trkseg>${trackPoints(0, 3_000, 61)}</trkseg>
      <trkseg>${trackPoints(3_150, 6_000, 58)}</trkseg>
    </trk></gpx>`;
    const parsed = parseCourseGpx(gpx);

    expect(parsed.pointCount).toBe(119);
    expect(parsed.distanceM).toBeCloseTo(6_000, -1); // the 150 m gap counts as course distance
    expect(parsed.warnings).toEqual([]);
  });

  it('keeps sections apart once the gap is over 200 m, and applies the same rule to routes', () => {
    const tracks = parseCourseGpx(`<gpx><trk>
      <trkseg>${trackPoints(0, 4_000, 81)}</trkseg>
      <trkseg>${trackPoints(4_250, 6_000, 36)}</trkseg>
    </trk></gpx>`);
    expect(tracks.pointCount).toBe(81);
    expect(tracks.distanceM).toBeCloseTo(4_000, -1);
    expect(tracks.warnings).toHaveLength(1);

    const routes = parseCourseGpx(`<gpx>
      <rte>${trackPoints(0, 1_500, 16, 'rtept')}</rte>
      <rte>${trackPoints(50_000, 53_000, 31, 'rtept')}</rte>
    </gpx>`);
    expect(routes.sourceKind).toBe('route');
    expect(routes.pointCount).toBe(31);
    expect(routes.warnings[0]).toMatch(/2 separate route sections/);
  });
});

describe('courseGpxParser — fitting the course to the race distance', () => {
  it('rescales a 26.5 mi GPX (within ±3%) so splits, aid stations and the profile end at the official marathon distance', () => {
    const waterLat = latAtMetersNorth(41.8781, 26.4 * METERS_PER_MILE).toFixed(7);
    const gpx = buildTrackGpx({
      totalMeters: 26.5 * METERS_PER_MILE,
      numPoints: 2_650,
      elevationAtM: (d) => 50 + 10 * Math.sin(d / 2_000),
      waypointsXml: `<wpt lat="${waterLat}" lon="-87.6298"><name>Final water station</name></wpt>`,
    });
    const parsed = parseCourseGpx(gpx);

    expect(COURSE_DISTANCE_FIT_TOLERANCE).toBe(0.03);
    expect(parsed.distanceFit).toMatchObject({ measuredMi: 26.5, targetMi: MARATHON_MI, fitted: true });
    expect(parsed.distanceFit.scale).toBeCloseTo(MARATHON_MI / 26.5, 4);
    expect(parsed.distanceMi).toBe(26.219);
    expect(parsed.distanceKm).toBe(42.195);
    expect(parsed.splits).toHaveLength(27);
    expect(parsed.splits[25].endMi).toBe(26);
    expect(parsed.splits[26].endMi).toBe(26.219);
    expect(parsed.splits[26].distanceMi).toBe(0.219);
    expect(parsed.elevationProfile[parsed.elevationProfile.length - 1].distanceMi).toBe(26.219);
    // The waypoint at 26.4 measured miles lands at 26.4 × 26.21875 / 26.5 ≈ 26.1 mi, inside the finish.
    expect(parsed.aidStations).toEqual([{ distanceMi: 26.1, name: 'Final water station', offerings: ['water'] }]);
    expect(parsed.splits[26].landmarks).toEqual(['Final water station']);
  });

  it('leaves a course more than 3% off the race distance as measured', () => {
    const parsed = parseCourseGpx(buildTrackGpx({ totalMeters: 28 * METERS_PER_MILE, numPoints: 2_000 }));

    expect(parsed.distanceFit).toMatchObject({ measuredMi: 28, targetMi: MARATHON_MI, fitted: false, scale: 1 });
    expect(parsed.distanceMi).toBe(28);
    expect(parsed.splits).toHaveLength(28);
    expect(parsed.splits[27].endMi).toBe(28);
    expect(parsed.aidStations[parsed.aidStations.length - 1].distanceMi).toBe(26); // every 2 mi to the measured end
  });

  it('fits to an explicit race distance, refits on demand, and never changes the climb', () => {
    const gpx = buildTrackGpx({
      totalMeters: 13.3 * METERS_PER_MILE,
      numPoints: 1_500,
      elevationAtM: (d) => 30 + 12 * Math.sin(d / 1_500),
    });
    const half = parseCourseGpx(gpx, { targetDistanceMi: 13.1 });
    // Only the marathon is replaced by its official distance; 13.1 stays exactly 13.1.
    expect(half.distanceFit).toMatchObject({ measuredMi: 13.3, targetMi: 13.1, fitted: true });
    expect(half.distanceMi).toBe(13.1);
    expect(half.splits).toHaveLength(14);
    expect(half.splits[13].endMi).toBe(13.1);

    const asMeasured = fitCourseToDistance(half, 13.3);
    expect(asMeasured.distanceMi).toBe(13.3);
    expect(asMeasured.splits).toHaveLength(14);

    const tooFar = fitCourseToDistance(half, 26.2);
    expect(tooFar.distanceFit).toMatchObject({ targetMi: MARATHON_MI, fitted: false });
    expect(tooFar.distanceMi).toBe(13.3);

    for (const course of [asMeasured, tooFar]) {
      expect(course.elevationGainFt).toBe(half.elevationGainFt);
      expect(course.elevationLossFt).toBe(half.elevationLossFt);
      expect(sumOf(course, 'elevationGainFt')).toBe(half.elevationGainFt);
    }
  });

  it('fits up to ±3% of the race distance and no further', () => {
    const at = (factor: number) => parseCourseGpx(buildTrackGpx({ totalMeters: MARATHON_M * factor, numPoints: 800 }));
    expect(at(1.029).distanceFit.fitted).toBe(true);
    expect(at(0.971).distanceFit.fitted).toBe(true);
    expect(at(1.032).distanceFit.fitted).toBe(false);
    expect(at(0.968).distanceFit.fitted).toBe(false);
  });

  it('saves the rescaled course with the race so the strategy finishes at the official marathon distance', () => {
    const parsed = parseCourseGpx(
      buildTrackGpx({
        totalMeters: 26.5 * METERS_PER_MILE,
        numPoints: 2_650,
        elevationAtM: (d) => 60 + 20 * Math.sin(d / 3_000),
      }),
    );
    // As MarathonImport saves a 26.2 mi race with a course: at the official distance, fitted to it.
    const race = importCustomMarathon({
      name: 'Long Course Marathon',
      city: 'Testville',
      country: 'USA',
      date: '2026-12-06',
      courseType: parsed.suggestedCourseType,
      distanceMi: MARATHON_MI,
      elevationGainFt: parsed.elevationGainFt,
      elevationLossFt: parsed.elevationLossFt,
    });
    const saved = applyGpxCourseToMarathon(race.id, { ...fitCourseToDistance(parsed, 26.2), distanceMi: MARATHON_MI });
    expect(saved).not.toBeNull();

    const stored = getMarathon(race.id)!;
    expect(stored.distanceMi).toBe(MARATHON_MI);
    expect(stored.splits).toHaveLength(27);
    expect(stored.splits[stored.splits.length - 1].endMi).toBe(26.219);
    expect(stored.course.elevationPoints[stored.course.elevationPoints.length - 1].distanceMi).toBe(26.219);
    expect(stored.aidStations.every((a) => a.distanceMi <= MARATHON_MI)).toBe(true);

    const strategy = buildRaceStrategy(race.id, 4 * 3600, 'even-split');
    expect(strategy!.milePaces).toHaveLength(27);
    expect(strategy!.milePaces[strategy!.milePaces.length - 1].mile).toBe(26.219);
  });
});

describe('courseGpxParser — the marathon is 42.195 km', () => {
  it('reads 26.2 mi, 42.2 km and 42.195 km as the marathon, and every other distance as given', () => {
    expect(DEFAULT_COURSE_DISTANCE_MI).toBe(MARATHON_MI);
    expect(MARATHON_MI).toBe(26.21875);
    expect(MARATHON_DISTANCE_MATCH_MI).toBe(0.02);
    const KM = 1.609344;
    for (const marathon of [26.2, 42.2 / KM, 42.195 / KM, MARATHON_MI, 26.22, 42.19 / KM, 42.21 / KM]) {
      expect(isMarathonDistanceMi(marathon)).toBe(true);
      expect(courseFitTargetMi(marathon)).toBe(MARATHON_MI);
    }
    for (const other of [26.1, 26.3, 26.25, 42 / KM, 42.3 / KM, 13.1, 13.109375, 31.07, 50]) {
      expect(isMarathonDistanceMi(other)).toBe(false);
      expect(courseFitTargetMi(other)).toBe(other);
    }
    for (const invalid of [undefined, 0, -26.2, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(courseFitTargetMi(invalid)).toBe(MARATHON_MI);
    }
    expect(isMarathonDistanceMi(Number.NaN)).toBe(false);
  });

  it('keeps an exact 42.195 km course unscaled and labels the finish sensibly', () => {
    const finishLat = latAtMetersNorth(41.8781, MARATHON_M).toFixed(7);
    const waypointsXml = [
      `<wpt lat="${latAtMetersNorth(41.8781, 25 * METERS_PER_MILE).toFixed(7)}" lon="-87.6298"><name>Mile 25 water</name></wpt>`,
      `<wpt lat="${finishLat}" lon="-87.6298"><name>Finish line water</name></wpt>`,
    ].join('');
    const gpx = buildTrackGpx({ totalMeters: MARATHON_M, numPoints: 3_000, waypointsXml });

    for (const targetDistanceMi of [undefined, 26.2, 42.2 / 1.609344, 42.195 / 1.609344]) {
      const parsed = parseCourseGpx(gpx, { targetDistanceMi });
      expect(parsed.distanceFit.targetMi).toBe(MARATHON_MI);
      expect(Math.abs(parsed.distanceFit.scale - 1)).toBeLessThan(1e-5);
      expect(parsed.distanceKm).toBe(42.195);
      // Mile splits 1–26, then the last 0.2 mi (0.219 mi to 42.195 km)
      expect(parsed.splits.map((s) => s.endMi).slice(-3)).toEqual([25, 26, 26.219]);
      expect(parsed.splits[26].distanceMi).toBe(0.219);
      expect(parsed.splits[26].notes).toContain('Final push');
      // Aid stations snap to tenths of a mile: the finish-line one reads 26.2, never past the finish
      expect(parsed.aidStations.map((a) => a.distanceMi)).toEqual([25, 26.2]);
      expect(parsed.splits[26].landmarks).toEqual(['Finish line water']);
    }

    // A file drawn to exactly 26.2 mi is stretched by 0.07% to the official distance
    const short = parseCourseGpx(buildTrackGpx({ totalMeters: 26.2 * METERS_PER_MILE, numPoints: 3_000 }));
    expect(short.distanceFit.fitted).toBe(true);
    expect(short.distanceKm).toBe(42.195);
    expect(short.splits).toHaveLength(27);
    // …and with no aid-station waypoints, the default stations every 2 mi stop at mile 26
    expect(short.aidStations[short.aidStations.length - 1].distanceMi).toBe(26);
  });
});

describe('courseGpxParser — <wpt> aid station extraction & custom marathon pacing integration', () => {
  it('extracts matching <wpt> aid/water/gel/medical waypoints sorted by course mile and ignores far/unrelated ones', () => {
    const baseLat = 41.8781;
    const lon = -87.6298;
    // Out-of-order waypoints at 9.65 km (~6.0 mi), 3.22 km (~2.0 mi), plus a non-aid photo spot and a far-off wpt
    const wpt6Lat = latAtMetersNorth(baseLat, 6 * 1609.344).toFixed(6);
    const wpt2Lat = latAtMetersNorth(baseLat, 2 * 1609.344).toFixed(6);
    const photoLat = latAtMetersNorth(baseLat, 4 * 1609.344).toFixed(6);
    const farLat = latAtMetersNorth(baseLat, 50_000).toFixed(6);

    const waypointsXml = `
      <wpt lat="${wpt6Lat}" lon="${lon}"><name>Mile 6 Maurten Gel &amp; Medical Station</name></wpt>
      <wpt lat="${photoLat}" lon="${lon}"><name>Historic Clocktower Arch</name></wpt>
      <wpt lat="${wpt2Lat}" lon="${lon}"><name>Water &amp; Gatorade Aid 1</name></wpt>
      <wpt lat="${farLat}" lon="${lon}"><name>Remote Water Tower</name></wpt>
    `;

    const gpx = buildTrackGpx({
      totalMeters: 16_093.44, // 10 miles
      numPoints: 200,
      waypointsXml,
    });

    const parsed = parseCourseGpx(gpx);
    expect(parsed.aidStations).toHaveLength(2);
    expect(parsed.aidStations[0].distanceMi).toBeCloseTo(2.0, 1);
    expect(parsed.aidStations[0].offerings).toContain('water');
    expect(parsed.aidStations[0].offerings).toContain('sports drink');

    expect(parsed.aidStations[1].distanceMi).toBeCloseTo(6.0, 1);
    expect(parsed.aidStations[1].offerings).toContain('energy gel');
    expect(parsed.aidStations[1].offerings).toContain('medical');
  });

  it('attaches GPX elevation profile to an imported custom marathon so buildRaceStrategy adjusts mile paces for hills', () => {
    const gpx = buildTrackGpx({
      totalMeters: 16_093.44, // 10 miles
      numPoints: 200,
      name: 'Mountain Ten Miler',
      elevationAtM: (d) => {
        // Mile 3 (3218m..4828m) climbs 80m; Mile 7 (9656m..11265m) descends 80m
        if (d >= 3218 && d <= 4828) return 100 + ((d - 3218) / 1610) * 80;
        if (d > 4828 && d < 9656) return 180;
        if (d >= 9656 && d <= 11265) return 180 - ((d - 9656) / 1609) * 80;
        return 100;
      },
    });
    const parsed = parseCourseGpx(gpx);

    const race = importCustomMarathon({
      name: parsed.suggestedName,
      city: 'Boulder',
      country: 'USA',
      date: '2026-11-08',
      courseType: parsed.suggestedCourseType,
      distanceMi: parsed.distanceMi,
      elevationGainFt: parsed.elevationGainFt,
      elevationLossFt: parsed.elevationLossFt,
    });
    const updated = applyGpxCourseToMarathon(race.id, parsed);
    expect(updated).not.toBeNull();
    expect(getMarathon(race.id)?.course.elevationPoints.length).toBe(parsed.elevationProfile.length);

    const strategy = buildRaceStrategy(race.id, 75 * 60, 'even-split');
    expect(strategy).not.toBeNull();
    const climbMile3 = strategy!.milePaces[2].targetPaceSec;
    const downhillMile7 = strategy!.milePaces[6].targetPaceSec;
    expect(climbMile3).toBeGreaterThan(downhillMile7 + 15);
  });
});

describe('courseGpxParser — validation, error handling & byte-size guard', () => {
  it('accepts UTF-8 Uint8Array bytes and uses fallbackName when <name> is absent', () => {
    const baseLat = 40.0;
    const nextLat = latAtMetersNorth(baseLat, 2_000).toFixed(6);
    const minimalGpx = `<gpx version="1.1"><trk><trkseg><trkpt lat="40.000000" lon="-74.0"/><trkpt lat="${nextLat}" lon="-74.0"/></trkseg></trk></gpx>`;
    const bytes = new TextEncoder().encode(minimalGpx);

    const parsed = parseCourseGpx(bytes, { fallbackName: 'brooklyn_loop_course.gpx' });
    expect(parsed.suggestedName).toBe('brooklyn loop course');
    expect(haversineMeters(40, -74, Number(nextLat), -74)).toBeCloseTo(2000, 0);
  });

  it('rejects empty, non-GPX, < 2 valid points, and too-short (< 0.5 mi) courses with clear messages', () => {
    expect(() => parseCourseGpx('   ')).toThrow(/empty/i);
    expect(() => parseCourseGpx('<html><body>Not a GPX</body></html>')).toThrow(/<gpx>/i);
    expect(() => parseCourseGpx('<gpx><trk><trkseg><trkpt lat="40.0" lon="-74.0"/></trkseg></trk></gpx>')).toThrow(
      /at least 2 valid/i,
    );
    expect(() =>
      parseCourseGpx('<gpx><trk><trkseg><trkpt lat="999" lon="-74.0"/><trkpt lat="0" lon="0"/></trkseg></trk></gpx>'),
    ).toThrow(/at least 2 valid/i);

    // 300 meters (< 0.5 mi / 800 m)
    const shortLat = latAtMetersNorth(40.0, 300).toFixed(6);
    expect(() =>
      parseCourseGpx(
        `<gpx><trk><trkseg><trkpt lat="40.0" lon="-74.0"/><trkpt lat="${shortLat}" lon="-74.0"/></trkseg></trk></gpx>`,
      ),
    ).toThrow(/too short|0\.5 miles/i);
  });

  it('rejects oversized Uint8Array and string inputs exceeding MAX_COURSE_GPX_BYTES', () => {
    const oversizedBytes = new Uint8Array(MAX_COURSE_GPX_BYTES + 1);
    expect(() => parseCourseGpx(oversizedBytes)).toThrow(/15 MB/i);
  });

  it('caps excessive <wpt> waypoints at MAX_COURSE_WAYPOINTS to prevent O(W * N) CPU stalls', () => {
    expect(MAX_COURSE_TRACKPOINTS).toBe(250_000);
    expect(MAX_COURSE_WAYPOINTS).toBe(1_000);

    const baseLat = 41.8781;
    const lon = -87.6298;
    const wpts = Array.from(
      { length: MAX_COURSE_WAYPOINTS + 250 },
      (_, i) => `<wpt lat="${baseLat.toFixed(6)}" lon="${lon}"><name>Marker ${i}</name></wpt>`,
    ).join('');
    const gpx = buildTrackGpx({
      totalMeters: 5_000,
      numPoints: 50,
      waypointsXml: wpts,
    });
    const parsed = parseCourseGpx(gpx);
    expect(parsed.distanceM).toBeGreaterThan(4_900);
    expect(parsed.measurement.waypoints).toHaveLength(MAX_COURSE_WAYPOINTS);
  });
});
